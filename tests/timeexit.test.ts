import { describe, expect, it } from 'vitest'
import { newExit, paperExitFill, timeExitDue } from '@shared/exits'
import { DEFAULT_ACCOUNT, defaultBot } from '@shared/ruleset'
import { BotSettings } from '@shared/schema'
import type { Signal } from '@shared/signal'
import { STARTERS } from '@shared/starters'
import { evaluate, type GateContext } from '../src/main/rules/gates'
import { kalshiAsk } from '../src/main/venues/kalshi'

const NOW = Date.UTC(2026, 10, 20, 2, 0, 0)

// A 4th quarter NBA moneyline: our 70% against a 60c ask, a 10 point gap.
function play(over: Partial<Signal> = {}, quote: { ask?: number; bid?: number | null } = {}): Signal {
  return {
    key: 'nba:g1:MONEYLINE:home', sport: 'NBA', lane: 'MONEYLINE', phase: 'live', gameId: 'g1',
    title: 'AAA @ BBB BBB to win', signalType: 'BUY_HOME', explicitSide: 'yes',
    ourP: 0.7, marketP: 0.6, edgePp: 10, label: 'PRICE_GAP', kelly: null, trigger: false, measured: false,
    clock: { period: 4, secondsRemaining: 600, overtime: false },
    quotes: [{ venue: 'kalshi', contract: 'KXNBAGAME-99JAN01AAABBB-BBB', side: 'yes', ask: quote.ask ?? 0.6, askSize: 500, bid: quote.bid === undefined ? 0.58 : quote.bid, priceAgeS: 10 }],
    why: null, receivedAt: NOW, team: { lead: 4, winP: 0.6 },
    ...over
  }
}

const q4 = (): BotSettings => {
  const b = STARTERS.find((s) => s.key === 'nba-q4-catchup')!.build()
  b.enabled = true
  b.market.venues = ['kalshi']
  return b
}
const account = () => { const a = structuredClone(DEFAULT_ACCOUNT); a.venues.kalshi.enabled = true; return a }
const ctx = (over: Partial<GateContext> = {}): GateContext => ({
  now: NOW, venues: { paper: { balanceUsd: 1000, equityUsd: 1000 }, kalshi: { balanceUsd: 200, equityUsd: 200 } }, openMarketKeys: new Set(), gamePositions: [],
  gameExposureUsd: 0, accountOpenExposureUsd: 0, botDailyPnlUsd: 0, accountDailyPnlUsd: 0, botTradesToday: 0, ...over
})

describe('the bid on the Kalshi book', () => {
  it('reads our side best bid with the ask', () => {
    const book = { orderbook_fp: { yes_dollars: [['0.5800', '40'], ['0.5500', '10']], no_dollars: [['0.4000', '25']] } }
    expect(kalshiAsk(book, 'yes')).toMatchObject({ ask: 0.6, askSize: 25, bid: 0.58 })
    expect(kalshiAsk(book, 'no')).toMatchObject({ ask: 0.42, bid: 0.4 })
    expect(kalshiAsk({ orderbook_fp: { no_dollars: [['0.4000', '25']] } }, 'yes')).toMatchObject({ ask: 0.6, bid: null })
  })
})

describe('the widest book, 2026-11-20', () => {
  it('buys a book within the width and refuses one wider or with no bid', () => {
    expect(evaluate(play(), q4(), account(), ctx())).toMatchObject({ kind: 'trade', limitPriceC: 60 })
    expect(evaluate(play({}, { bid: 0.57 }), q4(), account(), ctx())).toMatchObject({ kind: 'trade' })
    expect(evaluate(play({}, { bid: 0.56 }), q4(), account(), ctx())).toMatchObject({ gate: 'no_venue', detail: 'kalshi:book 4c wide' })
    expect(evaluate(play({}, { bid: null }), q4(), account(), ctx())).toMatchObject({ gate: 'no_venue', detail: 'kalshi:no bid' })
  })

  it('ignores the bid when no width is set', () => {
    const b = q4()
    b.entry.maxSpreadC = null
    expect(evaluate(play({}, { bid: null }), b, account(), ctx())).toMatchObject({ kind: 'trade' })
  })
})

