import type { ProviderId } from '@shared/schema'
import { AnthropicProvider } from './anthropic'
import { OllamaProvider, openai, xai } from './compatible'
import type { AiProvider } from './types'

const providers: Record<ProviderId, AiProvider> = {
  anthropic: new AnthropicProvider(),
  openai: openai(),
  xai: xai(),
  ollama: new OllamaProvider()
}

export const ai = (id: ProviderId): AiProvider => providers[id]
export const allProviders = (): AiProvider[] => Object.values(providers)
