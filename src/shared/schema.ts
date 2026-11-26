// The settings documents. These are the contract the executor obeys exactly
// (docs/DECISIONS.md, the thesis). Every field here maps to one gate in
// src/main/rules/gates.ts; a field with no gate is a bug.
import { z } from 'zod'

export const Sport = z.enum(['NFL', 'MLB', 'NBA', 'WC'])
// TEAM_TOTAL is its own lane on the board (nfl_publish v60) and is not yet
// graded, so it is never enabled by default.
// COMBO is not a feed lane: it lets the bot tie plays it would take alone into
// one Kalshi combo (shared/combos.ts).
export const Lane = z.enum(['MONEYLINE', 'SPREAD', 'TOTAL', 'TEAM_TOTAL', 'PROP', 'COMBO'])
export const Phase = z.enum(['pregame', 'live', 'both'])
export const Quarter = z.enum(['Q1', 'Q2', 'Q3', 'Q4'])
// hold: keep to settlement. limit: rest a sell at entry + target cents the
// moment the entry fills. mark: watch the book and sell at the bid once it
// reaches entry + target. time: sell at the bid a set number of minutes
// after the entry, or at the end of its quarter, whatever the price.
export const ExitMode = z.enum(['hold', 'limit', 'mark', 'time'])
const chance = z.number().min(0).max(99)
const trailing = z.number().int().min(0).max(60).nullable()
export const VenueId = z.enum(['paper', 'kalshi', 'polymarket'])
export const ProviderId = z.enum(['anthropic', 'openai', 'xai', 'ollama'])

// Labels the board publishes. ILLIQUID, ROLE_PRICED and UNPRICED are shown by
// the API and never ranked, so no setting can allow them.
// A player prop's stat and side, so one can be switched off (2026-11-24).
export const PropSide = z.enum(['PTS over', 'PTS under', 'REB over', 'REB under', 'AST over', 'AST under'])
export type PropSide = z.infer<typeof PropSide>

export const TradeableLabel = z.enum(['PRICE_GAP', 'RATING_Q', 'LEAN', 'TAIL_RUNG', 'ROLE_Q', 'MEASURED'])
export const NEVER_TRADE_LABELS = ['ILLIQUID', 'ROLE_PRICED', 'UNPRICED', 'NONE'] as const

const usd = z.number().min(0)
const pct = z.number().min(0).max(1)
const cents = z.number().min(1).max(99)

export const AccountSettings = z.object({
  // A bot's own mode is the only switch between practice and real money
  // (2026-11-20): there is no account wide dry run, and a venue is in
  // use when its key is saved, not by a toggle here. Older files still carry
  // executionMode and the venue toggles; they are read once to move live
  // bots that were held in dry run back to paper (settingsStore), then dropped.
  // Runbook gate 3. Stops every real order on the next signal.
  killSwitch: z.boolean(),
  venues: z.object({
    paper: z.object({ startingBalanceUsd: usd }),
    kalshi: z.object({ environment: z.enum(['production', 'demo']) }),
    // 'email' covers email and Magic logins (a Polymarket proxy wallet),
    // 'browser_wallet' a MetaMask style login (a Gnosis safe), and 'eoa' a
    // plain wallet trading for itself. This decides the order signature type.
    polymarket: z.object({ accountType: z.enum(['email', 'browser_wallet', 'eoa']) })
  }),
  // The account cap above every bot (decision 12): the bots together cannot
  // lose more than this today, however many are switched on.
  accountDailyDrawdownUsd: usd,
  accountMaxOpenExposureUsd: usd,
  // The day profit lock (2026-11-16): once the day is up upPct, cash out
  // everything, at once (trailPct 0) or once the day gives back trailPct
  // points from its high. It watches live money or paper, once a day.
  profitLock: z.object({
    enabled: z.boolean(),
    watch: z.enum(['live', 'paper']),
    upPct: z.number().min(1).max(1000),
    trailPct: z.number().min(0).max(1000)
  }).default({ enabled: false, watch: 'live', upPct: 20, trailPct: 5 })
})
export type AccountSettings = z.infer<typeof AccountSettings>

