// The AI desk (2026-11-20): one place that watches every bot, the live board
// and the graded record, and says in plain words what to change. Pure, so the
// tests and the main process read the same checks.
//
// What the desk may suggest is closed: pause a bot, or a Results fix, which
// only ever narrows what a bot trades. It can never raise a stake, switch a
// bot on, go live or touch the account. Nothing is applied until the user
// presses Apply, and every apply is written to the ledger and can be undone
// from the bot itself.
//
// The plain checks below run with no AI at all. The AI reads the same
// snapshot, these alerts and how earlier suggestions turned out, and adds its
// own; an AI suggestion whose action does not parse, or would not change the
// bot, keeps its words and loses its button.
import { z } from 'zod'
import { applyFix, Fix } from './fixes'
import { analyze, settled, type SettledLike } from './results'
import { botRisk, botRiskLines } from './risk'
import type { BotSettings } from './schema'
import { quarterOf, type Signal } from './signal'

export const DeskAction = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('pause') }),
  z.object({ kind: z.literal('fix'), fix: Fix })
])
export type DeskAction = z.infer<typeof DeskAction>

export type DeskLevel = 'act' | 'watch' | 'info'

export interface DeskRec {
  id: string
  // Stable for the same finding, so it is raised once and a dismissal sticks.
  key: string
  at: number
  source: 'rules' | 'ai'
  level: DeskLevel
  botId: string | null
  botName: string | null
  title: string
  why: string
  action: DeskAction | null
  // The gate a "blocked" check is about, for the screen's plain words.
  gate?: string
  status: 'new' | 'applied' | 'dismissed'
  doneAt?: number
  // The recorded AI change an apply made, so the Desk can put it back.
  changeId?: string
  // The paper trial running this suggestion, while it runs.
  trialId?: string
}

export interface DeskTicket extends SettledLike {
  id: string
  title: string
  status: string
  play?: SettledLike['play']
}

export interface DeskSkip { at: number; botId: string; signalKey: string; gate: string }

export interface DeskInput {
  now: number
  day: string
  bots: BotSettings[]
  // The last 30 days of tickets, newest first, every bot.
  tickets: DeskTicket[]
  // Today's skips, every bot.
  skips: DeskSkip[]
  board: Signal[]
  dayOf: (at: number) => string
}

export interface BotDay {
  botId: string
  name: string
  enabled: boolean
  mode: 'paper' | 'live'
  rules: string
  today: { trades: number; open: number; won: number; lost: number; pnlUsd: number; losingStreak: number }
  blockedBy: { gate: string; plays: number }[]
  playsSeen: number
  record30: { trades: number; games: number; won: number; lost: number; pnlUsd: number; avgPriceC: number }
  // Risk and reward over the same 30 days, in plain lines (shared/risk.ts).
  risk30?: string[]
}

export interface Holding {
  ticketId: string
  botId: string
  botName: string
  title: string
  costUsd: number
  entryP: number | null
  nowP: number | null
  quarter: string | null
  lead: number | null
}

export interface DeskSnapshot {
  at: number
  bots: BotDay[]
  holdings: Holding[]
  liveGames: number
}

const OPEN = new Set(['resting', 'filled', 'partial'])
const isOpenTicket = (t: DeskTicket): boolean => OPEN.has(t.status) && t.pnlUsd === null && t.filledContracts > 0
const round2 = (n: number): number => Math.round(n * 100) / 100

