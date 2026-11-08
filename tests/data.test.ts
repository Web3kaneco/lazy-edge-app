import { constants, generateKeyPairSync, verify } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { hotPlayContract, kalshiRung, mlbEdges, nbaLiveEdges, nbaSpreadLadder, nflBoardRows, nflHotPlays, nflMarketMaps, parseNbaClock, parseNflClock } from '../src/main/data/normalize'
import { resolveSide } from '../src/main/rules/side'
import { kalshiAsk, kalshiBalance, kalshiHeaders } from '../src/main/venues/kalshi'

describe('Kalshi balance', () => {
  it('reads integer cents, the shape the Python engine reads', () => {
    expect(kalshiBalance({ balance: 12345, portfolio_value: 500 })).toEqual({ usd: 123.45, equity: 128.45 })
  })
  it('reads dollar strings', () => {
    expect(kalshiBalance({ balance_dollars: '123.4500', portfolio_value_dollars: '5.0000' })).toEqual({ usd: 123.45, equity: 128.45 })
  })
  it('a zero balance is a balance, not a missing one', () => {
    expect(kalshiBalance({ balance: 0 })).toEqual({ usd: 0, equity: 0 })
  })
  it('no balance field is null', () => {
    expect(kalshiBalance({ something_else: 1 })).toBeNull()
  })
})

describe('Kalshi request signing', () => {
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 })
  const h = kalshiHeaders(privateKey, 'key-123', 'GET', '/trade-api/v2/portfolio/balance?exchange_index=3', 1_766_000_000_123)

  it('signs timestamp + method + path without the query, RSA-PSS with digest length salt', () => {
    const ok = verify('sha256', Buffer.from('1766000000123GET/trade-api/v2/portfolio/balance'), {
      key: publicKey, padding: constants.RSA_PKCS1_PSS_PADDING, saltLength: constants.RSA_PSS_SALTLEN_DIGEST
    }, Buffer.from(h['KALSHI-ACCESS-SIGNATURE']!, 'base64'))
    expect(ok).toBe(true)
  })

  it('sends the timestamp in milliseconds and the key id', () => {
    expect(h['KALSHI-ACCESS-TIMESTAMP']).toBe('1766000000123')
    expect(h['KALSHI-ACCESS-KEY']).toBe('key-123')
  })

  it('signs Ed25519 keys, Kalshi\'s default, directly over the same message', () => {
    const ed = generateKeyPairSync('ed25519')
    const eh = kalshiHeaders(ed.privateKey, 'key-123', 'GET', '/trade-api/v2/portfolio/balance?exchange_index=3', 1_766_000_000_123)
    const sig = Buffer.from(eh['KALSHI-ACCESS-SIGNATURE']!, 'base64')
    expect(sig.length).toBe(64)
    expect(verify(null, Buffer.from('1766000000123GET/trade-api/v2/portfolio/balance'), ed.publicKey, sig)).toBe(true)
  })

  it('refuses a key that is neither type, by name', () => {
    const ec = generateKeyPairSync('ec', { namedCurve: 'prime256v1' })
    expect(() => kalshiHeaders(ec.privateKey, 'k', 'GET', '/x', 1)).toThrow(/Ed25519 or RSA; this private key is ec/)
  })

  it('a signature over the query string would not verify', () => {
    const withQuery = verify('sha256', Buffer.from('1766000000123GET/trade-api/v2/portfolio/balance?exchange_index=3'), {
      key: publicKey, padding: constants.RSA_PKCS1_PSS_PADDING, saltLength: constants.RSA_PSS_SALTLEN_DIGEST
    }, Buffer.from(h['KALSHI-ACCESS-SIGNATURE']!, 'base64'))
    expect(withQuery).toBe(false)
  })
})

const NOW = Date.UTC(2026, 9, 25, 18, 0, 0)

describe('Kalshi orderbook', () => {
  // A made up book in the live shape (never record real Kalshi data into the
  // repo). Bids only: the YES ask is 1 minus the best NO bid, and the reverse.
  const book = {
    orderbook_fp: {
      yes_dollars: [['0.0100', '2500000.00'], ['0.4300', '350.25'], ['0.4400', '40.00']],
      no_dollars: [['0.0100', '2800000.00'], ['0.5400', '110.50'], ['0.5500', '675.75']]
    }
  }

  it('reads the ask on both sides from the opposite bids', () => {
    expect(kalshiAsk(book, 'yes')).toMatchObject({ ask: 0.45, askSize: 675.75 })
    expect(kalshiAsk(book, 'no')).toMatchObject({ ask: 0.56, askSize: 40 })
  })

  it('reads the older integer cent shape the same way', () => {
    const old = { orderbook: { yes: [[43, 349], [44, 43]], no: [[54, 110], [55, 675]] } }
    expect(kalshiAsk(old, 'yes').ask).toBe(0.45)
    expect(kalshiAsk(old, 'no').ask).toBe(0.56)
  })

  it('an empty book has no ask, never a guessed one', () => {
    expect(kalshiAsk({ orderbook_fp: { yes_dollars: [], no_dollars: [] } }, 'yes').ask).toBeNull()
  })
})

