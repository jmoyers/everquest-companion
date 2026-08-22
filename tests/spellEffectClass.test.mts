// JOS-251 — THE CHARM ROSTER, DERIVED. And the audit that says it is the right one.
//
// THE CLAIM UNDER TEST: given the effect lines JOS-251 taught the scrape to capture, "which spells
// charm?" is a QUERY over committed data rather than a regex somebody maintained by hand — and the
// answer it returns is exactly the roster JOS-250's charm-roster research assembled by reading the
// wiki page by page, including every gap and every false positive that research found.
//
// THE ORACLE IS THAT RESEARCH (JOS-250 comment, 2026-08-12), and it is written out below as a
// literal list of names, because the whole value of this test is that the two were produced
// INDEPENDENTLY: one by a human reading spell pages, one by a rule anchored at the head of a
// sentence. A roster that agrees with a hand audit it never saw is a roster that can be trusted to
// notice the next spell nobody thought about.
//
// WHAT THIS FILE PINS AND WHAT IT DOES NOT. The parser swap itself landed on top of JOS-250:
// `ParserConfig.charmSpell` is now the derived set with `CHARM_STEMS` as the fallback for a name
// the catalog does not carry, and tests/charmCcRoster.test.mts asserts the two agree on every row.
// This file is the layer underneath — the grammar, the class memberships, the delta against the
// hand audit, and the separation. `ccSpell` deliberately did NOT move; R3b/R3c pin the derivation's
// answer for the nineteen spells the two disagree about, so the owner ruling that decides them has
// something to land against. The argument is in src/main/log/rulesets.ts under THE HALF-SWAP.
//
// SEPARABILITY IS ASSERTED, NOT ASSUMED (the owner's second constraint). R7 builds the roster from
// the RAW committed JSON with no correction overlay applied at all, and then proves the corrected
// entries produce the IDENTICAL roster — so the derivation layer is not load-bearing for the data,
// and the data is not load-bearing for the derivation. Delete src/main/data/spellEffectClass.ts and
// spells.json is still a complete, valid scrape.
//
// Run: `npm test`.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { SpellDbFile, SpellEntry } from '../src/shared/types.ts'
import spellsJson from '../src/main/data/spells.json' with { type: 'json' }
import {
  EFFECT_RULES,
  charmRoster,
  classifyEffectLine,
  effectRoster,
  holdRoster,
  petSummonRoster,
  spellEffectClasses,
  spellHasEffect
} from '../src/main/data/spellEffectClass.ts'
// The two things this file compares the derivation AGAINST: the name stems it is meant to replace,
// and the overlay it is meant to be independent of.
import { CC_STEMS, CHARM_STEMS } from '../src/main/log/rulesets.ts'
import { applySpellCorrections } from '../src/main/data/spellCorrections.ts'
import { CALM_LANDING_MESSAGES } from '../src/main/data/spellDb.ts'

/** THE RAW SCRAPE. No corrections, no derived durations, no overlay of any kind. */
const RAW: SpellEntry[] = (spellsJson as SpellDbFile).spells

/** Distinct spell NAMES (not canonical keys) carrying `klass`, sorted — for readable assertions. */
function names(klass: Parameters<typeof effectRoster>[1], opts?: Parameters<typeof effectRoster>[2]): string[] {
  const keys = effectRoster(RAW, klass, opts)
  const out = new Set<string>()
  for (const s of RAW) if (keys.has(s.name.toLowerCase())) out.add(s.name)
  return [...out].sort()
}

// ── R1: the roster ──────────────────────────────────────────────────────────────────────────────

/**
 * THE JOS-250 RESEARCH ROSTER, verbatim: every charm a PLAYER can cast.
 *
 * The research states it as class counts — Enchanter 6, Druid 7, Shaman 2 (both shared with the
 * druid list), Necromancer 5, Bard 2 — which is 20 distinct spells, and R1b re-derives those counts
 * from the DB's own `classes` text rather than trusting this comment.
 */
