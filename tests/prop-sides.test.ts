import { describe, expect, it } from 'vitest'
import { evaluate, propSideOf, type GateContext } from '../src/main/rules/gates'
import { DEFAULT_ACCOUNT, defaultBot } from '../src/shared/ruleset'
import { BotSettings } from '../src/shared/schema'
import { botSentence } from '../src/shared/sentence'
import { segment, type SettledLike } from '../src/shared/results'
import type { Signal } from '../src/shared/signal'

const ctx = (): GateContext => ({ now: 0, venues: { paper: { balanceUsd: 1000, equityUsd: 1000 }, kalshi: { balanceUsd: 200, equityUsd: 200 } }, keyed: ['kalshi'], openMarketKeys: new Set(), gamePositions: [], gameExposureUsd: 0, accountOpenExposureUsd: 0, botDailyPnlUsd: 0, accountDailyPnlUsd: 0, botTradesToday: 0 })

// Made up: a prop on stat at line 5.5, over or under, our number at ourP, Kalshi asking askC.
const prop = (stat: 'PTS' | 'REB' | 'AST', over: boolean, ourP: number, askC: number): Signal => {
  const contract = `KXNBA${stat}-99JAN01AAABBB-AAAPLAYER1-6`
  return {
    key: `nba:g1:PROP:${contract}`, sport: 'NBA', lane: 'PROP', phase: 'live', gameId: 'g1', title: `AAA @ BBB Player One ${over ? 'over' : 'under'} 5.5`,
    signalType: over ? 'BUY_OVER' : 'BUY_UNDER', explicitSide: over ? 'yes' : 'no', ourP, marketP: askC / 100, edgePp: ourP * 100 - askC, label: 'PRICE_GAP', kelly: null, trigger: false, measured: false,
    clock: { period: 3, secondsRemaining: 1500, overtime: false }, quotes: [{ venue: 'kalshi', contract, side: over ? 'yes' : 'no', ask: askC / 100, askSize: 100, priceAgeS: 2 }],
    prop: { line: 5.5, soFar: 2, over, teamLead: null, rank: 3 },
    why: null, receivedAt: 0
  }
}
const bot = () => {
  const b = defaultBot('b', 'Props'); b.enabled = true; b.market.sports = ['NBA']; b.market.lanes = ['PROP']
  b.entry.priceBandC = [40, 92]; b.entry.minEdgePp = 3; b.entry.maxEdgePp = 15
  return b
}

describe('prop sides switched off and the unders edge range (2026-11-24)', () => {
  it('reads the stat and side from the ticker', () => {
    expect(propSideOf(prop('REB', false, 0.8, 70))).toBe('REB under')
    expect(propSideOf(prop('PTS', true, 0.8, 70))).toBe('PTS over')
  })

  it('stops rebound unders and nothing else', () => {
    const b = bot(); b.market.propSidesOff = ['REB under']
    expect(evaluate(prop('REB', false, 0.76, 70), b, DEFAULT_ACCOUNT, ctx())).toMatchObject({ kind: 'skip', gate: 'prop_side_off' })
    expect(evaluate(prop('REB', true, 0.76, 70), b, DEFAULT_ACCOUNT, ctx()).kind).toBe('trade')
    expect(evaluate(prop('PTS', false, 0.76, 70), b, DEFAULT_ACCOUNT, ctx()).kind).toBe('trade')
  })

  it('holds unders to 5 to 7 points at the price paid, and leaves overs alone', () => {
    const b = bot(); b.entry.underEdgePp = [5, 7]
    expect(evaluate(prop('PTS', false, 0.74, 70), b, DEFAULT_ACCOUNT, ctx())).toMatchObject({ kind: 'skip', gate: 'under_edge' })
    expect(evaluate(prop('PTS', false, 0.76, 70), b, DEFAULT_ACCOUNT, ctx()).kind).toBe('trade')
    expect(evaluate(prop('PTS', false, 0.80, 70), b, DEFAULT_ACCOUNT, ctx())).toMatchObject({ kind: 'skip', gate: 'under_edge' })
    expect(evaluate(prop('PTS', true, 0.80, 70), b, DEFAULT_ACCOUNT, ctx()).kind).toBe('trade')
  })

  it('an old bot file loads with every side on and no unders range', () => {
    const b = defaultBot('old', 'Old') as Record<string, any>
    delete b.market.propSidesOff; delete b.entry.underEdgePp
    const parsed = BotSettings.parse(b)
    expect(parsed.market.propSidesOff).toEqual([])
    expect(parsed.entry.underEdgePp).toBeNull()
  })

  it('the bot sentence says both', () => {
    const b = bot(); b.market.propSidesOff = ['REB under']; b.entry.underEdgePp = [5, 7]
    expect(botSentence(b)).toContain('never rebound unders')
    expect(botSentence(b)).toContain('unders only at an edge of 5 to 7 points')
  })
})

