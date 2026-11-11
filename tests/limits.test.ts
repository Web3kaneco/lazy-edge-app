import { describe, expect, it } from 'vitest'
import { heldNote, isLimitGate, limitsSummary } from '../src/shared/limits'
import { DEFAULT_ACCOUNT } from '../src/shared/ruleset'
import type { BotSettings } from '../src/shared/schema'
import { STARTERS } from '../src/shared/starters'

const explorer = (change: (b: BotSettings) => void = () => {}): BotSettings => {
  const b = STARTERS.find((s) => s.key === 'explorer')!.build()
  b.mode = 'live'
  change(b)
  return b
}

describe('limits summary', () => {
  it('says the account limit, not the trade count, caps money in play', () => {
    // The tester's question: 125 trades at $4 under the shipped $200 limit.
    const { lines, warnings } = limitsSummary(explorer((b) => { b.guards.maxTradesPerDay = 125; b.size.maxTradeUsd = 4 }), DEFAULT_ACCOUNT)
    expect(lines.join(' ')).toMatch(/up to \$500 into trades \(125 at \$4\)/)
    expect(lines.join(' ')).toMatch(/at most \$200 is open at once/)
    expect(warnings.join(' ')).toMatch(/stops at about 50 trades of \$4, not 125.*raise Maximum open exposure/)
  })

  it('has nothing to warn about once the account limit covers the busiest day', () => {
    const { warnings } = limitsSummary(explorer((b) => { b.guards.maxTradesPerDay = 100; b.size.maxTradeUsd = 4 }), { ...DEFAULT_ACCOUNT, accountMaxOpenExposureUsd: 400 })
    expect(warnings).toEqual([])
  })

  it('leaves the account limit out for a paper bot', () => {
    const { lines, warnings } = limitsSummary(explorer((b) => { b.mode = 'paper'; b.guards.maxTradesPerDay = 500 }), DEFAULT_ACCOUNT)
    expect(lines.join(' ')).toMatch(/practice money/)
    expect(warnings.join(' ')).not.toMatch(/open exposure/)
  })

  it('catches settings that cancel each other', () => {
    const tooBig = limitsSummary(explorer((b) => { b.size.maxTradeUsd = 300 }), DEFAULT_ACCOUNT).warnings.join(' ')
    expect(tooBig).toMatch(/can never place its largest trade/)
    expect(tooBig).toMatch(/One losing \$300 trade is enough to hit the \$50 daily stop/)
    const contracts = limitsSummary(explorer((b) => { b.size.maxContracts = 2; b.size.maxTradeUsd = 4 }), DEFAULT_ACCOUNT).warnings.join(' ')
    expect(contracts).toMatch(/2 contracts at 75c cost \$1.50/)
    const minAboveMax = limitsSummary(explorer((b) => { b.size.minTradeUsd = 3 }), DEFAULT_ACCOUNT).warnings.join(' ')
    expect(minAboveMax).toMatch(/\$3 minimum per trade is above the \$2 maximum/)
    const stops = limitsSummary(explorer((b) => { b.guards.maxDailyDrawdownUsd = 80 }), DEFAULT_ACCOUNT).warnings.join(' ')
    expect(stops).toMatch(/\$80 daily stop never comes into play/)
  })

  it('names the setting that held plays back, and never suggests raising a loss stop', () => {
    const bot = explorer()
    const cap = heldNote({ gate: 'account_exposure', botId: bot.id, botName: bot.name, plays: 14 }, DEFAULT_ACCOUNT, bot)
    expect(cap).toMatch(/passed 14 plays that did not fit under the \$200 account limit.*raise Maximum open exposure/)
    expect(heldNote({ gate: 'max_trades_today', botId: bot.id, botName: bot.name, plays: 1 }, DEFAULT_ACCOUNT, bot)).toMatch(/its 60 trade daily limit and passed 1 play after it/)
    expect(heldNote({ gate: 'max_trades_today', botId: 'gone', botName: 'A deleted bot', plays: 2 }, DEFAULT_ACCOUNT)).toMatch(/its daily limit/)
    const stop = heldNote({ gate: 'bot_drawdown', botId: bot.id, botName: bot.name, plays: 3 }, DEFAULT_ACCOUNT, bot)
    expect(stop).toMatch(/\$50 daily loss stop and sat out 3 plays/)
    expect(stop).not.toMatch(/raise/i)
  })

  it('counts only the money and pace gates as limits', () => {
    expect(isLimitGate('account_exposure')).toBe(true)
    expect(isLimitGate('min_edge')).toBe(false)
  })
})

describe('limits summary wording', () => {
  it('says the stops count settled money only, and names the pace', () => {
    const live = limitsSummary(explorer(), DEFAULT_ACCOUNT).lines.join(' ')
    expect(live).toMatch(/settled trades are down \$50 after fees, or when your live bots together are down \$50/)
    expect(live).toMatch(/deposits and withdrawals never count/)
    const paper = limitsSummary(explorer((b) => { b.mode = 'paper'; b.pollS = 60 }), DEFAULT_ACCOUNT).lines.join(' ')
    expect(paper).not.toMatch(/live bots together/)
    expect(paper).toMatch(/every 60 seconds/)
  })
})
