import { describe, expect, it } from 'vitest'
import { fromAi, merge, outcomes, ruleChecks, snapshot, type DeskInput, type DeskRec, type DeskTicket } from '@shared/desk'
import { defaultBot } from '@shared/ruleset'
import type { Signal } from '@shared/signal'

const NOW = Date.UTC(2026, 10, 20, 3, 0, 0)
const DAY = '2026-11-19'
const dayOf = (at: number): string => (at >= NOW - 12 * 3600_000 ? DAY : 'earlier')

const bot = (id: string, over: (b: ReturnType<typeof defaultBot>) => void = () => {}) => {
  const b = defaultBot(id, `Bot ${id}`)
  b.enabled = true
  over(b)
  return b
}

let n = 0
function ticket(botId: string, pnlUsd: number | null, over: Partial<DeskTicket> = {}): DeskTicket {
  n++
  return {
    id: `t${n}`, botId, botName: `Bot ${botId}`, title: `AAA @ BBB play ${n}`, signalKey: `nba:g${n}:MONEYLINE:home`, gameId: `g${n}`,
    side: 'yes', venue: 'paper', filledContracts: 10, avgFillC: 60, limitPriceC: 60, costUsd: 6, feeUsd: 0.1,
    pnlUsd, createdAt: NOW - n * 60_000, status: pnlUsd === null ? 'filled' : 'settled',
    play: { sport: 'NBA', lane: 'MONEYLINE', phase: 'live', label: 'PRICE_GAP', hot: false, measured: false, edgePp: 8, ourP: 0.7, quarter: 'Q2' },
    ...over
  }
}

function input(over: Partial<DeskInput>): DeskInput {
  return { now: NOW, day: DAY, dayOf, bots: [], tickets: [], skips: [], board: [], ...over }
}

describe('the desk snapshot', () => {
  it('counts today, the losing run, what stopped the bot and the last 30 days', () => {
    n = 0
    const tickets = [ticket('a', -6), ticket('a', -6), ticket('a', -6), ticket('a', 4), ticket('a', null)]
    const skips = [1, 2, 3].map((i) => ({ at: NOW, botId: 'a', signalKey: `s${i}`, gate: 'min_chance' }))
    const s = snapshot(input({ bots: [bot('a')], tickets, skips }))
    expect(s.bots[0]!.today).toMatchObject({ trades: 5, open: 1, won: 1, lost: 3, pnlUsd: -14, losingStreak: 3 })
    expect(s.bots[0]!.blockedBy[0]).toEqual({ gate: 'min_chance', plays: 3 })
    expect(s.bots[0]!.record30).toMatchObject({ trades: 4, won: 1, lost: 3 })
    expect(s.holdings).toHaveLength(1)
  })
})

