// SPECIAL-ATTACK LANES — golden windows for user report 01KZ9AAQ4ES1R2NVYK0JJ68EBQ,
// "Dragon Punch DPS isn't tracked" (monk).
//
// THE REPORT WAS RIGHT, AND THE DAMAGE WAS NEVER MISSING. EQ Legends' upgraded special attacks
// print NO verb of their own: a Dragon Punch, an Eagle Strike and a Tiger Claw all land as
// `You strike <mob> for N points of damage.`, so `meleeSkill('strike')` answered "Melee" and
// every one of those hits folded into the anonymous melee lane. The total was always right; the
// ROW could not exist. The game states the switch exactly once, in a line nothing parsed:
//
//   [Wed Jul 29 14:54:14 2026] You will now use Dragon Punch instead of Eagle Strike while attacking.
//
// THE FIX is stateful attribution — parse that line, track the live special per VERB LANE, and
// name the lane at ingest. src/main/combat/specialAttacks.ts carries the full-log sweep behind
// the lane table (and, just as importantly, behind the Bash/Slam lane it REFUSES to claim).
//
// LAW 8. This is a LABELING change and nothing else. The whole-log regression gate (2,464
// segments, 25,820,575 points of outgoing damage) came out byte-identical before and after —
// same per-segment totals, same per-source totals, same per-CATEGORY totals; only the per-skill
// names moved, with Σ skills inside each category conserved. Every window below re-asserts that
// locally: the category totals are the tripwire, the lane names are the feature.
//
// THE THREE WINDOWS (tests/extract-combat-fixtures.mjs; hand-read line by line, and every
// number below was tallied off the raw fixture text before it was compared to the engine):
//
//   w46  Tue Jul 28 22:06–22:10, Guk. `Eagle Strike instead of Tiger Claw` at 22:07:16.
//        strike hits: 10 before it (102 damage) → "Melee"; 7 after (89) → "Eagle Strike".
//   w47  Wed Jul 29 14:53–14:58, the ghoul knights. `Dragon Punch instead of Eagle Strike`
//        at 14:54:14. strike hits: 6 before (77) → "Melee"; 6 after (128) → "Dragon Punch".
//   w48  Sun Aug 02 01:55–02:03, the loadout swap. Six state lines in nine seconds, of which
//        `Kick while auto attacking.` RESETS the kick lane off Flying Kick and
//        `Slam instead of Bash` is the one the evidence refuses.
//
// WHY "BEFORE THE STATE LINE" IS "Strike" — AND WHY IT IS NEITHER "Melee" NOR "Tiger Claw"
// (JOS-163; this comment used to say "Melee" and the assertions used to pin it).
//
// None of these windows contains the state line that established its lane (Tiger Claw's grant is
// 6 hours before w46), and the model still never seeds a lane from the table — so "Tiger Claw" is
// as wrong as it ever was. What CHANGED is the floor those unnamed strikes fall to. `meleeSkill()`
// now has a `strike` branch, so an unclaimed strike lands in its own neutral "Strike" lane instead
// of being poured into the anonymous weapon pool beside slash/crush/hit.
//
// THE OLD ANSWER WAS HONEST BUT IT WAS ALSO WRONG, and a monk on 0.16.0 is what proved it. Saying
// "Melee" claims a strike is an ordinary weapon swing, and this file's own header says it is not:
// `strike` is EXCLUSIVE to the special-attack chain (the owner's first-ever `You strike` is three
// seconds after his Tiger Claw grant; unarmed autos print hit/claw/punch). Worse, the omission was
// not temporary for everyone. The state line prints ONCE, at the level-up, so a player whose log
// file BEGINS after it — fresh install, log rotation, `/log on` switched on later — never has it,
// and every strike he ever throws read "Melee" forever while his kicks read "Kick". "A full replay
// from the top of the log sees the grant" is true of the owner's log and false of that monk's.
//
// SO THE TWO FACTS ARE NOW SEPARATE, which is the whole shape of the fix: the VERB earns the row
// (Strike), and the STATE LINE earns the name (Eagle Strike / Dragon Punch / Tail Rake). W46 and
// W47 below assert both halves in one window each — the strikes before the line are "Strike", the
// strikes after it are the named special — and the category tripwires prove not one point moved
// between them.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { parseEvent } from '../src/main/log/parser'
import { CombatEngine } from '../src/main/combat/engine'
import { SpecialAttacks, laneOfSpecial, specialLaneVerbs } from '../src/main/combat/specialAttacks'
import type { SpecialAttackEvent } from '../src/shared/logEvents'

// ── the parser half ───────────────────────────────────────────────────────────────────────

