// The Lazy Edge API key, pasted on Settings, Keys (22 November 2026; replaces
// the email code and wallet sign in of decision 9). The user makes a key at
// lazyedge.net/settings, the app tests it once against the API, and only a key
// the API accepts goes into the Windows vault. There is no sign in screen: the
// app opens without a key and says in red where the key is missing.
import { API_BASE } from '../config'
import { vault } from '../store/vault'
import { HttpError, requestJson } from './http'

export interface KeyCheck {
  prefix: string
  tier: string
  // The API knows the key but the plan behind it is not active right now. The
  // key is still saved, since it works again as soon as the plan is.
  planInactive?: boolean
}

export const auth = {
  signedIn: (): boolean => Boolean(vault.get('lazyedge.apiKey')),

  async setKey(raw: string): Promise<KeyCheck> {
    const key = String(raw ?? '').trim()
    if (!key) throw new Error('Paste your Lazy Edge API key first.')
    if (/\s/.test(key) || key.length > 512) throw new Error('That does not look like a Lazy Edge API key. Copy it again from lazyedge.net/settings.')
    const check = await requestJson<{ prefix: string; tier: string }>(`${API_BASE}/v1/account/usage`, {
      headers: { Authorization: `Bearer ${key}` }
    }).then(
      (usage): KeyCheck => ({ prefix: usage.prefix, tier: usage.tier }),
      (err): KeyCheck => {
        if (err instanceof HttpError && err.status === 401) throw new Error('Lazy Edge refused that key. Check it is copied in full, or make a new one at lazyedge.net/settings.')
        if (err instanceof HttpError && err.status === 402) return { prefix: '', tier: '', planInactive: true }
        throw new Error(`Could not check the key with Lazy Edge, so it was not saved: ${(err as Error).message}`)
      }
    )
    await vault.set('lazyedge.apiKey', key)
    // A refresh token left by the old sign in is no longer used.
    await vault.remove('lazyedge.session')
    return check
  },

  async removeKey(): Promise<void> {
    await vault.remove('lazyedge.apiKey')
    await vault.remove('lazyedge.session')
  }
}
