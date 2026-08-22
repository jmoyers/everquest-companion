// OUR-SIDE REMOVALS FROM THE SCRAPED SPELL DB — THE MECHANISM (JOS-337).
//
// `spells.json` is a SCRAPE and `scripts/scrape-spells.ts` rewrites it wholesale, so a hand-DELETE
// out of it is undone by the next re-scrape exactly the way a hand-EDIT is. This pair of files is
// the removal half of the arrangement the corrections layer already built for edits: the wiki
// dataset stays PRISTINE and IDEMPOTENT under re-scrape, and what we know that the wiki does not
// lives here, applied to the ENTRIES at load — BEFORE the corrections overlay and before any
// lookup table is derived.
//
// THE LIST IS NEXT DOOR. `spellRemovalsList.ts` holds `SPELL_REMOVALS` itself and the prose that
// governs it — this drift class's OWN evidence bar, which is NOT the corrections bar and cannot
// be, and why each entry earned its place. READ THAT HEADER BEFORE ADDING A REMOVAL. It is
// re-exported from here so every consumer keeps one import; the split is the same one
// `spellCorrections.ts`/`spellCorrectionsList.ts` made, for the same reason (a data file that
// grows by one entry per defect should not be counted against a code-mass ceiling shared with the
// machinery that reads it).
//
// WHY THIS IS A SEPARATE LAYER AND NOT A SIXTH DRIFT CLASS OF THE CORRECTIONS OVERLAY. A
// correction is a claim about WORDS: the wiki and the game agree about which spell exists and
// disagree about the sentence it prints, and every one of them is settled by counting lines in a
// log. A removal is a claim about EXISTENCE, and existence has no sentence to count — see the
// list file's header, which is where that argument is made in full. Two consequences fall straight
// out of it and both are enforced here:
//
//   REMOVALS RUN FIRST. A spell that is not in the game cannot also have a corrected message, so
//   the pass that deletes it runs before the pass that patches text. `applySpellCorrections` would
//   then report a correction naming a removed spell as `unknownSpells` and the audit suite fails —
//   which is the desired outcome, and `tests/spellRemovals.test.mts` additionally refuses the pair
//   statically so the contradiction is caught in the LIST rather than in the load report.
//
//   A REMOVAL TAKES EVERY ROW OF ITS NAME, like a name correction and unlike a message
//   correction. The scrape carries era/rank duplicates whose MESSAGES may legitimately differ
//   (`rowsFor` in spellCorrections.ts explains that case), but a spell the game does not have is
//   not present in one revision of its own wiki page and absent from another. Half a removal
//   leaves a phantom row that `byKey`, `buildSpellCatalog` and `buildLevelUnlocks` would all still
//   find, which is the entire defect this layer exists to fix.

import type { SpellEntry } from '../../shared/types'
import { SPELL_REMOVALS } from './spellRemovalsList'

export { SPELL_REMOVALS }

/**
 * One spell the wiki carries and the shipped game does not.
 *
 * SINGULAR, DELIBERATELY — this is the first place the shape departs from `SpellCorrection`, which
 * names a `spells[]` FAMILY. A correction can attribute a whole family from one measurement,
 * because the siblings demonstrably share the sentence being corrected and the log counts settle
 * all of them at once. This bar cannot: absence is established one spell at a time, by a person
 * looking in the game, and a family entry would smuggle four unverified spells in under one
 * person's one look. One entry, one spell, one date.
 */
