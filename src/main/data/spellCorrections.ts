// OUR-SIDE CORRECTIONS TO THE SCRAPED SPELL DB — THE MECHANISM (JOS-150).
//
// `spells.json` is a SCRAPE and `scripts/scrape-spells.ts` rewrites it wholesale, so a hand-edit
// into it is lost on the next re-scrape and the diff of that re-scrape stops being readable. This
// pair of files is the other half of that arrangement: the wiki dataset stays PRISTINE and
// IDEMPOTENT under re-scrape, and everything we know that the wiki does not lives here, applied to
// the ENTRIES at load in `spellDb.ts` before any lookup table is derived.
//
// THE LIST IS NEXT DOOR. `spellCorrectionsList.ts` holds `SPELL_CORRECTIONS` itself and the prose
// that governs it — the evidence bar, the five drift classes, and why each entry earned its place.
// READ THAT HEADER BEFORE ADDING A CORRECTION. It is re-exported from here so every consumer keeps
// one import; the split is only that a data file which grows by one entry per defect should not be
// counted against a code-mass ceiling shared with the machinery that reads it.
//
// WHAT THIS FILE OWNS is the shape of a correction, the report one pass produces, and the two
// write rules:
//
//   IDEMPOTENCE, IN BOTH DIRECTIONS. Every correction states the text it REPLACES. If a re-scrape
//   leaves the wiki text unchanged the correction applies; if the wiki is fixed upstream the entry
//   already says `to` and the correction reports `satisfied` and does nothing; if the wiki changes
//   to some THIRD text it reports `stale` and `tests/spellCorrections.test.mts` fails — which is
//   the whole point, because a correction that has quietly stopped describing anything is worse
//   than no correction, since it looks like coverage.
//
//   WHICH ROWS ARE WRITTEN. A message correction writes the FIRST row of its name; a name
//   correction writes ALL of them. `rowsFor` states why, and it is not a detail.

import type { SpellEntry } from '../../shared/types'
import { SPELL_CORRECTIONS } from './spellCorrectionsList'

export { SPELL_CORRECTIONS }

/** The three message fields a correction can patch. */
export type SpellMessageField = 'msgCastOnYou' | 'msgCastOnOther' | 'msgWearsOff'

/**
 * Everything a correction can patch: the three messages, since JOS-161 the NAME, and since JOS-413
 * the POLARITY (`spellType`).
 *
 * THE POLARITY IS THE SIXTH DRIFT CLASS and it is the only one that is not about a SENTENCE. The
 * first five all assume the wiki is describing the right spell and getting its words wrong; a
 * polarity correction says the wiki filed the spell on the wrong SIDE. `spellCorrectionsPolarity.ts`
 * carries the family, the owner ruling and the derived census that keeps it honest.
 *
 * THE WRONG LEVEL IS THE SEVENTH (JOS-415), and it is the polarity's neighbour rather than a
 * message's: `classes` is the wiki's OTHER column, the one `shared/spellLevels.ts` reads into
 * (class, level) pairs and `buildLevelUnlocks` turns into "new at this level" cards. A correction
 * here says the wiki filed the spell at the wrong LEVEL. Its one entry and its argument live in
 * `spellCorrectionsList.ts`, beside the drift-class paragraph that governs it.
 */
export type SpellCorrectionField = SpellMessageField | 'name' | 'spellType' | 'classes'

/** How a correction earned its place — see THE EVIDENCE BAR in `spellCorrectionsList.ts`. */
export type CorrectionAttribution = 'cast' | 'db' | 'sole'

export interface SpellCorrection {
  /**
   * Exact `SpellEntry.name`s this applies to, as the SCRAPE spells them — a correction always
   * names its target by the DB's own name, never by a name another correction produces. A name
   * absent from the DB fails the audit test.
   */
  spells: readonly string[]
  field: SpellCorrectionField
  /**
   * The wiki text being replaced, or `null` when the DB states NOTHING for this field. The
   * correction is a no-op unless the entry still says exactly this (or, for `null`, still says
   * nothing at all) — see THE ABSENT FIELD in the list file. For `field: 'name'` it restates the
   * name in `spells` (a spell always has one, so `null` is meaningless there and the audit
   * refuses it).
   */
  from: string | null
  /** What the live game prints, verbatim. */
  to: string
  attribution: CorrectionAttribution
  /** The measurement, in one line: what was counted, where, and how much of it there was. */
  evidence: string
}

/** What one pass of the overlay did, for the startup line and for the audit test. */
export interface CorrectionsReport {
  /** Entries whose `from` was found and replaced, counted per (correction, spell) pair. */
  applied: number
  /** Entries whose spell already said `to` — a re-scrape fixed it upstream and we can drop it. */
  satisfied: number
  /**
   * Entries whose spell said NEITHER `from` nor `to`. The wiki moved under us and the correction
   * now describes nothing; `tests/spellCorrections.test.mts` fails on a non-empty list.
   */
  stale: { spell: string; field: SpellCorrectionField; found: string | undefined }[]
  /**
   * Correction entries naming a spell the DB does not have (a rename, or a typo here). It is also
   * where a rotted NAME correction lands — a renamed row is no longer findable by the name the
   * correction states — so the audit test failing on a non-empty list is doing the same job for
   * names that `stale` does for messages.
   */
  unknownSpells: string[]
}

/** The working state one pass carries: the list being built, the name index, and the tally. */
interface Pass {
  out: SpellEntry[]
  /** EVERY index per name, not just the first — `rowsFor` decides which of them are written. */
  byName: ReadonlyMap<string, number[]>
  report: CorrectionsReport
}

