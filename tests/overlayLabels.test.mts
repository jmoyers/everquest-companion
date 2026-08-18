// ============================================================================
// overlayLabels.test.mts — ONE NAME PER OVERLAY WINDOW (JOS-405).
// ============================================================================
//
// This repo carried TWO overlay-label maps — `shared/shareMerge.ts`'s and the title bar's Overlay
// menu — and they DISAGREED about two windows. An import preview offered to change the background
// opacity of an "Overall meter" and an "Event feed" that the menu, three inches away, calls the
// Zone meter and the Event log. Neither spelling was wrong; having two was, because those two
// surfaces are read together: you open the menu to find the window the preview is talking about.
//
// The map now lives in `shared/overlayLabels.ts` in the MENU's wording — the name a user meets
// first, because it is what they clicked to make the window exist — and JOS-405 gave it a third
// reader, the Preferences per-overlay size list, which is why the disagreement had to end rather
// than being tolerated for a fourth time.
//
// THREE CLAIMS, all of them about a name a user reads:
//
//   1. AN IMPORT PREVIEW SAYS WHAT THE MENU SAYS. Driven through the real `planScalarChanges`,
//      because the label is built there and a map nobody reads is not a fix.
//   2. THE MENU READS THE MAP RATHER THAN CARRYING A SECOND ONE. A source pin, because the
//      regression is one literal typed back into TitleBar.tsx and nothing else would catch it.
//   3. EVERY KIND IS NAMED, AND THE LIST IS ALL TWELVE. The map is keyed by the whole union on
//      purpose (a kind with no shared field today must still be named, or the first future shared
//      field renders as a raw id), and the Preferences list has to have a row for each.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { planScalarChanges, type SettingsBundleBody } from '../src/shared/profiles'
import { OVERLAY_KINDS } from '../src/shared/types'
import type { AlertPrefs } from '../src/shared/types'
import {
  OVERLAY_KIND_LABEL,
  OVERLAY_LABEL_ORDER,
  OVERLAY_STRIP_KINDS
} from '../src/shared/overlayLabels'

const src = (rel: string): string => readFileSync(new URL(rel, import.meta.url), 'utf8')

/** The spellings the retired second map used. Kept as data because the claim is that they are
 *  GONE from what a user reads, not merely outvoted somewhere. */
const RETIRED = ['Overall meter', 'Event feed', 'Healing (fight)', 'Healing (overall)', 'Buff timers', 'Debuff timers', 'XP and motes', 'Respawn clocks']

test('an import preview names an overlay the way the Overlay menu does', () => {
  const body: SettingsBundleBody = {
    overlays: { overall: { bgAlpha: 0.5 }, events: { bgAlpha: 0.4 } }
  }
  const rows = planScalarChanges(body, { alertPrefs: {} as AlertPrefs, overlays: {}, ui: {} })
  const labels = rows.map((r) => r.label)
  assert.ok(
    labels.includes('Zone meter - background opacity'),
    `the menu calls it the Zone meter; the preview said ${labels.join(' | ')}`
  )
  assert.ok(labels.includes('Event log - background opacity'))
  for (const stale of RETIRED) {
    assert.ok(!labels.some((l) => l.startsWith(stale)), `${stale} is a name no menu in this app uses`)
  }
})

test('the Overlay menu reads the map instead of carrying a second one', () => {
  // The regression is one literal typed back into a menu row, and it would be invisible until
  // somebody read a share preview beside the menu — which is how the last one survived.
  const bar = src('../src/renderer/src/components/TitleBar.tsx')
  assert.match(bar, /OVERLAY_KIND_LABEL\[kind\]/, 'the rows render the shared name')
  assert.match(bar, /import \{ OVERLAY_KIND_LABEL \} from '@shared\/overlayLabels'/)
  // Its DESCRIPTIONS stay local on purpose — a row here has to say what the window is FOR, and
  // nowhere else in the app needs that sentence.
  assert.match(bar, /\['fight', 'Current fight \+ fight selector'\]/)
  for (const name of Object.values(OVERLAY_KIND_LABEL)) {
    assert.ok(!bar.includes(`'${name}',`), `${name} is spelled out in the menu rather than read`)
  }
  // …and shareMerge no longer declares one at all.
  const merge = src('../src/shared/shareMerge.ts')
  assert.doesNotMatch(merge, /const OVERLAY_KIND_LABEL/, 'the second map is gone, not renamed')
  assert.match(merge, /import \{ OVERLAY_KIND_LABEL \} from '\.\/overlayLabels'/)
})

test('every overlay kind is named, and the Preferences list is all twelve', () => {
  for (const kind of OVERLAY_KINDS) {
    const label = OVERLAY_KIND_LABEL[kind]
    assert.ok(typeof label === 'string' && label.length > 0, `${kind} has no name`)
    assert.notEqual(label, kind, `${kind} is rendering as its own raw id`)
  }
  // The per-overlay size list is every kind, once each — nine windows you open from the Overlay
  // menu, in that menu's order, then the three STRIPS (the ones that appear by themselves).
  assert.equal(OVERLAY_LABEL_ORDER.length, OVERLAY_KINDS.length)
  assert.equal(new Set(OVERLAY_LABEL_ORDER).size, OVERLAY_KINDS.length, 'no kind listed twice')
  for (const kind of OVERLAY_KINDS) {
    assert.ok(OVERLAY_LABEL_ORDER.includes(kind), `${kind} would have no row in Preferences`)
  }
  assert.deepEqual(OVERLAY_LABEL_ORDER.slice(-3), OVERLAY_STRIP_KINDS, 'the strips come last')
  // The one kind whose placement is a JUDGEMENT rather than a fact: the mob card IS in the
  // Overlay menu (JOS-383, so its off switch is within reach), but it is a strip, and this list
  // is about what the window IS.
  assert.ok(OVERLAY_STRIP_KINDS.includes('conCard'))
})
