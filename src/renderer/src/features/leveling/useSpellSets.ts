// useSpellSets — the renderer's subscription to the gem/spell-set module (JOS-391).
//
// The transport is the generic one every module-backed view uses (`useModule`: hydrate over
// `module:getSnapshot`, then ride `module:delta`), so nothing was added to shared/ipc.ts.
//
// THE MERGE IS A REPLACE, and shared/spellSets.ts states why: the whole state is a dozen gem names
// and a handful of current set definitions, every mutation touches the bar, and older definitions
// are dropped rather than kept — so there is nothing for a per-key merge to preserve. The `stale`
// predicate is the shape-version guard `useModule` documents (shared/kills.ts's precedent): a
// window still running against a restarted main re-hydrates instead of merging across shapes.

import { EMPTY_SPELL_SETS, SPELL_SETS_SHAPE_VERSION, type SpellSetsDelta, type SpellSetsSnap } from '@shared/spellSets'
import { useModule } from '../../lib/useModule'

/** The delta IS the state. Kept as a named function so the hook's contract reads at the seam. */
export function applySpellSetsDelta(_state: SpellSetsSnap, delta: SpellSetsDelta): SpellSetsSnap {
  return delta
}

/** Never null — an un-hydrated panel makes no claim about any gem, which is the honest state. */
export function useSpellSets(): SpellSetsSnap {
  return (
    useModule<SpellSetsSnap, SpellSetsDelta>(
      'spellSets',
      applySpellSetsDelta,
      (_state, delta) => delta.v !== SPELL_SETS_SHAPE_VERSION
    ) ?? EMPTY_SPELL_SETS
  )
}
