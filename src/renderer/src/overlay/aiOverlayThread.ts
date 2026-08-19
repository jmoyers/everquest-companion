import { useEffect, useState } from 'react'
import {
  AI_CHAT_STORAGE_KEY,
  AI_HISTORY_CAP,
  parseAiChat,
  serializeAiChat,
  toolHintName,
  type AiChatTurn,
  type AiPromptResult,
  type AiStoredMessage,
  type AiStreamChunk
} from '@shared/aiChat'
import type { AiChatPhase } from '@shared/aiSlash'

export function lastAiAnswer(messages: readonly AiStoredMessage[]): string | undefined {
  for (let i = messages.length - 1; i >= 0; i--) {
    const row = messages[i]
    if (row?.role === 'ai') return row.text
  }
  return undefined
}

export function historyFrom(messages: readonly AiStoredMessage[]): AiChatTurn[] {
  return messages.slice(-AI_HISTORY_CAP).map((m) => ({
    role: m.role === 'ai' ? 'assistant' : 'user',
    text: m.text
  }))
}

export function foldAiChunk(prev: string, chunk: AiStreamChunk): string {
  if (chunk.kind === 'token' && chunk.text) return prev + chunk.text
  if (chunk.kind === 'error' && chunk.error) return chunk.error
  if (chunk.kind === 'done' && chunk.text) return chunk.text
  return prev
}

export function foldToolHint(prev: string | null, chunk: AiStreamChunk): string | null {
  if (chunk.kind === 'tool') return toolHintName(chunk.tool) || null
  if (chunk.kind === 'token' || chunk.kind === 'done' || chunk.kind === 'error') return null
  return prev
}

export function foldAiPhase(chunk: AiStreamChunk): AiChatPhase | null {
  if (chunk.kind === 'token' || chunk.kind === 'done') return 'idle'
  if (chunk.kind === 'error') return 'error'
  return null
}

export function nextDraft(prev: string, chunk: AiStreamChunk): string {
  const folded = foldAiChunk(prev, chunk)
  if (chunk.kind === 'done' && !chunk.text) return prev
  return folded
}

export function failText(err: unknown): string {
  return err instanceof Error && err.message ? err.message : String(err)
}

export function loadChat(): AiStoredMessage[] {
  try {
    return parseAiChat(localStorage.getItem(AI_CHAT_STORAGE_KEY))
  } catch {
    return []
  }
}

function saveChat(messages: readonly AiStoredMessage[]): void {
  try {
    localStorage.setItem(AI_CHAT_STORAGE_KEY, serializeAiChat(messages))
  } catch {
    // quota or disabled storage: keep the in-memory thread
  }
}

export function useSharedThread(): [AiStoredMessage[], (next: AiStoredMessage[]) => void] {
  const [messages, setMessages] = useState(loadChat)
  useEffect(() => {
    const onStorage = (ev: StorageEvent): void => {
      if (ev.key !== AI_CHAT_STORAGE_KEY) return
      setMessages(parseAiChat(ev.newValue))
    }
    window.addEventListener('storage', onStorage)
    return () => window.removeEventListener('storage', onStorage)
  }, [])
  const commit = (next: AiStoredMessage[]): void => {
    setMessages(next)
    saveChat(next)
  }
  return [messages, commit]
}

function aiRow(result: AiPromptResult): AiStoredMessage {
  const row: AiStoredMessage = { role: 'ai', text: result.text }
  if (result.drafts.length > 0) row.drafts = result.drafts
  if (result.mentions) row.mentions = result.mentions
  return row
}

export async function runSend(
  prompt: string,
  prior: readonly AiStoredMessage[],
  ctl: {
    commit: (next: AiStoredMessage[]) => void
    setDraft: (s: string | null) => void
    streamBase: { current: AiStoredMessage[] | null }
    onFail: () => void
  }
): Promise<void> {
  const withUser: AiStoredMessage[] = [...prior, { role: 'user', text: prompt }]
  ctl.streamBase.current = withUser
  ctl.commit(withUser)
  try {
    const result = await window.eqOverlay.sendAiPrompt(prompt, historyFrom(prior))
    ctl.commit([...withUser, aiRow(result)])
  } catch (err) {
    ctl.onFail()
    ctl.commit([...withUser, { role: 'ai', text: failText(err) }])
  } finally {
    ctl.streamBase.current = null
    ctl.setDraft(null)
  }
}