// A bot's rules in one line, for the AI and the screen.
export function rulesLine(b: BotSettings): string {
  const chance = b.entry.minChancePct
  const floors = Object.entries(chance).filter(([, v]) => v > 0).map(([k, v]) => `${k} ${v}%`).join(', ')
  return [
    `${b.market.sports.join('/')} ${b.market.lanes.join('/')}`,
    b.market.phase === 'both' ? 'pregame and live' : b.market.phase,
    b.market.phase !== 'pregame' ? `quarters ${b.market.quarters.join(' ')}` : null,
    b.entry.basis === 'pick' ? `buys our pick${b.entry.pickGapPp !== null ? `, ${b.entry.pickGapPp}pp under our number` : ''}` : `edge ${b.entry.minEdgePp}pp or more`,
    floors ? `min chance ${floors}` : null,
    `price ${b.entry.priceBandC[0]} to ${b.entry.priceBandC[1]}c`,
    b.size.sizing === 'flat' ? `flat $${b.size.maxTradeUsd}` : `kelly up to $${b.size.maxTradeUsd}`,
    b.exit.mode === 'hold' ? 'held to settlement' : b.exit.mode === 'time' ? `sold after ${b.exit.afterMin}m` : `exit +${b.exit.targetC}c`
  ].filter(Boolean).join('; ')
}

export function snapshot(input: DeskInput): DeskSnapshot {
  const { bots, tickets, skips, board, day, dayOf } = input
  const bySignal = new Map(board.map((s) => [s.key, s]))
  const botDays: BotDay[] = bots.map((b) => {
    const mine = tickets.filter((t) => t.botId === b.id && t.filledContracts > 0)
    const todays = mine.filter((t) => dayOf(t.createdAt) === day)
    const done = settled(todays)
    // Newest first: count losses until the first win.
    let losingStreak = 0
    for (const t of done) { if ((t.pnlUsd ?? 0) < 0) losingStreak++; else break }
    const seen = new Map<string, Set<string>>()
    const plays = new Set<string>()
    for (const s of skips) {
      if (s.botId !== b.id) continue
      plays.add(s.signalKey)
      let g = seen.get(s.gate)
      if (!g) seen.set(s.gate, (g = new Set()))
      g.add(s.signalKey)
    }
    for (const t of todays) plays.add(t.signalKey ?? t.id)
    const s30 = settled(mine)
    const contracts = s30.reduce((n, t) => n + t.filledContracts, 0)
    return {
      botId: b.id, name: b.name, enabled: b.enabled, mode: b.mode, rules: rulesLine(b),
      today: {
        trades: todays.length,
        open: todays.filter(isOpenTicket).length,
        won: done.filter((t) => (t.pnlUsd ?? 0) > 0).length,
        lost: done.filter((t) => (t.pnlUsd ?? 0) <= 0).length,
        pnlUsd: round2(done.reduce((n, t) => n + (t.pnlUsd ?? 0), 0)),
        losingStreak
      },
      blockedBy: [...seen].map(([gate, keys]) => ({ gate, plays: keys.size })).sort((a, z) => z.plays - a.plays).slice(0, 3),
      playsSeen: plays.size,
      record30: {
        trades: s30.length,
        games: new Set(s30.map((t) => t.gameId || t.signalKey)).size,
        won: s30.filter((t) => (t.pnlUsd ?? 0) > 0).length,
        lost: s30.filter((t) => (t.pnlUsd ?? 0) <= 0).length,
        pnlUsd: round2(s30.reduce((n, t) => n + (t.pnlUsd ?? 0), 0)),
        avgPriceC: contracts ? Math.round(s30.reduce((n, t) => n + t.filledContracts * (t.avgFillC ?? t.limitPriceC), 0) / contracts) : 0
      },
      ...((): { risk30?: string[] } => { const r = botRisk(s30); return r ? { risk30: botRiskLines(r) } : {} })()
    }
  })
  const holdings: Holding[] = tickets.filter(isOpenTicket).map((t) => {
    const now = t.signalKey ? bySignal.get(t.signalKey) : undefined
    return {
      ticketId: t.id, botId: t.botId, botName: t.botName, title: t.title, costUsd: round2(t.costUsd),
      entryP: t.play?.ourP ?? null,
      nowP: now?.ourP ?? null,
      quarter: now ? (now.phase === 'pregame' ? 'Pregame' : quarterOf(now)) : null,
      lead: now?.team?.lead ?? null
    }
  })
  const liveGames = new Set(board.filter((s) => s.phase === 'live').map((s) => s.gameId)).size
  return { at: input.now, bots: botDays, holdings, liveGames }
}

