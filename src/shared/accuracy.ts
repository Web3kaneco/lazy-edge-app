// Is the record true? Every ticket is checked against Kalshi's own public
// record, after the fact, by something other than the code that wrote it.
//
// A fill is checked against the real trades printed on that market around the
// moment it filled. If someone traded our side at our price or better, the
// fill was there to be had. If every real trade was worse than our price, the
// paper fill flattered us. With no trades nearby, the book the fill read is
// the only evidence, and only fills placed since the book was recorded have it.
//
// A settlement is checked by re-reading the market's result and recomputing
// the profit from the fill: contracts times (1 - price) for a win, minus
// contracts times price for a loss, minus the fee.
import type { ContractSide } from './signal'

export const BOOK_EVIDENCE = 'book at fill:'
// Real trades this far either side of a fill count as evidence for it.
export const PRINT_WINDOW_S = 120

export type FillVerdict = 'confirmed' | 'book_only' | 'better_than_market' | 'unverified'

export interface Print {
  // Price paid for each side, in cents. yes + no = 100.
  yesC: number
  count: number
}

export interface FillCheck {
  at: number
  prints: number
  // Lowest price any real trade in the window paid for our side.
  bestOurSideC: number | null
  verdict: FillVerdict
}

export interface SettleCheck {
  at: number
  result: ContractSide
  expectedPnlUsd: number
  // Null while the ticket is still open here although Kalshi has settled it.
  recordedPnlUsd: number | null
  ok: boolean
}

export interface AccuracyEntry {
  fill?: FillCheck
  settle?: SettleCheck
}

export interface CheckedTicket {
  id: string
  title: string
  venue: string
  priceSource: string
  side: ContractSide
  filledContracts: number
  avgFillC: number | null
  feeUsd: number
  pnlUsd: number | null
  createdAt: number
  audit: string[]
}

export function classifyFill(t: Pick<CheckedTicket, 'side' | 'avgFillC' | 'audit'>, prints: Print[], at = Date.now()): FillCheck {
  const ours = prints.map((p) => (t.side === 'yes' ? p.yesC : 100 - p.yesC))
  const bestOurSideC = ours.length ? Math.min(...ours) : null
  const hasBook = t.audit.some((a) => a.startsWith(BOOK_EVIDENCE))
  const fill = t.avgFillC ?? Infinity
  const verdict: FillVerdict = bestOurSideC === null
    ? (hasBook ? 'book_only' : 'unverified')
    : bestOurSideC <= fill ? 'confirmed' : 'better_than_market'
  return { at, prints: prints.length, bestOurSideC, verdict }
}

export function expectedPnl(t: Pick<CheckedTicket, 'side' | 'filledContracts' | 'avgFillC' | 'feeUsd'>, result: ContractSide): number {
  const px = (t.avgFillC ?? 0) / 100
  const gross = result === t.side ? t.filledContracts * (1 - px) : -t.filledContracts * px
  return Math.round((gross - t.feeUsd) * 100) / 100
}

export function checkSettlement(t: CheckedTicket, result: ContractSide, at = Date.now()): SettleCheck {
  const expectedPnlUsd = expectedPnl(t, result)
  return { at, result, expectedPnlUsd, recordedPnlUsd: t.pnlUsd, ok: t.pnlUsd !== null && Math.abs(t.pnlUsd - expectedPnlUsd) <= 0.01 }
}

export interface AccuracySummary {
  paperFills: number
  confirmed: number
  bookOnly: number
  betterThanMarket: number
  unverified: number
  pendingFill: number
  settled: number
  settleChecked: number
  settleMismatch: number
  // Kalshi has a result but the ticket is still open here.
  stuckOpen: number
  issues: { id: string; title: string; problem: string }[]
}

export function summarize(tickets: CheckedTicket[], entries: Record<string, AccuracyEntry>): AccuracySummary {
  const fills = tickets.filter((t) => t.venue === 'paper' && t.filledContracts > 0)
  const v = (k: FillVerdict): number => fills.filter((t) => entries[t.id]?.fill?.verdict === k).length
  const settledHere = tickets.filter((t) => t.filledContracts > 0 && t.pnlUsd !== null)
  const issues: AccuracySummary['issues'] = []
  for (const t of tickets) {
    const e = entries[t.id]
    if (e?.fill?.verdict === 'better_than_market') issues.push({ id: t.id, title: t.title, problem: `paper filled at ${t.avgFillC}c; every real trade within ${PRINT_WINDOW_S / 60} minutes paid ${e.fill.bestOurSideC}c or more` })
    if (e?.settle && !e.settle.ok && e.settle.recordedPnlUsd !== null) issues.push({ id: t.id, title: t.title, problem: `recorded ${money(e.settle.recordedPnlUsd)}, Kalshi's result (${e.settle.result.toUpperCase()}) gives ${money(e.settle.expectedPnlUsd)}` })
    if (e?.settle && e.settle.recordedPnlUsd === null && t.pnlUsd === null) issues.push({ id: t.id, title: t.title, problem: `Kalshi settled it ${e.settle.result.toUpperCase()}, still open here` })
  }
  return {
    paperFills: fills.length,
    confirmed: v('confirmed'),
    bookOnly: v('book_only'),
    betterThanMarket: v('better_than_market'),
    unverified: v('unverified'),
    pendingFill: fills.filter((t) => !entries[t.id]?.fill).length,
    settled: settledHere.length,
    settleChecked: settledHere.filter((t) => entries[t.id]?.settle).length,
    settleMismatch: settledHere.filter((t) => entries[t.id]?.settle && !entries[t.id]!.settle!.ok).length,
    stuckOpen: tickets.filter((t) => t.pnlUsd === null && entries[t.id]?.settle).length,
    issues
  }
}

const money = (n: number): string => `${n < 0 ? '−' : ''}$${Math.abs(n).toFixed(2)}`