/** Parse one line and assert it came back as a `specialAttack` event (narrowing helper). */
function special(text: string): SpecialAttackEvent {
  const ev = parseEvent(`[Wed Jul 29 14:54:14 2026] ${text}`, 0)
  assert.ok(ev, `line did not parse at all: ${text}`)
  assert.equal(ev.kind, 'specialAttack', `expected a specialAttack event for: ${text}`)
  if (ev.kind !== 'specialAttack') throw new Error('unreachable')
  return ev
}

test('parser: BOTH real shapes of the state line, verbatim from the log', () => {
  // The replacement form — the one the user's report is about.
  const dp = special('You will now use Dragon Punch instead of Eagle Strike while attacking.')
  assert.equal(dp.skill, 'Dragon Punch')
  assert.equal(dp.replaces, 'Eagle Strike')
  assert.equal(dp.autoAttack, false)
  // Multi-word names on BOTH sides of "instead of" must survive the lazy captures.
  const fk = special('You will now use Flying Kick instead of Round Kick while attacking.')
  assert.equal(fk.skill, 'Flying Kick')
  assert.equal(fk.replaces, 'Round Kick')
  // The bare GRANT form: no `replaces`, and the `auto` qualifier is the discriminator.
  const tc = special('You will now use Tiger Claw while auto attacking.')
  assert.equal(tc.skill, 'Tiger Claw')
  assert.equal(tc.replaces, undefined)
  assert.equal(tc.autoAttack, true)
  // Every one of the 21 real lines in the log is one of these two shapes; the sixth from the
  // Aug 02 burst is included because a single-word skill exercises the same captures.
  assert.equal(special('You will now use Smite while auto attacking.').skill, 'Smite')
})

test('parser: the rule claims ONLY this family', () => {
  // Neighbouring `You will now …` phrasing that is not the family (no such line exists in the
  // log today; the rule must decline it rather than invent a skill).
  for (const t of [
    'You will now use your primary weapon.',
    'You will now use Dragon Punch while defending.',
    'You will now use  while auto attacking.'
  ]) {
    const ev = parseEvent(`[Wed Jul 29 14:54:14 2026] ${t}`, 0)
    assert.ok(ev)
    assert.notEqual(ev.kind, 'specialAttack', `must not claim: ${t}`)
  }
})

test('parser: melee damage now carries its un-conjugated verb; nothing else does', () => {
  const dmg = (text: string) => {
    const ev = parseEvent(`[Wed Jul 29 15:05:14 2026] ${text}`, 0)
    assert.ok(ev)
    assert.equal(ev.kind, 'damage')
    if (ev.kind !== 'damage') throw new Error('unreachable')
    return ev
  }
  // First and third person, base and conjugated, land on the same base verb.
  assert.equal(dmg('You strike a frenzied ghoul for 32 points of damage.').verb, 'strike')
  assert.equal(dmg('A wan ghoul knight strikes a frenzied ghoul for 56 points of damage.').verb, 'strike')
  assert.equal(dmg('You kick a frenzied ghoul for 13 points of damage.').verb, 'kick')
  assert.equal(dmg('A wan ghoul knight kicks a frenzied ghoul for 32 points of damage.').verb, 'kick')
  // The un-conjugation traps: `-es` on a sibilant vs a bare `-s` on a word that ends in `e`.
  assert.equal(dmg('A zol ghoul knight crushes YOU for 56 points of damage.').verb, 'crush')
  assert.equal(dmg('A zol ghoul knight slices YOU for 5 points of damage.').verb, 'slice')
  assert.equal(dmg('A zol ghoul knight gores YOU for 5 points of damage.').verb, 'gore')
  assert.equal(dmg('A zol ghoul knight bashes YOU for 5 points of damage.').verb, 'bash')
  assert.equal(dmg('You frenzy on a rambunctious pet for 6 points of damage.').verb, 'frenzy')
  // …and the skill name it derives is the VERB's own lane, with no state line anywhere in sight.
  // "Strike" rather than "Melee" since JOS-163 (see the header); "Kick" as it always was.
  assert.equal(dmg('You strike a frenzied ghoul for 32 points of damage.').skill, 'Strike')
  assert.equal(dmg('You kick a frenzied ghoul for 13 points of damage.').skill, 'Kick')
  // Person-agnostic, exactly like the kick lane beside it: this function has never known who swung.
  assert.equal(dmg('A wan ghoul knight strikes a frenzied ghoul for 56 points of damage.').skill, 'Strike')
  // Non-melee families carry no verb — the field is melee-only by construction.
  assert.equal(dmg('You hit a zol ghoul knight for 88 points of magic damage by Smiting Strike.').verb, undefined)
  assert.equal(dmg('A zol ghoul knight is burned by YOUR flames for 11 points of non-melee damage.').verb, undefined)
})

