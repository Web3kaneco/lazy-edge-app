import { describe, expect, it } from 'vitest'
import { withHonest } from '../src/shared/honest'
import { defaultBot, DEFAULT_ACCOUNT } from '../src/shared/ruleset'
import { botRisk, flatRiskNote } from '../src/shared/risk'
import type { SettledLike } from '../src/shared/results'
import type { Signal } from '../src/shared/signal'
import { evaluate, type GateContext } from '../src/main/rules/gates'

// Made up: AAA trailing at BBB in the 4th, 25c, our 36%, teams in its spot came back 24%.
const longShot = (over: Partial<Signal> = {}): Signal => ({
  key: 'nba:g1:MONEYLINE:away', sport: 'NBA', lane: 'MONEYLINE', phase: 'live', gameId: 'g1', title: 'AAA @ BBB AAA to win',
  signalType: 'BUY_AWAY', explicitSide: 'yes', ourP: 0.36, marketP: 0.25, edgePp: 11, label: 'PRICE_GAP', kelly: null, trigger: false, measured: false,
  clock: { period: 4, secondsRemaining: 500, overtime: false },
  quotes: [{ venue: 'kalshi', contract: 'KXNBAGAME-99JAN01AAABBB-AAA', side: 'yes', ask: 0.25, askSize: 500, priceAgeS: 2 }],
  why: null, receivedAt: 0, team: { lead: -8, winP: 0.25 },
  comeback: { winP: 0.24, trailingHome: false, deficit: 8, bucket: 'Q4_MID' },
  ...over
})
const ctx: GateContext = { now: 0, venues: { paper: { balanceUsd: 1000, equityUsd: 1000 } }, keyed: ['kalshi'], openMarketKeys: new Set(), gamePositions: [], gameExposureUsd: 0, accountOpenExposureUsd: 0, botDailyPnlUsd: 0, accountDailyPnlUsd: 0, botTradesToday: 0 }
const kellyBot = () => { const b = defaultBot('k', 'Kelly'); b.enabled = true; b.market.lanes = ['MONEYLINE']; b.entry.minEdgePp = 3; b.size.maxTradeUsd = 100; return b }

describe('sizing on the honest chance', () => {
  it('Kelly stakes a long shot less once its chance is honest', () => {
    const raw = evaluate(longShot({ comeback: undefined }), kellyBot(), DEFAULT_ACCOUNT, ctx)
    const honest = evaluate(withHonest(longShot(), new Map()), kellyBot(), DEFAULT_ACCOUNT, ctx)
    expect(raw.kind).toBe('trade')
    expect(honest.kind).toBe('trade')
    if (raw.kind !== 'trade' || honest.kind !== 'trade') return
    expect(honest.costUsd).toBeLessThan(raw.costUsd)
    expect(honest.audit.join(' ')).toMatch(/size kelly .* on the honest chance/)
    expect(honest.audit.join(' ')).toMatch(/honest chance 30\.0%, ours 36\.0%/)
  })

  it('a feed\'s own Kelly is ignored once the honest check moved its chance', () => {
    const fed = evaluate(withHonest(longShot({ kelly: 0.5 }), new Map()), kellyBot(), DEFAULT_ACCOUNT, ctx)
    const own = evaluate(withHonest(longShot(), new Map()), kellyBot(), DEFAULT_ACCOUNT, ctx)
    if (fed.kind !== 'trade' || own.kind !== 'trade') throw new Error('expected trades')
    expect(fed.costUsd).toBe(own.costUsd)
  })
})

const t = (priceC: number, won: boolean, i: number): SettledLike => ({
  botId: 'f', botName: 'f', side: 'yes', venue: 'paper', filledContracts: 20, avgFillC: priceC, limitPriceC: priceC, costUsd: priceC / 5, feeUsd: 0.1,
  pnlUsd: won ? (100 - priceC) / 5 : -priceC / 5, createdAt: i,
  play: { sport: 'NBA', lane: 'MONEYLINE', phase: 'live', label: 'PRICE_GAP', hot: false, measured: false, edgePp: 8, ourP: 0.3 }
})

describe('a flat bot that buys long shots is told so', () => {
  const flat = () => { const b = defaultBot('f', 'Flat'); b.size.sizing = 'flat'; b.size.maxTradeUsd = 5; return b }

  it('from its record, when most of its trades were long shots', () => {
    const record = Array.from({ length: 12 }, (_, i) => t(22, i < 2, i))
    expect(flatRiskNote(flat(), botRisk(record))).toMatch(/100% of this bot's trades were long shots under 35c, each staking the full \$5: 2 of 12 won/)
  })

  it('from its settings, when the edge can buy long shots', () => {
    expect(flatRiskNote(flat(), null)).toMatch(/can buy long shots under 35c at a flat \$5 each/)
  })

  it('says nothing to a Kelly bot, a pick bot or a bot priced above long shots', () => {
    expect(flatRiskNote(kellyBot(), null)).toBeNull()
    const pick = flat(); pick.entry.basis = 'pick'
    expect(flatRiskNote(pick, null)).toBeNull()
    const dear = flat(); dear.entry.priceBandC = [40, 92]
    expect(flatRiskNote(dear, null)).toBeNull()
  })
})
