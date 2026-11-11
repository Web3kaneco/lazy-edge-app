import { useState } from 'react'
import type { AccountSettings } from '@shared/schema'
import { DEFAULT_ACCOUNT } from '@shared/ruleset'
import { api } from '../api'
import { Field, NumberField, Toggle } from '../ui'

export function Account({ account, onSaved, onSignOut }: { account: AccountSettings; onSaved: (a: AccountSettings) => void; onSignOut: () => void }) {
  const [a, setA] = useState<AccountSettings>(structuredClone(account))
  const [confirmLive, setConfirmLive] = useState('')
  const [err, setErr] = useState('')
  const [saved, setSaved] = useState(false)

  const set = (fn: (x: AccountSettings) => void): void => {
    const next = structuredClone(a)
    fn(next)
    setA(next); setSaved(false)
  }

  const goingLive = a.executionMode === 'live' && account.executionMode !== 'live'

  const save = async (): Promise<void> => {
    setErr('')
    if (goingLive && confirmLive !== 'LIVE') { setErr('Type LIVE to confirm real money orders.'); return }
    try {
      const out = await api.saveAccount(a)
      onSaved(out); setA(structuredClone(out)); setConfirmLive(''); setSaved(true)
    } catch (e) { setErr((e as Error).message) }
  }

  return (
    <>
      <h1>Account</h1>
      <p className="lede">Standards that sit above every bot. A bot can be stricter than these, never looser.</p>

      <div className="card">
        <h2>Execution</h2>
        <Field label="Live bots send" hint="Dry run runs the whole live path, signing, sizing, side and ticker, and logs the exact order it would place without sending it. It is the shipped default. Prove a bot dry before going live.">
          <select value={a.executionMode} onChange={(e) => set((x) => { x.executionMode = e.target.value as AccountSettings['executionMode'] })} style={{ width: 280 }}>
            <option value="dry_run">Dry run: log orders, send nothing</option>
            <option value="live">Live: send real orders</option>
          </select>
        </Field>
        {goingLive && (
          <div className="note bad" style={{ marginTop: 10 }}>
            Live bots will place real orders with your money under their settings. Type <strong>LIVE</strong> to confirm.
            <input type="text" value={confirmLive} onChange={(e) => setConfirmLive(e.target.value)} style={{ marginTop: 8, width: 160 }} />
          </div>
        )}
        <div className="grid cols-2" style={{ marginTop: 12 }}>
          <NumberField label="Account daily drawdown stop" suffix="$" step={5} value={a.accountDailyDrawdownUsd} measured={DEFAULT_ACCOUNT.accountDailyDrawdownUsd} why="Across every live bot together." onChange={(v) => set((x) => { x.accountDailyDrawdownUsd = v })} />
          <NumberField label="Maximum open exposure" suffix="$" step={10} value={a.accountMaxOpenExposureUsd} measured={DEFAULT_ACCOUNT.accountMaxOpenExposureUsd} why="The most money your live bots together can have in open trades at once. This, not the trade count, is what caps how much is in play."onChange={(v) => set((x) => { x.accountMaxOpenExposureUsd = v })} />
        </div>
      </div>

      <div className="grid cols-2" style={{ marginTop: 14 }}>
        <div className="card">
          <h2>Venues you hold accounts on</h2>
          <div className="grid">
            <Toggle on={a.venues.paper.enabled} onChange={(v) => set((x) => { x.venues.paper.enabled = v })} label="Paper" />
            <NumberField label="Paper starting balance" suffix="$" step={100} value={a.venues.paper.startingBalanceUsd} onChange={(v) => set((x) => { x.venues.paper.startingBalanceUsd = v })} />
            <Toggle on={a.venues.kalshi.enabled} onChange={(v) => set((x) => { x.venues.kalshi.enabled = v })} label="Kalshi" />
            <Field label="Kalshi environment" hint="Demo uses Kalshi's practice exchange and its own demo keys.">
              <select value={a.venues.kalshi.environment} onChange={(e) => set((x) => { x.venues.kalshi.environment = e.target.value as 'production' | 'demo' })}>
                <option value="production">Production</option>
                <option value="demo">Demo</option>
              </select>
            </Field>
            <Toggle on={a.venues.polymarket.enabled} onChange={(v) => set((x) => { x.venues.polymarket.enabled = v })} label="Polymarket" />
            <Field label="Polymarket account type" hint="How you log in to Polymarket decides how orders are signed.">
              <select value={a.venues.polymarket.accountType} onChange={(e) => set((x) => { x.venues.polymarket.accountType = e.target.value as AccountSettings['venues']['polymarket']['accountType'] })}>
                <option value="email">Email or Magic login</option>
                <option value="browser_wallet">Browser wallet login (MetaMask and similar)</option>
                <option value="eoa">Plain wallet trading for itself</option>
              </select>
            </Field>
          </div>
        </div>
        <div className="card">
          <h2>Lazy Edge</h2>
          <p className="small muted">This computer holds its own Lazy Edge API key. Signing out removes it here; revoke it at lazyedge.net/settings to remove it everywhere.</p>
          <button className="btn" onClick={async () => { await api.signOut(); onSignOut() }}>Sign out</button>
        </div>
      </div>

      <div className="row" style={{ marginTop: 16 }}>
        <button className="btn primary" onClick={save}>Save account settings</button>
        {saved && <span className="small good">Saved.</span>}
        {err && <span className="err">{err}</span>}
      </div>
    </>
  )
}
