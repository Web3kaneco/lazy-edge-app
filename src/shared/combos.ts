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

// The API's NBA tickets as combos to buy (agent guide, NBA tickets): each
// ticket's picks with their Kalshi ticker, our chance and the ask, our chance
// every leg wins (p_all) and the prices multiplied (market_p_all). Only a
// ticket that has locked, 20 minutes before the night's first tip, so it no
// longer changes, and only while none of its games has tipped. A pick without
// a ticker or a price, or two picks on one game, makes the ticket unusable.
//
// From 25 November the API's tickets can carry player props. the owner chose
// straight props only (24 November), and a prop leg and its own team's win
// on one game slipped past the one game check, which compared whole market
// names. A ticket with any pick that is not a game winner is skipped, and
// one game is now told by the game code every NBA ticker shares.
export function apiTicketPicks(body: unknown, now: number): ComboPick[] {
  const b = body as any
  const tickets: any[] = Array.isArray(b) ? b : Array.isArray(b?.tickets) ? b.tickets : []
  const out: ComboPick[] = []
  for (const t of tickets) {
    if (!(t?.locked ?? b?.locked)) continue
    const picks: any[] = Array.isArray(t?.picks) ? t.picks : []
    if (picks.length < 2) continue
    const legs: ComboLeg[] = []
    for (const p of picks) {
      const ticker = typeof p?.ticker === 'string' ? p.ticker : ''
      const ourP = typeof p?.our_prob === 'number' ? p.our_prob : NaN
      const price = typeof p?.price === 'number' ? p.price : NaN
      const tip = p?.tip ? Date.parse(String(p.tip)) : NaN
      if (!ticker || !(ourP > 0 && ourP < 1) || !(price > 0 && price < 1)) break
      if (!/^KXNBAGAME-/i.test(ticker)) break
      if (Number.isFinite(tip) && tip <= now) break
      if (legs.some((l) => gameCodeOf(l.contract) === gameCodeOf(ticker))) break
      legs.push({ signalKey: `nba-ticket:${ticker}`, gameId: eventOf(ticker), title: `${p.team ?? ticker}${p.opp ? ` over ${p.opp}` : ''}`, contract: ticker, side: 'yes', ourP, askC: Math.round(price * 100), edgePp: (ourP - price) * 100 })
    }
    if (legs.length !== picks.length) continue
    const chance = typeof t.p_all === 'number' ? t.p_all : legs.reduce((x, l) => x * l.ourP, 1)
    const market = typeof t.market_p_all === 'number' ? t.market_p_all : legs.reduce((x, l) => x * (l.askC / 100), 1)
    out.push({ legs, chance, legsPriceC: Math.round(market * 10000) / 100, source: 'lazy_edge' })
  }
  return out
}

// The game a Kalshi NBA ticker belongs to, the same for its winner, spread,
// total and every player prop: 26NOV24BOSWAS in KXNBAREB-26NOV24BOSWAS-BOSJTATUM0-6.
export function gameCodeOf(ticker: string): string {
  return (ticker.split('-')[1] ?? ticker).toUpperCase()
}

// The ticker without its last segment: right for game markets
// (KXNBAGAME-26NOV23MEMCHA-MEM), not for player props, whose event is one
// segment shorter again. Used here only to keep two legs from one market;
// the event sent to Kalshi comes from its combo list (comboEventOf).
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

// How many contracts to ask a combo's makers for (2026-11-23). A request by
// dollar amount came back with every quote sized 0 (Kalshi puts that size in
// other fields), so the request names a count: the most contracts that fit
// the budget at the highest price we would ever take, our chance less the
// edge minimum. Any quote we accept then costs no more than the budget.
export function comboRfqContracts(budgetUsd: number, chance: number, minEdgePp: number, maxContracts: number): number {
  const ceilingC = Math.min(99, Math.max(1, chance * 100 - minEdgePp))
  return Math.max(0, Math.min(maxContracts, Math.floor((budgetUsd * 100) / ceilingC + 1e-9)))
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
