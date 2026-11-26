import { describe, expect, it } from 'vitest'
import { levelFor, loosens, moneyChanges } from '../src/shared/levels'
import { findPatterns, patternBot } from '../src/shared/patterns'
import { defaultBot } from '../src/shared/ruleset'
import { BotSettings } from '../src/shared/schema'
import { acceptedBot, trialBot, trialViews, TRIAL_MIN_SETTLED } from '../src/shared/trials'
import { whyFacts } from '../src/shared/why'
import { fixFor, type SettledLike } from '../src/shared/results'
import { applyFix, fixText } from '../src/shared/fixes'
import { playTags } from '../src/shared/signal'

const bot = (over: (b: BotSettings) => void = () => {}): BotSettings => { const b = defaultBot('b1', 'Test bot'); b.enabled = true; over(b); return b }
const edit = (b: BotSettings, f: (x: BotSettings) => void): BotSettings => { const x = structuredClone(b); f(x); return x }

describe('levels of confirmation', () => {
  it('a paper bot is level 1 whatever the change', () => {
    const b = bot()
    expect(levelFor(b, edit(b, (x) => { x.entry.minEdgePp = 1 })).level).toBe(1)
  })

  it('a live bot that only narrows is level 2', () => {
    const b = bot((x) => { x.mode = 'live' })
    const r = levelFor(b, edit(b, (x) => { x.market.quarters = ['Q2', 'Q3', 'Q4']; x.entry.minEdgePp = 7; x.entry.priceBandC = [30, 70]; x.guards.noOvertime = true; x.market.phase = 'live' }))
    expect(r).toMatchObject({ level: 2, looser: [] })
  })

  it('a live bot asked to trade more is level 3 and names what loosens', () => {
    const b = bot((x) => { x.mode = 'live'; x.market.quarters = ['Q2', 'Q3'] })
    const r = levelFor(b, edit(b, (x) => { x.market.quarters = ['Q1', 'Q2', 'Q3']; x.entry.minEdgePp = 7 }))
    expect(r.level).toBe(3)
    expect(r.looser.map((c) => c.field)).toEqual(['market.quarters'])
  })

  it('reads each kind of field the right way round, and an unknown field as loosening', () => {
    expect(loosens({ field: 'entry.minChancePct.Q4', from: 80, to: 60 })).toBe(true)
    expect(loosens({ field: 'entry.minChancePct.Q4', from: 60, to: 80 })).toBe(false)
    expect(loosens({ field: 'entry.maxTrailing.Q2', from: 5, to: null })).toBe(true)
    expect(loosens({ field: 'entry.priceBandC', from: [25, 75], to: [20, 75] })).toBe(true)
    expect(loosens({ field: 'guards.oneEntryPerGame', from: true, to: false })).toBe(true)
    expect(loosens({ field: 'exit.mode', from: 'hold', to: 'limit' })).toBe(false)
    expect(loosens({ field: 'entry.somethingNew', from: 1, to: 2 })).toBe(true)
  })

  it('money, paper or live and venues are never the AI\'s', () => {
    const b = bot()
    expect(moneyChanges(b, edit(b, (x) => { x.size.maxTradeUsd = 500; x.mode = 'live'; x.market.venues = ['kalshi'] })).map((c) => c.field))
      .toEqual(expect.arrayContaining(['size.maxTradeUsd', 'mode', 'market.venues']))
    expect(moneyChanges(b, edit(b, (x) => { x.entry.minEdgePp = 9 }))).toEqual([])
  })
})

const ticket = (botId: string, pnl: number | null, at: number, over: Partial<SettledLike> = {}): SettledLike => ({
  botId, botName: botId, side: 'yes', venue: 'paper', filledContracts: 10, avgFillC: 60, limitPriceC: 60, costUsd: 6, feeUsd: 0.1, pnlUsd: pnl, createdAt: at, ...over
})

