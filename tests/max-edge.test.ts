import { describe, expect, it } from 'vitest'
import { evaluate, type GateContext } from '../src/main/rules/gates'
import { fieldName, fieldValue } from '../src/shared/fields'
import { DEFAULT_ACCOUNT, defaultBot } from '../src/shared/ruleset'
import { BotSettings } from '../src/shared/schema'
import { botSentence } from '../src/shared/sentence'
import type { Signal } from '../src/shared/signal'

const ctx = (): GateContext => ({ now: 0, venues: { paper: { balanceUsd: 1000, equityUsd: 1000 }, kalshi: { balanceUsd: 200, equityUsd: 200 } }, keyed: ['kalshi'], openMarketKeys: new Set(), gamePositions: [], gameExposureUsd: 0, accountOpenExposureUsd: 0, botDailyPnlUsd: 0, accountDailyPnlUsd: 0, botTradesToday: 0 })

// Made up: a prop our number has at ourP, with Kalshi asking askC.
const prop = (ourP: number, askC: number): Signal => ({
  key: 'nba:g1:PROP:KXNBAAST-99JAN01AAABBB-M4', sport: 'NBA', lane: 'PROP', phase: 'live', gameId: 'g1', title: 'AAA @ BBB Player One over 3.5 assists',
  signalType: 'BUY_OVER', explicitSide: 'yes', ourP, marketP: askC / 100, edgePp: ourP * 100 - askC, label: 'PRICE_GAP', kelly: null, trigger: false, measured: false,
  clock: { period: 3, secondsRemaining: 1500, overtime: false }, quotes: [{ venue: 'kalshi', contract: 'KXNBAAST-99JAN01AAABBB-M4', side: 'yes', ask: askC / 100, askSize: 100, priceAgeS: 2 }],
  why: null, receivedAt: 0
})
const bot = (max: number | null, basis: 'edge' | 'pick' = 'edge') => {
  const b = defaultBot('b', 'Props'); b.enabled = true; b.market.sports = ['NBA']; b.market.lanes = ['PROP']
  b.entry.priceBandC = [25, 92]; b.entry.minEdgePp = 5; b.entry.maxEdgePp = max; b.entry.basis = basis
  return b
}

describe('the maximum edge, the other end of the band', () => {
  it('off by default: a 43 point edge is taken, as last night', () => {
    expect(defaultBot('x', 'X').entry.maxEdgePp).toBeNull()
    expect(evaluate(prop(0.99, 56), bot(null), DEFAULT_ACCOUNT, ctx())).toMatchObject({ kind: 'trade' })
  })

  it('at 15, skips the 99% against a 56c price and says why', () => {
    expect(evaluate(prop(0.99, 56), bot(15), DEFAULT_ACCOUNT, ctx())).toMatchObject({ kind: 'skip', gate: 'max_edge' })
  })

  it('at 15, still takes 12 points, the band that made money live', () => {
    expect(evaluate(prop(0.68, 56), bot(15), DEFAULT_ACCOUNT, ctx()).kind).toBe('trade')
  })

  it('reads the gap at the price paid, for a bot buying our pick too', () => {
    expect(evaluate(prop(0.9, 60), bot(15, 'pick'), DEFAULT_ACCOUNT, ctx())).toMatchObject({ kind: 'skip', gate: 'max_edge' })
  })

  it('an old bot file with no maximum loads with no limit', () => {
    const b = defaultBot('old', 'Old') as Record<string, any>
    delete b.entry.maxEdgePp
    expect(BotSettings.parse(b).entry.maxEdgePp).toBeNull()
  })

  it('the bot sentence and the change log say it plainly', () => {
    expect(botSentence(bot(15))).toContain('by 5 to 15 points')
    expect(fieldName('entry.maxEdgePp')).toBe('Maximum edge (points)')
    expect(fieldValue('entry.maxEdgePp', null)).toBe('no limit')
  })
})
