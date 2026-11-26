// Patterns in the user's own graded record (2026-11-21: "patterns on
// losses also; losses tell more than wins; if it was a 2nd quarter instead of
// a 4th with the same settings, that is what I want the AI to do").
//
// Two kinds:
//  - Inside one bot: the same settings, a different spot. Each part of a bot's
//    record (a quarter, the time left, the score, our chance, the price, for a
//    prop how far the player was from the line) against the rest of that
//    bot's trades. A losing spot carries the one setting that leaves it out.
//  - Across the record: a sport, lane, point of the game and chance band that
//    beat its prices, which can start a paper bot of its own.
//
// Proven needs the Results bar: 20 trades across 20 games, two standard
// errors. Early is 8 trades at one and a half, and is shown as early.
import { applyFix, type Fix } from './fixes'
import { defaultBot } from './ruleset'
import { DIMENSIONS, fixFor, segment, settled, tagsOf, type SettledLike } from './results'
import type { BotSettings, Lane, Quarter, Sport } from './schema'

export interface PatternBuild {
  sport: Sport
  lane: Lane
  phase: 'pregame' | 'live'
  quarter: Quarter | null
  chanceLo: number | null
  minEdgePp: number
  priceLoC: number
  priceHiC: number
}

export interface Pattern {
  key: string
  kind: 'losing' | 'winning'
  strength: 'proven' | 'early'
  // The bot whose own record this is, or null for the whole record.
  botId: string | null
  botName: string | null
  dimension: string
  segment: string
  title: string
  n: number
  games: number
  won: number
  lost: number
  centsPerContract: number
  z: number
  // The same bot's other trades, for the comparison.
  rest: { n: number; centsPerContract: number } | null
  // A losing spot: the setting that leaves it out of this bot.
  fix?: Fix
  // A winning spot across the record: what a paper bot for it would trade.
  build?: PatternBuild
}

const PROVEN = { n: 20, games: 20, z: 2 }
const EARLY = { n: 8, z: 1.5 }
// Dimensions that say who, not where: not a pattern inside one bot.
const SKIP = new Set(['bot', 'sport', 'lane', 'label', 'hot', 'side'])
const LANE_WORD: Partial<Record<Lane, string>> = { MONEYLINE: 'moneylines', SPREAD: 'spreads', TOTAL: 'totals', PROP: 'props', TEAM_TOTAL: 'team totals' }
const Q_WORD: Record<string, string> = { Q1: 'the 1st quarter', Q2: 'the 2nd quarter', Q3: 'the 3rd quarter', Q4: 'the 4th quarter' }
const CHANCE = [[50, 60], [60, 70], [70, 80], [80, 90], [90, 100]] as const
const priceOf = (t: SettledLike): number => t.avgFillC ?? t.limitPriceC
const round1 = (n: number): number => Math.round(n * 10) / 10

function grade(n: number, games: number, z: number, pnl: number): { kind: Pattern['kind']; strength: Pattern['strength'] } | null {
  const kind = pnl < 0 && z < 0 ? 'losing' : pnl > 0 && z > 0 ? 'winning' : null
  if (!kind) return null
  if (n >= PROVEN.n && games >= PROVEN.games && Math.abs(z) >= PROVEN.z) return { kind, strength: 'proven' }
  if (n >= EARLY.n && Math.abs(z) >= EARLY.z) return { kind, strength: 'early' }
  return null
}

// Inside each bot: every spot against the rest of the same bot's trades.
function insideBots(done: SettledLike[], bots: BotSettings[]): Pattern[] {
  const out: Pattern[] = []
  const byBot = new Map<string, SettledLike[]>()
  for (const t of done) byBot.set(t.botId, [...(byBot.get(t.botId) ?? []), t])
  for (const [botId, ts] of byBot) {
    if (ts.length < EARLY.n) continue
    const bot = bots.find((b) => b.id === botId)
    const botName = bot?.name ?? ts[0]!.botName
    for (const d of DIMENSIONS) {
      if (SKIP.has(d.id)) continue
      const groups = new Map<string, SettledLike[]>()
      for (const t of ts) { const k = d.of(t); if (k !== null) groups.set(k, [...(groups.get(k) ?? []), t]) }
      // One value is no comparison: the bot only ever traded that spot.
      if (groups.size < 2) continue
      for (const [k, g] of groups) {
        const s = segment(k, g)
        const graded = grade(s.n, s.games, s.z, s.pnlUsd)
        if (!graded) continue
        const inSpot = new Set(g)
        const others = ts.filter((t) => !inSpot.has(t))
        const restSeg = segment('rest', others)
        // A spot is only a pattern if it differs from the rest of the bot.
        if (graded.kind === 'losing' ? s.pnlPerContractC >= restSeg.pnlPerContractC : s.pnlPerContractC <= restSeg.pnlPerContractC) continue
        let fix: Fix | undefined
        if (graded.kind === 'losing' && bot) {
          const f = fixFor(d.id, k)
          if (f && applyFix(bot, f).next) fix = f
        }
        out.push({
          key: `bot|${botId}|${d.id}|${k}`, ...graded, botId, botName, dimension: d.title, segment: k,
          title: `${botName}: ${d.title.toLowerCase()}, ${k}`,
          n: s.n, games: s.games, won: s.won, lost: s.lost, centsPerContract: round1(s.pnlPerContractC), z: round1(s.z),
          rest: { n: restSeg.n, centsPerContract: round1(restSeg.pnlPerContractC) },
          ...(fix ? { fix } : {})
        })
      }
    }
  }
  return out
}

