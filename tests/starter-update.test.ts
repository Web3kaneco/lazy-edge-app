import { describe, expect, it } from 'vitest'
import { draftStrategy } from '../src/main/ai/strategy'
import type { AiProvider } from '../src/main/ai/types'
import { changeLines } from '../src/shared/fields'
import { BotSettings } from '../src/shared/schema'
import { STARTERS, starterChanges, starterFingerprint, withStarter } from '../src/shared/starters'

const props = () => BotSettings.parse(STARTERS.find((s) => s.key === 'nba-props')!.build())

// 2026-11-20: a copy of the props starter from an older version kept
// pregame and Q1 on and spent its trades before the second quarter.
describe('starter updates', () => {
  it('a copy saved with an older starter differs, and takes the new settings but keeps its name and how it runs', () => {
    const old = props()
    old.name = 'My props'
    old.enabled = true
    old.mode = 'live'
    old.market.phase = 'both'
    old.market.quarters = ['Q1', 'Q2', 'Q3', 'Q4']
    old.market.venues = ['paper']
    expect(starterFingerprint(old)).not.toBe(starterFingerprint(props()))
    const fields = starterChanges(old, props()).map((c) => c.field)
    expect(fields).toEqual(expect.arrayContaining(['market.phase', 'market.quarters']))
    expect(fields).not.toContain('market.venues') // paper in the venues means nothing now
    const next = withStarter(old, props())
    expect(next).toMatchObject({ id: old.id, name: 'My props', enabled: true, mode: 'live', market: { phase: 'live', quarters: ['Q3', 'Q4'] } })
    expect(starterFingerprint(next)).toBe(starterFingerprint(props()))
  })

  it('the same settings saved in another order are no change', () => {
    const a = props()
    const b = props()
    b.market.quarters = ['Q4', 'Q3']
    b.name = 'Renamed'
    b.enabled = true
    expect(starterFingerprint(a)).toBe(starterFingerprint(b))
  })

  it('says what changed in plain words', () => {
    const old = props()
    old.entry.minChancePct.Q4 = 80
    old.market.quarters = ['Q1', 'Q2', 'Q3', 'Q4']
    const lines = changeLines(starterChanges(old, props()))
    expect(lines).toContainEqual(expect.objectContaining({ name: 'Minimum chance to hit, 4th quarter', from: '80%', to: '60%' }))
    expect(lines).toContainEqual(expect.objectContaining({ name: 'Quarters', from: 'Q1, Q2, Q3, Q4', to: 'Q3, Q4' }))
  })
})

// A stand in model that tries to raise the stake and turn off the loss stop.
const greedy = (over: Record<string, unknown>): AiProvider => ({
  id: 'anthropic', configured: () => true, models: async () => [], test: async () => ({ ok: true, detail: '' }),
  json: async <T,>(): Promise<T> => ({
    name: 'My props', sports: ['NBA'], lanes: ['PROP'], phase: 'live', quarters: ['Q3', 'Q4'], labels: ['PRICE_GAP'], venues: ['polymarket'],
    minEdgePp: 3, minChancePregamePct: 60, minChanceQ1Pct: 60, minChanceQ2Pct: 60, minChanceQ3Pct: 60, minChanceQ4Pct: 60,
    maxTrailingPoints: -1, favoritesOnly: false, buyOurPick: false, flatSize: false, pickGapPp: -1, exitMode: 'hold', exitTargetC: 10,
    minEvCents: 0.5, priceBandLowC: 40, priceBandHighC: 92, maxPriceAgeS: 60, requireTrigger: false, measuredOnly: false,
    kellyMultiplier: 1, maxTradeUsd: 500, minTradeUsd: 50, maxContracts: 1000, maxGameEquityPct: 1, noEntryFinalS: 120, noOvertime: true,
    maxDailyDrawdownUsd: 100000, maxTradesPerDay: 40, propTopPlayers: 10, bidWhenOverpriced: false,
    explanation: 'Q2 to Q4 at 60%.', recommendation: 'At 60% a 3 point edge buys at 57c or less, about +1.3c a contract.', unsupported: [], ...over
  }) as T
})

describe('the AI edits the open bot and never its money', () => {
  it('keeps size, the loss stop, the venues, on or off and paper or live, whatever the model returns', async () => {
    const mine = props()
    mine.enabled = true
    mine.mode = 'live'
    mine.market.phase = 'both'
    const out = await draftStrategy(greedy({}), 'only Q2 to Q4 at 60%', '', undefined, mine)
    expect(out.bot.id).toBe(mine.id)
    expect(out.bot).toMatchObject({ enabled: true, mode: 'live', size: mine.size, guards: { maxDailyDrawdownUsd: mine.guards.maxDailyDrawdownUsd }, market: { venues: mine.market.venues, phase: 'live' } })
    // Only what was asked moved, measured against the bot as it was.
    expect(out.changes.map((c) => c.field)).toEqual(['market.phase'])
  })

  it('a new bot from a sentence is off and in paper', async () => {
    const out = await draftStrategy(greedy({ maxTradeUsd: 5, minTradeUsd: 1, kellyMultiplier: 0.25, maxContracts: 100, maxGameEquityPct: 0.35, maxDailyDrawdownUsd: 50 }), 'props Q2 to Q4', '')
    expect(out.bot).toMatchObject({ enabled: false, mode: 'paper' })
  })
})
