// Settings documents on disk, validated on every read and every write. A
// document that fails validation is never half applied: the write is refused
// and the previous version stays in force.
import { app } from 'electron'
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { DEFAULT_ACCOUNT } from '@shared/ruleset'
import { AccountSettings, BotSettings } from '@shared/schema'
import { STARTERS, starterOf, starterUpdate, starterVersion, withStarter, withStarterUpdate } from '@shared/starters'
import { plainIssues } from '@shared/fields'
import { botProblems, notSaved } from '@shared/validate'

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

  // Once, for an account file from before the bot's mode became the only live
  // switch (0.9.2). Under the old account wide dry run a live bot sent
  // nothing; going straight to real orders would surprise anyone who relied
  // on that, so each such bot goes back to paper, where it records trades,
  // and the user switches it to Live again themselves. Returns their names.
  migrateDryRun(): string[] {
    const path = join(root(), 'account.json')
    if (!existsSync(path)) return []
    let raw: Record<string, unknown>
    try { raw = JSON.parse(readFileSync(path, 'utf8')) } catch { return [] }
    if (!raw || typeof raw !== 'object' || !('executionMode' in raw)) return []
    const moved: string[] = []
    if (raw.executionMode !== 'live') {
      for (const b of settingsStore.bots()) {
        if (b.mode !== 'live') continue
        settingsStore.saveBot({ ...b, mode: 'paper' })
        moved.push(b.name)
      }
    }
    // Validation drops the old fields; a file that no longer validates is
    // left alone and account() keeps falling back to the inert defaults.
    const parsed = AccountSettings.safeParse(raw)
    if (parsed.success) atomicWrite(path, parsed.data)
    return moved
  },

  saveAccount(input: unknown): AccountSettings {
    const checked = AccountSettings.safeParse(input)
    if (!checked.success) throw new Error(notSaved(plainIssues(checked.error.issues), 'the account keeps its last saved limits'))
    const doc = checked.data
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
    const problems = botProblems(input)
    if (problems.length) throw new Error(notSaved(problems))
    const doc = BotSettings.parse(input)
    atomicWrite(join(botsDir(), `${safeId(doc.id)}.json`), doc)
    return doc
  },

  deleteBot(id: string): void {
    rmSync(join(botsDir(), `${safeId(id)}.json`), { force: true })
  },

  // Each starter is added once, switched off. One the user deletes stays
  // deleted; the Bots screen can add it back.
  seedStarters(): void {
    const state = readStarterState()
    const have = new Set(settingsStore.bots().map((b) => b.id))
    const added = STARTERS.filter((s) => !state.seeded.includes(s.key))
    for (const s of added) {
      const b = BotSettings.parse(s.build())
      if (!have.has(b.id)) settingsStore.saveBot(b)
      state.seeded.push(s.key)
      // A starter added now is already this version's.
      state.versions[s.key] = starterVersion(s.key)
    }
    if (added.length) writeStarterState(state)
  },

  // Starter updates (2026-11-21, made exact). A starter that changed in this
  // version lists exactly which settings changed (STARTER_UPDATES). The
  // user's copy takes only those, and only where it differs; everything else
  // the user set stays, and money never changes. The old copy is kept so it
  // can be put back. A bot that is on and live waits for the user to choose.
  // Returns what moved.
  refreshStarters(): { updated: BotSettings[]; pending: BotSettings[] } {
    const state = readStarterState()
    const bots = settingsStore.bots()
    const updated: BotSettings[] = []
    // Worked out again each launch, so a card never waits for a change that
    // does not exist (the earlier comparison offered to undo users' settings).
    state.pending = []
    for (const s of STARTERS) {
      const version = starterVersion(s.key)
      if (versionOf(state, s.key) >= version) continue
      const starter = BotSettings.parse(s.build())
      const mine = bots.find((b) => b.id === starter.id)
      if (mine && starterUpdate(mine, starter, s.key).length) {
        if (mine.enabled && mine.mode === 'live') { state.pending.push(mine.id); continue }
        updated.push(settingsStore.useStarter(mine.id, 'update', state)!)
      }
      state.versions[s.key] = version
    }
    writeStarterState(state)
    return { updated, pending: bots.filter((b) => state.pending.includes(b.id)) }
  },

  // 'update' takes only this version's listed settings; 'reset' (the Bots
  // screen's Reset to the starter) takes the whole starter strategy. Both
  // keep the user's name, on or off, paper or live, money and venues, and
  // keep the old copy to put back.
  useStarter(id: string, how: 'update' | 'reset', given?: StarterState): BotSettings | null {
    const s = starterOf(id)
    const mine = settingsStore.bots().find((b) => b.id === id)
    if (!s || !mine) return null
    const state = given ?? readStarterState()
    const starter = BotSettings.parse(s.build())
    mkdirSync(backupsDir(), { recursive: true })
    atomicWrite(join(backupsDir(), `${safeId(id)}.json`), mine)
    const next = settingsStore.saveBot(how === 'update' ? withStarterUpdate(mine, starter, s.key) : withStarter(mine, starter))
    state.versions[s.key] = starterVersion(s.key)
    state.pending = state.pending.filter((p) => p !== id)
    if (!given) writeStarterState(state)
    return next
  },

  // The user keeps their own settings for this version's starter.
  keepMine(id: string): void {
    const s = starterOf(id)
    if (!s) return
    const state = readStarterState()
    state.versions[s.key] = starterVersion(s.key)
    state.pending = state.pending.filter((p) => p !== id)
    writeStarterState(state)
  },

  // The settings a starter update replaced, if they are still kept.
  starterBackup(id: string): BotSettings | null {
    const path = join(backupsDir(), `${safeId(id)}.json`)
    if (!existsSync(path)) return null
    const parsed = BotSettings.safeParse(JSON.parse(readFileSync(path, 'utf8')))
    return parsed.success ? parsed.data : null
  },

  // Puts the replaced settings back, as the bot runs now: on or off, paper or
  // live, stay as they are.
  restoreStarterBackup(id: string): BotSettings | null {
    const old = settingsStore.starterBackup(id)
    const mine = settingsStore.bots().find((b) => b.id === id)
    if (!old || !mine) return null
    const next = settingsStore.saveBot({ ...old, id, name: mine.name, enabled: mine.enabled, mode: mine.mode })
    settingsStore.dropStarterBackup(id)
    settingsStore.keepMine(id)
    return next
  },

  dropStarterBackup(id: string): void {
    rmSync(join(backupsDir(), `${safeId(id)}.json`), { force: true })
  },

  pendingStarters(): string[] {
    return readStarterState().pending
  }
}

