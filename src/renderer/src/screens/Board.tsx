import { useMemo, useState } from 'react'
import type { BotVerdict, Signal } from '@shared/signal'
import { useBoard, type EngineState } from '../api'
import { GATES, tip } from '../glossary'
import { Tip } from '../ui'

type Show = 'tradeable' | 'taking' | 'all'
type PhaseFilter = 'any' | 'live' | 'pregame'

interface Game {
  key: string
  sport: string
  name: string
  live: boolean
  clock: Signal['clock']
  plays: Signal[]
  info: Signal[]
  best: number
}

const PERIOD_S: Record<string, number> = { NFL: 900, NBA: 720 }

// "Q3 5:32" from the seconds left in the game.
function clockText(sport: string, c: Signal['clock']): string | null {
  if (!c) return null
  if (c.overtime) return 'OT'
  const per = PERIOD_S[sport]
  if (!per || c.period === null) return null
  if (c.secondsRemaining === null) return `Q${c.period}`
  const inPeriod = c.secondsRemaining - (4 - c.period) * per
  return `Q${c.period} ${Math.floor(inPeriod / 60)}:${String(inPeriod % 60).padStart(2, '0')}`
}

const pct = (p: number | null): string => (p === null ? '—' : `${(p * 100).toFixed(1)}%`)

function bestAsk(s: Signal): number | null {
  const asks = s.quotes.map((q) => q.ask).filter((a): a is number => a !== null)
  return asks.length ? Math.min(...asks) : null
}

function useRemembered<T extends string>(key: string, fallback: T): [T, (v: T) => void] {
  const [v, setV] = useState<T>(() => {
    try { return (localStorage.getItem(key) as T) || fallback } catch { return fallback }
  })
  return [v, (next: T) => { setV(next); try { localStorage.setItem(key, next) } catch { /* private window */ } }]
}

export function Board({ engine }: { engine: EngineState | null }) {
  const data = useBoard()
  const board = data?.board ?? []
  const verdicts = data?.verdicts ?? {}
  const [show, setShow] = useRemembered<Show>('board.show', 'tradeable')
  const [phase, setPhase] = useRemembered<PhaseFilter>('board.phase', 'any')
  const [sport, setSport] = useRemembered<string>('board.sport', 'ALL')
  const [hotOnly, setHotOnly] = useRemembered<'0' | '1'>('board.hot', '0')

  const sports = useMemo(() => [...new Set(board.map((s) => s.sport))].sort(), [board])

  const games = useMemo(() => {
    const taking = (s: Signal): boolean => (verdicts[s.key] ?? []).some((v) => v.outcome !== 'skip')
    const keep = board.filter((s) =>
      (sport === 'ALL' || s.sport === sport) &&
      (phase === 'any' || s.phase === phase) &&
      (hotOnly === '0' || s.hot) &&
      (show !== 'taking' || taking(s)))
    const by = new Map<string, Game>()
    for (const s of keep) {
      const key = `${s.sport}:${s.gameId}`
      let g = by.get(key)
      if (!g) {
        g = { key, sport: s.sport, name: '', live: false, clock: null, plays: [], info: [], best: -Infinity }
        by.set(key, g)
      }
      if (!g.name && s.matchup) g.name = s.matchup
      if (s.phase === 'live') { g.live = true; g.clock ??= s.clock }
      if (s.quotes.length) { g.plays.push(s); g.best = Math.max(g.best, s.edgePp ?? -Infinity) } else g.info.push(s)
    }
    const out = [...by.values()].filter((g) => g.plays.length || show === 'all')
    for (const g of out) {
      g.name ||= `${g.sport} game ${g.key.split(':')[1]}`
      g.plays.sort((a, b) => (b.edgePp ?? -99) - (a.edgePp ?? -99))
    }
    // Live games first, then the biggest edge.
    return out.sort((a, b) => Number(b.live) - Number(a.live) || b.best - a.best)
  }, [board, verdicts, sport, phase, hotOnly, show])

  const refusedCount = (engine?.refused ?? []).reduce((n, r) => n + r.count, 0)

  return (
    <>
      <h1>Board</h1>
      <p className="lede">Every play Lazy Edge published, grouped by game, with what each of your bots would do with it. Bots that are switched off are checked too, so you can see what a bot would take before you turn it on.</p>

      <div className="filters">
        <div className="group">
          <span>Show</span>
          {([['tradeable', 'Tradeable'], ['taking', 'My bots would take'], ['all', 'Everything']] as const).map(([k, l]) => (
            <button key={k} className={`chip ${show === k ? 'on' : ''}`} onClick={() => setShow(k)}>{l}</button>
          ))}
        </div>
        <div className="group">
          <span>Sport</span>
          {['ALL', ...sports].map((s) => <button key={s} className={`chip ${sport === s ? 'on' : ''}`} onClick={() => setSport(s)}>{s}</button>)}
        </div>
        <div className="group">
          <span>Phase</span>
          {([['any', 'Any'], ['live', 'Live'], ['pregame', 'Pregame']] as const).map(([k, l]) => (
            <button key={k} className={`chip ${phase === k ? 'on' : ''}`} onClick={() => setPhase(k)}>{l}</button>
          ))}
        </div>
        <button className={`chip has-tip ${hotOnly === '1' ? 'on' : ''}`} data-tip={tip('Hot play')} onClick={() => setHotOnly(hotOnly === '1' ? '0' : '1')}>Hot plays only</button>
      </div>

      {!board.length ? (
        <div className="card"><p className="muted" style={{ margin: 0 }}>No plays yet. Start the engine to load the board.</p></div>
      ) : !games.length ? (
        <div className="card"><p className="muted" style={{ margin: 0 }}>Nothing matches these filters.</p></div>
      ) : (
        games.map((g) => <GameCard key={g.key} game={g} verdicts={verdicts} />)
      )}

      {refusedCount > 0 && (
        <details style={{ marginTop: 14 }}>
          <summary>{refusedCount} rows the app could not read were refused, not guessed</summary>
          <ul className="small" style={{ margin: '8px 0 0' }}>
            {engine!.refused.map((r, i) => <li key={i}><span className="mono">{r.source}</span> {r.reason} <span className="muted">× {r.count}</span></li>)}
          </ul>
        </details>
      )}
    </>
  )
}

