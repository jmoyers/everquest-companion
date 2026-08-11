// THE CLEAVE LANE — golden window for user report 01KZCZ3BYRQRD4JQJ0PW7FQRG5 (JOS-77),
// "The combat parser does not appear to capture cleave. Or at a minimum it's not split out
// like Frenzy, Bash and Kick are."
//
// THE REPORT WAS RIGHT ABOUT THE SYMPTOM AND THE DAMAGE WAS NEVER MISSING — the same shape as
// the Dragon Punch report, one lane over. `cleave` has been in MELEE_VERBS since the
// missing-verbs fix (AGENTS.md: smite/cleave once hid 22% of all damage), so every point was
// counted; `meleeSkill('cleave')` answered "Melee", so it folded into the anonymous weapon lane
// beside slash/pierce/crush and the ROW could not exist. Measured on the reporter's own
// 30-minute slice: 171 self cleave hits worth 11,256 points, invisible inside a 87,154-point
// "Melee" row, while his Frenzy / Bash / Kick each had a row of their own.
//
// WHY CLEAVE IS A SKILL AND NOT A DAMAGE TIER OF SOME WEAPON VERB. This is the whole question —
// splitting a weapon's high-damage message into its own row would be a lie about one lane, not
// a new lane. Two measurements answer it:
//   1. `Cleave` is a WAR-only skill granted at level 5 in the scraped class table
//      (src/main/data/classes.json) — the same evidence class that earns Backstab (ROG),
//      Bash (PAL/SHD/WAR), Kick (BST/MNK/RNG/WAR) and Frenzy (BER) their rows today.
//   2. The OWNER's log — 1,404,458 lines, 71,104 `You slash` hits reaching 2,100 damage and
//      11,232 `You crush` — contains ZERO `You cleave` lines, while carrying 20,334 INCOMING
//      cleaves from mobs. A verb that never prints for a player who lacks the skill, however
//      hard he swings, is gated on the skill and not on the damage.
//
// LAW 8. This is a LABELING change and nothing else. Whole-log regression gate (the owner's
// real log, 2,722 fight segments, 27,895,079 points outgoing / 5,177,314 incoming): per-segment
// totals, per-source totals and per-CATEGORY totals all byte-identical before and after. Only
// per-skill names moved, with Σ skills inside each category conserved. The same gate on the
// reporter's slice: 24 segments, 192,502 out / 34,380 in, byte-identical, with
// `you|Melee 87,154/1,679 → 75,898/1,508` and a new `you|Cleave 11,256/171` — the difference
// is exact.
//
// THE FIXTURE, AND THE ONE LINE THAT IS INJECTED. A REPORTER'S SLICE NEVER BECOMES A FIXTURE
// (AGENTS.md), so the window is the OWNER's real bytes: `tests/fixtures/w52-cleave-lane.log`,
// Wed Aug 05 17:05:51 → 17:08:03, his charmed pet `a gust of wind` cleaving and two essence
// mobs cleaving HIM. His log has no self cleave to cut, so the third arm — YOUR OWN cleave — is
// INJECTED as a parsed line in the last test below, quoted in shape from the report's slice
// with the mob's name swapped for one this window is actually fighting. That is the
// petClaimWindows / mobLifetapPlayer precedent, and it is stated here rather than hidden.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { parseEvent } from '../src/main/log/parser'
import { meleeSkill, meleeVerbBase } from '../src/main/log/parseCombat'
import { CombatEngine } from '../src/main/combat/engine'
import { roundConfidence } from '../src/main/combat/rounds'
import { laneOfSpecial } from '../src/main/combat/specialAttacks'

// ── the parser half ───────────────────────────────────────────────────────────────────────

