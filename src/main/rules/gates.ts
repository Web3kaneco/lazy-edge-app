// The universal gate stack. Order
// follows the server engine's Kalshi executor. Every gate fails
// closed, and every skip names the gate so the ledger can say why nothing
// traded, which is how the 2026-07-23 silent slate would have been caught.
import { createHash } from 'node:crypto'
import { tradingDay } from '@shared/day'
import { NEVER_TRADE_LABELS, type AccountSettings, type BotSettings, type VenueId } from '@shared/schema'
import type { ContractSide, Signal, VenueQuote } from '@shared/signal'
import { breakevenProb, evCents } from './fees'
import { resolveSide } from './side'

export interface VenueState {
  // Usable balance in dollars, null when the venue could not be read.
  balanceUsd: number | null
  // Balance plus marked open positions, the base for the per game cap.
  equityUsd: number | null
}

export interface GateContext {
  now: number
  venues: Partial<Record<VenueId, VenueState>>
  openMarketKeys: ReadonlySet<string>
  // Open cost already committed on this game by this bot, in dollars.
  gameExposureUsd: number
  accountOpenExposureUsd: number
  botDailyPnlUsd: number
  accountDailyPnlUsd: number
  botTradesToday: number
}

export interface TradeDecision {
  kind: 'trade'
  venue: VenueId
  priceSource: VenueId
  contract: string
  side: ContractSide
  contracts: number
  limitPriceC: number
  costUsd: number
  evCents: number
  pCalibrated: number
  breakeven: number
  dryRun: boolean
  idempotencyKey: string
  autoCancelS: number
  audit: string[]
}

export interface SkipDecision {
  kind: 'skip'
  gate: string
  detail: string
}

export type Decision = TradeDecision | SkipDecision

const skip = (gate: string, detail = ''): SkipDecision => ({ kind: 'skip', gate, detail })

interface Candidate {
  quote: VenueQuote & { ask: number }
  pCal: number
  ev: number
}

// The gates that need no price: settings, side, clock and pace. The
// supervisor runs these before it reads a single order book, so a play the
// bot could never take costs nothing, and evaluate() runs them again so the
// two can never disagree.
export function preGates(signal: Signal, bot: BotSettings, account: AccountSettings, ctx: GateContext): SkipDecision | null {
  const live = bot.mode === 'live'

  // 1. The bot and the account must both allow trading at all.
  if (!bot.enabled) return skip('bot_disabled')
  if (live && account.killSwitch) return skip('kill_switch')

  // 2. Lane allowlist. A lane the user did not enable physically cannot reach
  // an order (runbook gate 2).
  if (!bot.market.sports.includes(signal.sport)) return skip('sport_not_enabled', signal.sport)
  if (!bot.market.lanes.includes(signal.lane)) return skip('lane_not_enabled', signal.lane)
  if (bot.market.phase !== 'both' && bot.market.phase !== signal.phase) return skip('phase_not_enabled', signal.phase)

  // 3. Labels. Some are shown by the API and never ranked; no setting can
  // allow them.
  const label = signal.label.toUpperCase()
  if ((NEVER_TRADE_LABELS as readonly string[]).includes(label)) return skip('label_never_traded', label)
  if (!(bot.market.labels as string[]).includes(label)) return skip('label_not_enabled', label)
  if (bot.entry.measuredOnly && !signal.measured) return skip('not_measured')
  if (bot.entry.requireTrigger && !signal.trigger) return skip('no_trigger')

  // 4. Side, from the explicit table. Refused rather than guessed.
  if (!resolveSide(signal)) return skip('side_unresolved', signal.signalType)

  // 5. The clock. Live entries need a known clock, because the final seconds
  // lockout cannot be enforced against a clock we cannot read.
  if (signal.phase === 'live') {
    if (!signal.clock) return skip('clock_unknown')
    if (bot.guards.noOvertime && signal.clock.overtime) return skip('overtime')
    const left = signal.clock.secondsRemaining
    if (bot.guards.noEntryFinalS > 0 && (left === null || left <= bot.guards.noEntryFinalS)) {
      return skip('final_seconds', `${left ?? 'unknown'}s left`)
    }
  }

  // 6. Position and pace limits.
  if (bot.guards.onePositionPerMarket && ctx.openMarketKeys.has(signal.key)) return skip('position_open', signal.key)
  if (ctx.botTradesToday >= bot.guards.maxTradesPerDay) return skip('max_trades_today')
  if (ctx.botDailyPnlUsd <= -bot.guards.maxDailyDrawdownUsd) return skip('bot_drawdown', ctx.botDailyPnlUsd.toFixed(2))
  // The account stop counts live money only, so it stops live bots only.
  if (live && ctx.accountDailyPnlUsd <= -account.accountDailyDrawdownUsd) {
    return skip('account_drawdown', ctx.accountDailyPnlUsd.toFixed(2))
  }
  return null
}

