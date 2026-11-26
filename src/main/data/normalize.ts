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
import { kalshiNflCode } from './nflkalshi'

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

// An API time as epoch ms: ISO text, or epoch seconds or ms. Null if unreadable.
export const epochMs = (v: unknown): number | null => {
  if (v === null || v === undefined || v === '') return null
  const s = String(v).trim()
  const t = /^\d+(\.\d+)?$/.test(s) ? Number(s) : Date.parse(s)
  if (!Number.isFinite(t)) return null
  return t < 1e12 ? t * 1000 : t
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
  // A bare "4:12" is time left in the quarter the qtr field names (the prop
  // rows, 2026-11-26).
  const bare = m ? null : /^(\d+):(\d{2})$/.exec(s)
  const q = m ? Number(m[1]) : num(qtr)
  if (q === null) return null
  if (q > 4) return { period: q, secondsRemaining: null, overtime: true }
  const inQ = m ? Number(m[2]) * 60 + Number(m[3]) : bare ? Number(bare[1]) * 60 + Number(bare[2]) : null
  return { period: q, secondsRemaining: inQ === null ? null : (4 - q) * 900 + inQ, overtime: false }
}

export function nflBoardRows(rows: any[], now: number): Normalized {
  const out: Normalized = { signals: [], refused: [] }
  for (const r of rows ?? []) {
    const lane = LANE[String(r?.lane ?? '').toUpperCase()]
    const sideWord = String(r?.side ?? '').toUpperCase()
    if (!lane) { out.refused.push({ source: 'nfl.board', reason: `lane ${r?.lane}` }); continue }
    const kalshi = String(r.venue ?? '').toUpperCase() === 'KALSHI' && Boolean(r.ticker)
    // New Orleans is NO, the same word as the NO side. A moneyline row with no
    // contract that names NO as the winner ("NO wins") is the Saints
    // (2026-11-23: their picks were read as a NO side with no contract).
    const saints = lane === 'MONEYLINE' && !kalshi && sideWord === 'NO' && /^NO\b/i.test(String(r.ref ?? ''))
    const side = saints ? undefined : BOARD_SIDE[sideWord]
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
  kickoff?: string
  status?: string
}

// A book consensus moneyline row names a team ("NYJ wins") with our chance
// and no venue contract. The game's own Kalshi moneyline tickers from the
// market map end in each team's code (KXNFLGAME-26NOV22NYJLAC-NYJ), so a row
// whose team matches one exactly becomes a play on YES of that ticker
// (2026-11-21: Kaneco's bot could not trade most NFL picks for want of one).
// A team that matches neither ticker, or a ticker another row already
// prices, stays information.
export function nflInfoToKalshi(signals: Signal[], maps: Record<string, NflMarketMap>): Signal[] {
  const priced = new Set(signals.flatMap((s) => s.quotes.map((q) => q.contract)))
  return signals.map((s) => {
    if (s.sport !== 'NFL' || s.lane !== 'MONEYLINE' || s.quotes.length || !s.signalType.startsWith('INFO_')) return s
    // The API's team code, in Kalshi's spelling (JAX is JAC, LA is LAR).
    const team = kalshiNflCode(s.signalType.slice(5))
    const m = maps[s.gameId]
    const home = m?.kalshi_moneyline_home && m.kalshi_moneyline_home.split('-').pop() === team ? m.kalshi_moneyline_home : null
    const away = m?.kalshi_moneyline_away && m.kalshi_moneyline_away.split('-').pop() === team ? m.kalshi_moneyline_away : null
    const ticker = home ?? away
    if (!ticker || priced.has(ticker)) return s
    priced.add(ticker)
    return {
      ...s,
      key: `nfl:${s.gameId}:MONEYLINE:${ticker}:yes`,
      signalType: home ? 'BUY_HOME' : 'BUY_AWAY', explicitSide: 'yes',
      quotes: [{ venue: 'kalshi', contract: ticker, side: 'yes', ask: null, askSize: null, priceAgeS: null }],
      why: [s.why, "the API's consensus pick, matched to Kalshi's moneyline"].filter(Boolean).join('; ')
    }
  })
}

// The board is priced before kickoff. Once a game is under way, by its status
// or because kickoff has passed, its board rows are in game plays priced off
// a pregame number. They become live with no clock: a pregame bot never takes
// them, and a live bot refuses them on the clock gate. In game trading comes
// from the hot plays, which carry a clock. A game whose kickoff cannot be read
// counts as under way, so a pregame bot never guesses.
const NFL_UNDER_WAY = ['IN_PROGRESS', 'HALFTIME']
export function nflBoardPhase(game: NflMarketMap | undefined, now: number): Pick<Signal, 'phase' | 'clock'> {
  const status = String(game?.status ?? '').toUpperCase()
  const kickoff = Date.parse(String(game?.kickoff ?? ''))
  const started = !Number.isFinite(kickoff) || kickoff <= now || NFL_UNDER_WAY.includes(status) || status.includes('FINAL')
  return { phase: started ? 'live' : 'pregame', clock: null }
}

// Each game whole, so the board can read its kickoff and status too.
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
      clock: nflPlayClock(p),
      quotes, why, receivedAt: now,
      matchup: p.matchup ? String(p.matchup) : null, hot: true,
      // A player prop keeps its line and side, so its record can be read by
      // them like an NBA prop's. Its Kalshi market is found in the supervisor.
      ...(lane === 'PROP' && num(p.line) !== null ? { prop: { line: num(p.line)!, soFar: num(p.so_far ?? p.current ?? p.stat_so_far), over: sideWord === 'OVER', teamLead: null, rank: null } } : {})
    })
  }
  // A play with no clock of its own takes its game's clock from the same
  // reply: the game's own row when the reply lists games, else another play
  // in that game that has one. Same reply, same moment, so never stale
  // (2026-11-26: every live prop on 23 November came without one and was
  // refused on the clock gate). A game with no clock anywhere stays refused.
  const gameClock = new Map<string, NonNullable<Signal['clock']>>()
  for (const g of Array.isArray(body?.games) ? body.games : []) {
    const c = nflPlayClock(g)
    if (g?.game_id && c) gameClock.set(String(g.game_id), c)
  }
  for (const s of out.signals) if (s.clock && !gameClock.has(s.gameId)) gameClock.set(s.gameId, s.clock)
  for (const s of out.signals) if (!s.clock) s.clock = gameClock.get(s.gameId) ?? null
  return out
}

