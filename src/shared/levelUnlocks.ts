// LEVEL UNLOCKS — "what's new at this level", as a wire shape and a pure join
// (docs/plans/levelup-whats-new.md § 1–2, wave O2).
//
// TWO SOURCES, ALREADY COMMITTED, NEITHER OF THEM SCRAPED HERE:
//   * spells.json's `classes` field states, per spell, WHICH CLASS gets it AT WHICH LEVEL —
//     parsed by shared/spellLevels.ts (2,001 pairs over the committed DB, measured wave O1).
//   * classes.json's `skillUnlocks` / `discUnlocks` state the same for skills, disciplines and
//     the three structure-derived innates (450 + 33 rows, measured wave O1).
// Main folds both into `LevelUnlockData` (src/main/data/levelUnlocks.ts) because both JSONs are
// bundled into the MAIN process; this file holds the shape they cross the wire in and every
// derivation the renderer performs on them, so `npm test` pins the arithmetic with no Electron.
//
// LAW 10 IS THE WHOLE DESIGN OF `comboClassesAt`. A level-up is a timestamped record and the
// class combo is a set of FUZZY, RETROACTIVELY REVISABLE intervals, so "which classes did that
// ding unlock things for" is a TIME JOIN at read (`comboAt`), never a stamped field. A ding
// toasted an hour ago re-counts correctly the moment a `/who` line or a user correction re-labels
// that span — there is nothing to reconcile because nothing was stamped.
//
// AND LAW 1: an unresolved loadout is never guessed. A slot holding {CLR,PAL} contributes BOTH
// classes to the count and the whole answer is labeled `ambiguous`; a slot with no evidence at
// all (all 16 candidates) contributes NOTHING — unioning sixteen classes would produce a number
// that is not about this character at all.
//
// Pure, dependency-free, RELATIVE value imports (the mobSearch.ts precedent).

import { CLASS_ABBRS, resolvedClasses, type ClassAbbr, type ComboInterval } from './classCombo'
import { comboAt } from './comboIndex'
import type { ClientHpFacts, SpellMetrics } from './spellMetrics'

/** What kind of thing unlocked. `skill`/`disc`/`innate` are classes.json's own words. */
export type UnlockKind = 'spell' | 'skill' | 'disc' | 'innate'

