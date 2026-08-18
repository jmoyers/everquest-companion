// JOS-84 — CHARM AND CROWD CONTROL ARE ROSTERS, AND THE ROSTER ORACLE IS THE SPELL DB.
//
// THE REPORT: "Hey, for bard the charm break doesnt work? :D".
//
// THE ROOT CAUSE, measured. `Your <spell> spell has worn off of <mob>.` is ONE sentence for three
// different facts, and src/main/log/rulesets.ts decides which by matching the spell NAME:
// `charmSpell` ⇒ `uncharm` (a charmed pet is loose), `ccSpell` ⇒ `cc {refresh:true}` (a mez/root
// broke), neither ⇒ an ordinary `buffFade`. `ccSpell` carried exactly ONE bard song — Largo's
// Melodic Binding, which a bard gets at level 20 — and nothing a bard casts after it. So every
// bard past the mid-twenties held a crowd-control break the parser filed as a plain buff fade:
// no `cc` event, no `uncharm` event, and therefore no alert of any kind, seeded or grouped.
//
// THE ORACLE BELOW is what keeps that from happening again, and it is the same argument
// shared/alertGroups.ts makes for SLOW_SPELLS ("a slow is the spell you REPLACE as you level, so
// a def pinned to one name goes silently dead at the next tier"): the committed spells.json
// groups spells by LANDING MESSAGE, one message per family, so "every castable spell that shares
// a landing message with a member the roster already classifies" is DB knowledge rather than a
// guess — and it is re-derived here on every run. A future scrape that adds a member fails this
// suite instead of going quietly mute in somebody's ears.
//
// AND THE ORACLE HAS ONE EXCEPTION, BECAUSE IT PRODUCED ONE WRONG ANSWER (JOS-200).
//
// JOS-84 concluded from the landing-message family that `Solon's Bewitching Bravura` is a mez, and
// it is not: it is the bard's level-39 CHARM. The oracle is still right about what it can see —
// the four songs really do share `Someone 's eyes glaze over.` — but spells.json HAS NO EFFECT
// COLUMN (`spellType` is only Beneficial/Detrimental), so a shared sentence is evidence of a
// shared sentence and nothing more. A message family is not an effect family. That is the whole
// bug, and `FAMILY_EXCEPTIONS` below is where the oracle now admits it, with the evidence
// attached, rather than being quietly widened until it stops complaining.
//
// THE EVIDENCE, from the very slice JOS-84 cited (feedback report 01KZAG2QAW885YJNRTDDND8BF2,
// read-only, NEVER committed — AGENTS.md's reporter-slice rule) and from the half of it JOS-84
// did not read: fire giants sing the song AT that reporter three times, and every episode runs
// `<mob> begins singing Solon's Bewitching Bravura.` → 3 s later `You lose control of yourself!`
// → 21-32 s later `You are no longer captivated.` together with `You have control of yourself
// again.` in the same second. 3 s is the song's own `castTimeMs`, the captivate line is its own
// `msgWearsOff`, and lose/regain-control is EverQuest's charm-on-a-player pair — the same slice
// separately carries nine `You are stunned!` / `You are no longer stunned.` episodes, so the
// client prints different words for the two effects and this is not the mez one. The reporter's
// own casts hold a mob 51-117 s before the break line against a listed duration of 18 s, and three
// reporters on three versions (0.14.0, 0.16.0, 0.18.0) each called it the bard charm unprompted.
//
// The one sentence the owner's log lacks is INJECTED as a line here, quoted verbatim from the
// slice with the mob's name swapped for one the owner's own log prints, exactly as the
// petClaimWindows / mobLifetapPlayer precedents do.
//
// AND THE ORACLE PRODUCED A SECOND WRONG ANSWER, IN THE OTHER DIRECTION (JOS-225). A bard reported
// the "Mez / root broke" alert firing every time `Largo's Melodic Binding` lapsed. That song was
// not something the family walk added — it was in `ccSpell` from the original hand-audited stem
// list, labelled "bard/enchanter mez", and JOS-84 completed the pair (Assonant Binding 51) on the
// strength of the shared landing sentence without ever re-checking what the songs DO. They hold
// nothing. `NOT_A_HOLD` below carries the evidence and R1c/R1d are its assertions; the point of
// writing it as a table rather than a quiet regex edit is that the oracle would otherwise sweep
// both songs straight back in on the next scrape.
//
// AND "NOT A HOLD" WAS NEVER "NOT AN ALERT" (JOS-233, owner ruling 2026-08-12). Both Largo's are
// still refused by both rosters here — nothing in the parser moved — but the owner ruled them
// attack-speed debuffs as well as snares, so shared/alertGroups.ts's mob-side slow roster claims
// them by name and their wear-off now fires `group:slow:mob`. The JOS-225 regression is unchanged
// and is asserted directly: zero mez and zero charm firings from either song, forever. The rest of
// the bard binding line (Selo's Consonant Chain 23, Chords of Cessation 48, Assonant Strain 54) is
// EXPLICITLY UNRULED and sits in the same table with an empty `fires` list.
//
// Run: `npm test`.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseEvent } from '../src/main/log/parser'
import { CHARM_STEMS, getParserConfig, installSpellDb } from '../src/main/log/rulesets'
import { loadSpellDb } from '../src/main/data/spellDb'
import { CharmModel } from '../src/main/combat/charmModel'
import { AlertsModule } from '../src/main/modules/alerts'
import { ALERT_GROUPS, alertGroupDefs } from '../src/shared/alertGroups'
import type { AlertDef } from '../src/shared/types'

