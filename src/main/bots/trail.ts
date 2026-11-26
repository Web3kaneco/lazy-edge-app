// The app's own memory of the last few minutes (shared/trail.ts says why).
// Kalshi's ask is read once a cycle for every play a bot might buy, so the
// readings here are the same ones the gates priced, about 15 seconds apart.
// Nothing here changes a chance or a decision; it only records.
import type { Signal } from '@shared/signal'
import type { Trail } from '@shared/trail'

const KEEP_PRICES_MS = 5 * 60_000
// A play not seen for this long starts its edge age again.
const EDGE_BREAK_MS = 60_000
const FORGET_MS = 10 * 60_000

interface Reading { at: number; askC: number }
interface Edge { over: boolean | null; contract: string; side: string; since: number; last: number }
interface Count { value: number | null; since: number; changed: boolean; last: number }

export class PlayTrail {
  private prices = new Map<string, Reading[]>()
  private edges = new Map<string, Edge>()
  private counts = new Map<string, Count>()

  // Every prop in the feed, every cycle, so a count change is seen even on a
  // play no bot was close to buying.
  noteCounts(signals: Signal[], now: number): void {
    for (const s of signals) {
      if (!s.prop || s.phase !== 'live') continue
      const c = this.counts.get(s.key)
      const v = s.prop.soFar
      if (!c || now - c.last > FORGET_MS) { this.counts.set(s.key, { value: v, since: now, changed: false, last: now }); continue }
      if (v !== null && c.value !== null && v !== c.value) Object.assign(c, { value: v, since: now, changed: true })
      else if (c.value === null && v !== null) c.value = v
      c.last = now
    }
  }

  // One requoted play: its price goes on the trail and the trail comes back.
  // The side bought is the quote with the best edge, the one the gates use.
  read(s: Signal, now: number): Trail {
    const q = s.quotes
      .filter((x) => x.ask !== null && s.ourP !== null)
      .sort((a, b) => (s.ourP! - a.ask!) - (s.ourP! - b.ask!))
      .pop()
    let move60C: number | null = null
    let move120C: number | null = null
    let edgeAgeS: number | null = null
    if (q) {
      const askC = Math.round(q.ask! * 100)
      const pk = `${q.contract}|${q.side}`
      const list = (this.prices.get(pk) ?? []).filter((r) => now - r.at <= KEEP_PRICES_MS)
      move60C = moveSince(list, askC, now, 60)
      move120C = moveSince(list, askC, now, 120)
      list.push({ at: now, askC })
      this.prices.set(pk, list)
      // Edge age: how long our chance has stood above the ask on this side.
      const above = s.ourP! > q.ask!
      const e = this.edges.get(s.key)
      const over = s.prop?.over ?? null
      const same = e && e.contract === q.contract && e.side === q.side && e.over === over && now - e.last <= EDGE_BREAK_MS
      if (!above) this.edges.delete(s.key)
      else if (same) { e.last = now; edgeAgeS = Math.round((now - e.since) / 1000) }
      else { this.edges.set(s.key, { over, contract: q.contract, side: q.side, since: now, last: now }); edgeAgeS = 0 }
    }
    const c = s.prop && s.phase === 'live' ? this.counts.get(s.key) : undefined
    return {
      move60C, move120C, edgeAgeS,
      countSameS: c ? Math.round((now - c.since) / 1000) : null,
      countChanged: c ? c.changed : null,
      statsAgeS: s.prop?.statsAt != null ? Math.max(0, Math.round((now - s.prop.statsAt) / 1000)) : null,
      pricedAgeS: s.prop?.pricedAt != null ? Math.max(0, Math.round((now - s.prop.pricedAt) / 1000)) : null,
      liveModel: s.prop?.liveModel ?? null,
      minutes: s.prop?.minutes ?? null
    }
  }

  // Old readings go, so a long night does not grow without end.
  prune(now: number): void {
    for (const [k, list] of this.prices) { const keep = list.filter((r) => now - r.at <= KEEP_PRICES_MS); if (keep.length) this.prices.set(k, keep); else this.prices.delete(k) }
    for (const [k, e] of this.edges) if (now - e.last > FORGET_MS) this.edges.delete(k)
    for (const [k, c] of this.counts) if (now - c.last > FORGET_MS) this.counts.delete(k)
  }
}

// The ask now less the last reading at least windowS old. A reading more than
// twice the window old is too far back to call it that window's move.
export function moveSince(list: Reading[], askC: number, now: number, windowS: number): number | null {
  let then: Reading | null = null
  for (const r of list) if (now - r.at >= windowS * 1000 && (!then || r.at > then.at)) then = r
  if (!then || now - then.at > windowS * 2000) return null
  return askC - then.askC
}
