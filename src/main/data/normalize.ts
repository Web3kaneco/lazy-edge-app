// API rows into Signals. The NFL board and hot plays mappings follow the
// publisher itself (the Lazy Edge NFL publisher and live plays endpoint):
// every row states its side, our_p and market_p are
// already oriented to that side, and price_c is the ask on that side (an UNDER
// or NO row is 100 minus the YES bid, bought as NO on the same ticker).
//
// A row that cannot be mapped is refused with a reason and counted, never
// dropped silently, so a shape change shows up on the board screen rather
// than as a slate that quietly trades nothing.
import type { Lane } from '@shared/schema'
import type { ContractSide, Signal, VenueQuote } from '@shared/signal'

export interface Normalized {
  signals: Signal[]
  refused: { source: string; reason: string }[]
}

const num = (v: unknown): number | null => {
  if (v === null || v === undefined || v === '') return null
  const n = Number(v)
  return Number.isFinite(n) ? n : null
}

const LANE: Record<string, Lane> = {
  ML: 'MONEYLINE', MONEYLINE: 'MONEYLINE', GAME: 'MONEYLINE',
  SPREAD: 'SPREAD', TOTAL: 'TOTAL', TEAM_TOTAL: 'TEAM_TOTAL', PROP: 'PROP'
}

// OVER and YES buy YES on the ticker; UNDER and NO buy NO on the same ticker.
const BOARD_SIDE: Record<string, ContractSide> = { OVER: 'yes', YES: 'yes', UNDER: 'no', NO: 'no' }

const ageFrom = (iso: unknown, now: number): number | null => {
  const t = typeof iso === 'string' ? Date.parse(iso) : NaN
  return Number.isFinite(t) ? Math.max(0, Math.round((now - t) / 1000)) : null
}

// "Q3 4:12" is in quarter time; game seconds left adds the quarters to come.
// "AWAY @ HOME" from any row that names both teams, else null.
export function matchupOf(row: any): string | null {
  return row?.away_team && row?.home_team ? `${row.away_team} @ ${row.home_team}` : null
}

export function parseNflClock(clock: unknown, qtr: unknown): Signal['clock'] {
  const s = typeof clock === 'string' ? clock.trim() : ''
  if (s === 'OT') return { period: 5, secondsRemaining: null, overtime: true }
  const m = /^Q(\d)\s+(\d+):(\d{2})$/.exec(s)
  const q = m ? Number(m[1]) : num(qtr)
  if (q === null) return null
  if (q > 4) return { period: q, secondsRemaining: null, overtime: true }
  const inQ = m ? Number(m[2]) * 60 + Number(m[3]) : null
  return { period: q, secondsRemaining: inQ === null ? null : (4 - q) * 900 + inQ, overtime: false }
}

export function nflBoardRows(rows: any[], now: number): Normalized {
  const out: Normalized = { signals: [], refused: [] }
  for (const r of rows ?? []) {
    const lane = LANE[String(r?.lane ?? '').toUpperCase()]
    const sideWord = String(r?.side ?? '').toUpperCase()
    const side = BOARD_SIDE[sideWord]
    if (!lane) { out.refused.push({ source: 'nfl.board', reason: `lane ${r?.lane}` }); continue }
    const kalshi = String(r.venue ?? '').toUpperCase() === 'KALSHI' && Boolean(r.ticker)
    if (!side) {
      // A team named as the side (IND, KC) is a book consensus row: our number
      // against the sportsbooks, with no venue contract. It is shown as
      // information. The same side on a row WITH a contract is refused,
      // because the contract's YES or NO cannot be read from a team name.
      if (kalshi) { out.refused.push({ source: 'nfl.board', reason: `side ${r?.side} on contract ${r.ticker}` }); continue }
      out.signals.push({
        key: `nfl:${r.game_id}:${lane}:info:${r.ref ?? sideWord}`,
        sport: 'NFL', lane, phase: 'pregame', gameId: String(r.game_id),
        title: String(r.ref ?? `${lane} ${sideWord}`), signalType: `INFO_${sideWord}`, explicitSide: null,
        ourP: num(r.our_p), marketP: num(r.market_p), edgePp: num(r.edge_pp),
        label: String(r.label ?? 'NONE').toUpperCase(), kelly: null, trigger: false, measured: false,
        clock: null, quotes: [], why: r.record ? `Record on this lane: ${r.record}` : null, receivedAt: now
      })
      continue
    }

    const quotes: VenueQuote[] = []
    // Only venue priced rows carry a contract. Book consensus rows (RATING_Q
    // with gap_pts and no ticker) are information, not orders.
    if (kalshi) {
      const priceC = num(r.price_c)
      quotes.push({
        venue: 'kalshi', contract: String(r.ticker), side,
        ask: priceC === null ? null : priceC / 100, askSize: null,
        priceAgeS: ageFrom(r.updated_at, now)
      })
    }

    out.signals.push({
      key: `nfl:${r.game_id}:${lane}:${r.ticker ?? r.ref}:${side}`,
      sport: 'NFL', lane, phase: 'pregame', gameId: String(r.game_id),
      title: String(r.ref ?? `${lane} ${sideWord}`),
      signalType: `BUY_${sideWord}`, explicitSide: side,
      ourP: num(r.our_p), marketP: num(r.market_p), edgePp: num(r.edge_pp),
      label: String(r.label ?? 'NONE').toUpperCase(),
      kelly: null, trigger: false, measured: false, clock: null, quotes,
      why: r.record ? `Record on this lane: ${r.record}` : null, receivedAt: now
    })
  }
  return out
}

