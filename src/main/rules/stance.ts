// Which way a Kalshi contract bets, so a bot never bets against a position it
// already holds on the same game. Read from the ticker alone, by Kalshi's own
// naming: the series ends in GAME, SPREAD, TEAMTOTAL or TOTAL, and the last
// segment is a team code, a rung, or both ("-DAL", "-DEN11", "-IND24", "-49").
//
// A game has two teams, so YES on one team is the same bet as NO on the
// other. Two side bets agree when they name the same team on the same side,
// or different teams on different sides; anything else bets both ways, like
// YES on both moneylines or "A by over 3.5" with "A not by over 9.5". A
// ticker the table does not know has no stance and is never blocked by it.
import type { ContractSide } from '@shared/signal'

export interface Position { contract: string; side: ContractSide }

interface Stance { family: string; team: string | null }

export function stanceOf(contract: string): Stance | null {
  const parts = contract.toUpperCase().split('-')
  if (parts.length < 3) return null
  const series = parts[0]!
  const m = /^([A-Z]*)(\d*)$/.exec(parts[parts.length - 1]!)
  if (!m) return null
  const team = m[1] || null
  if (/TEAMTOTAL$/.test(series)) return team ? { family: `team_total:${team}`, team } : null
  if (/TOTAL$/.test(series)) return { family: 'total', team: null }
  if (/(GAME|SPREAD)$/.test(series)) return team ? { family: 'sides', team } : null
  return null
}

export function opposes(a: Position, b: Position): boolean {
  // The other side of the very same contract always bets against it, whatever
  // the market, player props included.
  if (a.contract.toUpperCase() === b.contract.toUpperCase()) return a.side !== b.side
  const x = stanceOf(a.contract)
  const y = stanceOf(b.contract)
  if (!x || !y || x.family !== y.family) return false
  if (x.family === 'sides') return (x.team === y.team) !== (a.side === b.side)
  return a.side !== b.side
}

// The held position this one would bet against, or null.
export function opposedBy(p: Position, held: readonly Position[]): Position | null {
  return held.find((h) => opposes(p, h)) ?? null
}
