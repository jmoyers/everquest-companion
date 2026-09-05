import { useEffect, useState } from 'react'
import { AI_CHAT_CHANGED, AI_CHAT_STORAGE_KEY, parseAiChat, serializeAiChat } from '@shared/aiChat'
import type { ChatMessage } from './chatTypes'

function persistable(messages: readonly ChatMessage[]): ChatMessage[] {
  return messages.filter((m) => m.text.length > 0 || (m.drafts !== undefined && m.drafts.length > 0))
}

/** Hydrate from localStorage (JOS-90) and share the thread with other windows. */
export function useAiChat(): [ChatMessage[], (fn: (prev: ChatMessage[]) => ChatMessage[]) => void] {
  const [messages, setMessages] = useState<ChatMessage[]>(() =>
    parseAiChat(localStorage.getItem(AI_CHAT_STORAGE_KEY))
  )

  useEffect(() => {
    localStorage.setItem(AI_CHAT_STORAGE_KEY, serializeAiChat(persistable(messages)))
  }, [messages])

  useEffect(() => {
    const onStorage = (e: StorageEvent): void => {
      if (e.key !== AI_CHAT_STORAGE_KEY) return
      setMessages(parseAiChat(e.newValue))
    }
    const onLocal = (): void => {
      setMessages(parseAiChat(localStorage.getItem(AI_CHAT_STORAGE_KEY)))
    }
    window.addEventListener('storage', onStorage)
    window.addEventListener(AI_CHAT_CHANGED, onLocal)
    return () => {
      window.removeEventListener('storage', onStorage)
      window.removeEventListener(AI_CHAT_CHANGED, onLocal)
    }
  }, [])

  return [messages, setMessages]
}
