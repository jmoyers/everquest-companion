// JOS-437 — THE FINISHING BLOW AA WAS COUNTED AND SHOWN NOWHERE.
//
// Report 01M0DNQQ41G1YA20N4ZM07HVWG (v1.5.0), verbatim: "The proc from Finishing Blow AA is not
// being listed anywhere (neither in melee nor under procs). Since it's a proc similar to slay
// undead AA proc, it should either have it's combat damage listing component, or at least listed
// under procs."
//
// WHAT THE INVESTIGATION FOUND, because "nobody knows what the log line looks like" was the
// ticket's first question. The line shape is not exotic and never was — it is an ORDINARY MELEE
// HIT wearing a trailing paren modifier, and all five in the reporter's slice look like this:
//
//   [Thu Aug 20 02:40:39 2026] You slash Cleric of Innoruuk for 690 points of damage. (Finishing Blow)
//   [Thu Aug 20 02:46:22 2026] You bash Cleric of Innoruuk for 445 points of damage. (Finishing Blow)
//   [Thu Aug 20 02:46:22 2026] You smite Cleric of Innoruuk for 274 points of damage. (Finishing Blow)
//   [Thu Aug 20 02:46:45 2026] You strike Cleric of Innoruuk for 4 points of damage. (Finishing Blow)
//   [Thu Aug 20 02:46:52 2026] You punch an ire ghast for 176 points of damage. (Finishing Blow)
//
// So the parser has understood it since Task #51 — `parseModifiers` recombines the two words BY
// NAME — and `tallyModifiers` has been keeping its count and its damage on `SourceStat.mods` the
// whole time. The defect is one level up and is a rendering absence, not a parsing one: nothing
// reads that map. `SourceRoundsView.modifiers` puts it on the wire and no component consumes it;
// the drill groups by SKILL, so the damage really is in the meter but smeared invisibly across
// Slash/Bash/Smite/Strike; the timeline shows the modifier only in a single event's hover. The
// reporter is describing a counted fact with no surface, and their analogy is the right one.
//
// AND IT IS A DAMAGE PROC, which is what earns it a lane rather than a footnote. Swept over the
// owner's whole 180 MB log (taxonomy.ts header carries the table): an ordinary swing of his
// means 66.3, a `(Finishing Blow)` swing means 167.8 across 1,578 of them. It correlates hard
// with a kill — of 1,729 firings the very next line is death aftermath 984 times — but it does
// NOT always finish (454 continue the fight), which is the shape of an AA gated on a health
// threshold rather than a kill annotation.
//
// THE FIX IS THE CHEAP HALF OF THE REPORTER'S "either/or", DELIBERATELY. They offered "a combat
// damage listing component, or at least listed under procs"; this does the second. Slay Undead
// got a damage CATEGORY, which MOVES its swings out of 'melee' — a Finishing Blow swing's damage
// IS a weapon swing's, and moving ~1,600 of the owner's melee lines would shift every melee
// mean, every swing denominator and the drill's whole shape to fix a listing problem. Law 8's
// tripwire says take the cheap one: this change moves no damage at all.
//
// THE FIXTURE is the reporter's own slice with every third-party character line removed
// (`tests/fixtures/jos437-finishing-blow.log`, 3,862 of the slice's 4,904 lines — no other
// player's name travels into the repo). It carries all five Finishing Blow lines AND four
// `(Slay Undead)` ones, so the analogy the report rests on is testable inside one capture.
//
// Run: `npm test`.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { parseEvent } from '../src/main/log/parser'
import { CombatEngine } from '../src/main/combat/engine'
import { FINISHING_BLOW, damageCategory, parseModifiers } from '../src/main/combat/taxonomy'
import { procAnnotationFor, procListRows, procSummary, procTagIndex } from '../src/renderer/src/features/combat/procRows'
import { flattenSkills } from '../src/renderer/src/features/combat/dashboardData'
import { ORIGIN_COLOR } from '../src/renderer/src/features/combat/markerStyle'
import type { ProcLaneView } from '../src/shared/procAnalytics'
import type { SegmentView } from '../src/shared/combat'

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), 'fixtures')
const PATH = join(FIXTURES, 'jos437-finishing-blow.log')
const LINES = existsSync(PATH) ? readFileSync(PATH, 'utf8').split(/\r?\n/).filter((l) => l.length > 0) : []
const skip = LINES.length === 0 ? 'fixture not present' : false

/** Replay the fixture and hand back the segment with the given id, defaulting to the zone. */
function segment(id = 'zone'): SegmentView {
  const eng = new CombatEngine()
  let seq = 0
  let lastTs = 0
  for (const raw of LINES) {
    const ev = parseEvent(raw, seq++)
    if (ev) {
      lastTs = ev.ts
      eng.ingestEvent(ev, false)
    }
  }
  const s = eng.snapshot(lastTs, { selectedId: id }).selected
  assert.ok(s, `the ${id} segment resolves`)
  return s
}