test('C1: every conjugation of cleave lands on ONE verb and ONE lane', () => {
  // First person and third person, landed. Both shapes are verbatim in form from the report's
  // slice ("You cleave an elemental warrior for 75 points of damage." / "A ratman warrior
  // cleaves YOU for 19 points of damage.") with this window's mobs substituted.
  const dmg = (text: string) => {
    const ev = parseEvent(`[Wed Aug 05 17:06:08 2026] ${text}`, 0)
    assert.ok(ev, `did not parse: ${text}`)
    assert.equal(ev.kind, 'damage', text)
    if (ev.kind !== 'damage') throw new Error('unreachable')
    return ev
  }
  const self = dmg('You cleave an essence carrier for 75 points of damage.')
  assert.equal(self.verb, 'cleave')
  assert.equal(self.skill, 'Cleave')
  assert.equal(self.amount, 75)
  const mob = dmg('An essence carrier cleaves YOU for 19 points of damage.')
  assert.equal(mob.verb, 'cleave')
  assert.equal(mob.skill, 'Cleave')
  // A modifier rides the same line without disturbing the lane.
  const crit = dmg('You cleave an essence carrier for 106 points of damage. (Critical)')
  assert.equal(crit.skill, 'Cleave')
  assert.equal(crit.crit, true)
  // `cleaves` un-conjugates to `cleave` — the `-es`-on-a-word-ending-in-e trap.
  assert.equal(meleeVerbBase('cleaves'), 'cleave')
  assert.equal(meleeVerbBase('Cleaves'), 'cleave')
})

test('C2: an AVOIDED cleave lanes exactly like a landed one', () => {
  // All four avoided shapes the report's slice prints, mobs substituted. The aggregation lane
  // for a miss stays 'Melee' by design (routing.ts missFold — that is the shipped accuracy
  // lane); what must agree with the landed swing is the VERB, which is what the round grouper
  // and the miss's `laneSkill` are built on.
  for (const text of [
    'You try to cleave an essence carrier, but miss!',
    'You try to cleave an essence carrier, but an essence carrier dodges!',
    'An essence carrier tries to cleave YOU, but misses!',
    'An essence carrier tries to cleave YOU, but YOU block!'
  ]) {
    const ev = parseEvent(`[Wed Aug 05 17:06:08 2026] ${text}`, 0)
    assert.ok(ev, `did not parse: ${text}`)
    assert.equal(ev.kind, 'miss', text)
    if (ev.kind !== 'miss') throw new Error('unreachable')
    assert.equal(ev.verb, 'cleave', text)
    assert.equal(meleeSkill(ev.verb ?? ''), 'Cleave', text)
  }
})

test('C3: the split is a NAMED-SKILL table, not a matcher over verb spelling', () => {
  // Each of these is a skill in the scraped class table, so each earns a row.
  assert.equal(meleeSkill('backstab'), 'Backstab')
  assert.equal(meleeSkill('bash'), 'Bash')
  assert.equal(meleeSkill('kick'), 'Kick')
  assert.equal(meleeSkill('cleave'), 'Cleave')
  assert.equal(meleeSkill('frenzy'), 'Frenzy')
  assert.equal(meleeSkill('flurry'), 'Flurry')
  // `smite` (PAL) joined them in JOS-81 — cleave's twin, and the gap this test used to pin as
  // deliberate. tests/combatSmiteLane.test.mts carries its evidence.
  assert.equal(meleeSkill('smite'), 'Smite')
  // `strike` joined them in JOS-163 on a DIFFERENT argument — it is not a class skill, it is the
  // generic verb every monk special prints as, so the row it earns is the anonymous "Strike"
  // rather than a name from the chain. tests/specialAttackWindows.test.mts carries its evidence.
  assert.equal(meleeSkill('strike'), 'Strike')
  // …and everything a WEAPON prints stays in the one auto-attack lane. `slice` is the trap a
  // "big damage message" heuristic would fall into.
  for (const v of ['slash', 'pierce', 'crush', 'hit', 'slice', 'claw', 'punch', 'reave', 'gore']) {
    assert.equal(meleeSkill(v), 'Melee', v)
  }
})

test('C4: cleave claims NO special-attack lane and NO reuse-timer confidence', () => {
  // The awaiting-sample law. `You will now use <X> instead of <Y>` has never named a cleave
  // upgrade in any log seen, so the verb owns no special lane; and nothing states a cleave
  // reuse timer, so its multi-swing reading keeps the honest `aggregate` tier that every
  // weapon verb has. Naming a lane here would be exactly the guess specialAttacks.ts refuses
  // for Slam.
  assert.equal(laneOfSpecial('Cleave'), undefined)
  assert.equal(roundConfidence('cleave'), 'aggregate')
})

