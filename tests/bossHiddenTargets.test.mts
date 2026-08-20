// HIDE MOBS FROM RAID TARGETS (GitHub issue #32) — the pure half of the roster's hide flag.
//
// THE REPORT: "I do not personally see much of a use in displaying all hate minis on the page
// and even plane of sky could be hideable since it's not effected by the weekly loot as well."
// "Hate minis" is not a data category — Plane of Hate's twelve targets mix Innoruuk with the
// minis — so the flag is PER TARGET, a localStorage set of lowercased names in the
// `useQuestFlags` shape (useHiddenTargets.ts), and the filter is one more input to
// `filterRoster` (rosterFilter.ts).
//
// THE ORDER IS THE DESIGN: hidden drops FIRST, before the search box and the defeated switch,
// because hiding is an identity statement about the roster ("this card is not my raid week")
// where the other two are momentary narrowings of it. `showHidden` is a PEEK, not an un-hide:
// it stops the drop so the cards can render (dimmed, with the restore control) and changes
// nothing about the set.
//
// Same fixtures as tests/bossDefeatedFilter.test.mts — real kill histories, because a
// hand-built status would assume away the interplay these tests pin (a hidden target that
// matches the search box must still be gone).
//
// Run: `npm test`.

process.env.TZ = 'America/Los_Angeles'

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { everDefeated, filterRoster } from '../src/renderer/src/features/bosses/rosterFilter'
import { history } from './bossHistories.mts'

/** An untouched toolbar, stated once. */
const none = { query: '', defeatedOnly: false, defeated: everDefeated } as const

test('a hidden target leaves the roster', () => {
  const list = history()
  const out = filterRoster(list, { ...none, hidden: new Set(['lord of ire']), showHidden: false })
  assert.equal(out.length, list.length - 1)
  assert.ok(!out.some((s) => s.target.name === 'Lord of Ire'))
})

test('the set holds LOWERCASED names and the filter lowercases before asking', () => {
  // The same casing armour useQuestFlags states: a data casing drift must not orphan a hide.
  const list = history()
  const out = filterRoster(list, { ...none, hidden: new Set(['lord of ire']), showHidden: false })
  assert.ok(!out.some((s) => s.target.name.toLowerCase() === 'lord of ire'))
})

test('showHidden is a PEEK: nothing is dropped, and the set is not consulted for membership', () => {
  const list = history()
  const out = filterRoster(list, { ...none, hidden: new Set(['lord of ire']), showHidden: true })
  assert.equal(out, list, 'peeking an otherwise-untouched toolbar hands back the same array')
})

test('hidden drops FIRST: a hidden target that matches the search box is still gone', () => {
  const list = history()
  const out = filterRoster(list, {
    ...none,
    query: 'lord of ire',
    hidden: new Set(['lord of ire']),
    showHidden: false
  })
  assert.equal(out.length, 0, 'the search box cannot resurrect what the user hid')
})

test('…and the other filters still apply to what survives the hide', () => {
  const list = history()
  const out = filterRoster(list, {
    ...none,
    defeatedOnly: true,
    hidden: new Set(['lord of ire']),
    showHidden: false
  })
  assert.ok(out.every((s) => s.killed), 'the defeated switch reads the un-hidden remainder')
  assert.ok(!out.some((s) => s.target.name === 'Lord of Ire'))
})

test('an untouched toolbar with an EMPTY hidden set hands back the same array', () => {
  // The memo-identity promise filterRoster already makes, extended to the new inputs: an empty
  // set must not churn the sectioning below it.
  const list = history()
  assert.equal(filterRoster(list, { ...none, hidden: new Set(), showHidden: false }), list)
  assert.equal(filterRoster(list, none), list, 'and the fields are optional — old call sites stand')
})
