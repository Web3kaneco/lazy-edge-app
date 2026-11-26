// The universal gate stack. Order
// follows the server engine's Kalshi executor. Every gate fails
// closed, and every skip names the gate so the ledger can say why nothing
// traded, which is how the 2026-07-23 silent slate would have been caught.
import { createHash } from 'node:crypto'
import { tradingDay } from '@shared/day'
import { NEVER_TRADE_LABELS, type AccountSettings, type BotSettings, type Quarter, type VenueId } from '@shared/schema'
import { isOurPick, isTeamPlay, minutesIntoQuarter, quarterOf, teamWinP, type ContractSide, type Signal, type VenueQuote } from '@shared/signal'
import { botVenues, type RealVenue } from '@shared/venues'
import { breakevenProb, evCents, kalshiFee } from './fees'
import { resolveSide } from './side'
import { opposedBy, type Position } from './stance'

export interface VenueState {
  // Usable balance in dollars, null when the venue could not be read.
  balanceUsd: number | null
  // Balance plus marked open positions, the base for the per game cap.
  equityUsd: number | null
  // Why new orders on this venue wait for now, in words, or null.
  hold?: string | null
}

export interface GateContext {
  now: number
  venues: Partial<Record<VenueId, VenueState>>
  // The real venues the user has saved a key for. A bot prices and trades only
  // on these (shared/venues.ts).
  keyed: readonly RealVenue[]
  // Signal keys and contract tickers this bot holds open, of any age.
  openMarketKeys: ReadonlySet<string>
  // Signal keys other bots hold open with real money, to the holding bot's
  // name, so two live bots never buy the same pregame pick (2026-11-25).
  othersHoldLive?: ReadonlyMap<string, string>
  // This bot's open positions on this game.
  gamePositions: readonly Position[]
  // Open cost already committed on this game by this bot, in dollars.
  gameExposureUsd: number
  accountOpenExposureUsd: number
  botDailyPnlUsd: number
  accountDailyPnlUsd: number
  botTradesToday: number
  // Earlier entries by this bot on this play today. A bot that exited may
  // enter again, and each entry needs its own order id.
  entriesToday?: number
  // Orders on this play today that came back cancelled with nothing filled.
  cancelledToday?: number
  // Entries holding contracts by this bot on this game today, for one entry a game.
  gameEntriesToday?: number
  // Every order this bot sent on this play today, filled or not, so a new bid
  // after one that expired gets its own order id.
  attemptsToday?: number
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
  idempotencyKey: string
  autoCancelS: number
  // A bid below the ask that waits up to autoCancelS seconds for the price
  // to come down (orderType 'bid'), rather than taking the ask now.
  rest?: boolean
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
  // A bid below the ask, in cents, when the ask itself does not pass.
  bidC?: number
}

