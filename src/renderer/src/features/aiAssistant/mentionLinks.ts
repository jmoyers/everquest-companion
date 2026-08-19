import type { AiMentions } from '@shared/aiChat'

export type MentionKind = 'item' | 'spell' | 'mob'

const HREF: Record<MentionKind, string> = {
  item: 'eq-item',
  spell: 'eq-spell',
  mob: 'eq-mob'
}

export function parseMentionHref(href: string | undefined): { kind: MentionKind; name: string } | null {
  if (!href) return null
  for (const kind of ['item', 'spell', 'mob'] as const) {
    const prefix = `${HREF[kind]}:`
    if (href.startsWith(prefix)) {
      return { kind, name: decodeURIComponent(href.slice(prefix.length)) }
    }
  }
  return null
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function entries(mentions: AiMentions): { name: string; kind: MentionKind }[] {
  const out: { name: string; kind: MentionKind }[] = []
  for (const name of mentions.items) out.push({ name, kind: 'item' })
  for (const name of mentions.mobs) out.push({ name, kind: 'mob' })
  for (const name of mentions.spells) out.push({ name, kind: 'spell' })
  out.sort((a, b) => b.name.length - a.name.length)
  return out
}

/** Wrap mention names as markdown links the bubble's `a` renderer understands. */
export function linkMentions(text: string, mentions: AiMentions | undefined): string {
  if (!mentions) return text
  const seen = new Set<string>()
  let out = text
  for (const { name, kind } of entries(mentions)) {
    const key = name.toLowerCase()
    if (!name || seen.has(key)) continue
    seen.add(key)
    const re = new RegExp(`(?<!\\[)${escapeRegExp(name)}(?!\\]\\()`, 'g')
    out = out.replace(re, `[${name}](${HREF[kind]}:${encodeURIComponent(name)})`)
  }
  return out
}
