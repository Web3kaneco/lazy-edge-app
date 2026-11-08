// Sign in, then the app issues its own API key and vaults it (decision 9). The
// raw key is returned by the server exactly once, so each install holds its
// own key and can be revoked on its own from lazyedge.net/settings.
import { shell } from 'electron'
import { randomBytes } from 'node:crypto'
import { createServer, type IncomingMessage } from 'node:http'
import type { AddressInfo } from 'node:net'
import { API_BASE, SUPABASE_ANON_KEY, SUPABASE_URL } from '../config'
import { vault } from '../store/vault'
import { HttpError, requestJson } from './http'

interface Session {
  access_token: string
  refresh_token: string
  expires_in: number
}

const gotrue = <T>(path: string, body: unknown): Promise<T> => {
  if (!SUPABASE_ANON_KEY) throw new Error('This build has no Supabase anon key (MAIN_VITE_SUPABASE_ANON_KEY)')
  return requestJson<T>(`${SUPABASE_URL}/auth/v1${path}`, { method: 'POST', body, headers: { apikey: SUPABASE_ANON_KEY } })
}

async function finish(session: Session): Promise<{ tier: string; prefix: string }> {
  await vault.set('lazyedge.session', session.refresh_token)
  try {
    const issued = await requestJson<{ api_key: string; prefix: string; tier: string }>(`${API_BASE}/api/account/api-keys/issue`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${session.access_token}` }
    })
    await vault.set('lazyedge.apiKey', issued.api_key)
    return { tier: issued.tier, prefix: issued.prefix }
  } catch (err) {
    if (err instanceof HttpError && err.status === 402) {
      throw new Error('API access needs a paid Lazy Edge plan or 5 or more Lazy Lions in your linked wallets.')
    }
    throw err
  }
}

export const auth = {
  signedIn: (): boolean => Boolean(vault.get('lazyedge.apiKey')),

  // Email: Supabase sends a six digit code. The project's email template must
  // include {{ .Token }} for the code to appear in the message.
  async emailStart(email: string): Promise<void> {
    await gotrue('/otp', { email: email.trim(), create_user: true })
  },

  async emailVerify(email: string, code: string): Promise<{ tier: string; prefix: string }> {
    const session = await gotrue<Session>('/verify', { type: 'email', email: email.trim(), token: code.trim() })
    return finish(session)
  },

  // Wallet: a one time page on 127.0.0.1 in the user's own browser, where the
  // wallet extension lives. It signs the API's own nonce challenge; the page
  // only ever talks to this loopback server, which talks to the API.
  walletSignIn(): Promise<{ tier: string; prefix: string }> {
    const secret = randomBytes(16).toString('hex')
    return new Promise((resolve, reject) => {
      const readBody = (req: IncomingMessage): Promise<any> =>
        new Promise((ok, bad) => {
          let data = ''
          req.on('data', (c) => { data += c; if (data.length > 20_000) req.destroy() })
          req.on('end', () => { try { ok(JSON.parse(data || '{}')) } catch (e) { bad(e) } })
        })

      const server = createServer(async (req, res) => {
        const url = new URL(req.url ?? '/', 'http://127.0.0.1')
        // Every route carries the one time secret, so no other local page can drive this.
        if (url.searchParams.get('s') !== secret) { res.writeHead(403).end(); return }
        const json = (code: number, body: unknown): void => {
          res.writeHead(code, { 'Content-Type': 'application/json' }).end(JSON.stringify(body))
        }
        try {
          if (req.method === 'GET' && url.pathname === '/') {
            res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }).end(walletPage(secret))
          } else if (req.method === 'POST' && url.pathname === '/nonce') {
            json(200, await requestJson(`${API_BASE}/api/auth/wallet/nonce`, { method: 'POST', body: {} }))
          } else if (req.method === 'POST' && url.pathname === '/verify') {
            const body = await readBody(req)
            const verified = await requestJson<{ token_hash: string }>(`${API_BASE}/api/auth/wallet/verify`, {
              method: 'POST',
              body: { address: body.address, message: body.message, signature: body.signature, nonce_token: body.nonce_token }
            })
            const session = await gotrue<Session>('/verify', { type: 'magiclink', token_hash: verified.token_hash })
            const result = await finish(session)
            json(200, { ok: true })
            done(); resolve(result)
          } else {
            res.writeHead(404).end()
          }
        } catch (err) {
          json(400, { ok: false, error: err instanceof HttpError ? safeDetail(err.body) : (err as Error).message })
        }
      })

      const timer = setTimeout(() => { done(); reject(new Error('Wallet sign in timed out after five minutes')) }, 5 * 60_000)
      const done = (): void => { clearTimeout(timer); server.close() }

      server.listen(0, '127.0.0.1', () => {
        const { port } = server.address() as AddressInfo
        void shell.openExternal(`http://127.0.0.1:${port}/?s=${secret}`)
      })
    })
  },

  async signOut(): Promise<void> {
    await vault.remove('lazyedge.apiKey')
    await vault.remove('lazyedge.session')
  }
}

function safeDetail(body: string): string {
  try { return String(JSON.parse(body).detail ?? body).slice(0, 300) } catch { return body.slice(0, 300) }
}

function walletPage(secret: string): string {
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Lazy Edge sign in</title>
<style>
:root{--bg:#0d0f12;--fg:#e8eaed;--muted:#9aa0a6;--accent:#f5b800}
body{margin:0;min-height:100vh;display:grid;place-items:center;background:var(--bg);color:var(--fg);font:16px/1.5 system-ui,sans-serif}
main{max-width:420px;padding:32px;text-align:center}
button{background:var(--accent);color:#111;border:0;border-radius:8px;padding:12px 20px;font-weight:600;font-size:16px;cursor:pointer}
p{color:var(--muted)} #msg{margin-top:20px;min-height:24px}
</style></head><body><main>
<h1>Sign in to Lazy Edge Desktop</h1>
<p>Your wallet signs a one time message. Nothing is sent from your wallet and no transaction is made.</p>
<button id="go">Connect wallet</button><div id="msg"></div>
</main><script>
const s=${JSON.stringify(secret)};const msg=document.getElementById('msg');
const post=(p,b)=>fetch(p+'?s='+s,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(b||{})}).then(r=>r.json());
document.getElementById('go').onclick=async()=>{
  try{
    if(!window.ethereum){msg.textContent='No wallet found in this browser. Open this page in the browser where your wallet is installed.';return}
    const [address]=await window.ethereum.request({method:'eth_requestAccounts'});
    const n=await post('/nonce');
    const message='lazyedge.net wants you to sign in with your Ethereum account:\\n'+address+'\\n\\nSign in to Lazy Edge Desktop.\\n\\nNonce: '+n.nonce+'\\nIssued At: '+new Date().toISOString();
    const signature=await window.ethereum.request({method:'personal_sign',params:[message,address]});
    msg.textContent='Verifying...';
    const r=await post('/verify',{address,message,signature,nonce_token:n.nonce_token});
    msg.textContent=r.ok?'Signed in. You can close this tab and return to the app.':(r.error||'Sign in failed');
  }catch(e){msg.textContent=e.message||String(e)}
};
</script></body></html>`
}
