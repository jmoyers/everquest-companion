// PER-ABILITY STATS, INLINE (JOS-113) — the correction to JOS-105's level-3 category drill.
//
// The owner's ask, verbatim: "one bar per ability, flat — Dragon Punch, Melee, Kick, each its own
// bar. NO category grouping layer, NO category strip. Click an ability that has stats and the
// ability's own stats appear inline: crit %, double attack %, triple attack %, miss rate.
// Abilities with no such stats (a DoT tick) are not clickable." So the double/triple that JOS-105
// filed under a CATEGORY is filed under the ABILITY now, and clickability is a per-ability gate.
//
// THE ROUND-FILING JUDGEMENT SHRANK, AND THIS PINS WHAT IS LEFT. JOS-105 had to decide which
// CATEGORY an attack round belonged to (the Bash-in-two-categories tie, the flurry-once rule).
// With stats attached per ability, a round lane's counters are simply that lane's ability's — a
// lane names exactly one ability. The only tie left is the same one, expressed as skill-first-wins:
// the "Bash" lane is the melee Bash ability's, never the slay Bash proc's, because the round is the
// swing that opened it. Flurry stays un-splittable (law 6) and rides the auto-attack ability alone.
//
// This replaces tests/categoryDrill.test.mts. The shaping module (multiAttackRows.ts) and its test
// are untouched; only where its numbers attach moved.
//
// RELATIVE value import, like the module it tests: node runs it under tsx with no `@shared` value
// alias (abilityStats.ts borrows `@shared/combat` type-only, which tsx strips).

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import {
  abilityExpandable,
  abilityMultiAttack,
  lanesForAbility
} from '../src/renderer/src/features/combat/abilityStats'
import type { FlatSkill } from '../src/renderer/src/features/combat/dashboardData'
import type {
  CategoryView,
  DamageCategory,
  RoundLaneView,
  SkillView,
  SourceRoundsView,
  SourceView
} from '../src/shared/combat'

function skill(name: string, total: number, over: Partial<SkillView> = {}): SkillView {
  return { name, total, pct: 0, hits: Math.max(1, Math.round(total / 100)), crits: 0, max: total, ...over }
}

function category(cat: DamageCategory, skills: SkillView[], over: Partial<CategoryView> = {}): CategoryView {
  const total = skills.reduce((n, s) => n + s.total, 0)
  const hits = skills.reduce((n, s) => n + s.hits, 0)
  const crits = skills.reduce((n, s) => n + s.crits, 0)
  return {
    category: cat,
    total,
    pct: 100,
    hits,
    crits,
    critPct: hits > 0 ? (crits / hits) * 100 : 0,
    max: Math.max(0, ...skills.map((s) => s.max)),
    resists: 0,
    resistPct: 0,
    skills,
    ...over
  }
}

function lane(verb: string, label: string, buckets: number[], over: Partial<RoundLaneView> = {}): RoundLaneView {
  const rounds = buckets.reduce((n, v) => n + v, 0)
  const multi = buckets.slice(1).reduce((n, v) => n + v, 0)
  return {
    verb,
    label,
    rounds,
    buckets,
    multiRounds: multi,
    multiPct: rounds > 0 ? (multi / rounds) * 100 : 0,
    fannedRounds: 0,
    confidence: 'aggregate',
    ...over
  }
}

function rounds(lanes: RoundLaneView[], over: Partial<SourceRoundsView> = {}): SourceRoundsView {
  return {
    lanes,
    primaryRounds: lanes.reduce((n, l) => n + l.rounds, 0),
    excluded: { frenzy: 0, riposte: 0, flurry: 0, rampage: 0 },
    modifiers: [],
    ripostesGiven: 0,
    ripostesTaken: 0,
    rampagesTaken: 0,
    flurries: 0,
    flurryPct: 0,
    ...over
  }
}

