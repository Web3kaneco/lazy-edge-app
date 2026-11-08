// The measured defaults (decision 16). Shipped inside the executable so the app
// works offline, refreshed from the API when it can be reached, and always
// overridden by the user's own settings. Each number cites where it was earned
// in the Lazy Edge server engine so a change can be argued with evidence rather than taste.
import type { AccountSettings, BotSettings } from './schema'

export const RULESET_VERSION = '2026-10-24.1'

export const FEES = {
  // Server engine: taker fee 0.07 * C * p * (1 - p), raw, verified against
  // 28 real fills on 2026-08-31.
  kalshiTakerCoef: 0.07,
  // Maker fee was 25% of taker on KXMLBGAME and 0 on KXMLBTOTAL. The
  // conservative 25% is the default, never a guess of zero.
  kalshiMakerRate: 0.25,
  // Polymarket's CLOB charges no trading fee on most markets. A per market
  // fee rate, when the venue reports one, wins over this.
  polymarketFeeRate: 0
} as const

export const DEFAULT_ACCOUNT: AccountSettings = {
  executionMode: 'dry_run', // runbook: dry run is the default, always
  killSwitch: false,
  venues: {
    paper: { enabled: true, startingBalanceUsd: 1000 },
    kalshi: { enabled: false, environment: 'production' },
    polymarket: { enabled: false, accountType: 'email' }
  },
  accountDailyDrawdownUsd: 50, // the server engine's UserConfig default
  accountMaxOpenExposureUsd: 200
}

export function defaultBot(id: string, name: string): BotSettings {
  return {
    id,
    name,
    enabled: false, // the user switches every bot on themselves (decision 12)
    mode: 'paper',
    decider: { kind: 'rules' },
    market: {
      sports: ['NBA', 'NFL'], // NBA is the core product
      lanes: ['MONEYLINE', 'SPREAD', 'TOTAL'],
      phase: 'both',
      labels: ['PRICE_GAP', 'MEASURED'],
      venues: ['paper']
    },
    entry: {
      minEdgePp: 5, // UserConfig.min_edge_threshold
      minEvCents: 0.5, // MLB_MIN_EV_C
      edgeHaircut: 0.5, // MLB_EDGE_HAIRCUT, the 811 fill forensic
      priceBandC: [25, 75], // the hot plays work
      maxPriceAgeS: 180, // the API's own freshness rule
      requireTrigger: false,
      measuredOnly: false
    },
    size: {
      kellyMultiplier: 0.25, // the strategy plan's kelly_fraction default
      bankrollUsd: 0,
      maxTradeUsd: 10, // MLB_MAX_TRADE_USD
      minTradeUsd: 1, // MLB_MIN_TRADE_USD
      maxContracts: 100,
      maxGameEquityPct: 0.35 // MLB_MAX_GAME_EQUITY_PCT, the 255 contract weeks
    },
    guards: {
      noEntryFinalS: 90, // the overtime wipeout
      noOvertime: true,
      onePositionPerMarket: true, // the backtest harness
      autoCancelS: 120, // UserConfig.auto_cancel_seconds
      maxDailyDrawdownUsd: 50, // UserConfig.max_daily_drawdown_usd
      maxTradesPerDay: 40
    },
    pollS: 15
  }
}
