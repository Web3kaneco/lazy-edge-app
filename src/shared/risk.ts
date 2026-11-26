// Risk and reward (2026-11-21): what a play really offers, and how a
// bot really makes or loses its money. An underdog with an edge wins rarely
// and pays big; a favorite wins often and loses big; both only pay if the
// chance is honest. Every number here is plain arithmetic on the honest
// chance (shared/honest.ts) and the price, with Kalshi's taker fee, the fee
// paper is charged too.
import { FEES } from './ruleset'
import type { SettledLike } from './results'

// Kalshi's taker fee on one contract at price p (0 to 1), in the same units.
export const feeOf = (p: number): number => FEES.kalshiTakerCoef * p * (1 - p)

export type Shape = 'long shot' | 'coin flip' | 'favorite'
export const shapeOf = (priceC: number): Shape => (priceC < 35 ? 'long shot' : priceC <= 65 ? 'coin flip' : 'favorite')

export interface PlayRisk {
  shape: Shape
  // The win rate the price needs, fee included, 0 to 1.
  breakeven: number
  // The honest chance it pays.
  chance: number
  // Per contract, in cents, after the fee.
  winC: number
  lossC: number
  evC: number
  // How many plays like it to one win, rounded: "1 in 4".
  oneIn: number
  // The chance of five losses in a row, 0 to 1.
  fiveLosses: number
  // The longest losing run to expect over 20 plays like it.
  runIn20: number
}

// Expected longest run of losses in n plays, each losing with chance l:
// about log(n x (1 - l)) / log(1 / l), never under 1 when a loss is possible.
export function expectedRun(n: number, lose: number): number {
  if (lose <= 0) return 0
  if (lose >= 1) return n
  return Math.max(1, Math.round(Math.log(n * (1 - lose)) / Math.log(1 / lose)))
}

export function playRisk(chance: number, priceC: number): PlayRisk {
  const p = priceC / 100
  const fee = feeOf(p)
  return {
    shape: shapeOf(priceC),
    breakeven: Math.min(1, p + fee),
    chance,
    winC: Math.round((1 - p - fee) * 1000) / 10,
    lossC: Math.round((p + fee) * 1000) / 10,
    evC: Math.round((chance - p - fee) * 1000) / 10,
    oneIn: chance > 0 ? Math.max(1, Math.round(1 / chance)) : Infinity,
    fiveLosses: Math.pow(1 - chance, 5),
    runIn20: expectedRun(20, 1 - chance)
  }
}

// One line a person reads in five seconds.
export function playRiskLine(r: PlayRisk): string {
  const wins = r.oneIn <= 1 ? 'wins most of the time' : `wins about 1 in ${r.oneIn}`
  return `${r.shape[0]!.toUpperCase()}${r.shape.slice(1)}: needs ${Math.round(r.breakeven * 100)}% to break even, honest chance ${Math.round(r.chance * 100)}%, ${wins}. A win pays ${r.winC}c, a loss costs ${r.lossC}c, ${r.evC >= 0 ? '+' : ''}${r.evC}c a contract on average. Expect losing runs of ${r.runIn20} in 20.`
}

// The same, short, for a row on the Board.
export function playRiskShort(r: PlayRisk): string {
  return `${r.shape[0]!.toUpperCase()}${r.shape.slice(1)} · needs ${Math.round(r.breakeven * 100)}% · ${r.oneIn <= 1 ? 'wins most' : `wins 1 in ${r.oneIn}`} · win +${r.winC}c / loss −${r.lossC}c · ${r.evC >= 0 ? '+' : '−'}${Math.abs(r.evC)}c a contract`
}

export interface ShapeRecord { trades: number; won: number; pnlUsd: number; centsPerContract: number }

export interface BotRisk {
  trades: number
  won: number
  lost: number
  winRate: number
  // The win rate the prices paid needed, fee included.
  breakeven: number
  // What our chances said: expected wins, and the profit a contract.
  expectedWins: number
  expectedC: number
  actualC: number
  avgWinUsd: number
  avgLossUsd: number
  // Average win against average loss: above 1 means wins are bigger.
  payoff: number
  longestLosing: number
  // Where the money came from, by the shape of the play.
  byShape: Record<Shape, ShapeRecord>
  // Share of trades bought as long shots.
  longShotShare: number
}

const priceOf = (t: SettledLike): number => t.avgFillC ?? t.limitPriceC

