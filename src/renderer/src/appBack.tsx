// appBack — the React seam between the mouse's Back button and the app's back contract (JOS-201).
//
// The main process forwards ONE fact ("Back was pressed in this window", src/main/appBack.ts). The
// answer to "back to what" lives here, because it is a question about what the reader is looking
// at: an open drill-down, and behind it the navigation origin a deep link parked (JOS-43,
// navOrigin.ts). The resolution ORDER is the pure part and lives in backTargets.ts.
//
// WHY THE PROVIDER SITS ABOVE `App` (main.tsx) RATHER THAN INSIDE IT: the app-level answer is a
// FALLBACK, not a stack entry. React runs effects children-first, so an `App`-level registration
// would land BELOW any drill that mounted in the same commit only by accident of ordering — and
// "the last thing to try" is a slot, not a race. `useBackFallback` fills that slot; `useBackTarget`
// pushes the affordances in front of it.
//
// WHAT REGISTERS, and why the list is short: a target is a Back AFFORDANCE THE USER CAN SEE — the
// loot drill's arrow and the mob page's named Back, which are also the two receivers of the JOS-43
// `NavBack` object. Each registers exactly the expression its own button already runs, so the
// mouse button and the on-screen button can never mean two different things. The combat meter's
// drill breadcrumb is NOT registered: that is an in-panel expansion (drilled by default), not a
// page you arrived at, and popping it would make the Back button undo a layout rather than a
// journey. If that judgement is ever revisited, it is one `useBackTarget` call — the mechanism is
// not the argument.

import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, type ReactNode } from 'react'
import { addTarget, removeTarget, runBack, type BackTarget } from './backTargets'

interface BackRegistry {
  /** Register a visible Back affordance. Returns its unregister. */
  push: (run: () => boolean) => () => void
  /** Fill the "nothing on screen handled it" slot. Returns a reset. */
  setFallback: (run: () => boolean) => () => void
}

const NOOP_REGISTRY: BackRegistry = {
  push: () => () => undefined,
  setFallback: () => () => undefined
}

/**
 * Defaulted to a no-op registry rather than `null`, so a component that renders outside the
 * provider (a unit harness, a future second renderer entry) is inert instead of throwing. The
 * mouse button simply does nothing there, which is exactly what it did before this existed.
 */
const BackContext = createContext<BackRegistry>(NOOP_REGISTRY)

/**
 * Hosts the registry and owns the ONE subscription to the button.
 *
 * The subscription is MOUNT-ONLY and reads the stack through a ref: the set of registered targets
 * changes on every drill open, and a subscription that tore itself down and re-registered each
 * time would be re-entering the preload bridge for no reason (the same argument that keeps
 * `linkTo` memoized in appRouting.ts).
 */
export function AppBackProvider({ children }: { children: ReactNode }): React.JSX.Element {
  const stack = useRef<BackTarget[]>([])
  const nextId = useRef(0)
  const fallback = useRef<() => boolean>(() => false)

  const push = useCallback((run: () => boolean): (() => void) => {
    const id = ++nextId.current
    stack.current = addTarget(stack.current, { id, run })
    return () => {
      stack.current = removeTarget(stack.current, id)
    }
  }, [])

  const setFallback = useCallback((run: () => boolean): (() => void) => {
    fallback.current = run
    return () => {
      fallback.current = () => false
    }
  }, [])

  useEffect(() => window.eq.onAppBack(() => void runBack(stack.current, () => fallback.current())), [])

  // A stable value: both members are `useCallback`s with no dependencies, so every consumer's
  // registration effect runs exactly once per mount rather than once per render of this provider.
  const registry = useMemo<BackRegistry>(() => ({ push, setFallback }), [push, setFallback])
  return <BackContext.Provider value={registry}>{children}</BackContext.Provider>
}

/**
 * Register the Back affordance this component is rendering, for as long as it is on screen.
 *
 * `run` is read through a ref so the registration survives a re-render with a fresh closure —
 * otherwise every keystroke in a drill would churn the stack and reorder it.
 */
export function useBackTarget(run: () => boolean): void {
  const { push } = useContext(BackContext)
  const latest = useRef(run)
  useEffect(() => {
    latest.current = run
  })
  useEffect(() => push(() => latest.current()), [push])
}

/**
 * Declare the app-level answer — what Back means when nothing on screen claimed it. One caller
 * (App, handing in the JOS-43 `nav.back`), and it is a SLOT rather than a stack entry on purpose:
 * see the header.
 */
export function useBackFallback(run: () => boolean): void {
  const { setFallback } = useContext(BackContext)
  const latest = useRef(run)
  useEffect(() => {
    latest.current = run
  })
  useEffect(() => setFallback(() => latest.current()), [setFallback])
}
