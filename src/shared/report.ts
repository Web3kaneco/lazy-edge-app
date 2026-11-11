// A report a tester sends about a bug, a play that looks wrong, or an idea.
// Plain text the user reads in full before it leaves, and it only leaves
// through their own email. It carries what the app shows on screen: a play,
// its check, a bot's share code. Never a key, a balance or a sign in.
import type { PlayReview } from './review'
import type { Change } from './share'

export type ReportKind = 'bug' | 'play' | 'idea'

export const REPORT_KINDS: Record<ReportKind, { label: string; subject: string; prompt: string }> = {
  bug: { label: 'Something broke', subject: 'Bug report', prompt: 'What were you doing, what did you expect, and what happened instead?' },
  play: { label: 'A play looks wrong', subject: 'Play report', prompt: 'What looks wrong about this play? For example the price, the result, or why the bot took it.' },
  idea: { label: 'An idea', subject: 'Idea', prompt: 'What would make Lazy Edge better for you?' }
}

export interface ReportPlay {
  id: string
  title: string
  botName: string
  venue: string
  priceSource: string
  contract: string
  side: 'yes' | 'no'
  contracts: number
  filledContracts: number
  limitPriceC: number
  avgFillC: number | null
  costUsd: number
  feeUsd: number
  evCents: number
  status: string
  pnlUsd: number | null
  createdAt: number
  why: string | null
  audit: string[]
  error: string | null
}

export interface ReportInput {
  kind: ReportKind
  note: string
  at: number
  app: {
    version: string
    os: string
    engineRunning: boolean
    executionMode: string
    killSwitch: boolean
    lastError: string | null
  }
  play?: ReportPlay
  review?: PlayReview | null
  bot?: { name: string; code: string; changes: Change[] }
  problems?: { at: number; botName: string; title: string; outcome: string; detail: string }[]
}

// Anything longer than this is cut, so a report always fits the clipboard.
export const REPORT_MAX = 20_000
// Email programs on Windows cut a mailto link somewhere past 2,000 characters.
export const MAILTO_MAX = 1_900
const PASTE_NOTE = 'Your full Lazy Edge report is on your clipboard. Click on the empty line below, press Ctrl+V to paste it, then press Send.\n\n'

const money = (n: number | null): string => n === null ? 'open' : `${n < 0 ? '-' : ''}$${Math.abs(n).toFixed(2)}`
const when = (t: number): string => new Date(t).toLocaleString()
const MARK = { ok: 'OK  ', look: 'LOOK', bad: 'BAD ', info: 'NOTE' } as const

export function reportSubject(kind: ReportKind, version: string, playTitle?: string): string {
  return `Lazy Edge ${version} ${REPORT_KINDS[kind].subject}${playTitle ? `: ${playTitle}` : ''}`.slice(0, 160)
}

export function buildReport(r: ReportInput): string {
  const out: string[] = []
  const section = (title: string): void => { out.push('', title.toUpperCase()) }
  out.push('LAZY EDGE REPORT', `Kind: ${REPORT_KINDS[r.kind].label}`, `Written: ${when(r.at)}`)

  section('What happened')
  out.push(r.note.trim() || '(nothing written)')

  section('App')
  out.push(`Version ${r.app.version} on ${r.app.os}`)
  out.push(`Engine ${r.app.engineRunning ? 'running' : 'stopped'}, ${r.app.executionMode === 'live' ? 'live money' : 'dry run'}, kill switch ${r.app.killSwitch ? 'on' : 'off'}`)
  if (r.app.lastError) out.push(`Last error: ${r.app.lastError}`)

  if (r.play) {
    const p = r.play
    section('The play')
    out.push(`${p.title}, bot ${p.botName}`)
    out.push(`${p.venue}${p.venue === 'paper' ? ` priced off ${p.priceSource}` : ''}, ${p.side.toUpperCase()} ${p.filledContracts} of ${p.contracts} at ${p.avgFillC ?? '-'}c (limit ${p.limitPriceC}c)`)
    out.push(`Cost ${money(p.costUsd)}, fee ${money(p.feeUsd)}, EV ${p.evCents.toFixed(1)}c, status ${p.status}, P&L ${money(p.pnlUsd)}`)
    out.push(`Contract ${p.contract}, placed ${when(p.createdAt)}, ticket ${p.id}`)
    if (p.why) out.push(`Why: ${p.why}`)
    for (const a of p.audit) out.push(`  - ${a}`)
    if (p.error) out.push(`Error: ${p.error}`)
  }

  if (r.review) {
    section('Play check')
    out.push(r.review.headline)
    for (const [group, title] of [['trade', 'Did it trade correctly'], ['play', 'Was it a sound play']] as const) {
      const cs = r.review.checks.filter((c) => c.group === group)
      if (!cs.length) continue
      out.push(`${title}:`)
      for (const c of cs) out.push(`  ${MARK[c.level]} ${c.title}: ${c.text}`)
    }
  }

  if (r.bot) {
    section('Bot settings')
    out.push(`Name: ${r.bot.name}`)
    out.push(r.bot.changes.length
      ? `Changed from the measured defaults: ${r.bot.changes.map((c) => `${c.field} ${JSON.stringify(c.from)} to ${JSON.stringify(c.to)}`).join('; ')}`
      : 'At the measured defaults.')
    out.push(`Share code: ${r.bot.code}`)
  }

  if (r.problems?.length) {
    section('Recent problems this session')
    for (const e of r.problems) out.push(`  ${new Date(e.at).toLocaleTimeString()} ${e.botName}, ${e.title}, ${e.outcome}: ${e.detail}`)
  }

  out.push('', 'This report holds no keys, passwords or balances.')
  const text = out.join('\n')
  return text.length > REPORT_MAX ? `${text.slice(0, REPORT_MAX - 40)}\n\n(report cut to fit)` : text
}

// The mailto link for a report. The whole report when it fits; otherwise a
// short note asking the user to paste it from the clipboard.
export function mailtoUrl(to: string, subject: string, report: string): { url: string; full: boolean } {
  const make = (body: string): string => `mailto:${to}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body.replace(/\r?\n/g, '\r\n'))}`
  const whole = make(report)
  return whole.length <= MAILTO_MAX ? { url: whole, full: true } : { url: make(PASTE_NOTE), full: false }
}
