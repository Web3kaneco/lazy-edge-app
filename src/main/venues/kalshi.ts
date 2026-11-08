// Kalshi, ported from the server engine's Kalshi executor. Three lessons from that file
// each cost a night of zero trades, and all three live here:
//   1. Requests are signed over timestamp_ms + METHOD + path without the
//      query: RSA keys with RSA-PSS, SHA-256, salt = digest length (PKCS1v15
//      is rejected); Ed25519 keys, Kalshi's default since 2026, directly.
//   2. The V2 order book trades in YES terms only. Buying NO at 30c is an ask
//      on YES at 70c. exchange_index -1 forces routing by ticker.
//   3. Collateral must already sit on the market's shard, or the order dies
//      user_not_found. It is moved from shard 0 and confirmed before placing.
import { constants, createPrivateKey, sign, type KeyObject } from 'node:crypto'
import type { ContractSide } from '@shared/signal'
import { HttpError, requestJson } from '../data/http'
import type { TradeDecision, VenueState } from '../rules/gates'
import { kalshiFee } from '../rules/fees'
import { vault } from '../store/vault'
import { DRY_RUN_RESULT, type OrderUpdate, type PlaceResult, type Quote, type Venue } from './types'

const HOSTS = {
  production: 'https://api.elections.kalshi.com',
  demo: 'https://demo-api.kalshi.co'
} as const
const PREFIX = '/trade-api/v2'