// ── the golden window ─────────────────────────────────────────────────────────────────────

// Fixtures are COMMITTED (`.gitignore` negates `tests/fixtures/*.log`) — regenerate with
// `npm run fixtures:combat -- <path to eqlog_Primitive_freeport.txt>`.
const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), 'fixtures')
const W52 = existsSync(join(FIXTURES, 'w52-cleave-lane.log'))
  ? readFileSync(join(FIXTURES, 'w52-cleave-lane.log'), 'utf8').split(/\r?\n/).filter((l) => l.length > 0)
  : []
const SKIP52 = W52.length === 0 && 'fixture not present'

interface Lane {
  total: number
  hits: number
}

/**
 * Replay a window and roll damage up per (source kind, skill lane) and per (source kind,
 * category), summed over EVERY fight in it — the specialAttackWindows rollup, widened to the
 * incoming side because two of this report's three arms are not yours.
 */
function laneRollup(lines: string[]): {
  skills: Map<string, Lane>
  categories: Map<string, number>
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
  let outTotal = 0
  let inTotal = 0
  for (const seg of eng.snapshot(at, { maxSegments: 100_000 }).segments) {
    if (seg.kind === 'zone') continue
    const view = eng.snapshot(at, { selectedId: seg.id }).selected
    if (!view) continue
    outTotal += view.outTotal
    inTotal += view.inTotal
    for (const src of [...view.entities, ...view.incoming]) {
      for (const k of src.skills) {
        const key = `${src.kind}|${k.name}`
        const prev = skills.get(key) ?? { total: 0, hits: 0 }
        skills.set(key, { total: prev.total + k.total, hits: prev.hits + k.hits })
      }
      for (const c of src.categories) {
        categories.set(`${src.kind}|${c.category}`, (categories.get(`${src.kind}|${c.category}`) ?? 0) + c.total)
      }
    }
  }
  return { skills, categories, outTotal, inTotal }
}

function lane(skills: Map<string, Lane>, key: string, total: number, hits: number): void {
  assert.deepEqual(skills.get(key), { total, hits }, `lane "${key}"`)
}

