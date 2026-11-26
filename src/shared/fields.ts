// Settings paths in plain words, for every screen that lists what changed: a
// starter update, an AI edit, a share code. A path with no name here shows as
// it is, so nothing is ever hidden.
import type { Change } from './share'

const NAMES: Record<string, string> = {
  pollS: 'Check every (seconds)',
  'decider.kind': 'Decider',
  'market.sports': 'Sports',
  'market.lanes': 'Lanes',
  'market.phase': 'Pregame or in game',
  'market.quarters': 'Quarters',
  'market.labels': 'Labels',
  'market.venues': 'Venues',
  'market.propTopPlayers': "Props on the game's top players only",
  'market.propSidesOff': 'Prop sides switched off',
  'entry.underEdgePp': 'Prop unders only at an edge of (points)',
  'entry.underFirstMin': 'Prop unders only in the first minutes of a quarter',
  'entry.minEdgePp': 'Minimum edge (points)',
  'entry.maxEdgePp': 'Maximum edge (points)',
  'entry.minEvCents': 'Minimum EV (cents)',
  'entry.edgeHaircut': 'Edge haircut',
  'entry.priceBandC': 'Price band (cents)',
  'entry.maxPriceAgeS': 'Oldest price allowed (seconds)',
  'entry.requireTrigger': 'Game event plays only',
  'entry.measuredOnly': 'Proven patterns only',
  'entry.favoritesOnly': 'Favorites only',
  'entry.basis': 'Chooses trades on',
  'entry.pickGapPp': 'Our pick priced under our number by (points)',
  'entry.maxSpreadC': 'Widest book (cents)',
  'entry.pregameWindowMin': 'Pregame plays wait until (minutes before the start)',
  'entry.orderType': "When the price is above the play's value",
  'entry.bidRestS': 'Bid waits (seconds)',
  'size.sizing': 'Sizing',
  'size.maxTradeUsd': 'Largest trade ($)',
  'size.minTradeUsd': 'Smallest trade ($)',
  'size.kellyMultiplier': 'Kelly fraction',
  'size.bankrollUsd': 'Bankroll ($)',
  'size.maxContracts': 'Most contracts a trade',
  'size.maxGameEquityPct': 'Most of the account on one game',
  'exit.mode': 'Exit',
  'exit.targetC': 'Exit target (cents)',
  'exit.afterMin': 'Sell after (minutes)',
  'exit.atQuarterEnd': 'Sell at the end of the quarter',
  'guards.noEntryFinalS': 'No entry in the final (seconds)',
  'guards.noOvertime': 'No overtime',
  'guards.onePositionPerMarket': 'One position a contract',
  'guards.noOpposingBets': 'Never bet against itself',
  'guards.oneEntryPerGame': 'One entry a game',
  'guards.autoCancelS': 'Cancel an unfilled order after (seconds)',
  'guards.maxDailyDrawdownUsd': 'Daily loss stop ($)',
  'guards.maxTradesPerDay': 'Most trades a day (live)',
  'combo.legs': 'Legs per combo',
  'combo.maxPerDay': 'Combos a day',
  'combo.only': 'Combos only',
  'combo.source': 'Which combos',
  'combo.apiLegs': "The API's combos to buy, by legs"
}

const QUARTER: Record<string, string> = { pregame: 'pregame', Q1: '1st quarter', Q2: '2nd quarter', Q3: '3rd quarter', Q4: '4th quarter' }

export function fieldName(path: string): string {
  const m = /^entry\.(minChancePct|maxTrailing)\.(\w+)$/.exec(path)
  if (m) return `${m[1] === 'minChancePct' ? 'Minimum chance to hit' : 'Most points behind'}, ${QUARTER[m[2]!] ?? m[2]}`
  return NAMES[path] ?? path
}

export function fieldValue(path: string, v: unknown): string {
  if (v === null || v === undefined) return path.includes('maxTrailing') || path.includes('pickGap') || path.includes('maxSpread') || path.includes('propTopPlayers') || path.includes('maxEdge') || path.includes('underEdge') || path.includes('underFirstMin') ? 'no limit' : 'none'
  if (path === 'market.propTopPlayers') return `top ${v} in the game`
  if (typeof v === 'boolean') return v ? 'yes' : 'no'
  if (path === 'entry.basis') return v === 'pick' ? 'our pick' : 'the edge'
  if (path === 'entry.priceBandC' && Array.isArray(v)) return `${v[0]}c to ${v[1]}c`
  if (path.startsWith('entry.minChancePct')) return `${v}%`
  if (path === 'market.venues' && Array.isArray(v)) return v.filter((x) => x !== 'paper').join(', ') || 'every venue with a key'
  if (Array.isArray(v)) return v.length ? v.join(', ') : 'none'
  return String(v)
}

// Why a setting must hold a value, said after the problem.
const NEEDS: Record<string, string> = {
  'market.labels': 'A bot only takes plays with a ticked label, so with none it would never trade.',
  'market.sports': 'With no sport the bot would never trade.',
  'market.lanes': 'With no lane the bot would never trade.',
  'market.quarters': 'An in game bot with no quarter would never trade in game.',
  'combo.apiLegs': 'With none ticked it would buy no combo.'
}

// One validation problem in plain words: the setting by its screen name, what
// is wrong, and why it matters (2026-11-21: "need good errors and a
// report and not just a bunch of code"). Takes a zod issue's shape.
export interface IssueLike { code: string; path: PropertyKey[]; message: string; minimum?: number | bigint; maximum?: number | bigint; origin?: string; expected?: string }
export function plainIssue(i: IssueLike): string {
  const path = i.path.map(String).join('.')
  const name = path ? fieldName(path) : 'The settings'
  const min = i.minimum !== undefined ? Number(i.minimum) : null
  const max = i.maximum !== undefined ? Number(i.maximum) : null
  let what: string
  if (i.code === 'too_small') what = i.origin === 'array' ? (min === 1 ? 'tick at least one' : `needs at least ${min}`) : i.origin === 'string' ? 'cannot be empty' : `must be ${min} or more`
  else if (i.code === 'too_big') what = i.origin === 'array' ? `at most ${max}` : i.origin === 'string' ? `is too long, ${max} characters at most` : `must be ${max} or less`
  else if (i.code === 'invalid_type') what = i.expected === 'number' ? 'needs a number' : 'is missing'
  else if (i.code === 'invalid_value' || i.code === 'invalid_enum_value') what = 'is not one of the choices'
  else if (i.code === 'not_multiple_of') what = 'must be a whole number'
  else what = i.message
  return `${name}: ${what}.${NEEDS[path] && i.code === 'too_small' ? ` ${NEEDS[path]}` : ''}`
}

// Every problem with a settings document, in plain words; empty when it saves.
export function plainIssues(issues: readonly IssueLike[]): string[] {
  return [...new Set(issues.map(plainIssue))]
}

export interface ChangeLine { field: string; name: string; from: string; to: string }

export const changeLines = (changes: Change[]): ChangeLine[] =>
  changes.map((c) => ({ field: c.field, name: fieldName(c.field), from: fieldValue(c.field, c.from), to: fieldValue(c.field, c.to) }))
