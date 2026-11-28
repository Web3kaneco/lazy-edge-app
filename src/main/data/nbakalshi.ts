// NBA player props matched to Kalshi's own markets (2026-11-27). From that
// night the API's /v1/nba/props named Polymarket's market for each prop, or
// none, instead of Kalshi's, so no prop reached a bot on a night of eleven
// games. Kalshi lists every player's ladder per game and stat (KXNBAPTS,
// KXNBAREB, KXNBAAST); "Deni Avdija: 20+" is YES above 19.5. A prop takes the
// rung for the same player at exactly the API's line, since our chance was
// worked out for that line and no other. No rung at that line, no trade.
import { initialKey, kalshiGameCode, nameKey, type KalshiRung } from '@shared/nflcombos'
import type { Normalized } from './normalize'

export const NBA_PROP_SERIES = { pts: 'KXNBAPTS', reb: 'KXNBAREB', ast: 'KXNBAAST' } as const

const sameLine = (a: number, b: number): boolean => Math.abs(a - b) < 0.01
const needsMatch = (s: Normalized['signals'][number]): boolean =>
  s.sport === 'NBA' && s.lane === 'PROP' && s.quotes.length === 0 && Boolean(s.prop?.player && s.prop?.stat)

// Each game's Kalshi game code (26NOV27GSWPOR) from any Kalshi NBA game ticker
// the other feeds carry for it.
export function nbaGameCodes(signals: Normalized['signals']): Map<string, string> {
  const out = new Map<string, string>()
  for (const s of signals) {
    if (s.sport !== 'NBA' || out.has(s.gameId)) continue
    for (const q of s.quotes) {
      if (q.venue !== 'kalshi' || !/^KXNBA[A-Z]+-/.test(q.contract)) continue
      const code = kalshiGameCode(q.contract)
      if (code) { out.set(s.gameId, code); break }
    }
  }
  return out
}

// The Kalshi events the unmatched props need.
export function nbaPropEvents(n: Normalized, codes: Map<string, string>): string[] {
  const out = new Set<string>()
  for (const s of n.signals) {
    if (!needsMatch(s)) continue
    const code = codes.get(s.gameId)
    if (code) out.add(`${NBA_PROP_SERIES[s.prop!.stat!]}-${code}`)
  }
  return [...out]
}

// Gives each unmatched prop its Kalshi rung, in place: the contract, the key
// it would have had from the API, over YES and under NO. A prop that cannot be
// matched is taken out and its reason refused, as before.
export function mapNbaProps(n: Normalized, codes: Map<string, string>, rungs: Map<string, KalshiRung[]>): number {
  let matched = 0
  const keep: Normalized['signals'] = []
  for (const s of n.signals) {
    if (!needsMatch(s)) { keep.push(s); continue }
    const { player, stat, line, over } = s.prop!
    const code = codes.get(s.gameId)
    const event = code ? `${NBA_PROP_SERIES[stat!]}-${code}` : null
    const ladder = event ? rungs.get(event) : undefined
    if (!ladder) { n.refused.push({ source: 'nba.props', reason: code ? `${event} not read` : 'no Kalshi game for the prop' }); continue }
    let mine = ladder.filter((r) => nameKey(r.player) === nameKey(player!))
    if (!mine.length) mine = ladder.filter((r) => initialKey(r.player) === initialKey(player!))
    if (!mine.length) { n.refused.push({ source: 'nba.props', reason: `${player} has no ${stat} market on Kalshi` }); continue }
    const rung = mine.find((r) => sameLine(r.floor, line))
    if (!rung) { n.refused.push({ source: 'nba.props', reason: `Kalshi lists no ${stat} line at ${line}` }); continue }
    const side = over ? 'yes' : 'no'
    s.key = `nba:${s.gameId}:PROP:${rung.ticker}`
    s.quotes = [{ venue: 'kalshi', contract: rung.ticker, side, ask: null, askSize: null, priceAgeS: null }]
    s.explicitSide = side
    s.why = [s.why, "Kalshi's market at the same line"].filter(Boolean).join(' · ')
    keep.push(s)
    matched++
  }
  n.signals = keep
  return matched
}
