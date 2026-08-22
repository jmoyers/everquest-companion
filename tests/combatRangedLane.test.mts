// THE RANGED LANE (JOS-92) — the third of the "the damage was counted, the ROW could not exist"
// family, after JOS-77 (Cleave) and JOS-81 (Smite), and the one whose justification is DIFFERENT.
//
// THE REPORT, a ranger's: "Could you Split Ranged (bow) into another field separate from Melee?
// I would love to see DPS differences between my dual wield melees and my bow more easily and
// really compare those numbers within a fight as stance switching Ranger/Ranged stance uses bow
// in melee. currently that is lumped into the same bar as melee."
//
// He is right about the symptom and the damage was never missing. `shoot` has been in
// MELEE_VERBS since the missing-verbs fix, so every bow point was counted; `meleeSkill('shoot')`
// answered "Melee", so bow hits folded into the anonymous weapon lane beside slash/pierce/crush
// and no Ranged row could exist. One branch in meleeSkill() gives it the row.
//
// ── WHY THIS IS NOT THE SMITE ARGUMENT, SAID OUT LOUD ────────────────────────────────────────
//
// JOS-81 settled "skill or weapon?" with the SKILL-UP STREAM: a weapon verb never ticks under
// its own name (slash → `1H Slashing` 365, crush → `1H Blunt` 248, pierce → `1H Piercing` 410,
// punch → `Hand to Hand` 282), while `Smite` ticks 280 times under `Smite`.
//
// RUN THAT TEST ON `shoot` AND IT FAILS. There is no `better at Shoot!` line anywhere; `shoot`
// ticks under `Archery`, and `Archery` sits in the WEAPON-TYPE family beside 1H Slashing and
// Hand to Hand — precisely where a weapon verb ticks. By JOS-81's test alone, `shoot` belongs in
// the generic row and this ticket should have been refused. Borrowing the smite argument here
// would have been a lie, so it is not borrowed.
//
// WHAT THE LANE ACTUALLY RESTS ON is the clause JOS-77 already wrote and never needed: the four
// generic verbs share one row because they "are what a weapon IN A HAND prints, and four of them
// are ONE auto-attack lane". A bow is not in that lane — different equipment slot, different
// skill, and none of the hand lane's multipliers touch it (Dual Wield 322 skill-ups, Double
// Attack 395, Triple Attack 100, every one of them about swings from hands). The game names the
// mode itself, in the reporter's words and its own: `You assume a ranged stance.` — which is
// where the lane takes its LABEL from, rather than from a skill table.
//
// So the rule gains a narrow second clause: a weapon verb fired from a DIFFERENT SLOT than the
// hands is not the hand lane. `shoot` is the only verb in MELEE_VERBS that qualifies, and no
// thrown lane is invented beside it — `You throw` is ZERO whole-log, ` throws ` is ZERO,
// `Throwing` occurs only inside item names, and no `better at Throwing!` tick exists (R4).
//
// ── THE EVIDENCE, AND THE HOLE IN IT THAT IS STATED RATHER THAN PAPERED OVER ─────────────────
//
// THE OWNER HAS NEVER FIRED A BOW. Whole-log sweep of eqlog_Primitive_freeport.txt (1,438,942
// lines) plus both halas logs plus all 103 committed fixtures:
//   `You shoot`                        ZERO      `You try to shoot`                 ZERO
//   `You throw` / ` throws `           ZERO      `(Double Bow Shot)`                ZERO
//   `You have become better at Archery!`  ONCE — the rarest skill in the file, tied with
//                                        Forage and Pick Lock. `You assume a ranged stance.` ×2.
// What the log DOES carry is other people's archery: NINE `<Player> shoots <mob> for N point(s)
// of damage.` lines and EIGHT `<X> tries to shoot <mob>, but …` avoided ones. Those are real
// bytes and they are what W57/W58 pin. The DISCRIMINATOR question is answered by them and it is
// the whole point of the design: the line is shape-identical to a melee hit
// (`<A> shoots <B> for N point(s) of damage.`) and the only trailing annotation the family has
// ever carried is `(Critical)`. Nothing in the message names a bow, an arrow, a stance or a
// class — so the VERB is the entire discriminator, which is exactly what a stance-switching
// ranger needs (a class- or stance-keyed split would mis-assign both halves of his fight).
//
// THE SELF ARM IS INJECTED, and that is the honest name for it. Because the owner has never
// shot, no committed fixture can contain `You shoot`, and a reporter's slice never becomes a
// fixture (AGENTS.md). So the last test injects it — the petClaimWindows / mobLifetapPlayer /
// W52 precedent — built from the ATTESTED third-person template with the attacker conjugated to
// first person and the amounts taken verbatim from the owner's own log's bow hits (60 Critical,
// 15, 1). Nothing about that conjugation is special-cased in the code: MELEE_RE is
// person-agnostic, `meleeVerbBase` maps `shoots` and `shoot` to one base, and `meleeSkill` has
// ONE branch — so both persons traverse identical code and R1 proves it on real bytes.
//
// LAW 8. The gate is unusually strong here and unusually easy to pass, and both halves are
// worth saying. Every committed fixture was replayed before and after — per-segment out/in,
// per (source, category), per (source, lane) and the per-category drill, 1,591 rows — and the
// two dumps are BYTE-IDENTICAL. Not one figure moved, because there is no self `shoot` line in
// the tree to move one. The lane's real behaviour is therefore proven by the injection test,
// which asserts the movement is exact: Ranged appears with the injected points, `you|Melee`
// does not budge, and the melee category grows by exactly what was injected and no more.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { parseEvent } from '../src/main/log/parser'
import { meleeSkill, meleeVerbBase } from '../src/main/log/parseCombat'
import { CombatEngine } from '../src/main/combat/engine'
import { roundConfidence } from '../src/main/combat/rounds'
import { SpecialAttacks, laneOfSpecial } from '../src/main/combat/specialAttacks'
import type { SourceView } from '../src/shared/combat'