export const BotSettings = z.object({
  id: z.string().min(1),
  name: z.string().min(1).max(80),
  enabled: z.boolean(),
  // The one switch between practice and real money. 'paper' trades the local
  // ledger against real books; 'live' sends real orders to the venues with a
  // saved key, and obeys only the kill switch above it.
  mode: z.enum(['paper', 'live']),

  // Decision 1. 'rules' is the deterministic engine. 'agent' lets a model
  // choose among signals that already passed every gate; it can only narrow.
  decider: z.object({
    kind: z.enum(['rules', 'agent']),
    provider: ProviderId.optional(),
    model: z.string().optional(),
    instructions: z.string().max(4000).optional()
  }),

  market: z.object({
    sports: z.array(Sport).min(1),
    lanes: z.array(Lane).min(1),
    phase: Phase,
    // In game plays trade only in these quarters, so a bot can start in the
    // quarter the user picks. Overtime is the No overtime guard's.
    quarters: z.array(Quarter).min(1).default(['Q1', 'Q2', 'Q3', 'Q4']),
    labels: z.array(TradeableLabel).min(1),
    // The real venues to use among those with a saved key; none, or none
    // with a key, means every keyed venue. 'paper' here is ignored: the mode
    // decides paper or live (shared/venues.ts).
    venues: z.array(VenueId).default([]),
    // Player props only on the game's leading players (2026-11-21: "only
    // the top 10 players in the game, not random role players"): the players
    // ranked this high or better in their game by our points projection. Null
    // trades every player.
    propTopPlayers: z.number().int().min(1).max(30).nullable().default(null),
    // Prop stats and sides this bot never buys (2026-11-24: "stop
    // rebound unders"). Across 503 graded props, rebound unders hit 54% where
    // we said 70% and lost $101 over 83, live and paper alike, while rebound
    // overs made $34 over 80. Empty buys every side.
    propSidesOff: z.array(PropSide).default([])
  }),

  entry: z.object({
    // Probability points, ours minus the market's. 5 means 5pp. The engine
    // also accepts a fraction and normalises (the 2026-07-23 units bug).
    minEdgePp: z.number().min(0).max(50),
    // The other end of the edge (2026-11-23: "we have one side limit on
    // the bands but not the other side"). Our chance minus the price paid,
    // above which the market most likely knows something we do not: across
    // 183 settled live bets, edges above 15 points won 9 of 23 and lost $29.94.
    // Null is no limit. Read at the price the order would pay, on either basis.
    maxEdgePp: z.number().min(1).max(100).nullable().default(null),
    // Net expected value per contract after fees and the haircut, in cents.
    minEvCents: z.number().min(-10).max(50),
    // Shrinks our claimed edge by the measured overconfidence before the EV
    // test. 0.5 is the 2026-08-02 forensic on 811 fills. 1.0 trades raw.
    edgeHaircut: pct,
    priceBandC: z.tuple([cents, cents]),
    // The API nulls an edge against a price older than 180s. This can only
    // be tighter.
    maxPriceAgeS: z.number().int().min(1).max(180),
    requireTrigger: z.boolean(),
    measuredOnly: z.boolean(),
    // The lowest chance, in percent, that the contract bought pays out, before
    // the game and in each quarter. 0 means no minimum. Overtime uses Q4's.
    minChancePct: z.object({ pregame: chance, Q1: chance, Q2: chance, Q3: chance, Q4: chance })
      .default({ pregame: 0, Q1: 0, Q2: 0, Q3: 0, Q4: 0 }),
    // Moneyline and spread plays (2026-11-17). The most points the team a
    // live play backs may trail by, in each quarter; null is no limit and 0
    // means never a team that is behind. Overtime uses Q4's. Read only where
    // the feed carries the score (NBA); with a limit set, a play whose score
    // cannot be read is refused.
    maxTrailing: z.object({ Q1: trailing, Q2: trailing, Q3: trailing, Q4: trailing })
      .default({ Q1: null, Q2: null, Q3: null, Q4: null }),
    // Only back the team the market prices at 50% or more to win the game.
    favoritesOnly: z.boolean().default(false),
    // What a trade is chosen on (2026-11-17). 'edge' buys where our chance
    // beats the price by the minimum edge and expected value. 'pick' buys only
    // the side our number has winning (over 50%), at the minimum chance and
    // inside the price band, with the edge and expected value minimums not
    // used: graded NBA games showed our picks winning more often than we said,
    // so the edge pointed at the other team. Bots saved before 0.9.0 use edge.
    basis: z.enum(['edge', 'pick']).default('edge'),
    // Bots that buy our pick only (2026-11-20): the fewest points our chance
    // must sit above the price paid. null is not used, so the price may be
    // above our chance. The NFL graded season made its money on our pick at
    // 70% or more priced under our number.
    pickGapPp: z.number().min(0).max(50).nullable().default(null),
    // The widest book to buy into (2026-11-20): the ask less the bid on the
    // side bought, in cents. null is no limit. With a limit set, a book whose
    // bid cannot be read is refused. Kalshi books only.
    maxSpreadC: z.number().int().min(1).max(50).nullable().default(null),
    // When the ask is above what the play is worth (2026-11-21): 'take'
    // skips it; 'bid' places a buy below the ask at the highest price that
    // still clears the minimum edge, and leaves it there for bidRestS seconds
    // in case the price comes down. Kalshi's fee on a resting order is a
    // quarter of the taker fee. Paper fills it only when the ask reaches it.
    // Pregame plays wait until this many minutes before the game starts
    // (2026-11-21: "pregame rolls out 15 minutes before the game", so
    // the pick and the price have settled). Null enters any time before the
    // start. A combos only bot is not held to it, so an early game's leg can
    // go early.
    pregameWindowMin: z.number().int().min(1).max(1440).nullable().default(15),
    // Player prop unders only at an edge inside this band, in points, read at
    // the price the order pays (2026-11-24: "unders 5 to 7 only").
    // Across 280 graded unders, 5 to 7 points was the one band that made
    // money (+$15 over 90); under 5 and over 7 both lost. Overs are not held
    // to it. The bot's own minimum and maximum edge still apply, so the band
    // can only narrow them. Null holds unders to the bot's edges alone.
    underEdgePp: z.tuple([z.number().min(0).max(50), z.number().min(0).max(100)]).nullable().default(null),
    // In game prop unders only in the first this many minutes of a quarter
    // (2026-11-24: built to test, not switched on). Live unders bought
    // in the first 2 minutes of Q3 won 11 of 12 (+$16.70); bought 8 or more
    // minutes in they hit 59% against our 81% and lost $22.49 over 27. A
    // clock that cannot say how far in refuses the under. Null is no limit.
    underFirstMin: z.number().min(1).max(15).nullable().default(null),
    orderType: z.enum(['take', 'bid']).default('take'),
    bidRestS: z.number().int().min(30).max(3600).default(300)
  }),

  size: z.object({
    kellyMultiplier: z.number().min(0).max(1),
    // 0 means size against the venue's live balance.
    bankrollUsd: usd,
    maxTradeUsd: usd,
    // The trade size band (2026-08-31): below the floor a trade cannot pay
    // its own fee, so an EV positive trade below it is rounded up to it.
    minTradeUsd: usd,
    maxContracts: z.number().int().min(1),
    maxGameEquityPct: pct,
    // 'kelly' sizes by the edge, so a trade with no edge is sized at nothing.
    // 'flat' makes every trade the largest trade amount, whatever the edge,
    // still held to the balance, the contract limit and the game cap.
    sizing: z.enum(['kelly', 'flat']).default('kelly')
  }),

  // How a position is closed (2026-11-16). The engine acts on every mode; a
  // position whose exit never fills is held to settlement. Bots saved before
  // 0.6.0 hold.
  exit: z.object({
    mode: ExitMode,
    // Cents above the entry price to sell at.
    targetC: z.number().int().min(1).max(50),
    // The time exit (2026-11-20): minutes after the entry to sell at the bid,
    // and whether the end of the entry's quarter sells it sooner. In game
    // prices measured on c2 moved toward our number over minutes, not
    // seconds, and an exit on the gap closing chased noise.
    afterMin: z.number().int().min(1).max(60).default(15),
    atQuarterEnd: z.boolean().default(false)
  }).default({ mode: 'hold', targetC: 10, afterMin: 15, atQuarterEnd: false }),

  // With COMBO in the lanes: how many legs, how many combos a day, and
  // whether the plays are taken only as combo legs and never alone.
  combo: z.object({
    legs: z.number().int().min(2).max(4),
    maxPerDay: z.number().int().min(1).max(50),
    only: z.boolean(),
    // 'built' ties the bot's own plays together; 'api' buys the API's own
    // NBA tickets as they are (2026-11-21), with only money settings applied.
    source: z.enum(['built', 'api']).default('built'),
    // Which of the API's combos to buy, by their number of legs, each as the
    // API built it (2026-11-21: "there are 3, 4 leg combos also so need
    // options to just play those as is"). Every size, as before, by default.
    apiLegs: z.array(z.union([z.literal(2), z.literal(3), z.literal(4)])).min(1).default([2, 3, 4])
  }).default({ legs: 2, maxPerDay: 5, only: false, source: 'built', apiLegs: [2, 3, 4] }),

  guards: z.object({
    noEntryFinalS: z.number().int().min(0).max(900),
    noOvertime: z.boolean(),
    onePositionPerMarket: z.boolean(),
    // Refuses a trade that bets against a position this bot already holds on
    // the same game. Bots saved before 0.4.0 read it as on.
    noOpposingBets: z.boolean().default(true),
    // One entry a game, all day: once the bot has bought on a game it never
    // buys on that game again, even after it has sold out.
    oneEntryPerGame: z.boolean().default(false),
    autoCancelS: z.number().int().min(5).max(3600),
    maxDailyDrawdownUsd: usd,
    maxTradesPerDay: z.number().int().min(1).max(1000)
  }),

  pollS: z.number().int().min(5).max(600),

  // A paper trial (2026-11-20): a paper copy of another bot running a
  // change the AI proposed, side by side, until the user accepts or drops it.
  // Accept copies this bot's strategy onto the original; money, name and
  // paper or live stay the original's.
  trial: z.object({
    of: z.string().min(1),
    startedAt: z.number(),
    what: z.string().max(400)
  }).optional()
})
export type BotSettings = z.infer<typeof BotSettings>

export type Sport = z.infer<typeof Sport>
export type Lane = z.infer<typeof Lane>
export type Quarter = z.infer<typeof Quarter>
export type ExitMode = z.infer<typeof ExitMode>
export type VenueId = z.infer<typeof VenueId>
export type ProviderId = z.infer<typeof ProviderId>
