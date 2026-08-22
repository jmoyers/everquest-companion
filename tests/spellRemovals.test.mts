// JOS-337 — THE WIKI CARRIES A SPELL THE GAME DOES NOT HAVE, AND THE OVERLAY LEARNS TO SAY SO.
//
// `src/main/data/spells.json` is a SCRAPE and `scripts/scrape-spells.ts` rewrites it wholesale, so
// a hand-DELETE out of it is undone by the next re-scrape exactly the way a hand-EDIT is. JOS-150
// built the edit half (`spellCorrections.ts`); this is the delete half, and
// `src/main/data/spellRemovalsList.ts` carries its evidence bar — which is NOT the corrections bar
// and cannot be, because the corrections bar is a line count and absence cannot be counted.
// READ THAT HEADER FIRST. This suite is the guard that keeps the layer from becoming a way to
// delete rows nobody checked.
//
// WHAT IS PINNED HERE:
//
//   1. THE ACCEPTANCE, BY NAME. The corrections layer gets an anti-rot guard for free — every
//      entry restates the text it replaces, so a wiki that moves reports `stale`. A removal has
//      nothing to restate: a misspelled name and a naturally-dropped page are indistinguishable at
//      run time, and the layer deliberately calls BOTH of them `satisfied` (see THE TOMBSTONE).
//      That decision has a price and this is where it is paid: every entry is asserted BY NAME
//      against the committed DB, so a typo is caught in the commit that writes it rather than
//      never.
//   2. THE SHAPE OF THE BAR. A dated verification, an explicitly-stated (or explicitly-null)
//      mechanical reason, and evidence — checked as DATA, because a bar that lives only in prose
//      is a bar the next entry can quietly skip.
//   3. THE CONTRADICTION. A spell cannot be both removed and corrected. The load order makes that
//      fail on its own (a correction naming a removed row reports `unknownSpells`); this refuses
//      the pair STATICALLY too, so the report names the real defect.
//   3b. THE DUPLICATE PAGE (JOS-440). `supersededBy` is a second, narrower claim — "the wiki
//      documents this spell twice and this page is the copy EQ Legends is not running" — and it is
//      held to its own obligations here: the named survivor must be in the effective DB after
//      removals AND corrections, and it is allowed to be a row a `name` correction renames INTO the
//      removed spelling. That last permission is a NARROWING of a rule this suite used to state as
//      a blanket refusal; the argument, and the two assertions that still cover the hazard the
//      blanket rule was written for, are beside the test.
//   4. IDEMPOTENCE, NON-MUTATION, AND THE RE-SCRAPE — both directions, the way
//      tests/spellCorrections.test.mts asks them of every correction.
//   5. THE RIPPLE. The layer exists because a phantom spell is OFFERED to the player, so the
//      tests that matter are the two surfaces that were offering Invigor: the New-at-this-level
//      panel (`buildLevelUnlocks`) and the suggested-alerts catalog (`buildSpellCatalog`).
//
// NO REPORTER BYTES AND NO THIRD-PARTY SPEECH ENTER THIS FILE. The measurements quoted in the list
// file's header were taken over the owner's own log and are stated there as counts; nothing here
// needs a log line at all, because the whole subject is a row that should not exist.
//
// Run: `npm test`.

import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { applySpellRemovals, SPELL_REMOVALS } from '../src/main/data/spellRemovals.ts'
import { SPELL_CORRECTIONS } from '../src/main/data/spellCorrections.ts'
import {
  buildSpellCatalog,
  loadSpellDb,
  spellCorrectionsReport,
  spellRemovalsReport
} from '../src/main/data/spellDb.ts'
import { buildLevelUnlocks } from '../src/main/data/levelUnlocks.ts'
import { classesForSpell } from '../src/main/data/spellClasses.ts'
import type { SpellDbFile, SpellEntry } from '../src/shared/types.ts'
import spellsJson from '../src/main/data/spells.json' with { type: 'json' }

const RAW = (spellsJson as SpellDbFile).spells