// ── the parser half ───────────────────────────────────────────────────────────────────────

test('R1: every conjugation of shoot lands on ONE verb and ONE lane', () => {
  const dmg = (text: string) => {
    const ev = parseEvent(`[Mon Aug 03 16:06:59 2026] ${text}`, 0)
    assert.ok(ev, `did not parse: ${text}`)
    assert.equal(ev.kind, 'damage', text)
    if (ev.kind !== 'damage') throw new Error('unreachable')
    return ev
  }
  // THIRD PERSON, VERBATIM from the owner's log (and from w57-ranged-lane.log line 62). This is
  // the arm the game has actually printed for him, so it is asserted first.
  const other = dmg('Sinzar shoots a wanderer for 15 points of damage.')
  assert.equal(other.verb, 'shoot')
  assert.equal(other.skill, 'Ranged')
  assert.equal(other.dtype, 'melee')
  assert.equal(other.amount, 15)
  // THE SINGULAR ARM — `for 1 point of damage.`, not `points`. Verbatim (w57 line 49). Two of
  // the log's nine bow hits are 1-pointers, so this is not a curiosity: the `points?` optional
  // is load-bearing and a bow hit is the shape most likely to exercise it.
  const one = dmg('Sinzar shoots a wanderer for 1 point of damage.')
  assert.equal(one.skill, 'Ranged')
  assert.equal(one.amount, 1)
  // THE CRITICAL ARM — verbatim from w58-ranged-critical.log line 72. `(Critical)` is the ONLY
  // annotation any bow line in the file carries; there is no `(Double Bow Shot)` to parse.
  const crit = dmg('Brakk shoots a gloomwater mermaid for 60 points of damage. (Critical)')
  assert.equal(crit.skill, 'Ranged')
  assert.equal(crit.crit, true)
  assert.equal(crit.amount, 60)
  // FIRST PERSON — the shape NO log in this tree has printed (the owner has never fired a bow),
  // conjugated from the attested template above. It needs no code of its own: `shoots` and
  // `shoot` un-conjugate to one base and meleeSkill has one branch, which is what makes the
  // conjugation safe to assert rather than a guess about grammar.
  const self = dmg('You shoot a wanderer for 15 points of damage.')
  assert.equal(self.verb, 'shoot')
  assert.equal(self.skill, 'Ranged')
  assert.equal(self.attacker, 'You')
  // `shoots` → `shoot` is the plain `-s` rule, confirmed against the base set.
  assert.equal(meleeVerbBase('shoots'), 'shoot')
  assert.equal(meleeVerbBase('Shoots'), 'shoot')
  assert.equal(meleeVerbBase('shoot'), 'shoot')
})

