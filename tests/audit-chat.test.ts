import { describe, expect, it, vi } from 'vitest'

// The chat tools read the ledger and the API client; neither is needed here.
vi.mock('../src/main/store/ledger', () => ({ ledger: { tickets: () => [], events: () => [] } }))
vi.mock('../src/main/data/lazyedge', () => ({ lazyedge: {} }))

import { auditBots, type AuditInput } from '../src/shared/audit'
import { DEFAULT_ACCOUNT, defaultBot } from '../src/shared/ruleset'
import type { BotSettings } from '../src/shared/schema'
import { deskTools } from '../src/main/bots/desktools'

const bot = (id: string, name: string, f: (b: BotSettings) => void = () => {}): BotSettings => {
  const b = defaultBot(id, name); b.enabled = true; b.market.sports = ['NBA']; f(b); return b
}
const input = (bots: BotSettings[], over: Partial<AuditInput> = {}): AuditInput => ({
  bots, account: DEFAULT_ACCOUNT, venues: { kalshi: { configured: true, balanceUsd: 200 } }, engineRunning: true, tickets: [], ...over
})
const texts = (i: AuditInput): string[] => auditBots(i).map((f) => `${f.level}: ${f.botName ?? 'app'}: ${f.text}`)

describe('the settings audit', () => {
  it('a pick bot sized by Kelly is a problem, with the fix named', () => {
    const f = auditBots(input([bot('a', 'Pregame', (b) => { b.entry.basis = 'pick'; b.size.sizing = 'kelly'; b.market.phase = 'pregame' })]))
    expect(f.find((x) => /Kelly/.test(x.text))).toMatchObject({ level: 'problem', botName: 'Pregame', fix: 'Set Sizing to Flat.' })
  })

  it('a stopped engine is a problem when a bot is on, and problems come first', () => {
    const f = auditBots(input([bot('a', 'Props', (b) => { b.market.lanes = ['PROP'] })], { engineRunning: false }))
    expect(f[0]).toMatchObject({ level: 'problem', botId: null })
    expect(f[0]!.text).toMatch(/engine is stopped/)
    expect(f.some((x) => /every player/.test(x.text))).toBe(true)
  })

  it('a live bot with no key says so; the kill switch shows once per live bot', () => {
    const live = bot('a', 'Live one', (b) => { b.mode = 'live' })
    expect(texts(input([live], { venues: { kalshi: { configured: false, balanceUsd: null } } })).some((t) => /No Kalshi or Polymarket key/.test(t))).toBe(true)
    const halted = texts(input([live], { account: { ...DEFAULT_ACCOUNT, killSwitch: true } })).filter((t) => /kill switch/i.test(t))
    expect(halted).toHaveLength(1)
  })

  it('an edge bot and a pick bot on the same games can oppose each other; two pregame pick bots double up', () => {
    const edge = bot('a', 'Edge', (b) => { b.market.lanes = ['MONEYLINE'] })
    const pick = bot('b', 'Pick', (b) => { b.market.lanes = ['MONEYLINE']; b.entry.basis = 'pick'; b.size.sizing = 'flat' })
    const pick2 = bot('c', 'Pick two', (b) => { b.market.lanes = ['MONEYLINE']; b.entry.basis = 'pick'; b.size.sizing = 'flat' })
    const t = texts(input([edge, pick, pick2]))
    expect(t.some((x) => /Edge and Pick both trade NBA/.test(x))).toBe(true)
    expect(t.some((x) => /Pick and Pick two both buy our NBA pregame picks/.test(x))).toBe(true)
  })

  it("combos built from the bot's own plays get a check; the API's combos without NBA or NFL are a problem", () => {
    const built = bot('a', 'Combos', (b) => { b.market.lanes = ['COMBO']; b.combo.only = true; b.combo.source = 'built' })
    const wrong = bot('b', 'MLB combos', (b) => { b.market.sports = ['MLB']; b.market.lanes = ['COMBO']; b.combo.only = true; b.combo.source = 'api'; b.entry.pregameWindowMin = null })
    const f = auditBots(input([built, wrong]))
    expect(f.find((x) => x.botName === 'Combos' && /builds its own combos/.test(x.text))?.level).toBe('check')
    expect(f.find((x) => x.botName === 'MLB combos' && /neither NBA nor NFL/.test(x.text))?.level).toBe('problem')
  })

  it('a flat stake up to 95c shows what it risks for what it wins', () => {
    const t = texts(input([bot('a', 'Flat', (b) => { b.mode = 'live'; b.size.sizing = 'flat'; b.size.maxTradeUsd = 10; b.entry.priceBandC = [1, 95] })]))
    expect(t.some((x) => /risks the whole \$10 to win about \$0\.53/.test(x))).toBe(true)
  })

  it('bots that are off are left out, and nothing on says so', () => {
    const off = bot('a', 'Off'); off.enabled = false
    expect(texts(input([off]))).toEqual(['check: app: No bot is switched on.'])
  })
})

describe('the chat tools', () => {
  const bots = [bot('a', 'Pregame only', (b) => { b.entry.basis = 'pick'; b.size.sizing = 'kelly' }), bot('b', 'Props live', (b) => { b.market.lanes = ['PROP'] })]
  const engine = () => ({ running: true, lastCycleAt: 0, lastError: null, venues: { kalshi: { configured: true, balanceUsd: 50, equityUsd: 50 } },
    recent: [{ at: Date.now(), botId: 'b', botName: 'Props live', title: 'AAA Star One over 24.5', outcome: 'skipped', detail: 'not on pace' }] })
  const proposed: string[] = []
  const tools = deskTools({ bots: () => bots, verdicts: () => ({ 'k1': [{ botId: 'b', outcome: 'skip', gate: 'prop_not_top', detail: 'rank 7' } as never] }), account: () => DEFAULT_ACCOUNT, engine, version: '9.9.9', propose: async (b, r) => { proposed.push(`${b.name}: ${r}`); return { drafted: true } } })
  const run = (name: string, args: unknown) => tools.find((t) => t.name === name)!.run(args as never)

  it('has every tool the app wide chat needs', () => {
    expect(tools.map((t) => t.name)).toEqual(expect.arrayContaining(['app_status', 'bot_settings', 'audit_bots', 'activity_today', 'board_now', 'propose_change', 'my_trades']))
  })

  it('finds a bot by part of its name and reads its settings in plain words', async () => {
    const out = await run('bot_settings', { bot: 'pregame' }) as Record<string, unknown>
    expect(out.name).toBe('Pregame only')
    expect(typeof out.in_one_line).toBe('string')
    expect(await run('bot_settings', { bot: 'nope' })).toMatchObject({ error: expect.stringContaining('Pregame only, Props live') })
  })

  it('the audit, status, activity and board answer from the app', async () => {
    expect(JSON.stringify(await run('audit_bots', {}))).toMatch(/sizes by Kelly/)
    expect(await run('app_status', {})).toMatchObject({ version: '9.9.9', engine_running: true, venues: { kalshi: { key_saved: true, balance_usd: 50 } } })
    expect(await run('activity_today', { bot: 'props' })).toMatchObject({ activity: [expect.objectContaining({ bot: 'Props live', outcome: 'skipped' })] })
    expect(await run('board_now', { bot: 'props' })).toMatchObject({ plays_seen: 1, counts: { 'skip: prop_not_top': 1 } })
  })

  it('propose_change drafts on the named bot and saves nothing itself', async () => {
    await run('propose_change', { bot: 'Pregame', request: 'set sizing to flat' })
    expect(proposed).toEqual(['Pregame only: set sizing to flat'])
  })
})
