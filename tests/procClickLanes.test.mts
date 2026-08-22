// JOS-438 — A HELD CLICKY IS NOT A PROC.
//
// Report 01M0BS3FJW1YWP6ZNMM41HCMS2, verbatim: "Firestrike and Gravity Flux clicky abilities (on
// my bow and earring, respectively) are given ppm (procs per minute) ratings in the dps
// breakdown, but they are not procs. That said, the rate at which I remember to click them IS
// slightly interesting, so do whatever you wish with this bug report."
//
// THE FIXTURE IS THE REPORTER'S OWN SLICE, reduced to the lines whose only actors are the player
// and the mob (`tests/fixtures/jos438-clicky-attribution.log`, 2,036 of the slice's 4,000 lines —
// no third-party player name travels into the repo). It carries all six clicky firings:
//
//   [Tue Aug 18 17:54:57 2026] You hit Master Yael for 302 points of fire damage by Firestrike.
//   [Tue Aug 18 17:54:58 2026] You hit Master Yael for 100 points of magic damage by Gravity Flux.
//   … 17:57:59 / 17:58:00 …  … 18:04:00 / 18:04:01 …
//
// and NOT ONE `You begin casting` line for either — which is exactly why they classified as procs.
// The bow's own cooldown is 120s and the firings sit 182s and 361s apart, in pairs one second
// apart. That is two hotkeys, not a chance-on-hit.
//
// WHAT IS PINNED HERE, in the order the fix runs:
//   1. the catalog reads the reporter's two items at all (part 1's parse fix is load-bearing —
//      Rain Caller's row used to be unreadable);
//   2. the gate is OWNERSHIP, and refuses to move a lane without it;
//   3. replaying the slice WITHOUT a dump reproduces the report exactly (`· proc`, ppm);
//   4. replaying it WITH the reporter's two items routes both lanes to `· click`, keeps every
//      count and every damage total identical, and prints clicks per minute instead.
//
// Run: `npm test`.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { parseEvent } from '../src/main/log/parser'
import { CombatEngine } from '../src/main/combat/engine'
// The DB-BOUND form, from the module that supplies the catalog. itemClickies.ts itself is pure and
// imports no JSON — its header carries the measurement that put it that way.
import { heldClickySpells } from '../src/main/itemLookup'
import { procAnnotationFor, procSummary, procTagIndex } from '../src/renderer/src/features/combat/procRows'
import { flattenSkills } from '../src/renderer/src/features/combat/dashboardData'
import { ORIGIN_COLOR } from '../src/renderer/src/features/combat/markerStyle'
import type { ProcLaneView } from '../src/shared/procAnalytics'
import type { SegmentView } from '../src/shared/combat'
import type { HeldCounts } from '../src/shared/types'

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), 'fixtures')
const SLICE = (): string[] => {
  const p = join(FIXTURES, 'jos438-clicky-attribution.log')
  return existsSync(p) ? readFileSync(p, 'utf8').split(/\r?\n/).filter((l) => l.length > 0) : []
}
const LINES = SLICE()
const skip = LINES.length === 0 ? 'fixture not present' : false

/** What the reporter's `/outputfile inventory` dump says, in the two rows this ticket is about.
 *  Keys are RAW and lowercased, exactly as `heldCountsFromDump` writes them. */
const REPORTER_BAGS: HeldCounts = { 'rain caller': 1, 'earring of displacement': 1 }

function zone(lines: string[], held: HeldCounts | null): SegmentView {
  const eng = new CombatEngine()
  if (held) eng.setHeldClickies(heldClickySpells(held))
  let seq = 0
  let lastTs = 0
  for (const raw of lines) {
    const ev = parseEvent(raw, seq++)
    if (ev) {
      lastTs = ev.ts
      eng.ingestEvent(ev, false)
    }
  }
  const s = eng.snapshot(lastTs, { selectedId: 'zone' }).selected
  assert.ok(s, 'the zone segment resolves')
  return s
}

const lane = (seg: SegmentView, name: string): ProcLaneView | undefined =>
  (seg.procs.lanes ?? []).find((l) => l.name === name)

const rowNames = (seg: SegmentView): string[] => {
  const you = seg.entities.find((e) => e.id === 'you')
  assert.ok(you, 'a You row exists')
  return flattenSkills(you).map((r) => r.name)
}

// ── 1. THE CATALOG ───────────────────────────────────────────────────────────────────

test('the committed DB names both of the reporter items’ instant clickies', () => {
  const held = heldClickySpells(REPORTER_BAGS)
  assert.ok(held.has('firestrike'), 'Rain Caller grants Firestrike')
  assert.ok(held.has('gravity flux'), 'Earring of Displacement grants Gravity Flux')
})

