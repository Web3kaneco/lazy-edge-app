// NFL moneylines matched to Kalshi's own game markets, for games whose market
// map from the API has no moneyline ticker (2026-11-23: about 100 NFL picks a
// week reached the bots as "WAS wins" with no contract, so no bot could buy
// them, while Kalshi listed the game all along).
//
// Nothing is built from a pattern. The app reads Kalshi's list of open NFL
// game markets and picks the one event whose two team codes are this game's
// away and home teams, in that order; each team's ticker is the market in that
// event ending in the team's code. A game that matches no event, or more than
// one, stays unmatched: a guess here would be a bet on the wrong game.
import { kalshiGameCode, mapLeg, NFL_PROP_SERIES, type KalshiRung, type SlipLeg } from '@shared/nflcombos'
import type { NflMarketMap, Normalized } from './normalize'

// The API names teams by their nflverse codes; Kalshi uses its own for two.
const KALSHI_CODE: Record<string, string> = { JAX: 'JAC', LA: 'LAR' }
export const kalshiNflCode = (code: string): string => KALSHI_CODE[code.toUpperCase()] ?? code.toUpperCase()

// "2026_11_CIN_WAS" is season, week, away, home.
export function nflGameTeams(gameId: string): { away: string; home: string } | null {
  const m = /^\d{4}_\d{1,2}_([A-Z]{2,3})_([A-Z]{2,3})$/.exec(gameId.toUpperCase())
  return m ? { away: m[1]!, home: m[2]! } : null
}

export interface KalshiGameMarket {
  ticker: string
  event_ticker: string
  expected_expiration_time?: string | null
}

// The markets in Kalshi's answer for one event. Kalshi sends an empty list at
// the top beside the real list inside the event (2026-11-23: every NFL player
// prop read as "has no market on Kalshi" because the empty list was taken), so
// the longer list wins.
export function eventMarketList(res: { markets?: unknown[] | null; event?: { markets?: unknown[] | null } | null } | null | undefined): unknown[] {
  const top = Array.isArray(res?.markets) ? res!.markets! : []
  const nested = Array.isArray(res?.event?.markets) ? res!.event!.markets! : []
  return nested.length > top.length ? nested : top
}

const SETTLES_WITHIN_MS = 12 * 3_600_000

export function matchNflMoneyline(
  gameId: string,
  kickoffMs: number | null,
  markets: KalshiGameMarket[]
): { home: string; away: string } | { refuse: string } {
  const teams = nflGameTeams(gameId)
  if (!teams) return { refuse: `game id ${gameId} names no teams` }
  const away = kalshiNflCode(teams.away)
  const home = kalshiNflCode(teams.home)
  // KXNFLGAME-26NOV23CINWAS: the date is seven characters, then away and home.
  const events = new Map<string, KalshiGameMarket[]>()
  for (const m of markets) {
    const tail = m.event_ticker.split('-')[1] ?? ''
    if (tail.slice(7) !== away + home) continue
    events.set(m.event_ticker, [...(events.get(m.event_ticker) ?? []), m])
  }
  let candidates = [...events.values()]
  // With a kickoff, only the event that settles in the hours after it; two
  // division games a season are weeks apart, so this leaves one.
  if (kickoffMs !== null) {
    candidates = candidates.filter((ms) => ms.some((m) => {
      const end = Date.parse(String(m.expected_expiration_time ?? ''))
      return Number.isFinite(end) && end >= kickoffMs && end - kickoffMs <= SETTLES_WITHIN_MS
    }))
  }
  if (candidates.length === 0) return { refuse: `no open Kalshi game market for ${away} at ${home}` }
  if (candidates.length > 1) return { refuse: `${candidates.length} open Kalshi game markets for ${away} at ${home}` }
  const ms = candidates[0]!
  const homeT = ms.find((m) => m.ticker.split('-').pop() === home)?.ticker
  const awayT = ms.find((m) => m.ticker.split('-').pop() === away)?.ticker
  if (!homeT || !awayT) return { refuse: `Kalshi's ${ms[0]!.event_ticker} lacks a market for each team` }
  return { home: homeT, away: awayT }
}

// A live NFL player prop from the hot plays (2026-11-23: "get me the
// props going in NFL"), as the same leg the slips map, so it takes the same
// Kalshi market: the player's market for the stat, at the rung of the API's
// line or the nearest easier one within the stat's limit, never a harder one.
// Our chance at the API's line is then a floor for the Kalshi rung's.
export function nflHotPropLeg(p: any): SlipLeg | null {
  const side = String(p?.side ?? '').toUpperCase()
  const line = typeof p?.line === 'number' ? p.line : Number(p?.line)
  const ourP = Number(p?.our_p)
  if (String(p?.market ?? '').toUpperCase() !== 'PROP' || !p?.player || !p?.stat || !p?.game_id) return null
  if ((side !== 'OVER' && side !== 'UNDER') || !Number.isFinite(line) || !(ourP > 0 && ourP < 1)) return null
  return { player: String(p.player), stat: String(p.stat), side, line, gameId: String(p.game_id), pSide: ourP, team: p.team ? String(p.team) : null }
}

