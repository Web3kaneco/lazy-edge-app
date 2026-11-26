// Paper trials (2026-11-20): try an AI change on a paper copy beside
// the real bot, then accept it onto the bot or drop it, on the record of both
// since the trial began. Shown on the Desk.
import type { BotSettings } from './schema'
import type { SettledLike } from './results'

// Trades on the trial before the Desk calls the comparison worth reading.
export const TRIAL_MIN_SETTLED = 20

export interface TrialSide { trades: number; won: number; lost: number; pnlUsd: number; contracts: number; centsPerContract: number; open: number }

export interface TrialView {
  trialId: string
  ofId: string
  ofName: string
  what: string
  startedAt: number
  original: TrialSide
  trial: TrialSide
  // ready once the trial has TRIAL_MIN_SETTLED settled trades.
  ready: boolean
  // The plain verdict, only when ready.
  verdict: string | null
}

function side(ts: SettledLike[], since: number): TrialSide {
  const mine = ts.filter((t) => t.createdAt >= since && t.filledContracts > 0)
  const done = mine.filter((t) => t.pnlUsd !== null)
  const pnlUsd = done.reduce((s, t) => s + (t.pnlUsd ?? 0), 0)
  const contracts = done.reduce((s, t) => s + t.filledContracts, 0)
  return {
    trades: done.length,
    won: done.filter((t) => (t.pnlUsd ?? 0) > 0).length,
    lost: done.filter((t) => (t.pnlUsd ?? 0) <= 0).length,
    pnlUsd: Math.round(pnlUsd * 100) / 100,
    contracts,
    centsPerContract: contracts ? Math.round((pnlUsd / contracts) * 1000) / 10 : 0,
    open: mine.length - done.length
  }
}

// Every running trial with both records since it began. Per contract, so a
// live bot's size and a paper copy's are compared fairly.
export function trialViews(bots: BotSettings[], tickets: SettledLike[]): TrialView[] {
  return bots.filter((b) => b.trial).map((t) => {
    const of = bots.find((b) => b.id === t.trial!.of)
    const original = side(tickets.filter((x) => x.botId === t.trial!.of), t.trial!.startedAt)
    const trial = side(tickets.filter((x) => x.botId === t.id), t.trial!.startedAt)
    const ready = trial.trades >= TRIAL_MIN_SETTLED
    const diff = trial.centsPerContract - original.centsPerContract
    const verdict = !ready ? null
      : original.trades === 0 ? `The change made ${trial.centsPerContract}c a contract over ${trial.trades} trades; the bot itself traded nothing to compare.`
        : diff > 0 ? `The change did better: ${trial.centsPerContract}c a contract against ${original.centsPerContract}c, over ${trial.trades} and ${original.trades} trades.`
          : `The change did no better: ${trial.centsPerContract}c a contract against ${original.centsPerContract}c, over ${trial.trades} and ${original.trades} trades.`
    return { trialId: t.id, ofId: t.trial!.of, ofName: of?.name ?? 'a deleted bot', what: t.trial!.what, startedAt: t.trial!.startedAt, original, trial, ready, verdict }
  })
}

// The paper copy for a proposed change: the proposal, as a paper bot that is
// on, named for what it tests.
export function trialBot(original: BotSettings, proposed: BotSettings, what: string, now: number): BotSettings {
  const { trial: _t, ...p } = structuredClone(proposed)
  return {
    ...p,
    id: `trial-${now.toString(36)}`,
    name: `${original.name} (trial)`.slice(0, 80),
    enabled: true,
    mode: 'paper',
    trial: { of: original.id, startedAt: now, what: what.slice(0, 400) }
  }
}

// What accepting writes onto the original: the trial's strategy, with the
// original's own name, on or off, paper or live, money and venues.
export function acceptedBot(original: BotSettings, trial: BotSettings): BotSettings {
  const { trial: _t, ...t } = structuredClone(trial)
  return {
    ...t,
    id: original.id, name: original.name, enabled: original.enabled, mode: original.mode,
    size: original.size,
    market: { ...t.market, venues: original.market.venues },
    guards: { ...t.guards, maxDailyDrawdownUsd: original.guards.maxDailyDrawdownUsd }
  }
}