const RESEARCH_CHARMS = [
  'Allure', // Enchanter 46
  'Allure of the Wild', // Druid 43
  'Befriend Animal', // Druid 13 / Shaman 25 — SHARED, and missed by every stem
  'Beguile', // Enchanter 23
  'Beguile Animals', // Druid 33
  'Beguile Plants', // Druid 28
  'Beguile Undead', // Necromancer 31
  "Boltran's Agacerie", // Enchanter 53
  'Cajole Undead', // Necromancer 47
  'Cajoling Whispers', // Enchanter 37
  'Call of Karana', // Druid 52 — missed by every stem
  'Charm', // Enchanter 11
  'Charm Animals', // Druid 23 / Shaman 32 — SHARED
  'Dictate', // Enchanter 60
  'Dominate Undead', // Necromancer 18
  'Enslave Death', // Necromancer 60
  "Solon's Bravura", // Bard 39 — the JOS-200 reversal, and the wiki carries the page twice
  "Solon's Song of the Sirens", // Bard 27 — the JOS-250 contested item, ruled a CHARM by the owner
  'Thrall of Bones', // Necromancer 54
  'Tunare`s Request' // Druid 55 — a 2h45m hold whose break was silent; missed by every stem
].sort()

/** The three the wiki marks `This spell is cast by NPCs only.` — real charms, not player rosters. */
const NPC_CHARMS = ['Alluring Whispers', 'Dragon Charm', 'Vampire Charm']

test('JOS-251 R1: the derived charm roster IS the researched roster, name for name', () => {
  assert.deepEqual(names('charm'), RESEARCH_CHARMS)
  assert.equal(RESEARCH_CHARMS.length, 20, 'twenty player-castable charms')
})

test('JOS-251 R1b: …and its class breakdown is the research`s, re-derived from the DB', () => {
  const per = (cls: string): string[] =>
    names('charm').filter((n) => RAW.some((s) => s.name === n && new RegExp(`\\*\\s*\\[*${cls}`).test(s.classes ?? '')))
  assert.equal(per('Enchanter').length, 6, 'Charm 11 → Dictate 60')
  assert.equal(per('Druid').length, 7, 'three of these had no stem at all')
  assert.deepEqual(per('Shaman'), ['Befriend Animal', 'Charm Animals'], 'both shared with the druid list')
  assert.equal(per('Necromancer').length, 5)
  assert.deepEqual(per('Bard'), ["Solon's Bravura", "Solon's Song of the Sirens"])
})

test('JOS-251 R1c: the NPC charms are real charms, and are excluded by the CASTABLE gate', () => {
  // `Your <X> spell has worn off of <mob>.` names a spell YOU cast, so a spell no player can cast
  // can never appear in one — the exclusion charmCcRoster.test.mts and SLOW_SPELLS both make. The
  // effect line still says charm, and dropping the gate says so.
  for (const n of NPC_CHARMS) {
    const row = RAW.find((s) => s.name === n)
    assert.ok(row, `spells.json must still carry ${n}`)
    assert.ok(spellHasEffect(row, 'charm'), `${n} is a charm by its effect line`)
  }
  assert.deepEqual(names('charm', { castableOnly: false }).filter((n) => NPC_CHARMS.includes(n)), NPC_CHARMS)
  assert.deepEqual(names('charm').filter((n) => NPC_CHARMS.includes(n)), [])
})

// ── R2: the delta against the stems the derivation replaces ─────────────────────────────────────

/**
 * THE FALSE POSITIVES the JOS-250 audit measured to their consumers, each a spell whose NAME reads
 * like a charm and whose EFFECT LIST says something else entirely.
 *
 * JOS-250 removed all four from `CHARM_STEMS` by hand, days before this file existed, so the stems
 * and the derivation now agree about them — which is the good outcome and also the reason these
 * are asserted against the EFFECT LINE rather than against the stem delta. The claim being pinned
 * is that reading the wiki's own words gets these right WITHOUT anybody having to notice them.
 */
const AUDIT_FALSE_POSITIVES: Record<string, string> = {
  'Allure of Death': 'necro self-buff — the `allure` stem used to catch it',
  "Boltran's Animation": 'a PET SUMMON with a 9,000 ms cast — the `boltran` stem armed a 10.5-second false charm window, the exact foreign-pet adoption the ownership model exists to prevent',
  "Naki's Charm of Pernicity": 'an ITEM focus effect — a charm is a trinket as well as a spell in this game',
  "Tavee's Charm of Diuturnity": 'the second item focus effect'
}