export function botRisk(tickets: SettledLike[]): BotRisk | null {
  const done = tickets.filter((t) => t.pnlUsd !== null && t.filledContracts > 0).sort((a, b) => a.createdAt - b.createdAt)
  if (!done.length) return null
  const won = done.filter((t) => (t.pnlUsd ?? 0) > 0)
  const lost = done.filter((t) => (t.pnlUsd ?? 0) <= 0)
  const contracts = done.reduce((s, t) => s + t.filledContracts, 0)
  const pnl = done.reduce((s, t) => s + (t.pnlUsd ?? 0), 0)
  // Our chance at entry: the honest one the trade was taken on.
  const chance = (t: SettledLike): number | null => t.play?.ourP ?? null
  const withChance = done.filter((t) => chance(t) !== null)
  let run = 0
  let longest = 0
  for (const t of done) { run = (t.pnlUsd ?? 0) > 0 ? 0 : run + 1; longest = Math.max(longest, run) }
  const byShape: Record<Shape, ShapeRecord> = { 'long shot': empty(), 'coin flip': empty(), favorite: empty() }
  const shapeContracts: Record<Shape, number> = { 'long shot': 0, 'coin flip': 0, favorite: 0 }
  for (const t of done) {
    const s = shapeOf(priceOf(t))
    byShape[s].trades++
    if ((t.pnlUsd ?? 0) > 0) byShape[s].won++
    byShape[s].pnlUsd += t.pnlUsd ?? 0
    shapeContracts[s] += t.filledContracts
  }
  for (const s of Object.keys(byShape) as Shape[]) {
    byShape[s].pnlUsd = round2(byShape[s].pnlUsd)
    byShape[s].centsPerContract = shapeContracts[s] ? Math.round((byShape[s].pnlUsd / shapeContracts[s]) * 1000) / 10 : 0
  }
  const avgWin = won.length ? won.reduce((s, t) => s + (t.pnlUsd ?? 0), 0) / won.length : 0
  const avgLoss = lost.length ? -lost.reduce((s, t) => s + (t.pnlUsd ?? 0), 0) / lost.length : 0
  const weighted = (f: (t: SettledLike) => number): number => contracts ? done.reduce((s, t) => s + f(t) * t.filledContracts, 0) / contracts : 0
  const wcContracts = withChance.reduce((s, t) => s + t.filledContracts, 0)
  return {
    trades: done.length,
    won: won.length,
    lost: lost.length,
    winRate: won.length / done.length,
    // Each trade once, as the win rate counts them (2026-11-24).
    breakeven: done.reduce((s, t) => { const p = priceOf(t) / 100; return s + p + feeOf(p) }, 0) / done.length,
    expectedWins: Math.round(withChance.reduce((s, t) => s + chance(t)!, 0) * 10) / 10,
    expectedC: wcContracts ? Math.round((withChance.reduce((s, t) => { const p = priceOf(t) / 100; return s + (chance(t)! - p - feeOf(p)) * t.filledContracts }, 0) / wcContracts) * 1000) / 10 : 0,
    actualC: contracts ? Math.round((pnl / contracts) * 1000) / 10 : 0,
    avgWinUsd: round2(avgWin),
    avgLossUsd: round2(avgLoss),
    payoff: avgLoss ? Math.round((avgWin / avgLoss) * 100) / 100 : 0,
    longestLosing: longest,
    byShape,
    longShotShare: byShape['long shot'].trades / done.length
  }
}

function empty(): ShapeRecord { return { trades: 0, won: 0, pnlUsd: 0, centsPerContract: 0 } }
const round2 = (n: number): number => Math.round(n * 100) / 100

// A flat bot stakes the same dollars on every play, so a long shot risks as
// much as a favorite while losing most of the time. Said when its record
// is mostly long shots, or when its settings let the edge buy them. Sizing is
// money, so this only ever explains; the user switches it.
export function flatRiskNote(bot: { size: { sizing: string; maxTradeUsd: number }; entry: { priceBandC: [number, number]; basis: string } }, risk: BotRisk | null): string | null {
  if (bot.size.sizing !== 'flat') return null
  const amt = bot.size.maxTradeUsd
  const money = (n: number): string => `$${Number.isInteger(n) ? n : n.toFixed(2)}`
  if (risk && risk.trades >= 10 && risk.longShotShare >= 0.5) {
    const ls = risk.byShape['long shot']
    return `${Math.round(risk.longShotShare * 100)}% of this bot's trades were long shots under 35c, each staking the full ${money(amt)}: ${ls.won} of ${ls.trades} won, ${ls.centsPerContract >= 0 ? '+' : ''}${ls.centsPerContract}c a contract. Sizing by Kelly on the honest chance would stake less on each long shot and more on the plays it is surer of.`
  }
  if (bot.entry.basis === 'edge' && bot.entry.priceBandC[0] < 35) {
    return `This bot can buy long shots under 35c at a flat ${money(amt)} each, and chasing the edge mostly finds them. A 20c long shot risks the whole ${money(amt)} to win about ${money(amt * 4)}, and loses about 4 times in 5. Sizing by Kelly on the honest chance would stake less on them.`
  }
  return null
}

// What the record says in plain words: the first thing worth knowing.
export function botRiskLines(r: BotRisk): string[] {
  const out: string[] = []
  out.push(`Won ${r.won} of ${r.trades} (${Math.round(r.winRate * 100)}%), where the prices paid needed ${Math.round(r.breakeven * 100)}% to break even.`)
  if (r.expectedWins > 0) {
    const gap = r.won - r.expectedWins
    out.push(`Our chances said about ${r.expectedWins} wins${Math.abs(gap) >= 1 ? `; it won ${Math.abs(Math.round(gap))} ${gap < 0 ? 'fewer' : 'more'}` : ', and it won about that'}. Expected ${r.expectedC >= 0 ? '+' : ''}${r.expectedC}c a contract, made ${r.actualC >= 0 ? '+' : ''}${r.actualC}c.`)
  }
  out.push(`An average win was $${r.avgWinUsd.toFixed(2)} and an average loss $${r.avgLossUsd.toFixed(2)}; the longest losing run was ${r.longestLosing}.`)
  const ls = r.byShape['long shot']
  if (ls.trades) out.push(`${Math.round(r.longShotShare * 100)}% of its trades were long shots under 35c: ${ls.won} of ${ls.trades} won, ${ls.centsPerContract >= 0 ? '+' : ''}${ls.centsPerContract}c a contract.`)
  return out
}