test('the item name is folded at the counting boundary — `+N` and (Exaltation) still resolve', () => {
  // A dump writes the client's spelling verbatim; law 2 folds it here and nowhere else.
  const upgraded = heldClickySpells({ 'rain caller +6': 1, 'earring of displacement (exaltation)': 1 })
  assert.deepEqual([...upgraded].sort(), ['firestrike', 'gravity flux'])
})

test('a zero count is not ownership, and an empty dump names nothing', () => {
  assert.equal(heldClickySpells({ 'rain caller': 0 }).size, 0)
  assert.equal(heldClickySpells({}).size, 0)
})

test('a spell some weapon PROCS is never admitted, however the catalog also lists it', () => {
  // `Earthquake` is an instant click on an item AND a combat effect on another. The combat
  // effect wins outright: a cast-less Earthquake of yours may well have been the weapon.
  const held = heldClickySpells({ 'boon of the garou': 1, 'shovel of ponz': 1, 'rain caller': 1 })
  assert.ok(!held.has('earthquake'), 'a combat-effect twin disqualifies the spell')
  assert.ok(held.has('firestrike'), 'and disqualifies only itself')
})

test('OWNERSHIP is the gate: the catalog alone admits nothing', () => {
  // The measured reason this is not a catalog rule (see main/itemClickies.ts): `Vampiric Curse`
  // is an instant clicky on Pestilence Scythe and a combat effect on NO item in the DB, and it
  // fires cast-less 148 times in the owner's log at a six-second melee cadence — a proc off a
  // weapon this DB has never heard of. Not holding the scythe is what keeps it a proc.
  assert.ok(!heldClickySpells(REPORTER_BAGS).has('vampiric curse'))
  assert.ok(heldClickySpells({ 'pestilence scythe': 1 }).has('vampiric curse'))
})

// ── 2. THE REPORTED BEHAVIOUR, REPRODUCED ────────────────────────────────────────────

test('JOS-438: with no dump, the slice reproduces the report exactly', { skip }, () => {
  const seg = zone(LINES, null)
  for (const spell of ['Firestrike', 'Gravity Flux']) {
    const l = lane(seg, spell)
    assert.ok(l, `${spell} has a lane`)
    assert.equal(l.origin, 'spell', 'and the engine calls it a cast-less PROC')
    assert.equal(l.count, 3)
  }
  assert.ok(rowNames(seg).includes('Firestrike · proc'), 'the meter row wears the proc marker')
  assert.ok(rowNames(seg).includes('Gravity Flux · proc'))
  // …and the drill row wears a PROCS-PER-MINUTE tag, which is the sentence that was reported.
  const tag = procAnnotationFor(procTagIndex(seg.procs.procSkills), 'Firestrike · proc')
  assert.ok(tag)
  assert.match(tag.text, /^proc( · .*ppm)?$/)
})

// ── 3. THE FIX ───────────────────────────────────────────────────────────────────────

test('JOS-438: the reporter’s own bags route both lanes to CLICK', { skip }, () => {
  const seg = zone(LINES, REPORTER_BAGS)
  for (const spell of ['Firestrike', 'Gravity Flux']) {
    const l = lane(seg, spell)
    assert.ok(l, `${spell} still has a lane`)
    assert.equal(l.origin, 'click', 'and it is no longer called a proc')
    assert.equal(l.count, 3, 'the count is the same three firings')
  }
  const names = rowNames(seg)
  assert.ok(names.includes('Firestrike · click'), 'the meter row wears the click marker')
  assert.ok(names.includes('Gravity Flux · click'))
  assert.ok(!names.includes('Firestrike · proc'), 'and no longer the proc one')
  assert.ok(!names.includes('Gravity Flux · proc'))
})

test('JOS-438: ONLY the two owned clickies move — every real proc lane is untouched', { skip }, () => {
  // The slice is a live pull, so it carries eight genuine cast-less lanes beside the two clickies
  // (Drain Spirit, Reaving Strike, Call of Sky Strike, Lifetap Strike, Earthquake, …). A gate that
  // moved any of them would be the JOS-355 phantom-row failure arriving on this lane instead.
  const shape = (s: SegmentView): string[] =>
    (s.procs.lanes ?? []).map((l) => `${l.origin} ${l.count} ${l.name} ${l.directDamage}`).sort()
  const before = shape(zone(LINES, null))
  const after = shape(zone(LINES, REPORTER_BAGS))
  const moved = after.filter((r) => !before.includes(r))
  assert.deepEqual(moved.sort(), ['click 3 Firestrike 716', 'click 3 Gravity Flux 300'])
  assert.equal(after.length, before.length, 'and no lane appeared or vanished')
  // `Earthquake` fires cast-less 23 times here and IS an instant clicky on an item — it stays a
  // proc because another item procs it, which is the disqualification working on real data.
  assert.ok(after.includes('spell 23 Earthquake 5444'))
})

