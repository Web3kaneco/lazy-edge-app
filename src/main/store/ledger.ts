// The local record: every decision, order and fill, append only, one JSON line
// per event, one file per UTC day. Nothing is rewritten, so the record of what
// a bot did can always be audited against what the venue says it did. The
// file split is storage only; daily limits use the trading day (shared/day.ts).
//
// The files are read once at start up. After that the latest state of every
// ticket lives in memory and each append updates it, so the trading loop
// never rereads the disk however long the history grows.
import { app } from 'electron'
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { TicketExit } from '@shared/exits'
import type { PlayRules } from '@shared/review'
import type { ContractSide, PlayTags } from '@shared/signal'
import type { VenueId } from '@shared/schema'

// exited: everything held was sold before settlement; its P&L is final.
export type OrderStatus = 'dry_run' | 'resting' | 'filled' | 'partial' | 'cancelled' | 'rejected' | 'settled' | 'exited'
// Statuses that may still hold a position, until the ticket carries a P&L.
export const OPEN: OrderStatus[] = ['resting', 'filled', 'partial', 'dry_run']
export const isOpen = (t: { status: OrderStatus; pnlUsd: number | null }): boolean => OPEN.includes(t.status) && t.pnlUsd === null

export interface Ticket {
  id: string
  botId: string
  botName: string
  signalKey: string
  gameId: string
  title: string
  venue: VenueId
  priceSource: VenueId
  contract: string
  side: ContractSide
  contracts: number
  limitPriceC: number
  costUsd: number
  evCents: number
  status: OrderStatus
  filledContracts: number
  avgFillC: number | null
  feeUsd: number
  pnlUsd: number | null
  venueOrderId: string | null
  createdAt: number
  updatedAt: number
  why: string | null
  audit: string[]
  error: string | null
  // What kind of play this was, for the Results screen. Missing on tickets
  // written before 2026-11-06; results.tagsOf() reads those from the key.
  play?: PlayTags
  // The bot's entry and size rules when it placed, so a play check judges it
  // by the rules it ran under. Missing on tickets before 0.3.0-beta.1.
  rules?: PlayRules
  // How the bot gets out, when it is set to exit before settlement. Missing
  // on a ticket held to settlement and on tickets before 0.6.0.
  exit?: TicketExit | null
  // A combo's legs, so each counts against its own game's limits and a bot
  // never bets against a leg it holds inside a combo.
  legs?: { contract: string; side: ContractSide; gameId: string }[]
  // A live combo's accepted quote: when, how the quote read, and the price
  // expected, so a fill that comes late is still recorded and checked.
  comboAccept?: { at: number; reading: 'yes_bid' | 'one_minus_no_bid'; expectedC: number }
}

export type LedgerEvent =
  | { type: 'ticket'; ticket: Ticket }
  | { type: 'skip'; at: number; botId: string; signalKey: string; gate: string; detail: string }
  | { type: 'note'; at: number; botId: string | null; text: string }

const DAY_MS = 86_400_000
const dir = (): string => join(app.getPath('userData'), 'ledger')
const fileFor = (at: number): string => join(dir(), `${new Date(at).toISOString().slice(0, 10)}.jsonl`)

function readFile(path: string): LedgerEvent[] {
  const out: LedgerEvent[] = []
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    if (!line) continue
    try { out.push(JSON.parse(line)) } catch { /* a torn final line from a crash is skipped */ }
  }
  return out
}

let latest = new Map<string, Ticket>()

export const ledger = {
  init(): void {
    mkdirSync(dir(), { recursive: true })
    latest = new Map()
    for (const f of readdirSync(dir()).filter((f) => f.endsWith('.jsonl')).sort()) {
      for (const e of readFile(join(dir(), f))) if (e.type === 'ticket') latest.set(e.ticket.id, e.ticket)
    }
  },

  append(event: LedgerEvent): void {
    const at = event.type === 'ticket' ? event.ticket.updatedAt : event.at
    appendFileSync(fileFor(at), `${JSON.stringify(event)}\n`)
    if (event.type === 'ticket') latest.set(event.ticket.id, event.ticket)
  },

  // Latest state of every ticket created in the last `days` days, newest
  // first. Served from memory.
  tickets(days = 7): Ticket[] {
    const since = Date.now() - days * DAY_MS
    return [...latest.values()].filter((t) => t.createdAt >= since).sort((a, b) => b.createdAt - a.createdAt)
  },

  // The last `days` days plus every ticket still open, however old. A pregame
  // position bought days before kickoff still holds its market and its money
  // until it settles; reading only recent days bought it again.
  active(days = 2): Ticket[] {
    const since = Date.now() - days * DAY_MS
    return [...latest.values()].filter((t) => t.createdAt >= since || isOpen(t)).sort((a, b) => b.createdAt - a.createdAt)
  },

  // Raw events stamped inside [from, to), read from only the day files that
  // can hold them.
  eventsBetween(from: number, to: number): LedgerEvent[] {
    if (!existsSync(dir())) return []
    const first = `${new Date(from).toISOString().slice(0, 10)}.jsonl`
    const last = `${new Date(to).toISOString().slice(0, 10)}.jsonl`
    return readdirSync(dir()).filter((f) => f.endsWith('.jsonl') && f >= first && f <= last).sort()
      .flatMap((f) => readFile(join(dir(), f)))
      .filter((e) => { const at = e.type === 'ticket' ? e.ticket.updatedAt : e.at; return at >= from && at < to })
  },

  // Raw events from the last `days` day files, for audits. Reads the disk, so
  // the caller caps `days`.
  events(days = 1): LedgerEvent[] {
    if (!existsSync(dir())) return []
    const files = readdirSync(dir()).filter((f) => f.endsWith('.jsonl')).sort().slice(-days)
    return files.flatMap((f) => readFile(join(dir(), f)))
  }
}
