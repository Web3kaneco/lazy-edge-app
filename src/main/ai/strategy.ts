// A sentence into a settings document. The model fills a flat draft; the app
// maps it onto the measured defaults and validates it. The result is always
// disabled and in paper mode: the model drafts, the user reviews, saves and
// switches it on. Anything the sentence asks for that the settings cannot
// express is listed back as unsupported rather than silently dropped.
import { z } from 'zod'
import { defaultBot, RULESET_VERSION } from '@shared/ruleset'
import { BotSettings, Lane, Phase, Sport, TradeableLabel, VenueId } from '@shared/schema'
import type { AiProvider } from './types'

const Draft = z.object({
  name: z.string(),
  sports: z.array(Sport),
  lanes: z.array(Lane),
  phase: Phase,
  labels: z.array(TradeableLabel),
  venues: z.array(VenueId),
  minEdgePp: z.number(),
  minEvCents: z.number(),
  priceBandLowC: z.number(),
  priceBandHighC: z.number(),
  maxPriceAgeS: z.number(),
  requireTrigger: z.boolean(),
  measuredOnly: z.boolean(),
  kellyMultiplier: z.number(),
  maxTradeUsd: z.number(),
  minTradeUsd: z.number(),
  maxContracts: z.number(),
  maxGameEquityPct: z.number(),
  noEntryFinalS: z.number(),
  noOvertime: z.boolean(),
  maxDailyDrawdownUsd: z.number(),
  maxTradesPerDay: z.number(),
  explanation: z.string(),
  unsupported: z.array(z.string())
})

export interface StrategyResult {
  bot: BotSettings
  explanation: string
  unsupported: string[]
  // Every field that moved off the measured default, so the user sees exactly
  // what the sentence changed before saving it.
  changes: { field: string; from: unknown; to: unknown }[]
}

const SYSTEM = (guide: string, defaults: BotSettings): string => `You turn a trader's plain English description into a Lazy Edge bot settings draft.

Rules:
1. Start from the measured defaults below. Change a field only when the description asks for it. A default you keep is the right answer, not a lazy one.
2. Every default was measured on real fills. If the description asks for something looser than a default, set what they asked and say in the explanation which measured lesson that relaxes.
3. You only fill settings. You never decide trades, never predict outcomes, and never describe anything as a recommendation.
4. If the description asks for something these settings cannot express, leave the settings at their defaults for it and list it in unsupported, in the trader's own words.
5. Probabilities are in probability points (5 means 5pp). Prices are in cents. Money is in dollars.
6. Write the explanation as two or three plain sentences.

Ruleset ${RULESET_VERSION}. Measured defaults:
${JSON.stringify(defaults, null, 2)}

How to read the Lazy Edge data the bot trades on:
${guide}`

export async function draftStrategy(provider: AiProvider, sentence: string, guide: string, model?: string): Promise<StrategyResult> {
  const base = defaultBot(`bot-${Date.now().toString(36)}`, 'New bot')
  const d = await provider.json({
    system: SYSTEM(guide, base),
    user: sentence,
    schema: Draft,
    schemaName: 'bot_settings_draft',
    model,
    depth: 'careful'
  })

  const bot: BotSettings = structuredClone(base)
  bot.name = d.name.slice(0, 80) || base.name
  bot.enabled = false
  bot.mode = 'paper'
  bot.market = {
    sports: d.sports.length ? d.sports : base.market.sports,
    lanes: d.lanes.length ? d.lanes : base.market.lanes,
    phase: d.phase,
    labels: d.labels.length ? d.labels : base.market.labels,
    venues: d.venues.length ? d.venues : base.market.venues
  }
  bot.entry = {
    ...base.entry,
    minEdgePp: d.minEdgePp,
    minEvCents: d.minEvCents,
    priceBandC: [Math.round(d.priceBandLowC), Math.round(d.priceBandHighC)],
    maxPriceAgeS: Math.round(d.maxPriceAgeS),
    requireTrigger: d.requireTrigger,
    measuredOnly: d.measuredOnly
  }
  bot.size = {
    ...base.size,
    kellyMultiplier: d.kellyMultiplier,
    maxTradeUsd: d.maxTradeUsd,
    minTradeUsd: d.minTradeUsd,
    maxContracts: Math.round(d.maxContracts),
    maxGameEquityPct: d.maxGameEquityPct
  }
  bot.guards = {
    ...base.guards,
    noEntryFinalS: Math.round(d.noEntryFinalS),
    noOvertime: d.noOvertime,
    maxDailyDrawdownUsd: d.maxDailyDrawdownUsd,
    maxTradesPerDay: Math.round(d.maxTradesPerDay)
  }

  // The same validator a hand written document goes through. A draft outside
  // the allowed ranges is an error the user sees, never a clamped guess.
  const parsed = BotSettings.safeParse(bot)
  if (!parsed.success) throw new Error(`The draft is outside the allowed settings: ${parsed.error.issues.map((i) => i.path.join('.')).join(', ')}`)

  return { bot: parsed.data, explanation: d.explanation, unsupported: d.unsupported, changes: diff(base, parsed.data) }
}

function diff(a: unknown, b: unknown, path = ''): StrategyResult['changes'] {
  if (path === 'id' || path === 'name') return []
  if (a && b && typeof a === 'object' && typeof b === 'object' && !Array.isArray(a)) {
    return Object.keys(b as object).flatMap((k) => diff((a as any)[k], (b as any)[k], path ? `${path}.${k}` : k))
  }
  return JSON.stringify(a) === JSON.stringify(b) ? [] : [{ field: path, from: a, to: b }]
}
