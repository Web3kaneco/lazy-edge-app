// Acceptance of the terms, by version. Enforced here in the main process: the
// engine will not start and no bot can be switched on until the current
// version is accepted, whatever the interface shows.
import { app } from 'electron'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { ACKNOWLEDGEMENTS, TERMS_VERSION } from '@shared/terms'

interface Acceptance {
  version: string
  acceptedAt: string
  acknowledgements: number
}

const file = (): string => join(app.getPath('userData'), 'terms.json')

function read(): Acceptance | null {
  try { return existsSync(file()) ? (JSON.parse(readFileSync(file(), 'utf8')) as Acceptance) : null } catch { return null }
}

export const terms = {
  status(): { version: string; accepted: boolean; acceptedAt: string | null } {
    const a = read()
    const accepted = a?.version === TERMS_VERSION && a.acknowledgements === ACKNOWLEDGEMENTS.length
    return { version: TERMS_VERSION, accepted, acceptedAt: accepted ? a!.acceptedAt : null }
  },

  accept(version: string, acknowledged: number): void {
    // The renderer must name the version it showed and confirm every box, so
    // a stale screen can never accept newer text.
    if (version !== TERMS_VERSION) throw new Error('These terms have changed. Read the current version first.')
    if (acknowledged !== ACKNOWLEDGEMENTS.length) throw new Error('Every acknowledgement must be confirmed.')
    writeFileSync(file(), JSON.stringify({ version, acceptedAt: new Date().toISOString(), acknowledgements: acknowledged }))
  },

  require(): void {
    if (!terms.status().accepted) throw new Error('Accept the terms of use first.')
  }
}