const db = loadSpellDb()
installSpellDb(db)
const cfg = getParserConfig()

/** Every def the curated groups author (the surface a user clicks "create" on). */
const GROUP_DEFS: AlertDef[] = ALERT_GROUPS.filter((g) => g.verified).flatMap((g) =>
  alertGroupDefs(g)
)

/** Feed raw log lines through the real parser into a module holding `defs`; return fired ids. */
function fire(defs: AlertDef[], lines: string[]): string[] {
  const mod = new AlertsModule()
  mod.setDefs(defs)
  mod.reset()
  let seq = 0
  for (const line of lines) {
    const ev = parseEvent(line, seq++)
    if (ev) mod.onEvent(ev, true)
  }
  return (mod.flushDelta()?.delta.fired ?? []).map((f) => f.alertId)
}

/** A `Your <spell> spell has worn off of <mob>.` line, stamped like the real log. */
function wornOff(spell: string, mob = 'a fire giant warrior'): string {
  return `[Wed Aug 05 22:28:56 2026] Your ${spell} spell has worn off of ${mob}.`
}

/**
 * The DB's own family index: landing message → the CASTABLE spells that print it.
 *
 * "Castable" excludes the NPC-only entries (`This spell is cast by NPCs only.`) and the
 * class-less ones: `Your <X> spell has worn off of <mob>.` names a spell YOU cast, so a spell no
 * player can cast can never appear in one — the same exclusion SLOW_SPELLS makes for Rejuvenation
 * and Energy Sap.
 */
function castableSharing(message: string): string[] {
  const out = new Set<string>()
  for (const s of db.spells) {
    if (s.msgCastOnOther !== message) continue
    const classes = s.classes ?? ''
    if (!classes.includes('*')) continue
    out.add(s.name)
  }
  return [...out].sort()
}

// ── R1: the two rosters must classify every member of every family they already claim ────────
//
// THE MEZ / ROOT FAMILIES the parser routes to `cc`. Each key is a landing message spells.json
// records verbatim; the comment names the ladder it is.
const CC_FAMILIES: Record<string, string> = {
  // The bard mez ladder — TWO messages now, six songs, and before JOS-84 `ccSpell` held one of
  // them. It was three messages until JOS-161: `Sionachie's Dreams` used to sit alone under
  // `Target's eyes glaze over.`, which is the SAME sentence with the wrong subject placeholder,
  // and the corrections overlay folds it into the family the other three already shared. That is
  // exactly what the R1 assertion below is for — the family is read off the LOADED db, so a
  // correction that moved a song shows up here as the family it moved into.
  // …and since JOS-200 it is THREE songs, not four: `Solon's Bewitching Bravura` prints the same
  // sentence and is a charm (FAMILY_EXCEPTIONS, below).
  // …and since the owner's 2026-08-12 ruling it is TWO: `Solon's Song of the Sirens` went the same
  // way, on the wiki's effect line ("1: Charm up to level 37"). The family is now half charm and
  // half mez, which is exactly why it is an EXCEPTION table and not a family reclassification —
  // the sentence still cannot be routed, and never could.
  "Someone 's eyes glaze over.": "bard mez (Pixie Strike 28, Sionachie's Dreams 40)",
  "Someone 's head nods.": "bard mez (Kelin's Lucid Lullaby 15)"
  // The `… bound in/by strands of solid music.` families used to sit here, claimed as "bard root"
  // (Largo's Melodic Binding 20 and its direct upgrade, Assonant Binding 51). JOS-225 WITHDREW
  // that claim — they are movement debuffs and hold nothing. See NOT_A_HOLD below. They were TWO
  // families then and are ONE since JOS-384, which corrected the level-20 song's sentence to the
  // `by` form the shipped game prints; neither of them belongs here either way.
}

