// Every bot, one loop. Pull the board, requote each candidate from the live
// book, run each enabled bot's gates, place, then reconcile fills and
// settlements against the venue's own record. Runs only while the app is
// open (decision 14).
import { app } from 'electron'
import { EventEmitter } from 'node:events'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { checkLock, dayPct, rollDay, type LockDay, type LockState } from '@shared/profitlock'
import { acceptSideFor, apiTicketPicks, bestQuote, comboRfqContracts, fillMatches, fillPosition, pickCombo, type ComboLeg, type ComboPick, type QuoteReading } from '@shared/combos'
import { createHash } from 'node:crypto'
import { kalshiFee } from '../rules/fees'
import { tradingDay } from '@shared/day'
import { addExitFill, bidFromOtherAsk, exitFee, newExit, nothingHeld, paperExitFill, positionPnl, timeExitDue, withOrderTotals, type CashOutResult, type TicketExit } from '@shared/exits'
import { isLimitGate, type HeldBack, type LimitGate } from '@shared/limits'
import { rulesOf } from '@shared/review'
import type { AccountSettings, BotSettings, VenueId } from '@shared/schema'
import { playTags, type BotVerdict, type Signal, type VenueQuote } from '@shared/signal'
import { REAL_VENUES, type RealVenue } from '@shared/venues'
import { kalshiGameCode, kalshiRungs, mapLeg, nameKey, NFL_PROP_SERIES, nflSlips, rankSlips, type KalshiRung, type MappedLeg, type Ranked } from '@shared/nflcombos'
import { calibrate, withHonest, type Calibration } from '@shared/honest'
import { screen, type Candidate } from '../ai/agent'
import { accuracy } from './accuracy'
import { ai } from '../ai/registry'
import { lazyedge, NotSignedInError, PlanInactiveError } from '../data/lazyedge'
import { matchupOf, mlbEdges, nflBoardPhase, nflInfoToKalshi, nbaLiveEdges, nbaPicks, nbaProps, nbaRowProblem, nbaSpreadLadder, nflBoardRows, nflHotPlays, nflMarketMaps, type NflMarketMap, type Normalized } from '../data/normalize'
import { evaluate, preGates, type GateContext, type TradeDecision, type VenueState } from '../rules/gates'
import type { Position } from '../rules/stance'
import { isOpen, ledger, type Ticket } from '../store/ledger'
import { missed } from '../store/missed'
import { keepSample } from '../store/samples'
import { PlayTrail } from './trail'
import { settingsStore } from '../store/settings'
import { terms } from '../store/terms'
import { KalshiVenue } from '../venues/kalshi'
import { fillNflMoneylines, mapNflHotLines, mapNflHotProps, nflLadderEvents, nflPropEvents } from '../data/nflkalshi'
import { mapNbaProps, nbaGameCodes, nbaPropEvents } from '../data/nbakalshi'
import { PaperVenue } from '../venues/paper'
import { PolymarketVenue } from '../venues/polymarket'
import type { Venue } from '../venues/types'

const BOARD_EVERY_MS = 5 * 60_000 // pregame boards move slowly; live plays are polled every cycle
// One spread ladder call per live NBA game; every 30s keeps a full slate well
// inside the basic tier's 60 requests a minute.
const NBA_LADDER_EVERY_MS = 30_000
const NBA_PROPS_EVERY_MS = 30_000
// NFL slips priced each pass, the likeliest first (2026-11-21).
const NFL_SLIPS_PRICED = 20
// A feed only switched off bots read, for the Board's preview.
const PREVIEW_EVERY_MS = 5 * 60_000
const LOCK_EVERY_MS = 30_000
// Quotes a paper or dry run bot may ask for and never take, across the app,
// in any hour; and how long a combo waits for makers to answer.
const PAPER_RFQ_PER_HOUR = 6
const COMBO_QUOTE_WAIT_S = 5
const LIVE_RFQ_PER_HOUR = 20

// How a combo quote reads, once a live fill has confirmed it, and whether
// live combos were switched off by a fill that did not match.
interface ComboPricing { confirmed: QuoteReading | null; disabled: string | null }
const comboFile = (): string => join(app.getPath('userData'), 'combo-pricing.json')
function readComboPricing(): ComboPricing {
  try { return existsSync(comboFile()) ? { confirmed: null, disabled: null, ...JSON.parse(readFileSync(comboFile(), 'utf8')) } : { confirmed: null, disabled: null } } catch { return { confirmed: null, disabled: 'the combo pricing file could not be read' } }
}
function writeComboPricing(p: ComboPricing): void {
  writeFileSync(comboFile(), JSON.stringify(p))
}

// The profit lock's record of the day, kept on disk so a restart keeps the
// day's start and high.
const lockFile = (): string => join(app.getPath('userData'), 'profitlock.json')
function readLockDay(): LockDay | null {
  try { return existsSync(lockFile()) ? JSON.parse(readFileSync(lockFile(), 'utf8')) as LockDay : null } catch { return null }
}
function writeLockDay(d: LockDay): void {
  try { writeFileSync(lockFile(), JSON.stringify(d)) } catch { /* the next reading writes it again */ }
}
const RECONCILE_EVERY_MS = 30_000
// Book reads run in parallel but are spaced to stay inside Kalshi's basic
// tier of 20 reads a second, shared with everything else the app reads.
const REQUOTE_CONCURRENCY = 6
const REQUOTE_SPACING_MS = 70
// Gates that only restate a bot's own settings. The Board shows them live;
// writing one ledger line per spread rung for them was 96% of the ledger.
const SETTINGS_GATES = new Set(['sport_not_enabled', 'lane_not_enabled', 'phase_not_enabled', 'label_not_enabled', 'label_never_traded', 'not_measured', 'no_trigger', 'quarter_not_enabled', 'pick_only', 'not_our_pick', 'prop_not_top', 'prop_side_off', 'pregame_wait', 'start_unknown'])
// A bot is due a little early rather than a whole cycle late when the timer
// and its Poll every line up.
const POLL_SLACK_MS = 2000

export interface DecisionLogEntry {
  at: number
  botId: string
  botName: string
  title: string
  outcome: string
  detail: string
}

export interface SupervisorState {
  running: boolean
  lastCycleAt: number | null
  lastError: string | null
  signals: number
  refused: { source: string; reason: string; count: number }[]
  venues: Partial<Record<VenueId, VenueState & { configured: boolean }>>
  recent: DecisionLogEntry[]
  board: Signal[]
  // signal key -> what each bot whose market covers it would do this cycle.
  verdicts: Record<string, BotVerdict[]>
}

// What the money limits look like right now, for the Dashboard.
export interface LimitsState {
  // Open cost of live orders, the same sum the account exposure gate reads.
  openLiveUsd: number
  capUsd: number
  liveBots: number
  // Plays a limit held back today, one per bot and gate, most first.
  held: HeldBack[]
}

const today = tradingDay
// What filled, at the price it filled. A live order counts at its full
// ordered cost while it can still fill, and at this once it is done.
const filledCost = (filled: number, avgFillC: number | null, limitPriceC: number): number => (filled * (avgFillC ?? limitPriceC)) / 100
const openCost = (ts: Ticket[]): number => ts.filter((t) => isOpen(t) && t.status !== 'dry_run').reduce((s, t) => s + t.costUsd, 0)

export class Supervisor extends EventEmitter {
  private timer: NodeJS.Timeout | null = null
  private busy = false
  private lastBoardAt = 0
  private lastReconcileAt = 0
  private boardCache: Normalized = { signals: [], refused: [] }
  // game_id -> the game as /v1/nfl/edges publishes it: the Kalshi tickers
  // from nfl_market_map, its kickoff and its status.
  private nflMaps: Record<string, NflMarketMap> = {}
  private nbaLadders = new Map<string, { at: number; rungs: unknown }>()
  private nbaPropsCache: { at: number; body: unknown } | null = null
  // Feeds only switched off bots read, kept between their slower fetches.
  private previewFeeds = new Map<string, { at: number; n: Normalized }>()
  // Ticket id -> settlement passes spent waiting to read an exit's last fills.
  private settleTries = new Map<string, number>()
  private rfqTimes: number[] = []
  private liveRfqTimes: number[] = []
  // Combo key -> when it was last asked about.
  private comboTried = new Map<string, number>()
  private lastLockAt = 0
  private lockDay: LockDay | null = null
  private lockNowPct: number | null = null
  private skipSeen = new Set<string>()
  private guide = ''
  // One book read per signal per cycle, shared by every bot that looks at it.
  private requoting = new Map<string, Promise<Signal>>()
  private requoted = new Map<string, Signal>()
  // Kalshi's recent prices, edge ages and player counts (bots/trail.ts).
  private trail = new PlayTrail()
  private lastBookReadAt = 0
  private skipDay = today()
  // botId|gate -> the signals a money or pace limit held back today.
  private held = new Map<string, Set<string>>()
  private heldDay = ''
  private verdicts: Record<string, BotVerdict[]> = {}
  // Bot id (":preview" for a bot that is off) -> when its gates last ran.
  private lastRun = new Map<string, number>()
  readonly venues: Record<VenueId, Venue>
  state: SupervisorState = { running: false, lastCycleAt: null, lastError: null, signals: 0, refused: [], venues: {}, recent: [], board: [], verdicts: {} }

  constructor() {
    super()
    this.venues = {
      // Paper rereads the real book at the moment it places.
      paper: new PaperVenue(() => this.paperState(), async (venue, contract, side) => {
        await this.bookSlot()
        return this.venues[venue].quote(contract, side)
      }),
      kalshi: new KalshiVenue(() => settingsStore.account().venues.kalshi.environment),
      polymarket: new PolymarketVenue(() => settingsStore.account().venues.polymarket.accountType)
    }
  }

  // Everything but the board, which is large and only the Board screen needs.
  // The limits are worked out fresh, so a cap saved on Account shows at once.
  publicState(): Omit<SupervisorState, 'board' | 'verdicts'> & { limits: LimitsState; profitLock: LockState } {
    const { board: _b, verdicts: _v, ...rest } = this.state
    // Which venues have a key is known before the first cycle, so the Bots
    // screen can grey out a venue with no key while the engine is stopped.
    const venues = Object.fromEntries((Object.keys(this.venues) as VenueId[]).map((id) => [id, {
      balanceUsd: this.state.venues[id]?.balanceUsd ?? null,
      equityUsd: this.state.venues[id]?.equityUsd ?? null,
      configured: this.venues[id].configured()
    }]))
    return { ...rest, venues, limits: this.limits(), profitLock: this.lockState() }
  }

  private limits(): LimitsState {
    const account = settingsStore.account()
    const bots = settingsStore.bots()
    const names = new Map(bots.map((b) => [b.id, b.name]))
    this.rollHeld()
    const held = [...this.held].map(([k, signals]) => {
      const [botId, gate] = k.split('|') as [string, LimitGate]
      return { gate, botId, botName: names.get(botId) ?? 'A deleted bot', plays: signals.size }
    }).sort((a, b) => b.plays - a.plays)
    return {
      openLiveUsd: openCost(ledger.active(2).filter((t) => t.venue !== 'paper')),
      capUsd: account.accountMaxOpenExposureUsd,
      liveBots: bots.filter((b) => b.enabled && b.mode === 'live').length,
      held
    }
  }

  // The day's held back plays, rebuilt from the ledger on a new day or a
  // restart, so the count is the day's and not the session's.
  private rollHeld(): void {
    if (this.heldDay === today()) return
    this.heldDay = today()
    this.held.clear()
    // Ledger files are cut at midnight UTC, so a trading day spans two.
    for (const e of ledger.events(2)) {
      if (e.type === 'skip' && today(e.at) === this.heldDay && isLimitGate(e.gate)) this.addHeld(e.botId, e.gate, e.signalKey)
    }
  }

  private addHeld(botId: string, gate: string, signalKey: string): void {
    const k = `${botId}|${gate}`
    let s = this.held.get(k)
    if (!s) this.held.set(k, (s = new Set()))
    s.add(signalKey)
  }

