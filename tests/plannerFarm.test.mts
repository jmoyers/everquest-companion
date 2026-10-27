// PLANNER FARM-ROLLUP TESTS — which zone a donor is filed under, and why (JOS-42, refinement 4).
//
// THE TRUST BUG THIS FILE EXISTS FOR. A farm plan filed Batfang Headband under DRAGON NECROPOLIS
// — a Velious zone this server has not opened — while Western Plains of Karana, where five
// classic-era ogres drop the same headband, sat in the row's muted "also:" tail. The rollup was
// not wrong about the facts; it was wrong about which of them to lead with. Its tiebreak was
// alphabetical (header: "a stable, statable rule beats whichever the scrape listed first"), and
// `Dragon Necropolis` < `Timorous Deep` < `Western Plains of Karana`. So the one heading the whole
// feature exists to produce — "go here next" — named a place the player cannot go.
//
// SO THE ANCHOR IS THE REAL CATALOG, not a hand-built fixture. `src/renderer/src/data/eqlegends/
// mobs.json` is committed data, and every zone below was read out of it: a carrion bat and a
// Chetari guard in Dragon Necropolis (velious), four ogres in Western Plains of Karana (classic),
// The Great Oowomp in Timorous Deep (kunark). If a rescrape ever moves those, this test is
// supposed to notice — that is what makes it an anchor rather than a mock.
//
// The rest is the arithmetic the header states, pinned as identities: every need appears exactly
// once, the weights still choose the zone that feeds the most of the list, and the alphabetical
// tiebreak survives inside whichever candidate set the era rule leaves standing.
//
// WHAT JOS-326 CHANGED HERE, AND WHAT IT DELIBERATELY DID NOT. The rollup used to be fed by
// `collectNeeds(plan, …)`, which walked an exaltation set's cells; the plan board is gone and the
// wish list feeds it now (`features/wishlist/wishFarm.ts`, pinned by tests/wishFarm.test.mts). So
// this file builds its needs DIRECTLY — which is what it should always have done, because the
// thing under test is the GROUPING and a collector standing between it and the assertion was only
// ever a way for a change in one to look like a failure in the other. Not one zone claim, weight
// or tiebreak below moved.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { campTail, campText, farmZone, groupNeeds, type FarmNeed } from '../src/renderer/src/features/planner/plannerFarm'
import { sourcesFor } from '../src/renderer/src/features/planner/sourceIndex'
import type { DonorProgress } from '../src/renderer/src/features/planner/plannerProgress'

const HEADBAND = 'batfang headband'

/** The three zones the committed catalog names for the headband, in catalog order. */
const DN = 'Dragon Necropolis'
const WPK = 'Western Plains of Karana'
const TD = 'Timorous Deep'

/** Progress is DECORATION here (design D6) — the rollup groups the same way whatever it says. */
const PLANNED: DonorProgress = {
  state: 'planned',
  label: 'planned',
  tierRequired: 4,
  held: 0,
  looted: 0
}

/**
 * One need, resolved against the MOB CATALOG alone.
 *
 * No corpus row on purpose, which is also the harder case: a wanted item the item DB no longer
 * carries must still be routed from `sourcesFor` — the renderer's own inversion of the committed
 * `|known_loot` — and that is precisely the evidence every zone claim below rests on.
 */
function needOf(itemKey: string, effect: string): FarmNeed {
  const sources = sourcesFor(itemKey)
  return {
    id: `${itemKey}:${effect}`,
    itemKey,
    name: itemKey,
    effect,
    socket: 'proc',
    tierRequired: 4,
    subject: { key: itemKey },
    classes: [],
    slots: [],
    quest: false,
    playerCrafted: false,
    sources,
    zones: [...new Set(sources.flatMap((s) => s.zones))],
    progress: PLANNED
  }
}

function needsOf(picks: readonly { effect: string; donorKey: string }[]): FarmNeed[] {
  return picks.map((p) => needOf(p.donorKey, p.effect))
}

test('ANCHOR — the committed catalog puts Batfang Headband in three zones, two of them out of era', () => {
  const [need] = needsOf([{ effect: 'Bat Fang', donorKey: HEADBAND }])
  assert.ok(need, 'the plan produced no need')
  assert.deepEqual([...need.zones].sort(), [DN, TD, WPK].sort())
  assert.equal(farmZone(DN).era, 'velious')
  assert.equal(farmZone(DN).outOfEra, true)
  assert.equal(farmZone(TD).era, 'kunark')
  assert.equal(farmZone(TD).outOfEra, true)
  assert.equal(farmZone(WPK).era, 'classic')
  assert.equal(farmZone(WPK).outOfEra, false)
})

