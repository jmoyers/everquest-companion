// planner/gearIndex.ts — the committed item corpus → the GEAR PLANNER's candidate index
// (JOS-283, phase 2; the row model and its design rule live in src/shared/planner/gear.ts).
//
// One row per EQUIPPABLE item — 6,884 of the corpus's 11,213 pages state a `Slot:`, plus the three
// the curated layer repairs (JOS-67) — carrying slots, classes, races, era, flags, effects, the
// weapon block and the NUMERIC BASE VECTOR the whole feature sorts and filters on.
//
// PURE and ELECTRON-FREE, exactly like `effectIndex.ts` beside it: value imports are RELATIVE,
// nothing here reads a file, the corpus is handed IN by the IPC handler (which already inlines it
// for itemLookup, so main pays for the 8.6 MB once), and `tests/gearIndex.test.mts` runs THIS
// builder over the REAL committed bytes.
//
// IT RE-STATES NOTHING. Slots, classes, sockets, extraction tiers, the haste lock, the focus family
// and the effect one-liner join are all the same calls the donor index makes — `slotsOf` and
// `COMMITTED_SPELL_FACTS` are exported from effectIndex.ts for exactly this reader. The dedupe is
// the donor index's too: a page contributes at most one row, `|itemname` alias keys are skipped by
// PAGE identity (196 of them), and where two pages describe one item the ITEM'S OWN PAGE wins.
//
// AND SINCE JOS-333 IT ALSO CARRIES LAYER 3 (`eraDerive.ts`, beside this file): the one stated
// acquisition edge that points at out-of-era content, computed ONCE for the whole file before the
// row walk and attached to the rows that have one (`eraDerived`). It is a BUILD-TIME answer on
// purpose — the walk crosses the corpus's recipe and quest graph, and the renderer's job is to read
// a field, not to re-derive it per row per keystroke. The build census counts it like every other
// reading (`eraDerivedRows`), so a rescrape that changes the shape of the answer is visible.
//
// WHAT IT ADDS is the reading of NUMBERS, and there the honesty rule is the census rather than the
// row: `statInteger` (shared/characterSheet.ts) is the parser, a `%` value is admitted for the one
// key that states one, and every value or key the vector does not take is COUNTED BY KEY in
// `GearBuildStats` — so a rescrape that spells a stat a new way turns the suite red instead of
// quietly dropping a column out of the gear table (law 1).

import { itemKey, type ItemDbEntry, type ItemDbFile } from '../itemsDb'
import { renamedItems } from '../../shared/itemRenames'
import {
  ITEMS_RESEARCH,
  knowledgeWithResearch,
  type ItemResearchFile,
  type ResearchedKnowledge
} from '../itemsResearch'
import { COMMITTED_SPELL_FACTS, slotsOf, type SpellFactsIndex } from './effectIndex'
import { buildEraDerivations } from './eraDerive'
import {
  isHasteEffect,
  normalizeClasses,
  normalizeSlotTokens,
  parseFocusEffect,
  socketTypeOf
} from '../../shared/planner/normalize'
import { extractionTier } from '../../shared/planner/rules'
import { statInteger } from '../../shared/characterSheet'
import { normalizeStatKey, synthesizesVoidSave } from '../../shared/itemUpgrade'
import type { EraDerivation } from '../../shared/planner/era'
import {
  GEAR_INDEX_VERSION,
  isGearStatKey,
  type GearBuildStats,
  type GearEffect,
  type GearIndexPayload,
  type GearRow,
  type GearStats
} from '../../shared/planner/gear'
import type { ItemEffect, ItemStat, ItemStatBlock } from '../../shared/itemStats'
import type { ItemUpgradeState } from '../../shared/itemUpgrade'

/** Tier 1 — any upgraded state answers the SV VOID question identically (phase 0: it reads `full > 0`). */
const ANY_UPGRADED: ItemUpgradeState = { full: 1, fraction: 0 }

/** What a page with no stats block at all states: nothing. One committed page needs it. */
const EMPTY_BLOCK: ItemStatBlock = {
  flags: [],
  stats: [],
  saves: [],
  effects: [],
  exaltationSlots: [],
  extras: []
}

// ---- reading a number out of the corpus ---------------------------------------------------

/**
 * A stat value → a number for the vector, or null when it states none.
 *
 * `statInteger` is the parser (the character sheet's, and the ticket's): `+9` and a bare `10` are
 * integers and a trailing `%` disqualifies the value. THE ONE WIDENING is a whole-value percent —
 * `HASTE: +41%`, 64 pages, and the build census pins that HASTE is the only key it ever fires for.
 * A percent is refused where it would be SUMMED (`characterSheet.ts` says why: a percentage inside
 * an integer total is a lie), and that is not what this is: a gear row is ONE item, so "sort by
 * haste" compares 41% with 36% and adds nothing to anything.
 *
 * Everything else — "Unlimited" charges, "15 and faction at Kindly" — is null, counted, and absent
 * from the vector, because absent means "the item stated no number" and 0 would mean it stated one.
 */
