// What happened just before a play was bought (2026-11-24: "lets build
// out the system for us to use in the app"). Recorded on every ticket and
// every skip so the nights can be graded by it; no gate reads it yet.
//
// The API research of 24 November found unders lose most when our stats are
// behind: the player has just scored, Kalshi has moved, our count has not.
// Kalshi's own price moving against our side, a count that only just changed
// and a stale box line are the app's three ways to see that.
export interface Trail {
  // Kalshi's ask on the side bought now, less its ask about 60 and 120
  // seconds before, in cents. Plus is dearer: the market came toward us.
  // Minus is cheaper: the market moved away. Null when the app has no
  // reading that old.
  move60C: number | null
  move120C: number | null
  // Seconds our chance has stood above Kalshi's ask on this side without a
  // break, as far as the app has watched.
  edgeAgeS: number | null
  // For a prop, seconds the player's count on this stat has stayed as it is,
  // since it last changed or since the app began watching.
  countSameS: number | null
  // True when the count changed while the app watched; false when it has
  // only ever seen this count, so countSameS is a lower bound.
  countChanged: boolean | null
  // Seconds since the API's poller last wrote the player's box line
  // (updated_at). The poller rewrites it about every 15 seconds, so a
  // minute or more means the feed for that game has stalled.
  statsAgeS: number | null
  // Seconds since c2 worked out the player's chance (c2_priced_at). When
  // liveModel is formula, the chance is worked out as it is served.
  pricedAgeS: number | null
  liveModel: string | null
  // The player's minutes so far.
  minutes: number | null
}

const secs = (s: number): string => (s >= 120 ? `${Math.round(s / 60)} min` : `${Math.round(s)}s`)

// One plain line for the ledger, e.g. "Kalshi 4c dearer over the last
// minute, 6c over two; edge 95s old; count unchanged 40s; stats 12s old;
// chance 20s old (c2)".
export function trailWords(t: Trail | null | undefined): string | null {
  if (!t) return null
  const move = (c: number): string => (c === 0 ? 'unchanged' : `${Math.abs(c)}c ${c > 0 ? 'dearer' : 'cheaper'}`)
  const parts: string[] = []
  if (t.move60C !== null || t.move120C !== null) {
    const one = t.move60C !== null ? `${move(t.move60C)} over the last minute` : null
    const two = t.move120C !== null ? `${move(t.move120C)} over two` : null
    parts.push(`Kalshi ${[one, two].filter(Boolean).join(', ')}`)
  }
  if (t.edgeAgeS !== null) parts.push(`edge ${secs(t.edgeAgeS)} old`)
  if (t.countSameS !== null) parts.push(t.countChanged ? `count changed ${secs(t.countSameS)} ago` : `count unchanged ${secs(t.countSameS)}`)
  if (t.statsAgeS !== null) parts.push(`stats ${secs(t.statsAgeS)} old`)
  if (t.pricedAgeS !== null || t.liveModel) parts.push(`chance ${t.pricedAgeS !== null ? `${secs(t.pricedAgeS)} old` : 'age unknown'}${t.liveModel ? ` (${t.liveModel})` : ''}`)
  if (t.minutes !== null) parts.push(`${Math.round(t.minutes)} min played`)
  return parts.length ? parts.join('; ') : null
}