test('R2: an AVOIDED shot lanes exactly like a landed one', () => {
  // The first is VERBATIM from w57-ranged-lane.log (line 87); the second is verbatim from the
  // owner's OTHER real log, eqlog_Primitive_halas.txt — `An aqua goblin tries to shoot Dutun,
  // but misses!` — and it matters because it proves the attacker side is not player-shaped: a
  // MOB shoots too, so nothing here may assume a bow means a player. The last two are the same
  // family's other outcomes with this window's mob.
  //
  // The aggregation lane for a miss stays 'Melee' by design (routing.ts missFold — that is the
  // shipped accuracy lane and law 8 keeps it still); what must agree with the landed shot is the
  // VERB, which is what the round grouper and the miss's `laneSkill` are built on.
  for (const text of [
    'Sinzar tries to shoot a wanderer, but a wanderer dodges!',
    'An aqua goblin tries to shoot Dutun, but misses!',
    'You try to shoot a wanderer, but miss!',
    'A wanderer tries to shoot YOU, but YOU block!'
  ]) {
    const ev = parseEvent(`[Mon Aug 03 16:07:05 2026] ${text}`, 0)
    assert.ok(ev, `did not parse: ${text}`)
    assert.equal(ev.kind, 'miss', text)
    if (ev.kind !== 'miss') throw new Error('unreachable')
    assert.equal(ev.verb, 'shoot', text)
    assert.equal(meleeSkill(ev.verb ?? ''), 'Ranged', text)
  }
})

test('R3: the ranged split is a SLOT rule over one verb, and it moves no other verb', () => {
  assert.equal(meleeSkill('shoot'), 'Ranged')
  assert.equal(meleeSkill('shoots'), 'Ranged')
  assert.equal(meleeSkill('Shoots'), 'Ranged')
  // Every named class skill keeps the row it already had — this change is additive to the table.
  assert.equal(meleeSkill('backstab'), 'Backstab')
  assert.equal(meleeSkill('bash'), 'Bash')
  assert.equal(meleeSkill('kick'), 'Kick')
  assert.equal(meleeSkill('cleave'), 'Cleave')
  assert.equal(meleeSkill('smite'), 'Smite')
  assert.equal(meleeSkill('frenzy'), 'Frenzy')
  assert.equal(meleeSkill('flurry'), 'Flurry')
  // `strike` also left, in JOS-163, and on a THIRD argument again — neither this slot rule nor
  // JOS-77's class-skill test. It is the generic verb every monk special prints as, so it earns
  // an anonymous row named after the verb itself.
  assert.equal(meleeSkill('strike'), 'Strike')
  assert.equal(meleeSkill('strikes'), 'Strike')
  // …and every verb a weapon IN A HAND prints stays in the one auto-attack lane. `shoot` leaving
  // is a slot rule, not a licence to promote big-damage verbs: `slice` remains the trap.
  for (const v of ['slash', 'pierce', 'crush', 'hit', 'slice', 'claw', 'punch', 'reave', 'gore',
    'maul', 'sting', 'rend', 'smash', 'gnaw', 'lash', 'bite', 'slam']) {
    assert.equal(meleeSkill(v), 'Melee', v)
  }
})