describe('NFL board rows, oriented by the publisher', () => {
  const under = {
    game_id: '2026_08_CHI_SEA', lane: 'TOTAL', basis: 'KALSHI_ASK', side: 'UNDER', ref: 'NO: CHI @ SEA over 44.5',
    line: 44.5, our_p: 0.58, market_p: 0.52, edge_pp: 6, price_c: 52, label: 'PRICE_GAP', rank: 1,
    ticker: 'KXNFLTOTAL-99JAN01CHISEA-44', venue: 'KALSHI', updated_at: new Date(NOW - 30_000).toISOString()
  }

  it('an UNDER row is bought as NO on the same ticker, never YES', () => {
    const [s] = nflBoardRows([under], NOW).signals
    expect(s!.quotes[0]).toMatchObject({ venue: 'kalshi', contract: under.ticker, side: 'no', ask: 0.52, priceAgeS: 30 })
    expect(resolveSide(s!)).toBe('no')
    expect(s!.ourP).toBe(0.58) // already P(under), no flip
  })

  it('ML maps to MONEYLINE and YES/NO rows carry their side', () => {
    const [s] = nflBoardRows([{ ...under, lane: 'ML', side: 'YES', ticker: 'KXNFLGAME-99JAN01CHISEA-CHI' }], NOW).signals
    expect(s!.lane).toBe('MONEYLINE')
    expect(resolveSide(s!)).toBe('yes')
  })

  it('a consensus row with no ticker is information, not an order', () => {
    const [s] = nflBoardRows([{ ...under, label: 'RATING_Q', venue: null, ticker: null }], NOW).signals
    expect(s!.quotes).toHaveLength(0)
  })

  it('refuses a contract row whose side it does not know', () => {
    const n = nflBoardRows([{ ...under, side: 'PUSH' }], NOW)
    expect(n.signals).toHaveLength(0)
    expect(n.refused[0]!.reason).toContain('PUSH')
  })

  it('a team sided consensus row with no contract is shown as information, not refused', () => {
    const n = nflBoardRows([{ ...under, lane: 'SPREAD', side: 'KC', venue: null, ticker: null, label: 'RATING_Q' }], NOW)
    expect(n.refused).toHaveLength(0)
    expect(n.signals[0]!.quotes).toHaveLength(0)
    expect(resolveSide(n.signals[0]!)).toBeNull()
  })
})

describe('NFL hot plays', () => {
  const play = (over: Record<string, unknown>) => ({
    game_id: 'g1', matchup: 'CHI @ SEA', market: 'SPREAD', side: 'AWAY', selection: 'CHI +3.5', line: 3.5,
    our_p: 0.6, market_p: 0.5, edge_pp: 10, price_age_s: 20, clock: 'Q3 4:12', qtr: 3,
    why: [{ type: 'TURNOVER', text: 'SEA turnover, 0:40 ago' }], measured: false, ...over
  })

  it('a spread AWAY is the NO side of the home margin contract', () => {
    const [s] = nflHotPlays({ plays: [play({})] }, NOW).signals
    expect(s!.explicitSide).toBe('no')
    expect(resolveSide(s!)).toBe('no')
  })

  it('a moneyline AWAY is YES on its own ticker', () => {
    const [s] = nflHotPlays({ plays: [play({ market: 'MONEYLINE' })] }, NOW).signals
    expect(resolveSide(s!)).toBe('yes')
  })

  it('carries no contract until the API publishes a ticker', () => {
    const [s] = nflHotPlays({ plays: [play({})] }, NOW).signals
    expect(s!.quotes).toHaveLength(0)
    const [t] = nflHotPlays({ plays: [play({ ticker: 'KXNFLSPREAD-X' })] }, NOW).signals
    expect(t!.quotes[0]).toMatchObject({ contract: 'KXNFLSPREAD-X', side: 'no' })
  })

  it('a game event in why counts as the trigger', () => {
    expect(nflHotPlays({ plays: [play({})] }, NOW).signals[0]!.trigger).toBe(true)
    expect(nflHotPlays({ plays: [play({ why: [] })] }, NOW).signals[0]!.trigger).toBe(false)
  })
})

