import { generateKeyPairSync } from 'node:crypto'
import { beforeEach, describe, expect, it, vi } from 'vitest'

// Every request the venue makes, answered from `replies` by method and path.
const calls: { method: string; url: string; body?: unknown; headers?: Record<string, string> }[] = []
let replies: Record<string, unknown> = {}
vi.mock('../src/main/data/http', () => ({
  HttpError: class HttpError extends Error {},
  requestJson: async (url: string, opts: { method?: string; body?: unknown; headers?: Record<string, string> } = {}) => {
    const method = opts.method ?? 'GET'
    calls.push({ method, url, body: opts.body, headers: opts.headers })
    const path = new URL(url).pathname.replace('/trade-api/v2', '')
    const hit = replies[`${method} ${path}`]
    if (hit === undefined) throw new Error(`unexpected ${method} ${path}`)
    // A function answers from the full url, or throws as the venue would.
    return typeof hit === 'function' ? (hit as (u: string, b?: unknown) => unknown)(url, opts.body) : hit
  }
}))
const pem = generateKeyPairSync('ed25519').privateKey.export({ type: 'pkcs8', format: 'pem' }).toString()
vi.mock('../src/main/store/vault', () => ({
  vault: { get: (k: string) => ({ 'kalshi.keyId': 'key-123', 'kalshi.privateKeyPem': pem } as Record<string, string>)[k] }
}))

const { KalshiVenue, kalshiOrderUpdate, kalshiPlaced, kalshiShardCash } = await import('../src/main/venues/kalshi')
const { kalshiFee } = await import('../src/main/rules/fees')

// Shapes as Kalshi documents them (docs.kalshi.com/openapi.yaml, 2026-11).
const order = (o: Record<string, unknown>): Record<string, unknown> => ({
  order_id: 'ord-1', ticker: 'KXNFLGAME-99JAN01CHISEA-SEA', status: 'resting', outcome_side: 'yes', book_side: 'bid',
  yes_price_dollars: '0.4500', no_price_dollars: '0.5500', fill_count_fp: '0.00', remaining_count_fp: '10.00', initial_count_fp: '10.00',
  taker_fill_cost_dollars: '0.0000', maker_fill_cost_dollars: '0.0000', taker_fees_dollars: '0.0000', maker_fees_dollars: '0.0000', ...o
})

describe('Kalshi order placed (CreateOrderV2Response)', () => {
  it('reads a full fill, price in YES terms, fee per contract', () => {
    const r = kalshiPlaced({ order_id: 'a', fill_count: '10.00', remaining_count: '0.00', average_fill_price: '0.4500', average_fee_paid: '0.0174', ts_ms: 1 }, 'yes', 10)
    expect(r).toEqual({ status: 'filled', filledContracts: 10, avgFillC: 45, feeUsd: 0.174 })
  })
  it('turns a NO buy into the complement of the YES book price', () => {
    const r = kalshiPlaced({ order_id: 'a', fill_count: '4.00', remaining_count: '6.00', average_fill_price: '0.7000', average_fee_paid: '0.0150', ts_ms: 1 }, 'no', 10)
    expect(r).toEqual({ status: 'partial', filledContracts: 4, avgFillC: 30, feeUsd: 0.06 })
  })
  it('is resting when nothing filled, with no price and no fee', () => {
    expect(kalshiPlaced({ order_id: 'a', fill_count: '0.00', remaining_count: '10.00', ts_ms: 1 }, 'yes', 10))
      .toEqual({ status: 'resting', filledContracts: 0, avgFillC: null, feeUsd: 0 })
  })
  it('falls back to the fee formula when Kalshi leaves the fee out', () => {
    const r = kalshiPlaced({ order_id: 'a', fill_count: '10.00', remaining_count: '0.00', average_fill_price: '0.4500', ts_ms: 1 }, 'yes', 10)
    expect(r.feeUsd).toBeCloseTo(kalshiFee(0.45, 10), 4)
  })
})

