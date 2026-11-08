// The local record: every decision, order and fill, append only, one JSON line
// per event, one file per UTC day. Nothing is rewritten, so the record of what
// a bot did can always be audited against what the venue says it did.
//
// The files are read once at start up. After that the latest state of every
// ticket lives in memory and each append updates it, so the trading loop
// never rereads the disk however long the history grows.
import { app } from 'electron'
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { ContractSide, PlayTags } from '@shared/signal'
import type { VenueId } from '@shared/schema'

export type OrderStatus = 'dry_run' | 'resting' | 'filled' | 'partial' | 'cancelled' | 'rejected' | 'settled'

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

  // Raw events from the last `days` day files, for audits. Reads the disk, so
  // the caller caps `days`.
  events(days = 1): LedgerEvent[] {
    if (!existsSync(dir())) return []
    const files = readdirSync(dir()).filter((f) => f.endsWith('.jsonl')).sort().slice(-days)
    return files.flatMap((f) => readFile(join(dir(), f)))
  }
}