// ---------------------------------------------------------------------------------------------
// 1 — THE ACCEPTANCE, BY NAME: the only typo guard this class admits
// ---------------------------------------------------------------------------------------------

test('THE REPORTED DEFECT: Invigor is in the scrape and is NOT in the effective DB', () => {
  // The row the owner's New-at-this-level panel was reading: one row, `Decrease Stamina Loss by
  // 35`, placed at CLR 9 / PAL 22 / DRU 14 / SHM 24 / ENC 24 / RNG 30.
  const before = RAW.filter((s) => s.name === 'Invigor')
  assert.equal(before.length, 1, 'the committed scrape still carries the row this entry removes')
  assert.ok(before[0].classes?.includes('Paladin - Level 22'), 'and still places it at the levels the report names')

  const { spells, report } = applySpellRemovals(RAW)
  assert.equal(spells.filter((s) => s.name === 'Invigor').length, 0, 'the layer drops it')
  // ONE ROW PER ENTRY, and the list has grown past one entry (JOS-440 added the invisibility
  // duplicate page), so this counts the LIST rather than restating a literal that would have to be
  // bumped by every future removal. `every removal removes something…` is where the per-entry
  // accounting is asserted.
  assert.equal(report.removed, SPELL_REMOVALS.length, 'one row per entry, counted')
  assert.deepEqual(report.satisfied, [], 'and nothing was already gone')
})

test('THE INVISIBILITY TWINS: two pages, one spell, and the client says which page (JOS-440)', () => {
  // The second reported defect this layer answers, and the first `supersededBy` entry. eqlwiki
  // carries this spell on TWO pages; a 2026-08-18 retitle of the newer one broke the canon-key fold
  // that had been hiding the duplication, and the unlock panel drew two rows at five levels.
  //
  // THE COMMITTED SCRAPE STILL CARRIES BOTH, which is the point of the layer: the wiki dataset stays
  // pristine and only the EFFECTIVE list shrinks.
  const classic = RAW.filter((s) => s.name === 'Invisibility Versus Undead')
  const modern = RAW.filter((s) => s.name === 'Invisibility vs. Undead')
  assert.equal(classic.length, 1, 'pageid 57190, the classic-EverQuest copy')
  assert.equal(modern.length, 1, 'pageid 49735, retitled by the wiki on 2026-08-18')
  assert.deepEqual(
    [classic[0].mana, classic[0].castTimeMs, classic[0].targetType],
    [30, 5000, 'Single'],
    'the copy this client does not run'
  )
  assert.deepEqual(
    [modern[0].mana, modern[0].castTimeMs, modern[0].targetType],
    [40, 4000, 'Single Friendly (or Self)'],
    'and the one it does — spells_us.txt id 235 states cast 4000, 270 ticks, 40 mana'
  )
  // AND THE SCRAPE ARTIFACT IS THE CLASSIC PAGE'S ALONE: its commented-out items block swallowed
  // the opening `<!--` into the two fields that precede it. The correction that used to patch
  // `msgWearsOff` is retired with the row; `classes` was never patched at all.
  assert.ok(classic[0].msgWearsOff?.includes('<!--'), 'msgWearsOff carries the swallowed comment')
  assert.ok(classic[0].classes?.includes('<!--'), 'and so does classes — the swallow is general')
  assert.ok(!modern[0].msgWearsOff?.includes('<!--'), 'the surviving page has neither')
  assert.ok(!modern[0].classes?.includes('<!--'))

  // THE EFFECTIVE DB HOLDS ONE ROW, under the spelling the game prints, with the client's numbers.
  const rows = loadSpellDb().spells.filter((s) => /^Invisibility (Versus|vs\.) Undead$/.test(s.name))
  assert.equal(rows.length, 1, 'one spell, one row')
  assert.equal(rows[0].name, 'Invisibility Versus Undead', 'the 83 log lines spell it this way; 0 spell it `vs.`')
  assert.deepEqual(
    [rows[0].mana, rows[0].castTimeMs, rows[0].targetType, rows[0].durationText],
    [40, 4000, 'Single Friendly (or Self)', '27 Min'],
    'THE RULING: the joined entry keeps the surviving page`s fields, not whichever row sorted first'
  )
  assert.ok(!rows[0].classes?.includes('<!--'), 'and no leaked markup survives anywhere on it')
  assert.ok(rows[0].classes?.includes('(Autogranted)'), 'including the autogrant note only that page states')
})

