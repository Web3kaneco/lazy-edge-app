import { describe, expect, it } from 'vitest'
import { applyFix } from '@shared/fixes'
import { DEFAULT_ACCOUNT, defaultBot } from '@shared/ruleset'
import { BotSettings } from '@shared/schema'
import type { Signal } from '@shared/signal'
import { STARTERS } from '@shared/starters'
import { nbaLiveEdges, nbaPicks } from '../src/main/data/normalize'
import { evaluate, type GateContext } from '../src/main/rules/gates'

const NOW = Date.UTC(2026, 10, 17, 1, 0, 0)

// A live NBA moneyline on the home side, our 80% to win, priced at 85c: our
// pick, with the edge pointing the other way.
function pick(over: Partial<Signal> = {}): Signal {
  return {
    key: 'nba:g1:MONEYLINE:home', sport: 'NBA', lane: 'MONEYLINE', phase: 'live', gameId: 'g1',
    title: 'AAA @ BBB BBB to win', signalType: 'BUY_HOME', explicitSide: 'yes',
    ourP: 0.8, marketP: 0.85, edgePp: -5, label: 'PRICE_GAP', kelly: null, trigger: false, measured: false,
    clock: { period: 3, secondsRemaining: 1000, overtime: false },
    quotes: [{ venue: 'kalshi', contract: 'KXNBAGAME-99JAN01AAABBB-BBB', side: 'yes', ask: 0.85, askSize: 500, priceAgeS: 20 }],
    why: null, receivedAt: NOW, team: { lead: 6, winP: 0.85 }, pickOnly: true,
    ...over
  }
}

const bot = (over: (b: BotSettings) => void = () => {}): BotSettings => {
  const b = defaultBot('b1', 'test')
  b.enabled = true
  b.market.venues = ['kalshi']
  b.guards.noEntryFinalS = 0
  over(b)
  return b
}
const pickBot = (over: (b: BotSettings) => void = () => {}): BotSettings => bot((b) => {
  b.entry.basis = 'pick'
  b.entry.minChancePct = { pregame: 70, Q1: 70, Q2: 70, Q3: 70, Q4: 70 }
  b.entry.priceBandC = [25, 92]
  b.size.sizing = 'flat'
  b.size.maxTradeUsd = 5
  over(b)
})
const account = () => { const a = structuredClone(DEFAULT_ACCOUNT); a.venues.kalshi.enabled = true; return a }
const ctx = (paperUsd = 1000): GateContext => ({
  now: NOW, venues: { paper: { balanceUsd: paperUsd, equityUsd: paperUsd }, kalshi: { balanceUsd: 200, equityUsd: 200 } }, openMarketKeys: new Set(), gamePositions: [],
  gameExposureUsd: 0, accountOpenExposureUsd: 0, botDailyPnlUsd: 0, accountDailyPnlUsd: 0, botTradesToday: 0
})