describe('paper trials', () => {
  it('a trial is a paper copy that is on, and accepting keeps the original\'s money and mode', () => {
    const live = bot((x) => { x.mode = 'live'; x.size.maxTradeUsd = 7; x.market.venues = ['kalshi'] })
    const proposed = edit(live, (x) => { x.market.quarters = ['Q3', 'Q4'] })
    const t = trialBot(live, proposed, 'Q3 and Q4 only', 1000)
    expect(t).toMatchObject({ enabled: true, mode: 'paper', trial: { of: 'b1', startedAt: 1000 }, market: { quarters: ['Q3', 'Q4'] } })
    expect(BotSettings.safeParse(t).success).toBe(true)
    const accepted = acceptedBot(live, { ...t, size: { ...t.size, maxTradeUsd: 99 } })
    expect(accepted).toMatchObject({ id: 'b1', mode: 'live', size: { maxTradeUsd: 7 }, market: { venues: ['kalshi'], quarters: ['Q3', 'Q4'] } })
    expect(accepted.trial).toBeUndefined()
  })

  it('compares both records from the start, per contract, and waits for enough trades', () => {
    const live = bot()
    const t = trialBot(live, live, 'a change', 1000)
    const tickets = [
      ticket('b1', -6, 500), // before the trial: not counted
      ticket('b1', 4, 2000), ticket('b1', -6, 2001),
      ...Array.from({ length: TRIAL_MIN_SETTLED }, (_, i) => ticket(t.id, 4, 3000 + i))
    ]
    const [v] = trialViews([live, t], tickets)
    expect(v).toMatchObject({ ofName: 'Test bot', ready: true, original: { trades: 2, centsPerContract: -10 }, trial: { trades: TRIAL_MIN_SETTLED, centsPerContract: 40 } })
    expect(v!.verdict).toMatch(/did better/)
    expect(trialViews([live, t], tickets.slice(0, 5))[0]!.ready).toBe(false)
  })
})

describe('patterns in the record', () => {
  // 24 made up games of NBA props in Q3 at about 72%, bought at 60c, 20 won.
  const play = { sport: 'NBA', lane: 'PROP', phase: 'live', quarter: 'Q3', label: 'PRICE_GAP', hot: false, measured: false, edgePp: 6, ourP: 0.72 } as SettledLike['play']
  const record = Array.from({ length: 24 }, (_, i) => ticket('p', i < 20 ? 4 : -6, i, { gameId: `g${i}`, play }))

  it('finds a winning part of the record, and makes a paper bot for it', () => {
    const p = findPatterns(record).find((x) => x.build)!
    expect(p).toMatchObject({ kind: 'winning', strength: 'proven', won: 20, lost: 4, build: { sport: 'NBA', lane: 'PROP', quarter: 'Q3' } })
    const b = patternBot(p, 5000)
    expect(BotSettings.safeParse(b).success).toBe(true)
    expect(b).toMatchObject({ enabled: true, mode: 'paper', market: { sports: ['NBA'], lanes: ['PROP'], phase: 'live', quarters: ['Q3'] }, size: { sizing: 'flat', maxTradeUsd: 5 } })
  })

  it('says nothing about a record too small to read', () => {
    expect(findPatterns(record.slice(0, 5))).toEqual([])
  })

  // 2026-11-21: the same bot, the same settings, the 2nd quarter
  // against the 4th. Made up: 24 games in Q2 that mostly won, 24 in Q4 at
  // the same chance that mostly lost.
  it('finds a losing spot inside one bot against the rest of its trades, with the fix', () => {
    const b = bot((x) => { x.id = 'q'; x.market.lanes = ['PROP']; x.market.sports = ['NBA']; x.market.phase = 'live'; x.market.quarters = ['Q2', 'Q3', 'Q4'] })
    const tag = (quarter: 'Q2' | 'Q4') => ({ ...play!, quarter })
    const trades = [
      ...Array.from({ length: 24 }, (_, i) => ticket('q', i < 19 ? 4 : -6, i, { gameId: `a${i}`, play: tag('Q2') })),
      ...Array.from({ length: 24 }, (_, i) => ticket('q', i < 6 ? 4 : -6, 100 + i, { gameId: `b${i}`, play: tag('Q4') }))
    ]
    const ps = findPatterns(trades, [b])
    expect(ps[0]).toMatchObject({ kind: 'losing', strength: 'proven', botId: 'q', dimension: 'Quarter bought in', segment: 'Q4', won: 6, lost: 18, fix: { kind: 'drop', field: 'quarters', value: 'Q4' } })
    expect(ps[0]!.rest).toMatchObject({ n: 24 })
    expect(ps[0]!.rest!.centsPerContract).toBeGreaterThan(0)
    // Losing spots come before winning ones.
    const firstWin = ps.findIndex((p) => p.kind === 'winning')
    expect(ps.findIndex((p) => p.kind === 'losing')).toBeLessThan(firstWin === -1 ? Infinity : firstWin)
  })

  it('reads where a prop was: how far from the line and the time left', () => {
    const near = { ...play!, propLine: 20.5, propSoFar: 19, propOver: true, secondsLeft: 200 }
    const far = { ...play!, propLine: 20.5, propSoFar: 9, propOver: true, secondsLeft: 1500 }
    const b = bot((x) => { x.id = 'r'; x.market.lanes = ['PROP'] })
    const trades = [
      ...Array.from({ length: 12 }, (_, i) => ticket('r', i < 11 ? 4 : -6, i, { gameId: `c${i}`, play: near })),
      ...Array.from({ length: 12 }, (_, i) => ticket('r', i < 2 ? 4 : -6, 50 + i, { gameId: `d${i}`, play: far }))
    ]
    const ps = findPatterns(trades, [b])
    expect(ps.map((p) => `${p.kind}:${p.dimension}:${p.segment}`)).toEqual(expect.arrayContaining([
      'losing:How far from the line:Over, needed 6 or more',
      'winning:How far from the line:Over, needed 2 or fewer more'
    ]))
  })
})

