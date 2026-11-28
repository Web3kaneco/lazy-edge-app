// The API's NFL slips as Kalshi combos (2026-11-21: "the NFL combos
// still work, we just have to map them; there are a lot more, so we need
// limits and a ranking").
//
// The API prices its slips at sportsbook lines with no Kalshi tickers. Kalshi
// lists the same props as one event per game and stat (KXNFLPASSYDS-
// 26NOV22ARIKC) with a market per player and rung ("Patrick Mahomes: 250+",
// YES above 249.5). A leg maps when its game, stat, player and a rung near its
// line are all found:
//   - an over takes the highest Kalshi rung at or under its line, an under
//     the lowest at or over it, so the Kalshi leg is never harder than the one
//     the API priced, and our chance at the API's line is a floor for ours at
//     Kalshi's;
//   - a rung further than the stat's limit away is no match.
// A slip is bought only when every leg maps. Ranking and limits sit in the
// supervisor once each leg's live ask is read.
import type { ComboLeg } from './combos'

export const NFL_PROP_SERIES: Record<string, string> = {
  pass_yds: 'KXNFLPASSYDS',
  rush_yds: 'KXNFLRSHYDS',
  rec_yds: 'KXNFLRECYDS',
  receptions: 'KXNFLREC'
}

// The furthest a Kalshi rung may sit from the API's line, by stat.
export const NFL_MAX_GAP: Record<string, number> = { pass_yds: 25, rush_yds: 10, rec_yds: 10, receptions: 1 }

export interface SlipLeg { player: string; stat: string; side: 'OVER' | 'UNDER'; line: number; gameId: string; pSide: number; team: string | null }
export interface Slip { key: string; name: string; legs: SlipLeg[]; chance: number }

const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null)

function legOf(x: any): SlipLeg | null {
  const side = String(x?.side ?? '').toUpperCase()
  const line = num(x?.line)
  const pOver = num(x?.p_over)
  const pSide = num(x?.p_side) ?? (pOver === null ? null : side === 'OVER' ? pOver : 1 - pOver)
  if (!x?.player || !x?.stat || (side !== 'OVER' && side !== 'UNDER') || line === null || pSide === null || !(pSide > 0 && pSide < 1) || !x?.game_id) return null
  return { player: String(x.player), stat: String(x.stat), side, line, gameId: String(x.game_id), pSide, team: x.team ? String(x.team) : null }
}

// The curated slips and, where the API sends them, its same-game pairs, each
// with the legs and our chance that all of them hit. Anything that cannot be
// read whole is left out.
export function nflSlips(body: unknown): Slip[] {
  const b = body as any
  const out: Slip[] = []
  for (const s of Array.isArray(b?.slips) ? b.slips : []) {
    const legs = (Array.isArray(s?.legs) ? s.legs : []).map(legOf)
    const chance = num(s?.quote?.our_prob) ?? num(s?.our_prob)
    if (legs.length < 2 || legs.some((l: SlipLeg | null) => !l) || chance === null) continue
    out.push({ key: `slip:${s.key ?? s.name}`, name: String(s.name ?? s.key ?? 'Slip'), legs: legs as SlipLeg[], chance })
  }
  for (const p of Array.isArray(b?.pairs) ? b.pairs : []) {
    const raw = Array.isArray(p?.legs) ? p.legs : [p?.a ?? p?.leg1, p?.b ?? p?.leg2]
    const legs = raw.map(legOf)
    const chance = num(p?.joint) ?? num(p?.our_prob)
    if (legs.length !== 2 || legs.some((l: SlipLeg | null) => !l) || chance === null) continue
    out.push({ key: `pair:${legs.map((l: SlipLeg) => `${l.player}|${l.stat}|${l.side}`).join('+')}`, name: `Same game pair: ${legs.map((l: SlipLeg) => l.player).join(' and ')}`, legs: legs as SlipLeg[], chance })
  }
  return out
}

export interface KalshiRung { ticker: string; event: string; player: string; floor: number }

// Kalshi's markets for one game and stat as rungs: "Patrick Mahomes: 250+" is
// YES above 249.5.
export function kalshiRungs(event: string, markets: unknown): KalshiRung[] {
  const out: KalshiRung[] = []
  for (const m of Array.isArray(markets) ? markets : []) {
    const floor = num((m as any)?.floor_strike)
    const sub = String((m as any)?.yes_sub_title ?? '')
    const player = sub.includes(':') ? sub.slice(0, sub.indexOf(':')).trim() : ''
    if (!(m as any)?.ticker || floor === null || !player || ((m as any)?.strike_type && (m as any).strike_type !== 'greater')) continue
    out.push({ ticker: String((m as any).ticker), event, player, floor })
  }
  return out
}

