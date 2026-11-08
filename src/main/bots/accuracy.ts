// The accuracy loop. In the background, at a gentle pace, every ticket priced
// off Kalshi is checked against Kalshi's public record: each paper fill
// against the real trades around it, each settlement against the market's
// result. Results are kept in accuracy.json next to the ledger, so a ticket is
// checked once, and the ledger itself is never rewritten.
import { app } from 'electron'
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { checkSettlement, classifyFill, PRINT_WINDOW_S, type AccuracyEntry } from '@shared/accuracy'
import type { Ticket } from '../store/ledger'
import type { KalshiVenue } from '../venues/kalshi'

// Background runs at most this often, and space their reads well under the
// Kalshi basic tier, which the trading loop shares.
const EVERY_MS = 10 * 60_000
const SPACING_MS = 250
const LOOKBACK_DAYS = 30
// An open ticket is asked about only once its game is likely over, and then
// at most every half hour.
const OPEN_AFTER_MS = 3 * 3_600_000
const OPEN_RECHECK_MS = 30 * 60_000

type Entry = AccuracyEntry & { openCheckedAt?: number }

const file = (): string => join(app.getPath('userData'), 'accuracy.json')
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

let entries: Record<string, Entry> | null = null
let running: Promise<void> | null = null
let lastRunAt: number | null = null

function load(): Record<string, Entry> {
  if (entries) return entries
  try { entries = existsSync(file()) ? JSON.parse(readFileSync(file(), 'utf8')) : {} } catch { entries = {} }
  return entries!
}

function save(): void {
  const tmp = `${file()}.tmp`
  writeFileSync(tmp, JSON.stringify(entries))
  renameSync(tmp, file())
}

async function run(kalshi: KalshiVenue, tickets: Ticket[]): Promise<void> {
  const all = load()
  const now = Date.now()
  const since = now - LOOKBACK_DAYS * 86_400_000
  let changed = false
  for (const t of tickets) {
    if (t.createdAt < since || t.filledContracts < 1 || t.avgFillC === null) continue
    if ((t.venue === 'paper' ? t.priceSource : t.venue) !== 'kalshi') continue
    const e: Entry = all[t.id] ?? {}
    try {
      // A paper fill, once the window of trades around it has closed.
      if (t.venue === 'paper' && !e.fill && now - t.createdAt > (PRINT_WINDOW_S + 30) * 1000) {
        const at = Math.floor(t.createdAt / 1000)
        e.fill = classifyFill(t, await kalshi.prints(t.contract, at - PRINT_WINDOW_S, at + PRINT_WINDOW_S))
        changed = true
        await sleep(SPACING_MS)
      }
      const settledHere = t.pnlUsd !== null
      const due = settledHere
        ? !e.settle || e.settle.recordedPnlUsd !== t.pnlUsd
        : now - t.createdAt > OPEN_AFTER_MS && (!e.openCheckedAt || now - e.openCheckedAt > OPEN_RECHECK_MS)
      if (due) {
        const result = await kalshi.settlement(t.contract)
        if (result) e.settle = checkSettlement(t, result)
        else e.openCheckedAt = now
        changed = true
        await sleep(SPACING_MS)
      }
    } catch { /* a failed read is retried on the next run */ }
    all[t.id] = e
  }
  lastRunAt = Date.now()
  if (changed) save()
}

export const accuracy = {
  // Kicked after a cycle; never awaited by the trading loop.
  maybeRun(kalshi: KalshiVenue, tickets: () => Ticket[]): void {
    if (running || (lastRunAt && Date.now() - lastRunAt < EVERY_MS)) return
    void this.run(kalshi, tickets())
  },

  run(kalshi: KalshiVenue, tickets: Ticket[]): Promise<void> {
    running ??= run(kalshi, tickets).finally(() => { running = null })
    return running
  },

  state(): { entries: Record<string, AccuracyEntry>; running: boolean; lastRunAt: number | null } {
    return { entries: load(), running: running !== null, lastRunAt }
  }
}
