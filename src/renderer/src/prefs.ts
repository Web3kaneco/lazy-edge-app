// How the app looks and opens, chosen by the user in Settings (
// 2026-11-21: a dark mode switch, and "settings for the users if they want to
// change how things are configured"). Kept on this computer only: none of it
// changes what a bot trades, so it never goes in the settings documents.
import { useEffect, useState } from 'react'

export type Theme = 'light' | 'dark' | 'system'
export interface Prefs {
  theme: Theme
  textSize: 'standard' | 'large'
  // Every bot's Advanced settings open, rather than folded under the card.
  advancedOpen: boolean
  // The screen the app opens on.
  startScreen: 'Home' | 'Bots'
}

const KEY = 'ui.prefs'
export const DEFAULT_PREFS: Prefs = { theme: 'light', textSize: 'standard', advancedOpen: false, startScreen: 'Home' }

function read(): Prefs {
  try {
    const v = JSON.parse(localStorage.getItem(KEY) ?? '{}') as Partial<Prefs>
    return {
      theme: v.theme === 'dark' || v.theme === 'system' ? v.theme : 'light',
      textSize: v.textSize === 'large' ? 'large' : 'standard',
      advancedOpen: v.advancedOpen === true,
      startScreen: v.startScreen === 'Bots' ? 'Bots' : 'Home'
    }
  } catch { return { ...DEFAULT_PREFS } }
}

let current = read()
const listeners = new Set<(p: Prefs) => void>()
const dark = typeof window !== 'undefined' && window.matchMedia ? window.matchMedia('(prefers-color-scheme: dark)') : null

// The theme actually shown: System follows Windows.
export const shownTheme = (p: Prefs = current): 'light' | 'dark' => (p.theme === 'system' ? (dark?.matches ? 'dark' : 'light') : p.theme)

export function applyPrefs(p: Prefs = current): void {
  const root = document.documentElement
  root.dataset.theme = shownTheme(p)
  root.dataset.text = p.textSize
}
dark?.addEventListener('change', () => { if (current.theme === 'system') applyPrefs() })

export function getPrefs(): Prefs { return current }

export function setPrefs(change: Partial<Prefs>): void {
  current = { ...current, ...change }
  try { localStorage.setItem(KEY, JSON.stringify(current)) } catch { /* kept for this session only */ }
  applyPrefs()
  for (const l of listeners) l(current)
}

export function usePrefs(): Prefs {
  const [p, setP] = useState(current)
  useEffect(() => { listeners.add(setP); return () => { listeners.delete(setP) } }, [])
  return p
}
