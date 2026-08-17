// mobs/dropEra.ts — a mob's drop list, read against the era the server is actually on (JOS-377).
//
// ONE VERDICT, NOT A SECOND OPINION. Every function here is a call into the era join the planner,
// the gear browser and the wish list already live by (`features/planner/plannerData.ts` ->
// `shared/planner/era.ts layeredVerdict`). Nothing in this file decides what a banner token means,
// which expansion outranks which, or when a zone loses to a page - four tickets argued that out
// (JOS-298/328/333/341) and a fifth rule living on the mob page would be the one thing the mob
// page must not grow. This file only builds the SUBJECT and partitions the rows.
//
// WHAT A DROP'S SUBJECT IS MADE OF, all three witnesses in hand:
//   1. the mob catalog's zones for this item key - already renderer-side (`lib/itemSources`), and
//      reached for free by handing the era join the item KEY (`donorEra` inverts the catalog).
//   2. the zones the ITEM PAGE named, which main attached (`MobDrop.eraZones`).
//   3. the item page's own era banner, which main attached (`MobDrop.eraTag`) - the witness that
//      catches a REVAMP, where the zone is worthless because the revamp replaced a classic zone's
//      contents without adding a zone.
//
// THE FOLD RULE (the same one the gear browser lives by, and the era?-hides ruling 73ad7ec9 read
// the other way round on purpose):
//   OUT     - hidden behind a "+N out of era" disclosure that expands to the rows, each chipped.
//   IN      - rendered plainly.
//   UNKNOWN - rendered PLAINLY, never hidden. This is where this surface departs from the gear
//             browser's `eraHides`, and it is not an oversight: the browser is a FILTER over a
//             corpus the player is shopping in, so "we cannot say" fails its promise the same way
//             "no" does. A mob page is a REPORT of what one wiki page states this creature drops,
//             and hiding a row nothing has a verdict about would be deleting the wiki's own claim
//             to protect a guess we never made. "The wiki lists it" and "it is not in era" are two
//             facts and both stay sayable (law 1). The row still wears its quiet `era?` chip.
//
// PURE: no React, no Electron. `tests/mobDropEra.test.mts` drives it over the committed corpus.

import type { MobDrop } from '@shared/types'
// RELATIVE value imports (the mobSearch house law): the vite-only `@shared` alias does not resolve
// under the node test runner, and the era join is reached from there.
import { sourceItemKey } from '../../lib/itemSources'
import { donorEra, type EraSubject } from '../planner/plannerData'

/**
 * A drop as the era join sees it. The KEY is the whole of layer 1's catalog half - `donorEra`
 * inverts the mob catalog itself - so a drop from a build that never annotated anything (an older
 * persistent cache, the renderer's own catalog mirror) still gets a real zone answer, and only the
 * page's banner is missing from it.
 */
export function dropEraSubject(drop: MobDrop): EraSubject {
  const subject: EraSubject = { key: sourceItemKey(drop.item) }
  // Assigned rather than spread, the wishSearch idiom: an absent field stays ABSENT instead of
  // becoming an explicit `undefined`, which reads as a claim.
  if (drop.eraTag !== undefined) subject.eraTag = drop.eraTag
  if (drop.eraZones?.length) subject.zones = drop.eraZones
  return subject
}

/** Is this drop one the wiki marks as content this server has not opened? */
export function dropIsOutOfEra(drop: MobDrop): boolean {
  return donorEra(dropEraSubject(drop)).verdict === 'out-of-era'
}

/** A drop list split by the fold rule. Both halves keep the PAGE'S OWN ORDER. */
export interface DropEraSplit {
  /** in-era and unknown, in page order - what the surface shows without being asked. */
  shown: MobDrop[]
  /** positively out of era - what the disclosure holds, and what its count names. */
  out: MobDrop[]
}

/** The one split. A list nothing is out of era in yields an empty `out`, never a disclosure. */
export function splitDropsByEra(drops: readonly MobDrop[]): DropEraSplit {
  const shown: MobDrop[] = []
  const out: MobDrop[] = []
  for (const drop of drops) (dropIsOutOfEra(drop) ? out : shown).push(drop)
  return { shown, out }
}

/** The disclosure's label. One phrase, single-sourced, so the mob page and the card cannot drift. */
export function outOfEraLabel(count: number): string {
  return `+${String(count)} out of era`
}
