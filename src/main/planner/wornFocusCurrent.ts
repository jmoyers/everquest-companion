// THE ACTIVE CHARACTER'S WORN FOCUS EFFECTS (JOS-452) — the one live-state wrapper over
// `wornFocusIndex.ts`'s pure join.
//
// It is a separate file for a boundary rather than for size: `wornFocusIndex.ts` is driven by the
// node runner against the committed dump, and reaching `getActiveCharacter()` from inside it would
// pull `app` in three modules deep and take that away. Everything that knows about a RUNNING app
// lives here; everything that knows about the JOIN lives next door.
//
// MEMOIZED ON THE DUMP'S OWN IDENTITY, exactly the way `gearOwnership` is (src/main/ipc/planner.ts
// carries that argument in full): path plus mtime identify the file completely, a rewrite moves the
// mtime, a character switch moves the path, and nothing anywhere has to remember to invalidate it.
//
// TWO HANDLERS READ IT — the planner's inventory payload and the spell card's `spells:detail` — so
// the resolution happens once. Two copies of it could credit two different items for one spell, and
// the whole point of the card is to name the item the readout's marker is talking about.

import { loadInventoryDump, outputStatus } from '../outputs'
import { getActiveCharacter } from '../session'
import { COMMITTED_ITEMS, committedFocusLines, wornFocusFor } from './wornFocusIndex'
import type { WornFocus } from '../../shared/wornFocus'

let resolved: { path: string; loadedAt: string; focus: WornFocus[] } | null = null

/** The active character's worn focus effects. An empty array when there is no dump to read. */
export function currentWornFocus(): WornFocus[] {
  const character = getActiveCharacter()
  const status = outputStatus('inventory', { name: character?.name, server: character?.server })
  if (status.path === null || status.updatedAt === null) {
    resolved = null
    return []
  }
  if (resolved !== null && resolved.path === status.path && resolved.loadedAt === status.updatedAt) {
    return resolved.focus
  }
  // `loadInventoryDump` re-resolves the same status, so the two can never disagree about WHICH file
  // was folded — and a dump that vanished between the stat and the read is simply no dump.
  const loaded = loadInventoryDump(character?.name, character?.server)
  if (!loaded) {
    resolved = null
    return []
  }
  const focus = wornFocusFor(loaded.dump, COMMITTED_ITEMS, committedFocusLines())
  resolved = { path: loaded.path, loadedAt: loaded.loadedAt, focus }
  return focus
}
