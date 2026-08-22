// THE METER SCOPE FILTER — the view-layer half of the group model (docs/plans/group-model.md
// §2), and the half that carries the design's central promise:
//
//   A WRONG ROSTER CAN HIDE A ROW, IT CAN NEVER CORRUPT A NUMBER.
//
// Everything here is a filter over rows the engine ALREADY recorded. Nothing re-attributes,
// nothing re-folds, and switching scope re-filters the same recorded truth. So the tests below
// are mostly about two things the filter could plausibly get wrong: what survives (the
// allowlist) and what the HEADLINE says about what survived (law 5 — aggregates must not lie).
//
// One module, both renderer bundles. `features/combat/meterScope.ts` is MUI-free and JSX-free
// for exactly that reason: the Combat tab and the two floating overlays are separate entries,
// and a filter written twice is a filter that eventually disagrees with itself.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import {
  memberKeyOf,
  scopeHealers,
  scopeHealing,
  scopeSources,
  scopeTotals
} from '../src/renderer/src/features/combat/meterScope'
import { EMPTY_ROSTER, type RosterSnap } from '../src/shared/roster'
import type { HealSourceView, SourceView } from '../src/shared/combat'

// ── fixtures ──────────────────────────────────────────────────────────────────────────

const roster = (...keys: string[]): RosterSnap => ({
  members: keys.map((k) => ({
    key: k,
    name: k,
    source: 'joined' as const,
    sinceTs: 0,
    lastConfirmedTs: 0,
    stale: false
  })),
  seen: true,
  lastSignalTs: 1
})

/** A roster module that has SEEN signals but currently holds nobody — "the group ended", which
 *  is a different state from "we have been told nothing" and must not fall back to Everyone. */
const emptySeenRoster: RosterSnap = { members: [], seen: true, lastSignalTs: 1 }

function src(id: string, kind: SourceView['kind'], total: number, pct = 100): SourceView {
  return {
    id,
    name: id,
    kind,
    total,
    dps: total / 10,
    pct,
    hits: 1,
    crits: 0,
    critPct: 0,
    ambiguousHits: 0,
    ambiguousTotal: 0,
    misses: 0,
    hitPct: 100,
    missBreakdown: { miss: 0, dodge: 0, parry: 0, riposte: 0, block: 0, absorb: 0 },
    resists: 0,
    resistPct: 0,
    skills: [],
    categories: []
  }
}

function healer(id: string, kind: HealSourceView['kind'], total: number): HealSourceView {
  return {
    id,
    name: id,
    kind,
    total,
    absorbedTotal: 0,
    hps: total / 10,
    pct: 100,
    count: 1,
    crits: 0,
    critPct: 0,
    max: total,
    overheal: 0,
    overhealPct: 0,
    fullOverheal: 0,
    spells: []
  } as HealSourceView
}

/** You, your pet, two group-mates — and, since JOS-430, a combatant the log named that the roster
 *  never heard of. `other` is a row like any other to this filter: it carries the same
 *  `member:<key>` id shape and it is asked the same question of the ROSTER, so Group hides it and
 *  Everyone shows it without a rule of its own. */
const ROWS: SourceView[] = [
  src('you', 'you', 1000, 100),
  src('pet:fluffy#1', 'pet', 400, 40),
  src('member:rykkerr', 'member', 600, 60),
  src('member:dranix', 'member', 200, 20),
  src('member:scooba', 'other', 300, 30)
]

// ── the allowlist ─────────────────────────────────────────────────────────────────────

test('You scope keeps you and your pets, and nothing else', () => {
  const kept = scopeSources(ROWS, 'you', roster('rykkerr', 'dranix'))
  assert.deepEqual(kept.map((r) => r.id), ['you', 'pet:fluffy#1'])
})

test('Group scope keeps the members the roster names, and drops the ones it does not', () => {
  // Dranix left the group (or the user removed him). His damage is still RECORDED — it is
  // simply not in this scope's answer, and Everyone below still shows it.
  const kept = scopeSources(ROWS, 'group', roster('rykkerr'))
  assert.deepEqual(kept.map((r) => r.id), ['you', 'pet:fluffy#1', 'member:rykkerr'])
})

test('Everyone keeps every recorded source, including ex-members', () => {
  const kept = scopeSources(ROWS, 'everyone', roster('rykkerr'))
  assert.equal(kept, ROWS, 'and hands back the very same array')
})

test('LAW 1: Group with no roster shows EVERYONE rather than hiding people', () => {
  // An empty roster means UNKNOWN, not "you are alone". Hiding a real group-mate is the bug
  // this whole feature exists to fix, so the unknown case must never be the hiding case.
  const kept = scopeSources(ROWS, 'group', EMPTY_ROSTER)
  assert.equal(kept, ROWS)
})

test('…but a roster that has SEEN signals and holds nobody really does filter', () => {
  // The other side of `seen`: the group ended, we were told so, and Group now means "you".
  const kept = scopeSources(ROWS, 'group', emptySeenRoster)
  assert.deepEqual(kept.map((r) => r.id), ['you', 'pet:fluffy#1'])
})

// ── the headline (law 5: no aggregate that no visible row explains) ────────────────────