test('THE UNLOCK PANEL draws ONE invisibility-vs-undead row at each of the five levels', () => {
  // The reported surface, at the five (class, level) pairs the report names. `buildLevelUnlocks`
  // emits one row per DB ROW, so before the fix this returned two rows carrying the same five
  // pairs and the panel's fold-by-name — which folds only WITHIN a level — had two different names
  // to fold and drew both.
  const data = buildLevelUnlocks()
  const rows = data.spells.filter((s) => /^Invisibility (Versus|vs\.) Undead$/.test(s.name))
  assert.equal(rows.length, 1, 'one row in the dataset, not two')
  assert.deepEqual(
    rows[0].at.map((p) => `${p.cls} ${p.level}`).sort(),
    ['CLR 11', 'ENC 14', 'NEC 1', 'PAL 17', 'SHD 4'],
    'at exactly the five levels the report names'
  )
  assert.deepEqual([rows[0].mana, rows[0].castTimeMs], [40, 4000], 'carrying the client-confirmed figures')
})

test('THE ALERT WIZARD and THE CLASS INDEX hold one invisibility-vs-undead key', () => {
  // Two keys for one spell was the shape of the defect underneath the panel: `spellCanonKey` folds
  // rank suffixes, not abbreviations, so `invisibility versus undead` and `invisibility vs. undead`
  // were two spells everywhere a name is a join key.
  const catalog = buildSpellCatalog(loadSpellDb(), new Map())
  const keys = catalog.entries.filter((e) => e.key.includes('undead') && e.key.startsWith('invisibility'))
  assert.deepEqual(keys.map((e) => e.key).sort(), ['invisibility to undead', 'invisibility versus undead'])
  // And the key the catalog holds is the one a cast line produces: `You begin casting Invisibility
  // Versus Undead.` occurs 28 times in the owner's log and is what class inference reads.
  assert.deepEqual(classesForSpell('Invisibility Versus Undead'), ['CLR', 'ENC', 'NEC', 'PAL', 'SHD'])
  assert.deepEqual(classesForSpell('Invisibility vs. Undead'), [], 'a spelling the game never prints places nobody')
})

test('every removal removes something in the committed DB, or is a stated tombstone', () => {
  // THE PRICE OF THE TOMBSTONE DECISION, paid here. `satisfied` cannot distinguish "the wiki
  // dropped the page" from "somebody misspelled the name", so the report will never fail on a
  // typo. This test is what does: an entry authored against today's spells.json either removes a
  // row or it is a typo, and the day the wiki really drops a page this assertion is the ONE place
  // that has to be updated — deliberately, by a person, who then writes the page's disappearance
  // into the entry's evidence.
  const { report } = applySpellRemovals(RAW)
  assert.deepEqual(
    report.satisfied,
    [],
    'a removal matching no row is a typo until somebody records that the wiki dropped the page'
  )
  assert.equal(report.removed, SPELL_REMOVALS.length, 'one row per entry, on the committed scrape')
})

test('a removal that names a spell nobody looked for cannot hide in the list', () => {
  // The bar's own counter-example, kept executable: `Extinguish Fatigue` is the sibling that shares
  // BOTH of Invigor's messages and is likewise a pure stamina-loss spell — exactly the row a
  // family inference would have swept up. It is still here, because nobody has verified it.
  const { spells } = applySpellRemovals(RAW)
  assert.ok(
    spells.some((s) => s.name === 'Extinguish Fatigue'),
    'absence of evidence is not evidence of absence: an unverified sibling stays in the DB'
  )
})

// ---------------------------------------------------------------------------------------------
// 2 — THE SHAPE OF THE BAR, checked as data
// ---------------------------------------------------------------------------------------------

