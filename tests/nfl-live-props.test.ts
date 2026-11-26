import { describe, expect, it } from 'vitest'
import { mapNflHotProps, nflHotPropLeg, nflPropEvents } from '../src/main/data/nflkalshi'
import { nflHotPlays } from '../src/main/data/normalize'
import { kalshiRungs } from '../src/shared/nflcombos'

// Kalshi's receptions markets for Bengals at Commanders, 23 November 2026, as
// its events endpoint lists them (Stefon Diggs and Ja'Marr Chase only).
const MARKETS = [{"ticker": "KXNFLREC-26NOV23CINWAS-WASSDIGGS3-2", "yes_sub_title": "Stefon Diggs: 2+", "floor_strike": 1.5, "strike_type": "greater"}, {"ticker": "KXNFLREC-26NOV23CINWAS-WASSDIGGS3-3", "yes_sub_title": "Stefon Diggs: 3+", "floor_strike": 2.5, "strike_type": "greater"}, {"ticker": "KXNFLREC-26NOV23CINWAS-WASSDIGGS3-4", "yes_sub_title": "Stefon Diggs: 4+", "floor_strike": 3.5, "strike_type": "greater"}, {"ticker": "KXNFLREC-26NOV23CINWAS-WASSDIGGS3-5", "yes_sub_title": "Stefon Diggs: 5+", "floor_strike": 4.5, "strike_type": "greater"}, {"ticker": "KXNFLREC-26NOV23CINWAS-WASSDIGGS3-6", "yes_sub_title": "Stefon Diggs: 6+", "floor_strike": 5.5, "strike_type": "greater"}, {"ticker": "KXNFLREC-26NOV23CINWAS-WASSDIGGS3-7", "yes_sub_title": "Stefon Diggs: 7+", "floor_strike": 6.5, "strike_type": "greater"}, {"ticker": "KXNFLREC-26NOV23CINWAS-WASSDIGGS3-8", "yes_sub_title": "Stefon Diggs: 8+", "floor_strike": 7.5, "strike_type": "greater"}, {"ticker": "KXNFLREC-26NOV23CINWAS-WASSDIGGS3-9", "yes_sub_title": "Stefon Diggs: 9+", "floor_strike": 8.5, "strike_type": "greater"}, {"ticker": "KXNFLREC-26NOV23CINWAS-WASSDIGGS3-10", "yes_sub_title": "Stefon Diggs: 10+", "floor_strike": 9.5, "strike_type": "greater"}, {"ticker": "KXNFLREC-26NOV23CINWAS-CINJCHASE1-5", "yes_sub_title": "Ja'Marr Chase: 5+", "floor_strike": 4.5, "strike_type": "greater"}, {"ticker": "KXNFLREC-26NOV23CINWAS-CINJCHASE1-6", "yes_sub_title": "Ja'Marr Chase: 6+", "floor_strike": 5.5, "strike_type": "greater"}, {"ticker": "KXNFLREC-26NOV23CINWAS-CINJCHASE1-7", "yes_sub_title": "Ja'Marr Chase: 7+", "floor_strike": 6.5, "strike_type": "greater"}, {"ticker": "KXNFLREC-26NOV23CINWAS-CINJCHASE1-8", "yes_sub_title": "Ja'Marr Chase: 8+", "floor_strike": 7.5, "strike_type": "greater"}, {"ticker": "KXNFLREC-26NOV23CINWAS-CINJCHASE1-9", "yes_sub_title": "Ja'Marr Chase: 9+", "floor_strike": 8.5, "strike_type": "greater"}, {"ticker": "KXNFLREC-26NOV23CINWAS-CINJCHASE1-10", "yes_sub_title": "Ja'Marr Chase: 10+", "floor_strike": 9.5, "strike_type": "greater"}, {"ticker": "KXNFLREC-26NOV23CINWAS-CINJCHASE1-11", "yes_sub_title": "Ja'Marr Chase: 11+", "floor_strike": 10.5, "strike_type": "greater"}, {"ticker": "KXNFLREC-26NOV23CINWAS-CINJCHASE1-12", "yes_sub_title": "Ja'Marr Chase: 12+", "floor_strike": 11.5, "strike_type": "greater"}, {"ticker": "KXNFLREC-26NOV23CINWAS-CINJCHASE1-13", "yes_sub_title": "Ja'Marr Chase: 13+", "floor_strike": 12.5, "strike_type": "greater"}, {"ticker": "KXNFLREC-26NOV23CINWAS-CINJCHASE1-14", "yes_sub_title": "Ja'Marr Chase: 14+", "floor_strike": 13.5, "strike_type": "greater"}, {"ticker": "KXNFLREC-26NOV23CINWAS-CINJCHASE1-15", "yes_sub_title": "Ja'Marr Chase: 15+", "floor_strike": 14.5, "strike_type": "greater"}, {"ticker": "KXNFLREC-26NOV23CINWAS-CINJCHASE1-16", "yes_sub_title": "Ja'Marr Chase: 16+", "floor_strike": 15.5, "strike_type": "greater"}]
const EVENT = 'KXNFLREC-26NOV23CINWAS'
const MAPS = { '2026_11_CIN_WAS': { kalshi_moneyline_home: 'KXNFLGAME-26NOV23CINWAS-WAS', kalshi_moneyline_away: 'KXNFLGAME-26NOV23CINWAS-CIN' } }
const play = (over: Record<string, unknown>) => ({ game_id: '2026_11_CIN_WAS', market: 'PROP', stat: 'receptions', player: 'Stefon Diggs', side: 'OVER', line: 3.5, our_p: 0.62, market_p: 0.5, clock: 'Q2 6:00', matchup: 'CIN @ WAS', why: [], ...over })
const run = (plays: Record<string, unknown>[]) => {
  const body = { plays }
  const n = nflHotPlays(body, 0, MAPS)
  const matched = mapNflHotProps(body, n, MAPS, new Map([[EVENT, kalshiRungs(EVENT, MARKETS)]]))
  return { n, matched }
}

