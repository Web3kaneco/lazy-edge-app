import { describe, expect, it } from 'vitest'
import { DEFAULT_ACCOUNT, defaultBot } from '@shared/ruleset'
import type { AccountSettings, BotSettings } from '@shared/schema'
import type { Signal } from '@shared/signal'
import { breakevenProb, evCents, kalshiFee } from '../src/main/rules/fees'
import { evaluate, type GateContext } from '../src/main/rules/gates'
import { resolveSide } from '../src/main/rules/side'

const NOW = Date.UTC(2026, 9, 24, 1, 0, 0)

function signal(over: Partial<Signal> = {}): Signal {
  return {
    key: 'nfl:g1:total:47.5:under',
    sport: 'NFL',
    lane: 'TOTAL',
    phase: 'pregame',
    gameId: 'g1',
    title: 'KC @ BUF under 47.5',
    signalType: 'BUY_UNDER',
    explicitSide: null,
    ourP: 0.6,
    marketP: 0.5,
    edgePp: 10,
    label: 'PRICE_GAP',
    kelly: null,
    trigger: false,
    measured: false,
    clock: null,
    quotes: [{ venue: 'kalshi', contract: 'KXNFLTOTAL-G1-47', side: 'no', ask: 0.5, askSize: 500, priceAgeS: 20 }],
    why: null,
    receivedAt: NOW,
    ...over
  }
}

function bot(over: (b: BotSettings) => void = () => {}): BotSettings {
  const b = defaultBot('b1', 'test')
  b.enabled = true
  b.market.venues = ['kalshi', 'polymarket']
  over(b)
  return b
}

function liveBot(over: (b: BotSettings) => void = () => {}): BotSettings {
  return bot((b) => { b.mode = 'live'; over(b) })
}

function account(over: (a: AccountSettings) => void = () => {}): AccountSettings {
  const a: AccountSettings = structuredClone(DEFAULT_ACCOUNT)
  a.venues.kalshi.enabled = true
  a.venues.polymarket.enabled = true
  over(a)
  return a
}

function ctx(over: Partial<GateContext> = {}): GateContext {
  return {
    now: NOW,
    venues: {
      paper: { balanceUsd: 1000, equityUsd: 1000 },
      kalshi: { balanceUsd: 200, equityUsd: 200 },
      polymarket: { balanceUsd: 200, equityUsd: 200 }
    },
    openMarketKeys: new Set(),
    gameExposureUsd: 0,
    accountOpenExposureUsd: 0,
    botDailyPnlUsd: 0,
    accountDailyPnlUsd: 0,
    botTradesToday: 0,
    ...over
  }
}

describe('fees, ported from the server engine', () => {
  it('taker fee is 0.07 * p * (1 - p), peaking at 50c', () => {
    expect(kalshiFee(0.5)).toBeCloseTo(0.0175, 6)
    expect(kalshiFee(0.83)).toBeCloseTo(0.07 * 0.83 * 0.17, 6)
    expect(kalshiFee(0.83)).toBeLessThan(kalshiFee(0.5))
  })

  it('an 83c contract with a real 7pp edge beats a 50c one with the same edge', () => {
    expect(evCents(0.9, 0.83)).toBeGreaterThan(evCents(0.57, 0.5))
  })

  it('breakeven is the cost plus its fee', () => {
    expect(breakevenProb(0.5)).toBeCloseTo(0.5175, 6)
  })
})

describe('side table, fail closed', () => {
  it('BUY_UNDER is the NO side of the same strike, never YES (the inverted under)', () => {
    expect(resolveSide({ signalType: 'BUY_UNDER', explicitSide: null })).toBe('no')
    expect(resolveSide({ signalType: 'BUY_OVER', explicitSide: null })).toBe('yes')
  })

  it('moneyline sides are YES on their own tickers', () => {
    expect(resolveSide({ signalType: 'BUY_HOME', explicitSide: null })).toBe('yes')
    expect(resolveSide({ signalType: 'BUY_AWAY', explicitSide: null })).toBe('yes')
  })

  it('refuses a signal it does not recognise rather than guessing', () => {
    expect(resolveSide({ signalType: 'BUY_SOMETHING', explicitSide: null })).toBeNull()
    expect(resolveSide({ signalType: '', explicitSide: null })).toBeNull()
  })

  it('refuses when the API side and the table disagree', () => {
    expect(resolveSide({ signalType: 'BUY_UNDER', explicitSide: 'yes' })).toBeNull()
  })
})

