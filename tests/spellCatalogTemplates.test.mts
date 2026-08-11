// JOS-103 — THE SUGGESTION CATALOG SAYS WHAT IT CAN ACTUALLY DO.
//
// THE REPORT (01KZH1YK7YPRC40QPV00X1Z4NX, v0.12.0): Spirit of the Puma is missing from suggested
// alerts. It is in the committed spell DB; it was never in the CATALOG the wizard searches,
// because `suggestionTemplates` compared `spellType` to the two string literals 'Beneficial' and
// 'Detrimental', Puma's type is 'Proc Buff', and a spell that earns no template and is not an
// illusion is DROPPED by `buildSpellCatalog`. Searching "puma" returned nothing at all.
//
// THE LAW BEING ENFORCED, which is why this file is bigger than that one-line fix: every template
// flag is a CLAIM THAT THE ALERT CAN FIRE (shared/alertGroups.ts, and the whole of JOS-84). A
// guessed trigger that never fires is worse than an absent feature, because the user believes
// they are covered. So the tests below check both directions — the spells that were missing are
// present, AND the suggestions that could never have fired are gone.
//
// Run: `npm test`.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  CLASSIFIED_SPELL_TYPES,
  buildSpellCatalog,
  castOnOtherSuffix,
  loadSpellDb
} from '../src/main/data/spellDb'
import { subjectCapturePattern } from '../src/shared/alertCaptures'

const db = loadSpellDb()
const catalog = buildSpellCatalog(db, new Map())
const byKey = new Map(catalog.entries.map((e) => [e.key, e]))

test('THE REPORT: Spirit of the Puma is in the catalog the wizard searches', () => {
  const puma = byKey.get('spirit of the puma')
  assert.ok(puma, 'searching "puma" in Suggested must find something')
  assert.equal(puma.name, 'Spirit of the Puma')
  assert.equal(puma.spellType, 'Proc Buff', 'the type that used to make it invisible')
  // Its searchable surface carries the game's own words, so "growls" finds it too.
  assert.ok(puma.searchText.includes('growls with the spirit of the puma'))
})

test('the spellType table is EXHAUSTIVE over the committed DB', () => {
  // The tripwire for a re-scrape. A spellType this table does not name folds to 'unknown' and
  // silently loses its disposition-gated templates — which is exactly the defect that was
  // reported, so it must fail loudly here instead of quietly in the wizard.
  const unclassified = new Set<string>()
  for (const s of db.spells) {
    const t = s.spellType
    // A spell with NO spellType at all is a stated absence, not an unclassified value.
    if (t && !CLASSIFIED_SPELL_TYPES.has(t)) unclassified.add(t)
  }
  assert.deepEqual(
    [...unclassified],
    [],
    'spells.json grew a spellType the catalog does not classify — add it to BENEFICIAL_TYPES or DETRIMENTAL_TYPES in spellDb.ts'
  )
})

test('the classification recovered spells the two literals dropped', () => {
  // Named cases, so the fix is legible rather than a count. Each is a real spell whose type is
  // not one of the two literals and which now earns templates.
  for (const key of ['spirit of the puma', 'agility', 'endure cold', 'burnout', 'levitate']) {
    const e = byKey.get(key)
    assert.ok(e, `${key} must be in the catalog`)
    assert.ok(
      e.templates.wearsOff || e.templates.fade || e.templates.lands || e.templates.landsOnOther,
      `${key} must earn at least one template`
    )
  }
  // …and the detrimental side of the same table.
  const listless = byKey.get('listless power')
  assert.ok(listless, 'Listless Power (Statistic Debuff) must be in the catalog')
})

test('NO DEAD `lands`: every lands template names a message the parser can match', () => {
  // `lands` authors `buffApply {where:{spell}}`. buffApply is emitted only from the cast-on-other
  // SUFFIX table, which is keyed by what remains after the wiki's "Someone " subject is stripped.
  // A message with any other subject is not in that table, so no buffApply is ever emitted for
  // the spell and the suggestion is dead on arrival.
  for (const e of catalog.entries) {
    if (!e.templates.lands) continue
    const s = db.byKey.get(e.key)
    assert.ok(s?.msgCastOnOther, `${e.name}: lands requires a cast-on-other message`)
    assert.notEqual(
      castOnOtherSuffix(s.msgCastOnOther),
      null,
      `${e.name}: lands is offered but its message has no suffix the parser indexes`
    )
  }
})