// The gates that need no price: settings, side, clock and pace. The
// supervisor runs these before it reads a single order book, so a play the
// bot could never take costs nothing, and evaluate() runs them again so the
// two can never disagree.
// A player prop's stat and side, as 'REB under', from the Kalshi ticker
// (KXNBAREB-...) and the side the prop takes. Null when either cannot be read.
export function propSideOf(signal: Pick<Signal, 'key' | 'quotes' | 'prop'>): string | null {
  if (!signal.prop) return null
  const ticker = [signal.key, ...signal.quotes.map((q) => q.contract)].map((s) => /KXNBA(PTS|REB|AST)-/.exec(s ?? '')).find(Boolean)
  return ticker ? `${ticker[1]} ${signal.prop.over ? 'over' : 'under'}` : null
}

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
  // Pregame plays wait for the last minutes before the start (2026-11-21), so
  // the pick and the price have settled. A combos only bot may go early. A
  // play whose start time is not known cannot be shown to be inside the
  // window, so it is refused.
  const window = bot.entry.pregameWindowMin
  if (signal.phase === 'pregame' && window != null && !(bot.combo.only && bot.market.lanes.includes('COMBO'))) {
    if (signal.startsAt == null) return skip('start_unknown')
    const mins = (signal.startsAt - ctx.now) / 60_000
    if (mins > window) return skip('pregame_wait', `starts in ${Math.round(mins)} min, enters in the last ${window}`)
  }
  // One live bot per pregame pick (2026-11-25). On 23 and 24 November two
  // live bots bought the same pick a second apart, so one loss counted twice.
  // The bot that runs first keeps it; paper bots are never held back.
  const holder = live && signal.phase === 'pregame' ? ctx.othersHoldLive?.get(signal.key) : undefined
  if (holder) return skip('held_by_other_bot', `${holder} already holds this pick with real money`)

  // 3. Labels. Some are shown by the API and never ranked; no setting can
  // allow them.
  const label = signal.label.toUpperCase()
  if ((NEVER_TRADE_LABELS as readonly string[]).includes(label)) return skip('label_never_traded', label)
  if (!(bot.market.labels as string[]).includes(label)) return skip('label_not_enabled', label)
  if (bot.entry.measuredOnly && !signal.measured) return skip('not_measured')
  // Props on the game's leading players only, when the bot asks (2026-11-21).
  // A player with no projection cannot be shown to rank, so is refused.
  const top = bot.market.propTopPlayers
  if (signal.lane === 'PROP' && top != null) {
    const rank = signal.prop?.rank ?? null
    if (rank === null || rank > top) return skip('prop_not_top', rank === null ? 'no projection to rank' : `ranked ${rank} in the game, top ${top} only`)
  }
  // Prop stats and sides switched off (2026-11-24). A prop whose stat or side
  // cannot be read is refused while any side is off, rather than guessed.
  if (signal.lane === 'PROP' && bot.market.propSidesOff.length) {
    const side = propSideOf(signal)
    if (side === null) return skip('prop_side_off', 'stat or side unknown')
    if ((bot.market.propSidesOff as string[]).includes(side)) return skip('prop_side_off', side)
  }
  // In game prop unders only early in a quarter (2026-11-24).
  const early = bot.entry.underFirstMin
  if (early !== null && signal.lane === 'PROP' && signal.phase === 'live' && signal.prop && !signal.prop.over) {
    const into = minutesIntoQuarter(signal)
    if (into === null) return skip('under_late', 'how far into the quarter is not known')
    if (into > early) return skip('under_late', `${into.toFixed(1)} minutes into the quarter, unders only in the first ${early}`)
  }
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
    // The quarters the user picked. A live play with no quarter cannot be
    // shown to be in one, so it is refused.
    const q = quarterOf(signal)
    if (!q) return skip('quarter_unknown')
    if (q !== 'OT' && !bot.market.quarters.includes(q)) return skip('quarter_not_enabled', q)
  }

  // 4b. What the trade is chosen on. A pick signal exists only for a bot that
  // buys our pick, and such a bot never buys the side our number has losing.
  const pick = bot.entry.basis === 'pick'
  if (signal.pickOnly && !pick) return skip('pick_only')
  if (pick) {
    if (signal.ourP === null) return skip('no_reading')
    // Which team is our pick is the model's call: the honest chance may lower
    // the chance, never move the pick to the other team.
    if (!isOurPick({ ourP: signal.rawP ?? signal.ourP })) return skip('not_our_pick', `${(signal.ourP * 100).toFixed(1)}% to pay out`)
  }

  // 5b. The chance the contract pays out, against the minimum for this point
  // of the game. It needs only our number, so no book is read for a play
  // that could never pass.
  const need = minChanceFor(signal, bot)
  if (need > 0) {
    if (signal.ourP === null) return skip('no_reading')
    if (signal.ourP * 100 < need) return skip('min_chance', `${(signal.ourP * 100).toFixed(1)}% < ${need}%`)
  }

  // 5c. Where the game stands, for plays that back a team (2026-11-17): only
  // the team the market prices to win, and never a team further behind than
  // the user allows in this quarter. A rule that is on and cannot be read
  // refuses the play rather than guessing.
  if (isTeamPlay(signal)) {
    if (bot.entry.favoritesOnly) {
      const p = teamWinP(signal)
      if (p === null) return skip('favorite_unknown')
      if (p < 0.5) return skip('not_favorite', `${(p * 100).toFixed(0)}% to win`)
    }
    // The score limit reads NBA only, the one feed that carries the score; an
    // NBA play whose score is missing is refused, other sports are not held
    // to a score they never publish.
    const most = signal.sport === 'NBA' ? maxTrailingFor(signal, bot) : null
    if (most !== null) {
      const lead = signal.team?.lead ?? null
      if (lead === null) return skip('score_unknown')
      if (-lead > most) return skip('trailing', `down ${-lead}, most allowed ${most}`)
    }
  }

  // 6. Position and pace limits.
  // A market is the contract, on either side, whichever row priced it: a
  // board row and a hot play on one ticker are one position.
  if (bot.guards.onePositionPerMarket) {
    const held = ctx.openMarketKeys.has(signal.key) ? signal.key : signal.quotes.find((q) => ctx.openMarketKeys.has(q.contract))?.contract
    if (held) return skip('position_open', held)
  }
  if (bot.guards.oneEntryPerGame && (ctx.gameEntriesToday ?? 0) > 0) return skip('game_entered', `${ctx.gameEntriesToday} entry today`)
  if (bot.guards.noOpposingBets) {
    for (const q of signal.quotes) {
      const against = opposedBy({ contract: q.contract, side: q.side }, ctx.gamePositions)
      if (against) return skip('opposes_position', `holds ${against.side.toUpperCase()} ${against.contract}`)
    }
  }
  // The pace and loss stops guard money, so they hold live bots only. A paper
  // bot is a test, and a test that stops at 40 trades measures nothing after
  // them (2026-11-20: the props test ran out at 7:46 PM).
  if (!live) return null
  if (ctx.botTradesToday >= bot.guards.maxTradesPerDay) return skip('max_trades_today')
  if (ctx.botDailyPnlUsd <= -bot.guards.maxDailyDrawdownUsd) return skip('bot_drawdown', ctx.botDailyPnlUsd.toFixed(2))
  if (ctx.accountDailyPnlUsd <= -account.accountDailyDrawdownUsd) {
    return skip('account_drawdown', ctx.accountDailyPnlUsd.toFixed(2))
  }
  return null
}

