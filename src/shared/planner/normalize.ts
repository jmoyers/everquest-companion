// planner/normalize.ts — the item corpus is DIRTY; this is the hand-authored table that cleans it.
//
// Law 12 (renames are knowledge, never fuzzy): every variant below was MEASURED off the committed
// corpus (src/main/data/items.json, 11,155 distinct pages, re-derived 2026-08-04) and is written
// out explicitly. A closest-match matcher would happily fold SECONDARY into SECONDAY's neighbours
// and invent slots nobody wrote; unknown tokens are RETURNED instead, so a rescrape that adds a
// token turns the test red rather than silently dropping items out of the planner.
//
// MEASURED SLOT INVENTORY (40 distinct tokens across every stats block that states a Slot:;
// re-measured 2026-08-22 — the Mistmoore-rework wiki wave added eight Title Case spellings,
// all absorbed by the case fold: Waist Wrist Feet Neck Arms Shoulders Fingers Ear):
//   canonical  PRIMARY 1706 · SECONDARY 1166 · CHEST 517 · HEAD 475 · NECK 445 · WRIST 445 ·
//              HANDS 378 · FEET 362 · LEGS 344 · ARMS 330 · RANGE 290 · WAIST 274 · FACE 272 ·
//              BACK 264 · SHOULDERS 255 · FINGER 217 · EAR 116 · AMMO 88
//   renames    SHOULDER 5 · FINGERS 4 · SECONDAY 3            (typos/plurals, hand-verified)
//   case       Chest 4 · Primary 3 · Secondary 3 · Ammo 2 · Head 2 · Range 1 · Back 1 · Face 1 ·
//              Hands 1                                        (law 2: fold case at the boundary)
//   noise      "BACK," 2 (trailing comma from "BACK, SHOULDER") · "/" 1 (from "PRIMARY / SECONDARY")
//   absent     CHARM — zero pages. See types.ts: the slot does not exist here.
//
// MEASURED CLASS INVENTORY (24 distinct tokens): the 16 ClassAbbr codes (+ `War`, the one
//   Title Case code the 2026-08-22 rescrape added — the case fold absorbs it), plus ALL 5509 /
//   All 1, NONE 204 / None 23, the prose marker `except` 757, and two level annotations
//   "(35)" "(48)" (one page: "Class: CLR (35) PAL (48)") which are dropped as noise.

import { CLASS_ABBRS, isClassAbbr, type ClassAbbr } from '../classCombo'
import type { ItemEffectKind } from '../itemStats'
import { EQUIP_SLOTS, type EquipSlot, type SocketType } from './types'

const SLOT_SET: ReadonlySet<string> = new Set<string>(EQUIP_SLOTS)

/** Hand-verified spelling variants → the canonical slot. Never widened by guesswork. */
const SLOT_RENAMES: Record<string, EquipSlot> = {
  SHOULDER: 'SHOULDERS',
  FINGERS: 'FINGER',
  SECONDAY: 'SECONDARY'
}

/** Punctuation the wiki leaves between slot names. Dropped SILENTLY — it is not an unknown slot. */
const SLOT_NOISE: ReadonlySet<string> = new Set(['/', '-', '&', 'OR', 'AND'])

/** Strip the trailing punctuation the wiki leaves on a token ("BACK," → "BACK") and fold case. */
function cleanToken(raw: string): string {
  return raw.trim().replace(/[,.;:]+$/, '').toUpperCase()
}

/**
 * The verbatim `Slot:` text → canonical equip slots. Space-joined multi-slot strings
 * ("RANGE PRIMARY SECONDARY", 67 pages) split into every slot they name.
 *
 * `unknown` carries any token the table does not know, VERBATIM — the caller surfaces it and the
 * test pins the inventory, so an unrecognized slot can never be quietly discarded (law 1).
 */
export function normalizeSlotTokens(slot?: string): { slots: EquipSlot[]; unknown: string[] } {
  const slots: EquipSlot[] = []
  const unknown: string[] = []
  for (const raw of (slot ?? '').split(/\s+/)) {
    const token = cleanToken(raw)
    if (token === '' || SLOT_NOISE.has(token)) continue
    const mapped = SLOT_RENAMES[token] ?? (SLOT_SET.has(token) ? (token as EquipSlot) : undefined)
    if (mapped === undefined) {
      if (!unknown.includes(raw)) unknown.push(raw)
      continue
    }
    if (!slots.includes(mapped)) slots.push(mapped)
  }
  return { slots, unknown }
}

interface ClassTokens {
  all: boolean
  none: boolean
  sawExcept: boolean
  listed: ClassAbbr[]
  excluded: ClassAbbr[]
}