test('THE TRUST BUG — with the era filter on, the headband is filed under the zone you can reach', () => {
  const needs = needsOf([{ effect: 'Bat Fang', donorKey: HEADBAND }])
  const groups = groupNeeds(needs, { eraOnly: true })

  assert.equal(groups.length, 1)
  assert.equal(groups[0].title, WPK, `filed under ${groups[0].title}, which is not in era`)
  assert.equal(groups[0].kind, 'zone')

  // …and the out-of-era zones survive, in the tail, each naming its own expansion.
  const also = groups[0].rows[0].also
  assert.deepEqual(
    also.map((z) => z.name).sort(),
    [DN, TD].sort()
  )
  assert.ok(
    also.every((z) => z.outOfEra),
    'an out-of-era "also" zone must say which expansion it is'
  )
  // The chip's word comes from ERA_LABEL, never spelled here twice.
  assert.deepEqual(also.map((z) => z.eraLabel).sort(), ['Kunark', 'Velious'])
})

test('with the era filter OFF the rollup keeps its old answer — the filter is what makes the rule apply', () => {
  const needs = needsOf([{ effect: 'Bat Fang', donorKey: HEADBAND }])
  const groups = groupNeeds(needs, { eraOnly: false })
  // Ties are alphabetical and every zone is a candidate again, so the old (honest, era-blind)
  // answer comes back: this is a browse of everything, not a route.
  assert.equal(groups[0].title, DN)
})

test('the era rule never beats the weights INSIDE the reachable set — most-needed still wins', () => {
  // Two needs. The headband can be farmed in WPK (classic) or DN/TD (later expansions); the
  // second donor is a Western Plains of Karana drop only. WPK therefore feeds both and must win
  // on weight, exactly as it does on era.
  const needs = needsOf([
    { effect: 'Bat Fang', donorKey: HEADBAND },
    { effect: 'Bone', donorKey: 'glowing bone collar' }
  ])
  const groups = groupNeeds(needs, { eraOnly: true })
  const wpk = groups.find((g) => g.title === WPK)
  assert.ok(wpk, `no ${WPK} group in ${groups.map((g) => g.title).join(', ')}`)
  assert.ok(wpk.rows.length >= 1)
  assert.equal(groups[0].title, WPK, 'the biggest group leads the rollup')
})

test('every need appears EXACTLY once, whatever the era rule chose', () => {
  const needs = needsOf([
    { effect: 'Bat Fang', donorKey: HEADBAND },
    { effect: 'Bone', donorKey: 'glowing bone collar' },
    { effect: 'Nothing', donorKey: 'an item nobody drops' }
  ])
  for (const eraOnly of [true, false]) {
    const groups = groupNeeds(needs, { eraOnly })
    const rows = groups.flatMap((g) => g.rows)
    assert.equal(rows.length, needs.length, `${String(rows.length)} rows for ${String(needs.length)} needs`)
    const ids = new Set(rows.map((r) => r.id))
    assert.equal(ids.size, needs.length)
  }
})

test('a donor nothing places keeps the honest non-zone heading', () => {
  const groups = groupNeeds(needsOf([{ effect: 'X', donorKey: 'an item nobody drops' }]), {
    eraOnly: true
  })
  assert.equal(groups.length, 1)
  assert.equal(groups[0].kind, 'unknown')
})

test('campTail is the camp line AFTER the mob`s name - level verbatim, +N more, nothing invented', () => {
  // Split out (2026-08-18) so the wish list can make the name itself a door while the tail keeps
  // this module's one spelling: `campText` IS the name plus the tail, always.
  const one = { sources: [{ mob: 'the froglok shin lord', levelText: '30', zones: ['Upper Guk'] }] }
  assert.equal(campTail(one), ' (lvl 30)')
  assert.equal(campText(one), `the froglok shin lord${campTail(one)}`)
  // A range is a level the catalog stated - verbatim, never its midpoint (law 1).
  const range = { sources: [{ mob: 'a ghoul', levelText: '36-40', zones: [] }] }
  assert.equal(campTail(range), ' (lvl 36-40)')
  // A page-only witness has no level text: a bare name, no `(lvl ?)` and no `(lvl 0)`.
  const bare = { sources: [{ mob: 'a bandit', zones: [] }] }
  assert.equal(campTail(bare), '')
  assert.equal(campText(bare), 'a bandit')
  // More witnesses are counted, never listed - the cell is one line.
  const many = { sources: [...one.sources, ...range.sources, ...bare.sources] }
  assert.equal(campTail(many), ' (lvl 30) +2 more')
  assert.equal(campTail({ sources: [...bare.sources, ...one.sources] }), ' +1 more', 'the FIRST witness sets the level, or its absence')
  // Nobody named: nothing at all.
  assert.equal(campTail({ sources: [] }), '')
  assert.equal(campText({ sources: [] }), '')
})
