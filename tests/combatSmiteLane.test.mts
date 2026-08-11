// THE SMITE LANE (JOS-81) — cleave's twin, and the gap `tests/combatCleaveLane.test.mts` and
// `tests/specialAttackWindows.test.mts` (W48) used to pin as deliberate.
//
// THE DAMAGE WAS NEVER MISSING. `smite` has been in MELEE_VERBS since the missing-verbs fix
// (AGENTS.md: smite/cleave once hid 22% of all damage), so every point was counted;
// `meleeSkill('smite')` answered "Melee", so 13,984 of the owner's own swings folded into the
// anonymous weapon lane beside slash/pierce/crush and the ROW could not exist.
//
// WHY SMITE IS A SKILL AND NOT A DAMAGE TIER OF SOME WEAPON VERB. Cleave's proof was an
// ABSENCE (a WAR verb that never once printed for a player who lacks the skill). Smite cannot
// borrow it — the owner IS a paladin and swings it 13,984 times — so it needs its own, and the
// log supplies a stronger one. Two measurements, whole log, 1,434,4xx lines, 2026-08-06:
//   1. `Smite` is a PAL-only INNATE granted at level 9 in the scraped class table
//      (src/main/data/classes.json `skillUnlocks`), the same evidence class that earns
//      Backstab (ROG), Bash (PAL/SHD/WAR), Kick (BST/MNK/RNG/WAR), Frenzy (BER) and Cleave (WAR)
//      their rows. `You have gained the ability to use Smite.` is in the log, verbatim, at
//      Tue Jul 28 14:59:23 — the class-skill grant family, not an AA purchase.
//   2. THE SKILL-UP STREAM, which is decisive. Enumerating all 56 `You have become better at X!`
//      names in the log: a weapon verb NEVER ticks under its own name — a slash ticks
//      `1H Slashing` (365), a crush `1H Blunt` (248), a pierce `1H Piercing` (410), a punch
//      `Hand to Hand` (282), and `better at Slash!` does not exist at all. `Smite` ticks 280
//      times under its OWN name, beside Kick (296), Bash (222), Backstab (200) and Frenzy (196).
//      The log itself says which words are skills and which are weapons.
//
// THE SKILL LANE AND THE SPELL LANE SHARE A STEM AND MUST NEVER MERGE — and one of them is a
// real collision this change discovered:
//   * `Smiting Strike` (15,016 lines) is the paladin's PROC and is NOT this feature's business:
//     `You hit <mob> for 259 points of magic damage by Smiting Strike.` comes in on the
//     `by <Spell>` path, carries no melee verb, lands in the `spell` category, and has always
//     had its own named row. It is byte-identical before and after (W53 pins both rows side by
//     side in a window where the two land in the same second).
//   * There is ALSO a spell literally named `Smite` — `You hit <mob> for 94 points of magic
//     damage by Smite.`, 20 self lines in the whole log (1,820 points) plus 60 from other
//     players. classes.json already flags the name clash ("also a Template:Spellpage spell name
//     with a DIFFERENT class set — never union them"). A source's TOP-LEVEL lane list is keyed
//     by skill NAME alone (aggregate.ts `bySkill`), so on those 10 fights out of 2,727 the
//     melee row and the spell row now share one line. W54 pins it on real bytes rather than
//     hiding it: the per-CATEGORY drill keeps them apart (melee 433/14 vs spell 455/3), every
//     category total is exact, and nothing is lost — but the top row does sum two different
//     things, and that is stated, not papered over.
//
// LAW 8. This is a LABELING change and nothing else. Whole-log regression gate on the owner's
// real log (2,727 fight segments, 27,909,387 points outgoing / 5,178,703 incoming): per-segment
// totals, per-source totals and per-CATEGORY totals came out BYTE-IDENTICAL — 35,243 identical
// lines, the only diff being the replay's own line counter, because the live log grew by 15
// lines between the two runs. Only lane NAMES moved: 2,306 (segment, source) rows, 428,422
// points over 13,984 hits out of "Melee" and into "Smite" — 13,984 being exactly the whole-log
// `You smite` count, so the movement closes to the line. Zero mismatches: in every one of those
// 2,306 rows the points that left Melee equal the points that arrived in Smite. 87 lanes
// disappeared from the payload and ALL 87 carry `total=0 hits=0` — zero-damage effect/resist
// rows pushed off the 12-row cap in `sourceViews.ts` by the new row. That is a payload-cap
// artifact, the same one JOS-77 reported, not accounting.
//
// THE FIXTURES ARE THE OWNER'S OWN BYTES AND NOTHING IS INJECTED. Unlike the cleave window,
// which had to inject the self arm, every arm here is real: `p2-pet-arc-bound.log` (the greater
// kobold fights, Thu Aug 06) carries the melee smites and the Smiting Strike procs seconds
// apart, and `w25-per-mob-miss-ghosts.log` (Sun Aug 02) carries the melee-verb/spell-name
// collision. Both are already committed; neither is re-cut.

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

