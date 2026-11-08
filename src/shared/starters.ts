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
