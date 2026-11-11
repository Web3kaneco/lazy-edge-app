// Check this play: one ticket judged on two questions. Did it trade correctly,
// meaning the price, size and fee are right and the result matches Kalshi's
// own record? And was it a sound play under the bot's rules, or a misguided
// one? Read only: public Kalshi data and the local ledger, nothing placed.
import { checkSettlement, classifyFill, PRINT_WINDOW_S, type Print } from '@shared/accuracy'
import { MIN_SETTLED, settled, tagsOf } from '@shared/results'
import { defaultBot } from '@shared/ruleset'
import { rulesOf, type PlayCheck, type PlayReview } from '@shared/review'
import type { BotSettings } from '@shared/schema'
import type { ContractSide } from '@shared/signal'
import { orderFee } from '../rules/fees'
import type { Ticket } from '../store/ledger'
import type { KalshiVenue } from '../venues/kalshi'

export interface Evidence {
  // Real Kalshi trades around a paper fill. Null when not read: not priced
  // off Kalshi, the window around the fill still open, or the read failed.
  prints: Print[] | null
  // Kalshi's settled side. Null while the market is open or not read.
  result: ContractSide | null
}

const money = (n: number): string => `${n < 0 ? '−' : ''}$${Math.abs(n).toFixed(2)}`
const cents = (c: number): string => `${Number.isInteger(c) ? c : c.toFixed(1)}c`
const pct = (p: number): string => `${(p * 100).toFixed(1)}%`
const VENUE: Record<string, string> = { kalshi: 'Kalshi', polymarket: 'Polymarket', paper: 'Paper' }
const MINUTES = PRINT_WINDOW_S / 60

