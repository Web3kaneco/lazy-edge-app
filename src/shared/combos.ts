// Combos (2026-11-16): a bot ties two or more plays it would take on their
// own into one Kalshi combo market and buys YES on it. Pure, so the engine
// and the tests read the same rules. internal/combos.md has the background.
//
// Legs come from different games only. Legs from one game move together (a
// player going over and his team winning), so multiplying their chances
// would overstate the combo; same game combos wait for Lazy Edge's parlay
// API, which plugs in where comboChance says.
//
// Combo markets have no order book. A price comes from a request for quote:
// makers answer with yes_bid_dollars and no_bid_dollars. Kalshi's docs do
// not say in so many words what a requester pays to buy YES, so both
// readings are checked against the legs' own market prices and a reading is
// used only when exactly one of them is coherent. Live fills then confirm it.
import type { ContractSide } from './signal'

export interface ComboLeg {
  signalKey: string
  gameId: string
  title: string
  // The Kalshi market and side this leg buys, as the bot would buy it alone.
  contract: string
  side: ContractSide
  // Our chance the leg pays, and the ask a single order would pay for it.
  ourP: number
  askC: number
  edgePp: number
}

export interface ComboPick {
  legs: ComboLeg[]
  // Our chance every leg pays.
  chance: number
  // What the legs cost bought one by one: the market's own price of the combo.
  legsPriceC: number
  // Where the chance came from, so a ledger line says which model priced it.
  source: 'legs_multiplied' | 'lazy_edge'
}

// Kalshi names an event by the ticker without its last segment:
// KXNBAPTS-99JAN01AAABBB-AAAPONE-25 belongs to KXNBAPTS-99JAN01AAABBB-AAAPONE.
export function eventOf(contract: string): string {
  const parts = contract.split('-')
  return parts.length > 2 ? parts.slice(0, -1).join('-') : contract
}

// The best edged legs the bot would take alone, one per game, up to `count`.
// Null when there are not enough games to build a combo.
export function pickCombo(candidates: ComboLeg[], count: number): ComboPick | null {
  const byGame = new Map<string, ComboLeg>()
  for (const c of [...candidates].sort((a, b) => b.edgePp - a.edgePp)) {
    if (!c.gameId || byGame.has(c.gameId)) continue
    if ([...byGame.values()].some((l) => eventOf(l.contract) === eventOf(c.contract))) continue
    byGame.set(c.gameId, c)
  }
  const legs = [...byGame.values()].slice(0, count)
  if (legs.length < Math.max(2, count)) return null
  return {
    legs,
    chance: comboChance(legs),
    legsPriceC: Math.round(legs.reduce((p, l) => p * (l.askC / 100), 1) * 10000) / 100,
    source: 'legs_multiplied'
  }
}

// Different games are independent enough to multiply. Lazy Edge's parlay API
// replaces this once it publishes a combo price.
export function comboChance(legs: ComboLeg[]): number {
  return legs.reduce((p, l) => p * l.ourP, 1)
}

export type QuoteReading = 'yes_bid' | 'one_minus_no_bid'

export interface QuotePrice {
  // What buying YES on the combo costs, in cents, or null when it does not add up.
  buyYesC: number | null
  reading: QuoteReading | null
  why: string
}

// A maker's markup over the legs bought one by one is expected; more than this
// many times the legs' price, or under it at all, does not look like a real
// price for buying YES.
const MAX_MARKUP = 2.5

// The price of buying YES from one quote. The two numbers say which way to
// read them: a maker's two bids leave a spread, so they sum under 100, and
// buying YES costs 100 minus the NO bid; two prices to buy carry the maker's
// margin, so they sum over 100, and buying YES costs the YES figure. At
// exactly 100 the two readings give the same price. A reading confirmed by a
// live fill must agree with this, and the price must sit at or above what the
// legs cost bought one by one, within MAX_MARKUP of it. Anything else is
// refused: a combo is never bought on a price that does not add up.
export function quotePrice(yesBidC: number, noBidC: number, legsPriceC: number, confirmed: QuoteReading | null): QuotePrice {
  if (!(yesBidC > 0 && yesBidC < 100 && noBidC > 0 && noBidC < 100)) return { buyYesC: null, reading: null, why: `the quote is not a price: yes ${yesBidC}c, no ${noBidC}c` }
  const sum = yesBidC + noBidC
  // At or near 100 the numbers cannot say which way they read, so a reading
  // confirmed by live fills decides, and decides which side is accepted.
  const reading: QuoteReading = confirmed && Math.abs(sum - 100) <= 0.5 ? confirmed : sum > 100 ? 'yes_bid' : 'one_minus_no_bid'
  if (confirmed && confirmed !== reading) {
    return { buyYesC: null, reading: null, why: `yes ${yesBidC}c and no ${noBidC}c read the other way from the confirmed fills` }
  }
  const buyYesC = reading === 'yes_bid' ? yesBidC : Math.round((100 - noBidC) * 100) / 100
  if (buyYesC < legsPriceC - 0.5) return { buyYesC: null, reading: null, why: `${buyYesC}c is under the ${legsPriceC}c the legs cost one by one, which does not look right` }
  if (buyYesC > Math.max(legsPriceC * MAX_MARKUP, legsPriceC + 3)) return { buyYesC: null, reading: null, why: `${buyYesC}c is far over the ${legsPriceC}c the legs cost one by one` }
  return { buyYesC, reading, why: `${buyYesC}c against ${legsPriceC}c for the legs one by one${confirmed ? ', the confirmed reading' : ''}` }
}

// The best quote to buy YES from: the cheapest coherent one.
export function bestQuote<Q extends { yesBidC: number; noBidC: number }>(quotes: Q[], legsPriceC: number, confirmed: QuoteReading | null): { quote: Q; price: QuotePrice } | null {
  let best: { quote: Q; price: QuotePrice } | null = null
  for (const q of quotes) {
    const price = quotePrice(q.yesBidC, q.noBidC, legsPriceC, confirmed)
    if (price.buyYesC !== null && (!best || price.buyYesC < best.price.buyYesC!)) best = { quote: q, price }
  }
  return best
}

// Whether a live fill matches the price the reading predicted, to the cent.
export const fillMatches = (expectedC: number, filledC: number): boolean => Math.abs(expectedC - filledC) <= 1

// The side of the quote to accept to buy YES under a reading: a maker's NO
// bid is what sells us YES; a price to buy YES is accepted on YES.
export const acceptSideFor = (reading: QuoteReading): 'yes' | 'no' => reading === 'yes_bid' ? 'yes' : 'no'

// The position one fill leaves, from Kalshi's own action and side: buying YES
// (or bidding on the YES book) holds YES; selling YES, or buying NO, holds NO.
export function fillPosition(action: string | undefined, side: string | undefined): ContractSide | null {
  const a = String(action ?? 'buy').toLowerCase()
  const s = String(side ?? '').toLowerCase()
  // The YES only book's own terms already carry the direction.
  if (s === 'bid') return 'yes'
  if (s === 'ask') return 'no'
  if (s !== 'yes' && s !== 'no') return null
  return (a === 'sell') !== (s === 'yes') ? 'yes' : 'no'
}
