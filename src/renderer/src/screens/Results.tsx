import { useEffect, useMemo, useState, type ReactNode } from 'react'
import { PRINT_WINDOW_S, summarize } from '@shared/accuracy'
import { analyze, MIN_GAMES, MIN_SETTLED, settled, type Segment } from '@shared/results'
import { ago, api, usd, type AccuracyState, type Ticket } from '../api'
import { Tip } from '../ui'

type Venue = 'all' | 'paper' | 'live'

const VERDICT: Record<Segment['verdict'], { text: string; cls: string }> = {
  winning: { text: 'Winning', cls: 'good' },
  losing: { text: 'Losing', cls: 'bad' },
  even: { text: 'Could be luck', cls: 'muted' },
  too_early: { text: 'Too early', cls: 'muted' }
}

const pct = (p: number): string => `${(p * 100).toFixed(1)}%`
const cents = (c: number): string => `${c >= 0 ? '+' : '−'}${Math.abs(c).toFixed(1)}c`

export function Results() {
  const [days, setDays] = useState(30)
  const [venue, setVenue] = useState<Venue>('all')
  const [bot, setBot] = useState('all')
  const [fills, setFills] = useState<'all' | 'proven'>('all')
  const [tickets, setTickets] = useState<Ticket[]>([])
  const [acc, setAcc] = useState<AccuracyState | null>(null)

  useEffect(() => {
    void api.tickets(days).then(setTickets)
    return window.lazyedge.on('ticket', () => void api.tickets(days).then(setTickets))
  }, [days])
  useEffect(() => { void api.accuracy().then(setAcc) }, [tickets])

  const bots = useMemo(() => [...new Map(tickets.map((t) => [t.botId, t.botName])).entries()], [tickets])
  const base = tickets.filter((t) =>
    (venue === 'all' || (venue === 'paper') === (t.venue === 'paper')) && (bot === 'all' || t.botId === bot))
  // Proven: a live fill, or a paper fill the accuracy check backed with a real
  // trade or a recorded book.
  const proven = (t: Ticket): boolean => t.venue !== 'paper' || ['confirmed', 'book_only'].includes(acc?.entries[t.id]?.fill?.verdict ?? '')
  const scoped = fills === 'proven' ? base.filter(proven) : base
  const { overall, dimensions, recommendations } = useMemo(() => analyze(scoped), [scoped])
  const open = scoped.filter((t) => t.pnlUsd === null && t.filledContracts > 0).length
  const n = settled(scoped).length
  const tooEarly = overall.n < MIN_SETTLED
    ? `${MIN_SETTLED - overall.n} more settled trades before any call`
    : `${MIN_GAMES - overall.games} more games before any call; trades on one game win and lose together`

  return (
    <>
      <h1>Results</h1>
      <p className="lede">What won and what lost, from your own settled trades, broken down every way a setting can change. A pattern is only called winning or losing once it is unlikely to be luck.</p>

      <div className="filters">
        <div className="group">
          <span>Window</span>
          {[7, 30, 90, 365].map((d) => <button key={d} className={`chip ${days === d ? 'on' : ''}`} onClick={() => setDays(d)}>{d === 365 ? '1 year' : `${d} days`}</button>)}
        </div>
        <div className="group">
          <span>Money</span>
          {([['all', 'All'], ['paper', 'Paper'], ['live', 'Live']] as const).map(([k, l]) => <button key={k} className={`chip ${venue === k ? 'on' : ''}`} onClick={() => setVenue(k)}>{l}</button>)}
        </div>
        <div className="group">
          <span>Bot</span>
          <button className={`chip ${bot === 'all' ? 'on' : ''}`} onClick={() => setBot('all')}>All</button>
          {bots.map(([id, name]) => <button key={id} className={`chip ${bot === id ? 'on' : ''}`} onClick={() => setBot(id)}>{name}</button>)}
        </div>
        <div className="group">
          <span>Fills<Tip text="Proven only leaves out paper fills the accuracy check could not back with a real Kalshi trade or a recorded order book, and fills that came in better than every real trade nearby." /></span>
          {([['all', 'All'], ['proven', 'Proven only']] as const).map(([k, l]) => <button key={k} className={`chip ${fills === k ? 'on' : ''}`} onClick={() => setFills(k)}>{l}</button>)}
        </div>
      </div>

      <div className="grid cols-4">
        <div className="card">
          <h2>Settled</h2>
          <div className="stat">{overall.n}</div>
          <div className="stat-label">{overall.won} won · {overall.lost} lost · from {overall.games} games · {open} still open</div>
        </div>
        <div className="card">
          <h2>Win rate<Tip text="How often a trade paid out, against the win rate you needed to break even. Breakeven is the average price you paid: buying at 40c needs a 40% win rate before fees." /></h2>
          <div className="stat">{n ? pct(overall.winRate) : '—'}</div>
          <div className="stat-label">breakeven {n ? pct(overall.avgPrice) : '—'}</div>
        </div>
        <div className="card">
          <h2>Profit</h2>
          <div className={`stat ${overall.pnlUsd < 0 ? 'bad' : overall.pnlUsd > 0 ? 'good' : ''}`}>{usd(overall.pnlUsd)}</div>
          <div className="stat-label">{n ? `${cents(overall.pnlPerContractC)} a contract · ${pct(overall.roi)} on cost` : 'nothing settled yet'}</div>
        </div>
        <div className="card">
          <h2>Verdict</h2>
          <div className={`stat ${VERDICT[overall.verdict].cls}`} style={{ fontSize: 18 }}>{VERDICT[overall.verdict].text}</div>
          <div className="stat-label">{overall.verdict === 'too_early' ? tooEarly : `${overall.z >= 0 ? '+' : ''}${overall.z.toFixed(1)} standard errors from breakeven`}</div>
        </div>
      </div>

      <Accuracy tickets={base} acc={acc} setAcc={setAcc} />

      <div className="card" style={{ marginTop: 14 }}>
        <h2>Recommendations</h2>
        {recommendations.length ? (
          <>
            {recommendations.map((r, i) => (
              <div key={i} className="help-term" style={{ gridTemplateColumns: '110px 1fr' }}>
                <span className={`pill ${r.kind === 'cut' ? 'live' : ''}`} style={r.kind === 'keep' ? { color: 'var(--good)', borderColor: 'rgba(0,200,83,.45)' } : undefined}>
                  {r.kind === 'cut' ? 'Cut' : 'Keep'} · {r.strength}
                </span>
                <span>{r.text}</span>
              </div>
            ))}
            <p className="small muted" style={{ marginBottom: 0 }}>These describe your own past trades, not what will happen next. Strong means the record is two or more standard errors from breakeven; leaning means one. A change you make is saved to the bot as usual and shows in amber against the measured default.</p>
          </>
        ) : (
          <p className="muted" style={{ margin: 0 }}>
            {overall.verdict === 'too_early'
              ? `No recommendations yet. Each part of your results needs ${MIN_SETTLED} settled trades from at least ${MIN_GAMES} separate games before it is judged, so a lucky or unlucky night is not mistaken for a pattern. You have ${n} settled from ${overall.games} games in this window.`
              : 'Nothing in your results is far enough from breakeven to call yet. Everything below is within what luck alone would produce.'}
          </p>
        )}
      </div>

      <div className="grid dims" style={{ marginTop: 14 }}>
        {dimensions.filter((d) => d.rows.length).map((d) => (
          <div key={d.id} className="card">
            <h2>{d.title}{d.setting && <span className="muted"> · setting: {d.setting}</span>}</h2>
            <table className="tight">
              <thead><tr><th></th><th className="num">Record</th><th className="num">Games</th><th className="num">Win</th><th className="num">Even at</th><th className="num">Per contract</th><th className="num">Profit</th><th></th></tr></thead>
              <tbody>
                {d.rows.map((r) => (
                  <tr key={r.key}>
                    <td>{r.key}</td>
                    <td className="num">{r.won}–{r.lost}</td>
                    <td className="num muted">{r.games}</td>
                    <td className="num">{pct(r.winRate)}</td>
                    <td className="num muted">{pct(r.avgPrice)}</td>
                    <td className={`num ${r.pnlPerContractC < 0 ? 'bad' : 'good'}`}>{cents(r.pnlPerContractC)}</td>
                    <td className={`num ${r.pnlUsd < 0 ? 'bad' : 'good'}`}>{usd(r.pnlUsd)}</td>
                    <td className={`small ${VERDICT[r.verdict].cls}`}>{VERDICT[r.verdict].text}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ))}
      </div>
      {!n && <p className="muted">Nothing has settled in this window yet. Results appear here as games finish and the venue settles each market.</p>}
    </>
  )
}

// Checked against Kalshi's public record by a background loop in the main
// process, separate from the code that placed and settled the trades.
function Accuracy({ tickets, acc, setAcc }: { tickets: Ticket[]; acc: AccuracyState | null; setAcc: (a: AccuracyState) => void }) {
  const [busy, setBusy] = useState(false)
  const s = acc ? summarize(tickets, acc.entries) : null
  if (!s || (!s.paperFills && !s.settled)) return null
  const row = (n: number, text: string, cls = ''): ReactNode => n ? <div className={`small ${cls}`}><b>{n}</b> {text}</div> : null
  const run = async (): Promise<void> => {
    setBusy(true)
    try { setAcc(await api.runAccuracy()) } finally { setBusy(false) }
  }

  return (
    <div className="card" style={{ marginTop: 14 }}>
      <h2>
        Is the record accurate?
        <Tip text={`Every trade is checked against Kalshi's own public record, by a separate check from the code that placed it. Settlements are compared with the market's official result. Paper fills are compared with the real trades on that market within ${PRINT_WINDOW_S / 60} minutes either side.`} />
        <span className="muted small"> · checked {ago(acc?.lastRunAt ?? null)}</span>
      </h2>
      <div className="grid cols-2">
        <div>
          <div className="stat-label" style={{ marginBottom: 6 }}>Settlements</div>
          <div className={`small ${s.settleMismatch ? 'bad' : 'good'}`}>
            <b>{s.settleChecked}</b> of {s.settled} settled trades match Kalshi's official result to the cent{s.settleMismatch ? `; ${s.settleMismatch} do not` : ''}
          </div>
          {row(s.stuckOpen, 'settled at Kalshi but still open here', 'bad')}
          {row(s.settled - s.settleChecked, 'not checked yet', 'muted')}
        </div>
        <div>
          <div className="stat-label" style={{ marginBottom: 6 }}>Paper fills ({s.paperFills})</div>
          {row(s.confirmed, 'backed by a real Kalshi trade at that price or better', 'good')}
          {row(s.bookOnly, 'filled from the live order book, with no other trade nearby to compare')}
          {row(s.unverified, 'placed before the app recorded the order book, so they cannot be proven', 'muted')}
          {row(s.betterThanMarket, 'better than every real trade nearby, so they flatter your results', 'bad')}
          {row(s.pendingFill, 'waiting to be checked', 'muted')}
        </div>
      </div>
      {s.issues.length > 0 && (
        <details style={{ marginTop: 10 }}>
          <summary className="small bad">{s.issues.length} trades to look at</summary>
          {s.issues.slice(0, 25).map((i) => <div key={i.id + i.problem} className="small" style={{ marginTop: 4 }}>{i.title}: <span className="muted">{i.problem}</span></div>)}
        </details>
      )}
      <div style={{ display: 'flex', gap: 10, alignItems: 'center', marginTop: 12 }}>
        <button className="btn" disabled={busy || acc?.running} onClick={() => void run()}>{busy || acc?.running ? 'Checking…' : 'Check now'}</button>
        <span className="small muted">Runs on its own every 10 minutes while the engine is on. The final test is a small live bot beside your paper bot, so real fills can be compared with paper fills.</span>
      </div>
    </div>
  )
}