/**
 * Insert lines into a window IN TIME ORDER, stably — never `[...window, ...extra].sort()`.
 * A plain sort reorders lines that share a second, and this window's very first line is the
 * pet-claim tell: sorting drops `A gust of wind told you, …` below the pet's own 17:05:51
 * swings, a tell binds FORWARD only (JOS-49), and 218 points of pet damage silently stop being
 * the pet's. Measured while writing this test — which is the law working, not an aside.
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

test('W52: THE REPORTED BUG — a pet cleave and an incoming cleave each get their own row', { skip: SKIP52 }, () => {
  const { skills, categories } = laneRollup(W52)

  // HAND-TALLIED off the fixture text before the engine was ever asked: `A gust of wind`
  // lands 14 cleaves for 2,243 points (and whiffs 7 more). Before this change every one of
  // them was inside the pet's "Melee" row.
  lane(skills, 'pet|Cleave', 2243, 14)
  // The incoming arm: an essence carrier and an essence tamer land 8 cleaves for 609 (6 more
  // avoided). A mob's lanes split by the same rule — nothing here is self-only.
  lane(skills, 'enemy|Cleave', 609, 8)
  // YOUR row does not exist: this is the owner's log and he has never had the skill.
  assert.equal(skills.has('you|Cleave'), false, 'a lane is never invented for a verb the window never printed')

  // The rest of the pet's swings stay where they were — the split takes cleave OUT of Melee
  // and touches nothing else. slash 7,055 + crush 4,830 = 11,885 in the generic lane.
  lane(skills, 'pet|Melee', 11885, 77)
  lane(skills, 'pet|Bash', 414, 9)
  lane(skills, 'pet|Kick', 322, 6)
  // Yours: slash 2,316 + claw 1,817 = 4,133. The 340 points of `strike` that used to be inside
  // this number left for the neutral "Strike" lane when JOS-163 landed (16 hits, hand-tallied off
  // the fixture) — this window carries no state line, so the verb earns the row and nothing names
  // it. The 150 points of smite left the same way when JOS-81 landed. The melee CATEGORY total
  // below is unchanged through all of it, which is the whole claim.
  lane(skills, 'you|Melee', 4133, 60)
  lane(skills, 'you|Strike', 340, 16)
  lane(skills, 'you|Smite', 150, 8)
  lane(skills, 'you|Bash', 375, 9)
  lane(skills, 'you|Kick', 602, 9)

  // LAW 8 TRIPWIRE — the CATEGORY totals are what may not move, and Σ lanes must equal them.
  // Hand-tallied: you 5,600 melee, pet 14,864, enemy 2,149. No Slay Undead fires in this
  // window, so every melee point stays in the melee category.
  assert.equal(categories.get('you|melee'), 5600)
  assert.equal(categories.get('pet|melee'), 14864)
  assert.equal(categories.get('enemy|melee'), 2149)
  const sum = (prefix: string, names: string[]): number =>
    names.reduce((n, k) => n + (skills.get(`${prefix}|${k}`)?.total ?? 0), 0)
  assert.equal(sum('you', ['Melee', 'Strike', 'Cleave', 'Smite', 'Bash', 'Kick']), categories.get('you|melee'))
  assert.equal(sum('pet', ['Melee', 'Strike', 'Cleave', 'Smite', 'Bash', 'Kick']), categories.get('pet|melee'))
  assert.equal(sum('enemy', ['Melee', 'Strike', 'Cleave', 'Smite', 'Bash', 'Kick']), categories.get('enemy|melee'))
})

test('W52 + THE INJECTED SELF ARM: your own cleave gets the row, and moves no other number', { skip: SKIP52 }, () => {
  // THE INJECTION, stated plainly. The owner's log has no `You cleave` line to cut, and the
  // reporter's slice may never become a fixture, so these four sentences are quoted in SHAPE
  // from report 01KZCZ3BYRQRD4JQJ0PW7FQRG5 — `You cleave an elemental warrior for 75 points of
  // damage.` / `… for 106 points of damage. (Critical)` — with the mob renamed to one this
  // window is really fighting and timestamps inside the fight. Nothing else is invented: the
  // amounts are the slice's own.
  const INJECTED = [
    '[Wed Aug 05 17:06:30 2026] You cleave an essence tamer for 75 points of damage.',
    '[Wed Aug 05 17:06:30 2026] You try to cleave an essence tamer, but miss!',
    '[Wed Aug 05 17:06:44 2026] You cleave an essence carrier for 106 points of damage. (Critical)',
    '[Wed Aug 05 17:06:44 2026] You cleave an essence carrier for 46 points of damage.'
  ]
  const base = laneRollup(W52)
  const withSelf = laneRollup(mergeByTime(W52, INJECTED))

  // The row the reporter cannot see today: 75 + 106 + 46 = 227 over three hits.
  lane(withSelf.skills, 'you|Cleave', 227, 3)
  // …and it comes out of NOWHERE ELSE. Your generic lane is untouched (the cleaves were never
  // in it), and your melee category grows by exactly the injected 227 — no more, no less.
  lane(withSelf.skills, 'you|Melee', base.skills.get('you|Melee')!.total, base.skills.get('you|Melee')!.hits)
  assert.equal(withSelf.categories.get('you|melee'), (base.categories.get('you|melee') ?? 0) + 227)
  assert.equal(withSelf.outTotal, base.outTotal + 227)
  // The pet and the mobs are bystanders to your swing.
  assert.equal(withSelf.categories.get('pet|melee'), base.categories.get('pet|melee'))
  assert.equal(withSelf.inTotal, base.inTotal)
  lane(withSelf.skills, 'pet|Cleave', 2243, 14)
  lane(withSelf.skills, 'enemy|Cleave', 609, 8)
})
