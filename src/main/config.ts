// Endpoints. Keys only ever travel over TLS, whatever a build sets.
const httpsOnly = (url: string): string => {
  if (!url.startsWith('https://')) throw new Error(`${url} is not https`)
  return url
}

export const API_BASE = httpsOnly(import.meta.env.MAIN_VITE_API_BASE || 'https://api.lazyedge.net')
// Where releases are published; must match publish in electron-builder.yml.
export const RELEASES_URL = 'https://github.com/Web3kaneco/lazy-edge-app/releases'
// Team notices: one JSON file on the release repository's notices branch,
// which the source export never touches. internal/notices.md has the format.
export const NOTICES_URL = 'https://raw.githubusercontent.com/Web3kaneco/lazy-edge-app/notices/notices.json'
// Where the Report screen addresses its email. The user's own email program
// sends it; the app never does.
export const SUPPORT_EMAIL = 'support@lazyedge.net'