describe('fixes for the new spots', () => {
  it('raises the minimum chance in one quarter, and keeps out of the last minutes', () => {
    const b = bot((x) => { x.market.phase = 'live' })
    const q4 = applyFix(b, { kind: 'minChance', when: 'Q4', pct: 70 }).next!
    expect(q4.entry.minChancePct).toMatchObject({ Q3: 0, Q4: 70 })
    expect(applyFix(q4, { kind: 'minChance', when: 'Q4', pct: 70 }).next).toBeNull()
    expect(applyFix(b, { kind: 'finalSeconds', s: 300 }).next!.guards.noEntryFinalS).toBe(300)
    expect(fixText({ kind: 'minChance', when: 'Q4', pct: 70 })).toBe('Raise the minimum chance to hit to 70% in the 4th quarter')
    expect(fixFor('quarterChance', 'Q4 at 60 to 70%')).toEqual({ kind: 'minChance', when: 'Q4', pct: 70 })
    expect(fixFor('timeLeft', '2 to 5 minutes left')).toEqual({ kind: 'finalSeconds', s: 300 })
  })

  it('a prop trade records where it was', () => {
    const tags = playTags({
      key: 'k', sport: 'NBA', lane: 'PROP', phase: 'live', gameId: 'g', title: 't', signalType: 'BUY_OVER', explicitSide: 'yes',
      ourP: 0.7, marketP: 0.6, edgePp: 10, label: 'PRICE_GAP', kelly: null, trigger: false, measured: false,
      clock: { period: 3, secondsRemaining: 1000, overtime: false }, quotes: [], why: null, receivedAt: 0,
      prop: { line: 20.5, soFar: 14, over: true, teamLead: -4 }
    })
    expect(tags).toMatchObject({ quarter: 'Q3', secondsLeft: 1000, marketP: 0.6, propLine: 20.5, propSoFar: 14, propOver: true, propTeamLead: -4 })
  })
})

describe('why a bot is not trading', () => {
  const words = (g: string): string => ({ no_venue: 'No venue passes', min_edge: 'Edge is under your minimum', quarter_not_enabled: 'Quarter is off for this bot' }[g] ?? g)
  const base = { engineRunning: true, liveProblem: null, skipsToday: [], tradesToday: 0, gateWords: words }

  it('names the one check stopping most plays, from this cycle and today', () => {
    const f = whyFacts({ ...base, bot: bot(), verdicts: [
      { outcome: 'skip', gate: 'quarter_not_enabled', detail: 'Q1' }, { outcome: 'skip', gate: 'quarter_not_enabled', detail: 'Q1' },
      { outcome: 'skip', gate: 'min_edge', detail: '2.1pp < 5pp' }
    ], skipsToday: [{ gate: 'no_venue', detail: 'kalshi:no key' }] })
    expect(f.headline).toMatch(/mainly because of one check: quarter is off for this bot \(2 plays\)/)
    expect(f.lines.join(' ')).toMatch(/No venue passes: 1 play/)
  })

  it('puts the engine and a live problem first', () => {
    expect(whyFacts({ ...base, engineRunning: false, bot: bot(), verdicts: [] }).headline).toBe('The engine is stopped.')
    expect(whyFacts({ ...base, liveProblem: 'No key.', bot: bot(), verdicts: [] }).headline).toMatch(/cannot send orders/)
  })

  it('a bot that is off says what it would do', () => {
    const f = whyFacts({ ...base, bot: bot((x) => { x.enabled = false }), verdicts: [{ outcome: 'take', gate: null, detail: 'YES 8 @ 62c' }] })
    expect(f.headline).toBe('Test bot is switched off.')
    expect(f.lines[0]).toBe('If it were on it would take 1 play right now.')
  })
})
