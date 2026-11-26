import { describe, expect, it } from 'vitest'
import { draftStrategy } from '../src/main/ai/strategy'
import type { AiProvider } from '../src/main/ai/types'
import { nbaProps } from '../src/main/data/normalize'
import { bidPrice, evaluate, preGates, type GateContext } from '../src/main/rules/gates'
import { kalshiFee } from '../src/main/rules/fees'
import { paperFill } from '../src/main/venues/paper'
import { applyFix } from '../src/shared/fixes'
import { apiTicketPicks, gameCodeOf } from '../src/shared/combos'
import { fixFor } from '../src/shared/results'
import { DEFAULT_ACCOUNT, defaultBot } from '../src/shared/ruleset'
import { BotSettings } from '../src/shared/schema'
import type { Signal } from '../src/shared/signal'
import { STARTERS } from '../src/shared/starters'

const ctx = (over: Partial<GateContext> = {}): GateContext => ({ now: 0, venues: { paper: { balanceUsd: 1000, equityUsd: 1000 }, kalshi: { balanceUsd: 200, equityUsd: 200 } }, keyed: ['kalshi'], openMarketKeys: new Set(), gamePositions: [], gameExposureUsd: 0, accountOpenExposureUsd: 0, botDailyPnlUsd: 0, accountDailyPnlUsd: 0, botTradesToday: 0, ...over })

// Made up: AAA at BBB, three AAA players with props.
const game = () => [{
  game_id: 'g1', home_team: 'BBB', away_team: 'AAA', period: 2, clock: '6:00', is_pregame: false,
  players: [
    { player_name: 'Star One', team: 'AAA', availability: 'ACTIVE', projection: 28, market_line: 24.5, pts_market_id: 'KXNBAPTS-99JAN01AAABBB-S1', pts_venue: 'kalshi', likelihood_over: 0.7, pts_live_price: 0.6, pts_live_edge_pp: 10, current_points: 14 },
    { player_name: 'Role Two', team: 'AAA', availability: 'ACTIVE', projection: 6, market_line: 4.5, pts_market_id: 'KXNBAPTS-99JAN01AAABBB-R2', pts_venue: 'kalshi', likelihood_over: 0.7, pts_live_price: 0.6, pts_live_edge_pp: 10, current_points: 2 },
    { player_name: 'Wing Three', team: 'AAA', availability: 'ACTIVE', projection: 15, market_line: 12.5, pts_market_id: 'KXNBAPTS-99JAN01AAABBB-W3', pts_venue: 'kalshi', likelihood_over: 0.7, pts_live_price: 0.6, pts_live_edge_pp: 10, current_points: 6 }
  ]
}]

describe('props on the game\'s top players only', () => {
  it('ranks each player in his game by our points projection', () => {
    const ranks = Object.fromEntries(nbaProps(game(), 0).signals.map((s) => [s.title.split(' ')[3], s.prop?.rank]))
    expect(ranks).toEqual({ Star: 1, Role: 3, Wing: 2 })
  })

  it('a bot set to the top 2 skips the role player and takes the stars', () => {
    const b = defaultBot('p', 'Props'); b.enabled = true; b.market.sports = ['NBA']; b.market.lanes = ['PROP']; b.market.propTopPlayers = 2
    const verdicts = nbaProps(game(), 0).signals.map((s) => preGates(s, b, DEFAULT_ACCOUNT, ctx())?.gate ?? 'pass')
    expect(verdicts).toEqual(['pass', 'prop_not_top', 'pass'])
  })

  it('a losing band of lower ranked players has a one click fix', () => {
    expect(fixFor('propRank', '7th to 10th')).toEqual({ kind: 'propTop', n: 6 })
    const b = defaultBot('p', 'Props'); b.market.lanes = ['PROP']
    expect(applyFix(b, { kind: 'propTop', n: 6 }).next!.market.propTopPlayers).toBe(6)
  })
})

