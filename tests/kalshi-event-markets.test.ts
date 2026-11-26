import { describe, expect, it } from 'vitest'
import { eventMarketList } from '../src/main/data/nflkalshi'
import { kalshiRungs, mapLeg, type SlipLeg } from '../src/shared/nflcombos'

// Kalshi's real answer for KXNFLREC-26NOV23CINWAS (23 November 2026), cut to
// three of Chig Okonkwo's rungs: an empty list at the top, the markets inside
// the event. The app took the empty list, so all day every NFL slip leg and
// every live NFL prop read "has no market on Kalshi".
const okonkwo = (n: number) => ({ ticker: `KXNFLREC-26NOV23CINWAS-WASCOKONKWO85-${n}`, yes_sub_title: `Chig Okonkwo: ${n}+`, floor_strike: n - 0.5, strike_type: 'greater' })
const REC = { event: { event_ticker: 'KXNFLREC-26NOV23CINWAS', markets: [okonkwo(4), okonkwo(5), okonkwo(6)] }, markets: [] }
const daniels = (n: number) => ({ ticker: `KXNFLPASSYDS-26NOV23CINWAS-WASJDANIELS5-${n}`, yes_sub_title: `Jayden Daniels: ${n}+`, floor_strike: n - 0.5, strike_type: 'greater' })
const PASS = { event: { markets: [daniels(200), daniels(225), daniels(250)] }, markets: [] }

const leg = (player: string, stat: string, side: 'OVER' | 'UNDER', line: number): SlipLeg => ({ player, stat, side, line, gameId: '2026_11_CIN_WAS', pSide: 0.6, team: 'WAS' })

describe("reading one Kalshi event's markets", () => {
  it('takes the markets inside the event, not the empty list beside it', () => {
    expect(eventMarketList(REC)).toHaveLength(3)
    expect(eventMarketList({ markets: [okonkwo(4)] })).toHaveLength(1)
    expect(eventMarketList(null)).toEqual([])
  })

  it("maps tonight's skipped slip legs to Kalshi's markets", () => {
    const rungs = new Map([
      ['KXNFLREC-26NOV23CINWAS', kalshiRungs('KXNFLREC-26NOV23CINWAS', eventMarketList(REC))],
      ['KXNFLPASSYDS-26NOV23CINWAS', kalshiRungs('KXNFLPASSYDS-26NOV23CINWAS', eventMarketList(PASS))]
    ])
    const under = mapLeg(leg('Chig Okonkwo', 'receptions', 'UNDER', 4.5), '26NOV23CINWAS', (e) => rungs.get(e))
    expect(under.leg).toMatchObject({ contract: 'KXNFLREC-26NOV23CINWAS-WASCOKONKWO85-5', side: 'no' })
    const over = mapLeg(leg('Jayden Daniels', 'pass_yds', 'OVER', 230.5), '26NOV23CINWAS', (e) => rungs.get(e))
    expect(over.leg).toMatchObject({ contract: 'KXNFLPASSYDS-26NOV23CINWAS-WASJDANIELS5-225', side: 'yes' })
  })
})

describe("each combo leg's event, from Kalshi's combo list", async () => {
  const { comboEventOf } = await import('../src/main/venues/kalshi')
  // Events from Kalshi's KXMVECROSSCATEGORY-R list on 23 November 2026.
  const listed = new Set(['KXNFLREC-26NOV23CINWAS', 'KXNFLPASSYDS-26NOV23CINWAS', 'KXNBAPTS-26NOV23MEMCHA', 'KXNBAGAME-26NOV23MEMCHA', 'KXNFLTEAMFIRSTTD-26NOV23CINWAS-CIN'])

  it('a player prop belongs to the game event, not a player event', () => {
    expect(comboEventOf('KXNFLREC-26NOV23CINWAS-WASCOKONKWO85-5', listed)).toBe('KXNFLREC-26NOV23CINWAS')
    expect(comboEventOf('KXNBAPTS-26NOV23MEMCHA-CHACWHITE3-20', listed)).toBe('KXNBAPTS-26NOV23MEMCHA')
  })

  it('a game market and a three part event still match', () => {
    expect(comboEventOf('KXNBAGAME-26NOV23MEMCHA-MEM', listed)).toBe('KXNBAGAME-26NOV23MEMCHA')
    expect(comboEventOf('KXNFLTEAMFIRSTTD-26NOV23CINWAS-CIN-YES', listed)).toBe('KXNFLTEAMFIRSTTD-26NOV23CINWAS-CIN')
  })

  it('a market in no listed event has none', () => {
    expect(comboEventOf('KXNHLGAME-26NOV23AAABBB-AAA', listed)).toBeNull()
  })
})
