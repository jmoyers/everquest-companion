// Class knowledge — the static tables the combo inference stands on (Wave 2 of
// docs/plans/class-combo-inference.md § 10).
//
// TWO data sources, both COMMITTED, both asserted here and NEVER re-fetched:
//   src/main/data/classes.json     — written by `npm run scrape:classes` (eqlwiki)
//   src/main/data/spellClasses.ts  — a pure parse of the committed spells.json
// Assertions against the LIVE wiki are forbidden: a test that hits the network fails on a
// wiki edit, an outage, or a plane, and it is the JSON in the tree that ships. The scrape
// is a build step; the file is the authority.
//
// No Electron, no fixtures, no live log — the security.test.mts precedent. This suite
// NEVER skips.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import classes from '../src/main/data/classes.json'
import spellsJson from '../src/main/data/spells.json'
import {
  classesForSpell,
  parseSpellClassString,
  spellClassIndex
} from '../src/main/data/spellClasses'

/** The 16 /who codes. SHD, never SHK — the wiki writes the class two ways, we don't. */
const ALL: string[] = [
  'BER', 'BRD', 'BST', 'CLR', 'DRU', 'ENC', 'MAG', 'MNK',
  'NEC', 'PAL', 'RNG', 'ROG', 'SHD', 'SHM', 'WAR', 'WIZ'
]

const skills: Record<string, string[]> = classes.skills
const abilities: Record<string, string[]> = classes.abilities
const stances: Record<string, string[]> = classes.stances
const invocations: Record<string, string[]> = classes.invocations

// ---- classes.json: the 16 classes ----------------------------------------

test('classes.json names exactly the 16 EQ Legends classes', () => {
  assert.deepEqual(Object.keys(classes.names).sort(), ALL)
  assert.equal(classes.names.SHD, 'Shadow Knight')
  assert.equal(classes.names.BER, 'Berserker')
  // SHK is the classic-EQ code and is NOT what /who prints here.
  assert.equal(Object.keys(classes.names).includes('SHK'), false)
})

test('every class code used anywhere in classes.json is one of the 16', () => {
  const tables = [stances, invocations, skills, abilities]
  for (const table of tables) {
    for (const [key, list] of Object.entries(table)) {
      assert.ok(list.length > 0, `${key} names no class`)
      for (const abbr of list) assert.ok(ALL.includes(abbr), `${key} names unknown class ${abbr}`)
      // Sorted + deduped, so a consumer can compare sets by string equality.
      assert.deepEqual(list, [...new Set(list)].sort(), `${key} is not sorted/deduped`)
    }
  }
})

// ---- stances + invocations: the class-GATED evidence ---------------------

test('the 9 stances are keyed by the string the CLIENT prints', () => {
  // parseCasts.ts lowercases the name captured from "You assume a/an <X> stance." — these
  // nine are the full set observed in the real log.
  assert.deepEqual(Object.keys(stances).sort(), [
    'balanced', 'berserker', 'channeler', 'defensive', 'evasive',
    'mage hunter', 'offensive', 'ranged', 'striker'
  ])
})

test('berserker stance is BER-EXCLUSIVE — the whole reason melee is detectable', () => {
  assert.deepEqual(stances.berserker, ['BER'])
})

test('the 9 invocations are keyed by the CLIENT string, not the wiki prose', () => {
  assert.deepEqual(Object.keys(invocations).sort(), [
    'arcane mastery', 'divine', 'empowering', 'inversion', 'inviolable',
    'overchannel', 'recovery', 'spellblade', 'unyielding'
  ])
  // The wiki's prose row is headed "Empower" and "Over Channel" (and "Overchannel" in the
  // Magician table). The client says "empowering" and "overchannel"; those win the key.
  assert.equal(Object.keys(invocations).includes('empower'), false)
  assert.equal(Object.keys(invocations).includes('over channel'), false)
})

test('unyielding is the four pure-melee classes', () => {
  assert.deepEqual(invocations.unyielding, ['BER', 'MNK', 'ROG', 'WAR'])
})

