// JOS-84 — A SUGGESTED ALERT MUST FIRE ON THE LINE ITS SPELL PRINTS.
//
// THE REPORT. A v0.10.0 enchanter created the slow-landed alert FROM SUGGESTED and it never
// fired. They hand-edited the pattern (their slow is Shiftless Deeds) and it still never fired.
// They created the Incapacitate one and it never fired either.
//
// THE ROOT CAUSE, measured against their own log lines (feedback report
// 01KZEGGWTKYN7C8FMNPQ4Y181P — a reporter's slice, so it is quoted here and never committed):
// EQ prints ONE landing sentence for a whole spell family, and the parser says so. Their real
// lines resolve like this through src/main/log/parseCasts.ts + the committed spells.json:
//
//   `Coercer T`vala slows down.`   → buffApply { spell:'Forlorn Deeds',
//                                     candidates:[Forlorn Deeds, Languid Pace, Rejuvenation,
//                                                 Shiftless Deeds, Tepid Deeds] }
//   `Coercer T`vala looks frail.`  → buffApply { spell:'Disempower',
//                                     candidates:[Disempower, Incapacitate, Listless Power] }
//
// `buffApply.spell` is documented as a BEST-EFFORT first candidate (shared/logEvents.ts), and it
// is alphabetical — it is not, and cannot be, the spell the user cast. The `lands` suggestion
// template authored `where:{spell:'Shiftless Deeds'}`, which the alerts module compared to the
// literal string "Forlorn Deeds". It was never an anchor problem and never a self-cast /
// third-person problem: the trigger was pinned to a coin flip, and lost it every time.
//
// THE FIX under test: a `where.spell` matcher tests the event's WHOLE candidate list
// (main/modules/alerts.ts `spellCandidateNames`), and the fire reports the name that actually
// satisfied the matcher rather than the arbitrary pick (`matchedSpellName`) — so a spoken alert
// says "Shiftless Deeds", not "Forlorn Deeds".
//
// THE DEFS ARE NOT HAND-WRITTEN HERE. Every trigger below comes out of the REAL wizard path —
// buildSpellCatalog(loadSpellDb()) → suggestionsFor(entry, rank) — and goes into the REAL
// AlertsModule through the REAL parser. That path had never been executed by a test, because
// suggestions.ts imported a VALUE through the `@shared/*` alias and could not load under tsx at
// all; that is a large part of why this shipped. The alias import is now relative (repo law).
//
// Run: `npm test`.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseEvent } from '../src/main/log/parser'
import { installSpellDb } from '../src/main/log/rulesets'
import { buildSpellCatalog, loadSpellDb } from '../src/main/data/spellDb'
import { AlertsModule } from '../src/main/modules/alerts'
import {
  illusionSuggestion,
  spellShortName,
  suggestionsFor
} from '../src/renderer/src/features/alerts/suggestions'
import { speechTextFor } from '../src/shared/speechText'
import type { SpellRank } from '../src/shared/spellLines'
import type { AlertDef, FiredAlert, SpellCatalogEntry } from '../src/shared/types'

// The whole defect lives in the DB-driven message families, so the DB is installed exactly as
// main installs it. Node runs each test FILE in its own process, so this cannot reach a sibling.
const db = loadSpellDb()
installSpellDb(db)
const catalog = buildSpellCatalog(db, new Map())

/**
 * THE REPORTER'S OWN LINES, verbatim from slice 01KZEGGWTKYN7C8FMNPQ4Y181P (mob names left as
 * their log spelled them — they are mobs, not people). Quoted in the test rather than extracted
 * into tests/fixtures/, per AGENTS.md: a reporter's slice never becomes a committed fixture, and
 * these are single client notices with no surrounding state to warm.
 */
const SLICE = {
  slowLandedTvala: '[Fri Aug 07 09:07:24 2026] Coercer T`vala slows down.',
  slowLandedChosen: '[Fri Aug 07 09:17:14 2026] Innoruuk`s Chosen slows down.',
  incapCast: '[Fri Aug 07 09:07:49 2026] You begin casting Incapacitate V.',
  incapLanded: '[Fri Aug 07 09:07:51 2026] Coercer T`vala looks frail.',
  incapCastLater: '[Fri Aug 07 09:17:19 2026] You begin casting Incapacitate V.',
  incapLandedLater: '[Fri Aug 07 09:17:21 2026] Innoruuk`s Chosen looks frail.'
}

