// The day profit lock: cash everything out once the day is up enough, so a
// good day is not given back by the close. Pure, so the engine and the tests
// read the same rule.
//
// The day is measured as account value now against account value at the
// first reading of the trading day (4 AM to 4 AM), with open positions marked
// at what they could be sold for. A deposit or withdrawal during the day moves
// that number too, so the lock says so on screen.
import type { AccountSettings } from './schema'

export type ProfitLock = AccountSettings['profitLock']

export interface LockDay {
  day: string
  watch: ProfitLock['watch']
  // Account value at the day's first reading.
  startUsd: number
  // The best the day has been, in percent.
  highPct: number
  // When the lock fired today, if it did.
  firedAt: number | null
}

export interface LockState extends LockDay {
  enabled: boolean
  nowPct: number | null
  armed: boolean
}

// The day's record, carried forward or started fresh on a new day, a new
// thing to watch, or a first reading.
export function rollDay(prev: LockDay | null, day: string, watch: ProfitLock['watch'], valueUsd: number): LockDay {
  if (prev && prev.day === day && prev.watch === watch && prev.startUsd > 0) return prev
  return { day, watch, startUsd: valueUsd, highPct: 0, firedAt: null }
}

export const dayPct = (d: LockDay, valueUsd: number): number | null => d.startUsd > 0 ? ((valueUsd - d.startUsd) / d.startUsd) * 100 : null

// Whether to cash out now, and the day's record after this reading.
export function checkLock(lock: ProfitLock, d: LockDay, valueUsd: number): { day: LockDay; fire: string | null } {
  const now = dayPct(d, valueUsd)
  if (now === null) return { day: d, fire: null }
  const day = { ...d, highPct: Math.max(d.highPct, now) }
  if (!lock.enabled || d.firedAt !== null || day.highPct < lock.upPct) return { day, fire: null }
  if (lock.trailPct <= 0) return { day, fire: `the day is up ${now.toFixed(1)}%, past the ${lock.upPct}% lock` }
  if (now <= day.highPct - lock.trailPct) {
    return { day, fire: `the day reached ${day.highPct.toFixed(1)}% and fell to ${now.toFixed(1)}%, a ${lock.trailPct} point give back` }
  }
  return { day, fire: null }
}