// A play's or a game's clock, from whichever fields the row carries.
function nflPlayClock(r: any): Signal['clock'] {
  return parseNflClock(r?.clock ?? r?.game_clock, r?.qtr ?? r?.quarter ?? r?.period)
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
    // A price of 0 or 1 is no reading, never a price (the API audit, 2026-11-20).
    const mRaw = num(g.market_p_over)
    const mOver = mRaw !== null && mRaw > 0 && mRaw < 1 ? mRaw : null
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
  if (m) return { period: p, secondsRemaining: (4 - p) * 720 + Number(m[1]) * 60 + Number(m[2]), overtime: false }
  // Between quarters and at halftime the clock is not a time. Before the 4th
  // the game has at least the later quarters left, a floor that keeps the
  // final seconds lockout honest; in the 4th nothing is assumed (2026-11-20:
  // every break read as "unknown seconds left" and refused the play).
  return { period: p, secondsRemaining: p < 4 ? (4 - p) * 720 : null, overtime: false }
}

// NBA, from LiveEdgeResponse (/v1/edges/live). Each row names its own
// contract: BUY is YES on the home ticker, SELL is YES on the away ticker.
// our_prob is the HOME win probability, so the away side gets 1 minus it.
// Polymarket is a condition id with no token id, so NBA routes to Kalshi only.
//
// signal_age_s grows through a timeout and halftime, when no plays arrive,
// and the API says a quiet game is not stale (agent guide, How to read NBA).
// signal_stale is the server's own word that plays are arriving unpriced. The
// age limit is only a backstop for a wedged pipeline, the 2026-05-26
// postmortem's hours old edge, so it sits past the longest break: halftime
// runs 15 minutes, and a review or injury stoppage can add more.
const NBA_MAX_SIGNAL_AGE_S = 25 * 60

