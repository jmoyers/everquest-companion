import { OpenRouterClient } from './OpenRouterClient'

export function getOpenRouterClient(credential: string): OpenRouterClient {
  if (!credential) throw new Error('OpenRouter API key is missing.')
  return new OpenRouterClient(credential)
}
