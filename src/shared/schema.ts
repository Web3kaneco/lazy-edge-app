// The settings documents. These are the contract the executor obeys exactly
// (docs/DECISIONS.md, the thesis). Every field here maps to one gate in
// src/main/rules/gates.ts; a field with no gate is a bug.
import { z } from 'zod'

export const Sport = z.enum(['NFL', 'MLB', 'NBA', 'WC'])
// TEAM_TOTAL is its own lane on the board (nfl_publish v60) and is not yet
// graded, so it is never enabled by default.
export const Lane = z.enum(['MONEYLINE', 'SPREAD', 'TOTAL', 'TEAM_TOTAL', 'PROP'])
export const Phase = z.enum(['pregame', 'live', 'both'])
export const VenueId = z.enum(['paper', 'kalshi', 'polymarket'])
export const ProviderId = z.enum(['anthropic', 'openai', 'xai', 'ollama'])

// Labels the board publishes. ILLIQUID, ROLE_PRICED and UNPRICED are shown by
// the API and never ranked, so no setting can allow them.
export const TradeableLabel = z.enum(['PRICE_GAP', 'RATING_Q', 'LEAN', 'TAIL_RUNG', 'ROLE_Q', 'MEASURED'])
export const NEVER_TRADE_LABELS = ['ILLIQUID', 'ROLE_PRICED', 'UNPRICED', 'NONE'] as const

const usd = z.number().min(0)
const pct = z.number().min(0).max(1)
const cents = z.number().min(1).max(99)

export const AccountSettings = z.object({
  // Global switch. 'dry_run' runs the entire path and logs the order it would
  // place (runbook gate 4). Shipped default; the user flips it themselves.
  executionMode: z.enum(['dry_run', 'live']),
  // Runbook gate 3. Stops every real order on the next signal.
  killSwitch: z.boolean(),
  venues: z.object({
    paper: z.object({ enabled: z.boolean(), startingBalanceUsd: usd }),
    kalshi: z.object({ enabled: z.boolean(), environment: z.enum(['production', 'demo']) }),
    // 'email' covers email and Magic logins (a Polymarket proxy wallet),
    // 'browser_wallet' a MetaMask style login (a Gnosis safe), and 'eoa' a
    // plain wallet trading for itself. This decides the order signature type.
    polymarket: z.object({ enabled: z.boolean(), accountType: z.enum(['email', 'browser_wallet', 'eoa']) })
  }),
  // The account cap above every bot (decision 12): the bots together cannot
  // lose more than this today, however many are switched on.
  accountDailyDrawdownUsd: usd,
  accountMaxOpenExposureUsd: usd
})
export type AccountSettings = z.infer<typeof AccountSettings>

export const BotSettings = z.object({
  id: z.string().min(1),
  name: z.string().min(1).max(80),
  enabled: z.boolean(),
  // 'paper' trades the local ledger regardless of the account mode. 'live'
  // sends to real venues, and still obeys executionMode and the kill switch.
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
    labels: z.array(TradeableLabel).min(1),
    venues: z.array(VenueId).min(1)
  }),

  entry: z.object({
    // Probability points, ours minus the market's. 5 means 5pp. The engine
    // also accepts a fraction and normalises (the 2026-07-23 units bug).
    minEdgePp: z.number().min(0).max(50),
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
    measuredOnly: z.boolean()
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
    maxGameEquityPct: pct
  }),

  // No exit settings in phase one: every position is held to settlement. A
  // take profit field the engine did not act on would be a protection the
  // user believes in and does not have.

  guards: z.object({
    noEntryFinalS: z.number().int().min(0).max(900),
    noOvertime: z.boolean(),
    onePositionPerMarket: z.boolean(),
    autoCancelS: z.number().int().min(5).max(3600),
    maxDailyDrawdownUsd: usd,
    maxTradesPerDay: z.number().int().min(1).max(1000)
  }),

  pollS: z.number().int().min(5).max(600)
})
export type BotSettings = z.infer<typeof BotSettings>

export type Sport = z.infer<typeof Sport>
export type Lane = z.infer<typeof Lane>
export type VenueId = z.infer<typeof VenueId>
export type ProviderId = z.infer<typeof ProviderId>