// The NFL market map, as /v1/nfl/edges publishes it per game (nfl_market_map
// on the server; "tickers come from nfl_market_map and are NEVER derived").
// Only one of the spread fields is set: the favourite's contract, "that team
// wins by more than the line".
export interface NflMarketMap {
  kalshi_moneyline_home?: string
  kalshi_moneyline_away?: string
  kalshi_total_over?: string
  kalshi_spread_home?: string
  kalshi_spread_away?: string
}

export function nflMarketMaps(edges: any): Record<string, NflMarketMap> {
  const games: any[] = Array.isArray(edges) ? edges : edges?.games ?? edges?.edges ?? []
  const out: Record<string, NflMarketMap> = {}
  for (const g of games) if (g?.game_id) out[String(g.game_id)] = g
  return out
}

// The rung a Kalshi ladder ticker carries, by the server's own rule
// (nfl_routes._market_rungs): the last segment is an optional team code then
// digits, and the line is the digits minus 0.5. "...-SEA3" is SEA by more than 2.5.
export function kalshiRung(ticker: string): number | null {
  const m = /(\d+)$/.exec(ticker.split('-').pop() ?? '')
  return m ? Number(m[1]) - 0.5 : null
}

const sameLine = (a: number | null, b: number | null): boolean => a !== null && b !== null && Math.abs(a - b) < 0.01

// The contract a hot play refers to, from the market map alone. A play on a
// rung the map does not hold is refused: the live rung can drift off the main
// line, and a ticker on another rung is a different bet.
export function hotPlayContract(
  lane: 'MONEYLINE' | 'SPREAD' | 'TOTAL',
  sideWord: string,
  line: number | null,
  map: NflMarketMap | undefined
): { contract: string; side: ContractSide } | { refuse: string } {
  if (!map) return { refuse: 'game not in the market map' }

  if (lane === 'MONEYLINE') {
    const t = sideWord === 'HOME' ? map.kalshi_moneyline_home : sideWord === 'AWAY' ? map.kalshi_moneyline_away : undefined
    return t ? { contract: t, side: 'yes' } : { refuse: `no moneyline ticker for ${sideWord}` }
  }

  if (lane === 'TOTAL') {
    const t = map.kalshi_total_over
    if (!t) return { refuse: 'no total ticker' }
    if (!sameLine(kalshiRung(t), line)) return { refuse: `total rung ${kalshiRung(t)} is not the play's ${line}` }
    // One strike: YES is over, the UNDER is the NO side of the same contract.
    if (sideWord === 'OVER') return { contract: t, side: 'yes' }
    if (sideWord === 'UNDER') return { contract: t, side: 'no' }
    return { refuse: `side ${sideWord} on a total` }
  }

  // SPREAD. The play prices "home margin over thr", published as the team's
  // own line: HOME at -thr, AWAY at +thr.
  if (sideWord !== 'HOME' && sideWord !== 'AWAY' || line === null) return { refuse: `side ${sideWord} on a spread` }
  const thr = sideWord === 'HOME' ? -line : line
  if (map.kalshi_spread_home) {
    // "home wins by more than X" is exactly "home margin over X".
    if (!sameLine(kalshiRung(map.kalshi_spread_home), thr)) return { refuse: `spread rung ${kalshiRung(map.kalshi_spread_home)} is not the play's ${thr}` }
    return { contract: map.kalshi_spread_home, side: sideWord === 'HOME' ? 'yes' : 'no' }
  }
  if (map.kalshi_spread_away) {
    // "away wins by more than X" is "home margin under -X", the complement of
    // "home margin over -X" on half point lines, so the sides flip.
    const x = kalshiRung(map.kalshi_spread_away)
    if (!sameLine(x === null ? null : -x, thr)) return { refuse: `spread rung ${x} is not the play's ${thr}` }
    return { contract: map.kalshi_spread_away, side: sideWord === 'HOME' ? 'no' : 'yes' }
  }
  return { refuse: 'no spread ticker' }
}

