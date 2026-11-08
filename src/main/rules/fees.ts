// Ported from the Lazy Edge server engine's EV maths. Pure arithmetic, unit tested
// rather than believed. EV = p - c - fee(c) for a contract held to settlement.
import { FEES } from '@shared/ruleset'
import type { VenueId } from '@shared/schema'

const clamp01 = (x: number): number => Math.min(Math.max(x, 0), 1)

export function kalshiFee(price: number, count = 1, isTaker = true, makerRate: number = FEES.kalshiMakerRate): number {
  const p = clamp01(price)
  const base = FEES.kalshiTakerCoef * count * p * (1 - p)
  return isTaker ? base : base * makerRate
}

export function venueFee(venue: VenueId, price: number, count = 1, polymarketRate: number = FEES.polymarketFeeRate): number {
  if (venue === 'kalshi') return kalshiFee(price, count)
  if (venue === 'polymarket') return polymarketRate * count * Math.min(price, 1 - price)
  // Paper charges what Kalshi would, so a paper record is not flattered.
  return kalshiFee(price, count)
}

// What one order is actually charged: Kalshi rounds each order's fee up to
// the next cent. EV stays per contract and unrounded.
export function orderFee(venue: VenueId, price: number, count: number): number {
  return Math.ceil(venueFee(venue, price, count) * 100 - 1e-9) / 100
}

export function netEv(pModel: number, cost: number, venue: VenueId = 'kalshi', feeRate?: number | null): number {
  const p = clamp01(pModel)
  const c = clamp01(cost)
  return p - c - venueFee(venue, c, 1, feeRate ?? FEES.polymarketFeeRate)
}

export const evCents = (pModel: number, cost: number, venue: VenueId = 'kalshi', feeRate?: number | null): number =>
  100 * netEv(pModel, cost, venue, feeRate)

export const breakevenProb = (cost: number, venue: VenueId = 'kalshi'): number =>
  Math.min(clamp01(cost) + venueFee(venue, clamp01(cost)), 1)
