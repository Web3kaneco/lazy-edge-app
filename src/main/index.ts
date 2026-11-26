import { app, BrowserWindow, clipboard, dialog, ipcMain, Menu, Notification, shell, type IpcMainInvokeEvent } from 'electron'
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs'
import { release } from 'node:os'
import { pathToFileURL } from 'node:url'
import { join } from 'node:path'
import { dayBounds, tradingDay } from '@shared/day'
import { mailtoUrl, REPORT_MAX } from '@shared/report'
import { defaultBot } from '@shared/ruleset'
import { AccountSettings, BotSettings, type ProviderId } from '@shared/schema'
import type { Change } from '@shared/share'
import { STARTERS, starterChanges, starterOf, starterUpdate } from '@shared/starters'
import { changeLines, fieldName } from '@shared/fields'
import { levelFor, moneyChanges } from '@shared/levels'
import { aiChanges, type AiChange } from './store/aiundo'
import { rulesLine } from '@shared/desk'
import { GATES } from '@shared/gatewords'
import { patternBot, type Pattern } from '@shared/patterns'
import { acceptedBot, trialBot } from '@shared/trials'
import { liveProblem } from '@shared/venues'
import { whyFacts } from '@shared/why'
import type { CashOutResult } from '@shared/exits'
import { DeskAction } from '@shared/desk'
import { applyFix, Fix, fixText } from '@shared/fixes'
import { changeNote, exportFiles, paperTestPlan, settingsChanges } from '@shared/testdata'
import { draftStrategy } from './ai/strategy'
import { ai, allProviders } from './ai/registry'
import { accuracy } from './bots/accuracy'
import { checkPlay } from './bots/review'
import { Desk } from './bots/desk'
import type { EngineView } from './bots/desktools'
import { Supervisor } from './bots/supervisor'
import { RELEASES_URL, SUPPORT_EMAIL } from './config'
import { auth } from './data/auth'
import { lazyedge } from './data/lazyedge'
import { notices } from './data/notices'
import { ledger } from './store/ledger'
import { settingsStore } from './store/settings'
import { terms } from './store/terms'
import { vault, type SecretName } from './store/vault'
import type { KalshiVenue } from './venues/kalshi'

// The renderer may write these and nothing else. It can never read one back.
const WRITABLE_SECRETS: readonly SecretName[] = [
  'kalshi.keyId', 'kalshi.privateKeyPem', 'polymarket.privateKey', 'polymarket.funder',
  'ai.anthropic', 'ai.openai', 'ai.xai', 'ai.ollamaUrl'
]

let win: BrowserWindow | null = null
let supervisor: Supervisor
let desk: Desk

if (!app.requestSingleInstanceLock()) app.quit()
app.on('second-instance', () => { if (win) { if (win.isMinimized()) win.restore(); win.focus() } })

function createWindow(): void {
  win = new BrowserWindow({
    width: 1360,
    height: 880,
    minWidth: 1024,
    minHeight: 680,
    // Light by default; the page sets the user's theme before its first
    // paint, and the window shows only once that paint is ready.
    backgroundColor: '#f5f5f7',
    show: false,
    title: `Lazy Edge Beta ${app.getVersion()}`,
    autoHideMenuBar: true,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false
    }
  })
  win.once('ready-to-show', () => win?.show())
  // Keep the versioned title rather than the page's own.
  win.on('page-title-updated', (e) => e.preventDefault())
  // Links open in the user's browser, never inside the app window.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https:\/\//.test(url)) void shell.openExternal(url)
    return { action: 'deny' }
  })
  // The window only ever shows the app itself. A packaged build never
  // navigates; development may reload its own dev server and nothing else.
  const stay = (e: Electron.Event, url: string): void => { if (app.isPackaged || !fromApp(url)) e.preventDefault() }
  win.webContents.on('will-navigate', stay)
  win.webContents.on('will-redirect', stay)

  // A window whose page process dies is reloaded, at most three times in a
  // minute so a page that dies on load cannot loop; trading runs here in the
  // main process and carries on either way. Both are written to the crash log.
  const reloads: number[] = []
  win.webContents.on('render-process-gone', (_e, d) => {
    crashLog(`window process gone: ${d.reason} (exit ${d.exitCode})`)
    const now = Date.now()
    while (reloads.length && now - reloads[0]! > 60_000) reloads.shift()
    if (d.reason !== 'clean-exit' && reloads.length < 3 && win && !win.isDestroyed()) { reloads.push(now); win.webContents.reload() }
  })
  win.on('unresponsive', () => crashLog('window stopped responding'))
  win.on('responsive', () => crashLog('window responding again'))

  if (process.env.ELECTRON_RENDERER_URL) void win.loadURL(process.env.ELECTRON_RENDERER_URL)
  else void win.loadFile(join(__dirname, '../renderer/index.html'))
}

// userData/logs/crash.log: window crashes and screen errors, one line each.
function crashLog(line: string): void {
  try {
    const dir = join(app.getPath('userData'), 'logs')
    mkdirSync(dir, { recursive: true })
    appendFileSync(join(dir, 'crash.log'), `${new Date().toISOString()} ${line.split('\n').join('\n    ')}\n`)
  } catch { /* logging must never take the app down */ }
}

