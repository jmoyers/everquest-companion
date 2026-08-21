// THE OVERLAY TOOLTIP POLICY, AND THE ORPHAN THAT MADE IT URGENT (JOS-358).
//
// OWNER RULING, 2026-08-14, from hands-on testing and release-blocking: remove tooltips on the
// overlay windows EXCEPT in the window title bar - the unlock control keeps its tooltip, the bars
// get NONE. And separately: "when your mouse leaves the window its sometimes leaving a tooltip
// behind". THEN, 2026-08-16, the exception was withdrawn: "let's drop tooltips in the overlays, even
// in the title bar". So the sweep below now covers the WHOLE bundle - the title bar's controls keep
// their words as `aria-label` (a screen reader and the e2e's selectors still find the pin by
// name), and nothing on any overlay window hands the DOM a `title` at all.
//
// Two halves, pinned two different ways:
//
//   1. THAT NO TOOLTIP LIVES ANYWHERE — a DERIVED sweep, not a list. Every file in the overlay bundle
//      is read, the `<OverlayHeader …/>` ELEMENT is cut out of each one (its `title` / `tailTitle`
//      props are the title bar's own text, travelling as props), and what is left may not carry a
//      `title=` attribute at all - the title bar's own files included since 2026-08-16. Derived because a hardcoded list is exactly what lets the next
//      surface arrive already broken — the app has learned this twice on the main window
//      (tests/tooltipCursor.test.mts, JOS-127 then JOS-143).
//
//   2. THAT IT LEAVES WITH THE POINTER — the bookkeeping in `stripTitles`, driven directly, plus
//      source pins on the three places the exit is raised from. A native tooltip is drawn by the
//      widget and is not in the DOM, so this is the layer a node test can hold; the e2e asserts the
//      observable half (the feed's hover card leaving on a window blur).
//
// No DOM and no fixture — it never skips.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { stripTitles, type TitleHolder } from '../src/renderer/src/overlay/pointerExit'

const OVERLAY = join(fileURLToPath(new URL('.', import.meta.url)), '..', 'src', 'renderer', 'src', 'overlay')

/**
 * THE TITLE BAR, as two files. `OverlayHeader.tsx` IS the bar — the lock/unlock pin, the close ✕
 * beside it, the drag gutter, the live dot, the selector's disambiguation — and `IconButton.tsx` is
 * the button primitive it draws those controls with, used nowhere else in this bundle. Under the
 * 2026-08-14 ruling these two were EXEMPT from the sweep; under the 2026-08-16 one they are swept
 * by the test that follows it, by name, because they are where the last tooltips lived.
 */
const TITLE_BAR = ['OverlayHeader.tsx', 'IconButton.tsx']

function overlaySources(): { name: string; src: string }[] {
  return readdirSync(OVERLAY)
    .filter((n) => /\.tsx?$/.test(n))
    .map((name) => ({ name, src: readFileSync(join(OVERLAY, name), 'utf8') }))
}

/**
 * The file with every `<OverlayHeader … />` element removed.
 *
 * A window passes the bar its text as PROPS (`title=`, `tailTitle=`), so those spellings appear in
 * five files that draw no tooltip of their own. Cutting the element is what makes the sweep read
 * the question it means: does anything OUTSIDE the title bar hand a `title` to the DOM.
 */
function withoutHeaderElements(src: string): string {
  return src.replace(/<OverlayHeader[\s\S]*?\/>/g, '')
}

test('JOS-358: nothing outside the title bar carries a tooltip', () => {
  const offenders: string[] = []
  for (const { name, src } of overlaySources()) {
    if (TITLE_BAR.includes(name)) continue
    if (/\btitle=/.test(withoutHeaderElements(src))) offenders.push(name)
  }
  assert.deepEqual(
    offenders,
    [],
    `the owner ruled the bars get NO tooltip; these still hover: ${offenders.join(', ')}`
  )
})