describe('live NFL player props matched to Kalshi', () => {
  it('reads the leg and the Kalshi event it needs', () => {
    expect(nflHotPropLeg(play({}))).toMatchObject({ player: 'Stefon Diggs', stat: 'receptions', side: 'OVER', line: 3.5, pSide: 0.62 })
    expect(nflPropEvents({ plays: [play({})] }, MAPS)).toEqual([EVENT])
  })

  it('an over at the API line buys YES on that exact rung', () => {
    const { n, matched } = run([play({})])
    expect(matched).toBe(1)
    expect(n.signals[0]!.quotes[0]).toMatchObject({ venue: 'kalshi', contract: 'KXNFLREC-26NOV23CINWAS-WASSDIGGS3-4', side: 'yes' })
    expect(n.signals[0]!.prop).toMatchObject({ line: 3.5, over: true })
    expect(n.signals[0]!.why).toContain("at the API's line")
  })

  it('an under buys NO on the rung at or above the line, never a harder one', () => {
    const { n } = run([play({ side: 'UNDER', line: 4.5, our_p: 0.55 })])
    expect(n.signals[0]!.quotes[0]).toMatchObject({ contract: 'KXNFLREC-26NOV23CINWAS-WASSDIGGS3-5', side: 'no' })
    expect(n.signals[0]!.explicitSide).toBe('no')
  })

  it('a player Kalshi does not list keeps no contract and says why', () => {
    const { n, matched } = run([play({ player: 'Nobody Real' })])
    expect(matched).toBe(0)
    expect(n.signals[0]!.quotes).toEqual([])
    expect(n.refused.map((r) => r.reason)).toContain('Nobody Real has no receptions market on Kalshi')
  })

  it('a game with no Kalshi moneyline match has no event to read', () => {
    expect(nflPropEvents({ plays: [play({ game_id: '2026_11_KC_BUF' })] }, MAPS)).toEqual([])
  })
})
