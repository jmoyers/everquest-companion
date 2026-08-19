import type { AlertDef } from '@shared/alertTypes'
import type { AiMentions } from '@shared/aiChat'

/** One bubble. Extra fields are renderer-only; persist keeps role + text. */
export interface ChatMessage {
  role: 'user' | 'ai'
  text: string
  drafts?: AlertDef[]
  mentions?: AiMentions
  pending?: boolean
  toolHint?: string
}
