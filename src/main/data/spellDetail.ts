// spellDetail.ts — BUILD the one-spell record the hover card draws (JOS-293).
//
// It is a JOIN and nothing else: the effective spell DB (spells.json + the corrections overlay,
// already applied by `loadSpellDb`), the derived effect classes (spellEffectClass.ts, the
// separable JOS-251 overlay), and the ranks the LOG has seen you cast. Nothing is computed that a
// source did not state - a field the wiki omits arrives here as `undefined` and leaves as
// `undefined`, which is what lets the card obey law 1 by construction rather than by discipline.
//
// WHY THE LOG IS IN HERE AT ALL. The DB knows one row per line for ~1,800 of its ~1,900 spells
// (shared/spellLines.ts states the measurement), so it cannot name `Celestial Remedy II` when you
// ask about `Celestial Remedy III`. The log can: `AlertsSnap.spellLastCast` is rank-PRESERVING and
// is recorded on replay as well as live. Joining them here - rather than in the renderer, which
// would make every host surface pass its own rank map in - is what makes the card the same card on
// every surface. Each member carries which source named it; see shared/spellDetail.ts for the
// boundary that arrangement is honest about.

import type { SpellDetail, SpellRankMember } from '../../shared/spellDetail'
import { spellMetricsAt } from '../../shared/spellMetrics'
import { parseSpellClassLevels, parseSpellRank, spellLineKey } from '../../shared/spellLines'
import type { SpellResistTable } from '../../shared/resistTypes'
import type { SpellEntry } from '../../shared/types'
import { clientHpFor } from './clientSpellHp'
import { spellEffectClasses } from './spellEffectClass'
import { spellNature, type SpellDb } from './spellDb'

/** The record for a name no row of the DB carries. `found: false` is an answer, not an error. */
function notFound(queried: string): SpellDetail {
  return {
    queried,
    found: false,
    nature: 'unknown',
    illusion: false,
    classLevels: [],
    effectClasses: [],
    lineage: null
  }
}

/**
 * Every rank of `key` that a source names, ascending, deduped by display name.
 *
 * The DB side reads `db.spells` rather than `db.byKey`, which keeps only the FIRST row per line -
 * the rank siblings are invisible through the map. The log side reads the rank-preserving cast
 * recency map. A name both of them carry is `both`, and only a log-ONLY name is ever tagged on the
 * card: the point of the tag is to say "no committed source states this rank, your own play does".
 */
function lineMembers(key: string, db: SpellDb, observed: readonly string[]): SpellRankMember[] {
  const byName = new Map<string, SpellRankMember>()
  const add = (name: string, source: 'db' | 'log'): void => {
    const dedupe = name.trim().toLowerCase()
    const seen = byName.get(dedupe)
    if (seen) {
      if (seen.source !== source) seen.source = 'both'
      return
    }
    byName.set(dedupe, { name: name.trim(), rank: parseSpellRank(name).rank, source })
  }
  for (const s of db.spells) if (spellLineKey(s.name) === key) add(s.name, 'db')
  for (const name of observed) if (spellLineKey(name) === key) add(name, 'log')
  return [...byName.values()].sort((a, b) => a.rank - b.rank || a.name.localeCompare(b.name))
}

/**
 * The rank block for a queried name, or null when there is nothing to say.
 *
 * Null means BOTH halves are silent: the name carries no numeral and no source names a second rank
 * of its line. A single-rank line ("Clarity" alone) has no lineage, and saying "Rank I of 1" would
 * be inventing a denominator no source states.
 */
function buildLineage(
  queried: string,
  db: SpellDb,
  observed: readonly string[],
  row: SpellEntry
): SpellDetail['lineage'] {
  const { base, rank, suffixed } = parseSpellRank(queried)
  const key = spellLineKey(queried)
  const members = lineMembers(key, db, observed)
  if (!suffixed && members.length <= 1) return null
  // A ROW STANDING IN FOR THE WHOLE LINE CANNOT ALSO BE THE RANK BELOW YOU. When the DB carries no
  // row for the rank asked about, its single unsuffixed row supplies the facts on the card AND
  // would otherwise be reported as what rank III replaces - so `Celestial Remedy III` would read
  // "replaces Celestial Remedy" directly above "these are the Celestial Remedy line's numbers".
  // The row is still LISTED as a member (it is a real row); it just cannot be the answer to what
  // this rank superseded, because nothing states that it is a rank rather than the line.
  const standIn = row.name.trim().toLowerCase() !== queried.trim().toLowerCase()
  // The highest rank BELOW this one that somebody names. Not "the previous rank": if a source
  // names III and V and you asked about V, what it can honestly say is that III came before it.
  const below = members.filter(
    (m) => m.rank < rank && !(standIn && m.name.trim().toLowerCase() === row.name.trim().toLowerCase())
  )
  const replaces = below.length > 0 ? below[below.length - 1].name : undefined
  return { rank, suffixed, base, members, ...(replaces !== undefined ? { replaces } : {}) }
}

