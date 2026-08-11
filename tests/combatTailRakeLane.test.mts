// THE TAIL RAKE LANE (JOS-102) — user report 01KZGADDMWEGAVPX9V95F8H4Y2, "Tail Rake is missing
// from the DPS overview". Sixth of the lane family after Cleave (JOS-77), Smite (JOS-81), Mend
// (JOS-86) and Ranged (JOS-92), and the first one whose fix is NOT a branch in `meleeSkill()`.
//
// ── WHAT THE SWEEP FOUND, BECAUSE IT OVERTURNS THE OBVIOUS READING ──────────────────────────
//
// The obvious reading is JOS-77's easy case: Tail Rake is a monk SKILL — the committed class
// table grants it to MNK and to nobody else — so give it a verb and a row, the way Cleave and
// Smite got one. THAT WOULD HAVE INVENTED A MESSAGE SHAPE THE GAME HAS NEVER PRINTED.
//
//   `tail rake` (any casing): ZERO in eqlog_Primitive_freeport.txt (1,438,942 lines), ZERO in
//   both halas logs, ZERO in all 103 committed fixtures. The only "rake" in the whole tree is
//   the word inside `drake`. There is no verb to route.
//
// Tail Rake is an UPGRADED SPECIAL, and EQ Legends prints those as a generic verb — the exact
// thing wave T measured and built specialAttacks.ts for. A Dragon Punch lands as
// `You strike <mob> for N points of damage.`; so does a Tail Rake. The only line that ever names
// it is the state line, and the report is therefore the Dragon Punch bug one RACE over:
//
//   You will now use Tail Rake instead of Eagle Strike while attacking.
//
// ── WHY IT TAKES DRAGON PUNCH'S SEAT, ON THREE SOURCES THAT AGREE ───────────────────────────
//
//   1. THE COMMITTED CLASS TABLE (src/main/data/classes.json, scraped by `npm run scrape:classes`,
//      not hand-authored). MNK's skill unlocks read: Round Kick 5, Tiger Claw 10, Eagle Strike
//      20, Dragon Punch 25, TAIL RAKE 25, Flying Kick 30. Same class, same level as Dragon Punch,
//      in a chain whose other rungs are 10 and 20 — that is a race variant of one rung, not a
//      fourth rung. T3 below asserts it off the JSON so the claim cannot drift.
//   2. THE EQ LEGENDS WIKI says the identical sentence about both: Dragon Punch "replaces Eagle
//      Strike as the Monk special punch attack", and "Iksar Monks get Tail Rake instead". Same
//      slot, same displaced special, same level, same 225 cap.
//   3. THE EXCLUSIVITY TEST specialAttacks.ts applies before claiming any lane was already won
//      for `strike` in wave T on the owner's own bytes (his first-ever `You strike` is three
//      seconds after his Tiger Claw grant; Eagle Strike and Dragon Punch skill-ups are confined
//      to their own eras, 145/145 and 254/255). Tail Rake takes a SEAT in that chain rather than
//      opening a lane, so no new verb is claimed and that evidence does not have to be re-won.
//
// ── THE ARM IS INJECTED, AND HERE IS EXACTLY WHAT IS ATTESTED vs CONSTRUCTED ────────────────
//
// THE OWNER IS NOT AN IKSAR. He has a monk in his loadout — `You have become better at Dragon
// Punch!` ticks 255 times — which is precisely why his log can never contain the Iksar arm: the
// two are alternatives. No fixture can be cut for this, and a reporter's slice never becomes one
// (AGENTS.md). So T6 injects, the petClaimWindows / mobLifetapPlayer / JOS-92 precedent.
//
// The injection is unusually cheap to justify, because it is ONE WORD inside a sentence this
// repo already has verbatim. `w47-special-dragon-punch.log` line 242 is the owner's real bytes:
//
//   [Wed Jul 29 14:54:14 2026] You will now use Dragon Punch instead of Eagle Strike while attacking.
//
// T6 replays that whole committed window with THAT ONE LINE's skill name swapped to `Tail Rake`
// and nothing else touched — the same "attested sentence, name swapped" move the precedent
// describes. ATTESTED: the grammar (21 real `You will now use …` lines in the owner's log), every
// other byte in the window, and all 12 numbers it asserts. CONSTRUCTED: the two words `Tail Rake`
// standing where `Dragon Punch` stands, sourced from the class table and the wiki above. The
// assertion is the strong form — the Iksar arm must produce a rollup IDENTICAL to the human arm
// under a rename, which is the whole claim of "it shares the seat".
//
// ── LAW 8 ───────────────────────────────────────────────────────────────────────────────────
//
// Every committed fixture was replayed before and after the change — 1,102 rows: per-segment
// out/in, per (source, category), per (source, lane) — and the two dumps are BYTE-IDENTICAL, not
// merely additive. Nothing could move: membership in the LANES table does nothing until a
// `You will now use Tail Rake …` line is read, and T7 asserts no such line exists anywhere in the
// tree. The behaviour is proven by T5/T6 instead, and T6 proves the movement is exactly a rename.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { parseEvent } from '../src/main/log/parser'
import { meleeSkill } from '../src/main/log/parseCombat'
import { CombatEngine } from '../src/main/combat/engine'
import { SpecialAttacks, laneOfSpecial, specialLaneVerbs } from '../src/main/combat/specialAttacks'
import classes from '../src/main/data/classes.json'
import type { SourceView } from '../src/shared/combat'
import type { SpecialAttackEvent } from '../src/shared/logEvents'

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), 'fixtures')

