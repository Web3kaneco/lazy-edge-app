// Starter bots, preloaded once on first launch so a new user has several
// ready to switch on. Each is the measured defaults with a few settings moved,
// and only settings the engine already enforces. Every one ships switched off
// and in paper: a starting point to judge on the Results screen, not a claim
// that it wins.
import { defaultBot } from './ruleset'
import type { BotSettings } from './schema'
import { diffSettings, type Change } from './share'

export interface Starter {
  key: string
  name: string
  summary: string
  build: () => BotSettings
}

const make = (key: string, name: string, change: (b: BotSettings) => void): (() => BotSettings) => () => {
  const b = defaultBot(`starter-${key}`, name)
  change(b)
  return b
}

export const STARTERS: Starter[] = [
  {
    key: 'core',
    name: 'Measured Defaults',
    summary: 'NBA and NFL moneylines, spreads and totals, every setting at its measured default. The baseline to compare the others against.',
    build: make('core', 'Measured Defaults', () => {})
  },
  {
    key: 'measured',
    name: 'Measured Only',
    summary: 'Only edges with a graded track record, a higher edge bar and half the trade size. Fewer trades, each backed by a measured record.',
    build: make('measured', 'Measured Only', (b) => {
      b.market.labels = ['MEASURED']
      b.entry.measuredOnly = true
      b.entry.minEdgePp = 6
      b.size.maxTradeUsd = 5
      b.guards.maxTradesPerDay = 20
    })
  },
  {
    key: 'nba-live',
    name: 'NBA In Game Sides',
    summary: 'In game NBA moneylines and spreads. Refuses any price older than a minute and stops entering two minutes before the end.',
    build: make('nba-live', 'NBA In Game Sides', (b) => {
      b.market.sports = ['NBA']
      b.market.lanes = ['MONEYLINE', 'SPREAD']
      b.market.phase = 'live'
      b.entry.maxPriceAgeS = 60
      b.guards.noEntryFinalS = 120
      b.pollS = 10
    })
  },
  {
    key: 'nfl-pregame',
    name: 'NFL Pregame',
    summary: 'NFL moneylines, spreads and totals before kickoff, checked once a minute. No in game trading.',
    build: make('nfl-pregame', 'NFL Pregame', (b) => {
      b.market.sports = ['NFL']
      b.market.phase = 'pregame'
      b.pollS = 60
    })
  },
  {
    key: 'nfl-hot',
    name: 'NFL In Game Sides',
    summary: 'In game NFL plays, and only when a game event fires the play. Quiet most of a game by design.',
    build: make('nfl-hot', 'NFL In Game Sides', (b) => {
      b.market.sports = ['NFL']
      b.market.phase = 'live'
      b.entry.requireTrigger = true
      b.entry.maxPriceAgeS = 60
      b.pollS = 10
    })
  },
  {
    key: 'mlb-pregame',
    name: 'MLB Pregame',
    summary: 'MLB moneylines and totals before first pitch, checked once a minute.',
    build: make('mlb-pregame', 'MLB Pregame', (b) => {
      b.market.sports = ['MLB']
      b.market.lanes = ['MONEYLINE', 'TOTAL']
      b.market.phase = 'pregame'
      b.pollS = 60
    })
  },
  {
    key: 'pregame',
    name: 'NBA Pregame',
    summary: 'NBA and NFL moneylines, spreads and totals before the game starts, and nothing once it is under way. Checked once a minute.',
    // No MLB: its feed carries a date but no first pitch time or status, so
    // nothing can prove an MLB row is still pregame.
    build: make('pregame', 'NBA Pregame', (b) => {
      b.market.sports = ['NBA', 'NFL']
      b.market.phase = 'pregame'
      b.pollS = 60
    })
  },
  {
    key: 'nba-props',
    name: 'NBA Props',
    summary: "Props trending to hit: points, rebounds and assists in the third and fourth quarters only, for each game's ten leading players, when our chance the prop hits is 60% or more and the price is 3 to 15 points under that chance. Unders only at 5 to 7 points under, and no rebound unders. A flat $5 a trade, held to settlement.",
    // Likely props are priced high, so the band reaches up to 92c and the edge
    // bar sits lower than a moneyline's. In game only at 60%: the plan is
    // props on pace to hit, priced right (2026-11-20). On 2026-11-20 a
    // copy with pregame and Q1 on spent 39 of its 40 trades before the second
    // quarter. The rules the owner's own live copy has run since 24 November
    // (2026-11-26): Q3 and Q4 only, the top ten players, edge 3 to 15, unders
    // only at 5 to 7, no rebound unders. Graded live 24 to 25 November: 58
    // trades, 45 won (78%) against our 70%, +$46.68 on $252.94.
    build: make('nba-props', 'NBA Props', (b) => {
      b.market.sports = ['NBA']
      b.market.lanes = ['PROP']
      b.market.phase = 'live'
      b.market.quarters = ['Q3', 'Q4']
      b.market.labels = ['PRICE_GAP']
      b.market.propTopPlayers = 10
      b.market.propSidesOff = ['REB under']
      b.size.sizing = 'flat'
      b.size.maxTradeUsd = 5
      b.entry.minChancePct = { pregame: 60, Q1: 60, Q2: 60, Q3: 60, Q4: 60 }
      b.entry.minEdgePp = 3
      b.entry.maxEdgePp = 15
      b.entry.underEdgePp = [5, 7]
      b.entry.priceBandC = [40, 92]
      b.entry.maxPriceAgeS = 60
      b.guards.noEntryFinalS = 120
    })
  },
  {
    key: 'nba-scalp',
    name: 'NBA Scalp',
    summary: 'In game NBA moneylines, spreads and props. Every fill rests a sell 10 cents higher at once; once it sells, the bot may take either side of the game again.',
    build: make('nba-scalp', 'NBA Scalp', (b) => {
      b.market.sports = ['NBA']
      b.market.lanes = ['MONEYLINE', 'SPREAD', 'PROP']
      b.market.phase = 'live'
      b.entry.maxPriceAgeS = 60
      b.guards.noEntryFinalS = 120
      b.exit = { ...b.exit, mode: 'limit', targetC: 10 }
      b.pollS = 10
    })
  },
  {
    key: 'nba-combos',
    name: 'NBA Combos',
    summary: 'Ties two NBA plays from different games into one Kalshi combo when our chance that both hit beats a real quote from Kalshi\'s market makers. Takes nothing alone. Needs a Kalshi key, even on paper.',
    build: make('nba-combos', 'NBA Combos', (b) => {
      b.market.sports = ['NBA']
      b.market.lanes = ['MONEYLINE', 'SPREAD', 'PROP', 'COMBO']
      b.market.labels = ['PRICE_GAP']
      b.entry.priceBandC = [40, 92]
      b.combo = { legs: 2, maxPerDay: 5, only: true, source: 'built', apiLegs: [2, 3, 4] }
    })
  },
  // 0.9.0, from 169 graded NBA games and NFL weeks 1 to 8 (2026-11-17). Each
  // is a test next to the bot it changes, not a proven winner.
  {
    key: 'kaneco',
    name: "Kaneco's Bot",
    summary: 'Backs our own confident pick and never chases the edge, which mostly points at underdogs we expect to lose and lost 7.5c a contract in the NFL over the season. NBA and NFL moneylines, before the game and in play: only the team our number has winning, at 70% or more, priced at least 3 points under our number and no higher than 92c. One entry a game, held to the final, the same $5 every time, and no totals. Graded so far: NFL live our pick at 70% priced under our number made 4.1c a contract over 144 games, inside the noise of about 3.5c, and NBA our pick made 6c to 14c a contract over about 170 games. Promising, not proven: run it in paper for a few weeks of nights.',
    build: make('kaneco', "Kaneco's Bot", (b) => {
      b.market.sports = ['NBA', 'NFL']
      b.market.lanes = ['MONEYLINE']
      b.market.phase = 'both'
      b.market.labels = ['PRICE_GAP', 'RATING_Q', 'LEAN', 'ROLE_Q', 'MEASURED']
      b.entry.basis = 'pick'
      b.entry.pickGapPp = 3
      b.entry.minChancePct = { pregame: 70, Q1: 70, Q2: 70, Q3: 70, Q4: 70 }
      b.entry.priceBandC = [25, 92]
      b.entry.maxPriceAgeS = 60
      b.size.sizing = 'flat'
      b.size.maxTradeUsd = 5
      b.exit.mode = 'hold'
      // One entry a game: one position a contract, never the other side, and
      // moneylines only, so a pregame entry is not added to in play.
      b.guards.onePositionPerMarket = true
      b.guards.noOpposingBets = true
      b.guards.oneEntryPerGame = true
      b.guards.noEntryFinalS = 120
      b.pollS = 10
    })
  },
  {
    key: 'nba-q4-catchup',
    name: 'NBA Q4 Catchup',
    summary: 'A slow catch up trade, not a bet on who wins. In the 4th quarter, when our number and the market are 8 points or more apart and the book is no more than 3c wide, it buys at the ask, sells at the bid 15 minutes later or at the end of the quarter, and never sells early because the gap closed. One entry a game, a flat $5. On c2 games the 4th quarter price moved toward our number by about 8c over 15 minutes before costs, but the held trade has 9 measured trades behind it, so this is a candidate rule to prove in paper. The 2nd quarter measured the same way more weakly; add Q2 to test it.',
    build: make('nba-q4-catchup', 'NBA Q4 Catchup', (b) => {
      b.market.sports = ['NBA']
      b.market.lanes = ['MONEYLINE']
      b.market.phase = 'live'
      b.market.quarters = ['Q4']
      b.entry.minEdgePp = 8
      b.entry.maxSpreadC = 3
      b.entry.maxPriceAgeS = 60
      b.entry.priceBandC = [10, 90]
      b.size.sizing = 'flat'
      b.size.maxTradeUsd = 5
      b.exit = { mode: 'time', targetC: 10, afterMin: 15, atQuarterEnd: true }
      b.guards.onePositionPerMarket = true
      b.guards.noOpposingBets = true
      b.guards.oneEntryPerGame = true
      b.guards.noEntryFinalS = 120
      b.pollS = 10
    })
  },
  {
    key: 'nba-tickets',
    name: 'NBA API Combos',
    summary: "The API's own NBA tickets, bought as they are: each night's our play, three legs and four legs, our highest win chances built into Kalshi combos. Bought once each ticket locks, 20 minutes before the first tip, when a real quote from Kalshi's market makers is at or under our chance that every leg wins, after the fee. A flat $5 a ticket. Nothing else to set. Needs a Kalshi key, even on paper.",
    build: make('nba-tickets', 'NBA API Combos', (b) => {
      b.market.sports = ['NBA']
      b.market.lanes = ['COMBO']
      b.market.phase = 'pregame'
      b.combo = { legs: 4, maxPerDay: 3, only: true, source: 'api', apiLegs: [2, 3, 4] }
      b.size.sizing = 'flat'
      b.size.maxTradeUsd = 5
      b.pollS = 60
    })
  },
  {
    key: 'nfl-slips',
    name: 'NFL API Slips',
    summary: "The API's own NFL slips and same-game pairs, mapped to Kalshi's player prop markets and bought as Kalshi combos before kickoff. Each leg takes the Kalshi rung at or easier than the API's line, never a harder one. Slips are ranked by our chance over the legs bought one by one, and the best are bought up to five a day, one combo a day per player, a flat $5 each, when a real quote is at or under our chance. A slip with a leg Kalshi does not list near the API's line is left out. Needs a Kalshi key, even on paper.",
    build: make('nfl-slips', 'NFL API Slips', (b) => {
      b.market.sports = ['NFL']
      b.market.lanes = ['COMBO']
      b.market.phase = 'pregame'
      b.combo = { legs: 4, maxPerDay: 5, only: true, source: 'api', apiLegs: [2, 3, 4] }
      b.size.sizing = 'flat'
      b.size.maxTradeUsd = 5
      b.pollS = 60
    })
  },
  {
    key: 'nba-pick-live',
    name: 'NBA Pick In Game',
    summary: 'In game NBA moneylines on the team our number has winning at 70% or more, even when the price is above our chance, up to 92c. A flat amount a trade, held to settlement. Our picks have won more often than we said on graded games, which is not yet proof.',
    build: make('nba-pick-live', 'NBA Pick In Game', (b) => {
      b.market.sports = ['NBA']
      b.market.lanes = ['MONEYLINE']
      b.market.phase = 'live'
      b.entry.basis = 'pick'
      b.entry.minChancePct = { pregame: 70, Q1: 70, Q2: 70, Q3: 70, Q4: 70 }
      b.entry.priceBandC = [25, 92]
      b.entry.maxPriceAgeS = 60
      b.size.sizing = 'flat'
      b.size.maxTradeUsd = 5
      b.guards.noEntryFinalS = 120
      b.pollS = 10
    })
  },
  {
    key: 'nba-pick-pregame',
    name: 'NBA Pick Pregame',
    summary: "Every pregame pick: before the tip, one trade on each NBA game on the team our number has winning, whatever the chance or the price, a flat $5 held to settlement. Nothing else to set. A pick priced near 90c risks almost the whole $5 to win a little; the Board's risk line shows it.",
    // 2026-11-21: "I just want a trade on every pregame pick the system
    // has." No minimum chance, no gap, the whole price range, one per game.
    build: make('nba-pick-pregame', 'NBA Pick Pregame', (b) => {
      b.market.sports = ['NBA']
      b.market.lanes = ['MONEYLINE']
      b.market.phase = 'pregame'
      b.market.labels = ['PRICE_GAP', 'MEASURED', 'LEAN', 'RATING_Q', 'ROLE_Q', 'TAIL_RUNG']
      b.entry.basis = 'pick'
      b.entry.pickGapPp = null
      b.entry.minChancePct = { pregame: 0, Q1: 0, Q2: 0, Q3: 0, Q4: 0 }
      b.entry.priceBandC = [1, 99]
      b.entry.maxPriceAgeS = 180
      b.size.sizing = 'flat'
      b.size.maxTradeUsd = 5
      b.guards.oneEntryPerGame = true
      b.pollS = 60
    })
  },
  {
    key: 'nba-live-70',
    name: 'NBA In Game Sides 70%',
    summary: 'The NBA live bot with one change: it takes only plays our number gives 70% or more to pay out. Run it next to NBA live to see what the floor is worth.',
    build: make('nba-live-70', 'NBA In Game Sides 70%', (b) => {
      b.market.sports = ['NBA']
      b.market.lanes = ['MONEYLINE', 'SPREAD']
      b.market.phase = 'live'
      b.entry.maxPriceAgeS = 60
      b.entry.minChancePct = { pregame: 70, Q1: 70, Q2: 70, Q3: 70, Q4: 70 }
      b.guards.noEntryFinalS = 120
      b.pollS = 10
    })
  },
  {
    key: 'nfl-pregame-sides',
    name: 'NFL Pregame Sides',
    summary: 'The NFL pregame bot without totals, which lost on graded weeks, and with the edge bar raised to 10. Run it next to NFL pregame.',
    build: make('nfl-pregame-sides', 'NFL Pregame Sides', (b) => {
      b.market.sports = ['NFL']
      b.market.lanes = ['MONEYLINE', 'SPREAD']
      b.market.phase = 'pregame'
      b.entry.minEdgePp = 10
      b.pollS = 60
    })
  },
  {
    key: 'nfl-hot-60',
    name: 'NFL In Game Sides 60c',
    summary: 'The NFL hot plays bot with the price capped at 60c, cutting the 60 to 75c band that lost the most on graded weeks. Expect about break even at best. Run it next to NFL hot plays.',
    build: make('nfl-hot-60', 'NFL In Game Sides 60c', (b) => {
      b.market.sports = ['NFL']
      b.market.phase = 'live'
      b.entry.requireTrigger = true
      b.entry.maxPriceAgeS = 60
      b.entry.priceBandC = [25, 60]
      b.pollS = 10
    })
  },
  {
    key: 'explorer',
    name: 'Explorer',
    summary: 'Takes every tradeable label at a lower edge bar and $2 a trade at most, so Results can show which labels and lanes are worth keeping.',
    build: make('explorer', 'Explorer', (b) => {
      b.market.labels = ['PRICE_GAP', 'RATING_Q', 'LEAN', 'TAIL_RUNG', 'ROLE_Q', 'MEASURED']
      b.entry.minEdgePp = 3
      b.entry.minEvCents = 0
      b.size.maxTradeUsd = 2
      b.guards.maxTradesPerDay = 60
    })
  }
]

