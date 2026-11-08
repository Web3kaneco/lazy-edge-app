import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { BOOK_EVIDENCE, checkSettlement, classifyFill, summarize, type CheckedTicket } from '../src/shared/accuracy'
import { analyze, MIN_SETTLED, tagsOf, type SettledLike } from '../src/shared/results'
import { orderFee } from '../src/main/rules/fees'
import { paperFill } from '../src/main/venues/paper'
import { GLOSSARY, tip } from '../src/renderer/src/glossary'

describe('paper fills against the live book', () => {
  const order = { contracts: 26, limitPriceC: 48, priceSource: 'kalshi' as const }

  it('fills at the ask, no more contracts than the ask offers', () => {
    const r = paperFill(order, { ask: 0.46, askSize: 10, priceAgeS: 0 })
    expect(r.status).toBe('partial')
    expect(r.filledContracts).toBe(10)
    expect(r.avgFillC).toBe(46)
    expect(r.error).toMatch(/only 10 of 26/)
  })

  it('fills the whole order when the ask has the size', () => {
    const r = paperFill(order, { ask: 0.48, askSize: 500, priceAgeS: 0 })
    expect(r).toMatchObject({ status: 'filled', filledContracts: 26, avgFillC: 48 })
  })

  it('does not fill when the ask moved above the limit', () => {
    const r = paperFill(order, { ask: 0.49, askSize: 500, priceAgeS: 0 })
    expect(r).toMatchObject({ status: 'cancelled', filledContracts: 0, feeUsd: 0 })
    expect(r.error).toMatch(/49c, above the 48c limit/)
  })

  it('does not fill with no book or no size', () => {
    expect(paperFill(order, null).filledContracts).toBe(0)
    expect(paperFill(order, { ask: 0.4, askSize: 0, priceAgeS: 0 }).filledContracts).toBe(0)
    expect(paperFill(order, { ask: null, askSize: null, priceAgeS: 0 }).filledContracts).toBe(0)
  })

  it('charges the per order fee rounded up to the cent', () => {
    // 0.07 * 10 * 0.46 * 0.54 = 0.17388, charged as 0.18
    expect(paperFill(order, { ask: 0.46, askSize: 10, priceAgeS: 0 }).feeUsd).toBe(0.18)
    expect(orderFee('kalshi', 0.5, 4)).toBe(0.07)
  })
})

const ticket = (o: Partial<SettledLike> & { won: boolean; priceC: number }): SettledLike => ({
  botId: 'b1', botName: 'Bot 1', side: 'yes', venue: 'paper', filledContracts: 10,
  avgFillC: o.priceC, limitPriceC: o.priceC, costUsd: o.priceC / 10, feeUsd: 0.1,
  pnlUsd: o.won ? 10 * (1 - o.priceC / 100) - 0.1 : -10 * (o.priceC / 100) - 0.1,
  createdAt: 0, ...o
})

describe('results', () => {
  it('reads old tickets\' sport, lane and phase from the signal key', () => {
    expect(tagsOf(ticket({ won: true, priceC: 50, signalKey: 'nfl:123:live:SPREAD:3.5:::HOME' }))).toMatchObject({ sport: 'NFL', lane: 'SPREAD', phase: 'live', hot: true })
    expect(tagsOf(ticket({ won: true, priceC: 50, signalKey: 'nba:9:MONEYLINE:home' }))).toMatchObject({ sport: 'NBA', lane: 'MONEYLINE' })
  })

  it('makes no call before the minimum sample', () => {
    const few = Array.from({ length: MIN_SETTLED - 1 }, () => ticket({ won: false, priceC: 50 }))
    const { overall, recommendations } = analyze(few)
    expect(overall.verdict).toBe('too_early')
    expect(recommendations).toEqual([])
  })

  it('a coin flip record at fair prices is luck, not a pattern', () => {
    const even = Array.from({ length: 40 }, (_, i) => ticket({ won: i % 2 === 0, priceC: 50, gameId: `g${i}` }))
    expect(analyze(even).overall.verdict).toBe('even')
  })

  it('rungs of the same few games are not a big sample', () => {
    // 30 wins of 40 at 50c is strong across 40 games, too early across 10.
    const spread = (games: number) => Array.from({ length: 40 }, (_, i) => ticket({ won: i < 30, priceC: 50, gameId: `g${i % games}` }))
    expect(analyze(spread(40)).overall).toMatchObject({ games: 40, verdict: 'winning' })
    expect(analyze(spread(10)).overall).toMatchObject({ games: 10, verdict: 'too_early' })
    // Twelve games, each won or lost as a block of three rungs: the clustered
    // error is wider, so the same record is weaker than if it were 36 games.
    const blocks = Array.from({ length: 36 }, (_, i) => ticket({ won: Math.floor(i / 3) < 9, priceC: 50, gameId: `g${Math.floor(i / 3)}` }))
    const loose = blocks.map((t, i) => ({ ...t, gameId: `x${i}` }))
    expect(analyze(blocks).overall.z).toBeLessThan(analyze(loose).overall.z)
  })

  it('names the losing segment and the setting that controls it', () => {
    const tag = (label: string) => ({ sport: 'NFL' as const, lane: 'SPREAD' as const, phase: 'live' as const, label, hot: true, measured: false, edgePp: 6, ourP: 0.55 })
    const losers = Array.from({ length: 30 }, (_, i) => ticket({ won: i < 3, priceC: 50, play: tag('TAIL_RUNG'), gameId: `l${i}` }))
    const winners = Array.from({ length: 30 }, (_, i) => ticket({ won: i < 24, priceC: 50, play: tag('PRICE_GAP'), gameId: `w${i}` }))
    const { dimensions, recommendations } = analyze([...losers, ...winners])
    const label = dimensions.find((d) => d.id === 'label')!
    expect(label.rows.find((r) => r.key === 'TAIL_RUNG')!.verdict).toBe('losing')
    expect(label.rows.find((r) => r.key === 'PRICE_GAP')!.verdict).toBe('winning')
    const cut = recommendations.find((r) => r.kind === 'cut' && r.segment === 'TAIL_RUNG')!
    expect(cut.strength).toBe('strong')
    expect(cut.text).toMatch(/Consider leaving it out under Labels/)
    // Cuts come before keeps.
    expect(recommendations[0]!.kind).toBe('cut')
  })

  it('ignores unsettled and unfilled tickets', () => {
    const open = { ...ticket({ won: true, priceC: 50 }), pnlUsd: null }
    const unfilled = { ...ticket({ won: true, priceC: 50 }), filledContracts: 0 }
    expect(analyze([open, unfilled]).overall.n).toBe(0)
  })
})