export function evaluate(signal: Signal, bot: BotSettings, account: AccountSettings, ctx: GateContext): Decision {
  const audit: string[] = []
  const live = bot.mode === 'live'
  const pre = preGates(signal, bot, account, ctx)
  if (pre) return pre
  const side = resolveSide(signal)!

  // 7. A null edge is no reading, never zero (agent guide, rule 1). Read
  // after the live requote, so it is the edge at the price that can be paid.
  if (signal.edgePp === null || signal.ourP === null) return skip('no_reading')
  // Signed: a negative edge means the market already prices it above ours.
  if (signal.edgePp < bot.entry.minEdgePp) {
    return skip('min_edge', `${signal.edgePp.toFixed(2)}pp < ${bot.entry.minEdgePp}pp`)
  }

  // 8. Route. Best EV after each venue's own fee, among venues the bot allows,
  // the account enabled, and (when live) the user actually funded.
  const best = route(signal, side, bot, account, ctx, live)
  if ('gate' in best) return best
  const { quote, pCal, ev } = best
  audit.push(`route ${quote.venue} ask ${(quote.ask * 100).toFixed(0)}c age ${quote.priceAgeS}s ev ${ev.toFixed(2)}c`)

  // 9. Size. Kelly against a real bankroll, then the rails, then the band.
  const venue: VenueId = live ? quote.venue : 'paper'
  const state = ctx.venues[venue]
  const bankroll = bot.size.bankrollUsd > 0 ? bot.size.bankrollUsd : (state?.balanceUsd ?? 0)
  if (bankroll <= 0) return skip('no_bankroll', venue)
  // The API's own Kelly when it publishes one; otherwise binary Kelly on the
  // calibrated probability at the price we would pay: (p - c) / (1 - c).
  const rawKelly = signal.kelly ?? (pCal - quote.ask) / (1 - quote.ask)
  const kelly = Math.max(0, Math.min(rawKelly * bot.size.kellyMultiplier, 1))
  if (kelly <= 0) return skip('kelly_zero', rawKelly.toFixed(4))

  let sizeUsd = Math.min(kelly * bankroll, bot.size.maxTradeUsd)
  const kellyUsd = sizeUsd
  if (sizeUsd > 0 && sizeUsd < bot.size.minTradeUsd) sizeUsd = Math.min(bot.size.minTradeUsd, bot.size.maxTradeUsd)
  if (state?.balanceUsd !== null && state?.balanceUsd !== undefined) sizeUsd = Math.min(sizeUsd, state.balanceUsd)
  if (Math.abs(sizeUsd - kellyUsd) > 0.005) audit.push(`size band: kelly $${kellyUsd.toFixed(2)} -> $${sizeUsd.toFixed(2)}`)

  const limitPriceC = Math.round(quote.ask * 100)
  const contracts = Math.min(Math.floor((sizeUsd * 100) / limitPriceC), bot.size.maxContracts)
  if (contracts < 1) return skip('size_too_small', `$${sizeUsd.toFixed(2)} at ${limitPriceC}c`)
  const costUsd = (contracts * limitPriceC) / 100

  // 10. Exposure caps, per game and per account. Fail closed on the cap.
  const equity = state?.equityUsd ?? bankroll
  const gameCap = Math.max(5, bot.size.maxGameEquityPct * equity)
  if (ctx.gameExposureUsd + costUsd > gameCap) {
    return skip('game_cap', `$${ctx.gameExposureUsd.toFixed(2)} + $${costUsd.toFixed(2)} > $${gameCap.toFixed(2)}`)
  }
  if (live && ctx.accountOpenExposureUsd + costUsd > account.accountMaxOpenExposureUsd) {
    return skip('account_exposure', `$${(ctx.accountOpenExposureUsd + costUsd).toFixed(2)}`)
  }

  const day = tradingDay(ctx.now)
  return {
    kind: 'trade',
    venue,
    priceSource: quote.venue,
    contract: quote.contract,
    side,
    contracts,
    limitPriceC,
    costUsd,
    evCents: ev,
    pCalibrated: pCal,
    breakeven: breakevenProb(quote.ask, quote.venue),
    dryRun: live && account.executionMode === 'dry_run',
    idempotencyKey: createHash('sha256').update(`${bot.id}|${signal.key}|${day}`).digest('hex').slice(0, 32),
    autoCancelS: bot.guards.autoCancelS,
    audit
  }
}

