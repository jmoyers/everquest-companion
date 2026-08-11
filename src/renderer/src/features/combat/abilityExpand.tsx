// WHICH ABILITY HAS ITS STATS OPEN — lifted out of the bar that draws it (JOS-116).
//
// JOS-113 made a stat-bearing ability's crit/double/triple/miss expand INLINE beneath its own bar,
// held in a `useState` inside `SkillBar`. That is the right place for it right up until the view
// unmounts: switching tabs takes the Combat tab down, and the expansion goes with the drill one
// level above it. Both are now remembered (useDrillMemory.ts), and this is how the answer reaches
// a component four levels down.
//
// WHY A CONTEXT AND NOT A PROP. The path is SegmentBody → SegmentContent → MeterRows →
// EntityLanes → SkillBar (and again into SkillChildren for a grouped row's children), across two
// call sites — the Combat tab and the Overview card — plus `EntityRow`'s own inline list on the
// Incoming direction. Threading a pair of callbacks through all of that would put two more
// parameters on five components that have no interest in either, and `max-params` is 4 for a
// reason. One context, read at the leaf, and every intermediate stays exactly as it was.
//
// AND IT DEGRADES TO WHAT IT REPLACED. With no provider above it — the floating overlay, which is
// a separate renderer entry with its own chrome, or any surface that has not opted in — the hook
// falls back to the LOCAL `useState` this feature shipped with. Nothing has to opt in to keep
// working, so a bar rendered somewhere new is never inert.

import { createContext, useCallback, useContext, useState, type ReactNode } from 'react'

export interface AbilityExpand {
  isOpen: (category: string, name: string) => boolean
  setOpen: (category: string, name: string, open: boolean) => void
}

/** null ⇒ no surface is remembering this; the leaf keeps its own state (see useAbilityExpand). */
const Ctx = createContext<AbilityExpand | null>(null)

export function AbilityExpandProvider({
  value,
  children
}: {
  value: AbilityExpand
  children: ReactNode
}): React.JSX.Element {
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>
}

/**
 * One ability bar's open state and its toggle.
 *
 * Both hooks below run unconditionally on every render — the local `useState` exists even when the
 * context wins, which costs one unused slot and keeps the hook order fixed whatever is mounted
 * above. Whichever source is in force, the RETURN is the same pair, so `SkillBar` is written once.
 *
 * `expandable` is the JOS-113 gate (a DoT tick has no stats to open), and it is answered HERE
 * rather than at the bar: a remembered key can outlive the thing it named — the same ability in a
 * later fight may have landed no crit and no multi-attack, and so may no longer be expandable at
 * all. Reporting it closed is the degrade, and it keeps the check in one place instead of once per
 * use of the pair.
 */
export function useAbilityExpand(category: string, name: string, expandable: boolean): [boolean, () => void] {
  const ctx = useContext(Ctx)
  const [local, setLocal] = useState(false)
  const stored = ctx ? ctx.isOpen(category, name) : local
  const toggle = useCallback(() => {
    if (ctx) ctx.setOpen(category, name, !ctx.isOpen(category, name))
    else setLocal((o) => !o)
  }, [ctx, category, name])
  return [expandable && stored, toggle]
}