// Why a game's live model row cannot be traded on, or null when it can. The
// spread ladder is priced off the same row, so it obeys the same check.
export function nbaRowProblem(r: any): string | null {
  if (r?.signal_stale) return 'signal flagged stale by the server'
  // model_ready false: our_prob is the pregame number or nothing, not the
  // model's live reading, and the API holds such rows (guide, How to read NBA).
  if (r?.model_ready === false) return `no model reading yet (${String(r?.skellam_status ?? 'not ready').toLowerCase()})`
  const age = num(r?.signal_age_s)
  if (age === null || age > NBA_MAX_SIGNAL_AGE_S) return `signal ${age ?? 'unknown'}s old`
  return null
}

// A game with a clock or any points on the board is under way, even when the
// feed drops its period, so a pregame bot never takes it.
const nbaPhase = (row: any, clock: Signal['clock']): Signal['phase'] =>
  clock || (num(row?.home_score) ?? 0) + (num(row?.away_score) ?? 0) > 0 ? 'live' : 'pregame'

// Where the game stands for the team a play backs (2026-11-17), from a live
// model row: its points ahead (negative behind) and the market's chance it
// wins, from kalshi_implied, the home win price. home is null when the play's
// team cannot be matched to either side, and then nothing is claimed.
export function nbaTeamState(row: any, home: boolean | null): NonNullable<Signal['team']> {
  if (home === null) return { lead: null, winP: null }
  const h = num(row?.home_score)
  const a = num(row?.away_score)
  const mid = num(row?.kalshi_implied)
  return {
    lead: h === null || a === null ? null : home ? h - a : a - h,
    winP: mid === null || mid <= 0 || mid >= 1 ? null : home ? mid : 1 - mid
  }
}

// Whether a team named on a row is the home side: true, false, or null when
// it matches neither team.
const isHomeTeam = (team: unknown, row: any): boolean | null => {
  const t = String(team ?? '').trim().toUpperCase()
  if (!t) return null
  if (t === String(row?.home_team ?? '').trim().toUpperCase()) return true
  if (t === String(row?.away_team ?? '').trim().toUpperCase()) return false
  return null
}

// The measured comeback record for the game's spot (agent guide, Comeback):
// from the 3rd quarter, when a team trails by 5 or more, how often teams in
// that spot went on to win, the trailing team's. Null outside that window or
// when the trailing team cannot be matched to a side.
export function comebackOf(r: any): Signal['comeback'] | null {
  const winP = num(r?.comeback_win_prob)
  if (winP === null || winP < 0 || winP > 1) return null
  const trailingHome = isHomeTeam(r?.comeback_trailing_team, r)
  if (trailingHome === null) return null
  return { winP, trailingHome, deficit: num(r?.comeback_deficit), bucket: r?.comeback_bucket ? String(r.comeback_bucket) : null }
}