describe('hot plays priced through the market map', () => {
  // SEA hosts CHI. The map holds what /v1/nfl/edges publishes from nfl_market_map.
  const ML = { kalshi_moneyline_home: 'KXNFLGAME-99JAN01CHISEA-SEA', kalshi_moneyline_away: 'KXNFLGAME-99JAN01CHISEA-CHI' }
  const TOTAL = { kalshi_total_over: 'KXNFLTOTAL-99JAN01CHISEA-44' } // 44 means over 43.5
  const SEA_FAV = { kalshi_spread_home: 'KXNFLSPREAD-99JAN01CHISEA-SEA3' } // SEA wins by more than 2.5
  const CHI_FAV = { kalshi_spread_away: 'KXNFLSPREAD-99JAN01CHISEA-CHI3' } // CHI wins by more than 2.5

  it('reads the rung the way the server does: digits minus 0.5', () => {
    expect(kalshiRung(SEA_FAV.kalshi_spread_home)).toBe(2.5)
    expect(kalshiRung(TOTAL.kalshi_total_over)).toBe(43.5)
    expect(kalshiRung('KXNFLGAME-99JAN01CHISEA-SEA')).toBeNull()
  })

  it('moneyline sides are YES on their own tickers', () => {
    expect(hotPlayContract('MONEYLINE', 'HOME', null, ML)).toEqual({ contract: ML.kalshi_moneyline_home, side: 'yes' })
    expect(hotPlayContract('MONEYLINE', 'AWAY', null, ML)).toEqual({ contract: ML.kalshi_moneyline_away, side: 'yes' })
  })

  it('a total UNDER is NO on the strike, and only on the play\'s own rung', () => {
    expect(hotPlayContract('TOTAL', 'UNDER', 43.5, TOTAL)).toEqual({ contract: TOTAL.kalshi_total_over, side: 'no' })
    expect(hotPlayContract('TOTAL', 'OVER', 43.5, TOTAL)).toEqual({ contract: TOTAL.kalshi_total_over, side: 'yes' })
    expect(hotPlayContract('TOTAL', 'OVER', 44.5, TOTAL)).toHaveProperty('refuse')
  })

  it('home favourite: SEA -2.5 is YES on "SEA by more than 2.5", CHI +2.5 is NO', () => {
    expect(hotPlayContract('SPREAD', 'HOME', -2.5, SEA_FAV)).toEqual({ contract: SEA_FAV.kalshi_spread_home, side: 'yes' })
    expect(hotPlayContract('SPREAD', 'AWAY', 2.5, SEA_FAV)).toEqual({ contract: SEA_FAV.kalshi_spread_home, side: 'no' })
  })

  it('away favourite: CHI -2.5 is YES on "CHI by more than 2.5", SEA +2.5 is NO', () => {
    expect(hotPlayContract('SPREAD', 'AWAY', -2.5, CHI_FAV)).toEqual({ contract: CHI_FAV.kalshi_spread_away, side: 'yes' })
    expect(hotPlayContract('SPREAD', 'HOME', 2.5, CHI_FAV)).toEqual({ contract: CHI_FAV.kalshi_spread_away, side: 'no' })
  })

  it('a spread on a rung the map does not hold is refused, never priced on the main line', () => {
    expect(hotPlayContract('SPREAD', 'HOME', -3.5, SEA_FAV)).toHaveProperty('refuse')
    expect(hotPlayContract('SPREAD', 'AWAY', -3.5, CHI_FAV)).toHaveProperty('refuse')
  })

  it('a game missing from the map is refused', () => {
    expect(hotPlayContract('MONEYLINE', 'HOME', null, undefined)).toEqual({ refuse: 'game not in the market map' })
  })

  it('end to end, an away favourite spread play becomes a NO quote the side table accepts', () => {
    const maps = nflMarketMaps([{ game_id: 'g1', ...ML, ...CHI_FAV }])
    const n = nflHotPlays({ plays: [{
      game_id: 'g1', matchup: 'CHI @ SEA', market: 'SPREAD', side: 'HOME', selection: 'SEA +2.5', line: 2.5,
      our_p: 0.6, market_p: 0.5, edge_pp: 10, price_age_s: 20, clock: 'Q2 8:00', qtr: 2, why: [], measured: false
    }] }, NOW, maps)
    const s = n.signals[0]!
    expect(s.quotes[0]).toMatchObject({ venue: 'kalshi', contract: CHI_FAV.kalshi_spread_away, side: 'no' })
    expect(s.explicitSide).toBe('no')
    expect(resolveSide(s)).toBe('no')
    expect(n.refused).toHaveLength(0)
  })

  it('a refused match still shows the play, with the reason counted', () => {
    const n = nflHotPlays({ plays: [{ game_id: 'g1', market: 'TOTAL', side: 'OVER', line: 47.5, our_p: 0.6, clock: 'Q1 10:00' }] }, NOW, nflMarketMaps([{ game_id: 'g1', ...TOTAL }]))
    expect(n.signals[0]!.quotes).toHaveLength(0)
    expect(n.refused[0]!.reason).toContain('rung')
  })
})