describe('Kalshi order after placing (Order and Fill)', () => {
  it('a resting order that later filled is recorded as filled, priced from its fills', () => {
    const fills = [
      { order_id: 'ord-1', count_fp: '6.00', yes_price_dollars: '0.4400', no_price_dollars: '0.5600', fee_cost: '0.1000' },
      { order_id: 'ord-1', count_fp: '4.00', yes_price_dollars: '0.4500', no_price_dollars: '0.5500', fee_cost: '0.0700' }
    ]
    const u = kalshiOrderUpdate(order({ status: 'executed', fill_count_fp: '10.00', remaining_count_fp: '0.00' }), fills, 'yes')
    expect(u).toEqual({ status: 'filled', filledContracts: 10, avgFillC: 44.4, feeUsd: 0.17, done: true })
  })
  it('prices a NO order from the NO side of each fill', () => {
    const fills = [{ order_id: 'ord-1', count_fp: '5.00', yes_price_dollars: '0.6800', no_price_dollars: '0.3200', fee_cost: '0.0800' }]
    expect(kalshiOrderUpdate(order({ status: 'executed', fill_count_fp: '5.00', remaining_count_fp: '0.00' }), fills, 'no').avgFillC).toBe(32)
  })
  it('an expired order with some fills is partial, with none cancelled', () => {
    const fills = [{ order_id: 'ord-1', count_fp: '3.00', yes_price_dollars: '0.4500', no_price_dollars: '0.5500', fee_cost: '0.0500' }]
    expect(kalshiOrderUpdate(order({ status: 'canceled', fill_count_fp: '3.00', remaining_count_fp: '0.00' }), fills, 'yes').status).toBe('partial')
    // Cancelled with fills can fill no further, so its cost becomes what filled.
    expect(kalshiOrderUpdate(order({ status: 'canceled', fill_count_fp: '3.00', remaining_count_fp: '0.00' }), fills, 'yes').done).toBe(true)
    expect(kalshiOrderUpdate(order({ status: 'canceled' }), [], 'yes')).toEqual({ status: 'cancelled', filledContracts: 0, avgFillC: null, feeUsd: 0, done: true })
  })
  it('uses the order fill cost when no fill is listed yet', () => {
    const u = kalshiOrderUpdate(order({ status: 'resting', fill_count_fp: '2.00', remaining_count_fp: '8.00', taker_fill_cost_dollars: '0.9000', taker_fees_dollars: '0.0300' }), [], 'yes')
    expect(u).toEqual({ status: 'partial', filledContracts: 2, avgFillC: 45, feeUsd: 0.03, done: false })
  })
})

