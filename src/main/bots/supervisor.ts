// Every bot, one loop. Pull the board, requote each candidate from the live
// book, run each enabled bot's gates, place, then reconcile fills and
// settlements against the venue's own record. Runs only while the app is
// open (decision 14).
import { app } from 'electron'
import { EventEmitter } from 'node:events'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { checkLock, dayPct, rollDay, type LockDay, type LockState } from '@shared/profitlock'
import { tradingDay } from '@shared/day'
import { addExitFill, bidFromOtherAsk, exitFee, newExit, paperExitFill, positionPnl, withOrderTotals, type CashOutResult, type TicketExit } from '@shared/exits'
import { isLimitGate, type HeldBack, type LimitGate } from '@shared/limits'
import { rulesOf } from '@shared/review'
import type { AccountSettings, BotSettings, VenueId } from '@shared/schema'
import { playTags, type BotVerdict, type Signal, type VenueQuote } from '@shared/signal'
import { screen, type Candidate } from '../ai/agent'
import { accuracy } from './accuracy'
import { ai } from '../ai/registry'
import { lazyedge, NotSignedInError, PlanInactiveError } from '../data/lazyedge'
import { matchupOf, mlbEdges, nflBoardPhase, nbaLiveEdges, nbaProps, nbaRowProblem, nbaSpreadLadder, nflBoardRows, nflHotPlays, nflMarketMaps, type NflMarketMap, type Normalized } from '../data/normalize'
import { evaluate, preGates, type GateContext, type TradeDecision, type VenueState } from '../rules/gates'
import type { Position } from '../rules/stance'
import { isOpen, ledger, type Ticket } from '../store/ledger'
import { settingsStore } from '../store/settings'
import { terms } from '../store/terms'
import { KalshiVenue } from '../venues/kalshi'
import { PaperVenue } from '../venues/paper'
import { PolymarketVenue } from '../venues/polymarket'
import type { Venue } from '../venues/types'

