// Settings documents on disk, validated on every read and every write. A
// document that fails validation is never half applied: the write is refused
// and the previous version stays in force.
import { app } from 'electron'
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { DEFAULT_ACCOUNT } from '@shared/ruleset'
import { AccountSettings, BotSettings } from '@shared/schema'
import { STARTERS } from '@shared/starters'

const root = (): string => join(app.getPath('userData'), 'settings')
const botsDir = (): string => join(root(), 'bots')

function atomicWrite(path: string, data: unknown): void {
  const tmp = `${path}.tmp`
  writeFileSync(tmp, JSON.stringify(data, null, 2))
  renameSync(tmp, path)
}

const safeId = (id: string): string => {
  if (!/^[a-zA-Z0-9_-]{1,64}$/.test(id)) throw new Error(`invalid bot id ${id}`)
  return id
}

export const settingsStore = {
  init(): void {
    mkdirSync(botsDir(), { recursive: true })
  },

  account(): AccountSettings {
    const path = join(root(), 'account.json')
    if (!existsSync(path)) return structuredClone(DEFAULT_ACCOUNT)
    const parsed = AccountSettings.safeParse(JSON.parse(readFileSync(path, 'utf8')))
    // A corrupt account file falls back to the inert defaults: dry run on.
    return parsed.success ? parsed.data : structuredClone(DEFAULT_ACCOUNT)
  },

  saveAccount(input: unknown): AccountSettings {
    const doc = AccountSettings.parse(input)
    atomicWrite(join(root(), 'account.json'), doc)
    return doc
  },

  bots(): BotSettings[] {
    const out: BotSettings[] = []
    for (const f of readdirSync(botsDir())) {
      if (!f.endsWith('.json')) continue
      const parsed = BotSettings.safeParse(JSON.parse(readFileSync(join(botsDir(), f), 'utf8')))
      // An invalid bot is loaded disabled so it can be seen and fixed, never run.
      if (parsed.success) out.push(parsed.data)
    }
    return out.sort((a, b) => a.name.localeCompare(b.name))
  },

  saveBot(input: unknown): BotSettings {
    const doc = BotSettings.parse(input)
    if (doc.entry.priceBandC[0] > doc.entry.priceBandC[1]) throw new Error('price band low is above high')
    if (doc.decider.kind === 'agent' && !doc.decider.provider) throw new Error('agent mode needs a provider')
    atomicWrite(join(botsDir(), `${safeId(doc.id)}.json`), doc)
    return doc
  },

  deleteBot(id: string): void {
    rmSync(join(botsDir(), `${safeId(id)}.json`), { force: true })
  },

  // Each starter is added once, switched off. One the user deletes stays
  // deleted; the Bots screen can add it back.
  seedStarters(): void {
    const path = join(root(), 'starters.json')
    const seeded: string[] = existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : []
    const have = new Set(settingsStore.bots().map((b) => b.id))
    const added = STARTERS.filter((s) => !seeded.includes(s.key))
    for (const s of added) { const b = s.build(); if (!have.has(b.id)) settingsStore.saveBot(b) }
    if (added.length) atomicWrite(path, [...seeded, ...added.map((s) => s.key)])
  }
}
