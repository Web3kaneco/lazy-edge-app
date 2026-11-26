import { useState } from 'react'
import { api, useDesk, type ChatProposal } from './api'

// Ask Lazy Edge (2026-11-21: "an overall chat bot in the app"). One
// assistant on every screen that looks up what a question needs: the app's
// state, each bot's settings, the audit, today's activity, the board, the
// Lazy Edge data and the user's own record. It can draft a settings change;
// nothing is saved until the user presses Apply, which goes through the same
// confirmation levels as the AI box, and money settings are never changed.

const STARTERS = [
  'Is everything set up the way I mean it?',
  'Why has nothing traded today?',
  'What did my bots do today?',
  'Which of my bots is losing, and where?'
]

const LEVEL = {
  1: { text: 'Paper bot', cls: '' },
  2: { text: 'Live bot, trades less', cls: 'hot' },
  3: { text: 'Live bot, trades more', cls: 'live' }
} as const

type Entry = { q: string; a: string; proposals: ChatProposal[] }
type Outcome = { kind: 'saved'; changeId: string | null } | { kind: 'trial' } | { kind: 'dropped' } | { kind: 'undone' }

export function Proposal({ p }: { p: ChatProposal }) {
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')
  const [done, setDone] = useState<Outcome | null>(null)
  const act = async (fn: () => Promise<Outcome>): Promise<void> => {
    setBusy(true); setErr('')
    try { setDone(await fn()) } catch (e) { if ((e as Error).message !== 'Cancelled.') setErr((e as Error).message) } finally { setBusy(false) }
  }
  return (
    <div className="ask-proposal">
      <div className="row" style={{ gap: 8, alignItems: 'center' }}>
        <b>{p.botName}</b>
        <span className={`pill ${LEVEL[p.level].cls}`}>{LEVEL[p.level].text}</span>
      </div>
      <table className="small" style={{ width: '100%', margin: '6px 0' }}>
        <tbody>
          {p.changes.map((c) => (
            <tr key={c.field}><td className="muted">{c.name}</td><td>{c.from}</td><td className="muted">to</td><td><b>{c.to}</b></td></tr>
          ))}
        </tbody>
      </table>
      {p.explanation && <p className="small" style={{ margin: '4px 0' }}>{p.explanation}</p>}
      {p.unsupported.length > 0 && <p className="small warn" style={{ margin: '4px 0' }}>Not done: {p.unsupported.join('; ')}</p>}
      {!done ? (
        <div className="row" style={{ gap: 6 }}>
          <button className="btn primary" disabled={busy} onClick={() => void act(async () => ({ kind: 'saved', changeId: (await api.chatApply(p.id)).changeId }))}>Apply</button>
          <button className="btn" disabled={busy} onClick={() => void act(async () => { await api.chatTrial(p.id); return { kind: 'trial' } })} title="Runs a paper copy with this change beside the bot, so you can compare before you change the bot itself.">Try in paper</button>
          <button className="btn ghost" disabled={busy} onClick={() => setDone({ kind: 'dropped' })}>Leave it</button>
        </div>
      ) : done.kind === 'saved' ? (
        <div className="row small" style={{ gap: 8, alignItems: 'center' }}>
          <span className="good">Saved to {p.botName}.</span>
          {done.changeId && <button className="btn ghost" disabled={busy} onClick={() => void act(async () => { await api.aiUndo(done.changeId!); return { kind: 'undone' } })}>Put it back</button>}
        </div>
      ) : (
        <p className="small muted" style={{ margin: 0 }}>{done.kind === 'trial' ? `A paper trial of ${p.botName} is running; see the Desk.` : done.kind === 'undone' ? 'Put back as it was.' : 'Left as it is.'}</p>
      )}
      {err && <p className="err small">{err}</p>}
    </div>
  )
}

// The chat itself: questions, answers, and any drafted changes under them.
export function AskBody({ compact = false }: { compact?: boolean }) {
  const [desk] = useDesk()
  const [q, setQ] = useState('')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')
  const [log, setLog] = useState<Entry[]>([])
  const ask = async (text?: string): Promise<void> => {
    const question = (text ?? q).trim()
    if (!question || busy) return
    setBusy(true); setErr('')
    try {
      const r = await api.deskChat(question, log.map((x) => ({ q: x.q, a: x.a })))
      setLog([...log, { q: question, a: r.answer, proposals: r.proposals }].slice(-8)); setQ('')
    } catch (e) { setErr((e as Error).message) } finally { setBusy(false) }
  }
  if (desk && !desk.provider) return <p className="small muted">Add an AI key on the Keys screen to ask Lazy Edge questions.</p>
  return (
    <div className="ask-body">
      <div className="ask-log">
        {!log.length && (
          <div className="small muted">
            <p style={{ marginTop: 0 }}>Ask about anything in the app: whether your bots are set up the way you mean, why a bot did or did not trade, how a spot has gone for you, or what a play is worth. It looks things up and can draft a change for you to apply. It never changes your money settings or paper and live.</p>
            {!compact && <div className="ask-starters">{STARTERS.map((s) => <button key={s} className="btn ghost small" disabled={busy} onClick={() => void ask(s)}>{s}</button>)}</div>}
          </div>
        )}
        {log.map((x, i) => (
          <div key={i} className="ask-entry">
            <div className="ask-q">{x.q}</div>
            <div className="ask-a">{x.a}</div>
            {x.proposals.map((p) => <Proposal key={p.id} p={p} />)}
          </div>
        ))}
        {busy && <p className="small muted">Looking it up…</p>}
      </div>
      <div className="row" style={{ gap: 6 }}>
        <input type="text" placeholder="Is everything set up the way I mean it?" value={q} onChange={(e) => setQ(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') void ask() }} style={{ flex: 1 }} />
        <button className="btn primary" disabled={busy || !q.trim()} onClick={() => void ask()}>{busy ? 'Reading…' : 'Ask'}</button>
      </div>
      {err && <p className="err small">{err}</p>}
    </div>
  )
}

// The side panel, open from the header on every screen. It stays mounted
// while closed so the conversation is still there when it opens again.
export function AskPanel({ open, onClose }: { open: boolean; onClose: () => void }) {
  return (
    <aside className={`ask-panel ${open ? 'open' : ''}`} aria-hidden={!open}>
      <div className="row" style={{ alignItems: 'center', marginBottom: 8 }}>
        <h2 style={{ margin: 0 }}>Ask Lazy Edge</h2>
        <span className="grow" />
        <button className="btn ghost" onClick={onClose}>Close</button>
      </div>
      <AskBody />
    </aside>
  )
}
