import { Fragment, useEffect, useState } from 'react'
import { api, usd, type Ticket } from '../api'
import { PlayActions } from './Report'

export function Ledger({ onReport }: { onReport: (ticketId: string) => void }) {
  const [days, setDays] = useState(7)
  const [tickets, setTickets] = useState<Ticket[]>([])
  const [open, setOpen] = useState<string | null>(null)

  useEffect(() => {
    void api.tickets(days).then(setTickets)
    return window.lazyedge.on('ticket', () => void api.tickets(days).then(setTickets))
  }, [days])

  const settled = tickets.filter((t) => t.pnlUsd !== null)
  const total = settled.reduce((s, t) => s + (t.pnlUsd ?? 0), 0)
  const wins = settled.filter((t) => (t.pnlUsd ?? 0) > 0).length

  return (
    <>
      <h1>Ledger</h1>
      <p className="lede">Every ticket, append only. Fills and settlements are read back from the venue's own record. Click a row for the full audit trail, to check the play against Kalshi and the bot's rules, or to report it.</p>
      <div className="row" style={{ marginBottom: 12 }}>
        <select value={days} onChange={(e) => setDays(Number(e.target.value))} style={{ width: 160 }}>
          {[1, 7, 30, 90].map((d) => <option key={d} value={d}>Last {d} day{d > 1 ? 's' : ''}</option>)}
        </select>
        <span className="muted small">{tickets.length} tickets · {settled.length} settled · {wins} won · net <span className={total < 0 ? 'bad' : 'good'}>{usd(total)}</span></span>
      </div>
      <div className="card">
        <table>
          <thead>
            <tr><th>When</th><th>Bot</th><th>Signal</th><th>Venue</th><th>Side</th><th className="num">Qty</th><th className="num">Price</th><th className="num">Cost</th><th className="num">EV</th><th>Status</th><th className="num">P&amp;L</th></tr>
          </thead>
          <tbody>
            {tickets.map((t) => (
              <Fragment key={t.id}>
                <tr onClick={() => setOpen(open === t.id ? null : t.id)} style={{ cursor: 'pointer' }}>
                  <td className="mono small muted">{new Date(t.createdAt).toLocaleString()}</td>
                  <td>{t.botName}</td>
                  <td>{t.title}</td>
                  <td className="small">{t.venue}{t.venue === 'paper' && <span className="muted"> ({t.priceSource})</span>}</td>
                  <td className="mono">{t.side.toUpperCase()}</td>
                  <td className="num">{t.filledContracts}/{t.contracts}</td>
                  <td className="num">{t.avgFillC ?? t.limitPriceC}c</td>
                  <td className="num">{usd(t.costUsd)}</td>
                  <td className="num">{t.evCents.toFixed(1)}c</td>
                  <td className={`small ${t.status === 'rejected' ? 'bad' : ''}`}>{t.status}</td>
                  <td className={`num ${(t.pnlUsd ?? 0) < 0 ? 'bad' : t.pnlUsd ? 'good' : ''}`}>{usd(t.pnlUsd)}</td>
                </tr>
                {open === t.id && (
                  <tr>
                    <td colSpan={11} className="small">
                      <div className="mono muted">{t.contract}</div>
                      {t.why && <div>{t.why}</div>}
                      <ul style={{ margin: '6px 0' }}>{t.audit.map((a, i) => <li key={i} className="muted">{a}</li>)}</ul>
                      {t.error && <div className="err">{t.error}</div>}
                      <div className="muted">fee {usd(t.feeUsd)}</div>
                      <PlayActions ticketId={t.id} onReport={onReport} />
                    </td>
                  </tr>
                )}
              </Fragment>
            ))}
          </tbody>
        </table>
        {!tickets.length && <p className="muted">No tickets in this window.</p>}
      </div>
    </>
  )
}