test('the specific invocations name few classes; the generic ones name twelve', () => {
  assert.deepEqual(invocations.inviolable, ['BRD', 'WIZ'])
  assert.deepEqual(invocations['arcane mastery'], ['ENC', 'MAG', 'NEC', 'SHD', 'WIZ'])
  assert.deepEqual(invocations.spellblade, ['BST', 'PAL', 'RNG', 'SHD'])
  // inversion / overchannel / recovery span 12 classes each — nearly no information,
  // which is exactly why the design weights invocations below stances and skill-ups.
  for (const weak of ['inversion', 'overchannel', 'recovery']) {
    assert.equal(invocations[weak].length, 12, `${weak} should span 12 classes`)
  }
})

// ---- skills: the ONLY window into BER / MNK / WAR / ROG ------------------

test('the signature skill-ups resolve to exactly one class each', () => {
  // These are the names as the client prints them in "You have become better at <X>!",
  // measured against all 55 distinct skill-up names in the real 1.1M-line log.
  assert.deepEqual(skills.Frenzy, ['BER'])
  assert.deepEqual(skills.Backstab, ['ROG'])
  assert.deepEqual(skills.Mend, ['MNK'])
  assert.deepEqual(skills['Flying Kick'], ['MNK'])
  assert.deepEqual(skills['Feign Death'], ['MNK'])
  assert.deepEqual(skills.Singing, ['BRD'])
  assert.deepEqual(skills.Smite, ['PAL'])
})

test('skill keys are client spellings, not the wiki long forms', () => {
  // The wiki writes "1 Hand Slashing" / "Channelling" / "String"; the client abbreviates.
  for (const client of ['1H Blunt', '1H Piercing', '1H Slashing', '2H Slashing', 'Channeling', 'Stringed Instruments', 'Percussion Instruments']) {
    assert.ok(client in skills, `missing client skill name ${client}`)
  }
  for (const wiki of ['1 Hand Slashing', 'Channelling', 'String', 'Percussion', 'Pick Pocket']) {
    assert.equal(wiki in skills, false, `${wiki} is the wiki spelling, not the client's`)
  }
})

test('the skills table carries no scrape junk', () => {
  for (const key of Object.keys(skills)) {
    assert.ok(key.length > 1 && key.length < 40, `implausible skill name ${JSON.stringify(key)}`)
    // Cap columns are numbers; quest-page titles leak in when the section slice over-runs.
    assert.equal(/^\d+\??$/.test(key), false, `${key} is a cap value, not a skill`)
    assert.equal(/quest/i.test(key), false, `${key} is a quest page, not a skill`)
  }
  assert.ok(Object.keys(skills).length >= 60, 'suspiciously few skills')
})

// ---- abilities: the non-Spellpage casts ---------------------------------

test('abilities cover the Paladin gap that spells.json cannot', () => {
  // 441 "Lay on Hands" + 61 "Holy Steed" casts in the real log resolve to no spell page.
  assert.deepEqual(abilities['Lay on Hands'], ['PAL'])
  assert.deepEqual(abilities['Holy Steed'], ['PAL'])
  assert.deepEqual(abilities['Harm Touch'], ['SHD'])
})

test('abilities and spells.json do not overlap — abilities are strictly the gap', () => {
  for (const name of Object.keys(abilities)) {
    assert.deepEqual(classesForSpell(name), [], `${name} is already a spell; drop it`)
  }
})

// ---- disputed: the wiki contradicting itself, carried through -----------

test('disputed[] records every conflict instead of silently picking', () => {
  assert.ok(classes.disputed.length > 0, 'the wiki definitely disagrees with itself')
  for (const d of classes.disputed) assert.ok(d.length > 10, `useless disputed entry ${d}`)
  const blob = classes.disputed.join('\n')
  assert.match(blob, /empowering/)
  assert.match(blob, /overchannel/)
  // Frenzy is a Berserker SKILL and a Shaman/Beastlord SPELL. Unioning the two tables
  // would turn the single best Berserker signal into a Shaman signal.
  assert.match(blob, /skill 'Frenzy'/)
})

test('the three skill/spell name collisions really do disagree', () => {
  for (const name of ['Frenzy', 'Smite', 'Feign Death']) {
    const asSkill = skills[name]
    const asSpell = classesForSpell(name)
    assert.ok(asSpell.length > 0, `${name} should also be a spell`)
    assert.notDeepEqual(asSkill, asSpell, `${name} was expected to disagree across tables`)
  }
})

// ---- spellClasses.ts: the pure parse of spells.json ---------------------