/** One spell, with every (class, level) statement the DB makes about it and its card fields. */
export interface UnlockSpell {
  name: string
  /** the (class, level) pairs `shared/spellLevels.ts` read out of the wiki's bullet list */
  at: { cls: ClassAbbr; level: number }[]
  /** cast time in ms, when the page states one */
  castTimeMs?: number
  mana?: number
  /** target_type verbatim ("Single Friendly (or Self)") */
  targetType?: string
  /** spell_type verbatim ("Beneficial" / "Detrimental") */
  spellType?: string
  /** parsed duration in ms; absent for instants and unparseable formulas */
  durationMs?: number
  /**
   * THE SEARCH SURFACE (JOS-392) — name + the three message texts, lowercased and apostrophe-folded
   * by `searchTextFor`, the SAME function the alerts catalog is built with.
   *
   * It rides this dataset rather than a second channel because this dataset is already every spell
   * the DB places, already carries the figures a result row prints, and is already pulled ONCE per
   * renderer session and cached — so the search box filters in the renderer and asks main nothing
   * per keystroke. Measured cost of carrying it: 329 kB → 461 kB on the one pull.
   */
  searchText?: string
  /** the DB's illusion flag, so `type:illusion` can be answered here too */
  illusion?: boolean
  /**
   * WHAT THE SPELL IS WORTH (JOS-391), read off the effect lines MAIN-SIDE at the LOWEST level
   * any class gains it (`shared/spellMetrics.ts`).
   *
   * The effect strings themselves stay behind: they are the bulk of the catalog, the renderer has
   * `SpellTooltip` for the one spell a reader opens, and a row needs four numbers rather than a
   * paragraph. Absent for every spell with no hitpoint line, which is most of them.
   */
  metrics?: SpellMetrics
  /**
   * THE INPUTS `metrics` WAS COMPUTED FROM, so a reader can compute it again at a DIFFERENT LEVEL
   * (JOS-445). `metrics` is a snapshot at the spell's own gain level and cannot answer "what is this
   * L18 nuke worth to me at 35" — `Garrison's Mighty Mana Shock` states
   * `Decrease Hitpoints by 272 (L18) to 333 (L34)`, so the two levels differ by 22%.
   *
   * ONLY THE HITPOINT LINES, and that is what makes carrying them affordable: the full effect list
   * is the bulk of the catalog (the reason `UnlockSpell` never carried it), while the lines
   * `parseHpLine` answers to are 403 spells and 17 kB against this dataset's 467 kB. Whether a line
   * IS a hitpoint line does not depend on the level — the head test and the magnitude shapes are
   * level-independent, only the VALUE a ramp yields is not — so filtering main-side loses nothing a
   * far-end reader could have found.
   *
   * Absent for a spell with no hitpoint line at all, which is most of the catalog.
   */
  hpLines?: string[]
  /**
   * The CLIENT'S hitpoint slots (JOS-396's fallback source), carried for the same reason and under
   * the same rule: only for the spells whose wiki lines yield nothing, which is the only case
   * `spellMetricsAt` consults it in. Fifteen spells in the owner's install; absent for everyone
   * else, and absent entirely on a machine with no `spells_us.txt`.
   */
  clientHp?: ClientHpFacts
  /**
   * The re-use timer, RESOLVED main-side with `spellMetricsAt`'s own precedence (page over client,
   * a stated 0 blocking the fallback) — the JOS-444 ∩ JOS-445 seam: `hpLines`/`clientHp` let a
   * reader re-evaluate at another level, and without this field that re-evaluation would divide by
   * a cast-only window while the row's own snapshot divides by the sustained cycle.
   */
  recastMs?: number
  /**
   * HOW MANY WAVES ONE CAST DELIVERS (JOS-449), present only for a RAIN — absent is the ordinary
   * spell that lands once, and no row ever carries a 1.
   *
   * Resolved main-side by `src/main/data/rainSpells.ts`, whose header carries the whole
   * three-instrument derivation, because the sentence the roster is derived from is a wiki page's
   * `description` and that field does not ship in `spells.json`. A far-end reader gets the count
   * and multiplies, which is the same arrangement `recastMs` above has: the resolution happens once
   * and the two ends cannot disagree about it.
   */
  waves?: number
  /**
   * THE MOST TARGETS ONE CAST CAN STRIKE, as the PLAYER'S OWN CLIENT states it (JOS-449, field 143).
   *
   * Absent on a machine with no `spells_us.txt`, and absent for every single-target spell even
   * where there is one. `shared/aoeSpells.ts` has the default that answers for the first case and
   * the reason it is 4; the second case never asks.
   */
  aeMaxTargets?: number
  /**
   * The spell THIS one replaces, per class that gains it (JOS-391) — the shipped spell-line
   * research, joined main-side (`src/main/data/spellLineLookup.ts`).
   *
   * Per class because the ladders differ: `Greater Healing` is followed by Superior Healing for a
   * cleric and by Spirit Salve for a shaman. Absent when no class's line places it.
   */
  replaces?: { name: string; cls: ClassAbbr }[]
  /**
   * THE WIKI BADGES THIS SPELL'S PAGE OUT OF ERA (JOS-393) — `true` or absent, never `false`, which
   * is `SpellEntry.outOfEra`'s own law carried across the wire.
   *
   * It is what `unlocksAtLevel` folds a row out of the level lists on, and what a SEARCH row wears
   * as a chip instead. The two treatments are one rule read from two directions: a level list
   * answers "what is new for me now" and an expansion this server has not opened is not part of
   * that answer; a search answers a question the player typed, and hiding the row would be
   * answering a different one.
   */
  outOfEra?: boolean
}

/** One skill / discipline / innate, as classes.json states it for ONE class. */
export interface UnlockSkill {
  name: string
  level: number
  kind: 'skill' | 'disc' | 'innate'
  /**
   * A source that DISPUTES this row, quoted verbatim from classes.json's `disputed[]`.
   *
   * The central Disciplines page strikes the whole non-Rogue discipline table through and says
   * only Rogue poison disciplines are on Legends, while each class page still states its own
   * levels. Both claims are the wiki's; the row is kept and LABELED rather than silently
   * dropped or silently shown (law 1).
   */
  dispute?: string
}