// ── the state model, in isolation ─────────────────────────────────────────────────────────

test('SpecialAttacks: only the verified lanes are claimed, and nothing is guessed', () => {
  const sp = new SpecialAttacks()
  // Cold: every lane is silent, so the parser's own skill name stands everywhere.
  assert.equal(sp.laneSkill('strike'), undefined)
  assert.equal(sp.laneSkill('kick'), undefined)
  assert.equal(sp.laneSkill(undefined), undefined)

  const set = (skill: string, replaces?: string): string | undefined =>
    sp.note({ kind: 'specialAttack', seq: 0, ts: 0, raw: '', skill, autoAttack: replaces === undefined, ...(replaces ? { replaces } : {}) })

  assert.equal(set('Tiger Claw'), 'strike')
  assert.equal(sp.laneSkill('strike'), 'Tiger Claw')
  assert.equal(sp.laneSkill('kick'), undefined, 'one lane speaking must not seed another')

  assert.equal(set('Dragon Punch', 'Eagle Strike'), 'strike')
  assert.equal(sp.laneSkill('strike'), 'Dragon Punch', 'the newest statement wins')

  // A bare grant RESETS a lane — this is the Aug 02 `Kick while auto attacking.` case, and it
  // is why `replaces` is never used to infer anything.
  assert.equal(set('Flying Kick', 'Round Kick'), 'kick')
  assert.equal(sp.laneSkill('kick'), 'Flying Kick')
  assert.equal(set('Kick'), 'kick')
  assert.equal(sp.laneSkill('kick'), 'Kick')

  // THE LANES THAT ARE DELIBERATELY NOT CLAIMED. Smite/Backstab/Frenzy print their own verb and
  // need no attribution; Slam is the one the evidence refuses (185 `better at Bash!` ticks fire
  // during Slam eras, and `better at Slam!` does not exist in 1.35M lines).
  for (const s of ['Smite', 'Backstab', 'Frenzy', 'Slam', 'Bash']) {
    assert.equal(set(s), undefined, `${s} must claim no lane`)
    assert.equal(laneOfSpecial(s), undefined)
  }
  assert.equal(sp.laneSkill('bash'), undefined, 'the bash lane is never labelled')
  assert.equal(sp.laneSkill('slam'), undefined)

  sp.reset()
  assert.deepEqual(sp.entries(), [])
})

test('SpecialAttacks: every lane verb is a verb the melee parser can actually emit', () => {
  // The tripwire against drift between the lane table and MELEE_VERBS: a lane keyed on a verb
  // no damage line ever prints would be silently dead. Each lane verb is fed through the real
  // parser in a real sentence and must come back as that verb.
  for (const verb of specialLaneVerbs()) {
    const ev = parseEvent(`[Wed Jul 29 15:05:14 2026] You ${verb} a frenzied ghoul for 7 points of damage.`, 0)
    assert.ok(ev, `lane verb "${verb}" produced no event`)
    assert.equal(ev.kind, 'damage', `lane verb "${verb}" is not a melee verb`)
    if (ev.kind !== 'damage') throw new Error('unreachable')
    assert.equal(ev.verb, verb, `lane verb "${verb}" did not round-trip`)
  }
})

// ── the golden windows ────────────────────────────────────────────────────────────────────

// Fixtures are COMMITTED (`.gitignore` negates `tests/fixtures/*.log`) — regenerate with
// `npm run fixtures:combat -- <path to eqlog_Primitive_freeport.txt>`.
const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), 'fixtures')
function load(name: string): string[] {
  const p = join(FIXTURES, name)
  return existsSync(p) ? readFileSync(p, 'utf8').split(/\r?\n/).filter((l) => l.length > 0) : []
}
const W46 = load('w46-special-eagle-strike.log')
const W47 = load('w47-special-dragon-punch.log')
const W48 = load('w48-special-lane-reset.log')
const SKIP46 = W46.length === 0 && 'fixture not present'
const SKIP47 = W47.length === 0 && 'fixture not present'
const SKIP48 = W48.length === 0 && 'fixture not present'

/** One lane row of YOUR outgoing damage. */
interface Lane {
  total: number
  hits: number
}

/**
 * Replay a window and roll YOUR outgoing damage up per skill lane and per category, summed over
 * EVERY fight in the window.
 *
 * Fights, not the zone aggregate, because w48 crosses three zone lines and a zone change resets
 * `zoneAgg` — summing the (uncapped) fight history is the only way to see the whole window. Each
 * point of damage belongs to exactly one fight, so nothing is double-counted.
 */
