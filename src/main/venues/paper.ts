// Paper trading against real books. At the moment of placing, a paper order
// rereads the live book on the venue it was priced off and fills only what a
// real order could have: at the current ask if that is at or under the limit,
// and no more contracts than the ask offers. Anything else does not fill.
// It pays the fee that venue would charge, rounded up per order the way
// Kalshi charges it, so a paper record is never flattered.
//
// Paper orders are fill or kill: one that would have rested on the book is
// recorded as not filled, rather than guessing whether it would have filled
// later. That understates fills slightly, never overstates them.
import { BOOK_EVIDENCE } from '@shared/accuracy'
import type { ContractSide } from '@shared/signal'
import type { VenueId } from '@shared/schema'
import type { TradeDecision, VenueState } from '../rules/gates'
import { orderFee } from '../rules/fees'
import type { OrderUpdate, PlaceResult, Quote, Venue } from './types'

type BookReader = (venue: VenueId, contract: string, side: ContractSide) => Promise<Quote | null>

export function paperFill(order: Pick<TradeDecision, 'contracts' | 'limitPriceC' | 'priceSource'>, book: Quote | null): PlaceResult {
  const evidence = book ? bookEvidence(book) : undefined
  const none = (error: string): PlaceResult => ({ ok: true, venueOrderId: null, status: 'cancelled', filledContracts: 0, avgFillC: null, feeUsd: 0, error, evidence })
  if (!book || book.ask === null) return none('no live price at the moment of placing')
  const askC = Math.round(book.ask * 100)
  if (askC > order.limitPriceC) return none(`the ask moved to ${askC}c, above the ${order.limitPriceC}c limit`)
  const filled = Math.min(order.contracts, Math.floor(book.askSize ?? 0))
  if (filled < 1) return none('no contracts offered at the ask')
  return {
    ok: true,
    venueOrderId: null,
    status: filled < order.contracts ? 'partial' : 'filled',
    filledContracts: filled,
    avgFillC: askC,
    feeUsd: orderFee(order.priceSource, askC / 100, filled),
    error: filled < order.contracts ? `only ${filled} of ${order.contracts} offered at ${askC}c` : null,
    evidence
  }
}

const bookEvidence = (b: Quote): string =>
  `${BOOK_EVIDENCE} ask ${b.ask === null ? 'none' : `${Math.round(b.ask * 100)}c`} x ${b.askSize ?? 0}, read ${b.priceAgeS}s before`

export class PaperVenue implements Venue {
  readonly id = 'paper' as const

  // The supervisor owns the paper balance, because it is derived from the
  // ledger: starting balance, minus open cost, plus settled profit and loss.
  constructor(private readonly balance: () => VenueState, private readonly readBook: BookReader) {}

  configured(): boolean {
    return true
  }

  async quote(): Promise<Quote | null> {
    return null // paper prices off the real venues
  }

  async state(): Promise<VenueState> {
    return this.balance()
  }

  async place(order: TradeDecision): Promise<PlaceResult> {
    const book = await this.readBook(order.priceSource, order.contract, order.side).catch(() => null)
    const res = paperFill(order, book)
    return res.filledContracts > 0 ? { ...res, venueOrderId: `paper-${order.idempotencyKey}` } : res
  }

  async status(): Promise<OrderUpdate | null> {
    return null
  }

  async cancel(): Promise<void> {}

  async test(): Promise<{ ok: boolean; detail: string }> {
    const s = this.balance()
    return { ok: true, detail: `Paper balance $${(s.balanceUsd ?? 0).toFixed(2)}.` }
  }
}