test('R4: no THROWN lane is invented beside the bow, and ranged claims no special-attack lane', () => {
  // THE REFUSAL (the awaiting-sample law). Throwing is the obvious "while I am in here" lane and
  // the log refuses it outright: `You throw` is ZERO whole-log, ` throws ` is ZERO, `Throwing`
  // appears only inside item names (`Throwing Boulder` ×143, `Throwing Knife` ×4) and there is no
  // `better at Throwing!` tick. There is no verb to route, so no branch is written — a lane the
  // log has never demonstrated is not written from grammar.
  assert.equal(meleeSkill('throw'), 'Melee')
  assert.equal(meleeSkill('throws'), 'Melee')
  // …and `throw` is not even a parsed melee verb, so such a line would not reach a lane at all.
  const thrown = parseEvent('[Mon Aug 03 16:06:59 2026] You throw a wanderer for 15 points of damage.', 0)
  assert.equal(thrown?.kind === 'damage' ? thrown.dtype : undefined, undefined,
    'no thrown damage family is claimed — the log has never printed one')

  // SPECIAL-ATTACK LANE: a special earns a lane only when it prints NO verb of its own
  // (specialAttacks.ts — a Dragon Punch lands as `You strike`). A bow prints `shoot`, and no
  // `You will now use <X> instead of <Y>` line has ever named an archery upgrade in any log
  // seen, so the verb owns no chain to track. `(Double Bow Shot)` — the annotation AGENTS.md
  // listed as unobserved — is still unobserved, so nothing is parsed for it either.
  assert.equal(laneOfSpecial('Ranged'), undefined)
  assert.equal(laneOfSpecial('Archery'), undefined)
  assert.equal(new SpecialAttacks().laneSkill('shoot'), undefined)
  // REUSE TIMER: nothing states one for archery, so its multi-swing reading keeps the honest
  // `aggregate` tier every weapon verb has rather than joining backstab/bash/kick in the
  // confident one. Naming a timer here would be the guess rounds.ts refuses.
  assert.equal(roundConfidence('shoot'), 'aggregate')
})

// ── the golden windows ────────────────────────────────────────────────────────────────────

// Fixtures are COMMITTED (`.gitignore` negates `tests/fixtures/*.log`) — regenerate with
// `npm run fixtures:combat -- <path to eqlog_Primitive_freeport.txt>`. Both windows below were
// cut for this ticket (tests/extract-combat-fixtures.mjs W57/W58) because no existing fixture
// contained a single bow line: ` shoots ` was ZERO across all 101 of them.
const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), 'fixtures')
function load(name: string): string[] {
  const p = join(FIXTURES, name)
  return existsSync(p) ? readFileSync(p, 'utf8').split(/\r?\n/).filter((l) => l.length > 0) : []
}
const W57 = load('w57-ranged-lane.log')
const W58 = load('w58-ranged-critical.log')
const SKIP57 = W57.length === 0 && 'fixture not present'
const SKIP58 = W58.length === 0 && 'fixture not present'

interface Lane {
  total: number
  hits: number
}

/**
 * Replay a window and roll damage up per (source kind, skill lane), per (source kind, category)
 * and per (source kind, category, skill lane) — summed over EVERY fight in it. Same rollup the
 * cleave and smite windows use, so the three lane goldens read alike.
 */
function laneRollup(lines: string[]): {
  skills: Map<string, Lane>
  categories: Map<string, number>
  catSkills: Map<string, Lane>
  outTotal: number
  inTotal: number
} {
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
  const catSkills = new Map<string, Lane>()
  let outTotal = 0
  let inTotal = 0
  const add = (m: Map<string, Lane>, key: string, total: number, hits: number): void => {
    const prev = m.get(key) ?? { total: 0, hits: 0 }
    m.set(key, { total: prev.total + total, hits: prev.hits + hits })
  }
  const foldSource = (src: SourceView): void => {
    for (const k of src.skills) add(skills, `${src.kind}|${k.name}`, k.total, k.hits)
    for (const c of src.categories) {
      categories.set(`${src.kind}|${c.category}`, (categories.get(`${src.kind}|${c.category}`) ?? 0) + c.total)
      for (const k of c.skills) add(catSkills, `${src.kind}|${c.category}|${k.name}`, k.total, k.hits)
    }
  }
  for (const seg of eng.snapshot(at, { maxSegments: 100_000 }).segments) {
    if (seg.kind === 'zone') continue
    const view = eng.snapshot(at, { selectedId: seg.id }).selected
    if (!view) continue
    outTotal += view.outTotal
    inTotal += view.inTotal
    for (const src of [...view.entities, ...view.incoming]) foldSource(src)
  }
  return { skills, categories, catSkills, outTotal, inTotal }
}

