import { useState } from 'react'
import type { AccountSettings } from '@shared/schema'
import { DEFAULT_ACCOUNT } from '@shared/ruleset'
import { api } from '../api'
import { Field, NumberField, Toggle } from '../ui'

export function Account({ account, onSaved }: { account: AccountSettings; onSaved: (a: AccountSettings) => void }) {
  const [a, setA] = useState<AccountSettings>(structuredClone(account))
  const [err, setErr] = useState('')
  const [saved, setSaved] = useState(false)

  const set = (fn: (x: AccountSettings) => void): void => {
    const next = structuredClone(a)
    fn(next)
    setA(next); setSaved(false)
  }

  const save = async (): Promise<void> => {
    setErr('')
    try {
      const out = await api.saveAccount(a)
      onSaved(out); setA(structuredClone(out)); setSaved(true)
    } catch (e) { setErr((e as Error).message) }
  }

  return (
    <>
      <h1>Account</h1>
      <p className="lede">Limits that sit above every live bot. A bot can be stricter than these, never looser. Whether a bot trades real money is set on the bot itself: Paper or Live, and nothing else.</p>

      <div className="card">
        <h2>Live money limits</h2>
        <div className="grid cols-2">
          <NumberField label="Account daily drawdown stop" suffix="$" step={5} value={a.accountDailyDrawdownUsd} measured={DEFAULT_ACCOUNT.accountDailyDrawdownUsd} why="Settled losses after fees since 4 AM, across every live bot together. Paper bots are not affected." onChange={(v) => set((x) => { x.accountDailyDrawdownUsd = v })} />
          <NumberField label="Maximum open exposure" suffix="$" step={10} value={a.accountMaxOpenExposureUsd} measured={DEFAULT_ACCOUNT.accountMaxOpenExposureUsd} why="The most money your live bots together can have in open trades at once. This, not the trade count, is what caps how much is in play."onChange={(v) => set((x) => { x.accountMaxOpenExposureUsd = v })} />
        </div>

        <div className="section">Day profit lock</div>
        <p className="small muted">Locks in a good day. Once the day is up your target, the app cashes out on its own. Watching live money, every live bot is switched off, the kill switch goes on and every open live position is sold at the bid. Watching paper, only paper bots and paper positions are touched. It fires at most once a day, while the engine is running, and switching it on asks you to confirm.</p>
        <Toggle on={a.profitLock.enabled} onChange={(v) => set((x) => { x.profitLock.enabled = v })} label="Cash out automatically when the day is up" />
        <div className="grid cols-2" style={{ marginTop: 10 }}>
          <Field label="Watch" hint={a.profitLock.watch === 'live' ? 'Your Kalshi account value, as Kalshi marks it. A deposit or withdrawal during the day moves it too.' : 'Your paper balance, with open positions at their bid.'}>
            <select value={a.profitLock.watch} onChange={(e) => set((x) => { x.profitLock.watch = e.target.value as 'live' | 'paper' })}>
              <option value="live">Live money on Kalshi</option>
              <option value="paper">Paper</option>
            </select>
          </Field>
          <NumberField label="Lock in once the day is up" suffix="%" step={1} min={1} value={a.profitLock.upPct} measured={DEFAULT_ACCOUNT.profitLock.upPct} onChange={(v) => set((x) => { x.profitLock.upPct = v })} />
          <NumberField label="Then cash out after it gives back" suffix="points, 0 = at once" step={1} min={0} value={a.profitLock.trailPct} measured={DEFAULT_ACCOUNT.profitLock.trailPct} onChange={(v) => set((x) => { x.profitLock.trailPct = v })} />
        </div>
        <p className="small muted" style={{ marginTop: 8 }}>
          {a.profitLock.trailPct > 0
            ? `Once the day reaches ${a.profitLock.upPct}%, it rides the high and cashes out the moment the day falls ${a.profitLock.trailPct} points below its best. Reach ${a.profitLock.upPct + 10}%, and it cashes out at ${a.profitLock.upPct + 10 - a.profitLock.trailPct}%.`
            : `It cashes out the moment the day reaches ${a.profitLock.upPct}%.`}
        </p>
      </div>

      <div className="grid cols-2" style={{ marginTop: 14 }}>
        <div className="card">
          <h2>Venues</h2>
          <p className="small muted">A venue is used once its key is saved on the Keys screen; there is nothing to switch on here.</p>
          <div className="grid">
            <NumberField label="Paper starting balance" suffix="$" step={100} value={a.venues.paper.startingBalanceUsd} onChange={(v) => set((x) => { x.venues.paper.startingBalanceUsd = v })} />
            <Field label="Kalshi environment" hint="Demo uses Kalshi's practice exchange and its own demo keys.">
              <select value={a.venues.kalshi.environment} onChange={(e) => set((x) => { x.venues.kalshi.environment = e.target.value as 'production' | 'demo' })}>
                <option value="production">Production</option>
                <option value="demo">Demo</option>
              </select>
            </Field>
            <Field label="Polymarket account type" hint="How you log in to Polymarket decides how orders are signed.">
              <select value={a.venues.polymarket.accountType} onChange={(e) => set((x) => { x.venues.polymarket.accountType = e.target.value as AccountSettings['venues']['polymarket']['accountType'] })}>
                <option value="email">Email or Magic login</option>
                <option value="browser_wallet">Browser wallet login (MetaMask and similar)</option>
                <option value="eoa">Plain wallet trading for itself</option>
              </select>
            </Field>
          </div>
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
