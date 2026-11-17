// The paper test: every bot switched on in paper, the way a user would switch
// them on by hand, and the data it produces written out as files to study.
// Pure, so the tests and the main process read the same rules.
//
// A paper test never touches a live bot, and changes nothing but the switch,
// and the largest trade when one is given. Every change it makes is written to
// the ledger as a note, so the old setting can always be read back.
import { tradingDay } from './day'
import { analyze, tagsOf, type Segment, type SettledLike } from './results'
import type { TicketExit } from './exits'
import type { PlayRules } from './review'
import type { BotSettings } from './schema'
import { diffSettings, type Change } from './share'

export interface PaperTestPlan {
  // Bots to save, already switched on.
  save: BotSettings[]
  // Live bots, left exactly as they are.
  live: string[]
}

export function paperTestPlan(bots: BotSettings[], missingStarters: BotSettings[], maxTradeUsd: number | null): PaperTestPlan {
  const save: BotSettings[] = []
  const live: string[] = []
  for (const b of [...bots, ...missingStarters]) {
    if (b.mode === 'live') { live.push(b.name); continue }
    const next = structuredClone(b)
    next.enabled = true
    if (maxTradeUsd !== null && maxTradeUsd > 0) {
      next.size.maxTradeUsd = Math.min(next.size.maxTradeUsd, maxTradeUsd)
      next.size.minTradeUsd = Math.min(next.size.minTradeUsd, next.size.maxTradeUsd)
    }
    save.push(next)
  }
  return { save, live }
}

const fmt = (v: unknown): string => Array.isArray(v) ? v.join('/') : typeof v === 'string' ? v : JSON.stringify(v)

// One line for the ledger: what changed on a bot, old value to new.
export function changeNote(name: string, changes: Change[]): string {
  return `${name}: ${changes.map((c) => `${c.field} ${fmt(c.from)} -> ${fmt(c.to)}`).join('; ')}`
}

export function settingsChanges(before: BotSettings, after: BotSettings): Change[] {
  return diffSettings(before, after).filter((c) => c.field !== 'id')
}

// ── Export ───────────────────────────────────────────────────────────────

export interface TestTicket extends SettledLike {
  id: string
  title: string
  contract: string
  status: string
  contracts: number
  evCents: number
  priceSource: string
  error: string | null
  rules?: PlayRules
  exit?: TicketExit | null
}

export type TestEvent =
  | { type: 'ticket' }
  | { type: 'skip'; at: number; botId: string; signalKey: string; gate: string; detail: string }
  | { type: 'note'; at: number; botId: string | null; text: string }

// Text that a spreadsheet would read as a formula (=, +, -, @, tab or return
// first) gets a leading quote. Plain numbers, negatives included, stay numbers.
const cell = (v: unknown): string => {
  let s = v === null || v === undefined ? '' : String(v)
  if (/^[=+\-@\t\r]/.test(s) && !/^-?\d+(\.\d+)?$/.test(s)) s = `'${s}`
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
}
const table = (head: string[], rows: unknown[][]): string => [head, ...rows].map((r) => r.map(cell).join(',')).join('\r\n') + '\r\n'
const iso = (t: number): string => new Date(t).toISOString()
// A paper order the book never filled was not a trade.
const traded = (t: TestTicket): boolean => t.status !== 'rejected' && !(t.status === 'cancelled' && t.filledContracts === 0)

export function ticketsCsv(tickets: TestTicket[]): string {
  const head = ['created', 'trading_day', 'bot', 'bot_id', 'venue', 'priced_off', 'sport', 'lane', 'label', 'phase', 'hot', 'measured', 'edge_pp', 'our_p', 'quarter', 'lead', 'team_win_p',
    'title', 'contract', 'side', 'status', 'ordered', 'filled', 'fill_c', 'cost_usd', 'fee_usd', 'ev_c', 'pnl_usd',
    'rule_min_edge_pp', 'rule_min_ev_c', 'rule_haircut', 'rule_band_c', 'rule_max_trade_usd', 'exit_mode', 'exit_at_c', 'exit_sold', 'exit_avg_c', 'exit_status', 'error', 'id']
  const rows = [...tickets].sort((a, b) => a.createdAt - b.createdAt).map((t) => {
    const p = tagsOf(t)
    return [iso(t.createdAt), tradingDay(t.createdAt), t.botName, t.botId, t.venue, t.priceSource, p.sport, p.lane, p.label, p.phase, p.hot, p.measured,
      p.edgePp?.toFixed(2), p.ourP?.toFixed(4), p.quarter, p.lead, p.teamWinP?.toFixed(4), t.title, t.contract, t.side, t.status, t.contracts, t.filledContracts, t.avgFillC,
      t.costUsd.toFixed(2), t.feeUsd.toFixed(2), t.evCents.toFixed(2), t.pnlUsd?.toFixed(2),
      t.rules?.minEdgePp, t.rules?.minEvCents, t.rules?.edgeHaircut, t.rules ? t.rules.priceBandC.join('-') : null, t.rules?.maxTradeUsd,
      t.exit?.mode ?? 'hold', t.exit?.targetC, t.exit?.filledContracts, t.exit?.avgC, t.exit?.status, t.error, t.id]
  })
  return table(head, rows)
}

