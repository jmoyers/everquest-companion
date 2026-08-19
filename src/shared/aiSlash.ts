// Slash commands the AI chat understands. Overlay ghost-complete reads this list.

export const AI_SLASH_COMMANDS = ['/help', '/model', '/usage'] as const

/** False this PR: zone tips are parked until they name what a player needs. */
export const AI_PROACTIVE_SHIPPED = false

export const AI_PROACTIVE_PARKED =
  'Proactive tips are not in this version. Next pass they will name key drops and named enemies, not a catalog list.'

export type AiChatPhase = 'idle' | 'sent' | 'awaiting' | 'error'

export const AI_CHAT_LOCKED_PLACEHOLDER = 'Chat is locked while awaiting reply.'
export const AI_CHAT_AWAITING_COLOR = '#e0a94a'
export const AI_CHAT_ERROR_COLOR = '#e88'

export function aiChatPhaseLabel(phase: AiChatPhase): string {
  if (phase === 'sent') return 'Sent'
  if (phase === 'awaiting') return 'Awaiting reply'
  if (phase === 'error') return 'Error'
  return ''
}

export function aiChatPhaseColor(phase: AiChatPhase): string | null {
  if (phase === 'awaiting') return AI_CHAT_AWAITING_COLOR
  if (phase === 'error') return AI_CHAT_ERROR_COLOR
  return null
}

export function aiChatComposerPlaceholder(locked: boolean, idle: string): string {
  return locked ? AI_CHAT_LOCKED_PLACEHOLDER : idle
}

/** Longest matching command that still has leftover text to ghost. */
export function slashGhost(input: string): string | null {
  if (!input.startsWith('/') || input.includes('\n')) return null
  let best: string | null = null
  for (const cmd of AI_SLASH_COMMANDS) {
    if (cmd === input) continue
    if (!cmd.startsWith(input)) continue
    if (best === null || cmd.length < best.length) best = cmd
  }
  return best
}

export function slashFill(input: string): string | null {
  const ghost = slashGhost(input)
  return ghost ?? null
}

export function aiHelpText(): string {
  return [
    'Commands:',
    '/help - this list',
    '/model - which model is selected',
    '/usage - OpenRouter spend on this key',
    '',
    'Ask in plain English about items, spells, this fight, this zone, buffs, or loot.',
    'Type /outputfile inventory in EverQuest if bags are missing, not here.'
  ].join('\n')
}
