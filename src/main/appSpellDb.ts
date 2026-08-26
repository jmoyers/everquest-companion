// ============================================================================
// appSpellDb.ts — MAIN'S OWN SPELL CATALOG, WITHOUT A FOLD (JOS-499 item 4).
// ============================================================================
//
// `ipc/knowledge.ts` builds the spell catalog and the spell detail card
// (`buildSpellCatalog`/`buildSpellDetail`) off a `SpellDb`, and it used to read that object out of
// `pipeline.ts` — where it existed because the FOLD needed it: the parser is configured with the
// effective catalog so a self-landing sentence the wiki got wrong is recognised as a `buffApply`.
// The fold is deleted in this release. The catalog is not: a spell card is committed knowledge, and
// the two questions were only ever the same object by coincidence of construction.
//
// ── WHY THIS IS NEEDED AT ALL, STATED PLAINLY ──────────────────────────────────────────────────
//
// JOS-497 did NOT close this gap and the ledger says so. What that ticket built engine-side is
// `resist.spell` — the CLIENT spell table out of `spells_us.txt`, a different source by design
// (the game's own binary-ish table, carrying resist adjusts and mana costs). `knowledge.spell` is
// the WIKI catalog and still carries a named gap engine-side: no effect classes, no rank lineage,
// no metrics. Until that surface lands, the app answers its own spell cards, so the app needs its
// own catalog. This file is that, and it is deliberately small enough to delete in one line when
// the engine's knowledge surface grows the missing joins.
//
// ── IT IS THE SAME CONSTRUCTION, MINUS THE PARSER ──────────────────────────────────────────────
//
// `modules/wiring.ts effectiveSpellDb` did three things: load the committed catalog, fold the
// message overlay's learned landing corrections into it, and INSTALL it into the parser config.
// The first two survive verbatim here; the third has nothing left to install into and is dropped
// rather than stubbed. Everything it reads — `data/spellDb.ts`, `data/messageOverlay.ts`,
// `data/overlayPersistence.ts` — is committed-data machinery that survives this release intact.
//
// WHY THE OVERLAY CORRECTIONS ARE KEPT rather than simplified away to a bare `loadSpellDb()`: they
// change `castOnYou`, which is what `buildSpellCatalog` reads to decide whether a spell can offer a
// `lands` alert template. Dropping them would silently withdraw alert templates from exactly the
// spells a user's own log had taught the app about — a regression dressed as a simplification, and
// invisible until somebody noticed a suggestion had stopped being offered.
//
// MEMOIZED, ONCE, AND LAZILY. `loadSpellDb()` is itself memoized, but the overlay fold on top of it
// is not, and it reads the user's persisted overlay buckets off disk. Doing that at module
// evaluation would charge every launch for a catalog that only the knowledge IPC asks for —
// `itemLookup.ts`'s header makes the same argument about the same startup phase. The first caller
// pays; everybody after it gets the object.

import { logInfo } from './errorLog'
import {
  applyOverlayCorrections,
  loadSpellDb,
  spellCorrectionsReport,
  spellPlaceholdersReport,
  spellRemovalsReport,
  type SpellDb
} from './data/spellDb'
import { MessageOverlayMiner } from './data/messageOverlay'
import { baselineOverlay, loadUserSources } from './data/overlayPersistence'
import { BASELINE_SOURCE } from './data/messageOverlay'
// The registry VALIDATOR (JOS-412). It is not one of the load passes and reports from here rather
// than from the loader on purpose — see `spellSubjectAudit.ts`'s header for the one-way edge.
import { auditSpellSubjects } from './data/spellSubjectAudit'
// The era join's own census (JOS-393). It reports from `spellEra.ts` rather than from the loader
// beside its three siblings because the pass has two callers over one catalog — see that file.
import { spellEraReport } from './data/spellEra'

let cached: SpellDb | null = null
let cachedCorrections = 0

/**
 * THE APP'S EFFECTIVE SPELL CATALOG: `spells.json` plus every landing correction this user's own
 * logs have earned, overlay WINS (Task #36).
 *
 * The seeds are the committed baseline first and then the persisted per-source buckets, each under
 * the SOURCE KEY that produced it (JOS-231) — the same list and the same order `pipeline.ts` built,
 * because a different merge order is a different catalog.
 */
