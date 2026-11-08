import { useState } from 'react'
import { api } from '../api'
import { BrandMark } from '../ui'

export function SignIn({ onDone }: { onDone: () => void }) {
  const [email, setEmail] = useState('')
  const [code, setCode] = useState('')
  const [sent, setSent] = useState(false)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')

  const run = async (fn: () => Promise<unknown>): Promise<void> => {
    setBusy(true); setErr('')
    try { await fn() } catch (e) { setErr((e as Error).message) } finally { setBusy(false) }
  }

  return (
    <div className="center">
      <div className="card signin">
        <div style={{ marginBottom: 12 }}><BrandMark /></div>
        <p className="muted">Sign in with the account you use on lazyedge.net. The app issues its own API key for this computer and keeps it in the Windows vault.</p>

        <div className="section">Email</div>
        {!sent ? (
          <div className="grid">
            <input type="email" placeholder="you@example.com" value={email} onChange={(e) => setEmail(e.target.value)} />
            <button className="btn primary" disabled={busy || !email.includes('@')} onClick={() => run(async () => { await api.emailStart(email); setSent(true) })}>
              Send me a code
            </button>
          </div>
        ) : (
          <div className="grid">
            <span className="small muted">A six digit code was sent to {email}.</span>
            <input type="text" inputMode="numeric" placeholder="123456" value={code} onChange={(e) => setCode(e.target.value)} />
            <div className="row">
              <button className="btn primary" disabled={busy || code.trim().length < 6} onClick={() => run(async () => { await api.emailVerify(email, code); onDone() })}>
                Sign in
              </button>
              <button className="btn ghost" onClick={() => { setSent(false); setCode('') }}>Use a different email</button>
            </div>
          </div>
        )}

        <div className="section">Wallet</div>
        <p className="small muted">Opens a page in your browser, where your wallet extension is. You sign a one time message; no transaction is made.</p>
        <button className="btn" disabled={busy} onClick={() => run(async () => { await api.wallet(); onDone() })}>
          {busy ? 'Waiting for your wallet…' : 'Sign in with wallet'}
        </button>

        {err && <p className="err">{err}</p>}
      </div>
    </div>
  )
}