// With picks on (a bot buys our pick), every fresh row also gives our pick,
// the team our_prob has winning, whenever the row's own signal is the other
// team or HOLD. That signal is marked pickOnly and priced on the pick's own
// ticker from the row's routing keys, so an edge bot never sees it.
export function nbaLiveEdges(body: any, now: number, picks = false): Normalized {
  const out: Normalized = { signals: [], refused: [] }
  for (const r of Array.isArray(body) ? body : []) {
    const gid = String(r.game_id ?? '')
    const sig = String(r.trade_signal ?? 'HOLD').toUpperCase()
    if (sig === 'HOLD' && !picks) continue
    if (sig !== 'BUY' && sig !== 'SELL' && sig !== 'HOLD') { out.refused.push({ source: 'nba.edges', reason: `signal ${sig}` }); continue }
    const problem = nbaRowProblem(r)
    if (problem) { out.refused.push({ source: 'nba.edges', reason: problem }); continue }
    const pHome = num(r.our_prob)
    if (pHome === null || pHome <= 0 || pHome >= 1) { out.refused.push({ source: 'nba.edges', reason: `no model probability on ${gid}` }); continue }

    const mid = num(r.kalshi_implied)
    const clock = parseNbaClock(r.clock, r.period)
    const edgeSide: boolean | null = sig === 'BUY' ? true : sig === 'SELL' ? false : null
    const comeback = comebackOf(r)
    const build = (home: boolean, ticker: string, edgePp: number | null, pickOnly: boolean): Signal => {
      const team = home ? r.home_team : r.away_team
      return {
        key: `nba:${gid}:MONEYLINE:${home ? 'home' : 'away'}`, sport: 'NBA', lane: 'MONEYLINE',
        phase: nbaPhase(r, clock), gameId: gid,
        title: `${r.away_team ?? ''} @ ${r.home_team ?? ''} ${team ?? ''} to win`.trim(),
        signalType: home ? 'BUY_HOME' : 'BUY_AWAY', explicitSide: 'yes',
        ourP: home ? pHome : 1 - pHome,
        marketP: mid === null || mid <= 0 ? null : home ? mid : 1 - mid,
        edgePp, label: 'PRICE_GAP', kelly: null, trigger: false, measured: false, clock,
        quotes: ticker ? [{ venue: 'kalshi', contract: ticker, side: 'yes', ask: null, askSize: null, priceAgeS: null }] : [],
        why: r.momentum_state && r.momentum_state !== 'NEUTRAL' ? `Momentum ${String(r.momentum_state).toLowerCase().replace('_', ' ')}` : null,
        receivedAt: now, matchup: matchupOf(r),
        team: nbaTeamState(r, home),
        ...(pickOnly ? { pickOnly: true } : {}),
        ...(comeback ? { comeback } : {})
      }
    }

    if (edgeSide !== null) {
      if (String(r.target_side ?? '').toUpperCase() !== 'YES') {
        out.refused.push({ source: 'nba.edges', reason: `target side ${r.target_side}` })
      } else {
        const ticker = r.target_kalshi_ticker ? String(r.target_kalshi_ticker) : ''
        const edge = num(r.edge_score)
        // edge_score is a fraction against the home mid; the gates read points.
        out.signals.push(build(edgeSide, ticker, edge === null ? null : Math.abs(edge) * 100, false))
        if (!ticker) out.refused.push({ source: 'nba.edges', reason: 'no target ticker' })
      }
    }

    // Our pick, when the row's signal is not already it. A tie has no pick.
    if (!picks || pHome === 0.5) continue
    const pickHome = pHome > 0.5
    if (edgeSide === pickHome) continue
    const ticker = String((pickHome ? r.kalshi_home_ticker : r.kalshi_away_ticker) ?? '')
    if (!ticker) { out.refused.push({ source: 'nba.edges', reason: `no ${pickHome ? 'home' : 'away'} ticker for our pick on ${gid}` }); continue }
    const ourPick = pickHome ? pHome : 1 - pHome
    const mPick = mid === null || mid <= 0 || mid >= 1 ? null : pickHome ? mid : 1 - mid
    out.signals.push(build(pickHome, ticker, mPick === null ? null : (ourPick - mPick) * 100, true))
  }
  return out
}

// NBA picks, from NBAPickResponse (/v1/nba/picks, 2026-11-17): the team our
// number has winning in each game, the contract on it, its record and its
// price. Every usable row is a pick signal, read only by a bot that buys our
// pick. The API's BACK or WATCH is shown, never obeyed: the bot's own minimum
// chance and price band decide, so the settings stay the product. ourP is our
// raw number, the one the minimum chance has always read; the corrected
// chance and the record ride along in the note.
//
// A live pick is held to the live feed's limit, past the longest break. A pregame number moves
// slowly, so it may be older, but one past three hours is a stalled pipeline
// and is refused.
const NBA_PICK_MAX_AGE_S = { live: NBA_MAX_SIGNAL_AGE_S, pregame: 3 * 3600 }

