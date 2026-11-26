// What won and what lost, from the user's own settled tickets. Pure, so the
// Results screen and the tests read the same numbers.
//
// A segment is only called a winner or a loser when its record is unlikely to
// be luck: the win rate is compared with breakeven, the average price paid
// plus the fee a contract, which is the win rate a fair coin at those prices
// would produce after fees, and the gap is measured in standard errors. Both
// count each trade once (2026-11-24: breakeven was once weighted by contracts
// and left the fee out, so flat sizing, which buys more contracts on cheap
// plays, showed it 5 points under the win rate it sat beside). Small samples are reported, never recommended on. The
// Lazy Edge sim found 19 of 3,297 situations clear a bar, fewer than chance
// alone would produce, which is the mistake this guards against.
//
// Trades on one game win and lose together: three rungs of one spread are
// close to one bet, not three. So the standard error is also measured by game
// (clustered), the larger of the two is used, and nothing is judged before it
// spans enough separate games.
import type { Fix } from './fixes'
import type { PlayTags } from './signal'
import { Quarter, type Lane, type Sport } from './schema'

export interface SettledLike {
  botId: string
  botName: string
  signalKey?: string
  gameId?: string
  side: 'yes' | 'no'
  venue: string
  filledContracts: number
  avgFillC: number | null
  limitPriceC: number
  costUsd: number
  feeUsd: number
  pnlUsd: number | null
  createdAt: number
  play?: PlayTags
}

export interface Segment {
  key: string
  n: number
  // Separate games the trades came from; the real size of the sample.
  games: number
  won: number
  lost: number
  contracts: number
  pnlUsd: number
  costUsd: number
  // Average price paid a trade, 0 to 1, before fees.
  avgPrice: number
  // The win rate this segment needs to break even: the average price paid a
  // trade plus the fee Kalshi charged a contract.
  breakeven: number
  winRate: number
  pnlPerContractC: number
  roi: number
  // Win rate minus breakeven, in standard errors. |z| >= 2 is "strong".
  z: number
  verdict: 'winning' | 'losing' | 'too_early' | 'even'
  // The bots whose trades are in this segment, so a fix goes to them.
  botIds: string[]
}

export interface Dimension {
  id: string
  title: string
  setting: string | null
  rows: Segment[]
}

export interface Recommendation {
  kind: 'cut' | 'keep'
  dimension: string
  segment: string
  text: string
  strength: 'strong' | 'leaning'
  // For a cut: the setting change that leaves the segment out, and the bots
  // that traded it. Missing when no setting can (side bought, hot play).
  fix?: Fix
  botIds: string[]
}

export const MIN_SETTLED = 20
// With few games even a clustered error runs small, so the bar is set high.
export const MIN_GAMES = 20

const gameOf = (t: SettledLike): string => t.gameId || (t.signalKey ?? '').split(':').slice(0, 2).join(':') || String(t.createdAt)

// Tickets written before tags were saved still carry the sport, lane and
// phase in their signal key: sport:game:LANE:..., or sport:game:live:LANE:...
// for NFL hot plays.
export function tagsOf(t: SettledLike): Partial<PlayTags> {
  if (t.play) return t.play
  const parts = (t.signalKey ?? '').split(':')
  const sport = parts[0]?.toUpperCase() as Sport | undefined
  const live = parts[2] === 'live'
  const lane = (live ? parts[3] : parts[2]) as Lane | undefined
  return { sport, lane, phase: live ? 'live' : undefined, hot: live && sport === 'NFL' ? true : undefined }
}

const PRICE_BUCKETS: [number, number, string][] = [[0, 30, 'Under 30c'], [30, 45, '30 to 44c'], [45, 56, '45 to 55c'], [56, 71, '56 to 70c'], [71, 100, 'Over 70c']]
const EDGE_BUCKETS: [number, number, string][] = [[-Infinity, 5, 'Under 5pp'], [5, 8, '5 to 8pp'], [8, 12, '8 to 12pp'], [12, Infinity, '12pp and up']]
const bucket = (v: number | null | undefined, table: [number, number, string][]): string | null =>
  v === null || v === undefined ? null : table.find(([lo, hi]) => v >= lo && v < hi)?.[2] ?? null

const priceC = (t: SettledLike): number => t.avgFillC ?? t.limitPriceC