export function nflHotPlays(body: any, now: number, maps: Record<string, NflMarketMap> = {}): Normalized {
  const out: Normalized = { signals: [], refused: [] }
  for (const p of body?.plays ?? []) {
    const lane = LANE[String(p?.market ?? '').toUpperCase()]
    const sideWord = String(p?.side ?? '').toUpperCase()
    if (!lane) { out.refused.push({ source: 'nfl.live-plays', reason: `market ${p?.market}` }); continue }

    // Moneyline HOME/AWAY each have their own ticker, both YES. A spread
    // contract is "home margin over the line": HOME is YES, AWAY is NO.
    // Totals and props: OVER is YES, UNDER is NO.
    let side: ContractSide | undefined
    if (lane === 'MONEYLINE') side = sideWord === 'HOME' || sideWord === 'AWAY' ? 'yes' : undefined
    else if (lane === 'SPREAD') side = sideWord === 'HOME' ? 'yes' : sideWord === 'AWAY' ? 'no' : undefined
    else side = BOARD_SIDE[sideWord]
    if (!side) { out.refused.push({ source: 'nfl.live-plays', reason: `side ${p?.side} on ${lane}` }); continue }

    // Hot plays carry no ticker; the market map supplies it. A ticker the API
    // publishes on the row itself wins.
    const quotes: VenueQuote[] = []
    let refusedContract: string | null = null
    if (p.ticker ?? p.kalshi_ticker) {
      quotes.push({ venue: 'kalshi', contract: String(p.ticker ?? p.kalshi_ticker), side, ask: num(p.price), askSize: null, priceAgeS: num(p.price_age_s) })
    } else if (lane === 'MONEYLINE' || lane === 'SPREAD' || lane === 'TOTAL') {
      const c = hotPlayContract(lane, sideWord, num(p.line), maps[String(p.game_id)])
      if ('refuse' in c) refusedContract = c.refuse
      else {
        // The contract the map names decides the side: an away favourite's
        // spread ticker is the complement of the home margin contract.
        side = c.side
        // The ask is read from the live book before the gates run.
        quotes.push({ venue: 'kalshi', contract: c.contract, side: c.side, ask: null, askSize: null, priceAgeS: null })
      }
    }
    if (refusedContract) out.refused.push({ source: 'nfl.live-plays', reason: refusedContract })

    const why = Array.isArray(p.why) ? p.why.map((w: any) => w?.text).filter(Boolean).join(' · ') : null
    out.signals.push({
      key: `nfl:${p.game_id}:live:${lane}:${p.line ?? ''}:${p.player ?? ''}:${p.stat ?? ''}:${sideWord}`,
      sport: 'NFL', lane, phase: 'live', gameId: String(p.game_id),
      title: `${p.matchup ?? ''} ${p.selection ?? ''}`.trim(),
      // A spread HOME/AWAY is not a moneyline HOME/AWAY, so it gets its own
      // name and the explicit side decides; the table never sees it.
      signalType: `BUY_${lane === 'SPREAD' ? 'SPREAD_' : ''}${sideWord}`,
      explicitSide: side,
      ourP: num(p.our_p), marketP: num(p.market_p),
      // Props publish the edge at the price you would pay as exec_edge_pp.
      edgePp: num(p.exec_edge_pp) ?? num(p.edge_pp),
      label: p.measured ? 'MEASURED' : 'PRICE_GAP',
      kelly: null,
      trigger: Array.isArray(p.why) && p.why.some((w: any) => w?.type && w.type !== 'UNDER_REACTION'),
      measured: Boolean(p.measured),
      clock: parseNflClock(p.clock, p.qtr),
      quotes, why, receivedAt: now,
      matchup: p.matchup ? String(p.matchup) : null, hot: true
    })
  }
  return out
}

