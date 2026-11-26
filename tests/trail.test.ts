import { describe, expect, it } from 'vitest'
import { PlayTrail, moveSince } from '../src/main/bots/trail'
import { epochMs, nbaProps } from '../src/main/data/normalize'
import { playTags, type Signal } from '../src/shared/signal'
import { trailWords } from '../src/shared/trail'

// Made up: Player One under 5.5 points on Kalshi's NO side.
const under = (askC: number, soFar = 2, extra: Partial<NonNullable<Signal['prop']>> = {}): Signal => ({
  key: 'nba:g1:PROP:KXNBAPTS-99JAN01AAABBB-AAAPONE-6', sport: 'NBA', lane: 'PROP', phase: 'live', gameId: 'g1', title: 'AAA @ BBB Player One under 5.5',
  signalType: 'BUY_UNDER', explicitSide: 'no', ourP: 0.75, marketP: 0.7, edgePp: 75 - askC, label: 'PRICE_GAP', kelly: null, trigger: false, measured: false,
  clock: { period: 3, secondsRemaining: 1200, overtime: false },
  quotes: [{ venue: 'kalshi', contract: 'KXNBAPTS-99JAN01AAABBB-AAAPONE-6', side: 'no', ask: askC / 100, askSize: 50, priceAgeS: 0 }],
  prop: { line: 5.5, soFar, over: false, teamLead: null, rank: 2, ...extra }, why: null, receivedAt: 0
})

describe('what happened just before a play (2026-11-24, recorded only)', () => {
  it('reads the move over a minute and two from the readings it kept', () => {
    const list = [{ at: 0, askC: 70 }, { at: 60_000, askC: 66 }, { at: 105_000, askC: 64 }]
    expect(moveSince(list, 62, 120_000, 60)).toBe(-4) // the reading 60s back was 66c
    expect(moveSince(list, 62, 120_000, 120)).toBe(-8)
    expect(moveSince(list, 62, 30_000, 60)).toBeNull() // nothing a minute old yet
    expect(moveSince([{ at: 0, askC: 70 }], 62, 300_000, 60)).toBeNull() // too far back to call it a minute
  })

  it('tracks Kalshi, the edge age and the count across cycles', () => {
    const t = new PlayTrail()
    t.noteCounts([under(70)], 0)
    expect(t.read(under(70), 0)).toMatchObject({ move60C: null, edgeAgeS: 0, countSameS: 0, countChanged: false })
    for (const at of [15_000, 30_000, 45_000]) { t.noteCounts([under(68)], at); t.read(under(68), at) }
    t.noteCounts([under(64, 4)], 60_000) // he scored, and Kalshi made the under cheaper
    expect(t.read(under(64, 4), 60_000)).toMatchObject({ move60C: -6, edgeAgeS: 60, countSameS: 0, countChanged: true })
    t.noteCounts([under(64, 4)], 90_000)
    expect(t.read(under(64, 4), 90_000)).toMatchObject({ move60C: -4, countSameS: 30, countChanged: true })
  })

  it('starts the edge age again when the edge goes or the side flips', () => {
    const t = new PlayTrail()
    t.read(under(70), 0)
    expect(t.read(under(70), 15_000).edgeAgeS).toBe(15)
    expect(t.read(under(80), 30_000).edgeAgeS).toBeNull() // ask above our 75%: no edge
    expect(t.read(under(70), 45_000).edgeAgeS).toBe(0)
    const flipped = { ...under(70), prop: { ...under(70).prop!, over: true }, quotes: [{ ...under(70).quotes[0]!, side: 'yes' as const }] }
    expect(t.read(flipped, 60_000).edgeAgeS).toBe(0)
  })

  it('reports the feed times it was given, and goes on the ticket and the skip', () => {
    const t = new PlayTrail()
    const s = under(70, 2, { statsAt: 100_000 - 12_000, pricedAt: 100_000 - 20_000, liveModel: 'c2', minutes: 24.4 })
    const trail = t.read(s, 100_000)
    expect(trail).toMatchObject({ statsAgeS: 12, pricedAgeS: 20, liveModel: 'c2', minutes: 24.4 })
    expect(playTags({ ...s, trail }).trail).toEqual(trail)
    expect(trailWords(trail)).toBe('edge 0s old; stats 12s old; chance 20s old (c2); 24 min played')
  })

  it('says the move in plain words', () => {
    expect(trailWords({ move60C: 4, move120C: -2, edgeAgeS: 95, countSameS: 40, countChanged: true, statsAgeS: null, pricedAgeS: null, liveModel: null, minutes: null }))
      .toBe('Kalshi 4c dearer over the last minute, 2c cheaper over two; edge 95s old; count changed 40s ago')
    expect(trailWords(undefined)).toBeNull()
  })
})

describe('the props feed times (API, 2026-11-24)', () => {
  it('reads ISO text and epoch seconds or ms', () => {
    expect(epochMs('2026-11-24T23:00:00Z')).toBe(Date.parse('2026-11-24T23:00:00Z'))
    expect(epochMs(1795600000)).toBe(1795600000000)
    expect(epochMs('1795600000000')).toBe(1795600000000)
    expect(epochMs('soon')).toBeNull()
    expect(epochMs(null)).toBeNull()
  })

  it('carries updated_at, c2_priced_at, live_model and minutes_played on a live prop', () => {
    const body = [{
      game_id: 'g9', home_team: 'BBB', away_team: 'AAA', period: 3, clock: '6:00', is_pregame: false,
      players: [{
        player_name: 'Player One', team: 'AAA', availability: 'ACTIVE', market_line: 24.5, pts_market_id: 'KXNBAPTS-99JAN01AAABBB-AAAPONE-25', pts_venue: 'kalshi',
        likelihood_over: 0.78, current_points: 14, updated_at: '2026-11-24T23:00:00Z', c2_priced_at: '2026-11-24T22:59:50Z', live_model: 'c2', minutes_played: 22.5
      }]
    }]
    expect(nbaProps(body, 0).signals[0]!.prop).toMatchObject({
      statsAt: Date.parse('2026-11-24T23:00:00Z'), pricedAt: Date.parse('2026-11-24T22:59:50Z'), liveModel: 'c2', minutes: 22.5
    })
  })
})
