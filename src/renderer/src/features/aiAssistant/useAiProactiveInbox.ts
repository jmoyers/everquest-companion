import { useEffect } from 'react'
import { AI_CHAT_CHANGED, AI_CHAT_STORAGE_KEY, appendAiChatTip } from '@shared/aiChat'

/** Always-mounted: tips must land even when the AI tab is unmounted (JOS-90). */
export function useAiProactiveInbox(): void {
  useEffect(() => {
    const on = window.eq.onAiProactive
    if (!on) return
    return on((text) => {
      localStorage.setItem(AI_CHAT_STORAGE_KEY, appendAiChatTip(localStorage.getItem(AI_CHAT_STORAGE_KEY), text))
      window.dispatchEvent(new Event(AI_CHAT_CHANGED))
    })
  }, [])
}
