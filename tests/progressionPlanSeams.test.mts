// THE TWO SEAMS THE 2026-08-25 REVIEW CORRECTED IN THE PLAN FOLD (src/shared/planner/progressionPlan.ts
// rules 9 and 12), and the witness page a target carries.
//
// A THIRD FILE beside `progressionPlan.test.mts` (the route model) and `progressionPlanRuns.test.mts`
// (admission and grouping), for the reason the second one gives: the runs file met the tree's
// 400-code-line ceiling the day these were written, and each file carries its own small corpus so
// a claim is pinned against fixtures shaped for it alone.
//
// WHAT IS PINNED:
//   1. THE HASTE RULE IS PER SLOT, ON BOTH SIDES OF THE GAP. A strictly better haste weapon IS an
//      upgrade for the slot holding the haste source (the bug: candidates were scored above the
//      global best and the bars at full credit, so that slot could never be upgraded); a hasteless
//      weapon with a slightly better ratio is NOT (the swap rule 12 was written to refuse); the same
//      blade offered for another slot is read against the sword. And a stated haste PENALTY scores
//      as one — only the positive margin is clamped.
//   2. THE POOL AND THE WISH LIST ARE SEPARATE INPUTS (`candidatePool` / `routeFromPool`): one pool
//      serves any wish set, the gap verdict is carried rather than applied, and the one-shot door
//      `buildProgressionPlan` is exactly the two composed.
//   3. A TARGET NAMES ITS WITNESS PAGE (`mobPage`) beside the base mob spelling the level joins on.
//
// SYNTHETIC, like its siblings: the con table is written here, the zone NAMES are real spellings
// because the era layer is real code, and every level, membership and witness is invented.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { ConBand } from '../src/shared/conBands'
import type { GearRow } from '../src/shared/planner/gear'
import {
  buildProgressionPlan,
  candidatePool,
  roleValue,
  routeFromPool,
  type OwnedHaste,
  type PlanCorpora,
  type PlanInputs
} from '../src/shared/planner/progressionPlan'
import { zoneLevelKey, type ZoneLevels } from '../src/shared/planner/zoneLevels'

// =================================================================================================
// FIXTURES — synthetic, see the header
// =================================================================================================

function con(myLevel: number, mobLevel: number): ConBand {
  const diff = mobLevel - myLevel
  if (diff <= -6) return 'trivial'
  if (diff <= -1) return 'safe'
  if (diff <= 1) return 'even'
  if (diff <= 4) return 'risky'
  return 'deadly'
}

const PROFILES: ReadonlyMap<string, ZoneLevels> = new Map(
  [
    { zone: 'Crushbone', low: 8, median: 12, sampled: 40 },
    { zone: 'Najena', low: 20, median: 26, sampled: 25 }
  ].map((r) => [zoneLevelKey(r.zone), r])
)

const MOB_LEVELS = new Map<string, number>([
  ['a young kobold', 14],
  ['Ixiblat Fer', 55]
])
const mobLevel = (name: string): number | null => MOB_LEVELS.get(name) ?? null

function row(over: Partial<GearRow> & Pick<GearRow, 'key' | 'name'>): GearRow {
  return {
    searchKey: over.name.toLowerCase(),
    slots: ['CHEST'],
    classes: ['WAR'],
    races: ['ALL'],
    flags: [],
    quest: false,
    playerCrafted: false,
    stats: {},
    effects: [],
    wikiSources: [{ mob: 'a young kobold', zone: 'Crushbone' }],
    ...over
  }
}

/** The owned haste weapon, at base: a 10/20 blade with 36% haste, worn in the main hand. */
const OWNED_HASTE_SWORD = { DMG: 10, DELAY: 20, HASTE: 36 }
/** Strictly better on BOTH counts — a higher ratio AND more haste. The upgrade the bug hid. */
const QUICKBLADE = row({
  key: 'quickblade',
  name: 'Quickblade',
  slots: ['PRIMARY'],
  skill: '1H Slashing',
  stats: { DMG: 12, DELAY: 20, HASTE: 40 }
})
/** A better ratio and NO haste — the swap rule 12 was written to refuse. */
const KEEN_SWORD = row({
  key: 'keen sword',
  name: 'Keen Sword',
  slots: ['PRIMARY'],
  skill: '1H Slashing',
  stats: { DMG: 11, DELAY: 20 }
})
/** The high scorer of the wish tests, and DELIBERATELY WORTHLESS beside it. */
const PLATE = row({ key: 'plate of the sentinel', name: 'Plate of the Sentinel', stats: { AC: 30, HP: 60, STA: 10 } })
const WISHED_LOW = row({ key: 'chipped talisman', name: 'Chipped Talisman', slots: ['NECK'], stats: { AC: 1 } })
/** The tier on the MOB: the level join key is the base spelling, the page is the spelling as linked. */
const TIER_RING = row({
  key: 'fused ring',
  name: 'Fused Ring',
  slots: ['FINGER'],
  stats: { AC: 9 },
  wikiSources: [{ mob: 'Ixiblat Fer +5', zone: 'Najena' }]
})

function corpora(over: Partial<PlanCorpora> = {}): PlanCorpora {
  return { gear: [], profiles: PROFILES, mobLevel, con, owned: new Set(), ownedBestBySlot: new Map(), ...over }
}