/** The whole unlock dataset, as it crosses the wire once per renderer session. */
export interface LevelUnlockData {
  /** every spell the DB places for at least one class at a stated level */
  spells: UnlockSpell[]
  /** skills + discs + innates, keyed by /who class code */
  skills: Partial<Record<ClassAbbr, UnlockSkill[]>>
  /** classes.json's scrape stamp — provenance for the panel's "from the wiki DB" chip */
  scrapedAt?: string
}

export const EMPTY_UNLOCK_DATA: LevelUnlockData = { spells: [], skills: {} }

// ---- the combo join (law 10) ----------------------------------------------------------

/** The classes a count should be computed over, and whether that set is a guess. */
export interface ComboClasses {
  /** slots holding exactly one candidate — the classes we KNOW are in the loadout */
  resolved: ClassAbbr[]
  /** extra candidates from partially-known slots ({CLR,PAL}); never a fully-unknown slot */
  candidates: ClassAbbr[]
  /** true when ANY slot is unresolved — every count over this set is an upper bound */
  ambiguous: boolean
}

export const EMPTY_COMBO_CLASSES: ComboClasses = { resolved: [], candidates: [], ambiguous: true }

/** resolved ∪ candidates, deduped and sorted — the set a count is actually taken over. */
export function comboClassSet(c: ComboClasses): ClassAbbr[] {
  return [...new Set([...c.resolved, ...c.candidates])].sort((a, b) => a.localeCompare(b))
}

/**
 * One interval's classes, split into what it KNOWS and what it merely narrows.
 *
 * A slot listing every class in the game is UNKNOWN, not ambiguous-in-a-useful-way: it states no
 * evidence, so it contributes no candidates and only sets the flag. A null interval is
 * `EMPTY_COMBO_CLASSES` (ambiguous, empty) rather than an empty loadout — the difference between
 * "you gained nothing" and "we do not know yet".
 */
export function comboClassesOf(interval: ComboInterval | null): ComboClasses {
  if (!interval) return EMPTY_COMBO_CLASSES
  const resolved = resolvedClasses(interval)
  const candidates: ClassAbbr[] = []
  let ambiguous = false
  for (const slot of interval.slots) {
    if (slot.candidates.length === 1) continue
    ambiguous = true
    if (slot.candidates.length >= CLASS_ABBRS.length) continue
    candidates.push(...slot.candidates)
  }
  return {
    resolved: [...new Set(resolved)].sort((a, b) => a.localeCompare(b)),
    candidates: [...new Set(candidates)].filter((c) => !resolved.includes(c)).sort((a, b) => a.localeCompare(b)),
    ambiguous
  }
}

/**
 * The loadout as of `ts`, joined at read (law 10) — the form the level-up toast uses, because a
 * ding is a timestamped record and the intervals covering it are revisable forever.
 */
export function comboClassesAt(intervals: readonly ComboInterval[], ts: number): ComboClasses {
  return comboClassesOf(comboAt(intervals, ts))
}

// ---- the level join -------------------------------------------------------------------

/** One thing that unlocks at a level, folded across the classes that unlock it there. */
export interface UnlockRow {
  kind: UnlockKind
  name: string
  /** the classes IN THE QUERIED SET that gain this at this level, sorted */
  classes: ClassAbbr[]
  level: number
  /** the disputing source, quoted verbatim (disc rows only) */
  dispute?: string
  /** the spell's card fields, for the hover — absent on skill rows */
  spell?: UnlockSpell
  /**
   * Classes IN THE QUERIED SET that gain this spell EARLIER than this row's level (JOS-391),
   * ascending — the `already yours` claim. Empty/absent when no class in the loadout has it yet.
   */
  earlier?: { cls: ClassAbbr; level: number }[]
  /**
   * EVERY class the DB places this spell for, with the level each gets it at (JOS-392) — present
   * only on SEARCH rows, where the answer is about the game rather than about one level.
   *
   * A level row is drawn AT a level, so its chips need no numbers: `level` says it once for the
   * whole row. A search row is drawn at no level at all, so a bare `CLR` chip would be a fact
   * withheld — `CLR 24 · PAL 30` is the `spellClassLine` shape the spell card already prints.
   */
  levels?: { cls: ClassAbbr; level: number }[]
}

