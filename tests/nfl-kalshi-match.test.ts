import { describe, expect, it } from 'vitest'
import { fillNflMoneylines, kalshiNflCode, matchNflMoneyline, nflGameTeams } from '../src/main/data/nflkalshi'
import { nflBoardRows, nflHotPlays, nflInfoToKalshi } from '../src/main/data/normalize'

// Kalshi's open NFL game markets as its list gives them (week of 23 November
// 2026), plus a made up rematch weeks later to test the date check.
const game = (event: string, a: string, h: string, settles: string) => [
  { ticker: `${event}-${h}`, event_ticker: event, expected_expiration_time: settles },
  { ticker: `${event}-${a}`, event_ticker: event, expected_expiration_time: settles }
]
const KALSHI = [
  ...game('KXNFLGAME-26NOV23CINWAS', 'CIN', 'WAS', '2026-11-24T04:15:00Z'),
  ...game('KXNFLGAME-26NOV29TENJAC', 'TEN', 'JAC', '2026-11-30T00:05:00Z'),
  ...game('KXNFLGAME-26NOV25GBLAR', 'GB', 'LAR', '2026-11-26T04:00:00Z'),
  ...game('KXNFLGAME-26NOV29NOCIN', 'NO', 'CIN', '2026-11-29T21:00:00Z'),
  ...game('KXNFLGAME-26DEC27CINWAS', 'CIN', 'WAS', '2026-12-28T04:15:00Z')
]
const KICKOFF_CIN_WAS = Date.parse('2026-11-24T01:15:00Z')

describe('NFL moneylines matched to Kalshi game markets', () => {
  it('reads the teams from the game id and spells them as Kalshi does', () => {
    expect(nflGameTeams('2026_11_CIN_WAS')).toEqual({ away: 'CIN', home: 'WAS' })
    expect(nflGameTeams('not a game')).toBeNull()
    expect(kalshiNflCode('JAX')).toBe('JAC')
    expect(kalshiNflCode('LA')).toBe('LAR')
    expect(kalshiNflCode('LAC')).toBe('LAC')
  })

  it('finds the game by its kickoff, not the rematch weeks later', () => {
    expect(matchNflMoneyline('2026_11_CIN_WAS', KICKOFF_CIN_WAS, KALSHI)).toEqual({ home: 'KXNFLGAME-26NOV23CINWAS-WAS', away: 'KXNFLGAME-26NOV23CINWAS-CIN' })
  })

  it('refuses when two open games match and no kickoff tells them apart', () => {
    expect(matchNflMoneyline('2026_11_CIN_WAS', null, KALSHI)).toEqual({ refuse: '2 open Kalshi game markets for CIN at WAS' })
  })

  it('matches Jacksonville and the Rams under their Kalshi codes', () => {
    expect(matchNflMoneyline('2026_12_TEN_JAX', null, KALSHI)).toEqual({ home: 'KXNFLGAME-26NOV29TENJAC-JAC', away: 'KXNFLGAME-26NOV29TENJAC-TEN' })
    expect(matchNflMoneyline('2026_12_GB_LA', null, KALSHI)).toEqual({ home: 'KXNFLGAME-26NOV25GBLAR-LAR', away: 'KXNFLGAME-26NOV25GBLAR-GB' })
  })

  it('never matches teams the other way round', () => {
    expect('refuse' in matchNflMoneyline('2026_11_WAS_CIN', null, KALSHI)).toBe(true)
  })

  it('keeps a ticker the API gave and only fills what is missing', () => {
    const r = fillNflMoneylines({ '2026_11_CIN_WAS': { kickoff: '2026-11-24T01:15:00Z' }, '2026_12_TEN_JAX': { kalshi_moneyline_home: 'FROM-THE-API', kalshi_moneyline_away: 'FROM-THE-API-2' } }, ['2026_11_CIN_WAS', '2026_12_TEN_JAX', '2026_12_KC_BUF'], KALSHI)
    expect(r.maps['2026_11_CIN_WAS']).toMatchObject({ kalshi_moneyline_home: 'KXNFLGAME-26NOV23CINWAS-WAS', kalshi_moneyline_away: 'KXNFLGAME-26NOV23CINWAS-CIN' })
    expect(r.maps['2026_12_TEN_JAX']!.kalshi_moneyline_home).toBe('FROM-THE-API')
    expect(r.matched).toEqual(['2026_11_CIN_WAS'])
    expect(r.refused).toEqual([{ source: 'nfl.kalshi-match', reason: 'no open Kalshi game market for KC at BUF' }])
  })

  it("turns the API's pick into a buyable play once the game is matched", () => {
    const board = nflBoardRows([{ game_id: '2026_11_CIN_WAS', lane: 'ML', side: 'WAS', ref: 'WAS wins', our_p: 0.37, market_p: 0.28, edge_pp: 9 }], 0).signals
    expect(board[0]!.quotes).toEqual([])
    const { maps } = fillNflMoneylines({ '2026_11_CIN_WAS': { kickoff: '2026-11-24T01:15:00Z' } }, ['2026_11_CIN_WAS'], KALSHI)
    const [s] = nflInfoToKalshi(board, maps)
    expect(s!.quotes[0]).toMatchObject({ venue: 'kalshi', contract: 'KXNFLGAME-26NOV23CINWAS-WAS', side: 'yes' })
    expect(s!.ourP).toBe(0.37)
  })

  it('reads a Saints pick as the Saints, not as a NO side', () => {
    const [s] = nflBoardRows([{ game_id: '2026_12_NO_CIN', lane: 'ML', side: 'NO', ref: 'NO wins', our_p: 0.55 }], 0).signals
    expect(s!.signalType).toBe('INFO_NO')
    const { maps } = fillNflMoneylines({}, ['2026_12_NO_CIN'], KALSHI)
    expect(nflInfoToKalshi([s!], maps)[0]!.quotes[0]?.contract).toBe('KXNFLGAME-26NOV29NOCIN-NO')
  })

  it('a live moneyline hot play gets its contract from the filled map', () => {
    const { maps } = fillNflMoneylines({ '2026_11_CIN_WAS': { kickoff: '2026-11-24T01:15:00Z' } }, ['2026_11_CIN_WAS'], KALSHI)
    const body = { plays: [{ game_id: '2026_11_CIN_WAS', market: 'MONEYLINE', side: 'AWAY', our_p: 0.6, market_p: 0.5, clock: 'Q2 7:00', why: [{ type: 'TOUCHDOWN', text: 'CIN touchdown' }] }] }
    expect(nflHotPlays(body, 0, maps).signals[0]!.quotes[0]).toMatchObject({ contract: 'KXNFLGAME-26NOV23CINWAS-CIN', side: 'yes' })
  })
})