function source(over: Partial<SourceView> = {}): SourceView {
  return {
    id: 'you',
    name: 'You',
    kind: 'you',
    total: 0,
    dps: 0,
    pct: 100,
    hits: 0,
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
    categories: [],
    ...over
  } as SourceView
}

/** A flat row as the flatten builds one — a SkillView tagged with its category. */
function row(name: string, category: DamageCategory, over: Partial<SkillView> = {}): FlatSkill {
  return { ...skill(name, over.total ?? 100, over), category }
}

/**
 * The paladin shape that makes every judgement load-bearing: weapon verbs the parser answers
 * "Melee" for (so their lanes are titled after the VERB), a NAMED special-attack lane that IS a
 * skill row (Bash), a Slay Undead proc row named after that same weapon skill, and a spell.
 */
const MELEE = category('melee', [skill('Melee', 5000, { hits: 40, crits: 6 }), skill('Bash', 1200, { hits: 12 })], {
  critPct: 11.5,
  max: 512
})
const SLAY = category('slay', [skill('Bash', 800, { hits: 4 })])
const SPELL = category('spell', [skill('Smiting Strike', 2000, { hits: 10 })], { resists: 3, resistPct: 23 })
const ROUNDS = rounds(
  [
    lane('slash', 'Slash', [18, 10, 5, 2]),
    lane('crush', 'Crush', [12, 4, 1, 0]),
    lane('bash', 'Bash', [9, 1, 0, 0], { confidence: 'perEvent' })
  ],
  { flurries: 12, flurryPct: 2.1, modifiers: [{ name: 'Flurry', count: 12, avoided: 0 }] }
)
const PALADIN = source({ categories: [MELEE, SLAY, SPELL], roundStats: ROUNDS })

test('A BARE WEAPON VERB IS THE AUTO-ATTACK ABILITY’S: slash/crush belong to "Melee", not to a lane of their own', () => {
  // The parser answers "Melee" for slash / crush / pierce / hit alike, so `roundLaneLabel` titles
  // those lanes after the VERB and no skill row is called "Slash". They are auto-attack swings.
  assert.deepEqual(lanesForAbility(PALADIN, 'Melee', 'melee').map((l) => l.verb), ['slash', 'crush'])
  // A NAMED special lane is its OWN ability, filed to the first-wins category — melee wins the
  // Bash tie, so the melee Bash ability owns the "Bash" lane and the slay Bash proc owns none.
  assert.deepEqual(lanesForAbility(PALADIN, 'Bash', 'melee').map((l) => l.verb), ['bash'])
  assert.deepEqual(lanesForAbility(PALADIN, 'Bash', 'slay'), [])
})

test('THE AUTO-ATTACK ABILITY POOLS ITS WEAPON VERBS — double/triple over the summed rounds', () => {
  const m = abilityMultiAttack(PALADIN, 'Melee', 'melee')
  assert.ok(m)
  assert.equal(m.rounds, 52, 'slash 35 + crush 17 — one ability, its swings pooled')
  // 14 of 52 doubled, 6 tripled, 2 quad+. The percentages are over ROUNDS, the shown denominator.
  assert.equal(m.text, '27% doubled · 12% tripled · 4% quad+')
  assert.equal(Math.round(m.doubledPct), 27)
  assert.equal(m.estimated, true, 'a dual-wieldable weapon verb reads in aggregate — the one est. marker')
})

test('A NAMED SPECIAL IS ITS OWN LANE, and the ROUND is the swing that opened it (melee Bash, not the slay proc)', () => {
  const bash = abilityMultiAttack(PALADIN, 'Bash', 'melee')
  assert.ok(bash)
  assert.equal(bash.rounds, 10)
  assert.equal(bash.text, '10% doubled')
  assert.equal(bash.estimated, false, 'a reuse-timer special is per-event, so not estimated')
  // The slay Bash proc rides a weapon swing; the round belongs to the swing, so the proc gets none.
  assert.equal(abilityMultiAttack(PALADIN, 'Bash', 'slay'), null)
})