/** Everything a level gives a loadout, split the way the panel draws it. */
export interface LevelUnlocks {
  level: number
  /** the spells this level gives, MINUS the ones the wiki badges out of era */
  spells: UnlockRow[]
  /**
   * THE ONES THE WIKI BADGES OUT OF ERA (JOS-393) — folded, never dropped.
   *
   * THE DROPS PRECEDENT, EXACTLY (`features/mobs/dropEra.ts`, JOS-377): a positively out-of-era row
   * sits behind a `+N out of era` disclosure that expands to the rows; an UNKNOWN row renders
   * plainly beside the rest. The difference between the two surfaces is only which way silence
   * falls, and it falls the same way here — a spell the era sidecar has no verdict for carries no
   * flag and stays in `spells`, because "we cannot say" must never be drawn as "no".
   *
   * FOLDED RATHER THAN HIDDEN because the wiki's claim is still a fact about the game: a shaman at
   * 50 should not be sent to a vendor for `Sloths Healing`, and should also not be left wondering
   * why the spell his friend mentions is missing from the list.
   */
  outOfEraSpells: UnlockRow[]
  /** skills, disciplines and innates in one list — the panel chips the kind */
  skills: UnlockRow[]
  /** the set the join ran over (may be empty) */
  classes: ClassAbbr[]
  /** true when the loadout was not fully resolved: the lists are an UPPER BOUND */
  ambiguous: boolean
}

/** A class set with nothing in it answers honestly rather than scanning the whole game. */
function emptyUnlocks(level: number, ambiguous: boolean): LevelUnlocks {
  return { level, spells: [], outOfEraSpells: [], skills: [], classes: [], ambiguous }
}

/**
 * Every spell the queried classes gain at `level`, folded BY NAME.
 *
 * By name, not per DB row, for two reasons the committed data shows: a spell can be stated for
 * several classes in the loadout at the same level (one row, two chips), and the wiki genuinely
 * carries duplicate pages for a few spells (`Imbue Emerald` appears twice at CLR 29). Counting a
 * name twice would inflate the toast's headline over a wiki bookkeeping artefact; the first
 * record's fields win, because they are the same spell.
 */
function spellRows(data: LevelUnlockData, want: ReadonlySet<string>, level: number): UnlockRow[] {
  const byName = new Map<string, UnlockRow>()
  for (const spell of data.spells) {
    const classes = spell.at.filter((p) => p.level === level && want.has(p.cls)).map((p) => p.cls)
    if (classes.length === 0) continue
    const key = spell.name.toLowerCase()
    const row = byName.get(key)
    if (!row) {
      const next: UnlockRow = { kind: 'spell', name: spell.name, classes: [...new Set(classes)], level, spell }
      const earlier = earlierClasses(spell, want, level)
      if (earlier.length > 0) next.earlier = earlier
      byName.set(key, next)
      continue
    }
    for (const cls of classes) if (!row.classes.includes(cls)) row.classes.push(cls)
  }
  for (const row of byName.values()) row.classes.sort((a, b) => a.localeCompare(b))
  return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name))
}

/**
 * The classes in the loadout that ALREADY have this spell — gained it below the level being
 * viewed (JOS-391). Ascending by level, deduped by class at its lowest statement.
 *
 * IT IS A CLAIM ABOUT THIS CHARACTER, not about the game. A cleric/paladin/enchanter walking up
 * to Paladin 30 does not need to be sold a spell their cleric bought at 24 — the DB states both
 * rows and the loadout is what turns two facts into one answer. A class OUTSIDE the queried set
 * contributes nothing, however loudly the DB states it: the row's whole point is what YOU own.
 */
function earlierClasses(
  spell: UnlockSpell,
  want: ReadonlySet<string>,
  level: number
): { cls: ClassAbbr; level: number }[] {
  const lowest = new Map<ClassAbbr, number>()
  for (const p of spell.at) {
    if (p.level >= level || !want.has(p.cls)) continue
    const seen = lowest.get(p.cls)
    if (seen === undefined || p.level < seen) lowest.set(p.cls, p.level)
  }
  return [...lowest]
    .map(([cls, at]) => ({ cls, level: at }))
    .sort((a, b) => a.level - b.level || a.cls.localeCompare(b.cls))
}

