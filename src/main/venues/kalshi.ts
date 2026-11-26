// Kalshi, ported from the server engine's Kalshi executor. Three lessons from that file
// each cost a night of zero trades, and all three live here:
//   1. Requests are signed over timestamp_ms + METHOD + path without the
//      query: RSA keys with RSA-PSS, SHA-256, salt = digest length (PKCS1v15
//      is rejected); Ed25519 keys, Kalshi's default since 2026, directly.
//   2. The V2 order book trades in YES terms only. Buying NO at 30c is an ask
//      on YES at 70c. exchange_index -1 forces routing by ticker.
//   3. Collateral must already sit on the market's shard, or the order dies
//      user_not_found. It is moved from whichever shards hold it, shard 0
//      included, and confirmed before placing (2026-11-26).
import { constants, createPrivateKey, sign, type KeyObject } from 'node:crypto'
import type { ContractSide } from '@shared/signal'
import { HttpError, requestJson } from '../data/http'
import type { TradeDecision, VenueState } from '../rules/gates'
import { kalshiFee } from '../rules/fees'
import { countFp } from '@shared/exits'
import { eventMarketList } from '../data/nflkalshi'
import { vault } from '../store/vault'
import { type OrderUpdate, type PlaceResult, type Quote, type SellOrder, type Venue } from './types'

const HOSTS = {
  production: 'https://api.elections.kalshi.com',
  demo: 'https://demo-api.kalshi.co'
} as const
const PREFIX = '/trade-api/v2'

const SHARD_FUND_BUFFER_C = 200
const SHARD_FUND_MIN_C = 100
const BALANCE_TTL_MS = 60_000
const CASH_HOLD_MS = 5 * 60_000

type Level = [number, number]

// The ask on our side from a Kalshi orderbook response. Each side lists BIDS,
// so the ask on YES is 1 minus the best NO bid and the ask on NO is 1 minus
// the best YES bid. The live shape is `orderbook_fp` with dollar strings
// (verified 2026-10-25 against Kalshi's own yes_ask / no_ask); the older
// integer cent `orderbook` shape is still accepted.
export function kalshiAsk(res: Record<string, any>, side: ContractSide): Quote {
  const book = res.orderbook_fp ?? res.orderbook ?? {}
  const bids = (rows: unknown): Level[] =>
    (Array.isArray(rows) ? rows : []).map((r: any) => {
      const p = Number(r[0])
      return [p > 1 ? p / 100 : p, Number(r[1])] as Level
    })
  const yes = bids(book.yes_dollars ?? book.yes)
  const no = bids(book.no_dollars ?? book.no)
  const best = (levels: Level[]): Level | null => levels.reduce<Level | null>((a, l) => (!a || l[0] > a[0] ? l : a), null)
  const opposite = best(side === 'yes' ? no : yes)
  // Our side's own best bid, for the widest book a bot will buy into.
  const own = best(side === 'yes' ? yes : no)
  const bid = own ? Math.round(own[0] * 100) / 100 : null
  if (!opposite) return { ask: null, askSize: null, priceAgeS: 0, bid }
  return { ask: Math.round((1 - opposite[0]) * 100) / 100, askSize: opposite[1], priceAgeS: 0, bid }
}

// The balance reply, in either shape: integer cents (`balance`,
// `portfolio_value`, what the Python engine reads) or dollar strings
// (`balance_dollars`, `portfolio_value_dollars`), the way Kalshi moved the
// order book to `_dollars`. Null when neither is present.
export function kalshiBalance(b: Record<string, unknown>): { usd: number; equity: number } | null {
  const dollars = (d: unknown, c: unknown): number | null => {
    if (d !== undefined && d !== null && d !== '' && Number.isFinite(Number(d))) return Number(d)
    if (c !== undefined && c !== null && c !== '' && Number.isFinite(Number(c))) return Number(c) / 100
    return null
  }
  const usd = dollars(b.balance_dollars, b.balance)
  if (usd === null) return null
  return { usd, equity: usd + (dollars(b.portfolio_value_dollars, b.portfolio_value) ?? 0) }
}

