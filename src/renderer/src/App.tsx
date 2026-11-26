import { useCallback, useEffect, useState } from 'react'
import type { CashOutResult } from '@shared/exits'
import type { ReportKind } from '@shared/report'
import type { AccountSettings } from '@shared/schema'
import { ago, api, useEngine, useNotices } from './api'
import { AskPanel } from './Ask'
import { NoticeBar } from './Notices'
import { Account } from './screens/Account'
import { Board } from './screens/Board'
import { Bots } from './screens/Bots'
import { Dashboard } from './screens/Dashboard'
import { Keys } from './screens/Keys'
import { Ledger } from './screens/Ledger'
import { Help } from './screens/Help'
import { Report } from './screens/Report'
import { Results } from './screens/Results'
import { Desk } from './screens/Desk'
import { Terms } from './screens/Terms'
import { Preferences } from './screens/Preferences'
import { getPrefs, setPrefs, shownTheme, usePrefs } from './prefs'
import { BrandMark, Segments } from './ui'

// Four screens, each with a few views (the simple app plan, 2026-11-21). The
// eleven screens of 0.9 all live on, one tap down.
const SCREENS = {
  Home: ['Today', 'Suggestions'],
  Bots: ['My bots', 'Live board'],
  Results: ['Record', 'Every trade'],
  Settings: ['Preferences', 'Keys', 'Account', 'Help', 'Report a problem', 'Terms']
} as const
type Screen = keyof typeof SCREENS
type View = (typeof SCREENS)[Screen][number]
const ICONS: Record<Screen, string> = { Home: '⌂', Bots: '◎', Results: '▤', Settings: '⚙' }

