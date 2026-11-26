// Typed wrappers over the preload bridge. The renderer holds no key and makes
// no trading decision; it renders state and sends intents.
import { useEffect, useState } from 'react'
import type { AccuracyEntry } from '@shared/accuracy'
import type { DeskRec, DeskSnapshot } from '@shared/desk'
import type { CashOutResult } from '@shared/exits'
import type { Fix } from '@shared/fixes'
import type { LockState } from '@shared/profitlock'
import type { HeldBack } from '@shared/limits'
import type { NoticesState } from '@shared/notices'
import type { PlayReview } from '@shared/review'
import type { AccountSettings, BotSettings, ProviderId } from '@shared/schema'
import type { BotVerdict, PlayTags, Signal } from '@shared/signal'
import type { Change } from '@shared/share'
import type { Pattern } from '@shared/patterns'
import type { TrialView } from '@shared/trials'

// A starter bot's update: new starter settings waiting for a live bot's
// owner (pending), settings an update replaced that can be put back
// (replaced), and what Reset to the starter would change (reset).
export interface StarterStatus { pending: Change[] | null; replaced: Change[] | null; reset?: Change[] }

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
  limits: { openLiveUsd: number; capUsd: number; liveBots: number; held: HeldBack[] }
  profitLock: LockState
}

export interface BoardData {
  board: Signal[]
  verdicts: Record<string, BotVerdict[]>
}

export interface StrategyResult {
  bot: BotSettings
  explanation: string
  recommendation: string
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
  cashOut: () => c<CashOutResult | null>('engine:cashOut'),
  authStatus: () => c<{ signedIn: boolean; usage?: { prefix: string; tier: string; calls_today: number }; error?: string }>('auth:status'),
  setLazyEdgeKey: (key: string) => c<{ tier: string; prefix: string; planInactive?: boolean }>('auth:setKey', key),
  removeLazyEdgeKey: () => c('auth:removeKey'),
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
  paperTest: (maxTradeUsd: number | null) => c<{ on: number; live: string[] }>('bots:paperTest', maxTradeUsd),
  paperStop: () => c<{ off: number }>('bots:paperStop'),
  exportTest: (days: number) => c<string | null>('test:export', days),
  // Applies a Results fix to the bots named; before holds each bot as it was,
  // for undo.
  applyFix: (fix: Fix, botIds: string[]) => c<{ changed: string[]; skipped: { name: string; why: string }[]; before: BotSettings[] }>('results:apply', fix, botIds),
  copy: (text: string) => c('clipboard:write', text),
  // With a bot, the AI edits that bot; without one it drafts a new bot.
  draft: (sentence: string, provider: ProviderId, bot?: BotSettings) => c<StrategyResult>('bots:draft', sentence, provider, bot),
  tickets: (days = 7) => c<Ticket[]>('ledger:tickets', days),
  accuracy: () => c<AccuracyState>('accuracy:get'),
  runAccuracy: () => c<AccuracyState>('accuracy:run'),
  checkPlay: (id: string) => c<PlayReview>('play:check', id),
  reportContext: () => c<ReportContext>('report:context'),
  emailReport: (subject: string, text: string) => c<{ full: boolean }>('report:email', subject, text),
  saveReport: (text: string) => c<string | null>('report:save', text),
  notices: () => c<NoticesState>('notices:get'),
  dismissNotice: (id: string) => c<void>('notices:dismiss', id),
  checkNotices: () => c<NoticesState>('notices:check'),
  reportDay: (day: string) => c<{ tickets: Ticket[]; skips: Record<string, Record<string, number>> }>('report:day', day),
  desk: () => c<DeskState>('desk:get'),
  deskAsk: () => c<DeskState>('desk:ask'),
  deskAi: (on: boolean) => c<DeskState>('desk:ai', on),
  deskApply: (id: string) => c<DeskState>('desk:apply', id),
  deskDismiss: (id: string) => c<DeskState>('desk:dismiss', id),
  starters: () => c<Record<string, StarterStatus>>('starters:status'),
  starterUse: (id: string) => c<void>('starters:use', id),
  starterReset: (id: string) => c<void>('starters:reset', id),
  starterKeep: (id: string) => c<void>('starters:keep', id),
  starterUndo: (id: string) => c<void>('starters:undo', id),
  starterDismiss: (id: string) => c<void>('starters:dismiss', id),
  // AI changes go through the confirmation levels and can be put back.
  aiSave: (bot: BotSettings, what: string) => c<{ bot: BotSettings; changeId: string | null }>('ai:save', bot, what),
  aiChanges: (botId?: string) => c<AiChange[]>('ai:changes', botId),
  aiUndo: (changeId: string) => c<AiChange[]>('ai:undo', changeId),
  aiWhy: (botId: string) => c<WhyAnswer>('ai:why', botId),
  trialStart: (from: string | BotSettings, what?: string) => c<BotSettings>('trial:start', from, what),
  trialAccept: (trialId: string) => c<DeskState>('trial:accept', trialId),
  trialDrop: (trialId: string) => c<DeskState>('trial:drop', trialId),
  deskRecap: () => c<DeskState>('desk:recap'),
  deskChat: (question: string, history: { q: string; a: string }[]) => c<ChatReply>('desk:chat', question, history),
  chatApply: (id: string) => c<{ bot: BotSettings; changeId: string | null }>('chat:apply', id),
  chatTrial: (id: string) => c<BotSettings>('chat:trial', id),
  patternBot: (key: string) => c<BotSettings>('desk:patternBot', key),
  patternFix: (key: string) => c<DeskState>('desk:patternFix', key),
  patternTrial: (key: string) => c<DeskState>('desk:patternTrial', key)
}

export interface AiChange { id: string; at: number; botId: string; source: 'ai box' | 'desk' | 'trial' | 'chat'; what: string; undoneAt?: number }
export interface ChatProposal {
  id: string; botId: string; botName: string; request: string; explanation: string; unsupported: string[]
  changes: { field: string; name: string; from: string; to: string }[]
  level: 1 | 2 | 3; bot: BotSettings
}
export interface ChatReply { answer: string; proposals: ChatProposal[] }
export interface WhyAnswer { headline: string; lines: string[]; text: string; by: 'ai' | 'plain' }

export interface DeskState {
  recs: DeskRec[]
  aiOn: boolean
  provider: ProviderId | null
  lastRulesAt: number | null
  lastAiAt: number | null
  aiBusy: boolean
  aiError: string | null
  snapshot: DeskSnapshot | null
  trials: TrialView[]
  recap: { day: string; at: number; text: string; by: 'ai' | 'plain' } | null
  recapBusy: boolean
  patterns: Pattern[]
}

// The desk, pushed whenever a check or the AI adds something.
export function useDesk(): [DeskState | null, (s: DeskState) => void] {
  const [s, setS] = useState<DeskState | null>(null)
  useEffect(() => {
    void api.desk().then(setS).catch(() => {})
    return window.lazyedge.on('desk', (next) => setS(next))
  }, [])
  return [s, setS]
}

// Team notices and update alerts, pushed whenever they change.
export function useNotices(): NoticesState | null {
  const [s, setS] = useState<NoticesState | null>(null)
  useEffect(() => {
    void api.notices().then(setS).catch(() => {})
    return window.lazyedge.on('notices', (next) => setS(next))
  }, [])
  return s
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