export const starterOf = (id: string): Starter | undefined => STARTERS.find((s) => `starter-${s.key}` === id)

// Starter updates (2026-11-20): when a version ships better starter
// settings, a user's copy takes them, keeping only who owns it and whether it
// runs: its name, on or off, and paper or live.
// Paper in the venues means nothing since 0.9.2 (shared/venues.ts), so a copy
// saved with it is not a change.
const strategyOf = (b: BotSettings): Omit<BotSettings, 'id' | 'name' | 'enabled' | 'mode'> => {
  const { id: _i, name: _n, enabled: _e, mode: _m, ...rest } = b
  return { ...rest, market: { ...rest.market, venues: rest.market.venues.filter((v) => v !== 'paper') } }
}

// Exactly what each starter changed, by version (2026-11-21: an update
// offered to undo his own settings because it compared his bot with the whole
// starter). An update offers only the settings listed for the version the
// user's copy has not yet seen; everything else the user set stays as it is.
// Money is never listed: an update never changes size, sizing, the loss stop
// or venues. A starter with no entry has never changed (version 1).
export const STARTER_UPDATES: Record<string, { version: number; fields: string[] }> = {
  // 0.9.2: in game only, the 2nd to 4th quarters, 60% or more to hit.
  'nba-props': { version: 2, fields: ['market.phase', 'market.quarters', 'entry.minChancePct'] },
  // 0.9.2: every pregame pick, whatever the chance or the price, one a game.
  'nba-pick-pregame': { version: 2, fields: ['market.labels', 'entry.pickGapPp', 'entry.minChancePct', 'entry.priceBandC', 'entry.maxPriceAgeS', 'guards.oneEntryPerGame'] }
}
export const starterVersion = (key: string): number => STARTER_UPDATES[key]?.version ?? 1

