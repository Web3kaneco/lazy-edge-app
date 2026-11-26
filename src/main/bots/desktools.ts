// The desk's data tools (2026-11-21: "a data source that can come back
// and forth and answer these questions"). Read only. The model asks; the app
// calls the Lazy Edge API with the user's own key, or reads the user's own
// ledger, here on this computer, and hands back a trimmed result. Nothing a
// tool returns is an instruction; the system prompt says so.
import { z } from 'zod'
import { tradingDay } from '@shared/day'
import { auditBots } from '@shared/audit'
import { apiTicketPicks } from '@shared/combos'
import { botSentence } from '@shared/sentence'
import { fieldName, fieldValue } from '@shared/fields'
import { limitsSummary } from '@shared/limits'
import type { AccountSettings, BotSettings } from '@shared/schema'
import type { Change } from '@shared/share'
import { starterOf } from '@shared/starters'
import { liveProblem } from '@shared/venues'
import type { BotVerdict } from '@shared/signal'
import type { AiTool } from '../ai/types'
import { lazyedge } from '../data/lazyedge'
import { ledger } from '../store/ledger'

const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null)
const r3 = (v: unknown): number | null => { const n = num(v); return n === null ? null : Math.round(n * 1000) / 1000 }
const list = (body: any): any[] => (Array.isArray(body) ? body : Array.isArray(body?.games) ? body.games : Array.isArray(body?.rows) ? body.rows : [])

const STATS = [['points', '', 'pts', 'current_points'], ['rebounds', 'reb_', 'reb', 'current_rebounds'], ['assists', 'ast_', 'ast', 'current_assists']] as const

// One player's props in a few fields: the line, our chance of the over, the
// live price and edge, what he has, and his place in the game.
function propRows(game: any, player?: string | null): Record<string, unknown>[] {
  const players: any[] = Array.isArray(game?.players) ? game.players : []
  const ranked = players.filter((p) => num(p?.projection) !== null).sort((a, b) => num(b.projection)! - num(a.projection)!)
  const live = game?.is_pregame === false
  const want = player?.trim().toLowerCase()
  return players
    .filter((p) => !want || String(p?.player_name ?? '').toLowerCase().includes(want))
    .map((p) => ({
      player: p.player_name, team: p.team, availability: p.availability ?? null,
      place_in_game: ranked.indexOf(p) >= 0 ? ranked.indexOf(p) + 1 : null,
      on_bench: p.left_floor ? { chance_back_tonight: r3(p.p_back) } : null,
      stats: Object.fromEntries(STATS.flatMap(([label, pre, key, now]) => {
        const line = num(p[`${pre}market_line`])
        if (line === null) return []
        return [[label, {
          line,
          our_chance_over: r3(live ? p[`${pre}likelihood_over`] : p[`${key}_sim_p_over`]),
          projection: r3(p[`${pre}projection`] ?? (pre === '' ? p.projection : null)),
          live_price_over: r3(p[`${key}_live_price`]), live_edge_pp: r3(p[`${key}_live_edge_pp`]), book: p[`${key}_live_source`] ?? null,
          so_far: live ? num(p[now]) : null, projected_final: live ? r3(p[`${pre}projected_final`]) : null
        }]]
      }))
    }))
}

export interface EngineView {
  running: boolean
  lastCycleAt: number | null
  lastError: string | null
  recent: { at: number; botId: string; botName: string; title: string; outcome: string; detail: string }[]
  venues: Record<string, { balanceUsd: number | null; equityUsd: number | null; configured: boolean }>
}

export interface DeskToolDeps {
  bots: () => BotSettings[]
  verdicts: () => Record<string, BotVerdict[]>
  account?: () => AccountSettings
  engine?: () => EngineView
  version?: string
  // Drafts a settings change on one bot for the user to apply, and returns
  // what it would change.
  propose?: (bot: BotSettings, request: string) => Promise<unknown>
}

const findBot = (bots: BotSettings[], name: string): BotSettings | undefined => {
  const want = name.trim().toLowerCase()
  return bots.find((b) => b.name.toLowerCase() === want) ?? bots.find((b) => b.name.toLowerCase().includes(want) || b.id === name)
}