function lane(skills: Map<string, Lane>, key: string, total: number, hits: number): void {
  assert.deepEqual(skills.get(key), { total, hits }, `lane "${key}"`)
}

/**
 * Insert lines into a window IN TIME ORDER, stably — never `[...window, ...extra].sort()`, which
 * reorders lines that share a second. Lifted from combatCleaveLane.test.mts, where a plain sort
 * demoted a pet-claim tell below the swings it had to bind (JOS-49).
 */
function mergeByTime(window: string[], extra: string[]): string[] {
  const stamp = (l: string): string => l.slice(1, 25)
  const out = [...window]
  for (const e of extra) {
    const at = out.findIndex((l) => stamp(l) > stamp(e))
    if (at < 0) out.push(e)
    else out.splice(at, 0, e)
  }
  return out
}

test('R5: the real bow lines in the committed fixtures each lane Ranged', { skip: SKIP57 || SKIP58 }, () => {
  // Read the arrow-hit lines OUT OF THE FIXTURES rather than retyping them, so the assertion can
  // never drift from the committed bytes. Four lines across the two windows: three landed shots
  // (1 / 15 / 60-critical) and one avoided.
  const bowLines = [...W57, ...W58].filter((l) => / shoots | tries to shoot /.test(l))
  assert.equal(bowLines.length, 4, 'the two windows carry exactly four bow lines')
  let landed = 0
  let avoided = 0
  let points = 0
  for (const raw of bowLines) {
    const ev = parseEvent(raw, 0)
    assert.ok(ev, `did not parse: ${raw}`)
    if (ev.kind === 'damage') {
      assert.equal(ev.verb, 'shoot', raw)
      assert.equal(ev.skill, 'Ranged', raw)
      assert.equal(ev.dtype, 'melee', raw)
      landed++
      points += ev.amount
    } else if (ev.kind === 'miss') {
      assert.equal(ev.verb, 'shoot', raw)
      assert.equal(meleeSkill(ev.verb ?? ''), 'Ranged', raw)
      avoided++
    } else {
      assert.fail(`a bow line parsed as ${ev.kind}: ${raw}`)
    }
  }
  assert.equal(landed, 3)
  assert.equal(avoided, 1)
  assert.equal(points, 76, '1 + 15 + 60')
})