test('every removal states a dated verification, a reason field and evidence', () => {
  const seen = new Set<string>()
  for (const r of SPELL_REMOVALS) {
    assert.ok(r.spell.length > 0, 'a removal with no spell removes nothing')
    assert.ok(!seen.has(r.spell), `two removals name ${r.spell}`)
    seen.add(r.spell)
    // The date is the whole evidence base for this class, so its shape is checked rather than
    // trusted: a claim about a live service goes stale, and a reader needs to know how old the
    // look was without parsing prose.
    assert.match(r.verified, /^\d{4}-\d{2}-\d{2}$/, `${r.spell}: \`verified\` is an ISO date, not prose`)
    assert.ok(!Number.isNaN(Date.parse(r.verified)), `${r.spell}: \`verified\` must be a real date`)
    // `null` is a REAL answer and the point of the field: a mechanical reason is a much wider claim
    // than a verification and is held to its own bar. What is refused is the empty gesture — a
    // blank string, or whitespace, which reads as "stated" and says nothing.
    assert.ok(r.reason === null || r.reason.trim().length > 20, `${r.spell}: state a real reason or state null`)
    assert.ok(r.evidence.length > 20, `${r.spell}: say what was done and what was found`)
    // A superseded entry does not withdraw a spell, so it owes the name the spell survives under.
    // An absence entry must NOT state one: after it runs the DB says nothing about the spell, and a
    // survivor would mean the entry is a duplicate-page claim filed under the absence bar.
    if (r.supersededBy !== undefined) {
      assert.ok(r.supersededBy.length > 0, `${r.spell}: \`supersededBy\` names the surviving row`)
    }
  }
})

test('a superseded page leaves its spell standing, under the name it says', () => {
  // THE OBLIGATION THAT MAKES `supersededBy` A DIFFERENT CLAIM (JOS-440). An absence removal is
  // asserted to leave NOTHING behind (`THE CLASS INDEX places nobody…`, below); this one is
  // asserted to leave the spell exactly where the player can still reach it. Read through the FULL
  // load — removals then corrections — because the survivor is allowed to be a row that a `name`
  // correction renames into this spelling, which is what JOS-440's pair does.
  const effective = loadSpellDb().spells
  for (const r of SPELL_REMOVALS) {
    if (r.supersededBy === undefined) continue
    const rows = effective.filter((s) => s.name === r.supersededBy)
    assert.equal(rows.length, 1, `${r.spell}: the survivor \`${r.supersededBy}\` must be in the effective DB, once`)
  }
})

test('no spell is both removed and corrected', () => {
  // The load order already makes this fail — removals run first, so a correction naming a removed
  // row reports `unknownSpells` and tests/spellCorrections.test.mts goes red. That backstop reports
  // a rotted CORRECTION, which is the wrong diagnosis: the real defect is two entries disagreeing
  // about whether a spell exists, and it belongs in the lists rather than in a load report.
  const removed = new Set(SPELL_REMOVALS.map((r) => r.spell))
  for (const c of SPELL_CORRECTIONS) {
    for (const s of c.spells) {
      assert.ok(!removed.has(s), `${s} is removed AND corrected — one of the two entries is wrong`)
    }
    // A `name` correction produces a name too, and removing the row it produces USED TO BE refused
    // outright as the same contradiction wearing the destination's spelling. It is not always one,
    // and JOS-440 is the case that separates them: two wiki pages for one spell, the classic copy
    // removed and the surviving copy renamed INTO the removed spelling because that is what the
    // game prints. Nothing is withdrawn — the test above asserts the survivor is still there — so
    // the refusal now applies only where no `supersededBy` entry claims the destination.
    if (c.field === 'name' && removed.has(c.to)) {
      const claimed = SPELL_REMOVALS.some((r) => r.spell === c.to && r.supersededBy === c.to)
      assert.ok(claimed, `${c.to} is removed AND is the target of a rename, with no superseded entry saying so`)
    }
  }
})