type Draft = Omit<DeskRec, 'id' | 'at' | 'status' | 'source'>

// Thresholds for the plain checks. Small on purpose: these are prompts to look,
// not verdicts, and the AI and the user decide what to do with them.
export const DESK = {
  streak: 3, // settled losses in a row today
  driftPp: 15, // our number on a held play down this many points since entry
  blockedPlays: 15, // distinct plays seen today before "blocked" is said
  blockedShare: 0.8 // one gate stopping this share of them
}

export function ruleChecks(input: DeskInput, snap: DeskSnapshot = snapshot(input)): Draft[] {
  const out: Draft[] = []
  const bots = new Map(input.bots.map((b) => [b.id, b]))
  for (const d of snap.bots) {
    const bot = bots.get(d.botId)!
    if (d.enabled && d.today.losingStreak >= DESK.streak && d.today.pnlUsd < 0) {
      out.push({
        key: `streak:${d.botId}:${input.day}`, level: 'watch', botId: d.botId, botName: d.name,
        title: `${d.name} has lost its last ${d.today.losingStreak} trades today`,
        why: `It is ${d.today.won} won, ${d.today.lost} lost today, ${money(d.today.pnlUsd)}. A run like this can be chance, but pausing it while you look costs nothing.`,
        action: { kind: 'pause' }
      })
    }
    const top = d.blockedBy[0]
    if (d.enabled && d.today.trades === 0 && top && d.playsSeen >= DESK.blockedPlays && top.plays / d.playsSeen >= DESK.blockedShare) {
      out.push({
        key: `blocked:${d.botId}:${top.gate}:${input.day}`, level: 'info', botId: d.botId, botName: d.name, gate: top.gate,
        title: `${d.name} has not traded today`,
        why: `${top.plays} of the ${d.playsSeen} plays it saw were stopped by one check. If that is not what you meant, loosen that setting on the bot; the desk never loosens a setting for you.`,
        action: null
      })
    }
    // Learning from the graded record: a part of this bot's own trades that
    // lost with a record two standard errors from breakeven, and the setting
    // that leaves it out.
    const mine = input.tickets.filter((t) => t.botId === d.botId)
    for (const r of analyze(mine).recommendations) {
      if (r.kind !== 'cut' || r.strength !== 'strong' || !r.fix) continue
      if (!applyFix(bot, r.fix).next) continue
      out.push({
        key: `cut:${d.botId}:${r.dimension}:${r.segment}`, level: 'act', botId: d.botId, botName: d.name,
        title: `${d.name}: ${r.dimension.toLowerCase()} ${r.segment} keeps losing`,
        why: r.text,
        action: { kind: 'fix', fix: r.fix }
      })
    }
  }
  for (const h of snap.holdings) {
    if (h.entryP === null || h.nowP === null) continue
    const drop = (h.entryP - h.nowP) * 100
    if (drop < DESK.driftPp) continue
    out.push({
      key: `drift:${h.ticketId}`, level: 'watch', botId: h.botId, botName: h.botName,
      title: `Our number has moved against ${h.title}`,
      why: `${h.botName} bought it at our ${pct(h.entryP)}; it now reads ${pct(h.nowP)}${h.quarter ? ` in ${h.quarter}` : ''}${h.lead !== null ? `, ${h.lead >= 0 ? `up ${h.lead}` : `down ${-h.lead}`}` : ''}. The bot holds it as set; sell it by hand if you disagree.`,
      action: null
    })
  }
  return out
}

