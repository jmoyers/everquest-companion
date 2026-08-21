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
  isPlaceholderMessage,
  loadSpellDb,
  spellPlaceholdersReport
} from '../src/main/data/spellDb'
import { subjectCapturePattern } from '../src/shared/alertCaptures'
// The RAW scrape, read directly — the independent count below has to look at the text the pass
// blanked, which by definition is no longer in the effective DB.
import spellsJson from '../src/main/data/spells.json'
import type { SpellDbFile } from '../src/shared/types'

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

// The title carried the count until JOS-189 moved it and left the name behind, which is the ordinary
// way a frozen number rots. The count lives in the assertion, where a change has to be argued for in
// the comment below it; the title only claims the gate removes SOMETHING.
test('the dead-lands gate actually removed something, and the count is measured here', () => {
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
  //
  // AND IT IS 45 SINCE JOS-245: `Vengeance of the Wild`, the druid DoT at 49, reported by a druid
  // whose debuff window never showed it (01KZSR4HQVWJKDG0NCDGZ01928). ONE row, and the shape of the
  // remainder is the point — the owner's log has never printed a single line of that spell, so this
  // is the first entry the sweep admitted on a REPORTER'S SLICE rather than on his own bytes. The
  // rest of this population is still what nobody has evidenced from any log at all, which is what
  // the gate is for.
  //
  // AND IT IS 44 SINCE JOS-342, which took one off it WITHOUT correcting anything: `FireBomb`, a
  // Detrimental NPC spell whose three message fields all say the literal string `N/A`. It was in
  // this population because `N/A` is a non-empty string that yields no suffix — the same arithmetic
  // as a real sentence with the wrong subject, for a field that states nothing at all. The
  // placeholder pass now blanks it at load, so the row no longer has a cast-on-other message to be
  // counted for, and the remainder is once again only spells whose message is real and unkeyable.
  // (The wiki page agrees with the pass: FireBomb's own `classes` text reads "There are no messages
  // in chat when the spell is cast/lands.")
  //
  // AND IT IS 41 SINCE JOS-412, which is the first move of this number that no report asked for.
  // The sweep grew a VALIDATOR (src/main/data/spellSubjectAudit.ts) that asks the registry which
  // spells are in this state at all, and the answer was 153 rows — 71 of them carrying a subject
  // placeholder that simply is not `Someone`. 41 of those rows were corrected: `Curse` (the shaman
  // 34, GitHub issue 43 — `Odium` one rank down the same line, and the reason the validator exists)
  // plus every sentence the family ALREADY owned, where restoring the subject mints no tail and
  // only adds a candidate. Exactly three of the 41 are Detrimental and so leave this population:
  // `Beholder Dispel`, `SpectreLifetap` and `Wave of Fire`. `Curse` is not among them and never
  // could be — its spellType is `Curse`, the same reason Odium was invisible to this gate.
  //
  // What remains is what it has always been: sentences no log has evidenced. The difference is that
  // they are now a pinned CENSUS (tests/spellSubjectAudit.test.mts) rather than a silence, so the
  // next spell to enter this state fails a build instead of waiting for somebody to notice.
  let dead = 0
  for (const s of db.spells) {
    if (s.spellType !== 'Detrimental' || !s.msgCastOnOther) continue
    if (castOnOtherSuffix(s.msgCastOnOther) === null) dead += 1
  }
  assert.equal(dead, 41, 'the measured population the `lands` gate now excludes')
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

// ─────────────────────────────────────────────────────────────────────────────
// THE SCRAPE'S PLACEHOLDER MESSAGES (JOS-342) — the same law, one level down.
//
// A template flag is a claim that the alert can fire, and the flag reads `!!s.msgCastOnOther`. A
// SCRAPE STUB is a non-empty string, so it read as a message the wiki stated, and `Snails Healing`
// was therefore offered a `landsOnOther` alert whose authored pattern matched any line ending in a
// name and a period. `applyPlaceholderMessages` blanks those fields at load, and every gate here
// then does the right thing by its EXISTING absent-field rule — nothing downstream was taught
// anything new. What has to be pinned is the census: which shapes are folded, and that a short
// REAL sentence is not among them.

/** Every field the pass blanked, as `spell/field = "text"`, in the order it found them. */
function nulledRows(): string[] {
  const report = spellPlaceholdersReport()
  assert.ok(report, 'loadSpellDb must have run the placeholder pass')
  return report.rows.map((r) => `${r.spell}/${r.field} = ${JSON.stringify(r.text)}`)
}

/**
 * The stub fields a COMMITTED CORRECTION now answers, as `spell/field`.
 *
 * THE PASS ORDER IS WHY THIS LIST EXISTS (JOS-318). `loadSpellDb` runs the corrections overlay
 * BEFORE the placeholder pass, precisely so that OUR stated truth about a sentence wins over the
 * scrape's stub — spellDb.ts's load order says so, and said so while no correction named any of the
 * five placeholder spells. Four of the ten now do, so the census below is the stubs the pass still
 * blanks and this is the rest of the original ten: nothing left the population, two fields moved
 * from "blanked" to "answered".
 */
const CORRECTED_STUBS = [
  'Slugs Healing/msgCastOnYou',
  'Slugs Healing/msgCastOnOther',
  'Snails Healing/msgCastOnYou',
  'Snails Healing/msgCastOnOther'
]

test('THE CENSUS: the stub fields no correction answers, verbatim', () => {
  // Listed VERBATIM rather than counted, because the whole risk of this pass is swallowing a real
  // sentence. A re-scrape that changes what it folds has to change this list and argue for it.
  assert.deepEqual(nulledRows(), [
    // SHAPE B — the literal not-applicable marker. FireBomb's own `classes` text says there are no
    // chat messages for it at all, which is the wiki agreeing with the fold in prose.
    'FireBomb/msgCastOnYou = "N/A"',
    'FireBomb/msgCastOnOther = "N/A"',
    'FireBomb/msgWearsOff = "N/A"',
    'Nature\'s Holy Wrath/msgWearsOff = "N/A"',
    // SHAPE A — a subject with no predicate. It was three shaman heal-over-times; JOS-318 evidenced
    // two of them out of this list from the owner's own log, and `Sloths Healing` is the one no log
    // anywhere has ever printed a line of. It stays blanked rather than extrapolated, which is the
    // awaiting-sample law — and the `healsOverTime` alert template covers it anyway, off the healing
    // engine's tick line instead of off a message the wiki never wrote.
    'Sloths Healing/msgCastOnYou = "You ."',
    'Sloths Healing/msgCastOnOther = "Someone ."'
  ])
  assert.equal(spellPlaceholdersReport()?.nulled, 6)
})

test('…and an INDEPENDENT count finds the same ten: they are the DB\'s only one-word messages', () => {
  // Two directions on one population. The rule was derived from SHAPES; a word count knows nothing
  // about shapes and lands on exactly the same ten fields of the RAW scrape. Every other one of the
  // 3,847 non-empty message fields the scrape ships carries two or more words.
  //
  // The comparison is against blanked ∪ CORRECTED, because a stub a correction answers never reaches
  // the placeholder pass — see CORRECTED_STUBS. The union is what has to equal the word count; a
  // stub that fell out of BOTH would be the pass quietly failing to notice one.
  const single: string[] = []
  for (const s of (spellsJson as unknown as SpellDbFile).spells) {
    for (const field of ['msgCastOnYou', 'msgCastOnOther', 'msgWearsOff'] as const) {
      const text = s[field]
      if (!text) continue
      const words = text.trim().split(/\s+/).filter((w) => /[A-Za-z0-9]/.test(w))
      if (words.length <= 1) single.push(`${s.name}/${field}`)
    }
  }
  const handled = [...nulledRows().map((r) => r.split(' = ')[0]), ...CORRECTED_STUBS]
  assert.deepEqual(single.sort(), handled.sort())
  assert.equal(single.length, 10, 'the population is still the same ten fields')
})

test('THE BOUNDARY: a short sentence is still a sentence and survives the pass', () => {
  // Law 1, stated as a test. Only a message with NOTHING BUT a subject, or the literal
  // not-applicable marker, is a stub.
  for (const stub of ['You .', 'Someone .', 'N/A', 'n/a', '  You  . ', 'Target .', '   ', '.']) {
    assert.equal(isPlaceholderMessage(stub), true, `${JSON.stringify(stub)} states nothing`)
  }
  for (const real of [
    'You burn.', // Flames of Ro — two words, and one of them is a verb
    'You stop.', // Chase the Moon
    'Someone dies.', // Death Peace
    'Someone staggers.', // 41 rows share it
    'fades away.', // 10 rows — the wiki cropped the SUBJECT, not the predicate
    'starts limping!', // Hobbling Poison
    "'s limbs move slower!" // Weakening Strike — a possessive fragment IS the parser's suffix
  ]) {
    assert.equal(isPlaceholderMessage(real), false, `${JSON.stringify(real)} is a sentence`)
  }
})

test('THE REPORTED SPELL: Sloths Healing carries no stub anywhere downstream', () => {
  // The defect really was authored. Left in place, `Someone .` produces a raw trigger that fires on
  // any line ending in a name-shaped run and a period — offered to the user as coverage for a
  // spell landing, which is precisely the guessed trigger alertGroups.ts's law forbids.
  //
  // THE SPELL MOVED (JOS-318). JOS-342 wrote this against `Snails Healing`, which now carries the
  // three sentences the owner's log proves it prints. `Sloths Healing` is the rank above it and the
  // one nothing anywhere has witnessed, so it is the row that still exercises the pass — and it is a
  // better one, because a stub with no correction behind it is exactly the state the pass is for.
  assert.notEqual(
    subjectCapturePattern('Someone .'),
    null,
    'the stub really did author a pattern — this is what the pass exists to remove'
  )

  const spell = db.byKey.get('sloths healing')
  assert.ok(spell, 'the row is still in the DB — the pass blanks fields, it never drops a spell')
  assert.equal(spell.msgCastOnYou, undefined, 'absent, rather than the string "You ."')
  assert.equal(spell.msgCastOnOther, undefined, 'absent, rather than the string "Someone ."')

  const entry = byKey.get('sloths healing')
  assert.ok(entry, 'and still in the catalog: Heal Over Time is Beneficial, so `fade` stands')
  assert.equal(entry.templates.fade, true)
  assert.equal(entry.templates.landsOnOther, false, 'the junk capture is gone')
  assert.equal(entry.castOnOtherCapture, undefined)
  assert.equal(entry.templates.wearsOff, false, 'the DB states no wear-off sentence for it')
  assert.equal(entry.templates.landsOnYou, false, '…nor a landing sentence')
  // …and the template that does not need one. THE ANSWER TO A ROW NOBODY CAN CORRECT (JOS-318): the
  // heal-over-time tick line is printed by the healing engine and names the spell itself, so this
  // spell is alertable with no message table entry of any kind.
  assert.equal(entry.templates.healsOverTime, true)
  assert.equal(
    entry.searchText,
    'sloths healing sloths healing',
    'the search surface is the name and its rank list — no stub text joined into it'
  )

  // …and the parser's own tables never learned the stubs either. `Someone .` minted the
  // cast-on-other suffix `.`, a real entry that any line ending in a space and a period would have
  // matched; `You .` and `N/A` were keys in the landing and wear-off maps.
  assert.equal(db.castOnOtherSuffix.has('.'), false, 'the one-character suffix is out of the table')
  assert.equal(db.castOnYou.has('You .'), false)
  assert.equal(db.castOnYou.has('N/A'), false)
  assert.equal(db.wearsOff.has('N/A'), false)
})

test('JOS-318: the corrected ladder rungs carry real sentences, and earn the chips they name', () => {
  // The other side of the row that moved. Snails and Slugs are the two rungs the owner's log can
  // witness, so their stubs are ANSWERED rather than blanked, and the template flags follow from the
  // sentences without anything being taught a new rule.
  for (const [key, animal] of [['snails healing', 'snail'], ['slugs healing', 'slug']] as const) {
    const s = db.byKey.get(key)
    assert.ok(s, `${key} must still be in the DB`)
    assert.equal(s.msgCastOnYou, `You being to feel healed by the ${animal}.`)
    assert.equal(s.msgCastOnOther, `Someone is healed by the spirit of the ${animal}.`)
    assert.equal(s.msgWearsOff, `You feel the ${animal} spirit depart.`)

    const e = byKey.get(key)
    assert.ok(e)
    assert.equal(e.templates.landsOnYou, true, 'the landing sentence exists now')
    assert.equal(e.templates.wearsOff, true, 'and so does the wear-off')
    assert.equal(e.templates.landsOnOther, true, 'and the third-person one, with a real subject')
    assert.equal(e.templates.healsOverTime, true)
    // The minted tail is the spell's own and nothing else in the table shares it.
    assert.equal(
      db.castOnOtherSuffix.get(`is healed by the spirit of the ${animal}.`)?.length,
      1,
      `${key}: the restored sentence resolves to exactly one spell`
    )
  }
  // …including the rung the wiki DID fill in, whose only fault was a dropped subject.
  assert.equal(
    db.castOnOtherSuffix.get('is healed by the spirit of the tortoise.')?.length,
    1,
    'Tortoises Healing keys the table now too'
  )
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
