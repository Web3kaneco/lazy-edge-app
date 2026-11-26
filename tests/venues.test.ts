import { describe, expect, it } from 'vitest'
import { DEFAULT_ACCOUNT, defaultBot } from '../src/shared/ruleset'
import { AccountSettings } from '../src/shared/schema'
import { botVenues, liveProblem } from '../src/shared/venues'

// 2026-11-20: a bot set to Live with paper still in its venues showed a
// red LIVE badge and sent nothing all night. One switch, venues follow keys.
const bot = (venues: ('paper' | 'kalshi' | 'polymarket')[] = []) => {
  const b = defaultBot('b', 'Test bot')
  b.enabled = true
  b.mode = 'live'
  b.market.venues = venues
  return b
}
const funded = { kalshi: { configured: true, balanceUsd: 120 }, polymarket: { configured: false, balanceUsd: null } }

describe('venues follow the saved keys', () => {
  it('a bot naming paper, or nothing, uses every venue with a key', () => {
    expect(botVenues(bot(['paper']), ['kalshi'])).toEqual(['kalshi'])
    expect(botVenues(bot([]), ['kalshi', 'polymarket'])).toEqual(['kalshi', 'polymarket'])
  })

  it('a venue without a key is never used, even when the bot names it', () => {
    expect(botVenues(bot(['polymarket']), ['kalshi'])).toEqual(['kalshi'])
    expect(botVenues(bot(['polymarket']), ['kalshi', 'polymarket'])).toEqual(['polymarket'])
    expect(botVenues(bot(['kalshi']), [])).toEqual([])
  })
})

describe('a live bot that cannot trade says why', () => {
  it('has nothing to say when it can trade, or is paper, or is off', () => {
    expect(liveProblem(bot(['paper']), DEFAULT_ACCOUNT, funded)).toBeNull()
    expect(liveProblem({ ...bot(), mode: 'paper' }, DEFAULT_ACCOUNT, {})).toBeNull()
    expect(liveProblem({ ...bot(), enabled: false }, DEFAULT_ACCOUNT, {})).toBeNull()
  })

  it('names the kill switch, a missing key, an unread balance and an empty one', () => {
    expect(liveProblem(bot(), { killSwitch: true }, funded)).toMatch(/kill switch/)
    expect(liveProblem(bot(), DEFAULT_ACCOUNT, { kalshi: { configured: false, balanceUsd: null } })).toMatch(/Keys screen/)
    expect(liveProblem(bot(), DEFAULT_ACCOUNT, { kalshi: { configured: true, balanceUsd: null } })).toMatch(/Kalshi balance has not been read/)
    expect(liveProblem(bot(), DEFAULT_ACCOUNT, { kalshi: { configured: true, balanceUsd: 0.4 } })).toMatch(/under the \$1 smallest trade/)
  })
})

describe('the old account wide dry run', () => {
  it('an older account file still loads, without the fields that are gone', () => {
    const old = { ...structuredClone(DEFAULT_ACCOUNT), executionMode: 'dry_run', venues: { paper: { enabled: true, startingBalanceUsd: 1000 }, kalshi: { enabled: true, environment: 'production' }, polymarket: { enabled: false, accountType: 'email' } } }
    const parsed = AccountSettings.safeParse(old)
    expect(parsed.success).toBe(true)
    expect(parsed.success && 'executionMode' in parsed.data).toBe(false)
    expect(parsed.success && parsed.data.venues.kalshi).toEqual({ environment: 'production' })
  })
})