/** Per-class (total, exclusive) counts over a list of class sets. */
function tally(sets: readonly (readonly string[])[]): Map<string, { total: number; excl: number }> {
  const out = new Map<string, { total: number; excl: number }>()
  for (const abbr of ALL) out.set(abbr, { total: 0, excl: 0 })
  for (const set of sets) {
    for (const abbr of set) {
      const row = out.get(abbr)
      if (row) row.total++
    }
    if (set.length === 1) {
      const row = out.get(set[0])
      if (row) row.excl++
    }
  }
  return out
}

const RAW = tally(
  (spellsJson as { spells: { classes?: string }[] }).spells.map((s) => parseSpellClassString(s.classes))
)
const CANON = tally([...spellClassIndex().values()].map((s) => [...s]))

test('BER, MNK and WAR have ZERO spells — three classes invisible to cast evidence', () => {
  for (const abbr of ['BER', 'MNK', 'WAR']) {
    assert.equal(RAW.get(abbr)?.total, 0, `${abbr} should have no spells at all`)
    assert.equal(CANON.get(abbr)?.total, 0, `${abbr} should hold no canon key`)
  }
})

test('ROG has exactly nine spells, all ROG-exclusive', () => {
  assert.equal(RAW.get('ROG')?.total, 9)
  assert.equal(RAW.get('ROG')?.excl, 9)
  assert.equal(CANON.get('ROG')?.total, 9)
})

test('the per-class counts reproduce the design measurement, per spell entry', () => {
  // docs/plans/class-combo-inference.md § 2/C1, measured over the 1926 raw entries.
  //
  // NEC 192 -> 193 AND SHD 90 -> 91 (JOS-439), and they are ONE spell. The game patched on
  // 2026-08-18 and added `Lifebite`, an instant lifetap the wiki page for which was created that
  // day — `* Necromancer - Level 8 (Autogranted) * Shadow Knight - Level 10 (Autogranted)`. The
  // scrape brought it in whole; nothing was overlaid. Both classes gain a row and NEITHER gains an
  // exclusive one, because a spell two classes cast is exclusive to neither — which is exactly the
  // check that makes this pair of numbers worth pinning rather than one of them.
  //
  // Nothing else in that 78-row scrape diff reaches this table: the rest of the patch is the
  // alchemy shelf (`Elixir of *`, `<Resist> Awareness`, `Healing Potion *`), whose `classes` field
  // reads `This spell cannot be cast directly. It is triggered by drinking a …` and parses to no
  // class at all. `Invisibility versus Undead` -> `Invisibility vs. Undead` is a RENAME of a page
  // this table already counted, so its five classes each keep the row they had.
  //
  // AND JOS-440 DOES NOT MOVE THEM EITHER, stated because that ticket removes a row and a reader
  // will expect a removal to show up in a per-class total. It cannot show up HERE: these tallies
  // are taken over the PRISTINE scrape (`spellsJson` directly, no removals and no corrections),
  // which still carries both invisibility pages exactly as the wiki wrote them. The effective
  // index below is where that ticket lands.
  const expected: Record<string, [number, number]> = {
    BRD: [91, 90], BST: [77, 27], CLR: [206, 82], DRU: [268, 152],
    ENC: [239, 184], MAG: [202, 161], NEC: [193, 86], PAL: [91, 17],
    RNG: [92, 20], SHD: [91, 23], SHM: [209, 102], WIZ: [235, 193]
  }
  for (const [abbr, [total, excl]] of Object.entries(expected)) {
    assert.deepEqual([RAW.get(abbr)?.total, RAW.get(abbr)?.excl], [total, excl], `${abbr} drifted`)
  }
})

