import { describe, expect, it } from 'vitest'
import { kalshiGameCode, kalshiRungs, mapLeg, nameKey, nflSlips, rankSlips, type MappedLeg, type Ranked } from '../src/shared/nflcombos'
import { BotSettings } from '../src/shared/schema'
import { STARTERS } from '../src/shared/starters'

// Made up, in the shapes Kalshi and the API use: AAA at BBB on 99JAN01.
const market = (player: string, n: number, code = 'AAABBB', series = 'KXNFLPASSYDS') => ({ ticker: `${series}-99JAN01${code}-${player.replace(/\W/g, '').toUpperCase()}-${n}`, yes_sub_title: `${player}: ${n}+`, floor_strike: n - 0.5, strike_type: 'greater' })
const passEvent = 'KXNFLPASSYDS-99JAN01AAABBB'
const recEvent = 'KXNFLREC-99JAN01AAABBB'
const rungs = new Map([
  [passEvent, kalshiRungs(passEvent, [175, 200, 225, 250, 275].map((n) => market('Alpha Quarterback Jr.', n)))],
  [recEvent, kalshiRungs(recEvent, [3, 4, 5, 6].map((n) => market('Bravo Wideout', n, 'AAABBB', 'KXNFLREC')))]
])
const leg = (over: Record<string, unknown>) => ({ player: 'Alpha Quarterback', stat: 'pass_yds', side: 'OVER', line: 247.5, game_id: 'g1', p_over: 0.6, team: 'AAA', ...over })

describe('reading the API slips', () => {
  it('reads curated slips and same-game pairs with our chance for the whole slip', () => {
    const slips = nflSlips({
      slips: [{ key: 'banker', name: 'THE BANKER', legs: [leg({}), leg({ player: 'Bravo Wideout', stat: 'receptions', line: 4.5, p_over: 0.65 })], quote: { our_prob: 0.39 } }],
      pairs: [{ legs: [leg({}), leg({ player: 'Bravo Wideout', stat: 'rec_yds', line: 55.5, p_over: 0.55 })], joint: 0.36, product: 0.33 }]
    })
    expect(slips.map((s) => [s.name, s.chance, s.legs.length])).toEqual([['THE BANKER', 0.39, 2], ['Same game pair: Alpha Quarterback and Bravo Wideout', 0.36, 2]])
    expect(slips[0]!.legs[0]).toMatchObject({ side: 'OVER', pSide: 0.6, gameId: 'g1' })
  })

  it('leaves out a slip with an unreadable leg', () => {
    expect(nflSlips({ slips: [{ name: 'X', legs: [leg({}), leg({ line: null })], quote: { our_prob: 0.4 } }] })).toEqual([])
  })
})

describe('mapping a leg to a Kalshi market', () => {
  const s = (over: Record<string, unknown>) => nflSlips({ slips: [{ name: 'S', legs: [leg(over), leg({})], quote: { our_prob: 0.3 } }] })[0]!.legs[0]!

  it('an over takes the highest Kalshi rung at or under its line, never a harder one', () => {
    const m = mapLeg(s({}), '99JAN01AAABBB', (e) => rungs.get(e)).leg!
    expect(m).toMatchObject({ contract: 'KXNFLPASSYDS-99JAN01AAABBB-ALPHAQUARTERBACKJR-225', side: 'yes', floor: 224.5, ourP: 0.6, exact: false })
  })

  it('an under takes the lowest rung at or over its line, as the NO side', () => {
    const m = mapLeg(s({ side: 'UNDER', line: 247.5 }), '99JAN01AAABBB', (e) => rungs.get(e)).leg!
    expect(m).toMatchObject({ contract: 'KXNFLPASSYDS-99JAN01AAABBB-ALPHAQUARTERBACKJR-250', side: 'no', floor: 249.5 })
    expect(m.ourP).toBeCloseTo(0.4)
  })

  it('matches names across suffixes and refuses a rung too far away, a missing player or a stat Kalshi lacks', () => {
    expect(nameKey('Alpha Quarterback Jr.')).toBe(nameKey('Alpha Quarterback'))
    expect(mapLeg(s({ player: 'Bravo Wideout', stat: 'receptions', line: 4.5 }), '99JAN01AAABBB', (e) => rungs.get(e)).leg).toMatchObject({ floor: 4.5, exact: true })
    expect(mapLeg(s({ line: 160.5 }), '99JAN01AAABBB', (e) => rungs.get(e)).why).toMatch(/no Kalshi rung/)
    expect(mapLeg(s({ player: 'Nobody Here' }), '99JAN01AAABBB', (e) => rungs.get(e)).why).toMatch(/has no pass_yds market/)
    expect(mapLeg(s({ stat: 'longest_rec' }), '99JAN01AAABBB', (e) => rungs.get(e)).why).toMatch(/Kalshi lists no/)
    expect(kalshiGameCode('KXNFLGAME-99JAN01AAABBB-AAA')).toBe('99JAN01AAABBB')
  })
})

describe('ranking and limits', () => {
  const ranked = (key: string, players: string[], edgePp: number): Ranked => ({
    slip: { key, name: key, chance: 0.4, legs: players.map((p) => ({ player: p, stat: 'pass_yds', side: 'OVER' as const, line: 200, gameId: 'g', pSide: 0.6, team: null })) },
    legs: [] as MappedLeg[], legsPriceC: 40 - edgePp, edgePp
  })

  it('best edge first, only positive ones, one combo a day per player, up to the cap', () => {
    const picks = rankSlips([ranked('a', ['Ann Ash', 'Bo Birch'], 3), ranked('b', ['Ann Ash', 'Cy Cedar'], 8), ranked('c', ['Di Dogwood', 'Ed Elm'], 5), ranked('d', ['Fay Fir', 'Gus Gum'], -1), ranked('e', ['Hal Hazel', 'Ida Ivy'], 2)], { max: 2, boughtKeys: new Set(), usedPlayers: new Set() })
    expect(picks.map((p) => p.slip.key)).toEqual(['b', 'c'])
    expect(rankSlips([ranked('c', ['Di Dogwood', 'Ed Elm'], 5)], { max: 5, boughtKeys: new Set(), usedPlayers: new Set([nameKey('Di Dogwood')]) })).toEqual([])
  })

  it('the starter buys the API slips before kickoff, five a day, a flat $5', () => {
    const b = BotSettings.parse(STARTERS.find((s) => s.key === 'nfl-slips')!.build())
    expect(b).toMatchObject({ market: { sports: ['NFL'], lanes: ['COMBO'], phase: 'pregame' }, combo: { source: 'api', maxPerDay: 5 }, size: { sizing: 'flat', maxTradeUsd: 5 } })
  })
})