// ── T1..T4: the shape of the claim ────────────────────────────────────────────────────────

test('T1: the state line parses, in both real shapes, with the multi-word name intact', () => {
  const special = (text: string): SpecialAttackEvent => {
    const ev = parseEvent(`[Wed Jul 29 14:54:14 2026] ${text}`, 0)
    assert.ok(ev, `did not parse: ${text}`)
    assert.equal(ev.kind, 'specialAttack', `expected specialAttack for: ${text}`)
    if (ev.kind !== 'specialAttack') throw new Error('unreachable')
    return ev
  }
  // The replacement form — the reporter's line, and the one the class table + wiki predict.
  const tr = special('You will now use Tail Rake instead of Eagle Strike while attacking.')
  assert.equal(tr.skill, 'Tail Rake')
  assert.equal(tr.replaces, 'Eagle Strike')
  assert.equal(tr.autoAttack, false)
  // The bare GRANT form. Nothing about the two-word name is special-cased: SPECIAL_ATTACK_RE's
  // lazy captures are bounded by literal text, which is why `Round Kick` and `Flying Kick`
  // already work, so this needed no parser change at all — only the lane table moved.
  const grant = special('You will now use Tail Rake while auto attacking.')
  assert.equal(grant.skill, 'Tail Rake')
  assert.equal(grant.replaces, undefined)
  assert.equal(grant.autoAttack, true)
  // …and the reverse pairing, for an Iksar who is later handed the other name (or an Iksar's
  // Flying Kick at 30 displacing it). `Tail Rake` must survive on the RIGHT of "instead of" too.
  const fk = special('You will now use Flying Kick instead of Tail Rake while attacking.')
  assert.equal(fk.skill, 'Flying Kick')
  assert.equal(fk.replaces, 'Tail Rake')
})

test('T2: Tail Rake joins the strike chain, and no other lane moves', () => {
  assert.equal(laneOfSpecial('Tail Rake'), 'strike')
  // Case and whitespace are folded the same way every other entry is.
  assert.equal(laneOfSpecial('  tail rake  '), 'strike')
  assert.equal(laneOfSpecial('TAIL RAKE'), 'strike')
  // The seat it shares, and the rest of the chain — all unchanged.
  for (const s of ['Tiger Claw', 'Eagle Strike', 'Dragon Punch']) assert.equal(laneOfSpecial(s), 'strike', s)
  for (const s of ['Kick', 'Round Kick', 'Flying Kick']) assert.equal(laneOfSpecial(s), 'kick', s)
  // THE REFUSALS STAY REFUSED. Smite/Backstab/Frenzy print their own verb; Slam is the one the
  // evidence contradicts (185 `better at Bash!` ticks fire during Slam eras).
  for (const s of ['Smite', 'Backstab', 'Frenzy', 'Slam', 'Bash']) assert.equal(laneOfSpecial(s), undefined, s)
  // NO NEW VERB LANE was opened — the whole point of taking a seat rather than building a rung.
  assert.deepEqual(specialLaneVerbs().sort(), ['kick', 'strike'])
})

test('T3: the class table itself says Tail Rake shares Dragon Punch\'s rung', () => {
  // Read off the COMMITTED scrape (never the live wiki — classTables.test.mts states why).
  const skills: Record<string, string[]> = classes.skills
  assert.deepEqual(skills['Tail Rake'], ['MNK'], 'Tail Rake is monk-only')
  assert.deepEqual(skills['Dragon Punch'], ['MNK'])
  const unlocks: { name: string; level: number; kind: string }[] = classes.skillUnlocks.MNK
  const at = (name: string): number | undefined => unlocks.find((u) => u.name === name)?.level
  // The chain, and the shared level that makes Tail Rake a race variant rather than an upgrade.
  assert.equal(at('Tiger Claw'), 10)
  assert.equal(at('Eagle Strike'), 20)
  assert.equal(at('Dragon Punch'), 25)
  assert.equal(at('Tail Rake'), 25, 'the same rung as Dragon Punch — the Iksar variant of it')
  assert.equal(at('Flying Kick'), 30, 'the next upgrade is in the OTHER lane, so the seat is the last strike')
})