describe('NFL clock', () => {
  it('converts quarter time to game seconds left', () => {
    expect(parseNflClock('Q3 4:12', 3)).toEqual({ period: 3, secondsRemaining: 900 + 252, overtime: false })
    expect(parseNflClock('Q4 1:05', 4)).toEqual({ period: 4, secondsRemaining: 65, overtime: false })
  })

  it('knows overtime', () => {
    expect(parseNflClock('OT', 5)!.overtime).toBe(true)
  })

  it('a quarter with no clock has unknown seconds, which the gates refuse', () => {
    expect(parseNflClock('Q4', 4)!.secondsRemaining).toBeNull()
  })
})

describe('MLB, MLBEdgeResponse field names', () => {
  const game = {
    game_pk: 7, home_team: 'TB', away_team: 'MIL', signal: 'NO_EDGE', best_edge_pp: 0, p_home_win: 0.4,
    kalshi_implied_pct: 45, kalshi_home_ticker: 'KXMLBGAME-99JAN011900MILTB-TB', kalshi_away_ticker: 'KXMLBGAME-99JAN011900MILTB-MIL',
    total_pick: '', main_line: 7.5, our_p_over: 0.6, market_p_over: 0.52, total_edge_pp: 8, total_seam: true,
    total_line_ok: true, kalshi_totals_ticker: 'KXMLBTOTAL-99JAN011900MILTB-8', sp_tbd: false
  }

  it('refuses a moneyline row with no model probability rather than guessing one', () => {
    const n = mlbEdges([{ ...game, signal: 'BUY_HOME', p_home_win: 0 }], NOW)
    expect(n.signals).toHaveLength(0)
    expect(n.refused[0]!.reason).toContain('no model probability')
  })

  it('prices the away side with the away probability, Kalshi only', () => {
    const [s] = mlbEdges([{ ...game, signal: 'BUY_AWAY', best_edge_pp: 6 }], NOW).signals
    expect(s!.ourP).toBeCloseTo(0.6)
    expect(s!.marketP).toBeCloseTo(0.55)
    expect(s!.quotes).toEqual([expect.objectContaining({ venue: 'kalshi', contract: game.kalshi_away_ticker, side: 'yes' })])
  })

  it('reads "UNDER 7.5" and buys NO on the 7.5 strike', () => {
    const [s] = mlbEdges([{ ...game, total_pick: 'UNDER 7.5' }], NOW).signals
    expect(s!.lane).toBe('TOTAL')
    expect(s!.quotes[0]).toMatchObject({ contract: game.kalshi_totals_ticker, side: 'no' })
    expect(s!.ourP).toBeCloseTo(0.4)
    expect(resolveSide(s!)).toBe('no')
  })

  it('refuses a total whose ticker strike is not the main line', () => {
    const n = mlbEdges([{ ...game, total_pick: 'OVER 7.5', kalshi_totals_ticker: 'KXMLBTOTAL-99JAN011900MILTB-9' }], NOW)
    expect(n.signals).toHaveLength(0)
    expect(n.refused[0]!.reason).toContain('rung')
  })

  it('refuses a total the books have not confirmed', () => {
    const n = mlbEdges([{ ...game, total_pick: 'OVER 7.5', total_line_ok: false }], NOW)
    expect(n.signals).toHaveLength(0)
  })
})