describe('one entry a game', () => {
  it('refuses a second entry on a game the bot already bought today', () => {
    expect(evaluate(play(), q4(), account(), ctx({ gameEntriesToday: 1 }))).toMatchObject({ gate: 'game_entered' })
    const b = q4()
    b.guards.oneEntryPerGame = false
    expect(evaluate(play(), b, account(), ctx({ gameEntriesToday: 1 }))).toMatchObject({ kind: 'trade' })
  })
})

describe('the time exit', () => {
  const exit = () => newExit('time', 60, 10, { now: NOW, afterMin: 15, atQuarterEnd: true, period: 4 })

  it('is due after its minutes whatever the price', () => {
    const e = exit()
    expect(e).toMatchObject({ mode: 'time', targetC: 1, dueAt: NOW + 15 * 60_000, period: 4, atQuarterEnd: true })
    expect(timeExitDue(e, NOW + 14 * 60_000, { period: 4, secondsRemaining: 100 })).toBe(false)
    expect(timeExitDue(e, NOW + 15 * 60_000, { period: 4, secondsRemaining: 100 })).toBe(true)
    // Due means any bid sells, even below what was paid; never before.
    expect(paperExitFill(e, 8, { bidC: 52, size: 100 })).toMatchObject({ contracts: 8, priceC: 52 })
  })

  it('is due sooner at the end of the quarter when set, and only then', () => {
    const e = exit()
    expect(timeExitDue(e, NOW + 60_000, { period: 4, secondsRemaining: 0 })).toBe(true)
    expect(timeExitDue(e, NOW + 60_000, { period: 5, secondsRemaining: 300 })).toBe(true)
    expect(timeExitDue(e, NOW + 60_000, null)).toBe(false)
    expect(timeExitDue({ ...e, atQuarterEnd: false }, NOW + 60_000, { period: 5, secondsRemaining: 300 })).toBe(false)
  })

  it('sells as a taker, and is never due on another exit mode', () => {
    const fill = paperExitFill(exit(), 10, { bidC: 50, size: 100 })!
    const limit = paperExitFill(newExit('limit', 40, 10), 10, { bidC: 50, size: 100 })!
    expect(fill.feeUsd).toBeGreaterThan(limit.feeUsd)
    expect(timeExitDue(newExit('mark', 60, 10), NOW + 3_600_000, null)).toBe(false)
  })
})

describe('settings saved before 0.9.1', () => {
  it('read with no width, no time exit and more than one entry a game', () => {
    const old = defaultBot('b1', 'old') as any
    delete old.entry.maxSpreadC
    delete old.guards.oneEntryPerGame
    old.exit = { mode: 'mark', targetC: 8 }
    const b = BotSettings.parse(old)
    expect(b.entry.maxSpreadC).toBeNull()
    expect(b.guards.oneEntryPerGame).toBe(false)
    expect(b.exit).toEqual({ mode: 'mark', targetC: 8, afterMin: 15, atQuarterEnd: false })
  })

  it('the 4th quarter starter carries its rules', () => {
    const b = STARTERS.find((s) => s.key === 'nba-q4-catchup')!.build()
    expect(BotSettings.parse(b)).toBeTruthy()
    expect(b).toMatchObject({
      enabled: false, mode: 'paper',
      market: { sports: ['NBA'], lanes: ['MONEYLINE'], phase: 'live', quarters: ['Q4'] },
      entry: { basis: 'edge', minEdgePp: 8, maxSpreadC: 3 },
      size: { sizing: 'flat', maxTradeUsd: 5 },
      exit: { mode: 'time', afterMin: 15, atQuarterEnd: true },
      guards: { oneEntryPerGame: true }
    })
    // Q1 to Q3 are off.
    expect(evaluate(play({ clock: { period: 1, secondsRemaining: 600, overtime: false } }), q4(), account(), ctx())).toMatchObject({ gate: 'quarter_not_enabled' })
    // A 7 point gap is under the bar.
    expect(evaluate(play({ ourP: 0.67, edgePp: 7 }), q4(), account(), ctx())).toMatchObject({ kind: 'skip' })
  })
})
