import { describe, expect, it } from 'vitest'
import { defaultBot } from '../src/shared/ruleset'
import { botSentence } from '../src/shared/sentence'
import type { BotSettings } from '../src/shared/schema'

const bot = (f: (b: BotSettings) => void): BotSettings => { const b = defaultBot('a', 'A'); f(b); return b }

describe('a bot in one sentence', () => {
  it('reads the props bot as it is set today', () => {
    const s = botSentence(bot((b) => {
      b.market.sports = ['NBA']; b.market.lanes = ['PROP']; b.market.phase = 'live'; b.market.quarters = ['Q3', 'Q4']; b.market.propTopPlayers = 10
      b.entry.minEdgePp = 3; b.entry.priceBandC = [40, 92]; b.entry.minChancePct = { pregame: 60, Q1: 60, Q2: 60, Q3: 60, Q4: 60 }
      b.size.sizing = 'flat'; b.size.maxTradeUsd = 5; b.exit.mode = 'hold'
    }))
    expect(s).toBe('Trades NBA player props in game, in Q3 and Q4 only, on the top 10 players in each game, when our chance beats the price by 3 points and 60% or more to hit, priced 40c to 92c. $5 a trade, held to the end.')
  })

  it('reads a pregame pick bot with its window', () => {
    const s = botSentence(bot((b) => {
      b.market.sports = ['NBA']; b.market.lanes = ['MONEYLINE']; b.market.phase = 'pregame'; b.entry.basis = 'pick'; b.entry.pickGapPp = null
      b.entry.pregameWindowMin = 15; b.entry.priceBandC = [1, 85]; b.size.sizing = 'flat'; b.size.maxTradeUsd = 5
    }))
    expect(s).toMatch(/^Buys our pick on NBA moneylines before the game, priced 1c to 85c, in the last 15 minutes before the start\. \$5 a trade/)
  })

  it("reads the API's combos and a Kelly bot that sells after a time", () => {
    expect(botSentence(bot((b) => { b.market.sports = ['NBA']; b.market.lanes = ['COMBO']; b.combo.only = true; b.combo.source = 'api'; b.combo.maxPerDay = 5 })))
      .toMatch(/^Buys the API's NBA combos as they are, up to 5 a day, priced/)
    expect(botSentence(bot((b) => { b.market.sports = ['NBA']; b.market.lanes = ['COMBO']; b.combo.only = true; b.combo.source = 'api'; b.combo.apiLegs = [4, 3] })))
      .toMatch(/^Buys the API's NBA combos of 3 and 4 legs as they are/)
    expect(botSentence(bot((b) => { b.size.sizing = 'kelly'; b.size.maxTradeUsd = 10; b.exit.mode = 'time'; b.exit.afterMin = 15 })))
      .toMatch(/Up to \$10 a trade, sized by Kelly, sold after 15 minutes\.$/)
  })

  it('leaves the chance out when the quarters ask for different chances', () => {
    expect(botSentence(bot((b) => { b.market.phase = 'live'; b.entry.minChancePct = { pregame: 0, Q1: 50, Q2: 60, Q3: 60, Q4: 60 } }))).not.toMatch(/to hit/)
  })
})
