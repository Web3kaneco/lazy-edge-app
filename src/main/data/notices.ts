// Team notices and update alerts. The notices file is read from the public
// release repository every half hour, and the update check reruns every six
// hours, so an install left open for days still hears about both. Nothing is
// sent but the request for the file. Warnings, urgent notices and new
// versions also raise a Windows notification, once each.
import { app, Notification } from 'electron'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { activeNotices, type Notice, type NoticesState } from '@shared/notices'
import { NOTICES_URL, RELEASES_URL } from '../config'
import { requestJson } from './http'

const EVERY_MS = 30 * 60_000

interface Seen { dismissed: string[]; notified: string[] }

const file = (): string => join(app.getPath('userData'), 'notices-seen.json')
function readSeen(): Seen {
  try {
    const s = existsSync(file()) ? JSON.parse(readFileSync(file(), 'utf8')) : {}
    return { dismissed: Array.isArray(s.dismissed) ? s.dismissed : [], notified: Array.isArray(s.notified) ? s.notified : [] }
  } catch { return { dismissed: [], notified: [] } }
}
const writeSeen = (s: Seen): void => writeFileSync(file(), JSON.stringify({ dismissed: s.dismissed.slice(-200), notified: s.notified.slice(-200) }))

const releaseUrl = (version: string | null): string => version ? `${RELEASES_URL}/tag/v${encodeURIComponent(version)}` : RELEASES_URL

let all: Notice[] = []
let required: { version: string; reason: string | null } | null = null
let available: string | null = null
let checkedAt: number | null = null
let timer: NodeJS.Timeout | null = null
let onChange: (s: NoticesState) => void = () => {}

function notifyOnce(id: string, title: string, body: string): void {
  const seen = readSeen()
  if (seen.notified.includes(id)) return
  seen.notified.push(id)
  writeSeen(seen)
  if (Notification.isSupported()) new Notification({ title, body: body.slice(0, 250) }).show()
}

function emit(): void { onChange(notices.state()) }

export const notices = {
  state(): NoticesState {
    const { dismissed } = readSeen()
    const update = required
      ? { version: required.version, required: true, reason: required.reason, url: releaseUrl(available) }
      : available ? { version: available, required: false, reason: null, url: releaseUrl(available) } : null
    return { notices: all.filter((n) => !dismissed.includes(n.id)), update, checkedAt }
  },

  start(listener: (s: NoticesState) => void): void {
    onChange = listener
    if (timer) return
    void notices.check()
    timer = setInterval(() => void notices.check(), EVERY_MS)
  },

  async check(): Promise<void> {
    try {
      const raw = await requestJson(NOTICES_URL, { timeoutMs: 10_000, retries: 1 })
      const found = activeNotices(raw, app.getVersion(), Date.now())
      all = found.notices
      required = found.upgradeBelow ? { version: found.upgradeBelow, reason: found.upgradeReason } : null
      checkedAt = Date.now()
      for (const n of all) if (n.level !== 'info') notifyOnce(`notice:${n.id}`, `Lazy Edge: ${n.title}`, n.body)
      if (required) notifyOnce(`required:${required.version}`, 'Lazy Edge needs an update', required.reason ?? `Versions before ${required.version} should be updated. Open the app for the download.`)
    } catch {
      // Offline, or the file is missing: keep what was last shown and try again later.
    }
    emit()
  },

  // From the update check: a newer release exists.
  updateAvailable(version: string): void {
    if (available === version) return
    available = version
    notifyOnce(`update:${version}`, `Lazy Edge ${version} is available`, `You have ${app.getVersion()}. Open the app to download it; your bots, ledger and keys carry over.`)
    emit()
  },

  dismiss(id: string): void {
    const n = all.find((x) => x.id === id)
    // Urgent notices stay until the team takes them down.
    if (!n || n.level === 'urgent') return
    const seen = readSeen()
    if (!seen.dismissed.includes(id)) seen.dismissed.push(id)
    writeSeen(seen)
    emit()
  }
}
