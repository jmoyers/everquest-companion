// useChatHistory — the chat module's append-only snapshot, as one hook. The loot precedent
// (useLootHistory.ts): a delta carries `appended`, the snapshot is a concat, forever.

import type { ChatDelta, ChatLine, ChatSnap } from '@shared/types'
import { useModule } from '../../lib/useModule'

const applyChatDelta = (s: ChatSnap, d: ChatDelta): ChatSnap => [...s, ...d.appended]

/** Stable empty array: a new `[]` each render would re-run every `useMemo` keyed on the history. */
const NO_CHAT: ChatLine[] = []

/** Every chat line this character has, oldest first. Empty until the snapshot lands. */
export function useChatHistory(): ChatLine[] {
  return useModule<ChatSnap, ChatDelta>('chat', applyChatDelta) ?? NO_CHAT
}