test('2026-08-16: …and neither does the title bar — its controls are NAMED, never hovered', () => {
  const header = readFileSync(join(OVERLAY, 'OverlayHeader.tsx'), 'utf8')
  const button = readFileSync(join(OVERLAY, 'IconButton.tsx'), 'utf8')
  // The primitive puts the string on the element as its accessible NAME and nowhere else: the pin
  // is still `button[aria-label^="Unlock"]` to the e2e and to a screen reader, and draws no popup.
  assert.match(button, /aria-label=\{label\}/)
  assert.doesNotMatch(button, /\btitle=/, 'IconButton still hands its label to the DOM as a tooltip')
  // The bar's other hover texts - the tail, the live dot, the selector's disambiguation - moved to
  // aria-label the same way; the drag gutter's hint is simply gone (there is nothing to name).
  // Only the <HeaderBody title={title}> PROP (the bar's own text) may still spell `title=`.
  assert.doesNotMatch(
    header,
    /^\s+title=(?!\{title\})/m,
    'OverlayHeader still hands a tooltip to the DOM'
  )
  assert.match(header, /aria-label=\{tailTitle\}/)
  assert.match(header, /aria-label=\{live \? 'In combat' : 'Idle'\}/)
})

test('the bars mount no tooltip STATE either — the wiring is deleted, not hidden', () => {
  // `Bar` is the one component both meters draw every row with. A `title` PROP surviving on it
  // would be the "hide it rather than delete it" the ruling forbids: nothing would render today and
  // the next call site would put it back.
  for (const rel of ['meterBars.tsx', 'healBars.tsx']) {
    const src = readFileSync(join(OVERLAY, rel), 'utf8')
    const bar = /function Bar\(\{[\s\S]*?\}\): JSX\.Element/.exec(src)?.[0] ?? ''
    assert.ok(bar.length > 0, `${rel} draws no Bar`)
    assert.doesNotMatch(bar, /\btitle\b/, `${rel}'s Bar still takes a tooltip`)
  }
  // Same rule one layer up: the crumb's aggregate and the XP window's rows carried hover text in
  // their view models, and those fields are gone rather than unread.
  assert.doesNotMatch(readFileSync(join(OVERLAY, 'meterCrumb.tsx'), 'utf8'), /title\?: string/)
  const xp = readFileSync(join(OVERLAY, 'xpRows.ts'), 'utf8')
  assert.doesNotMatch(xp, /^\s+title: /m, 'an XP row still builds hover text nothing renders')
  assert.doesNotMatch(xp, /spanTitle/, 'the span line still builds hover text nothing renders')
})

// ── the orphan: what "the pointer left" means, and that the title really comes back ──────────────

/** A TitleHolder over a plain object — no DOM, and every rule below is visible in it. */
function fake(title: string | null, connected = true): TitleHolder & { title: string | null } {
  return {
    title,
    isConnected: connected,
    getAttribute(): string | null {
      return this.title
    },
    removeAttribute(): void {
      this.title = null
    },
    setAttribute(_n: 'title', v: string): void {
      this.title = v
    }
  }
}

test('the dismissal takes every title off and puts every one back', () => {
  const a = fake('Unlock (interactive)')
  const b = fake('Close overlay')
  const restore = stripTitles([a, b])
  // THE DISMISSAL ITSELF: the widget draws from the attribute, so removing it is what takes the
  // popup down. There is no other API for it.
  assert.equal(a.title, null)
  assert.equal(b.title, null)
  restore()
  assert.equal(a.title, 'Unlock (interactive)')
  assert.equal(b.title, 'Close overlay')
})