describe('bids below the ask when a play is overpriced', () => {
  const bidder = () => { const b = defaultBot('b', 'Bidder'); b.enabled = true; b.market.lanes = ['PROP']; b.market.sports = ['NBA']; b.entry.minEdgePp = 3; b.entry.minEvCents = 0.5; b.entry.priceBandC = [40, 92]; b.entry.orderType = 'bid'; b.entry.bidRestS = 300; return b }
  // Our honest 60% on a prop the ask has at 62c: no edge to take.
  const prop = (): Signal => ({
    key: 'nba:g1:PROP:KXNBAPTS-99JAN01AAABBB-S1', sport: 'NBA', lane: 'PROP', phase: 'live', gameId: 'g1', title: 'AAA @ BBB Star One over 24.5 points',
    signalType: 'BUY_OVER', explicitSide: 'yes', ourP: 0.6, marketP: 0.62, edgePp: -2, label: 'PRICE_GAP', kelly: null, trigger: false, measured: false,
    clock: { period: 2, secondsRemaining: 2000, overtime: false }, quotes: [{ venue: 'kalshi', contract: 'KXNBAPTS-99JAN01AAABBB-S1', side: 'yes', ask: 0.62, askSize: 100, priceAgeS: 2 }],
    why: null, receivedAt: 0
  })

  it('works out the highest bid that clears the edge and the EV after the resting fee', () => {
    const b = bidPrice(0.6, 62, bidder())!
    expect(b.c).toBe(57)
    expect(b.ev).toBeCloseTo((0.57 + 0.03 * 0.5 - 0.57 - kalshiFee(0.57, 1, false)) * 100)
  })

  it('places a resting bid at that price instead of skipping, with its own wait', () => {
    const d = evaluate(prop(), bidder(), DEFAULT_ACCOUNT, ctx())
    expect(d).toMatchObject({ kind: 'trade', limitPriceC: 57, rest: true, autoCancelS: 300 })
    expect(d.kind === 'trade' && d.audit.join(' ')).toMatch(/is above the play's value; bid 57c/)
    // The same bot set to skip leaves it alone.
    const skipper = bidder(); skipper.entry.orderType = 'take'
    expect(evaluate(prop(), skipper, DEFAULT_ACCOUNT, ctx())).toMatchObject({ kind: 'skip', gate: 'min_edge' })
  })

  it('a new bid after one that expired is a new order', () => {
    const a = evaluate(prop(), bidder(), DEFAULT_ACCOUNT, ctx({ attemptsToday: 0 }))
    const b = evaluate(prop(), bidder(), DEFAULT_ACCOUNT, ctx({ attemptsToday: 1 }))
    if (a.kind !== 'trade' || b.kind !== 'trade') throw new Error('expected trades')
    expect(a.idempotencyKey).not.toBe(b.idempotencyKey)
  })

  it('paper never fills a bid the ask has not reached', () => {
    expect(paperFill({ contracts: 10, limitPriceC: 57, priceSource: 'kalshi' }, { ask: 0.62, askSize: 100, priceAgeS: 1 })).toMatchObject({ filledContracts: 0, status: 'cancelled' })
  })
})

describe('every pregame pick', () => {
  const starter = () => BotSettings.parse(STARTERS.find((s) => s.key === 'nba-pick-pregame')!.build())
  const pick = (over: Partial<Signal>): Signal => ({
    key: 'nba:g2:MONEYLINE:home', sport: 'NBA', lane: 'MONEYLINE', phase: 'pregame', gameId: 'g2', title: 'AAA @ BBB BBB to win',
    signalType: 'BUY_HOME', explicitSide: 'yes', ourP: 0.56, marketP: 0.6, edgePp: -4, label: 'PRICE_GAP', kelly: null, trigger: false, measured: false,
    clock: null, quotes: [{ venue: 'kalshi', contract: 'KXNBAGAME-99JAN01AAABBB-BBB', side: 'yes', ask: 0.6, askSize: 100, priceAgeS: 5 }], why: null, receivedAt: 0, startsAt: 10 * 60_000, pickOnly: true, ...over
  })

  it('trades our pick whatever the chance or the price, one a game, a flat $5', () => {
    const b = { ...starter(), enabled: true }
    expect(b).toMatchObject({ market: { phase: 'pregame' }, entry: { basis: 'pick', pickGapPp: null, priceBandC: [1, 99] }, size: { sizing: 'flat', maxTradeUsd: 5 }, guards: { oneEntryPerGame: true } })
    expect(evaluate(pick({}), b, DEFAULT_ACCOUNT, ctx())).toMatchObject({ kind: 'trade', limitPriceC: 60 })
    expect(evaluate(pick({ ourP: 0.93, quotes: [{ venue: 'kalshi', contract: 'KXNBAGAME-99JAN01AAABBB-BBB', side: 'yes', ask: 0.95, askSize: 100, priceAgeS: 5 }] }), b, DEFAULT_ACCOUNT, ctx())).toMatchObject({ kind: 'trade', limitPriceC: 95 })
    expect(evaluate(pick({}), b, DEFAULT_ACCOUNT, ctx({ gameEntriesToday: 1 }))).toMatchObject({ gate: 'game_entered' })
  })

  it('the honest chance never moves the pick to the other team', () => {
    const b = { ...starter(), enabled: true }
    expect(evaluate(pick({ ourP: 0.48, rawP: 0.56, honestNotes: ['your favorite moneyline plays won less'] }), b, DEFAULT_ACCOUNT, ctx()).kind).toBe('trade')
  })
})

describe("the API's NBA tickets as combos", () => {
  // Made up: tonight's tickets, our play (two legs) and three legs.
  const tip = new Date(Date.UTC(2099, 0, 1, 0, 30)).toISOString()
  const leg = (team: string, opp: string, ourP: number, price: number, tk: string) => ({ team, opp, our_prob: ourP, price, ticker: `KXNBAGAME-99JAN01${tk}-${team}`, tip })
  const body = { date: '2099-01-01', locked: true, tickets: [
    { label: 'our play', picks: [leg('AAA', 'BBB', 0.8, 0.74, 'AAABBB'), leg('CCC', 'DDD', 0.78, 0.72, 'CCCDDD')], p_all: 0.624, market_p_all: 0.5328 },
    { label: 'three legs', picks: [leg('AAA', 'BBB', 0.8, 0.74, 'AAABBB'), leg('CCC', 'DDD', 0.78, 0.72, 'CCCDDD'), leg('EEE', 'FFF', 0.75, 0.7, 'EEEFFF')], p_all: 0.468, market_p_all: 0.373 }
  ] }

  it('turns each locked ticket into a combo with its own legs and our chance', () => {
    const picks = apiTicketPicks(body, Date.UTC(2098, 0, 1))
    expect(picks).toHaveLength(2)
    expect(picks[0]).toMatchObject({ chance: 0.624, legsPriceC: 53.28, source: 'lazy_edge' })
    expect(picks[1]!.legs.map((l) => l.contract)).toEqual(['KXNBAGAME-99JAN01AAABBB-AAA', 'KXNBAGAME-99JAN01CCCDDD-CCC', 'KXNBAGAME-99JAN01EEEFFF-EEE'])
  })

  it('waits for the lock, and drops a ticket once a game tips or a leg has no ticker', () => {
    expect(apiTicketPicks({ ...body, locked: false }, Date.UTC(2098, 0, 1))).toEqual([])
    expect(apiTicketPicks(body, Date.UTC(2099, 0, 1, 1))).toEqual([])
    const broken = { ...body, tickets: [{ ...body.tickets[0], picks: [{ ...body.tickets[0]!.picks[0], ticker: '' }, body.tickets[0]!.picks[1]] }] }
    expect(apiTicketPicks(broken, Date.UTC(2098, 0, 1))).toEqual([])
  })

  it('skips a ticket with a player prop leg, and one with two picks on one game (2026-11-25)', () => {
    // 24 November: BOS to win plus Jayson Tatum 6+ rebounds, one game, was bought as AAA over BBB twice.
    const prop = { team: 'AAA', opp: 'BBB', our_prob: 0.797, price: 0.77, ticker: 'KXNBAREB-99JAN01AAABBB-AAAPONE0-6', tip }
    const withProp = { ...body, tickets: [{ label: 'our play', picks: [leg('AAA', 'BBB', 0.819, 0.79, 'AAABBB'), prop], p_all: 0.653, market_p_all: 0.6083 }] }
    expect(apiTicketPicks(withProp, Date.UTC(2098, 0, 1))).toEqual([])
    const sameGame = { ...body, tickets: [{ label: 'our play', picks: [leg('AAA', 'BBB', 0.8, 0.74, 'AAABBB'), { ...leg('BBB', 'AAA', 0.3, 0.27, 'AAABBB') }], p_all: 0.24, market_p_all: 0.2 }] }
    expect(apiTicketPicks(sameGame, Date.UTC(2098, 0, 1))).toEqual([])
    expect(gameCodeOf('KXNBAREB-26NOV24BOSWAS-BOSJTATUM0-6')).toBe(gameCodeOf('KXNBAGAME-26NOV24BOSWAS-BOS'))
  })

  it('the starter buys only the API tickets, a flat $5, three a night', () => {
    const b = BotSettings.parse(STARTERS.find((s) => s.key === 'nba-tickets')!.build())
    expect(b).toMatchObject({ market: { lanes: ['COMBO'] }, combo: { source: 'api', maxPerDay: 3, only: true }, size: { sizing: 'flat', maxTradeUsd: 5 } })
  })
})

// The AI box recommends with the math, and can set the new fields.
const answering = (over: Record<string, unknown>): AiProvider => ({
  id: 'anthropic', configured: () => true, models: async () => [], test: async () => ({ ok: true, detail: '' }),
  json: async <T,>(): Promise<T> => ({
    name: 'NBA player props', sports: ['NBA'], lanes: ['PROP'], phase: 'live', quarters: ['Q2', 'Q3', 'Q4'], labels: ['PRICE_GAP'], venues: [],
    minEdgePp: 5, minChancePregamePct: 60, minChanceQ1Pct: 60, minChanceQ2Pct: 60, minChanceQ3Pct: 60, minChanceQ4Pct: 60,
    maxTrailingPoints: -1, favoritesOnly: false, buyOurPick: false, flatSize: true, pickGapPp: -1, exitMode: 'hold', exitTargetC: 10,
    minEvCents: 0.5, priceBandLowC: 40, priceBandHighC: 92, maxPriceAgeS: 60, requireTrigger: false, measuredOnly: false,
    kellyMultiplier: 0.25, maxTradeUsd: 5, minTradeUsd: 1, maxContracts: 100, maxGameEquityPct: 0.35, noEntryFinalS: 120, noOvertime: true,
    maxDailyDrawdownUsd: 50, maxTradesPerDay: 40, propTopPlayers: 10, bidWhenOverpriced: true,
    explanation: 'Props now only on the top 10 players, bidding when overpriced.', recommendation: 'At 60% the break even is about 58c.', unsupported: [], ...over
  }) as T
})

describe('the AI box sets top players and bids, and says the math', () => {
  it('maps the new fields onto the open bot and returns its recommendation', async () => {
    const b = BotSettings.parse(STARTERS.find((s) => s.key === 'nba-props')!.build())
    b.market.propTopPlayers = null
    const out = await draftStrategy(answering({}), 'top 10 players only, and bid when it is overpriced', '', undefined, b)
    expect(out.bot.market.propTopPlayers).toBe(10)
    expect(out.bot.entry.orderType).toBe('bid')
    expect(out.recommendation).toMatch(/break even is about 58c/)
    expect(out.changes.map((c) => c.field)).toEqual(expect.arrayContaining(['market.propTopPlayers', 'entry.orderType']))
  })
})
