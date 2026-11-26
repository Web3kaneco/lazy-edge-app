// A sentence into a settings document. The model fills a flat draft; the app
// maps it onto the measured defaults and validates it. The result is always
// disabled and in paper mode: the model drafts, the user reviews, saves and
// switches it on. Anything the sentence asks for that the settings cannot
// express is listed back as unsupported rather than silently dropped.
import { z } from 'zod'
import { defaultBot, RULESET_VERSION } from '@shared/ruleset'
import { BotSettings, ExitMode, Lane, Phase, Quarter, Sport, TradeableLabel, VenueId } from '@shared/schema'
import type { AiProvider } from './types'

const Draft = z.object({
  name: z.string(),
  sports: z.array(Sport),
  lanes: z.array(Lane),
  phase: Phase,
  quarters: z.array(Quarter),
  labels: z.array(TradeableLabel),
  venues: z.array(VenueId),
  minEdgePp: z.number(),
  minChancePregamePct: z.number(),
  minChanceQ1Pct: z.number(),
  minChanceQ2Pct: z.number(),
  minChanceQ3Pct: z.number(),
  minChanceQ4Pct: z.number(),
  // The most points a backed team may trail by, every quarter; -1 is no limit.
  maxTrailingPoints: z.number(),
  favoritesOnly: z.boolean(),
  buyOurPick: z.boolean(),
  flatSize: z.boolean(),
  // With buyOurPick: the fewest points our chance must sit above the price; -1 is not used.
  pickGapPp: z.number(),
  exitMode: ExitMode,
  exitTargetC: z.number(),
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
  // Player props on the game's top players only; -1 trades every player.
  propTopPlayers: z.number(),
  // When the ask is above what the play is worth, place a bid below it.
  bidWhenOverpriced: z.boolean(),
  explanation: z.string(),
  // The AI's recommendation with the math, in plain words (2026-11-21).
  recommendation: z.string(),
  unsupported: z.array(z.string())
})

export interface StrategyResult {
  bot: BotSettings
  explanation: string
  recommendation: string
  unsupported: string[]
  // Every field that moved off the measured default, so the user sees exactly
  // what the sentence changed before saving it.
  changes: { field: string; from: unknown; to: unknown }[]
}

// What the app already does, and the arithmetic, so the AI answers with the
// math instead of calling a request unsupported (2026-11-21: it said props
// could not choose over or under, which they always have).
const APP_FACTS = `How the app works, which you must use instead of listing a request as unsupported:
- Player props: for each player and stat the app makes one play on whichever side, over or under, our chance favors. The bot never chooses over or under; it is automatic.
- propTopPlayers keeps props to the players ranked this high or better in their game by our points projection, both teams together (10 means the top 10 in the game); -1 trades every player.
- The chance every check reads is the honest chance: our number, lowered by how often teams in the same spot came back and by how the trader's own settled plays like it did. It is never raised.
- Kelly sizing stakes more the more a play is underpriced on the honest chance, and less on a long shot; flat sizing stakes the same every time. Sizing is money, so the trader switches it.
- bidWhenOverpriced: when the ask is above what the play is worth, the bot places a buy below the ask at the highest price that still clears the minimum edge, and leaves it for a few minutes in case the price comes down. A resting order pays about a quarter of the normal fee, but it fills most often when the price is falling for a reason.
- The math, per contract held to the end, with price p and honest chance q both 0 to 1: Kalshi's fee is about 0.07 x p x (1 - p); the break even price is about q minus that fee; the profit on average is q - p - fee. At q = 60%, break even is about 58c; a minimum edge of 3 buys at 57c or less for about +1.3c a contract, and an edge of 5 at 55c or less for about +3.3c. A chance that is 2 points too high wipes out a 3 point edge.

Your recommendation: say in plain words, with that math and the numbers that matter, what you would set and why, what the trader should change themselves on the bot (money and sizing), and the trade off. Recommend settings only; never predict an outcome or pick a trade.`

