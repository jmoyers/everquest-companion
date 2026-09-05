// Shared AI chat payload types. Preload and renderer import these so the send
// prompt IPC cannot drift on history or draft-alert shape.

import type { AlertDef } from './alertTypes'
import type { OutputKindId } from './outputs/kinds'

/** One-word live hint. Never a generic "looking it up." */
const TOOL_HINT: Record<string, string> = {
  search_items: 'items',
  search_spells: 'spells',
  search_mobs: 'mobs',
  get_loadout: 'loadout',
  get_aa: 'aa',
  get_output: 'output',
  draft_alert: 'alert'
}

export function toolHintName(tool: string | undefined): string {
  if (!tool) return ''
  const mapped = TOOL_HINT[tool]
  if (mapped) return mapped
  const trimmed = tool.replace(/^(search_|get_)/, '')
  const word = trimmed.split(/[_-]/)[0]
  return word || trimmed
}

export interface AiChatTurn {
  role: 'user' | 'assistant'
  text: string
}

export interface AiPromptResult {
  text: string
  drafts: AlertDef[]
  mentions?: AiMentions
}

export interface AiMentions {
  items: string[]
  spells: string[]
  mobs: string[]
}

export interface AiConfigPayload {
  apiKey: string
  consent: boolean
  model?: string
  personalStyle?: string
  proactive?: boolean
}

export interface AiDumpStatus {
  kind: OutputKindId
  command: string
  empty: boolean
  updatedAt: number | null
}

export interface AiLiveStatus {
  zone: string | null
  loadout: {
    ready: boolean
    classes: string[]
    inferred: boolean
    uncertain: boolean
  }
  dumps: AiDumpStatus[]
  recap: string[]
}

export interface AiStreamChunk {
  requestId: string
  kind: 'token' | 'tool' | 'done' | 'error'
  text?: string
  tool?: string
  drafts?: AlertDef[]
  mentions?: AiMentions
  error?: string
}

export interface AiStoredMessage {
  role: 'user' | 'ai'
  text: string
  drafts?: AlertDef[]
  mentions?: AiMentions
}

export interface AiFollowUp {
  id: string
  label: string
  prompt: string
}

/** OpenRouter key spend + the picker label, for the chat footer bar. */
export interface AiUsageSnap {
  spendUsd: number | null
  modelLabel: string
}

/** Last N turns sent with a follow-up. Four exchanges is enough for tool context. */
export const AI_HISTORY_CAP = 8

/** localStorage key. Main window and overlay share one origin, so one thread. */
export const AI_CHAT_STORAGE_KEY = 'eq.ai.messages'

/** Same-window ping after a proactive tip is written to localStorage. */
export const AI_CHAT_CHANGED = 'eq-ai-chat'

/** Persist a bounded tail so a long night does not grow forever. */
export const AI_CHAT_PERSIST_CAP = 40

function stringList(v: unknown): string[] {
  if (!Array.isArray(v)) return []
  return v.filter((x): x is string => typeof x === 'string' && x.length > 0)
}

function parseStoredMentions(raw: unknown): AiMentions | undefined {
  if (!raw || typeof raw !== 'object') return undefined
  const rec = raw as { items?: unknown; spells?: unknown; mobs?: unknown }
  const items = stringList(rec.items)
  const spells = stringList(rec.spells)
  const mobs = stringList(rec.mobs)
  if (items.length === 0 && spells.length === 0 && mobs.length === 0) return undefined
  return { items, spells, mobs }
}

function parseStoredDraft(raw: unknown): AlertDef | null {
  if (!raw || typeof raw !== 'object') return null
  const rec = raw as Partial<AlertDef>
  if (typeof rec.id !== 'string' || typeof rec.name !== 'string') return null
  if (!rec.trigger || typeof rec.trigger !== 'object') return null
  if (!rec.sound || typeof rec.sound !== 'object') return null
  return rec as AlertDef
}

function parseStoredDrafts(raw: unknown): AlertDef[] | undefined {
  if (!Array.isArray(raw)) return undefined
  const drafts = raw.map(parseStoredDraft).filter((d): d is AlertDef => d !== null)
  return drafts.length > 0 ? drafts : undefined
}

function parseStoredRow(row: unknown): AiStoredMessage | null {
  if (!row || typeof row !== 'object') return null
  const rec = row as { role?: unknown; text?: unknown; drafts?: unknown; mentions?: unknown }
  if (rec.role !== 'user' && rec.role !== 'ai') return null
  if (typeof rec.text !== 'string') return null
  const msg: AiStoredMessage = { role: rec.role, text: rec.text }
  const drafts = parseStoredDrafts(rec.drafts)
  const mentions = parseStoredMentions(rec.mentions)
  if (drafts) msg.drafts = drafts
  if (mentions) msg.mentions = mentions
  return msg
}

export function parseAiChat(raw: string | null): AiStoredMessage[] {
  if (!raw) return []
  try {
    const v: unknown = JSON.parse(raw)
    if (!Array.isArray(v)) return []
    const out: AiStoredMessage[] = []
    for (const row of v) {
      const msg = parseStoredRow(row)
      if (msg) out.push(msg)
    }
    return out.slice(-AI_CHAT_PERSIST_CAP)
  } catch {
    return []
  }
}

function storedRow(m: AiStoredMessage): AiStoredMessage {
  const row: AiStoredMessage = { role: m.role, text: m.text }
  if (m.drafts && m.drafts.length > 0) row.drafts = m.drafts
  if (m.mentions) row.mentions = m.mentions
  return row
}

export function serializeAiChat(messages: readonly AiStoredMessage[]): string {
  const tail = messages.slice(-AI_CHAT_PERSIST_CAP).map(storedRow)
  return JSON.stringify(tail)
}

/** Append one assistant line. Same last text is a no-op (overlay + tab both hear the IPC). */
export function appendAiChatTip(raw: string | null, text: string): string {
  const prev = parseAiChat(raw)
  const last = prev[prev.length - 1]
  if (last?.role === 'ai' && last.text === text) return serializeAiChat(prev)
  return serializeAiChat([...prev, { role: 'ai', text }])
}
