// How careful to be with a change the AI proposes (2026-11-20). Every
// change is shown before it is made; what changes is how many clicks it takes:
//
//   1. a paper bot, any change: review the table and save.
//   2. a live bot, a change that only narrows what it trades: the same.
//   3. a live bot, a change that lets it trade more: a second window says so
//      by name, with the money at stake.
//   4. money, paper or live, venues and the kill switch: never by the AI.
//
// Narrowing is judged field by field. A field this file does not know is
// counted as loosening, so a new setting is careful by default.
import type { BotSettings } from './schema'
import { diffSettings, type Change } from './share'

export type Level = 1 | 2 | 3

const asList = (v: unknown): string[] => (Array.isArray(v) ? v.map(String) : [])
const subset = (a: unknown, b: unknown): boolean => asList(a).every((x) => asList(b).includes(x))
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null)

// A higher number trades less for these fields; a lower number for the next.
const HIGHER_IS_NARROWER = /^entry\.(minEdgePp|minEvCents|pickGapPp|minChancePct\.\w+)$|^guards\.noEntryFinalS$/
const LOWER_IS_NARROWER = /^entry\.(maxPriceAgeS|maxSpreadC|maxTrailing\.\w+)$|^guards\.maxTradesPerDay$|^combo\.(legs|maxPerDay)$|^market\.propTopPlayers$|^entry\.maxEdgePp$|^entry\.pregameWindowMin$/
// true is the narrower value for these switches.
const TRUE_IS_NARROWER = /^entry\.(requireTrigger|measuredOnly|favoritesOnly)$|^guards\.(noOvertime|onePositionPerMarket|noOpposingBets|oneEntryPerGame)$|^combo\.only$/
// Settings that do not change what or how much a bot trades.
const NEUTRAL = /^(pollS|exit\.\w+|guards\.autoCancelS|decider\.(model|instructions)|entry\.bidRestS)$/

// Does this one change let the bot trade more (or differently in a way that
// cannot be called narrower)?
export function loosens(c: Change): boolean {
  const f = c.field
  if (NEUTRAL.test(f)) return false
  if (/^market\.(sports|lanes|quarters|labels)$|^combo\.apiLegs$/.test(f)) return !subset(c.to, c.from)
  if (f === 'market.phase') return !(c.from === 'both' && (c.to === 'live' || c.to === 'pregame'))
  if (f === 'entry.priceBandC') {
    const [a0, a1] = asList(c.from).map(Number)
    const [b0, b1] = asList(c.to).map(Number)
    return !(b0! >= a0! && b1! <= a1!)
  }
  if (TRUE_IS_NARROWER.test(f)) return c.to !== true
  const from = num(c.from)
  const to = num(c.to)
  // null means no limit for the "most" fields and no floor for the gap.
  if (LOWER_IS_NARROWER.test(f)) return to === null || (from !== null && to > from)
  if (HIGHER_IS_NARROWER.test(f)) return to === null || (from !== null && to < from)
  return true
}

export interface LevelReport {
  level: Level
  changes: Change[]
  // The changes that let the bot trade more, for the second window.
  looser: Change[]
}

// The level a proposed change to a bot needs, with what makes it so.
export function levelFor(before: BotSettings, after: BotSettings): LevelReport {
  const { id: _a, name: _b, enabled: _c, ...was } = before
  const { id: _d, name: _e, enabled: _f, ...now } = after
  const changes = diffSettings(was, now)
  const looser = changes.filter(loosens)
  const level: Level = before.mode !== 'live' ? 1 : looser.length ? 3 : 2
  return { level, changes, looser }
}

// The fields the AI never sets. A proposal that moves one is refused whole,
// a backstop behind the editors that already keep them.
const MONEY = /^(mode|enabled|size\.\w+|guards\.maxDailyDrawdownUsd|market\.venues)$/
export const moneyChanges = (before: BotSettings, after: BotSettings): Change[] =>
  diffSettings(before, after).filter((c) => MONEY.test(c.field))