describe('gates', () => {
  it('trades a clean signal and routes the UNDER as NO', () => {
    const d = evaluate(signal(), liveBot(), account(), ctx())
    expect(d.kind).toBe('trade')
    if (d.kind !== 'trade') return
    expect(d.side).toBe('no')
    expect(d.venue).toBe('kalshi')
    expect(d.dryRun).toBe(true) // the shipped default
  })

  it('an unrecognised signal never reaches an order', () => {
    const d = evaluate(signal({ signalType: 'BUY_MYSTERY' }), liveBot(), account(), ctx())
    expect(d).toMatchObject({ kind: 'skip', gate: 'side_unresolved' })
  })

  it('a lane the user did not enable cannot trade', () => {
    const d = evaluate(signal(), liveBot((b) => { b.market.lanes = ['MONEYLINE'] }), account(), ctx())
    expect(d).toMatchObject({ kind: 'skip', gate: 'lane_not_enabled' })
  })

  it('a null edge is no reading, never zero', () => {
    const d = evaluate(signal({ edgePp: null }), liveBot(), account(), ctx())
    expect(d).toMatchObject({ kind: 'skip', gate: 'no_reading' })
  })

  it('labels the API never ranks cannot be enabled into a trade', () => {
    const d = evaluate(signal({ label: 'ILLIQUID' }), liveBot(), account(), ctx())
    expect(d).toMatchObject({ kind: 'skip', gate: 'label_never_traded' })
  })

  it('the kill switch stops live bots and leaves paper running', () => {
    const halted = account((a) => { a.killSwitch = true })
    expect(evaluate(signal(), liveBot(), halted, ctx())).toMatchObject({ kind: 'skip', gate: 'kill_switch' })
    expect(evaluate(signal(), bot(), halted, ctx()).kind).toBe('trade')
  })

  it('locks out the final 90 seconds and overtime, and refuses an unknown clock', () => {
    const late = signal({ phase: 'live', clock: { period: 4, secondsRemaining: 60, overtime: false } })
    expect(evaluate(late, liveBot(), account(), ctx())).toMatchObject({ gate: 'final_seconds' })
    const ot = signal({ phase: 'live', clock: { period: 5, secondsRemaining: 500, overtime: true } })
    expect(evaluate(ot, liveBot(), account(), ctx())).toMatchObject({ gate: 'overtime' })
    expect(evaluate(signal({ phase: 'live', clock: null }), liveBot(), account(), ctx())).toMatchObject({ gate: 'clock_unknown' })
  })

  it('a stale price is refused', () => {
    const s = signal({ quotes: [{ venue: 'kalshi', contract: 'T', side: 'no', ask: 0.5, askSize: 10, priceAgeS: 400 }] })
    expect(evaluate(s, liveBot(), account(), ctx())).toMatchObject({ gate: 'no_venue' })
  })

  it('best price wins after fees, and an unfunded venue is skipped up front', () => {
    const s = signal({
      quotes: [
        { venue: 'kalshi', contract: 'K', side: 'no', ask: 0.5, askSize: 100, priceAgeS: 10 },
        { venue: 'polymarket', contract: 'P', side: 'no', ask: 0.46, askSize: 100, priceAgeS: 10 }
      ]
    })
    const funded = evaluate(s, liveBot(), account(), ctx())
    expect(funded).toMatchObject({ kind: 'trade', venue: 'polymarket' })

    const broke = ctx({ venues: { kalshi: { balanceUsd: 200, equityUsd: 200 }, polymarket: { balanceUsd: 0, equityUsd: 0 } } })
    expect(evaluate(s, liveBot(), account(), broke)).toMatchObject({ kind: 'trade', venue: 'kalshi' })
  })

  it('the size band rounds a tiny Kelly up to the floor so the trade can pay its fee', () => {
    // Kelly here is 0.06 x 0.25 on a $20 balance, about 30 cents, which cannot
    // pay its own fee. The band lifts it to the $1 floor.
    const small = ctx({ venues: { kalshi: { balanceUsd: 20, equityUsd: 20 } } })
    const d = evaluate(signal({ ourP: 0.56, edgePp: 6 }), liveBot(), account(), small)
    expect(d.kind).toBe('trade')
    if (d.kind === 'trade') {
      expect(d.costUsd).toBe(1)
      expect(d.audit.some((line) => line.startsWith('size band'))).toBe(true)
    }
  })

  it('a trade that is positive before the fee and negative after it is refused', () => {
    const d = evaluate(signal({ ourP: 0.53, edgePp: 5.5 }), liveBot((b) => { b.entry.minEvCents = 0 }), account(), ctx())
    expect(d).toMatchObject({ kind: 'skip', gate: 'no_venue' })
  })

  it('the per game cap stops compounding re entries', () => {
    const d = evaluate(signal(), liveBot(), account(), ctx({ gameExposureUsd: 69 }))
    expect(d).toMatchObject({ kind: 'skip', gate: 'game_cap' })
  })

  it('daily drawdown stops the bot, and the account cap stops every bot', () => {
    expect(evaluate(signal(), liveBot(), account(), ctx({ botDailyPnlUsd: -50 }))).toMatchObject({ gate: 'bot_drawdown' })
    expect(evaluate(signal(), liveBot(), account(), ctx({ accountDailyPnlUsd: -50 }))).toMatchObject({ gate: 'account_drawdown' })
  })

  it('one position per market', () => {
    const s = signal()
    expect(evaluate(s, liveBot(), account(), ctx({ openMarketKeys: new Set([s.key]) }))).toMatchObject({ gate: 'position_open' })
  })

  it('negative EV after the haircut is refused at any price', () => {
    const d = evaluate(signal({ ourP: 0.52, edgePp: 6 }), liveBot(), account(), ctx())
    expect(d).toMatchObject({ kind: 'skip', gate: 'no_venue' })
  })
})
