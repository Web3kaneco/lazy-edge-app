import { afterAll, describe, expect, it } from 'vitest'
import { tradingDay } from '../src/shared/day'

const zone = process.env.TZ
afterAll(() => { process.env.TZ = zone })

describe('trading day', () => {
  it('keeps an East Coast night together through a late West Coast game', () => {
    process.env.TZ = 'America/New_York'
    const early = new Date(2026, 10, 10, 19, 0).getTime() // 7 PM tip
    const late = new Date(2026, 10, 11, 1, 30).getTime() // a Lakers game ending 1:30 AM
    expect(tradingDay(early)).toBe('2026-11-10')
    expect(tradingDay(late)).toBe('2026-11-10')
    // Midnight UTC used to split the same night at 7 PM.
    expect(new Date(early).toISOString().slice(0, 10)).not.toBe(new Date(early - 3_600_000).toISOString().slice(0, 10))
  })

  it('starts the next day at 4 AM local time', () => {
    process.env.TZ = 'America/New_York'
    expect(tradingDay(new Date(2026, 10, 11, 3, 59).getTime())).toBe('2026-11-10')
    expect(tradingDay(new Date(2026, 10, 11, 4, 0).getTime())).toBe('2026-11-11')
  })

  it('moves with the clock across a daylight saving change', () => {
    process.env.TZ = 'America/New_York'
    // Clocks fell back at 2 AM on 2026-11-01.
    expect(tradingDay(new Date(2026, 10, 1, 3, 59).getTime())).toBe('2026-10-31')
    expect(tradingDay(new Date(2026, 10, 1, 4, 0).getTime())).toBe('2026-11-01')
  })

  it('works the same on the West Coast', () => {
    process.env.TZ = 'America/Los_Angeles'
    expect(tradingDay(new Date(2026, 10, 10, 23, 0).getTime())).toBe('2026-11-10')
    expect(tradingDay(new Date(2026, 10, 11, 2, 0).getTime())).toBe('2026-11-10')
  })
})