// ---------------------------------------------------------------------------------------------
// 3 — IDEMPOTENCE, NON-MUTATION, AND THE RE-SCRAPE (THE TOMBSTONE)
// ---------------------------------------------------------------------------------------------

test('applying the layer twice is applying it once, and the second pass is all tombstone', () => {
  const first = applySpellRemovals(RAW)
  const second = applySpellRemovals(first.spells)
  assert.deepEqual(second.spells, first.spells, 'the second pass must be a no-op on the entries')
  assert.equal(second.report.removed, 0, 'nothing left to remove')
  assert.deepEqual(
    second.report.satisfied,
    SPELL_REMOVALS.map((r) => r.spell),
    'every entry reports satisfied, which is the SAME answer a natural upstream drop produces'
  )
})

test('THE TOMBSTONE: a re-scrape that drops the page reports satisfied, not a failure', () => {
  // The decision this layer had to make, stated as a test. The corrections layer's `from: null`
  // faces the same shortage (an absent field has no text to compare) and resolves it by making
  // absence the match condition; a removal is that argument with the ROW in place of the field.
  // The entry has got exactly what it asked for, so the suite must not go red — and the entry
  // STAYS, because the wiki is editable and a page that vanished in June can be restored in July.
  // Read against ONE entry's page, with the rest of the list held out, so the assertion stays about
  // the tombstone semantic rather than about how many entries the list happens to hold.
  const invigor = SPELL_REMOVALS.filter((r) => r.spell === 'Invigor')
  assert.equal(invigor.length, 1, 'the entry this test is about')
  const dropped = RAW.filter((s) => s.name !== 'Invigor')
  const { spells, report } = applySpellRemovals(dropped, invigor)
  assert.equal(report.removed, 0, 'there was nothing left to remove')
  assert.deepEqual(report.satisfied, ['Invigor'], 'and the entry stands as a tombstone, named')
  assert.equal(spells.length, dropped.length, 'the list is untouched')
})

test('a removal takes EVERY row of its name, the way a NAME correction does', () => {
  // The scrape carries era/rank duplicates, and `rowsFor` in spellCorrections.ts explains why a
  // MESSAGE correction deliberately writes only the first of them: their messages may genuinely
  // differ. Existence cannot differ. Half a removal leaves a phantom that `byKey`,
  // `buildSpellCatalog` and `buildLevelUnlocks` would all still find, which is the whole defect.
  const twinned: SpellEntry[] = RAW.flatMap((s) => (s.name === 'Invigor' ? [s, { ...s, durationMs: 36_000 }] : [s]))
  assert.equal(twinned.filter((s) => s.name === 'Invigor').length, 2)
  const { spells, report } = applySpellRemovals(twinned)
  assert.equal(spells.filter((s) => s.name === 'Invigor').length, 0, 'both rows, or the row is still there')
  assert.equal(report.removed, SPELL_REMOVALS.length + 1, 'counted per ROW, not per entry — the synthetic twin is the +1')
})

test('the layer never writes through the imported JSON module', () => {
  // spells.json is one shared object for the whole process and several suites read it raw
  // (tests/buffUnifiedModel.test.mts reads it for the spellType oracle). The pass copies.
  const before = RAW.length
  applySpellRemovals(RAW)
  assert.equal(RAW.length, before, 'mutating it would leak into every importer')
  assert.ok(RAW.some((s) => s.name === 'Invigor'), 'and the committed scrape still carries what the wiki carries')
})

