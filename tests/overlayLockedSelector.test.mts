// A LOCKED OVERLAY KEEPS ITS SELECTOR — and, since JOS-138, a scroll grip (P3 of
// docs/plans/combat-overlay-parity.md; owner ruling 3: "a LOCKED overlay keeps its top dropdown
// usable; click-through everywhere else", plus the owner's 2026-08-09 disposition that a pinned
// overlay must still scroll).
//
// This is a SOURCE pin rather than a behaviour test on purpose: the thing being protected is a
// wiring decision across three files plus a main-process hazard note, and none of it can be
// observed without a real always-on-top window and a real cursor (the e2e harness asserts the
// IPC half of the seam instead — see tests/e2e/overlay-sync.e2e.mts).
//
// THE HAZARD IT GUARDS. `setIgnoreMouseEvents(true, {forward:true})` installs a low-level mouse
// hook (WH_MOUSE_LL) owned by MAIN, so every system mouse event waits on our message loop and a
// blocked main freezes the user's cursor system-wide (measured — it is why the cursor ring
// deliberately does not forward). P3 was implemented by REUSING that already-paid-for forwarding
// on the meter kinds, not by adding a second sensor: the pins below are what keep it that way.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const src = (rel: string): string => readFileSync(new URL(rel, import.meta.url), 'utf8')

const METERS = {
  'the damage meter': '../src/renderer/src/overlay/OverlayMeter.tsx',
  'the healing meter': '../src/renderer/src/overlay/HealMeter.tsx'
}

