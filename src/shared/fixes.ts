// One click fixes (2026-11-17): the setting change a Results recommendation
// points at, as data, so the user can apply it to the bots that made the
// trades without hunting for the field. Every fix only narrows what a bot may
// trade; none can loosen a setting, raise a size or switch a bot on. The user
// sees each bot's exact change before it is saved, and the save is written to
// the ledger like any other.
import { z } from 'zod'
import { BotSettings, Quarter } from './schema'

export const Fix = z.discriminatedUnion('kind', [
  // Leave one sport, lane, label or quarter out.
  z.object({ kind: z.literal('drop'), field: z.enum(['sports', 'lanes', 'labels', 'quarters']), value: z.string().min(1).max(40) }),
  z.object({ kind: z.literal('dropPhase'), phase: z.enum(['pregame', 'live']) }),
  z.object({ kind: z.literal('noOvertime') }),
  z.object({ kind: z.literal('priceFloor'), c: z.number().int().min(1).max(99) }),
  z.object({ kind: z.literal('priceCeiling'), c: z.number().int().min(1).max(99) }),
  z.object({ kind: z.literal('minEdge'), pp: z.number().min(0).max(50) }),
  z.object({ kind: z.literal('maxTrailing'), points: z.number().int().min(0).max(60) }),
  z.object({ kind: z.literal('favoritesOnly') }),
  // From 0.9.2 (patterns on losses): raise the minimum chance, in one part of
  // the game or all of them, and keep out of a game's last minutes.
  z.object({ kind: z.literal('minChance'), when: z.enum(['pregame', 'Q1', 'Q2', 'Q3', 'Q4', 'all']), pct: z.number().min(1).max(99) }),
  z.object({ kind: z.literal('finalSeconds'), s: z.number().int().min(1).max(2880) }),
  // Props on the game's leading players only.
  z.object({ kind: z.literal('propTop'), n: z.number().int().min(1).max(30) })
])
export type Fix = z.infer<typeof Fix>

const FIELD_NAME = { sports: 'Sports', lanes: 'Lanes', labels: 'Labels', quarters: 'Quarters' } as const

// The change in plain words, for the button and the ledger.
export function fixText(f: Fix): string {
  switch (f.kind) {
    case 'drop': return `Leave ${f.value} out of ${FIELD_NAME[f.field]}`
    case 'dropPhase': return f.phase === 'pregame' ? 'Trade live only, no pregame plays' : 'Trade pregame only, no live plays'
    case 'noOvertime': return 'Switch on No entries in overtime'
    case 'priceFloor': return `Raise the price band low to ${f.c}c`
    case 'priceCeiling': return `Lower the price band high to ${f.c}c`
    case 'minEdge': return `Raise the minimum edge to ${f.pp}pp`
    case 'maxTrailing': return f.points === 0 ? 'Never back a team that is behind' : `Never back a team more than ${f.points} points behind`
    case 'favoritesOnly': return 'Switch on Favorites only'
    case 'minChance': return `Raise the minimum chance to hit to ${f.pct}%${f.when === 'all' ? '' : f.when === 'pregame' ? ' before the game' : ` in the ${ORDINAL[f.when]} quarter`}`
    case 'finalSeconds': return `No entries in a game's last ${Math.round(f.s / 60)} minutes`
    case 'propTop': return `Props only on the top ${f.n} players in each game`
  }
}

const ORDINAL = { Q1: '1st', Q2: '2nd', Q3: '3rd', Q4: '4th' } as const

const backsTeams = (b: BotSettings): boolean => b.market.lanes.includes('MONEYLINE') || b.market.lanes.includes('SPREAD')