export function App() {
  const prefs = usePrefs()
  // Whether a Lazy Edge API key is saved, and what the API said about it.
  // There is no sign in screen: without a working key the app still opens and
  // a red bar says where to add one (rule 3).
  const [signedIn, setSignedIn] = useState<boolean | null>(null)
  const [keyError, setKeyError] = useState('')
  const [tier, setTier] = useState('')
  const [screen, setScreen] = useState<Screen>(() => getPrefs().startScreen)
  const [views, setViews] = useState<Record<Screen, View>>({ Home: 'Today', Bots: 'My bots', Results: 'Record', Settings: 'Preferences' })
  const go = (s: Screen, v?: View): void => { setScreen(s); if (v) setViews((x) => ({ ...x, [s]: v })) }
  const view = views[screen]
  const [menu, setMenu] = useState(false)
  // A click anywhere else closes the Stop everything menu.
  useEffect(() => {
    if (!menu) return
    const close = (): void => setMenu(false)
    const t = setTimeout(() => document.addEventListener('click', close), 0)
    return () => { clearTimeout(t); document.removeEventListener('click', close) }
  }, [menu])
  // The play a ledger row asked to report, carried to the Report screen.
  const [reportTicket, setReportTicket] = useState<string | null>(null)
  const [reportKind, setReportKind] = useState<ReportKind | undefined>(undefined)
  const [account, setAccount] = useState<AccountSettings | null>(null)
  const [bootError, setBootError] = useState('')
  const [termsAt, setTermsAt] = useState<string | null | undefined>(undefined)
  const engine = useEngine()
  const notices = useNotices()
  const [cashing, setCashing] = useState(false)
  const [asking, setAsking] = useState(false)
  const [cashed, setCashed] = useState<(CashOutResult & { why?: string }) | { error: string } | null>(null)
  // The day profit lock cashes out on its own; its result shows the same way.
  useEffect(() => window.lazyedge.on('cashOut', (r) => { setCashed(r); void api.account().then(setAccount) }), [])

  const refresh = useCallback(async () => {
    setBootError('')
    try {
      const t = await api.termsStatus()
      setTermsAt(t.accepted ? t.acceptedAt : null)
      if (!t.accepted) return
      const s = await api.authStatus()
      setSignedIn(s.signedIn)
      setKeyError(s.error ?? '')
      setTier(s.usage?.tier ?? '')
      setAccount(await api.account())
    } catch (e) {
      setBootError((e as Error).message)
    }
  }, [])

  useEffect(() => { void refresh() }, [refresh])
  // Account changes made elsewhere (the kill switch) arrive with engine state.
  useEffect(() => { void api.account().then(setAccount) }, [engine?.lastCycleAt])

  if (bootError) {
    return (
      <div className="center">
        <div className="card signin">
          <h1>Something went wrong</h1>
          <p className="err">{bootError}</p>
          <button className="btn primary" onClick={refresh}>Try again</button>
        </div>
      </div>
    )
  }
  if (termsAt === undefined) return <div className="center muted">Loading…</div>
  // Terms come before anything else.
  if (termsAt === null) return <Terms onAccepted={refresh} />
  if (signedIn === null) return <div className="center muted">Loading…</div>

  const halted = account?.killSwitch
  // A bot's own mode is the live switch, so the badge counts live bots.
  const liveBots = engine?.limits?.liveBots ?? 0

  // The dot follows the engine: green when its last check ran cleanly, red
  // when it hit an error, amber when the kill switch holds, grey when stopped.
  const health = halted ? 'warn' : !engine?.running ? '' : engine.lastError ? 'bad' : 'good'
  const darkNow = shownTheme(prefs) === 'dark'
  const cashOut = async (): Promise<void> => {
    setCashing(true)
    try { const r = await api.cashOut(); if (r) setCashed(r) } catch (e) { setCashed({ error: (e as Error).message }) }
    setCashing(false); setAccount(await api.account())
  }
  const kill = async (on: boolean): Promise<void> => { await api.killSwitch(on); setAccount(await api.account()) }

  return (
    <div className="app">
      <header className="top">
        <BrandMark />
        <span className="badge beta" title="Beta software: unfinished and still being tested. Use only money you can afford to lose.">v{__APP_VERSION__}</span>
        <span className="divider" />
        {/* One status line: is it running, is real money on, is it healthy. */}
        <span className="status" title={engine?.lastError ?? undefined}>
          <span className={`dot ${health}`} />
          {halted
            ? <><span className="halt">Kill switch on</span><span className="sep">·</span>no live orders go out</>
            : !engine?.running
              ? <b>Stopped</b>
              : <><b>Running</b><span className="sep">·</span>{liveBots ? <span className="live">{liveBots} live {liveBots === 1 ? 'bot' : 'bots'}</span> : 'paper only'}<span className="sep">·</span>checked {ago(engine.lastCycleAt ?? null)}</>}
          {engine?.lastError && <><span className="sep">·</span><span className="bad">last check failed</span></>}
        </span>
        <span className="grow" />
        <button className={`btn ${asking ? 'primary' : ''}`} onClick={() => setAsking(!asking)} title="Ask about your bots, your record or the markets. It looks things up and can draft a change for you to apply.">Ask Lazy Edge</button>
        <button className="icon-btn" onClick={() => setPrefs({ theme: darkNow ? 'light' : 'dark' })} title={darkNow ? 'Light mode' : 'Dark mode'} aria-label={darkNow ? 'Switch to light mode' : 'Switch to dark mode'}>{darkNow ? '☀' : '☾'}</button>
        {!engine?.running && <button className="btn primary" onClick={() => api.start()}>Start</button>}
        {halted && <button className="btn" onClick={() => void kill(false)}>Release kill switch</button>}
        <span className="menu-wrap">
          <button className="btn danger" disabled={cashing} onClick={() => setMenu(!menu)} aria-expanded={menu}>{cashing ? 'Cashing out…' : 'Stop everything'} ▾</button>
          {menu && (
            <div className="menu" role="menu" onClick={(e) => e.stopPropagation()}>
              {!halted && (
                <button className="bad" onClick={() => { setMenu(false); void kill(true) }}>
                  <b>Kill switch</b><span>No new live orders, and resting ones are cancelled. Open positions stay. Paper keeps running.</span>
                </button>
              )}
              <button className="bad" onClick={() => { setMenu(false); void cashOut() }}>
                <b>Cash out everything</b><span>Every bot off, the kill switch on, and every open position sold at the bid now.</span>
              </button>
              {engine?.running && (
                <button onClick={() => { setMenu(false); void api.stop() }}>
                  <b>Stop the engine</b><span>No bot checks or trades, paper or live, until you press Start.</span>
                </button>
              )}
            </div>
          )}
        </span>
      </header>
      {cashed && <CashOutNote result={cashed} onClose={() => setCashed(null)} />}
      <div className="shell">
        <aside className="side">
          {(Object.keys(SCREENS) as Screen[]).map((s) => (
            <button key={s} className={`nav ${screen === s ? 'on' : ''}`} onClick={() => setScreen(s)}><span className="ico">{ICONS[s]}</span>{s}</button>
          ))}
          <div className="spacer" />
          <div className="beta-note">Version {__APP_VERSION__}. Beta test software that may have faults. Use only money you can afford to lose.</div>
          <div className="foot">
            <span className={`dot ${health}`} />
            <span>{tier ? `Lazy Edge API, ${tier}` : 'Lazy Edge API'}</span>
          </div>
        </aside>
        <div className="main">
          {(!signedIn || keyError) && !(screen === 'Settings' && view === 'Keys') && (
            <div className="notices">
              <div className="notice urgent">
                <div className="notice-text">
                  <b>{signedIn ? 'Your Lazy Edge API key is not working' : 'No Lazy Edge API key yet'}</b>
                  <span>{signedIn ? keyError : 'Bots have no data to trade on until you add one. Make a key at lazyedge.net/settings and paste it in Settings, Keys.'}</span>
                </div>
                <button className="btn primary" onClick={() => go('Settings', 'Keys')}>{signedIn ? 'Open Keys' : 'Add key'}</button>
              </div>
            </div>
          )}
          <NoticeBar state={notices} />
          <main className="page">
            <h1>{screen}</h1>
            <Segments options={SCREENS[screen] as readonly View[]} value={view} onChange={(v) => go(screen, v)} />
            <div className="sub">
              {view === 'Today' && <Dashboard engine={engine} onSendDay={() => { setReportTicket(null); setReportKind('day'); go('Settings', 'Report a problem') }} />}
              {view === 'Suggestions' && <Desk />}
              {view === 'My bots' && <Bots advancedOpen={prefs.advancedOpen} />}
              {view === 'Live board' && <Board engine={engine} />}
              {view === 'Record' && <Results />}
              {view === 'Every trade' && <Ledger onReport={(id) => { setReportTicket(id); setReportKind(undefined); go('Settings', 'Report a problem') }} />}
              {view === 'Preferences' && <Preferences />}
              {view === 'Keys' && <Keys onLazyEdgeChange={refresh} />}
              {view === 'Account' && account && <Account account={account} onSaved={setAccount} />}
              {view === 'Help' && <Help />}
              {view === 'Report a problem' && <Report ticketId={reportTicket} startKind={reportKind} />}
              {view === 'Terms' && <Terms acceptedAt={termsAt} />}
            </div>
          </main>
        </div>
      </div>
      <AskPanel open={asking} onClose={() => setAsking(false)} />
    </div>
  )
}