// The key nflHotPlays gives a play, so a prop's signal can be found again.
export const nflHotPlayKey = (p: any): string =>
  `nfl:${p.game_id}:live:PROP:${p.line ?? ''}:${p.player ?? ''}:${p.stat ?? ''}:${String(p.side ?? '').toUpperCase()}`

// The Kalshi events the live props need, by game and stat.
export function nflPropEvents(body: any, maps: Record<string, NflMarketMap>): string[] {
  const out = new Set<string>()
  for (const p of body?.plays ?? []) {
    const leg = nflHotPropLeg(p)
    const series = leg ? NFL_PROP_SERIES[leg.stat] : undefined
    const code = leg ? kalshiGameCode(maps[leg.gameId]?.kalshi_moneyline_home ?? maps[leg.gameId]?.kalshi_moneyline_away) : null
    if (series && code) out.add(`${series}-${code}`)
  }
  return [...out]
}

// Gives each live prop with no contract its Kalshi market, in place. A prop
// that cannot be matched keeps no contract and its reason is refused.
export function mapNflHotProps(body: any, n: Normalized, maps: Record<string, NflMarketMap>, rungs: Map<string, KalshiRung[]>): number {
  const byKey = new Map(n.signals.map((s) => [s.key, s]))
  let matched = 0
  for (const p of body?.plays ?? []) {
    if (String(p?.market ?? '').toUpperCase() !== 'PROP' || p.ticker || p.kalshi_ticker) continue
    const s = byKey.get(nflHotPlayKey(p))
    const leg = nflHotPropLeg(p)
    if (!s || !leg || s.quotes.length) continue
    const m = maps[leg.gameId]
    const r = mapLeg(leg, kalshiGameCode(m?.kalshi_moneyline_home ?? m?.kalshi_moneyline_away), (e) => rungs.get(e))
    if (!r.leg) { n.refused.push({ source: 'nfl.props', reason: r.why }); continue }
    s.quotes = [{ venue: 'kalshi', contract: r.leg.contract, side: r.leg.side, ask: null, askSize: null, priceAgeS: null }]
    s.explicitSide = r.leg.side
    s.title = `${s.matchup ?? ''} ${r.leg.title}`.trim()
    s.why = [s.why, r.leg.exact ? "Kalshi's market at the API's line" : `Kalshi's ${r.leg.floor} rung, easier than the API's ${leg.line}; our chance is a floor`].filter(Boolean).join(' · ')
    matched++
  }
  return matched
}

// In game totals and spreads on Kalshi's full ladder (2026-11-26). The API's
// market map names one total and one spread rung per game, the one nearest
// 50c before kickoff, so an in game play at another line ("Over 54.5" with the
// map on 47.5) found no contract and every one on 23 November stopped at
// no_venue. Kalshi lists every rung in KXNFLTOTAL-<game> and KXNFLSPREAD-<game>;
// the play takes the rung at exactly its own line, or none.
const LADDER_SERIES = { TOTAL: 'KXNFLTOTAL', SPREAD: 'KXNFLSPREAD' } as const
const gameCodeOf = (m: NflMarketMap | undefined): string | null => kalshiGameCode(m?.kalshi_moneyline_home ?? m?.kalshi_moneyline_away)
const teamOf = (ticker: string | undefined): string | null => (ticker ? ticker.split('-').pop() ?? null : null)
const sameLine = (a: number, b: number): boolean => Math.abs(a - b) < 0.01
const playKey = (p: any): string =>
  `nfl:${p.game_id}:live:${String(p.market ?? '').toUpperCase()}:${p.line ?? ''}:${p.player ?? ''}:${p.stat ?? ''}:${String(p.side ?? '').toUpperCase()}`

// The Kalshi ladders the in game totals and spreads need.
export function nflLadderEvents(body: any, maps: Record<string, NflMarketMap>): string[] {
  const out = new Set<string>()
  for (const p of body?.plays ?? []) {
    const series = LADDER_SERIES[String(p?.market ?? '').toUpperCase() as keyof typeof LADDER_SERIES]
    const code = gameCodeOf(maps[String(p?.game_id ?? '')])
    if (series && code) out.add(`${series}-${code}`)
  }
  return [...out]
}

