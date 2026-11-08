// fetch with a timeout and honest 429 handling. Errors carry the status and a
// short body so the ledger can say why a call failed rather than that it did.
export class HttpError extends Error {
  constructor(readonly status: number, readonly body: string, readonly url: string) {
    super(`HTTP ${status} from ${new URL(url).host}: ${body.slice(0, 200)}`)
  }
}

export interface RequestOptions {
  method?: string
  headers?: Record<string, string>
  body?: unknown
  timeoutMs?: number
  retries?: number
}

export async function requestJson<T = unknown>(url: string, opts: RequestOptions = {}): Promise<T> {
  const { method = 'GET', headers = {}, body, timeoutMs = 15_000, retries = 2 } = opts
  let lastError: unknown
  for (let attempt = 0; attempt <= retries; attempt++) {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    try {
      const res = await fetch(url, {
        method,
        headers: { Accept: 'application/json', ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...headers },
        body: body === undefined ? undefined : JSON.stringify(body),
        // A redirect would carry signed headers to another host. No venue or
        // API this app talks to redirects, so one is an error.
        redirect: 'error',
        signal: controller.signal
      })
      if (res.status === 429 && attempt < retries) {
        const wait = Number(res.headers.get('Retry-After')) || 2 ** attempt
        await new Promise((r) => setTimeout(r, wait * 1000))
        continue
      }
      const text = await res.text()
      if (!res.ok) throw new HttpError(res.status, text, url)
      return (text ? JSON.parse(text) : {}) as T
    } catch (err) {
      lastError = err
      // Never retry a request the server answered; only network failures.
      // A retried POST could place an order twice, so writes are not retried.
      if (err instanceof HttpError || method !== 'GET' || attempt === retries) throw err
      await new Promise((r) => setTimeout(r, 500 * 2 ** attempt))
    } finally {
      clearTimeout(timer)
    }
  }
  throw lastError
}
