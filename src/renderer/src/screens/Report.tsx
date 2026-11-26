import { useEffect, useMemo, useState } from 'react'
import { dayOptions, type DayReport } from '@shared/dayreport'
import { buildReport, REPORT_KINDS, reportSubject, type ReportKind } from '@shared/report'
import type { PlayReview } from '@shared/review'
import type { AccountSettings, BotSettings } from '@shared/schema'
import { changesFromDefaults, shareCode } from '@shared/share'
import { api, usd, useEngine, type ReportContext, type Ticket } from '../api'
import { Field } from '../ui'

const MARK = { ok: '✓', look: '!', bad: '✕', info: 'i' } as const
const GROUPS = [['trade', 'Did it trade correctly'], ['play', 'Was it a sound play']] as const

export function PlayReviewCard({ review }: { review: PlayReview }) {
  return (
    <div className={`review ${review.verdict}`}>
      <div className="review-head">{review.headline}</div>
      {GROUPS.map(([group, title]) => {
        const checks = review.checks.filter((c) => c.group === group)
        return checks.length > 0 && (
          <div key={group}>
            <div className="review-group">{title}</div>
            {checks.map((c) => (
              <div key={c.title} className={`check ${c.level}`}>
                <span className="mark">{MARK[c.level]}</span>
                <span className="k">{c.title}</span>
                <span>{c.text}</span>
              </div>
            ))}
          </div>
        )
      })}
    </div>
  )
}

// The two buttons under a ledger row: check the play here, or report it.
export function PlayActions({ ticketId, onReport }: { ticketId: string; onReport: (id: string) => void }) {
  const [review, setReview] = useState<PlayReview | null>(null)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')
  const check = async (): Promise<void> => {
    setBusy(true); setErr('')
    try { setReview(await api.checkPlay(ticketId)) } catch (e) { setErr((e as Error).message) } finally { setBusy(false) }
  }
  return (
    <div style={{ marginTop: 8 }}>
      <div className="row">
        <button className="btn" disabled={busy} onClick={() => void check()}>{busy ? 'Checking…' : review ? 'Check again' : 'Check this play'}</button>
        <button className="btn" onClick={() => onReport(ticketId)}>Report this play</button>
      </div>
      {err && <div className="err" style={{ marginTop: 6 }}>{err}</div>}
      {review && <PlayReviewCard review={review} />}
    </div>
  )
}

const playLabel = (t: Ticket): string =>
  `${new Date(t.createdAt).toLocaleDateString()} · ${t.botName} · ${t.title} · ${t.side.toUpperCase()} ${t.avgFillC ?? t.limitPriceC}c · ${t.pnlUsd === null ? t.status : usd(t.pnlUsd)}`

