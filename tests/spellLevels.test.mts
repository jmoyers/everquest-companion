// SPELL UNLOCK LEVELS — the pure parse behind "what's new at this level"
// (docs/plans/levelup-whats-new.md § 1, wave O1).
//
// Asserted against the REAL COMMITTED src/main/data/spells.json, never the live wiki: a
// test that hits the network fails on a wiki edit, an outage, or a plane, and it is the
// JSON in the tree that ships (the tests/classTables.test.mts precedent). No Electron, no
// fixtures, no live log — this suite NEVER skips.
//
// The numbers below are FLOORS, not frozen counts. They sit a margin under what the
// committed DB measures today (1,455 rows / 2,001 pairs / 16 unusable segments, measured
// 2026-08-05), so a wiki re-scrape that ADDS spells keeps them green while a parser
// regression that silently stops matching bullets turns them red.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import classes from '../src/main/data/classes.json'
import spellsJson from '../src/main/data/spells.json'
import { CLASS_ABBRS } from '../src/shared/classCombo'
import {
  classAbbrForDisplayName,
  classDisplayName,
  knownClassDisplayNames,
  parseSpellClasses,
  scanSpellClasses,
  spellLevelFor
} from '../src/shared/spellLevels'

const spells: { name: string; classes?: string }[] = spellsJson.spells
const ABBRS: string[] = [...CLASS_ABBRS]

/** One pass over the whole committed DB, shared by the coverage assertions. */
const scans = spells.map((s) => ({ name: s.name, ...scanSpellClasses(s.classes) }))
const withPairs = scans.filter((s) => s.pairs.length > 0)
const allPairs = scans.flatMap((s) => s.pairs)

// ---- the shape of one field ----------------------------------------------

test('a single-class bullet parses to exactly one (class, level) pair', () => {
  assert.deepEqual(parseSpellClasses('* Enchanter - Level 37'), [{ cls: 'ENC', level: 37 }])
})

test('a multi-class field parses every bullet, sorted by class code', () => {
  // Bind Affinity's real field: six bullets, three of them with a "(Autogranted?)" tail.
  const text =
    '* Cleric - Level 10 (Autogranted) * Druid - Level 12 (Autogranted) ' +
    '* Enchanter - Level 12 (Autogranted?) * Shaman - Level 14 (Autogranted?)'
  assert.deepEqual(parseSpellClasses(text), [
    { cls: 'CLR', level: 10 },
    { cls: 'DRU', level: 12 },
    { cls: 'ENC', level: 12 },
    { cls: 'SHM', level: 14 }
  ])
})

test('both wiki spellings of the Shadow Knight resolve to SHD', () => {
  assert.deepEqual(parseSpellClasses('* Shadow Knight - Level 9'), [{ cls: 'SHD', level: 9 }])
  assert.deepEqual(parseSpellClasses('* Shadowknight - Level 9'), [{ cls: 'SHD', level: 9 }])
})

test('a trailing `+` on the level is read as the level, not dropped with the bullet (JOS-393)', () => {
  // `Sloths Healing` states `* Shaman - Level 50+` and is the ONE row in the committed DB that
  // writes the form (measured 2026-08-16) — which is exactly why it is pinned: a parse that
  // dropped the segment would take the spell out of the level join silently, and the era fold
  // beside it would then have nothing to fold. The `+` itself carries no claim we can use (the
  // wiki means "and above", which is where every spell already stays), so it is IGNORED rather
  // than interpreted, the same way `(Autogranted)` is.
  assert.deepEqual(parseSpellClasses('* Shaman - Level 50+'), [{ cls: 'SHM', level: 50 }])
  assert.equal(spellLevelFor('* Shaman - Level 50+', 'SHM'), 50)
  assert.deepEqual(scanSpellClasses('* Shaman - Level 50+').dropped, [])
  const sloths = spells.find((s) => s.name === 'Sloths Healing')
  assert.ok(sloths, 'the committed DB no longer carries Sloths Healing')
  assert.deepEqual(parseSpellClasses(sloths.classes), [{ cls: 'SHM', level: 50 }])
})

test('a class stated twice keeps the LOWEST level, never a duplicate chip', () => {
  assert.deepEqual(parseSpellClasses('* Druid - Level 44 * Druid - Level 12'), [
    { cls: 'DRU', level: 12 }
  ])
})

test('an absent field and the NPC-only prose both yield nothing, and count nothing', () => {
  assert.deepEqual(scanSpellClasses(undefined), { pairs: [], dropped: [] })
  const npc = scanSpellClasses('This spell is cast by NPCs only.')
  assert.deepEqual(npc.pairs, [])
  // No bullet at all ⇒ no claim was made ⇒ nothing to drop.
  assert.deepEqual(npc.dropped, [])
})

test('a bullet that states no level is DROPPED and countable, never guessed at', () => {
  // Resurrection Effects really says this; "Various" is not a level and must not become one.
  const scan = scanSpellClasses('* Cleric - Various * Paladin - Various')
  assert.deepEqual(scan.pairs, [])
  assert.deepEqual(scan.dropped, ['Cleric - Various', 'Paladin - Various'])
})

