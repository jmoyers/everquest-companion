// pointerExit — THE ORPHANED TOOLTIP, AND THE ONE PLACE IT IS KILLED (JOS-358).
//
// THE REPORT (owner, hands-on, 2026-08-14): "when your mouse leaves the window its sometimes
// leaving a tooltip behind". A native `title` popup that outlives the pointer is worse here than
// anywhere else in the app: these windows are ALWAYS ON TOP, so the stranded popup sits over the
// GAME, and the window it belongs to may be click-through — there is nothing left to hover, and
// therefore nothing that can un-hover it.
//
// WHY AN OVERLAY WINDOW IS THE HARD CASE, and why the ordinary DOM story is not enough. Chromium
// takes a tooltip down when the widget is told the pointer left. It is told that by a mouse-leave
// the OS delivers to the window — and these windows spend most of their life under
// `setIgnoreMouseEvents(true, {forward:true})`, where the moves arriving are FORWARDED samples
// rather than a real hover. The cursor jumping onto the game does not have to produce a leave at
// all. So a leave is not one event here; it is whichever of these happens first:
//
//   1. the pointer leaves the DOCUMENT (the ordinary case, when the window owns the mouse);
//   2. the WINDOW loses focus, or the page is hidden — the alt-tab / click-into-the-game case;
//   3. the overlay RELEASES its capture (useOverlayChrome): the last named reason letting go is
//      this window saying "nothing here needs the mouse any more", which is exactly the moment a
//      pinned overlay stops being able to observe a leave for itself;
//   4. MAIN WATCHED THE CURSOR WALK OFF (JOS-381) — the only one that does not come from this
//      window, and the one for the case where NONE of the first three can ever fire. While the
//      Windows task switcher is up it owns input: the forwarded move that captured this window
//      arrived, nothing arrives afterwards, and by the time the switcher closes the pointer is
//      elsewhere. There is no blur (the overlay never had the foreground), no visibility change,
//      no leave, and no reason letting go — so main watches the cursor for the seconds a locked
//      overlay is capturing and says so (src/main/pointerWatch.ts).
//
// HOW A NATIVE TOOLTIP IS DISMISSED. There is no API for it. What there is: removing the `title`
// attribute takes the popup down, because the widget re-reads the attribute it is drawing from.
// So the exit STRIPS every live title and puts each one back on the next task — by then the popup
// is gone, and Chromium re-arms a tooltip only on a fresh mouse move over the element, so the
// restore cannot resurrect what was just dismissed.
//
// IT IS ALSO THE SIGNAL THE FEED'S HOVER CARDS RIDE. The event log's item/mob cards are a
// FEATURE, not a tooltip (they survived the JOS-358 sweep), but they have the same defect: a card
// mounted on `mouseenter` and unmounted on `mouseleave` is orphaned by the same missing leave.
// They subscribe here rather than growing a second opinion about what "the pointer left" means.
//
// MUI-FREE, and framework-free: plain DOM, like cursorRing.ts. It is imported by the overlay
// entry point (main.tsx) so every KIND gets it — including the celebration toast, which has no
// OverlayHeader and no chrome hook of its own.

/**
 * The slice of an element this module touches. Narrow on purpose: it is what makes the strip /
 * restore bookkeeping — the load-bearing half — testable under node with no DOM
 * (tests/overlayTooltipPolicy.test.mts).
 */
export interface TitleHolder {
  getAttribute: (name: 'title') => string | null
  removeAttribute: (name: 'title') => void
  setAttribute: (name: 'title', value: string) => void
  readonly isConnected: boolean
}

/**
 * Take every one of these titles off, and answer with the function that puts them back.
 *
 * TWO RULES IN THE RESTORE, and both are about not fighting whoever else owns the DOM:
 *   - a DETACHED element is skipped. React may have replaced the row while the popup was down;
 *     writing to a node nobody is holding is a leak of exactly one attribute, forever.
 *   - an element that has GROWN A TITLE AGAIN in the meantime keeps the new one. React re-renders
 *     against its own previous props rather than against the DOM, so a re-render that restores the
 *     attribute is the only writer that can beat us here — and it is the one whose answer is
 *     current.
 */
