// JOS-69 — the round-two alert sets: SLOW WORE OFF, MOTE DROPPED, TELL RECEIVED.
//
// tests/alertGroups.test.mts already proves each of these fires on the line the catalog quotes
// (its G1 completeness check will not let a def ship without one). This suite pins the half that
// is easy to get wrong and impossible to notice: what each trigger must NOT fire on. Every one
// of these negatives is a real sentence from the reference log that sits one word, one tense or
// one field away from the positive.
//
// THE MEASUREMENTS BEHIND THEM (read-only sweep of eqlog_Primitive_freeport.txt, 1,406,311
// lines, 2026-08-06 — the live log grows, so these are provenance stamps, never thresholds):
//
//   slow, mob side   `Your <Slow> spell has worn off of <mob>.`      52  (Shiftless Deeds 26,
//                                                                        Languid Pace 23,
//                                                                        Tepid Deeds 3)
//   slow, on you     `Your speed returns.`                           21
//                    `You feel less drowsy.`                         62
//   motes            `--You have looted a Mote of … Potential …--`  285  (7 tiers)
//   tells            `<Name> tells you, '…'`                         11  (all players)
//                    `<Name> told you, '…'`                        3537  (all NPCs — 3050 pet
//                                                                        claims, rest merchants)
//
// AND THE BARD'S BINDING PAIR JOINED THE SLOW SET (JOS-233, owner ruling 2026-08-12; re-measured
// read-only over the same file at 1,593,491 lines on 2026-08-12): `Your Largo's Melodic Binding
// spell has worn off of <mob>.` 81, `Largo's Assonant Binding` 0 (this character never reached
// 51), `The strands fade away.` 0, `Selo's Consonant Chain` 0. J1b and J1c below are theirs.
//
// TELL CONTENT IS CONSTRUCTED HERE, deliberately. The 11 real tells are other people's words and
// shared/logScrub.ts drops every line carrying quoted speech, so no fixture can hold one and no
// public test file should quote one. The SHAPE is what was measured and the shape is what is
// tested — the brief called this out, and it is the same reasoning as the reporter's-slice rule
// in AGENTS.md: never commit someone else's sentence, do commit the sentence's structure.
//
// Run: `npm test`.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseEvent } from '../src/main/log/parser'
import { installSpellDb } from '../src/main/log/rulesets'
import { loadSpellDb } from '../src/main/data/spellDb'
import { AlertsModule } from '../src/main/modules/alerts'
import { ALERT_GROUPS, alertGroupDefs } from '../src/shared/alertGroups'
import type { AlertDef } from '../src/shared/types'

// The shared-message families (`Your speed returns.`, `You feel less drowsy.`) resolve against
// spells.json, so the parser needs the DB to emit anything at all for them.
installSpellDb(loadSpellDb())

const TS = '[Tue Jul 28 13:04:53 2026] '

/** Every group def in the catalog, cooldowns removed so a burst of lines cannot mask a fire. */
function allDefs(): AlertDef[] {
  return ALERT_GROUPS.flatMap((g) => alertGroupDefs(g)).map((d) => ({ ...d, cooldownMs: 0 }))
}

/** Push raw lines through the real parser into a module holding `defs`; return the fired ids. */
function fire(defs: AlertDef[], lines: string[]): Set<string> {
  const mod = new AlertsModule()
  mod.setDefs(defs)
  mod.reset()
  let seq = 0
  for (const line of lines) {
    const ev = parseEvent(TS + line, seq++)
    if (ev) mod.onEvent(ev, true)
  }
  return new Set((mod.flushDelta()?.delta.fired ?? []).map((f) => f.alertId))
}

// ─────────────────────────────────────────────────────────────────────────────
// SLOW

test('J1 the slow set covers every player-castable slow, not just the one this character casts', () => {
  const defs = allDefs()
  // The enchanter ladder and the shaman ladder. Only the first three of these appear in the
  // reference log; the rest come from the spell DB's two slow landing-emote families, and they
  // are the whole reason the trigger is a roster instead of a name — a def pinned to Languid
  // Pace goes silently dead the day the user dings 23.
  const slows = [
    'Languid Pace',
    'Tepid Deeds',
    'Shiftless Deeds',
    'Forlorn Deeds',
    'Drowsy',
    'Walking Sleep',
    "Tagar's Insects",
    "Togor's Insects",
    "Turgur's Insects",
    'Turgur`s Insects',
    "Tigir's Insects"
  ]
  for (const spell of slows) {
    const fired = fire(defs, [`Your ${spell} spell has worn off of a froglok ton knight.`])
    assert.ok(fired.has('group:slow:mob'), `${spell} did not fire the slow alert`)
    assert.ok(!fired.has('group:cc:broke'), `${spell} must not read as a mez/root break`)
    assert.ok(!fired.has('charm-break'), `${spell} must not read as a charm break`)
  }
})