// MLB, from MLBEdgeResponse in the API (the /v1/mlb/edges
// model). The response carries Kalshi tickers only; Polymarket appears as an
// event slug with no token id, so MLB routes to Kalshi alone. The API's own
// Kelly fields are on the raw probability, so sizing uses the gates' Kelly on
// the haircut probability instead.
export function mlbEdges(body: any, now: number): Normalized {
  const out: Normalized = { signals: [], refused: [] }
  const games: any[] = Array.isArray(body) ? body : []
  for (const g of games) {
    const gid = String(g.game_pk ?? '')
    const title = `${g.away_team ?? ''} @ ${g.home_team ?? ''}`.trim()
    const sig = String(g.signal ?? '').toUpperCase()
    if (sig === 'BUY_HOME' || sig === 'BUY_AWAY') {
      const home = sig === 'BUY_HOME'
      const pHome = num(g.p_home_win)
      if (pHome === null || pHome <= 0) { out.refused.push({ source: 'mlb.edges', reason: `no model probability on ${gid}` }); continue }
      const implied = num(g.kalshi_implied_pct)
      const mHome = implied === null || implied <= 0 ? null : implied > 1 ? implied / 100 : implied
      const kt = home ? g.kalshi_home_ticker : g.kalshi_away_ticker
      out.signals.push({
        key: `mlb:${gid}:MONEYLINE:${home ? 'home' : 'away'}`, sport: 'MLB', lane: 'MONEYLINE', phase: 'pregame', gameId: gid,
        title: `${title} ${home ? g.home_team : g.away_team} to win`,
        signalType: sig, explicitSide: null, ourP: home ? pHome : 1 - pHome,
        marketP: mHome === null ? null : home ? mHome : 1 - mHome,
        edgePp: num(g.best_edge_pp), label: 'PRICE_GAP', kelly: null,
        trigger: false, measured: false, clock: null,
        quotes: kt ? [{ venue: 'kalshi', contract: String(kt), side: 'yes', ask: null, askSize: null, priceAgeS: null }] : [],
        why: null, receivedAt: now, matchup: matchupOf(g)
      })
    } else if (sig && sig !== 'NO_EDGE') {
      out.refused.push({ source: 'mlb.edges', reason: `signal ${sig}` })
    }

    // The measured totals board. total_pick reads like "OVER 7.5". The API
    // says a total is a play only when the seam AND the line check both hold.
    const m = /^(OVER|UNDER)\s+([\d.]+)$/.exec(String(g.total_pick ?? '').trim().toUpperCase())
    const pOver = num(g.our_p_over)
    const mainLine = num(g.main_line)
    const ticker = g.kalshi_totals_ticker ? String(g.kalshi_totals_ticker) : ''
    if (!m || pOver === null) continue
    if (!g.total_line_ok) { out.refused.push({ source: 'mlb.edges', reason: 'total line not confirmed by a book' }); continue }
    if (!ticker) { out.refused.push({ source: 'mlb.edges', reason: 'no totals ticker' }); continue }
    // The pick, the main line and the ticker's own strike must all agree, or
    // the order would land on a different bet than the one priced.
    if (!sameLine(Number(m[2]), mainLine) || !sameLine(kalshiRung(ticker), mainLine)) {
      out.refused.push({ source: 'mlb.edges', reason: `total rung ${kalshiRung(ticker)} is not the main line ${mainLine}` })
      continue
    }
    const over = m[1] === 'OVER'
    const mOver = num(g.market_p_over)
    out.signals.push({
      key: `mlb:${gid}:TOTAL:${mainLine}:${m[1]}`, sport: 'MLB', lane: 'TOTAL', phase: 'pregame', gameId: gid,
      title: `${title} ${over ? 'over' : 'under'} ${mainLine}`,
      signalType: over ? 'BUY_OVER' : 'BUY_UNDER', explicitSide: null,
      ourP: over ? pOver : 1 - pOver,
      marketP: mOver === null ? null : over ? mOver : 1 - mOver,
      edgePp: num(g.total_edge_pp) === null ? null : Math.abs(num(g.total_edge_pp)!),
      label: g.total_seam ? 'MEASURED' : 'LEAN', kelly: null, trigger: false, measured: Boolean(g.total_seam),
      clock: null,
      quotes: [{ venue: 'kalshi', contract: ticker, side: over ? 'yes' : 'no', ask: null, askSize: null, priceAgeS: null }],
      why: g.sp_tbd ? 'Starting pitcher unconfirmed; the total carries more uncertainty than its spread suggests.' : null,
      receivedAt: now, matchup: matchupOf(g)
    })
  }
  return out
}