/**
 * Apply the overlay to a spell list, returning a NEW list.
 *
 * NON-MUTATING ON PURPOSE. The list comes from an ES-imported JSON module, which is a single shared
 * object for the whole process — mutating it would make `loadSpellDb()` non-idempotent and would
 * leak into every test that imports `spells.json` directly (`tests/buffUnifiedModel.test.mts` reads
 * it for the spellType oracle). Only the entries that actually change are copied.
 *
 * TWO CORRECTIONS MAY SHARE A `from` AND DIFFER IN `to` — Symbol of Transal and Symbol of Pinzarn
 * both replace the same generic mystic-symbol sentence with their own spell's name. That works
 * because a correction names SPELLS, not messages: each is matched against the CURRENT text of the
 * entry it names, so the two never see each other. A pair that named the same spell AND field would
 * be a contradiction, and `tests/spellCorrections.test.mts` refuses it rather than letting order
 * decide.
 */
export function applySpellCorrections(
  spells: readonly SpellEntry[],
  corrections: readonly SpellCorrection[] = SPELL_CORRECTIONS
): { spells: SpellEntry[]; report: CorrectionsReport } {
  const byName = new Map<string, number[]>()
  spells.forEach((s, i) => {
    const list = byName.get(s.name)
    if (list) list.push(i)
    else byName.set(s.name, [i])
  })
  const pass: Pass = {
    out: spells.map((s) => s),
    byName,
    report: { applied: 0, satisfied: 0, stale: [], unknownSpells: [] }
  }
  for (const c of corrections) {
    for (const name of c.spells) applyOne(pass, c, name)
  }
  return { spells: pass.out, report: pass.report }
}

/**
 * Which rows of the DB one correction writes to, and it is NOT the same answer for both kinds.
 *
 * A MESSAGE correction takes the FIRST row of that name, which is what this overlay has always
 * done and is deliberately kept: the scrape carries era/rank duplicates whose messages genuinely
 * differ (`Shock of Frost` is two rows, one saying `Your feel your skin freeze.` and one `Your skin
 * goes numb.`), so writing one row's correction across both would turn a real difference into a
 * stale report.
 *
 * A NAME correction takes ALL of them, because the same duplicates cannot disagree about what the
 * spell is CALLED. Half a rename is worse than none: `SpellDb.byKey` and `buildSpellCatalog` fold
 * by name, so a renamed row and its un-renamed twin become two lines and the wizard lists a spell
 * that does not exist (JOS-161).
 *
 * A POLARITY correction takes ALL of them too, and for the same reason read one field over
 * (JOS-413): era/rank duplicates of one spell genuinely differ about the sentence they print, but
 * they cannot differ about whether the spell is a good thing or a bad thing. Half a reclassification
 * is the worse of the two failures here — `spellNature` is what `classOf` folds into `cls`, so one
 * corrected row and one untouched twin means the same Pacify is a buff or a debuff depending on
 * which row a lookup happened to reach, and the two surfaces would disagree about the same bar.
 *
 * A CLASSES correction takes ALL of them for the third time, and this is where the rule does the
 * most work (JOS-415): the defect it exists for IS a duplicate pair that disagrees. `Leach` has two
 * wiki pages, one saying `Necromancer - Level 9` and one `Necromancer - Level 12 Recourse Effect`,
 * so the level-up panel announced the same spell at two levels. `buildLevelUnlocks` emits one row
 * PER DB ROW and `spellRows` folds by name only WITHIN a level, so half a correction leaves the
 * phantom card exactly where it was. Writing every row makes the two agree and the renderer's fold
 * draws one card at one level. The already-correct twin costs nothing: `applyOne` sees
 * `current === to` and reports `satisfied` — the same answer a re-scrape fixing it upstream gives.
 */
function rowsFor(
  byName: ReadonlyMap<string, number[]>,
  field: SpellCorrectionField,
  name: string
): number[] {
  const all = byName.get(name)
  if (!all) return []
  return field === 'name' || field === 'spellType' || field === 'classes' ? all : [all[0]]
}

/** One (correction, spell) pair against the working list. Reports rather than throws. */
function applyOne(pass: Pass, c: SpellCorrection, name: string): void {
  const { out, byName, report } = pass
  const rows = rowsFor(byName, c.field, name)
  if (rows.length === 0) {
    // A NAME correction that already ran (the idempotence pass) or that a re-scrape fixed upstream
    // leaves no row called `from` at all — the rows are called `to`, which is `satisfied`, exactly
    // as an already-correct message is. Anything else is a spell the DB does not have.
    const renamed = c.field === 'name' ? byName.get(c.to) : undefined
    if (renamed) report.satisfied += renamed.length
    else report.unknownSpells.push(name)
    return
  }
  for (const at of rows) {
    const current = out[at][c.field]
    if (current === c.to) {
      report.satisfied++
      continue
    }
    // `from: null` describes an ABSENT field, so its match test is "the DB still says nothing"
    // rather than a string compare. Everything downstream is unchanged: a re-scrape that fills
    // the field with our text reports satisfied above, and one that fills it with anything else
    // falls through to stale exactly as a moved sentence does.
    const describes = c.from === null ? current === undefined : current === c.from
    if (!describes) {
      report.stale.push({ spell: name, field: c.field, found: current })
      continue
    }
    out[at] = { ...out[at], [c.field]: c.to }
    report.applied++
  }
}