/**
 * NOT A HOLD (JOS-225) — the songs that must stay OUT of both rosters, and why.
 *
 * THE REPORT: a bard hears the "Mez / root broke" alert every time `Largo's Melodic Binding`
 * lapses. Replaying the reporter's slice (01KZSH65ZX4Z74AK1CSZWQ42VK, read-only, never committed)
 * through the real parser and the real alerts module fires `group:cc:broke` four times, and all
 * four are Largo's — there is not one genuine mez in it.
 *
 * THIS IS THE OTHER DIRECTION OF THE JOS-200 MISTAKE. There, the message oracle swept a charm into
 * the mez roster. Here, the ORIGINAL hand-audited stem list called Largo's "bard/enchanter mez" in
 * 2026-07, JOS-84's family walk completed the pair without re-checking the effect, and this table
 * is where the effect finally got checked. A message family is not an effect family in either
 * direction.
 *
 * THE EVIDENCE IS MECHANICAL (the full argument, with counts, is in src/main/log/rulesets.ts):
 * the song's target trades melee blows in the same second its wear-off prints; `<mob> has been
 * awakened by <name>.` lands with 0 of 81 Largo's wear-offs over the owner's whole log against
 * 67.7% of Mesmerization's 1,848, 78.9% of Enthrall's 95, 85.9% of Dazzle's 85 and 84.1% of
 * Entrance's 69; and the committed DB gives it a `buffApply` landing sentence, so no CC
 * APPLICATION event for it exists in the corpus at all. Both songs go together for the reason
 * JOS-84 added the second: a fix that stops at level 20 hands the bug back at level 51.
 *
 * FALLING OUT OF BOTH ROSTERS IS THE POINT HERE, and it is the one outcome R1b forbids — for a
 * HOLD. R1c below is the counterpart assertion: a movement debuff filed as `buffFade` is a debuff
 * filed correctly. Adding a row here is not a way to quiet a noisy alert; it is a claim that the
 * game shows the spell doing something other than holding, and it needs evidence of that shape.
 *
 * WHAT `buffFade` LEADS TO IS A SECOND QUESTION, AND JOS-233 ANSWERED IT. R1c used to assert the
 * two songs fire NOTHING, which was true of the tree JOS-225 left and was never the ticket's
 * claim: "not a hold" says what the songs are not. The owner ruled 2026-08-12 what they are — an
 * attack-speed debuff as well as a snare — so the mob-side slow roster in shared/alertGroups.ts
 * claims them by name and their wear-off now fires `group:slow:mob`. NOTHING IN THE PARSER MOVED:
 * both rosters here still refuse them, the event is still `buffFade`, and the alert that must
 * never fire again is still `group:cc:broke`. The `fires` column below is what each row is
 * expected to produce end to end, so a row cannot silently drift between the two answers.
 */
const NOT_A_HOLD: Record<string, { why: string; fires: string[] }> = {
  "Largo's Melodic Binding": {
    why: "bard 20, PB AE, 3 ticks — the reporter's own false positive",
    fires: ['group:slow:mob']
  },
  "Largo's Assonant Binding": {
    why: 'bard 51 — the direct upgrade, one word apart',
    fires: ['group:slow:mob']
  },
  // THE UNRULED REST OF THE BINDING LINE (JOS-233). Same shape of song, same `buffFade`, and no
  // owner ruling — so they must stay SILENT. These are the control JOS-225's slice supplied from
  // the inside (Consonant Chain's wear-offs were quiet while Largo's screamed), kept as an
  // assertion so a future widening of the slow roster has to be deliberate about them.
  "Selo's Consonant Chain": { why: 'bard 23 — explicitly unruled', fires: [] },
  "Selo's Chords of Cessation": { why: 'bard 48 — explicitly unruled', fires: [] },
  "Selo's Assonant Strain": { why: 'bard 54 — explicitly unruled', fires: [] }
}

/** The charm families the parser routes to `uncharm`. */
const CHARM_FAMILIES: Record<string, string> = {
  'Someone has been charmed.': 'the Enchanter charm ladder (Charm 11 → Dictate 60)',
  // Five Necromancer charm-undead spells share this one; the stems covered the first three by
  // accident (dominate / beguile / cajol) and a necro who reached 54 lost their charm break.
  'Someone moans.': 'the Necromancer charm-undead ladder (Dominate Undead 18 → Enslave Death 60)',
  // THE THIRD FAMILY, AND IT WAS NEVER A PAIR (JOS-250 charm roster research 2026-08-12). This
  // ladder has SEVEN castable members and rulesets.ts used to claim in prose that it was complete
  // at two. Registering the message here is what proved otherwise: R2 walks the family off
  // spells.json and failed on exactly the three the stems had never matched — Befriend Animal
  // (Druid 13 / Shaman 25, the druid's FIRST charm), Call of Karana (Druid 52) and Tunare`s
  // Request (Druid 55, the capstone). Same "one word apart" failure JOS-84 caught for Largo's, at
  // both ends of a different ladder.
  'Someone blinks.': 'the Druid/Shaman charm ladder (Befriend Animal 13 → Tunare`s Request 55)'
}