// A name as both sides spell it: lower case, letters only, no suffixes.
export function nameKey(name: string): string {
  return name.toLowerCase().replace(/\b(jr|sr|ii|iii|iv|v)\b\.?/g, '').replace(/[^a-z ]/g, '').replace(/\s+/g, ' ').trim()
}
export const initialKey = (name: string): string => { const k = nameKey(name).split(' '); return k.length > 1 ? `${k[0]![0]} ${k[k.length - 1]}` : k[0] ?? '' }

// The Kalshi game code (26NOV22NYJLAC) from a Kalshi game ticker.
export const kalshiGameCode = (ticker: string | undefined): string | null => {
  const parts = String(ticker ?? '').split('-')
  return parts.length >= 2 && parts[1] ? parts[1] : null
}

export interface MappedLeg extends ComboLeg { floor: number; exact: boolean }

export function mapLeg(leg: SlipLeg, gameCode: string | null, rungsFor: (event: string) => KalshiRung[] | undefined): { leg: MappedLeg | null; why: string } {
  const series = NFL_PROP_SERIES[leg.stat]
  if (!series) return { leg: null, why: `Kalshi lists no ${leg.stat} props` }
  if (!gameCode) return { leg: null, why: `no Kalshi game for ${leg.gameId}` }
  const event = `${series}-${gameCode}`
  const rungs = rungsFor(event)
  if (!rungs) return { leg: null, why: `${event} not read` }
  const want = nameKey(leg.player)
  let mine = rungs.filter((r) => nameKey(r.player) === want)
  if (!mine.length) mine = rungs.filter((r) => initialKey(r.player) === initialKey(leg.player))
  if (!mine.length) return { leg: null, why: `${leg.player} has no ${leg.stat} market on Kalshi` }
  const gap = NFL_MAX_GAP[leg.stat] ?? 0
  const pick = leg.side === 'OVER'
    ? mine.filter((r) => r.floor <= leg.line + 1e-9 && leg.line - r.floor <= gap).sort((a, b) => b.floor - a.floor)[0]
    : mine.filter((r) => r.floor >= leg.line - 1e-9 && r.floor - leg.line <= gap).sort((a, b) => a.floor - b.floor)[0]
  if (!pick) return { leg: null, why: `no Kalshi rung for ${leg.player} ${leg.side.toLowerCase()} ${leg.line} within ${gap}` }
  const words = leg.stat.replace('_', ' ').replace('yds', 'yards')
  return {
    leg: {
      signalKey: `nfl-slip:${pick.ticker}:${leg.side}`, gameId: event, contract: pick.ticker, side: leg.side === 'OVER' ? 'yes' : 'no',
      title: `${leg.player} ${leg.side === 'OVER' ? 'over' : 'under'} ${pick.floor} ${words}`,
      // Our chance at the API's line: a floor for ours at Kalshi's, since the
      // Kalshi leg is never the harder one.
      ourP: leg.pSide, askC: 0, edgePp: 0, floor: pick.floor, exact: Math.abs(pick.floor - leg.line) < 1e-9
    },
    why: ''
  }
}

// Which slips to try, best first, within the bot's limits: every leg mapped
// and priced, our chance above the legs bought one by one, at most one combo
// a day per player, never one already bought today.
export interface Ranked { slip: Slip; legs: MappedLeg[]; legsPriceC: number; edgePp: number }
export function rankSlips(candidates: Ranked[], opts: { max: number; boughtKeys: Set<string>; usedPlayers: Set<string> }): Ranked[] {
  const out: Ranked[] = []
  const used = new Set(opts.usedPlayers)
  for (const c of [...candidates].sort((a, b) => b.edgePp - a.edgePp || b.slip.chance - a.slip.chance)) {
    if (out.length >= opts.max) break
    if (c.edgePp <= 0 || opts.boughtKeys.has(c.slip.key)) continue
    const players = c.slip.legs.map((l) => nameKey(l.player))
    if (players.some((p) => used.has(p))) continue
    players.forEach((p) => used.add(p))
    out.push(c)
  }
  return out
}