const pct = (p: number): string => `${Math.round(p * 100)}%`
const tally = (r: any): string | null => (r && num(r.n) ? `${r.won}-${r.lost}` : null)

export function nbaPicks(body: any, now: number): Normalized {
  const out: Normalized = { signals: [], refused: [] }
  for (const r of Array.isArray(body) ? body : []) {
    const gid = String(r.game_id ?? '')
    const refuse = (reason: string): void => { out.refused.push({ source: 'nba.picks', reason }) }
    if (!r.model_ready) { refuse(`no model number yet on ${gid}`); continue }
    if (r.signal_stale) { refuse('signal flagged stale by the server'); continue }
    const side = String(r.pick_side ?? '').toLowerCase()
    if (side !== 'home' && side !== 'away') { refuse(`no pick on ${gid}`); continue }
    const p = num(r.pick_p)
    if (p === null || p <= 0 || p >= 1) { refuse(`no chance on the pick on ${gid}`); continue }
    const ticker = String(r.target_kalshi_ticker ?? '')
    if (!ticker) { refuse(`no ticker for our pick on ${gid}`); continue }
    const clock = parseNbaClock(r.clock, r.period)
    // The row's own phase decides once the API sends it (API #981: pregame
    // picks are designated up to the tip); the clock and score only stand in
    // for an older row. A game with points on the board is never pregame.
    const rowPhase = String(r.phase ?? '').toLowerCase()
    const phase: Signal['phase'] = rowPhase === 'live' || nbaPhase(r, clock) === 'live' ? 'live' : rowPhase === 'pregame' || !rowPhase ? 'pregame' : 'live'
    const at = num(r.computed_at_ms)
    if (at === null || at <= 0) { refuse(`no time on the pick on ${gid}`); continue }
    const age = Math.max(0, Math.round((now - at) / 1000))
    if (age > NBA_PICK_MAX_AGE_S[phase]) { refuse(`pick ${age}s old`); continue }

    const home = side === 'home'
    const team = home ? r.home_team : r.away_team
    const price = num(r.price)
    const raw = num(r.raw_edge)
    const cp = num(r.corrected_p)
    const season = tally(r.record_season)
    const week = tally(r.record_7d)
    // API #981: the market's chance on our pick, whether the market has our
    // pick winning too, and in play whether the pick changed at the tip.
    const marketP = num(r.market_p)
    const favorite = typeof r.pick_is_favorite === 'boolean' ? r.pick_is_favorite : null
    const changed = phase === 'live' && typeof r.pick_changed === 'boolean' ? r.pick_changed : null
    const gap = num(r.gap_pp)
    const why = [
      cp !== null ? `Corrected chance ${pct(cp)}` : null,
      season ? `picks at this chance ${season} this season${week ? `, ${week} in the last 7 days` : ''}` : null,
      favorite === false && r.market_pick ? `the market has ${r.market_pick} winning` : favorite === true ? 'the market agrees' : null,
      gap !== null ? `${gap >= 0 ? '+' : ''}${gap.toFixed(1)} points over the market` : null,
      changed && r.pregame_pick ? `changed at the tip from ${r.pregame_pick}` : null,
      r.edge_against_pick && r.edge_team ? `the edge points at ${r.edge_team}` : null,
      r.model ? `model ${String(r.model)}` : null,
      `API ${String(r.signal ?? 'WATCH')}${r.reason ? `: ${r.reason}` : ''}`
    ].filter(Boolean).join('; ')
    const state = nbaTeamState(r, home)
    // The market's chance on our pick, straight from the API, wins over one
    // worked out from the home price.
    if (marketP !== null && marketP > 0 && marketP < 1) state.winP = marketP
    out.signals.push({
      key: `nba:${gid}:MONEYLINE:${side}`, sport: 'NBA', lane: 'MONEYLINE', phase, gameId: gid,
      title: `${r.away_team ?? ''} @ ${r.home_team ?? ''} ${team ?? ''} to win`.trim(),
      signalType: home ? 'BUY_HOME' : 'BUY_AWAY', explicitSide: 'yes',
      ourP: p, marketP: price, edgePp: raw === null ? null : raw * 100,
      label: 'PRICE_GAP', kelly: null, trigger: false, measured: false, clock: phase === 'live' ? clock : null,
      quotes: [{ venue: 'kalshi', contract: ticker, side: 'yes', ask: null, askSize: null, priceAgeS: null }],
      why, receivedAt: now, matchup: matchupOf(r),
      team: state, pickOnly: true,
      ...(changed === null ? {} : { pickChanged: changed }),
      ...((): { comeback?: NonNullable<Signal['comeback']> } => { const c = comebackOf(r); return c ? { comeback: c } : {} })()
    })
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
    // YES backs the named team to cover; NO backs the other team, the one
    // that needs the named team to fall short.
    const named = isHomeTeam(r.team, liveRow)
    const backsHome = named === null ? null : side === 'yes' ? named : !named
    out.signals.push({
      key: `nba:${gid}:SPREAD:${ticker}:${side}`, sport: 'NBA', lane: 'SPREAD',
      phase: nbaPhase(liveRow, clock), gameId: gid,
      title: `${liveRow.away_team ?? ''} @ ${liveRow.home_team ?? ''} ${r.team} ${side === 'yes' ? 'by over' : 'not by over'} ${line}`.trim(),
      signalType: `BUY_SPREAD_${sideWord}`, explicitSide: side,
      ourP: side === 'yes' ? pYes : 1 - pYes,
      marketP: num(r.market_price) === null ? null : side === 'yes' ? num(r.market_price) : 1 - num(r.market_price)!,
      edgePp: edge === null ? null : Math.abs(edge) * 100,
      label: r.best_edge ? 'PRICE_GAP' : 'TAIL_RUNG', kelly: null, trigger: false, measured: false, clock,
      quotes: [{ venue: 'kalshi', contract: ticker, side, ask: null, askSize: null, priceAgeS: null }],
      why: r.best_edge ? 'The ladder rung with the widest disagreement, the one the server marks for bots.' : null,
      receivedAt: now, matchup: matchupOf(liveRow),
      team: nbaTeamState(liveRow, backsHome)
    })
  }
  return out
}

