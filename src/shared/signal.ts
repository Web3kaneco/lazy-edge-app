// One shape for every opportunity the API publishes, whatever the sport or
// lane. src/main/data/normalize.ts builds these; the gates read only these.
import type { Lane, Quarter, Sport, VenueId } from './schema'
import type { Trail } from './trail'

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
  // The best bid on our side in dollars, read with the ask on the live
  // requote. Missing or null means unknown.
  bid?: number | null
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
  // The team a moneyline or spread play backs (2026-11-17). lead is its
  // points ahead from the feed's score, negative when it trails; winP is the
  // market's chance it wins the game. Either is null when the feed gives
  // none, and the field is missing where the feed carries no score.
  team?: { lead: number | null; winP: number | null }
  // Our pick on a game whose edge points at the other team, or has no edge
  // at all (2026-11-17). Only a bot that buys our pick reads it.
  pickOnly?: boolean
  // In play, whether our pick differs from our last pregame call, held at the
  // tip (API #981, pick_changed). Null when the feed does not say.
  pickChanged?: boolean | null
  // A player prop: its line, what the player had when it was priced, the
  // side, and his team's points ahead (negative behind) when known.
  // rank is the player's place in his game by our points projection, 1 the
  // highest, null when the feed gives no projection.
  // From 2026-11-24, the API's own times on the player's row: statsAt when
  // its poller last wrote his box line (updated_at), pricedAt when c2 worked
  // out his chance (c2_priced_at), both epoch ms; liveModel c2 or formula;
  // minutes his minutes so far. Missing or null when the feed gives none.
  prop?: { line: number; soFar: number | null; over: boolean; teamLead: number | null; rank?: number | null; statsAt?: number | null; pricedAt?: number | null; liveModel?: string | null; minutes?: number | null }
  // What happened just before the play (shared/trail.ts), set on the live
  // requote. Recorded only; no gate reads it.
  trail?: Trail
  // The honest chance (shared/honest.ts): ourP is the chance the gates read;
  // rawP is the feed's own when the honest one is lower, and honestNotes say
  // why. comeback is the measured record for the game's spot, NBA only.
  rawP?: number | null
  honestNotes?: string[]
  // When the game starts, ms; null or missing when the feed does not say.
  startsAt?: number | null
  comeback?: { winP: number; trailingHome: boolean; deficit: number | null; bucket: string | null }
}

// Whether a signal is our pick: our number has the contract it buys paying
// out more often than not. A dead even game has no pick.
export const isOurPick = (s: Pick<Signal, 'ourP'>): boolean => s.ourP !== null && s.ourP > 0.5

// A play that backs one team to win or cover.
export const isTeamPlay = (s: Pick<Signal, 'lane'>): boolean => s.lane === 'MONEYLINE' || s.lane === 'SPREAD'

// The market's chance that the team a play backs wins the game. A moneyline's
// own market price is exactly that; a spread needs the game's moneyline.
export function teamWinP(s: Pick<Signal, 'lane' | 'marketP' | 'team'>): number | null {
  if (!isTeamPlay(s)) return null
  return s.team?.winP ?? (s.lane === 'MONEYLINE' ? s.marketP : null)
}

// The quarter a live play is in: Q1 to Q4, OT past the fourth, null when the
// feed gives no period.
// Minutes played in the current quarter, from the game clock (NBA quarters
// are 12 minutes, NFL 15). Null in overtime or when the clock cannot say.
export function minutesIntoQuarter(signal: Pick<Signal, 'clock' | 'sport'>): number | null {
  const c = signal.clock
  if (!c || c.overtime || c.secondsRemaining === null || c.period === null || c.period < 1 || c.period > 4) return null
  const len = signal.sport === 'NFL' ? 900 : 720
  const left = c.secondsRemaining - (4 - c.period) * len
  if (left < 0 || left > len) return null
  return (len - left) / 60
}

export function quarterOf(signal: Pick<Signal, 'clock'>): Quarter | 'OT' | null {
  const p = signal.clock?.period
  if (signal.clock?.overtime || (p !== null && p !== undefined && p > 4)) return 'OT'
  return p === 1 || p === 2 || p === 3 || p === 4 ? (`Q${p}` as Quarter) : null
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
  // From 0.8.0: where the game stood. quarter is Pregame, Q1 to Q4 or OT;
  // lead is the backed team's points ahead in a live game; teamWinP the
  // market's chance that team wins. Null where it does not apply or the feed
  // gave none; missing on older tickets.
  quarter?: Quarter | 'OT' | 'Pregame' | null
  lead?: number | null
  teamWinP?: number | null
  // From 0.9.2, on our pick in play: whether it changed from the pregame call.
  pickChanged?: boolean | null
  // From 0.9.2, where the play was (2026-11-21: "where was the play,
  // can the AI know that"): game seconds left when bought, the market's price
  // on the side bought, and for a prop its line, the player's total so far,
  // over or under, and his team's score.
  secondsLeft?: number | null
  marketP?: number | null
  propLine?: number | null
  propSoFar?: number | null
  propOver?: boolean | null
  propTeamLead?: number | null
  propRank?: number | null
  // From 0.9.2: the feed's own chance when the honest chance was lower. ourP
  // is then the honest one the trade was taken on.
  rawP?: number | null
  // From 2026-11-24: Kalshi's move, the edge's age, the player's count and
  // the feed's times just before the play (shared/trail.ts).
  trail?: Trail
}

export function playTags(s: Signal): PlayTags {
  return {
    sport: s.sport, lane: s.lane, phase: s.phase, label: s.label, hot: Boolean(s.hot), measured: s.measured, edgePp: s.edgePp, ourP: s.ourP,
    quarter: s.phase === 'pregame' ? 'Pregame' : quarterOf(s),
    lead: s.phase === 'live' && isTeamPlay(s) ? s.team?.lead ?? null : null,
    teamWinP: teamWinP(s),
    ...(s.pickChanged === undefined ? {} : { pickChanged: s.pickChanged }),
    secondsLeft: s.phase === 'live' ? s.clock?.secondsRemaining ?? null : null,
    marketP: s.marketP,
    ...(s.prop ? { propLine: s.prop.line, propSoFar: s.prop.soFar, propOver: s.prop.over, propTeamLead: s.prop.teamLead, propRank: s.prop.rank ?? null } : {}),
    ...(s.rawP != null && s.rawP !== s.ourP ? { rawP: s.rawP } : {}),
    ...(s.trail ? { trail: s.trail } : {})
  }
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