function route(
  signal: Signal,
  side: ContractSide,
  bot: BotSettings,
  account: AccountSettings,
  ctx: GateContext,
  live: boolean
): Candidate | SkipDecision {
  const allowed = bot.market.venues.filter((v) => v !== 'paper')
  // Only a paper bot may price off every venue; a live bot trades where it is told.
  if (live && allowed.length === 0) return skip('no_venue', 'a live bot needs Kalshi or Polymarket in its venues')
  const reasons: string[] = []
  let best: Candidate | null = null

  for (const q of signal.quotes) {
    if (q.venue === 'paper') continue
    // A paper bot that lists only 'paper' prices off every real venue.
    if (allowed.length > 0 && !allowed.includes(q.venue)) continue
    if (q.side !== side) { reasons.push(`${q.venue}:side_conflict`); continue }
    if (live) {
      if (!account.venues[q.venue].enabled) { reasons.push(`${q.venue}:not_enabled`); continue }
      const bal = ctx.venues[q.venue]?.balanceUsd
      // Decision 11: skip unfunded venues up front rather than discovering it
      // at order time.
      if (bal === null || bal === undefined || bal < bot.size.minTradeUsd) { reasons.push(`${q.venue}:unfunded`); continue }
    }
    if (q.ask === null) { reasons.push(`${q.venue}:no_ask`); continue }
    if (q.priceAgeS === null || q.priceAgeS > bot.entry.maxPriceAgeS) { reasons.push(`${q.venue}:stale`); continue }
    const askC = q.ask * 100
    const [lo, hi] = bot.entry.priceBandC
    if (askC < lo || askC > hi) { reasons.push(`${q.venue}:band ${askC.toFixed(0)}c`); continue }
    // The minimum edge holds on the venue that would be traded, not only on
    // the best price anywhere.
    const edgePp = (signal.ourP! - q.ask) * 100
    if (edgePp < bot.entry.minEdgePp) { reasons.push(`${q.venue}:edge ${edgePp.toFixed(1)}pp`); continue }

    // The measured overconfidence haircut, then net EV after this venue's fee.
    const pCal = q.ask + (signal.ourP! - q.ask) * bot.entry.edgeHaircut
    const ev = evCents(pCal, q.ask, q.venue, q.feeRate)
    if (ev < bot.entry.minEvCents) { reasons.push(`${q.venue}:ev ${ev.toFixed(2)}c`); continue }
    if (!best || ev > best.ev) best = { quote: { ...q, ask: q.ask }, pCal, ev }
  }

  return best ?? skip('no_venue', reasons.join(', ') || 'no quotes')
}