/**
 * NOT A CHARM (JOS-250 charm roster research 2026-08-12) — the spells `CHARM_STEMS` used to match
 * and must never match again, and why. The mirror of `NOT_A_HOLD` above, and it exists for the
 * same reason: a stem that reaches too far is a silent claim about a spell, and the only way to
 * stop the next scrape or the next widening quietly re-adopting one is to write the claim down as
 * an assertion.
 *
 * THE DANGEROUS ONE IS `Boltran's Animation`, and it is worth being explicit about the mechanism.
 * The old roster carried a bare `boltran` stem, which bought nothing (`agacerie` already matches
 * `Boltran's Agacerie` uniquely) and which also matched a magician PET SUMMON with a 9,000 ms cast
 * time. JOS-250 arms an ownership window of `castTime + slack` on a matching third-person cast, so
 * that stem handed a magician summoning their pet a 10.5-second window in which the next
 * caster-less `<mob> has been charmed.` in the zone would be attributed to them — the exact
 * foreign-pet adoption Task #65 spent a wave undoing, reached through the roster's back door.
 *
 * `castArms` says whether the spell is castable by a player and therefore whether the second half
 * of the assertion (drive it through the real `CharmModel` and prove no arm opens) applies. The
 * two item entries are focus effects with no cast line at all.
 */
const NOT_A_CHARM: Record<string, { why: string; castArms: boolean }> = {
  'Allure of Death': {
    why: 'Necromancer self-buff, Beneficial — `Someone looks sick.`, not a charm landing',
    castArms: true
  },
  "Boltran's Animation": {
    why: 'Magician PET SUMMON, Beneficial, 9,000 ms cast — the 10.5 s false ownership window',
    castArms: true
  },
  "Naki's Charm of Pernicity": { why: 'an ITEM focus effect; a charm is a trinket too', castArms: false },
  "Tavee's Charm of Diuturnity": { why: 'an ITEM focus effect', castArms: false }
}

/**
 * THE SPELLS THE MESSAGE ORACLE GETS WRONG (JOS-200, widened by the owner 2026-08-12), and the
 * shape of the admission.
 *
 * Keyed by spell name → the roster it ACTUALLY belongs to, so the exception is a claim about one
 * named song rather than a hole punched in a family. R1 skips these when walking a CC family and
 * R1b then asserts each one is classified the way this table says — so an exception cannot rot
 * into "unclassified": it still has to be in a roster, just the other one.
 *
 * Adding a row here is not a way to make a red test green. It is a statement that the DB's message
 * grouping and the GAME disagree about a specific spell, and it needs evidence of that shape: log
 * lines showing the effect, or the wiki's own EFFECT column — the field spells.json does not
 * carry, and the field whose absence is the whole reason the message oracle can be wrong at all.
 *
 * IT IS TWO SONGS NOW, AND THE FAMILY IS HALF EXCEPTIONS. That is uncomfortable and is the honest
 * reading rather than a reason to reclassify the family: `Someone 's eyes glaze over.` is printed
 * by two charms and two mezzes, so the SENTENCE says nothing about the effect in either direction
 * and the only thing that can is a per-spell claim with per-spell evidence.
 */
const FAMILY_EXCEPTIONS: Record<string, 'charm'> = {
  // Bard 39. Charms — `You lose control of yourself!` 3 s after the sung line, three for three in
  // slice 01KZAG2QAW885YJNRTDDND8BF2; see the header. Shares the mez ladder's landing sentence and
  // nothing else.
  "Solon's Bewitching Bravura": 'charm',
  // Bard 27, and the SECOND Solon song (owner ruling, 2026-08-12). The evidence is the wiki page's
  // effect line — "1: Charm up to level 37" — which is a statement about what the spell DOES, in
  // the one column spells.json lacks. No slice in hand shows it doing the lose-control/regain pair
  // Bravura was proved by; that corroboration is OUTSTANDING and named as such rather than
  // implied. Both Solon songs are one line and now share one stem alternation.
  "Solon's Song of the Sirens": 'charm'
}

test('JOS-84 R1: ccSpell classifies every castable member of every mez/root family it claims', () => {
  for (const [message, ladder] of Object.entries(CC_FAMILIES)) {
    const members = castableSharing(message)
    assert.ok(members.length > 0, `spells.json must still carry ${ladder}`)
    for (const name of members) {
      if (name in FAMILY_EXCEPTIONS) continue
      assert.ok(
        cfg.ccSpell.test(name),
        `ccSpell misses "${name}" — ${ladder}. A ${name} break would parse as a plain buffFade ` +
          'and fire no alert at all.'
      )
      // …and it must not ALSO look like a charm: charm is tested first, so a false hit there
      // would retire a pet the player never had.
      assert.ok(!cfg.charmSpell.test(name), `"${name}" is a hold, not a charm`)
    }
  }
})

