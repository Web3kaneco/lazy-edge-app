import { describe, expect, it } from 'vitest'
import { acceptSideFor, bestQuote, eventOf, fillMatches, fillPosition, pickCombo, quotePrice, type ComboLeg } from '../src/shared/combos'
import { defaultBot } from '../src/shared/ruleset'
import { BotSettings } from '../src/shared/schema'

const leg = (game: string, ourP: number, askC: number, edgePp: number, contract = `KXNBAGAME-99JAN01${game}-AAA`): ComboLeg =>
  ({ signalKey: `nba:${game}:MONEYLINE:home`, gameId: game, title: `${game} home`, contract, side: 'yes', ourP, askC, edgePp })

describe('combos, 2026-11-16', () => {
  it('names a leg\'s event by its ticker without the last segment', () => {
    expect(eventOf('KXNBAPTS-99JAN01AAABBB-AAAPONE-25')).toBe('KXNBAPTS-99JAN01AAABBB-AAAPONE')
    expect(eventOf('KXNBAGAME-99JAN01AAABBB-AAA')).toBe('KXNBAGAME-99JAN01AAABBB')
  })

  it('takes the best edged legs, one per game, and multiplies their chances', () => {
    const pick = pickCombo([leg('G1', 0.6, 50, 10), leg('G1', 0.7, 60, 12, 'KXNBASPREAD-99JAN01G1-AAA5'), leg('G2', 0.55, 45, 10), leg('G3', 0.5, 45, 5)], 2)!
    expect(pick.legs.map((l) => l.gameId)).toEqual(['G1', 'G2'])
    expect(pick.legs[0]!.contract).toBe('KXNBASPREAD-99JAN01G1-AAA5')
    expect(pick.chance).toBeCloseTo(0.7 * 0.55)
    expect(pick.legsPriceC).toBeCloseTo(27)
    expect(pickCombo([leg('G1', 0.6, 50, 10), leg('G1', 0.6, 50, 9, 'KXNBATOTAL-99JAN01G1-220')], 2)).toBeNull()
  })

  it('reads two bids under 100 as a maker\'s bids: buying YES costs 100 minus the NO bid', () => {
    // Legs worth 27c; the maker bids 22c for YES and 70c for NO.
    expect(quotePrice(22, 70, 27, null)).toMatchObject({ buyYesC: 30, reading: 'one_minus_no_bid' })
  })

  it('reads two prices over 100 as prices to buy: buying YES costs the YES figure', () => {
    expect(quotePrice(31, 76, 27, null)).toMatchObject({ buyYesC: 31, reading: 'yes_bid' })
  })

  it('refuses a price that does not look right', () => {
    // Under what the legs cost one by one: no maker sells a combo below its legs.
    expect(quotePrice(20, 85, 27, null).buyYesC).toBeNull()
    // Far over it.
    expect(quotePrice(10, 20, 27, null).buyYesC).toBeNull()
    // Not a price at all.
    expect(quotePrice(0, 70, 27, null).buyYesC).toBeNull()
    // A reading the live fills contradicted.
    expect(quotePrice(31, 76, 27, 'one_minus_no_bid').buyYesC).toBeNull()
    expect(quotePrice(22, 70, 27, 'one_minus_no_bid').buyYesC).toBe(30)
  })

  it('buys from the cheapest quote that adds up', () => {
    const best = bestQuote([{ yesBidC: 20, noBidC: 85 }, { yesBidC: 22, noBidC: 66 }, { yesBidC: 22, noBidC: 70 }], 27, null)
    expect(best?.price.buyYesC).toBe(30)
  })

  it('treats a fill a cent off as a match and more as a mismatch', () => {
    expect(fillMatches(30, 31)).toBe(true)
    expect(fillMatches(30, 33)).toBe(false)
  })

  it('reads bots saved before combos as two legs, five a day, not combos only', () => {
    const old: Record<string, any> = structuredClone(defaultBot('old', 'old'))
    delete old.combo
    expect(BotSettings.parse(old).combo).toEqual({ legs: 2, maxPerDay: 5, only: false })
  })
  it('lets a confirmed reading decide a quote at 100, and the side to accept follows it', () => {
    expect(quotePrice(40, 60, 35, 'one_minus_no_bid')).toMatchObject({ buyYesC: 40, reading: 'one_minus_no_bid' })
    expect(quotePrice(40, 60.3, 35, 'one_minus_no_bid')).toMatchObject({ reading: 'one_minus_no_bid' })
    expect(quotePrice(40, 60.3, 35, 'yes_bid')).toMatchObject({ reading: 'yes_bid', buyYesC: 40 })
    expect(acceptSideFor('one_minus_no_bid')).toBe('no')
    expect(acceptSideFor('yes_bid')).toBe('yes')
  })

  it('reads the position a fill leaves, from the action and side Kalshi wrote', () => {
    expect(fillPosition('buy', 'yes')).toBe('yes')
    expect(fillPosition('sell', 'yes')).toBe('no')
    expect(fillPosition('buy', 'no')).toBe('no')
    expect(fillPosition('sell', 'no')).toBe('yes')
    expect(fillPosition(undefined, 'bid')).toBe('yes')
    expect(fillPosition('sell', 'ask')).toBe('no')
    expect(fillPosition('buy', 'maybe')).toBeNull()
  })
})

