import { describe, expect, it } from 'vitest'
import { checkLock, dayPct, rollDay, type ProfitLock } from '../src/shared/profitlock'
import { DEFAULT_ACCOUNT } from '../src/shared/ruleset'
import { AccountSettings } from '../src/shared/schema'

const lock = (over: Partial<ProfitLock> = {}): ProfitLock => ({ enabled: true, watch: 'paper', upPct: 20, trailPct: 5, ...over })
const start = rollDay(null, '2099-01-01', 'paper', 1000)

describe('day profit lock, 2026-11-16', () => {
  it('measures the day against its first reading, and starts fresh on a new day or a new watch', () => {
    expect(dayPct(start, 1280)).toBeCloseTo(28)
    expect(rollDay({ ...start, highPct: 12 }, '2099-01-01', 'paper', 1500)).toMatchObject({ startUsd: 1000, highPct: 12 })
    expect(rollDay({ ...start, highPct: 12 }, '2099-01-02', 'paper', 1500)).toMatchObject({ startUsd: 1500, highPct: 0, firedAt: null })
    expect(rollDay(start, '2099-01-01', 'live', 400)).toMatchObject({ startUsd: 400, watch: 'live' })
  })

  it('cashes out at once at the target when there is no give back', () => {
    expect(checkLock(lock({ trailPct: 0 }), start, 1190).fire).toBeNull()
    expect(checkLock(lock({ trailPct: 0 }), start, 1210).fire).toMatch(/up 21.0%/)
  })

  it('rides the high and cashes out on the give back: up 28%, out at 23%', () => {
    let d = start
    for (const v of [1100, 1220, 1280, 1250]) {
      const r = checkLock(lock(), d, v)
      expect(r.fire).toBeNull()
      d = r.day
    }
    expect(d.highPct).toBeCloseTo(28)
    expect(checkLock(lock(), d, 1230).fire).toMatch(/reached 28.0% and fell to 23.0%/)
  })

  it('never fires below the target, when off, or twice in a day', () => {
    const fell = { ...start, highPct: 15 }
    expect(checkLock(lock(), fell, 1050).fire).toBeNull()
    expect(checkLock(lock({ enabled: false }), { ...start, highPct: 30 }, 1100).fire).toBeNull()
    expect(checkLock(lock(), { ...start, highPct: 30, firedAt: 1 }, 1100).fire).toBeNull()
  })

  it('is off for accounts saved before it existed', () => {
    const { profitLock: _p, ...old } = DEFAULT_ACCOUNT
    expect(AccountSettings.parse(old).profitLock).toEqual({ enabled: false, watch: 'live', upPct: 20, trailPct: 5 })
  })
})
