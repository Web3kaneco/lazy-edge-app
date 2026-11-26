// The Lazy Edge API, read only. Every number a bot trades comes from here; the
// app computes nothing the API already publishes.
import { API_BASE } from '../config'
import { vault } from '../store/vault'
import { HttpError, requestJson } from './http'

export class PlanInactiveError extends Error {}
export class NotSignedInError extends Error {}

export async function api<T = any>(path: string, query: Record<string, string | number | boolean | undefined> = {}): Promise<T> {
  const key = vault.get('lazyedge.apiKey')
  if (!key) throw new NotSignedInError('No Lazy Edge API key yet. Add one in Settings, Keys.')
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
    if (err instanceof HttpError && err.status === 401) throw new NotSignedInError('Lazy Edge refused the saved API key. Paste a new one in Settings, Keys.')
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
  // For the desk's data tools (2026-11-21): read only, called only when the
  // user asks the desk a question.
  nbaGamesToday: () => api<any>('/v1/nba/games/today'),
  nbaPropsFor: (gameId?: string) => api<any>('/v1/nba/props', { game_id: gameId }),
  nbaHitRates: (player: string, stat: string, line?: number, games?: number) => api<any>('/v1/nba/hit-rates', { player, stat, line, games }),
  nbaResults: (date?: string, gameId?: string) => api<any>('/v1/nba/results', { date, game_id: gameId }),
  // The night's NBA tickets, for a bot that buys the API's own combos.
  nbaTickets: () => api<any>('/v1/nba/tickets'),
  // The week's NFL slips and same-game pairs, for a bot that buys them.
  nflSuggested: () => api<any>('/v1/nfl/parlay/suggested'),
  nflEdges: () => api<any>('/v1/nfl/edges', { include_no_edge: true }),
  nflBoard: (gameId: string) => api<any>(`/v1/nfl/board/${encodeURIComponent(gameId)}`, { ranked_only: true }),
  nflLivePlays: () => api<any>('/v1/nfl/live-plays', { include_props: true }),
  mlbEdges: () => api<any>('/v1/mlb/edges'),
  mlbLive: () => api<any>('/v1/mlb/live'),
  // The NBA routes moved beside the other sports' on 2026-10-26; the old
  // paths still answer with the same data (agent guide, Older NBA paths).
  nbaLive: () => api<any>('/v1/nba/edges'),
  // Our pick in each NBA game, pregame and live, with its record and price
  // (2026-11-17). Read only when a bot buys our pick.
  nbaPicks: () => api<any>('/v1/nba/picks'),
  // Points, rebounds and assists for every game on the slate, with the chance
  // of the over pregame and live, the Kalshi contract and its live price.
  nbaProps: () => api<any>('/v1/nba/props'),
  nbaSpreadLadder: (gameId: string) => api<any>(`/v1/nba/spread-ladder/${encodeURIComponent(gameId)}`, { venue: 'kalshi' }),
  wcEdges: () => api<any>('/v1/wc/edges')
}