// True only for the app's own page: the packaged index.html, or the exact
// dev server origin. IPC from any other frame is refused.
const RENDERER_FILE = pathToFileURL(join(__dirname, '../renderer/index.html')).href
function fromApp(url: string | undefined): boolean {
  if (!url) return false
  if (process.env.ELECTRON_RENDERER_URL && !app.isPackaged) {
    try { return new URL(url).origin === new URL(process.env.ELECTRON_RENDERER_URL).origin } catch { return false }
  }
  return url.split('#')[0] === RENDERER_FILE
}

// A native confirmation the renderer cannot click for itself, for every step
// that lets real money move.
function confirmNative(message: string, detail: string, yes: string): void {
  const choice = dialog.showMessageBoxSync(win!, { type: 'warning', buttons: [yes, 'Cancel'], defaultId: 1, cancelId: 1, noLink: true, title: 'Lazy Edge', message, detail })
  if (choice !== 0) throw new Error('Cancelled.')
}

const send = (channel: string, payload: unknown): void => {
  if (win && !win.isDestroyed()) win.webContents.send(channel, payload)
}

function handle<A extends unknown[], R>(channel: string, fn: (...args: A) => R | Promise<R>): void {
  ipcMain.handle(channel, async (e: IpcMainInvokeEvent, ...args) => {
    if (!fromApp(e.senderFrame?.url)) return { ok: false, error: 'refused: not the app window' }
    try {
      return { ok: true, value: await fn(...(args as A)) }
    } catch (err) {
      return { ok: false, error: (err as Error).message }
    }
  })
}

const note = (botId: string | null, text: string): void => ledger.append({ type: 'note', at: Date.now(), botId, text: text.slice(0, 4000) })

// Saves a bot and writes what changed to the ledger, so the record shows which
// settings every trade ran under and when each one moved.
function saveLogged(doc: unknown): BotSettings {
  const before = settingsStore.bots().find((b) => b.id === (doc as { id?: string })?.id)
  const saved = settingsStore.saveBot(doc)
  if (!before) note(saved.id, `${saved.name}: added, ${saved.enabled ? 'on' : 'off'}, in ${saved.mode}`)
  else {
    const changes = settingsChanges(before, saved)
    if (changes.length) note(saved.id, changeNote(saved.name, changes))
  }
  return saved
}

// Every bot off, the kill switch on, then every open position across every
// bot sold at the bid. Shared by the Cash out all button and the day profit
// lock, and written to the ledger either way.
async function cashOut(onlyInProfit: boolean, why: string, scope: 'all' | 'live' | 'paper' = 'all'): Promise<CashOutResult> {
  // A paper lock touches paper only; live bots, live positions and the kill
  // switch are left exactly as they are.
  const on = settingsStore.bots().filter((b) => b.enabled && (scope === 'all' || (scope === 'paper') === (b.mode === 'paper')))
  for (const b of on) saveLogged({ ...b, enabled: false })
  if (scope !== 'paper') await supervisor.killSwitch(true)
  note(null, `Cash out ${why}${scope !== 'all' ? `, ${scope} only` : ''}${onlyInProfit ? ', positions in profit only' : ''}: ${on.length} bots switched off${scope !== 'paper' ? ', kill switch on' : ''}`)
  const result = await supervisor.cashOutAll(onlyInProfit, scope)
  note(null, `Cash out sold ${result.contracts} contracts, ${result.sold} positions in full and ${result.partly} in part, ${result.pnlUsd >= 0 ? '+' : '-'}$${Math.abs(result.pnlUsd).toFixed(2)} after fees; ${result.kept.length} kept`)
  send('state', supervisor.publicState())
  return { ...result, botsOff: on.length }
}

