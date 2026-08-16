// ============================================================================
// skyTargets — the Targets tab's whole model: "who do I still kill", cross-quest.
// ============================================================================
//
// Issue #30, planned in docs/plans/sky-targets.md from
// docs/brainstorms/2026-08-16-sky-targets-tab-requirements.md. The quest tracker says what each
// quest needs; players invert it in their heads to the question they walk the islands with. This
// suite pins the inversion as a pure fold, half against the COMMITTED data (the poskyDroppers
// precedent: goldens over posky.json + the real catalog) and half against synthetic quests where
// the committed data cannot express the case (partial holdings, turn-in counts).
//
// WHAT IS PINNED, and the argument for each:
//   1. THE NEED SET is never-turned-in and nothing else (`everTurnedIn`, the Ready tab's
//      first-time reading). A reward-inferred completion (PR #33) reads turnIns >= 1 and is
//      excluded by the same predicate — no special case, which is the point of the floor.
//   2. SHORTFALL AGGREGATES PER COUNTING KEY, never per quest. `computeQuestProgress` clamps
//      `have` per quest with no cross-quest allocation, so a per-quest `have < need` filter
//      would read two quests each "satisfied" by the same single held copy. The rule:
//      totalNeed summed over the need set, minus the UNCAPPED `held`, floored at zero.
//   3. CLASSIFICATION IS THE SCRAPE'S OWN WORDS: resolved droppers fold into mob cards; an
//      unresolved item whose `who` starts with "random drop" (case-insensitive prefix — never
//      the literal sentinel, which carries an em dash `tests/copyNoEmDash.test.mts` would
//      reject) is the collective entry; anything else unresolved is the no-known-source list.
//      Never a guessed mob (law 1).
//   4. THE ORDER IS COUNTED: mobs by distinct needed items covered, desc, then name — the
//      questKillTargets order, cross-quest. Items inside a card, and both special lists,
//      alphabetical: deterministic and explainable, nothing invented.
//
// Run: `npm test`.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { skyTargets, type TargetsQuest, type TargetsQuestItem } from '../src/renderer/src/features/posky/skyTargets'
import { skyDroppersFor, type DropperMob } from '../src/renderer/src/features/posky/poskyDroppers'
import type { MobEntry, PoskyQuest } from '../src/shared/types'
import poskyRaw from '../src/renderer/src/data/eqlegends/posky.json' with { type: 'json' }

const QUESTS: PoskyQuest[] = (poskyRaw as { quests: PoskyQuest[] }).quests

// ---------------------------------------------------------------------------
// Builders
// ---------------------------------------------------------------------------

/** A synthetic dropper — the catalog shape with only the fields the fold reads. */
function mob(name: string, page = name): DropperMob {
  const entry = { name, page, zones: ['Plane of Sky'] } as MobEntry
  return { name, page, zones: ['Plane of Sky'], entry }
}

/** One quest item as the fold consumes it; droppers default to none. */
function item(p: {
  name: string
  need?: number
  held?: number
  droppers?: DropperMob[]
  where?: string
  who?: string[]
}): TargetsQuestItem {
  return {
    name: p.name,
    need: p.need ?? 1,
    held: p.held ?? 0,
    droppers: p.droppers ?? [],
    where: p.where ?? 'Island 1',
    who: p.who ?? []
  }
}

/** A quest as the fold consumes it. `turnIns` defaults to never-turned-in. */
function quest(p: {
  className?: string
  name: string
  turnIns?: number
  items: TargetsQuestItem[]
}): TargetsQuest {
  return {
    className: p.className ?? 'Warrior',
    name: p.name,
    turnIns: p.turnIns ?? 0,
    items: p.items
  }
}

/** A REAL quest row from the committed data, resolved through the real dropper index. */
function realQuest(q: PoskyQuest, turnIns = 0): TargetsQuest {
  return {
    className: q.className,
    name: q.name,
    turnIns,
    items: q.items.map((it) => ({
      name: it.name,
      need: it.count > 0 ? it.count : 1,
      held: 0,
      droppers: skyDroppersFor(it.name, it.who),
      where: it.where,
      who: it.who
    }))
  }
}

// ---------------------------------------------------------------------------
// 1. The need set
// ---------------------------------------------------------------------------

test('a quest turned in once contributes nothing (AE1)', () => {
  const q = quest({ name: 'Test of Done', turnIns: 1, items: [item({ name: 'Sky Pearl', droppers: [mob('Gorgalosk')] })] })
  const model = skyTargets([q])
  assert.equal(model.mobs.length, 0)
  assert.equal(model.randomDrop.length, 0)
  assert.equal(model.unsourced.length, 0)
})

