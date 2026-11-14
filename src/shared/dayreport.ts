// One trading day, written up for the team: what each bot traded, what it
// made or lost after fees, why it passed on the rest, and its settings as a
// share code, so a losing day can be replayed and the bot adjusted. It goes
// out only inside a report the user reads first and sends from their own
// email. It holds trades and settings, never keys, balances or sign ins.
import { tradingDay } from './day'
import { tagsOf, type SettledLike } from './results'

export interface DayTicket extends SettledLike {
  title: string
  contract: string
  status: string
  evCents: number
  createdAt: number
}

export interface DayOption { day: string; trades: number; settled: number; pnlUsd: number; live: boolean }

// A paper order the book never filled was not a trade.
const traded = (t: DayTicket): boolean => t.status !== 'rejected' && !(t.status === 'cancelled' && t.filledContracts === 0)

// The last trading days that had trades, newest first, with their settled result.
export function dayOptions(tickets: DayTicket[], limit = 30): DayOption[] {
  const by = new Map<string, DayOption>()
  for (const t of tickets) {
    if (!traded(t)) continue
    const day = tradingDay(t.createdAt)
    const o = by.get(day) ?? { day, trades: 0, settled: 0, pnlUsd: 0, live: false }
    o.trades++
    if (t.pnlUsd !== null) { o.settled++; o.pnlUsd += t.pnlUsd }
    if (t.venue !== 'paper') o.live = true
    by.set(day, o)
  }
  return [...by.values()].sort((a, b) => b.day.localeCompare(a.day)).slice(0, limit)
}

export interface DayBot { botId: string; botName: string; code: string | null; changes: string }

export interface DayReport {
  day: string
  tickets: DayTicket[]
  bots: DayBot[]
  // botId -> gate -> plays it passed on that day.
  skips: Record<string, Record<string, number>>
}

const money = (n: number): string => `${n < 0 ? '-' : ''}$${Math.abs(n).toFixed(2)}`
const time = (t: number): string => new Date(t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
const csv = (v: unknown): string => {
  const s = v === null || v === undefined ? '' : String(v)
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
}

// The day as report lines. The summary comes first and every trade last, as
// one CSV row each, so a long day that is cut to fit still keeps its totals.
export function dayLines(r: DayReport): string[] {
  const out: string[] = []
  const ts = r.tickets.filter(traded).sort((a, b) => a.createdAt - b.createdAt)
  const settled = ts.filter((t) => t.pnlUsd !== null)
  const pnl = settled.reduce((s, t) => s + (t.pnlUsd ?? 0), 0)
  const fees = ts.reduce((s, t) => s + t.feeUsd, 0)
  const wins = settled.filter((t) => (t.pnlUsd ?? 0) > 0).length
  out.push(`Trading day ${r.day} (4 AM to 4 AM local time)`)
  out.push(`${ts.length} trades, ${settled.length} settled (${wins} won, ${settled.length - wins} lost), ${ts.length - settled.length} still open`)
  out.push(`Settled P&L after fees ${money(pnl)}, fees ${money(fees)}`)

  for (const b of r.bots) {
    const mine = ts.filter((t) => t.botId === b.botId)
    const minePnl = mine.reduce((s, t) => s + (t.pnlUsd ?? 0), 0)
    out.push('', `Bot: ${b.botName}`)
    out.push(`  ${mine.length} trades, settled P&L ${money(minePnl)}, ${mine.filter((t) => t.venue !== 'paper').length ? 'live money' : 'paper'}`)
    const lanes = new Map<string, { n: number; open: number; pnl: number }>()
    for (const t of mine) {
      const g = tagsOf(t)
      const k = `${g.sport ?? '?'} ${g.lane ?? '?'} ${g.phase ?? '?'} ${g.label ?? '?'}`
      const v = lanes.get(k) ?? { n: 0, open: 0, pnl: 0 }
      v.n++
      if (t.pnlUsd === null) v.open++
      else v.pnl += t.pnlUsd
      lanes.set(k, v)
    }
    for (const [k, v] of [...lanes].sort((a, b) => a[1].pnl - b[1].pnl)) {
      out.push(`  ${k}: ${v.n} trades, ${v.n === v.open ? 'none settled' : `${money(v.pnl)} settled`}${v.open && v.open < v.n ? `, ${v.open} open` : ''}`)
    }
    const skips = Object.entries(r.skips[b.botId] ?? {}).sort((a, b) => b[1] - a[1])
    if (skips.length) out.push(`  Passed on: ${skips.map(([g, n]) => `${g} ${n}`).join(', ')}`)
    out.push(`  ${b.changes}`)
    if (b.code) out.push(`  Share code: ${b.code}`)
  }

  out.push('', 'Trades (CSV)')
  out.push('time,bot,sport,lane,phase,label,edge_pp,title,contract,side,filled,fill_c,cost,fee,ev_c,status,pnl')
  for (const t of ts) {
    const g = tagsOf(t)
    out.push([
      time(t.createdAt), t.botName, g.sport, g.lane, g.phase, g.label, g.edgePp?.toFixed(1), t.title, t.contract, t.side,
      t.filledContracts, t.avgFillC ?? t.limitPriceC, t.costUsd.toFixed(2), t.feeUsd.toFixed(2), t.evCents.toFixed(1), t.status,
      t.pnlUsd === null ? 'open' : t.pnlUsd.toFixed(2)
    ].map(csv).join(','))
  }
  return out
}
