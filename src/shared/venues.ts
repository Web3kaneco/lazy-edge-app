// Where a bot prices and, when live, trades (2026-11-20): a bot's mode
// is the only switch between practice and real money, and the venues follow
// the keys the user has saved. A venue with no key can never be chosen, so a
// live bot cannot be left pointing at nowhere by one wrong chip.
import type { AccountSettings, BotSettings, VenueId } from './schema'

export type RealVenue = Exclude<VenueId, 'paper'>
export const REAL_VENUES: readonly RealVenue[] = ['kalshi', 'polymarket']
export const VENUE_NAMES: Record<RealVenue, string> = { kalshi: 'Kalshi', polymarket: 'Polymarket' }

// The real venues the bot names that have a key, or every keyed venue when it
// names none that do. Empty only when no key is saved at all.
export function botVenues(bot: Pick<BotSettings, 'market'>, keyed: readonly RealVenue[]): RealVenue[] {
  const chosen = REAL_VENUES.filter((v) => bot.market.venues.includes(v) && keyed.includes(v))
  return chosen.length ? chosen : REAL_VENUES.filter((v) => keyed.includes(v))
}

export interface VenueReading {
  configured: boolean
  balanceUsd: number | null
}

// Why a live bot that is switched on cannot place a real order right now, in
// plain words, or null when nothing stands in its way. Paper bots and bots
// that are off have nothing to report.
export function liveProblem(
  bot: Pick<BotSettings, 'enabled' | 'mode' | 'market' | 'size'>,
  account: Pick<AccountSettings, 'killSwitch'>,
  venues: Partial<Record<RealVenue, VenueReading>>
): string | null {
  if (!bot.enabled || bot.mode !== 'live') return null
  if (account.killSwitch) return 'The kill switch is on, so no real order is sent until you release it.'
  // The venues are read once the engine runs; before that nothing is known.
  if (!REAL_VENUES.some((v) => venues[v])) return null
  const keyed = REAL_VENUES.filter((v) => venues[v]?.configured)
  const use = botVenues(bot, keyed)
  if (!use.length) return 'No Kalshi or Polymarket key is saved, so this bot has nowhere to send an order. Add one on the Keys screen.'
  const funded = use.filter((v) => (venues[v]?.balanceUsd ?? null) !== null && venues[v]!.balanceUsd! >= bot.size.minTradeUsd)
  if (funded.length) return null
  const names = use.map((v) => VENUE_NAMES[v]).join(' or ')
  const unread = use.every((v) => venues[v]?.balanceUsd === null || venues[v]?.balanceUsd === undefined)
  return unread
    ? `Your ${names} balance has not been read yet, so nothing is sent until it is. Start the engine, or check the key on the Keys screen.`
    : `Your ${names} balance is under the $${bot.size.minTradeUsd} smallest trade, so nothing can be sent.`
}
