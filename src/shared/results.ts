// What won and what lost, from the user's own settled tickets. Pure, so the
// Results screen and the tests read the same numbers.
//
// A segment is only called a winner or a loser when its record is unlikely to
// be luck: the win rate is compared with the average price paid, which is the
// win rate a fair coin at those prices would produce, and the gap is measured
// in standard errors. Small samples are reported, never recommended on. The
// Lazy Edge sim found 19 of 3,297 situations clear a bar, fewer than chance
// alone would produce, which is the mistake this guards against.
//
// Trades on one game win and lose together: three rungs of one spread are
// close to one bet, not three. So the standard error is also measured by game
// (clustered), the larger of the two is used, and nothing is judged before it
// spans enough separate games.
import type { PlayTags } from './signal'
import type { Lane, Sport } from './schema'

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
  // Average price paid, 0 to 1: the win rate at which this segment breaks even
  // before fees.
  avgPrice: number
  winRate: number
  pnlPerContractC: number
  roi: number
  // Win rate minus breakeven, in standard errors. |z| >= 2 is "strong".
  z: number
  verdict: 'winning' | 'losing' | 'too_early' | 'even'
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

function segment(key: string, ts: SettledLike[]): Segment {
  const won = ts.filter((t) => (t.pnlUsd ?? 0) > 0).length
  const contracts = ts.reduce((s, t) => s + t.filledContracts, 0)
  const pnlUsd = ts.reduce((s, t) => s + (t.pnlUsd ?? 0), 0)
  const costUsd = ts.reduce((s, t) => s + t.filledContracts * priceC(t) / 100, 0)
  const avgPrice = contracts ? ts.reduce((s, t) => s + t.filledContracts * priceC(t), 0) / contracts / 100 : 0
  const n = ts.length
  const winRate = n ? won / n : 0
  // Per game sums of (won - price paid): a game's rungs count as one draw.
  const byGame = new Map<string, number>()
  for (const t of ts) byGame.set(gameOf(t), (byGame.get(gameOf(t)) ?? 0) + ((t.pnlUsd ?? 0) > 0 ? 1 : 0) - priceC(t) / 100)
  const games = byGame.size
  const independent = Math.sqrt(Math.max(avgPrice * (1 - avgPrice), 0.01) / Math.max(n, 1))
  const clustered = Math.sqrt([...byGame.values()].reduce((s, r) => s + r * r, 0)) / Math.max(n, 1)
  const se = Math.max(independent, clustered)
  const z = n ? (winRate - avgPrice) / se : 0
  const verdict = n < MIN_SETTLED || games < MIN_GAMES ? 'too_early' : z >= 2 && pnlUsd > 0 ? 'winning' : z <= -2 && pnlUsd < 0 ? 'losing' : 'even'
  return {
    key, n, games, won, lost: n - won, contracts, pnlUsd, costUsd, avgPrice, winRate,
    pnlPerContractC: contracts ? (pnlUsd / contracts) * 100 : 0,
    roi: costUsd ? pnlUsd / costUsd : 0,
    z, verdict
  }
}

const DIMENSIONS: { id: string; title: string; setting: string | null; of: (t: SettledLike) => string | null }[] = [
  { id: 'bot', title: 'Bot', setting: null, of: (t) => t.botName },
  { id: 'sport', title: 'Sport', setting: 'Sports', of: (t) => tagsOf(t).sport ?? null },
  { id: 'lane', title: 'Lane', setting: 'Lanes', of: (t) => tagsOf(t).lane ?? null },
  { id: 'label', title: 'Label', setting: 'Labels', of: (t) => tagsOf(t).label ?? null },
  { id: 'phase', title: 'Live or pregame', setting: 'Phase', of: (t) => tagsOf(t).phase ?? null },
  { id: 'hot', title: 'Hot play', setting: 'Phase', of: (t) => { const h = tagsOf(t).hot; return h === undefined ? null : h ? 'Hot play' : 'Not a hot play' } },
  { id: 'side', title: 'Side bought', setting: null, of: (t) => t.side.toUpperCase() },
  { id: 'price', title: 'Price paid', setting: 'Price band', of: (t) => bucket(priceC(t), PRICE_BUCKETS) },
  { id: 'edge', title: 'Edge at entry', setting: 'Minimum edge', of: (t) => bucket(tagsOf(t).edgePp, EDGE_BUCKETS) }
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
          text: `${d.title} ${r.key} lost: ${record}.${d.setting ? ` Consider leaving it out under ${d.setting}.` : ''}`
        })
      } else if (r.pnlUsd > 0 && r.z > 0) {
        recommendations.push({ kind: 'keep', dimension: d.title, segment: r.key, strength, text: `${d.title} ${r.key} won: ${record}.` })
      }
    }
  }
  // Strong before leaning, losses before wins: the cut that saves money first.
  const rank = (r: Recommendation): number => (r.strength === 'strong' ? 0 : 2) + (r.kind === 'cut' ? 0 : 1)
  recommendations.sort((a, b) => rank(a) - rank(b))

  return { overall: segment('All', done), dimensions, recommendations }
}

const signed = (n: number): string => `${n >= 0 ? '+' : '−'}${Math.abs(n).toFixed(1)}`
