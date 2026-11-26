import { describe, expect, it } from 'vitest'
import { preGates, type GateContext } from '../src/main/rules/gates'
import { DEFAULT_ACCOUNT, defaultBot } from '../src/shared/ruleset'
import { BotSettings } from '../src/shared/schema'
import type { Signal } from '../src/shared/signal'
import { STARTERS, starterChanges, starterUpdate, starterVersion, withStarter, withStarterUpdate } from '../src/shared/starters'

const NOW = Date.UTC(2099, 0, 1, 0, 0)
const ctx: GateContext = { now: NOW, venues: { paper: { balanceUsd: 1000, equityUsd: 1000 } }, keyed: ['kalshi'], openMarketKeys: new Set(), gamePositions: [], gameExposureUsd: 0, accountOpenExposureUsd: 0, botDailyPnlUsd: 0, accountDailyPnlUsd: 0, botTradesToday: 0 }
const pre = (startsInMin: number | null): Signal => ({
  key: 'nba:g1:MONEYLINE:home', sport: 'NBA', lane: 'MONEYLINE', phase: 'pregame', gameId: 'g1', title: 'AAA @ BBB BBB to win',
  signalType: 'BUY_HOME', explicitSide: 'yes', ourP: 0.7, marketP: 0.6, edgePp: 10, label: 'PRICE_GAP', kelly: null, trigger: false, measured: false,
  clock: null, quotes: [{ venue: 'kalshi', contract: 'KXNBAGAME-99JAN01AAABBB-BBB', side: 'yes', ask: 0.6, askSize: 100, priceAgeS: 5 }], why: null, receivedAt: NOW,
  startsAt: startsInMin === null ? null : NOW + startsInMin * 60_000
})

// 2026-11-21: "pregame rolls out 15 minutes before the game starts,
// unless it is combos, those can be early".
describe('pregame plays wait for the last 15 minutes', () => {
  const b = () => { const x = defaultBot('b', 'B'); x.enabled = true; x.market.lanes = ['MONEYLINE']; return x }

  it('waits until 15 minutes before the start, then takes it', () => {
    expect(b().entry.pregameWindowMin).toBe(15)
    expect(preGates(pre(40), b(), DEFAULT_ACCOUNT, ctx)).toMatchObject({ gate: 'pregame_wait', detail: 'starts in 40 min, enters in the last 15' })
    expect(preGates(pre(14), b(), DEFAULT_ACCOUNT, ctx)).toBeNull()
  })

  it('refuses a pregame play whose start is not known, and any time is allowed when the window is off', () => {
    expect(preGates(pre(null), b(), DEFAULT_ACCOUNT, ctx)).toMatchObject({ gate: 'start_unknown' })
    const any = b(); any.entry.pregameWindowMin = null
    expect(preGates(pre(300), any, DEFAULT_ACCOUNT, ctx)).toBeNull()
  })

  it('a combos only bot may go early', () => {
    const combo = b(); combo.market.lanes = ['MONEYLINE', 'COMBO']; combo.combo.only = true
    expect(preGates(pre(300), combo, DEFAULT_ACCOUNT, ctx)).toBeNull()
  })

  it('bots saved before the window take it by default', () => {
    const old = JSON.parse(JSON.stringify(b()))
    delete old.entry.pregameWindowMin
    expect(BotSettings.parse(old).entry.pregameWindowMin).toBe(15)
  })
})