/**
 * THE ROW'S OWNERSHIP PHRASE, or null when the row makes no such claim.
 *
 *   `already yours (CLR 24)`   a class in the loadout bought it six levels ago
 *   `also PAL 27`              a second loadout class gains it at THIS level too
 *   `~already yours (CLR 24)`  the class that has it is only a CANDIDATE of an unresolved slot
 *
 * THE CLASS IS ITS /who CODE, not its display name, because the chips at the other end of the
 * same row are `CLR` and a row that spells one class two ways in twelve characters is asking to
 * be misread. The `~` is the app's existing marker for "over a loadout we only narrowed"
 * (`~ambiguous`, ClassComboLabels) — the same claim, one word long.
 *
 * The `also` arm is deliberately quiet: the chips already state that two classes gain it here, so
 * this only names the OTHER ones, and only when there is no stronger `already yours` to print.
 *
 * AND ON A SEARCH ROW THE `also` ARM IS SILENT (JOS-392). It exists because a level row's chips
 * carry no numbers; a search row's chips carry every class AND its level, so the same sentence
 * would restate a chip two inches to its left. The `already yours` arm still prints — it is a claim
 * about THIS character that no chip makes.
 */
export function ownershipPhrase(row: UnlockRow, resolved: ReadonlySet<string>): string | null {
  const earlier = row.earlier ?? []
  if (earlier.length > 0) {
    const uncertain = earlier.every((e) => !resolved.has(e.cls))
    const parts = earlier.map((e) => `${e.cls} ${String(e.level)}`)
    return `${uncertain ? '~' : ''}already yours (${parts.join(', ')})`
  }
  if (row.levels !== undefined || row.classes.length < 2) return null
  const [, ...rest] = row.classes
  return `also ${rest.map((c) => `${c} ${String(row.level)}`).join(', ')}`
}

/** Merge one class's skill row into the (name, kind) fold — a second class only adds a chip. */
function addSkillRow(byKey: Map<string, UnlockRow>, cls: ClassAbbr, s: UnlockSkill): void {
  const key = `${s.kind}:${s.name.toLowerCase()}`
  const row = byKey.get(key)
  if (row) {
    if (!row.classes.includes(cls)) row.classes.push(cls)
    return
  }
  const next: UnlockRow = { kind: s.kind, name: s.name, classes: [cls], level: s.level }
  if (s.dispute) next.dispute = s.dispute
  byKey.set(key, next)
}

/**
 * Every skill/disc/innate the queried classes gain at `level`, folded by (name, kind) so a skill
 * two classes in the loadout both get at 10 is ONE row wearing two chips.
 */
function skillRows(data: LevelUnlockData, classes: readonly ClassAbbr[], level: number): UnlockRow[] {
  const byKey = new Map<string, UnlockRow>()
  for (const cls of classes) {
    for (const s of (data.skills[cls] ?? []).filter((r) => r.level === level)) addSkillRow(byKey, cls, s)
  }
  for (const row of byKey.values()) row.classes.sort((a, b) => a.localeCompare(b))
  return [...byKey.values()].sort((a, b) => a.name.localeCompare(b.name))
}

/**
 * WHAT THIS LEVEL GIVES THESE CLASSES. Pure — the panel and the toast subtitle both read it, so
 * the number in the toast and the rows in the panel can never disagree.
 *
 * BER/MNK/WAR have ZERO Template:Spellpage spells (measured, wave O1): an empty `spells` list for
 * a skills-only loadout is the honest answer, never an error state.
 */
export function unlocksAtLevel(
  data: LevelUnlockData,
  combo: ComboClasses,
  level: number
): LevelUnlocks {
  const classes = comboClassSet(combo)
  if (classes.length === 0 || !Number.isFinite(level)) return emptyUnlocks(level, combo.ambiguous)
  const want = new Set<string>(classes)
  const { shown, out } = splitRowsByEra(spellRows(data, want, level))
  return {
    level,
    spells: shown,
    outOfEraSpells: out,
    skills: skillRows(data, classes, level),
    classes,
    ambiguous: combo.ambiguous
  }
}

/**
 * The era split (JOS-393) — `splitDropsByEra`'s shape, over unlock rows.
 *
 * POSITIVE CLAIMS ONLY. `outOfEra` is `true` or absent by construction, so this partition can never
 * fold a row on an absence: a spell the sidecar was never asked about, or answered `false` for,
 * stays in `shown`. Both halves keep the list's own order.
 */