describe('NBA, LiveEdgeResponse', () => {
  const row = {
    game_id: '0022600123', home_team: 'LAC', away_team: 'LAL', period: 3, clock: '5:32', home_score: 70, away_score: 66,
    trade_signal: 'BUY', target_side: 'YES', target_kalshi_ticker: 'KXNBAGAME-99JAN01LALLAC-LAC',
    our_prob: 0.62, edge_score: 0.07, kelly: 0.1, kalshi_implied: 0.55, momentum_state: 'NEUTRAL',
    signal_stale: false, signal_age_s: 20
  }

  it('BUY is YES on the home ticker at the home probability', () => {
    const [s] = nbaLiveEdges([row], NOW).signals
    expect(s!.quotes[0]).toMatchObject({ venue: 'kalshi', contract: row.target_kalshi_ticker, side: 'yes' })
    expect(s!.ourP).toBeCloseTo(0.62)
    expect(s!.edgePp).toBeCloseTo(7)
    expect(resolveSide(s!)).toBe('yes')
  })

  it('SELL is YES on the away ticker at the away probability', () => {
    const [s] = nbaLiveEdges([{ ...row, trade_signal: 'SELL', target_kalshi_ticker: 'KXNBAGAME-99JAN01LALLAC-LAL', our_prob: 0.4, edge_score: -0.06 }], NOW).signals
    expect(s!.quotes[0]!.contract).toContain('-LAL')
    expect(s!.ourP).toBeCloseTo(0.6)
    expect(s!.edgePp).toBeCloseTo(6)
  })

  it('refuses a stale or old signal, the 2026-05-26 postmortem', () => {
    expect(nbaLiveEdges([{ ...row, signal_stale: true }], NOW).signals).toHaveLength(0)
    expect(nbaLiveEdges([{ ...row, signal_age_s: 600 }], NOW).signals).toHaveLength(0)
  })

  it('HOLD is not a signal', () => {
    expect(nbaLiveEdges([{ ...row, trade_signal: 'HOLD' }], NOW)).toEqual({ signals: [], refused: [] })
  })

  describe('spread ladder', () => {
    // Made up ticker in Kalshi's spread rule: KXNBASPREAD-99JAN01PHIIND-PHI8 is "Philadelphia wins by over 7.5".
    const live = { ...row, home_team: 'IND', away_team: 'PHI' }
    const rung = (over: Record<string, unknown>) => ({
      ticker: 'KXNBASPREAD-99JAN01PHIIND-PHI8', team: 'PHI', line: 7.5, model_prob: 0.42,
      market_bid: 0.34, market_ask: 0.36, market_price: 0.35, edge: 0.07, side: 'COVER',
      depth_at_ask: 200, best_edge: true, venue: 'kalshi', ...over
    })

    it('COVER is YES on the rung at the model probability', () => {
      const [s] = nbaSpreadLadder(live, [rung({})], NOW).signals
      expect(s!.quotes[0]).toMatchObject({ contract: 'KXNBASPREAD-99JAN01PHIIND-PHI8', side: 'yes' })
      expect(s!.ourP).toBeCloseTo(0.42)
      expect(s!.label).toBe('PRICE_GAP')
      expect(resolveSide(s!)).toBe('yes')
    })

    it('NOT_COVER is NO on the same rung at one minus the model probability', () => {
      const [s] = nbaSpreadLadder(live, [rung({ model_prob: 0.28, edge: -0.07, side: 'NOT_COVER' })], NOW).signals
      expect(s!.quotes[0]!.side).toBe('no')
      expect(s!.ourP).toBeCloseTo(0.72)
      expect(resolveSide(s!)).toBe('no')
    })

    it('only the best_edge rung is a normal play; the rest are tail rungs', () => {
      const [s] = nbaSpreadLadder(live, [rung({ best_edge: false })], NOW).signals
      expect(s!.label).toBe('TAIL_RUNG')
    })

    it('refuses a rung priced for a different line than its ticker pays on (the server reads PHI8 as 8.5 today)', () => {
      const n = nbaSpreadLadder(live, [rung({ line: 8.5 })], NOW)
      expect(n.signals).toHaveLength(0)
      expect(n.refused[0]!.reason).toContain('ticker rung 7.5')
    })

    it('a stale game prices no spreads', () => {
      const n = nbaSpreadLadder({ ...live, signal_stale: true }, [rung({})], NOW)
      expect(n.signals).toHaveLength(0)
      expect(n.refused[0]!.reason).toContain('stale')
    })

    it('takes the clock from the live row', () => {
      expect(nbaSpreadLadder(live, [rung({})], NOW).signals[0]!.clock!.secondsRemaining).toBe(720 + 332)
    })
  })

  it('reads the clock in twelve minute quarters, overtime after the fourth', () => {
    expect(parseNbaClock('5:32', 3)).toEqual({ period: 3, secondsRemaining: 720 + 332, overtime: false })
    expect(parseNbaClock('1:05.3', 4)!.secondsRemaining).toBe(65)
    expect(parseNbaClock('3:00', 5)!.overtime).toBe(true)
    expect(parseNbaClock('', 0)).toBeNull()
  })
})