test('a removal names the SCRAPE`s spelling, so the corrections overlay never sees the row', () => {
  // The order is semantics, not legibility. Removals run first, so a corrected name does not exist
  // yet when the removals list is read — and THE HAZARD is an entry naming a post-correction
  // spelling and therefore matching nothing, which would report itself `satisfied` and look like
  // coverage.
  //
  // THIS USED TO BE A BLANKET REFUSAL OF THE SHAPE and it is now scoped to the hazard (JOS-440).
  // The shape is legitimate when the removal genuinely matches a row of its own in the committed
  // scrape: two wiki pages for one spell, the classic copy removed under the name the game prints,
  // the surviving copy renamed INTO that name because the wiki spells it otherwise. At the moment
  // the removals list is read those are two different names, which is precisely why the order is
  // semantics.
  //
  // AND THE HAZARD IS STILL COVERED, TWICE, WITHOUT THIS RULE — which is why narrowing it costs
  // nothing. `every removal removes something in the committed DB` asserts `report.satisfied` is
  // EMPTY, so an entry that matches nothing is red there; and it asserts `report.removed` equals
  // the entry count, so the other direction — a re-scrape adopting the corrected spelling upstream,
  // both rows sharing the name, one entry eating BOTH — is red there too, rather than silently
  // deleting a spell.
  const corrected = new Set(SPELL_CORRECTIONS.filter((c) => c.field === 'name').map((c) => c.to))
  const { spells } = applySpellRemovals([])
  assert.deepEqual(spells, [], 'sanity: the pass is a filter, not a source')
  for (const r of SPELL_REMOVALS) {
    if (!corrected.has(r.spell)) continue
    assert.equal(
      r.supersededBy,
      r.spell,
      `${r.spell} is a name the corrections layer PRODUCES; only a superseded duplicate may share it`
    )
    assert.ok(
      RAW.some((s) => s.name === r.spell),
      `${r.spell} must name a row of the committed SCRAPE, not only the name a rename produces`
    )
  }
})

// ---------------------------------------------------------------------------------------------
// 4 — THE LOAD SEAM: the layer reaches every derived structure, and runs before the corrections
// ---------------------------------------------------------------------------------------------

test('loadSpellDb builds its tables from the list the removals left behind', () => {
  const db = loadSpellDb()
  const removals = spellRemovalsReport()
  assert.ok(removals, 'the load path reports what it removed')
  assert.equal(removals.removed, SPELL_REMOVALS.length)
  assert.deepEqual(removals.satisfied, [])

  assert.equal(db.byKey.get('invigor'), undefined, 'the join key a cast line would fold to is gone')
  assert.equal(db.spells.length, RAW.length - removals.removed, 'and the row count says so')
  for (const table of [db.castOnYou, db.wearsOff, db.castOnOtherSuffix]) {
    for (const cands of table.values()) {
      assert.ok(!cands.some((c) => c.name === 'Invigor'), 'no derived table may still hold the row')
    }
  }
})

test('the corrections overlay still describes everything, applied AFTER the removals', () => {
  // The real backstop for the contradiction the static test above refuses: if a correction named a
  // removed spell, this report would carry it in `unknownSpells`. The corrections suite runs its
  // own audit over the RAW list, so this is the only place the POST-REMOVAL list is audited.
  const c = spellCorrectionsReport()
  assert.ok(c, 'the load path reports the corrections too')
  assert.deepEqual(c.unknownSpells, [], 'a correction naming a removed spell would land here')
  assert.deepEqual(c.stale, [], 'and removing a row must not move a sentence out from under a correction')
  assert.ok(c.applied > 0, 'the corrections still do their job on the shorter list')
})

test('WHAT THE REMOVAL DOES NOT TAKE WITH IT: both shared sentences keep an owner', () => {
  // Bar rule 4, executable. Invigor's two messages are shared VERBATIM with `Extinguish Fatigue`,
  // so dropping the row changes no message table at all — a line printing either sentence still
  // resolves, and the only thing that changed is who the app OFFERS.
  const db = loadSpellDb()
  const you = db.castOnYou.get('Your body zings with energy.')
  assert.ok(you, 'the self landing is still a message the parser knows')
  assert.deepEqual(you.map((s) => s.name), ['Extinguish Fatigue'], 'under its surviving owner')
  const other = db.castOnOtherSuffix.get('looks energized.')
  assert.ok(other, 'and so is the third-person landing')
  assert.deepEqual(other.map((s) => s.name), ['Extinguish Fatigue'])
})

// ---------------------------------------------------------------------------------------------
// 5 — THE RIPPLE: the two surfaces that were OFFERING the spell
// ---------------------------------------------------------------------------------------------

