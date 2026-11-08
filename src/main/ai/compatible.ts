// OpenAI, xAI and a local Ollama model. OpenAI and xAI share the chat
// completions shape with strict json_schema output; Ollama's native chat API
// takes the schema as `format`. No model name is guessed: the keys screen
// lists what each account actually serves and the user picks.
import { z } from 'zod'
import type { ProviderId } from '@shared/schema'
import { requestJson } from '../data/http'
import { vault, type SecretName } from '../store/vault'
import { strictJsonSchema, type AiProvider, type JsonRequest } from './types'

interface Spec {
  id: Exclude<ProviderId, 'anthropic' | 'ollama'>
  base: string
  secret: SecretName
  // Prefer models whose id contains this, when the user has not chosen one.
  prefer: RegExp
}

export class CompatibleProvider implements AiProvider {
  readonly id: Spec['id']

  constructor(private readonly spec: Spec) {
    this.id = spec.id
  }

  configured(): boolean {
    return Boolean(vault.get(this.spec.secret))
  }

  private headers(): Record<string, string> {
    const key = vault.get(this.spec.secret)
    if (!key) throw new Error(`${this.spec.id} API key is not set`)
    return { Authorization: `Bearer ${key}` }
  }

  async models(): Promise<string[]> {
    const res = await requestJson<{ data?: { id: string }[] }>(`${this.spec.base}/models`, { headers: this.headers() })
    return (res.data ?? []).map((m) => m.id).sort()
  }

  private async pick(model?: string): Promise<string> {
    if (model) return model
    const all = await this.models()
    const preferred = all.filter((m) => this.spec.prefer.test(m))
    const chosen = preferred.at(-1) ?? all[0]
    if (!chosen) throw new Error(`${this.spec.id} returned no models; choose one on the keys screen`)
    return chosen
  }

  async json<T>(req: JsonRequest<T>): Promise<T> {
    const res = await requestJson<any>(`${this.spec.base}/chat/completions`, {
      method: 'POST',
      headers: this.headers(),
      timeoutMs: req.depth === 'careful' ? 120_000 : 30_000,
      body: {
        model: await this.pick(req.model),
        messages: [
          { role: 'system', content: req.system },
          { role: 'user', content: req.user }
        ],
        response_format: {
          type: 'json_schema',
          json_schema: { name: req.schemaName, strict: true, schema: strictJsonSchema(z.toJSONSchema(req.schema as any)) }
        }
      }
    })
    const choice = res.choices?.[0]
    if (choice?.finish_reason === 'length') throw new Error('The model ran out of room before finishing')
    if (choice?.message?.refusal) throw new Error(`The model declined: ${choice.message.refusal}`)
    return req.schema.parse(JSON.parse(choice?.message?.content ?? ''))
  }

  async test(): Promise<{ ok: boolean; detail: string }> {
    try {
      const models = await this.models()
      return { ok: true, detail: `Connected. ${models.length} models available.` }
    } catch (err) {
      return { ok: false, detail: (err as Error).message }
    }
  }
}

export const openai = (): CompatibleProvider =>
  new CompatibleProvider({ id: 'openai', base: 'https://api.openai.com/v1', secret: 'ai.openai', prefer: /^gpt-/ })

export const xai = (): CompatibleProvider =>
  new CompatibleProvider({ id: 'xai', base: 'https://api.x.ai/v1', secret: 'ai.xai', prefer: /^grok-/ })

export class OllamaProvider implements AiProvider {
  readonly id = 'ollama' as const

  private base(): string {
    return (vault.get('ai.ollamaUrl') ?? 'http://127.0.0.1:11434').replace(/\/$/, '')
  }

  // Ollama needs no key; it is configured once the user has saved its address.
  configured(): boolean {
    return Boolean(vault.get('ai.ollamaUrl'))
  }

  async models(): Promise<string[]> {
    const res = await requestJson<{ models?: { name: string }[] }>(`${this.base()}/api/tags`)
    return (res.models ?? []).map((m) => m.name)
  }

  async json<T>(req: JsonRequest<T>): Promise<T> {
    const model = req.model || (await this.models())[0]
    if (!model) throw new Error('Ollama has no models installed')
    const res = await requestJson<any>(`${this.base()}/api/chat`, {
      method: 'POST',
      timeoutMs: 180_000,
      body: {
        model,
        stream: false,
        format: strictJsonSchema(z.toJSONSchema(req.schema as any)),
        messages: [
          { role: 'system', content: req.system },
          { role: 'user', content: req.user }
        ]
      }
    })
    return req.schema.parse(JSON.parse(res.message?.content ?? ''))
  }

  async test(): Promise<{ ok: boolean; detail: string }> {
    try {
      const models = await this.models()
      return models.length
        ? { ok: true, detail: `Connected. Local models: ${models.slice(0, 5).join(', ')}.` }
        : { ok: false, detail: 'Ollama answered but has no models installed. Run ollama pull first.' }
    } catch (err) {
      return { ok: false, detail: `Could not reach Ollama at ${this.base()}: ${(err as Error).message}` }
    }
  }
}
