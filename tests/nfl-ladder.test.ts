import { describe, expect, it } from 'vitest'
import { mapNflHotLines, nflLadderContract, nflLadderEvents } from '../src/main/data/nflkalshi'
import { nflHotPlays } from '../src/main/data/normalize'
import { resolveSide } from '../src/main/rules/side'

// Kalshi's ladders for Bears at Lions, 26 November 2026, as its events
// endpoint lists them (a few rungs each).
const TOTALS = [46.5, 53.5, 54.5, 55.5].map((f) => ({ ticker: `KXNFLTOTAL-26NOV26CHIDET-${f + 0.5}`, floor_strike: f, strike_type: 'greater', status: 'active' }))
const SPREADS = [['CHI', 2.5], ['CHI', 3.5], ['DET', 2.5], ['DET', 3.5]].map(([t, f]) => ({ ticker: `KXNFLSPREAD-26NOV26CHIDET-${t}${(f as number) + 0.5}`, floor_strike: f, strike_type: 'greater', status: 'active' }))
const GAME = '2026_12_CHI_DET'
// The API's map names one rung per game, the pregame one nearest 50c.
const MAP = { kalshi_moneyline_home: 'KXNFLGAME-26NOV26CHIDET-DET', kalshi_moneyline_away: 'KXNFLGAME-26NOV26CHIDET-CHI', kalshi_total_over: 'KXNFLTOTAL-26NOV26CHIDET-47' }
const play = (over: Record<string, unknown>) => ({ game_id: GAME, matchup: 'CHI @ DET', market: 'TOTAL', side: 'OVER', line: 54.5, our_p: 0.6, market_p: 0.52, edge_pp: 6, clock: 'Q2 6:00', qtr: 2, why: [{ type: 'SCORE', text: 'DET touchdown' }], ...over })
const contract = (over: Record<string, unknown>, markets: unknown[]) => nflLadderContract(play(over), MAP as never, markets)

describe('NFL in game totals and spreads on Kalshi ladders', () => {
  it('a total takes the rung at its own line: over is YES, under is NO', () => {
    expect(contract({}, TOTALS)).toEqual({ contract: 'KXNFLTOTAL-26NOV26CHIDET-55', side: 'yes' })
    expect(contract({ side: 'UNDER' }, TOTALS)).toEqual({ contract: 'KXNFLTOTAL-26NOV26CHIDET-55', side: 'no' })
    expect(contract({ line: 54 }, TOTALS)).toEqual({ refuse: 'Kalshi lists no total at 54' })
  })

  it('a home favourite and its underdog side take the home rung', () => {
    const s = (side: string, line: number) => contract({ market: 'SPREAD', side, line }, SPREADS)
    expect(s('HOME', -3.5)).toEqual({ contract: 'KXNFLSPREAD-26NOV26CHIDET-DET4', side: 'yes' }) // DET -3.5: DET wins by over 3.5
    expect(s('AWAY', 3.5)).toEqual({ contract: 'KXNFLSPREAD-26NOV26CHIDET-DET4', side: 'no' }) // CHI +3.5
  })

  it('an away favourite and its underdog side take the away rung', () => {
    const s = (side: string, line: number) => contract({ market: 'SPREAD', side, line }, SPREADS)
    expect(s('AWAY', -2.5)).toEqual({ contract: 'KXNFLSPREAD-26NOV26CHIDET-CHI3', side: 'yes' }) // CHI -2.5: CHI wins by over 2.5
    expect(s('HOME', 2.5)).toEqual({ contract: 'KXNFLSPREAD-26NOV26CHIDET-CHI3', side: 'no' }) // DET +2.5
    expect(s('HOME', -6.5)).toEqual({ refuse: 'Kalshi lists no DET by over 6.5' })
  })

  it('end to end: a play off the map rung gets its contract and a side the table accepts', () => {
    const body = { plays: [play({}), play({ market: 'SPREAD', side: 'AWAY', line: -2.5, selection: 'CHI -2.5' })] }
    const maps = { [GAME]: MAP as never }
    const n = nflHotPlays(body, 0, maps)
    expect(n.signals[0]!.quotes).toHaveLength(0)
    expect(nflLadderEvents(body, maps)).toEqual(['KXNFLTOTAL-26NOV26CHIDET', 'KXNFLSPREAD-26NOV26CHIDET'])
    const matched = mapNflHotLines(body, n, maps, new Map<string, unknown[]>([['KXNFLTOTAL-26NOV26CHIDET', TOTALS], ['KXNFLSPREAD-26NOV26CHIDET', SPREADS]]))
    expect(matched).toBe(2)
    expect(n.signals[0]!.quotes[0]).toMatchObject({ contract: 'KXNFLTOTAL-26NOV26CHIDET-55', side: 'yes' })
    expect(resolveSide(n.signals[0]!)).toBe('yes')
    expect(n.signals[1]!.quotes[0]).toMatchObject({ contract: 'KXNFLSPREAD-26NOV26CHIDET-CHI3', side: 'yes' })
    expect(resolveSide(n.signals[1]!)).toBe('yes')
  })

  it('a play the market map already matched is left alone', () => {
    const body = { plays: [play({ line: 46.5 })] }
    const maps = { [GAME]: MAP as never }
    const n = nflHotPlays(body, 0, maps)
    expect(n.signals[0]!.quotes[0]).toMatchObject({ contract: 'KXNFLTOTAL-26NOV26CHIDET-47' })
    expect(mapNflHotLines(body, n, maps, new Map())).toBe(0)
  })
})