const SYSTEM = (guide: string, defaults: BotSettings): string => `You turn a trader's plain English description into a Lazy Edge bot settings draft.

Rules:
1. Start from the measured defaults below. Change a field only when the description asks for it. A default you keep is the right answer, not a lazy one.
2. Every default was measured on real fills. If the description asks for something looser than a default, set what they asked and say in the explanation which measured lesson that relaxes.
3. You only fill settings and recommend them. You never decide trades or predict outcomes.
4. If the description asks for something these settings cannot express, leave the settings at their defaults for it and list it in unsupported, in the trader's own words.
5. Probabilities are in probability points (5 means 5pp). Prices are in cents. Money is in dollars. maxTrailingPoints is the most points a team the bot backs may be behind in a live game, every quarter, and -1 means no limit; favoritesOnly backs only the team the market prices to win. buyOurPick buys only the side the Lazy Edge number has winning and ignores minEdgePp and minEvCents; set it only when the description asks to follow our pick or the model's favourite rather than the edge. flatSize makes every trade maxTradeUsd instead of Kelly sizing; a bot with buyOurPick needs it, because Kelly sizes a trade with no edge at nothing. pickGapPp, with buyOurPick, is the fewest points our chance must sit above the price, such as 3 for "priced at least 3 points under our number"; use -1 when the description does not ask for it.
6. Write the explanation as two or three plain sentences.

${APP_FACTS}

Ruleset ${RULESET_VERSION}. Measured defaults:
${JSON.stringify(defaults, null, 2)}

How to read the Lazy Edge data the bot trades on:
${guide}`

// Editing a bot the user already has (2026-11-20: "just type things in
// to the AI and have it do the settings"). The model starts from that bot,
// changes only what the request asks, and never touches money: trade size,
// sizing, the loss stop, or paper or live. Those stay the user's.
const EDIT = (guide: string, current: BotSettings): string => `You change a Lazy Edge bot's settings to do what the trader asks, in plain English.

Rules:
1. Start from the bot's current settings below. Change only what the request asks for and keep every other field exactly as it is now.
2. Money belongs to the trader. Keep maxTradeUsd, minTradeUsd, kellyMultiplier, maxContracts, maxGameEquityPct, flatSize and maxDailyDrawdownUsd exactly as they are now, whatever the request says. If it asks to change one, list it in unsupported as "change <the setting> yourself on the bot".
3. You only fill settings and recommend them. You never decide trades or predict outcomes.
4. Words traders use: "chance", "likely to hit", "trending to hit" or "on pace" mean our probability that the play pays out, the minChance fields, set per quarter; "the edge" or "priced under our number" mean minEdgePp, the points our chance sits above the price. Player props are the PROP lane. "In game", "live" or "in play" is phase live; "the 2nd, 3rd and 4th quarters" is quarters Q2, Q3 and Q4, and a quarter left out is never traded. A quarter not traded can keep its minChance value.
5. If the request asks for something these settings cannot express, leave the settings for it as they are and list it in unsupported, in the trader's own words.
6. Probabilities are in probability points (5 means 5pp). Prices are in cents. maxTrailingPoints is the most points a team the bot backs may be behind, every quarter, and -1 means no limit. buyOurPick buys only the side the Lazy Edge number has winning; pickGapPp is then the fewest points our chance must sit above the price, or -1.
7. Keep the name unless the request asks for a new one. Write the explanation as two or three plain sentences saying what changed. Even when nothing changes, the recommendation must answer the request with the math.

${APP_FACTS}

Current settings:
${JSON.stringify(current, null, 2)}

How to read the Lazy Edge data the bot trades on:
${guide}`

