// One interface, four providers (decision 10). The model's whole job is to
// fill a schema; every answer is validated before anything reads it, and an
// invalid answer is treated as no answer.
import type { z } from 'zod'
import type { ProviderId } from '@shared/schema'

export interface JsonRequest<T> {
  system: string
  user: string
  schema: z.ZodType<T>
  schemaName: string
  model?: string
  // How hard this call is. Strategy drafting is careful work; screening a
  // handful of already approved tickets during a live game is quick work.
  depth: 'quick' | 'careful'
}

// A read only tool the model may call while it answers (2026-11-21: "a data
// source that can come back and forth"). The app runs it locally, so keys
// never leave this computer; the model sees only what run returns.
export interface AiTool {
  name: string
  description: string
  input: z.ZodObject<z.ZodRawShape>
  run: (input: any) => Promise<unknown>
}

export interface ToolRequest {
  system: string
  user: string
  tools: AiTool[]
  // The most model turns before it must answer with what it has.
  maxTurns: number
  model?: string
}

export interface AiProvider {
  readonly id: ProviderId
  configured(): boolean
  json<T>(req: JsonRequest<T>): Promise<T>
  // A plain text answer that may call tools first. Providers without it
  // answer from the context they are given.
  askWithTools?(req: ToolRequest): Promise<string>
  models(): Promise<string[]>
  test(): Promise<{ ok: boolean; detail: string }>
}

// JSON Schema for strict structured output: every object closed, every key
// required. Optional fields are expressed as nullable rather than absent.
export function strictJsonSchema(schema: Record<string, any>): Record<string, any> {
  const walk = (node: any): any => {
    if (!node || typeof node !== 'object') return node
    if (Array.isArray(node)) return node.map(walk)
    const out: Record<string, any> = {}
    for (const [k, v] of Object.entries(node)) if (k !== '$schema') out[k] = walk(v)
    if (out.type === 'object' && out.properties) {
      out.additionalProperties = false
      out.required = Object.keys(out.properties)
    }
    return out
  }
  return walk(schema)
}