function entryFor(key: string): SpellCatalogEntry {
  const e = catalog.entries.find((x) => x.key === key)
  assert.ok(e, `spells.json must carry a catalog entry for "${key}"`)
  return e
}

/** The rank the wizard pins the two rank-templates to, shaped as the alerts snapshot supplies it. */
function rank(name: string): SpellRank {
  return { name, rank: 5, lastCastMs: Date.parse('2026-08-07T09:07:49Z') } as SpellRank
}

/** Feed raw log lines through the real parser into a module holding `defs`; return the fires. */
function fire(defs: AlertDef[], lines: string[]): FiredAlert[] {
  const mod = new AlertsModule()
  mod.setDefs(defs)
  mod.reset()
  let seq = 0
  for (const line of lines) {
    const ev = parseEvent(line, seq++)
    if (ev) mod.onEvent(ev, true)
  }
  return mod.flushDelta()?.delta.fired ?? []
}

/** Every def the wizard would author for this spell, rank chips included. */
function suggestedDefs(key: string, rankName: string): AlertDef[] {
  return suggestionsFor(entryFor(key), rank(rankName)).map((s) => s.def)
}

test('JOS-84 A1: the from-suggested SLOW-LANDED alert fires on the reporter\'s own line', () => {
  const defs = suggestedDefs('shiftless deeds', 'Shiftless Deeds V')
  const lands = defs.find((d) => d.id === 'suggest:shiftless deeds:lands')
  assert.ok(lands, 'the wizard must still offer a "lands" suggestion for Shiftless Deeds')
  // The trigger is UNCHANGED by this fix — pinned to the user's own spell, as authored.
  assert.deepEqual(lands.trigger, {
    type: 'event',
    kind: 'buffApply',
    where: { spell: 'Shiftless Deeds' }
  })

  const fired = fire([lands], [SLICE.slowLandedTvala, SLICE.slowLandedChosen])
  assert.equal(fired.length, 2, 'both slow landings must fire')
  assert.deepEqual(
    fired.map((f) => f.matchedText),
    [SLICE.slowLandedTvala, SLICE.slowLandedChosen]
  )
  // …and it must SAY the user's spell, not the alphabetically-first candidate.
  assert.deepEqual(fired.map((f) => f.spell), ['Shiftless Deeds', 'Shiftless Deeds'])
})

test('JOS-84 A2: the from-suggested INCAPACITATE alert fires on the reporter\'s own line', () => {
  const defs = suggestedDefs('incapacitate', 'Incapacitate V')
  const lands = defs.find((d) => d.id === 'suggest:incapacitate:lands')
  assert.ok(lands, 'the wizard must still offer a "lands" suggestion for Incapacitate')

  const fired = fire([lands], [SLICE.incapLanded, SLICE.incapLandedLater])
  assert.equal(fired.length, 2, 'both Incapacitate landings must fire')
  assert.deepEqual(fired.map((f) => f.spell), ['Incapacitate', 'Incapacitate'])
})

test('JOS-84 A3: the pre-fix event is exactly the coin flip the report described', () => {
  // The evidence, pinned so the diagnosis cannot rot: the parser's `spell` field is NOT the
  // user's spell, and the candidate list is where the truth lives.
  const slow = parseEvent(SLICE.slowLandedTvala, 0)
  assert.equal(slow?.kind, 'buffApply')
  if (slow?.kind !== 'buffApply') return
  assert.equal(slow.target, 'Coercer T`vala')
  assert.equal(slow.spell, 'Forlorn Deeds', 'best-effort pick is alphabetical, not what you cast')
  assert.ok(slow.candidates.some((c) => c.name === 'Shiftless Deeds'))

  const incap = parseEvent(SLICE.incapLanded, 1)
  assert.equal(incap?.kind, 'buffApply')
  if (incap?.kind !== 'buffApply') return
  assert.equal(incap.spell, 'Disempower')
  assert.ok(incap.candidates.some((c) => c.name === 'Incapacitate'))
})

