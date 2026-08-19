import { toolHintName, type AiPromptResult, type AiStreamChunk } from '../../../../shared/aiChat'
import type { ChatMessage } from './chatTypes'

function lastIndex(messages: readonly ChatMessage[], pred: (m: ChatMessage) => boolean): number {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (pred(messages[i])) return i
  }
  return -1
}

function lastPendingAi(messages: readonly ChatMessage[]): number {
  return lastIndex(messages, (m) => m.role === 'ai' && m.pending === true)
}

function replaceAt(messages: ChatMessage[], idx: number, next: ChatMessage): ChatMessage[] {
  const out = messages.slice()
  out[idx] = next
  return out
}

export { toolHintName as toolWord }

function chunkMatches(chunk: AiStreamChunk, requestId: string | null): boolean {
  if (!requestId || !chunk.requestId) return true
  return chunk.requestId === requestId
}

function applyLiveChunk(cur: ChatMessage, chunk: AiStreamChunk): ChatMessage | null {
  if (chunk.kind === 'token' && chunk.text) {
    return { ...cur, text: cur.text + chunk.text, toolHint: undefined }
  }
  if (chunk.kind === 'tool') return { ...cur, toolHint: toolHintName(chunk.tool) }
  return null
}

function applyFinishChunk(cur: ChatMessage, chunk: AiStreamChunk): ChatMessage | null {
  if (chunk.kind === 'done') {
    return {
      ...cur,
      pending: false,
      toolHint: undefined,
      text: chunk.text ?? cur.text,
      drafts: chunk.drafts ?? cur.drafts,
      mentions: chunk.mentions ?? cur.mentions
    }
  }
  if (chunk.kind === 'error') {
    const text = chunk.error ? `Error: ${chunk.error}` : cur.text || 'Error: request failed'
    return { ...cur, pending: false, toolHint: undefined, text }
  }
  return null
}

export function applyStreamChunk(
  messages: ChatMessage[],
  chunk: AiStreamChunk,
  requestId: string | null
): ChatMessage[] {
  if (!chunkMatches(chunk, requestId)) return messages
  const idx = lastPendingAi(messages)
  if (idx < 0) return messages
  const cur = messages[idx]
  const next = applyLiveChunk(cur, chunk) ?? applyFinishChunk(cur, chunk)
  return next ? replaceAt(messages, idx, next) : messages
}

export function finishAi(messages: ChatMessage[], result: AiPromptResult): ChatMessage[] {
  const pending = lastPendingAi(messages)
  const idx = pending >= 0 ? pending : lastIndex(messages, (m) => m.role === 'ai')
  if (idx < 0) {
    return [...messages, { role: 'ai', text: result.text, drafts: result.drafts, mentions: result.mentions }]
  }
  const cur = messages[idx]
  return replaceAt(messages, idx, {
    ...cur,
    pending: false,
    toolHint: undefined,
    text: result.text || cur.text,
    drafts: result.drafts.length > 0 ? result.drafts : cur.drafts,
    mentions: result.mentions ?? cur.mentions
  })
}

export function dropDraft(messages: ChatMessage[], msgIndex: number, draftId: string): ChatMessage[] {
  const cur = messages[msgIndex]
  if (!cur?.drafts) return messages
  const drafts = cur.drafts.filter((d) => d.id !== draftId)
  return replaceAt(messages, msgIndex, { ...cur, drafts: drafts.length > 0 ? drafts : undefined })
}

export function failPendingAi(messages: ChatMessage[], message: string): ChatMessage[] {
  const idx = lastPendingAi(messages)
  if (idx < 0) return messages
  return replaceAt(messages, idx, {
    ...messages[idx],
    pending: false,
    toolHint: undefined,
    text: `Error: ${message}`
  })
}