  start(): void {
    if (this.timer) return
    this.state.running = true
    void this.cycle(true)
    this.timer = setInterval(() => void this.cycle(), this.cadenceMs())
    this.emitState()
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
    this.state.running = false
    this.emitState()
  }

  // Cadence follows the fastest enabled bot, never faster than ten seconds.
  private cadenceMs(): number {
    const bots = settingsStore.bots().filter((b) => b.enabled)
    return Math.max(10, Math.min(...bots.map((b) => b.pollS), 60)) * 1000
  }

  restartTimer(): void {
    if (!this.timer) return
    clearInterval(this.timer)
    this.timer = setInterval(() => void this.cycle(), this.cadenceMs())
  }

  // The kill switch also pulls every live order still on the book, resting or
  // partly filled. A cycle already running rechecks it before every order
  // (place), so nothing goes out after this returns.
  async killSwitch(on: boolean): Promise<void> {
    const account = settingsStore.account()
    settingsStore.saveAccount({ ...account, killSwitch: on })
    if (!on) return this.emitState()
    for (const t of ledger.active(2)) {
      // A resting exit is an open order too. Once Kalshi reports it done, what
      // it sold is kept and the rest is placed again after the release.
      if (t.venue !== 'paper' && t.exit?.status === 'resting' && t.exit.orderId) {
        try {
          await this.venues[t.venue].cancel(t.exit.orderId, t.contract)
          // It stays tracked until Kalshi reports it done, so whatever it sold
          // before the cancel is read from Kalshi, never guessed.
          const exit: TicketExit = { ...t.exit, killed: true }
          this.update(t, { exit })
          Object.assign(t, { exit })
        } catch (err) {
          this.log(t.botId, t.botName, t.title, 'cancel_failed', (err as Error).message)
        }
      }
      if ((t.status !== 'resting' && t.status !== 'partial') || !t.venueOrderId || t.venue === 'paper') continue
      try {
        await this.venues[t.venue].cancel(t.venueOrderId, t.contract)
        // Its final fills, so the position held is known exactly.
        const u = await this.venues[t.venue].status(t.venueOrderId, { contract: t.contract, side: t.side }).catch(() => null)
        const filled = u ? u.filledContracts : t.filledContracts
        const avgFillC = u?.avgFillC ?? t.avgFillC
        this.update(t, { status: filled > 0 ? 'partial' : 'cancelled', venueOrderId: null, filledContracts: filled, avgFillC, feeUsd: u?.feeUsd ?? t.feeUsd, costUsd: filledCost(filled, avgFillC, t.limitPriceC) })
      } catch (err) {
        this.log(t.botId, t.botName, t.title, 'cancel_failed', (err as Error).message)
      }
    }
    this.emitState()
  }

  // `force` runs every bot whether or not it is due, for a cycle the user asked for.
  async cycle(force = false): Promise<void> {
    if (this.busy) return
    this.busy = true
    try {
      const account = settingsStore.account()
      const bots = settingsStore.bots().filter((b) => b.enabled)
      // Balances first, so they show even when the data feed is down.
      const venueStates = await this.readVenues()
      if (!this.guide) this.guide = await lazyedge.skill().catch(() => '')

      // Bots that are switched off still load their sports and are evaluated
      // as a preview, so the Board can show what they would take.
      const everyBot = settingsStore.bots()
      const fed = await this.feed(everyBot)
      // The honest chance (shared/honest.ts) before any gate reads a play: the
      // comeback record and the user's own record only ever lower our chance.
      const calib = this.calibration()
      const feed = { ...fed, signals: fed.signals.map((s) => withHonest(this.withStart(s), calib)) }
      this.state.signals = feed.signals.length
      this.state.refused = tally(feed.refused)

      this.requoting.clear()
      this.requoted.clear()
      this.trail.prune(Date.now())
      this.trail.noteCounts(feed.signals, Date.now())
      const prev = this.state.verdicts
      this.verdicts = {}
      // Poll every is per bot. The engine cycles at the fastest bot's pace and
      // runs each bot once it is due; one not yet due keeps last time's
      // verdicts on the Board.
      const now = Date.now()
      const run = async (bot: BotSettings, preview: boolean): Promise<void> => {
        const key = preview ? `${bot.id}:preview` : bot.id
        if (!force && now - (this.lastRun.get(key) ?? 0) < bot.pollS * 1000 - POLL_SLACK_MS) {
          for (const [k, list] of Object.entries(prev)) {
            const kept = list.filter((v) => v.botId === bot.id)
            if (kept.length) (this.verdicts[k] ??= []).push(...kept)
          }
          return
        }
        this.lastRun.set(key, now)
        // One bot's fault never stops the others or the exits below.
        try {
          await this.runBot(bot, account, feed.signals, venueStates, preview)
        } catch (err) {
          if (err instanceof NotSignedInError || err instanceof PlanInactiveError) throw err
          if (!preview) this.log(bot.id, bot.name, 'this cycle', 'bot_error', (err as Error).message.slice(0, 200))
        }
      }
      for (const bot of bots) await run(bot, false)
      for (const bot of everyBot.filter((b) => !b.enabled)) await run(bot, true)
      // The board shows the live price wherever a bot read the book this cycle.
      // It is grouped by game on screen, so it carries the whole slate.
      this.state.board = feed.signals.slice(0, 3000).map((s) => this.requoted.get(s.key) ?? s)
      this.state.verdicts = this.verdicts

      // Paper bids every cycle, so one fills the moment the ask comes down.
      await this.paperBids()
      // Exits every cycle, so a mark exit sells while the bid is still there.
      await this.manageExits()
      await this.checkProfitLock()
      if (Date.now() - this.lastReconcileAt > RECONCILE_EVERY_MS) {
        this.lastReconcileAt = Date.now()
        await this.reconcile()
      }
      accuracy.maybeRun(this.venues.kalshi as KalshiVenue, () => ledger.tickets(30))
      this.state.lastError = null
    } catch (err) {
      this.state.lastError = err instanceof NotSignedInError || err instanceof PlanInactiveError
        ? err.message
        : `Cycle failed: ${(err as Error).message}`
    } finally {
      this.state.lastCycleAt = Date.now()
      this.busy = false
      this.emitState()
    }
  }

  // ── Data ─────────────────────────────────────────────────────────────

  private async feed(bots: BotSettings[]): Promise<Normalized> {
    const now = Date.now()
    const sports = new Set(bots.flatMap((b) => b.market.sports))
    // With no bot enabled the board still loads, so the user can see it.
    const browsing = !sports.size
    if (browsing) { sports.add('NBA'); sports.add('NFL') }
    const out: Normalized = { signals: [], refused: [] }
    const add = (n: Normalized): void => { out.signals.push(...n.signals); out.refused.push(...n.refused) }
    // A feed that fails is shown as refused and the others still load, so an
    // NFL outage never stops NBA bots or the exits (the API audit, 2026-11-20).
    // Signed out or an inactive plan stops everything, as it must.
    const safely = async (source: string, fn: () => Promise<void>): Promise<void> => {
      try { await fn() } catch (err) {
        if (err instanceof NotSignedInError || err instanceof PlanInactiveError) throw err
        out.refused.push({ source, reason: (err as Error).message.slice(0, 80) })
      }
    }
    // A feed only switched off bots read is for the Board's preview, so it is
    // fetched every few minutes rather than every cycle: in November the MLB
    // starter alone, switched off, cost a call every ten seconds (the API
    // audit, 2026-11-20). A feed a bot that is on reads is fetched every cycle.
    const running = new Set(bots.filter((b) => b.enabled).flatMap((b) => b.market.sports))
    const feedFor = async (key: string, active: boolean, source: string, fn: () => Promise<void>): Promise<void> => {
      const kept = this.previewFeeds.get(key)
      if (!active && kept && now - kept.at < PREVIEW_EVERY_MS) { add(kept.n); return }
      const s0 = out.signals.length
      const r0 = out.refused.length
      await safely(source, fn)
      this.previewFeeds.set(key, { at: now, n: { signals: out.signals.slice(s0), refused: out.refused.slice(r0) } })
    }

    if (sports.has('NFL')) await feedFor('NFL', running.has('NFL'), 'nfl', async () => {
      if (now - this.lastBoardAt > BOARD_EVERY_MS) {
        const edges = await lazyedge.nflEdges()
        this.nflMaps = nflMarketMaps(edges)
        const games: any[] = Array.isArray(edges) ? edges : edges?.games ?? edges?.edges ?? []
        const board: Normalized = { signals: [], refused: [] }
        for (const g of games) {
          if (!g?.game_id || String(g.status ?? '').toUpperCase().includes('FINAL')) continue
          try {
            // {game_id, as_of, n_rows, rows}; rows carry no timestamp of their
            // own, so the board's as_of stands in until the live requote.
            const res = await lazyedge.nflBoard(String(g.game_id))
            keepSample(`nfl-board-${String(g.game_id)}`, res, now)
            const rows = (res?.rows ?? []).map((r: any) => ({ updated_at: res?.as_of, ...r }))
            const n = nflBoardRows(rows, now)
            const matchup = matchupOf(g)
            if (matchup) for (const s of n.signals) s.matchup = matchup
            board.signals.push(...n.signals); board.refused.push(...n.refused)
          } catch (err) {
            board.refused.push({ source: 'nfl.board', reason: (err as Error).message.slice(0, 80) })
          }
        }
        this.boardCache = board
        this.lastBoardAt = now
      }
      // Games the API's market map gives no moneyline ticker are matched to
      // Kalshi's own game markets (data/nflkalshi.ts), board and hot plays alike.
      const live = await lazyedge.nflLivePlays()
      keepSample('nfl-live-plays', live, now)
      const gameIds = [...Object.keys(this.nflMaps), ...this.boardCache.signals.map((s) => s.gameId), ...((live?.plays ?? []) as any[]).map((p) => String(p?.game_id ?? '')).filter(Boolean)]
      add({ signals: [], refused: await this.matchNflMoneylines(gameIds) })
      // The board is cached for five minutes, so whether its game has kicked
      // off is worked out again every cycle.
      add({ refused: this.boardCache.refused, signals: nflInfoToKalshi(this.boardCache.signals, this.nflMaps).map((s) => ({ ...s, ...nflBoardPhase(this.nflMaps[s.gameId], now) })) })
      const hot = nflHotPlays(live, now, this.nflMaps)
      // Live player props have no contract from the API; each is matched to
      // its Kalshi market here, the way the slips' legs are.
      const rungs = new Map<string, KalshiRung[]>()
      for (const event of nflPropEvents(live, this.nflMaps)) {
        const markets = await (this.venues.kalshi as KalshiVenue).eventMarkets(event)
        if (markets) rungs.set(event, kalshiRungs(event, markets))
      }
      mapNflHotProps(live, hot, this.nflMaps, rungs)
      // In game totals and spreads at a line the market map does not name
      // take Kalshi's rung at that line from the game's full ladder.
      const ladders = new Map<string, unknown[]>()
      for (const event of nflLadderEvents(live, this.nflMaps)) {
        const markets = await (this.venues.kalshi as KalshiVenue).eventMarkets(event)
        if (markets) ladders.set(event, markets)
      }
      mapNflHotLines(live, hot, this.nflMaps, ladders)
      add(hot)
    })
    if (sports.has('MLB')) await feedFor('MLB', running.has('MLB'), 'mlb', async () => { add(mlbEdges(await lazyedge.mlbEdges(), now)) })
    if (sports.has('NBA')) await feedFor('NBA', running.has('NBA'), 'nba', async () => {
      const live = await lazyedge.nbaLive()
      // Each game's scheduled tip, for the pregame window (agent guide: every
      // NBA edge row carries tip_time, UTC).
      for (const r of Array.isArray(live) ? live : []) {
        const tip = r?.tip_time ? Date.parse(String(r.tip_time)) : NaN
        if (r?.game_id && Number.isFinite(tip)) this.nbaTips.set(String(r.game_id), tip)
      }
      add(nbaLiveEdges(live, now))
      // A bot that buys our pick reads /v1/nba/picks. If that cannot be read,
      // the picks are built from the live feed's own rows instead, and the
      // reason shows as refused. A pick on a contract the edge feed already
      // carries is that same signal, so it is not added twice.
      if (bots.some((b) => b.entry.basis === 'pick' && b.market.sports.includes('NBA'))) {
        let picks: Normalized
        try {
          picks = nbaPicks(await lazyedge.nbaPicks(), now)
        } catch (err) {
          out.refused.push({ source: 'nba.picks', reason: `${(err as Error).message.slice(0, 80)}; picks built from the live feed` })
          const built = nbaLiveEdges(live, now, true)
          picks = { refused: [], signals: built.signals.filter((s) => s.pickOnly) }
        }
        const have = new Set(out.signals.map((s) => s.key))
        add({ refused: picks.refused, signals: picks.signals.filter((s) => !have.has(s.key)) })
      }
      const wantSpreads = browsing || bots.some((b) => b.market.sports.includes('NBA') && b.market.lanes.includes('SPREAD'))
      for (const row of wantSpreads && Array.isArray(live) ? live : []) {
        // A stale game's ladder is priced off a stale margin; skip the call.
        if (!row?.game_id || nbaRowProblem(row)) continue
        const gid = String(row.game_id)
        let cached = this.nbaLadders.get(gid)
        if (!cached || now - cached.at > NBA_LADDER_EVERY_MS) {
          try {
            cached = { at: now, rungs: await lazyedge.nbaSpreadLadder(gid) }
            this.nbaLadders.set(gid, cached)
          } catch (err) {
            out.refused.push({ source: 'nba.spread', reason: (err as Error).message.slice(0, 80) })
            continue
          }
        }
        add(nbaSpreadLadder(row, cached.rungs, now))
      }
    })
    // Player props only load for a bot that trades the props lane: the slate
    // is several hundred rows, cached for 30s.
    const props = (b: BotSettings): boolean => b.market.sports.includes('NBA') && b.market.lanes.includes('PROP')
    if (sports.has('NBA') && bots.some(props)) await feedFor('NBA_PROP', bots.some((b) => b.enabled && props(b)), 'nba.props', async () => {
      if (!this.nbaPropsCache || now - this.nbaPropsCache.at > NBA_PROPS_EVERY_MS) {
        try {
          this.nbaPropsCache = { at: now, body: await lazyedge.nbaProps() }
          keepSample('nba-props', this.nbaPropsCache.body, now)
        } catch (err) {
          if (err instanceof NotSignedInError || err instanceof PlanInactiveError) throw err
          out.refused.push({ source: 'nba.props', reason: (err as Error).message.slice(0, 80) })
          keepSample('nba-props-error', { error: (err as Error).message }, now)
        }
      }
      if (this.nbaPropsCache) {
        const n = nbaProps(this.nbaPropsCache.body, this.nbaPropsCache.at)
        // Props the API gave no Kalshi contract take Kalshi's market for the
        // same player and line (data/nbakalshi.ts). The game codes come from
        // the NBA game tickers the other feeds carried this cycle.
        const codes = nbaGameCodes(out.signals)
        const rungs = new Map<string, KalshiRung[]>()
        for (const event of nbaPropEvents(n, codes)) {
          const markets = await (this.venues.kalshi as KalshiVenue).eventMarkets(event)
          // A settled rung is no longer a market.
          const open = (markets ?? []).filter((m: any) => !m?.status || ['active', 'open'].includes(String(m.status)))
          if (markets) rungs.set(event, kalshiRungs(event, open))
        }
        const matched = mapNbaProps(n, codes, rungs)
        // What the reader made of the reply, beside the reply itself
        // (2026-11-27: a night of NBA games with no prop reaching any bot).
        const why: Record<string, number> = {}
        for (const r of n.refused) why[r.reason.replace(/^.* has no /, 'player has no ').replace(/line at [\d.]+/, 'line at that number')] = (why[r.reason.replace(/^.* has no /, 'player has no ').replace(/line at [\d.]+/, 'line at that number')] ?? 0) + 1
        keepSample('nba-props-read', { signals: n.signals.length, matchedToKalshi: matched, games: codes.size, refused: why }, now)
        add(n)
      }
    })
    if (sports.has('WC')) {
      // Not wired yet: shown as refused so the gap is visible rather than
      // silently trading nothing.
      out.refused.push({ source: 'wc', reason: 'normaliser pending' })
    }
    return out
  }