// Cash per shard, in cents, from GetBalanceResponse.balance_breakdown
// ({ exchange_index, balance } with balance a dollar string). Null when the
// reply carries no breakdown.
export function kalshiShardCash(b: Record<string, unknown>): Map<number, number> | null {
  const rows = b.balance_breakdown
  if (!Array.isArray(rows)) return null
  const out = new Map<number, number>()
  for (const r of rows as Record<string, unknown>[]) {
    const idx = Number(r?.exchange_index)
    const usd = Number(r?.balance)
    if (Number.isInteger(idx) && idx >= 0 && r?.balance !== '' && r?.balance !== null && Number.isFinite(usd)) out.set(idx, Math.round(usd * 100))
  }
  return out
}

const num = (v: unknown): number => (v === undefined || v === null || v === '' ? 0 : Number(v) || 0)
const toC = (px: number): number => Math.round(px * 10000) / 100

// The reply to POST /portfolio/events/orders (CreateOrderV2Response). Counts
// are fixed point strings; average_fill_price is a book price, so in YES
// terms, and a NO buy's cost is its complement. average_fee_paid is per
// contract. Both are only present once something filled.
export function kalshiPlaced(res: Record<string, any>, side: ContractSide, wanted: number): Omit<PlaceResult, 'ok' | 'venueOrderId' | 'error'> {
  const filled = num(res.fill_count)
  const remaining = res.remaining_count === undefined ? Math.max(wanted - filled, 0) : num(res.remaining_count)
  const yes = res.average_fill_price === undefined || res.average_fill_price === null ? null : Number(res.average_fill_price)
  const px = filled > 0 && yes !== null ? (side === 'yes' ? yes : 1 - yes) : null
  const feeUsd = res.average_fee_paid !== undefined && res.average_fee_paid !== null ? num(res.average_fee_paid) * filled : px !== null ? kalshiFee(px, filled) : 0
  return {
    status: filled > 0 && remaining <= 0 ? 'filled' : filled > 0 ? 'partial' : 'resting',
    filledContracts: filled,
    avgFillC: px === null ? null : toC(px),
    feeUsd: Math.round(feeUsd * 10000) / 10000
  }
}

// An order's state after placing, from Kalshi's own record: the Order from
// GET /portfolio/orders and its fills from GET /portfolio/fills. The fills
// carry the price on each side outright, so they decide the average price and
// the fee; the order's fill cost is the fallback when no fill is listed yet.
// Kalshi's statuses are resting, canceled and executed.
export function kalshiOrderUpdate(order: Record<string, any>, fills: Record<string, any>[], side: ContractSide): OrderUpdate {
  const filled = num(order.fill_count_fp)
  const mine = fills.filter((f) => !f.order_id || f.order_id === order.order_id)
  const fillCount = mine.reduce((n, f) => n + num(f.count_fp), 0)
  let px: number | null = null
  let feeUsd: number
  if (fillCount > 0) {
    px = mine.reduce((s, f) => s + num(f.count_fp) * num(side === 'yes' ? f.yes_price_dollars : f.no_price_dollars), 0) / fillCount
    feeUsd = mine.reduce((s, f) => s + num(f.fee_cost), 0)
  } else {
    if (filled > 0) px = (num(order.taker_fill_cost_dollars) + num(order.maker_fill_cost_dollars)) / filled
    feeUsd = num(order.taker_fees_dollars) + num(order.maker_fees_dollars)
  }
  const st = String(order.status ?? '').toLowerCase()
  return {
    status: st === 'executed' ? 'filled' : st === 'canceled' || st === 'cancelled' ? (filled > 0 ? 'partial' : 'cancelled') : filled > 0 ? 'partial' : 'resting',
    filledContracts: filled,
    avgFillC: px === null ? null : toC(px),
    feeUsd: Math.round(feeUsd * 10000) / 10000,
    done: st === 'executed' || st === 'canceled' || st === 'cancelled'
  }
}

// Signs timestamp_ms + METHOD + the path without its query. The timestamp is
// milliseconds; seconds is a silent 401. Kalshi issues two key types and the
// PEM header does not say which, so the parsed key decides: Ed25519 signs the
// bytes as they are, RSA uses PSS with SHA-256 and salt = digest length.
// Giving an Ed25519 key the RSA options fails inside Electron's BoringSSL
// with COMMAND_NOT_SUPPORTED, which is how the first real key found this.
export function kalshiSign(key: KeyObject, message: string): Buffer {
  const data = Buffer.from(message, 'utf8')
  if (key.asymmetricKeyType === 'ed25519') return sign(null, data, key)
  if (key.asymmetricKeyType === 'rsa') {
    return sign('sha256', data, { key, padding: constants.RSA_PKCS1_PSS_PADDING, saltLength: constants.RSA_PSS_SALTLEN_DIGEST })
  }
  throw new Error(`Kalshi keys are Ed25519 or RSA; this private key is ${key.asymmetricKeyType ?? 'an unknown type'}`)
}