function registerIpc(): void {
  handle('terms:status', () => terms.status())
  handle('terms:accept', (version: string, acknowledged: number) => {
    confirmNative('Accept the Lazy Edge terms of use?', 'You confirm you have read the terms and every acknowledgement on the screen.', 'Accept')
    terms.accept(String(version), Number(acknowledged))
  })

  handle('state:get', () => supervisor.publicState())
  // The whole slate is large, so the Board pulls it when it is on screen
  // instead of it riding along with every state update.
  handle('board:get', () => ({ board: supervisor.state.board, verdicts: supervisor.state.verdicts }))
  handle('engine:start', () => { terms.require(); supervisor.start() })
  handle('engine:stop', () => supervisor.stop())
  handle('engine:cycle', () => { terms.require(); return supervisor.cycle(true) })
  handle('engine:killSwitch', (on: boolean) => {
    if (!on && settingsStore.account().killSwitch) confirmNative('Release the kill switch?', 'Live bots that are switched on will start sending orders again on the next cycle.', 'Release')
    return supervisor.killSwitch(Boolean(on))
  })

  // Lock it in: every bot off, the kill switch on, every open position across
  // every bot sold at the bid. The choice is made in a native dialog the page
  // cannot click for itself.
  handle('engine:cashOut', async () => {
    const choice = dialog.showMessageBoxSync(win!, {
      type: 'warning', title: 'Lazy Edge', noLink: true, defaultId: 2, cancelId: 2,
      buttons: ['Cash out everything', 'Only positions in profit', 'Cancel'],
      message: 'Cash out every open position, across all bots?',
      detail: 'Every bot is switched off and the kill switch goes on, so nothing new is bought and nothing waits on the book. Then each open position, live and paper, is sold now at the best bid, as far as the bid goes. Whatever cannot be sold is held to settlement. Live sales are real orders and cannot be undone.'
    })
    if (choice === 2) return null
    return cashOut(choice === 1, 'by hand')
  })

  handle('auth:status', async () => {
    if (!auth.signedIn()) return { signedIn: false }
    try { return { signedIn: true, usage: await lazyedge.usage() } } catch (err) { return { signedIn: true, error: (err as Error).message } }
  })
  // The Lazy Edge key is tested before it is saved, so a typo never reaches the vault.
  handle('auth:setKey', (key: string) => auth.setKey(String(key)))
  // Without a key no bot has data to trade on, so the engine stops with it.
  handle('auth:removeKey', async () => { supervisor.stop(); await auth.removeKey() })

  handle('keys:describe', () => vault.describe())
  handle('keys:set', async (name: SecretName, value: string) => {
    if (!WRITABLE_SECRETS.includes(name)) throw new Error(`not a writable secret: ${name}`)
    if (name === 'ai.ollamaUrl') {
      const u = new URL(String(value))
      if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new Error('The Ollama address must start with http:// or https://')
      const local = ['127.0.0.1', 'localhost', '[::1]'].includes(u.hostname)
      if (!local && u.protocol !== 'https:') throw new Error('An Ollama server on another machine must use https, or your prompts cross the network unencrypted.')
    }
    await vault.set(name, String(value))
    // New Polymarket key material means the derived API credentials are stale.
    if (name.startsWith('polymarket.')) await vault.remove('polymarket.apiCreds')
  })
  handle('keys:remove', async (name: SecretName) => {
    if (!WRITABLE_SECRETS.includes(name)) throw new Error(`not a writable secret: ${name}`)
    await vault.remove(name)
  })
  handle('keys:test', async (target: string) => {
    if (target === 'paper' || target === 'kalshi' || target === 'polymarket') return supervisor.venues[target].test()
    const p = allProviders().find((x) => x.id === target)
    if (!p) throw new Error(`unknown target ${target}`)
    return p.test()
  })
  handle('ai:models', (provider: ProviderId) => ai(provider).models())
  handle('ai:configured', () => Object.fromEntries(allProviders().map((p) => [p.id, p.configured()])))

  handle('settings:account', () => settingsStore.account())
  handle('settings:saveAccount', (doc: unknown) => {
    // The day profit lock sells on its own, so switching it on or changing it
    // while on is confirmed natively, like going live.
    const lockNext = AccountSettings.shape.profitLock.safeParse((doc as { profitLock?: unknown })?.profitLock)
    const lockNow = settingsStore.account().profitLock
    if (lockNext.success && lockNext.data.enabled && JSON.stringify(lockNext.data) !== JSON.stringify(lockNow)) {
      const l = lockNext.data
      confirmNative('Turn on the day profit lock?',
        `Once the ${l.watch === 'live' ? 'live Kalshi' : 'paper'} day is up ${l.upPct}%${l.trailPct > 0 ? ` and then gives back ${l.trailPct} points from its best` : ''}, the app cashes out on its own: every ${l.watch} bot is switched off${l.watch === 'live' ? ', the kill switch goes on,' : ''} and every open ${l.watch} position is sold at the bid.${l.watch === 'live' ? ' These are real sales that cannot be undone.' : ''}`,
        'Turn on')
    }
    // Only engine:killSwitch (and its native confirm) moves the kill switch; a
    // saved account document, stale or crafted, keeps whatever is stored.
    const saved = settingsStore.saveAccount({ ...(doc as object), killSwitch: settingsStore.account().killSwitch })
    send('state', supervisor.publicState())
    return saved
  })
  handle('bots:list', () => settingsStore.bots())
  handle('bots:new', (name: string) => defaultBot(`bot-${Date.now().toString(36)}`, String(name || 'New bot')))
  handle('bots:save', (doc: unknown) => {
    const next = doc as { id?: string; enabled?: boolean; mode?: string; name?: string }
    if (next?.enabled) terms.require()
    const before = settingsStore.bots().find((b) => b.id === next?.id)
    if (next?.enabled && next.mode === 'live' && !(before?.enabled && before.mode === 'live')) {
      confirmNative(`Switch on "${String(next.name ?? 'this bot')}" in live mode?`, 'It will send real orders with your money to Kalshi or Polymarket, wherever you have a key saved, under its settings. Only the kill switch stops it.', 'Switch on')
    }
    const saved = saveLogged(doc)
    supervisor.restartTimer()
    return saved
  })
  // Starter updates: what each starter bot could take or has taken, and the
  // user's choice. Every change is written to the ledger like any save.
  handle('starters:status', () => {
    const pending = new Set(settingsStore.pendingStarters())
    const out: Record<string, { pending: Change[] | null; replaced: Change[] | null }> = {}
    for (const b of settingsStore.bots()) {
      const s = starterOf(b.id)
      if (!s) continue
      const old = settingsStore.starterBackup(b.id)
      const starter = BotSettings.parse(s.build())
      // An update waiting: only what this version changed, never the user's
      // own settings.
      const update = pending.has(b.id) ? starterUpdate(b, starter, s.key) : []
      const reset = starterChanges(b, starter)
      out[b.id] = {
        pending: update.length ? update : null,
        replaced: old ? starterChanges(old, b) : null
      }
      // What Reset to the starter would change, even with no update waiting.
      if (!update.length && reset.length) (out[b.id] as { reset?: Change[] }).reset = reset
    }
    return out
  })
  const logStarter = (before: BotSettings | undefined, after: BotSettings | null, what: string): void => {
    if (!before || !after) return
    const changes = settingsChanges(before, after)
    note(after.id, changes.length ? `${changeNote(after.name, changes)} (${what})` : `${after.name}: ${what}, nothing changed`)
    supervisor.restartTimer()
  }
  handle('starters:use', (id: string) => {
    const before = settingsStore.bots().find((b) => b.id === String(id))
    logStarter(before, settingsStore.useStarter(String(id), 'update'), "took this version's starter changes")
  })
  handle('starters:reset', (id: string) => {
    const before = settingsStore.bots().find((b) => b.id === String(id))
    logStarter(before, settingsStore.useStarter(String(id), 'reset'), 'reset to the starter, money kept')
  })
  handle('starters:keep', (id: string) => { settingsStore.keepMine(String(id)) })
  handle('starters:undo', (id: string) => {
    const before = settingsStore.bots().find((b) => b.id === String(id))
    logStarter(before, settingsStore.restoreStarterBackup(String(id)), 'put the old settings back')
  })
  handle('starters:dismiss', (id: string) => { settingsStore.dropStarterBackup(String(id)) })
  handle('bots:delete', (id: string) => {
    const gone = settingsStore.bots().find((b) => b.id === String(id))
    settingsStore.deleteBot(String(id))
    if (gone) note(gone.id, `${gone.name}: deleted`)
  })
  // A Results fix, applied to the bots the user ticked. A fix only narrows
  // what a bot may trade, so it needs no native confirm; each save is logged
  // with the change, and the bots as they were go back for undo.
  handle('results:apply', (doc: unknown, ids: unknown) => {
    const fix = Fix.parse(doc)
    const want = new Set(Array.isArray(ids) ? ids.map(String) : [])
    const changed: string[] = []
    const skipped: { name: string; why: string }[] = []
    const before: BotSettings[] = []
    for (const bot of settingsStore.bots().filter((b) => want.has(b.id))) {
      const { next, why } = applyFix(bot, fix)
      if (!next) { skipped.push({ name: bot.name, why }); continue }
      before.push(bot)
      note(bot.id, `${bot.name}: from Results, ${fixText(fix)}`)
      saveLogged(next)
      changed.push(bot.name)
    }
    supervisor.restartTimer()
    return { changed, skipped, before }
  })
  // The AI desk. Apply does only what the suggestion's own action says, which
  // is a pause or a Results fix: both only narrow what a bot trades, so like
  // results:apply they need no native confirm. Each is written to the ledger.
  handle('desk:get', () => desk.state())
  handle('desk:ask', () => desk.askNow())
  handle('desk:ai', (on: boolean) => desk.setAi(Boolean(on)))
  handle('desk:dismiss', (id: string) => desk.mark(String(id), 'dismissed'))
  // ── AI changes: levels of confirmation, and a way back ───────────────
  // Every AI change goes through here. Money, paper or live and venues are
  // refused whole; a live bot asked to trade more gets a second window that
  // names it; every change is logged and can be put back.
  const applyAi = (doc: unknown, source: AiChange['source'], what: string): { bot: BotSettings; changeId: string | null } => {
    const after = BotSettings.parse(doc)
    const before = settingsStore.bots().find((b) => b.id === after.id)
    if (!before) {
      // A new bot from the AI starts in paper, whatever the draft says.
      const saved = saveLogged({ ...after, mode: 'paper' })
      note(saved.id, `${saved.name}: made by the AI (${source}), ${what}`.slice(0, 4000))
      supervisor.restartTimer()
      return { bot: saved, changeId: null }
    }
    const money = moneyChanges(before, after)
    if (money.length) throw new Error(`The AI cannot change ${money.map((c) => fieldName(c.field).toLowerCase()).join(', ')}. Those stay yours.`)
    const lv = levelFor(before, after)
    if (!lv.changes.length) throw new Error('Nothing would change.')
    if (lv.level === 3) {
      confirmNative(`${before.name} trades real money. Let it trade more?`,
        `This change lets a live bot take plays it skips now:\n${changeLines(lv.looser).map((c) => `• ${c.name}: ${c.from} to ${c.to}`).join('\n')}\n\nYou can put it back from the bot or the Desk.`,
        'Let it trade more')
    }
    const change = aiChanges.record({ botId: before.id, source, what, before })
    const saved = saveLogged(after)
    note(saved.id, `${saved.name}: the change above came from the AI (${source}), ${what}`.slice(0, 4000))
    supervisor.restartTimer()
    return { bot: saved, changeId: change.id }
  }
  handle('ai:save', (doc: unknown, what: string) => applyAi(doc, 'ai box', String(what ?? '').slice(0, 300)))
  handle('ai:changes', (botId?: string) => aiChanges.list(botId ? String(botId) : undefined))
  handle('ai:undo', (id: string) => {
    const c = aiChanges.get(String(id))
    if (!c || c.undoneAt) throw new Error('That change was already put back.')
    const now = settingsStore.bots().find((b) => b.id === c.botId)
    if (!now) throw new Error('That bot no longer exists.')
    // The settings as they were, run the way the bot runs now.
    const back = { ...c.before, id: now.id, name: now.name, enabled: now.enabled, mode: now.mode, market: { ...c.before.market, venues: now.market.venues }, size: now.size, guards: { ...c.before.guards, maxDailyDrawdownUsd: now.guards.maxDailyDrawdownUsd } }
    const lv = levelFor(now, back)
    if (lv.level === 3) confirmNative(`${now.name} trades real money. Put the old settings back?`, `The old settings let it take plays it skips now:\n${changeLines(lv.looser).map((x) => `• ${x.name}: ${x.from} to ${x.to}`).join('\n')}`, 'Put them back')
    saveLogged(back)
    note(now.id, `${now.name}: put back the AI change from ${new Date(c.at).toLocaleString()} (${c.what})`.slice(0, 4000))
    aiChanges.markUndone(c.id)
    supervisor.restartTimer()
    return aiChanges.list()
  })
  // ── Paper trials ─────────────────────────────────────────────────────
  // Start from a desk suggestion (its id) or from an AI box draft (a bot).
  handle('trial:start', (from: unknown, what?: string) => {
    let proposed: BotSettings
    let label: string
    let recId: string | null = null
    if (typeof from === 'string') {
      const rec = desk.get(from)
      if (!rec || !rec.action || rec.action.kind !== 'fix' || !rec.botId) throw new Error('Only a suggested settings change can be tried in paper.')
      const bot = settingsStore.bots().find((b) => b.id === rec.botId)
      if (!bot) throw new Error('That bot no longer exists.')
      const action = DeskAction.parse(rec.action)
      if (action.kind !== 'fix') throw new Error('Only a suggested settings change can be tried in paper.')
      const { next, why } = applyFix(bot, action.fix)
      if (!next) throw new Error(`${bot.name} would not change: ${why}.`)
      proposed = next
      label = rec.title
      recId = rec.id
    } else {
      proposed = BotSettings.parse(from)
      label = String(what ?? 'a change from the AI box')
    }
    const bots = settingsStore.bots()
    const original = bots.find((b) => b.id === proposed.id)
    if (!original) throw new Error('A trial needs the bot it tests.')
    if (original.trial) throw new Error('This bot is itself a trial.')
    if (bots.some((b) => b.trial?.of === original.id)) throw new Error(`${original.name} already has a trial running. Accept or drop it first.`)
    const money = moneyChanges(original, proposed)
    if (money.length) throw new Error(`The AI cannot change ${money.map((c) => fieldName(c.field).toLowerCase()).join(', ')}. Those stay yours.`)
    const t = saveLogged(trialBot(original, proposed, label, Date.now()))
    note(t.id, `${t.name}: a paper trial of ${original.name}, testing ${label}`.slice(0, 4000))
    if (recId) desk.setTrial(recId, t.id)
    supervisor.restartTimer()
    desk.refresh()
    return t
  })
  handle('trial:accept', (trialId: string) => {
    const t = settingsStore.bots().find((b) => b.id === String(trialId) && b.trial)
    if (!t) throw new Error('That trial has ended.')
    const original = settingsStore.bots().find((b) => b.id === t.trial!.of)
    if (!original) throw new Error('The bot it tested no longer exists.')
    // The same levels as any AI change: a live bot asked to trade more says so.
    applyAi(acceptedBot(original, t), 'trial', t.trial!.what)
    settingsStore.deleteBot(t.id)
    note(t.id, `${t.name}: accepted onto ${original.name} and ended`)
    for (const r of desk.state().recs.filter((r) => r.trialId === t.id)) { desk.setTrial(r.id, null); desk.mark(r.id, 'applied') }
    desk.refresh()
    return desk.state()
  })
  handle('trial:drop', (trialId: string) => {
    const t = settingsStore.bots().find((b) => b.id === String(trialId) && b.trial)
    if (!t) throw new Error('That trial has ended.')
    settingsStore.deleteBot(t.id)
    note(t.id, `${t.name}: dropped; ${settingsStore.bots().find((b) => b.id === t.trial!.of)?.name ?? 'the bot'} keeps its settings`)
    for (const r of desk.state().recs.filter((r) => r.trialId === t.id)) { desk.setTrial(r.id, null); desk.mark(r.id, 'dismissed') }
    supervisor.restartTimer()
    desk.refresh()
    return desk.state()
  })

  // ── Explain, recap, ask, build ───────────────────────────────────────
  handle('ai:why', async (botId: string) => {
    const bot = settingsStore.bots().find((b) => b.id === String(botId))
    if (!bot) throw new Error('That bot no longer exists.')
    const day = tradingDay(Date.now())
    const skips = ledger.events(2).filter((e) => e.type === 'skip' && e.botId === bot.id && tradingDay(e.at) === day) as { gate: string; detail: string }[]
    const verdicts = Object.values(supervisor.state.verdicts).flat().filter((v) => v.botId === bot.id)
    const facts = whyFacts({
      bot, engineRunning: supervisor.state.running,
      liveProblem: liveProblem(bot, settingsStore.account(), supervisor.publicState().venues),
      verdicts, skipsToday: skips.map((s) => ({ gate: s.gate, detail: s.detail })),
      tradesToday: ledger.tickets(2).filter((t) => t.botId === bot.id && tradingDay(t.createdAt) === day && t.filledContracts > 0).length,
      gateWords: (g) => GATES[g] ?? g
    })
    return { ...facts, ...(await desk.why(facts, rulesLine(bot))) }
  })
  handle('desk:recap', () => desk.recap())
  handle('desk:chat', (question: string, history: unknown) => desk.chat(String(question), Array.isArray(history) ? history.slice(-4) as { q: string; a: string }[] : []))
  // A losing spot inside a bot: leave it out now (a narrowing change, level 1
  // or 2, recorded and undoable), or try leaving it out on a paper copy first.
  const patternChange = (key: string): { p: Pattern; bot: BotSettings; next: BotSettings } => {
    const p = desk.state().patterns.find((x) => x.key === String(key))
    if (!p || !p.fix || !p.botId) throw new Error('That spot is no longer in the record.')
    const bot = settingsStore.bots().find((b) => b.id === p.botId)
    if (!bot) throw new Error('That bot no longer exists.')
    const { next, why } = applyFix(bot, p.fix)
    if (!next) throw new Error(`${bot.name} would not change: ${why}.`)
    return { p, bot, next }
  }
  handle('desk:patternFix', (key: string) => {
    const { p, next } = patternChange(key)
    applyAi(next, 'desk', `${fixText(p.fix!)}, from a losing spot: ${p.dimension.toLowerCase()} ${p.segment}`)
    desk.refresh()
    return desk.state()
  })
  // The app wide chat. Apply goes through applyAi like the AI box: money is
  // refused, a live bot asked to trade more gets the second window, and the
  // change can be put back. Try in paper runs it beside the bot instead.
  handle('chat:apply', (id: string) => {
    const p = desk.proposal(String(id))
    const out = applyAi(p.bot, 'chat', p.request)
    desk.dropProposal(p.id)
    return out
  })
  handle('chat:trial', (id: string) => {
    const p = desk.proposal(String(id))
    const bot = settingsStore.bots().find((b) => b.id === p.botId)!
    if (settingsStore.bots().some((b) => b.trial?.of === bot.id)) throw new Error(`${bot.name} already has a trial running. Accept or drop it first.`)
    if (moneyChanges(bot, p.bot).length) throw new Error('The AI cannot change money settings.')
    const t = saveLogged(trialBot(bot, p.bot, p.request.slice(0, 200), Date.now()))
    note(t.id, `${t.name}: a paper trial of ${bot.name} from the chat, testing ${p.request}`.slice(0, 4000))
    desk.dropProposal(p.id)
    supervisor.restartTimer()
    desk.refresh()
    return t
  })
  handle('desk:patternTrial', (key: string) => {
    const { p, bot, next } = patternChange(key)
    if (settingsStore.bots().some((b) => b.trial?.of === bot.id)) throw new Error(`${bot.name} already has a trial running. Accept or drop it first.`)
    const t = saveLogged(trialBot(bot, next, `${fixText(p.fix!)} (${p.dimension.toLowerCase()} ${p.segment} was losing)`, Date.now()))
    note(t.id, `${t.name}: a paper trial of ${bot.name}, testing ${fixText(p.fix!)}`)
    supervisor.restartTimer()
    desk.refresh()
    return desk.state()
  })
  handle('desk:patternBot', (key: string) => {
    const p = desk.state().patterns.find((x) => x.key === String(key))
    if (!p) throw new Error('That pattern is no longer in the record.')
    terms.require()
    const b = saveLogged(patternBot(p, Date.now()))
    note(b.id, `${b.name}: made from a ${p.strength} pattern in the record, ${p.won} won and ${p.lost} lost, ${p.centsPerContract}c a contract over ${p.n} trades in ${p.games} games`)
    supervisor.restartTimer()
    desk.refresh()
    return b
  })
  handle('desk:apply', (id: string) => {
    const rec = desk.get(String(id))
    if (!rec || rec.status !== 'new' || !rec.action || !rec.botId) throw new Error('This suggestion has nothing to apply.')
    const bot = settingsStore.bots().find((b) => b.id === rec.botId)
    if (!bot) throw new Error('That bot no longer exists.')
    const action = DeskAction.parse(rec.action)
    if (action.kind === 'pause') {
      if (!bot.enabled) throw new Error(`${bot.name} is already off.`)
      note(bot.id, `${bot.name}: paused from the AI desk, ${rec.title}`)
      saveLogged({ ...bot, enabled: false })
      supervisor.restartTimer()
      return desk.mark(rec.id, 'applied')
    }
    const { next, why } = applyFix(bot, action.fix)
    if (!next) throw new Error(`${bot.name} did not change: ${why}.`)
    // A desk fix only narrows, so it is level 1 or 2; it is still recorded
    // so it can be put back.
    return desk.mark(rec.id, 'applied', applyAi(next, 'desk', fixText(action.fix)).changeId)
  })
  // Every paper bot switched on, and any starter not in the list added, the
  // way a user would do it by hand. Live bots are never touched.
  handle('bots:paperTest', (maxTradeUsd: number | null) => {
    terms.require()
    const bots = settingsStore.bots()
    const have = new Set(bots.map((b) => b.id))
    const missing = STARTERS.map((s) => s.build()).filter((b) => !have.has(b.id))
    const cap = maxTradeUsd === null ? null : Number(maxTradeUsd)
    const plan = paperTestPlan(bots, missing, cap !== null && Number.isFinite(cap) && cap > 0 ? cap : null)
    for (const b of plan.save) saveLogged(b)
    note(null, `Paper test started: ${plan.save.length} bots on in paper${cap ? `, largest trade $${cap}` : ''}${plan.live.length ? `; live bots left as they are: ${plan.live.join(', ')}` : ''}`)
    supervisor.restartTimer()
    return { on: plan.save.length, live: plan.live }
  })
  handle('bots:paperStop', () => {
    const on = settingsStore.bots().filter((b) => b.enabled && b.mode === 'paper')
    for (const b of on) saveLogged({ ...b, enabled: false })
    note(null, `Paper test stopped: ${on.length} paper bots switched off`)
    supervisor.restartTimer()
    return { off: on.length }
  })
  // Test data for the user to study or send: trades, skips, settings changes
  // and a summary, written to a folder the user picks. Read only.
  handle('test:export', async (days: number) => {
    const d = Math.min(Math.max(Number(days) || 30, 1), 3650)
    const to = Date.now()
    const from = to - d * 86_400_000
    const files = exportFiles(ledger.tickets(d), ledger.eventsBetween(from, to + 1), settingsStore.bots(), from, to)
    const { canceled, filePaths } = await dialog.showOpenDialog(win!, { title: 'Choose where to save the test data', defaultPath: app.getPath('documents'), properties: ['openDirectory', 'createDirectory'] })
    if (canceled || !filePaths[0]) return null
    const folder = join(filePaths[0], `Lazy Edge test data ${new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-')}`)
    mkdirSync(folder, { recursive: true })
    for (const [name, text] of Object.entries(files)) writeFileSync(join(folder, name), text)
    void shell.openPath(folder)
    return folder
  })
  // Write only: the renderer can put a share code on the clipboard, never read it.
  handle('app:logError', (what: unknown) => { crashLog(`screen ${String(what).slice(0, 4000)}`) })
  handle('clipboard:write', (text: string) => clipboard.writeText(String(text).slice(0, REPORT_MAX)))
  // With a bot, the AI edits that bot and never its money, name or mode;
  // without one it drafts a new bot, off and in paper. Nothing is saved here.
  handle('bots:draft', async (sentence: string, provider: ProviderId, bot?: unknown) => {
    const guide = await lazyedge.skill().catch(() => '')
    const base = bot === undefined || bot === null ? undefined : BotSettings.parse(bot)
    return draftStrategy(ai(provider), String(sentence), guide, undefined, base)
  })

  handle('ledger:tickets', (days?: number) => ledger.tickets(Math.min(Number(days) || 7, 3650)))
  handle('accuracy:get', () => accuracy.state())
  // Read only: public Kalshi market data, written to accuracy.json.
  handle('accuracy:run', async () => { await accuracy.run(supervisor.venues.kalshi as KalshiVenue, ledger.tickets(30)); return accuracy.state() })
  // Reads day files from disk, so capped at a month.
  handle('ledger:events', (days?: number) => ledger.events(Math.min(Number(days) || 1, 31)))
  // Read only: one ticket against Kalshi's public record and its bot's rules.
  handle('play:check', (id: string) => {
    const history = ledger.tickets(3650)
    const t = history.find((x) => x.id === String(id))
    if (!t) throw new Error('That play is no longer in the ledger.')
    return checkPlay(t, settingsStore.bots().find((b) => b.id === t.botId) ?? null, supervisor.venues.kalshi as KalshiVenue, history)
  })

  // Reports leave only through the user's own email program, addressed here
  // and never by the page. The full text goes on the clipboard too, since a
  // mailto link holds only about 2,000 characters.
  handle('notices:get', () => notices.state())
  handle('notices:dismiss', (id: string) => notices.dismiss(String(id)))
  handle('notices:check', () => notices.check().then(() => notices.state()))

  handle('report:context', () => ({
    os: `Windows ${release()} ${process.arch}`,
    supportEmail: SUPPORT_EMAIL,
    problems: supervisor.state.recent.filter((e) => /rejected|failed|error/.test(e.outcome)).slice(0, 20)
  }))
  // One trading day for a day report: its trades, and how many plays each bot
  // passed on and why. Read only, from the local ledger.
  handle('report:day', (day: string) => {
    const d = String(day)
    if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) throw new Error('not a day')
    const { from, to } = dayBounds(d)
    const tickets = ledger.tickets(3650).filter((t) => tradingDay(t.createdAt) === d)
    const skips: Record<string, Record<string, number>> = {}
    for (const e of ledger.eventsBetween(from, to)) {
      if (e.type !== 'skip') continue
      const g = (skips[e.botId] ??= {})
      g[e.gate] = (g[e.gate] ?? 0) + 1
    }
    return { tickets, skips }
  })
  handle('report:email', async (subject: string, text: string) => {
    const report = String(text).slice(0, REPORT_MAX)
    clipboard.writeText(report)
    const { url, full } = mailtoUrl(SUPPORT_EMAIL, String(subject).slice(0, 160), report)
    await shell.openExternal(url)
    return { full }
  })
  handle('report:save', async (text: string) => {
    const name = `Lazy-Edge-report-${new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-')}.txt`
    const { canceled, filePath } = await dialog.showSaveDialog(win!, { title: 'Save report', defaultPath: join(app.getPath('documents'), name), filters: [{ name: 'Text', extensions: ['txt'] }] })
    if (canceled || !filePath) return null
    writeFileSync(filePath, String(text).slice(0, REPORT_MAX))
    return filePath
  })
}

