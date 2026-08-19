import { AI_DEFAULT_MODEL, parseOpenRouterSpend, resolveAiModel } from '../../shared/aiModels'
import type { AiChatTurn, AiMentions, AiPromptResult, AiStreamChunk } from '../../shared/aiChat'
import type { AlertDef } from '../../shared/alertTypes'
import { executeToolCall } from './AiTools'
import { AI_TOOLS } from './aiToolDefs'
import {
  emptyMentions,
  mentionsFromToolResult,
  mergeMentions,
  takeSseLines,
  tokenFromSseLine
} from './aiMentions'

const TOOL_ROUND_CAP = 4
const OPENROUTER_URL = 'https://openrouter.ai/api/v1/chat/completions'

type OnChunk = (c: Omit<AiStreamChunk, 'requestId'>) => void

export interface SendPromptOpts {
  model?: string
  history?: readonly AiChatTurn[]
  onChunk?: OnChunk
}

interface OrToolCall {
  id: string
  function: { name: string; arguments: string }
}

interface OrMessage {
  role: 'system' | 'user' | 'assistant' | 'tool'
  content?: string | null
  tool_calls?: OrToolCall[]
  tool_call_id?: string
}

interface OrChoiceMessage {
  content?: string | null
  tool_calls?: OrToolCall[]
}

interface ToolLoopState {
  drafts: AlertDef[]
  mentions: AiMentions
  onChunk?: OnChunk
}

function parseArgs(raw: string): Record<string, unknown> {
  try {
    const v: unknown = JSON.parse(raw)
    return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {}
  } catch {
    return {}
  }
}

function seedMessages(
  systemMessage: string,
  userMessage: string,
  history: readonly AiChatTurn[]
): OrMessage[] {
  const messages: OrMessage[] = [{ role: 'system', content: systemMessage }]
  for (const turn of history) {
    messages.push({ role: turn.role === 'assistant' ? 'assistant' : 'user', content: turn.text })
  }
  messages.push({ role: 'user', content: userMessage })
  return messages
}

function applyToolRound(
  messages: OrMessage[],
  calls: OrToolCall[],
  drafts: AlertDef[],
  mentions: AiMentions
): void {
  messages.push({ role: 'assistant', content: '', tool_calls: calls })
  for (const call of calls) {
    const result = executeToolCall(call.function.name, parseArgs(call.function.arguments))
    const draft = draftFromToolResult(result)
    if (draft) drafts.push(draft)
    absorbMentions(mentions, call.function.name, result)
    messages.push({ role: 'tool', tool_call_id: call.id, content: result })
  }
}

function absorbMentions(into: AiMentions, tool: string, json: string): void {
  const next = mergeMentions(into, mentionsFromToolResult(tool, json))
  into.items = next.items
  into.spells = next.spells
  into.mobs = next.mobs
}

function draftFromToolResult(raw: string): AlertDef | null {
  try {
    const v: unknown = JSON.parse(raw)
    if (!v || typeof v !== 'object') return null
    const rec = v as { status?: unknown; alert?: unknown }
    if (rec.status !== 'draft' || !rec.alert || typeof rec.alert !== 'object') return null
    const alert = rec.alert as AlertDef
    if (typeof alert.id !== 'string' || typeof alert.name !== 'string') return null
    return alert
  } catch {
    return null
  }
}

export async function readSseContent(
  body: ReadableStream<Uint8Array>,
  onToken: (text: string) => void
): Promise<string> {
  const reader = body.getReader()
  const dec = new TextDecoder()
  let rest = ''
  let out = ''
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    rest += dec.decode(value, { stream: true })
    const split = takeSseLines(rest)
    rest = split.rest
    const piece = emitSseTokens(split.lines, onToken)
    if (piece) out += piece
  }
  rest += dec.decode()
  const tail = tokenFromSseLine(rest)
  if (!tail) return out
  onToken(tail)
  return out + tail
}

function emitSseTokens(lines: readonly string[], onToken: (text: string) => void): string {
  let out = ''
  for (const line of lines) {
    const token = tokenFromSseLine(line)
    if (!token) continue
    out += token
    onToken(token)
  }
  return out
}

export class OpenRouterClient {
  constructor(private apiKey: string) {}

  async getUsageUsd(): Promise<number | null> {
    try {
      const response = await fetch('https://openrouter.ai/api/v1/auth/key', {
        method: 'GET',
        headers: { Authorization: `Bearer ${this.apiKey}` }
      })
      if (!response.ok) return null
      return parseOpenRouterSpend(await response.json())
    } catch {
      return null
    }
  }