  // The board's price is when it was published, not when the book last
  // moved. Every candidate is requoted from the live book before the gates
  // run, and its edge is recomputed at the price that can actually be paid.
  private async requote(signal: Signal): Promise<Signal> {
    const quotes: VenueQuote[] = []
    for (const q of signal.quotes) {
      try {
        const venue = this.venues[q.venue]
        await this.bookSlot()
        const fresh = await venue.quote(q.contract, q.side)
        const feeRate = q.venue === 'polymarket' ? await (venue as PolymarketVenue).feeRate(q.contract) : null
        quotes.push(fresh ? { ...q, ask: fresh.ask, askSize: fresh.askSize, bid: fresh.bid ?? null, priceAgeS: fresh.priceAgeS, feeRate } : { ...q, priceAgeS: null })
      } catch {
        quotes.push({ ...q, priceAgeS: null }) // unreadable book is stale, never trusted
      }
    }
    const edges = quotes.filter((q) => q.ask !== null && signal.ourP !== null).map((q) => (signal.ourP! - q.ask!) * 100)
    const next = { ...signal, quotes, edgePp: edges.length ? Math.max(...edges) : null }
    return { ...next, trail: this.trail.read(next, Date.now()) }
  }

  private async readVenues(): Promise<Partial<Record<VenueId, VenueState>>> {
    const out: Partial<Record<VenueId, VenueState>> = {}
    for (const id of Object.keys(this.venues) as VenueId[]) {
      const v = this.venues[id]
      out[id] = await v.state()
      this.state.venues[id] = { ...out[id]!, configured: v.configured() }
    }
    return out
  }

  // The moneyline tickers the API's NFL market map leaves out, from Kalshi's
  // list of open NFL game markets. The list is kept ten minutes by the venue,
  // so a cycle that needs nothing new costs nothing.
  private async matchNflMoneylines(gameIds: string[]): Promise<{ source: string; reason: string }[]> {
    // A finished game has no open market to find, so it is not looked for.
    const need = [...new Set(gameIds)].filter((id) => !(this.nflMaps[id]?.kalshi_moneyline_home && this.nflMaps[id]?.kalshi_moneyline_away)
      && !String(this.nflMaps[id]?.status ?? '').toUpperCase().includes('FINAL'))
    if (!need.length) return []
    const markets = await (this.venues.kalshi as KalshiVenue).openSeriesMarkets('KXNFLGAME')
    if (!markets) return [{ source: 'nfl.kalshi-match', reason: "Kalshi's list of NFL game markets could not be read" }]
    const r = fillNflMoneylines(this.nflMaps, need, markets)
    this.nflMaps = r.maps
    return r.refused
  }

  // ── Bots ─────────────────────────────────────────────────────────────

  // A preview runs every gate for a bot that is switched off and records what
  // it would do. It never logs a skip, calls an agent, or places anything.
  //
  // Three passes, so trade timing does not depend on slate size: the gates
  // that need no price, then every surviving book read at once, then the full
  // gates at the live price, best edge first.
  private async runBot(bot: BotSettings, account: AccountSettings, signals: Signal[], venues: Partial<Record<VenueId, VenueState>>, preview: boolean): Promise<void> {
    // Open tickets of any age, or a position held past two days is forgotten:
    // bought again, and missing from the exposure caps.
    const tickets = ledger.active(2)
    const mine = tickets.filter((t) => t.botId === bot.id)
    const openKeys = new Set(mine.filter(isOpen).flatMap((t) => [t.signalKey, t.contract]))
    // Real money picks other bots hold, read fresh for each bot: bots run one
    // after another, so a pick bought earlier in this cycle is already here.
    const othersHoldLive = new Map(tickets.filter((t) => t.botId !== bot.id && t.venue !== 'paper' && t.status !== 'dry_run' && isOpen(t)).map((t) => [t.signalKey, t.botName] as const))
    const asIf = preview ? { ...bot, enabled: true } : bot
    const verdict = (s: Signal, outcome: BotVerdict['outcome'], gate: string | null, detail: string): void => {
      ;(this.verdicts[s.key] ??= []).push({ botId: bot.id, botName: bot.name, enabled: !preview, outcome, gate, detail })
    }
    const skip = (s: Signal, gate: string, detail: string): void => {
      verdict(s, 'skip', gate, detail)
      if (!preview) this.skip(bot, s, gate, detail)
    }

    const survivors: Signal[] = []
    // A combos only bot that buys the API's own combos takes no single play,
    // so it reads none: its skips would only say why it did not buy what it
    // never buys (2026-11-21).
    const apiCombosOnly = bot.combo.source === 'api' && bot.combo.only && bot.market.lanes.includes('COMBO')
    for (const raw of apiCombosOnly ? [] : signals) {
      if (!bot.market.sports.includes(raw.sport) || !bot.market.lanes.includes(raw.lane)) continue
      if (bot.market.phase !== 'both' && bot.market.phase !== raw.phase) continue
      // A pick signal is not a play for a bot that trades on the edge, any more
      // than another sport is.
      if (raw.pickOnly && bot.entry.basis !== 'pick') { if (!preview) missed.note(bot.id, raw, 'pick_only', 'our pick, for bots that buy our pick; this bot trades on the edge'); continue }
      if (!raw.quotes.length) { skip(raw, 'no_venue', 'no contract on this signal'); continue }
      if (bot.guards.onePositionPerMarket && (openKeys.has(raw.key) || raw.quotes.some((q) => openKeys.has(q.contract)))) { verdict(raw, 'holding', null, 'already holds this market'); continue }
      const pre = preGates(raw, asIf, account, this.context(bot, raw, mine, tickets, venues, openKeys, othersHoldLive))
      if (pre) { skip(raw, pre.gate, pre.detail); continue }
      survivors.push(raw)
    }

    const fresh = (await this.requoteAll(survivors)).sort((x, y) => (y.edgePp ?? -99) - (x.edgePp ?? -99))

    // Trades approved earlier in this pass count against the limits at once,
    // so one cycle cannot overrun the daily count or a game cap.
    let pendingTrades = 0
    let pendingLiveUsd = 0
    const pendingGameUsd = new Map<string, number>()
    const pendingPositions: (Position & { gameId: string })[] = []
    const candidates: Candidate[] = []
    const combos = bot.market.lanes.includes('COMBO')
    const legs: ComboLeg[] = []
    const legSignals = new Map<string, Signal>()
    for (const signal of fresh) {
      const ctx = this.context(bot, signal, mine, tickets, venues, openKeys, othersHoldLive)
      ctx.botTradesToday += pendingTrades
      ctx.gameExposureUsd += pendingGameUsd.get(signal.gameId) ?? 0
      ctx.accountOpenExposureUsd += pendingLiveUsd
      ctx.gamePositions = [...ctx.gamePositions, ...pendingPositions.filter((p) => p.gameId === signal.gameId)]
      const decision = evaluate(signal, asIf, account, ctx)
      if (decision.kind === 'skip') { skip(signal, decision.gate, decision.detail); continue }
      const what = `${decision.side.toUpperCase()} ${decision.contracts} @ ${decision.limitPriceC}c on ${decision.venue}, ev ${decision.evCents.toFixed(1)}c`
      verdict(signal, 'take', null, bot.decider.kind === 'agent' ? `${what}; the agent screens it first` : what)
      if (preview) continue
      // A play priced off Kalshi can be a combo leg. A combos only bot takes
      // it as a leg and never alone.
      if (combos && decision.priceSource === 'kalshi' && signal.ourP !== null && signal.edgePp !== null) {
        legs.push({ signalKey: signal.key, gameId: signal.gameId, title: signal.title, contract: decision.contract, side: decision.side, ourP: signal.ourP, askC: decision.limitPriceC, edgePp: signal.edgePp })
        legSignals.set(signal.key, signal)
      }
      if (combos && bot.combo.only) continue
      pendingTrades++
      pendingGameUsd.set(signal.gameId, (pendingGameUsd.get(signal.gameId) ?? 0) + decision.costUsd)
      if (decision.venue !== 'paper') pendingLiveUsd += decision.costUsd
      // One per market, and no bet against it, even within a cycle.
      openKeys.add(signal.key)
      openKeys.add(decision.contract)
      pendingPositions.push({ contract: decision.contract, side: decision.side, gameId: signal.gameId })
      // A rules bot places the moment a play passes, while the price is fresh.
      if (bot.decider.kind === 'rules') await this.place(bot, signal, decision, null)
      else candidates.push({ id: signal.key, signal, decision })
    }

    if (combos && !preview && bot.decider.kind === 'rules') {
      if (bot.combo.source === 'api') {
        if (bot.market.sports.includes('NBA')) await this.apiTickets(bot, account)
        if (bot.market.sports.includes('NFL')) await this.apiNflSlips(bot, account)
      } else await this.tryCombo(bot, account, legs, legSignals)
    }
    if (bot.decider.kind !== 'agent' || !bot.decider.provider || !candidates.length) return
    const screened = await screen(ai(bot.decider.provider), bot, candidates, this.guide)
    if (screened.error) this.log(bot.id, bot.name, `${candidates.length} tickets`, 'agent_error', `${screened.error}; nothing taken`)
    for (const c of candidates) {
      const why = screened.reasons.get(c.id) ?? null
      if (screened.take.has(c.id)) { await this.place(bot, c.signal, c.decision, why); continue }
      const mineNow = this.verdicts[c.signal.key]?.find((v) => v.botId === bot.id)
      if (mineNow) Object.assign(mineNow, { outcome: 'skip', gate: 'agent_declined', detail: why ?? 'no verdict' })
      this.skip(bot, c.signal, 'agent_declined', why ?? 'no verdict')
    }
  }