export function segment(key: string, ts: SettledLike[]): Segment {
  const won = ts.filter((t) => (t.pnlUsd ?? 0) > 0).length
  const contracts = ts.reduce((s, t) => s + t.filledContracts, 0)
  const pnlUsd = ts.reduce((s, t) => s + (t.pnlUsd ?? 0), 0)
  const costUsd = ts.reduce((s, t) => s + t.filledContracts * priceC(t) / 100, 0)
  const n = ts.length
  const avgPrice = n ? ts.reduce((s, t) => s + priceC(t), 0) / n / 100 : 0
  const evenAt = (t: SettledLike): number => priceC(t) / 100 + (t.filledContracts > 0 ? (t.feeUsd || 0) / t.filledContracts : 0)
  const breakeven = n ? ts.reduce((s, t) => s + evenAt(t), 0) / n : 0
  const winRate = n ? won / n : 0
  // Per game sums of (won - price paid): a game's rungs count as one draw.
  const byGame = new Map<string, number>()
  for (const t of ts) byGame.set(gameOf(t), (byGame.get(gameOf(t)) ?? 0) + ((t.pnlUsd ?? 0) > 0 ? 1 : 0) - evenAt(t))
  const games = byGame.size
  const independent = Math.sqrt(Math.max(breakeven * (1 - breakeven), 0.01) / Math.max(n, 1))
  const clustered = Math.sqrt([...byGame.values()].reduce((s, r) => s + r * r, 0)) / Math.max(n, 1)
  const se = Math.max(independent, clustered)
  const z = n ? (winRate - breakeven) / se : 0
  const verdict = n < MIN_SETTLED || games < MIN_GAMES ? 'too_early' : z >= 2 && pnlUsd > 0 ? 'winning' : z <= -2 && pnlUsd < 0 ? 'losing' : 'even'
  return {
    key, n, games, won, lost: n - won, contracts, pnlUsd, costUsd, avgPrice, breakeven, winRate,
    pnlPerContractC: contracts ? (pnlUsd / contracts) * 100 : 0,
    roi: costUsd ? pnlUsd / costUsd : 0,
    z, verdict,
    botIds: [...new Set(ts.map((t) => t.botId))]
  }
}

// The backed team's score when bought, in a live game.
const SCORE_BUCKETS = { down10: 'Down 10 or more', down: 'Down 1 to 9', tied: 'Tied', up: 'Up 1 to 9', up10: 'Up 10 or more' } as const
function scoreBucket(lead: number | null | undefined): string | null {
  if (lead === null || lead === undefined) return null
  return lead <= -10 ? SCORE_BUCKETS.down10 : lead < 0 ? SCORE_BUCKETS.down : lead === 0 ? SCORE_BUCKETS.tied : lead < 10 ? SCORE_BUCKETS.up : SCORE_BUCKETS.up10
}

// The setting change that leaves a losing segment out, where one exists.
export function fixFor(dimension: string, key: string): Fix | undefined {
  switch (dimension) {
    case 'sport': return { kind: 'drop', field: 'sports', value: key }
    case 'lane': return { kind: 'drop', field: 'lanes', value: key }
    case 'label': return { kind: 'drop', field: 'labels', value: key }
    case 'phase': return key === 'pregame' || key === 'live' ? { kind: 'dropPhase', phase: key } : undefined
    case 'quarter':
      if (key === 'OT') return { kind: 'noOvertime' }
      return (Quarter.options as readonly string[]).includes(key) ? { kind: 'drop', field: 'quarters', value: key } : undefined
    case 'price': {
      // Only the end buckets can be cut alone: the cheapest raises the low,
      // the dearest lowers the high. Cutting a middle bucket would take a
      // bucket beside it too, so it has no fix.
      const first = PRICE_BUCKETS[0]!
      const last = PRICE_BUCKETS[PRICE_BUCKETS.length - 1]!
      if (key === first[2]) return { kind: 'priceFloor', c: first[1] }
      if (key === last[2]) return { kind: 'priceCeiling', c: last[0] - 1 }
      return undefined
    }
    case 'edge': {
      // Only the smallest edges, for the same reason.
      const first = EDGE_BUCKETS[0]!
      return key === first[2] ? { kind: 'minEdge', pp: first[1] } : undefined
    }
    case 'score':
      if (key === SCORE_BUCKETS.down10) return { kind: 'maxTrailing', points: 9 }
      if (key === SCORE_BUCKETS.down) return { kind: 'maxTrailing', points: 0 }
      return undefined
    case 'favorite': return key === 'Underdog' ? { kind: 'favoritesOnly' } : undefined
    // Keeping out of a game's last minutes cuts this bucket and every later one.
    case 'timeLeft': { const b = TIME_LEFT.find(([, k]) => k === key); return b && b[2] > 0 ? { kind: 'finalSeconds', s: b[2] } : undefined }
    // Raising the minimum chance to the top of a band cuts that band and the
    // ones under it.
    case 'chance': { const m = /^(\d+) to (\d+)%$/.exec(key); return m ? { kind: 'minChance', when: 'all', pct: Math.min(99, Number(m[2])) } : undefined }
    // Keeping props to the players above a losing band cuts that band and
    // every one below it.
    case 'propRank': { const b = RANK_BUCKETS.find(([, k]) => k === key); return b && b[2] > 0 ? { kind: 'propTop', n: b[2] } : undefined }
    case 'quarterChance': {
      const m = /^(Pregame|Q[1-4]) at (\d+) to (\d+)%$/.exec(key)
      return m ? { kind: 'minChance', when: m[1] === 'Pregame' ? 'pregame' : m[1] as 'Q1' | 'Q2' | 'Q3' | 'Q4', pct: Math.min(99, Number(m[3])) } : undefined
    }
    default: return undefined
  }
}