  async getUsage(): Promise<string> {
    const usage = await this.getUsageUsd()
    if (usage == null) return 'Failed to fetch usage from OpenRouter.'
    return `**OpenRouter API Usage:** $${usage.toFixed(4)}`
  }

  async sendPrompt(
    systemMessage: string,
    userMessage: string,
    opts: SendPromptOpts = {}
  ): Promise<AiPromptResult> {
    const model = resolveAiModel(opts.model ?? AI_DEFAULT_MODEL)
    const messages = seedMessages(systemMessage, userMessage, opts.history ?? [])
    const drafts: AlertDef[] = []
    const mentions = emptyMentions()
    try {
      const text = await this.runToolLoop(model, messages, { drafts, mentions, onChunk: opts.onChunk })
      opts.onChunk?.({ kind: 'done', text, drafts, mentions })
      return { text, drafts, mentions }
    } catch (e) {
      const error = e instanceof Error ? e.message : String(e)
      opts.onChunk?.({ kind: 'error', error })
      throw e
    }
  }

  private async runToolLoop(model: string, messages: OrMessage[], state: ToolLoopState): Promise<string> {
    for (let round = 0; round < TOOL_ROUND_CAP; round++) {
      const text = await this.oneToolRound(model, messages, state)
      if (text !== null) return text
    }
    return await this.afterTools(model, messages, state.onChunk)
  }

  private async oneToolRound(
    model: string,
    messages: OrMessage[],
    state: ToolLoopState
  ): Promise<string | null> {
    const choice = (await this.complete(model, messages, true)).choices?.[0]?.message
    if (!choice) throw new Error('OpenRouter returned no message')
    const calls = choice.tool_calls ?? []
    if (calls.length === 0) {
      return await this.finalText(model, messages, choice.content ?? '', state.onChunk)
    }
    emitToolChunks(calls, state.onChunk)
    applyToolRound(messages, calls, state.drafts, state.mentions)
    return null
  }

  private async afterTools(model: string, messages: OrMessage[], onChunk?: OnChunk): Promise<string> {
    if (onChunk) return await this.streamComplete(model, messages, onChunk)
    const last = await this.complete(model, messages, false)
    return last.choices?.[0]?.message?.content ?? ''
  }

  private async finalText(
    model: string,
    messages: OrMessage[],
    peeked: string,
    onChunk?: OnChunk
  ): Promise<string> {
    if (!onChunk) return peeked
    return await this.streamComplete(model, messages, onChunk)
  }

  private headers(): Record<string, string> {
    return {
      Authorization: `Bearer ${this.apiKey}`,
      'Content-Type': 'application/json',
      'HTTP-Referer': 'https://github.com/jmoyers/everquest-companion',
      'X-Title': 'EverQuest Legends Companion'
    }
  }

  private async streamComplete(model: string, messages: OrMessage[], onChunk: OnChunk): Promise<string> {
    const response = await this.postChat({ model, messages, stream: true })
    if (!response.body) throw new Error('OpenRouter returned no stream')
    return readSseContent(response.body, (text) => onChunk({ kind: 'token', text }))
  }

  private async complete(
    model: string,
    messages: OrMessage[],
    withTools: boolean
  ): Promise<{ choices?: { message?: OrChoiceMessage }[] }> {
    const body: Record<string, unknown> = { model, messages }
    if (withTools) body.tools = AI_TOOLS
    const response = await this.postChat(body)
    return (await response.json()) as { choices?: { message?: OrChoiceMessage }[] }
  }

  private async postChat(body: Record<string, unknown>): Promise<Response> {
    const response = await fetch(OPENROUTER_URL, {
      method: 'POST',
      headers: this.headers(),
      body: JSON.stringify(body)
    })
    if (!response.ok) {
      throw new Error(openRouterFail(response.status))
    }
    return response
  }
}

function openRouterFail(status: number): string {
  if (status === 402) {
    return 'OpenRouter is out of credits. Pick a [Free] model in Preferences, or add credits.'
  }
  if (status === 429) {
    return 'OpenRouter rate-limited this model. Wait a bit, or pick another in Preferences.'
  }
  if (status === 404) {
    return 'That model is gone from OpenRouter. Pick another in Preferences.'
  }
  return `OpenRouter API error: ${String(status)}`
}

function emitToolChunks(calls: readonly OrToolCall[], onChunk?: OnChunk): void {
  if (!onChunk) return
  for (const call of calls) onChunk({ kind: 'tool', tool: call.function.name })
}