test('S1: every conjugation of smite lands on ONE verb and ONE lane', () => {
  // Both shapes are verbatim from the owner's log with this window's mobs: the first person is
  // `[Thu Aug 06 12:35:48 2026] You smite a greater kobold for 72 points of damage. (Critical)`
  // and the third person is another paladin's, `Lizgar smites Gynok Moltor for 16 points…`
  // (1,223 third-person smites whole-log, every one of them another PLAYER's).
  const dmg = (text: string) => {
    const ev = parseEvent(`[Thu Aug 06 12:35:48 2026] ${text}`, 0)
    assert.ok(ev, `did not parse: ${text}`)
    assert.equal(ev.kind, 'damage', text)
    if (ev.kind !== 'damage') throw new Error('unreachable')
    return ev
  }
  const self = dmg('You smite a greater kobold for 56 points of damage.')
  assert.equal(self.verb, 'smite')
  assert.equal(self.skill, 'Smite')
  assert.equal(self.amount, 56)
  const other = dmg('Lizgar smites a greater kobold for 16 points of damage.')
  assert.equal(other.verb, 'smite')
  assert.equal(other.skill, 'Smite')
  // A modifier rides the same line without disturbing the lane.
  const crit = dmg('You smite a greater kobold for 72 points of damage. (Critical)')
  assert.equal(crit.skill, 'Smite')
  assert.equal(crit.crit, true)
  // `smites` un-conjugates to `smite` — the `-s`-on-a-word-ending-in-e case, same trap as
  // `slices`/`slice`, and the reason meleeVerbBase confirms against the base set.
  assert.equal(meleeVerbBase('smites'), 'smite')
  assert.equal(meleeVerbBase('Smites'), 'smite')
})

test('S2: an AVOIDED smite lanes exactly like a landed one', () => {
  // The first two are verbatim from p2-pet-arc-bound.log (Thu Aug 06 12:36:34, twice in one
  // second); the rest are the same family's other outcomes with this window's mobs. The
  // aggregation lane for a miss stays 'Melee' by design (routing.ts missFold — that is the
  // shipped accuracy lane); what must agree with the landed swing is the VERB, which is what
  // the round grouper and the miss's `laneSkill` are built on.
  for (const text of [
    'You try to smite a greater kobold, but miss!',
    'You try to smite a greater kobold, but a greater kobold dodges!',
    'A greater kobold tries to smite YOU, but misses!',
    'A greater kobold tries to smite YOU, but YOU block!'
  ]) {
    const ev = parseEvent(`[Thu Aug 06 12:36:34 2026] ${text}`, 0)
    assert.ok(ev, `did not parse: ${text}`)
    assert.equal(ev.kind, 'miss', text)
    if (ev.kind !== 'miss') throw new Error('unreachable')
    assert.equal(ev.verb, 'smite', text)
    assert.equal(meleeSkill(ev.verb ?? ''), 'Smite', text)
  }
})

test('S3: the split is a NAMED-SKILL table, not a matcher over verb spelling', () => {
  assert.equal(meleeSkill('smite'), 'Smite')
  assert.equal(meleeSkill('smites'), 'Smite')
  // The neighbours it must not swallow. `smash` shares three letters and is a weapon verb; a
  // prefix rule that read `sm` would take it, which is why the branch spells `smite` out.
  for (const v of ['smash', 'slash', 'slice', 'crush', 'pierce', 'hit', 'reave']) {
    assert.equal(meleeSkill(v), 'Melee', v)
  }
  // `strike` used to sit in that list and left in JOS-163 — NOT by this test's argument. It ticks
  // no skill-up of its own; it earns a row because it is the generic verb every monk special
  // prints as, and the row is anonymous for exactly that reason. `smite` is still spelled out in
  // full above it in the branch table, so `smash` is still declined.
  assert.equal(meleeSkill('strike'), 'Strike')
  assert.equal(meleeSkill('smash'), 'Melee')
})