test('JOS-84 A4: THE SIBLING AUDIT — every template the wizard can author fires', () => {
  // The brief's instruction: if one suggested pattern is wrong, the others from the same
  // generator likely are too. All five rank-less/rank-pinned templates plus the shared illusion
  // one, each against the line that must set it off. `wearsOff`/`fade` are BENEFICIAL-only, so
  // they are exercised on a beneficial spell the same DB carries.
  const detrimental = suggestedDefs('shiftless deeds', 'Shiftless Deeds V')
  // The two rank templates carry the rank fragment in their id (`…:castRank:shiftless-deeds-v`).
  const byPrefix = (p: string): AlertDef => {
    const d = detrimental.find((x) => x.id.startsWith(p))
    assert.ok(d, `the wizard must offer ${p}`)
    return d
  }

  const cast = fire(
    [byPrefix('suggest:shiftless deeds:castRank')],
    ['[Fri Aug 07 09:07:20 2026] You begin casting Shiftless Deeds V.']
  )
  assert.equal(cast.length, 1, 'castRank must fire on the rank-suffixed cast line')
  assert.equal(cast[0].spell, 'Shiftless Deeds V')

  const resisted = fire(
    [byPrefix('suggest:shiftless deeds:resistRank')],
    ['[Fri Aug 07 09:07:30 2026] Coercer T`vala resisted your Shiftless Deeds V!']
  )
  assert.equal(resisted.length, 1, 'resistRank must fire on your own resisted cast')

  // The beneficial pair. Clarity's fade/wears-off lines name the spell outright, so these two
  // templates were never in the coin-flip family — this pins that they still are not.
  const clarity = suggestionsFor(entryFor('clarity')).map((s) => s.def)
  const wearsOff = clarity.find((d) => d.id === 'suggest:clarity:wearsOff')
  const fade = clarity.find((d) => d.id === 'suggest:clarity:fade')
  assert.ok(wearsOff && fade, 'Clarity must offer both beneficial templates')
  assert.equal(
    fire([fade], ['[Fri Aug 07 09:20:00 2026] Your Clarity spell has worn off of Bonbonz.']).length,
    1,
    'fade must fire on a named-target wear-off'
  )
  // `wearsOff` matches the DERIVED buffExpired the buffs module synthesizes (it carries an
  // already-RESOLVED spell, which is why this template was never in the coin-flip family), so it
  // is handed to the module directly — no log line parses into one.
  const mod = new AlertsModule()
  mod.setDefs([wearsOff])
  mod.reset()
  mod.onEvent(
    {
      kind: 'buffExpired',
      seq: 1,
      ts: Date.parse('2026-08-07T09:20:30Z'),
      raw: '[Fri Aug 07 09:20:30 2026] Your Clarity spell has worn off.',
      spell: 'Clarity',
      target: 'self'
    },
    true
  )
  assert.equal(
    (mod.flushDelta()?.delta.fired ?? []).length,
    1,
    'wearsOff must fire on the resolved buffExpired'
  )

  // The shared illusion suggestion.
  assert.equal(
    fire([illusionSuggestion().def], ['[Fri Aug 07 09:21:00 2026] Your illusion fades.']).length,
    1,
    'the illusion suggestion must fire on the generic fade line'
  )
})

test('JOS-84 A5: the widening is scoped — it cannot make an unrelated family fire', () => {
  // THE TRIPWIRE. `Your speed returns to normal.` is NINE HASTES and shares nothing with the
  // slow roster; the shared-message widening must not reach it. (shared/alertGroups.ts calls
  // this exact sentence out as the slow group's tripwire — it is one word from `Your speed
  // returns.`, which IS a slow.)
  const slowLands = suggestedDefs('shiftless deeds', 'Shiftless Deeds V').find(
    (d) => d.id === 'suggest:shiftless deeds:lands'
  )!
  assert.equal(
    fire([slowLands], ['[Fri Aug 07 09:22:00 2026] Your speed returns to normal.']).length,
    0,
    'a haste wearing off must never fire a slow alert'
  )
  // A `where` key that is not `spell` keeps its exact-compare semantics untouched.
  const targetPinned: AlertDef = {
    id: 'test:target-pinned',
    name: 'target pinned',
    enabled: true,
    trigger: { type: 'event', kind: 'buffApply', where: { spell: 'Shiftless Deeds', target: 'nobody' } },
    cooldownMs: 0
  }
  assert.equal(fire([targetPinned], [SLICE.slowLandedTvala]).length, 0)
})

