import { useEffect, useRef, useState } from 'react'
import { AI_HISTORY_CAP, type AiChatTurn } from '@shared/aiChat'
import type { AiChatPhase } from '@shared/aiSlash'
import { eqOnAiChunk } from './aiEq'
import type { ChatMessage } from './chatTypes'
import { applyStreamChunk, failPendingAi, finishAi } from './streamApply'

function historyFrom(messages: ChatMessage[]): AiChatTurn[] {
  return messages
    .filter((m) => !m.pending && m.text.length > 0)
    .slice(-AI_HISTORY_CAP)
    .map((m) => ({ role: m.role === 'ai' ? 'assistant' : 'user', text: m.text }))
}

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

export function useAiSend(
  messages: ChatMessage[],
  setMessages: (fn: (prev: ChatMessage[]) => ChatMessage[]) => void
): { loading: boolean; send: (text: string) => void; phase: AiChatPhase } {
  const [loading, setLoading] = useState(false)
  const [phase, setPhase] = useState<AiChatPhase>('idle')
  const requestIdRef = useRef<string | null>(null)
  const messagesRef = useRef(messages)
  messagesRef.current = messages

  useEffect(() => {
    const off = eqOnAiChunk((chunk) => {
      if (!requestIdRef.current && chunk.requestId) requestIdRef.current = chunk.requestId
      setMessages((prev) => applyStreamChunk(prev, chunk, requestIdRef.current))
      if (chunk.kind === 'token') setPhase('idle')
      if (chunk.kind === 'error') {
        setLoading(false)
        setPhase('error')
      }
      if (chunk.kind === 'done') {
        setLoading(false)
        setPhase('idle')
      }
    })
    return () => {
      off?.()
    }
  }, [setMessages])

  const send = (text: string): void => {
    const prompt = text.trim()
    if (!prompt || loading) return
    const history = historyFrom(messagesRef.current)
    requestIdRef.current = null
    setMessages((prev) => [...prev, { role: 'user', text: prompt }, { role: 'ai', text: '', pending: true }])
    setLoading(true)
    setPhase('sent')
    queueMicrotask(() => {
      setPhase((p) => (p === 'sent' ? 'awaiting' : p))
    })
    void window.eq.sendAiPrompt(prompt, history).then(
      (result) => {
        setMessages((prev) => finishAi(prev, result))
        setLoading(false)
        setPhase('idle')
        requestIdRef.current = null
      },
      (err: unknown) => {
        setMessages((prev) => failPendingAi(prev, errText(err)))
        setLoading(false)
        setPhase('error')
        requestIdRef.current = null
      }
    )
  }

  return { loading, send, phase }
}