test('JOS-251 R2: every false positive the audit found is a non-charm by its effect line', () => {
  for (const [name, why] of Object.entries(AUDIT_FALSE_POSITIVES)) {
    const row = RAW.find((s) => s.name === name)
    assert.ok(row, `spells.json must still carry "${name}" — a table naming a spell that no longer exists is a stale claim, not a passing test`)
    assert.ok(!spellHasEffect(row, 'charm'), `"${name}" must not be a charm — ${why}`)
    assert.ok(row.effects?.length, `…and it must say what it IS: ${JSON.stringify(row.effects)}`)
    // The stems agree TODAY because a human fixed them. If a later edit puts one back, the
    // derivation is the thing that was right all along, and this says so.
    assert.ok(!CHARM_STEMS.test(name), `CHARM_STEMS must still refuse "${name}" — ${why}`)
  }
})

test('JOS-251 R2b: and every charm the audit had to hand-add is derived without being told', () => {
  // The other half: three druid charms that matched no stem (the druid's FIRST charm and their last
  // two), the NPC line the `allure` stem could not reach, and the bard song the owner ruled on.
  // Each needed a hand edit in JOS-250; each falls out of the effect list for free.
  for (const n of ['Befriend Animal', 'Call of Karana', 'Tunare`s Request', "Solon's Song of the Sirens"]) {
    assert.ok(names('charm').includes(n), `the derivation must find "${n}"`)
  }
  assert.ok(names('charm', { castableOnly: false }).includes('Alluring Whispers'), 'the NPC one')
})

// ── R3: the hold roster, and the JOS-225 line it must not cross ─────────────────────────────────

test('JOS-251 R3: the hold roster is mez ∪ root, and a movement debuff is in NEITHER', () => {
  const holds = holdRoster(RAW)
  // THE JOS-225 REPORT, restated as a derivation property: a mob under either Largo's keeps
  // swinging. The stems had to be TOLD that, twice, by two reporters; the effect line says it.
  for (const n of ["Largo's Melodic Binding", "Largo's Assonant Binding"]) {
    const row = RAW.find((s) => s.name === n)
    assert.ok(row, `spells.json must still carry "${n}"`)
    assert.ok(!holds.has(n.toLowerCase()), `"${n}" holds nothing — that is the JOS-225 report`)
    assert.ok(spellHasEffect(row, 'slow'), `"${n}" is an attack-speed debuff — the JOS-233 ruling`)
  }
  // …AND THE RULING WAS HALF RIGHT, which the effect lines are the first thing in the tree able to
  // say. JOS-233 called both songs "an attack-speed debuff as well as a snare"; only the level-51
  // one carries a `Decrease Movement Speed` line at all. Both still fire `group:slow:mob`, which is
  // the alert the ruling actually assigned, so nothing about it needs revisiting — but a future
  // reader reaching for "the snare songs" should be reaching for one of them.
  assert.ok(!spellHasEffect(RAW.find((s) => s.name === "Largo's Melodic Binding")!, 'snare'), 'AC and attack speed only')
  assert.ok(spellHasEffect(RAW.find((s) => s.name === "Largo's Assonant Binding")!, 'snare'), '61% at L60')
  // …and the roster does contain the thing it is named for.
  assert.ok(holds.has('mesmerize'), 'the enchanter mez')
  assert.ok(holds.has('root'), 'and the root that gives the alert group its other half')
})

/**
 * THREE MORE FALSE POSITIVES, FOUND BY THIS DERIVATION AND STILL LIVE IN `CC_STEMS` AS THIS LANDS.
 *
 * They are the same defect as the JOS-225 report — a spell whose wear-off announces "Mez / root
 * broke" while its target never stopped moving — and they are recorded here rather than fixed
 * because `rulesets.ts` belongs to the JOS-250 build until it merges. The assertion is on the
 * DERIVATION being right about them, so the swap has something to land against.
 */