const BOARD_EVERY_MS = 5 * 60_000 // pregame boards move slowly; live plays are polled every cycle
// One spread ladder call per live NBA game; every 30s keeps a full slate well
// inside the basic tier's 60 requests a minute.
const NBA_LADDER_EVERY_MS = 30_000
const NBA_PROPS_EVERY_MS = 30_000
const LOCK_EVERY_MS = 30_000

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
const SETTINGS_GATES = new Set(['sport_not_enabled', 'lane_not_enabled', 'phase_not_enabled', 'label_not_enabled', 'label_never_traded', 'not_measured', 'no_trigger', 'quarter_not_enabled'])
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
  dryRun: boolean
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
  // Ticket id -> settlement passes spent waiting to read an exit's last fills.
  private settleTries = new Map<string, number>()
  private lastLockAt = 0
  private lockDay: LockDay | null = null
  private lockNowPct: number | null = null
  private skipSeen = new Set<string>()
  private guide = ''
  // One book read per signal per cycle, shared by every bot that looks at it.
  private requoting = new Map<string, Promise<Signal>>()
  private requoted = new Map<string, Signal>()
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
    return { ...rest, limits: this.limits(), profitLock: this.lockState() }
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
      dryRun: account.executionMode === 'dry_run',
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
      const feed = await this.feed(everyBot)
      this.state.signals = feed.signals.length
      this.state.refused = tally(feed.refused)

      this.requoting.clear()
      this.requoted.clear()
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
        await this.runBot(bot, account, feed.signals, venueStates, preview)
      }
      for (const bot of bots) await run(bot, false)
      for (const bot of everyBot.filter((b) => !b.enabled)) await run(bot, true)
      // The board shows the live price wherever a bot read the book this cycle.
      // It is grouped by game on screen, so it carries the whole slate.
      this.state.board = feed.signals.slice(0, 3000).map((s) => this.requoted.get(s.key) ?? s)
      this.state.verdicts = this.verdicts

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

    if (sports.has('NFL')) {
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
      // The board is cached for five minutes, so whether its game has kicked
      // off is worked out again every cycle.
      add({ refused: this.boardCache.refused, signals: this.boardCache.signals.map((s) => ({ ...s, ...nflBoardPhase(this.nflMaps[s.gameId], now) })) })
      add(nflHotPlays(await lazyedge.nflLivePlays(), now, this.nflMaps))
    }
    if (sports.has('MLB')) add(mlbEdges(await lazyedge.mlbEdges(), now))
    if (sports.has('NBA')) {
      const live = await lazyedge.nbaLive()
      add(nbaLiveEdges(live, now))
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
    }
    // Player props only load for a bot that trades the props lane: the slate
    // is several hundred rows, cached for 30s.
    if (sports.has('NBA') && bots.some((b) => b.market.sports.includes('NBA') && b.market.lanes.includes('PROP'))) {
      if (!this.nbaPropsCache || now - this.nbaPropsCache.at > NBA_PROPS_EVERY_MS) {
        try {
          this.nbaPropsCache = { at: now, body: await lazyedge.nbaProps() }
        } catch (err) {
          out.refused.push({ source: 'nba.props', reason: (err as Error).message.slice(0, 80) })
        }
      }
      if (this.nbaPropsCache) add(nbaProps(this.nbaPropsCache.body, this.nbaPropsCache.at))
    }
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
        quotes.push(fresh ? { ...q, ask: fresh.ask, askSize: fresh.askSize, priceAgeS: fresh.priceAgeS, feeRate } : { ...q, priceAgeS: null })
      } catch {
        quotes.push({ ...q, priceAgeS: null }) // unreadable book is stale, never trusted
      }
    }
    const edges = quotes.filter((q) => q.ask !== null && signal.ourP !== null).map((q) => (signal.ourP! - q.ask!) * 100)
    return { ...signal, quotes, edgePp: edges.length ? Math.max(...edges) : null }
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
    const asIf = preview ? { ...bot, enabled: true } : bot
    const verdict = (s: Signal, outcome: BotVerdict['outcome'], gate: string | null, detail: string): void => {
      ;(this.verdicts[s.key] ??= []).push({ botId: bot.id, botName: bot.name, enabled: !preview, outcome, gate, detail })
    }
    const skip = (s: Signal, gate: string, detail: string): void => {
      verdict(s, 'skip', gate, detail)
      if (!preview) this.skip(bot, s, gate, detail)
    }

    const survivors: Signal[] = []
    for (const raw of signals) {
      if (!bot.market.sports.includes(raw.sport) || !bot.market.lanes.includes(raw.lane)) continue
      if (bot.market.phase !== 'both' && bot.market.phase !== raw.phase) continue
      if (!raw.quotes.length) { skip(raw, 'no_venue', 'no contract on this signal'); continue }
      if (bot.guards.onePositionPerMarket && (openKeys.has(raw.key) || raw.quotes.some((q) => openKeys.has(q.contract)))) { verdict(raw, 'holding', null, 'already holds this market'); continue }
      const pre = preGates(raw, asIf, account, this.context(bot, raw, mine, tickets, venues, openKeys))
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
    for (const signal of fresh) {
      const ctx = this.context(bot, signal, mine, tickets, venues, openKeys)
      ctx.botTradesToday += pendingTrades
      ctx.gameExposureUsd += pendingGameUsd.get(signal.gameId) ?? 0
      ctx.accountOpenExposureUsd += pendingLiveUsd
      ctx.gamePositions = [...ctx.gamePositions, ...pendingPositions.filter((p) => p.gameId === signal.gameId)]
      const decision = evaluate(signal, asIf, account, ctx)
      if (decision.kind === 'skip') { skip(signal, decision.gate, decision.detail); continue }
      const what = `${decision.side.toUpperCase()} ${decision.contracts} @ ${decision.limitPriceC}c on ${decision.venue}, ev ${decision.evCents.toFixed(1)}c`
      verdict(signal, 'take', null, bot.decider.kind === 'agent' ? `${what}; the agent screens it first` : what)
      if (preview) continue
      pendingTrades++
      pendingGameUsd.set(signal.gameId, (pendingGameUsd.get(signal.gameId) ?? 0) + decision.costUsd)
      if (decision.venue !== 'paper' && !decision.dryRun) pendingLiveUsd += decision.costUsd
      // One per market, and no bet against it, even within a cycle.
      openKeys.add(signal.key)
      openKeys.add(decision.contract)
      pendingPositions.push({ contract: decision.contract, side: decision.side, gameId: signal.gameId })
      // A rules bot places the moment a play passes, while the price is fresh.
      if (bot.decider.kind === 'rules') await this.place(bot, signal, decision, null)
      else candidates.push({ id: signal.key, signal, decision })
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

  private context(bot: BotSettings, signal: Signal, mine: Ticket[], all: Ticket[], venues: Partial<Record<VenueId, VenueState>>, openKeys: Set<string>): GateContext {
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
      openMarketKeys: openKeys,
      gamePositions: mine.filter((t) => isOpen(t) && t.gameId === signal.gameId).map((t) => ({ contract: t.contract, side: t.side })),
      gameExposureUsd: openCost(mine.filter((t) => t.gameId === signal.gameId)),
      accountOpenExposureUsd: openCost(all.filter((t) => t.venue !== 'paper')),
      botDailyPnlUsd: realised(todays(mine)),
      accountDailyPnlUsd: realised(todays(all.filter((t) => t.venue !== 'paper'))),
      // A paper order the book could not fill was never a trade.
      botTradesToday: todays(mine).filter((t) => t.status !== 'rejected' && !(t.status === 'cancelled' && t.filledContracts === 0)).length,
      // Only entries that held contracts: an order whose answer was lost keeps
      // its key, so Kalshi still refuses it as a duplicate.
      entriesToday: todays(mine).filter((t) => t.signalKey === signal.key && t.filledContracts > 0).length
    }
  }

  private async place(bot: BotSettings, signal: Signal, d: TradeDecision, agentReason: string | null): Promise<void> {
    // Re-read at the last moment. A kill switch, a switch back to dry run, a
    // bot turned off or new terms, made while this cycle was running, win.
    if (d.venue !== 'paper') {
      const account = settingsStore.account()
      const current = settingsStore.bots().find((b) => b.id === bot.id)
      const stop = account.killSwitch ? 'kill_switch' : !current?.enabled || current.mode !== 'live' ? 'bot_disabled' : !terms.status().accepted ? 'terms_not_accepted' : null
      if (stop) { this.skip(bot, signal, stop, 'changed while the cycle was running'); return }
      d = { ...d, dryRun: d.dryRun || account.executionMode === 'dry_run' }
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
      // A dry run and a book that never filled hold nothing to sell. Kalshi,
      // and paper priced off Kalshi, can sell; anything else holds to settlement.
      exit: bot.exit.mode !== 'hold' && !d.dryRun && res.ok && res.status !== 'cancelled' && res.status !== 'rejected' && d.priceSource === 'kalshi' && (d.venue === 'paper' || d.venue === 'kalshi')
        ? newExit(bot.exit.mode, res.avgFillC ?? d.limitPriceC, bot.exit.targetC)
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
    this.log(bot.id, bot.name, signal.title, res.ok ? (d.dryRun ? 'dry_run' : res.status) : 'rejected', res.error ? `${what}: ${res.error}` : what)
    this.emit('ticket', ticket)
  }

  // ── Reconcile ────────────────────────────────────────────────────────

  private async reconcile(): Promise<void> {
    // Every open trade, however old, so a week away still ends with each
    // settlement recorded. The list is in memory; only open ones reach a venue.
    for (const t of ledger.tickets(3650)) {
      if (t.pnlUsd !== null || !['resting', 'partial', 'filled'].includes(t.status)) continue
      const venue = this.venues[t.venue]
      try {
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
          if (t.status === 'resting' && bot && Date.now() - t.createdAt > (bot.guards.autoCancelS + 30) * 1000) {
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
      if (held < 1 && !exit.pending) { this.recordExit(t, exit, 'everything held has sold'); continue }
      // Cashed out by hand: only an unconfirmed sell is still looked up.
      if (exit.cashout && !exit.pending) continue
      try {
        if (t.venue === 'paper') await this.paperExit(t, exit, held)
        // Under the kill switch only the read only lookup of a pending sell runs.
        else if (t.venue === 'kalshi' && (!killed || exit.pending)) await this.kalshiExit(t, exit, held)
      } catch (err) {
        this.log(t.botId, t.botName, t.title, 'exit_failed', (err as Error).message.slice(0, 160))
      }
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
      if (t.venue !== 'paper' || !isOpen(t) || t.filledContracts < 1) continue
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
  async cashOutAll(onlyInProfit: boolean): Promise<Omit<CashOutResult, 'botsOff'>> {
    // Never alongside a cycle, which could be selling the same position.
    for (let i = 0; this.busy && i < 600; i++) await new Promise((r) => setTimeout(r, 100))
    if (this.busy) throw new Error('The engine is still in the middle of a cycle. Try again in a moment.')
    this.busy = true
    try {
      return await this.sellEverything(onlyInProfit)
    } finally {
      this.busy = false
    }
  }

  private async sellEverything(onlyInProfit: boolean): Promise<Omit<CashOutResult, 'botsOff'>> {
    const out: Omit<CashOutResult, 'botsOff'> = { sold: 0, partly: 0, kept: [], contracts: 0, pnlUsd: 0 }
    const keep = (t: Ticket, why: string): void => { out.kept.push({ title: t.title, why }) }
    const kalshi = this.venues.kalshi
    for (const t of ledger.active(2)) {
      if (!isOpen(t) || t.status === 'dry_run' || t.filledContracts < 1 || t.avgFillC === null) continue
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
        if (held < 1) { this.recordExit(t, exit, 'everything held had sold'); continue }
        const bid = await this.bidFor(t)
        if (!bid) { keep(t, 'nobody is bidding on it right now'); continue }
        if (onlyInProfit && bid.bidC <= t.avgFillC) { keep(t, `the bid ${bid.bidC}c is not above the ${t.avgFillC}c paid`); continue }

        let fill: { contracts: number; priceC: number; feeUsd: number } | null
        if (t.venue === 'paper') {
          const n = Math.min(held, bid.size)
          fill = { contracts: n, priceC: bid.bidC, feeUsd: exitFee(bid.bidC, n, true) }
        } else {
          const clientOrderId = `${t.id.slice(0, 36)}-c${Date.now().toString(36)}`
          this.update(t, { exit: { ...exit, pending: { clientOrderId, timeInForce: 'ioc' }, cashout: true } })
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
    this.recordExit(t, addExitFill(exit, fill), `${exit.mode === 'limit' ? 'limit' : 'mark'} sold ${fill.contracts} @ ${fill.priceC}c (bid ${bid!.bidC}c x ${bid!.size})`)
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
        this.update(t, { exit: { ...exit, pending: { clientOrderId, timeInForce: 'gtc' } } })
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
    if (killed()) return
    const bid = await this.bidFor(t)
    if (!bid || bid.bidC < exit.targetC || killed()) return
    const clientOrderId = `${t.id.slice(0, 36)}-m${Date.now().toString(36)}`
    this.update(t, { exit: { ...exit, pending: { clientOrderId, timeInForce: 'ioc' } } })
    const res = await venue.sell({ contract: t.contract, side: t.side, contracts: held, priceC: bid.bidC, timeInForce: 'ioc', clientOrderId })
    if (!res.ok) {
      if (res.retryable) return this.log(t.botId, t.botName, t.title, 'exit_retry', `mark sell not confirmed: ${res.error}`)
      this.update(t, { exit: { ...exit, pending: null } })
      return this.log(t.botId, t.botName, t.title, 'exit_failed', `mark sell refused: ${res.error}`)
    }
    const cleared: TicketExit = { ...exit, pending: null }
    if (res.filledContracts < 1) return this.update(t, { exit: cleared })
    this.recordExit(t, addExitFill(cleared, { contracts: res.filledContracts, priceC: res.avgFillC ?? bid.bidC, feeUsd: res.feeUsd }), `mark sold ${res.filledContracts} @ ${res.avgFillC ?? bid.bidC}c`)
  }

  // Writes the exit; once everything held is sold, the ticket closes with its P&L.
  private recordExit(t: Ticket, exit: TicketExit, detail: string): void {
    const allSold = exit.filledContracts >= t.filledContracts
    const done: TicketExit = allSold ? { ...exit, status: 'done', orderId: null } : exit
    this.update(t, allSold ? { exit: done, status: 'exited', pnlUsd: positionPnl({ ...t, exit: done }, null) } : { exit: done })
    this.log(t.botId, t.botName, t.title, allSold ? 'exited' : `exit_${exit.status}`, detail)
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
    // A gate that only restates the bot's settings is shown on the Board,
    // not written: it was 96% of the ledger and explains nothing new.
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
