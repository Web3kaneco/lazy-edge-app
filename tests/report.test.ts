import { describe, expect, it } from 'vitest'
import { buildReport, MAILTO_MAX, mailtoUrl, REPORT_MAX, reportSubject, type ReportInput } from '../src/shared/report'
import { dayOptions, type DayTicket } from '../src/shared/dayreport'
import { defaultBot } from '../src/shared/ruleset'
import { changesFromDefaults, shareCode } from '../src/shared/share'

const app: ReportInput['app'] = { version: '0.2.0-beta.3', os: 'Windows 10.0.26300 x64', engineRunning: true, executionMode: 'dry_run', killSwitch: false, lastError: null }
const play: NonNullable<ReportInput['play']> = {
  id: 't1', title: 'SEA -3.5', botName: 'Hot plays', venue: 'paper', priceSource: 'kalshi', contract: 'KXNFLSPREAD-X', side: 'yes',
  contracts: 10, filledContracts: 10, limitPriceC: 45, avgFillC: 45, costUsd: 4.5, feeUsd: 0.18, evCents: 8.3, status: 'settled',
  pnlUsd: -4.68, createdAt: 1_800_000_000_000, why: 'Model 65%', audit: ['ev 8.30c, breakeven 46.7%, calibrated p 55.0%'], error: null
}

describe('report', () => {
  it('holds the note, the app, the play, its check and the bot', () => {
    const bot = { ...defaultBot('b1', 'Hot plays'), entry: { ...defaultBot('b1', 'x').entry, edgeHaircut: 1 } }
    const text = buildReport({
      kind: 'play', note: 'Lost on a play I thought was good', at: 1_800_000_000_000, app, play,
      review: { ticketId: 't1', verdict: 'look', headline: 'Nothing is clearly wrong, but something is worth a look.', checkedAt: 0, checks: [
        { group: 'trade', level: 'ok', title: 'Price', text: 'Filled at 45c, at or under its 45c limit.' },
        { group: 'play', level: 'look', title: 'Settings', text: 'Looser than the measured defaults.' }
      ] },
      bot: { name: bot.name, code: shareCode(bot), changes: changesFromDefaults(bot) },
      problems: [{ at: 1_800_000_000_000, botName: 'Hot plays', title: 'SEA -3.5', outcome: 'rejected', detail: 'insufficient balance' }]
    })
    expect(text).toMatch(/Kind: A play looks wrong/)
    expect(text).toMatch(/Lost on a play I thought was good/)
    expect(text).toMatch(/Version 0.2.0-beta.3 on Windows/)
    expect(text).toMatch(/YES 10 of 10 at 45c \(limit 45c\)/)
    expect(text).toMatch(/P&L -\$4.68/)
    expect(text).toMatch(/OK {3}Price: Filled at 45c/)
    expect(text).toMatch(/LOOK Settings/)
    expect(text).toMatch(/entry.edgeHaircut 0.5 to 1/)
    expect(text).toMatch(/Share code: LEBOT1:/)
    expect(text).toMatch(/rejected: insufficient balance/)
  })

  it('says when nothing was written and leaves out what was not attached', () => {
    const text = buildReport({ kind: 'bug', note: '  ', at: 0, app })
    expect(text).toMatch(/\(nothing written\)/)
    expect(text).not.toMatch(/THE PLAY|BOT SETTINGS|PLAY CHECK/)
  })

  it('is cut to fit the clipboard', () => {
    expect(buildReport({ kind: 'idea', note: 'x'.repeat(50_000), at: 0, app }).length).toBeLessThanOrEqual(REPORT_MAX)
  })

  it('puts a short report in the email and asks for a paste when it is long', () => {
    const subject = reportSubject('bug', '0.2.0-beta.3')
    const short = mailtoUrl('support@lazyedge.net', subject, 'Short report\nline two')
    expect(short.full).toBe(true)
    expect(short.url).toMatch(/^mailto:support@lazyedge\.net\?subject=Lazy%20Edge%200\.2\.0-beta\.3%20Bug%20report&body=Short%20report%0D%0Aline%20two$/)
    const long = mailtoUrl('support@lazyedge.net', subject, 'x'.repeat(5000))
    expect(long.full).toBe(false)
    expect(long.url.length).toBeLessThanOrEqual(MAILTO_MAX)
    expect(decodeURIComponent(long.url)).toMatch(/press Ctrl\+V/)
  })

  it('does not call a reordered list a change', () => {
    const base = defaultBot('b1', 'x')
    const bot = { ...base, market: { ...base.market, sports: [...base.market.sports].reverse() } }
    expect(changesFromDefaults(bot).some((c) => c.field === 'market.sports')).toBe(false)
  })

  it('names the play in the subject', () => {
    expect(reportSubject('play', '0.2.0-beta.3', 'SEA -3.5')).toBe('Lazy Edge 0.2.0-beta.3 Play report: SEA -3.5')
  })
})

describe('a day of trades for the team', () => {
  const t = (over: Partial<DayTicket>): DayTicket => ({
    botId: 'b1', botName: 'Bot 1', signalKey: 'nba:g1:SPREAD:KXNBASPREAD-99JAN01AAABBB-AAA5:yes', gameId: 'g1', side: 'yes', venue: 'paper',
    filledContracts: 10, avgFillC: 40, limitPriceC: 40, costUsd: 4, feeUsd: 0.17, pnlUsd: -4.17, createdAt: new Date(2099, 0, 1, 20).getTime(),
    title: 'AAA by over 4.5', contract: 'KXNBASPREAD-99JAN01AAABBB-AAA5', status: 'settled', evCents: 2, ...over
  })

  it('lists days with trades, newest first, and leaves out orders that never filled', () => {
    const days = dayOptions([t({}), t({ createdAt: new Date(2099, 0, 2, 2).getTime(), pnlUsd: 5 }), t({ createdAt: new Date(2099, 0, 3, 20).getTime(), status: 'cancelled', filledContracts: 0 })])
    expect(days).toHaveLength(1)
    expect(days[0]).toMatchObject({ day: '2099-01-01', trades: 2, settled: 2, live: false })
    expect(days[0]!.pnlUsd).toBeCloseTo(0.83)
  })

  it('puts the totals first and every trade as a CSV row', () => {
    const text = buildReport({ kind: 'day', note: '', at: 0, app, day: {
      day: '2099-01-01', tickets: [t({}), t({ pnlUsd: null, status: 'filled', title: 'AAA, "late"' })],
      skips: { b1: { min_edge: 30, max_trades_today: 4 } },
      bots: [{ botId: 'b1', botName: 'Bot 1', code: 'LEBOT1:abc', changes: 'Settings now: the measured defaults.' }]
    } })
    expect(text).toMatch(/2 trades, 1 settled \(0 won, 1 lost\), 1 still open/)
    expect(text).toMatch(/Passed on: min_edge 30, max_trades_today 4/)
    expect(text).toMatch(/NBA SPREAD \S+ \S+: 2 trades, -\$4.17 settled, 1 open/)
    expect(text).toMatch(/Share code: LEBOT1:abc/)
    expect(text).toMatch(/"AAA, ""late""",KXNBASPREAD-99JAN01AAABBB-AAA5,yes,10,40,4.00,0.17,2.0,filled,open/)
  })
})