// Across the record: winning spots worth a paper bot of their own.
function acrossRecord(done: SettledLike[]): Pattern[] {
  const groups = new Map<string, { title: string; build: Omit<PatternBuild, 'minEdgePp' | 'priceLoC' | 'priceHiC'>; ts: SettledLike[] }>()
  for (const t of done) {
    const g = tagsOf(t)
    if (!g.sport || !g.lane || !g.phase || g.lane === 'COMBO') continue
    const quarter = g.phase === 'live' && g.quarter && g.quarter !== 'Pregame' && g.quarter !== 'OT' ? g.quarter as Quarter : null
    if (g.phase === 'live' && !quarter) continue
    const when = quarter ? `in ${Q_WORD[quarter]}` : 'before the game'
    const band = g.ourP == null ? null : CHANCE.find(([lo, hi]) => g.ourP! * 100 >= lo && g.ourP! * 100 < hi) ?? null
    const base = { sport: g.sport, lane: g.lane, phase: g.phase as 'pregame' | 'live', quarter }
    const add = (key: string, chance: readonly [number, number] | null): void => {
      const e = groups.get(key) ?? { title: `${g.sport} ${LANE_WORD[g.lane!] ?? g.lane} ${when}${chance ? ` at ${chance[0]} to ${chance[1]}% to hit` : ''}`, build: { ...base, chanceLo: chance?.[0] ?? null }, ts: [] }
      e.ts.push(t)
      groups.set(key, e)
    }
    const k = `all|${g.sport}|${g.lane}|${quarter ?? g.phase}`
    add(k, null)
    if (band) add(`${k}|${band[0]}`, band)
  }
  const out: Pattern[] = []
  for (const [key, { title, build, ts }] of groups) {
    const s = segment(key, ts)
    const graded = grade(s.n, s.games, s.z, s.pnlUsd)
    if (!graded || graded.kind !== 'winning') continue
    const edges = ts.map((t) => tagsOf(t).edgePp).filter((e): e is number => typeof e === 'number')
    out.push({
      key, ...graded, botId: null, botName: null, dimension: 'Across your record', segment: title, title,
      n: s.n, games: s.games, won: s.won, lost: s.lost, centsPerContract: round1(s.pnlPerContractC), z: round1(s.z), rest: null,
      build: {
        ...build,
        minEdgePp: Math.max(0, Math.floor(edges.length ? Math.min(...edges) : 3)),
        priceLoC: Math.max(1, Math.floor(Math.min(...ts.map(priceOf)))),
        priceHiC: Math.min(99, Math.ceil(Math.max(...ts.map(priceOf))))
      }
    })
  }
  return out
}

// Losing spots first (they tell more), proven before early, the clearest
// first; then winning spots. A spot already covered by a wider one with as
// clear a record is left out.
export function findPatterns(tickets: SettledLike[], bots: BotSettings[] = [], limit = 10): Pattern[] {
  const done = settled(tickets).filter((t) => !bots.find((b) => b.id === t.botId)?.trial)
  const all = [...insideBots(done, bots), ...acrossRecord(done)]
  const rank = (p: Pattern): number => (p.kind === 'losing' ? 0 : 2) + (p.strength === 'proven' ? 0 : 1)
  all.sort((a, b) => rank(a) - rank(b) || Math.abs(b.z) - Math.abs(a.z))
  const kept: Pattern[] = []
  for (const p of all) {
    if (p.botId === null && kept.some((k) => k.botId === null && p.key.startsWith(`${k.key}|`) && Math.abs(k.z) >= Math.abs(p.z))) continue
    kept.push(p)
  }
  return kept.slice(0, limit)
}

// A paper bot for a winning spot across the record: only that sport, lane
// and point of the game, at that chance or better, at the edge and prices the
// trades were taken at, a flat $5, on and in paper.
export function patternBot(p: Pattern, now: number): BotSettings {
  if (!p.build) throw new Error('Only a winning spot across your record can start a bot of its own.')
  const x = p.build
  const b = defaultBot(`pattern-${now.toString(36)}`, `Pattern: ${p.title}`.slice(0, 80))
  b.enabled = true
  b.mode = 'paper'
  b.market.sports = [x.sport]
  b.market.lanes = [x.lane]
  b.market.phase = x.phase
  if (x.quarter) b.market.quarters = [x.quarter]
  b.market.labels = ['PRICE_GAP', 'MEASURED', 'LEAN', 'RATING_Q', 'ROLE_Q', 'TAIL_RUNG']
  const floor = x.chanceLo ?? 0
  b.entry.minChancePct = { pregame: floor, Q1: floor, Q2: floor, Q3: floor, Q4: floor }
  b.entry.minEdgePp = x.minEdgePp
  b.entry.priceBandC = [x.priceLoC, Math.max(x.priceLoC, x.priceHiC)]
  b.size.sizing = 'flat'
  b.size.maxTradeUsd = 5
  return b
}
