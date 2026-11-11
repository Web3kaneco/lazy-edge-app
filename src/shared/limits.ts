// The money limits in plain words. Every number here is a setting the gates
// already enforce (src/main/rules/gates.ts); this file only says what they add
// up to, so "how much can be in play" never needs a message to support.
import { DAY_START_HOUR } from './day'
import type { AccountSettings, BotSettings } from './schema'

const START_TEXT = `${DAY_START_HOUR} AM your time`
const DAY_TEXT = `from ${DAY_START_HOUR} AM to ${DAY_START_HOUR} AM your time`
const money = (n: number): string => `$${Number.isInteger(n) ? n : n.toFixed(2)}`

export interface LimitsSummary {
  lines: string[]
  // Settings that fight each other, so one of them never does what it says.
  warnings: string[]
}

export function limitsSummary(bot: BotSettings, account: AccountSettings): LimitsSummary {
  const { size, guards } = bot
  const live = bot.mode === 'live'
  const cap = account.accountMaxOpenExposureUsd
  const busiest = guards.maxTradesPerDay * size.maxTradeUsd
  const lines: string[] = []
  const warnings: string[] = []

  const sizedOn = size.bankrollUsd > 0 ? `a ${money(size.bankrollUsd)} bankroll` : 'your live balance'
  lines.push(`Each trade costs at most ${money(size.maxTradeUsd)}, sized by Kelly against ${sizedOn}.`)
  lines.push(`At most ${guards.maxTradesPerDay} new trades a day. The day runs ${DAY_TEXT}, so a late West Coast game counts with the night it started.`)
  lines.push(`On its busiest day it could put up to ${money(busiest)} into trades (${guards.maxTradesPerDay} at ${money(size.maxTradeUsd)}). Trades that settle free their money, so far less is usually open at once.`)
  lines.push(`No more than ${Math.round(size.maxGameEquityPct * 100)}% of the account's value on any one game.`)
  lines.push(`It stops for the day once it is down ${money(guards.maxDailyDrawdownUsd)}, and when your live bots together are down ${money(account.accountDailyDrawdownUsd)}.`)
  if (live) lines.push(`Across every live bot together, at most ${money(cap)} is open at once. That is the Maximum open exposure on the Account screen, and it is what caps how much is in play.`)
  else lines.push('This bot trades practice money, so the open exposure limit on the Account screen does not apply to it.')

  if (live && size.maxTradeUsd > cap) {
    warnings.push(`A ${money(size.maxTradeUsd)} trade is bigger than the ${money(cap)} account limit on open trades, so this bot can never place its largest trade.`)
  } else if (live && busiest > cap) {
    warnings.push(`The account limit of ${money(cap)} open at once comes first. If trades stay open, the bot stops at about ${Math.floor(cap / size.maxTradeUsd)} trades of ${money(size.maxTradeUsd)}, not ${guards.maxTradesPerDay}. To have more in play, raise Maximum open exposure on the Account screen.`)
  }
  const contractsCap = (size.maxContracts * bot.entry.priceBandC[1]) / 100
  if (contractsCap < size.maxTradeUsd) {
    warnings.push(`${size.maxContracts} contracts at ${bot.entry.priceBandC[1]}c cost ${money(contractsCap)}, so Maximum contracts per trade stops a trade before it reaches ${money(size.maxTradeUsd)}.`)
  }
  if (size.minTradeUsd > size.maxTradeUsd) {
    warnings.push(`The ${money(size.minTradeUsd)} minimum per trade is above the ${money(size.maxTradeUsd)} maximum, so every trade is held to the maximum.`)
  }
  if (guards.maxDailyDrawdownUsd < size.maxTradeUsd) {
    warnings.push(`One losing ${money(size.maxTradeUsd)} trade is enough to hit the ${money(guards.maxDailyDrawdownUsd)} daily stop.`)
  }
  if (live && guards.maxDailyDrawdownUsd > account.accountDailyDrawdownUsd) {
    warnings.push(`The bot's ${money(guards.maxDailyDrawdownUsd)} daily stop never comes into play, because the account stops every live bot at ${money(account.accountDailyDrawdownUsd)} first.`)
  }
  return { lines, warnings }
}

// The gates that hold a play back for a money or pace limit, rather than
// because the play itself failed. The Dashboard counts these each day.
export const LIMIT_GATES = ['account_exposure', 'max_trades_today', 'game_cap', 'bot_drawdown', 'account_drawdown'] as const
export type LimitGate = (typeof LIMIT_GATES)[number]
export const isLimitGate = (gate: string): gate is LimitGate => (LIMIT_GATES as readonly string[]).includes(gate)

export interface HeldBack { gate: LimitGate; botId: string; botName: string; plays: number }

const plays = (n: number): string => `${n} ${n === 1 ? 'play' : 'plays'}`

// What a limit held back today and which setting did it. Raising a pace or
// size limit is the user's call; the loss stops are protection, so the text
// names them without suggesting they go up.
export function heldNote(h: HeldBack, account: AccountSettings, bot?: BotSettings): string {
  switch (h.gate) {
    case 'account_exposure':
      return `${h.botName} passed ${plays(h.plays)} that did not fit under the ${money(account.accountMaxOpenExposureUsd)} account limit on open trades. To have more in play, raise Maximum open exposure on the Account screen.`
    case 'max_trades_today':
      return `${h.botName} reached its ${bot ? `${bot.guards.maxTradesPerDay} trade ` : ''}daily limit and passed ${plays(h.plays)} after it. Maximum trades per day is in the bot's Guards.`
    case 'game_cap':
      return `${h.botName} passed ${plays(h.plays)} because the game already held its share of the account. Maximum share of equity per game is in the bot's Size settings.`
    case 'bot_drawdown':
      return `${h.botName} hit its ${bot ? `${money(bot.guards.maxDailyDrawdownUsd)} ` : ''}daily loss stop and sat out ${plays(h.plays)}. It starts again at ${START_TEXT}.`
    case 'account_drawdown':
      return `Your live bots together hit the ${money(account.accountDailyDrawdownUsd)} account loss stop, so ${h.botName} sat out ${plays(h.plays)}. It starts again at ${START_TEXT}.`
  }
}
