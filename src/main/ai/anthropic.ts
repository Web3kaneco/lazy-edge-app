// Claude through the official SDK, pinned at 0.133.0 (the 1.x line was three
// days old when this was written). Default model Claude Opus 5.5 with
// adaptive thinking; depth maps to effort. Server side refusal fallbacks are
// on, so a declined request is re-run on a fallback model inside the call
// rather than leaving a bot with no answer.
import Anthropic from '@anthropic-ai/sdk'
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod'
import { vault } from '../store/vault'
import type { AiProvider, JsonRequest } from './types'

const DEFAULT_MODEL = 'claude-opus-5-5'

export class AnthropicProvider implements AiProvider {
  readonly id = 'anthropic' as const

  configured(): boolean {
    return Boolean(vault.get('ai.anthropic'))
  }

  private client(): Anthropic {
    const apiKey = vault.get('ai.anthropic')
    if (!apiKey) throw new Error('Anthropic API key is not set')
    return new Anthropic({ apiKey })
  }

  async json<T>(req: JsonRequest<T>): Promise<T> {
    const response = await this.client().beta.messages.create({
      model: req.model || DEFAULT_MODEL,
      max_tokens: 16000,
      betas: ['server-side-fallback-2026-07-01'],
      fallbacks: 'default',
      thinking: { type: 'adaptive' },
      output_config: {
        effort: req.depth === 'careful' ? 'high' : 'low',
        format: zodOutputFormat(req.schema as any)
      },
      system: req.system,
      messages: [{ role: 'user', content: req.user }]
    } as any)

    // A refusal from the whole fallback chain, or a truncated answer, is no
    // answer. Never read content before checking why the model stopped.
    if (response.stop_reason === 'refusal') throw new Error('The model declined this request')
    if (response.stop_reason === 'max_tokens') throw new Error('The model ran out of room before finishing')
    const text = response.content.flatMap((b: any) => (b.type === 'text' ? [b.text] : [])).join('')
    return req.schema.parse(JSON.parse(text))
  }

  async models(): Promise<string[]> {
    const ids: string[] = []
    for await (const m of this.client().models.list()) ids.push(m.id)
    return ids.length ? ids : [DEFAULT_MODEL]
  }

  async test(): Promise<{ ok: boolean; detail: string }> {
    try {
      const models = await this.models()
      return { ok: true, detail: `Connected. ${models.length} models available, default ${DEFAULT_MODEL}.` }
    } catch (err) {
      if (err instanceof Anthropic.AuthenticationError) return { ok: false, detail: 'Anthropic refused the key.' }
      return { ok: false, detail: (err as Error).message }
    }
  }
}