// Where in the game a live play was bought, by minutes left in the game.
const TIME_LEFT: [number, string, number][] = [[120, 'Last 2 minutes', 120], [300, '2 to 5 minutes left', 300], [720, '5 to 12 minutes left', 720], [Infinity, 'More than 12 minutes left', 0]]
const timeLeftBucket = (s: number | null | undefined): string | null => (s === null || s === undefined ? null : TIME_LEFT.find(([hi]) => s < hi)![1])
const CHANCE_BANDS: [number, number][] = [[50, 60], [60, 70], [70, 80], [80, 90], [90, 100]]
const chanceBand = (p: number | null | undefined): [number, number] | null => (p === null || p === undefined ? null : CHANCE_BANDS.find(([lo, hi]) => p * 100 >= lo && p * 100 < hi) ?? null)

// How far a prop was from its line when bought: what an over still needed,
// or what an under had to spare.
function propNeed(t: SettledLike): string | null {
  const g = tagsOf(t)
  if (g.propLine == null || g.propSoFar == null || g.propOver == null) return null
  const gap = g.propLine - g.propSoFar
  if (g.propOver) return gap <= 2.5 ? 'Over, needed 2 or fewer more' : gap <= 5.5 ? 'Over, needed 3 to 5 more' : 'Over, needed 6 or more'
  return gap >= 5.5 ? 'Under, 6 or more to spare' : gap >= 2.5 ? 'Under, 3 to 5 to spare' : 'Under, 2 or fewer to spare'
}

// A player's place in his game by our points projection.
const RANK_BUCKETS: [number, string, number][] = [[3, 'Top 3 in the game', 0], [6, '4th to 6th', 3], [10, '7th to 10th', 6], [Infinity, '11th or lower', 10]]

