// The one interface every venue implements (decision 2). The gates never see a
// venue; the supervisor hands a TradeDecision to whichever adapter it names.
import type { VenueId } from '@shared/schema'
import type { ContractSide } from '@shared/signal'
import type { TradeDecision, VenueState } from '../rules/gates'

export interface Quote {
  ask: number | null
  askSize: number | null
  // The best bid on the same side, in dollars, where the book shows it.
  bid?: number | null
  // Age of the book we just read. Zero means we read it this instant.
  priceAgeS: number
}

export interface PlaceResult {
  ok: boolean
  venueOrderId: string | null
  // cancelled: a paper order the live book could not fill at the limit.
  status: 'resting' | 'filled' | 'partial' | 'rejected' | 'cancelled'
  filledContracts: number
  avgFillC: number | null
  feeUsd: number
  error: string | null
  // Paper only: what the live book showed at the moment of filling, kept on
  // the ticket so every paper fill can be checked afterwards.
  evidence?: string
  // A failure that says nothing about the order itself: a timeout, a rate
  // limit or a server error. The order may or may not have reached the book.
  retryable?: boolean
}

export interface OrderUpdate {
  status: 'resting' | 'filled' | 'partial' | 'cancelled'
  filledContracts: number
  avgFillC: number | null
  feeUsd: number | null
  // The order can fill no further: executed, or cancelled with or without
  // fills. A partial fill still on the book is not done.
  done?: boolean
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
  cancel(venueOrderId: string, contract: string): Promise<void>
  // A read only call that proves the credentials work, for the keys screen.
  test(): Promise<{ ok: boolean; detail: string }>
  // How the contract settled, from the venue's own record. Null while open.
  settlement?(contract: string): Promise<ContractSide | null>
  // Sells contracts the account already holds. Only real venues; paper
  // exits are judged against the book by the supervisor.
  sell?(order: SellOrder): Promise<PlaceResult>
  // The venue's id for an order sent with this client order id, or null when
  // the venue has no such order. Throws when the venue cannot be read.
  findOrder?(contract: string, clientOrderId: string): Promise<string | null>
}

export interface SellOrder {
  contract: string
  // The side held, which is the side sold.
  side: ContractSide
  contracts: number
  // Our side's price, in cents.
  priceC: number
  // gtc rests on the book until it fills or the market closes; ioc takes
  // what the book offers now and cancels the rest.
  timeInForce: 'gtc' | 'ioc'
  clientOrderId: string
}