describe('Kalshi venue requests', () => {
  beforeEach(() => { calls.length = 0; replies = {} })
  const venue = new KalshiVenue(() => 'production')

  it('finds an order in the market order list across every shard, then reads its fills', async () => {
    replies = {
      'GET /portfolio/orders': { orders: [order({ order_id: 'other' }), order({ status: 'executed', fill_count_fp: '10.00', remaining_count_fp: '0.00' })], cursor: '' },
      'GET /portfolio/fills': { fills: [{ order_id: 'ord-1', count_fp: '10.00', yes_price_dollars: '0.4500', no_price_dollars: '0.5500', fee_cost: '0.1700' }], cursor: '' }
    }
    const u = await venue.status('ord-1', { contract: 'KXNFLGAME-99JAN01CHISEA-SEA', side: 'yes' })
    expect(u).toEqual({ status: 'filled', filledContracts: 10, avgFillC: 45, feeUsd: 0.17, done: true })
    expect(calls[0]!.url).toContain('/portfolio/orders?ticker=KXNFLGAME-99JAN01CHISEA-SEA')
    expect(calls[0]!.url).not.toContain('exchange_index')
    expect(calls[1]!.url).toContain('/portfolio/fills?order_id=ord-1')
    // Signed over the path without its query.
    expect(calls[0]!.headers?.['KALSHI-ACCESS-KEY']).toBe('key-123')
  })
  it('never calls the read by id path the V2 API does not have', async () => {
    replies = { 'GET /portfolio/orders': { orders: [order({})], cursor: '' } }
    await venue.status('ord-1', { contract: 'KXNFLGAME-99JAN01CHISEA-SEA', side: 'yes' })
    expect(calls.some((c) => c.url.includes('/events/orders/'))).toBe(false)
  })
  it('is null when Kalshi does not list the order', async () => {
    replies = { 'GET /portfolio/orders': { orders: [], cursor: '' } }
    expect(await venue.status('ord-1', { contract: 'KXNFLGAME-99JAN01CHISEA-SEA', side: 'yes' })).toBeNull()
  })
  it('cancels with the market ticker so Kalshi routes it to the right shard', async () => {
    replies = { 'DELETE /portfolio/events/orders/ord-1': { order_id: 'ord-1', reduced_by: '10.00', ts_ms: 1 } }
    await venue.cancel('ord-1', 'KXNFLGAME-99JAN01CHISEA-SEA')
    expect(calls[0]!.method).toBe('DELETE')
    expect(calls[0]!.url).toContain('market_ticker=KXNFLGAME-99JAN01CHISEA-SEA')
    expect(calls[0]!.url).toContain('exchange_index=-1')
  })
  // A NO bought at 79c on a market on shard 3, the shape of the 2026-11-21 props.
  const noOrder = { venue: 'kalshi', priceSource: 'kalshi', contract: 'KXNBAREB-99JAN01AAABBB-AAASTAR1-6', side: 'no', contracts: 6, limitPriceC: 79, costUsd: 4.74,
    evCents: 1, pCalibrated: 0.8, breakeven: 0.8, idempotencyKey: 'k1', autoCancelS: 120, audit: [], kind: 'trade' } as never

  it('moves the price of the side bought to the shard: a 79c NO needs 79c a contract, not 21c', async () => {
    let shard3 = 200 // $2 already on shard 3
    replies = {
      'GET /markets/KXNBAREB-99JAN01AAABBB-AAASTAR1-6': { market: { exchange_index: 3 } },
      'GET /portfolio/balance': (u: string) => ({ balance: u.includes('exchange_index=3') ? shard3 : 10_000 }),
      'POST /portfolio/intra_exchange_instance_transfer': (_u: string, b: { amount: number }) => { shard3 += b.amount / 100; return {} },
      'POST /portfolio/events/orders': { order_id: 'o1', fill_count: '6.00', remaining_count: '0.00', average_fill_price: '0.2100', average_fee_paid: '0.0100', ts_ms: 1 }
    }
    const r = await venue.place(noOrder)
    expect(r.ok).toBe(true)
    const transfer = calls.find((c) => c.url.includes('intra_exchange_instance_transfer'))
    // 6 x 79c x 1.05 = 497.7c needed, 200c there: 297.7c short plus the 200c buffer.
    expect((transfer?.body as { amount: number }).amount).toBe(49_700)
    expect(shard3).toBeGreaterThanOrEqual(6 * 79 * 1.05)
  })

  it('after Kalshi refuses for balance, new orders wait instead of going again every cycle', async () => {
    replies = {
      'GET /markets/KXNBAREB-99JAN01AAABBB-AAASTAR1-6': { market: { exchange_index: 0 } },
      'GET /portfolio/balance': { balance: 300 },
      'POST /portfolio/events/orders': () => { throw new Error('HTTP 400 from api.elections.kalshi.com: {"error":{"code":"insufficient_balance","message":"insufficient balance"}}') }
    }
    const fresh = new KalshiVenue(() => 'production')
    expect((await fresh.state()).hold).toBeNull()
    const r = await fresh.place(noOrder)
    expect(r).toMatchObject({ ok: false, status: 'rejected' })
    expect((await fresh.state()).hold).toMatch(/low balance/)
  })

  // 2026-11-26: NFL markets on shard 0, the cash on shard 3 from the NBA
  // nights, and every NFL order refused for balance from 23 November.
  const nflOrder = { ...(noOrder as object), contract: 'KXNFLGAME-99JAN01GBLAR-LAR', side: 'yes', contracts: 8, limitPriceC: 56 } as never
  const shardReplies = (pots: Record<number, number>, ticker: string, idx: number) => ({
    [`GET /markets/${ticker}`]: { market: { exchange_index: idx } },
    'GET /portfolio/balance': (u: string) => {
      const m = /exchange_index=(\d+)/.exec(u)
      if (m) return { balance: pots[Number(m[1])] ?? 0 }
      return { balance: Object.values(pots).reduce((a, b) => a + b, 0), balance_breakdown: Object.entries(pots).map(([i, c]) => ({ exchange_index: Number(i), balance: (c / 100).toFixed(4) })) }
    },
    'POST /portfolio/intra_exchange_instance_transfer': (_u: string, b: { amount: number; source_exchange_shard: number; destination_exchange_shard: number }) => {
      pots[b.source_exchange_shard] = (pots[b.source_exchange_shard] ?? 0) - b.amount / 100
      pots[b.destination_exchange_shard] = (pots[b.destination_exchange_shard] ?? 0) + b.amount / 100
      return {}
    },
    'POST /portfolio/events/orders': { order_id: 'o2', fill_count: '8.00', remaining_count: '0.00', average_fill_price: '0.5600', average_fee_paid: '0.0200', ts_ms: 1 }
  })

  it('funds shard 0 from shard 3 when the cash sits on the NBA shard', async () => {
    const pots: Record<number, number> = { 0: 12, 3: 20_000 }
    replies = shardReplies(pots, 'KXNFLGAME-99JAN01GBLAR-LAR', 0)
    const r = await new KalshiVenue(() => 'production').place(nflOrder)
    expect(r.ok).toBe(true)
    const t = calls.filter((c) => c.url.includes('intra_exchange_instance_transfer')).map((c) => c.body as Record<string, number>)
    expect(t).toHaveLength(1)
    expect(t[0]).toMatchObject({ source_exchange_shard: 3, destination_exchange_shard: 0 })
    // 8 x 56c x 1.05 = 470.4c needed, 12c there: 458.4c short plus the 200c buffer.
    expect(t[0]!.amount).toBe(65_800)
    expect(pots[0]).toBeGreaterThanOrEqual(8 * 56 * 1.05)
  })

  it('takes cash from as many shards as it needs, largest first', async () => {
    const pots: Record<number, number> = { 0: 300, 3: 250, 5: 0 }
    replies = shardReplies(pots, 'KXNBAREB-99JAN01AAABBB-AAASTAR1-6', 5)
    const r = await new KalshiVenue(() => 'production').place(noOrder) // 497.7c needed on shard 5
    expect(r.ok).toBe(true)
    const t = calls.filter((c) => c.url.includes('intra_exchange_instance_transfer')).map((c) => c.body as Record<string, number>)
    expect(t.map((b) => [b.source_exchange_shard, b.destination_exchange_shard, b.amount])).toEqual([[0, 5, 30_000], [3, 5, 25_000]])
    expect(pots[5]).toBe(550)
  })

  it('refuses an order on another shard when the whole account is short, and moves nothing', async () => {
    const pots: Record<number, number> = { 0: 100, 3: 50 }
    replies = shardReplies(pots, 'KXNBAREB-99JAN01AAABBB-AAASTAR1-6', 3)
    const r = await new KalshiVenue(() => 'production').place(noOrder)
    expect(r).toMatchObject({ ok: false, status: 'rejected' })
    expect(r.error).toMatch(/shard 3 needs 498c, has 50c, the other shards 100c/)
    expect(calls.some((c) => c.url.includes('intra_exchange_instance_transfer') || c.url.includes('/events/orders'))).toBe(false)
  })

  it('reads the cash on each shard from the balance breakdown', () => {
    expect(kalshiShardCash({ balance: 100, balance_breakdown: [{ exchange_index: 0, balance: '0.1200' }, { exchange_index: 3, balance: '200.5000' }] }))
      .toEqual(new Map([[0, 12], [3, 20_050]]))
    expect(kalshiShardCash({ balance: 100 })).toBeNull()
  })

  it('leaves dry run orders alone', async () => {
    await venue.cancel('dryrun-abc', 'KXNFLGAME-99JAN01CHISEA-SEA')
    expect(await venue.status('dryrun-abc', { contract: 'X', side: 'yes' })).toBeNull()
    expect(calls).toHaveLength(0)
  })
})