app.whenReady().then(async () => {
  settingsStore.init()
  settingsStore.seedStarters()
  ledger.init()
  for (const name of settingsStore.migrateDryRun()) {
    const bot = settingsStore.bots().find((b) => b.name === name)
    note(bot?.id ?? null, `${name}: mode live -> paper. Dry run is gone and a bot's mode is now the only live switch, so a bot that was live under dry run starts in paper; switch it to Live to send real orders.`)
  }
  // After the dry run move, so a bot it put back in paper takes the update.
  const starters = settingsStore.refreshStarters()
  for (const b of starters.updated) note(b.id, `${b.name}: took this version's starter settings; the old settings are kept and can be put back on the Bots screen.`)
  try {
    await vault.init()
  } catch (err) {
    // No safe place for keys means no keys at all, never a weaker fallback.
    dialog.showErrorBox('Lazy Edge cannot start', `${(err as Error).message}. The app will not store keys without Windows encryption.`)
    app.exit(1)
    return
  }
  supervisor = new Supervisor()
  desk = new Desk(() => supervisor.state.board, () => supervisor.state.verdicts, () => ({
    account: () => settingsStore.account(),
    engine: () => {
      const s = supervisor.publicState()
      return { running: s.running, lastCycleAt: s.lastCycleAt, lastError: s.lastError, recent: s.recent, venues: s.venues as EngineView['venues'] }
    },
    version: app.getVersion(),
    guide: () => lazyedge.skill()
  }))
  desk.on('state', (s) => send('desk', s))
  supervisor.on('state', () => {
    send('state', supervisor.publicState())
    if (supervisor.state.running) desk.tick()
  })
  supervisor.on('ticket', (t) => send('ticket', t))
  // The day profit lock fired: the same cash out as the button, and the user
  // is told even if the window is behind something else.
  supervisor.on('profitLock', (why: string) => {
    void cashOut(false, `by the day profit lock: ${why}`, settingsStore.account().profitLock.watch).then((r) => {
      send('cashOut', { ...r, why })
      if (Notification.isSupported()) new Notification({ title: 'Lazy Edge cashed out', body: `Day profit lock: ${why}. Sold ${r.contracts} contracts, ${r.pnlUsd >= 0 ? '+' : '-'}$${Math.abs(r.pnlUsd).toFixed(2)} after fees. Its bots are off; switch them back on when you are ready.`.slice(0, 250) }).show()
    }).catch((err) => {
      note(null, `Day profit lock could not cash out: ${(err as Error).message}`)
      if (Notification.isSupported()) new Notification({ title: 'Lazy Edge profit lock', body: `It fired but could not cash out: ${(err as Error).message}`.slice(0, 250) }).show()
    })
  })
  // No menu in a packaged build, so no DevTools shortcut.
  if (app.isPackaged) Menu.setApplicationMenu(null)
  registerIpc()
  createWindow()
  notices.start((s) => send('notices', s))

  // Unsigned builds still check; installs pick updates up properly once the
  // build is signed (decision 15).
  if (app.isPackaged) {
    try {
      // Unsigned builds never download or install an update on their own.
      // The user is told one exists and installs it themselves, until the
      // build is signed and the publisher can be verified.
      const { autoUpdater } = await import('electron-updater')
      autoUpdater.autoDownload = false
      autoUpdater.autoInstallOnAppQuit = false
      // Asked once per version a session; the banner and a Windows
      // notification keep saying it after that.
      const asked = new Set<string>()
      autoUpdater.on('update-available', async (info) => {
        notices.updateAvailable(info.version)
        if (asked.has(info.version)) return
        asked.add(info.version)
        const { response } = await dialog.showMessageBox(win!, {
          type: 'info', title: 'Lazy Edge', buttons: ['Download', 'Later'], defaultId: 0, cancelId: 1, noLink: true,
          message: `Version ${info.version} is available.`,
          detail: `You have ${app.getVersion()}. Download opens the release page in your browser; run the new file and your bots, ledger and keys carry over. This version keeps working until you do.`
        })
        if (response === 0) void shell.openExternal(`${RELEASES_URL}/tag/v${encodeURIComponent(info.version)}`)
      })
      autoUpdater.on('error', () => { /* offline or no release yet; checked again later */ })
      void autoUpdater.checkForUpdates().catch(() => {})
      setInterval(() => void autoUpdater.checkForUpdates().catch(() => {}), 6 * 3_600_000)
    } catch { /* no update channel reachable */ }
  }
})

// Closing the window stops trading (decision 14).
app.on('window-all-closed', () => {
  supervisor?.stop()
  app.quit()
})
