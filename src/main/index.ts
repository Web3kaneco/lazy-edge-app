import { app, BrowserWindow, clipboard, dialog, ipcMain, Menu, Notification, shell, type IpcMainInvokeEvent } from 'electron'
import { mkdirSync, writeFileSync } from 'node:fs'
import { release } from 'node:os'
import { pathToFileURL } from 'node:url'
import { join } from 'node:path'
import { dayBounds, tradingDay } from '@shared/day'
import { mailtoUrl, REPORT_MAX } from '@shared/report'
import { defaultBot } from '@shared/ruleset'
import type { BotSettings, ProviderId } from '@shared/schema'
import { STARTERS } from '@shared/starters'
import type { CashOutResult } from '@shared/exits'
import { changeNote, exportFiles, paperTestPlan, settingsChanges } from '@shared/testdata'
import { draftStrategy } from './ai/strategy'
import { ai, allProviders } from './ai/registry'
import { accuracy } from './bots/accuracy'
import { checkPlay } from './bots/review'
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

if (!app.requestSingleInstanceLock()) app.quit()
app.on('second-instance', () => { if (win) { if (win.isMinimized()) win.restore(); win.focus() } })

function createWindow(): void {
  win = new BrowserWindow({
    width: 1360,
    height: 880,
    minWidth: 1024,
    minHeight: 680,
    backgroundColor: '#0d0f12',
    title: `Lazy Edge Beta ${app.getVersion()}`,
    autoHideMenuBar: true,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false
    }
  })
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

  if (process.env.ELECTRON_RENDERER_URL) void win.loadURL(process.env.ELECTRON_RENDERER_URL)
  else void win.loadFile(join(__dirname, '../renderer/index.html'))
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
async function cashOut(onlyInProfit: boolean, why: string): Promise<CashOutResult> {
  const on = settingsStore.bots().filter((b) => b.enabled)
  for (const b of on) saveLogged({ ...b, enabled: false })
  await supervisor.killSwitch(true)
  note(null, `Cash out ${why}${onlyInProfit ? ', positions in profit only' : ''}: ${on.length} bots switched off, kill switch on`)
  const result = await supervisor.cashOutAll(onlyInProfit)
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
  handle('auth:emailStart', (email: string) => auth.emailStart(String(email)))
  handle('auth:emailVerify', (email: string, code: string) => auth.emailVerify(String(email), String(code)))
  handle('auth:wallet', () => auth.walletSignIn())
  handle('auth:signOut', async () => { supervisor.stop(); await auth.signOut() })

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
    if ((doc as { executionMode?: string })?.executionMode === 'live') {
      terms.require()
      if (settingsStore.account().executionMode !== 'live') confirmNative('Turn off dry run?', 'Live bots that are switched on will send real orders to your venues.', 'Go live')
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
      confirmNative(`Switch on "${String(next.name ?? 'this bot')}" in live mode?`, 'It will place real orders under its settings, subject to the dry run switch and the kill switch.', 'Switch on')
    }
    const saved = saveLogged(doc)
    supervisor.restartTimer()
    return saved
  })
  handle('bots:delete', (id: string) => {
    const gone = settingsStore.bots().find((b) => b.id === String(id))
    settingsStore.deleteBot(String(id))
    if (gone) note(gone.id, `${gone.name}: deleted`)
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
  handle('clipboard:write', (text: string) => clipboard.writeText(String(text).slice(0, REPORT_MAX)))
  handle('bots:draft', async (sentence: string, provider: ProviderId, model?: string) => {
    const guide = await lazyedge.skill().catch(() => '')
    return draftStrategy(ai(provider), String(sentence), guide, model)
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
  try {
    await vault.init()
  } catch (err) {
    // No safe place for keys means no keys at all, never a weaker fallback.
    dialog.showErrorBox('Lazy Edge cannot start', `${(err as Error).message}. The app will not store keys without Windows encryption.`)
    app.exit(1)
    return
  }
  supervisor = new Supervisor()
  supervisor.on('state', () => send('state', supervisor.publicState()))
  supervisor.on('ticket', (t) => send('ticket', t))
  // The day profit lock fired: the same cash out as the button, and the user
  // is told even if the window is behind something else.
  supervisor.on('profitLock', (why: string) => {
    void cashOut(false, `by the day profit lock: ${why}`).then((r) => {
      send('cashOut', { ...r, why })
      if (Notification.isSupported()) new Notification({ title: 'Lazy Edge cashed out', body: `Day profit lock: ${why}. Sold ${r.contracts} contracts, ${r.pnlUsd >= 0 ? '+' : '-'}$${Math.abs(r.pnlUsd).toFixed(2)} after fees. Every bot is off and the kill switch is on.`.slice(0, 250) }).show()
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