test('W57: the stranger\'s bow gets a row of its own, and none of YOUR lanes move', { skip: SKIP57 }, () => {
  // THE POINT OF THIS WINDOW, AND THE ONE CLAIM JOS-430 REVERSED. Sinzar lands two bow hits and
  // whiffs a third while the owner is deep in his own fight with Commander Yarik. Sinzar is not
  // the owner, not his pet and not a rostered group member (no group line names him anywhere in
  // the log), so `classify()` used to return 'ignore' and his damage never reached an aggregate.
  //
  // The owner's 2026-08-20 ruling says the opposite: Everyone means ANY fight the log can see, so
  // an archer shooting a mob beside you is a row. He is `other` — the log named him, and nothing
  // claims him — and his damage lands under `Ranged`, the lane JOS-92 built for exactly this line.
  //
  // WHAT DID NOT MOVE IS THE WHOLE REST OF THE TEST, and that is the law-8 tripwire: every one of
  // the owner's own lanes and category totals below is the same figure it was before either change.
  const { skills, categories, catSkills, outTotal } = laneRollup(W57)
  assert.equal(skills.has('you|Ranged'), false, 'you did not shoot — no lane is invented')
  assert.equal(skills.has('pet|Ranged'), false)
  assert.equal(skills.has('enemy|Ranged'), false)
  assert.equal(skills.has('member|Ranged'), false, 'Sinzar is not a rostered member')
  // …he is a combatant the log named, so his two landed shots (15 + 1) are his own row's Ranged lane.
  lane(skills, 'other|Ranged', 16, 2)

  // EVERY FIGURE BELOW IS THE PRE-CHANGE VALUE, taken from the whole-fixture law-8 dump. The
  // owner's Commander Yarik fight: seven lanes, none of which may move by a point.
  lane(skills, 'you|Melee', 934, 16)
  lane(skills, 'you|Backstab', 189, 2)
  lane(skills, 'you|Bash', 66, 3)
  lane(skills, 'you|Frenzy', 106, 4)
  lane(skills, 'you|Kick', 54, 2)
  lane(skills, 'you|Smite', 65, 2)
  // The two CAST-LESS spell lanes carry JOS-167's origin marker; the amounts are the same
  // pre-change values. Blood Siphon Strike is a DoT (see the `you|dot` category below), which
  // the detector never judges, so its lane name is untouched.
  lane(skills, 'you|Smiting Strike · proc', 260, 2)
  lane(skills, 'you|Blood Siphon Strike', 94, 2)
  lane(skills, 'you|Condemnation of Nife · proc', 486, 2)
  lane(skills, 'enemy|Melee', 417, 5)
  lane(skills, 'enemy|Bash', 102, 3)

  // LAW 8 TRIPWIRE — the CATEGORY totals, and Σ lanes must equal them.
  // melee: 934 + 189 + 66 + 106 + 54 + 65 = 1,414.
  assert.equal(categories.get('you|melee'), 1414)
  assert.equal(categories.get('you|spell'), 746)
  assert.equal(categories.get('you|dot'), 94)
  assert.equal(categories.get('enemy|melee'), 519)
  // OUT-TOTAL, BEFORE AND AFTER, said as arithmetic rather than as one frozen integer: 2,254 was
  // the pre-JOS-430 figure AND it is exactly the sum of the owner's own three categories, because
  // his rows were the only rows there were. The segment total now also carries the 653 the archers
  // in the same zone dealt to their own mobs — which is the ruling, visible as a number.
  assert.equal(1414 + 746 + 94, 2254, 'your own rows still sum to the whole of the old total')
  assert.equal(outTotal, 2907, '…and the segment now also holds 653 of other people\'s')
  const sum = (names: string[]): number =>
    names.reduce((n, k) => n + (catSkills.get(`you|melee|${k}`)?.total ?? 0), 0)
  assert.equal(sum(['Melee', 'Backstab', 'Bash', 'Frenzy', 'Kick', 'Smite', 'Ranged']), 1414)
})

test('W58: a CRITICAL bow shot beside the owner\'s own pull, and his numbers are untouched', { skip: SKIP58 }, () => {
  // `Brakk shoots a gloomwater mermaid for 60 points of damage. (Critical)` at 16:09:52, while
  // the owner slays two gloomstalker mermaids around it. Same rule as W57 — Brakk is a stranger,
  // so since JOS-430 the crit lands on a row of his own rather than on the floor, and the CRIT
  // FLAG rides with it: a recorded row's crit rate is its own, derived from the same fields yours
  // is. The owner's numbers below are the pre-change figures, to the point.
  const { skills, categories, outTotal, inTotal } = laneRollup(W58)
  assert.equal(skills.has('you|Ranged'), false)
  assert.equal(skills.has('member|Ranged'), false)
  lane(skills, 'other|Ranged', 60, 1) // Brakk's critical bow shot, on Brakk's own row
  // 2,633 over 17 hits since JOS-163: the 4 `You strike` swings that used to be inside this
  // number (257 damage, hand-tallied off the fixture) moved to their own neutral row. This window
  // carries no `You will now use` line, so the verb earns the row and nothing names it. The melee
  // CATEGORY total below is unchanged, which is what the law-8 dump this test was built from says.
  lane(skills, 'you|Melee', 2633, 17)
  lane(skills, 'you|Strike', 257, 4)
  lane(skills, 'you|Bash', 160, 1)
  lane(skills, 'you|Kick', 92, 1)
  lane(skills, 'enemy|Melee', 170, 4)
  lane(skills, 'enemy|thorns', 138, 23)
  assert.equal(categories.get('you|melee'), 3142)
  assert.equal(categories.get('enemy|ds'), 138)
  // Same before/after arithmetic as W57: 3,142 was the whole segment when your rows were the only
  // rows, and it still is the whole of YOURS; the other 398 belongs to the people around you.
  assert.equal(outTotal, 3540, 'you 3,142 + 398 recorded for everyone else in the zone')
  assert.equal(inTotal, 313, 'and the INCOMING meter is untouched — it is still only what hits YOU')
})

