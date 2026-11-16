import { describe, expect, it } from 'vitest'
import { defaultBot } from '../src/shared/ruleset'
import { changeNote, exportFiles, paperTestPlan, settingsChanges, type TestEvent, type TestTicket } from '../src/shared/testdata'

const bot = (id: string, change: (b: ReturnType<typeof defaultBot>) => void = () => {}) => { const b = defaultBot(id, id); change(b); return b }

describe('paper test, 2026-11-16', () => {
  it('switches every paper bot on, adds missing starters and never touches a live bot', () => {
    const live = bot('live', (b) => { b.mode = 'live'; b.size.maxTradeUsd = 50 })
    const plan = paperTestPlan([bot('a'), live], [bot('starter-x')], 2)
    expect(plan.live).toEqual(['live'])
    expect(plan.save.map((b) => b.id)).toEqual(['a', 'starter-x'])
    for (const b of plan.save) expect(b).toMatchObject({ enabled: true, mode: 'paper', size: { maxTradeUsd: 2, minTradeUsd: 1 } })
  })

  it('only ever lowers the largest trade, and leaves it alone with no cap', () => {
    const small = bot('s', (b) => { b.size.maxTradeUsd = 1; b.size.minTradeUsd = 1 })
    expect(paperTestPlan([small], [], 5).save[0]!.size.maxTradeUsd).toBe(1)
    expect(paperTestPlan([bot('a')], [], null).save[0]!.size.maxTradeUsd).toBe(10)
    expect(paperTestPlan([bot('a')], [], 0.5).save[0]!.size).toMatchObject({ maxTradeUsd: 0.5, minTradeUsd: 0.5 })
  })

  it('writes each settings change as old to new', () => {
    const before = bot('a')
    const after = bot('a', (b) => { b.entry.minEdgePp = 4; b.market.sports = ['NBA']; b.enabled = true })
    const changes = settingsChanges(before, after)
    expect(changes.map((c) => c.field).sort()).toEqual(['enabled', 'entry.minEdgePp', 'market.sports'])
    expect(changeNote('a', changes)).toContain('entry.minEdgePp 5 -> 4')
    expect(changeNote('a', changes)).toContain('market.sports NBA/NFL -> NBA')
    expect(settingsChanges(before, structuredClone(before))).toEqual([])
  })
})

describe('test data export', () => {
  const t = (over: Partial<TestTicket>): TestTicket => ({
    id: 'x', botId: 'a', botName: 'Bot A', title: 'AAA @ BBB', contract: 'KXNBAGAME-99JAN01AAABBB-AAA', status: 'settled', side: 'yes', venue: 'paper',
    priceSource: 'kalshi', contracts: 4, filledContracts: 4, avgFillC: 50, limitPriceC: 50, costUsd: 2, feeUsd: 0.07, evCents: 3, pnlUsd: 1.93,
    createdAt: Date.UTC(2099, 0, 1, 18), gameId: 'g1', signalKey: 'nba:g1:MONEYLINE:x', error: null,
    play: { sport: 'NBA', lane: 'MONEYLINE', phase: 'pregame', label: 'PRICE_GAP', hot: false, measured: false, edgePp: 6, ourP: 0.56 },
    rules: { minEdgePp: 5, minEvCents: 0.5, edgeHaircut: 0.5, priceBandC: [25, 75], maxTradeUsd: 2, maxContracts: 100 },
    ...over
  })
  const events: TestEvent[] = [
    { type: 'skip', at: Date.UTC(2099, 0, 1, 18), botId: 'a', signalKey: 'nba:g2:SPREAD:y', gate: 'min_edge', detail: '3.1pp, "low"' },
    { type: 'note', at: Date.UTC(2099, 0, 1, 17), botId: 'a', text: 'Bot A: entry.minEdgePp 6 -> 5' }
  ]

  it('writes one CSV row per order, with its tags and the rules it ran under', () => {
    const files = exportFiles([t({}), t({ id: 'y', status: 'cancelled', filledContracts: 0, avgFillC: null, pnlUsd: null, error: 'the ask moved' })], events, [bot('a')], 0, Date.UTC(2099, 0, 2))
    const rows = files['tickets.csv']!.trim().split('\r\n')
    expect(rows).toHaveLength(3)
    expect(rows[1]).toContain('NBA,MONEYLINE,PRICE_GAP,pregame')
    expect(rows[1]).toContain('5,0.5,0.5,25-75,2')
    expect(files['skips.csv']).toContain('min_edge,nba:g2:SPREAD:y,"3.1pp, ""low"""')
    expect(files['notes.csv']).toContain('entry.minEdgePp 6 -> 5')
    expect(files['summary.txt']).toContain('1 trades placed, 1 paper orders the book did not fill.')
    expect(files['summary.txt']).toContain('Passed on: min_edge 1.')
    expect(JSON.parse(files['bots.json']!)).toHaveLength(1)
  })

  it('never lets a spreadsheet read a name or title as a formula, and keeps negative numbers', () => {
    const files = exportFiles([t({ botName: '=HYPERLINK("x")', title: '@SUM(A1)', pnlUsd: -1.2 })], events, [], 0, Date.UTC(2099, 0, 2))
    const row = files['tickets.csv']!.trim().split('\r\n')[1]!
    expect(row).toContain(`,"'=HYPERLINK(""x"")",`)
    expect(row).toContain(`'@SUM(A1)`)
    expect(row).toContain(',-1.20,')
  })

  it('never carries a key, password or balance', () => {
    const files = exportFiles([t({})], events, [bot('a')], 0, Date.UTC(2099, 0, 2))
    const all = Object.entries(files).filter(([n]) => n !== 'summary.txt').map(([, v]) => v).join('\n')
    expect(all).not.toMatch(/privateKey|apiKey|password|balance/i)
  })
})