function GameCard({ game: g, verdicts }: { game: Game; verdicts: Record<string, BotVerdict[]> }) {
  const [openInfo, setOpenInfo] = useState(false)
  const clock = clockText(g.sport, g.clock)
  return (
    <div className={`game ${g.live ? 'is-live' : ''}`}>
      <div className="game-head">
        <span className="pill">{g.sport}</span>
        <span className="name">{g.name}</span>
        {g.live && <span className="pill live">Live{clock ? ` · ${clock}` : ''}</span>}
        <span style={{ flex: 1 }} />
        <span className="meta">{g.plays.length} {g.plays.length === 1 ? 'play' : 'plays'}{g.best > -Infinity ? ` · best edge ${g.best.toFixed(1)}pp` : ''}</span>
      </div>
      {g.plays.map((s) => <Play key={s.key} s={s} game={g.name} verdicts={verdicts[s.key] ?? []} />)}
      {g.info.length > 0 && (
        <>
          <div className="fold">
            <button className="btn ghost small" onClick={() => setOpenInfo(!openInfo)}>
              {openInfo ? 'Hide' : 'Show'} {g.info.length} info {g.info.length === 1 ? 'row' : 'rows'}
            </button>
            <Tip text="Rows Lazy Edge publishes for context with no contract a bot can buy, such as a team side the market map does not name." />
          </div>
          {openInfo && g.info.map((s) => <Play key={s.key} s={s} game={g.name} verdicts={[]} info />)}
        </>
      )}
    </div>
  )
}

function Play({ s, game, verdicts, info }: { s: Signal; game: string; verdicts: BotVerdict[]; info?: boolean }) {
  const strip = (t: string, prefix: string | null | undefined): string => (prefix && t.startsWith(prefix) ? t.slice(prefix.length).trim() || t : t)
  const title = strip(strip(s.title, s.matchup), game)
  const ask = bestAsk(s)
  return (
    <div className="play">
      <div>
        <div className="title">{title}</div>
        {s.why && <div className="why">{s.why}</div>}
        <div className="tags">
          {s.hot && <span className="pill hot has-tip" data-tip={tip('Hot play')}>Hot</span>}
          <span className="pill lane has-tip" data-tip={tip(s.lane)}>{s.lane}</span>
          <span className="pill has-tip" data-tip={tip(s.label) || undefined}>{s.label}</span>
          <span className="pill">{s.phase}</span>
        </div>
        {!info && (
          <div className="verdicts">
            {verdicts.length ? verdicts.map((v) => <Verdict key={v.botId} v={v} />) : <span className="verdict">No bot covers this market</span>}
          </div>
        )}
      </div>
      <div className="n"><small>Ours</small>{pct(s.ourP)}</div>
      <div className="n"><small>{ask !== null ? 'Ask' : 'Market'}</small>{ask !== null ? `${Math.round(ask * 100)}c` : pct(s.marketP)}</div>
      <div className="n"><small>Edge<Tip text={tip('Edge (pp)')} /></small>{s.edgePp === null ? '—' : `${s.edgePp.toFixed(1)}pp`}</div>
    </div>
  )
}

function Verdict({ v }: { v: BotVerdict }) {
  const off = v.enabled ? '' : ' (off)'
  if (v.outcome === 'take') return <span className="verdict take has-tip" data-tip={v.detail || undefined}>{v.botName}{off} takes it</span>
  if (v.outcome === 'holding') return <span className="verdict holding">{v.botName}{off} holds it</span>
  const reason = (v.gate && GATES[v.gate]) || v.gate || 'skipped'
  return <span className="verdict has-tip" data-tip={v.detail || reason}>{v.botName}{off}: {reason}</span>
}