export function stripTitles(els: readonly TitleHolder[]): () => void {
  const saved: { el: TitleHolder; title: string }[] = []
  for (const el of els) {
    const title = el.getAttribute('title')
    // An empty title draws no popup and is not worth restoring — skip it rather than carrying a
    // no-op through the bookkeeping.
    if (title === null || title === '') continue
    saved.push({ el, title })
    el.removeAttribute('title')
  }
  return () => {
    for (const { el, title } of saved) {
      if (!el.isConnected) continue
      if (el.getAttribute('title') !== null) continue
      el.setAttribute('title', title)
    }
  }
}

/** Everything that could be drawing a tooltip right now. */
function liveTitles(): TitleHolder[] {
  return [...document.querySelectorAll<HTMLElement>('[title]')]
}

/** Hover surfaces that are NOT native tooltips and must leave with the pointer too. */
const listeners = new Set<() => void>()

/**
 * Subscribe to "the pointer has left this overlay window". Returns the unsubscribe, so a caller
 * can hand it straight back from a `useEffect`.
 */
export function onOverlayPointerExit(fn: () => void): () => void {
  listeners.add(fn)
  return () => {
    listeners.delete(fn)
  }
}

/** Is an exit being delivered right now? See the re-entrancy note in `overlayPointerExited`. */
let firing = false

/**
 * The pointer has left. Dismiss the native tooltip and tell every hover surface.
 *
 * Safe to call repeatedly and from anywhere: a second call while the first restore is pending
 * finds no live titles and does nothing, and the pending restore is unaffected.
 *
 * AND SAFE TO CALL FROM INSIDE ITSELF, which is not the same property (JOS-381). One subscriber —
 * the chrome hook — answers an exit by RELEASING its capture, and releasing a capture is itself
 * leave signal 3, so the plain version of this function would call every listener a second time
 * for one departure. The guard makes the fan-out single: a nested call returns, and the outer one
 * finishes telling everybody. It never suppresses a LATER exit (the flag is cleared before this
 * returns), which is the only thing a second call could legitimately be.
 */
export function overlayPointerExited(): void {
  if (firing) return
  firing = true
  try {
    const restore = stripTitles(liveTitles())
    // The NEXT TASK, not this one: the strip has to reach the widget before the attribute comes
    // back, and a microtask runs before the browser has done anything with it.
    setTimeout(restore, 0)
    for (const fn of [...listeners]) fn()
  } finally {
    firing = false
  }
}

let installed = false

/**
 * Install the leave signals this window can hear for itself, plus main's. Idempotent — the overlay
 * entry calls it once, and calling it again (a hot reload, a second entry) must not double-fire
 * every exit.
 */
export function installOverlayPointerExit(): void {
  if (installed) return
  installed = true
  // 1. the ordinary leave, when this window owns the mouse. `mouseout` with a null `relatedTarget`
  //    is the reading that survives the pointer going to another WINDOW rather than to another
  //    element, which is the only kind of leave this file is about.
  document.documentElement.addEventListener('mouseleave', overlayPointerExited)
  document.addEventListener('mouseout', (ev) => {
    if (ev.relatedTarget === null) overlayPointerExited()
  })
  // 2. the alt-tab / click-into-the-game case. An always-on-top frameless window can lose the
  //    foreground without ever being told the pointer left it.
  window.addEventListener('blur', overlayPointerExited)
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) overlayPointerExited()
  })
  // 3. the last named capture reason letting go is raised by useOverlayChrome itself, not here.
  // 4. main's cursor watchdog — the case where none of the above can fire (JOS-381). No payload and
  //    nothing to filter: the push already went to this kind's window and nowhere else, and it
  //    means exactly what the three above mean. The subscription is never torn down; this module
  //    lives as long as the window does.
  window.eqOverlay.onPointerExit(overlayPointerExited)
}