/** One pass over the `Class:` tokens, sorting them into the four things the wiki can say. */
function readClassTokens(raw: string[]): ClassTokens {
  const out: ClassTokens = { all: false, none: false, sawExcept: false, listed: [], excluded: [] }
  for (const token of raw) {
    const t = cleanToken(token)
    if (t === 'EXCEPT') out.sawExcept = true
    else if (t === 'ALL') out.all = true
    else if (t === 'NONE') out.none = true
    else if (isClassAbbr(t)) {
      const bucket = out.sawExcept ? out.excluded : out.listed
      if (!bucket.includes(t)) bucket.push(t)
    }
    // Anything else — "(35)", "(48)" — is a level annotation, not a class. Dropped.
  }
  return out
}

/**
 * The `Class:` list → the classes that can actually use the item.
 *
 * `ALL` → all 16. `ALL except NEC WIZ MAG ENC` (455 pages) → the complement. `NONE` → `[]`.
 *
 * `[]` means UNKNOWN-or-nobody and the UI must say so rather than assume: nine pages write a bare
 * `Class: ALL except` with the exception list MISSING (Stein, Efreeti Dirk, Geologist's Hammer,
 * Goblin Shin Splinter, Kerran Fishingpole, Poorly Balanced Mace, Soulforge Hammer, Staff,
 * Stein (of Water) — verified 2026-08-04). Reading that as "the complement of nothing = all 16"
 * would invent a class list the page explicitly declined to state, so it returns `[]`.
 */
export function normalizeClasses(classes?: string[]): ClassAbbr[] {
  const t = readClassTokens(classes ?? [])
  if (t.none) return []
  if (t.sawExcept) {
    if (t.excluded.length === 0) return []
    const base = t.all ? CLASS_ABBRS : t.listed
    return base.filter((c) => !t.excluded.includes(c))
  }
  if (t.all) return [...CLASS_ABBRS]
  return t.listed
}

/**
 * Which exaltation socket an item-effect line belongs to.
 *
 * D2, re-measured 2026-08-04: `proc` is 0 and `combat` is 453 — the wiki spells procs
 * `Combat Effect:`, so a planner filtering on `kind === 'proc'` would show an empty Proc tab.
 * Both fold to 'proc'.
 *
 * `effect` (a bare `Effect:` line whose parenthetical named no socket — 51 rows: Flowing Thought,
 * Aegolism, Regeneration, …) returns null and is EXCLUDED from v1: the wiki did not say which
 * socket it occupies, and guessing one would put an unextractable effect on a farm list.
 */
const SOCKET_BY_KIND: Record<ItemEffectKind, SocketType | null> = {
  combat: 'proc',
  proc: 'proc',
  worn: 'worn',
  focus: 'focus',
  click: 'click',
  effect: null
}

export function socketTypeOf(kind: ItemEffectKind): SocketType | null {
  return SOCKET_BY_KIND[kind]
}

// ---- R3: the haste lock ---------------------------------------------------------
//
// "Haste cannot travel as an exaltation" (wiki FAQ). Which effects ARE haste is knowledge, not a
// substring test, so the set below is hand-authored from EVIDENCE and nothing else:
//
//   * spells.json wear-off family "Your speed returns to normal." — the shared remover for the
//     attack-haste line (AGENTS.md law 3). Its ten members: Aanya's Quickening, Alacrity,
//     Celerity, Flurry, Quickness, Swift Like The Wind, Swift Spirit, Wonderous Rapidity,
//     Blessing of the Grove. (Five of them appear as item effects today: click Flurry ×6,
//     click Alacrity ×3, worn Swift Spirit, worn Blessing of the Grove, click Swift Like the Wind.)
//   * "Speed of the Shissar" — wear-off "Your body slows.", one click item.
//   * effects literally named "Haste" (combat ×4, click ×2) and the "Brittle Haste I–IV" line
//     (combat ×4, detrimental: it hastes the TARGET and weakens it — still haste).
//
// DELIBERATELY NOT HASTE, though their names contain the word: the five spell-CAST-time focus
// families — Spell Haste, Affliction Haste, Summoning Haste, Enhancement Haste, Reanimation Haste
// (28 focus rows). Those shorten casting time, are a different mechanic from attack speed, and
// locking them would strip the Focus tab of a fifth of its inventory for no rule.
// "Augment Death" (4 click rows) is the NEC pet-haste candidate and is NOT locked: the spell DB
// records no wear-off for it, so there is no evidence to lock it on. Add it here if evidence turns up.

const HASTE_EFFECTS: ReadonlySet<string> = new Set([
  'haste',
  'brittle haste',
  "aanya's quickening",
  'alacrity',
  'celerity',
  'quickness',
  'flurry',
  'swift like the wind',
  'swift spirit',
  'wonderous rapidity',
  'blessing of the grove',
  'speed of the shissar'
])

/** The cast-time FOCUS families. Named explicitly so "contains haste" can never capture them. */
const HASTE_FOCUS_FAMILIES: ReadonlySet<string> = new Set([
  'spell haste',
  'affliction haste',
  'summoning haste',
  'enhancement haste',
  'reanimation haste'
])

