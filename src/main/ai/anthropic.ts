// Claude through the official SDK, pinned at 0.133.0 (the 1.x line was three
// days old when this was written). Default model Claude Opus 5.5 with
// adaptive thinking; depth maps to effort. Server side refusal fallbacks are
// on, so a declined request is re-run on a fallback model inside the call
// rather than leaving a bot with no answer.
import Anthropic from '@anthropic-ai/sdk'
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod'
import { betaZodTool } from '@anthropic-ai/sdk/helpers/beta/zod'
import { vault } from '../store/vault'
import type { AiProvider, JsonRequest, ToolRequest } from './types'

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

  // The desk's questions with data tools, through the SDK's tool runner: it
  // runs each tool the model asks for, sends the result back with the
  // model's turn appended whole (thinking blocks included), and stops when
  // the model answers or the turn cap is reached. Tools run here, locally.
  async askWithTools(req: ToolRequest): Promise<string> {
    const tools = req.tools.map((t) => betaZodTool({
      name: t.name,
      description: t.description,
      inputSchema: t.input,
      run: async (input) => {
        try {
          // Capped, so one large feed cannot fill the conversation.
          return JSON.stringify(await t.run(input)).slice(0, 24_000)
        } catch (err) {
          return JSON.stringify({ error: (err as Error).message.slice(0, 300) })
        }
      }
    }))
    const final = await this.client().beta.messages.toolRunner({
      model: req.model || DEFAULT_MODEL,
      max_tokens: 16000,
      betas: ['server-side-fallback-2026-07-01'],
      fallbacks: 'default',
      thinking: { type: 'adaptive' },
      output_config: { effort: 'medium' },
      system: req.system,
      tools,
      max_iterations: req.maxTurns,
      messages: [{ role: 'user', content: req.user }]
    } as any)
    if (final.stop_reason === 'refusal') throw new Error('The model declined this question')
    const text = final.content.flatMap((b: any) => (b.type === 'text' ? [b.text] : [])).join('').trim()
    if (final.stop_reason === 'tool_use' || !text) throw new Error('The model used every data lookup it was allowed before answering. Ask a narrower question.')
    if (final.stop_reason === 'max_tokens') return `${text}\n\n(The answer was cut off.)`
    return text
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
