import { describe, expect, it } from 'vitest'
import { addExitFill, bidFromOtherAsk, countFp, exitFee, exitTargetC, newExit, nothingHeld, paperExitFill, positionPnl, withOrderTotals } from '../src/shared/exits'
import { opposes } from '../src/main/rules/stance'

describe('exits, 2026-11-16', () => {
  it('sells at entry plus the target, never above 99c', () => {
    expect(exitTargetC(55, 10)).toBe(65)
    expect(exitTargetC(94, 10)).toBe(99)
    expect(newExit('limit', 55, 10)).toMatchObject({ mode: 'limit', targetC: 65, status: 'waiting', filledContracts: 0 })
  })

  it('reads our bid from the other side\'s ask', () => {
    expect(bidFromOtherAsk(0.33, 40)).toEqual({ bidC: 67, size: 40 })
    expect(bidFromOtherAsk(null, 40)).toBeNull()
    expect(bidFromOtherAsk(0.3, 0)).toBeNull()
  })

  it('fills a paper limit sell at its own price only once the bid reaches it, as a maker', () => {
    const exit = newExit('limit', 55, 10)
    expect(paperExitFill(exit, 10, { bidC: 64, size: 50 })).toBeNull()
    expect(paperExitFill(exit, 10, { bidC: 67, size: 50 })).toEqual({ contracts: 10, priceC: 65, feeUsd: exitFee(65, 10, false) })
    expect(exitFee(65, 10, false)).toBeLessThan(exitFee(65, 10, true))
  })

  it('cashes out at the bid at the mark, no more than the bid offers', () => {
    const exit = newExit('mark', 55, 10)
    expect(paperExitFill(exit, 10, { bidC: 67, size: 4 })).toEqual({ contracts: 4, priceC: 67, feeUsd: exitFee(67, 4, true) })
  })

  it('counts profit after both fees, and settles only what did not sell', () => {
    const base = { filledContracts: 10, avgFillC: 55, feeUsd: 0.18, side: 'yes' as const }
    const sold = addExitFill(newExit('limit', 55, 10), { contracts: 10, priceC: 65, feeUsd: 0.04 })
    expect(positionPnl({ ...base, exit: sold }, null)).toBeCloseTo(10 * 0.1 - 0.18 - 0.04, 2)
    const half = addExitFill(newExit('mark', 55, 10), { contracts: 4, priceC: 67, feeUsd: 0.07 })
    expect(positionPnl({ ...base, exit: half }, null)).toBeNull()
    expect(positionPnl({ ...base, exit: half }, 'no')).toBeCloseTo(4 * 0.12 - 6 * 0.55 - 0.18 - 0.07, 2)
    expect(positionPnl({ ...base, exit: null }, 'yes')).toBeCloseTo(10 * 0.45 - 0.18, 2)
  })

  // 23 November 2026: Kalshi filled 0.5 of a contract and the ticket settled
  // with no result, so it was missing from P&L and the loss stops.
  it('grades a fill under one contract', () => {
    const half = { filledContracts: 0.5, avgFillC: 55, feeUsd: 0, side: 'no' as const, exit: null }
    expect(positionPnl(half, 'yes')).toBeCloseTo(-0.28, 2)
    expect(positionPnl({ ...half, filledContracts: 0.1, avgFillC: 86, feeUsd: 0.0009 }, 'no')).toBeCloseTo(0.01, 2)
    expect(positionPnl({ ...half, filledContracts: 0 }, 'no')).toBeNull()
    expect(nothingHeld(0.5)).toBe(false)
    expect(nothingHeld(0.3 - 0.1 - 0.2)).toBe(true)
    expect(countFp(9)).toBe('9.00')
    expect(countFp(0.5)).toBe('0.50')
    expect(countFp(0.12)).toBe('0.12')
  })

  it('keeps what sold before a resting order replaced the last one', () => {
    const exit = { ...addExitFill(newExit('limit', 55, 10), { contracts: 3, priceC: 65, feeUsd: 0.02 }), prior: { contracts: 3, avgC: 65, feeUsd: 0.02 } }
    expect(withOrderTotals(exit, { contracts: 5, avgC: 65, feeUsd: 0.03 })).toMatchObject({ filledContracts: 8, avgC: 65, feeUsd: 0.05 })
  })

  it('never lets a bot hold both sides of the same contract, props included', () => {
    expect(opposes({ contract: 'KXNBAPTS-99JAN01AAABBB-AAAPLAYER1-25', side: 'yes' }, { contract: 'KXNBAPTS-99JAN01AAABBB-AAAPLAYER1-25', side: 'no' })).toBe(true)
    expect(opposes({ contract: 'KXNBAPTS-99JAN01AAABBB-AAAPLAYER1-25', side: 'yes' }, { contract: 'KXNBAPTS-99JAN01AAABBB-AAAPLAYER1-30', side: 'no' })).toBe(false)
  })
})
