import { describe, expect, it } from 'vitest'
import { BOOK_EVIDENCE } from '../src/shared/accuracy'
import { defaultBot } from '../src/shared/ruleset'
import { rulesOf } from '../src/shared/review'
import { reviewPlay } from '../src/main/bots/review'
import type { Ticket } from '../src/main/store/ledger'

const bot = defaultBot('bot-1', 'Hot plays')
const HOUR = 3_600_000
const now = 1_800_000_000_000

// A paper YES buy of 10 at 45c on Kalshi's book, rated 55% to win.
const ticket = (o: Partial<Ticket> = {}): Ticket => ({
  id: 't1', botId: 'bot-1', botName: 'Hot plays', signalKey: 'nfl:g1:SPREAD:x', gameId: 'g1', title: 'SEA -3.5',
  venue: 'paper', priceSource: 'kalshi', contract: 'KXNFLSPREAD-X', side: 'yes', contracts: 10, limitPriceC: 45,
  costUsd: 4.5, evCents: 8.3, status: 'filled', filledContracts: 10, avgFillC: 45, feeUsd: 0.18, pnlUsd: null,
  venueOrderId: null, createdAt: now - 4 * HOUR, updatedAt: now - 4 * HOUR, why: null, error: null,
  audit: ['route kalshi ask 45c age 1s ev 8.30c', 'ev 8.30c, breakeven 46.7%, calibrated p 55.0%'],
  play: { sport: 'NFL', lane: 'SPREAD', phase: 'pregame', label: 'x', hot: false, measured: true, edgePp: 10, ourP: 0.65 },
  rules: rulesOf(bot),
  ...o
})

const check = (r: ReturnType<typeof reviewPlay>, title: string) => r.checks.find((c) => c.title === title)!

describe('play check: did it trade correctly', () => {
  it('a clean paper fill backed by a real trade, settled to the cent', () => {
    // Won: 10 * (1 - 0.45) - 0.18 = 5.32
    const r = reviewPlay(ticket({ pnlUsd: 5.32 }), bot, { prints: [{ yesC: 44, count: 5 }], result: 'yes' }, [], now)
    expect(r.verdict).toBe('clean')
    expect(check(r, 'Fill').level).toBe('ok')
    expect(check(r, 'Fee').level).toBe('ok')
    expect(check(r, 'Settlement').level).toBe('ok')
    expect(r.headline).toMatch(/traded correctly/)
  })

  it('flags a paper fill better than every real trade', () => {
    const r = reviewPlay(ticket(), bot, { prints: [{ yesC: 50, count: 5 }], result: null }, [], now)
    expect(check(r, 'Fill').level).toBe('bad')
    expect(r.verdict).toBe('problem')
  })

  it('accepts a quiet market when the book was recorded', () => {
    const r = reviewPlay(ticket({ audit: [...ticket().audit, `${BOOK_EVIDENCE} ask 45c x 200`] }), bot, { prints: [], result: null }, [], now)
    expect(check(r, 'Fill').level).toBe('ok')
  })

  it('flags a fill above the limit and a recorded result that disagrees with Kalshi', () => {
    const r = reviewPlay(ticket({ avgFillC: 47, pnlUsd: 5.32 }), bot, { prints: null, result: 'no' }, [], now)
    expect(check(r, 'Price').level).toBe('bad')
    expect(check(r, 'Settlement').level).toBe('bad')
    expect(check(r, 'Settlement').text).toMatch(/settled it NO/)
  })

  it('asks for a look when Kalshi settled it and the app has not caught up', () => {
    const r = reviewPlay(ticket(), bot, { prints: [{ yesC: 45, count: 1 }], result: 'yes' }, [], now)
    expect(check(r, 'Settlement').level).toBe('look')
    expect(r.verdict).toBe('look')
  })

  it('treats a live fill as the venue record and its fee as reported', () => {
    const r = reviewPlay(ticket({ venue: 'kalshi', feeUsd: 0.17 }), bot, { prints: null, result: null }, [], now)
    expect(check(r, 'Fill').level).toBe('ok')
    expect(check(r, 'Fee').level).toBe('info')
  })

  it('an order the venue refused is a problem, a dry run is not', () => {
    expect(reviewPlay(ticket({ venue: 'kalshi', status: 'rejected', filledContracts: 0, avgFillC: null, error: 'insufficient balance' }), bot, { prints: null, result: null }, [], now).verdict).toBe('problem')
    const dry = reviewPlay(ticket({ venue: 'kalshi', status: 'dry_run', filledContracts: 0, avgFillC: null }), bot, { prints: null, result: null }, [], now)
    expect(dry.verdict).toBe('clean')
    expect(dry.headline).toMatch(/no money moved/)
  })
})

describe('play check: was it a sound play', () => {
  it('a loss on a fair play is explained, not flagged', () => {
    // Lost: -10 * 0.45 - 0.18 = -4.68
    const r = reviewPlay(ticket({ pnlUsd: -4.68 }), bot, { prints: [{ yesC: 44, count: 5 }], result: 'no' }, [], now)
    expect(r.verdict).toBe('clean')
    expect(check(r, 'Outcome').text).toMatch(/loses about 5 times in 10/)
    expect(r.headline).toMatch(/It lost, which a fair play sometimes does/)
  })

  it('a play outside the rules it ran with is a problem', () => {
    const r = reviewPlay(ticket({ limitPriceC: 80, avgFillC: 80 }), bot, { prints: null, result: null }, [], now)
    expect(check(r, 'Rules').level).toBe('bad')
    expect(check(r, 'Rules').text).toMatch(/outside the 25 to 75c band/)
  })

  it('an older ticket is checked against the settings now, softly', () => {
    const r = reviewPlay(ticket({ rules: undefined, evCents: 0.1, audit: ['ev 0.10c, breakeven 46.7%, calibrated p 46.9%'] }), bot, { prints: null, result: null }, [], now)
    expect(check(r, 'Rules').level).toBe('look')
    expect(check(r, 'Rules').text).toMatch(/may have changed/)
  })

  it('names settings looser than the measured defaults', () => {
    const loose = { ...bot, entry: { ...bot.entry, edgeHaircut: 1, minEvCents: 0 } }
    const r = reviewPlay(ticket({ rules: rulesOf(loose) }), loose, { prints: null, result: null }, [], now)
    expect(check(r, 'Settings').level).toBe('look')
    expect(check(r, 'Settings').text).toMatch(/haircut 1 \(measured 0.5\).*minimum EV 0c/)
  })

  it('a play rated under breakeven should not have been taken', () => {
    const r = reviewPlay(ticket({ audit: ['ev -1.00c, breakeven 46.7%, calibrated p 45.0%'] }), bot, { prints: null, result: null }, [], now)
    expect(check(r, 'Edge').level).toBe('bad')
  })

  it('a losing run of the same kind of play is worth a look', () => {
    const history = Array.from({ length: 30 }, (_, i) => ticket({ id: `h${i}`, gameId: `g${i}`, pnlUsd: i < 8 ? 5.32 : -4.68 }))
    const r = reviewPlay(ticket({ pnlUsd: -4.68 }), bot, { prints: null, result: null }, history, now)
    expect(check(r, 'Track record').level).toBe('look')
    expect(check(r, 'Track record').text).toMatch(/30 settled NFL SPREAD pregame plays won 8/)
  })
})