// NBA player props, from NbaPropsGame (/v1/nba/props): one row per player,
// with points, rebounds and assists side by side. Each stat carries its
// Kalshi contract ({stat}_market_id), the line, and our chance of the over:
// the simulation's before the tip ({stat}_sim_p_over) and the live model's in
// play (likelihood_over, reb_likelihood_over, ast_likelihood_over). YES on a
// prop contract is the over, so the under is its NO side.
//
// One signal per player and stat, on whichever side we give the better
// chance, so a bot never sees both sides of one prop at once. A player listed
// out is skipped. A stat with no Kalshi contract or no chance is refused, so
// the gap shows instead of trading nothing quietly.
const PROP_STATS = [
  { label: 'points', pre: '', key: 'pts', now: 'current_points' },
  { label: 'rebounds', pre: 'reb_', key: 'reb', now: 'current_rebounds' },
  { label: 'assists', pre: 'ast_', key: 'ast', now: 'current_assists' }
] as const

export function nbaProps(body: unknown, now: number): Normalized {
  const out: Normalized = { signals: [], refused: [] }
  for (const g of Array.isArray(body) ? body : []) {
    const gid = String(g?.game_id ?? '')
    if (!gid) continue
    const clock = g.is_pregame === false ? parseNbaClock(g.clock, g.period) : null
    const live = g.is_pregame === false
    const matchup = matchupOf(g)
    const players: any[] = Array.isArray(g.players) ? g.players : []
    // Each player's place in his game by our points projection, 1 the
    // highest, for a bot that trades only the leading players. Players listed
    // out do not take a place.
    const ranked = players
      .filter((p) => !/\bOUT\b|INACTIVE/i.test(String(p?.availability ?? '')) && num(p?.projection) !== null)
      .sort((a, b) => num(b.projection)! - num(a.projection)!)
    const rankOf = new Map(ranked.map((p, i) => [p, i + 1]))
    for (const p of players) {
      if (/\bOUT\b|INACTIVE/i.test(String(p?.availability ?? ''))) continue
      const name = String(p?.player_name ?? '').trim()
      if (!name) continue
      const rank = rankOf.get(p) ?? null
      for (const s of PROP_STATS) {
        const line = num(p[`${s.pre}market_line`])
        if (line === null) continue
        const ticker = p[`${s.key}_market_id`] ? String(p[`${s.key}_market_id`]) : ''
        if (String(p[`${s.key}_venue`] ?? '').toLowerCase() !== 'kalshi' || !ticker) { out.refused.push({ source: 'nba.props', reason: 'no Kalshi contract' }); continue }
        const pOver = num(live ? p[`${s.pre}likelihood_over`] : p[`${s.key}_sim_p_over`])
        if (pOver === null || pOver <= 0 || pOver >= 1) { out.refused.push({ source: 'nba.props', reason: 'no chance of the over' }); continue }
        // A live book wider than 10 cents is marked thin by the API; its mid
        // is not a price anyone can trade at, so the play is refused.
        if (live && String(p[`${s.key}_live_source`] ?? '').toLowerCase() === 'thin') { out.refused.push({ source: 'nba.props', reason: 'book too thin, wider than 10 cents' }); continue }
        const over = pOver >= 0.5
        const price = num(p[`${s.key}_live_price`])
        const edge = num(p[`${s.key}_live_edge_pp`])
        const sofar = live ? num(p[s.now]) : null
        const ourP = over ? pOver : 1 - pOver
        // Off the floor: the projection already counts only his chance of
        // coming back, so it is said, not refused.
        const back = live && p.left_floor ? num(p.p_back) : null
        // His team's score, when the game row carries one.
        const home = isHomeTeam(p.team, g)
        const hs = num(g.home_score)
        const as = num(g.away_score)
        const teamLead = live && home !== null && hs !== null && as !== null ? (home ? hs - as : as - hs) : null
        out.signals.push({
          key: `nba:${gid}:PROP:${ticker}`, sport: 'NBA', lane: 'PROP',
          phase: live ? 'live' : 'pregame', gameId: gid,
          title: `${matchup ?? ''} ${name} ${over ? 'over' : 'under'} ${line} ${s.label}`.trim(),
          signalType: over ? 'BUY_OVER' : 'BUY_UNDER', explicitSide: over ? 'yes' : 'no',
          ourP,
          marketP: price === null ? null : over ? price : 1 - price,
          // The live edge is ours minus the mid on the over; the under is its mirror.
          edgePp: edge === null ? null : over ? edge : -edge,
          label: 'PRICE_GAP', kelly: null, trigger: false, measured: false, clock,
          quotes: [{ venue: 'kalshi', contract: ticker, side: over ? 'yes' : 'no', ask: null, askSize: null, priceAgeS: null }],
          why: `${Math.round(ourP * 100)}% to go ${over ? 'over' : 'under'} ${line}${sofar !== null ? `, ${sofar} so far` : ''}${back !== null ? `; on the bench, ${Math.round(back * 100)}% to come back tonight` : ''}`,
          receivedAt: now, matchup,
          prop: {
            line, soFar: sofar, over, teamLead, rank,
            ...(live ? { statsAt: epochMs(p.updated_at), pricedAt: epochMs(p.c2_priced_at), liveModel: p.live_model ? String(p.live_model) : null, minutes: num(p.minutes_played) } : {})
          }
        })
      }
    }
  }
  return out
}