describe('buy our pick, 2026-11-17', () => {
  it('buys our pick priced above our chance, flat, where an edge bot cannot', () => {
    const d = evaluate(pick(), pickBot(), account(), ctx())
    expect(d).toMatchObject({ kind: 'trade', side: 'yes', limitPriceC: 85, contracts: 5, costUsd: 4.25 })
    if (d.kind === 'trade') expect(d.audit.join(' ')).toContain('basis our pick at 80.0%')
    // The same play is not one for a bot that trades the edge.
    expect(evaluate(pick(), bot(), account(), ctx())).toMatchObject({ kind: 'skip', gate: 'pick_only' })
    expect(evaluate(pick({ pickOnly: undefined }), bot(), account(), ctx())).toMatchObject({ kind: 'skip', gate: 'min_edge' })
  })

  it('never buys the side our number has losing, whatever its edge', () => {
    const under = pick({ key: 'nba:g1:MONEYLINE:away', ourP: 0.3, marketP: 0.15, edgePp: 15, pickOnly: undefined, quotes: [{ venue: 'kalshi', contract: 'KXNBAGAME-99JAN01AAABBB-AAA', side: 'yes', ask: 0.15, askSize: 500, priceAgeS: 20 }] })
    expect(evaluate(under, pickBot((b) => { b.entry.minChancePct = { pregame: 0, Q1: 0, Q2: 0, Q3: 0, Q4: 0 } }), account(), ctx())).toMatchObject({ gate: 'not_our_pick' })
    expect(evaluate(pick({ ourP: 0.5 }), pickBot(), account(), ctx())).toMatchObject({ gate: 'not_our_pick' })
    expect(evaluate(pick({ ourP: null }), pickBot(), account(), ctx())).toMatchObject({ gate: 'no_reading' })
  })

  it('still holds a pick to the minimum chance, the price band and the price age', () => {
    expect(evaluate(pick({ ourP: 0.65 }), pickBot(), account(), ctx())).toMatchObject({ gate: 'min_chance' })
    const dear = pick({ quotes: [{ venue: 'kalshi', contract: 'KXNBAGAME-99JAN01AAABBB-BBB', side: 'yes', ask: 0.95, askSize: 500, priceAgeS: 20 }] })
    expect(evaluate(dear, pickBot(), account(), ctx())).toMatchObject({ gate: 'no_venue', detail: 'kalshi:band 95c' })
    const stale = pick({ quotes: [{ venue: 'kalshi', contract: 'KXNBAGAME-99JAN01AAABBB-BBB', side: 'yes', ask: 0.85, askSize: 500, priceAgeS: 500 }] })
    expect(evaluate(stale, pickBot(), account(), ctx())).toMatchObject({ gate: 'no_venue', detail: 'kalshi:stale' })
  })

  it('sizes a pick with no edge at nothing under Kelly', () => {
    expect(evaluate(pick(), pickBot((b) => { b.size.sizing = 'kelly' }), account(), ctx())).toMatchObject({ gate: 'kelly_zero' })
  })
})

describe('flat sizing', () => {
  const edgePlay = (): Signal => pick({ ourP: 0.6, marketP: 0.5, edgePp: 10, pickOnly: undefined, quotes: [{ venue: 'kalshi', contract: 'KXNBAGAME-99JAN01AAABBB-BBB', side: 'yes', ask: 0.5, askSize: 500, priceAgeS: 20 }] })

  it('makes every trade the maximum per trade, whatever the edge', () => {
    expect(evaluate(edgePlay(), bot((b) => { b.size.sizing = 'flat' }), account(), ctx())).toMatchObject({ kind: 'trade', contracts: 20, costUsd: 10 })
    // Kelly on the same play: a quarter of (0.55 - 0.5) / 0.5 of $1000, capped at $10.
    expect(evaluate(edgePlay(), bot(), account(), ctx())).toMatchObject({ kind: 'trade', contracts: 20 })
    expect(evaluate(edgePlay(), bot((b) => { b.size.sizing = 'flat'; b.size.maxTradeUsd = 3 }), account(), ctx())).toMatchObject({ contracts: 6, costUsd: 3 })
  })

  it('is still held to the balance and the contract limit', () => {
    expect(evaluate(edgePlay(), bot((b) => { b.size.sizing = 'flat' }), account(), ctx(4))).toMatchObject({ contracts: 8, costUsd: 4 })
    expect(evaluate(edgePlay(), bot((b) => { b.size.sizing = 'flat'; b.size.maxContracts = 3 }), account(), ctx())).toMatchObject({ contracts: 3 })
  })

  it('reads bots saved before 0.9.0 as the edge and Kelly', () => {
    const old: Record<string, any> = structuredClone(defaultBot('old', 'old'))
    delete old.entry.basis; delete old.size.sizing
    const b = BotSettings.parse(old)
    expect(b.entry.basis).toBe('edge')
    expect(b.size.sizing).toBe('kelly')
  })
})