test('…and the restore never fights whoever else owns the DOM', () => {
  // A row React replaced while the popup was down. Writing to it leaks one attribute forever.
  const gone = fake('Close overlay', false)
  // A re-render put a title back first — its answer is the current one.
  const rerendered = fake('Lock (click-through)')
  // Nothing to dismiss: an absent or empty title draws no popup and is not carried through.
  const bare = fake(null)
  const empty = fake('')
  const restore = stripTitles([gone, rerendered, bare, empty])
  rerendered.title = 'Unlock (interactive)'
  restore()
  assert.equal(gone.title, null, 'a detached element is left alone')
  assert.equal(rerendered.title, 'Unlock (interactive)', 'the newer title wins')
  assert.equal(bare.title, null)
  assert.equal(empty.title, '', 'an empty title draws no popup — it is left exactly as it was')
})

test('every leave signal is wired, and the entry installs them for every KIND', () => {
  const exit = readFileSync(join(OVERLAY, 'pointerExit.ts'), 'utf8')
  // 1. the pointer leaves the document — the ordinary case, when the window owns the mouse.
  assert.match(exit, /addEventListener\('mouseleave', overlayPointerExited\)/)
  assert.match(exit, /relatedTarget === null/)
  // 2. the window loses the foreground. An always-on-top frameless window can lose it without ever
  //    being told the pointer left — the owner's report is the cursor flicking onto the game.
  assert.match(exit, /addEventListener\('blur', overlayPointerExited\)/)
  assert.match(exit, /document\.hidden/)
  // …and installing twice must not double-fire every exit.
  assert.match(exit, /if \(installed\) return/)

  // 3. the overlay releasing its capture. This is the signal a PINNED window has instead of a
  //    leave: main is about to start ignoring mouse events again, so nothing after this point can
  //    un-hover anything.
  const chrome = readFileSync(join(OVERLAY, 'useOverlayChrome.ts'), 'utf8')
  assert.match(chrome, /if \(!want\) overlayPointerExited\(\)/)
  // …and pinning is a leave too: the press that locks the window is made ON the control whose
  // tooltip is up.
  const toggle = /const toggleLock = [\s\S]*?\n {2}\}/.exec(chrome)?.[0] ?? ''
  assert.match(toggle, /overlayPointerExited\(\)/, 'locking leaves the pin tooltip stranded')

  // 4. MAIN WATCHED THE CURSOR WALK OFF (JOS-381) — the signal for the case none of the first
  //    three can cover: while the Windows task switcher owns input, a captured overlay is told
  //    nothing at all until the pointer comes back. It arrives over IPC and means exactly what the
  //    others mean, so it is installed beside them. The watchdog itself (and the price it is
  //    allowed to cost) is pinned in tests/pointerWatch.test.mts.
  assert.match(exit, /window\.eqOverlay\.onPointerExit\(overlayPointerExited\)/)
  // …and because signal 3 is raised BY a listener of this very fan-out, the fan-out is guarded
  // against re-entering itself: one departure, one round of listeners.
  assert.match(exit, /if \(firing\) return/)

  // EVERY KIND, including the celebration toast — which has no OverlayHeader and no chrome hook,
  // so the entry point is the only place that reaches all seven.
  const main = readFileSync(join(OVERLAY, 'main.tsx'), 'utf8')
  assert.match(main, /installOverlayPointerExit\(\)/)
})

test('the feed hover card leaves with the pointer too — it is a feature, not a tooltip', () => {
  // The event log's item/mob cards SURVIVED the sweep (they are the row's answer to "is there more
  // here", not a restatement of its label), so they have to ride the same exit rather than grow a
  // second opinion about what a leave is: they mount on `mouseenter` and unmount on `mouseleave`,
  // which is the identical defect a native tooltip has out here.
  const layer = readFileSync(join(OVERLAY, 'hoverCardLayer.tsx'), 'utf8')
  assert.match(layer, /onOverlayPointerExit\(onDismiss\)/)
  // …through the OWNING ROW's own close path, so the layer never unmounts itself behind the state
  // that mounted it.
  const feed = readFileSync(join(OVERLAY, 'EventLogOverlay.tsx'), 'utf8')
  assert.equal((feed.match(/<HoverCardLayer anchor=\{anchor\} onDismiss=\{leave\}>/g) ?? []).length, 2)
})
