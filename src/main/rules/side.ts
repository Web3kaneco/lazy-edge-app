// The fail closed side table, from the server engine's Kalshi executor. The old logic
// derived the side by substring ("BUY" in signal -> yes) and BUY_UNDER bought
// the OVER on roughly half of all totals trades. An unrecognised signal is
// refused, never guessed: we do not understand the contract, so we do not buy it.
import type { ContractSide, Signal } from '@shared/signal'

const SIDE_BY_SIGNAL: Readonly<Record<string, ContractSide>> = {
  // Totals ride ONE strike where YES = over the line, so UNDER is the NO side
  // of that same strike.
  BUY_OVER: 'yes',
  BUY_UNDER: 'no',
  // Moneyline sides each have their OWN ticker, so both are YES on theirs.
  BUY_HOME: 'yes',
  BUY_AWAY: 'yes'
}

export function resolveSide(signal: Pick<Signal, 'signalType' | 'explicitSide'>): ContractSide | null {
  const table = SIDE_BY_SIGNAL[(signal.signalType ?? '').trim().toUpperCase()] ?? null
  // If the API states a side and the table disagrees, the two readings of the
  // same contract conflict, and that is exactly when not to trade.
  if (signal.explicitSide && table && signal.explicitSide !== table) return null
  return signal.explicitSide ?? table
}