function laneRollup(lines: string[]): { skills: Map<string, Lane>; categories: Map<string, number>; outTotal: number } {
  const eng = new CombatEngine()
  eng.setPlayerName('Primitive')
  let seq = 0
  let lastTs = 0
  for (const raw of lines) {
    const ev = parseEvent(raw, seq++)
    if (!ev) continue
    eng.ingestEvent(ev, false)
    lastTs = ev.ts
  }
  const at = lastTs + 600_000
  const skills = new Map<string, Lane>()
  const categories = new Map<string, number>()
  let outTotal = 0
  for (const seg of eng.snapshot(at, { maxSegments: 100_000 }).segments) {
    if (seg.kind === 'zone') continue
    const view = eng.snapshot(at, { selectedId: seg.id }).selected
    if (!view) continue
    outTotal += view.outTotal
    for (const src of view.entities) {
      if (src.kind !== 'you') continue
      for (const k of src.skills) {
        const prev = skills.get(k.name) ?? { total: 0, hits: 0 }
        skills.set(k.name, { total: prev.total + k.total, hits: prev.hits + k.hits })
      }
      for (const c of src.categories) categories.set(c.category, (categories.get(c.category) ?? 0) + c.total)
    }
  }
  return { skills, categories, outTotal }
}

/** Assert a lane exists with exactly these numbers. */
function lane(skills: Map<string, Lane>, name: string, total: number, hits: number): void {
  assert.deepEqual(skills.get(name), { total, hits }, `lane "${name}"`)
}

test('W46: the Eagle Strike era — strikes before the state line lane as Strike, after it are named', { skip: SKIP46 }, () => {
  const { skills, categories } = laneRollup(W46)
  // HAND-TALLIED off the fixture: 7 `You strike … for N` lines after 22:07:16, summing to 89.
  lane(skills, 'Eagle Strike', 89, 7)
  // …and the 10 BEFORE it (102 damage) now have a row of their own rather than disappearing into
  // the weapon pool (JOS-163). Hand-tallied the same way: the fixture's 17 self strikes total 191,
  // which is exactly 102 + 89, so the state line splits the verb's swings and creates none.
  lane(skills, 'Strike', 102, 10)
  assert.equal((skills.get('Strike')?.total ?? 0) + 89, 191, 'every self strike in the window is in one of the two rows')
  // The generic lane is now ONLY what a weapon in a hand printed — crush/slash/hit — and it no
  // longer carries a single strike.
  const melee = skills.get('Melee')
  assert.ok(melee && melee.total > 0, 'the weapon swings still have their generic lane')
  // Smite left that lane in JOS-81: 9 swings for 157, hand-tallied off the fixture.
  lane(skills, 'Smite', 157, 9)
  // THE KICK LANE IS UNTOUCHED. Round Kick was live for the whole window but its state line is
  // hours outside it, so the model must NOT reach into the table and name the lane.
  lane(skills, 'Kick', 292, 25)
  assert.equal(skills.has('Round Kick'), false, 'a lane the window never heard about is never named')
  assert.equal(skills.has('Tiger Claw'), false, 'the displaced special is never resurrected')
  lane(skills, 'Bash', 36, 18)
  // LAW 8 TRIPWIRE: the category totals are what must not move. Σ melee skills == melee total.
  const meleeSkills = ['Melee', 'Strike', 'Eagle Strike', 'Kick', 'Bash', 'Smite']
    .reduce((n, k) => n + (skills.get(k)?.total ?? 0), 0)
  assert.equal(meleeSkills, categories.get('melee'), 'Σ melee lanes == the melee category total')
  assert.equal(categories.get('melee'), 2105)
  assert.equal(categories.get('spell'), 1724)
})