export interface SpellRemoval {
  /**
   * The exact `SpellEntry.name` as the SCRAPE spells it. A removal names its target by the DB's
   * own name, never by a name a correction produces — the removals pass runs first, so a
   * corrected name does not exist yet when this is read.
   */
  spell: string
  /**
   * THE BAR, and the reason this field is required rather than a sentence inside `evidence`: the
   * ISO date (`YYYY-MM-DD`) on which the owner looked in EQ Legends and did not find the spell.
   * Absence cannot be measured from a log, so a dated human verification is the only evidence
   * that exists for this class and it is stated as DATA, not prose, so the audit can check it.
   *
   * A `supersededBy` entry reads this field the same way but with a different INSTRUMENT — the
   * date the client's own `spells_us.txt` was read. See that field, and the list header's
   * DUPLICATE-PAGE section for why one claim admits an instrument the other cannot.
   */
  verified: string
  /**
   * The MECHANICAL reason the game lacks this spell, where one is established — and `null` where
   * one is not.
   *
   * IT IS HELD TO ITS OWN BAR, SEPARATELY FROM `verified`, and the list file's first entry is the
   * worked example of why. A verification says "it is not there". A mechanical reason says "and
   * here is the system it belonged to, which is also not there" — a much broader claim, one that
   * would license removing every other spell in the same family. So a reason may be stated only
   * when it has been checked, and `null` is a real answer meaning "the owner verified this one
   * spell and nothing wider is claimed". Never restate the ticket's hypothesis here.
   */
  reason: string | null
  /**
   * THE NAME THE SPELL SURVIVES UNDER, when this entry drops a DUPLICATE WIKI PAGE rather than a
   * spell EQ Legends does not have — and `undefined` for the plain absence claim the layer was
   * built for (JOS-440).
   *
   * THE TWO CLAIMS ARE DIFFERENT AND THE FIELD IS WHAT SAYS WHICH ONE IS BEING MADE. An absence
   * entry says "no player can go and learn this spell", and after it runs the DB states nothing
   * about that spell at all. A superseded entry says "the wiki documents this spell twice, this
   * page is the copy EQ Legends is not running, and THAT row is the one the game has" — after it
   * runs the spell is still in the DB, under the name written here, and every surface still offers
   * it. Nothing is withdrawn from the player; a duplicate is.
   *
   * SO IT CARRIES THE OBLIGATION THE ABSENCE CLAIM DOES NOT: the named row must SURVIVE the whole
   * load. `tests/spellRemovals.test.mts` asserts it by name against the committed scrape, run
   * through removals AND corrections — because the surviving row is allowed to be a row a `name`
   * correction renames INTO this spelling, which is exactly what JOS-440 does and is the one
   * arrangement the layer's original audit refused outright. That audit is now narrowed to the
   * hazard it was actually written for; the argument is in the test, beside the assertion.
   */
  supersededBy?: string
  /** What was done and what was found, in one line: the verification, and any measurement beside it. */
  evidence: string
}

/**
 * What one pass of the removals layer did, for the startup line and for the audit test.
 *
 * TWO NUMBERS, AND THE SECOND ONE IS THE WHOLE RE-SCRAPE STORY — see THE TOMBSTONE in the list
 * file's header for the argument. There is deliberately no `stale`/`unknownSpells` list here: an
 * entry that matches no row has got exactly what it asked for, and the shape of the report says so.
 */
export interface RemovalsReport {
  /** DB rows dropped, counted per ROW — a duplicated name contributes one per row. */
  removed: number
  /**
   * Entries that matched NO row, by name. The page is already gone: a re-scrape dropped it, or an
   * earlier pass in this same process already removed it. Either way there is nothing left to do
   * and the entry stands as a TOMBSTONE — kept so the knowledge survives the next re-scrape that
   * puts the page back, reported by NAME rather than counted so a reader of the boot log can see
   * WHICH entries have become tombstones instead of only how many.
   */
  satisfied: string[]
}

/**
 * Drop every row named by a removal, returning a NEW list.
 *
 * NON-MUTATING, the `applySpellCorrections` rule and for the same reason: the list comes from an
 * ES-imported JSON module, one shared object for the whole process, and several suites read it
 * raw. `filter` allocates a new array and copies no entry, which is stronger than the corrections
 * pass needs to be — nothing here writes a field.
 *
 * IDEMPOTENT BY CONSTRUCTION. A second pass over the output finds no row for any entry and reports
 * every one of them `satisfied`, which is the same answer a re-scrape that dropped the page
 * upstream produces. That equivalence is not an accident of the implementation; it is the semantic
 * the list file's header argues for.
 */
export function applySpellRemovals(
  spells: readonly SpellEntry[],
  removals: readonly SpellRemoval[] = SPELL_REMOVALS
): { spells: SpellEntry[]; report: RemovalsReport } {
  const wanted = new Set(removals.map((r) => r.spell))
  const hit = new Set<string>()
  const out: SpellEntry[] = []
  for (const s of spells) {
    if (wanted.has(s.name)) {
      hit.add(s.name)
      continue
    }
    out.push(s)
  }
  const report: RemovalsReport = {
    removed: spells.length - out.length,
    // In list order, not set order: the boot log and the audit read the same sequence the file
    // states, so a diff of either is a diff of the list.
    satisfied: removals.filter((r) => !hit.has(r.spell)).map((r) => r.spell)
  }
  return { spells: out, report }
}