const CC_STEM_FALSE_POSITIVES: Record<string, string> = {
  Ensnare: 'druid 26 — a pure `Decrease Movement Speed by 40%`, caught by the `ensnar` stem that exists for Ensnaring ROOTS',
  Suffocate: 'enchanter 26 — a damage-over-time and stat debuff; the `suffocat` stem holds nothing',
  'Suffocating Sphere': 'enchanter 4 — the same, one tier down'
}

test('JOS-251 R3b: three spells CC_STEMS claims today are not holds by their effect lines', () => {
  const holds = holdRoster(RAW)
  for (const [name, why] of Object.entries(CC_STEM_FALSE_POSITIVES)) {
    const row = RAW.find((s) => s.name === name)
    assert.ok(row, `spells.json must still carry "${name}"`)
    assert.ok(CC_STEMS.test(name), `the stems really do claim "${name}" — ${why}`)
    assert.ok(!holds.has(name.toLowerCase()), `"${name}" is not a hold — ${why}`)
    assert.ok(!spellHasEffect(row, 'mez') && !spellHasEffect(row, 'root'), `${name}: ${why}`)
  }
})

test('JOS-251 R3c: and `Root` itself — which no stem has ever matched — is in the roster', () => {
  // The gap in the other direction, and it is the plainest one in the tree: the spell literally
  // named Root (Wizard 3 / Enchanter 6 / Druid …) is absent from CC_STEMS, so its break has never
  // reached the "Mez / root broke" group at all.
  assert.ok(!CC_STEMS.test('Root'), 'the stems really do miss it')
  assert.ok(holdRoster(RAW).has('root'))
  assert.equal(names('root').length, 12, 'the castable, target-side root ladder')
})

// ── R4: the grammar itself ──────────────────────────────────────────────────────────────────────

test('JOS-251 R4: the rules are disjoint over every effect line in the catalog', () => {
  // One line, at most one class. Asserted rather than assumed, because the classifier returns the
  // FIRST matching rule and a silent overlap would make the answer depend on table order.
  const clashes: string[] = []
  for (const s of RAW) {
    for (const line of s.effects ?? []) {
      const hits = EFFECT_RULES.filter((r) => r.test.test(line.trim())).map((r) => r.klass)
      if (hits.length > 1) clashes.push(`${line} → ${hits.join(', ')}`)
    }
  }
  assert.deepEqual(clashes, [])
})

test('JOS-251 R4b: the anchor is what keeps the near-misses out', () => {
  // Each of these matched a stem-shaped substring search and is excluded by reading the HEAD of the
  // line instead. They are the whole difference between this module and the regexes it replaces.
  assert.equal(classifyEffectLine('Add Melee Proc: Stunning Strike'), null, 'adds a proc, does not stun')
  assert.equal(classifyEffectLine('See Invisible(1)'), null, 'detection, not invisibility')
  assert.equal(classifyEffectLine('Fear Immunity'), null, 'the opposite of fear')
  assert.equal(classifyEffectLine('Decrease Hitpoints by 400'), null, 'no opinion is the honest answer')
  // …and the positives they are near.
  assert.equal(classifyEffectLine('Stun for 8.0 seconds'), 'stun')
  assert.equal(classifyEffectLine('Invisibility versus Undead'), 'invisibility')
  assert.equal(classifyEffectLine('Fear (up to L52)'), 'fear')
})

test('JOS-251 R4c: both wiki phrasings of a charm read the same, and a spell can be two things', () => {
  assert.equal(classifyEffectLine('Charm up to level 25'), 'charm', 'the Spellpage form')
  assert.equal(classifyEffectLine('Charm (up to L37)'), 'charm', 'the Spellpagesmart form')
  const sirens = RAW.find((s) => s.name === "Solon's Song of the Sirens")
  assert.ok(sirens)
  assert.deepEqual(sirens.effects, ['Charm (up to L37)', 'Decrease Magic Resist by 4 (L27) to 8 (L60)'])
  assert.deepEqual(spellEffectClasses(sirens), ['charm'], 'the resist debuff is not a class this module reads')
  assert.equal(sirens.instrumentEnhanced, 'Yes (just the resists debuff)', 'the bard row, captured verbatim')
})

