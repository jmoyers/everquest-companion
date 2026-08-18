// JOS-391 — THE SHIPPED SPELL-LINE DATA, and the four artefacts the generator had to repair.
//
// THE CLAIM UNDER TEST: `replaces X (Class)` on a Leveling row is a lookup into committed research
// rather than a guess, and the lookup never names a spell EQ Legends does not have, never says a
// spell replaces ITSELF, and never calls two travel destinations an upgrade.
//
// R1/R2 walk two classes' ladders by hand — the cleric heal line the ticket's own example uses and
// the druid Skin line, which is the one the research flagged most duplicates in. R3 is the
// same-level rule, R4 the non-ladder refusal, R5 the four repairs asserted against the RAW research
// files, so a regenerated file that reintroduces one fails here rather than on screen.
//
// Run: `npm test`.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { CLASS_ABBRS, type ClassAbbr } from '../src/shared/classCombo.ts'
import { classAbbrForDisplayName } from '../src/shared/spellLevels.ts'
import {
  linesForClass,
  replacedBy,
  spellLinesGeneratedAt
} from '../src/main/data/spellLineLookup.ts'

const RESEARCH = 'docs/research/spell-lines'

test('R1 the cleric heal ladder walks in both directions', () => {
  // Minor Healing -> Light Healing -> Healing -> Greater Healing -> Superior Healing -> …
  const minor = replacedBy('Minor Healing', 'CLR')
  assert.equal(minor.replaces, null, 'the first rung replaces nothing')
  assert.equal(minor.replacedBy, 'Light Healing')
  assert.match(String(minor.line), /heal/i)

  const healing = replacedBy('Healing', 'CLR')
  assert.equal(healing.replaces, 'Light Healing')
  assert.equal(healing.replacedBy, 'Greater Healing')

  // The Heroism/Courage line, the family the ticket names.
  assert.equal(replacedBy('Center', 'CLR').replaces, 'Courage')
  assert.equal(replacedBy('Valor', 'CLR').replaces, 'Bravery')
})

test('R2 a different class is a different ladder, and an unknown spell says so', () => {
  // The two heal ladders share their low rungs and diverge above them, which is exactly why the
  // lookup takes a class: `Greater Healing` is followed by Superior Healing for a cleric and by
  // Spirit Salve for a shaman.
  assert.equal(replacedBy('Greater Healing', 'CLR').replacedBy, 'Superior Healing')
  assert.equal(replacedBy('Greater Healing', 'SHM').replacedBy, 'Spirit Salve')

  // A cleric spell asked about as a wizard is not in a wizard line.
  assert.deepEqual(replacedBy('Minor Healing', 'WIZ'), { replaces: null, replacedBy: null, line: null })
  // Nor is something no line carries.
  assert.deepEqual(replacedBy('Not A Spell At All', 'CLR'), { replaces: null, replacedBy: null, line: null })
  // Case and spacing do not matter.
  assert.equal(replacedBy('  minor   healing ', 'CLR').replacedBy, 'Light Healing')
})

test('R3 two members at the SAME level never replace one another', () => {
  // Heroism@52 and its group twin Heroic Bond@52 both sit at 52; Heroic Bond replaces Resolution
  // (42), the rung below, and NOT the spell beside it.
  const bond = replacedBy('Heroic Bond', 'CLR')
  assert.notEqual(bond.replaces, 'Heroism', 'a group twin is not an upgrade over its single form')
  assert.equal(bond.replaces, 'Resolution')

  // And the rule is structural, not a special case: no answer anywhere may name a member at the
  // same level as the spell asked about.
  for (const cls of CLASS_ABBRS) for (const line of linesForClass(cls)) checkNeighbours(cls, line)
})

/** Every member of one line: whatever it names must sit strictly above or strictly below it. */
function checkNeighbours(cls: ClassAbbr, line: { name: string; members: { name: string; level: number }[] }): void {
  const at = (name: string): number | undefined => line.members.find((x) => x.name === name)?.level
  for (const m of line.members) {
    const place = replacedBy(m.name, cls)
    if (place.line !== line.name) continue
    if (place.replaces !== null) {
      assert.ok((at(place.replaces) ?? -1) < m.level, `${cls} ${m.name} replaces ${place.replaces}`)
    }
    if (place.replacedBy !== null) {
      assert.ok((at(place.replacedBy) ?? 99) > m.level, `${cls} ${m.name} is replaced by ${place.replacedBy}`)
    }
  }
}