  // One book read per signal per cycle, shared by every bot, at most
  // REQUOTE_CONCURRENCY at a time.
  private async requoteAll(signals: Signal[]): Promise<Signal[]> {
    const out: Signal[] = new Array(signals.length)
    let next = 0
    const worker = async (): Promise<void> => {
      while (next < signals.length) {
        const i = next++
        const raw = signals[i]!
        let p = this.requoting.get(raw.key)
        if (!p) {
          p = this.requote(raw).then((s) => { this.requoted.set(s.key, s); return s })
          this.requoting.set(raw.key, p)
        }
        out[i] = await p
      }
    }
    await Promise.all(Array.from({ length: Math.min(REQUOTE_CONCURRENCY, signals.length) }, worker))
    return out
  }

  // Spaces book reads so parallel workers never burst past the rate limit.
  private async bookSlot(): Promise<void> {
    const at = Math.max(Date.now(), this.lastBookReadAt + REQUOTE_SPACING_MS)
    this.lastBookReadAt = at
    const wait = at - Date.now()
    if (wait > 0) await new Promise((res) => setTimeout(res, wait))
  }

  // The user's own record by lane, side and chance, worked out again every
  // ten minutes: settlements arrive slowly and the ledger is read in full.
  private calib: { at: number; map: Map<string, Calibration> } | null = null
  private calibration(): Map<string, Calibration> {
    if (!this.calib || Date.now() - this.calib.at > 10 * 60_000) this.calib = { at: Date.now(), map: calibrate(ledger.tickets(90)) }
    return this.calib.map
  }

  // When a play's game starts, for the pregame window: the NBA tip from the
  // edge rows, the NFL kickoff from the market map. Left unknown otherwise.
  private nbaTips = new Map<string, number>()
  private withStart(s: Signal): Signal {
    if (s.startsAt != null) return s
    const at = s.sport === 'NBA' ? this.nbaTips.get(s.gameId)
      : s.sport === 'NFL' ? (() => { const k = this.nflMaps[s.gameId]?.kickoff; const t = k ? Date.parse(k) : NaN; return Number.isFinite(t) ? t : undefined })()
        : undefined
    return at === undefined ? s : { ...s, startsAt: at }
  }

  // The real venues with a saved key: the only places a bot prices or trades.
  private keyed(): RealVenue[] {
    return REAL_VENUES.filter((v) => this.venues[v].configured())
  }

  private context(bot: BotSettings, signal: Signal, mine: Ticket[], all: Ticket[], venues: Partial<Record<VenueId, VenueState>>, openKeys: Set<string>, othersHoldLive?: ReadonlyMap<string, string>): GateContext {
    const day = today()
    const todays = (ts: Ticket[]): Ticket[] => ts.filter((t) => today(t.createdAt) === day)
    const realised = (ts: Ticket[]): number => ts.reduce((s, t) => s + (t.pnlUsd ?? 0), 0)

    // Drawdown is the settled result of the day's trades, after fees. It used
    // to take the worse of that and the drop in account value since the day's
    // first reading, the Python guard's anchor, but account value falls by
    // the spread and fee the moment a position opens and moves with every
    // deposit and withdrawal, so a busy night or a withdrawal stopped bots
    // that had lost nothing. Every position is held to settlement, so the
    // stop only ever decides new entries, and settled money is what it means.
    return {
      now: Date.now(),
      venues,
      keyed: this.keyed(),
      openMarketKeys: openKeys,
      othersHoldLive,
      // A combo counts on every game it has a leg in, and its legs are
      // positions a single may not bet against.
      gamePositions: mine.filter((t) => isOpen(t)).flatMap((t) => t.legs
        ? t.legs.filter((l) => l.gameId === signal.gameId).map((l) => ({ contract: l.contract, side: l.side }))
        : t.gameId === signal.gameId ? [{ contract: t.contract, side: t.side }] : []),
      gameExposureUsd: openCost(mine.filter((t) => t.gameId === signal.gameId || t.legs?.some((l) => l.gameId === signal.gameId))),
      accountOpenExposureUsd: openCost(all.filter((t) => t.venue !== 'paper')),
      botDailyPnlUsd: realised(todays(mine)),
      accountDailyPnlUsd: realised(todays(all.filter((t) => t.venue !== 'paper'))),
      // A paper order the book could not fill was never a trade.
      botTradesToday: todays(mine).filter((t) => t.status !== 'rejected' && !(t.status === 'cancelled' && t.filledContracts === 0)).length,
      // Only entries that held contracts: an order whose answer was lost keeps
      // its key, so Kalshi still refuses it as a duplicate.
      entriesToday: todays(mine).filter((t) => t.signalKey === signal.key && t.filledContracts > 0).length,
      gameEntriesToday: todays(mine).filter((t) => t.filledContracts > 0 && (t.gameId === signal.gameId || t.legs?.some((l) => l.gameId === signal.gameId))).length,
      attemptsToday: todays(mine).filter((t) => t.signalKey === signal.key).length,
      // Orders Kalshi answered as cancelled with nothing filled. Each is known
      // to be over, so the next try needs its own id; a lost answer is not
      // counted and keeps its key (2026-11-21: 25 "order already exists").
      cancelledToday: todays(mine).filter((t) => t.signalKey === signal.key && t.status === 'cancelled' && t.filledContracts === 0).length
    }
  }

  private async place(bot: BotSettings, signal: Signal, d: TradeDecision, agentReason: string | null): Promise<void> {
    // Re-read at the last moment. A kill switch, a bot turned off or out of
    // live, or new terms, made while this cycle was running, win.
    if (d.venue !== 'paper') {
      const account = settingsStore.account()
      const current = settingsStore.bots().find((b) => b.id === bot.id)
      const stop = account.killSwitch ? 'kill_switch' : !current?.enabled || current.mode !== 'live' ? 'bot_disabled' : !terms.status().accepted ? 'terms_not_accepted' : null
      if (stop) { this.skip(bot, signal, stop, 'changed while the cycle was running'); return }
    }
    const res = await this.venues[d.venue].place(d)
    const now = Date.now()
    const ticket: Ticket = {
      id: `${d.idempotencyKey}-${now.toString(36)}`,
      botId: bot.id, botName: bot.name, signalKey: signal.key, gameId: signal.gameId, title: signal.title,
      venue: d.venue, priceSource: d.priceSource, contract: d.contract, side: d.side,
      // Paper fills only what the book offered, so its cost is what filled. A
      // live order that filled outright costs what it filled at.
      contracts: d.contracts, limitPriceC: d.limitPriceC, evCents: d.evCents,
      costUsd: d.venue === 'paper' || res.status === 'filled' ? filledCost(res.filledContracts, res.avgFillC, d.limitPriceC) : d.costUsd,
      status: res.status, filledContracts: res.filledContracts, avgFillC: res.avgFillC, feeUsd: res.feeUsd,
      pnlUsd: null, venueOrderId: res.venueOrderId, createdAt: now, updatedAt: now,
      why: [signal.why, agentReason && `Agent: ${agentReason}`].filter(Boolean).join(' · ') || null,
      audit: [...d.audit, `ev ${d.evCents.toFixed(2)}c, breakeven ${(d.breakeven * 100).toFixed(1)}%, calibrated p ${(d.pCalibrated * 100).toFixed(1)}%`, ...(res.evidence ? [res.evidence] : [])],
      error: res.error,
      play: playTags(signal),
      rules: rulesOf(bot),
      ...(d.rest ? { restS: d.autoCancelS } : {}),
      // A book that never filled holds nothing to sell. Kalshi, and paper
      // priced off Kalshi, can sell; anything else holds to settlement.
      exit: bot.exit.mode !== 'hold' && res.ok && res.status !== 'cancelled' && res.status !== 'rejected' && d.priceSource === 'kalshi' && (d.venue === 'paper' || d.venue === 'kalshi')
        ? newExit(bot.exit.mode, res.avgFillC ?? d.limitPriceC, bot.exit.targetC, { now, afterMin: bot.exit.afterMin, atQuarterEnd: bot.exit.atQuarterEnd, period: signal.clock?.period ?? null })
        : null
    }
    ledger.append({ type: 'ticket', ticket })
    // The kill switch pressed while the order was in flight: pull what rests.
    if (d.venue !== 'paper' && res.venueOrderId && (res.status === 'resting' || res.status === 'partial') && settingsStore.account().killSwitch) {
      try {
        await this.venues[d.venue].cancel(res.venueOrderId, ticket.contract)
        this.update(ticket, { status: res.filledContracts > 0 ? 'partial' : 'cancelled', venueOrderId: null, costUsd: filledCost(res.filledContracts, res.avgFillC, d.limitPriceC) })
      } catch (err) { this.log(bot.id, bot.name, signal.title, 'cancel_failed', (err as Error).message) }
    }
    const filled = res.filledContracts < d.contracts ? ` (${res.filledContracts} filled)` : ''
    const what = `${d.side.toUpperCase()} ${d.contracts} @ ${res.avgFillC ?? d.limitPriceC}c on ${d.venue}${d.venue === 'paper' ? ` (priced off ${d.priceSource})` : ''}${filled}`
    this.log(bot.id, bot.name, signal.title, res.ok ? res.status : 'rejected', res.error ? `${what}: ${res.error}` : what)
    this.emit('ticket', ticket)
  }

  // ── Reconcile ────────────────────────────────────────────────────────