test('JOS-251 R4d: the per-class membership counts, pinned', () => {
  // A re-scrape that widens or narrows a class fails HERE, with the class named, instead of drifting
  // into somebody's alert list. Counts are canonical (rank-stripped) names, ungated.
  //
  // THE 2026-08-18 GAME PATCH MOVED TWO OF THESE, AND NEITHER IS A NEW ABILITY (JOS-439):
  //
  //   haste 44 -> 45. The patch's `Elixir of Speed I..IX` (six rows) all read
  //     `Increase Attack Speed by N%`, which is the haste rule's own anchor. Six ROWS, ONE
  //     canonical name (`elixir of speed` — the rank suffix is stripped), so the count moves by
  //     one. They are potion clickies (`classes` says the spell cannot be cast directly), which is
  //     why they widen the roster without widening anybody's spell book. Note also what did NOT
  //     move: `Jonthan's Provocation` was re-worded from `Increase Melee Haste by 3%` to
  //     `Increase Attack Speed by 48% (L45) to 50% (L47)` and classifies as `haste` either way —
  //     the anchor reads both phrasings, which is the whole argument for anchoring at the head of
  //     the sentence instead of matching a stem.
  //   invisibility 19 -> 20. NO spell was added. The wiki keeps this one spell on two pages, and
  //     until the patch both were spelled `Invisibility versus/Versus Undead`, folding to one
  //     canonical name; the patch renamed one of them to `Invisibility vs. Undead` and the fold
  //     stopped joining them. The EFFECT line on both is still the string `Invisibility versus
  //     Undead` (R4b asserts on it below, unchanged) — it is the NAME that split.
  //
  // AND JOS-440 PUT THE TWINS BACK TOGETHER WITHOUT MOVING THIS NUMBER, which is worth writing
  // down because the ticket predicted 20 -> 19 and the prediction was wrong for a reason this file
  // exists to state. JOS-440 drops the classic duplicate page (a `supersededBy` removal) and
  // renames the survivor to the spelling the game prints, so the EFFECTIVE catalog holds one
  // invisibility key where it held two. This roster is not the effective catalog: `RAW` is the
  // committed scrape with NO overlay of any kind — that is R7's separation, asserted directly
  // below — so it still sees both pages and still counts 20. A future re-scrape that drops the
  // duplicate page UPSTREAM is what moves this number to 19, and it will be a diff of spells.json
  // rather than of the overlay.
  const all = (k: Parameters<typeof effectRoster>[1]): number =>
    effectRoster(RAW, k, { castableOnly: false, targetOnly: false }).size
  assert.deepEqual(
    Object.fromEntries(EFFECT_RULES.map((r) => [r.klass, all(r.klass)])),
    {
      charm: 23, summonPet: 102, mez: 16, root: 24, snare: 31, slow: 34, haste: 45, fear: 15,
      stun: 92, blind: 12, pacify: 12, memblur: 17, invisibility: 20, feignDeath: 2,
      // JOS-318, the class the alert catalog reads. 67 rows / 66 canonical names.
      healOverTime: 66
    }
  )
})

// ── R9: the heal-over-time class (JOS-318) ──────────────────────────────────────────────────────

test('JOS-318 R9: the HoT class reads BOTH wiki phrasings, and no DoT', () => {
  // The two heads, each on the row that names them, plus the casing/spelling variants the same
  // scrape carries. See the rule's own note in spellEffectClass.ts for the measurement.
  assert.equal(classifyEffectLine('Increase Hitpoints by 60 per tick'), 'healOverTime', 'Flowering Heal')
  assert.equal(classifyEffectLine('Increase Current Hit Points by 160 per Tick'), 'healOverTime', 'Slugs Healing')
  assert.equal(classifyEffectLine('Increase Hitpoints v2 by 300 per tick'), 'healOverTime', 'Torpor')
  assert.equal(classifyEffectLine('Increase hitpoints by 4 per tick'), 'healOverTime', 'Natureskin')
  assert.equal(
    classifyEffectLine('Increase Hitpoints between 55 and 55 for two additional ticks.'),
    'healOverTime',
    'the cleric Echo family'
  )
  // THE ANCHOR IS DOING THE WORK, exactly as it does for every rule above. A DoT tick is a DECREASE,
  // a mana regen is not hit points, a direct heal does not tick, and a delayed lump is not per-tick.
  assert.equal(classifyEffectLine('Decrease Hitpoints by 30 per tick'), null, 'that is a DoT')
  assert.equal(classifyEffectLine('Decrease Current Hit Points by 100 per Tick'), null)
  assert.equal(classifyEffectLine('Increase Mana by 10 per tick'), null, 'mana is not a heal')
  assert.equal(classifyEffectLine('Increase Hitpoints by 688'), null, "Kragg's Salve is a direct heal")
  assert.equal(classifyEffectLine('Increase Hitpoints by 197 after 4 ticks'), null, 'a delayed lump')
})

