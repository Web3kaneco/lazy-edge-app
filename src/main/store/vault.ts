// Secrets, encrypted by Electron safeStorage, which on Windows is DPAPI bound
// to the Windows user account (decision 7). Plaintext exists only in memory in
// the main process. The renderer can ask whether a secret is set and see its
// last four characters; it can never read one back.
//
// The file is decrypted once at startup (init), so reads are synchronous.
// Writes are queued so two saves can never interleave and corrupt the file.
import { app, safeStorage } from 'electron'
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

export type SecretName =
  | 'lazyedge.apiKey'
  | 'lazyedge.session'
  | 'kalshi.keyId'
  | 'kalshi.privateKeyPem'
  | 'polymarket.privateKey'
  | 'polymarket.funder'
  | 'polymarket.apiCreds'
  | 'ai.anthropic'
  | 'ai.openai'
  | 'ai.xai'
  | 'ai.ollamaUrl'

type Data = Partial<Record<SecretName, string>>

const file = (): string => join(app.getPath('userData'), 'vault.bin')

let cache: Data | null = null
let queue: Promise<void> = Promise.resolve()

function data(): Data {
  if (!cache) throw new Error('vault used before init')
  return cache
}

function persist(next: Data): Promise<void> {
  cache = next
  const snapshot = JSON.stringify(next)
  queue = queue.then(async () => {
    const tmp = `${file()}.tmp`
    writeFileSync(tmp, await safeStorage.encryptStringAsync(snapshot))
    renameSync(tmp, file()) // write then rename: a crash never corrupts the only copy
  })
  return queue
}

const HINTED = new Set(['kalshi.keyId', 'polymarket.funder', 'ai.ollamaUrl'])

export const vault = {
  async init(): Promise<void> {
    if (!(await safeStorage.isAsyncEncryptionAvailable())) throw new Error('Windows encryption is unavailable, refusing to store secrets')
    if (!existsSync(file())) { cache = {}; return }
    const { result, shouldReEncrypt } = await safeStorage.decryptStringAsync(readFileSync(file()))
    cache = JSON.parse(result)
    // The OS rotated its key; rewrite under the new one.
    if (shouldReEncrypt) await persist(cache!)
  },

  get(name: SecretName): string | null {
    return data()[name] ?? null
  },

  async set(name: SecretName, value: string): Promise<void> {
    const trimmed = value.trim()
    if (!trimmed) throw new Error(`empty value for ${name}`)
    await persist({ ...data(), [name]: trimmed })
  },

  async remove(name: SecretName): Promise<void> {
    const next = { ...data() }
    delete next[name]
    await persist(next)
  },

  // The only view the renderer gets. Identifiers show their last four
  // characters so the user can tell which one is saved; private keys,
  // API keys and tokens show nothing at all.
  describe(): Record<string, { set: boolean; hint: string }> {
    const out: Record<string, { set: boolean; hint: string }> = {}
    for (const [k, v] of Object.entries(data())) out[k] = { set: true, hint: v && HINTED.has(k) ? `…${v.slice(-4)}` : '' }
    return out
  }
}