describe('accuracy check', () => {
  const t = (o: Partial<CheckedTicket> = {}): CheckedTicket => ({
    id: 't1', title: 'TOR @ MIL', venue: 'paper', priceSource: 'kalshi', side: 'no', filledContracts: 30,
    avgFillC: 33, feeUsd: 0.47, pnlUsd: 19.63, createdAt: 0, audit: [], ...o
  })

  it('a paper fill keeps what the book showed', () => {
    const r = paperFill({ contracts: 5, limitPriceC: 40, priceSource: 'kalshi' }, { ask: 0.38, askSize: 12, priceAgeS: 0 })
    expect(r.evidence).toBe(`${BOOK_EVIDENCE} ask 38c x 12, read 0s before`)
    expect(paperFill({ contracts: 5, limitPriceC: 40, priceSource: 'kalshi' }, { ask: 0.45, askSize: 12, priceAgeS: 0 }).evidence).toMatch(/ask 45c/)
  })

  it('a fill is confirmed when a real trade paid our side at our price or better', () => {
    // We bought NO at 33c. A print at yes 68c is NO at 32c.
    expect(classifyFill(t(), [{ yesC: 68, count: 4 }]).verdict).toBe('confirmed')
    expect(classifyFill(t(), [{ yesC: 67, count: 4 }]).verdict).toBe('confirmed')
  })

  it('a fill better than every real trade nearby is flagged', () => {
    const c = classifyFill(t(), [{ yesC: 60, count: 4 }, { yesC: 62, count: 1 }])
    expect(c).toMatchObject({ verdict: 'better_than_market', bestOurSideC: 38 })
  })

  it('with no trades nearby, only a recorded book counts', () => {
    expect(classifyFill(t(), []).verdict).toBe('unverified')
    expect(classifyFill(t({ audit: [`${BOOK_EVIDENCE} ask 33c x 50, read 0s before`] }), []).verdict).toBe('book_only')
  })

  it('recomputes the profit from Kalshi\'s result', () => {
    // 30 NO at 33c, NO won: 30 * 0.67 - 0.47 = 19.63
    expect(checkSettlement(t(), 'no')).toMatchObject({ ok: true, expectedPnlUsd: 19.63 })
    expect(checkSettlement(t(), 'yes')).toMatchObject({ ok: false, expectedPnlUsd: -10.37 })
  })

  it('summarises and lists what to look at', () => {
    const tickets = [t(), t({ id: 't2', pnlUsd: null }), t({ id: 't3' })]
    const s = summarize(tickets, {
      t1: { fill: classifyFill(t(), [{ yesC: 68, count: 1 }]), settle: checkSettlement(t(), 'yes') },
      t2: { settle: checkSettlement(t({ pnlUsd: null }), 'no') }
    })
    expect(s).toMatchObject({ paperFills: 3, confirmed: 1, pendingFill: 2, settled: 2, settleChecked: 1, settleMismatch: 1, stuckOpen: 1 })
    expect(s.issues.map((i) => i.id)).toEqual(['t1', 't2'])
  })
})

describe('glossary', () => {
  it('explains every term the Bots and Board screens ask for', () => {
    const used = ['Bots.tsx', 'Board.tsx'].flatMap((f) =>
      [...readFileSync(`src/renderer/src/screens/${f}`, 'utf8').matchAll(/tip\('([^']+)'\)/g)].map((m) => m[1]!))
    const lanes = ['MONEYLINE', 'SPREAD', 'TOTAL', 'TEAM_TOTAL', 'PROP']
    const labels = ['PRICE_GAP', 'RATING_Q', 'LEAN', 'TAIL_RUNG', 'ROLE_Q', 'MEASURED']
    for (const term of [...used, ...lanes, ...labels]) expect(tip(term), term).not.toBe('')
    expect(used.length).toBeGreaterThan(20)
  })

  it('has no duplicate terms', () => {
    const terms = GLOSSARY.flatMap((s) => s.terms.map((t) => t.term.toLowerCase()))
    expect(new Set(terms).size).toBe(terms.length)
  })
})
