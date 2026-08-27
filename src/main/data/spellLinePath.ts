// spellLinePath.ts — WHERE ONE SPELL SITS ON ITS UPGRADE LADDER, AND WHEN YOUR COMBO GETS EACH
// RUNG (JOS-508).
//
// The drilldown page's second section, built here rather than in the renderer for `spellDetail.ts`'s
// own reason: it is a JOIN across three committed sources plus one fold fact, and doing it in the
// renderer would make every host surface pass its own copy of all four in — which is also ruling 4's
// whole subject (no filtering, sorting or aggregation client-side; views arrive render-ready).
//
// ── THE THREE SOURCES, AND WHAT EACH IS AUTHORITATIVE FOR ──────────────────────────────────────
//
//   1. `spellLineLookup.ts` over the committed research table `spellLines.json` — authoritative for
//      WHICH SPELLS FORM A LADDER and in what order. Keyed BY CLASS, because the same name sits at
//      a different rung for a cleric and a shaman, and there is no class-free reading of it.
//   2. the effective spell DB (`spells.json` + removals + corrections + the user's overlay) —
//      authoritative for the PER-CLASS LEVEL of any given name, via its `classes` string.
//   3. the combo module's RESOLVED classes — authoritative for who you are actually playing.
//
// ── A RANK IS NOT A LINE, AND THIS FILE DOES NOT BLUR THAT ─────────────────────────────────────
//
// `spellDetail.ts`'s `lineage` block enumerates the roman-numeral RANKS a source names; this is the
// other thing entirely, and `spellLineLookup.ts`'s header carries the owner's ruling that separated
// them (JOS-293). The one place the two touch is the LOOKUP KEY: the ladder is asked about the DB
// ROW's own display name, which for the ~1,800 lines the catalog holds once is already the
// unsuffixed name, and for the 121 rank-suffixed rows is the suffixed one — 20 of which the
// research table genuinely files as members (`Yaulp II`, `Rune I`…). Nothing is stripped here, so a
// name the table does not carry answers `null` rather than being folded until it matches something.
//
// ── TWO LEVELS, NEVER ONE ──────────────────────────────────────────────────────────────────────
//
// `step.level` is the LADDER'S OWN class's gain level — a fact about the table. `step.yoursAt` is
// when the resolved loadout gets that rung, read from the DB's per-class levels and intersected
// with the combo. They agree often and not always, and the difference is the whole point of the
// page: a paladin reading a cleric ladder must never be told he gets Complete Healing at 39.

import type { ClassAbbr } from '../../shared/classCombo'
import { CLASS_ABBRS } from '../../shared/classCombo'
import type { SpellLinePath, SpellLineStep } from '../../shared/spellDetail'
import type { SpellEntry } from '../../shared/types'
import { parseSpellClassLevels, spellLineKey } from '../../shared/spellLines'
import { lineContaining, replacedBy, type Placement } from './spellLineLookup'
import type { SpellDb } from './spellDb'

/**
 * THE ROW WHOSE FACTS ANSWER FOR THIS NAME — the exact rank when the DB carries it, the LINE's row
 * otherwise, and the caller is told which (`SpellDetail.name` vs `queried`).
 *
 * `db.byKey` is rank-FOLDED and keeps only the first row of a line, so reading it alone would
 * answer "Rune III" with Rune I's mana and duration and say nothing about the substitution. The 121
 * rank-suffixed rows the DB does carry deserve their own numbers; the ~1,800 lines it carries once
 * can only be answered by the line's row, and shared/spellDetail.ts `spellFactsAreForLine` is how
 * the card comes to say so out loud.
 *
 * IT LIVES HERE RATHER THAN IN `spellDetail.ts` (JOS-508) because both files need it and the
 * dependency has to point one way: the detail builder imports the ladder builder, never the
 * reverse. Moving it was the whole change — the body is verbatim what `spellDetail.ts` held.
 */
export function dbRowFor(db: SpellDb, name: string): SpellEntry | undefined {
  const wanted = name.trim().toLowerCase()
  const exact = db.spells.find((s) => s.name.trim().toLowerCase() === wanted)
  return exact ?? db.byKey.get(spellLineKey(name))
}

/** One class that files this spell, and where in that class's ladder it sits. */
interface Candidate {
  cls: ClassAbbr
  place: Placement
}