// NBA clock: "5:32" left in the period, twelve minute quarters, period 5 and
// up is overtime.
export function parseNbaClock(clock: unknown, period: unknown): Signal['clock'] {
  const p = num(period)
  if (p === null || p < 1) return null
  if (p > 4) return { period: p, secondsRemaining: null, overtime: true }
  const m = /^(\d+):(\d{2})(?:\.\d+)?$/.exec(String(clock ?? '').trim())
  return { period: p, secondsRemaining: m ? (4 - p) * 720 + Number(m[1]) * 60 + Number(m[2]) : null, overtime: false }
}

// NBA, from LiveEdgeResponse (/v1/edges/live). Each row names its own
// contract: BUY is YES on the home ticker, SELL is YES on the away ticker.
// our_prob is the HOME win probability, so the away side gets 1 minus it.
// Polymarket is a condition id with no token id, so NBA routes to Kalshi only.
const NBA_MAX_SIGNAL_AGE_S = 180

// Why a game's live model row cannot be traded on, or null when it can. The
// 2026-05-26 postmortem: a wedged pipeline can leave an edge sitting for
// hours. The server flags it; the app also refuses anything old. The spread
// ladder is priced off the same row, so it obeys the same check.
export function nbaRowProblem(r: any): string | null {
  if (r?.signal_stale) return 'signal flagged stale by the server'
  const age = num(r?.signal_age_s)
  if (age === null || age > NBA_MAX_SIGNAL_AGE_S) return `signal ${age ?? 'unknown'}s old`
  return null
}

export function nbaLiveEdges(body: any, now: number): Normalized {
  const out: Normalized = { signals: [], refused: [] }
  for (const r of Array.isArray(body) ? body : []) {
    const gid = String(r.game_id ?? '')
    const sig = String(r.trade_signal ?? 'HOLD').toUpperCase()
    if (sig === 'HOLD') continue
    if (sig !== 'BUY' && sig !== 'SELL') { out.refused.push({ source: 'nba.edges', reason: `signal ${sig}` }); continue }
    const problem = nbaRowProblem(r)
    if (problem) { out.refused.push({ source: 'nba.edges', reason: problem }); continue }
    if (String(r.target_side ?? '').toUpperCase() !== 'YES') { out.refused.push({ source: 'nba.edges', reason: `target side ${r.target_side}` }); continue }
    const pHome = num(r.our_prob)
    if (pHome === null || pHome <= 0 || pHome >= 1) { out.refused.push({ source: 'nba.edges', reason: `no model probability on ${gid}` }); continue }

    const home = sig === 'BUY'
    const ticker = r.target_kalshi_ticker ? String(r.target_kalshi_ticker) : ''
    const edge = num(r.edge_score)
    const mid = num(r.kalshi_implied)
    const clock = parseNbaClock(r.clock, r.period)
    const team = home ? r.home_team : r.away_team
    out.signals.push({
      key: `nba:${gid}:MONEYLINE:${home ? 'home' : 'away'}`, sport: 'NBA', lane: 'MONEYLINE',
      phase: clock ? 'live' : 'pregame', gameId: gid,
      title: `${r.away_team ?? ''} @ ${r.home_team ?? ''} ${team ?? ''} to win`.trim(),
      signalType: home ? 'BUY_HOME' : 'BUY_AWAY', explicitSide: 'yes',
      ourP: home ? pHome : 1 - pHome,
      marketP: mid === null || mid <= 0 ? null : home ? mid : 1 - mid,
      // edge_score is a fraction against the home mid; the gates read points.
      edgePp: edge === null ? null : Math.abs(edge) * 100,
      label: 'PRICE_GAP', kelly: null, trigger: false, measured: false, clock,
      quotes: ticker ? [{ venue: 'kalshi', contract: ticker, side: 'yes', ask: null, askSize: null, priceAgeS: null }] : [],
      why: r.momentum_state && r.momentum_state !== 'NEUTRAL' ? `Momentum ${String(r.momentum_state).toLowerCase().replace('_', ' ')}` : null,
      receivedAt: now, matchup: matchupOf(r)
    })
    if (!ticker) out.refused.push({ source: 'nba.edges', reason: 'no target ticker' })
  }
  return out
}