export function gearStatNumber(value: string): number | null {
  const n = statInteger(value)
  if (n !== null) return n
  const m = /^([+-]?\d+)\s*%$/.exec(value.trim())
  return m ? Number.parseInt(m[1], 10) : null
}

/**
 * `WT:` text → a number. The corpus writes "2.5", and on 197 container pages it writes
 * "0.1 Weight Reduction: 20%" (an unkeyed continuation the parser leaves on the value).
 *
 * LEADING-NUMBER, deliberately, because that is exactly what phase 0's `scaleWeightText` reads
 * before it scales — a stricter parse here would put a weight in the vector that the scaler
 * disagrees with, which is the one thing the equivalence test would catch and the wrong way to
 * learn it. Two pages state "?" and land as null.
 */
export function gearWeightNumber(text: string): number | null {
  const m = /-?\d+(?:\.\d+)?/.exec(text)
  return m ? Number(m[0]) : null
}

// ---- the stat block → the vector --------------------------------------------------------------

/**
 * ONE stat block, read into numbers — and everything the reading could not take, counted.
 *
 * Exported (and pure) because it is the half of the build the equivalence test drives directly:
 * `tests/gearIndex.test.mts` proves that scaling the VECTOR agrees with `scaleStatBlock` on the
 * BLOCK for every equippable item, and it can only do that honestly if it reads the block with
 * this exact function rather than a second copy of it.
 */
export interface GearStatReading {
  stats: GearStats
  /** `Range:` verbatim when it was not a single number */
  rangeText?: string
  /** values read by `statInteger` */
  integers: number
  /** values read as a whole-value percent */
  percents: number
  /** normalized keys the vector does not index, by key */
  unindexed: Record<string, number>
  /** indexed keys whose value no parse could read, by key */
  unreadable: Record<string, number>
}

const bump = (m: Record<string, number>, key: string): void => {
  m[key] = (m[key] ?? 0) + 1
}

/** The `KEY: value` rows (attributes and saves alike) folded into the vector. */
function foldStatRows(rows: readonly ItemStat[], out: GearStatReading): void {
  for (const row of rows) {
    const key = normalizeStatKey(row.key)
    if (!isGearStatKey(key)) {
      bump(out.unindexed, key)
      continue
    }
    const n = gearStatNumber(row.value)
    if (n === null) {
      bump(out.unreadable, key)
      continue
    }
    if (statInteger(row.value) === null) out.percents++
    else out.integers++
    // Last stated wins. No committed page states one indexed key twice today; if one ever does,
    // the duplicate is the page's own text and the later line is the one the window would draw.
    out.stats[key] = n
  }
}

/**
 * The block's structural numbers — the fields `parseStatsBlock` keys into their own slots rather
 * than into `stats[]`. `Range:` is the one that can refuse: 30 arrow pages state a triple
 * ("50 / 75 / 100"), which is not one number and is kept VERBATIM on the row instead of being
 * silently reduced to its first third.
 */
function foldStructural(block: ItemStatBlock, out: GearStatReading): void {
  const s = out.stats
  if (block.ac !== undefined) s.AC = block.ac
  if (block.dmg !== undefined) s.DMG = block.dmg
  if (block.atkDelay !== undefined) s.DELAY = block.atkDelay
  if (block.dmgBonus !== undefined) s.DMG_BONUS = block.dmgBonus
  if (block.backstab !== undefined) s.BACKSTAB = block.backstab
  if (block.weight !== undefined) {
    const w = gearWeightNumber(block.weight)
    if (w === null) bump(out.unreadable, 'WEIGHT')
    else s.WEIGHT = w
  }
  if (block.range === undefined) return
  const range = statInteger(block.range)
  if (range === null) out.rangeText = block.range
  else s.RANGE = range
}

export function readGearStats(block: ItemStatBlock): GearStatReading {
  const out: GearStatReading = { stats: {}, integers: 0, percents: 0, unindexed: {}, unreadable: {} }
  foldStatRows([...block.stats, ...block.saves], out)
  foldStructural(block, out)
  return out
}

// ---- the build ------------------------------------------------------------------------------

interface Acc {
  seenPages: Set<string>
  rows: Map<string, GearRow>
  fromCanonical: Set<string>
  unknownSlots: Set<string>
  unindexed: Map<string, number>
  unreadable: Map<string, number>
  /** LAYER 3, built once for the whole file before the walk (`eraDerive.ts`) — itemKey → the edge */
  derived: ReadonlyMap<string, EraDerivation>
  stats: Omit<GearBuildStats, 'unindexedStatKeys' | 'unreadableStatKeys' | 'unknownSlotTokens'>
}