test('NO NEW HOOK: main still decides forwarding per kind, in exactly one place', () => {
  const windows = src('../src/main/windows.ts')
  // ONE call site FORWARDS, and the STRIP kinds are still the ones that do not pay for the hook.
  // (The cursor ring's own `setIgnoreMouseEvents(true)` is the deliberate non-forwarding one and
  // is counted out here by the `{ forward` it does not have.)
  assert.equal((windows.match(/setIgnoreMouseEvents\(true, \{ forward/g) ?? []).length, 1)
  // …and it asks ONE predicate what the answer is. The rule moved to replayGate.ts with JOS-62,
  // which added the second reason not to forward (a historical replay is folding); JOS-378 and
  // JOS-383 added the second and third exempt kinds (the alert banner and the con card, both
  // strips on the toast's own terms) and the exemption still lives in exactly one expression.
  assert.match(windows, /forward: overlayMouseForward\(kind\)/)
  const gate = src('../src/main/replayGate.ts')
  assert.match(gate, /kind !== 'toast' && kind !== 'alertBanner' && kind !== 'conCard' && !replayRunning/)
  // The freeze-hazard note has to survive in BOTH halves: it is the reason the split exists at
  // all, and now also the reason the replay drops the hook entirely.
  assert.match(windows, /WH_MOUSE_LL/)
  assert.match(gate, /WH_MOUSE_LL/)
})

test('NO NEW CHANNEL: the capture flip rides the existing fine-grained pass-through', () => {
  const chrome = src('../src/renderer/src/overlay/useOverlayChrome.ts')
  assert.match(chrome, /window\.eqOverlay\.setIgnoreMouse\(!want\)/)
  // Exactly one place sends it, so the "what does main think the state is" bookkeeping cannot
  // be defeated by a second caller.
  assert.equal((chrome.match(/setIgnoreMouse\(/g) ?? []).length, 1)
})

test('CAPTURE IS A SET OF NAMED REASONS, released independently', () => {
  const chrome = src('../src/renderer/src/overlay/useOverlayChrome.ts')
  assert.match(chrome, /export type CaptureReason = 'window' \| 'selector' \| 'popup' \| 'scroll'/)
  // The union, not a boolean: the popup is `position: fixed` and therefore not inside the header
  // row, so moving into the open list fires the row's mouseleave. A single boolean would drop
  // capture out from under the list the user is reaching for.
  assert.match(chrome, /reasonsRef\.current\.size > 0/)
  // Interactive windows already own the mouse — a sensor firing there must send nothing.
  assert.match(chrome, /if \(!locked\) return/)
})

test('THE SELECTOR ROW IS THE ONLY INTERACTIVE PART of a locked meter', () => {
  const header = src('../src/renderer/src/overlay/OverlayHeader.tsx')
  // The header row itself carries the sensor…
  assert.match(header, /onMouseEnter=\{\(\) => capture\('selector', true\)\}/)
  assert.match(header, /onMouseLeave=\{\(\) => capture\('selector', false\)\}/)
  // …and the popup holds capture for as long as it is open.
  assert.match(header, /capture\('popup', next\)/)
  // A locked overlay is now selectable — but only when a sensor was supplied. Without one there
  // is no way for the click to land, and a chevron that did nothing would be worse than none.
  assert.match(header, /!locked \|\| chrome\.capture/)
})

test('…and the meters no longer capture the WHOLE window on hover', () => {
  for (const [who, rel] of Object.entries(METERS)) {
    const text = src(rel)
    // The old whole-window sensor. Its removal is what makes the bars genuinely click-through
    // while locked — the ruling's "click-through everywhere else".
    assert.doesNotMatch(text, /onMouseEnter=\{onEnter\}/, `${who} still captures its whole window`)
    assert.doesNotMatch(text, /onMouseLeave=\{onLeave\}/, `${who} still captures its whole window`)
    // It hands the header the precise sensor instead.
    assert.match(text, /toggleLock, capture \}/, `${who} does not give its header the sensor`)
  }
})

test('JOS-138: a pinned pane scrolls at its RIGHT EDGE, and nowhere else', () => {
  const scale = src('../src/renderer/src/overlay/overlayScale.tsx')
  // The strip is a NUMBER with a name, not a literal buried in a comparison: the e2e aims at it
  // and the comment above it is where the trade is argued.
  assert.match(scale, /export const SCROLL_GRIP_W = \d+/)
  // The grip exists only while PINNED and only with a sensor to raise — an unlocked pane already
  // owns the mouse, and a pane whose caller passes no `capture` must behave exactly as before.
  assert.match(scale, /const grip = locked && capture !== undefined/)
  // …and only while the rows genuinely overflow. Taking a click-through window's mouse for a pane
  // with nothing to scroll would be the pin's whole point spent on nothing.
  assert.match(scale, /el\.scrollHeight - el\.clientHeight > 1/)
  // The region test itself: right edge minus the strip, against the pointer's own x.
  assert.match(scale, /ev\.clientX >= el\.getBoundingClientRect\(\)\.right - SCROLL_GRIP_W/)
  // NO NEW CHANNEL AND NO NEW HOOK (the two pins above): it raises the P3 named reason over the
  // forwarding the meters already pay for.
  assert.match(scale, /capture\?\.\('scroll', want\)/)
  // The observable the hidden-window e2e reads, because `setIgnoreMouseEvents` cannot be seen
  // from inside the page.
  assert.match(scale, /data-scroll-grip=/)

  // BOTH METERS, THROUGH ONE PANE. The grip is forwarded by MeterPane so the damage and healing
  // meters cannot drift on where the edge is.
  const floor = src('../src/renderer/src/overlay/scopeFloor.tsx')
  assert.match(floor, /<OverlayContent[^>]*locked=\{locked\}[^>]*capture=\{capture\}/)
  for (const [who, rel] of Object.entries(METERS)) {
    const pane = /<MeterPane[\s\S]*?>/.exec(src(rel))?.[0] ?? ''
    assert.match(pane, /locked=\{locked\}/, `${who} does not arm the scroll grip`)
    assert.match(pane, /capture=\{capture\}/, `${who} gives the pane no sensor to raise`)
  }
})

test('the drill stays READ-ONLY while locked — only the selector was opened up', () => {
  for (const [who, rel] of Object.entries(METERS)) {
    assert.match(
      src(rel),
      /setDrill=\{locked \? null : setDrill\}/,
      `${who} made its bars clickable while locked`
    )
  }
})

test('JOS-121: the scope word is out of the title bar and onto the panel floor', () => {
  const header = src('../src/renderer/src/overlay/OverlayHeader.tsx')
  // The header row is the window's ONLY drag handle and the fight selector's whole width budget.
  // Nothing in it may render the scope again — not the tag, not its testid, not `chipLabel`.
  assert.doesNotMatch(header, /overlay-scope-label/)
  assert.doesNotMatch(header, /chipLabel|OverlayHeaderScope/)
  // …and the slice of the freed width that did NOT go to the selector is a real drag target,
  // which only works because it carries no `no-drag` (it inherits the row's drag region).
  assert.match(header, /data-testid="overlay-drag-gutter"/)

  const floor = src('../src/renderer/src/overlay/scopeFloor.tsx')
  // NON-INTERACTIVE IS THE CONTRACT, not a styling detail: the watermark stays rendered while the
  // overlay is LOCKED (unlike the header tag it replaced), so `pointerEvents: none` is the only
  // thing keeping a click-through window click-through.
  assert.match(floor, /pointerEvents: 'none'/)
  // …and it CANNOT know about the lock, because the only thing it is given is the word (JOS-358
  // took the hover that used to ride beside it). That is the whole of "it does not vanish when
  // pinned", stated as a signature rather than as a missing branch somebody could add back.
  assert.match(floor, /export function ScopeFloor\(\{ label \}: ScopeFloorText\)/)
  assert.match(floor, /export interface ScopeFloorText \{\s+label: string\s+\}/)

  for (const [who, rel] of Object.entries(METERS)) {
    const text = src(rel)
    // Both meters say it from the floor, through the SAME helper the Combat tab uses — one
    // phrasing, three renderers (the healRows.ts rule).
    assert.match(text, /<MeterPane[\s\S]*?scope=\{\{/, `${who} does not put its bars in the floor-bearing pane`)
    assert.match(text, /label: chipLabel\(meterScope, roster\)/, `${who} spells the scope itself`)
    // …and neither hands the HEADER a scope prop any more. Read off the element itself rather
    // than the file: both meters still say `scope=` — one line lower, to the pane.
    const headerEl = /<OverlayHeader[\s\S]*?\/>/.exec(text)?.[0] ?? ''
    assert.ok(headerEl.length > 0, `${who} renders no OverlayHeader`)
    assert.doesNotMatch(headerEl, /scope=/, `${who} still passes scope to its header`)
  }
})

/**
 * JOS-158 — the aggregate is out of the title bar and on the panel's own header row.
 *
 * A SOURCE PIN for the same reason as its neighbours: what is being protected is a wiring
 * decision spread over five files, and the layout half of it is measured for real against a
 * running window (tests/e2e/overlayTotalSteps.mts counts characters of a long fixture mob name in
 * the title before and after). What a unit test can hold still is that the four meter kinds share
 * ONE row, ONE label and ONE treatment — the JOS-119 no-fork rule — and that neither meter can
 * quietly put its number back in the title bar.
 */
test('JOS-158: the meters state their aggregate in the panel, not in the title bar', () => {
  const header = src('../src/renderer/src/overlay/OverlayHeader.tsx')
  // The tail is OPTIONAL now (the buffs/debuffs and event-log kinds still pass a COUNT), and a
  // header given none draws no span at all — an empty flex child would still cost the row its
  // gap, which is the width this ticket exists to hand to a mob name.
  assert.match(header, /tail\?: string/)
  assert.match(header, /tail !== undefined && tail !== ''/)

  const crumb = src('../src/renderer/src/overlay/meterCrumb.tsx')
  // ONE word, exported, so neither meter can grow a second opinion about what the number covers.
  assert.match(crumb, /export const TOTAL_LABEL = 'all'/)
  // …and it is a WORD in the row, not a hover: the label element carries the text itself.
  assert.match(crumb, /\{TOTAL_LABEL\}/)
  // VISUALLY DISTINCT FROM THE PERSONAL FIGURE (the other half of the ruling): the meter's accent
  // at full weight, where every bar's own number is plain white inside a bar.
  assert.match(crumb, /color: total\.accent, fontWeight: 700/)
  assert.match(crumb, /data-testid="overlay-total-value"/)
  // THE BACK CONTROL IS ITS OWN ELEMENT. It was split off because the aggregate beside it carried a
  // hover note (the healing split) and a note on a click target is what the tooltip rule forbids;
  // JOS-358 took the note and the split STAYS — the back target is bounded by the number rather
  // than by the row, which is the honest hit area either way.
  assert.doesNotMatch(crumb, /data-testid="overlay-crumb"[\s\S]{0,80}onClick/)
  assert.match(crumb, /flexGrow: 1,\s+minWidth: 0,\s+cursor: onBack \? 'pointer' : 'default'/)

  for (const [who, rel] of Object.entries(METERS)) {
    const headerEl = /<OverlayHeader[\s\S]*?\/>/.exec(src(rel))?.[0] ?? ''
    assert.ok(headerEl.length > 0, `${who} renders no OverlayHeader`)
    assert.doesNotMatch(headerEl, /tail=/, `${who} still puts its aggregate in the title bar`)
  }

  // BOTH BAR BODIES, THROUGH THE ONE CRUMB. Neither may state the aggregate its own way.
  const BARS = {
    'the damage bars': '../src/renderer/src/overlay/meterBars.tsx',
    'the healing bars': '../src/renderer/src/overlay/healBars.tsx'
  }
  for (const [who, rel] of Object.entries(BARS)) {
    const text = src(rel)
    assert.match(text, /total=\{total\}/, `${who} does not state the aggregate on the crumb row`)
    // The SAME figure the header used to print — moved, never recomputed, so the number a pinned
    // meter shows did not change on the day its label appeared.
    assert.match(text, /formatRate\(seg\.outDps\)|formatHealRate\(seg\?\.healing\.hps \?\? 0\)/, `${who} recomputed it`)
  }
  // …and the healing meter's restored/absorbed sentence is NOT here any more (JOS-358). It rode the
  // crumb's hover from JOS-158 until the owner ruled the overlay windows carry tooltips only in the
  // title bar; `healTotalTitle` itself is untouched, and the Combat tab's segment header still
  // prints it. Pinned as an ABSENCE so a later change cannot quietly re-import it.
  const healBars = src('../src/renderer/src/overlay/healBars.tsx')
  assert.doesNotMatch(healBars, /healTotalTitle\(/)
  assert.match(
    src('../src/renderer/src/features/combat/SegmentHeader.tsx'),
    /healTotalTitle\(seg\.healing\)/,
    'the sentence has to still be printed SOMEWHERE — the tab is where it went'
  )
})

test('the event log keeps the whole-window sensor it always had', () => {
  // It has no selector, so it never opted into the precise one — and it must not be dragged
  // along by a change that was about the meters.
  const feed = src('../src/renderer/src/overlay/EventLogOverlay.tsx')
  assert.match(feed, /onMouseEnter=\{onEnter\}/)
  assert.match(feed, /onMouseLeave=\{onLeave\}/)
})