test('a reward-inferred completion is excluded by the same predicate (AE2)', () => {
  // PR #33 floors turnIns to 1 when the reward sits in the inventory export; the fold reads
  // the floored count and needs no rewardInferred special case.
  const q = quest({ name: 'Test of Inferred', turnIns: 1, items: [item({ name: 'Sky Pearl', droppers: [mob('Gorgalosk')] })] })
  assert.equal(skyTargets([q]).mobs.length, 0)
})

test('a quest holding everything contributes nothing; an empty input is an empty model', () => {
  const full = quest({ name: 'Test of Full', items: [item({ name: 'Sky Pearl', need: 2, held: 2, droppers: [mob('Gorgalosk')] })] })
  assert.equal(skyTargets([full]).mobs.length, 0)
  const empty = skyTargets([])
  assert.deepEqual([empty.mobs, empty.randomDrop, empty.unsourced], [[], [], []])
})

// ---------------------------------------------------------------------------
// 2. Shortfall aggregates per counting key
// ---------------------------------------------------------------------------

test('two quests sharing one held copy still need one more — never vanishing (the R2 rule)', () => {
  const a = quest({ className: 'Cleric', name: 'Test A', items: [item({ name: 'Sphinx Claw', held: 1, droppers: [mob('Sphinx')] })] })
  const b = quest({ className: 'Rogue', name: 'Test B', items: [item({ name: 'Sphinx Claw', held: 1, droppers: [mob('Sphinx')] })] })
  const model = skyTargets([a, b])
  assert.equal(model.mobs.length, 1)
  const entry = model.mobs[0].items[0]
  // totalNeed 2 across the need set, 1 held -> 1 short. The per-quest clamp would say 0.
  assert.equal(entry.shortfall, 1)
  assert.equal(entry.quests.length, 2)
})

test('one item wanted by two quests is one mob entry naming both, with combined shortfall (AE4)', () => {
  const a = quest({ className: 'Cleric', name: 'Test A', items: [item({ name: 'Sphinx Claw', droppers: [mob('Sphinx')] })] })
  const b = quest({ className: 'Rogue', name: 'Test B', items: [item({ name: 'Sphinx Claw', droppers: [mob('Sphinx')] })] })
  const model = skyTargets([a, b])
  assert.equal(model.mobs.length, 1)
  assert.equal(model.mobs[0].mob.name, 'Sphinx')
  const entry = model.mobs[0].items[0]
  assert.equal(entry.shortfall, 2)
  assert.deepEqual(entry.quests.map((x) => x.questName).sort(), ['Test A', 'Test B'])
})

test('a +N variant folds onto its base item by counting key', () => {
  const a = quest({ className: 'Cleric', name: 'Test A', items: [item({ name: 'Sphinx Claw', droppers: [mob('Sphinx')] })] })
  const b = quest({ className: 'Rogue', name: 'Test B', items: [item({ name: 'Sphinx Claw +1', droppers: [mob('Sphinx')] })] })
  const model = skyTargets([a, b])
  assert.equal(model.mobs.length, 1)
  assert.equal(model.mobs[0].items.length, 1)
  assert.equal(model.mobs[0].items[0].shortfall, 2)
})

test('need > 1 with partial holdings reports the exact shortfall', () => {
  const q = quest({ name: 'Test of Two', items: [item({ name: 'Sky Pearl', need: 2, held: 1, droppers: [mob('Gorgalosk')] })] })
  assert.equal(skyTargets([q]).mobs[0].items[0].shortfall, 1)
})

test('an item shared by a turned-in and a never-turned-in quest annotates only the latter', () => {
  const done = quest({ className: 'Cleric', name: 'Test Done', turnIns: 1, items: [item({ name: 'Sphinx Claw', droppers: [mob('Sphinx')] })] })
  const open = quest({ className: 'Rogue', name: 'Test Open', items: [item({ name: 'Sphinx Claw', droppers: [mob('Sphinx')] })] })
  const model = skyTargets([done, open])
  const entry = model.mobs[0].items[0]
  assert.equal(entry.shortfall, 1)
  assert.deepEqual(entry.quests.map((x) => x.questName), ['Test Open'])
})

// ---------------------------------------------------------------------------
// 3. Classification — the scrape's own words, never a guess
// ---------------------------------------------------------------------------