test('the SHIPPED index is keyed by canon key, so rank variants collapse', () => {
  // The design's table counts raw entries; what ships is keyed by spellCanonKey, which
  // folds "Clarity I…X" into one key. ENC therefore holds 176 exclusive KEYS, not 184
  // exclusive ENTRIES — both numbers are correct, at different granularities.
  //
  // 1412 -> 1411 (JOS-337): the shipped index is built through the REMOVALS layer now, and
  // `Invigor` is the first spell EQ Legends does not have (src/main/data/spellRemovalsList.ts).
  // The RAW tallies above are untouched and still measure 1,926 scrape entries, which is the
  // point of the split — the wiki dataset stays pristine and only the EFFECTIVE index shrinks.
  // No per-class exclusive count moves with it: Invigor was placed for six classes, so it was
  // exclusive to none of them.
  //
  // 1411 -> 1413 (JOS-439), TWO keys from the 2026-08-18 game patch, and only ONE of them is a new
  // spell:
  //   `lifebite` — the new Necromancer 8 / Shadow Knight 10 lifetap.
  //   `invisibility vs. undead` — NOT a new spell. The wiki carries this spell on two pages, and
  //     until the patch they were `Invisibility versus Undead` and `Invisibility Versus Undead`,
  //     which spellCanonKey folded to ONE key. The patch renamed the first to `Invisibility vs.
  //     Undead`; the twin still says `Versus`, so the fold that used to join them no longer does
  //     and the index holds both spellings. No spell was added and no class gained a row (the RAW
  //     tallies above did not move) — a duplicate wiki page simply stopped looking like a
  //     duplicate. Reported to the integrator: a name correction that re-joins the twins is an
  //     owner call under the JOS-161 rename rules, not something a scrape run decides.
  //
  // 1413 -> 1412 (JOS-440), THE OWNER'S CALL, MADE — and the second key above is the one that goes.
  // The twins are re-joined, but NOT in the direction the report above assumed: the wiki's retitle
  // was an editorial edit and the GAME never adopted it. The install's own `spells_us.txt` carries
  // the spell as id 235 `Invisibility Versus Undead`, and the owner's log prints that spelling 83
  // times against 0 for `vs.` — so the surviving key is `invisibility versus undead`, the one a
  // cast line produces, and `invisibility vs. undead` is the key that disappears. A rename alone
  // could not do it: the two pages also disagree about mana (30 vs 40) and cast time (5.00 vs 4.00
  // s), and every fold takes the FIRST row in scrape order, which is the classic page. So the
  // classic page is dropped by a `supersededBy` removal (spellRemovalsList.ts, which carries the
  // client-table reading) and the survivor is renamed by a JOS-161 name correction.
  //
  // NO PER-CLASS COUNT MOVES WITH IT, and that is the check worth having here: both pages placed
  // the SAME five classes at the SAME five levels (NEC 1, SHD 4, CLR 11, ENC 14, PAL 17), so the
  // union that made one key out of two spellings gains and loses nobody. The RAW tallies above are
  // untouched for the usual reason — they measure the pristine scrape, which still carries both
  // pages.
  assert.equal(spellClassIndex().size, 1412)
  assert.equal(CANON.get('ENC')?.excl, 176)
  assert.equal(RAW.get('ENC')?.excl, 184)
  assert.deepEqual(classesForSpell('Clarity II'), classesForSpell('Clarity'))
  assert.deepEqual(classesForSpell('Swift Like the Wind IV'), ['ENC'])
})

test('Minor Healing resolves to exactly the six classes that get it', () => {
  assert.deepEqual(classesForSpell('Minor Healing'), ['BST', 'CLR', 'DRU', 'PAL', 'RNG', 'SHM'])
})

test('CLR is never separable from PAL by these spells — the ambiguity is real', () => {
  // The model must report {CLR,PAL} rather than guessing PAL (design § 4.3).
  for (const spell of ['Reckless Strength', 'Wrath', 'Courage', 'Holy Armor']) {
    assert.deepEqual(classesForSpell(spell), ['CLR', 'PAL'], spell)
  }
})

test('the parser answers "I do not know" instead of guessing', () => {
  assert.deepEqual(parseSpellClassString(undefined), [])
  assert.deepEqual(parseSpellClassString('This spell is cast by NPCs only.'), [])
  assert.deepEqual(parseSpellClassString('No eligible class'), [])
  // Lay on Hands is a Paladin ABILITY with no Spellpage page — classes.json covers it.
  assert.deepEqual(classesForSpell('Lay on Hands VII'), [])
})

test('both wiki spellings of the Shadow Knight canonicalize to SHD', () => {
  assert.deepEqual(parseSpellClassString('* Shadow Knight - Level 24'), ['SHD'])
  assert.deepEqual(parseSpellClassString('* Shadowknight - Level 24'), ['SHD'])
  assert.deepEqual(
    parseSpellClassString('* Shadowknight - Level 24 * Necromancer - Level 16 (Autogranted)'),
    ['NEC', 'SHD']
  )
})
