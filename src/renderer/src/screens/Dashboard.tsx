import { useEffect, useState } from 'react'
import { ago, api, usd, type EngineState, type Ticket } from '../api'

export function Dashboard({ engine }: { engine: EngineState | null }) {
  const [tickets, setTickets] = useState<Ticket[]>([])
  useEffect(() => {
    void api.tickets(1).then(setTickets)
    return window.lazyedge.on('ticket', () => void api.tickets(1).then(setTickets))
  }, [])

  const day = new Date().toISOString().slice(0, 10)
  const todays = tickets.filter((t) => new Date(t.createdAt).toISOString().slice(0, 10) === day)
  const pnl = (venue: (v: string) => boolean): number => todays.filter((t) => venue(t.venue)).reduce((s, t) => s + (t.pnlUsd ?? 0), 0)
  const open = tickets.filter((t) => t.pnlUsd === null && ['resting', 'filled', 'partial'].includes(t.status))

  return (
    <>
      <h1>Dashboard</h1>
      <p className="lede">What every bot did and why. A skip names the gate that stopped it, so a quiet night always has a reason you can read.</p>

      <div className="grid cols-4">
        {(['paper', 'kalshi', 'polymarket'] as const).map((v) => {
          // The headline is the account's total value; the line under it splits
          // that into spendable cash and money sitting in open trades.
          const s = engine?.venues[v]
          const inTrades = s?.equityUsd != null && s.balanceUsd != null ? s.equityUsd - s.balanceUsd : null
          return (
            <div className="card" key={v}>
              <h2>{v === 'paper' ? 'Paper (practice money)' : `${v} (real money)`}</h2>
              <div className="stat">{s?.configured === false ? <span className="muted small">not connected</span> : usd(s?.equityUsd)}</div>
              {s?.configured !== false && s?.equityUsd != null && (
                <div className="stat-label has-tip" data-tip={v === 'paper'
                  ? 'Total is cash plus what your open paper trades cost. Open trades count at cost until they settle.'
                  : `Total is cash plus your open ${v} positions at their current value, as ${v} reports it.`}>
                  total · cash {usd(s?.balanceUsd)} · in open trades {usd(inTrades)}
                </div>
              )}
            </div>
          )
        })}
        <div className="card">
          <h2>Today's profit</h2>
          <div className={`stat ${pnl((v) => v !== 'paper') < 0 ? 'bad' : ''}`}>{usd(pnl((v) => v !== 'paper'))}</div>
          <div className="stat-label">real money, settled · paper {usd(pnl((v) => v === 'paper'))} · {open.length} trades still open</div>
        </div>
      </div>

      <div className="card" style={{ marginTop: 14 }}>
        <h2>Decisions <span className="muted small">· {engine?.signals ?? 0} signals last cycle · {ago(engine?.lastCycleAt ?? null)}</span></h2>
        {!engine?.recent.length ? (
          <p className="muted">Nothing yet. Create a bot, switch it on, and start the engine.</p>
        ) : (
          <table>
            <thead><tr><th>When</th><th>Bot</th><th>Signal</th><th>Outcome</th><th>Detail</th></tr></thead>
            <tbody>
              {engine.recent.slice(0, 80).map((r, i) => (
                <tr key={i}>
                  <td className="mono small muted">{new Date(r.at).toLocaleTimeString()}</td>
                  <td>{r.botName}</td>
                  <td>{r.title}</td>
                  <td className={`mono small ${r.outcome.startsWith('skip') || r.outcome === 'cancelled' ? 'muted' : r.outcome === 'rejected' || r.outcome.endsWith('error') || r.outcome.endsWith('failed') ? 'bad' : 'good'}`}>{r.outcome}</td>
                  <td className="small muted">{r.detail}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </>
  )
}
