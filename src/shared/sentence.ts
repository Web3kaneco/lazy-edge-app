// A bot in one plain sentence, the first line of its card (the simple app
// plan, 2026-11-21): what it buys, when, at what price, how much, and how it
// gets out. Built from the settings themselves, so it can never say something
// the bot does not do.
import type { BotSettings } from './schema'

const LANES: Record<string, string> = { MONEYLINE: 'moneylines', SPREAD: 'spreads', TOTAL: 'totals', TEAM_TOTAL: 'team totals', PROP: 'player props', COMBO: 'combos' }
const list = (xs: string[]): string => (xs.length <= 1 ? xs.join('') : `${xs.slice(0, -1).join(', ')} and ${xs.at(-1)}`)
const usd = (n: number): string => `$${Number.isInteger(n) ? n : n.toFixed(2)}`

export function botSentence(b: BotSettings): string {
  const sports = list(b.market.sports)
  const comboOnly = b.combo.only && b.market.lanes.includes('COMBO')
  const phase = b.market.phase === 'pregame' ? 'before the game' : b.market.phase === 'live' ? 'in game' : 'before and during the game'
  const inGame = b.market.phase !== 'pregame'
  const quarters = inGame && b.market.quarters.length < 4 ? `, in ${list(b.market.quarters)} only` : ''
  const props = b.market.lanes.includes('PROP')
  const top = props && b.market.propTopPlayers !== null ? `, on the top ${b.market.propTopPlayers} players in each game` : ''
  const off = props && b.market.propSidesOff.length ? `, never ${list(b.market.propSidesOff.map((s) => s.replace('PTS', 'point').replace('REB', 'rebound').replace('AST', 'assist').replace(/ (over|under)$/, ' $1s')))}` : ''
  const unders = (props && b.entry.underEdgePp ? `, unders only at an edge of ${b.entry.underEdgePp[0]} to ${b.entry.underEdgePp[1]} points` : '')
    + (props && b.entry.underFirstMin !== null && b.market.phase !== 'pregame' ? `, in game unders only in the first ${b.entry.underFirstMin} minutes of a quarter` : '')

  let what: string
  if (comboOnly) {
    const sizes = [...b.combo.apiLegs].sort()
    const legs = sizes.length === 3 ? '' : ` of ${list(sizes.map(String))} legs`
    what = b.combo.source === 'api'
      ? `Buys the API's ${sports} combos${legs} as they are, up to ${b.combo.maxPerDay} a day`
      : `Builds ${b.combo.legs} leg ${sports} combos from its own plays, up to ${b.combo.maxPerDay} a day`
  } else {
    const lanes = list(b.market.lanes.map((l) => LANES[l] ?? l.toLowerCase()))
    what = `${b.entry.basis === 'pick' ? 'Buys our pick on' : 'Trades'} ${sports} ${lanes} ${phase}${quarters}${top}${off}${unders}`
  }

  const floors = (inGame ? (['Q1', 'Q2', 'Q3', 'Q4'] as const).filter((q) => b.market.quarters.includes(q)) : []).map((q) => b.entry.minChancePct[q])
  const pre = b.market.phase !== 'live' ? [b.entry.minChancePct.pregame] : []
  const chances = [...pre, ...floors]
  const chance = chances.length && chances.every((c) => c === chances[0]) && chances[0]! > 0 ? `${chances[0]}% or more to hit` : null
  const edge = comboOnly && b.combo.source === 'api' ? null
    : b.entry.basis === 'pick'
      ? (b.entry.pickGapPp !== null ? `when our chance is ${b.entry.pickGapPp} points above the price` : null)
      : `when our chance beats the price by ${b.entry.minEdgePp}${b.entry.maxEdgePp !== null ? ` to ${b.entry.maxEdgePp}` : ''} points`
  const when = [edge, chance].filter(Boolean)
  const [lo, hi] = b.entry.priceBandC
  const price = `priced ${lo}c to ${hi}c`
  const window = b.market.phase !== 'live' && b.entry.pregameWindowMin !== null && !comboOnly ? `, in the last ${b.entry.pregameWindowMin} minutes before the start` : ''

  const money = b.size.sizing === 'flat' ? `${usd(b.size.maxTradeUsd)} a trade` : `Up to ${usd(b.size.maxTradeUsd)} a trade, sized by Kelly`
  const exit = b.exit.mode === 'hold' ? 'held to the end'
    : b.exit.mode === 'time' ? `sold after ${b.exit.afterMin} minutes${b.exit.atQuarterEnd ? ' or at the end of the quarter' : ''}`
      : `sold once it is up ${b.exit.targetC}c`

  const first = `${what}${when.length ? `, ${when.join(' and ')}` : ''}, ${price}${window}.`
  return `${first} ${money.charAt(0).toUpperCase()}${money.slice(1)}, ${exit}.`
}