/**
 * Every class whose research ladder carries this exact name, in `CLASS_ABBRS` order.
 *
 * SWEPT OVER ALL SIXTEEN rather than over the DB row's own `classes` string, deliberately. The two
 * sources were written by different people from different pages and they disagree in both
 * directions; a ladder that files a spell for a class the wiki's class line omits is a real
 * placement, and dropping it would make the page silently forget a progression it has in hand.
 * Sixteen map reads against a lazily built index is not a cost worth designing around.
 */
function candidates(name: string): Candidate[] {
  const out: Candidate[] = []
  for (const cls of CLASS_ABBRS) {
    const place = lineContaining(name, cls)
    if (place) out.push({ cls, place })
  }
  return out
}

/** The rung's own level in a candidate's ladder — the number the choice below is made on. */
function rungLevel(c: Candidate): number {
  return c.place.line.members[c.place.index].level
}

/**
 * WHICH LADDER THE PAGE LEADS WITH, when several classes file the same spell.
 *
 * YOURS FIRST, ALWAYS: a class the loadout has resolved beats one it has not, because the page's
 * question is when YOU get these. Among equals, the ladder that hands the spell over EARLIEST wins
 * — that is the reading a player acts on — and the tie after that is alphabetical, so the answer is
 * stable across launches rather than dependent on `CLASS_ABBRS` order changing one day.
 *
 * Returns null when no class files the name at all, which is most of the catalog.
 */
function chooseLadder(name: string, combo: readonly ClassAbbr[]): { pick: Candidate; mine: boolean } | null {
  const all = candidates(name)
  if (all.length === 0) return null
  const mine = all.filter((c) => combo.includes(c.cls))
  const pool = mine.length > 0 ? mine : all
  const pick = pool.reduce((a, b) => {
    if (rungLevel(b) !== rungLevel(a)) return rungLevel(b) < rungLevel(a) ? b : a
    return b.cls < a.cls ? b : a
  })
  return { pick, mine: mine.length > 0 }
}

/**
 * WHEN THE CURRENT COMBO GETS ONE RUNG — the lowest level any resolved class of the loadout gains
 * it at, or null when none of them can cast it.
 *
 * Read off the DB's own per-class levels rather than off the ladder, because the ladder states one
 * class's number and the loadout may hold two or three. A trio of CLR/PAL/WAR asking about `Healing`
 * gets 10 (the cleric's), not 30 (the paladin's) and not whichever ladder the page happened to pick.
 *
 * NULL IS AN ANSWER AND IS NEVER SOFTENED into the ladder's own level: `shared/spellDetail.ts`
 * `spellStepWhen` turns it into "not for your classes" or "loadout unknown", which are two different
 * statements and neither is a number.
 */
function comboLevelFor(db: SpellDb, name: string, combo: readonly ClassAbbr[]): number | null {
  if (combo.length === 0) return null
  const row = dbRowFor(db, name)
  if (!row) return null
  const mine = parseSpellClassLevels(row.classes).filter((l) => combo.includes(l.cls))
  return mine.length === 0 ? null : Math.min(...mine.map((l) => l.level))
}

/** Case- and whitespace-stable comparison, matching `spellLineLookup.ts`'s own `nameKey`. */
function sameName(a: string, b: string): boolean {
  return a.trim().toLowerCase().replace(/\s+/g, ' ') === b.trim().toLowerCase().replace(/\s+/g, ' ')
}

/**
 * THE LADDER THIS SPELL SITS ON, ready to draw — or null when no class files the name.
 *
 * `name` is the DB ROW's display name (`SpellDetail.name`), not the string the user asked about:
 * `Celestial Remedy III` is answered by `Celestial Remedy`'s row, and it is that row's ladder the
 * page has to show. The `queried` flag therefore marks the rung matching `name`, and marks nothing
 * when the ladder carries the line under a spelling the DB does not use.
 *
 * The steps arrive in the table's own order, which the generator already sorted by level — the
 * renderer neither re-sorts nor filters them (ruling 4, `eslint.domainMunging.mjs`).
 */
export function buildSpellLinePath(
  db: SpellDb,
  name: string,
  combo: readonly ClassAbbr[]
): SpellLinePath | null {
  const chosen = chooseLadder(name, combo)
  if (!chosen) return null
  const { line } = chosen.pick.place
  const place = replacedBy(name, chosen.pick.cls)
  const steps: SpellLineStep[] = line.members.map((m) => ({
    name: m.name,
    level: m.level,
    queried: sameName(m.name, name),
    yoursAt: comboLevelFor(db, m.name, combo)
  }))
  return {
    line: line.name,
    cls: chosen.pick.cls,
    mine: chosen.mine,
    ladder: line.ladder,
    steps,
    prior: place.replaces,
    next: place.replacedBy
  }
}