// Money and venues: the user's own, kept through any update or reset.
const MONEY = /^(size\.|guards\.maxDailyDrawdownUsd$|market\.venues$)/
const inFields = (path: string, fields: string[]): boolean => fields.some((f) => path === f || path.startsWith(`${f}.`))

const getPath = (o: unknown, path: string): unknown => path.split('.').reduce<unknown>((v, k) => (v && typeof v === 'object' ? (v as Record<string, unknown>)[k] : undefined), o)
function setPath(o: Record<string, unknown>, path: string, value: unknown): void {
  const keys = path.split('.')
  let at = o
  for (const k of keys.slice(0, -1)) at = (at[k] ??= {}) as Record<string, unknown>
  at[keys[keys.length - 1]!] = structuredClone(value)
}

// What this version's update would change on the user's copy: only the
// listed settings, and only where the copy differs from the new starter.
export const starterUpdate = (mine: BotSettings, starter: BotSettings, key: string): Change[] => {
  const fields = STARTER_UPDATES[key]?.fields ?? []
  return diffSettings(strategyOf(mine), strategyOf(starter)).filter((c) => inFields(c.field, fields) && !MONEY.test(c.field))
}

// The user's copy with only this version's listed settings taken from the
// new starter.
export function withStarterUpdate(mine: BotSettings, starter: BotSettings, key: string): BotSettings {
  const next = structuredClone(mine) as unknown as Record<string, unknown>
  for (const f of STARTER_UPDATES[key]?.fields ?? []) if (!MONEY.test(f)) setPath(next, f, getPath(starter, f))
  return next as unknown as BotSettings
}

