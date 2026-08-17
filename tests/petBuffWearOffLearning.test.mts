// CHARACTERIZATION — `Your pet's <S> spell has worn off.` AND THE 15:00 THAT WOULD NOT MOVE
// (JOS-212). Read this before changing anything about pet fades or the estimator: the ticket's
// working theory is REFUTED here, by replay, and the real mechanism is pinned below.
//
// ─────────────────────────────────────────────────────────────────────────────
// THE REPORT (01KZRANV6CFHVF5ZD2AEZHHX3S, app 0.20.0): the buff overlay draws 15:00 for Shield of
// Fire while the spell really runs about 6:42.
//
// THE THEORY IN THE TICKET: pet-suffixed wear-off lines never match the player's cast, so duration
// learning never overrides the registry's 15:00.
//
// WHAT THE REPORTER'S OWN SLICE ACTUALLY DOES, replayed through this parser and this module
// (the slice itself never enters git — AGENTS.md — so the window below is SYNTHESIZED to the same
// grammar, with the names changed and the one thing that must not change kept: the spell, whose
// committed DB row is the whole point):
//
//   13:38:04  `<Pet> told you, 'Attacking <mob> Master.'`   binds the pet (petClaim, via tell)
//   13:41:47  `You begin casting Shield of Fire.`           the anchor for the PET cast
//   13:41:49  `<Pet> is enveloped by flame.`                the landing, NAMING the pet
//   13:41:51  `You begin casting Shield of Fire.`           the anchor for the SELF cast
//   13:41:53  `You are enveloped by flame.`                 the landing on you
//   13:48:37  `Your pet's Shield of Fire spell has worn off.`   408 s after the pet landing
//   13:48:39  `The flames die down.`                            406 s after the self landing
//
// THE PET WEAR-OFF MATCHES, AND IT ALWAYS DID. `classifyWornOff` emits
// `buffFade { spell, target: 'pet' }`; `PetEntities.fadeTargetEntity('pet')` resolves the
// possessive against the CURRENT pet entity — which that `… Master.'` tell bound three minutes
// earlier — and `BuffInstances.recordFade` pairs it with the open record the named landing opened.
// The replay mints 408 s. Nothing is missed and nothing is refused.
//
// WHAT KEEPS THE BAR AT 15:00 IS THE DB FLOOR. `SpellStats.estimateFor` is
// `max(DB baseline, recent-window observed max)` and the committed spells.json states 15 Min for
// Shield of Fire, so a 408 s observation loses to a 900 000 ms floor and the estimate reports
// `source: 'db'`. That floor is JOS-117 ruling 6 and it rests on ONE stated assumption — *a
// beneficial buff's true duration is never below its DB base, because AA and focus only EXTEND* —
// which is exactly what a classic-EQ scrape describing a re-tiered EverQuest Legends spell breaks.
// It is JOS-126's disease (the DB row is not this game's number) in the other direction.
//
// AND THE THEORY'S OWN CASE DOES NOT PRODUCE THE SYMPTOM EITHER. The last case below removes the
// binding tell, which is the world the theory describes: the possessive then resolves to the
// literal `'pet'` key, matches no open record and mints nothing — a real gap, and one AGENTS.md
// already names (the buffs model's entity succession still waits for the tell; closing it needs a
// derived-event seam, not a second arm in buffs.ts). Even so the SELF wear-off still mints its
// 406 s and the estimate is still 900 000 / 'db'. So the pet-matching question cannot be the cause
// of what the reporter sees, in either world.
//
// ─────────────────────────────────────────────────────────────────────────────
// HOW BIG THE BELOW-FLOOR POPULATION IS — MEASURED on the owner's whole log, 1,593,491 lines,
// 2026-08-11, folded through this same module. 66 (line, caster) rows carry clean samples and all
// 66 have a DB row. 46 of them observe AT OR ABOVE the floor, so the learner already wins there
// and nothing about them is in question. TWENTY sit below it, and the floor is what the app draws
// for every one:
//
//   spell (n clean)              DB floor   top 3 clean samples      top-3 spread   max vs floor
//   Quickness (60)                 11:00    6:54, 6:26, 6:09             12.2%          -37.3%
//   Charm (52)                     16:00    7:05, 6:49, 6:34              7.9%          -55.7%
//   Feedback (37)                  15:00    14:51, 14:45, 14:40           1.3%           -1.0%
//   Cajoling Whispers (27)         16:00    14:43, 14:25, 14:23           2.3%           -8.0%
//   Improved Invisibility (27)     10:00    6:40, 5:49, 5:09             29.4%          -33.3%
//   Invisibility Vs Undead (25)    27:00    9:02, 3:31, 3:19            172.4%          -66.5%
//   Celerity (24)                  16:00    15:01, 14:59, 14:58           0.3%           -6.1%
//   Languid Pace (21)               2:30    1:17, 1:11, 1:08             13.2%          -48.7%
//   Invisibility (20)              20:00    4:24, 2:13, 1:41            161.4%          -78.0%
//   Alacrity (19)                  11:00    7:05, 6:58, 6:56              2.2%          -35.6%
//   Beguile (18)                   16:00    9:53, 9:29, 9:12              7.4%          -38.2%
//   Tashina (9)                    11:00    5:04, 4:43, 4:40              8.6%          -53.9%
//   …plus eight rows at n<=3 (Negation of Life, Lull, Tepid Deeds, Shield of Thistles, Shield of
//   Barbs, Spirit of Bih`Li, Root, Rune IV).
//
// TWO SHAPES LIVE IN THAT LIST, AND THEY ARE DISTINGUISHABLE. Invisibility — the floor law's own
// worked counterexample — SCATTERS (4:24, 2:13, 1:41; 161% across the top three), which is what a
// buff clicked off at whatever moment you happened to need it looks like. Alacrity CLUSTERS
// (7:05, 6:58, 6:56; 2.2%), which is what a timer running out looks like, and its 7:05 against an
// 11:00 row is the same disease as JOS-126: the committed scrape is classic-EQ data and this game
// re-tiered the spell. Shield of Fire in the report is the clustered shape at n=2 (408 s, 406 s;
// 0.5%).
//
// HOW IT WAS DECIDED (owner ruling 2026-08-12, built in the same ticket). A tight below-floor
// cluster MAY overrule the floor: at least three clean cycles whose top three agree within 10%
// (`corroboratedMax`, buffsShapes.ts; the population above is the measurement the two numbers come
// from, and tests/buffOverlayDuration.test.mts drives every row of it). The scattered shapes keep
// their floor, Invisibility included.
//
// SO THE REPORTER'S WINDOW IS ONE CYCLE SHORT OF THE EVIDENCE BAR, and that is not a defect: two
// agreeing cycles are also what two identical click-offs look like. The last two cases below pin
// both halves of that — n=2 still draws the 15:00 floor, and the moment a third clean cast of the
// same shape lands the bar becomes the 6:48 the log measured, labelled 'cluster'. Self-healing by
// design, in the owner's words.