// A bot's settings in plain words, the way the bot screen says them.
function botPlain(b: BotSettings, account: AccountSettings | undefined, venues: EngineView['venues'] | undefined): Record<string, unknown> {
  const { id: _i, name: _n, ...rest } = b
  const flat: Change[] = []
  const walk = (v: unknown, path: string): void => {
    if (v && typeof v === 'object' && !Array.isArray(v)) { for (const [k, x] of Object.entries(v)) walk(x, path ? `${path}.${k}` : k); return }
    flat.push({ field: path, from: null, to: v })
  }
  walk(rest, '')
  return {
    name: b.name, on: b.enabled, mode: b.mode, in_one_line: botSentence(b),
    settings: Object.fromEntries(flat.map((c) => [fieldName(c.field), fieldValue(c.field, c.to)])),
    live_problem: account && venues ? liveProblem(b, account, venues) : null,
    money_limits: account ? limitsSummary(b, account).lines : null,
    starter: starterOf(b.id)?.summary ?? null
  }
}

export function deskTools(deps: DeskToolDeps): AiTool[] {
  const engine = (): EngineView | undefined => deps.engine?.()
  return [
    {
      name: 'app_status',
      description: "The app right now: version, whether the engine is running and when it last cycled, the last error, the kill switch and account limits, each venue's key and balance, and which bots are on and live.",
      input: z.object({}),
      run: async () => {
        const e = engine()
        const a = deps.account?.()
        const bots = deps.bots()
        return {
          version: deps.version ?? null, engine_running: e?.running ?? null, last_cycle: e?.lastCycleAt ? new Date(e.lastCycleAt).toISOString() : null, last_error: e?.lastError ?? null,
          kill_switch: a?.killSwitch ?? null, account_daily_loss_stop_usd: a?.accountDailyDrawdownUsd ?? null, account_open_money_cap_usd: a?.accountMaxOpenExposureUsd ?? null,
          venues: e ? Object.fromEntries(Object.entries(e.venues).map(([k, v]) => [k, { key_saved: v.configured, balance_usd: v.balanceUsd }])) : null,
          bots_on: bots.filter((b) => b.enabled).map((b) => ({ name: b.name, mode: b.mode })), bots_total: bots.length
        }
      }
    },
    {
      name: 'bot_settings',
      description: "One bot's settings in plain words, its rules in one line, whether a live bot cannot trade and why, its money limits, and its starter description. Find the bot by name or part of it.",
      input: z.object({ bot: z.string().describe('The bot name, or part of it') }),
      run: async ({ bot }: { bot: string }) => {
        const b = findBot(deps.bots(), bot)
        if (!b) return { error: `No bot named like "${bot}". Bots: ${deps.bots().map((x) => x.name).join(', ')}` }
        return botPlain(b, deps.account?.(), engine()?.venues)
      }
    },
    {
      name: 'audit_bots',
      description: 'Checks every bot that is on for problems: a live bot that cannot trade, settings that cancel each other (our pick sized by Kelly, combos not set to the API\'s), bots that can bet against each other or buy the same pick twice, props on role players, pregame plays that go in early, and money limits that fight. Use it first when asked whether everything is set up right.',
      input: z.object({}),
      run: async () => {
        const a = deps.account?.()
        if (!a) return { error: 'account not available' }
        return auditBots({ bots: deps.bots(), account: a, venues: engine()?.venues ?? {}, engineRunning: engine()?.running ?? false, tickets: ledger.tickets(30) })
      }
    },
    {
      name: 'activity_today',
      description: "What happened today: every trade placed or skipped with the reason, as the Dashboard's activity shows it, and every settings change written to the ledger. Filter by bot name.",
      input: z.object({ bot: z.string().nullable().describe('Part of a bot name, or null for every bot') }),
      run: async ({ bot }: { bot: string | null }) => {
        const want = bot?.toLowerCase()
        const day = tradingDay(Date.now())
        const recent = (engine()?.recent ?? []).filter((r) => tradingDay(r.at) === day && (!want || r.botName.toLowerCase().includes(want))).slice(0, 80)
        const notes = (ledger.events(2).filter((e) => e.type === 'note' && tradingDay(e.at) === day) as { at: number; text: string }[])
          .filter((n) => !want || n.text.toLowerCase().includes(want)).slice(-40)
        return {
          activity: recent.map((r) => ({ at: new Date(r.at).toISOString().slice(11, 16), bot: r.botName, play: r.title.slice(0, 70), outcome: r.outcome, detail: r.detail.slice(0, 160) })),
          settings_changes: notes.map((n) => ({ at: new Date(n.at).toISOString().slice(11, 16), change: n.text.slice(0, 220) }))
        }
      }
    },
    {
      name: 'board_now',
      description: 'What one bot would do with every play on the board this cycle: the plays it takes, holds, or skips and the check that stopped each. Find the bot by name.',
      input: z.object({ bot: z.string() }),
      run: async ({ bot }: { bot: string }) => {
        const b = findBot(deps.bots(), bot)
        if (!b) return { error: `No bot named like "${bot}".` }
        const rows = Object.entries(deps.verdicts()).flatMap(([key, vs]) => vs.filter((v) => v.botId === b.id).map((v) => ({ play: key, outcome: v.outcome, check: v.gate, detail: v.detail.slice(0, 120) })))
        const counts: Record<string, number> = {}
        for (const r of rows) counts[r.outcome === 'skip' ? `skip: ${r.check}` : r.outcome] = (counts[r.outcome === 'skip' ? `skip: ${r.check}` : r.outcome] ?? 0) + 1
        return { bot: b.name, plays_seen: rows.length, counts, taking_or_holding: rows.filter((r) => r.outcome !== 'skip').slice(0, 30), skipped_examples: rows.filter((r) => r.outcome === 'skip').slice(0, 30) }
      }
    },
    ...(deps.propose ? [{
      name: 'propose_change',
      description: "Drafts a settings change on one bot from a plain request, such as \"set sizing to flat\" or \"only the top 10 players\", for the trader to apply with one click. Money settings (trade size, sizing, the loss stop, the most contracts, paper or live) are never changed by a draft; tell the trader to change those on the bot. Nothing is saved; the trader sees the change and applies it.",
      input: z.object({ bot: z.string().describe('The bot name, or part of it'), request: z.string().describe('The change in plain words') }),
      run: async ({ bot, request }: { bot: string; request: string }) => {
        const b = findBot(deps.bots(), bot)
        if (!b) return { error: `No bot named like "${bot}".` }
        return deps.propose!(b, request)
      }
    } as AiTool] : []),
    {
      name: 'nba_games_today',
      description: "Today's NBA games from Lazy Edge with the live state of each: score, period, clock, our home win chance against Kalshi's price, and when a team is down 5 or more from the 3rd quarter, how often teams in that spot came back. Use it to find a game id.",
      input: z.object({}),
      run: async () => {
        const [games, live] = await Promise.all([lazyedge.nbaGamesToday(), lazyedge.nbaLive().catch(() => [])])
        const byId = new Map(list(live).map((r: any) => [String(r.game_id), r]))
        return list(games).map((g: any) => {
          const r: any = byId.get(String(g.game_id)) ?? {}
          return {
            game_id: g.game_id, away: g.away_team ?? r.away_team, home: g.home_team ?? r.home_team, tip_time: g.tip_time ?? r.tip_time ?? null,
            score: r.home_score != null ? `${r.away_score}-${r.home_score}` : null, period: r.period ?? null, clock: r.clock ?? null,
            our_home_chance: r3(r.our_prob), kalshi_home_price: r3(r.kalshi_implied), model_ready: r.model_ready ?? null,
            comeback: r.comeback_win_prob != null ? { trailing: r.comeback_trailing_team, down: r.comeback_deficit, came_back_to_win: r3(r.comeback_win_prob), spot: r.comeback_bucket } : null
          }
        })
      }
    },
    {
      name: 'nba_props',
      description: "Lazy Edge's NBA player props: for each player, his place in his game by our points projection, and for points, rebounds and assists the line, our chance of the over (in play, the live likelihood), the live Kalshi price of the over and the edge, what he has so far and his projected final. The bots take whichever side, over or under, our chance favors. Filter by game id and or player name.",
      input: z.object({ game_id: z.string().nullable().describe('A game id from nba_games_today, or null for every game'), player: z.string().nullable().describe('Part of a player name, or null') }),
      run: async ({ game_id, player }: { game_id: string | null; player: string | null }) => {
        const body = await lazyedge.nbaPropsFor(game_id ?? undefined)
        return list(body).map((g: any) => ({ game_id: g.game_id, game: `${g.away_team ?? ''} @ ${g.home_team ?? ''}`, in_play: g.is_pregame === false, period: g.period ?? null, clock: g.clock ?? null, players: propRows(g, player) }))
          .filter((g) => g.players.length)
      }
    },
    {
      name: 'nba_combos',
      description: "Tonight's NBA combo tickets from the Lazy Edge API (/v1/nba/tickets), as the API built them: each ticket's legs with the team, the Kalshi ticker, our chance and the Kalshi price of each leg, our chance that every leg hits (p_all), what the legs cost bought one by one (market_p_all), whether the ticket has locked, and whether a bot that buys the API's combos would ask Kalshi to quote it now, with the reason when not. Use it to show a combo, price it, or check its math.",
      input: z.object({}),
      run: async () => {
        const body: any = await lazyedge.nbaTickets()
        const now = Date.now()
        const tickets: any[] = Array.isArray(body) ? body : Array.isArray(body?.tickets) ? body.tickets : []
        const buyable = new Set(apiTicketPicks(body, now).map((p) => p.legs.map((l) => l.contract).join('+')))
        return {
          rule: "A bot that buys the API's combos (Which combos set to The API's combos, Combos only on) takes a ticket only once it is locked, has two or more legs each with a Kalshi ticker, a chance and a price, from different games, before any leg's tip. It asks Kalshi's market makers for a quote and buys when the quote plus Kalshi's fee is at or under our chance that every leg hits. It buys only the sizes ticked on the bot under Buy the API's combos with (2, 3 or 4 legs; bot_settings shows them). Its labels, minimum edge, price band, chance floors and quarters are not used. It buys at most its Combos a day, each combo once a day, within its largest trade and the account's open limit.",
          tickets: tickets.map((t: any) => {
            const picks: any[] = Array.isArray(t?.picks) ? t.picks : []
            const key = picks.map((p) => String(p?.ticker ?? '')).join('+')
            const locked = Boolean(t?.locked ?? body?.locked)
            const started = picks.some((p) => p?.tip && Date.parse(String(p.tip)) <= now)
            return {
              label: t?.label ?? t?.name ?? null, size: `${picks.length} legs`, locked, locks_at: t?.locks_at ?? body?.locks_at ?? null,
              legs: picks.map((p) => ({ team: p?.team ?? null, opponent: p?.opp ?? null, ticker: p?.ticker ?? null, our_chance: r3(p?.our_prob), kalshi_price: r3(p?.price), tip: p?.tip ?? null })),
              our_chance_all_hit: r3(t?.p_all), legs_cost_one_by_one: r3(t?.market_p_all), gap_pp: t?.gap_pp ?? null, payout_per_100: t?.payout_per_100 ?? null,
              bot_would_ask_for_a_quote: buyable.has(key),
              why_not: buyable.has(key) ? null : !locked ? 'not locked yet' : started ? 'a leg has tipped off' : picks.length < 2 ? 'fewer than two legs' : 'a leg lacks a ticker, a chance or a price, or two legs share a game'
            }
          })
        }
      }
    },
    {
      name: 'nba_hit_rates',
      description: "A player's recent record on a stat from Lazy Edge: his game log, averages, and with a line how many of his last 5, last 10 and season games went over it. Use it to test our chance against what the player has done.",
      input: z.object({
        player: z.string().describe('The player name'),
        stat: z.string().describe('The stat as the API names it: try points, rebounds or assists, and if the API refuses it, pts, reb or ast'),
        line: z.number().nullable().describe('The line, such as 24.5, or null'),
        games: z.number().int().nullable().describe('How many recent games, or null for the default')
      }),
      run: async ({ player, stat, line, games }: { player: string; stat: string; line: number | null; games: number | null }) =>
        lazyedge.nbaHitRates(player, stat, line ?? undefined, games ?? undefined)
    },
    {
      name: 'nba_results',
      description: "Lazy Edge's graded NBA record for a date: our pregame numbers against the finals, and the live win chance against Kalshi's price by quarter. Use it to judge how honest our numbers have been. Large; ask for one date or one game.",
      input: z.object({ date: z.string().nullable().describe('YYYY-MM-DD, the US Eastern slate date, or null for the newest graded night'), game_id: z.string().nullable() }),
      run: async ({ date, game_id }: { date: string | null; game_id: string | null }) => lazyedge.nbaResults(date ?? undefined, game_id ?? undefined)
    },
    {
      name: 'my_trades',
      description: "The trader's own trades from this app's ledger, newest first: bot, play, quarter, minutes left, score, our honest chance and the raw one, price paid, the prop line and what the player had, and how it settled. Filter by bot name, lane and days; settled only to judge results.",
      input: z.object({
        bot: z.string().nullable().describe('Part of a bot name, or null for every bot'),
        lane: z.enum(['MONEYLINE', 'SPREAD', 'TOTAL', 'PROP', 'COMBO']).nullable(),
        days: z.number().int().min(1).max(90).describe('How many days back'),
        settled_only: z.boolean()
      }),
      run: async ({ bot, lane, days, settled_only }: { bot: string | null; lane: string | null; days: number; settled_only: boolean }) => {
        const want = bot?.toLowerCase()
        const rows = ledger.tickets(days)
          .filter((t) => t.filledContracts > 0 && (!want || t.botName.toLowerCase().includes(want)) && (!lane || t.play?.lane === lane) && (!settled_only || t.pnlUsd !== null))
          .sort((a, b) => b.createdAt - a.createdAt)
        const settled = rows.filter((t) => t.pnlUsd !== null)
        return {
          count: rows.length, settled: settled.length, won: settled.filter((t) => (t.pnlUsd ?? 0) > 0).length,
          pnl_usd: Math.round(settled.reduce((s, t) => s + (t.pnlUsd ?? 0), 0) * 100) / 100,
          trades: rows.slice(0, 150).map((t) => {
            const g = t.play
            return {
              bot: t.botName, play: t.title.slice(0, 80), at: new Date(t.createdAt).toISOString().slice(0, 16), lane: g?.lane, quarter: g?.quarter,
              minutes_left: g?.secondsLeft == null ? null : Math.round(g.secondsLeft / 6) / 10, backed_team_ahead_by: g?.lead ?? null,
              honest_chance: g?.ourP ?? null, raw_chance: g?.rawP ?? null, paid_c: t.avgFillC ?? t.limitPriceC, contracts: t.filledContracts,
              ...(g?.propLine != null ? { prop_line: g.propLine, player_had: g.propSoFar ?? null, side: g.propOver ? 'over' : 'under', place_in_game: g.propRank ?? null } : {}),
              result: t.pnlUsd === null ? 'open' : t.pnlUsd > 0 ? 'won' : 'lost', pnl_usd: t.pnlUsd
            }
          })
        }
      }
    },
    {
      name: 'my_skips',
      description: "Why the trader's bots passed on plays today: for each bot, the checks that stopped plays with counts and examples, including the settings checks the engine ran this cycle.",
      input: z.object({ bot: z.string().nullable().describe('Part of a bot name, or null for every bot') }),
      run: async ({ bot }: { bot: string | null }) => {
        const want = bot?.toLowerCase()
        const bots = deps.bots().filter((b) => !want || b.name.toLowerCase().includes(want))
        const day = tradingDay(Date.now())
        const skips = ledger.events(2).filter((e) => e.type === 'skip' && tradingDay(e.at) === day) as { botId: string; gate: string; detail: string }[]
        const cycle = Object.values(deps.verdicts()).flat()
        return bots.map((b) => {
          const gates = new Map<string, { plays: number; examples: string[] }>()
          const add = (gate: string, detail: string): void => {
            const e = gates.get(gate) ?? { plays: 0, examples: [] }
            e.plays++
            if (detail && e.examples.length < 3 && !e.examples.includes(detail)) e.examples.push(detail)
            gates.set(gate, e)
          }
          for (const s of skips) if (s.botId === b.id) add(s.gate, s.detail)
          for (const v of cycle) if (v.botId === b.id && v.outcome === 'skip' && v.gate && !gates.has(v.gate)) add(v.gate, v.detail)
          return { bot: b.name, on: b.enabled, mode: b.mode, taking_now: cycle.filter((v) => v.botId === b.id && v.outcome === 'take').length, stopped_by: [...gates].map(([gate, e]) => ({ gate, ...e })).sort((x, y) => y.plays - x.plays).slice(0, 8) }
        })
      }
    }
  ]
}
