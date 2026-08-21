// SPELL UNLOCK LEVELS — the pure parse behind "what's new at this level"
// (docs/plans/levelup-whats-new.md § 1).
//
// NO SCRAPE IS INVOLVED. src/main/data/spells.json already carries, on every spell, the
// wiki's Template:Spellpage bullet list of who can cast it AND AT WHAT LEVEL:
//
//   "* Enchanter - Level 37"
//   "* Cleric - Level 10 (Autogranted) * Druid - Level 12 (Autogranted) * Shaman - Level 14"
//
// src/main/data/spellClasses.ts already reads the CLASSES out of that field; this module
// reads the (class, level) PAIRS, which is what a level-up panel needs. It is deliberately
// a second, tiny module in src/shared rather than a widening of the main-process one: the
// renderer needs these pairs and must not import from src/main.
//
// MEASURED over the committed DB (1,926 rows, 2026-08-05) — every number below is a
// measurement, not an estimate:
//   1,899 rows state a `classes` field at all (27 omit it entirely).
//   1,469 of those contain at least one `*` bullet; 1,455 yield at least one pair.
//   2,017 `*` segments exist; 2,001 parse; the 16 that do not are enumerated below.
//   14 distinct class DISPLAY names appear. BER, MNK and WAR appear ZERO times — those
//   three classes have no Template:Spellpage spells at all, so an empty result for them
//   is the honest answer, not a parse failure.
//   Levels run 1..63 with no gaps except 62. No em/en dashes, no "ALL", no newlines, no
//   non-ASCII, and no row ever states the same class twice.
//
// WHAT DOES NOT PARSE, and is therefore DROPPED (never guessed at):
//   - 430 rows carry no bullet at all: "This spell is cast by NPCs only." (337),
//     "No eligible class" (61), "BRD" (6 — a bare code with no level), "none",
//     "Druid (Epic)", and 20-odd one-off prose notes. A class with no stated level
//     cannot answer "what unlocks at 24", so naming one would be an invention.
//   - 16 bullet segments state no level: "None" (6), "NPC Only Spell" (2),
//     "Cleric - Various" / "Paladin - Various" (Resurrection Effects), "Item Effect",
//     and 5 prose notes the wiki bulleted into the same list.
// `scanSpellClasses` hands back the second group verbatim in `dropped[]` (a bulleted claim
// we could not use is worth counting); the first group produces no bullets at all, so it is
// simply an empty result. `parseSpellClasses` is the wrapper that just wants the pairs.
//
// Pure, dependency-free and node-testable, with RELATIVE value imports — the mobSearch.ts
// precedent (AGENTS.md, Toolchain gotchas).
import type { ClassAbbr } from './classCombo'

/** One statement of "this class gets this spell at this level". */
export interface SpellClassLevel {
  cls: ClassAbbr
  /** 1..63 as the wiki states it. */
  level: number
}

/** A parse plus what it could not use — the diagnostics hook the tests count against. */
export interface SpellClassScan {
  pairs: SpellClassLevel[]
  /** the `*` segments that stated no `<Class> - Level <n>`, verbatim and trimmed. */
  dropped: string[]
}

/**
 * Wiki class DISPLAY name -> /who code. Restated here rather than imported so this module
 * stays pure shared code with no reach into src/main/data; `tests/spellLevels.test.mts`
 * pins it against classes.json's own `names` table, so the two can never drift apart.
 *
 * "Shadowknight" is not a typo: the wiki spells the class both ways across its own spell
 * pages (75x "Shadow Knight", 15x "Shadowknight" in the committed DB) and both are SHD.
 */
const ABBR_BY_DISPLAY_NAME: ReadonlyMap<string, ClassAbbr> = new Map<string, ClassAbbr>([
  ['bard', 'BRD'],
  ['beastlord', 'BST'],
  ['berserker', 'BER'],
  ['cleric', 'CLR'],
  ['druid', 'DRU'],
  ['enchanter', 'ENC'],
  ['magician', 'MAG'],
  ['monk', 'MNK'],
  ['necromancer', 'NEC'],
  ['paladin', 'PAL'],
  ['ranger', 'RNG'],
  ['rogue', 'ROG'],
  ['shadow knight', 'SHD'],
  ['shadowknight', 'SHD'],
  ['shaman', 'SHM'],
  ['warrior', 'WAR'],
  ['wizard', 'WIZ']
])

/** The 16 display names this module understands, for a parity test against classes.json. */
export function knownClassDisplayNames(): string[] {
  return [...ABBR_BY_DISPLAY_NAME.keys()]
}