describe('our pick from the NBA feed', () => {
  const row = {
    game_id: 'g1', home_team: 'BBB', away_team: 'AAA', period: 3, clock: '5:32', home_score: 80, away_score: 74,
    trade_signal: 'SELL', target_side: 'YES', target_kalshi_ticker: 'KXNBAGAME-99JAN01AAABBB-AAA',
    kalshi_home_ticker: 'KXNBAGAME-99JAN01AAABBB-BBB', kalshi_away_ticker: 'KXNBAGAME-99JAN01AAABBB-AAA',
    our_prob: 0.8, edge_score: -0.05, kalshi_implied: 0.85, momentum_state: 'NEUTRAL', signal_stale: false, signal_age_s: 20
  }

  it('adds our pick on the other team only when a bot buys picks', () => {
    expect(nbaLiveEdges([row], NOW).signals.map((s) => s.key)).toEqual(['nba:g1:MONEYLINE:away'])
    const [edge, ours] = nbaLiveEdges([row], NOW, true).signals
    expect(edge).toMatchObject({ key: 'nba:g1:MONEYLINE:away', edgePp: 5 })
    expect(edge!.pickOnly).toBeUndefined()
    expect(ours).toMatchObject({ key: 'nba:g1:MONEYLINE:home', pickOnly: true, signalType: 'BUY_HOME', ourP: 0.8, team: { lead: 6, winP: 0.85 } })
    expect(ours!.edgePp).toBeCloseTo(-5)
    expect(ours!.quotes).toEqual([{ venue: 'kalshi', contract: 'KXNBAGAME-99JAN01AAABBB-BBB', side: 'yes', ask: null, askSize: null, priceAgeS: null }])
  })

  it('gives our pick on a row with no edge, and nothing extra when the edge already backs it', () => {
    const hold = nbaLiveEdges([{ ...row, trade_signal: 'HOLD', target_side: '', target_kalshi_ticker: '' }], NOW, true)
    expect(hold.signals.map((s) => [s.key, s.pickOnly])).toEqual([['nba:g1:MONEYLINE:home', true]])
    expect(hold.refused).toEqual([])
    const agree = nbaLiveEdges([{ ...row, trade_signal: 'BUY', target_kalshi_ticker: 'KXNBAGAME-99JAN01AAABBB-BBB', edge_score: 0.06 }], NOW, true)
    expect(agree.signals.map((s) => [s.key, s.pickOnly])).toEqual([['nba:g1:MONEYLINE:home', undefined]])
    // An away pick takes the away ticker.
    const away = nbaLiveEdges([{ ...row, trade_signal: 'HOLD', our_prob: 0.25, kalshi_implied: 0.3 }], NOW, true).signals[0]!
    expect(away).toMatchObject({ key: 'nba:g1:MONEYLINE:away', ourP: 0.75 })
    expect(away.quotes[0]!.contract).toBe('KXNBAGAME-99JAN01AAABBB-AAA')
  })

  it('refuses a pick it cannot route, a dead even game and a stale row', () => {
    const noTicker = nbaLiveEdges([{ ...row, trade_signal: 'HOLD', kalshi_home_ticker: '' }], NOW, true)
    expect(noTicker.signals).toEqual([])
    expect(noTicker.refused[0]!.reason).toContain('no home ticker')
    expect(nbaLiveEdges([{ ...row, trade_signal: 'HOLD', our_prob: 0.5 }], NOW, true).signals).toEqual([])
    expect(nbaLiveEdges([{ ...row, trade_signal: 'HOLD', signal_age_s: 900 }], NOW, true).signals).toEqual([])
  })
})