test('T4: no `tail rake` VERB is invented — the game has never printed one', () => {
  // THE AWAITING-SAMPLE LAW, and the branch this ticket deliberately did NOT write. A skill that
  // prints no verb of its own is not meleeSkill()'s business, however plainly it is a skill.
  assert.equal(meleeSkill('tail rake'), 'Melee')
  assert.equal(meleeSkill('rake'), 'Melee')
  assert.equal(meleeSkill('rakes'), 'Melee')
  // …and such a sentence is not a melee damage line at all, so it could not reach a lane even if
  // one existed. (Contrast `You strike …`, which is the shape a real Tail Rake actually lands as.)
  const invented = parseEvent('[Wed Jul 29 15:05:14 2026] You tail rake a frenzied ghoul for 32 points of damage.', 0)
  assert.notEqual(invented?.kind, 'damage', 'no `tail rake` damage family is claimed')
  const real = parseEvent('[Wed Jul 29 15:05:14 2026] You strike a frenzied ghoul for 32 points of damage.', 0)
  assert.equal(real?.kind === 'damage' ? real.verb : undefined, 'strike')
  // Unlaned, a strike is the ANONYMOUS "Strike" row (JOS-163) — the verb earns the row, and the
  // NAME still comes from the state line and nowhere else. That distinction is the whole reason
  // this ticket wrote no `tail rake` branch: had the floor been seeded from the chain instead of
  // taken from the verb, an Iksar's unlaned strikes would read "Dragon Punch", which is a claim
  // about his race that no line in his log has made.
  assert.equal(real?.kind === 'damage' ? real.skill : undefined, 'Strike')
})

// ── T5: the state model ───────────────────────────────────────────────────────────────────

test('T5: the seat holds one name at a time, and is never seeded', () => {
  const sp = new SpecialAttacks()
  const set = (skill: string, replaces?: string): string | undefined =>
    sp.note({
      kind: 'specialAttack', seq: 0, ts: 0, raw: '', skill,
      autoAttack: replaces === undefined, ...(replaces ? { replaces } : {})
    })

  // COLD IS SILENT. Membership in the table does nothing on its own — this is what makes the
  // law-8 gate trivial, and it is why an Iksar's swings read "Melee" until his log says otherwise.
  assert.equal(sp.laneSkill('strike'), undefined)

  assert.equal(set('Tail Rake', 'Eagle Strike'), 'strike')
  assert.equal(sp.laneSkill('strike'), 'Tail Rake')
  assert.equal(sp.laneSkill('kick'), undefined, 'one lane speaking must not seed another')

  // THE TWO NAMES SHARE THE SEAT, so each displaces the other — the newest statement wins, as it
  // does for every other pair in the chain. (No character ever prints both; the model does not
  // need to know that, and must not depend on it.)
  assert.equal(set('Dragon Punch', 'Eagle Strike'), 'strike')
  assert.equal(sp.laneSkill('strike'), 'Dragon Punch')
  assert.equal(set('Tail Rake', 'Eagle Strike'), 'strike')
  assert.equal(sp.laneSkill('strike'), 'Tail Rake')

  // A bare grant RESETS the seat downward exactly as `Kick while auto attacking.` does.
  assert.equal(set('Tiger Claw'), 'strike')
  assert.equal(sp.laneSkill('strike'), 'Tiger Claw', 'the reset applies to the Iksar arm too')

  set('Tail Rake', 'Eagle Strike')
  sp.reset()
  assert.deepEqual(sp.entries(), [], 'a character switch clears the Iksar seat like any other')
})

// ── T6: the injected arm, over the committed Dragon Punch window ──────────────────────────

function load(name: string): string[] {
  const p = join(FIXTURES, name)
  return existsSync(p) ? readFileSync(p, 'utf8').split(/\r?\n/).filter((l) => l.length > 0) : []
}
const W47 = load('w47-special-dragon-punch.log')
const SKIP47 = W47.length === 0 && 'fixture not present'

interface Lane {
  total: number
  hits: number
}

/**
 * Replay a window and roll damage up per (source kind, lane) and per (source kind, category),
 * summed over every fight in it. Same rollup shape as the cleave/smite/ranged goldens, so the
 * lane tests read alike.
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
  const foldSource = (src: SourceView): void => {
    for (const k of src.skills) {
      const key = `${src.kind}|${k.name}`
      const prev = skills.get(key) ?? { total: 0, hits: 0 }
      skills.set(key, { total: prev.total + k.total, hits: prev.hits + k.hits })
    }
    for (const c of src.categories) {
      const key = `${src.kind}|${c.category}`
      categories.set(key, (categories.get(key) ?? 0) + c.total)
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
  return { skills, categories, outTotal, inTotal }
}

/** The window with its ONE state line's skill name swapped to the Iksar variant. */
function iksarArm(window: string[]): string[] {
  const HUMAN = 'You will now use Dragon Punch instead of Eagle Strike while attacking.'
  const IKSAR = 'You will now use Tail Rake instead of Eagle Strike while attacking.'
  const hits = window.filter((l) => l.endsWith(HUMAN))
  assert.equal(hits.length, 1, 'the committed window carries exactly one Dragon Punch state line')
  return window.map((l) => (l.endsWith(HUMAN) ? l.replace(HUMAN, IKSAR) : l))
}

