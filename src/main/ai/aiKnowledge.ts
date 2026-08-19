// Local-only knowledge for AI tools. Electron-free: unit tests import this
// without the wiki fallbacks in itemLookup / mobLookup.

import { filterSpells, tokenizeSpellQuery } from '../../shared/spellSearch'
import type { ItemDbFile } from '../itemsDb'
import { buildItemDbIndex, itemKey, knowledgeFromDb } from '../itemsDb'
import itemsJson from '../data/items.json'
import { loadSpellDb, searchTextFor } from '../data/spellDb'
import { spellEffectClasses } from '../data/spellEffectClass'
import { parseSpellClassLevels } from '../../shared/spellLines'
import type { ClassAbbr } from '../../shared/classCombo'
import type { SpellEntry } from '../../shared/types'
import { localMobEntry } from '../mobLookupLocal'
import type { MobData, MobEntry } from '../../shared/mobTypes'
import mobsJson from '../../renderer/src/data/eqlegends/mobs.json'

export const AI_HIT_CAP = 8
const DROP_CAP = 12
const QUEST_CAP = 8

export interface CompactItem {
  name: string
  page?: string
  lore: boolean
  quest: boolean
  eraTag?: string
  summary?: string
  statsBlock?: string
  dropsFrom: { mob: string; zone?: string }[]
  questUses: string[]
}

export interface CompactSpell {
  name: string
  spellType?: string
  durationText?: string
  targetType?: string
  mana?: number
  classes?: string
  effects?: string[]
  effectClasses: string[]
  classLevels: { cls: string; level: number }[]
}

export interface CompactMob {
  name: string
  page: string
  level?: string
  zones?: string[]
  drops: string[]
}

const itemFile = itemsJson as unknown as ItemDbFile
const itemIndex = buildItemDbIndex(itemFile)
const itemRows: CompactItem[] = uniqueBy(
  [...itemIndex.values()].map((e) => compactItem(knowledgeFromDb(e))),
  (r) => r.page ?? r.name
)

const mobFile = mobsJson as unknown as MobData
const mobRows: CompactMob[] = (mobFile.mobs ?? []).map(compactMob)

type SearchableEntry = SpellEntry & {
  searchText: string
  classLevels: { cls: ClassAbbr; level: number }[]
}
let spellRowsCache: SearchableEntry[] | null = null

function spellRows(): SearchableEntry[] {
  if (spellRowsCache) return spellRowsCache
  spellRowsCache = loadSpellDb().spells.map((s) => ({
    ...s,
    searchText: searchTextFor(s, undefined),
    classLevels: parseSpellClassLevels(s.classes)
  }))
  return spellRowsCache
}

function uniqueBy<T>(rows: T[], keyOf: (row: T) => string): T[] {
  const seen = new Set<string>()
  const out: T[] = []
  for (const row of rows) {
    const key = keyOf(row).toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    out.push(row)
  }
  return out
}

function compactItem(k: ReturnType<typeof knowledgeFromDb>): CompactItem {
  return {
    name: k.name,
    page: k.page,
    lore: k.lore,
    quest: k.quest,
    eraTag: k.eraTag,
    summary: k.summary?.slice(0, 400),
    statsBlock: k.statsBlock?.slice(0, 600),
    dropsFrom: (k.dropsFrom ?? []).slice(0, DROP_CAP).map((d) => ({ mob: d.mob, zone: d.zone })),
    questUses: (k.questUses ?? []).slice(0, QUEST_CAP).map((q) => q.quest)
  }
}

function compactMob(e: MobEntry): CompactMob {
  return {
    name: e.name,
    page: e.page,
    level: e.level,
    zones: e.zones,
    drops: (e.drops ?? []).slice(0, DROP_CAP)
  }
}

function compactSpell(s: SpellEntry): CompactSpell {
  return {
    name: s.name,
    spellType: s.spellType,
    durationText: s.durationText,
    targetType: s.targetType,
    mana: s.mana,
    classes: s.classes,
    effects: s.effects?.slice(0, 12),
    effectClasses: spellEffectClasses(s),
    classLevels: parseSpellClassLevels(s.classes)
  }
}

function rankNameHits<T extends { name: string }>(query: string, rows: T[]): T[] {
  const q = query.trim().toLowerCase()
  if (!q) return []
  const scored: { row: T; rank: number }[] = []
  for (const row of rows) {
    const name = row.name.toLowerCase()
    if (name === q) scored.push({ row, rank: 0 })
    else if (name.startsWith(q)) scored.push({ row, rank: 1 })
    else if (name.includes(q)) scored.push({ row, rank: 2 })
  }
  scored.sort((a, b) => a.rank - b.rank || a.row.name.localeCompare(b.row.name))
  return scored.slice(0, AI_HIT_CAP).map((s) => s.row)
}

/** Exact itemKey first, then name substring. Empty query is no hits. */
export function searchItems(query: string): CompactItem[] {
  const q = query.trim()
  if (!q) return []
  const exact = itemIndex.get(itemKey(q))
  if (exact) return [compactItem(knowledgeFromDb(exact))]
  return rankNameHits(q, itemRows)
}

/** Uses the alert-wizard spell matcher (class:/level:/bare text). */
export function searchSpells(query: string): CompactSpell[] {
  const q = query.trim()
  if (!q) return []
  const hits = filterSpells(spellRows(), tokenizeSpellQuery(q))
  const exact = hits.filter((s) => s.name.toLowerCase() === q.toLowerCase())
  const rest = hits.filter((s) => s.name.toLowerCase() !== q.toLowerCase())
  return [...exact, ...rest].slice(0, AI_HIT_CAP).map(compactSpell)
}

/** Exact catalog key first, then name substring. */
export function searchMobs(query: string): CompactMob[] {
  const q = query.trim()
  if (!q) return []
  const exact = localMobEntry(q)
  if (exact) return [compactMob(exact)]
  return rankNameHits(q, mobRows)
}

/** Spells each class newly can use in (fromLevel, toLevel]. Empty classes is no rows. */
export function spellsGained(
  classes: readonly string[],
  fromLevel: number,
  toLevel: number
): { cls: string; names: string[] }[] {
  if (classes.length === 0 || toLevel <= fromLevel) return []
  const rows = spellRows()
  const out: { cls: string; names: string[] }[] = []
  for (const cls of classes) {
    const want = cls.toLowerCase()
    const names: string[] = []
    for (const s of rows) {
      const hit = s.classLevels.some((c) => c.cls.toLowerCase() === want && c.level > fromLevel && c.level <= toLevel)
      if (!hit) continue
      names.push(s.name)
      if (names.length >= 4) break
    }
    if (names.length > 0) out.push({ cls, names })
  }
  return out
}

/** Mobs whose catalog zones name this zone. Empty zone is no hits. */
export function mobsInZone(zone: string): CompactMob[] {
  const q = zone.trim().toLowerCase()
  if (!q) return []
  const hits: CompactMob[] = []
  for (const row of mobRows) {
    if (!(row.zones ?? []).some((z) => z.toLowerCase().includes(q))) continue
    hits.push(row)
    if (hits.length >= AI_HIT_CAP) break
  }
  return hits
}