/**
 * `Shadow Knight` -> SHD. The SAME table the `classes` field is read with, exported for the one
 * other place a class arrives as a display name: the spell-lines research files, whose thirteen
 * agents each wrote `"class": "Cleric"` at the top (scripts/gen-spell-lines.ts, JOS-391). A second
 * copy of this map in a generator is a second opinion about how the wiki spells Shadowknight.
 */
export function classAbbrForDisplayName(name: string): ClassAbbr | undefined {
  return ABBR_BY_DISPLAY_NAME.get(name.trim().toLowerCase())
}

/**
 * /who code -> the class's name as a person says it, in the wiki's own capitalization.
 *
 * THE OTHER DIRECTION, and it exists for the UI (JOS-402, owner: *anywhere in the app that we have
 * the class filter, it should be the whole class name*). Every class-SELECTION control now labels
 * its options and chips through this — the Gear and Exaltations class filters, their detected-combo
 * offer chips, and the loadout class picker — while the values they store, compare and validate stay
 * the three-letter codes. A renderer-local copy of this table would be a second opinion about how
 * this app spells Shadow Knight, which is exactly what the map above already refuses.
 *
 * It is written out rather than inverted from `ABBR_BY_DISPLAY_NAME`: that map is keyed by the
 * LOWERCASED wiki spelling and holds two keys for SHD, so an inversion would have to both pick a
 * winner and re-capitalize it. `tests/spellLevels.test.mts` pins every entry against classes.json's
 * `names` and pins the round trip through `classAbbrForDisplayName`, so the two tables here cannot
 * drift from each other or from the scrape.
 */
const DISPLAY_NAME_BY_ABBR: Readonly<Record<ClassAbbr, string>> = {
  BER: 'Berserker',
  BRD: 'Bard',
  BST: 'Beastlord',
  CLR: 'Cleric',
  DRU: 'Druid',
  ENC: 'Enchanter',
  MAG: 'Magician',
  MNK: 'Monk',
  NEC: 'Necromancer',
  PAL: 'Paladin',
  RNG: 'Ranger',
  ROG: 'Rogue',
  SHD: 'Shadow Knight',
  SHM: 'Shaman',
  WAR: 'Warrior',
  WIZ: 'Wizard'
}

/** `SHD` -> `Shadow Knight`. The ONE abbr-to-words function; see the table's header. */
export function classDisplayName(abbr: ClassAbbr): string {
  return DISPLAY_NAME_BY_ABBR[abbr]
}

/** `Enchanter - Level 37 (Autogranted)` -> ENC 37. Trailing notes are ignored, not required. */
const SEGMENT = /^([A-Za-z][A-Za-z ]*?)\s*-\s*Level\s*(\d+)\b/

/**
 * One `classes` field -> every (class, level) pair it states, plus the segments it did not.
 *
 * The field is a bullet list the spell scrape collapsed onto one line, so the bullets — not
 * the newlines — are the record separator. A class stated twice keeps its LOWEST level (the
 * conservative reading of "when do I get this"); the committed DB has no such row today,
 * but a future re-scrape must not turn one into a duplicate chip.
 */
export function scanSpellClasses(text: string | undefined): SpellClassScan {
  const dropped: string[] = []
  if (text === undefined) return { pairs: [], dropped }

  const lowest = new Map<ClassAbbr, number>()
  for (const raw of text.split('*').slice(1)) {
    const segment = raw.trim()
    if (segment.length === 0) continue
    const m = SEGMENT.exec(segment)
    const cls = m ? ABBR_BY_DISPLAY_NAME.get(m[1].trim().toLowerCase()) : undefined
    if (!m || cls === undefined) {
      dropped.push(segment)
      continue
    }
    const level = Number(m[2])
    const prior = lowest.get(cls)
    if (prior === undefined || level < prior) lowest.set(cls, level)
  }

  const pairs = [...lowest]
    .map(([cls, level]) => ({ cls, level }))
    .sort((a, b) => a.cls.localeCompare(b.cls))
  return { pairs, dropped }
}

/** The (class, level) pairs a `classes` field states, sorted by class code. */
export function parseSpellClasses(text: string | undefined): SpellClassLevel[] {
  return scanSpellClasses(text).pairs
}

/** The level `cls` gets this spell at, or null when the field does not place that class. */
export function spellLevelFor(text: string | undefined, cls: ClassAbbr): number | null {
  return parseSpellClasses(text).find((p) => p.cls === cls)?.level ?? null
}
