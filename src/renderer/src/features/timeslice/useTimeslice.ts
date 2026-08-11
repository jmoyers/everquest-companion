// useTimeslice — THE PICK, shared by every surface that has a slice control (JOS-130).
//
// The definitions are pure and live in `shared/timeslice.ts`; this file is the two things a
// renderer has to add to them: a subscription to the `progression` snapshot the slice is resolved
// against, and the ONE place the user's choice is kept.
//
// WHY THE CHOICE IS APP-WIDE AND NOT PER TAB. The ticket is "one control everywhere", and a
// control that reads `Session` on the Loot tab while the Leveling tab quietly still reads `All`
// is two controls wearing one design. A reader who narrows to this session and then goes looking
// for the xp rate behind those drops is asking ONE question; the answer follows them.
//
// IT IS SESSION-LIFETIME AND UNPERSISTED, exactly like the timescale it absorbs (JOS-71) and the
// chart's range selection: a slice is a thing you choose while you are looking, not a preference,
// and ALL TIME IS THE DEFAULT EVERY TIME THE APP STARTS (owner direction 2026-08-09). A store key
// would mean a user who once looked at one zone comes back tomorrow to a ledger that is quietly
// hiding most of their loot.
//
// The store is a five-line external store rather than a context: every consumer is a leaf, the
// value is two scalars, and `useSyncExternalStore` over a VERSION counter is the whole thing (a
// getSnapshot returning a fresh object would re-render forever).

import { useCallback, useMemo, useSyncExternalStore } from 'react'
import type { ProgressionDelta, ProgressionSnap } from '@shared/types'
import {
  availableSlices,
  resolveSlice,
  resolveSliceId,
  type SliceId,
  type SliceRange,
  type Timeslice
} from '@shared/timeslice'
import { useModule } from '../../lib/useModule'
import { EMPTY_PROGRESSION, applyProgressionDelta } from '../leveling/progressionDelta'
import { dataBounds, type DataBounds } from '../leveling/zoneBands'

let pickedId: SliceId = 'all'
let pickedCustom: SliceRange | null = null
let version = 0
const listeners = new Set<() => void>()

function subscribe(cb: () => void): () => void {
  listeners.add(cb)
  return () => listeners.delete(cb)
}

function getVersion(): number {
  return version
}

function emit(): void {
  version++
  for (const cb of [...listeners]) cb()
}

/** Reset to the default. Exported for tests and for a character rebuild that wants a clean slate;
 *  nothing in the app calls it today, and a slice surviving a character switch is fine because
 *  `resolveSliceId` degrades a pick the new record cannot define. */
export function resetTimeslice(): void {
  pickedId = 'all'
  pickedCustom = null
  emit()
}

export interface TimesliceState {
  /** The snapshot the slice was resolved against — handed back so a consumer that also needs
   *  `rangeStats` does not subscribe to the same module twice. */
  prog: ProgressionSnap
  /** Where the record starts and ends, or null when nothing carries a timestamp. */
  bounds: DataBounds | null
  /** The ids this record can offer, in render order (`shared/timeslice.availableSlices`). */
  available: SliceId[]
  /** The resolved slice — range, zone filter and wording. The whole object travels together. */
  slice: Timeslice
  /** The pick AFTER `resolveSliceId`, which is what the control must render as selected. */
  id: SliceId
  setId: (id: SliceId) => void
  custom: SliceRange | null
  setCustom: (range: SliceRange | null) => void
}

const NO_EXTRA: readonly number[] = []

/**
 * The slice in force on this surface.
 *
 * `extraTs` widens the record's bounds with series the progression snapshot does not carry — the
 * Leveling tab's level dings and AA gains. Pass a MEMOIZED array; it is a dependency.
 */
export function useTimeslice(extraTs: readonly number[] = NO_EXTRA): TimesliceState {
  const prog = useModule<ProgressionSnap, ProgressionDelta>('progression', applyProgressionDelta) ?? EMPTY_PROGRESSION
  useSyncExternalStore(subscribe, getVersion, getVersion)

  const bounds = useMemo(() => dataBounds(prog, extraTs), [prog, extraTs])
  const available = useMemo(() => availableSlices(prog, bounds), [prog, bounds])
  // A pick the record can no longer define degrades to `all` rather than to a window the log
  // cannot fill — the `resolveTimescale` rule this absorbs, over a wider id space.
  const id = resolveSliceId(pickedId, prog, bounds)
  const custom = pickedCustom
  const slice = useMemo(() => resolveSlice({ snap: prog, bounds, id, custom }), [prog, bounds, id, custom])

  const setId = useCallback((next: SliceId) => {
    pickedId = next
    emit()
  }, [])
  const setCustom = useCallback((range: SliceRange | null) => {
    pickedCustom = range
    // Choosing a range IS choosing the custom slice — a control that made you press two buttons
    // to see what you just typed would be stating the pick twice.
    if (range) pickedId = 'custom'
    emit()
  }, [])

  return { prog, bounds, available, slice, id, setId, custom, setCustom }
}
