// lib/itemSources.ts — "where does this item come from?", answered locally from the committed
// mob catalog, for EVERY renderer surface that asks per item.
//
// It began life as the planner's own `features/planner/sourceIndex.ts` and was promoted here the
// moment a SECOND consumer appeared (the Loot tab's item drill-down, 2026-08-04). The reason is
// not tidiness: the index is a ~33k-link inversion of `data/eqlegends/mobs.json`, and two feature
// modules each building their own would pay for it twice and answer the same question from two
// tables. There is ONE lazy singleton, in lib/, and both features read it.
//
// AND THE PURE HALF MOVED AGAIN (fork decision, kaltinril 2026-08-25), to `shared/itemSources.ts`,
// when MAIN became the third consumer: the gear index carries each row's drop columns on the wire
// now (data-server ruling 4 — the renderer never munges domain data), and the merge it needs was
// stuck behind a bundled-JSON singleton only this process could load. The builder, the key, the
// two-witness merge and the drop fold are all re-exported from here, so no call site and no test
// path moved; what THIS file owns is the window-lifetime index over the bundled catalog.
//
// The planner keeps `features/planner/sourceIndex.ts` as a re-export so its own vocabulary
// (`PlannerSource`) and its node test's import path both still resolve to this file.
//
// WHY THIS DATA IS ALREADY HERE. `data/eqlegends/mobs.json` is bundled into the renderer for the
// Mobs tab (mobSearch.ts), and every mob page states its `|known_loot`. Inverting that list gives
// an item → mobs index for free — no IPC, no network, works offline.
//
// LAZY, NEVER AT MODULE LOAD — the mobSearch precedent. Neither the Planner nor an item
// drill-down may ever be opened this session, and the catalog is immutable, so the index is built
// on first use and lives for the window's lifetime.

import type { MobEntry } from '@shared/types'
// RELATIVE value import (house law, the mobSearch.ts precedent): the `@shared` alias exists only
// inside the vite build, and `tests/plannerSourceIndex.test.mts` reaches this module under the
// node runner. Type-only imports are erased, so they keep the alias.
import { buildSourceIndex, type ItemSource, type SourceIndex } from '../../../shared/itemSources'
import mobsJson from '../data/eqlegends/mobs.json'

export {
  buildSourceIndex,
  dropDetails,
  mergeItemSources,
  sourceItemKey,
  type DropDetails,
  type ItemSource,
  type SourceIndex
} from '../../../shared/itemSources'

interface MobCatalog {
  scrapedAt: string
  source: string
  mobs: MobEntry[]
}

const catalog = mobsJson as unknown as MobCatalog

/** Built on first use, never at module load. The catalog is immutable, so one build is enough. */
let INDEX: Map<string, ItemSource[]> | null = null

export function sourceIndex(): SourceIndex {
  INDEX ??= buildSourceIndex(catalog.mobs ?? [])
  return INDEX
}

/**
 * Every known drop source for an item key, or `[]` — which is an HONEST answer, not a gap: quest
 * rewards and player-crafted items legitimately drop from nobody, and the caller carries those
 * flags itself. A surface says "no known source" only when the flags are absent too.
 */
export function sourcesFor(key: string): readonly ItemSource[] {
  return sourceIndex().get(key) ?? []
}