test('S4: smite claims NO special-attack lane and NO reuse-timer confidence', () => {
  // The enumeration discipline (JOS-77 pinned the same two refusals for cleave).
  //
  // SPECIAL-ATTACK LANE: the log DOES print `You will now use Smite while auto attacking.` —
  // three times, at Tue Jul 28 14:59:32, Sun Aug 02 01:55:13 and Thu Aug 06 19:23:32, all of
  // them the bare GRANT form. There is NO `instead of Smite` line anywhere in the log (0
  // occurrences), so nothing has ever displaced it and no chain exists to track. And it needs
  // none: a special attack earns a lane only when it prints no verb of its own (specialAttacks.ts
  // — a Dragon Punch lands as `You strike`), whereas Smite prints `smite`. So the event parses,
  // the state model declines the lane, and `meleeSkill()` is the whole answer.
  const grant = parseEvent('[Sun Aug 02 01:55:13 2026] You will now use Smite while auto attacking.', 0)
  assert.ok(grant)
  assert.equal(grant.kind, 'specialAttack')
  if (grant.kind !== 'specialAttack') throw new Error('unreachable')
  assert.equal(grant.skill, 'Smite')
  assert.equal(grant.autoAttack, true)
  const sp = new SpecialAttacks()
  assert.equal(sp.note(grant), undefined, 'Smite must claim no verb lane')
  assert.equal(sp.laneSkill('smite'), undefined)
  assert.equal(laneOfSpecial('Smite'), undefined)

  // REUSE TIMER: nothing in the log states one for Smite, so its multi-swing reading keeps the
  // honest `aggregate` tier every weapon verb has rather than joining backstab/bash/kick/strike
  // in the confident one. Naming a timer here would be the guess rounds.ts refuses.
  assert.equal(roundConfidence('smite'), 'aggregate')
})

// ── the golden windows ────────────────────────────────────────────────────────────────────

// Fixtures are COMMITTED (`.gitignore` negates `tests/fixtures/*.log`). Both windows below are
// existing fixtures re-read for a new question — neither is re-cut for this feature.
const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), 'fixtures')
function load(name: string): string[] {
  const p = join(FIXTURES, name)
  return existsSync(p) ? readFileSync(p, 'utf8').split(/\r?\n/).filter((l) => l.length > 0) : []
}
const W53 = load('p2-pet-arc-bound.log')
const W54 = load('w25-per-mob-miss-ghosts.log')
const SKIP53 = W53.length === 0 && 'fixture not present'
const SKIP54 = W54.length === 0 && 'fixture not present'

interface Lane {
  total: number
  hits: number
}

/**
 * Replay a window and roll damage up three ways, summed over EVERY fight in it: per
 * (source kind, skill lane) — which is the row the meter's drill shows — per (source kind,
 * category), and per (source kind, category, skill lane), which is the drill one level down.
 * The third is what proves the melee lane and the spell lane stay separable even where their
 * NAMES collide, so it is not an ornament.
 */
function laneRollup(lines: string[]): {
  skills: Map<string, Lane>
  categories: Map<string, number>
  catSkills: Map<string, Lane>
  outTotal: number
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
  const add = (m: Map<string, Lane>, key: string, total: number, hits: number): void => {
    const prev = m.get(key) ?? { total: 0, hits: 0 }
    m.set(key, { total: prev.total + total, hits: prev.hits + hits })
  }
  // One source's three foldings, lifted out of the segment loop so the nesting stays inside
  // `max-depth 3` (eslint.config.mjs) — the shape is the same as the cleave window's.
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
    for (const src of [...view.entities, ...view.incoming]) foldSource(src)
  }
  return { skills, categories, catSkills, outTotal }
}

function lane(skills: Map<string, Lane>, key: string, total: number, hits: number): void {
  assert.deepEqual(skills.get(key), { total, hits }, `lane "${key}"`)
}