export const DIMENSIONS: { id: string; title: string; setting: string | null; of: (t: SettledLike) => string | null }[] = [
  { id: 'bot', title: 'Bot', setting: null, of: (t) => t.botName },
  { id: 'sport', title: 'Sport', setting: 'Sports', of: (t) => tagsOf(t).sport ?? null },
  { id: 'lane', title: 'Lane', setting: 'Lanes', of: (t) => tagsOf(t).lane ?? null },
  { id: 'label', title: 'Label', setting: 'Labels', of: (t) => tagsOf(t).label ?? null },
  { id: 'phase', title: 'Live or pregame', setting: 'Phase', of: (t) => tagsOf(t).phase ?? null },
  { id: 'hot', title: 'Hot play', setting: 'Phase', of: (t) => { const h = tagsOf(t).hot; return h === undefined ? null : h ? 'Hot play' : 'Not a hot play' } },
  { id: 'side', title: 'Side bought', setting: null, of: (t) => t.side.toUpperCase() },
  { id: 'price', title: 'Price paid', setting: 'Price band', of: (t) => bucket(priceC(t), PRICE_BUCKETS) },
  { id: 'edge', title: 'Edge at entry', setting: 'Minimum edge', of: (t) => bucket(tagsOf(t).edgePp, EDGE_BUCKETS) },
  // From 0.8.0 tickets on; older ones carry none and are left out.
  // Live quarters only: pregame is already its own row under Live or pregame.
  { id: 'quarter', title: 'Quarter bought in', setting: 'Quarters', of: (t) => { const q = tagsOf(t).quarter; return q && q !== 'Pregame' ? q : null } },
  { id: 'score', title: 'Score when bought', setting: 'Most points behind', of: (t) => scoreBucket(tagsOf(t).lead) },
  { id: 'favorite', title: 'Favorite or underdog', setting: 'Favorites only', of: (t) => { const p = tagsOf(t).teamWinP; return p === null || p === undefined ? null : p >= 0.5 ? 'Favorite' : 'Underdog' } },
  // From 0.9.2, our pick in play: did it change at the tip (API #981)?
  { id: 'pickChanged', title: 'Our pick at the tip', setting: null, of: (t) => { const c = tagsOf(t).pickChanged; return c === null || c === undefined ? null : c ? 'Changed at the tip' : 'Same as pregame' } },
  // From 0.9.2, where the play was (2026-11-21).
  { id: 'timeLeft', title: 'Time left in the game', setting: 'No entry in the final', of: (t) => timeLeftBucket(tagsOf(t).secondsLeft) },
  { id: 'chance', title: 'Our chance when bought', setting: 'Minimum chance to hit', of: (t) => { const b = chanceBand(tagsOf(t).ourP); return b ? `${b[0]} to ${b[1]}%` : null } },
  // The same chance band in one quarter against another: what a quarter's
  // minimum chance should be.
  { id: 'quarterChance', title: 'Quarter and chance', setting: 'Minimum chance to hit', of: (t) => {
    const g = tagsOf(t)
    const b = chanceBand(g.ourP)
    const q = g.quarter && g.quarter !== 'OT' ? g.quarter : null
    return b && q ? `${q === 'Pregame' ? 'Pregame' : q} at ${b[0]} to ${b[1]}%` : null
  } },
  { id: 'propSide', title: 'Prop over or under', setting: null, of: (t) => { const o = tagsOf(t).propOver; return o === null || o === undefined ? null : o ? 'Over' : 'Under' } },
  { id: 'propNeed', title: 'How far from the line', setting: null, of: propNeed },
  { id: 'propTeamScore', title: "Player's team score", setting: null, of: (t) => scoreBucket(tagsOf(t).propTeamLead) },
  { id: 'propRank', title: "Player's place in the game", setting: "Props on the game's top players only", of: (t) => { const r = tagsOf(t).propRank; return r == null ? null : RANK_BUCKETS.find(([hi]) => r <= hi)![1] } }
]

export function settled<T extends SettledLike>(tickets: T[]): T[] {
  return tickets.filter((t) => t.pnlUsd !== null && t.filledContracts > 0)
}

export function analyze(tickets: SettledLike[]): { overall: Segment; dimensions: Dimension[]; recommendations: Recommendation[] } {
  const done = settled(tickets)
  const dimensions: Dimension[] = DIMENSIONS.map((d) => {
    const groups = new Map<string, SettledLike[]>()
    for (const t of done) {
      const k = d.of(t)
      if (k === null) continue
      groups.set(k, [...(groups.get(k) ?? []), t])
    }
    const rows = [...groups.entries()].map(([k, ts]) => segment(k, ts)).sort((a, b) => b.pnlUsd - a.pnlUsd)
    return { id: d.id, title: d.title, setting: d.setting, rows }
  })

  const recommendations: Recommendation[] = []
  for (const d of dimensions) {
    // A dimension with one value says nothing a setting could change.
    if (d.rows.length < 2 || d.id === 'bot') continue
    for (const r of d.rows) {
      if (r.verdict === 'too_early') continue
      const strength = Math.abs(r.z) >= 2 ? 'strong' : Math.abs(r.z) >= 1 ? 'leaning' : null
      if (!strength) continue
      const record = `${r.won} won, ${r.lost} lost at an average ${Math.round(r.avgPrice * 100)}c, ${signed(r.pnlPerContractC)}c a contract over ${r.n} trades in ${r.games} games`
      if (r.pnlUsd < 0 && r.z < 0) {
        recommendations.push({
          kind: 'cut', dimension: d.title, segment: r.key, strength,
          text: `${d.title} ${r.key} lost: ${record}.${d.setting ? ` Consider leaving it out under ${d.setting}.` : ''}`,
          fix: fixFor(d.id, r.key), botIds: r.botIds
        })
      } else if (r.pnlUsd > 0 && r.z > 0) {
        recommendations.push({ kind: 'keep', dimension: d.title, segment: r.key, strength, text: `${d.title} ${r.key} won: ${record}.`, botIds: r.botIds })
      }
    }
  }
  // Strong before leaning, losses before wins: the cut that saves money first.
  const rank = (r: Recommendation): number => (r.strength === 'strong' ? 0 : 2) + (r.kind === 'cut' ? 0 : 1)
  recommendations.sort((a, b) => rank(a) - rank(b))

  return { overall: segment('All', done), dimensions, recommendations }
}

const signed = (n: number): string => `${n >= 0 ? '+' : '−'}${Math.abs(n).toFixed(1)}`
