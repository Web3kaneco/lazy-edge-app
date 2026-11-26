import { describe, expect, it } from 'vitest'
import { nflBoardRows, nflInfoToKalshi, type NflMarketMap } from '../src/main/data/normalize'
import { resolveSide } from '../src/main/rules/side'

// Made up: AAA at BBB, the API's consensus row "AAA wins" with no contract.
const maps: Record<string, NflMarketMap> = { g1: { kalshi_moneyline_home: 'KXNFLGAME-99JAN01AAABBB-BBB', kalshi_moneyline_away: 'KXNFLGAME-99JAN01AAABBB-AAA', kickoff: '2099-01-01T18:00:00Z' } }
const info = (side: string, game = 'g1') => nflBoardRows([{ game_id: game, lane: 'ML', side, ref: `${side} wins`, our_p: 0.71, market_p: 0.64, edge_pp: 7, label: 'PRICE_GAP' }], 0).signals

describe('NFL consensus picks matched to Kalshi moneylines', () => {
  it('a team that matches a ticker becomes YES on that ticker', () => {
    const [s] = nflInfoToKalshi(info('AAA'), maps)
    expect(s).toMatchObject({ key: 'nfl:g1:MONEYLINE:KXNFLGAME-99JAN01AAABBB-AAA:yes', signalType: 'BUY_AWAY', explicitSide: 'yes', ourP: 0.71 })
    expect(s!.quotes).toEqual([expect.objectContaining({ venue: 'kalshi', contract: 'KXNFLGAME-99JAN01AAABBB-AAA', side: 'yes' })])
    expect(resolveSide(s!)).toBe('yes')
  })

  it('stays information when the team matches neither ticker, the game has no map, or another row prices that ticker', () => {
    expect(nflInfoToKalshi(info('ZZZ'), maps)[0]!.quotes).toEqual([])
    expect(nflInfoToKalshi(info('AAA', 'g9'), maps)[0]!.quotes).toEqual([])
    const kalshiRow = { ...nflInfoToKalshi(info('AAA'), maps)[0]! }
    const out = nflInfoToKalshi([kalshiRow, ...info('AAA')], maps)
    expect(out[1]!.quotes).toEqual([])
  })
})