test('JOS-84 A6: an alert pinned to a sibling of the same sentence fires too, and says so', () => {
  // Stated rather than hidden: when one sentence is five spells the log does not say which, so
  // the alert reports the FAMILY. A Languid Pace user (the level-9 rank of the same enchanter
  // ladder) gets the same fire off the same line — which is exactly what keeps the alert alive
  // across the level-up that replaces the spell.
  const languid = suggestionsFor(entryFor('languid pace')).map((s) => s.def)
  const lands = languid.find((d) => d.id === 'suggest:languid pace:lands')
  assert.ok(lands)
  const fired = fire([lands], [SLICE.slowLandedTvala])
  assert.equal(fired.length, 1)
  assert.equal(fired[0].spell, 'Languid Pace', 'it names the spell the ALERT is for')
})

// ---------------------------------------------------------------------------------------------
// JOS-103 — SPIRIT OF THE PUMA, AND THE CAPTURE TEMPLATE IT SHIPPED (report
// 01KZH1YK7YPRC40QPV00X1Z4NX, v0.12.0: "missing from suggested alerts").
//
// THE LINES ARE THE OWNER'S OWN, verbatim from eqlog_Primitive_freeport.txt — lines 890466-890467,
// the log's ONLY occurrence. Not a reporter's slice and not hand-authored: a shaman named Fail
// cast Puma on a group in Freeport on 2026-08-01. Two client notices with no surrounding state to
// warm, so they are quoted here rather than extracted into tests/fixtures/ (the same reasoning
// the JOS-84 block above states).
// ---------------------------------------------------------------------------------------------

const PUMA = {
  cast: '[Sat Aug 01 18:38:09 2026] Fail begins casting Spirit of the Puma VI.',
  landed: '[Sat Aug 01 18:38:10 2026] Fail growls with the spirit of the puma.',
  // The DB's own msgCastOnYou / msgWearsOff for the spell (src/main/data/spells.json). The owner
  // never held the buff, so his log has neither; these are the game's words as the committed wiki
  // scrape records them, which is the same provenance every DB-driven family is tested from.
  selfLanded: '[Sat Aug 01 18:38:11 2026] You begin to snarl as your features become feline.',
  departs: '[Sat Aug 01 18:39:10 2026] The spirit of the puma departs.'
}

test('JOS-103 P1: the landing line has a typed event SINCE JOS-174, and the raw trigger is still why', () => {
  // THE DIAGNOSIS, PINNED — AND THEN FIXED, which is why this assertion inverted.
  //
  // JOS-103 measured this line as `{kind:'unknown'}`: Puma's msgCastOnOther is `Target growls with
  // the spirit of the puma.` and the cast-on-other suffix table is keyed by what is left after the
  // wiki's "Someone " subject is stripped, so the message was not in the table at all. That is why
  // the shipped suggestion for this family is a `raw` capture trigger — there was no typed path.
  //
  // JOS-174 swept that drift class (`spellCorrectionsSubjects.ts`): the subject is restored, the
  // suffix keys, and the line is a `buffApply` now. NOTHING ELSE CHANGES HERE. The capture template
  // still ships and still fires, because a `raw` condition tests `ev.raw` whatever the event's kind
  // turns out to be (P2 below drives exactly that), and it is still the only thing that can SAY who
  // the buff landed on — a typed `buffApply` carries the target but the `lands` template is
  // disposition-gated and Puma is a `Proc Buff`. The assertion is inverted rather than deleted so
  // the reason the raw trigger exists stays legible after the fact.
  assert.equal(parseEvent(PUMA.landed, 0)?.kind, 'buffApply', 'the subject restoration gave the family a typed event')
  // The two DB-message sides DO parse, which is what the other templates rest on.
  assert.equal(parseEvent(PUMA.selfLanded, 1)?.kind, 'buffApply')
  const worn = parseEvent(PUMA.departs, 2)
  assert.equal(worn?.kind, 'buffWearOff')
  if (worn?.kind !== 'buffWearOff') return
  assert.deepEqual(worn.candidates, ['Spirit of the Puma'], 'unambiguous — one candidate, not a family')
  assert.equal(worn.target, 'self', 'the wears-off emote prints to the HOLDER, whoever cast it')
})

