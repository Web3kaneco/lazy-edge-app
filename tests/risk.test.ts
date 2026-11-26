import { describe, expect, it } from 'vitest'
import { botRisk, botRiskLines, expectedRun, feeOf, playRisk, playRiskShort, shapeOf } from '../src/shared/risk'
import type { SettledLike } from '../src/shared/results'

describe('risk and reward of one play', () => {
  it('a 20c long shot at an honest 24%: wins 1 in 4, pays big, loses often', () => {
    const r = playRisk(0.24, 20)
    expect(r.shape).toBe('long shot')
    expect(r.breakeven).toBeCloseTo(0.2 + feeOf(0.2))
    expect(r.winC).toBeCloseTo(78.9, 1)
    expect(r.lossC).toBeCloseTo(21.1, 1)
    expect(r.evC).toBeCloseTo(2.9, 1)
    expect(r.oneIn).toBe(4)
    // log(20 x 0.24) / log(1 / 0.76), about 5.7.
    expect(r.runIn20).toBe(6)
    expect(playRiskShort(r)).toBe('Long shot · needs 21% · wins 1 in 4 · win +78.9c / loss −21.1c · +2.9c a contract')
  })

  it('an 80c favorite at an honest 84%: wins most, one loss wipes several wins', () => {
    const r = playRisk(0.84, 80)
    expect(r.shape).toBe('favorite')
    expect(r.winC).toBeCloseTo(18.9, 1)
    expect(r.lossC).toBeCloseTo(81.1, 1)
    expect(r.evC).toBeCloseTo(2.9, 1)
    expect(r.runIn20).toBeLessThanOrEqual(2)
  })

  it('the same long shot at a hopeful number loses money once the chance is honest', () => {
    expect(playRisk(0.18, 20).evC).toBeLessThan(0)
  })

  it('names the shape by price and expects losing runs from the chance', () => {
    expect([shapeOf(34), shapeOf(35), shapeOf(65), shapeOf(66)]).toEqual(['long shot', 'coin flip', 'coin flip', 'favorite'])
    expect(expectedRun(20, 0)).toBe(0)
    expect(expectedRun(20, 0.5)).toBe(3)
  })
})

const t = (priceC: number, chance: number, won: boolean, i: number): SettledLike => ({
  botId: 'b', botName: 'b', side: 'yes', venue: 'paper', filledContracts: 10, avgFillC: priceC, limitPriceC: priceC,
  costUsd: priceC / 10, feeUsd: 0.1, pnlUsd: won ? (100 - priceC) / 10 : -priceC / 10, createdAt: i,
  play: { sport: 'NBA', lane: 'MONEYLINE', phase: 'live', label: 'PRICE_GAP', hot: false, measured: false, edgePp: 6, ourP: chance }
})

describe('risk and reward of a bot', () => {
  // Made up: an edge chaser. 20 long shots at 25c we called 31%, 3 won; 10
  // favorites at 75c we called 80%, 8 won.
  const record = [
    ...Array.from({ length: 20 }, (_, i) => t(25, 0.31, i % 7 === 0, i)),
    ...Array.from({ length: 10 }, (_, i) => t(75, 0.8, i < 8, 100 + i))
  ]

  it('sets what our chances said against what happened, and splits long shots from favorites', () => {
    const r = botRisk(record)!
    expect(r).toMatchObject({ trades: 30, won: 11, lost: 19 })
    expect(r.expectedWins).toBeCloseTo(14.2)
    expect(r.byShape['long shot']).toMatchObject({ trades: 20, won: 3 })
    expect(r.byShape['long shot'].pnlUsd).toBeLessThan(0)
    expect(r.byShape.favorite).toMatchObject({ trades: 10, won: 8 })
    expect(r.longShotShare).toBeCloseTo(2 / 3)
    expect(r.expectedC).toBeGreaterThan(0)
    expect(r.actualC).toBeLessThan(0)
    expect(r.longestLosing).toBeGreaterThanOrEqual(6)
    const lines = botRiskLines(r).join(' ')
    expect(lines).toMatch(/Our chances said about 14.2 wins; it won 3 fewer/)
    expect(lines).toMatch(/67% of its trades were long shots under 35c: 3 of 20 won/)
  })

  it('says nothing without a settled trade', () => {
    expect(botRisk([{ ...record[0]!, pnlUsd: null }])).toBeNull()
  })
})
