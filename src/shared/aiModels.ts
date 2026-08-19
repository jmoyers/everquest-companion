// The OpenRouter slugs the settings picker may store. Unknown stored values
// degrade to the default so a hand-edited store cannot send a dead model name.

export type AiModelTier = 'free' | 'good' | 'better' | 'best'

export interface AiModelOption {
  id: string
  label: string
  tier: AiModelTier
}

export const AI_DEFAULT_MODEL = 'deepseek/deepseek-chat'

/** Two per tier. Free slugs are pinned; we do not live-fetch OpenRouter's catalog. */
export const AI_MODEL_OPTIONS: readonly AiModelOption[] = [
  { id: 'nvidia/nemotron-3.5-lightning:free', label: '[Free] Nemotron 3.5 Lightning', tier: 'free' },
  { id: 'openai/gpt-oss-20b:free', label: '[Free] GPT OSS 20B', tier: 'free' },
  { id: 'deepseek/deepseek-chat', label: '[Good] DeepSeek Chat', tier: 'good' },
  { id: 'deepseek/deepseek-v4-flash-0731', label: '[Good] DeepSeek V4 Flash', tier: 'good' },
  { id: 'google/gemini-3.7-flash', label: '[Better] Gemini 3.7 Flash', tier: 'better' },
  { id: 'google/gemini-3.6-flash', label: '[Better] Gemini 3.6 Flash', tier: 'better' },
  { id: 'anthropic/claude-sonnet-4.6', label: '[Best] Claude Sonnet 4.6', tier: 'best' },
  { id: 'x-ai/grok-4.6', label: '[Best] Grok 4.6', tier: 'best' }
]

const ALLOWED = new Set(AI_MODEL_OPTIONS.map((m) => m.id))

export function resolveAiModel(stored: string | undefined): string {
  if (stored && ALLOWED.has(stored)) return stored
  return AI_DEFAULT_MODEL
}

/** Picker labels keep a [Good] prefix; the chat bar does not. */
export function aiModelBarLabel(id: string): string {
  const opt = AI_MODEL_OPTIONS.find((m) => m.id === id)
  const label = opt?.label ?? id
  return label.replace(/^\[[^\]]+\]\s*/, '')
}

/** Spend for the static chat bar. Unknown is a normal dash, never an em dash. */
export function formatAiSpend(usd: number | null): string {
  if (usd == null || !Number.isFinite(usd)) return '-'
  return `$${usd.toFixed(3)}`
}

export function parseOpenRouterSpend(json: unknown): number | null {
  if (!json || typeof json !== 'object') return null
  const data = (json as { data?: { usage?: unknown } }).data
  const usage = data?.usage
  return typeof usage === 'number' && Number.isFinite(usage) ? usage : null
}