test('JOS-103 P2: the suggestion fires on the owner\'s real line and SPEAKS the captured name', () => {
  const sugg = suggestionsFor(entryFor('spirit of the puma'))
  const lands = sugg.find((s) => s.template === 'landsOnOther')?.def
  assert.ok(lands, 'the wizard must offer the capture template for Spirit of the Puma')
  assert.deepEqual(lands.trigger, {
    type: 'raw',
    regex: "^\\[[^\\]]*\\] (?<player>[A-Za-z' `]{1,48}) growls with the spirit of the puma\\."
  })
  assert.deepEqual(lands.speech, { mode: 'custom', phrase: 'Puma on {player}' })
  // 'both', never 'speech': the pack sound is the half that is guaranteed audible on a machine
  // with no speech voices, and `speechPlan` falls back to it only for EMPTY TEXT, never for a
  // missing engine. An app-authored suggestion must not be able to ship silence.
  assert.equal(lands.audio, 'both')

  const fired = fire([lands], [PUMA.landed])
  assert.equal(fired.length, 1, 'it must fire on the real line')
  assert.equal(fired[0].matchedText, PUMA.landed)
  assert.deepEqual(fired[0].captures, { player: 'Fail' })
  assert.equal(speechTextFor(lands, fired[0]), 'Puma on Fail', 'THE ACCEPTANCE CRITERION')
})

test('JOS-103 P3: the wears-off suggestion covers a buff SOMEBODY ELSE cast on you', () => {
  // WHY THE TEMPLATE WAS WIDENED. `buffExpired` is synthesized only when the buffs module resolves
  // a wear-off against its ACTIVE set, and its own-cast gate means a groupmate's buff is never
  // tracked — so the derived event never arrives for exactly the buffs a player most wants this
  // alert on. The `any` composite adds the raw `buffWearOff`, which EQ prints to the HOLDER.
  const wearsOff = suggestionsFor(entryFor('spirit of the puma')).find(
    (s) => s.template === 'wearsOff'
  )?.def
  assert.ok(wearsOff, 'Puma must offer a wears-off suggestion')
  assert.deepEqual(wearsOff.trigger, {
    type: 'any',
    conditions: [
      { type: 'event', kind: 'buffExpired', where: { spell: 'Spirit of the Puma' } },
      { type: 'event', kind: 'buffWearOff', where: { spell: 'Spirit of the Puma' } }
    ]
  })
  const fired = fire([wearsOff], [PUMA.departs])
  assert.equal(fired.length, 1, 'the fade line alone must fire it — no own-cast required')
  assert.equal(fired[0].spell, 'Spirit of the Puma')
})

test('JOS-103 P4: the widened wears-off still fires exactly ONCE for your own buff', () => {
  // The duplicate the composite could have introduced: a self-cast buff produces the raw
  // buffWearOff AND the derived buffExpired the buffs module synthesizes from it. Both are stamped
  // with the PRIMARY event's ts, so the alert's own cooldown swallows the second.
  const wearsOff = suggestionsFor(entryFor('clarity')).find((s) => s.template === 'wearsOff')!.def
  const mod = new AlertsModule()
  mod.setDefs([wearsOff])
  mod.reset()
  const ts = Date.parse('2026-08-07T09:20:30Z')
  const raw = '[Fri Aug 07 09:20:30 2026] Your mind fades.'
  mod.onEvent(
    { kind: 'buffWearOff', seq: 1, ts, raw, spell: 'Clarity', candidates: ['Clarity'], target: 'self' },
    true
  )
  mod.onEvent({ kind: 'buffExpired', seq: 1, ts, raw, spell: 'Clarity', target: 'self' }, true)
  assert.equal((mod.flushDelta()?.delta.fired ?? []).length, 1, 'one line, one alert')
})