// The bot with the fix applied, or null and the reason it would not change.
export function applyFix(bot: BotSettings, f: Fix): { next: BotSettings | null; why: string } {
  const b = structuredClone(bot)
  const no = (why: string): { next: null; why: string } => ({ next: null, why })
  switch (f.kind) {
    case 'drop': {
      const list = b.market[f.field] as string[]
      if (!list.includes(f.value)) return no('already left out')
      if (list.length === 1) return no(`it is this bot's only one; switch the bot off instead`)
      ;(b.market[f.field] as string[]) = list.filter((x) => x !== f.value)
      break
    }
    case 'dropPhase': {
      const other = f.phase === 'pregame' ? 'live' : 'pregame'
      if (b.market.phase === other) return no('already left out')
      if (b.market.phase === f.phase) return no(`it is this bot's only phase; switch the bot off instead`)
      b.market.phase = other
      break
    }
    case 'noOvertime':
      if (b.guards.noOvertime) return no('already on')
      b.guards.noOvertime = true
      break
    case 'priceFloor':
      if (b.entry.priceBandC[0] >= f.c) return no('already at or above it')
      if (f.c > b.entry.priceBandC[1]) return no('it would leave no price to buy at')
      b.entry.priceBandC = [f.c, b.entry.priceBandC[1]]
      break
    case 'priceCeiling':
      if (b.entry.priceBandC[1] <= f.c) return no('already at or below it')
      if (f.c < b.entry.priceBandC[0]) return no('it would leave no price to buy at')
      b.entry.priceBandC = [b.entry.priceBandC[0], f.c]
      break
    case 'minEdge':
      if (b.entry.basis === 'pick') return no('it buys our pick and does not use the edge')
      if (b.entry.minEdgePp >= f.pp) return no('already at or above it')
      b.entry.minEdgePp = f.pp
      break
    case 'maxTrailing': {
      if (!backsTeams(b)) return no('it trades no moneyline or spread')
      if (!b.market.sports.includes('NBA') || b.market.phase === 'pregame') return no('the score is read only on live NBA plays, which it does not trade')
      let moved = false
      for (const q of Quarter.options) {
        const now = b.entry.maxTrailing[q]
        if (now === null || now > f.points) { b.entry.maxTrailing[q] = f.points; moved = true }
      }
      if (!moved) return no('already as tight in every quarter')
      break
    }
    case 'favoritesOnly':
      if (!backsTeams(b)) return no('it trades no moneyline or spread')
      if (b.entry.favoritesOnly) return no('already on')
      b.entry.favoritesOnly = true
      break
    case 'minChance': {
      const keys = f.when === 'all' ? (['pregame', 'Q1', 'Q2', 'Q3', 'Q4'] as const) : [f.when]
      let moved = false
      for (const k of keys) if (b.entry.minChancePct[k] < f.pct) { b.entry.minChancePct[k] = f.pct; moved = true }
      if (!moved) return no('already at or above it')
      break
    }
    case 'finalSeconds':
      if (b.market.phase === 'pregame') return no('it trades before the game only')
      if (b.guards.noEntryFinalS >= f.s) return no('already keeps out that long')
      b.guards.noEntryFinalS = f.s
      break
    case 'propTop':
      if (!b.market.lanes.includes('PROP')) return no('it trades no player props')
      if (b.market.propTopPlayers !== null && b.market.propTopPlayers <= f.n) return no('already that narrow')
      b.market.propTopPlayers = f.n
      break
  }
  const parsed = BotSettings.safeParse(b)
  return parsed.success ? { next: parsed.data, why: '' } : no('the change would not make a valid bot')
}

// Undo: the bot as it is now, with only the fields this fix moved put back,
// and only where they still hold what the fix set. Anything changed since,
// switching the bot off included, is kept. Null when there is nothing to undo.
export function undoFix(before: BotSettings, current: BotSettings, f: Fix): BotSettings | null {
  const applied = applyFix(before, f).next
  if (!applied) return null
  const out = structuredClone(current) as unknown as Record<string, unknown>
  let moved = false
  const at = (o: unknown, path: string[]): unknown => path.reduce<unknown>((x, k) => (x as Record<string, unknown> | undefined)?.[k], o)
  const walk = (a: unknown, b: unknown, path: string[]): void => {
    if (a && b && typeof a === 'object' && typeof b === 'object' && !Array.isArray(a)) {
      for (const k of Object.keys(a)) walk((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k], [...path, k])
      return
    }
    if (JSON.stringify(a) === JSON.stringify(b)) return
    if (JSON.stringify(at(out, path)) !== JSON.stringify(b)) return
    const parent = at(out, path.slice(0, -1)) as Record<string, unknown> | undefined
    if (!parent) return
    parent[path[path.length - 1]!] = structuredClone(a)
    moved = true
  }
  walk(before, applied, [])
  if (!moved) return null
  const parsed = BotSettings.safeParse(out)
  return parsed.success ? parsed.data : null
}
