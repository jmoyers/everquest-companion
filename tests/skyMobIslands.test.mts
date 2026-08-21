// SKY MOB ISLANDS — the overlay that says where a MOB is when its item is somewhere else.
//
// `src/renderer/src/features/posky/skyMobIslands.ts` carries one row and the argument for it;
// this suite is its audit, and it is deliberately built like the spell-corrections audit: an entry
// that has quietly stopped describing anything is worse than no entry, because it looks like
// coverage. So the suite pins BOTH sides — the defect the entry exists to fix (still present in the
// committed scrape) and the answer it produces — plus a blast-radius measurement over the real data
// proving no other mob's island moved.
//
// Everything here reads the COMMITTED files (posky.json, mobs.json), never a synthetic fixture:
// the whole point is that a re-scrape which fixes or moves the underlying data fails this suite
// rather than silently leaving a dead correction in the tree.
//
// Run: `npm test`.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  SKY_MOB_ISLANDS,
  mobIslands,
  skyMobIslandFor
} from '../src/renderer/src/features/posky/skyMobIslands'
import {
  islandNumber,
  islandOf,
  killTargetFacts,
  questKillTargets,
  skyDroppersFor,
  type KillTargetItem
} from '../src/renderer/src/features/posky/poskyDroppers'
import poskyRaw from '../src/renderer/src/data/eqlegends/posky.json' with { type: 'json' }
import type { PoskyQuest } from '../src/shared/types'

const QUESTS = (poskyRaw as { quests: PoskyQuest[] }).quests

/** One quest's item rows as the tracker computes them — nothing held, so every item still counts. */
const questRows = (q: PoskyQuest): KillTargetItem[] =>
  q.items.map((it) => ({
    need: it.count > 0 ? it.count : 1,
    have: 0,
    where: it.where,
    droppers: skyDroppersFor(it.name, it.who)
  }))

/** One item row folded into the accumulator — deduped by page, the questKillTargets rule. */
function foldItem(out: Map<string, Set<string>>, it: KillTargetItem): void {
  const island = islandOf(it.where)
  const seen = new Set<string>()
  for (const m of it.droppers) {
    if (seen.has(m.page)) continue
    seen.add(m.page)
    const set = out.get(m.page) ?? new Set<string>()
    if (island) set.add(island)
    out.set(m.page, set)
  }
}

/** The islands the ITEM-DERIVED join alone produces for each mob page, across every quest. */
function derivedIslandsByPage(): Map<string, Set<string>> {
  const out = new Map<string, Set<string>>()
  for (const q of QUESTS) for (const it of questRows(q)) foldItem(out, it)
  return out
}

const sorted = (s: Iterable<string>): string[] =>
  [...s].sort((a, b) => islandNumber(a) - islandNumber(b))

// =============================================================================
// 1. The table itself
// =============================================================================

test('every entry is well formed and names a mob page exactly once', () => {
  const pages = new Set<string>()
  for (const e of SKY_MOB_ISLANDS) {
    assert.ok(e.page.trim().length > 0, 'page must not be blank')
    assert.ok(!pages.has(e.page), `${e.page}: listed twice`)
    pages.add(e.page)
    // The island is stated in the vocabulary `islandOf` normalizes to, so the label, the sort and
    // the override all speak one language.
    assert.equal(islandOf(e.island), e.island, `${e.page}: island must read as "Island N"`)
    assert.ok(e.derived.length > 0, `${e.page}: must state what the join produces today`)
    assert.ok(!e.derived.includes(e.island), `${e.page}: derived already agrees — drop the entry`)
    assert.ok(e.evidence.length > 40, `${e.page}: evidence must say how it was checked`)
  }
})

// =============================================================================
// 2. The defect is still there — the entry still describes something
// =============================================================================

test('the committed scrape still produces the island each entry says it produces', () => {
  const derived = derivedIslandsByPage()
  for (const e of SKY_MOB_ISLANDS) {
    const got = derived.get(e.page)
    assert.ok(got, `${e.page}: no longer resolves as a dropper anywhere — re-check the entry`)
    assert.deepEqual(
      sorted(got),
      [...e.derived],
      `${e.page}: the join now says something else. Re-verify before keeping this row.`
    )
  }
})

test('Protector of Sky: the join says island 7, the mob is on island 2', () => {
  // The reported defect (5DZGYM, 1.4.0): "Protector of Sky is listed as Island 7, its island 2."
  // The 7 comes from Gem of Invigoration, which the Warrior Test of Smash states as `(7-Trash)`
  // and whose own item page calls a drop off "any trash on island 7 (SotS)" — true about the item,
  // false about this mob, whose eqlwiki page opens "Location: 2nd Island".
  const entry = skyMobIslandFor('Protector of Sky')
  assert.ok(entry)
  assert.equal(entry.island, 'Island 2')
  assert.deepEqual([...entry.derived], ['Island 7'])

  const smash = QUESTS.find((q) => q.name === 'Warrior Test of Smash')
  assert.ok(smash, 'Warrior Test of Smash is not in the committed scrape')
  const target = questKillTargets(questRows(smash)).find((t) => t.mob.page === 'Protector of Sky')
  assert.ok(target, 'Protector of Sky is no longer a kill target for the Warrior test')
  assert.deepEqual(target.islands, ['Island 2'])
  assert.equal(killTargetFacts(target), 'Protector of Sky · level 55 · Plane of Sky · Island 2')
})

// =============================================================================
// 3. Blast radius: exactly the listed pages move, and nothing else
// =============================================================================

test('the overlay changes the listed pages and no other mob in the committed data', () => {
  const derived = derivedIslandsByPage()
  const listed = new Set(SKY_MOB_ISLANDS.map((e) => e.page))
  let changed = 0
  for (const [page, islands] of derived) {
    const before = sorted(islands)
    const after = sorted(mobIslands(page, before))
    if (listed.has(page)) {
      changed += 1
      assert.notDeepEqual(after, before, `${page}: listed but unchanged`)
      assert.deepEqual(after, [skyMobIslandFor(page)?.island], page)
      continue
    }
    assert.deepEqual(after, before, `${page}: not listed, yet its islands moved`)
  }
  assert.equal(changed, SKY_MOB_ISLANDS.length, 'every listed page must be reachable in the data')
  // A floor, not a frozen count (a re-scrape may add mobs): today the join resolves 22 Sky pages.
  assert.ok(derived.size >= 20, `pages resolved: ${derived.size}`)
})

test('a mob the table does not name passes its derived islands through untouched', () => {
  assert.deepEqual(mobIslands('Gorgalosk', ['Island 3']), ['Island 3'])
  assert.deepEqual(mobIslands('Gorgalosk', []), [])
  // A replacement, not a union: the mob is in one place.
  assert.deepEqual(mobIslands('Protector of Sky', ['Island 7']), ['Island 2'])
  assert.deepEqual(mobIslands('Protector of Sky', []), ['Island 2'])
})