export function reviewPlay(t: Ticket, bot: BotSettings | null, ev: Evidence, history: Ticket[], now = Date.now()): PlayReview {
  const checks: PlayCheck[] = []
  const trade = (level: PlayCheck['level'], title: string, text: string): void => { checks.push({ group: 'trade', level, title, text }) }
  const play = (level: PlayCheck['level'], title: string, text: string): void => { checks.push({ group: 'play', level, title, text }) }
  const source = t.venue === 'paper' ? t.priceSource : t.venue
  const kalshiPriced = source === 'kalshi'
  const filled = t.filledContracts
  const fillC = t.avgFillC

  // Did it trade correctly?
  if (filled < 1) {
    if (t.status === 'rejected') trade('bad', 'Order', `${VENUE[t.venue] ?? t.venue} refused the order${t.error ? `: ${t.error}` : ''}. No money moved.`)
    else if (t.status === 'dry_run') trade('info', 'Order', 'Dry run: the order was worked out but never sent. No money moved.')
    else if (t.status === 'resting') trade('info', 'Order', `The order is resting at ${t.limitPriceC}c and nothing has filled yet.`)
    else trade('info', 'Order', `Nothing filled${t.error ? `: ${t.error}` : ''}. No money moved.`)
  } else {
    if (fillC === null) trade('bad', 'Price', `${filled} contracts filled but no fill price was recorded.`)
    else if (fillC <= t.limitPriceC + 1e-9) trade('ok', 'Price', `Filled at ${cents(fillC)}, at or under its ${t.limitPriceC}c limit.`)
    else trade('bad', 'Price', `Filled at ${cents(fillC)}, above its ${t.limitPriceC}c limit. A buy should never pay more than its limit.`)

    if (filled > t.contracts) trade('bad', 'Size', `${filled} contracts filled on an order for ${t.contracts}.`)
    else trade('ok', 'Size', filled === t.contracts ? `All ${filled} contracts filled.` : `${filled} of ${t.contracts} contracts filled; the book did not offer the rest at the limit.`)

    if (t.venue !== 'paper') trade('ok', 'Fill', `This fill is ${VENUE[t.venue] ?? t.venue}'s own record of the order.`)
    else if (!kalshiPriced) trade('info', 'Fill', `Priced off ${VENUE[source] ?? source}, whose trades this check cannot read.`)
    else if (ev.prints === null) trade('info', 'Fill', `Kalshi's trades around this fill cannot be read yet. Try again a few minutes after the fill.`)
    else {
      const f = classifyFill(t, ev.prints, now)
      if (f.verdict === 'confirmed') trade('ok', 'Fill', `Real Kalshi trades within ${MINUTES} minutes paid ${f.bestOurSideC}c for this side, so a ${cents(fillC ?? 0)} fill was really there.`)
      else if (f.verdict === 'book_only') trade('ok', 'Fill', `No one traded this market within ${MINUTES} minutes, so the fill rests on the order book the app recorded as it filled.`)
      else if (f.verdict === 'better_than_market') trade('bad', 'Fill', `Every real Kalshi trade within ${MINUTES} minutes paid ${f.bestOurSideC}c or more, but paper filled at ${cents(fillC ?? 0)}. The paper fill looks better than the market really was.`)
      else trade('look', 'Fill', `No real trades within ${MINUTES} minutes and no recorded book, so this paper fill cannot be proven either way.`)
    }

    if (t.venue === 'paper') {
      const expected = orderFee(t.priceSource, (fillC ?? t.limitPriceC) / 100, filled)
      if (Math.abs(t.feeUsd - expected) <= 0.011) trade('ok', 'Fee', `${money(t.feeUsd)} is what ${VENUE[t.priceSource] ?? t.priceSource} charges for ${filled} contracts at that price.`)
      else trade('look', 'Fee', `Recorded ${money(t.feeUsd)}, but ${VENUE[t.priceSource] ?? t.priceSource}'s fee formula gives ${money(expected)}.`)
    } else {
      trade('info', 'Fee', `${money(t.feeUsd)}, as ${VENUE[t.venue] ?? t.venue} reported it.`)
    }

    if (!kalshiPriced) {
      if (t.pnlUsd !== null) trade('info', 'Settlement', `Recorded ${money(t.pnlUsd)}. This check reads results from Kalshi only.`)
    } else if (ev.result === null) {
      trade('info', 'Settlement', t.pnlUsd === null ? 'Kalshi has not settled this market yet.' : `Recorded ${money(t.pnlUsd)}, but Kalshi's result could not be read just now.`)
    } else {
      const s = checkSettlement(t, ev.result, now)
      const side = ev.result.toUpperCase()
      if (t.pnlUsd === null) trade('look', 'Settlement', `Kalshi settled it ${side}, and the app has not recorded the result yet. It normally catches up within a few engine cycles.`)
      else if (s.ok) trade('ok', 'Settlement', `Kalshi settled it ${side}. The recorded ${money(t.pnlUsd)} matches the price paid and the fee to the cent.`)
      else trade('bad', 'Settlement', `Kalshi settled it ${side}, which gives ${money(s.expectedPnlUsd)}, but the app recorded ${money(t.pnlUsd)}.`)
    }
  }

  // Was it a sound play?
  const odds = /breakeven ([\d.]+)%, calibrated p ([\d.]+)%/.exec(t.audit.join(' '))
  const breakeven = odds ? Number(odds[1]) / 100 : null
  const p = odds ? Number(odds[2]) / 100 : null
  if (p !== null && breakeven !== null) {
    if (p > breakeven) play('ok', 'Edge', `The bot rated it ${pct(p)} to win after its haircut and it needed ${pct(breakeven)} to break even, worth ${t.evCents.toFixed(1)}c a contract.`)
    else play('bad', 'Edge', `The bot rated it ${pct(p)} to win but it needed ${pct(breakeven)} to break even, so it should not have been taken.`)
  } else {
    play('info', 'Edge', `Expected value at entry ${t.evCents.toFixed(1)}c a contract.`)
  }

  const rules = t.rules ?? (bot ? rulesOf(bot) : null)
  if (!rules) {
    play('info', 'Rules', 'The bot has been deleted and this ticket is older than saved rules, so its rules cannot be checked.')
  } else {
    const broken: string[] = []
    if (t.evCents < rules.minEvCents - 1e-6) broken.push(`expected value ${t.evCents.toFixed(1)}c is under the ${rules.minEvCents}c minimum`)
    const [lo, hi] = rules.priceBandC
    if (t.limitPriceC < lo || t.limitPriceC > hi) broken.push(`price ${t.limitPriceC}c is outside the ${lo} to ${hi}c band`)
    const edge = t.play?.edgePp
    if (edge !== null && edge !== undefined && Math.abs(edge) < rules.minEdgePp - 1e-6) broken.push(`edge ${Math.abs(edge).toFixed(1)}pp is under the ${rules.minEdgePp}pp minimum`)
    if (t.costUsd > rules.maxTradeUsd + 0.01) broken.push(`cost ${money(t.costUsd)} is over the ${money(rules.maxTradeUsd)} trade limit`)
    if (t.contracts > rules.maxContracts) broken.push(`${t.contracts} contracts is over the ${rules.maxContracts} contract limit`)
    const against = t.rules ? 'the rules it ran with' : "the bot's settings now, which may have changed since this older ticket"
    if (!broken.length) play('ok', 'Rules', `It met every entry and size rule, checked against ${against}.`)
    else play(t.rules ? 'bad' : 'look', 'Rules', `Against ${against}: ${broken.join('; ')}.`)

    const measured = defaultBot('x', 'x').entry
    const loose: string[] = []
    if (rules.edgeHaircut > measured.edgeHaircut + 1e-9) loose.push(`haircut ${rules.edgeHaircut} (measured ${measured.edgeHaircut})`)
    if (rules.minEvCents < measured.minEvCents - 1e-9) loose.push(`minimum EV ${rules.minEvCents}c (measured ${measured.minEvCents}c)`)
    if (rules.minEdgePp < measured.minEdgePp - 1e-9) loose.push(`minimum edge ${rules.minEdgePp}pp (measured ${measured.minEdgePp}pp)`)
    if (rules.priceBandC[0] < measured.priceBandC[0] || rules.priceBandC[1] > measured.priceBandC[1]) loose.push(`price band ${lo} to ${hi}c (measured ${measured.priceBandC[0]} to ${measured.priceBandC[1]}c)`)
    if (loose.length) play('look', 'Settings', `Looser than the measured defaults: ${loose.join('; ')}. Looser settings take plays the measured evidence says to skip.`)
    else play('ok', 'Settings', 'The entry settings are at or tighter than the measured defaults.')
  }

  if (t.pnlUsd !== null && filled > 0) {
    if (t.pnlUsd < 0 && p !== null) play('info', 'Outcome', `It lost ${money(-t.pnlUsd)}. A play rated ${pct(p)} still loses about ${Math.round((1 - p) * 10)} times in 10, so one loss on its own does not make the play wrong.`)
    else if (t.pnlUsd < 0) play('info', 'Outcome', `It lost ${money(-t.pnlUsd)}. One loss on its own does not make the play wrong.`)
    else play('info', 'Outcome', `It won ${money(t.pnlUsd)}.`)
  }

  // The kind of play, judged on this bot's record rather than one result.
  const tags = tagsOf(t)
  const kind = [tags.sport, tags.lane, tags.phase].filter(Boolean).join(' ')
  const same = (h: Ticket): boolean => { const g = tagsOf(h); return g.sport === tags.sport && g.lane === tags.lane && (g.phase ?? 'pregame') === (tags.phase ?? 'pregame') }
  const like = settled(history).filter((h) => h.botId === t.botId && same(h))
  if (kind && like.length >= MIN_SETTLED) {
    const won = like.filter((h) => (h.pnlUsd ?? 0) > 0).length
    const net = like.reduce((s, h) => s + (h.pnlUsd ?? 0), 0)
    const contracts = like.reduce((s, h) => s + h.filledContracts, 0)
    const avgPrice = contracts ? like.reduce((s, h) => s + h.filledContracts * (h.avgFillC ?? h.limitPriceC), 0) / contracts / 100 : 0
    const record = `This bot's ${like.length} settled ${kind} plays won ${won} for ${money(net)} net`
    if (net < 0 && won / like.length < avgPrice) play('look', 'Track record', `${record}, winning less often than the prices it paid imply. The Results screen shows which settings are behind it.`)
    else play('info', 'Track record', `${record}.`)
  } else if (kind && like.length) {
    play('info', 'Track record', `Only ${like.length} settled ${kind} plays from this bot so far, too few to judge this kind of play.`)
  }

  const verdict = checks.some((c) => c.level === 'bad') ? 'problem' : checks.some((c) => c.level === 'look') ? 'look' : 'clean'
  const headline = verdict === 'problem'
    ? 'Something about this play looks wrong. Report it so it can be looked at.'
    : verdict === 'look'
      ? 'Nothing is clearly wrong, but something is worth a look.'
      : filled < 1
        ? 'Nothing filled, so no money moved, and the play followed its rules.'
        : (t.pnlUsd ?? 0) < 0
          ? 'It traded correctly and followed its rules. It lost, which a fair play sometimes does.'
          : 'It traded correctly and followed its rules.'
  return { ticketId: t.id, verdict, headline, checks, checkedAt: now }
}

// Reads the evidence a check needs from Kalshi's public data, then judges.
export async function checkPlay(t: Ticket, bot: BotSettings | null, kalshi: KalshiVenue, history: Ticket[]): Promise<PlayReview> {
  const kalshiPriced = (t.venue === 'paper' ? t.priceSource : t.venue) === 'kalshi'
  let prints: Print[] | null = null
  let result: ContractSide | null = null
  if (kalshiPriced && t.filledContracts > 0) {
    if (t.venue === 'paper' && Date.now() - t.createdAt > (PRINT_WINDOW_S + 30) * 1000) {
      const at = Math.floor(t.createdAt / 1000)
      prints = await kalshi.prints(t.contract, at - PRINT_WINDOW_S, at + PRINT_WINDOW_S).catch(() => null)
    }
    result = await kalshi.settlement(t.contract)
  }
  return reviewPlay(t, bot, { prints, result }, history)
}