/**
 * THE ROW WHOSE FACTS ANSWER FOR THIS NAME - the exact rank when the DB carries it, the LINE's row
 * otherwise, and the caller is told which (`SpellDetail.name` vs `queried`).
 *
 * `db.byKey` is rank-FOLDED and keeps only the first row of a line, so reading it alone would
 * answer "Rune III" with Rune I's mana and duration and say nothing about the substitution. The 121
 * rank-suffixed rows the DB does carry deserve their own numbers; the ~1,800 lines it carries once
 * can only be answered by the line's row, and shared/spellDetail.ts `spellFactsAreForLine` is how
 * the card comes to say so out loud.
 */
function dbRowFor(db: SpellDb, name: string): SpellEntry | undefined {
  const wanted = name.toLowerCase()
  const exact = db.spells.find((s) => s.name.trim().toLowerCase() === wanted)
  return exact ?? db.byKey.get(spellLineKey(name))
}

/**
 * The one-spell record, joined from the DB entry, the effect-class overlay and the observed ranks.
 *
 * `observedRanks` is the caller's slice of `AlertsSnap.spellLastCast` - display names, rank intact.
 * An empty list is normal (a fresh character, or the alerts module not yet warm) and simply leaves
 * the lineage to whatever the DB states.
 */
export function buildSpellDetail(
  db: SpellDb,
  queried: string,
  observedRanks: readonly string[] = [],
  client: SpellResistTable | null = null
): SpellDetail {
  const name = queried.trim()
  if (!name) return notFound(queried)
  const entry: SpellEntry | undefined = dbRowFor(db, name)
  if (!entry) return notFound(name)
  const classLevels = parseSpellClassLevels(entry.classes)
  return {
    queried: name,
    name: entry.name,
    found: true,
    ...statedFields(entry),
    ...worthFields(entry, classLevels, client),
    nature: spellNature(entry.spellType),
    illusion: entry.illusion,
    classLevels,
    effectClasses: spellEffectClasses(entry),
    lineage: buildLineage(name, db, observedRanks, entry)
  }
}

/**
 * WHAT IT IS WORTH, at the level it becomes yours (JOS-392, owner addition).
 *
 * The SAME reader the unlock rows use (`spellMetricsAt`) at the SAME evaluation level — the lowest
 * level any class gains the line — so the figures on the card and the figures on the row beside it
 * are the same numbers rather than two derivations that agree today. A spell the DB places for
 * nobody is read at level 1, which is the only level it can honestly be read at.
 *
 * Absent for every spell with no hitpoint line, which is most of them, and the card draws nothing.
 *
 * AND SINCE JOS-396 THE CLIENT'S SLOTS ANSWER WHERE THE PAGE DOES NOT. `client` is the parsed
 * `spells_us.txt` table or null; it is a FALLBACK inside `spellMetricsAt`, so a spell whose page
 * states a hitpoint line is byte-identical to what it was. Null (no install, or the worker has not
 * finished) simply means the card behaves exactly as it did before this ticket — and because this
 * record is rebuilt on every invoke rather than cached, the next hover after the table resolves
 * carries the figures with no invalidation to arrange.
 */
function worthFields(
  e: SpellEntry,
  classLevels: readonly { level: number }[],
  client: SpellResistTable | null
): Partial<SpellDetail> {
  const level = classLevels.length > 0 ? Math.min(...classLevels.map((c) => c.level)) : 1
  const metrics = spellMetricsAt(e, level, clientHpFor(client, e.name))
  return metrics ? { metrics, metricsLevel: level } : {}
}

/**
 * The fields that are COPIED ACROSS ONLY IF THE PAGE STATED THEM - the whole of law 1 at this
 * seam, written once as a table rather than as eight conditional spreads.
 *
 * `undefined` is not spread in, so an absent wiki field stays absent in the record and the card's
 * selection (shared/spellDetail.ts) never has to decide what a missing mana cost looks like. A
 * STATED zero survives, because the test is `!== undefined` and not truthiness: `mana: 0` is what
 * every bard song's page says, and it is a fact.
 */
function statedFields(e: SpellEntry): Partial<SpellDetail> {
  const out: Partial<SpellDetail> = {}
  if (e.durationText !== undefined) out.durationText = e.durationText
  if (e.castTimeMs !== undefined) out.castTimeMs = e.castTimeMs
  if (e.mana !== undefined) out.mana = e.mana
  if (e.targetType !== undefined) out.targetType = e.targetType
  if (e.spellType !== undefined) out.spellType = e.spellType
  if (e.instrumentEnhanced !== undefined) out.instrumentEnhanced = e.instrumentEnhanced
  if (e.effects !== undefined) out.effects = e.effects
  if (e.msgCastOnYou !== undefined) out.msgCastOnYou = e.msgCastOnYou
  if (e.msgCastOnOther !== undefined) out.msgCastOnOther = e.msgCastOnOther
  if (e.msgWearsOff !== undefined) out.msgWearsOff = e.msgWearsOff
  // The era verdict is DERIVED rather than scraped (`spellEra.ts` joins it at load), but it obeys
  // the same rule as every line above it: copied across only when it is a positive claim, so the
  // card has nothing to interpret and cannot print "in era" over a page nobody has classified.
  if (e.outOfEra === true) out.outOfEra = true
  return out
}
