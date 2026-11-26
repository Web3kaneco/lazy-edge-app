import { describe, expect, it } from 'vitest'
import { comboRfqContracts } from '../src/shared/combos'

// 23 November 2026: a combo request by dollar amount had every quote sized 0,
// so HOU + SA at 71.9c against our 74.7% was skipped. The request now names a
// count that fits the budget at the highest price the bot would take.
describe('contracts asked for on a combo', () => {
  it("tonight's skipped ticket: $10 at our 74.7% asks for 13", () => {
    const n = comboRfqContracts(10, 0.747, 0, 100)
    expect(n).toBe(13)
    // At the quote that came back, 13 cost $9.35, inside the budget.
    expect((n * 71.9) / 100).toBeLessThanOrEqual(10)
  })

  it('any price we would take fits the budget', () => {
    for (const chance of [0.2, 0.35, 0.51, 0.638, 0.9, 0.995]) {
      for (const edge of [0, 3, 5]) {
        const n = comboRfqContracts(5, chance, edge, 100)
        const ceilingC = Math.min(99, Math.max(1, chance * 100 - edge))
        expect((n * ceilingC) / 100).toBeLessThanOrEqual(5 + 1e-9)
      }
    }
  })

  it('keeps to the most contracts and never goes below zero', () => {
    expect(comboRfqContracts(100, 0.3, 0, 100)).toBe(100)
    expect(comboRfqContracts(0.5, 0.9, 0, 100)).toBe(0)
  })
})
