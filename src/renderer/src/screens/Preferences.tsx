import { setPrefs, usePrefs, type Prefs, type Theme } from '../prefs'
import { Toggle } from '../ui'

// How the app looks and opens, on this computer only. Nothing here changes
// what a bot trades; the bots' own settings are on Bots, under each bot.
export function Preferences() {
  const p = usePrefs()
  const choice = <K extends keyof Prefs>(k: K, options: { v: Prefs[K]; label: string }[]) => (
    <div className="segments" style={{ margin: 0 }}>
      {options.map((o) => <button key={String(o.v)} className={p[k] === o.v ? 'on' : ''} onClick={() => setPrefs({ [k]: o.v } as Partial<Prefs>)}>{o.label}</button>)}
    </div>
  )
  return (
    <>
      <p className="lede">How the app looks and what it shows first. These stay on this computer and never change what a bot trades.</p>

      <div className="pref-group">
        <h2>Appearance</h2>
        <div className="pref">
          <div className="text"><b>Theme</b><span>Light, dark, or the same as Windows. The moon and sun in the top bar switch it too.</span></div>
          {choice('theme', [{ v: 'light' as Theme, label: 'Light' }, { v: 'dark' as Theme, label: 'Dark' }, { v: 'system' as Theme, label: 'Match Windows' }])}
        </div>
        <div className="pref">
          <div className="text"><b>Text size</b><span>Larger makes every screen easier to read, with less on it at once.</span></div>
          {choice('textSize', [{ v: 'standard', label: 'Standard' }, { v: 'large', label: 'Larger' }])}
        </div>
      </div>

      <div className="pref-group">
        <h2>Bots</h2>
        <div className="pref">
          <div className="text"><b>Show every setting</b><span>Opens Advanced on every bot, so all of its settings are in view. Off keeps each bot to its few main controls, with the rest one tap away.</span></div>
          <Toggle on={p.advancedOpen} onChange={(v) => setPrefs({ advancedOpen: v })} />
        </div>
      </div>

      <div className="pref-group">
        <h2>Starting up</h2>
        <div className="pref">
          <div className="text"><b>Open on</b><span>The screen the app shows when it starts.</span></div>
          {choice('startScreen', [{ v: 'Home', label: 'Home' }, { v: 'Bots', label: 'Bots' }])}
        </div>
      </div>
    </>
  )
}