// Everything a reset to the starter would change, money left out.
export const starterChanges = (mine: BotSettings, starter: BotSettings): Change[] =>
  diffSettings(strategyOf(mine), strategyOf(starter)).filter((c) => !MONEY.test(c.field))

// A reset: the starter's strategy, with the user's name, on or off, paper or
// live, money and venues kept.
export const withStarter = (mine: BotSettings, starter: BotSettings): BotSettings => ({
  ...structuredClone(starter), id: mine.id, name: mine.name, enabled: mine.enabled, mode: mine.mode,
  size: structuredClone(mine.size),
  market: { ...structuredClone(starter.market), venues: mine.market.venues },
  guards: { ...structuredClone(starter.guards), maxDailyDrawdownUsd: mine.guards.maxDailyDrawdownUsd }
})

// The same text for the same strategy whatever order its keys or name lists
// were saved in, so a version can tell whether a starter really changed.
export function starterFingerprint(b: BotSettings): string {
  const canon = (v: unknown): unknown =>
    Array.isArray(v) ? (v.every((x) => typeof x === 'string') ? [...v].sort() : v.map(canon))
      : v && typeof v === 'object' ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, canon((v as Record<string, unknown>)[k])]))
        : v
  return JSON.stringify(canon(strategyOf(b)))
}
