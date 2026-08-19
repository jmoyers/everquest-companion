// Electron-free AI helpers: harvest mentions from tool JSON, and shape
// the live-status fields getLiveStatus assembles from module snapshots.

import type { AiDumpStatus, AiLiveStatus, AiMentions } from '../../shared/aiChat'
import type { OutputKindId } from '../../shared/outputs/kinds'

const MENTIONS_CAP = 12

const TOOL_BUCKET: Record<string, keyof AiMentions> = {
  search_items: 'items',
  search_spells: 'spells',
  search_mobs: 'mobs'
}

export function emptyMentions(): AiMentions {
  return { items: [], spells: [], mobs: [] }
}

export function mentionsFromToolResult(toolName: string, json: string): AiMentions {
  const out = emptyMentions()
  const bucket = TOOL_BUCKET[toolName]
  if (!bucket) return out
  out[bucket] = uniqueCap(namesFromHits(json), MENTIONS_CAP)
  return out
}

export function mergeMentions(a: AiMentions, b: AiMentions): AiMentions {
  return {
    items: uniqueCap([...a.items, ...b.items], MENTIONS_CAP),
    spells: uniqueCap([...a.spells, ...b.spells], MENTIONS_CAP),
    mobs: uniqueCap([...a.mobs, ...b.mobs], MENTIONS_CAP)
  }
}

export function loadoutLiveFromSummary(raw: Record<string, unknown>): AiLiveStatus['loadout'] {
  return {
    ready: raw.ready === true,
    classes: stringList(raw.classes),
    inferred: raw.inferred === true,
    uncertain: raw.uncertain === true
  }
}

export function epochMsFromIso(iso: string | null | undefined): number | null {
  if (!iso) return null
  const ms = Date.parse(iso)
  return Number.isFinite(ms) ? ms : null
}

export function dumpLiveFrom(
  kind: OutputKindId,
  command: string,
  text: string,
  updatedAtIso: string | null
): AiDumpStatus {
  return {
    kind,
    command,
    empty: text === '[EMPTY]' || text.length === 0,
    updatedAt: epochMsFromIso(updatedAtIso)
  }
}

function namesFromHits(json: string): string[] {
  try {
    const v: unknown = JSON.parse(json)
    if (!v || typeof v !== 'object') return []
    const hits = (v as { hits?: unknown }).hits
    if (!Array.isArray(hits)) return []
    return hitNames(hits)
  } catch {
    return []
  }
}

function hitNames(hits: unknown[]): string[] {
  const names: string[] = []
  for (const hit of hits) {
    if (!hit || typeof hit !== 'object') continue
    const name = (hit as { name?: unknown }).name
    if (typeof name === 'string' && name.length > 0) names.push(name)
  }
  return names
}

function uniqueCap(names: readonly string[], cap: number): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const name of names) {
    const key = name.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    out.push(name)
    if (out.length >= cap) break
  }
  return out
}

function stringList(v: unknown): string[] {
  if (!Array.isArray(v)) return []
  return v.filter((x): x is string => typeof x === 'string')
}

export function takeSseLines(buffer: string): { lines: string[]; rest: string } {
  const parts = buffer.split('\n')
  const rest = parts.pop() ?? ''
  return { lines: parts, rest }
}

export function tokenFromSseLine(line: string): string | null {
  const trimmed = line.trim()
  if (!trimmed.startsWith('data:')) return null
  const data = trimmed.slice(5).trim()
  if (data === '' || data === '[DONE]') return null
  return deltaContent(parseJson(data))
}

function parseJson(raw: string): unknown {
  try {
    return JSON.parse(raw) as unknown
  } catch {
    return null
  }
}

function deltaContent(json: unknown): string | null {
  if (!json || typeof json !== 'object') return null
  const rec = json as { choices?: { delta?: { content?: unknown } }[] }
  const content = rec.choices?.[0]?.delta?.content
  return typeof content === 'string' && content.length > 0 ? content : null
}