test('JOS-318 R9b: the roster answers for every HoT the OWNER`S LOG has printed a tick for', () => {
  // The check that matters for a claim an alert rests on: not "does the regex match the rows I read"
  // but "does it read the spells the game actually ticks for". These 19 names are every distinct
  // `<healer> healed <target> over time for N hit points by <Spell>.` spell in the owner's whole log
  // (eqlog_Primitive_freeport.txt, 1,732,267 lines, measured 2026-08-14), with their counts.
  const LOGGED: readonly [string, number][] = [
    ['Snails Healing', 455], ['Tortoises Healing', 314], ['Slugs Healing', 248],
    ['Ethereal Cleansing', 214], ['Echoing Light', 93], ['Celestial Echo', 57], ['Sacred Echo', 57],
    ['Renewing Echo', 48], ['Sprouting Heal', 48], ['Efflorescing Heal', 35], ['Celestial Remedy', 34],
    ['Blossoming Heal', 22], ['Flowering Heal', 16], ['Budding Heal', 6], ['Echo of Health', 4],
    ['Stoicism', 3], ['Blooming Heal', 3], ['Impassivity', 1]
  ]
  const roster = effectRoster(RAW, 'healOverTime', { castableOnly: false, targetOnly: false })
  const missing = LOGGED.filter(([n]) => !roster.has(n.toLowerCase())).map(([n]) => n)
  assert.deepEqual(missing, [], 'a spell the log ticks for that the effect read cannot see')
  // THE ONE THE LOG PRINTS AND NO ROSTER CAN EVER HOLD, stated rather than quietly dropped: five
  // `Harm Touch IX` ticks. `Harm Touch` is not in spells.json at all, so it is out of every derived
  // structure, and its alert path is the `healsOverTime` template's own gate refusing to offer a
  // chip for a spell the catalog does not carry — not a silent miss.
  assert.equal(RAW.some((s) => s.name.startsWith('Harm Touch')), false, 'absent from the scrape')
})

// ── R8: the pet-summon class (JOS-258) ──────────────────────────────────────────────────────────

test('JOS-258 R8: the summon class reads what the spell DOES, not how the wiki FILED it', () => {
  // THE ARGUMENT FOR THE CLASS EXISTING AT ALL. `spellType === 'Pet'` is the obvious test and it is
  // NARROWER than the effect list it is supposed to summarise: 83 rows carry that type, 104 rows
  // say `Summon Pet:` in words. The gap is not noise — it is the magician's top elementals.
  // PER ROW, not through `names()`: this family has ranked members (Monster Summoning I/II/III) and
  // the roster is keyed canonically, so a name-vs-key comparison would report a phantom gap.
  const byType = RAW.filter((s) => s.spellType === 'Pet').map((s) => s.name)
  const byEffect = RAW.filter((s) => spellHasEffect(s, 'summonPet')).map((s) => s.name)
  assert.equal(byType.length, 83, 'the type column')
  assert.equal(byEffect.length, 104, 'the effect lines')
  // Every typed row is found by the effect read; the reverse is 21 rows the type column misses —
  // the magician's whole Vocarate/Greater Vocaration top end, and the necromancer's three
  // differently-spelled pets.
  assert.deepEqual(byType.filter((n) => !byEffect.includes(n)), [], 'the effect read is a superset')
  assert.deepEqual(byEffect.filter((n) => !byType.includes(n)).sort(), [
    'Dyzil`s Deafening Decoy',
    'Emissary of Thule',
    'Flaming Sword of Xuzl',
    'Greater Vocaration: Air',
    'Greater Vocaration: Earth',
    'Greater Vocaration: Fire',
    'Greater Vocaration: Water',
    'Minion of Shadows',
    'Mistwalker',
    'Monster Summoning III',
    'Nature Walkers Behest',
    'Rage of Zomm',
    'Servant of Bones',
    'Spirit of the Howler',
    'Summon Golin',
    'Unswerving Hammer',
    'Vocarate: Air',
    'Vocarate: Earth',
    'Vocarate: Fire',
    'Vocarate: Water',
    'Zumaik`s Animation'
  ])
})