const backupsDir = (): string => join(root(), 'starter-backups')
const versionOf = (state: StarterState, key: string): number => { const v = state.versions[key]; return typeof v === 'number' ? v : 1 }

interface StarterState {
  seeded: string[]
  // Starter key -> the starter version last applied or declined, so each
  // version's change is offered once. A text value is from the first 0.9.2
  // builds, which stored a fingerprint; it counts as version 1.
  versions: Record<string, number | string>
  // Live bots waiting for the user to take or decline new starter settings.
  pending: string[]
}

function readStarterState(): StarterState {
  const path = join(root(), 'starters.json')
  if (!existsSync(path)) return { seeded: [], versions: {}, pending: [] }
  let raw: unknown
  try { raw = JSON.parse(readFileSync(path, 'utf8')) } catch { return { seeded: STARTERS.map((s) => s.key), versions: {}, pending: [] } }
  // Before 0.9.2 the file was the list of seeded keys.
  if (Array.isArray(raw)) return { seeded: raw.map(String), versions: {}, pending: [] }
  const o = (raw ?? {}) as Partial<StarterState>
  return { seeded: Array.isArray(o.seeded) ? o.seeded : [], versions: o.versions && typeof o.versions === 'object' ? o.versions : {}, pending: Array.isArray(o.pending) ? o.pending : [] }
}

function writeStarterState(state: StarterState): void {
  atomicWrite(join(root(), 'starters.json'), state)
}