function newAcc(derived: ReadonlyMap<string, EraDerivation>): Acc {
  return {
    seenPages: new Set(),
    rows: new Map(),
    fromCanonical: new Set(),
    unknownSlots: new Set(),
    unindexed: new Map(),
    unreadable: new Map(),
    derived,
    stats: {
      pages: 0,
      aliasKeys: 0,
      slotless: 0,
      duplicatePages: 0,
      weaponRows: 0,
      effectRows: 0,
      spellJoined: 0,
      socketless: 0,
      voidSynthRows: 0,
      eraDerivedRows: 0,
      statValues: 0,
      percentValues: 0,
      rangeTexts: 0
    }
  }
}

/** One item's reading, folded into the build census. */
function foldReading(acc: Acc, read: GearStatReading): void {
  acc.stats.statValues += read.integers
  acc.stats.percentValues += read.percents
  if (read.rangeText !== undefined) acc.stats.rangeTexts++
  for (const [key, n] of Object.entries(read.unindexed)) {
    acc.unindexed.set(key, (acc.unindexed.get(key) ?? 0) + n)
  }
  for (const [key, n] of Object.entries(read.unreadable)) {
    acc.unreadable.set(key, (acc.unreadable.get(key) ?? 0) + n)
  }
}

/** One effect line, read exactly as the donor index reads it (see `GearEffect`). */
function gearEffect(effect: ItemEffect, spells: SpellFactsIndex, acc: Acc): GearEffect {
  const socket = socketTypeOf(effect.kind)
  const rank = socket === 'focus' ? parseFocusEffect(effect.name) : null
  const facts = spells.get(effect.name.trim().toLowerCase()) ?? {}
  if (Object.keys(facts).length > 0) acc.stats.spellJoined++
  if (socket === null) acc.stats.socketless++
  // Absent fields are OMITTED rather than set to `undefined`, here and on the row: the payload
  // crosses IPC, where a structured clone keeps an explicit `undefined` and a JSON round trip
  // does not. One shape on both sides of the wire, and absent stays the only spelling of unknown.
  return {
    ...facts,
    name: effect.name,
    ...(effect.detail === undefined ? {} : { detail: effect.detail }),
    ...(effect.reqLevel === undefined ? {} : { reqLevel: effect.reqLevel }),
    kind: effect.kind,
    ...(socket === null ? {} : { socket, tierRequired: extractionTier(socket) }),
    ...(isHasteEffect(effect.name, effect.detail) ? { hasteLocked: true as const } : {}),
    ...(rank === null ? {} : { family: rank.family, familyTier: rank.tier })
  }
}

/** Race tokens, upper-cased and de-punctuated; nothing else is claimed (see `GearRow.races`). */
function normalizeRaces(races: readonly string[] | undefined): string[] {
  const out: string[] = []
  for (const raw of races ?? []) {
    const token = raw.trim().replace(/[,.;:]+$/, '').toUpperCase()
    if (token !== '' && !out.includes(token)) out.push(token)
  }
  return out
}

/**
 * The fields a row states only when the corpus stated them.
 *
 * Kept apart from the row literal because "absent means absent" costs a conditional per field,
 * and thirteen of those in one function is a complexity score rather than a thought.
 */
function optionalFields(
  k: ResearchedKnowledge,
  read: GearStatReading | null,
  voidSynth: boolean,
  derived: EraDerivation | undefined
): Partial<GearRow> {
  return {
    ...(k.iconId === undefined ? {} : { iconId: k.iconId }),
    ...(k.eraTag === undefined ? {} : { eraTag: k.eraTag }),
    ...(derived === undefined ? {} : { eraDerived: derived }),
    ...(k.stats?.skill === undefined ? {} : { skill: k.stats.skill }),
    ...(read?.rangeText === undefined ? {} : { rangeText: read.rangeText }),
    ...(voidSynth ? { voidSynth: true as const } : {}),
    // Copied per row (donors do the same) so a consumer never needs a second index to answer
    // "where does this drop".
    ...(k.dropsFrom === undefined ? {} : { wikiSources: k.dropsFrom.map((s) => ({ ...s })) })
  }
}

/**
 * What one KEPT row contributes to the census — run in a final pass over the deduped rows, never
 * as each row is built.
 *
 * IT USED TO RUN AT BUILD TIME AND THAT WAS QUIETLY WRONG (found by JOS-341's sweep). A duplicate
 * page's row is counted the moment it is built and then thrown away by `remember`, so every one of
 * these numbers over-reported by however many duplicates happened to have the property. It read as
 * exact for `eraDerivedRows` only because no duplicated page carried a derivation until layer 3
 * grew the dropper edge; then eighteen did, and `stats.eraDerivedRows` and the rows themselves
 * disagreed. The stats are documented as counts of ROWS, so they are taken from the rows.
 */
