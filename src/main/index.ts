import { app, BrowserWindow, clipboard, dialog, ipcMain, Menu, shell, type IpcMainInvokeEvent } from 'electron'
import { writeFileSync } from 'node:fs'
import { release } from 'node:os'
import { pathToFileURL } from 'node:url'
import { join } from 'node:path'
import { mailtoUrl, REPORT_MAX } from '@shared/report'
import { defaultBot } from '@shared/ruleset'
import type { ProviderId } from '@shared/schema'
import { draftStrategy } from './ai/strategy'
import { ai, allProviders } from './ai/registry'
import { accuracy } from './bots/accuracy'
import { checkPlay } from './bots/review'
import { Supervisor } from './bots/supervisor'
import { RELEASES_URL, SUPPORT_EMAIL } from './config'
import { auth } from './data/auth'
import { lazyedge } from './data/lazyedge'
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
  handle('engine:cycle', () => { terms.require(); return supervisor.cycle() })
  handle('engine:killSwitch', (on: boolean) => {
    if (!on && settingsStore.account().killSwitch) confirmNative('Release the kill switch?', 'Live bots that are switched on will start sending orders again on the next cycle.', 'Release')
    return supervisor.killSwitch(Boolean(on))
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
    const saved = settingsStore.saveBot(doc)
    supervisor.restartTimer()
    return saved
  })
  handle('bots:delete', (id: string) => settingsStore.deleteBot(String(id)))
  // Write only: the renderer can put a share code on the clipboard, never read it.
  handle('clipboard:write', (text: string) => clipboard.writeText(String(text).slice(0, 20_000)))
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
  handle('report:context', () => ({
    os: `Windows ${release()} ${process.arch}`,
    supportEmail: SUPPORT_EMAIL,
    problems: supervisor.state.recent.filter((e) => /rejected|failed|error/.test(e.outcome)).slice(0, 20)
  }))
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
  // No menu in a packaged build, so no DevTools shortcut.
  if (app.isPackaged) Menu.setApplicationMenu(null)
  registerIpc()
  createWindow()

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
      autoUpdater.on('update-available', async (info) => {
        const { response } = await dialog.showMessageBox(win!, {
          type: 'info', title: 'Lazy Edge', buttons: ['Download', 'Later'], defaultId: 0, cancelId: 1, noLink: true,
          message: `Version ${info.version} is available.`,
          detail: `You have ${app.getVersion()}. Download opens the release page in your browser; run the new file and your bots, ledger and keys carry over. This version keeps working until you do.`
        })
        if (response === 0) void shell.openExternal(`${RELEASES_URL}/tag/v${encodeURIComponent(info.version)}`)
      })
      autoUpdater.on('error', () => { /* offline or no release yet; checked again next launch */ })
      void autoUpdater.checkForUpdates().catch(() => {})
    } catch { /* no update channel reachable */ }
  }
})

// Closing the window stops trading (decision 14).
app.on('window-all-closed', () => {
  supervisor?.stop()
  app.quit()
})
