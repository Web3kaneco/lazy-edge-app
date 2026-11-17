// Starter bots, preloaded once on first launch so a new user has several
// ready to switch on. Each is the measured defaults with a few settings moved,
// and only settings the engine already enforces. Every one ships switched off
// and in paper: a starting point to judge on the Results screen, not a claim
// that it wins.
import { defaultBot } from './ruleset'
import type { BotSettings } from './schema'

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
    name: 'Measured defaults',
    summary: 'NBA and NFL moneylines, spreads and totals, every setting at its measured default. The baseline to compare the others against.',
    build: make('core', 'Measured defaults', () => {})
  },
  {
    key: 'measured',
    name: 'Measured edges only',
    summary: 'Only edges with a graded track record, a higher edge bar and half the trade size. Fewer trades, each backed by a measured record.',
    build: make('measured', 'Measured edges only', (b) => {
      b.market.labels = ['MEASURED']
      b.entry.measuredOnly = true
      b.entry.minEdgePp = 6
      b.size.maxTradeUsd = 5
      b.guards.maxTradesPerDay = 20
    })
  },
  {
    key: 'nba-live',
    name: 'NBA live',
    summary: 'In game NBA moneylines and spreads. Refuses any price older than a minute and stops entering two minutes before the end.',
    build: make('nba-live', 'NBA live', (b) => {
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
    name: 'NFL pregame',
    summary: 'NFL moneylines, spreads and totals before kickoff, checked once a minute. No in game trading.',
    build: make('nfl-pregame', 'NFL pregame', (b) => {
      b.market.sports = ['NFL']
      b.market.phase = 'pregame'
      b.pollS = 60
    })
  },
  {
    key: 'nfl-hot',
    name: 'NFL hot plays',
    summary: 'In game NFL plays, and only when a game event fires the play. Quiet most of a game by design.',
    build: make('nfl-hot', 'NFL hot plays', (b) => {
      b.market.sports = ['NFL']
      b.market.phase = 'live'
      b.entry.requireTrigger = true
      b.entry.maxPriceAgeS = 60
      b.pollS = 10
    })
  },
  {
    key: 'mlb-pregame',
    name: 'MLB pregame',
    summary: 'MLB moneylines and totals before first pitch, checked once a minute.',
    build: make('mlb-pregame', 'MLB pregame', (b) => {
      b.market.sports = ['MLB']
      b.market.lanes = ['MONEYLINE', 'TOTAL']
      b.market.phase = 'pregame'
      b.pollS = 60
    })
  },
  {
    key: 'pregame',
    name: 'Pregame only',
    summary: 'NBA and NFL moneylines, spreads and totals before the game starts, and nothing once it is under way. Checked once a minute.',
    // No MLB: its feed carries a date but no first pitch time or status, so
    // nothing can prove an MLB row is still pregame.
    build: make('pregame', 'Pregame only', (b) => {
      b.market.sports = ['NBA', 'NFL']
      b.market.phase = 'pregame'
      b.pollS = 60
    })
  },
  {
    key: 'nba-props',
    name: 'NBA player props',
    summary: 'Points, rebounds and assists, pregame and in game, only when the chance to hit is high: 70% before the tip and in the first quarter, rising to 80% in the fourth. Untick quarters to choose when it starts.',
    // Likely props are priced high, so the band reaches up to 92c and the edge
    // bar sits lower than a moneyline's.
    build: make('nba-props', 'NBA player props', (b) => {
      b.market.sports = ['NBA']
      b.market.lanes = ['PROP']
      b.market.labels = ['PRICE_GAP']
      b.entry.minChancePct = { pregame: 70, Q1: 70, Q2: 72, Q3: 75, Q4: 80 }
      b.entry.minEdgePp = 3
      b.entry.priceBandC = [40, 92]
      b.entry.maxPriceAgeS = 60
      b.guards.noEntryFinalS = 120
    })
  },
  {
    key: 'nba-scalp',
    name: 'NBA scalp +10c',
    summary: 'In game NBA moneylines, spreads and props. Every fill rests a sell 10 cents higher at once; once it sells, the bot may take either side of the game again.',
    build: make('nba-scalp', 'NBA scalp +10c', (b) => {
      b.market.sports = ['NBA']
      b.market.lanes = ['MONEYLINE', 'SPREAD', 'PROP']
      b.market.phase = 'live'
      b.entry.maxPriceAgeS = 60
      b.guards.noEntryFinalS = 120
      b.exit = { mode: 'limit', targetC: 10 }
      b.pollS = 10
    })
  },
  {
    key: 'nba-combos',
    name: 'NBA two leg combos',
    summary: 'Ties two NBA plays from different games into one Kalshi combo when our chance that both hit beats a real quote from Kalshi\'s market makers. Takes nothing alone. Needs a Kalshi key, even on paper.',
    build: make('nba-combos', 'NBA two leg combos', (b) => {
      b.market.sports = ['NBA']
      b.market.lanes = ['MONEYLINE', 'SPREAD', 'PROP', 'COMBO']
      b.market.labels = ['PRICE_GAP']
      b.entry.priceBandC = [40, 92]
      b.combo = { legs: 2, maxPerDay: 5, only: true }
    })
  },
  // 0.9.0, from 169 graded NBA games and NFL weeks 1 to 8 (2026-11-17). Each
  // is a test next to the bot it changes, not a proven winner.
  {
    key: 'nba-pick-live',
    name: 'NBA our pick, live',
    summary: 'In game NBA moneylines on the team our number has winning at 70% or more, even when the price is above our chance, up to 92c. A flat amount a trade, held to settlement. Our picks have won more often than we said on graded games, which is not yet proof.',
    build: make('nba-pick-live', 'NBA our pick, live', (b) => {
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
    name: 'NBA our pick, pregame',
    summary: 'NBA moneylines before the tip on the team our number has winning at 70% or more, up to 92c, a flat amount a trade, held to settlement. Checked once a minute.',
    build: make('nba-pick-pregame', 'NBA our pick, pregame', (b) => {
      b.market.sports = ['NBA']
      b.market.lanes = ['MONEYLINE']
      b.market.phase = 'pregame'
      b.entry.basis = 'pick'
      b.entry.minChancePct = { pregame: 70, Q1: 70, Q2: 70, Q3: 70, Q4: 70 }
      b.entry.priceBandC = [25, 92]
      b.size.sizing = 'flat'
      b.size.maxTradeUsd = 5
      b.pollS = 60
    })
  },
  {
    key: 'nba-live-70',
    name: 'NBA live, 70% chance',
    summary: 'The NBA live bot with one change: it takes only plays our number gives 70% or more to pay out. Run it next to NBA live to see what the floor is worth.',
    build: make('nba-live-70', 'NBA live, 70% chance', (b) => {
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
    name: 'NFL pregame sides, edge 10',
    summary: 'The NFL pregame bot without totals, which lost on graded weeks, and with the edge bar raised to 10. Run it next to NFL pregame.',
    build: make('nfl-pregame-sides', 'NFL pregame sides, edge 10', (b) => {
      b.market.sports = ['NFL']
      b.market.lanes = ['MONEYLINE', 'SPREAD']
      b.market.phase = 'pregame'
      b.entry.minEdgePp = 10
      b.pollS = 60
    })
  },
  {
    key: 'nfl-hot-60',
    name: 'NFL hot plays, up to 60c',
    summary: 'The NFL hot plays bot with the price capped at 60c, cutting the 60 to 75c band that lost the most on graded weeks. Expect about break even at best. Run it next to NFL hot plays.',
    build: make('nfl-hot-60', 'NFL hot plays, up to 60c', (b) => {
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
    name: 'Explorer, tiny size',
    summary: 'Takes every tradeable label at a lower edge bar and $2 a trade at most, so Results can show which labels and lanes are worth keeping.',
    build: make('explorer', 'Explorer, tiny size', (b) => {
      b.market.labels = ['PRICE_GAP', 'RATING_Q', 'LEAN', 'TAIL_RUNG', 'ROLE_Q', 'MEASURED']
      b.entry.minEdgePp = 3
      b.entry.minEvCents = 0
      b.size.maxTradeUsd = 2
      b.guards.maxTradesPerDay = 60
    })
  }
]

export const starterOf = (id: string): Starter | undefined => STARTERS.find((s) => `starter-${s.key}` === id)