test('JOS-200 R1b: every family exception is still classified — into the OTHER roster', () => {
  // The exception buys a skip from R1, never a pass out of the rosters altogether. A spell that
  // fell out of both would parse its break to `buffFade` and fire nothing at all, which is the
  // original JOS-84 defect wearing a different hat.
  for (const [name, roster] of Object.entries(FAMILY_EXCEPTIONS)) {
    assert.ok(
      db.byKey.has(name.toLowerCase()),
      `spells.json (as corrected) must still carry "${name}" — an exception naming a spell that ` +
        'no longer exists is a stale claim, not a passing test'
    )
    assert.equal(roster, 'charm', 'only the charm direction is described here')
    assert.ok(cfg.charmSpell.test(name), `charmSpell must claim "${name}"`)
    assert.ok(!cfg.ccSpell.test(name), `ccSpell must NOT also claim "${name}" — one roster each`)
  }
})

test('JOS-225 R1c: a NOT_A_HOLD song is in NEITHER parser roster and parses to buffFade', () => {
  for (const [name, { why, fires }] of Object.entries(NOT_A_HOLD)) {
    assert.ok(
      db.byKey.has(name.toLowerCase()),
      `spells.json must still carry "${name}" (${why}) — a table naming a spell that no longer ` +
        'exists is a stale claim, not a passing test'
    )
    assert.ok(!cfg.ccSpell.test(name), `ccSpell must NOT claim "${name}" — ${why}`)
    assert.ok(!cfg.charmSpell.test(name), `charmSpell must NOT claim "${name}" — ${why}`)

    // …and end to end. The synthesized sentence has the same grammatical shape as the reporter's
    // (`Your <song> spell has worn off of <mob>.`) with a mob the owner's own log prints.
    const line = wornOff(name, 'a froglok ton knight')
    const ev = parseEvent(line, 0)
    assert.equal(
      ev?.kind,
      'buffFade',
      `"${name}" must file as an ordinary named-target debuff fade, not a hold ending`
    )
    const fired = fire(GROUP_DEFS, [line])
    assert.deepEqual(
      fired,
      fires,
      `"${name}" wearing off must fire exactly ${JSON.stringify(fires)} — ${why}`
    )
    // The JOS-225 report itself, stated as its own assertion so a future roster edit that
    // re-introduces the false positive fails HERE with the reporter's own words attached.
    assert.ok(
      !fired.includes('group:cc:broke'),
      `"${name}" must never fire "Mez / root broke" again — that is the JOS-225 report`
    )
    assert.ok(!fired.includes('charm-break'), `"${name}" is not a charm either`)
  }
})

test('JOS-233 R1c2: the binding songs fire the SLOW group, and only on the mob side', () => {
  // THE RULING, end to end: `Your Largo's <X> Binding spell has worn off of <mob>.` is the quiet
  // loss the slow group exists for, so it fires "Slow wore off a mob".
  const mob = fire(GROUP_DEFS, [
    `[Wed Aug 05 22:30:00 2026] Your Largo's Melodic Binding spell has worn off of a wanderer.`,
    `[Wed Aug 05 22:32:00 2026] Your Largo's Assonant Binding spell has worn off of a wanderer.`
  ])
  assert.deepEqual(mob, ['group:slow:mob', 'group:slow:mob'])

  // THE ON-YOU TRIPWIRE, and it is why the roster is two lists rather than one. Both Largo's and
  // the Bard 34 BENEFICIAL buff `Lyssa's Solidarity of Vision` print `The strands fade away.`
  // VERBATIM, and a `where:{spell}` matcher tests the whole candidate list (JOS-84) — so a single
  // shared roster would announce a slow every time that buff lapsed. The self sentence resolves
  // to all three names and must fire nothing at all.
  const self = parseEvent('[Wed Aug 05 22:34:00 2026] The strands fade away.', 0)
  assert.equal(self?.kind, 'buffWearOff')
  if (self?.kind !== 'buffWearOff') return
  assert.equal(self.target, 'self')
  assert.deepEqual(self.candidates, [
    "Largo's Assonant Binding",
    "Largo's Melodic Binding",
    "Lyssa's Solidarity of Vision"
  ])
  assert.deepEqual(
    fire(GROUP_DEFS, ['[Wed Aug 05 22:34:00 2026] The strands fade away.']),
    [],
    'one sentence for two songs and a beneficial buff cannot report a slow on you'
  )
})