function countRow(acc: Acc, row: GearRow): void {
  if (row.stats.DMG !== undefined || row.stats.DELAY !== undefined) acc.stats.weaponRows++
  if (row.effects.length > 0) acc.stats.effectRows++
  if (row.voidSynth === true) acc.stats.voidSynthRows++
  if (row.eraDerived !== undefined) acc.stats.eraDerivedRows++
}

/** One page → its row, or null when the corpus places the item in no slot at all. */
function pageRow(
  entry: ItemDbEntry,
  research: ItemResearchFile,
  spells: SpellFactsIndex,
  acc: Acc
): GearRow | null {
  const k = knowledgeWithResearch(entry, research)
  // One committed page states no stats block at all. Defaulting it here rather than threading an
  // optional through every field below is the difference between a row builder and a chain of
  // question marks — and an empty block reads as exactly what it is: an item that states nothing.
  const block: ItemStatBlock = k.stats ?? EMPTY_BLOCK
  const slot = normalizeSlotTokens(block.slot)
  for (const token of slot.unknown) acc.unknownSlots.add(token)
  const slots = slotsOf(k, slot.slots)
  if (slots.length === 0) return null

  const read = readGearStats(block)
  foldReading(acc, read)
  // LAYER 3 is keyed by the PAGE's canonical key (`eraDerive.ts` walks pages, not alias keys), while
  // the row's key comes from the item NAME. They differ on the 196 `|itemname` alias pages, and the
  // page is the thing the derivation walked, so the page is what it is looked up by.
  const row: GearRow = {
    key: itemKey(k.name),
    name: k.name,
    searchKey: k.name.toLowerCase(),
    slots,
    classes: normalizeClasses(block.classes),
    races: normalizeRaces(block.races),
    flags: [...block.flags],
    quest: k.quest,
    playerCrafted: k.playerCrafted === true,
    stats: read.stats,
    effects: block.effects.map((e) => gearEffect(e, spells, acc)),
    ...optionalFields(k, read, synthesizesVoidSave(block, ANY_UPGRADED), acc.derived.get(itemKey(entry.page)))
  }
  return row
}

/**
 * Keep at most one row per item key. A later page wins ONLY when it is the item's OWN page and the
 * row already held is not — the donor index's dedupe 2, for the same six duplicated item names.
 */
function remember(acc: Acc, entry: ItemDbEntry, row: GearRow): void {
  const canonical = itemKey(entry.page) === row.key
  if (acc.rows.has(row.key)) {
    acc.stats.duplicatePages++
    if (!canonical || acc.fromCanonical.has(row.key)) return
  }
  acc.rows.set(row.key, row)
  if (canonical) acc.fromCanonical.add(row.key)
}

function addPage(acc: Acc, entry: ItemDbEntry, research: ItemResearchFile, spells: SpellFactsIndex): void {
  if (acc.seenPages.has(entry.page)) {
    acc.stats.aliasKeys++
    return
  }
  acc.seenPages.add(entry.page)
  acc.stats.pages++
  const row = pageRow(entry, research, spells, acc)
  if (row === null) {
    acc.stats.slotless++
    return
  }
  remember(acc, entry, row)
}

/**
 * The committed file → the served payload. The curated layer and the spell join default to the
 * committed ones and are injectable so a test can drive either from a fixture.
 */
export function buildGearIndex(
  file: ItemDbFile,
  research: ItemResearchFile = ITEMS_RESEARCH,
  spells: SpellFactsIndex = COMMITTED_SPELL_FACTS
): GearIndexPayload {
  const acc = newAcc(buildEraDerivations(file))
  // Through the rename overlay (JOS-415) — same reasoning as `buildPlannerIndex`: a gear row is a
  // DISPLAYED name, and `addPage`'s page dedupe already absorbs the alias key.
  for (const entry of Object.values(renamedItems(file.items ?? {}))) addPage(acc, entry, research, spells)
  // The census is taken from the KEPT rows, after dedupe (see `countRow`).
  for (const row of acc.rows.values()) countRow(acc, row)
  return {
    version: GEAR_INDEX_VERSION,
    scrapedAt: file.scrapedAt,
    rows: [...acc.rows.values()],
    stats: {
      ...acc.stats,
      unindexedStatKeys: Object.fromEntries([...acc.unindexed].sort((a, b) => b[1] - a[1])),
      unreadableStatKeys: Object.fromEntries([...acc.unreadable].sort((a, b) => b[1] - a[1])),
      unknownSlotTokens: [...acc.unknownSlots]
    }
  }
}
