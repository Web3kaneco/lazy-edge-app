// Every change the AI made to a bot, with the settings before it, so any one
// can be put back (2026-11-20). The last 20 per bot are kept.
import { app } from 'electron'
import { randomUUID } from 'node:crypto'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { BotSettings } from '@shared/schema'

export interface AiChange {
  id: string
  at: number
  botId: string
  // Where it came from: the AI box, the desk or a paper trial.
  source: 'ai box' | 'desk' | 'trial' | 'chat'
  what: string
  before: BotSettings
  undoneAt?: number
}

const file = (): string => join(app.getPath('userData'), 'ai-changes.json')
const KEEP = 20

function read(): AiChange[] {
  try {
    if (!existsSync(file())) return []
    const raw = JSON.parse(readFileSync(file(), 'utf8'))
    return Array.isArray(raw) ? raw.filter((c) => c && BotSettings.safeParse(c.before).success) : []
  } catch { return [] }
}

function write(all: AiChange[]): void {
  try { writeFileSync(file(), JSON.stringify(all)) } catch { /* the change itself is already saved and logged */ }
}

export const aiChanges = {
  list(botId?: string): AiChange[] {
    return read().filter((c) => !botId || c.botId === botId).sort((a, b) => b.at - a.at)
  },

  record(change: Omit<AiChange, 'id' | 'at'>): AiChange {
    const entry: AiChange = { ...change, id: randomUUID(), at: Date.now() }
    const all = [entry, ...read()]
    const kept: AiChange[] = []
    const per = new Map<string, number>()
    for (const c of all) {
      const n = per.get(c.botId) ?? 0
      if (n < KEEP) kept.push(c)
      per.set(c.botId, n + 1)
    }
    write(kept)
    return entry
  },

  get(id: string): AiChange | undefined {
    return read().find((c) => c.id === id)
  },

  markUndone(id: string): void {
    write(read().map((c) => (c.id === id ? { ...c, undoneAt: Date.now() } : c)))
  }
}