test('JOS-225 R1d: re-filing Largo did not silence the mez beside it', () => {
  // The acceptance the ticket names: the false positive goes, the true positives stay, in ONE
  // stream. Timestamps are spaced so the group's 3 s cooldown collapses nothing — a `[]` here
  // would be the cooldown lying, not the roster.
  //
  // Since JOS-233 the two Largo's lines are not silent, they are the OTHER alert: `group:slow:mob`
  // where they used to say `group:cc:broke`. Position in this list is the assertion — the mez and
  // the charm beside them are unmoved, and no line answers to two groups.
  //
  // The MEZ control in slot 4 used to be `Solon's Song of the Sirens`; the owner ruled it a charm
  // on 2026-08-12 (R7), so the slot now holds `Crission's Pixie Strike` — a song from the same
  // landing family that is still a mez, which is the stronger control anyway: it proves the family
  // did not move with the two songs that left it.
  const lines = [
    `[Wed Aug 05 22:30:00 2026] Your Largo's Melodic Binding spell has worn off of a wanderer.`,
    '[Wed Aug 05 22:31:00 2026] Your Mesmerization spell has worn off of a wanderer.',
    `[Wed Aug 05 22:32:00 2026] Your Largo's Assonant Binding spell has worn off of a wanderer.`,
    `[Wed Aug 05 22:33:00 2026] Your Crission's Pixie Strike spell has worn off of a wanderer.`,
    '[Wed Aug 05 22:34:00 2026] Your Allure spell has worn off of a wanderer.'
  ]
  assert.deepEqual(fire(GROUP_DEFS, lines), [
    'group:slow:mob',
    'group:cc:broke',
    'group:slow:mob',
    'group:cc:broke',
    'charm-break'
  ])
})

test('JOS-84 R2: charmSpell classifies every castable member of every charm family it claims', () => {
  for (const [message, ladder] of Object.entries(CHARM_FAMILIES)) {
    const members = castableSharing(message)
    assert.ok(members.length > 0, `spells.json must still carry ${ladder}`)
    for (const name of members) {
      assert.ok(cfg.charmSpell.test(name), `charmSpell misses "${name}" — ${ladder}`)
    }
  }
})

test('JOS-250 R2b: a NOT_A_CHARM spell is refused by the roster AND arms no ownership window', () => {
  for (const [name, { why, castArms }] of Object.entries(NOT_A_CHARM)) {
    assert.ok(!cfg.charmSpell.test(name), `charmSpell must refuse "${name}" — ${why}`)
    assert.ok(!cfg.ccSpell.test(name), `ccSpell must refuse "${name}" — ${why}`)
    if (!castArms) continue
    // THE ASSERTION NOTHING IN THIS SUITE USED TO MAKE: drive the name through the real ownership
    // model as an own cast and prove the next charm broadcast is still foreign. A stem test alone
    // would have passed on the old roster too — `Boltran's Animation` matched the stem and the
    // damage it did was one layer down, in the arm the match opened.
    const m = new CharmModel()
    m.noteCastBegin(name, 1_000)
    assert.equal(
      m.charmBroadcast('a rock golem', 'a rock golem', 3_000),
      'foreign',
      `"${name}" must not arm the charm window — ${why}`
    )
  }
})

test('JOS-251 R2d: THE SWAP — the derived charm roster and the hand-audited stems agree, everywhere', () => {
  // `cfg.charmSpell` is no longer `CHARM_STEMS` (JOS-251): `installSpellDb` replaces it with the
  // set derived from each spell page's own EFFECT LIST, keeping the stems only as the fallback for
  // a name the catalog does not carry. This is the assertion that says the swap changed nothing.
  //
  // It is also the assertion that makes the swap worth making. JOS-250 arrived at these stems by
  // having a human read the wiki page by page and then hand-add four names and hand-remove four
  // others; the derivation arrives at the same 23 rows by reading a sentence the scrape now
  // captures. Agreement in BOTH directions over the whole catalog means the two methods can be
  // swapped without a behaviour question — and from here the next scrape that adds a charm adds it
  // without anybody reading anything.
  //
  // A FAILURE HERE IS INFORMATION, NOT NOISE. It means the wiki's effect line and our stem list
  // disagree about a specific spell, which is exactly the report JOS-84/200/225/250 each needed and
  // none of them had.
  const derived: string[] = []
  const stems: string[] = []
  for (const s of db.spells) {
    if (cfg.charmSpell.test(s.name)) derived.push(s.name)
    if (CHARM_STEMS.test(s.name)) stems.push(s.name)
  }
  const uniq = (a: string[]): string[] => [...new Set(a)].sort()
  assert.deepEqual(uniq(derived), uniq(stems))
  assert.equal(uniq(derived).length, 23, 'twenty player-castable charms and the three NPC-only ones')

  // …and the fallback is reachable rather than decorative: a name the catalog has never heard of
  // still answers to the stems, which is the only job they have left.
  // (`Dictate` and not `Charm`, because `\bcharm\b(?! of )` deliberately refuses a "Charm of …" —
  // that lookahead is JOS-250's fix for the two item focus effects.)
  assert.ok(!db.byKey.has('dictate of frobnication'), 'a name spells.json does not carry')
  assert.ok(cfg.charmSpell.test('Dictate of Frobnication'), 'the stem fallback still answers')
})

