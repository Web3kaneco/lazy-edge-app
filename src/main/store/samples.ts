// The latest raw reply from a feed, kept on this computer only, so a change
// in what the API sends can be checked against the real thing (2026-11-26:
// the NFL prop rows were said to carry times and counts now, while the app
// still read none). One file per feed, written at most once a minute; a reply
// with player props is also kept under its own name, since most replies have
// none.
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { app } from 'electron'

const EVERY_MS = 60_000
const last = new Map<string, number>()

const dir = (): string => join(app.getPath('userData'), 'samples')

export function keepSample(name: string, body: unknown, now = Date.now()): void {
  if (now - (last.get(name) ?? 0) < EVERY_MS) return
  last.set(name, now)
  try {
    mkdirSync(dir(), { recursive: true })
    const text = JSON.stringify({ at: new Date(now).toISOString(), body }, null, 1)
    writeFileSync(join(dir(), `${name}.json`), text)
    const plays: any[] = Array.isArray((body as any)?.plays) ? (body as any).plays : []
    if (plays.some((p) => String(p?.market ?? '').toUpperCase() === 'PROP')) writeFileSync(join(dir(), `${name}-with-props.json`), text)
  } catch {
    // A sample is a convenience; trading never waits on it.
  }
}