test('JOS-103 P5: the spoken default names the spell\'s DISTINCTIVE word, not its first', () => {
  // `spellFirstWord` would say "Spirit", which names Spirit of Wolf, Spirit of the Scorpion,
  // Spirit of Bih`Li and a dozen more. Authoring only — it renames nothing.
  assert.equal(spellShortName('Spirit of the Puma'), 'Puma')
  assert.equal(spellShortName('Spirit of Wolf'), 'Wolf')
  assert.equal(spellShortName('Ward of Calliav'), 'Calliav')
  assert.equal(spellShortName('Shiftless Deeds'), 'Shiftless', 'no function word → the first word')
  assert.equal(spellShortName('Clarity'), 'Clarity')
  assert.equal(spellShortName('Mesmerization III'), 'Mesmerization', 'the rank is not a word')
})

// ---------------------------------------------------------------------------------------------
// JOS-161 — THE TWO BARD SONGS THE WIKI WORDS WRONGLY (report: a bard on 0.14.0 could not get an
// alert to fire for `Sionachie's Dreams` or `Solon's Bewitching Bravura` with ANY trigger type,
// buff-expire included).
//
// TWO SEPARATE CAUSES, both fixed through the JOS-150 corrections overlay:
//   * `Sionachie's Dreams` wrote its landing as `Target's eyes glaze over.` where its three ladder
//     siblings write `Someone 's eyes glaze over.` — no `castOnOtherSuffix`, so the song was in no
//     table, `templates.lands` was false, and the sentence it really prints resolved to a
//     candidate list the song was not in. There was nothing to pin an alert to.
//   * The level-39 song is `Solon's Bravura` in the scrape and `Solon's Bewitching Bravura` in the
//     game. The name is the join key — `byKey`, the catalog `key`/`name`, and every `where.spell`
//     — so the landing alert and the break alert could not both be satisfied by one string.
//
// AND THE THIRD THING, which is why "buff-expire" was in the report: a mez on a mob emits no
// `buffExpired` and never could. Its break is a `cc {refresh:true}`, and until now the only alert
// that matched it was the family-wide "Mez / root broke" group. `breaks` is the per-spell one.
//
// THE LINES ARE REAL. The two `<mob>'s eyes glaze over.` landings and both `You begin singing`
// lines are the shapes slice 01KZAG2QAW885YJNRTDDND8BF2 carries verbatim; the owner's own log
// carries the same sentence 14 times (lines 300196-525511) including one three seconds after
// `Enzee begins singing Sionachie's Dreams.`. Single client notices with no surrounding state to
// warm, quoted here rather than committed as a fixture — the AGENTS.md reporter-slice rule, the
// same way the JOS-84 and JOS-103 blocks above do it.
// ---------------------------------------------------------------------------------------------

const BARD = {
  bravuraCast: "[Wed Aug 05 22:27:33 2026] You begin singing Solon's Bewitching Bravura IX.",
  bravuraLanded: "[Wed Aug 05 22:27:35 2026] a fire giant warrior's eyes glaze over.",
  bravuraBroke:
    "[Wed Aug 05 22:28:56 2026] Your Solon's Bewitching Bravura spell has worn off of a fire giant warrior.",
  dreamsCast: "[Wed Aug 05 22:26:46 2026] You begin singing Sionachie's Dreams IV.",
  dreamsLanded: "[Thu Jul 30 18:32:43 2026] a revenant's eyes glaze over.",
  dreamsBroke:
    "[Sun Aug 09 13:43:23 2026] Your Sionachie's Dreams spell has worn off of an elemental crusader."
}

test('JOS-161 B1: the bard mez LANDING alert fires for both songs', () => {
  for (const [key, line] of [
    ["sionachie's dreams", BARD.dreamsLanded],
    ["solon's bewitching bravura", BARD.bravuraLanded]
  ] as const) {
    const lands = suggestionsFor(entryFor(key)).find((s) => s.template === 'lands')?.def
    assert.ok(lands, `the wizard must offer a "lands" suggestion for ${key}`)
    const fired = fire([lands], [line])
    assert.equal(fired.length, 1, `${key}: the landing line must fire it`)
    // …and it names the ALERT's song, not the coin-flip first candidate of a four-song family.
    assert.equal(fired[0].spell, entryFor(key).name)
  }
})