export function kalshiHeaders(key: KeyObject, keyId: string, method: string, path: string, nowMs: number): Record<string, string> {
  const ts = String(nowMs)
  const signature = kalshiSign(key, `${ts}${method}${path.split('?')[0]}`)
  return {
    'KALSHI-ACCESS-KEY': keyId,
    'KALSHI-ACCESS-TIMESTAMP': ts,
    'KALSHI-ACCESS-SIGNATURE': signature.toString('base64')
  }
}

export class KalshiVenue implements Venue {
  readonly id = 'kalshi' as const
  private key: KeyObject | null = null
  private pem: string | null = null
  private balance: { usd: number; equity: number; at: number } | null = null
  private shards = new Map<string, { idx: number | null; at: number }>()
  private shardFail = new Map<number, number>()
  // When Kalshi last refused an order for balance. New orders wait
  // CASH_HOLD_MS after it instead of being sent again every cycle (2026-11-21:
  // 313 refused orders in under two hours).
  private cashShortAt: number | null = null

  constructor(private readonly environment: () => 'production' | 'demo') {}

  private get host(): string {
    return HOSTS[this.environment()]
  }

  configured(): boolean {
    return Boolean(vault.get('kalshi.keyId') && vault.get('kalshi.privateKeyPem'))
  }

  private credentials(): { keyId: string; key: KeyObject } {
    const keyId = vault.get('kalshi.keyId')
    const pem = vault.get('kalshi.privateKeyPem')
    if (!keyId || !pem) throw new Error('Kalshi credentials are not set')
    // Keyed on the PEM, so replacing only the private key takes effect too.
    if (!this.key || this.pem !== pem) {
      this.key = createPrivateKey(pem.replace(/\\n/g, '\n'))
      this.pem = pem
    }
    return { keyId, key: this.key }
  }

  private signedHeaders(method: string, path: string): Record<string, string> {
    const { keyId, key } = this.credentials()
    return kalshiHeaders(key, keyId, method, path, Date.now())
  }

  private authed<T>(method: string, path: string, body?: unknown, query = ''): Promise<T> {
    const full = `${PREFIX}${path}`
    return requestJson<T>(`${this.host}${full}${query}`, { method, body, headers: this.signedHeaders(method, full) })
  }

  async quote(ticker: string, side: ContractSide): Promise<Quote | null> {
    const res = await requestJson<Record<string, any>>(`${this.host}${PREFIX}/markets/${encodeURIComponent(ticker)}/orderbook`)
    return kalshiAsk(res, side)
  }

