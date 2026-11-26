import { useEffect, useState } from 'react'
import type { DeskRec } from '@shared/desk'
import { fixText } from '@shared/fixes'
import { TRIAL_MIN_SETTLED } from '@shared/trials'
import { ago, api, usd, useDesk, type AiChange } from '../api'
import { GATES } from '../glossary'
import { Tip } from '../ui'
import { AskBody } from '../Ask'

const PROVIDER = { anthropic: 'Claude', openai: 'OpenAI', xai: 'Grok', ollama: 'Ollama' } as const
const LEVEL: Record<DeskRec['level'], { text: string; cls: string }> = {
  act: { text: 'Do this', cls: 'live' },
  watch: { text: 'Watch', cls: '' },
  info: { text: 'Good to know', cls: '' }
}

const actionText = (r: DeskRec): string | null =>
  !r.action ? null : r.action.kind === 'pause' ? `Pause ${r.botName ?? 'this bot'}` : fixText(r.action.fix)

// Ask Lazy Edge, the same assistant as the header button, here on the Desk.
// It can draft a change; nothing is saved until Apply.
function Chat({ enabled }: { enabled: boolean }) {
  return (
    <div className="card">
      <h2>Ask Lazy Edge<Tip text="Ask anything about your bots and results, such as how props did in the 3rd quarter this week or why a bot lost tonight. It looks up what it needs and can draft a change for you to apply; it never changes your money settings. The Ask Lazy Edge button at the top opens the same chat on every screen." /></h2>
      {!enabled ? <p className="small muted">Add an AI key on the Keys screen to ask questions.</p> : <AskBody compact />}
    </div>
  )
}