test('JOS-161 B2: the mez BREAK alert fires by name', () => {
  // Bravura left this list in JOS-200 — it is a charm, and B2b below is its assertion. The mez
  // half is unchanged and still has to work.
  for (const [key, line] of [["sionachie's dreams", BARD.dreamsBroke]] as const) {
    const breaks = suggestionsFor(entryFor(key)).find((s) => s.template === 'breaks')?.def
    assert.ok(breaks, `the wizard must offer a "breaks" suggestion for ${key}`)
    assert.deepEqual(breaks.trigger, {
      type: 'event',
      kind: 'cc',
      where: { spell: entryFor(key).name, refresh: 'true' }
    })
    const fired = fire([breaks], [line])
    assert.equal(fired.length, 1, `${key}: the break line must fire it`)
    assert.equal(fired[0].matchedText, line)
  }
})

test('JOS-200 B2b: the CHARM break alert fires by name — the bard song and the enchanter line', () => {
  // The chip three reporters went looking for and could not find. Two things had to change for it
  // to exist: the song moved from `ccSpell` to `charmSpell` (so its break is an `uncharm` at all),
  // and `charmBreaks` gave the CHARM roster a per-spell offer it never had — which is why `allure`
  // is asserted right beside it. An enchanter typing "Allure" into the wizard had the identical
  // hole; only the family-wide group existed for them.
  for (const [key, line] of [
    ["solon's bewitching bravura", BARD.bravuraBroke],
    ['allure', '[Wed Aug 05 22:31:00 2026] Your Allure spell has worn off of an ice giant.']
  ] as const) {
    const entry = entryFor(key)
    const charmBreaks = suggestionsFor(entry).find((s) => s.template === 'charmBreaks')?.def
    assert.ok(charmBreaks, `the wizard must offer a "charmBreaks" suggestion for ${key}`)
    // No `refresh` key: an `uncharm` carries only `mob` and `spell`, so pinning the name IS the
    // trigger. (Measured for JOS-200: 3,382 of 3,383 wear-off-of lines in the owner's whole log
    // are rank-less, so the catalog's display name is the string the sentence carries.)
    assert.deepEqual(charmBreaks.trigger, {
      type: 'event',
      kind: 'uncharm',
      where: { spell: entry.name }
    })
    const fired = fire([charmBreaks], [line])
    assert.equal(fired.length, 1, `${key}: the charm-break line must fire it`)
    assert.equal(fired[0].matchedText, line)
  }
})

test('JOS-200 B2c: the two break chips are disjoint — no spell is offered both', () => {
  // `classifyWornOff` tests `charmSpell` before `ccSpell`, so a spell in both rosters would be
  // handed a `breaks` chip whose `cc` trigger the parser guarantees will never fire. Walk the whole
  // catalog rather than a sample: this is a property of the two regexes, and the cheapest place to
  // notice a future stem that overlaps is here.
  const both = catalog.entries.filter((e) => e.templates.breaks && e.templates.charmBreaks)
  assert.deepEqual(both.map((e) => e.name), [], 'a spell offered both chips has one that cannot fire')
  // …and the song at the heart of JOS-200 is on the charm side of that line, not the mez side.
  const bravura = entryFor("solon's bewitching bravura")
  assert.equal(bravura.templates.charmBreaks, true)
  assert.equal(bravura.templates.breaks, false)
})

test('JOS-161 B3: the break alert is pinned — another song`s break does not fire it', () => {
  // The whole point of a PER-SPELL break alert beside the family-wide group: it has to be able to
  // tell the two songs apart. `where.spell` on a `cc` refresh compares the name the break line
  // itself carries, which is why the rename had to happen for the level-39 song at all.
  const dreams = suggestionsFor(entryFor("sionachie's dreams")).find((s) => s.template === 'breaks')!.def
  // Since JOS-200 a Bravura break is not even a `cc` — it is an `uncharm` — so this holds twice
  // over: wrong spell AND wrong event.
  assert.equal(fire([dreams], [BARD.bravuraBroke]).length, 0, 'a Bravura break is not a Dreams break')
  assert.equal(
    fire([dreams], ['[Sun Aug 09 13:43:23 2026] Your Mesmerization spell has worn off of a scareling.']).length,
    0,
    'and neither is an enchanter`s mez'
  )
})