function splitRowsByEra(rows: readonly UnlockRow[]): { shown: UnlockRow[]; out: UnlockRow[] } {
  const shown: UnlockRow[] = []
  const out: UnlockRow[] = []
  for (const row of rows) (row.spell?.outOfEra === true ? out : shown).push(row)
  return { shown, out }
}

/**
 * WHAT THIS ROW REPLACES, for the classes the row is drawn for — `replaces Minor Healing (CLR)`.
 *
 * SCOPED TO THE ROW'S OWN CLASSES. `UnlockSpell.replaces` is joined main-side for every class the
 * DB places the spell for, because one dataset serves every loadout; a row drawn for a cleric must
 * not print the shaman's answer. Two classes replacing DIFFERENT spells both print, which is the
 * honest shape for a trio that gains the same upgrade from two ladders at once.
 */
export function replacesPhrase(row: UnlockRow): string | null {
  const parts = replacesEntries(row).map((r) => `${r.name} (${r.cls})`)
  return parts.length === 0 ? null : `replaces ${parts.join(', ')}`
}

/**
 * The same answer, unjoined — the (spell, class) pairs the phrase is built from.
 *
 * IT EXISTS BECAUSE THE NAME IN THAT SENTENCE IS A THING YOU CAN LOOK AT (JOS-392, owner
 * addition): the panel hangs the spell card off each replaced NAME, so a player deciding whether to
 * buy the upgrade can read what they are giving up without leaving the tab. A joined string cannot
 * carry a hover target, and a renderer re-splitting one on ` (` would be a second parser for a
 * sentence this file already knows the parts of.
 */
export function replacesEntries(row: UnlockRow): { name: string; cls: ClassAbbr }[] {
  const mine = (row.spell?.replaces ?? []).filter((r) => row.classes.includes(r.cls))
  const seen = new Set<string>()
  const out: { name: string; cls: ClassAbbr }[] = []
  for (const r of mine) {
    const key = `${r.name}|${r.cls}`
    if (seen.has(key)) continue
    seen.add(key)
    out.push({ name: r.name, cls: r.cls })
  }
  return out
}

/**
 * The two headline numbers: distinct spells, distinct skill-ish things.
 *
 * THE SPELL COUNT IS THE SHOWN ONES (JOS-393). `3 new spells` on a toast is an invitation to go and
 * buy three spells, so a number that included one the wiki badges out of era would be a promise the
 * game cannot keep. The folded rows are still on the panel, wearing their own count.
 */
export function unlockCounts(u: LevelUnlocks): { spells: number; skills: number } {
  return { spells: u.spells.length, skills: u.skills.length }
}

/**
 * The level-up toast's subtitle: "3 new spells · 2 new skills".
 *
 * Zero unlocks ⇒ undefined, and the toast celebrates the level alone (the design's explicit
 * case: a level that gives you nothing is still a level). An unresolved loadout appends the
 * `~ambiguous` label the UI convention reserves for exactly this — the counts are an upper
 * bound over the candidate classes, and saying so is cheaper than being wrong.
 */
export function levelUpSubtitle(u: LevelUnlocks): string | undefined {
  const { spells, skills } = unlockCounts(u)
  const parts: string[] = []
  if (spells > 0) parts.push(`${String(spells)} new spell${spells === 1 ? '' : 's'}`)
  if (skills > 0) parts.push(`${String(skills)} new skill${skills === 1 ? '' : 's'}`)
  if (parts.length === 0) return undefined
  if (u.ambiguous) parts.push('~ambiguous loadout')
  return parts.join(' · ')
}

/** The levels this dataset has anything at all to say about, ascending. Drives the stepper. */
export function unlockLevels(data: LevelUnlockData, classes: readonly ClassAbbr[]): number[] {
  const want = new Set<string>(classes)
  const levels = new Set<number>()
  for (const spell of data.spells) {
    for (const p of spell.at.filter((x) => want.has(x.cls))) levels.add(p.level)
  }
  for (const cls of classes) for (const s of data.skills[cls] ?? []) levels.add(s.level)
  return [...levels].sort((a, b) => a - b)
}