test("J1b the bard's binding songs fire the slow alert on the MOB side only", () => {
  // JOS-233, owner ruling 2026-08-12. These two are the first roster members that do NOT come from
  // the DB's slow landing-emote oracle: they share ONE landing sentence — `Someone is bound by
  // strands of solid music.`, which since JOS-384 the corrections overlay gives the level-20 song
  // too — and a message family is not an effect family, so the oracle has nothing to say about
  // them in either direction. The ruling is that the binding slows the mob's SWINGS as well as its
  // feet, which makes its expiry the same quiet loss this set exists for. This test reaches them
  // by the WEAR-OFF line, which names the spell outright and carries no candidate list at all, so
  // the shared landing sentence cannot reach it.
  //
  // JOS-225's regression is the other half of this test and it is asserted on every line: the
  // reporter heard "Mez / root broke" every time the level-20 song lapsed, and neither song may
  // ever reach that alert (or the charm one) again.
  const defs = allDefs()
  for (const spell of ["Largo's Melodic Binding", "Largo's Assonant Binding"]) {
    const fired = fire(defs, [`Your ${spell} spell has worn off of a froglok ton knight.`])
    assert.ok(fired.has('group:slow:mob'), `${spell} did not fire the slow alert`)
    assert.ok(!fired.has('group:cc:broke'), `${spell} must never read as a mez/root break again`)
    assert.ok(!fired.has('charm-break'), `${spell} must not read as a charm break`)
    assert.equal(fired.size, 1, `${spell} must fire exactly one alert`)
  }

  // THE UNRULED REST OF THE LINE stays silent. Same shape of song, same `buffFade`, no ruling —
  // and Selo's Consonant Chain is the control JOS-225's own slice used from the inside.
  for (const spell of [
    "Selo's Consonant Chain",
    "Selo's Chords of Cessation",
    "Selo's Assonant Strain"
  ]) {
    const fired = fire(defs, [`Your ${spell} spell has worn off of a froglok ton knight.`])
    assert.equal(fired.size, 0, `${spell} is explicitly unruled and must fire nothing`)
  }
})

test('J1c the binding songs do NOT reach the on-you slow alert — the sentence is shared', () => {
  // THE TRIPWIRE THAT MADE THE ROSTER TWO LISTS. Both Largo's print `The strands fade away.` when
  // they expire on YOU — and so does `Lyssa's Solidarity of Vision`, the Bard 34 BENEFICIAL vision
  // buff, verbatim. A `where:{spell:…}` matcher tests the whole CANDIDATE list (JOS-84), so one
  // shared roster would announce "a slow wore off you" every time that buff lapsed, with nothing
  // in the sentence to tell them apart. This is the haste twin again, except the two sentences are
  // not one word apart — they are identical, so anchoring cannot save it and only the ROSTER can.
  const ev = parseEvent(TS + 'The strands fade away.', 0)
  assert.ok(ev && ev.kind === 'buffWearOff')
  assert.equal(ev.target, 'self')
  assert.deepEqual(ev.candidates, [
    "Largo's Assonant Binding",
    "Largo's Melodic Binding",
    "Lyssa's Solidarity of Vision"
  ])

  const fired = fire(allDefs(), ['The strands fade away.'])
  assert.ok(!fired.has('group:slow:you'), 'a beneficial bard buff expiring is not a slow expiring')
  assert.equal(fired.size, 0)
})

test('J2 a NON-slow buff wearing off a named target is silent', () => {
  const defs = allDefs()
  // All three are real wear-off lines from the reference log, and all three arrive as the SAME
  // `buffFade` event the slow alert listens to — the spell name is the only thing between them.
  const quiet = fire(defs, [
    'Your Swift Like the Wind spell has worn off of an ice giant.',
    'Your Tashani spell has worn off of a froglok ton knight.',
    'Your Heat Blood spell has worn off of an imp protector.'
  ])
  assert.ok(!quiet.has('group:slow:mob'))
  assert.equal(quiet.size, 0, 'no other set may claim these either')
})

test('J3 the HASTE twin never fires the on-you slow alert', () => {
  // One word apart, and the difference is the whole point of world-model law 3: the game reuses
  // sentences, so the def has to be right about the FAMILY. `Your speed returns.` resolves to
  // three enchanter slows; `Your speed returns to normal.` resolves to nine HASTES. The roster
  // regex is anchored `^…$`, which is what keeps the second one out.
  const defs = allDefs()
  assert.ok(fire(defs, ['Your speed returns.']).has('group:slow:you'))
  assert.ok(fire(defs, ['You feel less drowsy.']).has('group:slow:you'))

  const haste = fire(defs, ['Your speed returns to normal.'])
  assert.ok(!haste.has('group:slow:you'), 'a haste expiring is not a slow expiring')
  assert.equal(haste.size, 0)
})

test('J4 the on-you slow alert reports the family, never which spell it was', () => {
  // Both self sentences are shared and name nothing. The parser hands over the FIRST candidate
  // as `spell`, which is a resolver artifact and not a fact about the fight — this pins that the
  // alert fires anyway, and that the candidate list it fired on is entirely slows.
  const ev = parseEvent(TS + 'You feel less drowsy.', 0)
  assert.ok(ev && ev.kind === 'buffWearOff')
  assert.equal(ev.target, 'self')
  assert.ok((ev.candidates?.length ?? 0) > 1, 'a shared message carries candidates, not an answer')
})