test('JOS-161 B4: the whole suggested set, on the reporter`s own cast-and-land pair', () => {
  // The shape a bard actually ends up with after clicking through the wizard. `landsOnOther` is
  // the shared capture template and rides along on the same sentence, which is honest: one line,
  // one family, and it says which mob.
  const defs = suggestionsFor(entryFor("solon's bewitching bravura")).map((s) => s.def)
  const fired = fire(defs, [BARD.bravuraCast, BARD.bravuraLanded, BARD.bravuraBroke])
  assert.deepEqual(
    new Set(fired.map((f) => f.alertId)),
    new Set([
      "suggest:solon's bewitching bravura:lands",
      "suggest:solon's bewitching bravura:landsOnOther",
      // …`:charmBreaks` since JOS-200, where it used to be `:breaks`. The LANDING pair above is
      // unchanged and stays a `cc` apply on purpose: `<mob>'s eyes glaze over.` is shared verbatim
      // with three real mez songs and nothing in the line separates them, so the app still cannot
      // tell whose hold just landed — only, from the break line, whose hold just ended.
      "suggest:solon's bewitching bravura:charmBreaks"
    ])
  )
  const named = fired.find((f) => f.alertId === "suggest:solon's bewitching bravura:landsOnOther")
  assert.deepEqual(named?.captures, { player: 'a fire giant warrior' })
})

test('JOS-161 B5: `breaks` is offered for the crowd-control roster and nobody else', () => {
  // The template flag is a CLAIM the alert can fire (shared/alertGroups.ts's law). A spell the
  // parser's `ccSpell` roster does not match parses its wear-off to `buffFade`, where this
  // trigger never sees it — so an offer there would be a guessed trigger that never fires.
  for (const key of ['mesmerization', 'ensnare', "largo's assonant binding", "kelin's lucid lullaby"]) {
    assert.ok(entryFor(key).templates.breaks, `${key} is crowd control`)
  }
  // `allure` stays on this list — it is a CHARM, so `breaks` (a `cc` trigger) still cannot fire for
  // it. What changed in JOS-200 is that it now gets `charmBreaks` instead of nothing (B2b).
  for (const key of ['clarity', 'shiftless deeds', 'allure', 'drifting death']) {
    assert.equal(entryFor(key).templates.breaks, false, `${key} is not a mez or a root`)
  }
})

test('JOS-200 B5b: `charmBreaks` is offered for the charm roster and nobody else', () => {
  // The mirror of B5, and the same law: the flag is a CLAIM the alert can fire. A spell
  // `charmSpell` does not match parses its wear-off to `cc` or `buffFade`, where an `uncharm`
  // trigger never sees it.
  for (const key of ['allure', 'charm', 'dictate', 'enslave death', "solon's bewitching bravura"]) {
    assert.ok(entryFor(key).templates.charmBreaks, `${key} is a charm`)
  }
  for (const key of ['clarity', 'shiftless deeds', 'mesmerization', "sionachie's dreams"]) {
    assert.equal(entryFor(key).templates.charmBreaks, false, `${key} is not a charm`)
  }
})

test('JOS-84 A7: the reporter\'s cast+land pair fires the cast and the landing alerts', () => {
  // End to end on the slice's own two-line sequence, with the full suggested set installed —
  // the shape a user actually ends up with after clicking through the wizard.
  const defs = suggestedDefs('incapacitate', 'Incapacitate V')
  const fired = fire(defs, [SLICE.incapCast, SLICE.incapLanded])
  // THREE since JOS-103, and the third is the point of that ticket rather than a regression: the
  // capture template is not Puma-specific, so `Someone looks frail.` also authors a raw trigger
  // that names WHO it landed on. The debuff user hears "Incapacitate on Coercer T`vala" instead
  // of a bare sound — on the same reporter line that started JOS-84.
  assert.deepEqual(new Set(fired.map((f) => f.alertId)), new Set([
    'suggest:incapacitate:castRank:incapacitate-v',
    'suggest:incapacitate:lands',
    'suggest:incapacitate:landsOnOther'
  ]))
  const named = fired.find((f) => f.alertId === 'suggest:incapacitate:landsOnOther')
  assert.deepEqual(named?.captures, { player: 'Coercer T`vala' }, 'the backtick name survives the class')
})
