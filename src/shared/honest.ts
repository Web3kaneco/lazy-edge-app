// The honest chance (2026-11-21): an edge is only money if our chance is
// true at the price. Chasing every edge keeps buying the side that is losing,
// because a model a little hopeful about comebacks makes the trailing team
// look underpriced, and it loses more often than the edge says.
//
// So every play's chance is checked before any gate reads it, and only ever
// lowered:
//  1. The comeback record (NBA, from the 3rd quarter, down 5 or more): how
//     often teams in that exact spot, the same deficit and time left, went on
//     to win, from 5,294 games. When our chance for the team backed sits above
//     what teams in its spot did, it is pulled halfway down to the record: the
//     record is every team in that spot, not this matchup, so our number keeps
//     half its say.
//  2. The user's own record: by lane, favorite or underdog, and chance band,
//     how often those plays really won against the chance we gave them,
//     shrunk toward our chance until enough have settled. Only a record that
//     came in under our chance lowers it.
// The raw chance rides along for the record and the screens.
import type { SettledLike } from './results'
import type { Signal } from './signal'

export interface ComebackRecord {
  // How often teams in this spot came back to win, 0 to 1.
  winP: number
  // Whether the trailing team is the home side.
  trailingHome: boolean
  deficit: number | null
  bucket: string | null
}

export interface Honest {
  // Our chance as the feed gave it.
  raw: number
  // What the gates use.
  p: number
  // What lowered it, in plain words; empty when nothing did.
  notes: string[]
}

// Our number keeps this share of its gap above the comeback record.
export const COMEBACK_WEIGHT = 0.5
// Settled plays a band needs before its record moves a chance, and the weight
// our own chance keeps as if it were this many plays.
export const MEASURED_MIN = 10
export const MEASURED_PRIOR = 30

const BANDS = [[0, 30], [30, 40], [40, 50], [50, 60], [60, 70], [70, 80], [80, 90], [90, 101]] as const
const bandOf = (p: number): string => { const b = BANDS.find(([lo, hi]) => p * 100 >= lo && p * 100 < hi)!; return `${b[0]}-${b[1] > 100 ? 100 : b[1]}` }
// Favorite or underdog by the price on the side bought.
const sideOf = (priceC: number | null | undefined): 'favorite' | 'underdog' | null => (priceC == null ? null : priceC >= 50 ? 'favorite' : 'underdog')

export interface Calibration {
  key: string
  n: number
  // Our average chance on these plays, and how often they won.
  said: number
  won: number
  // The shrunk difference, never above zero: the amount a chance is lowered.
  shift: number
}

const keyOf = (lane: string, side: string, band: string): string => `${lane}|${side}|${band}`

// The user's own record, settled plays only, by the raw chance we gave.
export function calibrate(tickets: SettledLike[]): Map<string, Calibration> {
  const groups = new Map<string, { said: number; won: number; n: number }>()
  for (const t of tickets) {
    if (t.pnlUsd === null || !(t.filledContracts > 0) || !t.play) continue
    const raw = t.play.rawP ?? t.play.ourP
    const side = sideOf(t.avgFillC ?? t.limitPriceC)
    if (raw == null || !side) continue
    const k = keyOf(t.play.lane, side, bandOf(raw))
    const g = groups.get(k) ?? { said: 0, won: 0, n: 0 }
    g.said += raw
    g.won += t.pnlUsd > 0 ? 1 : 0
    g.n++
    groups.set(k, g)
  }
  const out = new Map<string, Calibration>()
  for (const [key, g] of groups) {
    const said = g.said / g.n
    const won = g.won / g.n
    // Shrink the record toward what we said, as if MEASURED_PRIOR plays had
    // come in exactly at our chance.
    const shrunk = (g.won + MEASURED_PRIOR * said) / (g.n + MEASURED_PRIOR)
    out.set(key, { key, n: g.n, said, won, shift: g.n >= MEASURED_MIN ? Math.min(0, shrunk - said) : 0 })
  }
  return out
}

const pct = (p: number): string => `${Math.round(p * 100)}%`

// Is the play backing the home team? Moneylines say so in their type.
const backsHome = (s: Signal): boolean | null => (s.signalType === 'BUY_HOME' ? true : s.signalType === 'BUY_AWAY' ? false : null)

export function honestChance(s: Signal, calib: Map<string, Calibration>, priceC: number | null): Honest | null {
  if (s.ourP === null) return null
  const raw = s.rawP ?? s.ourP
  let p = raw
  const notes: string[] = []

  // 1. The comeback record, for a moneyline on a team in a measured spot.
  const home = backsHome(s)
  if (s.comeback && home !== null && s.lane === 'MONEYLINE') {
    const trailing = home === s.comeback.trailingHome
    const record = trailing ? s.comeback.winP : 1 - s.comeback.winP
    if (p > record) {
      const next = record + (p - record) * COMEBACK_WEIGHT
      const spot = `${s.comeback.deficit != null ? `down ${s.comeback.deficit}` : 'trailing'}${s.comeback.bucket ? ` (${s.comeback.bucket.toLowerCase().replace(/_/g, ' ')})` : ''}`
      notes.push(trailing
        ? `teams ${spot} came back to win ${pct(record)}, under our ${pct(p)}`
        : `teams leading like this held on ${pct(record)} of the time, under our ${pct(p)}`)
      p = next
    }
  }

  // 2. The user's own record at this lane, side and chance.
  const side = sideOf(priceC ?? (s.marketP === null ? null : s.marketP * 100))
  if (side) {
    const c = calib.get(keyOf(s.lane, side, bandOf(raw)))
    if (c && c.shift < 0) {
      notes.push(`your ${side} ${s.lane.toLowerCase()} plays at ${bandOf(raw)}% won ${pct(c.won)} over ${c.n}`)
      p = p + c.shift
    }
  }

  p = Math.min(raw, Math.max(0.01, p))
  return { raw, p, notes }
}

// The signal the gates read: our chance replaced by the honest one, the raw
// one kept, and the edge worked out again on the honest chance.
export function withHonest(s: Signal, calib: Map<string, Calibration>): Signal {
  const priceC = s.quotes.find((q) => q.ask !== null)?.ask
  const h = honestChance(s, calib, priceC == null ? null : priceC * 100)
  if (!h || h.p === h.raw) return s.rawP === undefined && s.ourP !== null ? { ...s, rawP: s.ourP } : s
  const drop = (h.raw - h.p) * 100
  return {
    ...s,
    rawP: h.raw,
    ourP: h.p,
    edgePp: s.edgePp === null ? null : s.edgePp - drop,
    honestNotes: h.notes
  }
}