test('R4 a destination set names its line and refuses to name a replacement', () => {
  // The druid Ring line is 20 teleport destinations filed as one line.
  const ring = replacedBy('Ring of Butcher', 'DRU')
  assert.notEqual(ring.line, null, 'the spell IS in that line')
  assert.equal(ring.replaces, null, 'but a place does not replace a place')
  assert.equal(ring.replacedBy, null)

  // The thirteen Imbue Gem spells, all at level 29, are the same shape.
  assert.equal(replacedBy('Imbue Emerald', 'CLR').replaces, null)
  // A wizard Gate is a destination; the wizard's nuke ladder is not.
  assert.equal(replacedBy('Tox Gate', 'WIZ').replaces, null)
  assert.notEqual(replacedBy('Shock of Lightning', 'WIZ').replacedBy, null)
})

interface RawLine {
  id: string
  members?: { name: string; level: number; inDb?: boolean }[]
}

/** Repairs 1-3 for ONE research line, against the shipped line of the same id. Returns tallies. */
function checkRepairs(cls: ClassAbbr, raw: RawLine, shipped: Map<string, { members: { name: string; level: number }[] }>): { dropped: number; deduped: number } {
  const members = raw.members ?? []
  const out = shipped.get(raw.id)
  if (!out) {
    // A line whose every member is absent from Legends ships as no line at all — the three rogue
    // combat-venom lines, five members between them.
    for (const m of members) {
      assert.equal(m.inDb, false, `${cls} ${raw.id} was dropped, so every member must be off-Legends`)
    }
    return { dropped: members.length, deduped: 0 }
  }
  const names = new Set(out.members.map((m) => m.name.toLowerCase()))
  const offLegends = members.filter((m) => m.inDb === false)
  // 3. nothing EQ Legends does not have
  for (const m of offLegends) assert.ok(!names.has(m.name.toLowerCase()), `${cls} ${raw.id}: ${m.name}`)
  // 2. no twin survived
  assert.equal(names.size, out.members.length, `${cls} ${raw.id} carries no duplicate name`)
  // 1. ascending by level
  for (let i = 1; i < out.members.length; i++) {
    assert.ok(out.members[i].level >= out.members[i - 1].level, `${cls} ${raw.id} is level-ordered`)
  }
  return { dropped: offLegends.length, deduped: members.length - offLegends.length - out.members.length }
}

test('R5 the four repairs hold against the raw research files', () => {
  const files = readdirSync(RESEARCH).filter((f) => f.startsWith('lines-') && f !== 'lines-merged.json')
  assert.equal(files.length, 13, 'thirteen spell-casting classes')
  let droppedNotInDb = 0
  let dedupedTwins = 0
  for (const name of files) {
    const raw = JSON.parse(readFileSync(join(RESEARCH, name), 'utf8')) as { class?: string; lines?: RawLine[] }
    const cls = classAbbrForDisplayName(String(raw.class)) as ClassAbbr
    assert.ok(cls, `${name} names a class the /who table knows`)
    const shipped = new Map(linesForClass(cls).map((l) => [l.id, l]))
    for (const line of raw.lines ?? []) {
      const tally = checkRepairs(cls, line, shipped)
      droppedNotInDb += tally.dropped
      dedupedTwins += tally.deduped
    }
  }
  assert.equal(droppedNotInDb, 13, 'the eleven rogue poisons and two wizard familiars')
  assert.ok(dedupedTwins >= 20, `${String(dedupedTwins)} duplicate members folded`)
})

test('R6 the shipped file covers the thirteen spell-casting classes and nothing else', () => {
  assert.equal(spellLinesGeneratedAt(), '2026-08-13')
  const withLines = CLASS_ABBRS.filter((c) => linesForClass(c).length > 0)
  assert.equal(withLines.length, 13)
  // BER/MNK/WAR have no spells on Legends, so no lines — the same floor levelUnlocks.ts states.
  for (const c of ['BER', 'MNK', 'WAR'] as const) assert.equal(linesForClass(c).length, 0)
  // Every member is a plain name and a plausible level.
  for (const cls of withLines) {
    for (const line of linesForClass(cls)) {
      assert.ok(line.members.length > 0, `${cls} ${line.id} is not empty`)
      for (const m of line.members) {
        assert.ok(m.name.length > 0 && m.level >= 1 && m.level <= 70, `${cls} ${m.name}@${String(m.level)}`)
      }
    }
  }
})