// ─────────────────────────────────────────────────────────────────────────────
// MOTES

test('J5 every mote tier the catalog knows fires the loot alert', () => {
  const defs = allDefs()
  // The seven the reference log printed, plus the three the committed items catalog knows and
  // this character has not seen. `^Mote of ` covers all ten, which is why the trigger anchors a
  // family instead of listing tiers.
  const tiers = [
    'Infinitesimal',
    'Minor',
    'Lesser',
    'Major',
    'Greater',
    'Superior',
    'Grand',
    'Ascendant',
    'Infinite'
  ]
  for (const tier of tiers) {
    const fired = fire(defs, [
      `--You have looted a Mote of ${tier} Potential from a zol ghoul knight's corpse.--`
    ])
    assert.ok(fired.has('group:motes:looted'), `Mote of ${tier} Potential did not fire`)
  }
  // The un-adjectived tier, which is a real item and a real loot line (7 in the reference log).
  assert.ok(
    fire(defs, ["--You have looted a Mote of Potential from Magus Rokyl's corpse.--"]).has(
      'group:motes:looted'
    )
  )
})

test('J6 an ordinary drop is silent, and so is chat that merely says "mote"', () => {
  const defs = allDefs()
  const ordinary = fire(defs, [
    "--You have looted a Ringmail Cape from a gnoll pup's corpse.--",
    "--You have looted a Dagger of Marnek from a shadowknight's corpse.--"
  ])
  assert.equal(ordinary.size, 0, 'a loot filter that speaks for everything is not a filter')

  // THE REASON THIS DEF IS AN EVENT AND NOT A RAW REGEX. Four lines in the reference log discuss
  // motes in a public channel; a raw pattern over the whole line would announce a stranger's
  // sentence as your drop. Matching the parsed loot event's `item` field cannot: chat carries no
  // item field at all. (The content here is constructed — see the header.)
  const chatter = fire(defs, [
    "Someone tells General:1, 'anyone know where Mote of Major Potential drops?'"
  ])
  assert.ok(!chatter.has('group:motes:looted'), 'talking about a mote is not looting one')
})

// ─────────────────────────────────────────────────────────────────────────────
// TELLS

test('J7 a player tell fires; an NPC or pet tell never does', () => {
  const defs = allDefs()
  assert.ok(fire(defs, ["Tellwyn tells you, 'group up?'"]).has('group:tells:received'))

  // PRESENT TENSE IS A PLAYER, PAST TENSE IS THE GAME — the measured rule, and the two shapes
  // that make it load-bearing. The pet claim is 3050 of the log's 3537 `told you` lines and would
  // machine-gun the alert through every pull; the merchant is the rest of them.
  const pet = fire(defs, ["Kibn told you, 'Attacking a froglok ton knight Master.'"])
  assert.ok(!pet.has('group:tells:received'), 'your pet acknowledging an order is not a tell')

  const merchant = fire(defs, [
    "Klok Sasz told you, 'I'll give you 3 platinum for the Ringmail Cape.'"
  ])
  assert.ok(!merchant.has('group:tells:received'), 'a vendor quoting a price is not a tell')

  // CAPITALIZATION PROVES NOTHING, measured: the log capitalizes a sentence-initial article, so
  // a charmed pet's tell looks exactly as proper-named as a player's. The tense is the only
  // discriminator, and this pins that the def is not secretly relying on the other one.
  const charmed = fire(defs, ["A gorgon told you, 'Attacking an imp protector Master.'"])
  assert.ok(!charmed.has('group:tells:received'))
})

test('J8 channel tells, group chat and your OWN tells stay silent', () => {
  const defs = allDefs()
  for (const line of [
    "Someone tells General:1, 'wts spell'",
    "Someone tells NewPlayers6:1, 'how do i get to freeport'",
    "Someone tells the group, 'inc'",
    "You told Someone, 'omw'",
    "You tell your party, 'inc'"
  ]) {
    assert.ok(
      !fire(defs, [line]).has('group:tells:received'),
      `must not fire on: ${line}`
    )
  }
})

// ─────────────────────────────────────────────────────────────────────────────
// THE REFUSAL

test('J9 the friend-online set ships unoffered, with the sweep recorded', () => {
  const g = ALERT_GROUPS.find((x) => x.id === 'friendOnline')
  assert.ok(g, 'the refusal is documented in the catalog, not merely omitted from it')
  assert.equal(g.verified, false)
  assert.equal(g.defs.length, 0, 'a guessed regex that never fires is worse than no feature')
  // The two lines the friend system DOES print. Neither is an arrival, and neither may be
  // massaged into one by a future edit without this failing first.
  assert.ok(g.unverifiedReason?.includes('Friends currently on EverQuest Legends:'))
  assert.ok(g.unverifiedReason?.includes('is now your friend.'))
})