function inputs(over: Partial<PlanInputs> = {}): PlanInputs {
  return { level: 13, classes: ['WAR', 'PAL', 'ROG'], role: 'dps', reach: 'solo', eraOnly: false, ...over }
}

const names = (route: readonly { targets: readonly { name: string }[] }[]): string[] =>
  route.flatMap((b) => b.targets.map((t) => t.name))

// =================================================================================================
// 1. THE HASTE RULE IS PER SLOT, ON BOTH SIDES OF THE GAP (rule 12, corrected 2026-08-25)
// =================================================================================================

test('a strictly better haste weapon IS an upgrade for the slot holding the haste source; a hasteless one is not', () => {
  // THE BAR IS SCORED UNDER THE SAME RULE AS ITS CHALLENGERS: for the sword's own slot the haste
  // you would still own after a swap is 0, so the sword's bar keeps FULL credit for its 36 — and so
  // does anything offered for that slot. The first cut scored the bar at full credit and the
  // candidates above the global 36, which no replacement could ever clear (it had to beat 36 haste
  // points with none of its own).
  const sources: OwnedHaste[] = [{ haste: 36, slots: ['PRIMARY'] }]
  const bar = roleValue(OWNED_HASTE_SWORD, 'dps', { ownedHaste: 0 })
  assert.ok(bar > roleValue(OWNED_HASTE_SWORD, 'dps', { ownedHaste: 36 }), 'the bar credits its own haste')
  const route = buildProgressionPlan(
    inputs(),
    corpora({ gear: [QUICKBLADE, KEEN_SWORD], ownedBestBySlot: new Map([['PRIMARY', bar]]), ownedHaste: sources })
  )
  assert.deepEqual(names(route), ['Quickblade'])
  // …and it is ranked at its full worth, not at four points of haste over the sword it replaces.
  assert.equal(route[0].targets[0].score, roleValue(QUICKBLADE.stats, 'dps'))

  // THE OTHER SLOTS STILL READ THE SWORD: the same 40% blade offered as an OFFHAND is credited only
  // above 36, because swapping the offhand keeps the sword.
  const offhand = row({ ...QUICKBLADE, key: 'offhand quickblade', name: 'Offhand Quickblade', slots: ['SECONDARY'] })
  const asOffhand = buildProgressionPlan(inputs(), corpora({ gear: [offhand], ownedHaste: sources }))
  assert.equal(asOffhand[0].targets[0].score, roleValue(QUICKBLADE.stats, 'dps', { ownedHaste: 36 }))
})

test('a stated haste PENALTY scores as one, whatever is owned — only the positive margin is clamped', () => {
  // -5% haste under the dps weight of 4 is -20, with nothing owned and with a 36% sword alike. The
  // old clamp rounded it up to 0, which was the one place the score improved on what the page said.
  assert.equal(roleValue({ HASTE: -5 }, 'dps'), -20)
  assert.equal(roleValue({ HASTE: -5 }, 'dps', { ownedHaste: 36 }), -20)
  // …and the clamp still holds on the way up: 9 under 36 is 0, never -27.
  assert.equal(roleValue({ HASTE: 9 }, 'dps', { ownedHaste: 36 }), 0)
})

// =================================================================================================
// 2. THE POOL IS ONE INPUT AND THE WISH LIST IS ANOTHER (rule 9, the renderer's two memos)
// =================================================================================================

test('one pool serves any wish set, and the one-shot door is exactly the two halves composed', () => {
  const shut = corpora({
    gear: [PLATE, WISHED_LOW],
    ownedBestBySlot: new Map([
      ['CHEST', 9999],
      ['NECK', 9999]
    ])
  })
  const scope = inputs()
  const pool = candidatePool(scope, shut)
  // The pool holds BOTH rows — neither is an upgrade, and the verdict is carried, not applied.
  assert.deepEqual(pool.map((c) => [c.row.key, c.upgrade]), [
    ['plate of the sentinel', false],
    ['chipped talisman', false]
  ])
  // The same pool, two wish sets, two routes — the scoring never re-ran.
  assert.deepEqual(names(routeFromPool(scope, shut, pool, new Set())), [])
  assert.deepEqual(names(routeFromPool(scope, shut, pool, new Set(['chipped talisman']))), ['Chipped Talisman'])
  // …and `buildProgressionPlan` with `wished` on the corpora is the composition, byte for byte.
  assert.deepEqual(
    buildProgressionPlan(scope, { ...shut, wished: new Set(['chipped talisman']) }),
    routeFromPool(scope, shut, pool, new Set(['chipped talisman']))
  )
})

// =================================================================================================
// 3. A TARGET NAMES ITS WITNESS PAGE
// =================================================================================================

test('a target carries the witness PAGE the item page named, beside the base mob spelling', () => {
  const route = buildProgressionPlan(inputs(), corpora({ gear: [PLATE, TIER_RING] }))
  const targets = route.flatMap((b) => b.targets)
  const plate = targets.find((t) => t.key === 'plate of the sentinel')
  assert.equal(plate?.mobPage, 'a young kobold')
  assert.equal(plate?.mob, 'a young kobold')
  // A mob-side tier: the LEVEL join key is the base spelling, the PAGE is the spelling as linked.
  const ring = targets.find((t) => t.key === 'fused ring')
  assert.equal(ring?.mob, 'Ixiblat Fer')
  assert.equal(ring?.mobPage, 'Ixiblat Fer +5')
})
