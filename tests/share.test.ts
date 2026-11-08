import { describe, expect, it } from 'vitest'
import { BotSettings } from '../src/shared/schema'
import { changesFromDefaults, readShareCode, shareCode } from '../src/shared/share'
import { STARTERS, starterOf } from '../src/shared/starters'

describe('starter bots', () => {
  it('are valid, off, in paper and distinct', () => {
    const bots = STARTERS.map((s) => s.build())
    for (const b of bots) {
      expect(BotSettings.safeParse(b).success, b.name).toBe(true)
      expect(b).toMatchObject({ enabled: false, mode: 'paper', decider: { kind: 'rules' } })
      expect(b.market.venues).toEqual(['paper'])
      expect(b.entry.priceBandC[0]).toBeLessThanOrEqual(b.entry.priceBandC[1])
      expect(starterOf(b.id)?.name).toBe(b.name)
    }
    expect(new Set(bots.map((b) => b.id)).size).toBe(bots.length)
    expect(new Set(bots.map((b) => JSON.stringify({ ...b, id: '', name: '' }))).size).toBe(bots.length)
  })

  it('show exactly what they move off the measured defaults', () => {
    expect(changesFromDefaults(STARTERS.find((s) => s.key === 'core')!.build())).toEqual([])
    const fields = changesFromDefaults(STARTERS.find((s) => s.key === 'measured')!.build()).map((c) => c.field)
    expect(fields).toEqual(expect.arrayContaining(['market.labels', 'entry.measuredOnly', 'entry.minEdgePp', 'size.maxTradeUsd']))
  })
})

describe('share codes', () => {
  const live = { ...STARTERS[2]!.build(), enabled: true, mode: 'live' as const, market: { ...STARTERS[2]!.build().market, venues: ['kalshi' as const] } }

  it('round trip the settings into a new bot that is off and in paper', () => {
    const code = shareCode(live)
    expect(code.startsWith('LEBOT1:')).toBe(true)
    const b = readShareCode(code, 'bot-new')
    expect(b).toMatchObject({ id: 'bot-new', enabled: false, mode: 'paper', name: live.name })
    expect(b.entry).toEqual(live.entry)
    expect(b.market.venues).toEqual(['kalshi'])
  })

  it('carry settings only', () => {
    const json = atob(shareCode(live).slice(7).replace(/-/g, '+').replace(/_/g, '/'))
    expect(Object.keys(JSON.parse(json)).sort()).toEqual(['decider', 'entry', 'guards', 'market', 'mode', 'name', 'pollS', 'size'])
  })

  it('refuse anything that is not a valid bot', () => {
    expect(() => readShareCode('hello', 'x')).toThrow(/not a Lazy Edge bot code/)
    expect(() => readShareCode('LEBOT1:@@@', 'x')).toThrow(/damaged/)
    const bad = shareCode({ ...live, entry: { ...live.entry, minEdgePp: 999 } })
    expect(() => readShareCode(bad, 'x')).toThrow(/does not recognise/)
  })
})
