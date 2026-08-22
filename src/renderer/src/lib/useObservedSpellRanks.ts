// useObservedSpellRanks — the renderer's subscription to the observed-spell-rank module (JOS-446).
//
// The transport is the generic one every module-backed view uses (`useModule`: hydrate over
// `module:getSnapshot`, then ride `module:delta`), so nothing was added to shared/ipc.ts. The
// merge is per-KEY, the kills-style shape `useItemTiers` already rides — a delta carries only the
// lines whose rank moved, and a line nobody has touched keeps the row it had.
//
// MAIN WINDOW ONLY, like every `useModule` reader: the overlay bundle has the minimal `eqOverlay`
// bridge and no module transport. Both callers today (the unlock rows and the spell hover card)
// are main-window surfaces already, for the same reason.

import {
  applyObservedSpellRanks,
  OBSERVED_SPELL_RANKS_MODULE_ID,
  type ObservedSpellRanksDelta,
  type ObservedSpellRanksSnap
} from '@shared/spellRanks'
import { useModule } from './useModule'

/** The whole observed-rank map for the current character, or null before hydration. */
export function useObservedSpellRanks(): ObservedSpellRanksSnap | null {
  return useModule<ObservedSpellRanksSnap, ObservedSpellRanksDelta>(
    OBSERVED_SPELL_RANKS_MODULE_ID,
    applyObservedSpellRanks
  )
}