  private async reconcile(): Promise<void> {
    // Every open trade, however old, so a week away still ends with each
    // settlement recorded. The list is in memory; only open ones reach a venue.
    for (const t of ledger.tickets(3650)) {
      // A fill under one contract was once settled with no result (fixed
      // 2026-11-24); those are graded again here, from Kalshi's own result.
      const ungraded = t.status === 'settled' && t.filledContracts > 0 && t.avgFillC !== null
      if (t.pnlUsd !== null || !(['resting', 'partial', 'filled'].includes(t.status) || ungraded)) continue
      const venue = this.venues[t.venue]
      try {
        if (t.comboAccept && t.status === 'resting') { await this.resolveCombo(t); continue }
        if ((t.status === 'resting' || t.status === 'partial') && t.venueOrderId) {
          const u = await venue.status(t.venueOrderId, { contract: t.contract, side: t.side })
          if (u) {
            const avgFillC = u.avgFillC ?? t.avgFillC
            const done = u.done || u.status === 'filled' || u.status === 'cancelled'
            const patch: Partial<Ticket> = { status: u.status, filledContracts: u.filledContracts, avgFillC, feeUsd: u.feeUsd ?? t.feeUsd, ...(done ? { costUsd: filledCost(u.filledContracts, avgFillC, t.limitPriceC) } : {}) }
            this.update(t, patch)
            // A settlement later in this pass builds on this, fee and cost included.
            Object.assign(t, patch)
          }
          // Expiry is set on the order itself; this is the backstop if the
          // venue did not honour it.
          const bot = settingsStore.bots().find((b) => b.id === t.botId)
          if (t.status === 'resting' && bot && Date.now() - t.createdAt > ((t.restS ?? bot.guards.autoCancelS) + 30) * 1000) {
            await venue.cancel(t.venueOrderId, t.contract)
            this.update(t, { status: t.filledContracts > 0 ? 'partial' : 'cancelled', costUsd: filledCost(t.filledContracts, t.avgFillC, t.limitPriceC) })
            continue
          }
        }
        if (t.filledContracts > 0 && t.avgFillC !== null) {
          const source = this.venues[t.venue === 'paper' ? t.priceSource : t.venue]
          const result = source.settlement ? await source.settlement(t.contract) : null
          if (result) {
            let ex = t.exit ?? null
            if (ex && t.venue !== 'paper' && (ex.pending || (ex.status === 'resting' && ex.orderId))) {
              // A sell whose outcome is unknown is found first, by manageExits,
              // and a resting sell's last fills are read before closing. Kalshi
              // may stop listing an old order, so after ten tries the ticket
              // settles on the last totals it reported, and says so.
              const tries = (this.settleTries.get(t.id) ?? 0) + 1
              this.settleTries.set(t.id, tries)
              const u = !ex.pending && ex.orderId ? await venue.status(ex.orderId, { contract: t.contract, side: t.side }).catch(() => null) : null
              if (u) ex = withOrderTotals(ex, { contracts: u.filledContracts, avgC: u.avgFillC, feeUsd: u.feeUsd })
              else if (tries < 10) continue
              else this.log(t.botId, t.botName, t.title, 'exit_unconfirmed', 'the market settled before the last exit fills could be read; settled on the last totals Kalshi reported')
              ex = { ...ex, pending: null }
            }
            this.settleTries.delete(t.id)
            // Whatever an exit did not sell settles; a resting exit closes with the market.
            const exit = ex && ex.status !== 'done' ? { ...ex, status: 'done' as const, orderId: null } : ex
            this.update(t, { status: 'settled', pnlUsd: positionPnl({ ...t, exit }, result), exit })
          }
        }
      } catch (err) {
        this.log(t.botId, t.botName, t.title, 'reconcile_failed', (err as Error).message.slice(0, 160))
      }
    }
  }

  // ── Exits ────────────────────────────────────────────────────────────

  // Every open position with an exit still to do. Paper is judged against the
  // live book on the venue it was priced off. Kalshi gets a real sell: a
  // resting limit the moment the entry is done, or an immediate or cancel
  // sell at the bid once the bid reaches the target. Nothing is sent while
  // the kill switch is on. Once everything held has sold, the ticket closes
  // and the market is free for the bot to trade again, either side.
  private async manageExits(): Promise<void> {
    const killed = settingsStore.account().killSwitch
    for (const t of ledger.active(2)) {
      const exit = t.exit
      if (!exit || exit.status === 'done' || exit.status === 'failed' || !isOpen(t) || t.avgFillC === null) continue
      // A live entry still on the book has not finished filling: wait for it to
      // fill or for its own expiry, plus the reconcile backstop.
      if (t.status === 'resting') continue
      if (t.status === 'partial' && t.venue !== 'paper') {
        const bot = settingsStore.bots().find((b) => b.id === t.botId)
        if (Date.now() - t.createdAt < ((bot?.guards.autoCancelS ?? 3600) + 60) * 1000) continue
      }
      const held = t.filledContracts - exit.filledContracts
      if (nothingHeld(held) && !exit.pending) { this.recordExit(t, exit, 'everything held has sold'); continue }
      // Cashed out by hand: only an unconfirmed sell is still looked up.
      if (exit.cashout && !exit.pending) continue
      // A time exit waits for its minutes or its quarter's end, then sells at
      // the bid whatever the price; a sell already sent is always looked up.
      if (exit.mode === 'time' && !exit.pending && !timeExitDue(exit, Date.now(), this.clockOf(t))) continue
      try {
        if (t.venue === 'paper') await this.paperExit(t, exit, held)
        // Under the kill switch only the read only lookup of a pending sell runs.
        else if (t.venue === 'kalshi' && (!killed || exit.pending)) await this.kalshiExit(t, exit, held)
      } catch (err) {
        this.log(t.botId, t.botName, t.title, 'exit_failed', (err as Error).message.slice(0, 160))
      }
    }
  }

  // ── Combos ───────────────────────────────────────────────────────────

  // One combo a cycle at most, from the plays this bot approved this cycle,
  // one leg per game. The quote is read by shared/combos.ts and refused when it
  // does not add up. Paper and dry run ask makers for a real quote and never
  // accept it (2026-11-16), so they are capped per hour, only asked for
  // a combo the bot would really take, and withdrawn the moment it is read.
  // A live combo accepts the quote, reads its fill from Kalshi and checks the
  // price against the reading: a match confirms the reading, a mismatch
  // switches live combos off until the user looks at it. Until the reading is
  // confirmed, a live combo is one contract.
  // The API's own NBA tickets (2026-11-21: "just want the combos the
  // system has"): each night's tickets, our highest win chances built into
  // two, three and four legs, bought as Kalshi combos once they lock, 20
  // minutes before the night's first tip. Only money settings apply: the
  // largest trade, the combos a day, paper or live. A ticket is bought when a
  // real quote is at or under our chance that every leg wins, after the fee.
  private apiTicketsCache: { at: number; body: any } | null = null
  private async apiTickets(bot: BotSettings, account: AccountSettings): Promise<void> {
    if (!this.apiTicketsCache || Date.now() - this.apiTicketsCache.at > 60_000) {
      try { this.apiTicketsCache = { at: Date.now(), body: await lazyedge.nbaTickets() } } catch (err) {
        this.log(bot.id, bot.name, 'NBA tickets', 'combo_skipped', `the tickets feed could not be read: ${(err as Error).message.slice(0, 120)}`)
        return
      }
    }
    const sizes = bot.combo.apiLegs as number[]
    for (const pick of apiTicketPicks(this.apiTicketsCache.body, Date.now())) {
      if (sizes.includes(pick.legs.length)) await this.tryCombo(bot, account, [], new Map(), pick)
    }
  }

  // The API's NFL slips and same-game pairs (2026-11-21), mapped to Kalshi's
  // prop markets (shared/nflcombos.ts), each leg's live ask read, ranked by
  // our chance over the legs bought one by one, and the best tried up to the
  // bot's combos a day, one combo a day per player. Only before each leg's
  // game kicks off. A slip with a leg that does not map is left out, and the
  // count of those is logged once a cycle.
  private nflSlipsCache: { at: number; body: any } | null = null
  private nflSlipsRanAt = new Map<string, number>()
  private async apiNflSlips(bot: BotSettings, account: AccountSettings): Promise<void> {
    if (Date.now() - (this.nflSlipsRanAt.get(bot.id) ?? 0) < 2 * 60_000) return
    this.nflSlipsRanAt.set(bot.id, Date.now())
    if (!this.nflSlipsCache || Date.now() - this.nflSlipsCache.at > 10 * 60_000) {
      try { this.nflSlipsCache = { at: Date.now(), body: await lazyedge.nflSuggested() } } catch (err) {
        this.log(bot.id, bot.name, 'NFL slips', 'combo_skipped', `the slips feed could not be read: ${(err as Error).message.slice(0, 120)}`)
        return
      }
    }
    const kalshi = this.venues.kalshi as KalshiVenue
    const now = Date.now()
    const slips = nflSlips(this.nflSlipsCache.body)
    const gameCode = (gameId: string): string | null => {
      const m = this.nflMaps[gameId]
      if (!m) return null
      const kick = m.kickoff ? Date.parse(m.kickoff) : NaN
      if (!Number.isFinite(kick) || kick <= now || ['IN_PROGRESS', 'HALFTIME', 'FINAL'].some((s) => String(m.status ?? '').toUpperCase().includes(s))) return null
      return kalshiGameCode(m.kalshi_moneyline_home ?? m.kalshi_moneyline_away)
    }
    // Read every event the slips need, once.
    const rungs = new Map<string, KalshiRung[]>()
    for (const s of slips) for (const l of s.legs) {
      const code = gameCode(l.gameId)
      const series = NFL_PROP_SERIES[l.stat]
      if (!code || !series) continue
      const event = `${series}-${code}`
      if (rungs.has(event)) continue
      const markets = await kalshi.eventMarkets(event)
      if (markets) rungs.set(event, kalshiRungs(event, markets))
    }
    const ranked: Ranked[] = []
    let unmapped = 0
    const reasons = new Map<string, number>()
    const mapped: { s: (typeof slips)[number]; legs: MappedLeg[] }[] = []
    for (const s of slips) {
      if (!(bot.combo.apiLegs as number[]).includes(s.legs.length)) continue
      const legs: MappedLeg[] = []
      let why = ''
      for (const l of s.legs) {
        const m = mapLeg(l, gameCode(l.gameId), (e) => rungs.get(e))
        if (!m.leg) { why = `${l.player} ${l.side.toLowerCase()} ${l.line} ${l.stat}: ${m.why}`; break }
        legs.push(m.leg)
      }
      if (!why && new Set(legs.map((l) => l.gameId + l.contract)).size !== legs.length) why = 'two legs on the same Kalshi market'
      if (why) {
        unmapped++
        reasons.set(why.split(': ').pop()!.replace(/ for .*| within .*/, ''), (reasons.get(why.split(': ').pop()!.replace(/ for .*| within .*/, '')) ?? 0) + 1)
        missed.combo(bot.id, s.key, { legs: s.legs.map((l) => ({ contract: '', side: l.side, title: `${l.player} ${l.side.toLowerCase()} ${l.line} ${l.stat}`, ourP: l.pSide })), chance: s.chance }, 'unmapped', why)
        continue
      }
      mapped.push({ s, legs })
    }
    // Live prices for the likeliest slips only, so a week of pairs does not
    // become hundreds of book reads a cycle.
    for (const { s, legs } of mapped.sort((a, b) => b.s.chance - a.s.chance).slice(0, NFL_SLIPS_PRICED)) {
      // Each leg's live ask on the side it buys.
      let priced = true
      for (const l of legs) {
        await this.bookSlot()
        const q = await kalshi.quote(l.contract, l.side).catch(() => null)
        if (!q || q.ask === null) { priced = false; break }
        l.askC = Math.round(q.ask * 100)
        l.edgePp = (l.ourP - q.ask) * 100
      }
      if (!priced) {
        unmapped++
        reasons.set('no live price on a leg', (reasons.get('no live price on a leg') ?? 0) + 1)
        missed.combo(bot.id, s.key, { legs, chance: s.chance }, 'no_price', 'a leg has no live ask on Kalshi')
        continue
      }
      const legsPriceC = Math.round(legs.reduce((p, l) => p * (l.askC / 100), 1) * 10000) / 100
      ranked.push({ slip: s, legs, legsPriceC, edgePp: s.chance * 100 - legsPriceC })
    }
    // One combo a day per player, counting combos already bought today.
    const day = today()
    const usedPlayers = new Set<string>()
    const byTicker = new Map([...rungs.values()].flat().map((r) => [r.ticker, nameKey(r.player)]))
    for (const t of ledger.active(2)) {
      if (t.botId !== bot.id || !t.legs || today(t.createdAt) !== day || !(t.filledContracts > 0)) continue
      for (const l of t.legs) { const p = byTicker.get(l.contract); if (p) usedPlayers.add(p) }
    }
    const boughtToday = ledger.active(2).filter((t) => t.botId === bot.id && t.signalKey.startsWith('combo:') && today(t.createdAt) === day && t.filledContracts > 0).length
    const picks = rankSlips(ranked, { max: Math.max(0, bot.combo.maxPerDay - boughtToday), boughtKeys: new Set(), usedPlayers })
    if (unmapped && now - (this.lastUnmappedLog ?? 0) > 30 * 60_000) {
      this.lastUnmappedLog = now
      const top = [...reasons.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3).map(([r, n]) => `${n} ${r}`).join('; ')
      this.log(bot.id, bot.name, 'NFL slips', 'combo_skipped', `${unmapped} of ${slips.length} slips left out (${top}); ${ranked.length} mapped`)
    }
    for (const r of picks) await this.tryCombo(bot, account, [], new Map(), { legs: r.legs, chance: r.slip.chance, legsPriceC: r.legsPriceC, source: 'lazy_edge' })
  }
  private lastUnmappedLog: number | null = null