export function appSpellDb(): SpellDb {
  if (cached) return cached
  const db = loadSpellDb()
  const seedMiner = new MessageOverlayMiner(db.byKey)
  // EVERY seed, the persisted buckets included — the corrections a user's OWN log has earned reach
  // the catalog through here and nowhere else.
  seedMiner.merge(baselineOverlay(), BASELINE_SOURCE)
  for (const s of loadUserSources()) seedMiner.merge(s, s.key)
  cachedCorrections = applyOverlayCorrections(db, seedMiner.deriveLandingCorrections())
  cached = db
  return db
}

/**
 * WHEN MAIN'S COMMITTED DATA FINISHED LOADING, in ms since process start — the `dataLoaded`
 * startup phase (docs/plans/perf-profiling.md P4).
 *
 * IT MEANS SOMETHING SMALLER THAN IT USED TO, and that is honest rather than a downgrade. It was
 * `pipeline.ts`'s last line and marked the moment the whole log-derived world had been CONSTRUCTED
 * — twenty modules, the combat engine, the parser's config. None of that exists in this process
 * any more. What is left of the phase is what this process still loads at boot, and the phase name
 * is kept because the thing it brackets — "main is done reading committed data and is ready to
 * serve" — is still the question the startup timeline asks.
 *
 * A plain exported number, for the same reason `STORE_READY_MS` is one: this happens during module
 * EVALUATION, long before Electron's `ready`, and importing main's perf module from here to mark it
 * would buy a dependency cycle for a timestamp. The composition root imports both and marks it.
 */
export const DATA_READY_MS = performance.now()

/**
 * THE BOOT SUMMARY FOR THE COMMITTED SPELL DATA — the lines `pipeline.ts` printed at module scope,
 * as a function the composition root calls.
 *
 * A FUNCTION RATHER THAN MODULE-SCOPE SIDE EFFECTS, which is the one deliberate change from the
 * original. `pipeline.ts` printed these while being imported because it was the composition root's
 * first act and its construction was unconditional. This file's catalog is built LAZILY, so the
 * reports do not exist until somebody asks — and a summary printed before the load it summarises
 * would report zeros. The root calls this once, after it has decided it wants the catalog.
 *
 * The numbers worth watching are called out per line, unchanged: `stale` means a re-scrape moved a
 * message out from under a correction; a `satisfied` removal is a TOMBSTONE and is NAMED rather
 * than counted; the placeholder pass DELETES text so its rows are named too; `silent` counts era
 * rows the sidecar has no answer for; `unreachable` counts spells that can never be resolved to
 * their own landing sentence.
 */
export function logSpellDbSummary(): void {
  const db = appSpellDb()
  logInfo(
    `[everquest-companion] Message overlay: applied ${cachedCorrections} cast-message corrections over the wiki DB.`
  )
  const c = spellCorrectionsReport()
  if (c) {
    logInfo(
      `[everquest-companion] Spell corrections: ${c.applied} applied, ${c.satisfied} already correct upstream, ${c.stale.length} stale.`
    )
  }
  const r = spellRemovalsReport()
  if (r) {
    const tombstones = r.satisfied.length > 0 ? ` Tombstones: ${r.satisfied.join(', ')}.` : ''
    logInfo(
      `[everquest-companion] Spell removals: ${r.removed} row${r.removed === 1 ? '' : 's'} dropped (absent from EQ Legends), ${r.satisfied.length} already absent upstream.${tombstones}`
    )
  }
  const p = spellPlaceholdersReport()
  if (p) {
    const which = p.rows.map((row) => `${row.spell}/${row.field}`).join(', ')
    logInfo(
      `[everquest-companion] Spell placeholders: ${p.nulled} stub message${p.nulled === 1 ? '' : 's'} read as absent${which ? ` (${which})` : ''}.`
    )
  }
  const e = spellEraReport()
  if (e) {
    logInfo(
      `[everquest-companion] Spell era: ${e.marked} row${e.marked === 1 ? '' : 's'} the wiki badges out of era, ${e.silent} with no verdict (of ${e.table} in the sidecar).`
    )
  }
  const a = auditSpellSubjects(db.spells)
  logInfo(
    `[everquest-companion] Spell subjects: ${a.unreachable.length} spell${a.unreachable.length === 1 ? '' : 's'} unreachable by their landing sentence (${a.wrongSubject} rows with the wrong subject placeholder, ${a.noSubject} with none, ${a.firstPerson.length} first-person fields naming a third party).`
  )
  logInfo(
    `[everquest-companion] Spell DB: ${db.spells.length} spells (${db.castOnYou.size} unique cast-on-you msgs).`
  )
}
