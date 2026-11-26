import { describe, expect, it } from 'vitest'
import { calibrate, honestChance, withHonest, MEASURED_MIN } from '../src/shared/honest'
import { defaultBot, DEFAULT_ACCOUNT } from '../src/shared/ruleset'
import type { Signal } from '../src/shared/signal'
import type { SettledLike } from '../src/shared/results'
import { comebackOf, nbaLiveEdges } from '../src/main/data/normalize'
import { preGates, type GateContext } from '../src/main/rules/gates'

// 2026-11-21: chasing the edge keeps buying the losing side, because
// a model hopeful about comebacks makes the trailing team look underpriced.
// Made up: AAA at BBB, BBB at home.
const play = (over: Partial<Signal> = {}): Signal => ({
  key: 'nba:g1:MONEYLINE:away', sport: 'NBA', lane: 'MONEYLINE', phase: 'live', gameId: 'g1', title: 'AAA @ BBB AAA to win',
  signalType: 'BUY_AWAY', explicitSide: 'yes', ourP: 0.3, marketP: 0.22, edgePp: 8, label: 'PRICE_GAP', kelly: null, trigger: false, measured: false,
  clock: { period: 4, secondsRemaining: 400, overtime: false }, quotes: [{ venue: 'kalshi', contract: 'KXNBAGAME-99JAN01AAABBB-AAA', side: 'yes', ask: 0.22, askSize: 50, priceAgeS: 2 }],
  why: null, receivedAt: 0, team: { lead: -9, winP: 0.22 },
  comeback: { winP: 0.18, trailingHome: false, deficit: 9, bucket: 'Q4_LATE' },
  ...over
})
const none = new Map()

describe('the honest chance, from the comeback record', () => {
  it('pulls a trailing team halfway down to how often teams in its spot came back', () => {
    const h = honestChance(play(), none, 22)!
    expect(h.raw).toBe(0.3)
    expect(h.p).toBeCloseTo(0.24)
    expect(h.notes[0]).toBe('teams down 9 (q4 late) came back to win 18%, under our 30%')
  })

  it('checks a leading team against how often leaders held on', () => {
    const lead = play({ signalType: 'BUY_HOME', ourP: 0.92, team: { lead: 9, winP: 0.78 }, comeback: { winP: 0.15, trailingHome: false, deficit: 9, bucket: null } })
    expect(honestChance(lead, none, 78)!.p).toBeCloseTo(0.885)
  })

  it('leaves a chance at or under the record alone, and never raises one', () => {
    expect(honestChance(play({ ourP: 0.15 }), none, 12)!.p).toBe(0.15)
    expect(honestChance(play({ comeback: undefined }), none, 22)!.p).toBe(0.3)
  })
})

const settled = (raw: number, won: boolean, i: number): SettledLike => ({
  botId: 'b', botName: 'b', side: 'yes', venue: 'paper', filledContracts: 10, avgFillC: 25, limitPriceC: 25, costUsd: 2.5, feeUsd: 0.1,
  pnlUsd: won ? 7.4 : -2.6, createdAt: i, gameId: `g${i}`,
  play: { sport: 'NBA', lane: 'MONEYLINE', phase: 'live', label: 'PRICE_GAP', hot: false, measured: false, edgePp: 8, ourP: raw }
})

describe('the honest chance, from your own record', () => {
  // 40 underdog moneylines we called at 33%, of which 8 won (20%).
  const record = Array.from({ length: 40 }, (_, i) => settled(0.33, i < 8, i))

  it('lowers a chance where your plays like it won less than we said, shrunk while the record is small', () => {
    const c = calibrate(record)
    const band = [...c.values()][0]!
    expect(band).toMatchObject({ key: 'MONEYLINE|underdog|30-40', n: 40 })
    expect(band.won).toBeCloseTo(0.2)
    // Shrunk toward 33% as if 30 more had come in at it: (8 + 30 x 0.33) / 70.
    expect(band.shift).toBeCloseTo((8 + 30 * 0.33) / 70 - 0.33)
    const h = honestChance(play({ comeback: undefined, ourP: 0.34 }), c, 25)!
    expect(h.p).toBeCloseTo(0.34 + band.shift)
    expect(h.notes[0]).toMatch(/your underdog moneyline plays at 30-40% won 20% over 40/)
  })

  it('waits for enough settled plays, and a record that beat our chance never raises it', () => {
    expect([...calibrate(record.slice(0, MEASURED_MIN - 1)).values()][0]!.shift).toBe(0)
    const lucky = Array.from({ length: 40 }, (_, i) => settled(0.33, i < 30, i))
    expect([...calibrate(lucky).values()][0]!.shift).toBe(0)
  })
})

describe('the gates read the honest chance', () => {
  const ctx: GateContext = { now: 0, venues: { paper: { balanceUsd: 1000, equityUsd: 1000 } }, keyed: ['kalshi'], openMarketKeys: new Set(), gamePositions: [], gameExposureUsd: 0, accountOpenExposureUsd: 0, botDailyPnlUsd: 0, accountDailyPnlUsd: 0, botTradesToday: 0 }

  it('a trailing team at our 72% that teams in its spot came back from 50% is held to the minimum chance', () => {
    const b = defaultBot('b', 'b')
    b.enabled = true
    b.market.lanes = ['MONEYLINE']
    b.entry.minChancePct = { pregame: 70, Q1: 70, Q2: 70, Q3: 70, Q4: 70 }
    const s = play({ ourP: 0.72, comeback: { winP: 0.5, trailingHome: false, deficit: 6, bucket: null } })
    expect(preGates(s, b, DEFAULT_ACCOUNT, ctx)).toBeNull()
    const honest = withHonest(s, none)
    expect(honest).toMatchObject({ rawP: 0.72 })
    expect(honest.ourP).toBeCloseTo(0.61)
    expect(honest.edgePp).toBeCloseTo(8 - 11)
    expect(preGates(honest, b, DEFAULT_ACCOUNT, ctx)).toMatchObject({ gate: 'min_chance' })
  })
})

describe('the comeback record from the NBA feed', () => {
  const row = {
    game_id: '99', home_team: 'BBB', away_team: 'AAA', trade_signal: 'SELL', target_side: 'YES', target_kalshi_ticker: 'KXNBAGAME-99JAN01AAABBB-AAA',
    our_prob: 0.7, edge_score: -0.08, kalshi_implied: 0.78, period: 4, clock: '6:40', home_score: 98, away_score: 89, signal_age_s: 20,
    comeback_win_prob: 0.18, comeback_trailing_team: 'AAA', comeback_deficit: 9, comeback_bucket: 'Q4_LATE', comeback_tier: 'BLEND'
  }
  it('reads it onto the play, and nothing outside its window', () => {
    expect(comebackOf(row)).toEqual({ winP: 0.18, trailingHome: false, deficit: 9, bucket: 'Q4_LATE' })
    expect(comebackOf({ ...row, comeback_win_prob: null })).toBeNull()
    expect(nbaLiveEdges([row], 0).signals[0]!.comeback).toMatchObject({ winP: 0.18, trailingHome: false })
  })
})
