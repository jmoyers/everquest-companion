// useWornFocus — what the character's GEAR is doing to their casts (JOS-452).
//
// A one-line reader over `usePlannerInventory`, and the indirection is the point: main resolves the
// focus effects onto the inventory payload (the same fact, the same file, the same push), so this
// feature needs no channel of its own and re-reads itself whenever the player types
// `/outputfile inventory`. A surface that wants the focus set asks for the focus set and never has
// to know it arrives on the planner's door.
//
// NO DUMP, NO DUMP FIELD, OR NOTHING WORN THAT CARRIES ONE all answer the SAME empty list, which is
// the base reading: every figure in the app is byte-identical to what it was before this overlay.
// An empty array rather than null for exactly that reason - there is no "we do not know yet" state
// a caller could do anything different with, and a null would make every reader write a `?? []`.

import { useMemo } from 'react'
import type { WornFocus } from '@shared/wornFocus'
import { usePlannerInventory } from '../features/planner/plannerInventory'

/** Stable across renders while the dump has not changed, so a memoized fold below it is not woken. */
const NONE: readonly WornFocus[] = []

export function useWornFocus(): readonly WornFocus[] {
  const { inventory } = usePlannerInventory()
  const focus = inventory?.focus
  return useMemo(() => focus ?? NONE, [focus])
}