test('THE UNLOCK PANEL no longer offers Invigor at 22, 24 or 30', () => {
  // The reported surface. `buildLevelUnlocks` joins the DB's `classes` bullet list to level, and
  // the New-at-this-level panel turns each row into a card telling the player what they can go
  // buy — so the owner's PAL/RNG/SHM loadout was being sent to a vendor for a spell that is not
  // there, three times over.
  const data = buildLevelUnlocks()
  assert.equal(data.spells.filter((s) => s.name === 'Invigor').length, 0, 'no card names it')
  const staminaSiblings = data.spells.filter((s) => s.name === 'Extinguish Fatigue')
  assert.equal(staminaSiblings.length, 1, 'and the unverified sibling is untouched — this is not a family purge')
  // The three levels the report names, read the way the panel reads them.
  for (const [cls, level] of [['PAL', 22], ['SHM', 24], ['RNG', 30]] as const) {
    const atLevel = data.spells.filter((s) => s.at.some((a) => a.cls === cls && a.level === level))
    assert.ok(!atLevel.some((s) => s.name === 'Invigor'), `${cls} ${level} must not list it`)
  }
})

test('THE ALERT WIZARD no longer offers Invigor a suggestion', () => {
  // The second surface `buildSpellCatalog` feeds. Invigor is Beneficial with a `msgWearsOff`-less
  // entry, so it earned the `fade` template and was searchable and offerable — an alert for a
  // spell that can never be cast, which is the same law JOS-84 states from the other direction.
  const catalog = buildSpellCatalog(loadSpellDb(), new Map())
  assert.equal(catalog.entries.filter((e) => e.key === 'invigor').length, 0, 'not in the catalog')
  assert.ok(!catalog.entries.some((e) => e.name === 'Invigor'), 'under any key')
  // THE SEARCH BOX, precisely. `searchText` is a substring surface, so "invigor" still matches two
  // OTHER spells and asserting it matches nothing would be asserting a falsehood: `Invigorate` is
  // the NPC-only heal, and `Jaxan's Jig o' Vigor` is the bard song whose wear-off reads `You are no
  // longer invigorated.` — the very song the list file's header measures 1,028 landings of. Both
  // are real rows and both must stay; what must be gone is the entry the search used to name.
  assert.deepEqual(
    catalog.entries.filter((e) => e.searchText.includes('invigor')).map((e) => e.key).sort(),
    ["invigorate", "jaxan's jig o' vigor"],
    'typing "invigor" finds the two spells that exist, and not the one that does not'
  )
  assert.ok(
    catalog.entries.some((e) => e.key === 'extinguish fatigue'),
    'while the unverified sibling stays offerable'
  )
})

test('THE CLASS INDEX places nobody by a spell the game does not have', () => {
  // `spellClasses.ts` is keyed by spell name and read with the name a `castBegin` line carries. No
  // cast line can ever name a spell that is not in the game, so its six classes are evidence about
  // a game that is not running — and `classesForSpell` returning `[]` is the honest answer the
  // module already gives for every NPC-only row.
  assert.deepEqual(classesForSpell('Invigor'), [], 'six classes, none of whom can cast it')
  assert.deepEqual(
    classesForSpell('Extinguish Fatigue'),
    ['CLR', 'DRU', 'ENC', 'RNG', 'SHM'],
    'and the sibling still places exactly who the wiki says'
  )
})

// ---------------------------------------------------------------------------------------------
// 6 — THE SEAM AUDIT: nothing indexes the scrape in front of the overlay
// ---------------------------------------------------------------------------------------------