test('JOS-250 R2c: the roster still arms for a real charm, so R2b is not vacuous', () => {
  // The control the refusal above needs: the same three calls with a genuine charm must bind, or
  // R2b would pass on a model that never arms for anything.
  const m = new CharmModel()
  m.noteCastBegin('Charm', 1_000)
  assert.equal(m.charmBroadcast('a rock golem', 'a rock golem', 3_000), 'own')
})

// ── R3: the reporter's own sentence, end to end ──────────────────────────────────────────────

test("JOS-200 R3: the bard's Bravura break parses as an uncharm and fires the charm-break alert", () => {
  // The injected sentence — verbatim from slice 01KZAG2QAW885YJNRTDDND8BF2 with the mob swapped
  // for one the owner's log prints (the slice's was `a fire giant warrior`).
  //
  // THIS ASSERTION USED TO SAY THE OPPOSITE, and the reversal is the ticket. JOS-84 pinned
  // `group:cc:broke` here and explicitly pinned the ABSENCE of `charm-break`, on the strength of
  // the landing-message family; three reporters (01KZM7F36JD12WYF15DHCCWNEE 0.14.0,
  // 01KZMPYP1QA3N02FE42T473TZM 0.16.0, 01KZPJZSTYPSKGR3GRP3FVW8RQ 0.18.0) each said charm and each
  // was right. The header carries the log evidence. What they asked for is the line below.
  const line = wornOff("Solon's Bewitching Bravura", 'a froglok ton knight')
  const ev = parseEvent(line, 0)
  assert.equal(ev?.kind, 'uncharm', 'a bard charm break is an uncharm, not a cc refresh')
  if (ev?.kind !== 'uncharm') return
  assert.equal(ev.mob, 'a froglok ton knight')
  assert.equal(ev.spell, "Solon's Bewitching Bravura")

  assert.deepEqual(fire(GROUP_DEFS, [line]), ['charm-break'])
})

test('JOS-84 R4: the whole bard crowd-control ladder fires the mez/root group', () => {
  // Every song at its own timestamp so the group's 3 s cooldown does not collapse them.
  // Bravura is NOT in this list since JOS-200 — it is a charm, and R3 above is its assertion.
  // Solon's Song of the Sirens left it on the owner's 2026-08-12 ruling for the same reason; R7
  // below is where both Solon songs are asserted together.
  // Neither Largo's is in it since JOS-225 — they are movement debuffs, and R1c/R1c2/R1d are
  // theirs (they fire the SLOW group since JOS-233, never this one).
  const songs = ["Kelin's Lucid Lullaby", "Crission's Pixie Strike", "Sionachie's Dreams"]
  const lines = songs.map(
    (s, i) => `[Wed Aug 05 22:${String(30 + i).padStart(2, '0')}:00 2026] Your ${s} spell has worn off of a froglok ton knight.`
  )
  assert.deepEqual(
    fire(GROUP_DEFS, lines),
    songs.map(() => 'group:cc:broke'),
    'every bard hold must announce its own break'
  )
})

test("JOS-84 R5: the Necromancer charm-undead ladder's top two now fire charm break", () => {
  const lines = [
    '[Wed Aug 05 22:30:00 2026] Your Thrall of Bones spell has worn off of a decaying skeleton.',
    '[Wed Aug 05 22:31:00 2026] Your Enslave Death spell has worn off of a decaying skeleton.'
  ]
  assert.deepEqual(fire(GROUP_DEFS, lines), ['charm-break', 'charm-break'])
})