  // The wait after a refusal for balance, in words, or null.
  private hold(): string | null {
    if (this.cashShortAt === null) return null
    const left = this.cashShortAt + CASH_HOLD_MS - Date.now()
    if (left <= 0) { this.cashShortAt = null; return null }
    const at = new Date(this.cashShortAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
    return `Kalshi refused an order for low balance at ${at}; new orders wait ${Math.ceil(left / 60_000)} more min`
  }

  async state(): Promise<VenueState> {
    if (!this.configured()) return { balanceUsd: null, equityUsd: null }
    const hold = this.hold()
    if (this.balance && Date.now() - this.balance.at < BALANCE_TTL_MS) {
      return { balanceUsd: this.balance.usd, equityUsd: this.balance.equity, hold }
    }
    try {
      const read = kalshiBalance(await this.authed<Record<string, unknown>>('GET', '/portfolio/balance'))
      if (!read) return { balanceUsd: null, equityUsd: null }
      this.balance = { ...read, at: Date.now() }
      return { balanceUsd: read.usd, equityUsd: read.equity, hold }
    } catch {
      return { balanceUsd: null, equityUsd: null }
    }
  }

  private async shardOf(ticker: string): Promise<number | null> {
    const hit = this.shards.get(ticker)
    if (hit && Date.now() - hit.at < 600_000) return hit.idx
    try {
      const res = await requestJson<{ market?: { exchange_index?: number } }>(`${this.host}${PREFIX}/markets/${encodeURIComponent(ticker)}`)
      const idx = res.market?.exchange_index ?? null
      this.shards.set(ticker, { idx, at: Date.now() })
      return idx
    } catch {
      return null
    }
  }

  private async shardBalanceC(shard: number): Promise<number | null> {
    try {
      const b = await this.authed<{ balance?: number }>('GET', '/portfolio/balance', undefined, `?exchange_index=${shard}`)
      return b.balance ?? null
    } catch {
      return null
    }
  }

  // The cash on every shard, in cents, from one balance read: Kalshi's
  // balance_breakdown lists each exchange index, zero balances included. Null
  // when the reply has no breakdown (a key limited to a subaccount).
  private async shardCash(): Promise<Map<number, number> | null> {
    try {
      return kalshiShardCash(await this.authed<Record<string, unknown>>('GET', '/portfolio/balance'))
    } catch {
      return null
    }
  }

  // ensure_shard_funded. Cash moves to the market's shard from whichever
  // shards hold it, shard 0 included as a destination (2026-11-26: NFL markets
  // sit on shard 0 and NBA markets on shard 3; cash was only ever moved out of
  // 0, so once it and the NBA payouts sat on 3, every NFL order from 23
  // November was refused for balance). An unknown shard is allowed through,
  // since auto routing decides (blocking on a lookup hiccup was the 08-27
  // lesson inverted). Shard 0 with no cash found anywhere is allowed through
  // too, so Kalshi's own refusal starts the low balance wait; any other shard
  // fails closed on every doubt.
  private async ensureShardFunded(shard: number | null, needC: number): Promise<string | null> {
    if (shard === null) return null
    const lastFail = this.shardFail.get(shard)
    if (lastFail && Date.now() - lastFail < 600_000) return shard === 0 ? null : `shard ${shard} funding failed recently`
    const fail = (why: string): string | null => { this.shardFail.set(shard, Date.now()); return shard === 0 ? null : why }

    // Every shard's cash from one read; without the breakdown, the target and
    // the other shards seen on markets, one read each.
    let cash = await this.shardCash()
    if (!cash) {
      cash = new Map()
      const seen = new Set<number>([0, shard])
      for (const s of this.shards.values()) if (s.idx !== null) seen.add(s.idx)
      for (const s of seen) { const c = await this.shardBalanceC(s); if (c !== null) cash.set(s, c) }
    }
    const have = cash.get(shard)
    if (have === undefined) return fail(`shard ${shard} balance unreadable`)
    if (have >= needC) return null
    const short = needC - have
    const sources = [...cash.entries()].filter(([s, c]) => s !== shard && c > 0).sort((a, b) => b[1] - a[1])
    const spare = sources.reduce((n, [, c]) => n + c, 0)
    if (spare < short) return fail(`shard ${shard} needs ${needC.toFixed(0)}c, has ${have}c, the other shards ${spare}c`)
    // Largest first, as many shards as it takes, with the buffer on top when
    // there is room for it.
    let want = Math.floor(Math.min(Math.max(SHARD_FUND_MIN_C, short + SHARD_FUND_BUFFER_C), spare))
    for (const [src, c] of sources) {
      if (want <= 0) break
      const amount = Math.floor(Math.min(want, c))
      if (amount <= 0) continue
      try {
        await this.authed('POST', '/portfolio/intra_exchange_instance_transfer', {
          amount: amount * 100, // the endpoint takes centicents ($1 = 10,000)
          source_exchange_shard: src,
          destination_exchange_shard: shard,
          source: 'event_contract',
          destination: 'event_contract'
        })
      } catch (err) {
        return fail(`shard transfer ${src} to ${shard} failed: ${(err as Error).message}`)
      }
      want -= amount
    }
    // Cross shard transfers are documented non atomic; confirm it landed.
    for (let i = 0; i < 4; i++) {
      await new Promise((r) => setTimeout(r, 1000))
      const now = await this.shardBalanceC(shard)
      if (now !== null && now >= needC) return null
    }
    return fail(`transfer to shard ${shard} not visible after 4s`)
  }

  async place(order: TradeDecision): Promise<PlaceResult> {
    const reject = (error: string): PlaceResult => ({
      ok: false, venueOrderId: null, status: 'rejected', filledContracts: 0, avgFillC: null, feeUsd: 0, error
    })

    // Collateral first: the price of the side bought, +5% for fees. The limit
    // is already in our side's terms (a NO bought at 79c ties up 79c). It was
    // once worked out as the complement for NO, so a 79c under moved only 21c
    // a contract to the shard and Kalshi refused it for balance while the
    // cash sat on shard 0 (2026-11-21: "there was enough money in the 3rd").
    const tieC = order.limitPriceC
    const shardProblem = await this.ensureShardFunded(await this.shardOf(order.contract), order.contracts * tieC * 1.05)
    if (shardProblem) return reject(`shard_funding_failed: ${shardProblem}`)

    const yesPriceC = order.side === 'yes' ? order.limitPriceC : 100 - order.limitPriceC
    try {
      const res = await this.authed<Record<string, any>>('POST', '/portfolio/events/orders', {
        ticker: order.contract,
        side: order.side === 'yes' ? 'bid' : 'ask',
        count: countFp(order.contracts),
        price: (yesPriceC / 100).toFixed(2),
        time_in_force: 'good_till_canceled',
        self_trade_prevention_type: 'taker_at_cross',
        expiration_time: Math.floor(Date.now() / 1000) + order.autoCancelS,
        exchange_index: -1,
        client_order_id: order.idempotencyKey
      })
      this.balance = null
      return { ok: true, ...kalshiPlaced(res, order.side, order.contracts), venueOrderId: String(res.order_id ?? '') || null, error: null }
    } catch (err) {
      const msg = (err as Error).message
      if (/insufficient_balance/.test(msg)) { this.cashShortAt = Date.now(); this.balance = null }
      return reject(msg)
    }
  }

  // Sells a held position. The V2 book trades YES only, so selling YES is an
  // ask on YES at our price and selling NO is a bid on YES at the complement.
  // A sell frees collateral, so no shard funding. Kalshi accepts reduce_only
  // only on immediate or cancel orders, so a mark exit can never open a new
  // position; a resting limit exit cannot carry it, and is sized to exactly
  // what this ticket holds.
  async sell(order: SellOrder): Promise<PlaceResult> {
    const yesPriceC = order.side === 'yes' ? order.priceC : 100 - order.priceC
    try {
      const res = await this.authed<Record<string, any>>('POST', '/portfolio/events/orders', {
        ticker: order.contract,
        side: order.side === 'yes' ? 'ask' : 'bid',
        count: countFp(order.contracts),
        price: (yesPriceC / 100).toFixed(2),
        time_in_force: order.timeInForce === 'ioc' ? 'immediate_or_cancel' : 'good_till_canceled',
        ...(order.timeInForce === 'ioc' ? { reduce_only: true } : {}),
        self_trade_prevention_type: 'taker_at_cross',
        exchange_index: -1,
        client_order_id: order.clientOrderId
      })
      this.balance = null
      return { ok: true, ...kalshiPlaced(res, order.side, order.contracts), venueOrderId: String(res.order_id ?? '') || null, error: null }
    } catch (err) {
      const retryable = !(err instanceof HttpError) || err.status === 429 || err.status >= 500
      return { ok: false, venueOrderId: null, status: 'rejected', filledContracts: 0, avgFillC: null, feeUsd: 0, error: (err as Error).message, retryable }
    }
  }

  // ── Combos ───────────────────────────────────────────────────────────
  // A combo is its own market, created from its legs, priced by request for
  // quote. Every call here is Kalshi's documented API (internal/combos.md).

  // One event's markets, a public read, kept ten minutes: the NFL slip
  // mapping reads each game's prop ladders from here (2026-11-21). Null when
  // Kalshi has no such event.
  private eventCache = new Map<string, { at: number; markets: unknown[] | null }>()
  async eventMarkets(eventTicker: string): Promise<unknown[] | null> {
    const kept = this.eventCache.get(eventTicker)
    if (kept && Date.now() - kept.at < 600_000) return kept.markets
    let markets: unknown[] | null = null
    try {
      const res = await requestJson<{ markets?: unknown[]; event?: { markets?: unknown[] } }>(`${this.host}${PREFIX}/events/${encodeURIComponent(eventTicker)}?with_nested_markets=true`)
      markets = eventMarketList(res)
    } catch { markets = null }
    this.eventCache.set(eventTicker, { at: Date.now(), markets })
    return markets
  }

  // Every open market in a series, such as KXNFLGAME, for matching a game to
  // its markets (data/nflkalshi.ts). Public read, kept ten minutes. A failed
  // read gives null, so a game stays unmatched rather than matched to a list
  // that is missing part of the slate.
  private seriesCache = new Map<string, { at: number; markets: { ticker: string; event_ticker: string; expected_expiration_time?: string | null }[] | null }>()
  async openSeriesMarkets(series: string): Promise<{ ticker: string; event_ticker: string; expected_expiration_time?: string | null }[] | null> {
    const kept = this.seriesCache.get(series)
    if (kept && Date.now() - kept.at < 600_000) return kept.markets
    let markets: { ticker: string; event_ticker: string; expected_expiration_time?: string | null }[] | null = []
    try {
      let cursor = ''
      for (let page = 0; page < 10; page++) {
        const res = await requestJson<{ markets?: any[]; cursor?: string }>(`${this.host}${PREFIX}/markets?series_ticker=${encodeURIComponent(series)}&status=open&limit=200${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`)
        for (const m of res.markets ?? []) if (m?.ticker && m?.event_ticker) markets.push({ ticker: String(m.ticker), event_ticker: String(m.event_ticker), expected_expiration_time: m.expected_expiration_time ?? null })
        cursor = res.cursor ?? ''
        if (!cursor) break
      }
    } catch { markets = null }
    this.seriesCache.set(series, { at: Date.now(), markets })
    return markets
  }

  private collections: { at: number; list: { ticker: string; events: Set<string> }[] } | null = null

  // The open combo collection that holds every leg, with each leg's event as
  // Kalshi lists it. A leg's event is the longest front part of its ticker
  // that a combo list names: KXNBAGAME-26NOV23MEMCHA-MEM is in
  // KXNBAGAME-26NOV23MEMCHA, and a player prop such as
  // KXNFLREC-26NOV23CINWAS-WASCOKONKWO85-5 is in KXNFLREC-26NOV23CINWAS, not in
  // a player event (2026-11-23: dropping only the last part sent every player
  // prop combo to an event that does not exist, so none could be priced).
  // A list that holds none is read once more before giving up, and the answer
  // names the legs no list holds.
  async comboCollection(contracts: string[]): Promise<{ ticker: string; events: string[] } | { missing: string[] }> {
    const read = async (): Promise<void> => {
      const res = await requestJson<{ multivariate_contracts?: Record<string, any>[] }>(`${this.host}${PREFIX}/multivariate_event_collections?status=open&limit=200`, { timeoutMs: 30_000 })
      this.collections = {
        at: Date.now(),
        list: (res.multivariate_contracts ?? []).map((c) => ({
          ticker: String(c.collection_ticker ?? ''),
          events: new Set<string>([...(c.associated_event_tickers ?? []), ...(c.associated_events ?? []).map((e: any) => e?.ticker)].filter(Boolean).map(String))
        })).filter((c) => c.ticker)
      }
    }
    const find = (): { ticker: string; events: string[] } | null => {
      for (const c of this.collections?.list ?? []) {
        const events = contracts.map((k) => comboEventOf(k, c.events))
        if (events.every((e): e is string => e !== null)) return { ticker: c.ticker, events }
      }
      return null
    }
    if (!this.collections || Date.now() - this.collections.at > 600_000) await read()
    let found = find()
    if (!found && Date.now() - this.collections!.at > 60_000) { await read(); found = find() }
    if (found) return found
    const held = new Set(this.collections!.list.flatMap((c) => [...c.events]))
    const missing = [...new Set(contracts.filter((k) => comboEventOf(k, held) === null))].map((k) => `${k} is in no combo list`)
    return { missing: missing.length ? missing : [`no one combo list holds ${contracts.join(' and ')}`] }
  }

  // Creates the combo market for these legs, or returns the one that exists.
  async createCombo(collection: string, legs: { contract: string; event: string; side: ContractSide }[]): Promise<string> {
    const res = await this.authed<{ market_ticker?: string }>('POST', `/multivariate_event_collections/${encodeURIComponent(collection)}`, {
      selected_markets: legs.map((l) => ({ market_ticker: l.contract, event_ticker: l.event, side: l.side }))
    })
    if (!res.market_ticker) throw new Error('Kalshi created no combo market')
    return String(res.market_ticker)
  }

  // Sized in contracts, or as a dollar budget fees included, so the maker
  // sizes the quote to what the bot may spend whatever the price.
  async createRfq(marketTicker: string, size: { contracts: number } | { budgetUsd: number }): Promise<string> {
    const res = await this.authed<{ id?: string }>('POST', '/communications/rfqs', {
      market_ticker: marketTicker,
      rest_remainder: false,
      ...('contracts' in size ? { contracts: size.contracts } : { target_cost_dollars: size.budgetUsd.toFixed(2), target_cost_excludes_fees: false })
    })
    if (!res.id) throw new Error('Kalshi returned no request id')
    return String(res.id)
  }

  // Open quotes answering this request, in cents, best price first. Kalshi
  // refuses a quote list that names no requester (2026-11-23, HTTP 403
  // "Either creator_user_id or rfq_creator_user_id must be filled"), so it
  // asks for quotes on this user's own requests, as Kalshi's docs set out.
  async rfqQuotes(rfqId: string): Promise<{ id: string; yesBidC: number; noBidC: number; contracts: number }[]> {
    const res = await this.authed<{ quotes?: Record<string, any>[] }>('GET', '/communications/quotes', undefined, `?rfq_id=${encodeURIComponent(rfqId)}&rfq_user_filter=self&status=open&limit=100`)
    return (res.quotes ?? []).map((q) => ({
      id: String(q.id ?? ''),
      yesBidC: Math.round(Number(q.yes_bid_dollars) * 10000) / 100,
      noBidC: Math.round(Number(q.no_bid_dollars) * 10000) / 100,
      contracts: Number(q.contracts_fp ?? 0)
    })).filter((q) => q.id && Number.isFinite(q.yesBidC) && Number.isFinite(q.noBidC))
  }

  async acceptQuote(rfqId: string, quoteId: string, side: ContractSide): Promise<void> {
    await this.authed('PUT', `/communications/rfqs/${encodeURIComponent(rfqId)}/quotes/${encodeURIComponent(quoteId)}/accept`, { accepted_side: side })
  }

  async deleteRfq(rfqId: string): Promise<void> {
    await this.authed('DELETE', `/communications/rfqs/${encodeURIComponent(rfqId)}`)
  }

  // Our fills on one market since a time: contracts, average price on our
  // side in cents, and fees, from Kalshi's own record.
  // Our fills on one market since a time, each as Kalshi wrote it: action,
  // side, count, the price on each side in cents, and fee.
  async fillsSince(ticker: string, sinceMs: number): Promise<{ action?: string; side?: string; contracts: number; yesC: number; noC: number; feeUsd: number }[]> {
    const res = await this.authed<{ fills?: Record<string, any>[] }>('GET', '/portfolio/fills', undefined, `?ticker=${encodeURIComponent(ticker)}&min_ts=${Math.floor(sinceMs / 1000)}&limit=200`)
    return (res.fills ?? []).map((f) => ({
      action: f.action === undefined ? undefined : String(f.action),
      side: f.side === undefined ? undefined : String(f.side),
      contracts: num(f.count_fp ?? f.count),
      yesC: toC(num(f.yes_price_dollars)),
      noC: toC(num(f.no_price_dollars)),
      feeUsd: num(f.fee_cost)
    })).filter((f) => f.contracts > 0)
  }

  // Every page of the market's orders, so a busy market cannot hide the one
  // we sent. A list that cannot be read to the end throws: unknown, never
  // absent, so the caller never sends the sell again on a guess.
  async findOrder(contract: string, clientOrderId: string): Promise<string | null> {
    let cursor = ''
    for (let page = 0; page < 50; page++) {
      const list = await this.authed<{ orders?: Record<string, any>[]; cursor?: string }>('GET', '/portfolio/orders', undefined,
        `?ticker=${encodeURIComponent(contract)}&limit=200${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`)
      const o = (list.orders ?? []).find((x) => x.client_order_id === clientOrderId)
      if (o?.order_id) return String(o.order_id)
      if (!list.cursor || !(list.orders ?? []).length) return null
      cursor = list.cursor
    }
    throw new Error('the order list is too long to search to the end')
  }

  // The V2 API has no read by order id, so the order is found in the market's
  // order list. Leaving exchange_index off searches every shard. Null when
  // Kalshi does not list it, and the caller keeps the ticket as it was.
  async status(id: string, order: { contract: string; side: ContractSide }): Promise<OrderUpdate | null> {
    if (id.startsWith('dryrun')) return null
    const list = await this.authed<{ orders?: Record<string, any>[] }>('GET', '/portfolio/orders', undefined, `?ticker=${encodeURIComponent(order.contract)}&limit=200`)
    const o = (list.orders ?? []).find((x) => x.order_id === id)
    if (!o) return null
    const fills = num(o.fill_count_fp) > 0
      ? (await this.authed<{ fills?: Record<string, any>[] }>('GET', '/portfolio/fills', undefined, `?order_id=${encodeURIComponent(id)}&limit=200`)).fills ?? []
      : []
    return kalshiOrderUpdate(o, fills, order.side)
  }

  // An order id alone cannot name the shard; the market ticker with
  // exchange_index -1 makes Kalshi route the cancel to the right one.
  async cancel(id: string, contract: string): Promise<void> {
    if (id.startsWith('dryrun')) return
    await this.authed('DELETE', `/portfolio/events/orders/${encodeURIComponent(id)}`, undefined, `?market_ticker=${encodeURIComponent(contract)}&exchange_index=-1`)
  }

  // Public market read. Kalshi publishes the settled side as `result`.
  async settlement(ticker: string): Promise<'yes' | 'no' | null> {
    try {
      const res = await requestJson<{ market?: { status?: string; result?: string } }>(`${this.host}${PREFIX}/markets/${encodeURIComponent(ticker)}`)
      const st = String(res.market?.status ?? '').toLowerCase()
      const result = String(res.market?.result ?? '').toLowerCase()
      if (!['settled', 'finalized', 'determined'].includes(st)) return null
      return result === 'yes' || result === 'no' ? result : null
    } catch {
      return null
    }
  }

  // Public trade prints on one market between two times. One page is enough:
  // the accuracy check only ever asks about a few minutes.
  async prints(ticker: string, fromS: number, toS: number): Promise<{ yesC: number; count: number }[]> {
    const q = `?ticker=${encodeURIComponent(ticker)}&min_ts=${fromS}&max_ts=${toS}&limit=1000`
    const res = await requestJson<{ trades?: Record<string, unknown>[] }>(`${this.host}${PREFIX}/markets/trades${q}`)
    return (res.trades ?? []).flatMap((t) => {
      const yesC = typeof t.yes_price === 'number' ? t.yes_price : Math.round(Number(t.yes_price_dollars) * 100)
      return Number.isFinite(yesC) ? [{ yesC, count: Number(t.count ?? t.count_fp ?? 0) }] : []
    })
  }

  // Says exactly what went wrong: which piece is missing, whether the private
  // key could be read, Kalshi's own error, or the fields it sent instead of a
  // balance. Read only; it never places or cancels anything.
  async test(): Promise<{ ok: boolean; detail: string }> {
    const env = this.environment()
    if (!vault.get('kalshi.keyId')) return { ok: false, detail: 'The key ID is not saved yet.' }
    if (!vault.get('kalshi.privateKeyPem')) return { ok: false, detail: 'The private key is not saved yet.' }
    try {
      this.credentials()
    } catch (err) {
      return { ok: false, detail: `The private key could not be read: ${(err as Error).message}. Paste the whole file, BEGIN and END lines included.` }
    }
    this.balance = null
    try {
      const raw = await this.authed<Record<string, unknown>>('GET', '/portfolio/balance')
      const read = kalshiBalance(raw)
      if (!read) return { ok: false, detail: `Kalshi (${env}) answered without a balance. Fields it sent: ${Object.keys(raw).join(', ') || 'none'}.` }
      this.balance = { ...read, at: Date.now() }
      return { ok: true, detail: `Connected to ${env}. Balance $${read.usd.toFixed(2)}, equity $${read.equity.toFixed(2)}.` }
    } catch (err) {
      if (err instanceof HttpError) {
        let said = err.body.slice(0, 200)
        try {
          const j = JSON.parse(err.body)
          said = [j.error?.code ?? j.code, j.error?.message ?? j.message].filter(Boolean).join(': ') || said
        } catch { /* keep the raw text */ }
        const hint = err.status === 401
          ? env === 'production'
            ? ' Check the key ID and private key are a pair from the same Kalshi API key, and that it is not a demo key.'
            : ' This is set to Demo; a normal Kalshi key needs Production on the Account screen.'
          : ''
        return { ok: false, detail: `Kalshi (${env}) refused with HTTP ${err.status}: ${said}.${hint}` }
      }
      return { ok: false, detail: `Could not reach Kalshi (${env}): ${(err as Error).message}` }
    }
  }
}

// The event a market belongs to, among the events a combo list names: the
// longest front part of the ticker that the list holds, or null.
export function comboEventOf(contract: string, events: Set<string>): string | null {
  const parts = contract.split('-')
  for (let n = parts.length - 1; n >= 2; n--) {
    const e = parts.slice(0, n).join('-')
    if (events.has(e)) return e
  }
  return null
}
