// Getting out before settlement (2026-11-16). A bot set to exit sells what it
// bought at entry + target cents: limit rests the sell on the book the moment
// the entry fills; mark watches the book and sells at the bid once the bid
// reaches the target. Whatever does not sell is held to settlement. Pure, so
// the engine and the tests read the same numbers.
//
// Paper exits are judged against the real book, never flattered: a resting
// limit sell fills only once the bid on our side reaches it, at its own price
// and as a maker; a mark sell fills at the bid, as a taker, and no more than
// the bid offers.
import { FEES } from './ruleset'

export type ExitMode = 'limit' | 'mark'

export interface TicketExit {
  mode: ExitMode
  // The sell price on our side, in cents.
  targetC: number
  // waiting: nothing on the book yet. resting: a limit sell is on the book.
  // done: everything held was sold, or the rest settled. failed: the venue
  // refused the sell; the position is held to settlement.
  status: 'waiting' | 'resting' | 'done' | 'failed'
  orderId: string | null
  filledContracts: number
  avgC: number | null
  feeUsd: number
  error: string | null
  // What had already sold before the resting order went on the book, since
  // the venue reports each order's own totals.
  prior?: { contracts: number; avgC: number | null; feeUsd: number }
  // The client order id of a sell sent whose outcome is not yet known: written
  // before sending, so a timeout or a crash is looked up, never sent twice.
  pending?: { clientOrderId: string; timeInForce: 'gtc' | 'ioc'; sentAt?: number } | null
  // The kill switch cancelled the resting sell. Once the venue reports it
  // done, what it sold is kept and the rest waits to be placed again.
  killed?: boolean
  // Cashed out by hand: nothing more is sold on its own. What the cash out
  // could not sell is held to settlement.
  cashout?: boolean
}

export interface CashOutResult {
  // Positions sold in full, in part, and left held, with why.
  sold: number
  partly: number
  kept: { title: string; why: string }[]
  contracts: number
  // Realised on what sold, after both fees.
  pnlUsd: number
  botsOff: number
}

// The exit once a resting order reports its own totals so far.
export function withOrderTotals(exit: TicketExit, order: { contracts: number; avgC: number | null; feeUsd: number | null }): TicketExit {
  const base = exit.prior ?? { contracts: 0, avgC: null, feeUsd: 0 }
  const n = base.contracts + order.contracts
  const avgC = n ? ((base.avgC ?? 0) * base.contracts + (order.avgC ?? exit.targetC) * order.contracts) / n : null
  return { ...exit, filledContracts: n, avgC: avgC === null ? null : Math.round(avgC * 100) / 100, feeUsd: Math.round((base.feeUsd + (order.feeUsd ?? 0)) * 10000) / 10000 }
}

export const exitTargetC = (entryC: number, targetC: number): number => Math.min(99, Math.round(entryC) + targetC)

export function newExit(mode: ExitMode, entryC: number, targetC: number): TicketExit {
  return { mode, targetC: exitTargetC(entryC, targetC), status: 'waiting', orderId: null, filledContracts: 0, avgC: null, feeUsd: 0, error: null }
}

// Kalshi's fee, rounded up per order; a maker pays a quarter of the taker fee.
export function exitFee(priceC: number, contracts: number, taker: boolean): number {
  const p = Math.min(Math.max(priceC / 100, 0), 1)
  const fee = FEES.kalshiTakerCoef * contracts * p * (1 - p) * (taker ? 1 : FEES.kalshiMakerRate)
  return Math.ceil(fee * 100 - 1e-9) / 100
}

// The bid on our side, read as the ask on the other side: someone selling the
// other side at 30c is buying ours at 70c.
export function bidFromOtherAsk(otherAsk: number | null, otherAskSize: number | null): { bidC: number; size: number } | null {
  if (otherAsk === null || !otherAskSize || otherAskSize < 1) return null
  return { bidC: Math.round((1 - otherAsk) * 100), size: Math.floor(otherAskSize) }
}

export interface ExitFill { contracts: number; priceC: number; feeUsd: number }

export function paperExitFill(exit: TicketExit, heldContracts: number, bid: { bidC: number; size: number } | null): ExitFill | null {
  if (!bid || heldContracts < 1 || bid.bidC < exit.targetC) return null
  const contracts = Math.min(heldContracts, bid.size)
  if (contracts < 1) return null
  const priceC = exit.mode === 'limit' ? exit.targetC : bid.bidC
  return { contracts, priceC, feeUsd: exitFee(priceC, contracts, exit.mode === 'mark') }
}

// The exit after one more fill, averaging the price over everything sold.
export function addExitFill(exit: TicketExit, fill: ExitFill): TicketExit {
  const n = exit.filledContracts + fill.contracts
  const avgC = ((exit.avgC ?? 0) * exit.filledContracts + fill.priceC * fill.contracts) / n
  return { ...exit, filledContracts: n, avgC: Math.round(avgC * 100) / 100, feeUsd: Math.round((exit.feeUsd + fill.feeUsd) * 100) / 100 }
}

interface Position { filledContracts: number; avgFillC: number | null; feeUsd: number; side: 'yes' | 'no'; exit?: TicketExit | null }

// Profit and loss after every fee: what was sold at its exit price, and what
// was still held at settlement. Null while anything is still held and the
// market has not settled.
export function positionPnl(t: Position, settled: 'yes' | 'no' | null): number | null {
  if (t.avgFillC === null || t.filledContracts < 1) return null
  const entry = t.avgFillC / 100
  const sold = Math.min(t.exit?.filledContracts ?? 0, t.filledContracts)
  const held = t.filledContracts - sold
  if (held > 0 && settled === null) return null
  const fromExit = sold * (((t.exit?.avgC ?? 0) / 100) - entry)
  const fromSettle = held === 0 ? 0 : settled === t.side ? held * (1 - entry) : -held * entry
  return Math.round((fromExit + fromSettle - t.feeUsd - (t.exit?.feeUsd ?? 0)) * 100) / 100
}
