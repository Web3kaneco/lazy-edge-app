// Endpoints. The Supabase anon key is public by design (it ships in the web
// bundle) but it is supplied at build time through MAIN_VITE_SUPABASE_ANON_KEY
// rather than committed, so a rotation never needs a code change.
// Keys and sessions only ever travel over TLS, whatever a build sets.
const httpsOnly = (url: string): string => {
  if (!url.startsWith('https://')) throw new Error(`${url} is not https`)
  return url
}

export const API_BASE = httpsOnly(import.meta.env.MAIN_VITE_API_BASE || 'https://api.lazyedge.net')
export const SUPABASE_URL = httpsOnly(import.meta.env.MAIN_VITE_SUPABASE_URL || 'https://auth.lazyedge.net')
// Where releases are published; must match publish in electron-builder.yml.
export const RELEASES_URL = 'https://github.com/Web3kaneco/lazy-edge-app/releases'
export const SUPABASE_ANON_KEY = import.meta.env.MAIN_VITE_SUPABASE_ANON_KEY || ''