/**
 * Effect names carry a Roman rank ("Brittle Haste IV"); the family is what the table keys on.
 *
 * DELIBERATELY LOOSER than V5's `parseFocusEffect` below, and for a different job: this one also
 * runs over DETAIL prose, where case is not the wiki's strong suit, and its only consumer is an
 * exact match against a closed hand-authored set — stripping too much can miss a lock, never
 * invent one. V5's parser feeds a GROUPING and must not invent families, so it is strict.
 */
function effectFamily(name: string): string {
  return name.trim().replace(/\s+[IVX]+$/i, '').trim().toLowerCase()
}

// ---- V5: the focus family and its tier ------------------------------------------
//
// THE RANK IN THE NAME IS THE ONLY MAGNITUDE SIGNAL THE CORPUS HAS. No percent, no level, no
// magnitude field exists on any focus row (measured) — "Improved Healing III" beats "Improved
// Healing I" because of those three characters and nothing else. So the name is split ONCE, at
// index build in main (law 2, boundary canonicalization), and every consumer above it sorts and
// groups on the parsed pair instead of re-reading the string.
//
// MEASURED over the committed corpus (2026-08-05, after W-A's V9 exclusion took the 24 summoned
// focus rows off the donor list): 119 focus rows, 53 distinct names → 29 families.
//   * 39 names carry a Roman rank I–III (Improved Healing III, Burning Affliction II, …).
//   * 5 carry an ARABIC one, and they are the bard instrument modifiers: Brass Resonance 14,
//     Percussion Resonance 11 / 14, String Resonance 11, Wind Resonance 10. The number is the
//     modifier's own scale, not a tier index — but it ranks its family exactly the way a Roman
//     numeral ranks its own, and the two spellings never meet inside one family (measured), so
//     they are read the same way and compared only within a family.
//   * 9 carry NO rank: the Minion/Servant of Air/Earth/Fire/Water/Hate pet families. Law 1 says
//     those are not tier 0 of some guessed family — an unranked name IS its own family, at tier 1.
//
// Only FOCUS rows are parsed. Roman ranks are all over the proc corpus too (System Shock V,
// Berserker Madness IV, Flowing Thought I), but "which is best" is a focus question — a proc's
// rank rides different resists, levels and procs-per-minute, and folding those into "best of
// family" would be the planner claiming a comparison the corpus never states.

/** A canonical Roman numeral, in the one spelling that is valid (no IIII, no VV). */
const ROMAN = /^M{0,3}(CM|CD|D?C{0,3})(XC|XL|L?X{0,3})(IX|IV|V?I{0,3})$/
const ROMAN_VALUE: Record<string, number> = { I: 1, V: 5, X: 10, L: 50, C: 100, D: 500, M: 1000 }

/** A canonical Roman token → its value; null for anything that is not one. */
function romanValue(token: string): number | null {
  if (token === '' || !ROMAN.test(token)) return null
  let total = 0
  let biggest = 0
  for (let i = token.length - 1; i >= 0; i--) {
    const v = ROMAN_VALUE[token[i]]
    total += v < biggest ? -v : v
    if (v > biggest) biggest = v
  }
  return total
}

/** A focus effect name, split into the family it belongs to and its rank within that family. */
export interface FocusRank {
  /** the name with its rank stripped — the name ITSELF when it carries none */
  family: string
  /** the rank the name states; 1 when it states none (law 1: unranked is not tier 0) */
  tier: number
}

/**
 * "Improved Healing III" → `{ family: 'Improved Healing', tier: 3 }`; "Minion of Air" →
 * `{ family: 'Minion of Air', tier: 1 }`; "Percussion Resonance 14" →
 * `{ family: 'Percussion Resonance', tier: 14 }`.
 *
 * The trailing token must be a CANONICAL Roman numeral or a plain integer; anything else leaves
 * the name whole, so a rescrape that spells a rank some new way makes a one-member family that is
 * visible in the browser rather than a silently mis-tiered row.
 */
export function parseFocusEffect(name: string): FocusRank {
  const trimmed = name.trim()
  const m = /^(.+?)\s+([A-Z]+|\d{1,3})$/.exec(trimmed)
  if (m === null) return { family: trimmed, tier: 1 }
  const [, stem, token] = m
  const tier = /^\d+$/.test(token) ? Number(token) : romanValue(token)
  return tier === null || tier === 0 ? { family: trimmed, tier: 1 } : { family: stem.trim(), tier }
}

/**
 * R3 — is this effect attack HASTE, and therefore non-transferable? The planner flags such donors
 * rather than hiding them: the item is still best-in-slot as a WORN item, it just cannot be moved.
 *
 * Note that worn melee haste mostly isn't an effect at all — 64 pages carry it as a stat line
 * (`HASTE: +41%`), which never becomes a donor row in the first place.
 */
export function isHasteEffect(name: string, detail?: string): boolean {
  for (const text of [name, detail]) {
    if (text == null) continue
    const family = effectFamily(text)
    if (HASTE_FOCUS_FAMILIES.has(family)) return false
    if (HASTE_EFFECTS.has(family)) return true
  }
  return false
}