test('FLURRY RIDES THE AUTO-ATTACK ABILITY ALONE — stated once, never split per verb (law 6)', () => {
  assert.equal(abilityMultiAttack(PALADIN, 'Melee', 'melee')?.flurry, 'flurry ×12 · 2.1% of rounds')
  // Not the named special, not the proc — the log never says which verb a flurried swing was.
  assert.equal(abilityMultiAttack(PALADIN, 'Bash', 'melee')?.flurry, null)
  // Nothing flurried ⇒ no line for anyone, even the auto-attack ability.
  const quiet = source({ categories: [MELEE], roundStats: rounds([lane('slash', 'Slash', [4, 1])]) })
  assert.equal(abilityMultiAttack(quiet, 'Melee', 'melee')?.flurry, null)
})

test('AN ABILITY THAT OPENED NO ROUNDS HAS NO MULTI — a caster’s spell is null, not a table of zeroes', () => {
  assert.equal(abilityMultiAttack(PALADIN, 'Smiting Strike', 'spell'), null)
  // …and a source with no round stats at all: every ability’s multi is null.
  const caster = source({ categories: [SPELL] })
  assert.equal(abilityMultiAttack(caster, 'Smiting Strike', 'spell'), null)
})

test('CLICKABILITY IS A PER-ABILITY GATE: a weapon swing expands, a DoT tick does not', () => {
  // Melee / slay are weapon swings — crit and miss are core stats, so they expand even at 0%
  // (Dragon Punch after a clean fight shows the miss it did not take). This is the owner's model.
  assert.equal(abilityExpandable(row('Dragon Punch', 'melee', { hits: 3, crits: 0 }), null), true)
  assert.equal(abilityExpandable(row('Melee', 'melee'), abilityMultiAttack(PALADIN, 'Melee', 'melee')), true)
  assert.equal(abilityExpandable(row('Bash', 'slay', { hits: 4 }), null), true)
  // A DoT tick: no swings to miss, no rounds, no crit — nothing to expand, so it is not clickable.
  assert.equal(abilityExpandable(row('Venom', 'dot', { hits: 10 }), null), false)
  // A damage shield is passive — likewise inert.
  assert.equal(abilityExpandable(row('Thorns', 'ds', { hits: 5 }), null), false)
})

test('A DIRECT SPELL EXPANDS ONLY WHEN IT HAS A STAT — a crit makes it clickable, a plain nuke does not', () => {
  assert.equal(abilityExpandable(row('Nuke', 'spell', { hits: 5, crits: 2 }), null), true, 'a spell that crit states its rate')
  assert.equal(abilityExpandable(row('Nuke', 'spell', { hits: 5, crits: 0 }), null), false, 'a plain nuke has none of the four stats')
  // An ability of ANY category that multi-attacked is worth a click for that alone.
  assert.equal(abilityExpandable(row('Kick', 'spell', { hits: 5, crits: 0 }), abilityMultiAttack(PALADIN, 'Bash', 'melee')), true)
})

test('THE OVERLAY DRILL NO LONGER PERSISTS A CATEGORY — the store normalizer rebuilds entityId alone', () => {
  // A SOURCE PIN, because `setOverlayConfig` writes through electron-store and cannot be called
  // from a node test. JOS-105 rebuilt the persisted drill field by field and briefly carried the
  // level-3 `category`; JOS-113 removes that level, so the normalizer must rebuild `{entityId}`
  // only — dropping any stored category, which is the no-migration degrade path this ticket owns.
  const store = readFileSync(new URL('../src/main/store.ts', import.meta.url), 'utf8')
  const block = /next\.drill\s*=[\s\S]{0,200}/.exec(store)?.[0] ?? ''
  assert.match(block, /entityId/, 'the drill normalizer still rebuilds the entityId')
  assert.doesNotMatch(block, /category/, 'the drill normalizer no longer carries a damage type (level 3 is gone)')
})