  private async tryCombo(bot: BotSettings, account: AccountSettings, legs: ComboLeg[], signals: Map<string, Signal>, given?: ComboPick): Promise<void> {
    const kalshi = this.venues.kalshi as KalshiVenue
    const day = today()
    const all = ledger.active(2)
    const mine = all.filter((t) => t.botId === bot.id && t.signalKey.startsWith('combo:'))
    if (mine.filter((t) => today(t.createdAt) === day && t.filledContracts > 0).length >= bot.combo.maxPerDay) return
    const pick = given ?? pickCombo(legs, bot.combo.legs)
    if (!pick) return
    // The API's tickets are taken as the API built them: no edge minimum
    // beyond not paying more than our chance.
    const minEdge = given ? 0 : bot.entry.minEdgePp
    const key = `combo:${pick.legs.map((l) => `${l.contract}:${l.side}`).sort().join('+')}`
    if (mine.some((t) => t.signalKey === key && (isOpen(t) || today(t.createdAt) === day))) return
    // The same combo is asked about again no sooner than 15 minutes later.
    if (Date.now() - (this.comboTried.get(key) ?? 0) < 15 * 60_000) return
    const titles = pick.legs.map((l) => l.title).join(' + ')
    const say = (outcome: string, detail: string): void => {
      this.log(bot.id, bot.name, `Combo: ${titles}`, outcome, detail)
      missed.combo(bot.id, key, pick, outcome, detail)
    }
    // Quotes never come under what the legs cost one by one, so a combo that
    // cannot clear the edge even there is not worth a request. Kept in the
    // record only: on screen it would repeat every cycle.
    if (pick.chance * 100 - pick.legsPriceC < minEdge) {
      missed.combo(bot.id, key, pick, 'combo_skipped', `our ${(pick.chance * 100).toFixed(1)}% that every leg wins is under the legs' ${pick.legsPriceC}c one by one`)
      return
    }
    if (!kalshi.configured()) return say('combo_skipped', 'combos need a Kalshi key, even on paper, to ask for a quote')

    // A key is saved by now, so a live bot's combo is real money.
    const real = bot.mode === 'live'
    const pricing = readComboPricing()
    // What one combo may spend: the bot's largest trade, never more than the
    // cash on hand, and for real money never past the account's open limit.
    const cash = real ? this.state.venues.kalshi?.balanceUsd ?? 0 : this.paperState().balanceUsd ?? 0
    const room = real ? account.accountMaxOpenExposureUsd - openCost(all.filter((t) => t.venue !== 'paper')) : Infinity
    const budgetUsd = Math.floor(Math.min(bot.size.maxTradeUsd, cash, room) * 100) / 100
    if (budgetUsd < Math.max(1, bot.size.minTradeUsd)) return
    if (real) {
      if (account.killSwitch) return
      if (pricing.disabled) return say('combo_skipped', `live combos are off: ${pricing.disabled}`)
      if (all.some((t) => t.comboAccept && t.status === 'resting')) return say('combo_skipped', 'an earlier combo is still waiting for its fill')
      this.liveRfqTimes = this.liveRfqTimes.filter((t) => Date.now() - t < 3_600_000)
      if (this.liveRfqTimes.length >= LIVE_RFQ_PER_HOUR) return
      this.liveRfqTimes.push(Date.now())
    } else {
      this.rfqTimes = this.rfqTimes.filter((t) => Date.now() - t < 3_600_000)
      if (this.rfqTimes.length >= PAPER_RFQ_PER_HOUR) return
      this.rfqTimes.push(Date.now())
    }
    this.comboTried.set(key, Date.now())

    let rfq: string | null = null
    let acceptTried = false
    try {
      const found = await kalshi.comboCollection(pick.legs.map((l) => l.contract))
      if ('missing' in found) return say('combo_skipped', `Kalshi offers no combo with these legs: ${found.missing.join(', ')}`)
      const market = await kalshi.createCombo(found.ticker, pick.legs.map((l, i) => ({ contract: l.contract, event: found.events[i]!, side: l.side })))
      // Until a live fill confirms how quotes read, a real combo is one contract.
      // After that, a count that fits the budget at the highest price we would
      // take: a request by dollar amount had every quote sized 0 (2026-11-23).
      const ask = real && !pricing.confirmed ? 1 : comboRfqContracts(budgetUsd, pick.chance, minEdge, bot.size.maxContracts)
      if (ask < 1) return say('combo_skipped', `not one contract fits the $${budgetUsd} budget at our ${(pick.chance * 100).toFixed(1)}%`)
      rfq = await kalshi.createRfq(market, { contracts: ask })
      let best: ReturnType<typeof bestQuote<{ id: string; yesBidC: number; noBidC: number; contracts: number }>> = null
      for (let i = 0; i < COMBO_QUOTE_WAIT_S && !best; i++) {
        await new Promise((r) => setTimeout(r, 1000))
        best = bestQuote(await kalshi.rfqQuotes(rfq), pick.legsPriceC, pricing.confirmed)
      }
      if (!best) return say('combo_skipped', `no quote that adds up within ${COMBO_QUOTE_WAIT_S}s for legs worth ${pick.legsPriceC}c`)
      const priceC = best.price.buyYesC!
      const reading = best.price.reading!
      const edge = pick.chance * 100 - priceC - kalshiFee(priceC / 100, 1) * 100
      if (edge < minEdge) return say('combo_skipped', `quote ${priceC}c leaves ${edge.toFixed(1)}pp after fees against our ${(pick.chance * 100).toFixed(1)}%, under the ${minEdge}pp minimum`)
      const contracts = Math.floor(best.quote.contracts)
      // The maker sized the quote; it must still fit the budget at its price.
      // The first unconfirmed live combo is one contract, which may cost up to $1.
      const probe = real && !pricing.confirmed
      if (probe && contracts !== 1) return say('combo_skipped', `the quote is for ${best.quote.contracts} contracts; until a fill confirms how quotes read, only a one contract quote is taken`)
      const cap = probe ? Math.max(budgetUsd, 1) : budgetUsd
      if (contracts < 1 || (contracts * priceC) / 100 > cap + 0.01) {
        return say('combo_skipped', `the quote for ${best.quote.contracts} at ${priceC}c does not fit the $${cap} budget`)
      }
      const tags = signals.get(pick.legs[0]!.signalKey)
      const now = Date.now()
      const base: Ticket = {
        id: `${createHash('sha256').update(`${bot.id}|${key}|${day}`).digest('hex').slice(0, 32)}-${now.toString(36)}`,
        botId: bot.id, botName: bot.name, signalKey: key, gameId: `combo:${pick.legs.map((l) => l.gameId).join('+')}`, title: `Combo: ${titles}`,
        venue: real ? 'kalshi' : 'paper', priceSource: 'kalshi', contract: market, side: 'yes',
        contracts, limitPriceC: Math.round(priceC), evCents: edge,
        costUsd: 0, status: 'filled', filledContracts: 0, avgFillC: null, feeUsd: 0, pnlUsd: null, venueOrderId: null,
        createdAt: now, updatedAt: now,
        why: `${pick.legs.length} legs, our chance ${(pick.chance * 100).toFixed(1)}% by ${pick.source === 'lazy_edge' ? 'Lazy Edge' : 'the legs multiplied'}, legs ${pick.legsPriceC}c one by one`,
        audit: [`quote ${best.price.why}`, `reading ${reading}${pricing.confirmed ? ' (confirmed)' : ' (not yet confirmed by a live fill)'}`, ...pick.legs.map((l) => `leg ${l.side.toUpperCase()} ${l.contract} at ${l.askC}c, ours ${(l.ourP * 100).toFixed(1)}%`)],
        error: null,
        // A combo backs no one team, so it carries no score or favorite.
        play: tags ? { ...playTags(tags), lane: 'COMBO', edgePp: edge, ourP: pick.chance, lead: null, teamWinP: null } : undefined,
        rules: rulesOf(bot),
        exit: null,
        legs: pick.legs.map((l) => ({ contract: l.contract, side: l.side, gameId: l.gameId }))
      }
      const write = (t: Ticket): void => { ledger.append({ type: 'ticket', ticket: t }); this.emit('ticket', t) }
      if (!real) {
        // The quote is read, never taken: the paper fill is the quote's price
        // and size, with Kalshi's taker fee.
        write({ ...base, filledContracts: contracts, avgFillC: priceC, costUsd: (contracts * priceC) / 100, feeUsd: exitFee(priceC, contracts, true) })
        return say('filled', `YES ${contracts} @ ${priceC}c from a real quote, not taken`)
      }

      // The last moment, as for any order: a kill switch, the bot off or out
      // of live, or new terms, made while quotes were read, win.
      const nowAccount = settingsStore.account()
      const nowBot = settingsStore.bots().find((b) => b.id === bot.id)
      const stop = nowAccount.killSwitch ? 'the kill switch is on' : !nowBot?.enabled || nowBot.mode !== 'live' ? 'the bot was switched off or out of live' : !terms.status().accepted ? 'the terms need accepting' : null
      if (stop) return say('combo_skipped', `${stop}; the quote was not taken`)

      const acceptedAt = Date.now()
      acceptTried = true
      let acceptError: string | null = null
      // An accept whose answer is lost may still have filled, so the fills are
      // read either way and whatever filled is recorded.
      try { await kalshi.acceptQuote(rfq, best.quote.id, acceptSideFor(reading)) } catch (err) { acceptError = (err as Error).message.slice(0, 160) }

      // Wait for the fills to settle: the full size, or the same count twice.
      let rows: Awaited<ReturnType<KalshiVenue['fillsSince']>> = []
      let last = -1
      for (let i = 0; i < 12; i++) {
        await new Promise((r) => setTimeout(r, 1000))
        rows = await kalshi.fillsSince(market, acceptedAt)
        const n = rows.reduce((s, f) => s + f.contracts, 0)
        if (n >= contracts || (n > 0 && n === last)) break
        last = n
      }
      const accept = { at: acceptedAt, reading, expectedC: priceC }
      if (!rows.length) {
        // Nothing filled yet is not the same as nothing filled: the combo is
        // kept as waiting, reconcile keeps reading Kalshi's fills for it, and
        // no new live combo goes out until it is settled either way.
        write({ ...base, status: 'resting', comboAccept: accept, error: acceptError ? `accept answer lost: ${acceptError}` : null })
        return say('combo_waiting', acceptError ? `the accept answer was lost (${acceptError}); watching Kalshi's fills for it` : 'quote accepted, no fill yet; watching Kalshi\'s fills for it')
      }
      this.recordComboFills({ ...base, comboAccept: accept }, rows)
    } catch (err) {
      say('combo_failed', (err as Error).message.slice(0, 160))
    } finally {
      if (rfq && !acceptTried) await kalshi.deleteRfq(rfq).catch(() => {})
    }
  }