test('W53: THE REPORTED GAP — your smite gets its own row, and the Smiting Strike row is untouched beside it', { skip: SKIP53 }, () => {
  const { skills, categories, catSkills } = laneRollup(W53)

  // HAND-TALLIED off the fixture text before the engine was ever asked. Five `You smite a
  // greater kobold …` lines — 72 (Critical) + 56 + 48 + 48 + 72 = 296 — plus two whiffed
  // smites in one second at 12:36:34. Every one of those 296 points was inside "Melee" before.
  lane(skills, 'you|Smite', 296, 5)
  // THE BLUE BAR THE OWNER ALREADY HAD, and the whole point of this window: the paladin proc
  // fires in the SAME SECOND as three of those swings (`You hit a greater kobold for 259 points
  // of magic damage by Smiting Strike.` sits on the very next line, twice at 12:35:48), and it
  // is a different lane in a different category. 5 × 259 = 1,295. Byte-identical before and
  // after this change — it never goes near meleeSkill(), which only ever sees a melee VERB.
  // (The row is NAMED for its origin since JOS-167 — this window never casts Smiting Strike, so
  // there is one row and it says where the 1,295 came from. The amount is unchanged.)
  lane(skills, 'you|Smiting Strike · proc', 1295, 5)
  assert.equal(catSkills.get('you|spell|Smiting Strike · proc')?.total, 1295)
  assert.equal(catSkills.get('you|melee|Smite')?.total, 296)
  assert.equal(catSkills.has('you|melee|Smiting Strike · proc'), false, 'the proc is never a melee lane')
  assert.equal(catSkills.has('you|spell|Smite'), false, 'this window casts no spell of that name')

  // The rest of your swings stay where they were — the split takes smite OUT of Melee and
  // touches nothing else. slash 3,598/20 + claw 1,395/15 = 4,993 over 35 hits. The strike arm
  // (795 over 12 hits) used to be inside that number and left for its own neutral row in
  // JOS-163: this window carries no `You will now use` line, so the verb earns the row and
  // nothing names it.
  lane(skills, 'you|Melee', 4993, 35)
  lane(skills, 'you|Strike', 795, 12)
  lane(skills, 'you|Bash', 898, 10)
  lane(skills, 'you|Kick', 787, 6)
  // Nobody else in the window smites, and a lane is never invented for a verb nothing printed.
  assert.equal(skills.has('pet|Smite'), false)
  assert.equal(skills.has('enemy|Smite'), false)
  lane(skills, 'pet|Cleave', 341, 8)

  // LAW 8 TRIPWIRE — the CATEGORY totals are what may not move, and Σ lanes must equal them.
  // Hand-tallied: your melee is bash 898 + claw 1,395 + kick 787 + slash 3,598 + smite 296 +
  // strike 795 = 7,769, and your spell side is Smiting Strike 1,295 + Lifetap Strike 31 = 1,326.
  assert.equal(categories.get('you|melee'), 7769)
  assert.equal(categories.get('you|spell'), 1326)
  assert.equal(categories.get('pet|melee'), 1627)
  assert.equal(categories.get('enemy|melee'), 561)
  const sum = (prefix: string, names: string[]): number =>
    names.reduce((n, k) => n + (skills.get(`${prefix}|${k}`)?.total ?? 0), 0)
  assert.equal(sum('you', ['Melee', 'Strike', 'Smite', 'Bash', 'Kick']), categories.get('you|melee'))
  assert.equal(sum('you', ['Smiting Strike · proc', 'Lifetap Strike · proc']), categories.get('you|spell'))
})

test('W54: the SPELL named Smite and the SKILL named Smite share a row — and the category drill keeps them apart', { skip: SKIP54 }, () => {
  // THE COLLISION, on real bytes. This window carries both shapes for the same player:
  //   [Sun Aug 02 16:51:28] You hit a deadly black widow for 94 points of magic damage by Smite.
  //   [Sun Aug 02 16:51:34] … for 98 …   [16:51:54] … for 263 … (Critical)      → 455 over 3
  //   fourteen `You smite <mob> for N points of damage.` lines                  → 433 over 14
  // A source's top-level lane list is keyed by NAME alone (aggregate.ts `bySkill`), so the row
  // reads 888 over 17. It is not a miscount — it is two different abilities the log gives one
  // word, and it is why classes.json says "never union them" about this exact name.
  const { skills, categories, catSkills } = laneRollup(W54)
  lane(skills, 'you|Smite', 888, 17)

  // ONE LEVEL DOWN THEY SEPARATE, because the per-category maps are keyed inside a category.
  // This is the honest reading of the row above, and it is exact.
  lane(catSkills, 'you|melee|Smite', 433, 14)
  lane(catSkills, 'you|spell|Smite', 455, 3)
  assert.equal(
    (catSkills.get('you|melee|Smite')?.total ?? 0) + (catSkills.get('you|spell|Smite')?.total ?? 0),
    skills.get('you|Smite')?.total
  )

  // …and the proc keeps its own row throughout, in the spell category, untouched.
  lane(skills, 'you|Smiting Strike · proc', 973, 14)
  lane(catSkills, 'you|spell|Smiting Strike · proc', 973, 14)

  // LAW 8: the category totals are byte-identical to what the pre-change engine produced.
  // Hand-tallied melee: backstab 3,928 + bash 61 (21 of its 25 hits print the singular "for 1
  // point of damage") + frenzy 1,167 + kick 357 + pierce 1,372 + slash 5,951 + smite 433
  // = 13,269, of which pierce + slash = 7,323 over 118 hits is the generic lane.
  lane(skills, 'you|Melee', 7323, 118)
  assert.equal(categories.get('you|melee'), 13269)
  assert.equal(categories.get('you|spell'), 1428)
  const sum = (names: string[]): number =>
    names.reduce((n, k) => n + (catSkills.get(`you|melee|${k}`)?.total ?? 0), 0)
  assert.equal(sum(['Melee', 'Smite', 'Backstab', 'Bash', 'Frenzy', 'Kick']), categories.get('you|melee'))
})
