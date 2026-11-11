import { useEffect, useState } from 'react'
import { tradingDay } from '@shared/day'
import { heldNote } from '@shared/limits'
import type { AccountSettings, BotSettings } from '@shared/schema'
import { ago, api, usd, type EngineState, type Ticket } from '../api'
import { Tip } from '../ui'

export function Dashboard({ engine }: { engine: EngineState | null }) {
  const [tickets, setTickets] = useState<Ticket[]>([])
  const [account, setAccount] = useState<AccountSettings | null>(null)
  const [bots, setBots] = useState<BotSettings[]>([])
  useEffect(() => {
    // Two days, so a trading day that started before yesterday's 4 AM is whole.
    void api.tickets(2).then(setTickets)
    return window.lazyedge.on('ticket', () => void api.tickets(2).then(setTickets))
  }, [])
  // The notes quote the settings, so they follow any change made elsewhere.
  useEffect(() => {
    void api.account().then(setAccount)
    void api.bots().then(setBots)
  }, [engine?.lastCycleAt, engine?.limits.capUsd])

  const day = tradingDay()
  const todays = tickets.filter((t) => tradingDay(t.createdAt) === day)
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
          <div className="stat-label has-tip" data-tip="The trading day runs from 4 AM to 4 AM your time, so a late game counts with the night it started.">real money, settled since 4 AM · paper {usd(pnl((v) => v === 'paper'))} · {open.length} trades still open</div>
        </div>
      </div>

      {engine && account && <InPlay limits={engine.limits} account={account} bots={bots} />}

      <div className="card" style={{ marginTop: 14 }}>
        <h2>Decisions<span className="muted small">· {engine?.signals ?? 0} signals last cycle · {ago(engine?.lastCycleAt ?? null)}</span></h2>
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

// How much real money is open against the account limit, and every play a
// limit held back today with the setting that did it.
function InPlay({ limits: l, account, bots }: { limits: EngineState['limits']; account: AccountSettings; bots: BotSettings[] }) {
  const share = l.capUsd > 0 ? Math.min(l.openLiveUsd / l.capUsd, 1) : 1
  const live = l.liveBots > 0 || l.openLiveUsd > 0
  return (
    <div className="card" style={{ marginTop: 14 }}>
      <h2>Money in play<Tip text="Real money in open trades across every live bot, against the Maximum open exposure on the Account screen. That limit, not the number of trades, is what caps how much is in play. Trades free their money when they settle." /></h2>
      {live ? (
        <>
          <div className={`meter ${share >= 0.9 ? 'full' : ''}`}><div style={{ width: `${share * 100}%` }} /></div>
          <div className="stat-label">
            {usd(l.openLiveUsd)} of {usd(l.capUsd)} open across live bots · {usd(Math.max(l.capUsd - l.openLiveUsd, 0))} free
            {l.dryRun ? ' · dry run is on, so no new real trades open' : ''}
          </div>
        </>
      ) : (
        <p className="small muted" style={{ margin: 0 }}>No live bot is switched on. Paper bots trade practice money, so the account limit does not apply to them.</p>
      )}
      {l.held.length > 0 ? (
        <div className="grid" style={{ marginTop: 12, gap: 8 }}>
          {l.held.map((h) => (
            <div key={`${h.botId}|${h.gate}`} className="note warn small">{heldNote(h, account, bots.find((b) => b.id === h.botId))}</div>
          ))}
        </div>
      ) : (
        <p className="small muted" style={{ margin: '10px 0 0' }}>No limit has held a play back today.</p>
      )}
    </div>
  )
}