test('JOS-258 R8b: three heads, and the near-misses the anchor keeps out', () => {
  // The necromancer's two top pets and the level-59 spectre are spelled differently on the wiki,
  // so the rule names all three heads rather than assuming one phrasing (JOS-84's lesson, applied
  // before it costs anything).
  assert.equal(classifyEffectLine('Summon Pet: Level 19 Skeletal Pet'), 'summonPet')
  assert.equal(classifyEffectLine('Summon Skeleton Pet: skel_pet_43_'), 'summonPet', 'Minion of Shadows')
  assert.equal(classifyEffectLine('Summon Spectre Pet'), 'summonPet', 'Emissary of Thule')
  // …and the things that mention a pet without summoning one. `Call Pet` is Summon Companion, which
  // TELEPORTS the pet you already have — a nudge armed by it would fire with a pet already bound.
  assert.equal(classifyEffectLine('Call Pet'), null, 'Summon Companion moves a pet, it does not make one')
  assert.equal(classifyEffectLine('Pet Power Increase (10)'), null)
  assert.equal(classifyEffectLine('Decrease Pet Size by 50%'), null, 'Tiny Companion')
  assert.equal(classifyEffectLine('Summon Item: Bone Chips'), null, '141 rows of conjured objects')
  assert.equal(classifyEffectLine('Summon Corpse'), null)
})

test('JOS-258 R8c: the roster gate is INVERTED against the charm one, and on purpose', () => {
  // `petSummonRoster` turns `targetOnly` OFF. Its consumer is `You begin casting <Spell>.`, a
  // sentence about the CASTER, and 103 of the 104 rows are `targetType: Self` — the charm reader's
  // gate would throw away essentially the whole family.
  assert.equal(petSummonRoster(RAW).size, 99, 'castable, either target type')
  assert.equal(effectRoster(RAW, 'summonPet').size, 1, 'the default gate keeps only Flaming Sword of Xuzl')
  // The castable gate stays ON: no player prints a cast line for an NPC-only spell.
  assert.deepEqual(
    names('summonPet', { castableOnly: false, targetOnly: false }).filter((n) => !names('summonPet', { targetOnly: false }).includes(n)),
    ['Manifest Elements', 'Mistwalker', 'Summon Golin']
  )
})

test('JOS-251 R4e: the scrape captured an effect list for all but four spells', () => {
  const file = spellsJson as SpellDbFile
  // 2 -> 3 on 2026-08-22: the scraper began capturing `recast_time` (SpellEntry.recastMs).
  assert.equal(file.schema, 3, 'the effect-list schema')
  assert.equal(file.withEffects, RAW.filter((s) => s.effects?.length).length, 'the header counts what the rows carry')
  // 1 -> 4 (JOS-439), 4 -> 3 (2026-08-22): a wiki editor filled Heritage of Mistmoore's effect
  // box that same day ("Added spell effects to appropriate box", the edit our rescrape caught).
  // The two Improved Vampirism stubs are still slotless, and the pre-existing one is `Instill`.
  // Naming them is the assertion: `effects: undefined` means THE WIKI SAID NOTHING, never "this
  // spell does nothing" (the scrape writes the field absent rather than `[]` for exactly that
  // reason), and a silent jump here would be the derived charm, mez and pet rosters quietly
  // losing members.
  assert.deepEqual(
    RAW.filter((s) => !s.effects?.length).map((s) => s.name).sort(),
    ['Improved Vampirism II', 'Improved Vampirism III', 'Instill']
  )
  assert.equal(RAW.length - file.withEffects!, 3, 'exactly three pages state no slot table at all')
  assert.equal(RAW.filter((s) => s.instrumentEnhanced).length, 79, 'the bard pages')
})

