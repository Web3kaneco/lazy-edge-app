import { describe, expect, it } from 'vitest'
import { applyFix, Fix, fixText, undoFix } from '@shared/fixes'
import { analyze, fixFor, type SettledLike } from '@shared/results'
import { DEFAULT_ACCOUNT, defaultBot } from '@shared/ruleset'
import { BotSettings } from '@shared/schema'
import { playTags, type PlayTags, type Signal } from '@shared/signal'
import { nbaLiveEdges, nbaSpreadLadder } from '../src/main/data/normalize'
import { evaluate, type GateContext } from '../src/main/rules/gates'

const NOW = Date.UTC(2026, 10, 17, 1, 0, 0)

// A live NBA moneyline: the home side, our 60% to win.
function ml(over: Partial<Signal> = {}): Signal {
  return {
    key: 'nba:g1:MONEYLINE:home', sport: 'NBA', lane: 'MONEYLINE', phase: 'live', gameId: 'g1',
    title: 'AAA @ BBB BBB to win', signalType: 'BUY_HOME', explicitSide: 'yes',
    ourP: 0.6, marketP: 0.5, edgePp: 10, label: 'PRICE_GAP', kelly: null, trigger: false, measured: false,
    clock: { period: 4, secondsRemaining: 400, overtime: false },
    quotes: [{ venue: 'kalshi', contract: 'KXNBAGAME-99JAN01AAABBB-BBB', side: 'yes', ask: 0.5, askSize: 500, priceAgeS: 20 }],
    why: null, receivedAt: NOW, startsAt: NOW + 10 * 60_000, team: { lead: -4, winP: 0.5 },
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
const account = () => { const a = structuredClone(DEFAULT_ACCOUNT); return a }
const ctx = (): GateContext => ({
  now: NOW, venues: { paper: { balanceUsd: 1000, equityUsd: 1000 }, kalshi: { balanceUsd: 200, equityUsd: 200 } }, keyed: ['kalshi'], openMarketKeys: new Set(), gamePositions: [],
  gameExposureUsd: 0, accountOpenExposureUsd: 0, botDailyPnlUsd: 0, accountDailyPnlUsd: 0, botTradesToday: 0
})

describe('score rules, 2026-11-17', () => {
  it('skips a team further behind than the quarter allows, and allows it within the limit', () => {
    const b = bot((x) => { x.entry.maxTrailing = { Q1: null, Q2: null, Q3: 10, Q4: 3 } })
    expect(evaluate(ml(), b, account(), ctx())).toMatchObject({ kind: 'skip', gate: 'trailing', detail: 'down 4, most allowed 3' })
    expect(evaluate(ml({ clock: { period: 3, secondsRemaining: 1000, overtime: false } }), b, account(), ctx()).kind).toBe('trade')
    expect(evaluate(ml({ clock: { period: 2, secondsRemaining: 2000, overtime: false }, team: { lead: -25, winP: 0.5 } }), b, account(), ctx()).kind).toBe('trade')
    expect(evaluate(ml({ team: { lead: 2, winP: 0.5 } }), b, account(), ctx()).kind).toBe('trade')
  })

  it('reads 0 as never behind, overtime as Q4, and refuses a play whose score is missing', () => {
    const b = bot((x) => { x.guards.noOvertime = false; x.entry.maxTrailing = { Q1: 0, Q2: 0, Q3: 0, Q4: 0 } })
    expect(evaluate(ml({ team: { lead: -1, winP: 0.5 } }), b, account(), ctx())).toMatchObject({ gate: 'trailing' })
    expect(evaluate(ml({ team: { lead: 0, winP: 0.5 } }), b, account(), ctx()).kind).toBe('trade')
    expect(evaluate(ml({ clock: { period: 5, secondsRemaining: null, overtime: true } }), b, account(), ctx())).toMatchObject({ gate: 'trailing' })
    expect(evaluate(ml({ team: undefined }), b, account(), ctx())).toMatchObject({ gate: 'score_unknown' })
    // A pregame play has no score to read, and other sports publish none.
    expect(evaluate(ml({ phase: 'pregame', clock: null, team: undefined }), b, account(), ctx()).kind).toBe('trade')
    expect(evaluate(ml({ sport: 'NFL', key: 'nfl:g1:MONEYLINE:home', team: undefined }), b, account(), ctx()).kind).toBe('trade')
  })

  it('reads a spread NO as backing the other team for favorites only', () => {
    const row = {
      game_id: 'g1', home_team: 'BBB', away_team: 'AAA', period: 2, clock: '6:00', home_score: 40, away_score: 50,
      kalshi_implied: 0.3, signal_stale: false, signal_age_s: 20
    }
    const rung = { ticker: 'KXNBASPREAD-99JAN01AAABBB-AAA8', team: 'AAA', line: 7.5, model_prob: 0.42, market_price: 0.35, edge: 0.07, side: 'NOT_COVER', best_edge: true, venue: 'kalshi' }
    const s = nbaSpreadLadder(row, [rung], NOW).signals[0]!
    // NOT_COVER on AAA backs BBB, the home side, down 10 and 30% to win.
    expect(s.team).toEqual({ lead: -10, winP: 0.3 })
    const fav = bot((x) => { x.entry.favoritesOnly = true })
    expect(evaluate({ ...s, quotes: [{ ...s.quotes[0]!, ask: 0.5, askSize: 500, priceAgeS: 20 }] }, fav, account(), ctx())).toMatchObject({ gate: 'not_favorite' })
  })

  it('backs only the favorite when asked, by the market, and refuses when it cannot tell', () => {
    const b = bot((x) => { x.entry.favoritesOnly = true })
    expect(evaluate(ml({ team: { lead: 0, winP: 0.42 } }), b, account(), ctx())).toMatchObject({ gate: 'not_favorite', detail: '42% to win' })
    expect(evaluate(ml({ team: { lead: 0, winP: 0.5 } }), b, account(), ctx()).kind).toBe('trade')
    // A moneyline without a team reading falls back to its own market price.
    expect(evaluate(ml({ team: undefined, marketP: 0.3 }), b, account(), ctx())).toMatchObject({ gate: 'not_favorite' })
    // A spread needs the game's moneyline.
    expect(evaluate(ml({ lane: 'SPREAD', team: undefined }), b, account(), ctx())).toMatchObject({ gate: 'favorite_unknown' })
  })

  it('reads bots saved before 0.8.0 as no limit and not favorites only', () => {
    const old: Record<string, any> = structuredClone(defaultBot('old', 'old'))
    delete old.entry.maxTrailing; delete old.entry.favoritesOnly
    const b = BotSettings.parse(old)
    expect(b.entry.maxTrailing).toEqual({ Q1: null, Q2: null, Q3: null, Q4: null })
    expect(b.entry.favoritesOnly).toBe(false)
  })
})

describe('the score from the feed', () => {
  const row = {
    game_id: 'g1', home_team: 'BBB', away_team: 'AAA', period: 3, clock: '5:32', home_score: 70, away_score: 80,
    trade_signal: 'BUY', target_side: 'YES', target_kalshi_ticker: 'KXNBAGAME-99JAN01AAABBB-BBB',
    our_prob: 0.4, edge_score: 0.07, kalshi_implied: 0.3, momentum_state: 'NEUTRAL', signal_stale: false, signal_age_s: 20
  }

  it('gives a moneyline the backed team\'s lead and the market\'s chance it wins', () => {
    expect(nbaLiveEdges([row], NOW).signals[0]!.team).toEqual({ lead: -10, winP: 0.3 })
    const away = nbaLiveEdges([{ ...row, trade_signal: 'SELL', target_kalshi_ticker: 'KXNBAGAME-99JAN01AAABBB-AAA' }], NOW).signals[0]!
    expect(away.team!.lead).toBe(10)
    expect(away.team!.winP).toBeCloseTo(0.7)
  })

  it('backs the named team on a cover and the other team on not covering', () => {
    const rung = { ticker: 'KXNBASPREAD-99JAN01AAABBB-AAA8', team: 'AAA', line: 7.5, model_prob: 0.42, market_price: 0.35, edge: 0.07, side: 'COVER', best_edge: true, venue: 'kalshi' }
    expect(nbaSpreadLadder(row, [rung], NOW).signals[0]!.team!.lead).toBe(10)
    expect(nbaSpreadLadder(row, [{ ...rung, side: 'NOT_COVER' }], NOW).signals[0]!.team!.lead).toBe(-10)
    expect(nbaSpreadLadder(row, [{ ...rung, team: 'ZZZ' }], NOW).signals[0]!.team).toEqual({ lead: null, winP: null })
  })

  it('saves the quarter, the score and the favorite on the ticket, and only a lead for a live team play', () => {
    expect(playTags(ml())).toMatchObject({ quarter: 'Q4', lead: -4, teamWinP: 0.5 })
    expect(playTags(ml({ phase: 'pregame', clock: null }))).toMatchObject({ quarter: 'Pregame', lead: null })
    expect(playTags(ml({ lane: 'TOTAL' }))).toMatchObject({ lead: null, teamWinP: null })
  })
})

describe('Results, by score and favorite, with a fix', () => {
  // 30 trades on 30 games, each bought at 40c behind by 12, all lost.
  const lost = (i: number, botId = 'b1'): SettledLike => ({
    botId, botName: botId, gameId: `g${i}`, side: 'yes', venue: 'paper', filledContracts: 10, avgFillC: 40, limitPriceC: 40,
    costUsd: 4, feeUsd: 0, pnlUsd: -4, createdAt: NOW + i,
    play: { sport: 'NBA', lane: 'MONEYLINE', phase: 'live', label: 'PRICE_GAP', hot: false, measured: false, edgePp: 10, ourP: 0.5, quarter: 'Q4', lead: -12, teamWinP: 0.3 } satisfies PlayTags
  })
  const won = (i: number): SettledLike => ({ ...lost(i), gameId: `w${i}`, pnlUsd: 6, play: { ...lost(i).play!, lead: 5, teamWinP: 0.7 } })

  it('breaks results down by the score when bought and by favorite, and points each cut at a fix', () => {
    const r = analyze([...Array.from({ length: 30 }, (_, i) => lost(i, i % 2 ? 'b1' : 'b2')), ...Array.from({ length: 30 }, (_, i) => won(i))])
    const score = r.dimensions.find((d) => d.id === 'score')!
    expect(score.rows.map((x) => x.key).sort()).toEqual(['Down 10 or more', 'Up 1 to 9'])
    const cut = r.recommendations.find((x) => x.segment === 'Down 10 or more')!
    expect(cut.fix).toEqual({ kind: 'maxTrailing', points: 9 })
    expect(cut.botIds.sort()).toEqual(['b1', 'b2'])
    expect(r.recommendations.find((x) => x.segment === 'Underdog')!.fix).toEqual({ kind: 'favoritesOnly' })
    expect(r.recommendations.find((x) => x.kind === 'keep')!.fix).toBeUndefined()
  })

  it('maps every cut to a narrowing fix, and leaves the middle of the band alone', () => {
    expect(fixFor('price', 'Under 30c')).toEqual({ kind: 'priceFloor', c: 30 })
    expect(fixFor('price', 'Over 70c')).toEqual({ kind: 'priceCeiling', c: 70 })
    // A middle bucket would take its neighbour too, so it has no fix.
    expect(fixFor('price', '45 to 55c')).toBeUndefined()
    expect(fixFor('price', '30 to 44c')).toBeUndefined()
    expect(fixFor('edge', 'Under 5pp')).toEqual({ kind: 'minEdge', pp: 5 })
    expect(fixFor('edge', '5 to 8pp')).toBeUndefined()
    expect(fixFor('edge', '12pp and up')).toBeUndefined()
    expect(fixFor('quarter', 'Q1')).toEqual({ kind: 'drop', field: 'quarters', value: 'Q1' })
    expect(fixFor('side', 'YES')).toBeUndefined()
  })
})

describe('one click fixes', () => {
  it('narrows a bot and explains a bot it cannot change', () => {
    const b = bot()
    expect(applyFix(b, { kind: 'maxTrailing', points: 9 }).next!.entry.maxTrailing).toEqual({ Q1: 9, Q2: 9, Q3: 9, Q4: 9 })
    const tight = bot((x) => { x.entry.maxTrailing = { Q1: 5, Q2: null, Q3: 12, Q4: 9 } })
    expect(applyFix(tight, { kind: 'maxTrailing', points: 9 }).next!.entry.maxTrailing).toEqual({ Q1: 5, Q2: 9, Q3: 9, Q4: 9 })
    expect(applyFix(bot((x) => { x.market.sports = ['NBA'] }), { kind: 'drop', field: 'sports', value: 'NBA' }).next).toBeNull()
    expect(applyFix(bot((x) => { x.market.lanes = ['TOTAL'] }), { kind: 'favoritesOnly' }).why).toBe('it trades no moneyline or spread')
    // The score limit can only act on live NBA plays.
    expect(applyFix(bot((x) => { x.market.sports = ['NFL'] }), { kind: 'maxTrailing', points: 9 }).next).toBeNull()
    expect(applyFix(bot((x) => { x.market.phase = 'pregame' }), { kind: 'maxTrailing', points: 9 }).next).toBeNull()
    expect(applyFix(b, { kind: 'priceFloor', c: 30 }).next!.entry.priceBandC).toEqual([30, 75])
    expect(applyFix(b, { kind: 'priceFloor', c: 80 }).next).toBeNull()
    expect(applyFix(b, { kind: 'dropPhase', phase: 'pregame' }).next!.market.phase).toBe('live')
    expect(fixText({ kind: 'maxTrailing', points: 9 })).toBe('Never back a team more than 9 points behind')
  })

  it('refuses a fix that is not one of the known shapes', () => {
    expect(Fix.safeParse({ kind: 'drop', field: 'size', value: 'x' }).success).toBe(false)
    expect(Fix.safeParse({ kind: 'maxTradeUsd', usd: 1000 }).success).toBe(false)
  })

  it('undoes only what the fix moved, keeping anything changed since', () => {
    const before = bot()
    const applied = applyFix(before, { kind: 'favoritesOnly' }).next!
    const since = { ...structuredClone(applied), enabled: false }
    since.entry.minEdgePp = 8
    const back = undoFix(before, since, { kind: 'favoritesOnly' })!
    expect(back.entry.favoritesOnly).toBe(false)
    expect(back.enabled).toBe(false)
    expect(back.entry.minEdgePp).toBe(8)
    // A field the user moved again after the fix is theirs now.
    const moved = structuredClone(applyFix(before, { kind: 'priceFloor', c: 30 }).next!)
    moved.entry.priceBandC = [35, 75]
    expect(undoFix(before, moved, { kind: 'priceFloor', c: 30 })).toBeNull()
  })
})