/**
 * Every `src/` module that ES-imports the scrape MUST route it through the removals seam, or be
 * named here with the reason it does not.
 *
 * WHY A GREP AND NOT A TYPE. AGENTS.md states the standing hazard in one line — "a raw-spells.json
 * importer that looks up BY NAME is a silent miss waiting to happen" — and JOS-161 paid for it
 * once already (`spellClasses.ts` and `levelUnlocks.ts` had to be retrofitted after the rename).
 * The import is the only thing a compiler can see; a new consumer that forgets the overlay type-
 * checks perfectly and is wrong.
 *
 * THE THREE EXEMPTIONS ARE REASONED, NOT GRANDFATHERED, and the third one is a rule about what
 * this layer MEANS rather than a concession.
 *
 * The first two build a name -> boolean ROSTER and both deliberately UNION the raw and corrected
 * spellings of every name, because the parser only ever sees the log's spelling and a membership
 * test must answer to both (charmModel.ts learned that one the hard way and says so in place). Two
 * consequences: passing them a shortened list would change nothing, since the raw list is unioned
 * in regardless — and charmModel.ts additionally walks `raw[i]`/`corrected[i]` in INDEX LOCKSTEP,
 * which a pass that deletes rows would silently break. Neither roster is a catalog anybody is
 * shown; the worst a stale member can do is keep the parser willing to recognize a spell nobody
 * can cast, which is inert.
 *
 * THE THIRD IS `effectIndex.ts`, AND IT MUST STAY ON THE RAW LIST. It joins an ITEM's `Effect:`
 * line to the spell page of the same name, to borrow the one-liner a gear row prints (type,
 * target, duration). A removal says "no player can learn this spell"; it does NOT say "no item
 * carries this effect", and for Invigor the committed items corpus settles it: SEVEN items carry
 * an `Invigor` effect, among them Frozen Efreeti Boots, Tolan's Darkwood Boots and Mrylokar's
 * Greaves. Feeding this join the shortened list would blank the one-liner on seven real,
 * obtainable items in order to hide a spell scroll — a regression bought with a fix. The boundary
 * is worth stating once, here: this layer removes what the app OFFERS the player, never what the
 * app can DESCRIBE.
 */
const RAW_IMPORT_EXEMPT: ReadonlyMap<string, string> = new Map([
  ['src/main/combat/charmModel.ts', 'name->boolean roster; unions raw+corrected and walks them in index lockstep'],
  ['src/main/combat/petNudge.ts', 'name->boolean roster; unions raw+corrected, so a shorter list changes nothing'],
  [
    'src/main/planner/effectIndex.ts',
    'item Effect: -> spell-page join; 7 committed items carry an Invigor effect and a removed row would blank their one-liners'
  ]
])

function tsFilesUnder(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name)
    if (statSync(path).isDirectory()) tsFilesUnder(path, out)
    else if (name.endsWith('.ts') || name.endsWith('.tsx')) out.push(path)
  }
  return out
}

test('every src importer of spells.json goes through the removals seam, or is exempt with a reason', () => {
  const root = new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')
  const offenders: string[] = []
  for (const file of tsFilesUnder(join(root, 'src'))) {
    const rel = file.replace(/\\/g, '/').slice(root.replace(/\\/g, '/').length).replace(/^\/+/, '')
    if (rel.endsWith('src/main/data/spellDb.ts')) continue
    const src = readFileSync(file, 'utf8')
    // The IMPORT, not a mention: every one of these files talks about spells.json in prose.
    if (!/^import\s+\w+\s+from\s+'[^']*spells\.json'/m.test(src)) continue
    if (rel === 'src/main/data/spellDb.ts') continue
    if (RAW_IMPORT_EXEMPT.has(rel)) continue
    if (!src.includes('applySpellRemovals')) offenders.push(rel)
  }
  assert.deepEqual(
    offenders,
    [],
    'a name-keyed index built on the raw scrape still offers spells EQ Legends does not have'
  )
})

test('the exemption list names only files that really exist and really import the scrape', () => {
  // An exemption that has rotted is worse than none: it looks like a decision somebody made about
  // a file, and the file may have been rewritten around it.
  const root = new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')
  for (const [rel, reason] of RAW_IMPORT_EXEMPT) {
    const src = readFileSync(join(root, rel), 'utf8')
    assert.match(src, /^import\s+\w+\s+from\s+'[^']*spells\.json'/m, `${rel} no longer imports the scrape`)
    assert.ok(reason.length > 20, `${rel}: an exemption states why`)
  }
})