  // A live combo's fills, from Kalshi's own record: each side that filled is
  // its own ticket at its own price, so the ledger always holds what Kalshi
  // holds. The fill then confirms how quotes read, or switches live combos off.
  private recordComboFills(base: Ticket, rows: Awaited<ReturnType<KalshiVenue['fillsSince']>>): void {
    const acc = base.comboAccept!
    const priceC = acc.expectedC
    const contracts = base.contracts
    const pricing = readComboPricing()
    const write = (t: Ticket): void => { ledger.append({ type: 'ticket', ticket: { ...t, updatedAt: Date.now() } }); this.emit('ticket', t) }
    const say = (outcome: string, detail: string): void => this.log(base.botId, base.botName, base.title, outcome, detail)
    {
      const bySide = new Map<'yes' | 'no' | 'unknown', { n: number; cost: number; fee: number }>()
      for (const f of rows) {
        const side = fillPosition(f.action, f.side) ?? 'unknown'
        const px = side === 'no' ? f.noC : f.yesC
        const g = bySide.get(side) ?? { n: 0, cost: 0, fee: 0 }
        bySide.set(side, { n: g.n + f.contracts, cost: g.cost + f.contracts * px, fee: g.fee + f.feeUsd })
      }
      const yes = bySide.get('yes')
      const odd = [...bySide.entries()].filter(([s]) => s !== 'yes')
      // The YES ticket keeps the waiting ticket's id, so it replaces it; with
      // nothing on YES the waiting ticket is closed as cancelled.
      if (yes) {
        const avg = Math.round((yes.cost / yes.n) * 100) / 100
        write({ ...base, error: null, filledContracts: yes.n, avgFillC: avg, costUsd: yes.cost / 100, feeUsd: Math.round(yes.fee * 10000) / 10000, status: yes.n < contracts ? 'partial' : 'filled' })
      } else if (base.status === 'resting') {
        write({ ...base, status: 'cancelled' })
      }
      for (const [side, g] of odd) {
        write({ ...base, id: `${base.id}-${side}`, side: side === 'no' ? 'no' : 'yes', filledContracts: g.n, avgFillC: Math.round((g.cost / g.n) * 100) / 100, costUsd: g.cost / 100, feeUsd: g.fee, status: 'filled', error: `filled as ${side} where YES was expected` })
      }
      const yesAvg = yes ? yes.cost / yes.n : null
      if (odd.length || yesAvg === null || !fillMatches(priceC, yesAvg)) {
        const why = odd.length ? `a combo filled as ${odd.map(([s, g]) => `${g.n} ${s}`).join(' and ')} where YES was expected` : `a combo filled at ${yesAvg?.toFixed(2)}c where ${priceC}c was expected`
        writeComboPricing({ ...pricing, confirmed: null, disabled: why })
        ledger.append({ type: 'note', at: Date.now(), botId: base.botId, text: `Live combos switched off: ${why}. Check the position on Kalshi.` })
        return say('combo_mismatch', `${why}; live combos are off until this is looked at`)
      }
      if (!pricing.confirmed) writeComboPricing({ ...pricing, confirmed: acc.reading })
      say('filled', `YES ${yes!.n} @ ${yesAvg.toFixed(2)}c, as the quote read`)
    }
  }

  // A live combo accepted with no fill seen yet: Kalshi's fills are read again
  // each reconcile. After thirty minutes with nothing, it is closed as not
  // filled; until then it blocks new live combos.
  private async resolveCombo(t: Ticket): Promise<void> {
    const acc = t.comboAccept!
    const rows = await (this.venues.kalshi as KalshiVenue).fillsSince(t.contract, acc.at)
    if (rows.length) return this.recordComboFills(t, rows)
    if (Date.now() - acc.at > 30 * 60_000) {
      this.update(t, { status: 'cancelled', error: 'no fill on Kalshi thirty minutes after the accept' })
      this.log(t.botId, t.botName, t.title, 'cancelled', 'no fill on Kalshi thirty minutes after the accept')
    }
  }

  // ── Day profit lock ──────────────────────────────────────────────────

  // Reads the day every 30 seconds while the engine runs. Live money is the
  // Kalshi account value, which Kalshi marks itself; paper is the paper
  // balance plus each open position at its bid. When the lock fires, the
  // index runs the same cash out as the button.
  private async checkProfitLock(): Promise<void> {
    if (Date.now() - this.lastLockAt < LOCK_EVERY_MS) return
    this.lastLockAt = Date.now()
    const lock = settingsStore.account().profitLock
    const value = lock.watch === 'live' ? this.state.venues.kalshi?.equityUsd ?? null : await this.paperMarked()
    if (value === null || value <= 0) { this.lockNowPct = null; return }
    const prev = this.lockDay ?? readLockDay()
    const start = rollDay(prev, today(), lock.watch, value)
    const { day, fire } = checkLock(lock, start, value)
    this.lockNowPct = dayPct(day, value)
    if (fire) day.firedAt = Date.now()
    if (JSON.stringify(day) !== JSON.stringify(prev)) writeLockDay(day)
    this.lockDay = day
    if (fire) this.emit('profitLock', fire)
  }

  // The paper balance plus every open paper position at what it could be sold
  // for now. A position with no bid counts at what it cost.
  private async paperMarked(): Promise<number | null> {
    const { balanceUsd } = this.paperState()
    if (balanceUsd === null) return null
    let marked = 0
    for (const t of ledger.active(2)) {
      if (t.venue !== 'paper' || !isOpen(t) || !(t.filledContracts > 0)) continue
      const held = t.filledContracts - (t.exit?.filledContracts ?? 0)
      const bid = await this.bidFor(t).catch(() => null)
      marked += bid ? (held * bid.bidC) / 100 : t.costUsd + t.feeUsd
    }
    return balanceUsd + marked
  }

  lockState(): LockState {
    const lock = settingsStore.account().profitLock
    const d = this.lockDay ?? readLockDay() ?? { day: today(), watch: lock.watch, startUsd: 0, highPct: 0, firedAt: null }
    const current = d.day === today() && d.watch === lock.watch
    return {
      ...(current ? d : { day: today(), watch: lock.watch, startUsd: 0, highPct: 0, firedAt: null }),
      enabled: lock.enabled,
      nowPct: current ? this.lockNowPct : null,
      armed: lock.enabled && !(current && d.firedAt)
    }
  }

  // ── Cash out ─────────────────────────────────────────────────────────

  // Every open position across every bot, sold now at the bid: the user's
  // "lock it in" button. The caller has already switched every bot off and
  // the kill switch on, so nothing re-enters and nothing rests on the book.
  // Kalshi sells are immediate or cancel and reduce only, so a sale can never
  // open a position; paper sells only what the real bid offers, as a taker.
  // `onlyInProfit` keeps any position whose bid is not above what was paid.
  async cashOutAll(onlyInProfit: boolean, scope: 'all' | 'live' | 'paper' = 'all'): Promise<Omit<CashOutResult, 'botsOff'>> {
    // Never alongside a cycle, which could be selling the same position.
    for (let i = 0; this.busy && i < 600; i++) await new Promise((r) => setTimeout(r, 100))
    if (this.busy) throw new Error('The engine is still in the middle of a cycle. Try again in a moment.')
    this.busy = true
    try {
      return await this.sellEverything(onlyInProfit, scope)
    } finally {
      this.busy = false
    }
  }

  private async sellEverything(onlyInProfit: boolean, scope: 'all' | 'live' | 'paper'): Promise<Omit<CashOutResult, 'botsOff'>> {
    const out: Omit<CashOutResult, 'botsOff'> = { sold: 0, partly: 0, kept: [], contracts: 0, pnlUsd: 0 }
    const keep = (t: Ticket, why: string): void => { out.kept.push({ title: t.title, why }) }
    const kalshi = this.venues.kalshi
    for (const t of ledger.active(2)) {
      if (!isOpen(t) || t.status === 'dry_run' || !(t.filledContracts > 0) || t.avgFillC === null) continue
      if ((scope === 'live' && t.venue === 'paper') || (scope === 'paper' && t.venue !== 'paper')) continue
      if (t.priceSource !== 'kalshi' || (t.venue !== 'paper' && t.venue !== 'kalshi')) { keep(t, `${t.venue} positions cannot be sold from the app yet`); continue }
      try {
        let exit: TicketExit = t.exit ?? { ...newExit('mark', t.avgFillC, 0), status: 'waiting' }
        if (t.venue === 'kalshi') {
          if (!kalshi.sell || !kalshi.findOrder) { keep(t, 'selling is not available'); continue }
          if (exit.pending) { keep(t, 'an earlier sell is still being confirmed; checked on the next cycle'); continue }
          // The kill switch pulled any resting sell; count what it sold first.
          if (exit.orderId) {
            const u = await kalshi.status(exit.orderId, { contract: t.contract, side: t.side })
            if (!u) { keep(t, 'its resting sell could not be read'); continue }
            exit = { ...withOrderTotals(exit, { contracts: u.filledContracts, avgC: u.avgFillC, feeUsd: u.feeUsd }), status: 'waiting', orderId: null, prior: undefined, killed: false }
          }
        }
        const held = t.filledContracts - exit.filledContracts
        if (nothingHeld(held)) { this.recordExit(t, exit, 'everything held had sold'); continue }
        const bid = await this.bidFor(t)
        if (!bid) { keep(t, 'nobody is bidding on it right now'); continue }
        if (onlyInProfit && bid.bidC <= t.avgFillC) { keep(t, `the bid ${bid.bidC}c is not above the ${t.avgFillC}c paid`); continue }

        let fill: { contracts: number; priceC: number; feeUsd: number } | null
        if (t.venue === 'paper') {
          const n = Math.min(held, bid.size)
          fill = { contracts: n, priceC: bid.bidC, feeUsd: exitFee(bid.bidC, n, true) }
        } else {
          const clientOrderId = `${t.id.slice(0, 36)}-c${Date.now().toString(36)}`
          this.update(t, { exit: { ...exit, pending: { clientOrderId, timeInForce: 'ioc', sentAt: Date.now() }, cashout: true } })
          const res = await kalshi.sell!({ contract: t.contract, side: t.side, contracts: held, priceC: bid.bidC, timeInForce: 'ioc', clientOrderId })
          if (!res.ok) {
            if (res.retryable) { keep(t, `the sell was not confirmed (${res.error}); it is checked on the next cycle`); continue }
            this.update(t, { exit: { ...exit, pending: null, cashout: true } })
            keep(t, `Kalshi refused the sell: ${res.error}`); continue
          }
          fill = res.filledContracts > 0 ? { contracts: res.filledContracts, priceC: res.avgFillC ?? bid.bidC, feeUsd: res.feeUsd } : null
        }
        const next: TicketExit = { ...(fill ? addExitFill(exit, fill) : exit), pending: null, cashout: true }
        if (!fill || fill.contracts < 1) { this.update(t, { exit: next }); keep(t, `no contracts sold at the ${bid.bidC}c bid`); continue }
        this.recordExit(t, next, `cash out: sold ${fill.contracts} @ ${fill.priceC}c`)
        out.contracts += fill.contracts
        out.pnlUsd += fill.contracts * (fill.priceC - t.avgFillC) / 100 - fill.feeUsd
        if (next.filledContracts >= t.filledContracts) out.sold++
        else { out.partly++; keep(t, `only ${fill.contracts} of ${held} were bid for at ${fill.priceC}c; the rest is held to settlement`) }
      } catch (err) {
        keep(t, (err as Error).message.slice(0, 160))
      }
    }
    out.pnlUsd = Math.round(out.pnlUsd * 100) / 100
    this.emitState()
    return out
  }

