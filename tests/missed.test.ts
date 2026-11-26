import { mkdtempSync, readdirSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import type { Signal } from '../src/shared/signal'

const home = mkdtempSync(join(tmpdir(), 'missed-'))
vi.mock('electron', () => ({ app: { getPath: () => home } }))
const { missed } = await import('../src/main/store/missed')

// Made up: one live moneyline pick, read in Q2 and again in Q3.
const play = (period: number): Signal => ({
  key: 'nba:g1:MONEYLINE:home', sport: 'NBA', lane: 'MONEYLINE', phase: 'live', gameId: 'g1', title: 'AAA @ BBB BBB to win',
  signalType: 'BUY_HOME', explicitSide: 'yes', ourP: 0.62, marketP: 0.55, edgePp: 7, label: 'PRICE_GAP', kelly: null, trigger: false, measured: false,
  clock: { period, secondsRemaining: 1500, overtime: false }, quotes: [], why: null, receivedAt: 0, pickOnly: true
} as Signal)

const rows = () => readdirSync(join(home, 'missed')).flatMap((f) => readFileSync(join(home, 'missed', f), 'utf8').trim().split('\n').map((l) => JSON.parse(l)))

describe('the missed plays record', () => {
  it('writes what a bot passed over, with the play as it looked, once per quarter', () => {
    const now = Date.UTC(2026, 10, 23, 2, 0)
    missed.note('bot-1', play(2), 'pick_only', 'edge bot', now)
    missed.note('bot-1', play(2), 'pick_only', 'edge bot', now + 60_000)
    missed.note('bot-1', play(3), 'pick_only', 'edge bot', now + 120_000)
    missed.note('bot-2', play(3), 'pick_only', 'edge bot', now + 120_000)
    const r = rows()
    expect(r).toHaveLength(3)
    expect(r[0]).toMatchObject({ botId: 'bot-1', gate: 'pick_only', signalKey: 'nba:g1:MONEYLINE:home', play: { ourP: 0.62, marketP: 0.55, quarter: 'Q2' } })
    expect(r.map((x) => x.play.quarter)).toEqual(['Q2', 'Q3', 'Q3'])
  })

  it('keeps every combo the bot looked at, once per outcome a day, with its legs and prices', () => {
    const now = Date.UTC(2026, 10, 24, 2, 0)
    const pick = { legs: [{ contract: 'KXNBAGAME-26NOV23OKCIND-OKC', side: 'yes', title: 'OKC over IND', ourP: 0.7, askC: 66 }, { contract: 'KXNBAGAME-26NOV23CLECHI-CLE', side: 'yes', title: 'CLE over CHI', ourP: 0.65, askC: 60 }], chance: 0.455, legsPriceC: 39.6 }
    missed.combo('combos', 'combo:a+b', pick, 'combo_skipped', 'no quote', now)
    missed.combo('combos', 'combo:a+b', pick, 'combo_skipped', 'no quote', now + 60_000)
    missed.combo('combos', 'combo:a+b', pick, 'filled', 'YES 1 @ 38c', now + 120_000)
    const c = rows().filter((r) => r.type === 'combo')
    expect(c.map((r) => r.outcome)).toEqual(['combo_skipped', 'filled'])
    expect(c[0]).toMatchObject({ botId: 'combos', chance: 0.455, legsPriceC: 39.6, legs: [{ contract: 'KXNBAGAME-26NOV23OKCIND-OKC', ourP: 0.7, askC: 66 }, { title: 'CLE over CHI' }] })
  })
})