// 2026-11-21: the update offered to switch his Pregame only bot from
// our pick to the edge, and his pregame combos to in game: his own settings.
describe('starter updates offer only what the starter changed', () => {
  const starter = (key: string) => BotSettings.parse(STARTERS.find((s) => s.key === key)!.build())

  it('a starter that did not change offers nothing, whatever the user changed', () => {
    const mine = starter('pregame')
    mine.entry.basis = 'pick'; mine.market.sports = ['NBA']; mine.market.lanes = ['MONEYLINE']; mine.entry.priceBandC = [1, 99]
    expect(starterVersion('pregame')).toBe(1)
    expect(starterUpdate(mine, starter('pregame'), 'pregame')).toEqual([])
    const combos = starter('nba-combos'); combos.market.phase = 'pregame'; combos.market.quarters = ['Q1']
    expect(starterUpdate(combos, starter('nba-combos'), 'nba-combos')).toEqual([])
  })

  it('a starter that changed offers only its own changes, keeps the rest, and never money', () => {
    const mine = starter('nba-pick-pregame')
    mine.entry.minChancePct = { pregame: 70, Q1: 70, Q2: 70, Q3: 70, Q4: 70 }
    mine.entry.priceBandC = [25, 92]
    mine.size.maxTradeUsd = 20
    mine.pollS = 30
    const fields = starterUpdate(mine, starter('nba-pick-pregame'), 'nba-pick-pregame').map((c) => c.field)
    expect(fields).toEqual(expect.arrayContaining(['entry.priceBandC', 'entry.minChancePct.pregame']))
    expect(fields).not.toContain('size.maxTradeUsd')
    expect(fields).not.toContain('pollS')
    const next = withStarterUpdate(mine, starter('nba-pick-pregame'), 'nba-pick-pregame')
    expect(next).toMatchObject({ entry: { priceBandC: [1, 99], minChancePct: { pregame: 0 } }, size: { maxTradeUsd: 20 }, pollS: 30 })
  })

  // 2026-11-26: every public copy of NBA Props comes from 0.9.1 (pregame on,
  // Q1 to Q4, no top players, no edge cap, no under band).
  it("a 0.9.1 copy of NBA Props takes 0.10.0's rules and keeps its money", () => {
    const mine = starter('nba-props')
    mine.market.phase = 'both'; mine.market.quarters = ['Q1', 'Q2', 'Q3', 'Q4']; mine.market.propTopPlayers = null; mine.market.propSidesOff = []
    mine.entry.maxEdgePp = null; mine.entry.underEdgePp = null; mine.size.maxTradeUsd = 25
    expect(starterVersion('nba-props')).toBe(3)
    const next = withStarterUpdate(mine, starter('nba-props'), 'nba-props')
    expect(next).toMatchObject({
      market: { phase: 'live', quarters: ['Q3', 'Q4'], propTopPlayers: 10, propSidesOff: ['REB under'] },
      entry: { maxEdgePp: 15, underEdgePp: [5, 7] }, size: { maxTradeUsd: 25 }
    })
  })

  it('a reset to the starter keeps money and venues too', () => {
    const mine = starter('nba-live'); mine.size.maxTradeUsd = 40; mine.guards.maxDailyDrawdownUsd = 200; mine.market.venues = ['kalshi']; mine.entry.minEdgePp = 9
    const r = withStarter(mine, starter('nba-live'))
    expect(r).toMatchObject({ size: { maxTradeUsd: 40 }, guards: { maxDailyDrawdownUsd: 200 }, market: { venues: ['kalshi'] }, entry: { minEdgePp: 5 } })
    expect(starterChanges(mine, starter('nba-live')).map((c) => c.field)).toEqual(['entry.minEdgePp'])
  })
})

// 2026-11-25: "Yes, one bot only". On 23 and 24 November Kaneco's bot
// and Pregame only bought the same OKC and DEN picks a second apart.
describe('one live bot per pregame pick', () => {
  const live = () => { const x = defaultBot('b', 'B'); x.enabled = true; x.mode = 'live'; x.market.lanes = ['MONEYLINE']; return x }
  const held = { ...ctx, othersHoldLive: new Map([['nba:g1:MONEYLINE:home', "Kaneco's bot"]]) }

  it('a live bot skips a pregame pick another bot holds with real money', () => {
    expect(preGates(pre(10), live(), DEFAULT_ACCOUNT, held)).toMatchObject({ gate: 'held_by_other_bot', detail: "Kaneco's bot already holds this pick with real money" })
  })

  it('a paper bot, another pick, or an in game play is not held back', () => {
    const paper = live(); paper.mode = 'paper'
    expect(preGates(pre(10), paper, DEFAULT_ACCOUNT, held)).toBeNull()
    expect(preGates({ ...pre(10), key: 'nba:g1:MONEYLINE:away' }, live(), DEFAULT_ACCOUNT, held)).toBeNull()
    const inGame = live(); inGame.market.phase = 'both'
    expect(preGates({ ...pre(10), phase: 'live' }, inGame, DEFAULT_ACCOUNT, held)?.gate).not.toBe('held_by_other_bot')
  })
})