describe('the plain checks', () => {
  it('suggests pausing a bot on a losing run, never one that is off', () => {
    n = 0
    const tickets = [ticket('a', -6), ticket('a', -6), ticket('a', -6)]
    const recs = ruleChecks(input({ bots: [bot('a')], tickets }))
    expect(recs.find((r) => r.key.startsWith('streak:'))).toMatchObject({ level: 'watch', action: { kind: 'pause' } })
    const off = ruleChecks(input({ bots: [bot('a', (b) => { b.enabled = false })], tickets }))
    expect(off.some((r) => r.key.startsWith('streak:'))).toBe(false)
  })

  it('says when one check stopped nearly everything, with no button', () => {
    const skips = Array.from({ length: 20 }, (_, i) => ({ at: NOW, botId: 'a', signalKey: `s${i}`, gate: i < 18 ? 'min_chance' : 'band' }))
    const r = ruleChecks(input({ bots: [bot('a')], skips })).find((x) => x.key.startsWith('blocked:'))
    expect(r).toMatchObject({ level: 'info', gate: 'min_chance', action: null })
    expect(r!.why).toContain('18 of the 20')
  })

  it('flags a held play our number has turned against', () => {
    n = 0
    const held = ticket('a', null, { signalKey: 'nba:g9:MONEYLINE:home' })
    const board = [{ key: 'nba:g9:MONEYLINE:home', ourP: 0.5, phase: 'live', clock: { period: 3, secondsRemaining: 300, overtime: false }, team: { lead: -8, winP: 0.4 }, gameId: 'g9' } as unknown as Signal]
    const r = ruleChecks(input({ bots: [bot('a')], tickets: [held], board })).find((x) => x.key.startsWith('drift:'))
    expect(r!.why).toContain('70%')
    expect(r!.why).toContain('50% in Q3, down 8')
    expect(r!.action).toBeNull()
  })

  it('learns from the graded record: a part that keeps losing gets its fix', () => {
    n = 0
    // 30 games won by Q1 trades losing hard, Q2 trades winning.
    const tickets: DeskTicket[] = []
    for (let i = 0; i < 30; i++) {
      tickets.push(ticket('a', -6, { createdAt: NOW - 3 * 86_400_000 - i, play: { sport: 'NBA', lane: 'MONEYLINE', phase: 'live', label: 'PRICE_GAP', hot: false, measured: false, edgePp: 8, ourP: 0.7, quarter: 'Q1' } }))
      tickets.push(ticket('a', 4, { createdAt: NOW - 3 * 86_400_000 - i, play: { sport: 'NBA', lane: 'MONEYLINE', phase: 'live', label: 'PRICE_GAP', hot: false, measured: false, edgePp: 8, ourP: 0.7, quarter: 'Q2' } }))
    }
    const r = ruleChecks(input({ bots: [bot('a')], tickets })).find((x) => x.key === 'cut:a:Quarter bought in:Q1')
    expect(r).toMatchObject({ level: 'act', action: { kind: 'fix', fix: { kind: 'drop', field: 'quarters', value: 'Q1' } } })
    // Too few games: no call.
    const few = ruleChecks(input({ bots: [bot('a')], tickets: tickets.slice(0, 10) }))
    expect(few.some((x) => x.key.startsWith('cut:'))).toBe(false)
  })
})

describe('the AI answer', () => {
  const bots = [bot('a'), bot('off', (b) => { b.enabled = false })]
  const rec = (over: object) => ({ bot_id: 'a', level: 'act' as const, title: 'Bot a: drop Q1', why: 'Q1 lost.', action: 'none' as const, field: null, value: null, number: null, ...over })

  it('keeps a valid narrowing as a button', () => {
    const [d] = fromAi({ recommendations: [rec({ action: 'drop', field: 'quarters', value: 'Q1' })] }, bots, DAY)
    expect(d!.action).toEqual({ kind: 'fix', fix: { kind: 'drop', field: 'quarters', value: 'Q1' } })
  })

  it('drops the button, never the words, when the action is bad or would change nothing', () => {
    const out = fromAi({ recommendations: [
      rec({ title: 'one', action: 'drop', field: 'size', value: 'x' }),
      rec({ title: 'two', action: 'priceFloor', number: 10 }), // the band low is already 25
      rec({ title: 'three', bot_id: 'nope', action: 'pause' }),
      rec({ title: 'four', bot_id: 'off', action: 'pause' })
    ] }, bots, DAY)
    expect(out.map((d) => d.action)).toEqual([null, null, null, null])
    expect(out.map((d) => d.title)).toEqual(['one', 'two', 'three', 'four'])
  })
})

describe('the desk list', () => {
  it('raises a finding once and keeps a dismissal', () => {
    let i = 0
    const id = (): string => `id${++i}`
    const draft = { key: 'k1', level: 'info' as const, botId: null, botName: null, title: 't', why: 'w', action: null }
    const first = merge([], [draft], 'rules', NOW, id)
    const dismissed: DeskRec[] = first.map((r) => ({ ...r, status: 'dismissed', doneAt: NOW }))
    expect(merge(dismissed, [draft], 'rules', NOW, id)).toHaveLength(1)
  })

  it('reports how an applied suggestion turned out', () => {
    n = 0
    const r: DeskRec = { id: 'x', key: 'k', at: NOW - 10, source: 'ai', level: 'act', botId: 'a', botName: 'Bot a', title: 't', why: 'w', action: { kind: 'pause' }, status: 'applied', doneAt: NOW - 100_000 }
    const after = [ticket('a', 3, { createdAt: NOW }), ticket('a', -1, { createdAt: NOW }), ticket('a', 5, { createdAt: NOW - 200_000 })]
    expect(outcomes([r], after)[0]).toMatchObject({ status: 'applied', tradesSince: 2, pnlSinceUsd: 2 })
  })
})