import test from 'node:test'
import assert from 'node:assert/strict'
import { parseEvent } from '../src/main/log/parser.ts'
import { installSpellDb } from '../src/main/log/rulesets.ts'
import { loadSpellDb } from '../src/main/data/spellDb.ts'
import { BuffsModule } from '../src/main/modules/buffs.ts'
import { SELF_CASTER } from '../src/shared/buffTrust.ts'
import type { LogEvent } from '../src/shared/logEvents.ts'

const SPELL_KEY = 'shield of fire'
/** The committed spells.json row for Shield of Fire: 15 Min. The number the reporter sees. */
const DB_MS = 900_000

/** The synthesized window, in the log's own grammar. Names changed; the spell cannot be. */
const PET = 'Gyxaz'
const MOB = 'a rock golem'
const BIND = `[Wed Aug 05 21:00:00 2026] ${PET} told you, 'Attacking ${MOB} Master.'`
const WINDOW: readonly string[] = [
  BIND,
  '[Wed Aug 05 21:04:07 2026] You begin casting Shield of Fire.',
  `[Wed Aug 05 21:04:09 2026] ${PET} is enveloped by flame.`,
  '[Wed Aug 05 21:04:11 2026] You begin casting Shield of Fire.',
  '[Wed Aug 05 21:04:13 2026] You are enveloped by flame.',
  "[Wed Aug 05 21:10:57 2026] Your pet's Shield of Fire spell has worn off.",
  '[Wed Aug 05 21:10:59 2026] The flames die down.'
]
/** The pet landing → pet wear-off span, and the self landing → self wear-off span. */
const PET_SPAN_MS = 408_000
const SELF_SPAN_MS = 406_000

