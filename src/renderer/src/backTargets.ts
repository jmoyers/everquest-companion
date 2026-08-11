// backTargets — "what does Back mean RIGHT NOW", as pure functions (JOS-201).
//
// THE PROBLEM. JOS-43 gave the app ONE back contract (navOrigin.ts): a cross-view deep link parks
// the tab it left and Back returns there. That contract is read by a BUTTON — the loot pane's
// arrow, the mob page's named Back — and each of those buttons already knows the second half of
// the answer too: when nothing is parked, close the drill and go back to the list you came from
// (`if (!nav.back()) close()`). The mouse's Back button has no button to read. It needs the same
// answer, resolved from wherever the user is standing.
//
// THE RULE, and it is deliberately the smallest one that is not a lie: the back affordance
// currently ON SCREEN wins, and the app's parked origin is what stands behind it. So a target is
// registered by the drill that renders a Back control, unregistered when that control leaves, and
// the FALLBACK is the app-level `nav.back()`. That is why this is a stack rather than a slot: a
// drill mounts under a view that is already mounted, and the innermost thing is what a reader
// means by "back".
//
// A target REPORTS whether it handled the press, exactly like `NavBack.back()` does, so a
// registered-but-inert affordance falls through instead of silently swallowing the button. Same
// reasoning as JOS-43's boolean: the receiver owns its own fallback, and the caller keeps walking.
//
// Pure and React-free so `tests/backTargets.test.mts` can pin the resolution order without a DOM —
// the navOrigin.ts precedent, for the same reason: the rule is the thing that can quietly rot.

/** One registered back affordance. `run` performs it and reports whether it did anything. */
export interface BackTarget {
  /** Registration identity. Opaque here; the provider mints it (see appBack.tsx). */
  id: number
  run: () => boolean
}

/** The stack after a target registered. Newest LAST — the innermost affordance is the top. */
export function addTarget(stack: readonly BackTarget[], target: BackTarget): BackTarget[] {
  return [...stack, target]
}

/**
 * The stack after a target unregistered.
 *
 * BY ID, not by position: React unmounts are not guaranteed to be the reverse of mounts once two
 * drills can be alive at once (a dialog over a pane), and popping the top would then retire
 * somebody else's affordance and leave a dead closure holding the button.
 */
export function removeTarget(stack: readonly BackTarget[], id: number): BackTarget[] {
  return stack.filter((t) => t.id !== id)
}

/**
 * Press Back: the innermost target that HANDLES it wins, otherwise the app-level fallback.
 *
 * Returns whether anything at all happened, so a press with nowhere to go is a no-op rather than a
 * surprise — the same honesty `NavBack.back()` owes its callers.
 */
export function runBack(stack: readonly BackTarget[], fallback: () => boolean): boolean {
  for (let i = stack.length - 1; i >= 0; i--) {
    if (stack[i]?.run()) return true
  }
  return fallback()
}
