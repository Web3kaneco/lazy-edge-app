// Typed wrappers over the preload bridge. The renderer holds no key and makes
// no trading decision; it renders state and sends intents.
import { useEffect, useState } from 'react'
import type { AccuracyEntry } from '@shared/accuracy'
import type { HeldBack } from '@shared/limits'
import type { PlayReview } from '@shared/review'
import type { AccountSettings, BotSettings, ProviderId } from '@shared/schema'
import type { BotVerdict, PlayTags, Signal } from '@shared/signal'

export interface Ticket {
  id: string; botId: string; botName: string; title: string; venue: string; priceSource: string
  contract: string; side: 'yes' | 'no'; contracts: number; limitPriceC: number; costUsd: number
  evCents: number; status: string; filledContracts: number; avgFillC: number | null; feeUsd: number
  pnlUsd: number | null; createdAt: number; why: string | null; audit: string[]; error: string | null
  signalKey: string; gameId: string; play?: PlayTags
}

export interface EngineState {
  running: boolean
  lastCycleAt: number | null
  lastError: string | null
  signals: number
  refused: { source: string; reason: string; count: number }[]
  venues: Record<string, { balanceUsd: number | null; equityUsd: number | null; configured: boolean }>
  recent: { at: number; botId: string; botName: string; title: string; outcome: string; detail: string }[]
  limits: { openLiveUsd: number; capUsd: number; liveBots: number; dryRun: boolean; held: HeldBack[] }
}

export interface BoardData {
  board: Signal[]
  verdicts: Record<string, BotVerdict[]>
}

export interface StrategyResult {
  bot: BotSettings
  explanation: string
  unsupported: string[]
  changes: { field: string; from: unknown; to: unknown }[]
}

const c = window.lazyedge.call

export const api = {
  termsStatus: () => c<{ version: string; accepted: boolean; acceptedAt: string | null }>('terms:status'),
  acceptTerms: (version: string, acknowledged: number) => c('terms:accept', version, acknowledged),
  state: () => c<EngineState>('state:get'),
  board: () => c<BoardData>('board:get'),
  start: () => c('engine:start'),
  stop: () => c('engine:stop'),
  cycle: () => c('engine:cycle'),
  killSwitch: (on: boolean) => c('engine:killSwitch', on),
  authStatus: () => c<{ signedIn: boolean; usage?: { prefix: string; tier: string; calls_today: number }; error?: string }>('auth:status'),
  emailStart: (email: string) => c('auth:emailStart', email),
  emailVerify: (email: string, code: string) => c<{ tier: string; prefix: string }>('auth:emailVerify', email, code),
  wallet: () => c<{ tier: string; prefix: string }>('auth:wallet'),
  signOut: () => c('auth:signOut'),
  keys: () => c<Record<string, { set: boolean; hint: string }>>('keys:describe'),
  setKey: (name: string, value: string) => c('keys:set', name, value),
  removeKey: (name: string) => c('keys:remove', name),
  test: (target: string) => c<{ ok: boolean; detail: string }>('keys:test', target),
  models: (p: ProviderId) => c<string[]>('ai:models', p),
  aiConfigured: () => c<Record<ProviderId, boolean>>('ai:configured'),
  account: () => c<AccountSettings>('settings:account'),
  saveAccount: (a: AccountSettings) => c<AccountSettings>('settings:saveAccount', a),
  bots: () => c<BotSettings[]>('bots:list'),
  newBot: (name: string) => c<BotSettings>('bots:new', name),
  saveBot: (b: BotSettings) => c<BotSettings>('bots:save', b),
  deleteBot: (id: string) => c('bots:delete', id),
  copy: (text: string) => c('clipboard:write', text),
  draft: (sentence: string, provider: ProviderId, model?: string) => c<StrategyResult>('bots:draft', sentence, provider, model),
  tickets: (days = 7) => c<Ticket[]>('ledger:tickets', days),
  accuracy: () => c<AccuracyState>('accuracy:get'),
  runAccuracy: () => c<AccuracyState>('accuracy:run'),
  checkPlay: (id: string) => c<PlayReview>('play:check', id),
  reportContext: () => c<ReportContext>('report:context'),
  emailReport: (subject: string, text: string) => c<{ full: boolean }>('report:email', subject, text),
  saveReport: (text: string) => c<string | null>('report:save', text)
}

export interface ReportContext {
  os: string
  supportEmail: string
  problems: EngineState['recent']
}

export interface AccuracyState {
  entries: Record<string, AccuracyEntry>
  running: boolean
  lastRunAt: number | null
}

export function useEngine(): EngineState | null {
  const [s, setS] = useState<EngineState | null>(null)
  useEffect(() => {
    void api.state().then(setS)
    return window.lazyedge.on('state', (next) => setS({ ...next }))
  }, [])
  return s
}

// The slate, refetched after each engine cycle while the Board is open.
export function useBoard(): BoardData | null {
  const [b, setB] = useState<BoardData | null>(null)
  useEffect(() => {
    let last: number | null = -1
    const pull = (at: number | null): void => {
      if (at === last) return
      last = at
      void api.board().then(setB)
    }
    void api.state().then((s) => pull(s.lastCycleAt))
    return window.lazyedge.on('state', (next) => pull((next as EngineState).lastCycleAt))
  }, [])
  return b
}

export const usd = (n: number | null | undefined): string =>
  n === null || n === undefined ? '—' : `${n < 0 ? '−' : ''}$${Math.abs(n).toFixed(2)}`

export const ago = (t: number | null): string => {
  if (!t) return 'never'
  const s = Math.round((Date.now() - t) / 1000)
  return s < 60 ? `${s}s ago` : s < 3600 ? `${Math.round(s / 60)}m ago` : new Date(t).toLocaleTimeString()
}
