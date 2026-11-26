import { describe, expect, it } from 'vitest'
import { defaultBot } from '../src/shared/ruleset'
import { botProblems, notSaved } from '../src/shared/validate'

describe('why a bot will not save, in plain words', () => {
  it('no label ticked names the setting, the fix and why, never the validation code', () => {
    const b = defaultBot('a', 'A'); b.market.labels = []
    const p = botProblems(b)
    expect(p).toEqual(['Labels: tick at least one. A bot only takes plays with a ticked label, so with none it would never trade.'])
    const msg = notSaved(p)
    expect(msg).toMatch(/^Not saved\. One setting needs fixing first; the bot keeps running on its last saved settings\.\n• Labels: tick at least one/)
    expect(msg).not.toMatch(/too_small|origin|"path"/)
  })

  it('numbers out of range and a band upside down are said by their screen names', () => {
    const b = defaultBot('a', 'A'); b.guards.autoCancelS = 1
    expect(botProblems(b)).toEqual(['Cancel an unfilled order after (seconds): must be 5 or more.'])
    const c = defaultBot('a', 'A'); c.entry.priceBandC = [80, 40]
    expect(botProblems(c)).toEqual(['Price band: the low price, 80c, is above the high price, 40c.'])
  })

  it('a good bot has nothing to fix', () => {
    expect(botProblems(defaultBot('a', 'A'))).toEqual([])
  })
})
