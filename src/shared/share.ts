// Share codes: a bot's settings as one line of text a user can post and
// another can paste. A code carries settings only, never trades, balances,
// results or keys. An imported bot is always a new bot, switched off and in
// paper, whatever the code says.
import { defaultBot } from './ruleset'
import { BotSettings } from './schema'

const PREFIX = 'LEBOT1:'
const MAX_CODE = 20_000

const toBase64Url = (s: string): string =>
  btoa(String.fromCharCode(...new TextEncoder().encode(s))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')

const fromBase64Url = (s: string): string =>
  new TextDecoder().decode(Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0)))

export function shareCode(bot: BotSettings): string {
  const { id: _id, enabled: _enabled, ...settings } = bot
  return PREFIX + toBase64Url(JSON.stringify({ ...settings, mode: 'paper' }))
}

export function readShareCode(code: string, id: string): BotSettings {
  const text = code.trim()
  if (!text.startsWith(PREFIX)) throw new Error('That is not a Lazy Edge bot code. Codes start with LEBOT1:')
  if (text.length > MAX_CODE) throw new Error('That code is too long to be a bot.')
  let raw: unknown
  try { raw = JSON.parse(fromBase64Url(text.slice(PREFIX.length))) } catch { throw new Error('That code is damaged. Copy it again in full.') }
  const parsed = BotSettings.safeParse({ ...(raw as object), id, enabled: false, mode: 'paper' })
  if (!parsed.success) throw new Error('That code holds settings this version does not recognise, so it was refused.')
  return parsed.data
}

export interface Change { field: string; from: unknown; to: unknown }

// Every setting that differs from the measured defaults, so an imported bot
// is read before it is saved.
export function changesFromDefaults(bot: BotSettings): Change[] {
  const out: Change[] = []
  const walk = (a: unknown, b: unknown, path: string): void => {
    if (a && b && typeof a === 'object' && typeof b === 'object' && !Array.isArray(a)) {
      for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) walk((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k], path ? `${path}.${k}` : k)
    } else if (JSON.stringify(a) !== JSON.stringify(b)) {
      out.push({ field: path, from: a, to: b })
    }
  }
  const { id: _a, name: _b, enabled: _c, ...base } = defaultBot('x', 'x')
  const { id: _d, name: _e, enabled: _f, ...mine } = bot
  walk(base, mine, '')
  return out
}
