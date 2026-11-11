// Every bot, one loop. Pull the board, requote each candidate from the live
// book, run each enabled bot's gates, place, then reconcile fills and
// settlements against the venue's own record. Runs only while the app is
// open (decision 14).
import { app } from 'electron'
import { EventEmitter } from 'node:events'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tradingDay } from '@shared/day'
import { isLimitGate, type HeldBack, type LimitGate } from '@shared/limits'
import { rulesOf } from '@shared/review'
import type { AccountSettings, BotSettings, VenueId } from '@shared/schema'
import { playTags, type BotVerdict, type Signal, type VenueQuote } from '@shared/signal'
import { screen, type Candidate } from '../ai/agent'
import { accuracy } from './accuracy'
import { ai } from '../ai/registry'
import { lazyedge, NotSignedInError, PlanInactiveError } from '../data/lazyedge'
import { matchupOf, mlbEdges, nbaLiveEdges, nbaRowProblem, nbaSpreadLadder, nflBoardRows, nflHotPlays, nflMarketMaps, type NflMarketMap, type Normalized } from '../data/normalize'
import { evaluate, preGates, type GateContext, type TradeDecision, type VenueState } from '../rules/gates'
import { ledger, type Ticket } from '../store/ledger'
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
const RECONCILE_EVERY_MS = 30_000
// Book reads run in parallel but are spaced to stay inside Kalshi's basic
// tier of 20 reads a second, shared with everything else the app reads.
const REQUOTE_CONCURRENCY = 6
const REQUOTE_SPACING_MS = 70
// Gates that only restate a bot's own settings. The Board shows them live;
// writing one ledger line per spread rung for them was 96% of the ledger.
const SETTINGS_GATES = new Set(['sport_not_enabled', 'lane_not_enabled', 'phase_not_enabled', 'label_not_enabled', 'label_never_traded', 'not_measured', 'no_trigger'])
const OPEN: Ticket['status'][] = ['resting', 'filled', 'partial', 'dry_run']

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
const openCost = (ts: Ticket[]): number => ts.filter((t) => OPEN.includes(t.status) && t.pnlUsd === null && t.status !== 'dry_run').reduce((s, t) => s + t.costUsd, 0)

