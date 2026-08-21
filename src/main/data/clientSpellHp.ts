// THE JOIN FROM A CATALOG SPELL NAME TO THE CLIENT'S HITPOINT SLOTS (JOS-396).
//
// Three lines of code and a page of reasons, which is the usual ratio for a join key in this repo.
//
// WHY IT IS A MODULE AND NOT AN INLINE LOOKUP. Two surfaces need it — the Leveling tab's unlock
// rows (`levelUnlocks.ts`) and the spell card (`spellDetail.ts`) — and law 2 says names are dirty
// and canonicalised at boundaries. Two call sites each writing their own `table[name.toLowerCase()]`
// is two opinions about what a spell's key is, and the wrong one fails SILENTLY: a spell that
// should have gained figures simply keeps showing none, which is the exact defect this ticket
// exists to fix. `spellCanonKey` is the key the client table was BUILT with (spellsUsParse.ts), so
// it is the only key that can read it back.
//
// WHY IT TAKES THE TABLE AS AN ARGUMENT rather than reaching for it. `src/main/resist/spellTable.ts`
// imports Electron, and both callers are pure node-tested modules (tests/levelUnlocks.test.mts,
// tests/spellDetailFacts.test.mts import them directly). The table is therefore threaded in from the
// IPC handler, which is already an Electron file — and that also buys the LAZINESS the ticket asks
// for for free: the handler reads `spellTableNow()` on every invoke, so a fold that happened before
// the worker resolved is rebuilt the first time somebody asks after it did, instead of baking a
// null into the dataset for the rest of the run.

import type { ClientHpFacts } from '../../shared/spellMetrics'
import type { SpellResistTable } from '../../shared/resistTypes'
import { spellCanonKey } from '../log/parseCommon'

/**
 * The client's hitpoint slots for one catalog spell name, or undefined when there is nothing to add.
 *
 * Undefined for all three of "no client install", "no row for this name" and "a row with no
 * effect-0 slot" — they are one answer to the caller (`spellMetricsAt` falls back to nothing) and
 * distinguishing them here would only invite a surface to say something about a file the user may
 * legitimately not have.
 */
export function clientHpFor(
  table: SpellResistTable | null | undefined,
  name: string
): ClientHpFacts | undefined {
  if (!table) return undefined
  const info = table[spellCanonKey(name)]
  return info?.hp && info.hp.length > 0 ? info : undefined
}
