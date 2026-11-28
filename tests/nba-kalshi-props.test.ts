import { describe, expect, it } from 'vitest'
import { mapNbaProps, nbaGameCodes, nbaPropEvents } from '../src/main/data/nbakalshi'
import { nbaProps } from '../src/main/data/normalize'
import { resolveSide } from '../src/main/rules/side'
import { kalshiRungs } from '../src/shared/nflcombos'

// 2026-11-27: the API's props named Polymarket's market (or none) instead of
// Kalshi's, and no prop reached a bot on a night of eleven games. The shape
// below is that night's reply, cut down to one player.
const game = (player: Record<string, unknown>) => [{
  game_id: '401909330', home_team: 'POR', away_team: 'GS', period: 3, clock: '5:00', is_pregame: false, ladder: null,
  players: [{
    player_name: 'Deni Avdija', team: 'POR', availability: null, projection: 22, current_points: 14,
    market_line: 19.5, likelihood_over: 0.7, pts_sim_p_over: 0.6, pts_venue: 'polymarket', pts_market_id: '0xabc', pts_market_price: 0.55,
    pts_live_price: null, pts_live_edge_pp: null, reb_market_line: null, ast_market_line: null, updated_at: '2026-11-28T03:00:00Z', ...player
  }]
}]
// Kalshi's points ladder for him, as its events endpoint lists it.
const EVENT = 'KXNBAPTS-26NOV27GSWPOR'
const LADDER = [15, 20, 25].map((n) => ({ ticker: `${EVENT}-PORDAVDIJA8-${n}`, yes_sub_title: `Deni Avdija: ${n}+`, floor_strike: n - 0.5, strike_type: 'greater' }))
// The NBA game ticker another feed carries for the same game.
const ML = [{ sport: 'NBA', gameId: '401909330', quotes: [{ venue: 'kalshi', contract: 'KXNBAGAME-26NOV27GSWPOR-POR' }] }] as never

describe('NBA props matched to Kalshi when the API names another venue', () => {
  it("a Polymarket prop takes Kalshi's rung for the same player at the same line", () => {
    const n = nbaProps(game({}), 0)
    expect(n.signals).toHaveLength(1)
    expect(n.signals[0]!.quotes).toEqual([])
    // A price read off another venue's book is not used.
    expect(n.signals[0]!.marketP).toBeNull()
    const codes = nbaGameCodes(ML)
    expect(nbaPropEvents(n, codes)).toEqual([EVENT])
    expect(mapNbaProps(n, codes, new Map([[EVENT, kalshiRungs(EVENT, LADDER)]]))).toBe(1)
    const s = n.signals[0]!
    expect(s.quotes[0]).toMatchObject({ venue: 'kalshi', contract: `${EVENT}-PORDAVDIJA8-20`, side: 'yes' })
    expect(s.key).toBe(`nba:401909330:PROP:${EVENT}-PORDAVDIJA8-20`)
    expect(resolveSide(s)).toBe('yes')
  })

  it('an under is the NO side of the same rung', () => {
    const n = nbaProps(game({ likelihood_over: 0.2 }), 0)
    mapNbaProps(n, nbaGameCodes(ML), new Map([[EVENT, kalshiRungs(EVENT, LADDER)]]))
    expect(n.signals[0]!.quotes[0]).toMatchObject({ contract: `${EVENT}-PORDAVDIJA8-20`, side: 'no' })
    expect(resolveSide(n.signals[0]!)).toBe('no')
  })

  it('no Kalshi rung at the exact line, no trade, and the reason is kept', () => {
    const n = nbaProps(game({ market_line: 21.5 }), 0)
    mapNbaProps(n, nbaGameCodes(ML), new Map([[EVENT, kalshiRungs(EVENT, LADDER)]]))
    expect(n.signals).toHaveLength(0)
    expect(n.refused.map((r) => r.reason)).toContain('Kalshi lists no pts line at 21.5')
  })

  it("a prop the API gives a Kalshi contract keeps it and its price", () => {
    const n = nbaProps(game({ pts_venue: 'kalshi', pts_market_id: `${EVENT}-PORDAVDIJA8-20`, pts_live_price: 0.6, pts_live_edge_pp: 10 }), 0)
    expect(n.signals[0]!.quotes[0]).toMatchObject({ contract: `${EVENT}-PORDAVDIJA8-20` })
    expect(n.signals[0]!.marketP).toBe(0.6)
    expect(mapNbaProps(n, new Map(), new Map())).toBe(0)
    expect(n.signals).toHaveLength(1)
  })
})
