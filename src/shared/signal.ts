// One shape for every opportunity the API publishes, whatever the sport or
// lane. src/main/data/normalize.ts builds these; the gates read only these.
import type { Lane, Sport, VenueId } from './schema'

export type ContractSide = 'yes' | 'no'

// A venue's quote for the exact contract this signal would buy.
export interface VenueQuote {
  venue: VenueId
  // Kalshi ticker, or Polymarket CLOB token id.
  contract: string
  side: ContractSide
  // The ask on OUR side in dollars (0 to 1). The price you can trade at is the
  // ask, never the mid (agent guide, reading the data safely, rule 5).
  ask: number | null
  askSize: number | null
  // Seconds since this price last changed. Null means unknown, which the
  // gates treat as stale.
  priceAgeS: number | null
  // The venue's own fee rate for this contract when it reports one. It wins
  // over the ruleset default, so best price is compared after the real fee.
  feeRate?: number | null
}

export interface Signal {
  // Stable across polls so one position per market can be enforced.
  key: string
  sport: Sport
  lane: Lane
  phase: 'pregame' | 'live'
  gameId: string
  title: string
  // The API's own field, e.g. BUY_OVER, BUY_HOME, or a board ref. Kept so the
  // side table can fail closed on anything it does not recognise.
  signalType: string
  // Explicit side when the API states one; otherwise the side table decides.
  explicitSide: ContractSide | null
  // Our probability that THE CONTRACT WE WOULD BUY pays out, already oriented
  // to that side (for an UNDER this is P(under), not P(over)). The normaliser
  // owns the orientation so no gate ever has to flip a probability.
  ourP: number | null
  marketP: number | null
  // Probability points, ours minus the market's. Null is no reading, never 0.
  edgePp: number | null
  label: string
  kelly: number | null
  trigger: boolean
  measured: boolean
  clock: { period: number | null; secondsRemaining: number | null; overtime: boolean } | null
  quotes: VenueQuote[]
  why: string | null
  receivedAt: number
  // "AWAY @ HOME" when the source names the teams; the Board groups by game.
  matchup?: string | null
  // From /v1/nfl/live-plays, the API's hot plays rule.
  hot?: boolean
}

// The strategy facts saved on every ticket, so results can be broken down by
// what kind of play won or lost. Edge is the one the bot traded on, after the
// live requote.
export interface PlayTags {
  sport: Sport
  lane: Lane
  phase: 'pregame' | 'live'
  label: string
  hot: boolean
  measured: boolean
  edgePp: number | null
  ourP: number | null
}

export function playTags(s: Signal): PlayTags {
  return { sport: s.sport, lane: s.lane, phase: s.phase, label: s.label, hot: Boolean(s.hot), measured: s.measured, edgePp: s.edgePp, ourP: s.ourP }
}

// What one bot would do with one signal this cycle. Bots that are switched
// off are evaluated too, as a preview that never places, so the Board can
// show what a bot would take before the user turns it on.
export interface BotVerdict {
  botId: string
  botName: string
  enabled: boolean
  outcome: 'take' | 'skip' | 'holding'
  gate: string | null
  detail: string
}
