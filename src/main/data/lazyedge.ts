// The Lazy Edge API, read only. Every number a bot trades comes from here; the
// app computes nothing the API already publishes.
import { API_BASE } from '../config'
import { vault } from '../store/vault'
import { HttpError, requestJson } from './http'

export class PlanInactiveError extends Error {}
export class NotSignedInError extends Error {}

export async function api<T = any>(path: string, query: Record<string, string | number | boolean | undefined> = {}): Promise<T> {
  const key = vault.get('lazyedge.apiKey')
  if (!key) throw new NotSignedInError('Sign in to Lazy Edge first')
  const qs = Object.entries(query)
    .filter(([, v]) => v !== undefined)
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`)
    .join('&')
  try {
    return await requestJson<T>(`${API_BASE}${path}${qs ? `?${qs}` : ''}`, { headers: { Authorization: `Bearer ${key}` } })
  } catch (err) {
    // A 402 means the plan is not active right now; the same key works again
    // as soon as it is (agent guide, Account).
    if (err instanceof HttpError && err.status === 402) throw new PlanInactiveError('Your Lazy Edge plan is not active')
    if (err instanceof HttpError && err.status === 401) throw new NotSignedInError('Your Lazy Edge key was refused. Sign in again.')
    throw err
  }
}

export const lazyedge = {
  // Public, no key. Handed to the AI providers as their reading guide.
  // Checked and capped: it is data handed to a model, never instructions.
  skill: async (): Promise<string> => {
    const r = await fetch(`${API_BASE}/v1/skill`, { redirect: 'error' })
    if (!r.ok) throw new Error(`guide unavailable (HTTP ${r.status})`)
    return (await r.text()).slice(0, 60_000)
  },
  usage: () => api<{ prefix: string; tier: string; calls_today: number; rate_limit_per_min: number }>('/v1/account/usage'),
  nflEdges: () => api<any>('/v1/nfl/edges', { include_no_edge: true }),
  nflBoard: (gameId: string) => api<any>(`/v1/nfl/board/${encodeURIComponent(gameId)}`, { ranked_only: true }),
  nflLivePlays: () => api<any>('/v1/nfl/live-plays', { include_props: true }),
  mlbEdges: () => api<any>('/v1/mlb/edges'),
  mlbLive: () => api<any>('/v1/mlb/live'),
  nbaLive: () => api<any>('/v1/edges/live'),
  nbaSpreadLadder: (gameId: string) => api<any>(`/v1/spread-ladder/${encodeURIComponent(gameId)}`, { venue: 'kalshi' }),
  wcEdges: () => api<any>('/v1/wc/edges')
}