// The contract and side for one play on a ladder, or why there is none.
// Totals: the rung "over L" at the play's line; OVER is YES, UNDER is NO.
// Spreads: the play prices "home margin over thr", the team's own line with
// HOME at -thr and AWAY at +thr. For thr > 0 that is "home wins by over thr",
// the home team's rung (HOME YES, AWAY NO); for thr < 0 it is the complement
// of "away wins by over -thr", the away team's rung (HOME NO, AWAY YES).
export function nflLadderContract(p: any, map: NflMarketMap | undefined, markets: unknown[]): { contract: string; side: 'yes' | 'no' } | { refuse: string } {
  const lane = String(p?.market ?? '').toUpperCase()
  const side = String(p?.side ?? '').toUpperCase()
  const line = typeof p?.line === 'number' ? p.line : Number(p?.line)
  if (!Number.isFinite(line)) return { refuse: `no line on the ${lane.toLowerCase()} play` }
  const rungs = (Array.isArray(markets) ? markets : []).flatMap((m: any) => {
    const floor = Number(m?.floor_strike)
    if (!m?.ticker || !Number.isFinite(floor) || (m.strike_type && m.strike_type !== 'greater')) return []
    if (m.status && !['active', 'open'].includes(String(m.status))) return []
    return [{ ticker: String(m.ticker), floor, team: teamOf(String(m.ticker))?.replace(/\d+$/, '') ?? '' }]
  })
  if (lane === 'TOTAL') {
    if (side !== 'OVER' && side !== 'UNDER') return { refuse: `side ${side} on a total` }
    const r = rungs.find((x) => sameLine(x.floor, line))
    return r ? { contract: r.ticker, side: side === 'OVER' ? 'yes' : 'no' } : { refuse: `Kalshi lists no total at ${line}` }
  }
  if (lane === 'SPREAD') {
    if (side !== 'HOME' && side !== 'AWAY') return { refuse: `side ${side} on a spread` }
    const thr = side === 'HOME' ? -line : line
    if (sameLine(thr, 0)) return { refuse: 'a spread of 0 has no Kalshi rung' }
    const home = teamOf(map?.kalshi_moneyline_home)
    const away = teamOf(map?.kalshi_moneyline_away)
    const team = thr > 0 ? home : away
    if (!team) return { refuse: 'no team codes for the spread' }
    const r = rungs.find((x) => x.team === team && sameLine(x.floor, Math.abs(thr)))
    if (!r) return { refuse: `Kalshi lists no ${team} by over ${Math.abs(thr)}` }
    return { contract: r.ticker, side: (side === 'HOME') === (thr > 0) ? 'yes' : 'no' }
  }
  return { refuse: `lane ${lane} has no ladder` }
}

// Gives each in game total and spread with no contract its Kalshi rung, in
// place. A play already matched through the market map is left as it is.
export function mapNflHotLines(body: any, n: Normalized, maps: Record<string, NflMarketMap>, ladders: Map<string, unknown[]>): number {
  const byKey = new Map(n.signals.map((s) => [s.key, s]))
  let matched = 0
  for (const p of body?.plays ?? []) {
    const lane = String(p?.market ?? '').toUpperCase()
    const series = LADDER_SERIES[lane as keyof typeof LADDER_SERIES]
    if (!series || p.ticker || p.kalshi_ticker) continue
    const s = byKey.get(playKey(p))
    if (!s || s.quotes.length) continue
    const map = maps[String(p.game_id)]
    const code = gameCodeOf(map)
    const markets = code ? ladders.get(`${series}-${code}`) : undefined
    if (!markets) { n.refused.push({ source: 'nfl.ladder', reason: `${series} ladder for ${p.game_id} not read` }); continue }
    const c = nflLadderContract(p, map, markets)
    if ('refuse' in c) { n.refused.push({ source: 'nfl.ladder', reason: c.refuse }); continue }
    s.quotes = [{ venue: 'kalshi', contract: c.contract, side: c.side, ask: null, askSize: null, priceAgeS: null }]
    s.explicitSide = c.side
    s.why = [s.why, "Kalshi's rung at the play's own line"].filter(Boolean).join(' · ')
    matched++
  }
  return matched
}

// Fills in the moneyline tickers the API's map leaves out, game by game. A
// ticker the API gives is kept as it is. Every game is either matched or has
// a reason it was not.
export function fillNflMoneylines(
  maps: Record<string, NflMarketMap>,
  gameIds: Iterable<string>,
  markets: KalshiGameMarket[]
): { maps: Record<string, NflMarketMap>; matched: string[]; refused: { source: string; reason: string }[] } {
  const out: Record<string, NflMarketMap> = { ...maps }
  const matched: string[] = []
  const refused: { source: string; reason: string }[] = []
  for (const id of new Set(gameIds)) {
    const map = out[id]
    if (map?.kalshi_moneyline_home && map?.kalshi_moneyline_away) continue
    const kickoff = Date.parse(String(map?.kickoff ?? ''))
    const m = matchNflMoneyline(id, Number.isFinite(kickoff) ? kickoff : null, markets)
    if ('refuse' in m) { refused.push({ source: 'nfl.kalshi-match', reason: m.refuse }); continue }
    out[id] = { ...map, kalshi_moneyline_home: map?.kalshi_moneyline_home ?? m.home, kalshi_moneyline_away: map?.kalshi_moneyline_away ?? m.away }
    matched.push(id)
  }
  return { maps: out, matched, refused }
}