test('T6: THE REPORTED BUG — an Iksar\'s strikes get the Tail Rake row, and the fight is otherwise identical', { skip: SKIP47 }, () => {
  const human = laneRollup(W47)
  const iksar = laneRollup(iksarArm(W47))

  // THE ROW THE REPORTER CANNOT SEE TODAY. These are w47's own hand-tallied numbers (the six
  // `You strike …` lines after 14:54:14: 1 + 30 Critical + 20 + 1 + 28 + 48), and the Iksar arm
  // must produce them under the other name — same bytes, same swings, same points.
  assert.deepEqual(iksar.skills.get('you|Tail Rake'), { total: 128, hits: 6 })
  assert.deepEqual(human.skills.get('you|Dragon Punch'), { total: 128, hits: 6 })
  assert.equal(iksar.skills.has('you|Dragon Punch'), false, 'the human name is gone with its line')
  assert.equal(human.skills.has('you|Tail Rake'), false, 'and does not appear where it was not stated')

  // THE STRONG FORM OF THE CLAIM: the two rollups are the SAME MAP under one rename. If Tail Rake
  // were anything other than Dragon Punch's seat — a different lane, a fourth rung, a verb of its
  // own — some other row would differ here.
  const renamed = new Map(
    [...human.skills].map(([k, v]) => [k === 'you|Dragon Punch' ? 'you|Tail Rake' : k, v] as const)
  )
  assert.deepEqual([...iksar.skills].sort(), [...renamed].sort())

  // LAW 8 TRIPWIRE — the category totals are what must not move, and they are w47's pre-existing
  // asserted values. A lane rename crosses no category boundary and moves no point of damage.
  assert.deepEqual([...iksar.categories].sort(), [...human.categories].sort())
  assert.equal(iksar.categories.get('you|melee'), 2297)
  assert.equal(iksar.categories.get('you|slay'), 659)
  assert.equal(iksar.categories.get('you|spell'), 2586)
  assert.equal(iksar.outTotal, 8733, 'total outgoing damage is untouched by the label')
  assert.equal(iksar.outTotal, human.outTotal)
  assert.equal(iksar.inTotal, human.inTotal)

  // …and the six PRE-state strikes stay generic for the Iksar exactly as they do for the human:
  // this window never heard the Eagle Strike statement, so the model does not seed the seat.
  assert.equal(iksar.skills.has('you|Eagle Strike'), false)
  const melee = iksar.skills.get('you|Melee')
  assert.ok(melee && melee.total > 77, 'the pre-state strikes are still inside the generic lane')
})

test('T6b: without the state line, an Iksar\'s strikes stay generic — nothing is seeded from the table', { skip: SKIP47 }, () => {
  // The honest-by-omission property, re-asserted for the new seat. Strip the state line entirely
  // and the Tail Rake row must not appear from the table's mere knowledge that the name exists.
  const silent = W47.filter((l) => !l.includes('You will now use '))
  const { skills } = laneRollup(silent)
  assert.equal(skills.has('you|Tail Rake'), false)
  assert.equal(skills.has('you|Dragon Punch'), false)
  // All 12 strikes (77 + 128) are back in the anonymous lane, which is where they are today.
  const melee = skills.get('you|Melee')
  assert.ok(melee && melee.total > 205, 'both eras of strikes fold into Melee when nothing names them')
})

// ── T7: the law-8 statement, asserted rather than claimed ─────────────────────────────────

test('T7: no committed fixture mentions Tail Rake — which is why not one figure could move', () => {
  const logs = readdirSync(FIXTURES).filter((f) => f.endsWith('.log'))
  assert.ok(logs.length >= 100, `expected the full fixture set, saw ${logs.length}`)
  for (const f of logs) {
    const text = readFileSync(join(FIXTURES, f), 'utf8').toLowerCase()
    assert.equal(text.includes('tail rake'), false, `${f} mentions tail rake`)
    // The only "rake" in the tree is the one inside `drake`, which is why a `rake` verb would
    // have been a genuinely dangerous thing to add.
    for (const m of text.matchAll(/rake/g)) {
      assert.equal(text.slice(Math.max(0, m.index - 1), m.index + 4), 'drake', `${f}: a bare "rake" appeared`)
    }
  }
})
