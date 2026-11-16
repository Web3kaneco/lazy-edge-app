import { useCallback, useEffect, useState } from 'react'
import type { CashOutResult } from '@shared/exits'
import type { ReportKind } from '@shared/report'
import type { AccountSettings } from '@shared/schema'
import { ago, api, useEngine, useNotices } from './api'
import { NoticeBar } from './Notices'
import { Account } from './screens/Account'
import { Board } from './screens/Board'
import { Bots } from './screens/Bots'
import { Dashboard } from './screens/Dashboard'
import { Keys } from './screens/Keys'
import { Ledger } from './screens/Ledger'
import { SignIn } from './screens/SignIn'
import { Help } from './screens/Help'
import { Report } from './screens/Report'
import { Results } from './screens/Results'
import { Terms } from './screens/Terms'
import { BrandMark } from './ui'

const SCREENS = ['Dashboard', 'Bots', 'Board', 'Results', 'Ledger', 'Keys', 'Account', 'Help', 'Report', 'Terms'] as const
type Screen = (typeof SCREENS)[number]

export function App() {
  const [signedIn, setSignedIn] = useState<boolean | null>(null)
  const [tier, setTier] = useState('')
  const [screen, setScreen] = useState<Screen>('Dashboard')
  // The play a ledger row asked to report, carried to the Report screen.
  const [reportTicket, setReportTicket] = useState<string | null>(null)
  const [reportKind, setReportKind] = useState<ReportKind | undefined>(undefined)
  const [account, setAccount] = useState<AccountSettings | null>(null)
  const [bootError, setBootError] = useState('')
  const [termsAt, setTermsAt] = useState<string | null | undefined>(undefined)
  const engine = useEngine()
  const notices = useNotices()
  const [cashing, setCashing] = useState(false)
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
      setTier(s.usage?.tier ?? '')
      if (s.signedIn) setAccount(await api.account())
    } catch (e) {
      setBootError((e as Error).message)
    }
  }, [])

  useEffect(() => { void refresh() }, [refresh])
  // Account changes made elsewhere (the kill switch) arrive with engine state.
  useEffect(() => { if (signedIn) void api.account().then(setAccount) }, [engine?.lastCycleAt, signedIn])

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
  // Terms come before anything else, including sign in.
  if (termsAt === null) return <Terms onAccepted={refresh} />
  if (signedIn === null) return <div className="center muted">Loading…</div>
  if (!signedIn) return <SignIn onDone={refresh} />

  const halted = account?.killSwitch
  const live = account?.executionMode === 'live'

  // The sidebar dot follows the terminal: green when the engine ran its last
  // cycle cleanly, red when it hit an error, grey when stopped.
  const health = !engine?.running ? '' : engine.lastError ? 'bad' : 'good'

  return (
    <div className="app">
      <header className="top">
        <BrandMark />
        <span className="badge beta" title="Beta software: unfinished and still being tested. Use only money you can afford to lose.">v{__APP_VERSION__}</span>
        <span className="divider" />
        <span className="crumb">Desktop · {screen}</span>
        <span className="divider" />
        {halted ? <span className="badge halt">Kill switch on</span> : live ? <span className="badge live">Live money</span> : <span className="badge dry">Dry run</span>}
        <span className={`badge ${engine?.running ? 'ok' : 'dry'}`}>{engine?.running ? 'Engine running' : 'Engine stopped'}</span>
        <span className="crumb">Last cycle {ago(engine?.lastCycleAt ?? null)}</span>
        {engine?.lastError && <span className="small bad" title={engine.lastError} style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', minWidth: 0 }}>{engine.lastError}</span>}
        <span className="grow" />
        {engine?.running
          ? <button className="btn" onClick={() => api.stop()}>Stop engine</button>
          : <button className="btn primary" onClick={() => api.start()}>Start engine</button>}
        <button
          className={`btn ${halted ? '' : 'danger'}`}
          onClick={async () => { await api.killSwitch(!halted); setAccount(await api.account()) }}
          title="Stops every new live order and cancels resting ones. Paper keeps running."
        >
          {halted ? 'Release kill switch' : 'Kill switch'}
        </button>
        <button
          className="btn danger"
          disabled={cashing}
          onClick={async () => {
            setCashing(true)
            try { const r = await api.cashOut(); if (r) setCashed(r) } catch (e) { setCashed({ error: (e as Error).message }) }
            setCashing(false); setAccount(await api.account())
          }}
          title="Switches every bot off, turns the kill switch on, and sells every open position across all bots at the bid now."
        >
          {cashing ? 'Cashing out…' : 'Cash out all'}
        </button>
      </header>
      {cashed && <CashOutNote result={cashed} onClose={() => setCashed(null)} />}
      <div className="shell">
        <aside className="side">
          {SCREENS.map((s) => (
            <button key={s} className={`nav ${screen === s ? 'on' : ''}`} onClick={() => setScreen(s)}>{s}</button>
          ))}
          <div className="spacer" />
          <div className="beta-note">Version {__APP_VERSION__}. Beta test software that may have faults. Use only money you can afford to lose.</div>
          <div className="foot">
            <span className={`dot ${health}`} />
            <span>{tier ? `API ${tier}` : 'API'}</span>
          </div>
        </aside>
        <div className="main">
          <NoticeBar state={notices} />
          <main className="page">
            {screen === 'Dashboard' && <Dashboard engine={engine} onSendDay={() => { setReportTicket(null); setReportKind('day'); setScreen('Report') }} />}
            {screen === 'Bots' && <Bots />}
            {screen === 'Board' && <Board engine={engine} />}
            {screen === 'Results' && <Results />}
            {screen === 'Ledger' && <Ledger onReport={(id) => { setReportTicket(id); setReportKind(undefined); setScreen('Report') }} />}
            {screen === 'Keys' && <Keys />}
            {screen === 'Account' && account && <Account account={account} onSaved={setAccount} onSignOut={refresh} />}
            {screen === 'Help' && <Help />}
            {screen === 'Report' && <Report ticketId={reportTicket} startKind={reportKind} />}
            {screen === 'Terms' && <Terms acceptedAt={termsAt} />}
          </main>
        </div>
      </div>
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
    `${result.botsOff} ${result.botsOff === 1 ? 'bot' : 'bots'} switched off and the kill switch is on. Switch bots back on and release the kill switch when you are ready to trade again.`,
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
