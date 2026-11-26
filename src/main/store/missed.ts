// Every play a bot passed over, and why, with the play as it looked at that
// moment: our chance, the market's, the edge, the quarter and clock, and for
// a prop the line, what the player had and the side. The ledger keeps one
// line per skip without the play, and none at all for a skip that only
// restates a bot's settings (those were 96% of it). Without the play nobody
// can tell what a gate or a setting costs or saves (2026-11-23: "need
// to see if we are skipping things"), so each skip is written here, beside
// the ledger, to be graded against how the game ended.
//
// One line per bot, play, gate and quarter per trading day: a play passed
// over in Q2 and again in Q3 is seen twice, at two different prices. A day's
// file stops at MAX_LINES so a busy slate can never fill the disk.
import { app } from 'electron'
import { appendFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { tradingDay } from '@shared/day'
import { playTags, type PlayTags, type Signal } from '@shared/signal'

export interface MissedPlay {
  at: number
  botId: string
  gate: string
  detail: string
  signalKey: string
  gameId: string
  title: string
  play: PlayTags
}

const MAX_LINES = 50_000
const dir = (): string => join(app.getPath('userData'), 'missed')

let day = ''
let seen = new Set<string>()
let lines = 0

// A combo the bot looked at and what became of it (2026-11-23: no combo had
// ever traded, and the only record of why was the screen's list, cleared on
// every restart). One line per bot, combo and outcome a day.
export interface ComboRecord {
  type: 'combo'
  at: number
  botId: string
  key: string
  outcome: string
  detail: string
  chance: number | null
  legsPriceC: number | null
  legs: { contract: string; side: string; title: string; ourP: number | null; askC: number | null }[]
}

export const missed = {
  combo(botId: string, key: string, pick: { legs: { contract: string; side: string; title: string; ourP?: number | null; askC?: number | null }[]; chance?: number | null; legsPriceC?: number | null }, outcome: string, detail: string, now = Date.now()): void {
    const d = tradingDay(now)
    if (d !== day) { day = d; seen = new Set(); lines = 0 }
    if (lines >= MAX_LINES) return
    const k = `combo|${botId}|${key}|${outcome}`
    if (seen.has(k)) return
    seen.add(k)
    const row: ComboRecord = {
      type: 'combo', at: now, botId, key, outcome, detail, chance: pick.chance ?? null, legsPriceC: pick.legsPriceC ?? null,
      legs: pick.legs.map((l) => ({ contract: l.contract, side: l.side, title: l.title, ourP: l.ourP ?? null, askC: l.askC ?? null }))
    }
    try {
      mkdirSync(dir(), { recursive: true })
      appendFileSync(join(dir(), `${d}.jsonl`), `${JSON.stringify(row)}\n`)
      lines++
    } catch {
      // A record that cannot be written never stops trading.
    }
  },

  note(botId: string, s: Signal, gate: string, detail: string, now = Date.now()): void {
    const d = tradingDay(now)
    if (d !== day) { day = d; seen = new Set(); lines = 0 }
    if (lines >= MAX_LINES) return
    const play = playTags(s)
    const key = `${botId}|${s.key}|${gate}|${play.quarter ?? ''}`
    if (seen.has(key)) return
    seen.add(key)
    const row: MissedPlay = { at: now, botId, gate, detail, signalKey: s.key, gameId: s.gameId, title: s.title, play }
    try {
      mkdirSync(dir(), { recursive: true })
      appendFileSync(join(dir(), `${d}.jsonl`), `${JSON.stringify(row)}\n`)
      lines++
    } catch {
      // A record that cannot be written never stops trading.
    }
  }
}