// What a cash out did, in a bar under the header until it is closed.
function CashOutNote({ result, onClose }: { result: (CashOutResult & { why?: string }) | { error: string }; onClose: () => void }) {
  if ('error' in result) {
    return <div className="notices"><div className="notice urgent"><div className="notice-text"><b>The cash out stopped</b><span>{result.error}</span></div><button className="btn ghost" onClick={onClose}>Close</button></div></div>
  }
  const money = `${result.pnlUsd < 0 ? '−' : '+'}$${Math.abs(result.pnlUsd).toFixed(2)}`
  const lines = [
    ...(result.why ? [`The day profit lock fired: ${result.why}.`] : []),
    `${result.botsOff} ${result.botsOff === 1 ? 'bot' : 'bots'} switched off. Switch them back on, and release the kill switch if it is on, when you are ready to trade again.`,
    result.contracts ? `Sold ${result.contracts} contracts: ${result.sold} positions in full${result.partly ? ` and ${result.partly} in part` : ''}, ${money} on what sold after fees.` : 'Nothing was sold.',
    ...result.kept.slice(0, 12).map((k) => `Kept ${k.title}: ${k.why}.`),
    ...(result.kept.length > 12 ? [`And ${result.kept.length - 12} more kept; every one is in the Ledger.`] : [])
  ]
  return (
    <div className="notices">
      <div className={`notice ${result.kept.length ? 'warn' : ''}`}>
        <div className="notice-text"><b>Cashed out</b><span>{lines.join('\n')}</span></div>
        <button className="btn ghost" onClick={onClose}>Close</button>
      </div>
    </div>
  )
}
