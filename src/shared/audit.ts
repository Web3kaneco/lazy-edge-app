// The settings audit (2026-11-21: "these are things I want the local AI
// to do in the complete system"). Plain checks on every bot that is on, the
// same ones a person would make by reading each bot: settings that cancel
// each other, a live bot that cannot trade, bots that bet against each other,
// and money that is risked in a way the settings may not mean. The app shows
// the findings; the AI reads them and explains, and can propose the fix.
import { liveProblem, type VenueReading, type RealVenue } from './venues'
import { flatRiskNote, botRisk } from './risk'
import { limitsSummary } from './limits'
import type { SettledLike } from './results'
import type { AccountSettings, BotSettings } from './schema'

export interface Finding {
  botId: string | null
  botName: string | null
  level: 'problem' | 'check'
  text: string
  // The setting to change, in plain words, when there is one.
  fix: string | null
}

export interface AuditInput {
  bots: BotSettings[]
  account: AccountSettings
  venues: Partial<Record<RealVenue, VenueReading>>
  engineRunning: boolean
  tickets: SettledLike[]
}

export function auditBots(input: AuditInput): Finding[] {
  const out: Finding[] = []
  const on = input.bots.filter((b) => b.enabled)
  const add = (b: BotSettings | null, level: Finding['level'], text: string, fix: string | null = null): void => {
    out.push({ botId: b?.id ?? null, botName: b?.name ?? null, level, text, fix })
  }

  if (!on.length) add(null, 'check', 'No bot is switched on.')
  if (on.length && !input.engineRunning) add(null, 'problem', 'The engine is stopped, so no bot trades, paper or live.', 'Press Start engine at the top.')

  for (const b of on) {
    const live = b.mode === 'live'
    const lp = liveProblem(b, input.account, input.venues)
    if (lp) add(b, 'problem', lp)

    const pick = b.entry.basis === 'pick'
    const comboOnly = b.combo.only && b.market.lanes.includes('COMBO')
    if (pick && b.size.sizing === 'kelly') add(b, 'problem', 'It buys our pick but sizes by Kelly. Kelly stakes nothing on a pick priced at or above our chance, so it skips many of the picks it is meant to take.', 'Set Sizing to Flat.')
    if (comboOnly && b.combo.source === 'built') add(b, 'check', `It builds its own combos from its plays, which must clear a ${b.entry.minEdgePp} point minimum edge, rather than buying the API's combos.`, "To buy the API's combos as they are, set Which combos to The API's combos.")
    if (comboOnly && b.combo.source === 'api' && !b.market.sports.some((s) => s === 'NBA' || s === 'NFL')) add(b, 'problem', "It buys the API's combos but trades neither NBA nor NFL, the two sports that have them.", 'Add NBA or NFL to Sports.')
    if (b.market.lanes.includes('PROP') && b.market.propTopPlayers === null) add(b, 'check', 'It trades props on every player, role players included.', "Set Props on the game's top players only, for example to 10.")
    if (b.market.phase !== 'live' && b.entry.pregameWindowMin === null && !comboOnly) add(b, 'check', 'Its pregame plays can go in hours early, before the pick and the price settle.', 'Set Pregame plays wait until, for example to 15 minutes.')
    if (b.market.sports.includes('MLB') && b.market.phase !== 'live' && b.entry.pregameWindowMin !== null) add(b, 'problem', "MLB rows carry no first pitch time, so with a pregame window its MLB pregame plays are never taken.", 'Clear Pregame plays wait until, or leave MLB out.')
    if (b.market.phase === 'pregame' && b.market.quarters.length < 4 && !comboOnly) add(b, 'check', 'It trades pregame only, so its quarter list is not used.')
    if (live && b.size.sizing === 'flat' && b.entry.priceBandC[1] >= 90) {
      const hi = b.entry.priceBandC[1]
      const win = (b.size.maxTradeUsd * (100 - hi)) / hi
      add(b, 'check', `It stakes a flat $${b.size.maxTradeUsd} at prices up to ${hi}c: a ${hi}c buy risks the whole $${b.size.maxTradeUsd} to win about $${win.toFixed(2)}.`, 'Lower Price band high if that is not what you mean.')
    }
    if (!pick && b.entry.minEdgePp < 3 && !comboOnly) add(b, 'check', `Its minimum edge is ${b.entry.minEdgePp} points; at a 60% chance a 3 point edge is worth only about 1 cent a contract after the fee.`)
    const note = flatRiskNote(b, botRisk(input.tickets.filter((t) => t.botId === b.id)))
    if (note) add(b, 'check', note, 'Set Sizing to Kelly to stake less on long shots.')
    if (live) for (const w of limitsSummary(b, input.account).warnings) add(b, 'check', w)
  }

  // Bots that can take opposite sides of one game: the "never bet against
  // itself" rule works inside one bot only.
  const teamBots = on.filter((b) => !b.combo.only && (b.market.lanes.includes('MONEYLINE') || b.market.lanes.includes('SPREAD')))
  for (let i = 0; i < teamBots.length; i++) for (let j = i + 1; j < teamBots.length; j++) {
    const a = teamBots[i]!, c = teamBots[j]!
    const sports = a.market.sports.filter((s) => c.market.sports.includes(s))
    const phases = a.market.phase === 'both' || c.market.phase === 'both' || a.market.phase === c.market.phase
    const differ = a.entry.basis !== c.entry.basis
    if (sports.length && phases && differ) add(null, 'check', `${a.name} and ${c.name} both trade ${sports.join(' and ')} games, one on the edge and one on our pick, so they can end up on opposite sides of one game.`, 'Set Favorites only on the edge bot if they should never oppose each other.')
  }
  // Two bots doing the same job double the money on it.
  const pickPre = on.filter((b) => b.entry.basis === 'pick' && b.market.phase !== 'live' && b.market.lanes.includes('MONEYLINE'))
  for (let i = 0; i < pickPre.length; i++) for (let j = i + 1; j < pickPre.length; j++) {
    const a = pickPre[i]!, c = pickPre[j]!
    const sports = a.market.sports.filter((s) => c.market.sports.includes(s))
    if (sports.length) add(null, 'check', `${a.name} and ${c.name} both buy our ${sports.join(' and ')} pregame picks, so a pick both take is bought twice.`, 'Switch one of them off if that is not meant.')
  }
  return out.sort((x, y) => (x.level === y.level ? 0 : x.level === 'problem' ? -1 : 1))
}