// How an earlier suggestion turned out: the bot's settled trades made after
// the user applied or dismissed it. This is what the AI learns from.
export interface DeskOutcome { key: string; title: string; status: 'applied' | 'dismissed'; botName: string | null; tradesSince: number; pnlSinceUsd: number }

export function outcomes(recs: DeskRec[], tickets: SettledLike[], limit = 15): DeskOutcome[] {
  return recs
    .filter((r): r is DeskRec & { status: 'applied' | 'dismissed'; doneAt: number } => r.status !== 'new' && typeof r.doneAt === 'number')
    .sort((a, z) => z.doneAt - a.doneAt)
    .slice(0, limit)
    .map((r) => {
      const after = settled(tickets.filter((t) => t.botId === r.botId && t.createdAt >= r.doneAt))
      return { key: r.key, title: r.title, status: r.status, botName: r.botName, tradesSince: after.length, pnlSinceUsd: round2(after.reduce((n, t) => n + (t.pnlUsd ?? 0), 0)) }
    })
}

// New findings join the list once per key; a key the user already applied or
// dismissed is not raised again. The list keeps the newest `cap`.
export function merge(existing: DeskRec[], drafts: Draft[], source: DeskRec['source'], now: number, newId: () => string, cap = 300): DeskRec[] {
  const known = new Set(existing.map((r) => r.key))
  const added = drafts.filter((d) => !known.has(d.key)).map((d) => ({ ...d, id: newId(), at: now, source, status: 'new' as const }))
  return [...added, ...existing].slice(0, cap)
}

// The AI's answer, loose on purpose so every provider can fill it, then made
// strict here: the action must parse as a desk action and change the bot.
export const AiDesk = z.object({
  recommendations: z.array(z.object({
    bot_id: z.string().nullable(),
    level: z.enum(['act', 'watch', 'info']),
    title: z.string(),
    why: z.string(),
    action: z.enum(['none', 'pause', 'drop', 'dropPhase', 'noOvertime', 'priceFloor', 'priceCeiling', 'minEdge', 'maxTrailing', 'favoritesOnly']),
    field: z.string().nullable(),
    value: z.string().nullable(),
    number: z.number().nullable()
  }))
})
export type AiDesk = z.infer<typeof AiDesk>

export function fromAi(answer: AiDesk, bots: BotSettings[], day: string): Draft[] {
  const byId = new Map(bots.map((b) => [b.id, b]))
  // At most eight a read, however many the model sends.
  return answer.recommendations.slice(0, 8).map((r) => {
    const bot = r.bot_id ? byId.get(r.bot_id) : undefined
    let action: DeskAction | null = null
    if (bot && r.action === 'pause' && bot.enabled) action = { kind: 'pause' }
    else if (bot && r.action !== 'none' && r.action !== 'pause') {
      const raw = r.action === 'drop' ? { kind: 'drop', field: r.field, value: r.value }
        : r.action === 'dropPhase' ? { kind: 'dropPhase', phase: r.value }
        : r.action === 'priceFloor' || r.action === 'priceCeiling' ? { kind: r.action, c: r.number }
        : r.action === 'minEdge' ? { kind: 'minEdge', pp: r.number }
        : r.action === 'maxTrailing' ? { kind: 'maxTrailing', points: r.number }
        : { kind: r.action }
      const fix = Fix.safeParse(raw)
      if (fix.success && applyFix(bot, fix.data).next) action = { kind: 'fix', fix: fix.data }
    }
    const title = r.title.trim().slice(0, 140)
    return {
      key: `ai:${day}:${bot?.id ?? 'all'}:${title.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim().slice(0, 60)}`,
      level: r.level, botId: bot?.id ?? null, botName: bot?.name ?? null,
      title, why: r.why.trim().slice(0, 600), action
    }
  }).filter((d) => d.title.length > 0)
}

const pct = (p: number): string => `${Math.round(p * 100)}%`
const money = (n: number): string => `${n < 0 ? '−' : '+'}$${Math.abs(n).toFixed(2)}`