describe('/v1/nba/picks', () => {
  // A pregame row as the API sends it, made up: BBB at home, our 80%.
  const row = {
    game_id: 'g2', home_team: 'BBB', away_team: 'AAA', phase: 'pregame', period: 0, clock: '', home_score: 0, away_score: 0,
    pick: 'BBB', pick_side: 'home', pick_p: 0.8, tier: '80+', corrected_p: 0.88,
    record_season: { n: 31, won: 29, lost: 2, win_rate: 0.935, avg_chance: 0.84 }, record_7d: { n: 5, won: 5, lost: 0, win_rate: 1, avg_chance: 0.83 },
    price: 0.82, price_source: 'kalshi_book', value: 0.06, raw_edge: -0.02,
    edge_score: 0.03, edge_team: 'AAA', edge_against_pick: true, signal: 'BACK', reason: null,
    target_kalshi_ticker: 'KXNBAGAME-99JAN01AAABBB-BBB', kalshi_home_ticker: 'KXNBAGAME-99JAN01AAABBB-BBB', kalshi_away_ticker: 'KXNBAGAME-99JAN01AAABBB-AAA',
    model_ready: true, signal_stale: false, signal_age_s: 30, computed_at_ms: NOW - 600_000
  }

  it('makes each pick a pick signal on its own contract, with its record in the note', () => {
    const [s] = nbaPicks([row], NOW).signals
    expect(s).toMatchObject({
      key: 'nba:g2:MONEYLINE:home', phase: 'pregame', pickOnly: true, ourP: 0.8, marketP: 0.82, signalType: 'BUY_HOME', clock: null,
      quotes: [{ venue: 'kalshi', contract: 'KXNBAGAME-99JAN01AAABBB-BBB', side: 'yes', ask: null, askSize: null, priceAgeS: null }]
    })
    expect(s!.edgePp).toBeCloseTo(-2)
    expect(s!.why).toBe('Corrected chance 88%; picks at this chance 29-2 this season, 5-0 in the last 7 days; the edge points at AAA; API BACK')
    // The away pick takes the away contract.
    const away = nbaPicks([{ ...row, pick_side: 'away', pick: 'AAA', target_kalshi_ticker: 'KXNBAGAME-99JAN01AAABBB-AAA' }], NOW).signals[0]!
    expect(away).toMatchObject({ key: 'nba:g2:MONEYLINE:away', signalType: 'BUY_AWAY' })
  })

  it('reads a live pick with its clock and score, and holds it to 180 seconds', () => {
    const live = { ...row, phase: 'live', period: 3, clock: '5:32', home_score: 80, away_score: 74, corrected_p: null, record_season: null, record_7d: null, computed_at_ms: NOW - 20_000 }
    const s = nbaPicks([live], NOW).signals[0]!
    expect(s).toMatchObject({ phase: 'live', team: { lead: 6 } })
    expect(s.clock).toMatchObject({ period: 3, overtime: false })
    expect(s.why).toBe('the edge points at AAA; API BACK')
    expect(nbaPicks([{ ...live, computed_at_ms: NOW - 200_000 }], NOW).refused[0]!.reason).toBe('pick 200s old')
  })

  it('refuses a row with no model number, a stale flag, no ticker, no time or a stalled pregame number', () => {
    const bad = [
      { ...row, model_ready: false }, { ...row, signal_stale: true }, { ...row, target_kalshi_ticker: '' },
      { ...row, pick_side: null }, { ...row, computed_at_ms: 0 }, { ...row, computed_at_ms: NOW - 4 * 3600_000 }
    ]
    const n = nbaPicks(bad, NOW)
    expect(n.signals).toEqual([])
    expect(n.refused).toHaveLength(6)
  })

  it('is bought by a pick bot by its own rules, whatever the API signal says', () => {
    const s = nbaPicks([{ ...row, signal: 'WATCH', reason: 'the price is over 92c' }], NOW).signals[0]!
    const quoted = { ...s, quotes: [{ ...s.quotes[0]!, ask: 0.82, askSize: 500, priceAgeS: 20 }] }
    expect(evaluate(quoted, pickBot((b) => { b.market.phase = 'pregame' }), account(), ctx())).toMatchObject({ kind: 'trade', limitPriceC: 82 })
    expect(evaluate(quoted, bot(), account(), ctx())).toMatchObject({ gate: 'pick_only' })
  })
})

describe('the 0.9.0 starters', () => {
  it('are valid, off and in paper, and the pick bots size flat', () => {
    for (const s of STARTERS) {
      const b = s.build()
      expect(BotSettings.safeParse(b).success, s.key).toBe(true)
      expect(b.enabled).toBe(false)
      expect(b.mode).toBe('paper')
      if (b.entry.basis === 'pick') expect(b.size.sizing, s.key).toBe('flat')
    }
    expect(new Set(STARTERS.map((s) => s.key)).size).toBe(STARTERS.length)
    expect(STARTERS.filter((s) => s.build().entry.basis === 'pick').map((s) => s.key)).toEqual(['nba-pick-live', 'nba-pick-pregame'])
  })

  it('will not raise the edge bar on a bot that buys our pick', () => {
    expect(applyFix(pickBot(), { kind: 'minEdge', pp: 5 })).toMatchObject({ next: null, why: 'it buys our pick and does not use the edge' })
  })
})
