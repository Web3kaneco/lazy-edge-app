// Messages from the Lazy Edge team to every install: a heads up, a warning,
// or "this version must be updated". Published as one JSON file on the public
// release repository and read by the app, so posting one needs no server and
// the app sends nothing but the request for the file. Text only: a notice can
// say something and link to a page, never change a setting or place an order.
import { z } from 'zod'

export const NoticeLevel = z.enum(['info', 'warn', 'urgent'])
export type NoticeLevel = z.infer<typeof NoticeLevel>

const Notice = z.object({
  id: z.string().min(1).max(80),
  level: NoticeLevel.default('info'),
  title: z.string().min(1).max(120),
  body: z.string().max(2000).default(''),
  link: z.string().max(500).optional(),
  // Shown only inside this window (ISO times), and only to versions in range.
  from: z.string().optional(),
  until: z.string().optional(),
  versionsBelow: z.string().optional(),
  versionsFrom: z.string().optional()
})
export type Notice = z.infer<typeof Notice>

export const NoticesFile = z.object({
  // Every version below this must update: an urgent notice that cannot be
  // dismissed, pointing at the release page.
  upgradeBelow: z.string().optional(),
  upgradeReason: z.string().max(500).optional(),
  notices: z.array(z.unknown()).max(50).default([])
})

// What the app shows: the notices for this version now, and whether it must update.
export interface NoticesState {
  notices: Notice[]
  // A newer release found by the update check, or required by upgradeBelow.
  update: { version: string | null; required: boolean; reason: string | null; url: string } | null
  checkedAt: number | null
}

// Links go only to the release repository or a Lazy Edge site.
const LINK_OK = /^https:\/\/((www\.)?github\.com\/Web3kaneco\/lazy-edge-app([/?#].*)?|([a-z0-9-]+\.)*lazyedge\.net([/?#].*)?)$/i

// 0.3.0-beta.1 style versions. A release sorts after its own prereleases.
export function compareVersions(a: string, b: string): number {
  const parse = (v: string): [number[], (string | number)[] | null] => {
    const [core, pre] = v.trim().replace(/^v/i, '').split('-', 2) as [string, string | undefined]
    const nums = core.split('.').map((n) => Number(n) || 0)
    return [nums, pre ? pre.split('.').map((p) => (/^\d+$/.test(p) ? Number(p) : p)) : null]
  }
  const [an, ap] = parse(a)
  const [bn, bp] = parse(b)
  for (let i = 0; i < 3; i++) if ((an[i] ?? 0) !== (bn[i] ?? 0)) return (an[i] ?? 0) - (bn[i] ?? 0)
  if (!ap || !bp) return ap ? -1 : bp ? 1 : 0
  for (let i = 0; i < Math.max(ap.length, bp.length); i++) {
    const x = ap[i], y = bp[i]
    if (x === undefined) return -1
    if (y === undefined) return 1
    if (x === y) continue
    if (typeof x === 'number' && typeof y === 'number') return x - y
    if (typeof x === 'number') return -1
    if (typeof y === 'number') return 1
    return x < y ? -1 : 1
  }
  return 0
}

// The notices this version should show now. A notice that does not parse is
// dropped on its own, so one bad entry never hides the rest.
export function activeNotices(raw: unknown, version: string, now: number): { notices: Notice[]; upgradeBelow: string | null; upgradeReason: string | null } {
  const file = NoticesFile.safeParse(raw)
  if (!file.success) return { notices: [], upgradeBelow: null, upgradeReason: null }
  const at = (iso: string | undefined): number | null => {
    const t = iso ? Date.parse(iso) : NaN
    return Number.isFinite(t) ? t : null
  }
  const notices: Notice[] = []
  for (const item of file.data.notices) {
    const n = Notice.safeParse(item)
    if (!n.success) continue
    const from = at(n.data.from)
    const until = at(n.data.until)
    if (from !== null && now < from) continue
    if (until !== null && now >= until) continue
    if (n.data.versionsBelow && compareVersions(version, n.data.versionsBelow) >= 0) continue
    if (n.data.versionsFrom && compareVersions(version, n.data.versionsFrom) < 0) continue
    notices.push({ ...n.data, link: n.data.link && LINK_OK.test(n.data.link) ? n.data.link : undefined })
  }
  const below = file.data.upgradeBelow
  const mustUpdate = Boolean(below && compareVersions(version, below) < 0)
  return { notices, upgradeBelow: mustUpdate ? below! : null, upgradeReason: mustUpdate ? file.data.upgradeReason ?? null : null }
}