test('JOS-438: the drill tag says CLICK and counts in cpm, never ppm', { skip }, () => {
  const seg = zone(LINES, REPORTER_BAGS)
  const tag = procAnnotationFor(procTagIndex(seg.procs.procSkills), 'Firestrike · click')
  assert.ok(tag, 'the click lane still tags its damage row')
  assert.doesNotMatch(tag.text, /proc/, 'the word the report objected to is gone')
  assert.doesNotMatch(tag.text, /ppm/, 'and so is the unit')
  assert.match(tag.text, /^click( · .*cpm)?$/)
  assert.match(tag.hint, /NOT a proc - an item CLICK/)
  assert.doesNotMatch(tag.hint, /Procs per minute/)
  // …and it does not wear the proc COLOUR either — half a fix reads as a proc at a glance.
  assert.equal(tag.color, ORIGIN_COLOR.click)
  assert.notEqual(tag.color, ORIGIN_COLOR.spell)
})

test('JOS-438: a real proc lane in the same slice keeps every word and hue it had', { skip }, () => {
  const seg = zone(LINES, REPORTER_BAGS)
  const tag = procAnnotationFor(procTagIndex(seg.procs.procSkills), 'Reaving Strike · proc')
  assert.ok(tag, 'the weapon proc beside the clickies is untouched')
  assert.match(tag.text, /^proc( · .*ppm)?$/)
  assert.equal(tag.color, ORIGIN_COLOR.spell)
})

test('JOS-438: clicks are counted apart from procs in the card header', { skip }, () => {
  const plain = procSummary(zone(LINES, null).procs)
  const withBags = procSummary(zone(LINES, REPORTER_BAGS).procs)
  assert.equal(withBags.clicks, 6, 'six clicks — three of each')
  assert.equal(plain.clicks, 0, 'and none at all without the dump')
  // The six leave the proc headline entirely; nothing else about it moves.
  assert.equal(withBags.count, plain.count - 6)
  assert.match(withBags.header, /· 6 clicks$/)
  assert.doesNotMatch(plain.header, /click/)
})

test('JOS-438: routing a lane moves no damage total (law 8)', { skip }, () => {
  const before = zone(LINES, null)
  const after = zone(LINES, REPORTER_BAGS)
  const total = (s: SegmentView): number => s.entities.find((e) => e.id === 'you')?.total ?? -1
  assert.equal(total(after), total(before), 'the meter is byte-identical either way')
  assert.ok(total(after) > 0)
  const dmg = (s: SegmentView, n: string): number => lane(s, n)?.directDamage ?? -1
  assert.equal(dmg(after, 'Firestrike'), dmg(before, 'Firestrike'))
  assert.equal(dmg(after, 'Firestrike'), 302 + 302 + 112)
  assert.equal(dmg(after, 'Gravity Flux'), 300)
})

test('JOS-438: a click lane divides by the segment and claims no unknown source window', { skip }, () => {
  const l = lane(zone(LINES, REPORTER_BAGS), 'Firestrike')
  assert.ok(l)
  // `sourceAmbiguous` reads "this rate is a LOWER bound, the source may have been absent". An
  // item in your bags was never absent, so the flag would be a false statement.
  assert.equal(l.rate.sourceAmbiguous, undefined)
  assert.equal(l.rate.sourceName, undefined)
})

test('JOS-438: a hand-cast is never promoted, however many clickies you own', { skip }, () => {
  // One line of the slice, with a cast in front of it: the cast explains the firing and the
  // ownership evidence has nothing to say.
  const cast = [
    '[Tue Aug 18 17:54:55 2026] You begin casting Firestrike.',
    '[Tue Aug 18 17:54:57 2026] You hit Master Yael for 302 points of fire damage by Firestrike.',
    ...LINES.filter((l) => !/by Firestrike|by Gravity Flux/.test(l))
  ]
  const seg = zone(cast, REPORTER_BAGS)
  assert.equal(lane(seg, 'Firestrike'), undefined, 'an explained firing enters no cast-less lane')
  assert.ok(rowNames(seg).includes('Firestrike'), 'and its meter row carries no marker at all')
})