describe('breakeven counts each trade once, fee included', () => {
  const t = (n: number, priceC: number, won: boolean, feeUsd: number): SettledLike => ({
    botId: 'b', botName: 'B', gameId: `g${priceC}${won}`, side: 'yes', venue: 'kalshi', filledContracts: n, avgFillC: priceC, limitPriceC: priceC,
    costUsd: (n * priceC) / 100, feeUsd, pnlUsd: (won ? n : 0) - (n * priceC) / 100 - feeUsd, createdAt: 0
  })
  it('flat sizing does not pull breakeven under the win rate', () => {
    // $5 at 50c buys 10, $5 at 90c buys 5: by contracts the price is 63c, by trade 70c.
    const s = segment('all', [t(10, 50, true, 0.18), t(5, 90, true, 0.04), t(5, 90, false, 0.04)])
    expect(s.avgPrice).toBeCloseTo(0.7667, 3)
    expect(s.breakeven).toBeCloseTo(0.7667 + (0.018 + 0.008 + 0.008) / 3, 3)
    expect(s.z).toBeLessThan(0) // 2 of 3 won, under the 78% these prices need
  })
})

describe('in game unders only early in a quarter (2026-11-24, built to test)', () => {
  // Q3 with secsInQ seconds left in the quarter: NBA game clock counts the whole game.
  const at = (s: Signal, secsInQ: number): Signal => ({ ...s, clock: { period: 3, secondsRemaining: 720 + secsInQ, overtime: false } })
  const b = () => { const x = bot(); x.entry.underFirstMin = 3; return x }

  it('is off by default, so every bot loads unchanged', () => {
    expect(defaultBot('x', 'X').entry.underFirstMin).toBeNull()
    const old = defaultBot('old', 'Old') as Record<string, any>
    delete old.entry.underFirstMin
    expect(BotSettings.parse(old).entry.underFirstMin).toBeNull()
  })

  it('takes an under 2 minutes in, refuses one 5 minutes in, and leaves overs alone', () => {
    expect(evaluate(at(prop('PTS', false, 0.76, 70), 600), b(), DEFAULT_ACCOUNT, ctx()).kind).toBe('trade')
    expect(evaluate(at(prop('PTS', false, 0.76, 70), 420), b(), DEFAULT_ACCOUNT, ctx())).toMatchObject({ kind: 'skip', gate: 'under_late' })
    expect(evaluate(at(prop('PTS', true, 0.76, 70), 420), b(), DEFAULT_ACCOUNT, ctx()).kind).toBe('trade')
  })

  it('refuses an under when the clock cannot say how far in', () => {
    const s = { ...prop('PTS', false, 0.76, 70), clock: { period: 3, secondsRemaining: null, overtime: false } }
    expect(evaluate(s, b(), DEFAULT_ACCOUNT, ctx())).toMatchObject({ kind: 'skip', gate: 'under_late' })
  })

  it('the bot sentence says it', () => {
    expect(botSentence(b())).toContain('in game unders only in the first 3 minutes of a quarter')
  })
})