// ── R5: the cross-oracle ────────────────────────────────────────────────────────────────────────

test('JOS-251 R5: the calm line read two ways — and the two oracles disagree, in both directions', () => {
  // spellDb.ts derives the calm line from three LANDING SENTENCES. That is the other kind of oracle
  // — the one JOS-84 and JOS-200 showed is not an effect oracle — so putting the two side by side
  // is the cheapest available audit of both. They overlap on six spells and disagree on ten, and
  // BOTH disagreements are informative rather than a bug in either.
  const byMessage = RAW.filter((s) => s.msgCastOnOther != null && CALM_LANDING_MESSAGES.has(s.msgCastOnOther)).map((s) => s.name)
  const byEffect = names('pacify', { castableOnly: false, targetOnly: false })
  assert.deepEqual(
    byEffect.filter((n) => byMessage.includes(n)),
    ['Calm', 'Calm Animal', 'Lull', 'Pacify', 'Soothe', 'Wake of Tranquility'],
    'the core the two oracles agree on'
  )

  // MESSAGE-ONLY: the enchanter FACTION ladder, whose effect lines say `Increase Faction by 100`
  // and nothing about aggro at all. They print a calm landing sentence because a faction bump is
  // how EQ implements that flavour of pacification — so this is a case where the message is the
  // better evidence, and `spellCalmsTarget` is right to claim them. Worth knowing, not worth moving.
  assert.deepEqual(byMessage.filter((n) => !byEffect.includes(n)).sort(), ['Alliance', 'Atone', 'Benevolence', 'Collaboration'])

  // EFFECT-ONLY: six spells the message oracle cannot see, two of them (Harmony, Lull Animal) named
  // in spellDb.ts's own header as an honest gap — the wiki lost their cast-on-other message. The
  // other four are simply not in the three sentences. This is the direction the effect list was
  // captured for: a roster derived from messages is a roster of what the game says, and a roster
  // derived from effects is a roster of what the spell does.
  assert.deepEqual(byEffect.filter((n) => !byMessage.includes(n)), [
    'Harmony',
    'Harmony of Nature',
    "Kelin's Lugubrious Lament",
    'Lull Animal',
    'Numb the Dead',
    'Rest the Dead'
  ])
})

// ── R6/R7: purity and separability ──────────────────────────────────────────────────────────────

test('JOS-251 R6: classification never writes through the entry it is handed', () => {
  const before = JSON.stringify(RAW)
  for (const s of RAW) spellEffectClasses(s)
  charmRoster(RAW)
  holdRoster(RAW)
  assert.equal(JSON.stringify(RAW), before, 'the imported JSON module is shared by every reader in the process')
})

test('JOS-251 R7: THE SEPARATION — the roster comes off the RAW scrape, and the overlay changes nothing', () => {
  // Half one: the derivation needs no overlay. `RAW` is the committed JSON exactly as the scrape
  // wrote it — no corrections, no derived durations, no learned message overlay — and it produces
  // the whole roster.
  assert.deepEqual([...charmRoster(RAW)].sort(), RESEARCH_CHARMS.map((n) => n.toLowerCase()).sort())

  // Half two: the overlay is not load-bearing for the derivation either. The corrections rename and
  // re-message rows (JOS-161 renames both Bravura rows), and the roster is IDENTICAL apart from the
  // renamed key it is supposed to change — stated by name so a future correction that silently
  // moved a charm out of the roster fails here.
  const corrected = applySpellCorrections(RAW).spells
  const rawKeys = charmRoster(RAW)
  const corrKeys = charmRoster(corrected)
  assert.deepEqual([...corrKeys].filter((k) => !rawKeys.has(k)), ["solon's bewitching bravura"])
  assert.deepEqual([...rawKeys].filter((k) => !corrKeys.has(k)), ["solon's bravura"])
  assert.equal(rawKeys.size, corrKeys.size, 'a rename, and nothing else')
})
