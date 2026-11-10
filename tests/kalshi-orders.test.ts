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
    return hit
  }
}))
const pem = generateKeyPairSync('ed25519').privateKey.export({ type: 'pkcs8', format: 'pem' }).toString()
vi.mock('../src/main/store/vault', () => ({
  vault: { get: (k: string) => ({ 'kalshi.keyId': 'key-123', 'kalshi.privateKeyPem': pem } as Record<string, string>)[k] }
}))

const { KalshiVenue, kalshiOrderUpdate, kalshiPlaced } = await import('../src/main/venues/kalshi')
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
    expect(u).toEqual({ status: 'filled', filledContracts: 10, avgFillC: 44.4, feeUsd: 0.17 })
  })
  it('prices a NO order from the NO side of each fill', () => {
    const fills = [{ order_id: 'ord-1', count_fp: '5.00', yes_price_dollars: '0.6800', no_price_dollars: '0.3200', fee_cost: '0.0800' }]
    expect(kalshiOrderUpdate(order({ status: 'executed', fill_count_fp: '5.00', remaining_count_fp: '0.00' }), fills, 'no').avgFillC).toBe(32)
  })
  it('an expired order with some fills is partial, with none cancelled', () => {
    const fills = [{ order_id: 'ord-1', count_fp: '3.00', yes_price_dollars: '0.4500', no_price_dollars: '0.5500', fee_cost: '0.0500' }]
    expect(kalshiOrderUpdate(order({ status: 'canceled', fill_count_fp: '3.00', remaining_count_fp: '0.00' }), fills, 'yes').status).toBe('partial')
    expect(kalshiOrderUpdate(order({ status: 'canceled' }), [], 'yes')).toEqual({ status: 'cancelled', filledContracts: 0, avgFillC: null, feeUsd: 0 })
  })
  it('uses the order fill cost when no fill is listed yet', () => {
    const u = kalshiOrderUpdate(order({ status: 'resting', fill_count_fp: '2.00', remaining_count_fp: '8.00', taker_fill_cost_dollars: '0.9000', taker_fees_dollars: '0.0300' }), [], 'yes')
    expect(u).toEqual({ status: 'partial', filledContracts: 2, avgFillC: 45, feeUsd: 0.03 })
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
    expect(u).toEqual({ status: 'filled', filledContracts: 10, avgFillC: 45, feeUsd: 0.17 })
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
  it('leaves dry run orders alone', async () => {
    await venue.cancel('dryrun-abc', 'KXNFLGAME-99JAN01CHISEA-SEA')
    expect(await venue.status('dryrun-abc', { contract: 'X', side: 'yes' })).toBeNull()
    expect(calls).toHaveLength(0)
  })
})