test('a missing Wind Rune lands in the collective entry and never on a mob (AE5, real data)', () => {
  const rune = QUESTS.flatMap((q) => q.items).find((it) =>
    it.who.some((w) => w.toLowerCase().startsWith('random drop'))
  )
  assert.ok(rune, 'the committed data states random-drop rows')
  const q = quest({ name: 'Test of Wind', items: [item({ name: rune.name, where: rune.where, who: rune.who, droppers: skyDroppersFor(rune.name, rune.who) })] })
  const model = skyTargets([q])
  assert.equal(model.mobs.length, 0)
  assert.equal(model.randomDrop.length, 1)
  assert.equal(model.randomDrop[0].name, rune.name)
  assert.equal(model.randomDrop[0].shortfall, 1)
})

test('a missing item with no known dropper lands in the no-known-source list (AE6, real data)', () => {
  // Azarack Blood: posky states a source in words, the catalog resolves nobody (the
  // poskyDroppers header's measured 3-item remainder).
  const row = QUESTS.flatMap((q) => q.items).find((it) => it.name === 'Azarack Blood')
  assert.ok(row, 'Azarack Blood is in the committed data')
  const droppers = skyDroppersFor(row.name, row.who)
  assert.equal(droppers.length, 0, 'still unresolved in the committed catalog')
  const q = quest({ name: 'Test of Azarack', items: [item({ name: row.name, where: row.where, who: row.who, droppers })] })
  const model = skyTargets([q])
  assert.equal(model.mobs.length, 0)
  assert.equal(model.unsourced.length, 1)
  assert.equal(model.unsourced[0].name, row.name)
})

test('a real never-turned-in quest yields real kill targets from the committed catalog', () => {
  const source = QUESTS.find((q) => q.items.some((it) => skyDroppersFor(it.name, it.who).length > 0))
  assert.ok(source, 'the committed data resolves droppers for some quest')
  const model = skyTargets([realQuest(source)])
  assert.ok(model.mobs.length > 0)
  for (const t of model.mobs) {
    assert.ok(t.covers >= 1)
    assert.ok(t.items.length === t.covers)
    assert.ok(t.items.every((i) => i.shortfall > 0))
  }
})

// ---------------------------------------------------------------------------
// 4. The order is counted
// ---------------------------------------------------------------------------

test('mobs sort by distinct items covered desc, then name; the order is stable', () => {
  const twoItems = quest({
    name: 'Test of Many',
    items: [
      item({ name: 'Sky Pearl', droppers: [mob('Gorgalosk')] }),
      item({ name: 'Sky Sapphire', droppers: [mob('Gorgalosk')] }),
      item({ name: 'Azarack Feather', droppers: [mob('Azarack')] })
    ]
  })
  const first = skyTargets([twoItems])
  assert.deepEqual(first.mobs.map((t) => t.mob.name), ['Gorgalosk', 'Azarack'])
  assert.deepEqual(first.mobs.map((t) => t.covers), [2, 1])
  // Ties break on name: two mobs each covering one item.
  const tied = quest({
    name: 'Test of Ties',
    items: [
      item({ name: 'Sky Pearl', droppers: [mob('Gorgalosk')] }),
      item({ name: 'Azarack Feather', droppers: [mob('Azarack')] })
    ]
  })
  assert.deepEqual(skyTargets([tied]).mobs.map((t) => t.mob.name), ['Azarack', 'Gorgalosk'])
})

test('items inside a card, and both special lists, read alphabetically', () => {
  const q = quest({
    name: 'Test of Order',
    items: [
      item({ name: 'Sky Sapphire', droppers: [mob('Gorgalosk')] }),
      item({ name: 'Azarack Feather', droppers: [mob('Gorgalosk')] })
    ]
  })
  assert.deepEqual(skyTargets([q]).mobs[0].items.map((i) => i.name), ['Azarack Feather', 'Sky Sapphire'])
})

test('a mob listed on two of one item\'s droppers counts that item once', () => {
  const dup = mob('Gorgalosk')
  const q = quest({ name: 'Test of Dupes', items: [item({ name: 'Sky Pearl', droppers: [dup, dup] })] })
  assert.equal(skyTargets([q]).mobs[0].covers, 1)
})

test('islands ride per mob from the items it is the target for', () => {
  const q = quest({
    name: 'Test of Where',
    items: [
      item({ name: 'Sky Pearl', where: 'Island 3', droppers: [mob('Gorgalosk')] }),
      item({ name: 'Sky Sapphire', where: 'Island 5', droppers: [mob('Gorgalosk')] })
    ]
  })
  assert.deepEqual(skyTargets([q]).mobs[0].islands, ['Island 3', 'Island 5'])
})
