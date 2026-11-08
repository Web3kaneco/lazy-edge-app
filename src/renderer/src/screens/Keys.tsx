import { useEffect, useState } from 'react'
import { api } from '../api'

interface SecretInput {
  name: string
  label: string
  hint?: string
  multiline?: boolean
  plain?: boolean // not secret, e.g. an address
}

const GROUPS: { title: string; target: string; lede: string; inputs: SecretInput[] }[] = [
  {
    title: 'Kalshi',
    target: 'kalshi',
    lede: 'Create an API key in Kalshi under Account, API keys. You get a key ID and a private key file. Paste both here; requests are signed on this computer and the key never leaves it. The Kalshi account and key are your own, Kalshi\'s member terms and Developer Agreement apply to your use of them, and Lazy Edge is not affiliated with Kalshi.',
    inputs: [
      { name: 'kalshi.keyId', label: 'Key ID', plain: true },
      { name: 'kalshi.privateKeyPem', label: 'Private key (the whole PEM file)', multiline: true }
    ]
  },
  {
    title: 'Polymarket',
    target: 'polymarket',
    lede: 'Polymarket orders must be signed by your account key; its API key alone cannot place an order. Fund a wallet you use only for this, so a mistake can never reach your main holdings. Set the account type on the Account screen. Polymarket\'s terms, including where it may be used, apply to you, and Lazy Edge is not affiliated with Polymarket.',
    inputs: [
      { name: 'polymarket.privateKey', label: 'Private key', hint: 'Email and Magic accounts: export it from Polymarket settings. Browser wallets: the key of the wallet you sign in with.' },
      { name: 'polymarket.funder', label: 'Polymarket profile address', plain: true, hint: 'The address shown on your Polymarket profile, which holds your USDC. Not needed for a plain wallet account.' }
    ]
  },
  { title: 'Anthropic', target: 'anthropic', lede: 'For drafting strategies and agent mode. Default model Claude Opus 5.5.', inputs: [{ name: 'ai.anthropic', label: 'API key' }] },
  { title: 'OpenAI', target: 'openai', lede: 'For drafting strategies and agent mode.', inputs: [{ name: 'ai.openai', label: 'API key' }] },
  { title: 'xAI', target: 'xai', lede: 'For drafting strategies and agent mode.', inputs: [{ name: 'ai.xai', label: 'API key' }] },
  { title: 'Ollama (local)', target: 'ollama', lede: 'A model running on this computer. No key, no cost.', inputs: [{ name: 'ai.ollamaUrl', label: 'Address', plain: true, hint: 'Usually http://127.0.0.1:11434' }] }
]

export function Keys() {
  const [keys, setKeys] = useState<Record<string, { set: boolean; hint: string }>>({})
  const [draft, setDraft] = useState<Record<string, string>>({})
  const [result, setResult] = useState<Record<string, { ok: boolean; detail: string } | 'testing'>>({})
  const [err, setErr] = useState('')

  const load = async (): Promise<void> => setKeys(await api.keys())
  useEffect(() => { void load() }, [])

  const save = async (name: string): Promise<void> => {
    setErr('')
    try {
      await api.setKey(name, draft[name] ?? '')
      setDraft((d) => ({ ...d, [name]: '' }))
      await load()
    } catch (e) { setErr((e as Error).message) }
  }

  const test = async (target: string): Promise<void> => {
    setResult((r) => ({ ...r, [target]: 'testing' }))
    const res = await api.test(target).catch((e) => ({ ok: false, detail: (e as Error).message }))
    setResult((r) => ({ ...r, [target]: res }))
  }

  return (
    <>
      <h1>Keys</h1>
      <p className="lede">Every key is encrypted by Windows for your user account and stays on this computer. The app can use a key; nothing, including this screen, can read one back.</p>
      {err && <p className="err">{err}</p>}
      <div className="grid cols-2">
        {GROUPS.map((g) => {
          const r = result[g.target]
          return (
            <div className="card" key={g.title}>
              <h2>{g.title}</h2>
              <p className="small muted" style={{ marginTop: 0 }}>{g.lede}</p>
              {g.inputs.map((i) => (
                <div className="field" key={i.name} style={{ marginBottom: 10 }}>
                  <label>{i.label} {keys[i.name]?.set && <span className="good">· saved {keys[i.name]!.hint}</span>}</label>
                  {i.multiline ? (
                    <textarea placeholder={keys[i.name]?.set ? 'Paste to replace' : '-----BEGIN PRIVATE KEY-----'} value={draft[i.name] ?? ''} onChange={(e) => setDraft((d) => ({ ...d, [i.name]: e.target.value }))} />
                  ) : (
                    <input type={i.plain ? 'text' : 'password'} placeholder={keys[i.name]?.set ? 'Paste to replace' : ''} value={draft[i.name] ?? ''} onChange={(e) => setDraft((d) => ({ ...d, [i.name]: e.target.value }))} autoComplete="off" />
                  )}
                  {i.hint && <span className="hint">{i.hint}</span>}
                  <div className="row" style={{ marginTop: 4 }}>
                    <button className="btn" disabled={!draft[i.name]?.trim()} onClick={() => save(i.name)}>Save</button>
                    {keys[i.name]?.set && <button className="btn ghost" onClick={async () => { await api.removeKey(i.name); await load() }}>Remove</button>}
                  </div>
                </div>
              ))}
              <div className="row">
                <button className="btn" onClick={() => test(g.target)}>Test connection</button>
                {r === 'testing' && <span className="small muted">Testing…</span>}
                {r && r !== 'testing' && <span className={`small ${r.ok ? 'good' : 'bad'}`}>{r.detail}</span>}
              </div>
            </div>
          )
        })}
      </div>
    </>
  )
}