test('W47: THE REPORTED BUG — Dragon Punch gets its own row, and moves not one point of damage', { skip: SKIP47 }, () => {
  const { skills, categories, outTotal } = laneRollup(W47)
  // HAND-TALLIED off the fixture: the 6 `You strike …` lines after 14:54:14 are
  // 1 + 30 (Critical) + 20 + 1 + 28 + 48 = 128. This row did not exist before this feature.
  lane(skills, 'Dragon Punch', 128, 6)
  // The 6 Eagle-Strike-era hits before the line (14+14+15+10+12+12 = 77) are NOT called Eagle
  // Strike — this window never heard that statement, and the model is never seeded from the table.
  // They land in the neutral "Strike" row instead of the weapon pool (JOS-163): the verb is what
  // earns the row, the state line is what puts a name on it, and 77 + 128 = 205 is every self
  // strike in the fixture.
  assert.equal(skills.has('Eagle Strike'), false)
  lane(skills, 'Strike', 77, 6)
  const melee = skills.get('Melee')
  assert.ok(melee && melee.total > 0, 'the weapon swings still have their generic lane')
  lane(skills, 'Kick', 122, 11)
  lane(skills, 'Bash', 26, 14)
  // LAW 8: the melee + slay category totals are exactly what the pre-change engine produced.
  // (A Dragon Punch that rides a Slay Undead proc is categorized 'slay' like any other slay
  // swing — the lane rename crosses no category boundary.)
  assert.equal(categories.get('melee'), 2297)
  assert.equal(categories.get('slay'), 659)
  assert.equal(categories.get('spell'), 2586)
  assert.equal(categories.get('ds'), 374)
  assert.equal(outTotal, 8733, 'total outgoing damage across the window is untouched')
})

test('W48: a bare grant RESETS a lane — Flying Kick primed, kicks come out "Kick"', { skip: SKIP48 }, () => {
  // PRIMING (AGENTS.md: priming fixtures warm learned state the way a full replay would). The
  // Flying Kick statement is real and verbatim from Wed Jul 29 21:28:03 — four days before this
  // window — so without the reset every kick below would be labelled "Flying Kick".
  const PRIME = '[Wed Jul 29 21:28:03 2026] You will now use Flying Kick instead of Round Kick while attacking.'
  const primed = laneRollup([PRIME, ...W48])
  // The Aug 02 burst's `Kick while auto attacking.` put the lane back. The log agrees on its own
  // terms: `You have become better at Kick!` ticks 21→30 fire inside this very window, and no
  // Flying Kick tick does.
  lane(primed.skills, 'Kick', 124, 20)
  assert.equal(primed.skills.has('Flying Kick'), false, 'the grant reset the lane')

  // …and the proof that the reset is what did it: replayed WITHOUT the priming line the rollup
  // is identical, because a reset lane and a never-set lane are the same state.
  const cold = laneRollup(W48)
  assert.deepEqual([...cold.skills.entries()].sort(), [...primed.skills.entries()].sort())
})

test('W48: Slam does NOT claim the bash lane — the refused inference stays refused', { skip: SKIP48 }, () => {
  const { skills, categories } = laneRollup(W48)
  // `You will now use Slam instead of Bash while attacking.` is line 5 of this fixture, and 25
  // bash swings land after it (74 damage). They stay "Bash": Bash skill-ups keep firing during
  // Slam eras log-wide (185 of them) and `You have become better at Slam!` appears zero times,
  // so relabelling them would be a guess the evidence contradicts. See specialAttacks.ts.
  lane(skills, 'Bash', 74, 25)
  assert.equal(skills.has('Slam'), false)
  // The other three grants in the burst name specials that print their OWN verb, so they need no
  // attribution and must be left exactly as the parser named them.
  lane(skills, 'Backstab', 762, 12)
  lane(skills, 'Frenzy', 485, 18)
  // SMITE HAS ITS OWN ROW NOW (JOS-81, flipped from the documented-absence assertion this test
  // used to carry). The nine `You smite …` lines in this window — 24+19+19+28+24+24+26+29+13,
  // hand-tallied off the fixture — used to be inside the generic Melee row; the grant three
  // lines up (`You will now use Smite while auto attacking.`) is not what named them, and that
  // is the point: Smite prints its OWN verb, so `meleeSkill('smite')` names the lane and
  // specialAttacks.ts still claims nothing (see the Smite/Backstab/Frenzy refusal above).
  lane(skills, 'Smite', 206, 9)
  // …and not one point moved between categories: the melee total is exactly what this test
  // asserted before the lane existed.
  assert.equal(categories.get('melee'), 5926)
  assert.equal(categories.get('slay'), 318)
  assert.equal(categories.get('spell'), 417)
})

test('W48: the lane survives zoning — three zone lines, one uninterrupted lane', { skip: SKIP48 }, () => {
  // The window crosses West Commonlands → Befallen → Befallen 4 (Refined). A special is chosen
  // once, not per zone, so the kick swings on the far side of all three zone lines must still be
  // laned by the state line from 01:55:09 — which is what the single 124/20 "Kick" row shows.
  const zones = W48.filter((l) => l.includes('You have entered '))
  assert.equal(zones.length, 3, 'the window really does cross three zones')
  const { skills } = laneRollup(W48)
  lane(skills, 'Kick', 124, 20)
})