/** Replay `lines` through the real parser into a real DB-backed buffs module. */
function replay(lines: readonly string[]): BuffsModule {
  const db = loadSpellDb()
  installSpellDb(db)
  const mod = new BuffsModule(db)
  mod.reset()
  let seq = 0
  for (const line of lines) {
    const ev = parseEvent(line, seq++)
    if (ev) mod.onEvent(ev as LogEvent)
  }
  return mod
}

/** The clean sample spans (ms) this replay minted for (line, caster). */
function samples(mod: BuffsModule, key = SPELL_KEY, caster = SELF_CASTER): number[] {
  return (mod.spellStats().samples.get(`${key}|${caster}`)?.samples ?? []).map((s) => s.ms)
}

test('the possessive wear-off is a targetless buffFade carrying target: pet', () => {
  const ev = parseEvent(WINDOW[5], 0)
  assert.ok(ev)
  assert.equal(ev.kind, 'buffFade')
  assert.equal(ev.kind === 'buffFade' ? ev.spell : null, 'Shield of Fire')
  assert.equal(ev.kind === 'buffFade' ? ev.target : null, 'pet')
})

test("a bound pet's wear-off mints its own duration sample — the theory is refuted", () => {
  const got = samples(replay(WINDOW))
  // BOTH halves of the cycle are learned: the pet's 408 s and your own 406 s, in log order.
  assert.deepEqual(got, [PET_SPAN_MS, SELF_SPAN_MS])
})

test('every sample is CLEAN — nothing on this path is censored', () => {
  const s = replay(WINDOW).spellStats().samples.get(`${SPELL_KEY}|${SELF_CASTER}`)
  assert.ok(s)
  assert.deepEqual(
    s.samples.map((x) => x.censored ?? false),
    [false, false]
  )
})

test('at n=2 the estimate STILL reads 15:00 from the DB floor — the reported symptom', () => {
  const stats = replay(WINDOW).spellStats()
  // The learner did its job: the observed max is the real duration, to the second — and it is a
  // measured CYCLE, not a lower bound (`bound: false`; JOS-379 gave the window's answer that second
  // field so a death bound cannot be mistaken for an observation).
  assert.deepEqual(stats.observedWindowMaxFor(SPELL_KEY, SELF_CASTER), { ms: PET_SPAN_MS, bound: false })
  // …and loses to the floor, which is what the overlay draws. TWO agreeing cycles are below the
  // evidence bar the owner set (JOS-212), and two identical click-offs look exactly like this.
  assert.deepEqual(stats.estimateFor(SPELL_KEY, SELF_CASTER), { ms: DB_MS, source: 'db' })
})

test('a THIRD clean cast of the same shape flips it — the bar becomes the 6:48 the log measured', () => {
  // A re-buff later in the same session — one more cycle of the same shape, and the third clean
  // sample. Nothing about the mechanism changes; only the count of measurements agreeing with each
  // other. (It stays inside the session on purpose: a 24-hour jump is a log hole, and JOS-134's
  // unexplained-hole rule would drop the open cast before its wear-off could be paired.)
  const AGAIN: readonly string[] = [
    '[Wed Aug 05 21:20:07 2026] You begin casting Shield of Fire.',
    `[Wed Aug 05 21:20:09 2026] ${PET} is enveloped by flame.`,
    "[Wed Aug 05 21:26:56 2026] Your pet's Shield of Fire spell has worn off."
  ]
  const mod = replay([...WINDOW, ...AGAIN])
  assert.deepEqual(samples(mod), [PET_SPAN_MS, SELF_SPAN_MS, 407_000], 'three clean cycles, 408/406/407 s')

  const est = mod.spellStats().estimateFor(SPELL_KEY, SELF_CASTER)
  assert.deepEqual(est, { ms: PET_SPAN_MS, source: 'cluster' }, '6:48 from the log, not 15:00 from the wiki')
  assert.ok(est.ms != null && est.ms < DB_MS, 'and it is BELOW the floor, which is the whole ruling')
})

test('with NO binding tell the pet fade mints nothing — and the symptom is unchanged', () => {
  // The world the ticket's theory describes: `fadeTargetEntity('pet')` falls back to the literal
  // 'pet' key, which matches no open record. A real gap — and not this report's mechanism.
  const mod = replay(WINDOW.slice(1))
  assert.deepEqual(samples(mod), [SELF_SPAN_MS])
  assert.deepEqual(mod.spellStats().estimateFor(SPELL_KEY, SELF_CASTER), { ms: DB_MS, source: 'db' })
})