  // The game clock for a ticket, from this cycle's board.
  private clockOf(t: Ticket): Signal['clock'] {
    return this.state.board.find((s) => s.gameId === t.gameId && s.clock)?.clock ?? null
  }

  // The bid on the side this ticket holds, from the other side's ask.
  private async bidFor(t: Ticket): Promise<{ bidC: number; size: number } | null> {
    const venue = this.venues[t.venue === 'paper' ? t.priceSource : t.venue]
    await this.bookSlot()
    const other = await venue.quote(t.contract, t.side === 'yes' ? 'no' : 'yes')
    return other ? bidFromOtherAsk(other.ask, other.askSize) : null
  }

  private async paperExit(t: Ticket, exit: TicketExit, held: number): Promise<void> {
    const bid = await this.bidFor(t)
    const fill = paperExitFill(exit, held, bid)
    if (!fill) return
    this.recordExit(t, addExitFill(exit, fill), `${exit.mode} sold ${fill.contracts} @ ${fill.priceC}c (bid ${bid!.bidC}c x ${bid!.size})`)
  }

  // Every sell is written to the ledger as pending before it is sent, so an
  // answer lost to a timeout or a crash is looked up on Kalshi by its client
  // order id, never sent a second time. The kill switch is read again just
  // before every sell, and a limit sell that lands after it was pressed is
  // pulled straight back.
  private async kalshiExit(t: Ticket, exit: TicketExit, held: number): Promise<void> {
    const venue = this.venues.kalshi
    if (!venue.sell || !venue.findOrder) return
    const killed = (): boolean => settingsStore.account().killSwitch
    const totals = (u: { filledContracts: number; avgFillC: number | null; feeUsd: number | null }) => ({ contracts: u.filledContracts, avgC: u.avgFillC, feeUsd: u.feeUsd })

    if (exit.pending) {
      const p = exit.pending
      const id = await venue.findOrder(t.contract, p.clientOrderId)
      // Just sent and not listed yet: unknown, not absent. Look again later.
      if (!id && p.sentAt && Date.now() - p.sentAt < 60_000) return
      if (!id) {
        // It never reached the book. Clear it and carry on as before.
        exit = { ...exit, pending: null }
        this.update(t, { exit })
      } else {
        const u = await venue.status(id, { contract: t.contract, side: t.side })
        if (!u) return
        const base: TicketExit = { ...exit, pending: null, prior: { contracts: exit.filledContracts, avgC: exit.avgC, feeUsd: exit.feeUsd } }
        if (p.timeInForce === 'gtc') {
          let found = withOrderTotals({ ...base, status: 'resting', orderId: id }, totals(u))
          // Found after the kill switch was pressed: pull it straight back.
          if (killed() && !u.done && found.filledContracts < t.filledContracts) {
            try { await venue.cancel(id, t.contract); found = { ...found, killed: true } } catch (err) { this.log(t.botId, t.botName, t.title, 'cancel_failed', (err as Error).message) }
          }
          return this.recordExit(t, found, 'found the limit sell on the book')
        }
        return this.recordExit(t, { ...withOrderTotals(base, totals(u)), prior: undefined }, `found the mark sell: ${u.filledContracts} sold`)
      }
      held = t.filledContracts - exit.filledContracts
    }

    if (exit.mode === 'limit') {
      if (exit.status === 'waiting') {
        if (killed()) return
        const clientOrderId = `${t.id.slice(0, 36)}-x${Date.now().toString(36)}`
        this.update(t, { exit: { ...exit, pending: { clientOrderId, timeInForce: 'gtc', sentAt: Date.now() } } })
        const res = await venue.sell({ contract: t.contract, side: t.side, contracts: held, priceC: exit.targetC, timeInForce: 'gtc', clientOrderId })
        if (!res.ok) {
          // A timeout or a server error may have landed: it stays pending and is looked up next cycle.
          if (res.retryable) return this.log(t.botId, t.botName, t.title, 'exit_retry', `limit sell not confirmed: ${res.error}`)
          return this.recordExit(t, { ...exit, pending: null, status: 'failed', error: res.error }, `limit sell refused: ${res.error}`)
        }
        let next = withOrderTotals({ ...exit, pending: null, status: 'resting', orderId: res.venueOrderId, prior: { contracts: exit.filledContracts, avgC: exit.avgC, feeUsd: exit.feeUsd } }, totals(res))
        if (killed() && res.venueOrderId && next.filledContracts < t.filledContracts) {
          try { await venue.cancel(res.venueOrderId, t.contract); next = { ...next, killed: true } } catch (err) { this.log(t.botId, t.botName, t.title, 'cancel_failed', (err as Error).message) }
        }
        return this.recordExit(t, next, `limit sell resting: ${held} @ ${exit.targetC}c`)
      }
      if (exit.status === 'resting' && exit.orderId) {
        const u = await venue.status(exit.orderId, { contract: t.contract, side: t.side })
        if (!u) return
        // Kalshi reports this order's own totals; what sold before it is kept.
        const next = withOrderTotals(exit, totals(u))
        const ended = u.done && next.filledContracts < t.filledContracts
        if (next.filledContracts === exit.filledContracts && !ended) return
        // Pulled by the kill switch: keep what sold and place the rest again later.
        if (ended && exit.killed) return this.recordExit(t, { ...next, status: 'waiting', orderId: null, prior: undefined, killed: false }, `limit sell pulled by the kill switch after ${next.filledContracts} sold`)
        // A sell that ended unfilled or part filled leaves the rest to settle.
        return this.recordExit(t, ended ? { ...next, status: 'failed', orderId: null, error: 'the limit sell ended before it all sold' } : next,
          ended ? 'limit sell ended; the rest is held to settlement' : `limit sold ${next.filledContracts} @ ${next.avgC}c`)
      }
      return
    }
    // mark: sell at the bid once it reaches the target, never more than held.
    // time: the same sell, once it is due, with a target any bid meets.
    if (killed()) return
    const bid = await this.bidFor(t)
    if (!bid || bid.bidC < exit.targetC || killed()) return
    const clientOrderId = `${t.id.slice(0, 36)}-m${Date.now().toString(36)}`
    this.update(t, { exit: { ...exit, pending: { clientOrderId, timeInForce: 'ioc', sentAt: Date.now() } } })
    const res = await venue.sell({ contract: t.contract, side: t.side, contracts: held, priceC: bid.bidC, timeInForce: 'ioc', clientOrderId })
    if (!res.ok) {
      if (res.retryable) return this.log(t.botId, t.botName, t.title, 'exit_retry', `${exit.mode} sell not confirmed: ${res.error}`)
      this.update(t, { exit: { ...exit, pending: null } })
      return this.log(t.botId, t.botName, t.title, 'exit_failed', `${exit.mode} sell refused: ${res.error}`)
    }
    const cleared: TicketExit = { ...exit, pending: null }
    if (!(res.filledContracts > 0)) return this.update(t, { exit: cleared })
    this.recordExit(t, addExitFill(cleared, { contracts: res.filledContracts, priceC: res.avgFillC ?? bid.bidC, feeUsd: res.feeUsd }), `${exit.mode} sold ${res.filledContracts} @ ${res.avgFillC ?? bid.bidC}c`)
  }

  // Writes the exit; once everything held is sold, the ticket closes with its P&L.
  private recordExit(t: Ticket, exit: TicketExit, detail: string): void {
    const allSold = exit.filledContracts >= t.filledContracts
    const done: TicketExit = allSold ? { ...exit, status: 'done', orderId: null } : exit
    this.update(t, allSold ? { exit: done, status: 'exited', pnlUsd: positionPnl({ ...t, exit: done }, null) } : { exit: done })
    this.log(t.botId, t.botName, t.title, allSold ? 'exited' : `exit_${exit.status}`, detail)
  }

  // A paper bid waits like a real one (2026-11-21): it fills only when the
  // live ask on the venue it was priced off comes down to it, at its own
  // price, no more contracts than the ask offers, with Kalshi's resting fee;
  // past its wait it is cancelled with nothing filled. One partly filled is
  // done, the rest cancelled, so a paper record never assumes a later fill.
  private async paperBids(): Promise<void> {
    for (const t of ledger.active(1)) {
      if (t.venue !== 'paper' || t.status !== 'resting' || !t.restS) continue
      const book = await this.venues[t.priceSource].quote(t.contract, t.side).catch(() => null)
      const askC = book?.ask == null ? null : Math.round(book.ask * 100)
      if (askC !== null && askC <= t.limitPriceC) {
        const filled = Math.min(t.contracts, Math.floor(book?.askSize ?? 0))
        if (filled > 0) {
          this.update(t, {
            status: filled < t.contracts ? 'partial' : 'filled', filledContracts: filled, avgFillC: t.limitPriceC,
            feeUsd: Math.ceil(kalshiFee(t.limitPriceC / 100, filled, false) * 100 - 1e-9) / 100,
            costUsd: (filled * t.limitPriceC) / 100,
            audit: [...t.audit, `paper bid filled ${filled} @ ${t.limitPriceC}c when the ask came down to ${askC}c`]
          })
          this.log(t.botId, t.botName, t.title, 'filled', `paper bid ${filled} @ ${t.limitPriceC}c`)
          continue
        }
      }
      if (Date.now() - t.createdAt > t.restS * 1000) {
        this.update(t, { status: 'cancelled', costUsd: 0, error: `the bid at ${t.limitPriceC}c waited ${t.restS}s and the ask never came down to it` })
      }
    }
  }

  private update(t: Ticket, patch: Partial<Ticket>): void {
    const next = { ...t, ...patch, updatedAt: Date.now() }
    ledger.append({ type: 'ticket', ticket: next })
    this.emit('ticket', next)
  }

  // ── Paper balance ────────────────────────────────────────────────────

  private paperState(): VenueState {
    const start = settingsStore.account().venues.paper.startingBalanceUsd
    const paper = ledger.tickets(3650).filter((t) => t.venue === 'paper')
    const open = paper.filter(isOpen).reduce((s, t) => s + t.costUsd + t.feeUsd, 0)
    const settled = paper.reduce((s, t) => s + (t.pnlUsd ?? 0), 0)
    const balance = start + settled - open
    return { balanceUsd: balance, equityUsd: balance + open }
  }

  // ── Bookkeeping ──────────────────────────────────────────────────────

  private skip(bot: BotSettings, s: Signal, gate: string, detail: string): void {
    // Every skip, of any gate, goes to the missed plays record with the play
    // as it looked, so a night's skips can be graded against how they ended.
    missed.note(bot.id, s, gate, detail)
    // A gate that only restates the bot's settings is shown on the Board and
    // kept out of the ledger (it was 96% of it).
    if (SETTINGS_GATES.has(gate)) return
    // One ledger line per bot, signal and gate per day, like the Python
    // decline throttle, so the record says why without a line every cycle.
    if (this.skipDay !== today()) { this.skipSeen.clear(); this.skipDay = today() }
    const key = `${today()}|${bot.id}|${s.key}|${gate}`
    if (this.skipSeen.has(key)) return
    this.skipSeen.add(key)
    ledger.append({ type: 'skip', at: Date.now(), botId: bot.id, signalKey: s.key, gate, detail })
    if (isLimitGate(gate)) { this.rollHeld(); this.addHeld(bot.id, gate, s.key) }
    this.log(bot.id, bot.name, s.title, `skip:${gate}`, detail)
  }

  private log(botId: string, botName: string, title: string, outcome: string, detail: string): void {
    this.state.recent.unshift({ at: Date.now(), botId, botName, title, outcome, detail })
    this.state.recent.length = Math.min(this.state.recent.length, 300)
  }

  private emitState(): void {
    this.emit('state', this.state)
  }
}

function tally(refused: { source: string; reason: string }[]): SupervisorState['refused'] {
  const m = new Map<string, { source: string; reason: string; count: number }>()
  for (const r of refused) {
    const k = `${r.source}|${r.reason}`
    const e = m.get(k)
    if (e) e.count++
    else m.set(k, { ...r, count: 1 })
  }
  return [...m.values()].sort((a, b) => b.count - a.count)
}