test('the headline is re-summed from the rows that SURVIVED, never carried over', () => {
  // `outTotal` counts you + pets + members. Leaving it under a filtered list would headline a
  // number nothing on screen accounts for — the exact "aggregates lie" failure.
  const all = 2200
  const kept = scopeSources(ROWS, 'you', roster('rykkerr', 'dranix'))
  const { total, dps } = scopeTotals(ROWS, kept, all, 220)
  assert.equal(total, 1400, 'you + pet only')
  // dps rides the same denominator (the segment's own elapsed time), so the ratio is exact.
  assert.equal(dps, 140)
})

test('an unfiltered list keeps the engine\'s own totals, to the bit', () => {
  // THE SOLO INVARIANT. Most sessions have no group at all, and they must come back byte-for
  // byte identical — same array, same numbers, no re-ranking and no rounding drift.
  const kept = scopeSources(ROWS, 'everyone', roster('rykkerr', 'dranix'))
  const { total, dps } = scopeTotals(ROWS, kept, 2200, 220)
  assert.equal(total, 2200)
  assert.equal(dps, 220)
})

test('bar widths are re-based on the surviving maximum', () => {
  // `pct` is a BAR WIDTH, not a fact about the fight. Left alone after filtering, the longest
  // remaining bar would stop short of the rail for no visible reason.
  const kept = scopeSources(ROWS, 'group', roster('rykkerr'))
  const top = kept.find((r) => r.id === 'you')
  assert.ok(top)
  assert.equal(top.pct, 100, 'the largest survivor fills the rail')
  assert.equal(kept.find((r) => r.id === 'member:rykkerr')?.pct, 60)
})

test('a zero-total scope cannot divide by zero', () => {
  const empty = scopeSources([src('member:rykkerr', 'member', 0)], 'you', roster('rykkerr'))
  assert.deepEqual(empty, [])
  assert.deepEqual(scopeTotals([src('member:rykkerr', 'member', 0)], empty, 0, 0), { total: 0, dps: 0 })
})

// ── healers ───────────────────────────────────────────────────────────────────────────

const HEALERS: HealSourceView[] = [
  healer('you', 'you', 900),
  healer('heal:fluffy', 'pet', 100),
  healer('heal:rykkerr', 'other', 500),
  healer('heal:stranger', 'other', 50)
]

test('healers scope by the same roster the damage rows do', () => {
  assert.deepEqual(
    scopeHealers(HEALERS, 'group', roster('rykkerr')).map((h) => h.id),
    ['you', 'heal:fluffy', 'heal:rykkerr'],
    'the passing stranger who topped you up is not in your group'
  )
  assert.deepEqual(scopeHealers(HEALERS, 'you', roster('rykkerr')).map((h) => h.id), ['you', 'heal:fluffy'])
  assert.equal(scopeHealers(HEALERS, 'everyone', roster('rykkerr')), HEALERS)
})

test('scopeHealing filters the model in ONE place, and by reference when it changed nothing', () => {
  // The one-builder rule (tests/healRows.test.mts) applies to the filter too: both heal
  // surfaces call THIS, so neither reaches into `healing.healers` on its own.
  const model = { healers: HEALERS, total: 1550 }
  assert.equal(scopeHealing(model, 'everyone', roster('rykkerr')), model, 'same object when nothing went')
  const scoped = scopeHealing(model, 'you', roster('rykkerr'))
  assert.deepEqual(scoped?.healers.map((h) => h.id), ['you', 'heal:fluffy'])
  assert.equal(scoped?.total, 1550, 'the rest of the model rides along untouched')
  assert.equal(scopeHealing(undefined, 'group', roster('rykkerr')), undefined)
})

// ── the key ───────────────────────────────────────────────────────────────────────────

test('memberKeyOf reads the roster key back out of a row id, and only for member rows', () => {
  assert.equal(memberKeyOf('member:rykkerr'), 'rykkerr')
  assert.equal(memberKeyOf('you'), null)
  assert.equal(memberKeyOf('pet:fluffy#1'), null)
})

// ── the two unions, pinned together ───────────────────────────────────────────────────

test('shared/roster.ts ScopeKind still spells the same set as shared/combat.ts SourceKind', () => {
  // `shared/roster.ts` is PURE (zero imports) so that the roster module, the engine and both
  // renderer bundles can compile against it, and `shared/combat.ts` already imports `RosterSnap`
  // from it — so the scope filter restates the kind union rather than importing it back. A
  // restated union is a union that can drift, and the drift would be SILENT: a seventh kind that
  // `isScopedKind` has never heard of falls through as "always visible", which is a row the Group
  // scope cannot hide. So the two lists are compared here, as text, by reading both files.
  const src = (rel: string): string => readFileSync(new URL(rel, import.meta.url), 'utf8')
  const union = (text: string, name: string): string[] => {
    const m = new RegExp(`export type ${name} =([^\\n]*)`).exec(text)
    assert.ok(m, `could not find "export type ${name}"`)
    return [...m[1].matchAll(/'([a-zA-Z]+)'/g)].map((x) => x[1]).sort()
  }
  assert.deepEqual(
    union(src('../src/shared/roster.ts'), 'ScopeKind'),
    union(src('../src/shared/combat.ts'), 'SourceKind')
  )
})