const SHARD_FUND_BUFFER_C = 200
const SHARD_FUND_MIN_C = 100
const BALANCE_TTL_MS = 60_000

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
  if (!opposite) return { ask: null, askSize: null, priceAgeS: 0 }
  return { ask: Math.round((1 - opposite[0]) * 100) / 100, askSize: opposite[1], priceAgeS: 0 }
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

  async state(): Promise<VenueState> {
    if (!this.configured()) return { balanceUsd: null, equityUsd: null }
    if (this.balance && Date.now() - this.balance.at < BALANCE_TTL_MS) {
      return { balanceUsd: this.balance.usd, equityUsd: this.balance.equity }
    }
    try {
      const read = kalshiBalance(await this.authed<Record<string, unknown>>('GET', '/portfolio/balance'))
      if (!read) return { balanceUsd: null, equityUsd: null }
      this.balance = { ...read, at: Date.now() }
      return { balanceUsd: read.usd, equityUsd: read.equity }
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

  // ensure_shard_funded, fail closed on every doubt. Shard 0 or unknown is
  // allowed through: 0 is where cash lives, and unknown means auto routing
  // decides (blocking on a lookup hiccup was the 08-27 lesson inverted).
  private async ensureShardFunded(shard: number | null, needC: number): Promise<string | null> {
    if (shard === null || shard === 0) return null
    const lastFail = this.shardFail.get(shard)
    if (lastFail && Date.now() - lastFail < 600_000) return `shard ${shard} funding failed recently`
    const fail = (why: string): string => { this.shardFail.set(shard, Date.now()); return why }

    const have = await this.shardBalanceC(shard)
    if (have === null) return fail(`shard ${shard} balance unreadable`)
    if (have >= needC) return null
    const src = await this.shardBalanceC(0)
    if (src === null || src < needC - have) return fail(`shard ${shard} needs ${needC.toFixed(0)}c, shard 0 has ${src ?? 0}c`)
    const amount = Math.floor(Math.min(Math.max(SHARD_FUND_MIN_C, needC - have + SHARD_FUND_BUFFER_C), src))
    try {
      await this.authed('POST', '/portfolio/intra_exchange_instance_transfer', {
        amount: amount * 100, // the endpoint takes centicents ($1 = 10,000)
        source_exchange_shard: 0,
        destination_exchange_shard: shard,
        source: 'event_contract',
        destination: 'event_contract'
      })
    } catch (err) {
      return fail(`shard transfer failed: ${(err as Error).message}`)
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
    if (order.dryRun) return DRY_RUN_RESULT(order)
    const reject = (error: string): PlaceResult => ({
      ok: false, venueOrderId: null, status: 'rejected', filledContracts: 0, avgFillC: null, feeUsd: 0, error
    })

    // Collateral first. YES ties up the price, NO the complement; +5% for fees.
    const tieC = order.side === 'yes' ? order.limitPriceC : 100 - order.limitPriceC
    const shardProblem = await this.ensureShardFunded(await this.shardOf(order.contract), order.contracts * tieC * 1.05)
    if (shardProblem) return reject(`shard_funding_failed: ${shardProblem}`)

    const yesPriceC = order.side === 'yes' ? order.limitPriceC : 100 - order.limitPriceC
    try {
      const res = await this.authed<Record<string, any>>('POST', '/portfolio/events/orders', {
        ticker: order.contract,
        side: order.side === 'yes' ? 'bid' : 'ask',
        count: `${order.contracts}.00`,
        price: (yesPriceC / 100).toFixed(2),
        time_in_force: 'good_till_canceled',
        self_trade_prevention_type: 'taker_at_cross',
        expiration_time: Math.floor(Date.now() / 1000) + order.autoCancelS,
        exchange_index: -1,
        client_order_id: order.idempotencyKey
      })
      this.balance = null
      return { ok: true, ...this.readOrder(res.order ?? res, order.side, order.contracts), venueOrderId: String((res.order ?? res).order_id ?? '') || null, error: null }
    } catch (err) {
      return reject((err as Error).message)
    }
  }

  private readOrder(o: Record<string, any>, side: ContractSide, wanted: number): Omit<PlaceResult, 'ok' | 'venueOrderId' | 'error'> {
    const filled = Number(o.fill_count ?? 0)
    const remaining = Number(o.remaining_count ?? Math.max(wanted - filled, 0))
    // average_fill_price is in YES terms; a NO buy's cost is the complement.
    const yes = o.average_fill_price === undefined || o.average_fill_price === null ? null : Number(o.average_fill_price)
    const px = filled > 0 && yes !== null ? (side === 'yes' ? yes : 1 - yes) : null
    const feeReported = o.taker_fees_dollars ?? o.taker_fees
    const feeUsd = feeReported !== undefined ? Number(feeReported) / (o.taker_fees_dollars !== undefined ? 1 : 100) : px !== null ? kalshiFee(px, filled) : 0
    return {
      status: filled > 0 && remaining <= 0 ? 'filled' : filled > 0 ? 'partial' : 'resting',
      filledContracts: filled,
      avgFillC: px === null ? null : Math.round(px * 10000) / 100,
      feeUsd
    }
  }

  async status(id: string, order: { contract: string; side: ContractSide }): Promise<OrderUpdate | null> {
    if (id.startsWith('dryrun')) return null
    // A GET by id carries no ticker, so routing cannot apply. Ask the market's
    // own shard first, then the bare path.
    const shard = await this.shardOf(order.contract)
    const queries = [shard !== null && shard !== 0 ? `?exchange_index=${shard}` : '', '']
    for (const q of queries) {
      try {
        const res = await this.authed<Record<string, any>>('GET', `/portfolio/events/orders/${encodeURIComponent(id)}`, undefined, q)
        const o = res.order ?? res
        const read = this.readOrder(o, order.side, Number(o.initial_count ?? o.count ?? 0))
        const st = String(o.status ?? '').toLowerCase()
        const closed = ['canceled', 'cancelled', 'expired'].includes(st)
        return {
          status: read.status === 'filled' ? 'filled' : closed ? (read.filledContracts > 0 ? 'partial' : 'cancelled') : read.status === 'partial' ? 'partial' : 'resting',
          filledContracts: read.filledContracts,
          avgFillC: read.avgFillC,
          feeUsd: read.feeUsd
        }
      } catch { /* try the next path */ }
    }
    return null
  }

  async cancel(id: string): Promise<void> {
    if (id.startsWith('dryrun')) return
    await this.authed('DELETE', `/portfolio/events/orders/${encodeURIComponent(id)}`)
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