export { quarterOf }

// The most points behind a backed team may be at this point of a live game,
// or null for no limit. Pregame plays have no score to read. Overtime uses
// Q4's.
export function maxTrailingFor(signal: Pick<Signal, 'phase' | 'clock'>, bot: BotSettings): number | null {
  if (signal.phase !== 'live') return null
  const q = quarterOf(signal)
  const m = bot.entry.maxTrailing
  return q === 'OT' ? m.Q4 : q ? m[q] : null
}

export function minChanceFor(signal: Pick<Signal, 'phase' | 'clock'>, bot: BotSettings): number {
  const m = bot.entry.minChancePct
  if (signal.phase === 'pregame') return m.pregame
  const q = quarterOf(signal)
  return q === 'OT' ? m.Q4 : q ? m[q] : 0
}

export function evaluate(signal: Signal, bot: BotSettings, account: AccountSettings, ctx: GateContext): Decision {
  const audit: string[] = []
  const live = bot.mode === 'live'
  const pre = preGates(signal, bot, account, ctx)
  if (pre) return pre
  const side = resolveSide(signal)!

  // 7. A null edge is no reading, never zero (agent guide, rule 1). Read
  // after the live requote, so it is the edge at the price that can be paid.
  // A bot buying our pick does not use the edge, only our number.
  const pick = bot.entry.basis === 'pick'
  if (signal.ourP === null || (!pick && signal.edgePp === null)) return skip('no_reading')
  // The honest chance (shared/honest.ts): every gate below reads it, and the
  // record says what lowered it.
  if (signal.rawP != null && signal.rawP !== signal.ourP) {
    audit.push(`honest chance ${(signal.ourP * 100).toFixed(1)}%, ours ${(signal.rawP * 100).toFixed(1)}%: ${(signal.honestNotes ?? []).join('; ')}`)
  }
  // Signed: a negative edge means the market already prices it above ours.
  // A bot that bids below the ask looks for a price with the edge rather
  // than refusing the ask, so the route below decides for it.
  const bids = bot.entry.orderType === 'bid'
  if (!pick && !bids && signal.edgePp! < bot.entry.minEdgePp) {
    return skip('min_edge', `${signal.edgePp!.toFixed(2)}pp < ${bot.entry.minEdgePp}pp`)
  }
  if (pick) {
    audit.push(bot.entry.pickGapPp === null
      ? `basis our pick at ${(signal.ourP * 100).toFixed(1)}%, edge ${signal.edgePp === null ? 'unknown' : `${signal.edgePp.toFixed(1)}pp`} not used`
      : `basis our pick at ${(signal.ourP * 100).toFixed(1)}%, priced at least ${bot.entry.pickGapPp}pp under it`)
  }

  // 8. Route. Best EV after each venue's own fee, among venues the bot allows,
  // the account enabled, and (when live) the user actually funded.
  const best = route(signal, side, bot, account, ctx, live)
  if ('gate' in best) return best
  const { quote, pCal, ev, bidC } = best
  // What the order pays: the ask now, or a bid below it that waits.
  const payC = bidC ?? Math.round(quote.ask * 100)
  // Too good to be true: our honest chance this far above what the order pays
  // means the market most likely knows something the feed does not.
  const gap = signal.ourP * 100 - payC
  if (bot.entry.maxEdgePp !== null && gap > bot.entry.maxEdgePp) {
    return skip('max_edge', `our ${(signal.ourP * 100).toFixed(1)}% is ${gap.toFixed(1)} points above ${payC}c, over ${bot.entry.maxEdgePp}`)
  }
  // Prop unders inside their own edge band (2026-11-24), at the price paid.
  const unders = bot.entry.underEdgePp
  if (unders && signal.lane === 'PROP' && signal.prop && !signal.prop.over && (gap < unders[0] || gap > unders[1])) {
    return skip('under_edge', `under at ${gap.toFixed(1)} points over ${payC}c, unders only ${unders[0]} to ${unders[1]}`)
  }
  audit.push(bidC !== undefined
    ? `route ${quote.venue} ask ${(quote.ask * 100).toFixed(0)}c is above the play's value; bid ${bidC}c and wait up to ${bot.entry.bidRestS}s, ev ${ev.toFixed(2)}c with the resting fee`
    : `route ${quote.venue} ask ${(quote.ask * 100).toFixed(0)}c age ${quote.priceAgeS}s ev ${ev.toFixed(2)}c`)

  // 9. Size. Kelly against a real bankroll, then the rails, then the band;
  // or flat, the largest trade amount every time.
  const venue: VenueId = live ? quote.venue : 'paper'
  const state = ctx.venues[venue]
  const bankroll = bot.size.bankrollUsd > 0 ? bot.size.bankrollUsd : (state?.balanceUsd ?? 0)
  if (bankroll <= 0) return skip('no_bankroll', venue)
  let sizeUsd: number
  let wantUsd: number
  if (bot.size.sizing === 'flat') {
    sizeUsd = wantUsd = Math.min(bot.size.maxTradeUsd, bankroll)
    audit.push(`size flat $${sizeUsd.toFixed(2)}`)
  } else {
    // The API's own Kelly when it publishes one; otherwise binary Kelly on the
    // calibrated probability at the price we would pay: (p - c) / (1 - c).
    // On the honest chance (2026-11-21): a feed's own Kelly is its sizing on
    // its own number, so it is used only when the honest check left that
    // number alone. Kelly on the honest chance stakes a long shot little,
    // since it loses most of the time, and a trade with no honest edge nothing.
    const honestMoved = signal.rawP != null && signal.rawP !== signal.ourP
    const rawKelly = signal.kelly !== null && !honestMoved && bidC === undefined ? signal.kelly : (pCal - payC / 100) / (1 - payC / 100)
    const kelly = Math.max(0, Math.min(rawKelly * bot.size.kellyMultiplier, 1))
    if (kelly <= 0) return skip('kelly_zero', rawKelly.toFixed(4))
    sizeUsd = wantUsd = Math.min(kelly * bankroll, bot.size.maxTradeUsd)
    audit.push(`size kelly ${(rawKelly * 100).toFixed(1)}% of the bankroll on the honest chance, x${bot.size.kellyMultiplier}: $${(kelly * bankroll).toFixed(2)}${kelly * bankroll > bot.size.maxTradeUsd ? `, held to the $${bot.size.maxTradeUsd} largest trade` : ''}`)
    if (sizeUsd > 0 && sizeUsd < bot.size.minTradeUsd) sizeUsd = Math.min(bot.size.minTradeUsd, bot.size.maxTradeUsd)
  }
  if (state?.balanceUsd !== null && state?.balanceUsd !== undefined) sizeUsd = Math.min(sizeUsd, state.balanceUsd)
  if (Math.abs(sizeUsd - wantUsd) > 0.005) audit.push(`size band: ${bot.size.sizing} $${wantUsd.toFixed(2)} -> $${sizeUsd.toFixed(2)}`)

  const limitPriceC = payC
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
    breakeven: breakevenProb(payC / 100, quote.venue),
    // A bid that expired unfilled leaves no position, so the next bid on the
    // same play is a new order with its own id.
    idempotencyKey: createHash('sha256').update(`${bot.id}|${signal.key}|${day}${ctx.entriesToday ? `|${ctx.entriesToday}` : ''}${ctx.cancelledToday ? `|r${ctx.cancelledToday}` : ''}${bidC !== undefined && ctx.attemptsToday ? `|b${ctx.attemptsToday}` : ''}`).digest('hex').slice(0, 32),
    autoCancelS: bidC !== undefined ? bot.entry.bidRestS : bot.guards.autoCancelS,
    ...(bidC !== undefined ? { rest: true } : {}),
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
  // The venues follow the saved keys. A live bot with no key has nowhere to
  // send; a paper bot with no key prices off every public book.
  const allowed = botVenues(bot, ctx.keyed)
  if (live && allowed.length === 0) return skip('no_venue', 'no Kalshi or Polymarket key is saved; add one on the Keys screen')
  const reasons: string[] = []
  let best: Candidate | null = null
  // The best bid below the ask, kept only when no ask passes.
  let bestBid: Candidate | null = null

  for (const q of signal.quotes) {
    if (q.venue === 'paper') continue
    if (allowed.length > 0 && !allowed.includes(q.venue)) { reasons.push(`${q.venue}:no key`); continue }
    if (q.side !== side) { reasons.push(`${q.venue}:side_conflict`); continue }
    if (live) {
      const bal = ctx.venues[q.venue]?.balanceUsd
      // Decision 11: skip unfunded venues up front rather than discovering it
      // at order time.
      if (bal === null || bal === undefined || bal < bot.size.minTradeUsd) { reasons.push(`${q.venue}:unfunded`); continue }
      const hold = ctx.venues[q.venue]?.hold
      if (hold) { reasons.push(`${q.venue}:${hold}`); continue }
    }
    if (q.ask === null) { reasons.push(`${q.venue}:no_ask`); continue }
    if (q.priceAgeS === null || q.priceAgeS > bot.entry.maxPriceAgeS) { reasons.push(`${q.venue}:stale`); continue }
    // The widest book: the ask less our side's bid. A bid that cannot be read
    // is refused, never assumed tight.
    if (bot.entry.maxSpreadC !== null) {
      if (q.bid === null || q.bid === undefined) { reasons.push(`${q.venue}:no bid`); continue }
      const widthC = Math.round((q.ask - q.bid) * 100)
      if (widthC > bot.entry.maxSpreadC) { reasons.push(`${q.venue}:book ${widthC}c wide`); continue }
    }
    const askC = q.ask * 100
    const [lo, hi] = bot.entry.priceBandC
    // Overpriced: a bot that bids looks for a price below the ask that has
    // the edge, on Kalshi, where an order can rest (2026-11-21).
    const tryBid = (why: string): void => {
      reasons.push(why)
      if (bot.entry.orderType !== 'bid' || q.venue !== 'kalshi') return
      const b = bidPrice(signal.ourP!, askC, bot)
      if (b && (!bestBid || b.ev > bestBid.ev)) bestBid = { quote: { ...q, ask: askC / 100 }, pCal: b.pCal, ev: b.ev, bidC: b.c }
    }
    if (askC < lo) { reasons.push(`${q.venue}:band ${askC.toFixed(0)}c`); continue }
    if (askC > hi) { tryBid(`${q.venue}:band ${askC.toFixed(0)}c`); continue }
    // The minimum edge holds on the venue that would be traded, not only on
    // the best price anywhere. A bot buying our pick uses neither minimum;
    // its EV is still worked out, for the record and to pick the venue.
    const pick = bot.entry.basis === 'pick'
    const edgePp = (signal.ourP! - q.ask) * 100
    if (!pick && edgePp < bot.entry.minEdgePp) { tryBid(`${q.venue}:edge ${edgePp.toFixed(1)}pp`); continue }
    // A pick bot may still ask for our chance to sit some points above the price.
    if (pick && bot.entry.pickGapPp !== null && edgePp < bot.entry.pickGapPp) { tryBid(`${q.venue}:gap ${edgePp.toFixed(1)}pp under ${bot.entry.pickGapPp}pp`); continue }

    // The measured overconfidence haircut, then net EV after this venue's fee.
    const pCal = q.ask + (signal.ourP! - q.ask) * bot.entry.edgeHaircut
    const ev = evCents(pCal, q.ask, q.venue, q.feeRate)
    if (!pick && ev < bot.entry.minEvCents) { tryBid(`${q.venue}:ev ${ev.toFixed(2)}c`); continue }
    if (!best || ev > best.ev) best = { quote: { ...q, ask: q.ask }, pCal, ev }
  }

  return best ?? bestBid ?? skip('no_venue', reasons.join(', ') || 'no quotes')
}

// The highest price below the ask, inside the band, where a resting buy still
// clears the bot's minimum edge (or a pick bot's gap) and, after the haircut
// and Kalshi's resting fee, its minimum EV. Null when no price does.
export function bidPrice(chance: number, askC: number, bot: BotSettings): { c: number; pCal: number; ev: number } | null {
  const pick = bot.entry.basis === 'pick'
  const need = pick ? (bot.entry.pickGapPp ?? 0) : bot.entry.minEdgePp
  const [lo, hi] = bot.entry.priceBandC
  let c = Math.min(Math.floor(chance * 100 - need + 1e-9), Math.ceil(askC) - 1, hi)
  for (; c >= Math.max(1, lo); c--) {
    const p = c / 100
    const pCal = p + (chance - p) * bot.entry.edgeHaircut
    const ev = (pCal - p - kalshiFee(p, 1, false)) * 100
    if (pick || ev >= bot.entry.minEvCents) return { c, pCal, ev }
  }
  return null
}