export function Report({ ticketId, startKind }: { ticketId: string | null; startKind?: ReportKind }) {
  const engine = useEngine()
  const [ctx, setCtx] = useState<ReportContext | null>(null)
  const [account, setAccount] = useState<AccountSettings | null>(null)
  const [tickets, setTickets] = useState<Ticket[]>([])
  const [bots, setBots] = useState<BotSettings[]>([])
  const [kind, setKind] = useState<ReportKind>(ticketId ? 'play' : startKind ?? 'bug')
  const [note, setNote] = useState('')
  const [playId, setPlayId] = useState(ticketId ?? '')
  const [botId, setBotId] = useState('')
  const [withProblems, setWithProblems] = useState(true)
  const [review, setReview] = useState<PlayReview | null>(null)
  const [checking, setChecking] = useState(false)
  const [status, setStatus] = useState<{ ok: boolean; text: string } | null>(null)
  const [dayPick, setDayPick] = useState('')
  const [dayData, setDayData] = useState<Pick<DayReport, 'tickets' | 'skips'> | null>(null)

  useEffect(() => {
    void api.reportContext().then(setCtx)
    void api.account().then(setAccount)
    void api.tickets(30).then(setTickets)
    void api.bots().then(setBots)
  }, [])
  // Report this play on another ledger row lands here with that play.
  useEffect(() => { if (ticketId) { setPlayId(ticketId); setKind('play') } }, [ticketId])
  useEffect(() => { if (startKind && !ticketId) setKind(startKind) }, [startKind])

  // Days with trades, the worst first among the losing ones so the day worth
  // sending is the default.
  const days = useMemo(() => dayOptions(tickets), [tickets])
  useEffect(() => {
    if (dayPick || !days.length) return
    const losing = days.filter((d) => d.pnlUsd < 0).sort((a, b) => a.pnlUsd - b.pnlUsd)
    setDayPick((losing[0] ?? days[0])!.day)
  }, [days, dayPick])
  useEffect(() => {
    setDayData(null)
    if (kind !== 'day' || !dayPick) return
    let current = true
    void api.reportDay(dayPick).then((d) => { if (current) setDayData(d) }).catch(() => {})
    return () => { current = false }
  }, [kind, dayPick])

  const play = tickets.find((t) => t.id === playId) ?? null
  // A play brings its own bot's settings along; the user can change it.
  useEffect(() => { if (play) setBotId(play.botId) }, [play?.id])
  useEffect(() => {
    setReview(null)
    if (!playId) return
    let current = true
    setChecking(true)
    api.checkPlay(playId).then((r) => { if (current) setReview(r) }).catch(() => {}).finally(() => { if (current) setChecking(false) })
    return () => { current = false }
  }, [playId])

  const bot = bots.find((b) => b.id === botId) ?? null
  const problems = ctx?.problems ?? []
  // Every bot that traded that day, with its settings as they are now.
  const day: DayReport | undefined = kind === 'day' && dayData ? {
    day: dayPick,
    tickets: dayData.tickets,
    skips: dayData.skips,
    bots: [...new Map(dayData.tickets.map((t) => [t.botId, t.botName])).entries()].map(([id, name]) => {
      const b = bots.find((x) => x.id === id)
      if (!b) return { botId: id, botName: name, code: null, changes: 'This bot has since been deleted.' }
      const ch = changesFromDefaults(b)
      return { botId: id, botName: b.name, code: shareCode(b), changes: ch.length ? `Settings now, changed from the measured defaults: ${ch.map((c) => `${c.field} ${JSON.stringify(c.from)} to ${JSON.stringify(c.to)}`).join('; ')}` : 'Settings now: the measured defaults.' }
    })
  } : undefined
  const subject = reportSubject(kind, __APP_VERSION__, kind === 'day' ? dayPick : play?.title)
  const text = useMemo(() => !ctx ? '' : buildReport({
    kind, note, at: Date.now(),
    app: {
      version: __APP_VERSION__, os: ctx.os, engineRunning: Boolean(engine?.running),
      liveBots: engine?.limits.liveBots ?? 0, killSwitch: Boolean(account?.killSwitch), lastError: engine?.lastError ?? null
    },
    play: kind !== 'day' && play ? play : undefined,
    review: kind !== 'day' && play ? review : null,
    day,
    bot: kind !== 'day' && bot ? { name: bot.name, code: shareCode(bot), changes: changesFromDefaults(bot) } : undefined,
    problems: withProblems ? problems : []
  }), [ctx, kind, note, engine?.running, engine?.lastError, account, play, review, bot, withProblems, problems, day])

  const to = ctx?.supportEmail ?? ''
  const email = async (): Promise<void> => {
    try {
      const { full } = await api.emailReport(subject, text)
      const opened = full
        ? `Your email program should now be open with the report filled in, addressed to ${to}. Press Send there.`
        : `Your email program should now be open, addressed to ${to}. The full report is on your clipboard: click in the email, press Ctrl+V to paste it, then press Send.`
      setStatus({ ok: true, text: `${opened} If nothing opened, use Copy report or Save as file and email it yourself.` })
    } catch (e) {
      setStatus({ ok: false, text: `Your email program did not open (${(e as Error).message}). Use Copy report and email it to ${to} yourself.` })
    }
  }
  const copy = async (): Promise<void> => { await api.copy(text); setStatus({ ok: true, text: `Copied. Paste it into an email to ${to}.` }) }
  const save = async (): Promise<void> => {
    const path = await api.saveReport(text)
    if (path) setStatus({ ok: true, text: `Saved to ${path}. Attach it to an email to ${to}.` })
  }

  return (
    <>
      <h1>Report</h1>
      <p className="lede">
        Tell us about something that broke, a play that looks wrong, or an idea. You can read the whole report before it leaves, and it only leaves through your own email to {to || 'support'}. Keys, passwords and balances are never included.
      </p>

      <div className="card" style={{ marginBottom: 12 }}>
        <h2>What is it about</h2>
        <div className="chips" style={{ marginBottom: 12 }}>
          {(Object.keys(REPORT_KINDS) as ReportKind[]).map((k) => (
            <button key={k} className={`chip ${kind === k ? 'on' : ''}`} onClick={() => setKind(k)}>{REPORT_KINDS[k].label}</button>
          ))}
        </div>
        <Field label="What happened">
          <textarea value={note} placeholder={REPORT_KINDS[kind].prompt} onChange={(e) => setNote(e.target.value)} rows={5} />
        </Field>
      </div>

      {kind === 'day' ? (
      <div className="card" style={{ marginBottom: 12 }}>
        <h2>Which day</h2>
        <Field label="Trading day" hint="Days run from 4 AM to 4 AM your time. Losing days are marked; the worst one is picked for you.">
          <select value={dayPick} onChange={(e) => setDayPick(e.target.value)}>
            {!days.length && <option value="">No trades in the last 30 days</option>}
            {days.map((d) => (
              <option key={d.day} value={d.day}>
                {d.day} · {d.trades} trades · {d.settled ? usd(d.pnlUsd) : 'nothing settled'}{d.pnlUsd < 0 ? ' · losing day' : ''}{d.live ? ' · live money' : ' · paper'}
              </option>
            ))}
          </select>
        </Field>
        <p className="small muted" style={{ marginTop: 8 }}>
          The report holds every trade that day, what each bot made or lost by sport, lane and label, how many plays it passed on and why, and each bot's settings as a share code, so the team can replay the day and suggest changes. It never holds keys, passwords or balances.
        </p>
      </div>
      ) : (
      <div className="card" style={{ marginBottom: 12 }}>
        <h2>Attach</h2>
        <div className="grid cols-2">
          <Field label="A play from the ledger" hint={kind === 'play' && !play ? 'Pick the play so its details and its check go with the report.' : 'Last 30 days. The play is checked as soon as you pick it.'}>
            <select value={playId} onChange={(e) => setPlayId(e.target.value)}>
              <option value="">None</option>
              {tickets.slice(0, 200).map((t) => <option key={t.id} value={t.id}>{playLabel(t)}</option>)}
            </select>
          </Field>
          <Field label="A bot's settings" hint="Its share code: settings only, never trades, balances or keys.">
            <select value={botId} onChange={(e) => setBotId(e.target.value)}>
              <option value="">None</option>
              {bots.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
            </select>
          </Field>
        </div>
        <label className="row small" style={{ marginTop: 12, gap: 8 }}>
          <input type="checkbox" checked={withProblems} onChange={(e) => setWithProblems(e.target.checked)} />
          Include recent problems from this session ({problems.length})
        </label>
        {play && (checking ? <p className="muted small">Checking the play…</p> : review && <PlayReviewCard review={review} />)}
      </div>
      )}

      <div className="card">
        <h2>Send</h2>
        <div className="row wrap">
          <button className="btn primary" disabled={!ctx} onClick={() => void email()}>Email report</button>
          <button className="btn" disabled={!ctx} onClick={() => void copy()}>Copy report</button>
          <button className="btn" disabled={!ctx} onClick={() => void save()}>Save as file</button>
          <span className="muted small">Opens your own email program. Nothing is sent until you press Send there.</span>
        </div>
        {status && <div className={`note ${status.ok ? '' : 'bad'}`} style={{ marginTop: 12 }}>{status.text}</div>}
        <details style={{ marginTop: 12 }}>
          <summary>See the whole report</summary>
          <pre className="report-preview">{text}</pre>
        </details>
      </div>
    </>
  )
}