test('the dead-lands gate actually removed something — 48 of them', () => {
  // Provenance for the claim in spellDb.ts's comment: a count, measured here rather than asserted
  // in prose. These were Detrimental spells with a cast-on-other message the suffix table cannot
  // key, every one of which was being offered a suggestion that could not fire.
  //
  // IT WAS 68 AND IT IS 59 (JOS-150). `db` is the EFFECTIVE DB — `loadSpellDb()` now applies the
  // committed corrections overlay (src/main/data/spellCorrections.ts) to the entries before
  // deriving anything — and nine of those 68 were dead for the ONE reason a correction can fix
  // outright: the scrape lost the wiki's `Someone` subject, so the message yielded no suffix at
  // all. Restoring the subject is not a rewrite of the sentence; it is the sentence the wiki
  // already had, with the placeholder the parser keys on put back. The nine are Garrison's Mighty
  // Mana Shock, Cease, Desist, Sacred Word, Cancelling/Cessation/Negation of Life, Force Snap and
  // Thunder of Karana, each of them evidenced against the owner's log in that file.
  //
  // AND IT WAS 58 SINCE JOS-161 — the tenth of that kind, and the first one a real user noticed
  // from the outside. `Sionachie's Dreams` (bard mez 40) wrote `Target's eyes glaze over.` where
  // its three ladder siblings write `Someone 's eyes glaze over.`, so the song could not be a
  // candidate for its own landing sentence and no alert naming it could ever fire.
  //
  // AND IT IS 48 SINCE JOS-174, which stopped fixing this one report at a time. Another shaman
  // reported the same shape from the other end — Odium never opened a debuff bar — so the drift
  // was SWEPT: every spell whose cast-on-other message the suffix table cannot key was measured
  // against the owner's whole log, and the ones the log can prove got an entry
  // (`spellCorrectionsSubjects.ts`, 33 entries over 44 spell rows). Ten of them are Detrimental
  // and so leave this population: Blood of Pain, Dark Soul, Elnerick's Entombment of Ice,
  // Insidious Retrogression, Laceration, Mana Detonation, Mana Ignition, Spike of Disease and
  // Tangling Weeds — nine names for ten rows, because the scrape carries Dustdevil twice and this
  // loop counts rows. Odium itself is NOT among them and never was: its spellType is `Curse`, so
  // the `lands` gate never looked at it, which is exactly why a reporter had to notice from the
  // debuff timer instead. The remainder is what the owner's log has never printed, which is what
  // the gate is for.
  //
  // AND IT IS 46 SINCE JOS-189, which took the next two off it: `Tuyen's Chant of Disease` and
  // `Tuyen's Chant of Poison`. All four Tuyen chants print ONE landing sentence and the scrape gave
  // `Someone` to Flame and Frost and `Target` to these two, so a bard chaining all four had two of
  // his debuffs filed under the wrong chant and two with no row at all (report
  // 01KZN3FSW4BQ519N3TV8CQ1TC1). They are the sweep's first entries to JOIN an existing suffix
  // rather than mint one, which is also why the population moves by exactly two.
  let dead = 0
  for (const s of db.spells) {
    if (s.spellType !== 'Detrimental' || !s.msgCastOnOther) continue
    if (castOnOtherSuffix(s.msgCastOnOther) === null) dead += 1
  }
  assert.equal(dead, 46, 'the measured population the `lands` gate now excludes')
})

test('`landsOnOther` always travels with the pattern it needs', () => {
  // The flag and `castOnOtherCapture` are one fact written twice (the UI gates on the flag, the
  // def is built from the pattern); if they can disagree, a chip authors a trigger with no regex.
  for (const e of catalog.entries) {
    assert.equal(
      e.templates.landsOnOther,
      e.castOnOtherCapture !== undefined,
      `${e.name}: the landsOnOther flag and its pattern must agree`
    )
    if (!e.castOnOtherCapture) continue
    // Every authored pattern is a valid regex that declares exactly the group the phrase names.
    assert.doesNotThrow(() => new RegExp(e.castOnOtherCapture!, 'i'), `${e.name}: pattern must compile`)
    assert.ok(e.castOnOtherCapture.includes('(?<player>'), `${e.name}: must declare {player}`)
    assert.ok(e.castOnOtherCapture.startsWith('^\\[[^\\]]*\\] '), `${e.name}: must anchor at line start`)
  }
})

test('the authored pattern is derived in MAIN and matches the shared rule exactly', () => {
  // The renderer never rebuilds this (SpellCatalogEntry.castOnOtherCapture says why). Pin that
  // the catalog's copy IS `subjectCapturePattern`'s output, so the two can never drift.
  for (const e of catalog.entries) {
    const s = db.byKey.get(e.key)
    const expected = s?.msgCastOnOther ? subjectCapturePattern(s.msgCastOnOther) : null
    if (e.templates.landsOnOther) assert.equal(e.castOnOtherCapture, expected)
  }
})

test('poison Strike procs are excluded from BOTH landing templates', () => {
  // The parser routes those cast-on-other emotes to `poisonProc` before `classifyDbBuff` ever
  // sees them, so neither a buffApply alert nor a raw one on the same sentence is the honest
  // trigger — the "Rogue slow poisons" group covers the real event (spellDb.ts POISON_PROC_MSGS).
  const asp = byKey.get('asp venom strike')
  if (asp) {
    assert.equal(asp.templates.lands, false)
    assert.equal(asp.templates.landsOnOther, false)
  }
})
