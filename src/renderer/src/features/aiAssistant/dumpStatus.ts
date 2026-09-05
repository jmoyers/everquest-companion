import type { AiDumpStatus, AiFollowUp, AiLiveStatus } from '@shared/aiChat'
import type { OutputKindId } from '@shared/outputs/kinds'
import { formatAge } from '../../lib/formatDate'

export function dumpOf(status: AiLiveStatus, kind: OutputKindId): AiDumpStatus | undefined {
  return status.dumps.find((d) => d.kind === kind)
}

export function bagsLabel(status: AiLiveStatus, now: number): string | null {
  const d = dumpOf(status, 'inventory')
  if (!d) return null
  if (d.empty || d.updatedAt == null) return 'Bags not exported'
  return `Bags ${formatAge(d.updatedAt, now)}`
}

export function spellbookLabel(status: AiLiveStatus, now: number): string | null {
  const d = dumpOf(status, 'spellbook')
  if (!d) return null
  if (d.empty || d.updatedAt == null) return 'Spellbook not exported'
  return `Spellbook ${formatAge(d.updatedAt, now)}`
}

/** Bags / spellbook flipped from empty to present. First poll is not news. */
export function dumpNoticesFor(prev: AiLiveStatus | null, next: AiLiveStatus): string[] {
  if (!prev) return []
  const out: string[] = []
  for (const kind of ['inventory', 'spellbook'] as const) {
    const before = prev.dumps.find((d) => d.kind === kind)
    const after = next.dumps.find((d) => d.kind === kind)
    if (before?.empty === true && after && !after.empty) {
      out.push(kind === 'inventory' ? 'Bags updated' : 'Spellbook updated')
    }
  }
  return out
}

/** Chip only - never auto-send. Same last question, now with a dump. */
export function askAgainChips(notices: readonly string[], lastPrompt: string): AiFollowUp[] {
  const prompt = lastPrompt.trim()
  if (!prompt) return []
  const out: AiFollowUp[] = []
  if (notices.includes('Bags updated')) {
    out.push({ id: 'ask-bags', label: 'Ask again with bags', prompt })
  }
  if (notices.includes('Spellbook updated')) {
    out.push({ id: 'ask-book', label: 'Ask again with spellbook', prompt })
  }
  return out
}