export function Desk() {
  const [desk, setDesk] = useDesk()
  const [busy, setBusy] = useState<string | null>(null)
  const [err, setErr] = useState('')
  const [showDone, setShowDone] = useState(false)
  const [changes, setChanges] = useState<AiChange[]>([])
  useEffect(() => { void api.aiChanges().then(setChanges).catch(() => {}) }, [desk?.recs.length, showDone])

  const run = async (key: string, fn: () => Promise<Parameters<typeof setDesk>[0]>): Promise<void> => {
    setBusy(key); setErr('')
    try { setDesk(await fn()) } catch (e) { if ((e as Error).message !== 'Cancelled.') setErr((e as Error).message) } finally { setBusy(null) }
  }

  if (!desk) return <><h1>Desk</h1><p className="muted">Loading…</p></>
  // Do this first, then watch, then good to know; newest first within each.
  const rank = { act: 0, watch: 1, info: 2 } as const
  const open = desk.recs.filter((r) => r.status === 'new').sort((a, z) => rank[a.level] - rank[z.level] || z.at - a.at)
  const done = desk.recs.filter((r) => r.status !== 'new').slice(0, 40)
  const snap = desk.snapshot

  return (
    <>
      <h1>Desk</h1>
      <p className="lede">Watches every bot, every open position and your graded record, and says what to change. Plain checks run every two minutes while the engine runs; your AI reads the whole picture every ten minutes during live games, and learns from how its earlier suggestions turned out. Nothing changes until you press Apply, and it can only pause a bot or narrow what one trades. Money, stakes and live trading stay yours.</p>

      <div className="grid cols-3">
        <div className="card">
          <h2>AI<Tip text="The desk uses the first AI key you have set, Claude first. Without one the plain checks still run." /></h2>
          <div className="stat" style={{ fontSize: 18 }}>{desk.provider ? `${PROVIDER[desk.provider]} ${desk.aiOn ? 'watching' : 'off'}` : 'No AI key'}</div>
          <div className="stat-label">{desk.aiBusy ? 'reading now…' : `last read ${ago(desk.lastAiAt)}`}</div>
          <div className="row" style={{ marginTop: 10 }}>
            <button className="btn primary" disabled={busy !== null || desk.aiBusy} onClick={() => run('ask', api.deskAsk)}>{desk.aiBusy || busy === 'ask' ? 'Reading…' : 'Ask now'}</button>
            {desk.provider && <button className="btn ghost" disabled={busy !== null} onClick={() => run('ai', () => api.deskAi(!desk.aiOn))}>{desk.aiOn ? 'Stop the AI' : 'Let the AI watch'}</button>}
          </div>
          {desk.aiError && <p className="err small">{desk.aiError}</p>}
        </div>
        <div className="card">
          <h2>Tonight</h2>
          <div className="stat">{snap ? snap.liveGames : '—'}</div>
          <div className="stat-label">live games · {snap ? snap.holdings.length : 0} open positions · checked {ago(desk.lastRulesAt)}</div>
        </div>
        <div className="card">
          <h2>Bots on today</h2>
          <div className="stat">{snap ? snap.bots.filter((b) => b.enabled).length : '—'}</div>
          <div className="stat-label">{snap ? `${usd(snap.bots.reduce((n, b) => n + b.today.pnlUsd, 0))} settled today across all bots` : 'press Start engine to begin'}</div>
        </div>
      </div>

      {err && <p className="err">{err}</p>}

      <div className="card" style={{ marginTop: 14 }}>
        <h2>Suggestions</h2>
        {open.length ? open.map((r) => (
          <div key={r.id} className="help-term" style={{ gridTemplateColumns: '120px 1fr auto' }}>
            <span className={`pill ${LEVEL[r.level].cls}`}>{LEVEL[r.level].text}{r.source === 'ai' ? ' · AI' : ''}</span>
            <span>
              <strong>{r.title}</strong><br />
              <span className="small">{r.why}{r.gate ? ` The check: ${GATES[r.gate] ?? r.gate}.` : ''}</span><br />
              <span className="small muted">{ago(r.at)}</span>
            </span>
            <span className="row" style={{ alignItems: 'start' }}>
              {r.trialId ? <span className="pill hot">On paper trial</span> : <>
                {r.action && <button className="btn primary" disabled={busy !== null} title={actionText(r) ?? ''} onClick={() => run(r.id, () => api.deskApply(r.id))}>{actionText(r)}</button>}
                {r.action?.kind === 'fix' && <button className="btn ghost" disabled={busy !== null} title="Runs this change on a paper copy beside the bot, so you can compare before it touches the bot." onClick={() => run(r.id, async () => { await api.trialStart(r.id); return api.desk() })}>Try in paper first</button>}
                <button className="btn ghost" disabled={busy !== null} onClick={() => run(r.id, () => api.deskDismiss(r.id))}>Dismiss</button>
              </>}
            </span>
          </div>
        )) : <p className="muted" style={{ marginBottom: 0 }}>Nothing needs doing right now. The desk speaks up when a bot keeps losing, stops trading, holds a play our number has turned against, or when your graded record shows a setting costing money.</p>}
      </div>

      {desk.trials.length > 0 && (
        <div className="card" style={{ marginTop: 14 }}>
          <h2>Paper trials<Tip text="Each trial runs one change on a paper copy beside the real bot. Both records count from the moment the trial began, per contract, so a live bot and a paper copy compare fairly. Accept moves the change onto the bot; Drop ends the trial and the bot keeps its settings." /></h2>
          {desk.trials.map((t) => (
            <div key={t.trialId} className="help-term" style={{ gridTemplateColumns: '1fr auto' }}>
              <span>
                <strong>{t.ofName}: {t.what}</strong><br />
                <span className="small">The bot: {t.original.won} won, {t.original.lost} lost, {t.original.centsPerContract}c a contract. The change: {t.trial.won} won, {t.trial.lost} lost, {t.trial.centsPerContract}c a contract.</span><br />
                <span className="small muted">{t.verdict ?? `Early: ${t.trial.trades} of ${TRIAL_MIN_SETTLED} settled trades on the trial so far, started ${ago(t.startedAt)}.`}</span>
              </span>
              <span className="row" style={{ alignItems: 'start' }}>
                <button className={`btn ${t.ready ? 'primary' : 'ghost'}`} disabled={busy !== null} onClick={() => run(t.trialId, () => api.trialAccept(t.trialId))}>Accept</button>
                <button className="btn ghost" disabled={busy !== null} onClick={() => run(t.trialId, () => api.trialDrop(t.trialId))}>Drop</button>
              </span>
            </div>
          ))}
        </div>
      )}

      <div className="grid cols-2" style={{ marginTop: 14 }}>
        <div className="card">
          <h2>Tonight's recap<Tip text="Written once the night's last live game ends, or when you ask. With an AI key it reads like a note from the desk; without one it is the plain numbers." /></h2>
          {desk.recap ? <>
            <p className="small muted" style={{ marginTop: 0 }}>{desk.recap.day} · {desk.recap.by === 'ai' ? 'by your AI' : 'from the numbers'} · {ago(desk.recap.at)}</p>
            <div className="small" style={{ whiteSpace: 'pre-wrap' }}>{desk.recap.text}</div>
          </> : <p className="small muted">The recap writes itself when tonight's games are over.</p>}
          <button className="btn ghost" style={{ marginTop: 10 }} disabled={busy !== null || desk.recapBusy} onClick={() => run('recap', api.deskRecap)}>{desk.recapBusy ? 'Writing…' : desk.recap ? 'Write it again' : 'Write it now'}</button>
        </div>
        <Chat enabled={Boolean(desk.provider)} />
      </div>

      {desk.patterns.length > 0 && (
        <div className="card" style={{ marginTop: 14 }}>
          <h2>Patterns in your record<Tip text="Losing spots come first: they tell more than wins. Inside each bot, every part of its record, the quarter, the time left, the score, our chance, the price and for a prop how far the player was from the line, is compared with the rest of the same bot's trades, so the settings are the same and only the spot differs. Proven means at least 20 trades across 20 games, two standard errors clear; early means fewer. A losing spot can be left out, or tried in paper first; a winning spot across your record can start a paper bot." /></h2>
          {desk.patterns.map((p) => (
            <div key={p.key} className="help-term" style={{ gridTemplateColumns: '120px 1fr auto' }}>
              <span className={`pill ${p.kind === 'losing' ? 'live' : 'hot'}`}>{p.kind === 'losing' ? 'Losing' : 'Winning'} · {p.strength}</span>
              <span>
                <strong>{p.title}</strong><br />
                <span className="small">{p.won} won, {p.lost} lost, {p.centsPerContract >= 0 ? '+' : ''}{p.centsPerContract}c a contract over {p.n} trades in {p.games} games{p.rest ? `; the rest of its trades ${p.rest.centsPerContract >= 0 ? '+' : ''}${p.rest.centsPerContract}c over ${p.rest.n}` : ''}.</span>
                {p.fix && <><br /><span className="small muted">The fix: {fixText(p.fix)}.</span></>}
              </span>
              <span className="row" style={{ alignItems: 'start' }}>
                {p.fix && <button className="btn primary" disabled={busy !== null} onClick={() => run(p.key, () => api.patternFix(p.key))}>Leave it out</button>}
                {p.fix && <button className="btn ghost" disabled={busy !== null} title="Runs the fix on a paper copy beside the bot, so you can compare before it touches the bot." onClick={() => run(`${p.key}:trial`, () => api.patternTrial(p.key))}>Try in paper first</button>}
                {p.build && <button className="btn ghost" disabled={busy !== null} title="Makes a paper bot that trades only this pattern, a flat $5, switched on." onClick={() => run(p.key, async () => { await api.patternBot(p.key); return api.desk() })}>Start a paper bot</button>}
              </span>
            </div>
          ))}
        </div>
      )}

      {snap && snap.bots.some((b) => b.enabled || b.today.trades) && (
        <div className="card" style={{ marginTop: 14 }}>
          <h2>Every bot today</h2>
          <table>
            <thead><tr><th>Bot</th><th>Today</th><th>Settled</th><th>Open</th><th>Stopped most by</th><th>Last 30 days</th></tr></thead>
            <tbody>
              {snap.bots.filter((b) => b.enabled || b.today.trades).map((b) => (
                <tr key={b.botId}>
                  <td title={b.rules}>{b.name}<span className="small muted"> · {b.enabled ? b.mode : 'off'}</span></td>
                  <td>{b.today.won} won, {b.today.lost} lost</td>
                  <td className={b.today.pnlUsd < 0 ? 'bad' : b.today.pnlUsd > 0 ? 'good' : ''}>{usd(b.today.pnlUsd)}</td>
                  <td>{b.today.open}</td>
                  <td className="small">{b.blockedBy[0] ? `${GATES[b.blockedBy[0].gate] ?? b.blockedBy[0].gate} (${b.blockedBy[0].plays} of ${b.playsSeen})` : '—'}</td>
                  <td className="small">{b.record30.trades ? `${b.record30.won} won, ${b.record30.lost} lost, ${usd(b.record30.pnlUsd)} over ${b.record30.games} ${b.record30.games === 1 ? 'game' : 'games'}` : 'nothing settled'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {done.length > 0 && (
        <div className="card" style={{ marginTop: 14 }}>
          <h2 style={{ cursor: 'pointer' }} onClick={() => setShowDone(!showDone)}>Done ({done.length}) {showDone ? '▾' : '▸'}</h2>
          {showDone && done.map((r) => {
            const change = r.changeId ? changes.find((c) => c.id === r.changeId) : undefined
            return (
              <div key={r.id} className="help-term" style={{ gridTemplateColumns: '120px 1fr auto' }}>
                <span className="pill">{change?.undoneAt ? 'Put back' : r.status === 'applied' ? 'Applied' : 'Dismissed'}</span>
                <span className="small">{r.title}{r.status === 'applied' && actionText(r) ? `: ${actionText(r)}` : ''} <span className="muted">· {ago(r.doneAt ?? r.at)}</span></span>
                {change && !change.undoneAt
                  ? <button className="btn ghost" disabled={busy !== null} onClick={() => run(r.id, async () => { setChanges(await api.aiUndo(change.id)); return api.desk() })}>Put it back</button>
                  : <span />}
              </div>
            )
          })}
          {showDone && <p className="small muted" style={{ marginBottom: 0 }}>The AI reads how each of these turned out, the bot's settled trades after you applied or dismissed it, and suggests more of what worked. Every apply is in the ledger and can be put back here.</p>}
        </div>
      )}
    </>
  )
}
