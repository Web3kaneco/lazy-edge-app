// Why a bot is not trading, in plain words (2026-11-20: tonight it
// took reading the ledger by hand to find 99 plays stopped by one setting).
// The facts come from the bot, the engine, this cycle's verdicts (which
// include the settings checks the ledger leaves out) and today's skips. The
// AI may phrase them; without it these lines are the answer.
import type { BotSettings } from './schema'

export interface WhyInput {
  bot: BotSettings
  engineRunning: boolean
  // liveProblem() for the bot, or null.
  liveProblem: string | null
  // This cycle: every play the bot looked at and what it did.
  verdicts: { outcome: string; gate: string | null; detail: string }[]
  // Today: the ledger's skips for this bot, by gate.
  skipsToday: { gate: string; detail: string }[]
  tradesToday: number
  // Plain words for a gate code.
  gateWords: (gate: string) => string
}

export interface WhyFacts {
  headline: string
  lines: string[]
  // The single check stopping the most plays, if any.
  top: { gate: string; words: string; plays: number; examples: string[] } | null
}

const plays = (n: number): string => `${n} ${n === 1 ? 'play' : 'plays'}`

export function whyFacts(w: WhyInput): WhyFacts {
  const lines: string[] = []
  const { bot } = w
  if (!w.engineRunning) return { headline: 'The engine is stopped.', lines: ['No bot trades until you press Start engine at the top.'], top: null }
  if (w.liveProblem) return { headline: `${bot.name} is live but cannot send orders.`, lines: [w.liveProblem], top: null }

  const taking = w.verdicts.filter((v) => v.outcome === 'take').length
  const holding = w.verdicts.filter((v) => v.outcome === 'holding').length
  const seen = w.verdicts.length
  // This cycle first, since it includes the settings checks; today's ledger
  // adds the plays seen earlier.
  const tally = new Map<string, { n: number; examples: string[] }>()
  const count = (gate: string, detail: string): void => {
    const e = tally.get(gate) ?? { n: 0, examples: [] }
    e.n++
    if (detail && e.examples.length < 3 && !e.examples.includes(detail)) e.examples.push(detail)
    tally.set(gate, e)
  }
  for (const v of w.verdicts) if (v.outcome === 'skip' && v.gate) count(v.gate, v.detail)
  const fromCycle = new Set(tally.keys())
  const today = new Map<string, { n: number; examples: string[] }>()
  for (const s of w.skipsToday) {
    const e = today.get(s.gate) ?? { n: 0, examples: [] }
    e.n++
    if (s.detail && e.examples.length < 3 && !e.examples.includes(s.detail)) e.examples.push(s.detail)
    today.set(s.gate, e)
  }
  for (const [gate, e] of today) if (!fromCycle.has(gate)) tally.set(gate, e)

  const ranked = [...tally.entries()].sort((a, b) => b[1].n - a[1].n)
  const top = ranked[0] ? { gate: ranked[0][0], words: w.gateWords(ranked[0][0]), plays: ranked[0][1].n, examples: ranked[0][1].examples } : null

  let headline: string
  if (taking) headline = `${bot.name} is taking ${plays(taking)} right now.`
  else if (!seen && !w.skipsToday.length) headline = `${bot.name} has seen no plays: nothing on the feed matches its sports, lanes and ${bot.market.phase === 'live' ? 'in game' : bot.market.phase === 'pregame' ? 'pregame' : 'game'} setting at the moment.`
  else if (top) headline = `${bot.name} is not trading mainly because of one check: ${top.words.toLowerCase()} (${plays(top.plays)}).`
  else headline = `${bot.name} is looking but nothing has passed yet.`

  // A bot that is off is previewed every cycle, so it can say what it would do.
  if (!bot.enabled) {
    lines.unshift(taking ? `If it were on it would take ${plays(taking)} right now.` : headline.replace(`${bot.name} is`, 'If it were on it would be'))
    headline = `${bot.name} is switched off.`
  }
  if (w.tradesToday) lines.push(`It has made ${w.tradesToday} ${w.tradesToday === 1 ? 'trade' : 'trades'} today.`)
  if (holding) lines.push(`It already holds ${plays(holding)} it would otherwise take.`)
  for (const [gate, e] of ranked.slice(0, 4)) {
    lines.push(`${w.gateWords(gate)}: ${plays(e.n)}${e.examples.length ? `, for example ${e.examples.join('; ')}` : ''}.`)
  }
  return { headline, lines, top }
}