test('JOS-250 R5b: the three unmatched Druid/Shaman charms now fire charm break', () => {
  // The ladder's two ends: the druid's FIRST charm (13) and their last two (52, 55). Every one of
  // them was an ordinary `buffFade` before JOS-250 — no `uncharm` event, no alert, and the same
  // "your charm break doesn't work" report the bard filed in JOS-84, waiting to be filed again by
  // a druid.
  //
  // TUNARE`S REQUEST IS SPELLED WITH AN APOSTROPHE HERE, ON PURPOSE. The committed spells.json
  // row uses a BACKTICK (`Tunare\`s Request`) and the game's own lines use an apostrophe, so the
  // stem's `.` covers both and this pair of assertions is what proves it: the LOG form below, and
  // the DB form that R2 above walks out of `castableSharing('Someone blinks.')`.
  const lines = [
    '[Wed Aug 05 22:30:00 2026] Your Befriend Animal spell has worn off of a black bear.',
    '[Wed Aug 05 22:31:00 2026] Your Call of Karana spell has worn off of a black bear.',
    "[Wed Aug 05 22:32:00 2026] Your Tunare's Request spell has worn off of a black bear."
  ]
  for (const l of lines) assert.equal(parseEvent(l, 0)?.kind, 'uncharm', l)
  assert.deepEqual(fire(GROUP_DEFS, lines), ['charm-break', 'charm-break', 'charm-break'])
  // …and the DB's backtick spelling classifies too, or the oracle and the game would disagree
  // about one spell (the same trap `solon.s (bewitching )?bravura` exists for).
  assert.ok(cfg.charmSpell.test('Tunare`s Request'), 'the backtick form is the DB\'s')
})

test('JOS-84 R6: the regression gate — the enchanter shapes are untouched', () => {
  // The three lines tests/alertGroups.test.mts already pins, re-asserted here because this change
  // edits the regexes those assertions run through. A charm is still a charm, a mez is still a
  // mez, and a slow is still neither.
  assert.equal(parseEvent(wornOff('Allure', 'an ice giant'), 0)?.kind, 'uncharm')
  assert.equal(parseEvent(wornOff('Mesmerization', 'a froglok ton knight'), 1)?.kind, 'cc')
  const slow = parseEvent(wornOff('Shiftless Deeds', 'King Tranix'), 2)
  assert.equal(slow?.kind, 'buffFade', 'a slow is an ordinary named-target fade — the slow group ' +
    'matches it by SPELL, so misfiling it as cc would silence that alert too')
  assert.deepEqual(fire(GROUP_DEFS, [wornOff('Shiftless Deeds', 'King Tranix')]), ['group:slow:mob'])
})

test('R7: the exceptions are NAMED SONGS, not their landing family', () => {
  // THIS TEST USED TO USE `Solon's Song of the Sirens` AS ITS COUNTER-EXAMPLE — "prints the SAME
  // sentence as Bravura and is still a mez, so a stem matching a bare `solon.s` would silently
  // convert its mez break into a charm break". The owner ruled 2026-08-12 that it is a charm, on
  // the wiki page's EFFECT line ("1: Charm up to level 37"), so the counter-example is gone and
  // the guard has to be rebuilt out of what is left.
  //
  // THE GUARD ITSELF IS UNCHANGED IN SHAPE, and it is still worth having: the family is now TWO
  // charms and TWO mezzes, so a stem that reached too far in the OTHER direction — matching
  // `crission` or `sionachie` off "they're all Solon-ish bard songs", or a family-wide
  // reclassification — would silently convert a real mez break into a charm break and announce a
  // pet that never existed. Four spells, one sentence, two effects, and only per-spell evidence
  // can tell them apart.
  //
  // The wiki effect line is what this ruling rests on. Bravura additionally has FIELD evidence
  // (JOS-200: `You lose control of yourself!` at T+3 s in slice 01KZAG2QAW885YJNRTDDND8BF2,
  // against nine `You are stunned!` episodes in the same slice); Sirens does not yet, and would
  // be upgraded from stated to measured by a slice showing the same pair.
  assert.equal(parseEvent(wornOff("Solon's Bewitching Bravura", 'a froglok ton knight'), 0)?.kind, 'uncharm')
  assert.equal(parseEvent(wornOff("Solon's Song of the Sirens", 'a froglok ton knight'), 1)?.kind, 'uncharm')
  assert.equal(parseEvent(wornOff("Crission's Pixie Strike", 'a froglok ton knight'), 2)?.kind, 'cc')
  assert.equal(parseEvent(wornOff("Sionachie's Dreams", 'a froglok ton knight'), 3)?.kind, 'cc')

  // …and end to end through the real groups, at spaced timestamps so no cooldown collapses them:
  // two charm breaks, two mez breaks, from four sentences a message oracle cannot tell apart.
  const lines = [
    `[Wed Aug 05 22:30:00 2026] Your Solon's Bewitching Bravura spell has worn off of a froglok ton knight.`,
    `[Wed Aug 05 22:31:00 2026] Your Solon's Song of the Sirens spell has worn off of a froglok ton knight.`,
    `[Wed Aug 05 22:32:00 2026] Your Crission's Pixie Strike spell has worn off of a froglok ton knight.`,
    `[Wed Aug 05 22:33:00 2026] Your Sionachie's Dreams spell has worn off of a froglok ton knight.`
  ]
  assert.deepEqual(fire(GROUP_DEFS, lines), [
    'charm-break',
    'charm-break',
    'group:cc:broke',
    'group:cc:broke'
  ])
})
