import { describe, expect, it } from 'vitest'
import { DEFAULT_ACCOUNT } from '@shared/ruleset'
import { BotSettings } from '@shared/schema'
import type { Signal } from '@shared/signal'
import { STARTERS } from '@shared/starters'
import { preGates, type GateContext } from '../src/main/rules/gates'

const NOW = Date.UTC(2026, 10, 20, 2, 0, 0)

// A made up prop: AAA's player over 20.5 points at our 80%.
function prop(over: Partial<Signal> = {}): Signal {
  return {
    key: 'nba:g1:PROP:KXNBAPTS-99JAN01AAABBB-P20', sport: 'NBA', lane: 'PROP', phase: 'live', gameId: 'g1',
    title: 'AAA @ BBB Player over 20.5 points', signalType: 'BUY_OVER', explicitSide: 'yes',
    ourP: 0.8, marketP: 0.7, edgePp: 10, label: 'PRICE_GAP', kelly: null, trigger: false, measured: false,
    clock: { period: 2, secondsRemaining: 400, overtime: false },
    quotes: [{ venue: 'kalshi', contract: 'KXNBAPTS-99JAN01AAABBB-P20', side: 'yes', ask: 0.7, askSize: 100, priceAgeS: 5 }],
    why: null, receivedAt: NOW,
    // Third in his game by projection, inside the starter's top ten.
    prop: { line: 20.5, soFar: 14, over: true, teamLead: null, rank: 3 },
    ...over
  }
}
const bot = () => { const b = STARTERS.find((s) => s.key === 'nba-props')!.build(); b.enabled = true; return b }
const ctx = (): GateContext => ({
  now: NOW, venues: { paper: { balanceUsd: 1000, equityUsd: 1000 } }, keyed: ['kalshi'], openMarketKeys: new Set(), gamePositions: [],
  gameExposureUsd: 0, accountOpenExposureUsd: 0, botDailyPnlUsd: 0, accountDailyPnlUsd: 0, botTradesToday: 0
})

// 2026-11-26: the starter takes the owner's live rules, Q3 and Q4 only.
describe('NBA player props starter, in game Q3 and Q4', () => {
  it('is in game only, Q3 and Q4, flat $5, off and in paper', () => {
    const b = STARTERS.find((s) => s.key === 'nba-props')!.build()
    expect(BotSettings.parse(b)).toBeTruthy()
    expect(b).toMatchObject({
      enabled: false, mode: 'paper',
      market: { lanes: ['PROP'], phase: 'live', quarters: ['Q3', 'Q4'], propTopPlayers: 10, propSidesOff: ['REB under'] },
      entry: { minEdgePp: 3, maxEdgePp: 15, underEdgePp: [5, 7] },
      size: { sizing: 'flat', maxTradeUsd: 5 },
      exit: { mode: 'hold' }
    })
  })

  it('never buys a pregame prop', () => {
    expect(preGates(prop({ phase: 'pregame', clock: null }), bot(), DEFAULT_ACCOUNT, ctx())).toMatchObject({ gate: 'phase_not_enabled' })
  })

  it('skips the first and second quarters', () => {
    for (const period of [1, 2]) {
      const clock = { period, secondsRemaining: (4 - period) * 720 + 400, overtime: false }
      expect(preGates(prop({ clock }), bot(), DEFAULT_ACCOUNT, ctx())).toMatchObject({ gate: 'quarter_not_enabled' })
    }
  })

  it('takes props trending to hit, 60% or more, in each of Q3 and Q4', () => {
    for (const period of [3, 4]) {
      const clock = { period, secondsRemaining: (4 - period) * 720 + 400, overtime: false }
      expect(preGates(prop({ clock, ourP: 0.6 }), bot(), DEFAULT_ACCOUNT, ctx())).toBeNull()
      expect(preGates(prop({ clock, ourP: 0.58 }), bot(), DEFAULT_ACCOUNT, ctx())).toMatchObject({ gate: 'min_chance' })
    }
  })
})