// NBA spreads, from SpreadLadderRung (/v1/spread-ladder/{game_id}, built in
// the server's spread ladder). Each Kalshi ticker reads "team wins by over the
// line" and model_prob is always P(YES) on it. COVER buys YES at model_prob;
// NOT_COVER buys NO at 1 - model_prob, the NO side of the same contract.
//
// The server's guidance is that bots act only on the rung marked best_edge.
// That rung arrives as PRICE_GAP; every other rung as TAIL_RUNG, which a bot
// trades only if the user enables that label.
//
// The ladder carries no clock and is priced off the game's live model row,
// so it takes the clock and the staleness check from that row.
export function nbaSpreadLadder(liveRow: any, rungs: any, now: number): Normalized {
  const out: Normalized = { signals: [], refused: [] }
  const gid = String(liveRow?.game_id ?? '')
  const problem = nbaRowProblem(liveRow)
  if (problem) {
    if (Array.isArray(rungs) && rungs.length) out.refused.push({ source: 'nba.spread', reason: problem })
    return out
  }
  const clock = parseNbaClock(liveRow.clock, liveRow.period)
  for (const r of Array.isArray(rungs) ? rungs : []) {
    if (String(r?.venue ?? 'kalshi') !== 'kalshi') continue
    const ticker = String(r?.ticker ?? '')
    const line = num(r?.line)
    const pYes = num(r?.model_prob)
    const sideWord = String(r?.side ?? '').toUpperCase()
    const side: ContractSide | undefined = sideWord === 'COVER' ? 'yes' : sideWord === 'NOT_COVER' ? 'no' : undefined
    if (!/^KXNBASPREAD-/i.test(ticker)) { out.refused.push({ source: 'nba.spread', reason: `not a spread ticker ${ticker}` }); continue }
    if (!side) { out.refused.push({ source: 'nba.spread', reason: `side ${r?.side}` }); continue }
    if (pYes === null || pYes <= 0 || pYes >= 1) { out.refused.push({ source: 'nba.spread', reason: `no model probability on ${ticker}` }); continue }
    // The rung the row states must be the rung the ticker carries.
    if (!sameLine(kalshiRung(ticker), line)) { out.refused.push({ source: 'nba.spread', reason: `ticker rung ${kalshiRung(ticker)} is not the row's ${line}` }); continue }
    const edge = num(r.edge)
    out.signals.push({
      key: `nba:${gid}:SPREAD:${ticker}:${side}`, sport: 'NBA', lane: 'SPREAD',
      phase: clock ? 'live' : 'pregame', gameId: gid,
      title: `${liveRow.away_team ?? ''} @ ${liveRow.home_team ?? ''} ${r.team} ${side === 'yes' ? 'by over' : 'not by over'} ${line}`.trim(),
      signalType: `BUY_SPREAD_${sideWord}`, explicitSide: side,
      ourP: side === 'yes' ? pYes : 1 - pYes,
      marketP: num(r.market_price) === null ? null : side === 'yes' ? num(r.market_price) : 1 - num(r.market_price)!,
      edgePp: edge === null ? null : Math.abs(edge) * 100,
      label: r.best_edge ? 'PRICE_GAP' : 'TAIL_RUNG', kelly: null, trigger: false, measured: false, clock,
      quotes: [{ venue: 'kalshi', contract: ticker, side, ask: null, askSize: null, priceAgeS: null }],
      why: r.best_edge ? 'The ladder rung with the widest disagreement, the one the server marks for bots.' : null,
      receivedAt: now, matchup: matchupOf(liveRow)
    })
  }
  return out
}