export function skipsCsv(events: TestEvent[], names: Map<string, string>): string {
  const rows = events.flatMap((e) => e.type === 'skip' ? [[iso(e.at), tradingDay(e.at), names.get(e.botId) ?? e.botId, e.botId, e.gate, e.signalKey, e.detail]] : [])
  return table(['at', 'trading_day', 'bot', 'bot_id', 'gate', 'signal', 'detail'], rows)
}

export function notesCsv(events: TestEvent[], names: Map<string, string>): string {
  const rows = events.flatMap((e) => e.type === 'note' ? [[iso(e.at), tradingDay(e.at), e.botId ? names.get(e.botId) ?? e.botId : '', e.text]] : [])
  return table(['at', 'trading_day', 'bot', 'note'], rows)
}

const money = (n: number): string => `${n < 0 ? '-' : ''}$${Math.abs(n).toFixed(2)}`
const pct = (n: number): string => `${Math.round(n * 100)}%`
const seg = (s: Segment): string =>
  `${s.n} settled in ${s.games} games, ${s.won} won (${pct(s.winRate)}) at an average ${Math.round(s.avgPrice * 100)}c, ${money(s.pnlUsd)} after fees, ROI ${pct(s.roi)}${s.verdict === 'too_early' ? ', too early to judge' : `, ${s.verdict}`}`

// The plain text read out: how each bot did, which kinds of play won and lost,
// how often a paper order filled, and why each bot passed on the rest.
export function summaryText(tickets: TestTicket[], events: TestEvent[], bots: BotSettings[], from: number, to: number): string {
  const out: string[] = []
  const placed = tickets.filter(traded)
  const { overall, dimensions, recommendations } = analyze(placed)
  out.push('Lazy Edge paper test data', `From ${iso(from)} to ${iso(to)}`, '')
  out.push(`${placed.length} trades placed, ${tickets.length - placed.length} paper orders the book did not fill.`)
  out.push(`Settled: ${seg(overall)}.`)
  const open = placed.filter((t) => t.pnlUsd === null).length
  if (open) out.push(`${open} trades still open.`)

  out.push('', 'By bot')
  const names = new Map(bots.map((b) => [b.id, b.name]))
  const botIds = [...new Set([...bots.map((b) => b.id), ...tickets.map((t) => t.botId)])]
  for (const id of botIds) {
    const mine = tickets.filter((t) => t.botId === id)
    const name = names.get(id) ?? mine[0]?.botName ?? id
    const done = mine.filter(traded)
    const row = dimensions.find((d) => d.id === 'bot')?.rows.find((r) => r.key === name)
    const skips = new Map<string, number>()
    for (const e of events) if (e.type === 'skip' && e.botId === id) skips.set(e.gate, (skips.get(e.gate) ?? 0) + 1)
    const top = [...skips].sort((a, b) => b[1] - a[1]).slice(0, 6).map(([g, n]) => `${g} ${n}`).join(', ')
    out.push(`  ${name}: ${done.length} placed, ${mine.length - done.length} not filled. ${row ? seg(row) : 'Nothing settled yet'}.`)
    if (top) out.push(`    Passed on: ${top}.`)
  }

  for (const d of dimensions) {
    if (d.id === 'bot' || !d.rows.length) continue
    out.push('', `By ${d.title.toLowerCase()}`)
    for (const r of d.rows) out.push(`  ${r.key}: ${seg(r)}`)
  }

  out.push('', 'What the record says so far')
  if (!recommendations.length) out.push('  Nothing has a large enough record to call yet.')
  for (const r of recommendations) out.push(`  ${r.strength === 'strong' ? 'Strong' : 'Leaning'}: ${r.text}`)

  const notes = events.filter((e) => e.type === 'note')
  out.push('', `Settings changes in this window: ${notes.length}. Every one is in notes.csv.`)
  out.push('', 'Files: tickets.csv (one row per order), skips.csv (each play a bot passed on and why, once per bot, play and gate a day), notes.csv (every settings change and paper test), bots.json (each bot as it is now).')
  out.push('This holds trades and bot settings only, never keys, passwords or balances.')
  return out.join('\r\n') + '\r\n'
}

export function exportFiles(tickets: TestTicket[], events: TestEvent[], bots: BotSettings[], from: number, to: number): Record<string, string> {
  const names = new Map<string, string>([...tickets.map((t) => [t.botId, t.botName] as [string, string]), ...bots.map((b) => [b.id, b.name] as [string, string])])
  return {
    'summary.txt': summaryText(tickets, events, bots, from, to),
    'tickets.csv': ticketsCsv(tickets),
    'skips.csv': skipsCsv(events, names),
    'notes.csv': notesCsv(events, names),
    'bots.json': JSON.stringify(bots, null, 2)
  }
}
