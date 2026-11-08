// The one interface every venue implements (decision 2). The gates never see a
// venue; the supervisor hands a TradeDecision to whichever adapter it names.
import type { VenueId } from '@shared/schema'
import type { ContractSide } from '@shared/signal'
import type { TradeDecision, VenueState } from '../rules/gates'

export interface Quote {
  ask: number | null
  askSize: number | null
  // Age of the book we just read. Zero means we read it this instant.
  priceAgeS: number
}

export interface PlaceResult {
  ok: boolean
  venueOrderId: string | null
  // cancelled: a paper order the live book could not fill at the limit.
  status: 'dry_run' | 'resting' | 'filled' | 'partial' | 'rejected' | 'cancelled'
  filledContracts: number
  avgFillC: number | null
  feeUsd: number
  error: string | null
  // Paper only: what the live book showed at the moment of filling, kept on
  // the ticket so every paper fill can be checked afterwards.
  evidence?: string
}

export interface OrderUpdate {
  status: 'resting' | 'filled' | 'partial' | 'cancelled'
  filledContracts: number
  avgFillC: number | null
  feeUsd: number | null
}

export interface Venue {
  readonly id: VenueId
  // Whether the user has supplied the credentials this venue needs.
  configured(): boolean
  // Public book read, no credentials needed.
  quote(contract: string, side: ContractSide): Promise<Quote | null>
  state(): Promise<VenueState>
  place(order: TradeDecision): Promise<PlaceResult>
  status(venueOrderId: string, order: { contract: string; side: ContractSide }): Promise<OrderUpdate | null>
  cancel(venueOrderId: string): Promise<void>
  // A read only call that proves the credentials work, for the keys screen.
  test(): Promise<{ ok: boolean; detail: string }>
  // How the contract settled, from the venue's own record. Null while open.
  settlement?(contract: string): Promise<ContractSide | null>
}

export const DRY_RUN_RESULT = (order: TradeDecision): PlaceResult => ({
  ok: true,
  venueOrderId: `dryrun-${order.idempotencyKey}`,
  status: 'dry_run',
  filledContracts: 0,
  avgFillC: null,
  feeUsd: 0,
  error: null
})
