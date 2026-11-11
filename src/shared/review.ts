// A play check: one ticket, judged on two questions a user can act on. Did it
// trade correctly (price, size, fee, settlement against Kalshi's own record),
// and was it a sound play under the rules the bot ran with? The checks are
// worked out in the main process; these are the shapes both sides read.
import type { BotSettings } from './schema'

// The bot's entry and size rules at the moment it placed, saved on the ticket
// so a later check judges the play by the rules it actually ran under.
export interface PlayRules {
  minEdgePp: number
  minEvCents: number
  edgeHaircut: number
  priceBandC: [number, number]
  maxTradeUsd: number
  maxContracts: number
}

export const rulesOf = (bot: BotSettings): PlayRules => ({
  minEdgePp: bot.entry.minEdgePp,
  minEvCents: bot.entry.minEvCents,
  edgeHaircut: bot.entry.edgeHaircut,
  priceBandC: [bot.entry.priceBandC[0], bot.entry.priceBandC[1]],
  maxTradeUsd: bot.size.maxTradeUsd,
  maxContracts: bot.size.maxContracts
})

// ok: checked and right. look: worth a look, not proof of a fault.
// bad: something is wrong. info: context, neither good nor bad.
export type CheckLevel = 'ok' | 'look' | 'bad' | 'info'

export interface PlayCheck {
  group: 'trade' | 'play'
  level: CheckLevel
  title: string
  text: string
}

export interface PlayReview {
  ticketId: string
  verdict: 'clean' | 'look' | 'problem'
  headline: string
  checks: PlayCheck[]
  checkedAt: number
}
