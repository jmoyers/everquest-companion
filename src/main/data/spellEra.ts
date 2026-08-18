// spellEra.ts — THE WIKI'S ERA VERDICT, JOINED ONTO THE SPELL CATALOG AT LOAD (JOS-393).
//
// THE REPORT. `Sloths Healing` was drawn as a spell newly available to a level-50 shaman. Its wiki
// page opens `{{Kunark Era}}`, states `Shaman - Level 50+`, and every link to it wears eqlwiki's
// red out-of-era pill — on a server that has not opened Kunark. It is not one spell: the committed
// scrape's own wikitext cache carries 168 Kunark-banner pages, 168 Velious, 17 Chardok Revamp and
// three Epics beside its 968 Classic ones, and the catalog recorded every field of those pages
// EXCEPT the badge.
//
// A JOIN, NEVER AN EDIT — the spell overlay law, stated in `spellCorrections.ts` and `spellRemovals.ts`
// and unchanged here. `spells.json` is rewritten wholesale by `npm run scrape:spells`, so anything we
// CONCLUDE about a row has to live beside the loader or it is lost on the next run and takes the
// readability of that run's diff with it. The era verdict is not even ours to conclude: it is a
// second scrape of a different endpoint (`scripts/scrape-page-era.ts` → `pageEra.json`, the sidecar
// the item and mob surfaces already read), and this module is the seam where the two meet.
//
// AND IT IS NOT `spellRemovals`, which is the pass it most resembles. A removal says EQ Legends does
// not have this spell at all; the row disappears and no surface can offer it. Out of era says the
// wiki has classified this content as belonging to an expansion this server has not opened — a
// claim with a source, about a spell that exists — so the row SURVIVES and is labeled. The level
// panel folds it away because that surface answers "what is new for me now" and the answer is not
// this; the search still shows it, because a search is a question the player asked out loud.
//
// LAW 1 AT THIS SEAM, and it is the whole reason the field is `true | absent` rather than a boolean:
//   TRUE     — `action=eqlmetadata` answered `outOfEra: true` for this page. A positive claim.
//   ABSENT   — either the endpoint said `false` (which covers both "the wiki files this as classic"
//              and "nobody has classified this page") or the table has no row for this name at all
//              (`scrape-page-era.ts` asks the enumeration ∪ the catalog's names, so this is one
//              malformed page today). Neither is a statement worth carrying, and both are drawn the
//              same way: plainly, with nothing said.
// A `false` field would invite a surface to write "in era" beside a spell nobody has classified,
// which is the one direction that shows a player content that is not there.
//
// KEYED BY THE CATALOG'S OWN NAME, through `pageEraKey` — the same fold the sidecar's other two
// tables use. The scrape asks about both spellings for exactly this reason; see its header.

import { pageEraKey } from '../pageEraDb'
import type { PageEraFile } from '../pageEraDb'
import type { SpellEntry } from '../../shared/types'
import pageEraJson from './pageEra.json'

/** What one era join did, for the boot line and the audit test that pins its census. */
export interface SpellEraReport {
  /** rows the wiki badges out of era — the ones the level panel will fold. */
  marked: number
  /** rows the table has NO verdict for: never asked, or asked and unanswered. Silence, not `false`. */
  silent: number
  /** how many spell keys the committed sidecar carries at all. */
  table: number
}

/** The committed sidecar's spell table, or an empty one when a build predates it. */
function spellVerdicts(file: PageEraFile): Record<string, boolean> {
  return file.spells ?? {}
}

/**
 * MARK THE SPELLS THE WIKI BADGES OUT OF ERA.
 *
 * NON-MUTATING, like the three passes it runs beside and for the same reason: `spells.json` is one
 * shared object for the whole process, so only the rows that change are copied.
 *
 * IDEMPOTENT: running it twice marks the same rows and copies nothing the second time.
 */
export function applySpellEra(
  spells: readonly SpellEntry[],
  file: PageEraFile = pageEraJson as PageEraFile
): { spells: SpellEntry[]; report: SpellEraReport } {
  const verdicts = spellVerdicts(file)
  const report: SpellEraReport = { marked: 0, silent: 0, table: Object.keys(verdicts).length }
  const out = spells.map((s) => {
    // ANNOTATED, and it is not decoration: this project does not run `noUncheckedIndexedAccess`, so
    // TypeScript would call a missing key a `boolean` and quietly agree that the silence branch
    // below is dead. The whole point of the table is that a key can be absent.
    const verdict: boolean | undefined = verdicts[pageEraKey(s.name)]
    if (verdict === undefined) {
      report.silent += 1
      return s
    }
    if (!verdict) return s
    report.marked += 1
    return s.outOfEra === undefined ? { ...s, outOfEra: true } : s
  })
  lastReport = report
  return { spells: out, report }
}

let lastReport: SpellEraReport | null = null

/**
 * What the last era join marked — the boot line's number (`pipeline.ts`), and null before any load.
 *
 * IT LIVES HERE rather than beside the corrections and removals reports in `spellDb.ts` for a
 * mechanical reason and a real one. The mechanical one: that file is AT the 400-line ceiling, which
 * AGENTS.md says to SPLIT rather than ratchet. The real one: this pass has two callers — the spell
 * DB and the unlock dataset, which both apply it to the same removals-filtered catalog — so the
 * number is a fact about the CATALOG rather than about one loader, and a copy cached per caller
 * would be two names for one measurement.
 */
export function spellEraReport(): SpellEraReport | null {
  return lastReport
}