test('W57 + THE INJECTED SELF ARM: your bow gets its own bar beside melee, and moves no other number', { skip: SKIP57 }, () => {
  // THE INJECTION, stated plainly. The owner has never fired a bow — `You shoot` is ZERO in
  // 1,438,942 lines — so there is no self arm to cut, and the reporter's slice may never become
  // a fixture (AGENTS.md). These four sentences are the ATTESTED third-person template with the
  // attacker conjugated to first person and the mob renamed to the one this window is really
  // fighting; the AMOUNTS are not invented either — 60 (Critical), 15 and 1 are, verbatim, the
  // damage figures of real bow hits in the owner's own log (Brakk 60 crit, Sinzar 15, Sinzar 1).
  //
  // This is the test that actually answers the ranger. His fight has both weapons in it, so the
  // window is deliberately one where the owner is swinging hard: the assertion is not merely
  // "Ranged exists" but "Ranged appeared and Melee did not change", which is the comparison he
  // asked for.
  const INJECTED = [
    '[Mon Aug 03 16:07:03 2026] You shoot Commander Yarik for 15 points of damage.',
    '[Mon Aug 03 16:07:03 2026] You try to shoot Commander Yarik, but miss!',
    '[Mon Aug 03 16:07:06 2026] You shoot Commander Yarik for 60 points of damage. (Critical)',
    '[Mon Aug 03 16:07:06 2026] You shoot Commander Yarik for 1 point of damage.'
  ]
  const base = laneRollup(W57)
  const withBow = laneRollup(mergeByTime(W57, INJECTED))

  // THE ROW THE RANGER CANNOT SEE TODAY: 15 + 60 + 1 = 76 over three hits.
  lane(withBow.skills, 'you|Ranged', 76, 3)
  // …and it is a MELEE-category lane, sitting beside the generic one rather than in a category
  // of its own. The bow's damage type is what the log says it is (`points of damage`, no
  // element), so no category boundary is crossed and no category total is invented.
  lane(withBow.catSkills, 'you|melee|Ranged', 76, 3)

  // IT CAME OUT OF NOWHERE ELSE. The generic lane is byte-identical — the bow hits were never in
  // it in THIS window (the owner never shot here), so this asserts the injection is clean rather
  // than that a reallocation happened. On the ranger's own log the movement is the other way and
  // the mechanism is the same one lane function.
  lane(withBow.skills, 'you|Melee', base.skills.get('you|Melee')!.total, base.skills.get('you|Melee')!.hits)
  lane(withBow.skills, 'you|Smite', 65, 2)
  lane(withBow.skills, 'you|Backstab', 189, 2)
  // The melee CATEGORY grows by exactly the injected 76 — no more, no less — and so does the
  // outgoing total. This is the law-8 arithmetic in its active form.
  assert.equal(withBow.categories.get('you|melee'), (base.categories.get('you|melee') ?? 0) + 76)
  assert.equal(withBow.outTotal, base.outTotal + 76)
  // The spell and dot lanes, the mobs, and everything coming the other way are bystanders.
  assert.equal(withBow.categories.get('you|spell'), base.categories.get('you|spell'))
  assert.equal(withBow.categories.get('you|dot'), base.categories.get('you|dot'))
  assert.equal(withBow.categories.get('enemy|melee'), base.categories.get('enemy|melee'))
  assert.equal(withBow.inTotal, base.inTotal)
  // The MISSED shot lands where every avoided swing lands (routing.ts missFold keeps the
  // accuracy lane at 'Melee'), so it adds no damage and no hits to either row.
  assert.equal(withBow.skills.get('you|Ranged')?.hits, 3, 'the whiff is not a hit')
})