export async function draftStrategy(provider: AiProvider, sentence: string, guide: string, model?: string, current?: BotSettings): Promise<StrategyResult> {
  const base = current ? structuredClone(current) : defaultBot(`bot-${Date.now().toString(36)}`, 'New bot')
  const d = await provider.json({
    system: current ? EDIT(guide, base) : SYSTEM(guide, base),
    user: sentence,
    schema: Draft,
    schemaName: 'bot_settings_draft',
    model,
    depth: 'careful'
  })

  const bot: BotSettings = structuredClone(base)
  bot.name = d.name.slice(0, 80) || base.name
  // A new draft is off and in paper; an edit keeps whether the bot runs.
  bot.enabled = current ? current.enabled : false
  bot.mode = current ? current.mode : 'paper'
  bot.market = {
    sports: d.sports.length ? d.sports : base.market.sports,
    lanes: d.lanes.length ? d.lanes : base.market.lanes,
    phase: d.phase,
    quarters: d.quarters.length ? d.quarters : base.market.quarters,
    labels: d.labels.length ? d.labels : base.market.labels,
    venues: d.venues.length ? d.venues : base.market.venues,
    propTopPlayers: d.propTopPlayers < 1 ? null : Math.min(30, Math.round(d.propTopPlayers)),
    // Not an AI field: an edit keeps the sides the user switched off.
    propSidesOff: base.market.propSidesOff ?? []
  }
  bot.entry = {
    ...base.entry,
    minEdgePp: d.minEdgePp,
    minEvCents: d.minEvCents,
    priceBandC: [Math.round(d.priceBandLowC), Math.round(d.priceBandHighC)],
    maxPriceAgeS: Math.round(d.maxPriceAgeS),
    requireTrigger: d.requireTrigger,
    measuredOnly: d.measuredOnly,
    minChancePct: { pregame: d.minChancePregamePct, Q1: d.minChanceQ1Pct, Q2: d.minChanceQ2Pct, Q3: d.minChanceQ3Pct, Q4: d.minChanceQ4Pct },
    maxTrailing: (() => {
      const n = d.maxTrailingPoints < 0 ? null : Math.round(d.maxTrailingPoints)
      return { Q1: n, Q2: n, Q3: n, Q4: n }
    })(),
    favoritesOnly: d.favoritesOnly,
    basis: d.buyOurPick ? 'pick' : 'edge',
    pickGapPp: d.buyOurPick && d.pickGapPp >= 0 ? Math.min(50, d.pickGapPp) : null,
    orderType: d.bidWhenOverpriced ? 'bid' : 'take'
  }
  bot.exit = { ...bot.exit, mode: d.exitMode, targetC: Math.round(d.exitTargetC) }
  // Money is the user's: an edit keeps the bot's own size and loss stop
  // whatever the model returned, and the venues follow the user's keys.
  bot.size = current ? structuredClone(current.size) : {
    ...base.size,
    kellyMultiplier: d.kellyMultiplier,
    maxTradeUsd: d.maxTradeUsd,
    minTradeUsd: d.minTradeUsd,
    maxContracts: Math.round(d.maxContracts),
    maxGameEquityPct: d.maxGameEquityPct,
    sizing: d.flatSize ? 'flat' : 'kelly'
  }
  if (current) bot.market.venues = current.market.venues
  bot.guards = {
    ...base.guards,
    noEntryFinalS: Math.round(d.noEntryFinalS),
    noOvertime: d.noOvertime,
    maxDailyDrawdownUsd: current ? current.guards.maxDailyDrawdownUsd : d.maxDailyDrawdownUsd,
    maxTradesPerDay: Math.round(d.maxTradesPerDay)
  }

  // The same validator a hand written document goes through. A draft outside
  // the allowed ranges is an error the user sees, never a clamped guess.
  const parsed = BotSettings.safeParse(bot)
  if (!parsed.success) throw new Error(`The draft is outside the allowed settings: ${parsed.error.issues.map((i) => i.path.join('.')).join(', ')}`)

  return { bot: parsed.data, explanation: d.explanation, recommendation: d.recommendation, unsupported: d.unsupported, changes: diff(base, parsed.data) }
}

function diff(a: unknown, b: unknown, path = ''): StrategyResult['changes'] {
  if (path === 'id' || path === 'name') return []
  if (a && b && typeof a === 'object' && typeof b === 'object' && !Array.isArray(a)) {
    return Object.keys(b as object).flatMap((k) => diff((a as any)[k], (b as any)[k], path ? `${path}.${k}` : k))
  }
  return JSON.stringify(a) === JSON.stringify(b) ? [] : [{ field: path, from: a, to: b }]
}