export class Supervisor extends EventEmitter {
  private timer: NodeJS.Timeout | null = null
  private busy = false
  private lastBoardAt = 0
  private lastReconcileAt = 0
  private boardCache: Normalized = { signals: [], refused: [] }
  // game_id -> the Kalshi tickers /v1/nfl/edges publishes from nfl_market_map.
  private nflMaps: Record<string, NflMarketMap> = {}
  private nbaLadders = new Map<string, { at: number; rungs: unknown }>()
  private skipSeen = new Set<string>()
  private anchors: Record<string, number> = {}
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
    this.loadAnchors()
  }

  // Everything but the board, which is large and only the Board screen needs.
  // The limits are worked out fresh, so a cap saved on Account shows at once.
  publicState(): Omit<SupervisorState, 'board' | 'verdicts'> & { limits: LimitsState } {
    const { board: _b, verdicts: _v, ...rest } = this.state
    return { ...rest, limits: this.limits() }
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
      openLiveUsd: openCost(ledger.tickets(2).filter((t) => t.venue !== 'paper')),
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
    void this.cycle()
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
    for (const t of ledger.tickets(2)) {
      if ((t.status !== 'resting' && t.status !== 'partial') || !t.venueOrderId || t.venue === 'paper') continue
      try {
        await this.venues[t.venue].cancel(t.venueOrderId, t.contract)
        this.update(t, { status: t.filledContracts > 0 ? 'partial' : 'cancelled', venueOrderId: null, costUsd: filledCost(t.filledContracts, t.avgFillC, t.limitPriceC) })
      } catch (err) {
        this.log(t.botId, t.botName, t.title, 'cancel_failed', (err as Error).message)
      }
    }
    this.emitState()
  }

  async cycle(): Promise<void> {
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
      this.verdicts = {}
      for (const bot of bots) await this.runBot(bot, account, feed.signals, venueStates, false)
      for (const bot of everyBot.filter((b) => !b.enabled)) await this.runBot(bot, account, feed.signals, venueStates, true)
      // The board shows the live price wherever a bot read the book this cycle.
      // It is grouped by game on screen, so it carries the whole slate.
      this.state.board = feed.signals.slice(0, 3000).map((s) => this.requoted.get(s.key) ?? s)
      this.state.verdicts = this.verdicts

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
      add(this.boardCache)
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
      const eq = out[id]!.equityUsd
      const key = `${today()}:${id}`
      if (eq !== null && this.anchors[key] === undefined) { this.anchors[key] = eq; this.saveAnchors() }
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
    const tickets = ledger.tickets(2)
    const mine = tickets.filter((t) => t.botId === bot.id)
    const openKeys = new Set(mine.filter((t) => OPEN.includes(t.status) && t.pnlUsd === null).map((t) => t.signalKey))
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
      if (openKeys.has(raw.key) && bot.guards.onePositionPerMarket) { verdict(raw, 'holding', null, 'already holds this market'); continue }
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
    const candidates: Candidate[] = []
    for (const signal of fresh) {
      const ctx = this.context(bot, signal, mine, tickets, venues, openKeys)
      ctx.botTradesToday += pendingTrades
      ctx.gameExposureUsd += pendingGameUsd.get(signal.gameId) ?? 0
      ctx.accountOpenExposureUsd += pendingLiveUsd
      const decision = evaluate(signal, asIf, account, ctx)
      if (decision.kind === 'skip') { skip(signal, decision.gate, decision.detail); continue }
      const what = `${decision.side.toUpperCase()} ${decision.contracts} @ ${decision.limitPriceC}c on ${decision.venue}, ev ${decision.evCents.toFixed(1)}c`
      verdict(signal, 'take', null, bot.decider.kind === 'agent' ? `${what}; the agent screens it first` : what)
      if (preview) continue
      pendingTrades++
      pendingGameUsd.set(signal.gameId, (pendingGameUsd.get(signal.gameId) ?? 0) + decision.costUsd)
      if (decision.venue !== 'paper' && !decision.dryRun) pendingLiveUsd += decision.costUsd
      openKeys.add(signal.key) // one per market even within a cycle
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

    // Drawdown is the worse of realised losses and the equity drop since the
    // day's first reading on the venues this bot trades, the way the Python
    // guard anchors it.
    const equityDrop = (ids: VenueId[]): number =>
      ids.reduce((s, id) => {
        const now = venues[id]?.equityUsd
        const anchor = this.anchors[`${day}:${id}`]
        return now === null || now === undefined || anchor === undefined ? s : s + (now - anchor)
      }, 0)
    const liveIds = (Object.keys(this.venues) as VenueId[]).filter((v) => v !== 'paper')
    const botVenues = bot.mode === 'live' ? bot.market.venues.filter((v) => v !== 'paper') : []

    return {
      now: Date.now(),
      venues,
      openMarketKeys: openKeys,
      gameExposureUsd: openCost(mine.filter((t) => t.gameId === signal.gameId)),
      accountOpenExposureUsd: openCost(all.filter((t) => t.venue !== 'paper')),
      botDailyPnlUsd: Math.min(realised(todays(mine)), botVenues.length ? equityDrop(botVenues) : 0),
      accountDailyPnlUsd: Math.min(realised(todays(all.filter((t) => t.venue !== 'paper'))), equityDrop(liveIds)),
      // A paper order the book could not fill was never a trade.
      botTradesToday: todays(mine).filter((t) => t.status !== 'rejected' && !(t.status === 'cancelled' && t.filledContracts === 0)).length
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
      rules: rulesOf(bot)
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
    for (const t of ledger.tickets(7)) {
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
            const px = t.avgFillC / 100
            const gross = result === t.side ? t.filledContracts * (1 - px) : -t.filledContracts * px
            this.update(t, { status: 'settled', pnlUsd: Math.round((gross - t.feeUsd) * 100) / 100 })
          }
        }
      } catch (err) {
        this.log(t.botId, t.botName, t.title, 'reconcile_failed', (err as Error).message.slice(0, 160))
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
    const open = paper.filter((t) => t.pnlUsd === null && OPEN.includes(t.status)).reduce((s, t) => s + t.costUsd + t.feeUsd, 0)
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

  private anchorsFile = (): string => join(app.getPath('userData'), 'equity-anchors.json')

  private loadAnchors(): void {
    try { if (existsSync(this.anchorsFile())) this.anchors = JSON.parse(readFileSync(this.anchorsFile(), 'utf8')) } catch { this.anchors = {} }
    // Keep a week; older anchors are never read.
    const cutoff = today(Date.now() - 7 * 86_400_000)
    for (const k of Object.keys(this.anchors)) if (k.slice(0, 10) < cutoff) delete this.anchors[k]
  }

  private saveAnchors(): void {
    writeFileSync(this.anchorsFile(), JSON.stringify(this.anchors))
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