const lane = (seg: SegmentView, name: string): ProcLaneView | undefined =>
  (seg.procs.lanes ?? []).find((l) => l.name === name)

const rowNames = (seg: SegmentView): string[] => {
  const you = seg.entities.find((e) => e.id === 'you')
  assert.ok(you, 'a You row exists')
  return flattenSkills(you).map((r) => r.name)
}

// ── 1. THE LINE SHAPE — the ticket's opening question ─────────────────────────────────

test('JOS-437: the log line is an ordinary melee hit with a two-word paren modifier', () => {
  const raw = '[Thu Aug 20 02:40:39 2026] You slash Cleric of Innoruuk for 690 points of damage. (Finishing Blow)'
  const ev = parseEvent(raw, 0)
  assert.ok(ev, 'it parses at all — this was never an unknown shape')
  assert.equal(ev.kind, 'damage')
  const d = ev as { dtype: string; amount: number; modifiers?: string[]; category: string; skill: string }
  assert.equal(d.dtype, 'melee', 'the grammar is the melee one, verb and all')
  assert.equal(d.amount, 690)
  assert.deepEqual(d.modifiers, [FINISHING_BLOW], 'and the two words arrive as ONE token')
})

test('JOS-437: the modifier does NOT move the swing out of the melee category', () => {
  // The whole reason this ticket is a listing fix and not a taxonomy one. Contrast with the
  // line below it, which is the analogy the reporter drew and which DOES re-categorize.
  assert.equal(damageCategory('melee', parseModifiers('Finishing Blow')), 'melee')
  assert.equal(damageCategory('melee', parseModifiers('Slay Undead')), 'slay')
})

test('JOS-437: the splitter survives the compounds the log actually prints', () => {
  // Re-swept 2026-08-20: `Strikethrough` went from 1 line to 1,754 and now compounds three deep,
  // which is exactly the case that would break a naive space-split of "Finishing Blow".
  assert.deepEqual(parseModifiers('Riposte Finishing Blow'), [FINISHING_BLOW, 'Riposte'])
  assert.deepEqual(parseModifiers('Strikethrough Finishing Blow'), [FINISHING_BLOW, 'Strikethrough'])
  assert.deepEqual(parseModifiers('Riposte Strikethrough Finishing Blow'), [FINISHING_BLOW, 'Riposte', 'Strikethrough'])
})

// ── 2. THE REPORTED ABSENCE, AND WHAT REPLACED IT ────────────────────────────────────

test('JOS-437: the slice now lists Finishing Blow in the proc lane', { skip }, () => {
  const seg = segment()
  const l = lane(seg, FINISHING_BLOW)
  assert.ok(l, 'the lane the report asked for exists')
  assert.equal(l.origin, 'aa')
  // FOUR, not five: the fixture spans a zone reload at 02:42 (`LOADING, PLEASE WAIT...` →
  // `You have entered The Plane of Hate.`), which ends a zone session, and the 690 firing sits
  // before it. Its own fight segment still carries it — asserted below.
  assert.equal(l.count, 4)
  assert.equal(l.directDamage, 445 + 274 + 4 + 176)
  // …and it reaches the panel that the report says it was missing from.
  const row = procListRows(seg.procs).find((r) => r.name === FINISHING_BLOW)
  assert.ok(row, 'the Procs cell has a row for it')
  assert.equal(row.count, 4)
  assert.match(row.ppm, /ppm$/, 'with a rate, not an em dash')
})

test('JOS-437: the reporter’s analogy holds — both AAs are lanes in the same capture', { skip }, () => {
  const seg = segment()
  const slay = lane(seg, 'Slay Undead')
  const fb = lane(seg, FINISHING_BLOW)
  assert.ok(slay && fb, 'the slice carries both, which is why it is the fixture')
  assert.equal(slay.origin, 'slay')
  assert.equal(fb.origin, 'aa')
  // They share every structural property that matters: no source window to divide by, the same
  // swing denominator, and a marginal because neither one's damage is the damage it ADDED.
  for (const l of [slay, fb]) {
    assert.equal(l.rate.sourceAmbiguous, undefined, 'an innate AA has no span that could have been off')
    assert.equal(l.rate.sourceName, undefined)
    assert.equal(l.rate.swings, seg.procs.overall?.swings)
    assert.notEqual(l.marginalDamage, undefined)
  }
})

test('JOS-437: the firing before the zone reload is not lost, it is in its own fight', { skip }, () => {
  // e4 is the 02:40:39 kill. This pins the segmentation as much as the lane: a zone reload ends
  // a zone session, and the fight beneath it keeps its own ledger.
  const l = lane(segment('e4'), FINISHING_BLOW)
  assert.ok(l, 'the 690 firing has a lane in the fight it happened in')
  assert.equal(l.count, 1)
  assert.equal(l.directDamage, 690)
})

// ── 3. LAW 8 — the listing fix moves no damage ───────────────────────────────────────