test('spellLevelFor answers per class, and null for a class the field does not place', () => {
  const text = '* Cleric - Level 10 * Druid - Level 12'
  assert.equal(spellLevelFor(text, 'CLR'), 10)
  assert.equal(spellLevelFor(text, 'DRU'), 12)
  assert.equal(spellLevelFor(text, 'WIZ'), null)
  assert.equal(spellLevelFor(undefined, 'WIZ'), null)
})

// ---- coverage over the committed DB --------------------------------------

test('the committed spell DB is the one we measured', () => {
  assert.ok(spells.length >= 1900, `only ${spells.length} spells`)
})

test('at least 1,400 spells yield a (class, level) pair', () => {
  // measured 1,455 of 1,926 — the rest are NPC-only, item-only or "No eligible class".
  assert.ok(withPairs.length >= 1400, `only ${withPairs.length} spells placed at a level`)
})

test('at least 1,900 (class, level) pairs come out of the DB', () => {
  // measured 2,001.
  assert.ok(allPairs.length >= 1900, `only ${allPairs.length} pairs`)
})

test('Aanya’s Animation is an Enchanter 37 spell', () => {
  const spell = spells.find((s) => s.name === "Aanya's Animation")
  assert.ok(spell, 'the anchor spell left the DB')
  assert.deepEqual(parseSpellClasses(spell.classes), [{ cls: 'ENC', level: 37 }])
})

test('every parsed level is a real level: an integer in 1..65, never NaN', () => {
  for (const p of allPairs) {
    assert.ok(Number.isInteger(p.level), `${p.cls} level ${String(p.level)} is not an integer`)
    assert.ok(p.level >= 1 && p.level <= 65, `${p.cls} level ${p.level} is out of range`)
  }
})

test('every parsed class is one of the 16 /who codes', () => {
  for (const p of allPairs) assert.ok(ABBRS.includes(p.cls), `unknown class ${p.cls}`)
})

test('no spell places the same class twice', () => {
  for (const s of scans) {
    const seen = s.pairs.map((p) => p.cls)
    assert.deepEqual(seen, [...new Set(seen)], `${s.name} places a class twice`)
  }
})

test('BER, MNK and WAR are placed by ZERO spells — the honest absence, not a parse bug', () => {
  // "Say what the log cannot say": those three classes have no Template:Spellpage spells,
  // so a level-up panel must fall back to skills for them rather than showing an empty list
  // it believes is a lookup failure.
  const placed = new Set(allPairs.map((p) => p.cls))
  for (const abbr of ['BER', 'MNK', 'WAR']) assert.equal(placed.has(abbr), false, `${abbr} gained spells`)
  // …and every other class IS placed, so an empty set can never pass this suite quietly.
  for (const abbr of ABBRS) {
    if (abbr === 'BER' || abbr === 'MNK' || abbr === 'WAR') continue
    assert.ok(placed.has(abbr), `${abbr} is placed by no spell at all`)
  }
})

test('the unusable bullets stay a handful, and are still counted', () => {
  const dropped = scans.flatMap((s) => s.dropped)
  // measured 16 ("None", "NPC Only Spell", "Cleric - Various", prose notes the wiki
  // bulleted into the same list). A jump here means the wiki changed the bullet shape.
  assert.ok(dropped.length > 0, 'the diagnostics hook reported nothing at all')
  assert.ok(dropped.length <= 40, `${dropped.length} unusable bullets — the shape changed`)
})

// ---- parity with the scraped class table ----------------------------------

test('the display-name table matches classes.json name-for-name', () => {
  const wiki = Object.values(classes.names).map((n) => n.toLowerCase())
  const known = knownClassDisplayNames()
  for (const name of wiki) assert.ok(known.includes(name), `classes.json names '${name}', we do not`)
  // The one extra spelling is deliberate and measured: the wiki writes SHD both ways.
  assert.deepEqual(
    known.filter((n) => !wiki.includes(n)),
    ['shadowknight']
  )
  assert.equal(known.length, wiki.length + 1)
})

test('classDisplayName answers for all 16 codes, exactly as classes.json spells them (JOS-402)', () => {
  // The UI's labels are this table (every class filter, offer chip and loadout picker since
  // JOS-402), so a drift from the scrape is a wrong word on screen, not just a stale constant.
  const names: Record<string, string> = classes.names
  for (const abbr of CLASS_ABBRS) {
    assert.equal(classDisplayName(abbr), names[abbr], `${abbr} is not spelled as classes.json does`)
  }
  assert.equal(classDisplayName('SHD'), 'Shadow Knight')
})

test('every display name round-trips back to its own code', () => {
  // The reverse direction is the parse the wiki fields go through, so the two tables in
  // spellLevels.ts have to agree: a name this app PRINTS must be a name it can READ.
  for (const abbr of CLASS_ABBRS) {
    assert.equal(classAbbrForDisplayName(classDisplayName(abbr)), abbr, `${abbr} does not round-trip`)
  }
})