test('JOS-437: the lane MOVES NO DAMAGE — the swings stay melee, in the weapon rows', { skip }, () => {
  const seg = segment()
  const you = seg.entities.find((e) => e.id === 'you')
  assert.ok(you)
  // No row was minted for it. Its damage is inside Bash/Smite/Strike/Melee, mixed with the
  // ordinary swings — which is the honest place for a weapon swing's damage, and the reason the
  // lane tags no drill row (procViews.procSkillTags).
  assert.ok(!rowNames(seg).includes(FINISHING_BLOW), 'no Finishing Blow damage row appears')
  const melee = you.categories.find((c) => c.category === 'melee')
  assert.ok(melee, 'the melee category is still where those four swings live')
  const fb = lane(seg, FINISHING_BLOW)
  assert.ok(fb)
  assert.ok(melee.total > fb.directDamage, 'their damage is a SUBSET of it, not a sibling of it')
  // And nothing was double-booked into the segment's outgoing total.
  assert.equal(you.total, seg.outTotal)
  assert.equal(seg.outTotal, 54105)
})

test('JOS-437: an aa lane annotates no drill row at all', { skip }, () => {
  const seg = segment()
  const index = procTagIndex(seg.procs.procSkills)
  assert.equal((seg.procs.procSkills ?? []).filter((t) => t.origin === 'aa').length, 0)
  // The two ways to tag it are both worse than none: the weapon rows are ~99% ordinary attacks,
  // and a minted row would re-show damage the meter already shows. So Bash stays plain…
  assert.equal(procAnnotationFor(index, 'Bash'), undefined)
  assert.equal(procAnnotationFor(index, FINISHING_BLOW), undefined)
  // …while the slay lane, which HAS a merged row of its own, keeps its tag.
  assert.ok(procAnnotationFor(index, 'Slay Undead'), 'the analogy stops exactly here, on purpose')
})

// ── 4. THE MARGINAL — an estimate, with its baseline stated ──────────────────────────

test('JOS-437: the marginal subtracts the swings the proc did NOT ride', { skip }, () => {
  const seg = segment()
  const you = seg.entities.find((e) => e.id === 'you')
  assert.ok(you)
  const melee = you.categories.find((c) => c.category === 'melee')
  assert.ok(melee)
  const fb = lane(seg, FINISHING_BLOW)
  assert.ok(fb)
  // THE ONE SUBTRACTION THAT SEPARATES THIS FROM slayLanes: a slay swing left the melee
  // category, so `melee` there is already the ordinary body; these four are still inside it, so
  // they come out of the baseline before the mean is taken. Using the contaminated mean would
  // understate the excess by counting the proc against itself.
  const plainMean = (melee.total - fb.directDamage) / (melee.hits - fb.count)
  assert.ok(Math.abs((fb.marginalDamage ?? 0) - (fb.directDamage - fb.count * plainMean)) < 1e-9)
  assert.ok((fb.marginalDamage ?? 0) < fb.directDamage, 'the marginal is ALWAYS below the raw total')
})

test('JOS-437: a marginal may go NEGATIVE on a small sample, and is not clamped', { skip }, () => {
  // e9's two firings are the 4 and the 176 — both below that segment's ordinary mean, so the
  // estimate says "these procs landed for LESS than a plain swing would have". That is what the
  // sample says and the type already calls itself an estimate; clamping it at zero would invent
  // a floor the data does not have. Pinned so a later tidy-up cannot quietly add one.
  const l = lane(segment('e9'), FINISHING_BLOW)
  assert.ok(l)
  assert.equal(l.count, 2)
  assert.equal(l.directDamage, 4 + 176)
  assert.ok((l.marginalDamage ?? 0) < 0, 'negative, and left that way')
})

// ── 5. THE VOCABULARY — it is a proc, and it reads as its own thing ──────────────────

test('JOS-437: an aa lane counts as a PROC in the headline, never as a click', { skip }, () => {
  const s = procSummary(segment().procs)
  assert.equal(s.clicks, 0, 'nothing here is a button press')
  // The four firings are inside the headline count — an AA that fires on its own is exactly what
  // "proc" means, which is the JOS-438 distinction landing on the right side this time.
  const lanes = segment().procs.lanes ?? []
  assert.equal(s.count, lanes.reduce((n, l) => n + l.count, 0))
  assert.doesNotMatch(s.header, /click/)
})

test('JOS-437: the aa hue is its own, and reads as slay’s sibling rather than its twin', () => {
  assert.notEqual(ORIGIN_COLOR.aa, ORIGIN_COLOR.slay)
  assert.notEqual(ORIGIN_COLOR.aa, ORIGIN_COLOR.spell)
  assert.notEqual(ORIGIN_COLOR.aa, ORIGIN_COLOR.poison)
  assert.notEqual(ORIGIN_COLOR.aa, ORIGIN_COLOR.click)
})
