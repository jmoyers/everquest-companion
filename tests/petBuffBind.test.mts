// GOLDEN WINDOW — THE UPGRADED PET, AND THE BUFF THAT NAMES IT (JOS-188).
//
// THE REPORT (01KZPFBMF1R26DSG0R2EGER7MV, app 0.18.0): *"It appears if you change pets, they stop
// showing up in the damage meter (i upgraded from level 10 water elemental to level 14). i tried
// relogging, but it did not resolve."*
//
// THE CHARACTERIZATION, from that reporter's own 2,446-line slice, replayed through this engine
// before the fix: the JOS-54 succession law never FAILED — it never ran. Succession is triggered
// by the successor's own claim, and an upgraded summon produces none.
//
//   11:26:22  `Zarer says, 'As you wish, oh great one.'`     the outgoing pet (a petSay, inert)
//   11:26:25  `You begin casting Minor Summoning: Water.`    the upgrade
//   11:26:34  `You begin casting Burnout.`                   a `targetType: Pet` spell
//   11:26:40  `Jabektik goes berserk.`                       the landing NAMES the new pet
//   11:26:50  `Jabektik backstabs Footman of V`Zher …`       89 hits / 3,385 points follow
//
// `told you, '… Master.'` tells in that whole 30-minute window: ZERO. `/pet who leader` answers:
// ZERO. So the replay ended with `petDisplayNames() === []` and one row, You — the predecessor's
// frozen row is only there for the reporter because a tell bound it earlier in the session, and
// relogging cannot help because relogging prints no binding line either. It is JOS-47's accepted
// blind spot reached by a new road: `world.claim()` binds a NAME, and an upgrade changes it.
//
// THE THIRD BINDING SIGNAL. 40 spells in the DB are `targetType: Pet`, the game will not let one
// land on anything but your own pet, and `You begin casting <Spell>.` is printed for the player
// and nobody else — the same exclusivity Task #65's charm model already runs on. So an own cast
// of a pet-only spell ARMS (charmModel.armWindowMs: the spell's own cast time plus slack) and the
// named landing that resolves it binds the pet, through the SAME `bindPetClaim` the tell and the
// leader say go through. It is the first of the three that costs the player nothing: you buff the
// pet you just summoned because you were going to anyway.
//
// MEASURED, owner's whole log (1,557,569 lines, 2026-08-10): 19 binds, 14 distinct names, and
// EVERY one of the 14 is a name a `… Master.'` tell also bound — nothing is bound by this rule
// alone and nothing it binds is later contradicted. In all 14 the buff arrives FIRST, by 81 s to
// 2,528 s, and the damage that lands in those gaps is 1,865 hits / 27,088 points the meter throws
// away without it (Giber alone: 947 hits / 11,636 points across a 42-minute gap).
//
// THE FIXTURE is the owner's own instance of the report — a reporter's slice never becomes one
// (AGENTS.md). p3-pet-upgraded-buff-bound.log, Sun Jul 19 21:06–21:12, Oggok:
//
//   21:06:26  `Vebann told you, 'Attacking Lost Crusader Master.'`   the predecessor, ordered
//   21:09:29  `You begin casting Haunting Corpse.`                   the upgrade
//   21:09:55  `You begin casting Intensify Death.`                   the pet-only spell
//   21:10:02  `Vabantik's eyes gleam with madness.`                  the successor, named
//   21:12:31  `Vabantik told you, 'Attacking an ogre guard Master.'` the tell, 149 s late
//
// THE SPELL DB IS INSTALLED HERE and is not optional: the named landing is a `buffApply`, which
// is DB-gated (shared/logEvents.ts BuffApplyEvent) and does not exist without it. Node runs each
// test file in its own process, so this injection cannot reach petClaimWindows.test.mts beside it
// — which deliberately runs WITHOUT a DB and whose numbers are therefore untouched by this rung.
//
// Fixture-guarded: `read` returns [] when the file is absent and every fixture test skips.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { parseEvent } from '../src/main/log/parser'
import { installCharacterName, installSpellDb } from '../src/main/log/rulesets'
import { loadSpellDb } from '../src/main/data/spellDb'
import { CombatEngine } from '../src/main/combat/engine'
import { PET_TARGET_SPELLS, isPetOnlySpell } from '../src/main/combat/charmModel'
import type { SegmentView } from '../src/shared/combat'

installSpellDb(loadSpellDb())
installCharacterName('Primitive')

const HERE = dirname(fileURLToPath(import.meta.url))
const read = (name: string): string[] => {
  const p = join(HERE, 'fixtures', name)
  return existsSync(p) ? readFileSync(p, 'utf8').split(/\r?\n/).filter((l) => l.length > 0) : []
}
const P3 = read('p3-pet-upgraded-buff-bound.log')
const P1 = read('p1-unbound-pet.log')
const skip = P3.length === 0 ? 'fixture not present' : false
const skipP1 = P1.length === 0 ? 'fixture not present' : false

function replay(lines: string[], pre: string[] = []): { eng: CombatEngine; lastTs: number } {
  const eng = new CombatEngine()
  eng.setPlayerName('Primitive')
  let seq = 0
  let lastTs = 0
  for (const raw of [...pre, ...lines]) {
    const ev = parseEvent(raw, seq++)
    if (!ev) continue
    eng.ingestEvent(ev, false)
    lastTs = Math.max(lastTs, ev.ts)
  }
  return { eng, lastTs }
}

/** Pet rows across every zone session, keyed by name with the display-only ` (N)` generation
 *  suffix stripped (world-model law 2 — it appears in no log line and is never identity). */
function petRows(eng: CombatEngine, lastTs: number): Map<string, { hits: number; total: number }> {
  const now = lastTs + 120_000
  const out = new Map<string, { hits: number; total: number }>()
  const views: SegmentView[] = []
  for (const zs of eng.snapshot(now, {}).zoneSessions) {
    const s = eng.snapshot(now, { selectedId: zs.id }).selected
    if (s) views.push(s)
  }
  for (const v of views)
    for (const e of v.entities) {
      if (e.kind !== 'pet') continue
      const name = e.name.replace(/\s+\(\d+\)$/, '')
      const row = out.get(name) ?? { hits: 0, total: 0 }
      row.hits += e.hits
      row.total += e.total
      out.set(name, row)
    }
  return out
}

// ── 1. THE TABLE COMES FROM THE DB, NOT FROM A NAME LIST ───────────────────────────────────

test('the pet-only family is read off targetType, and it is the family the log casts', () => {
  // Read rather than hand-listed, so a DB refresh cannot leave a stale copy behind. The four
  // spot-checks are the spells the two reported logs and the owner's own actually contain.
  assert.equal(PET_TARGET_SPELLS.size >= 30, true, `${PET_TARGET_SPELLS.size} pet-only spells`)
  for (const s of ['Burnout', 'Burnout III', 'Intensify Death', 'Focus Death', 'Renew Elements'])
    assert.equal(isPetOnlySpell(s), true, `${s} is pet-only`)
  // …and the ordinary spells that share those landing MESSAGES are not in it. This is the whole
  // reason the armed cast, not the message, is the gate: `goes berserk.` resolves to four spells
  // and only one of them is Burnout.
  for (const s of ['Fury', 'Rage', 'Voice of the Berserker', 'Greater Healing', 'Tashani'])
    assert.equal(isPetOnlySpell(s), false, `${s} must not be pet-only`)
})

// ── 2. THE GOLDEN WINDOW ───────────────────────────────────────────────────────────────────

test('P3: the fixture carries the upgrade it says it does', { skip }, () => {
  const has = (re: RegExp): number => P3.filter((l) => re.test(l)).length
  assert.equal(has(/\] Vebann told you, 'Attacking Lost Crusader Master\.'$/), 1)
  assert.equal(has(/\] You begin casting Haunting Corpse\.$/), 1)
  assert.equal(has(/\] You begin casting Intensify Death\.$/), 1)
  assert.equal(has(/\] Vabantik's eyes gleam with madness\.$/), 1)
  assert.equal(has(/\] Vabantik told you, 'Attacking an ogre guard Master\.'$/), 1)
  // No zone line — a zone would retire the world model out from under the succession.
  assert.equal(has(/\] You have entered /), 0)
})

test('P3: the buff binds the successor 149 SECONDS before its tell does', { skip }, () => {
  const { eng, lastTs } = replay(P3)
  const rows = petRows(eng, lastTs)
  assert.deepEqual([...rows.keys()].sort(), ['Vabantik', 'Vebann'])
  // The successor's whole working life in this window, because the bind lands 42 seconds before
  // its first swing. 81 hits / 1,411 points — the 76 melee lines the fixture's own extractor
  // counts, plus the damage-shield ticks the meter also books to the pet.
  assert.deepEqual(rows.get('Vabantik'), { hits: 81, total: 1411 })
  assert.deepEqual(eng.petDisplayNames(), ['Vabantik'])
})

test('P3: without the own cast it is the old behaviour — five hits, from the tell onward', { skip }, () => {
  // THE COUNTERFACTUAL, and the measurement of what this ticket is worth in this window. Drop the
  // one `You begin casting Intensify Death.` line and nothing is armed, so the landing is just a
  // sentence about somebody and the pet stays invisible until it is ordered at 21:12:31 — five
  // hits before the window ends. The rung recovers 76 hits / 1,307 points here.
  const noCast = P3.filter((l) => !/\] You begin casting Intensify Death\.$/.test(l))
  const { eng, lastTs } = replay(noCast)
  const rows = petRows(eng, lastTs)
  assert.deepEqual(rows.get('Vabantik'), { hits: 5, total: 104 })
  assert.deepEqual(eng.petDisplayNames(), ['Vabantik'], 'the tell still binds it, just far too late')
})

test('P3: the bind runs the JOS-54 succession — one pet at a time, the old row intact', { skip }, () => {
  // The successor's claim is what retires the predecessor, whichever of the three lines produced
  // it. RETIREMENT, NOT DELETION: Vebann keeps every point booked to it while it was yours.
  const { eng, lastTs } = replay(P3)
  assert.deepEqual(eng.petDisplayNames(), ['Vabantik'], 'Vebann is retired')
  assert.deepEqual(petRows(eng, lastTs).get('Vebann'), { hits: 14, total: 130 })
  // …and it costs this window nothing, because the game had already taken the pet away: Vebann
  // never swings again after the re-summon at 21:09:29.
  const after = P3.filter(
    (l) => /\] Vebann .* for \d+ points? of/.test(l) && l >= '[Sun Jul 19 21:09:29'
  )
  assert.equal(after.length, 0, 'no post-resummon predecessor swing exists to lose')
})

test('P3: the late tell is a REFRESH, not a second bind — no row splits', { skip }, () => {
  // `world.claim()` is idempotent and all three routes share it, so the tell that arrives 149 s
  // after the buff resolves to the same live instance. A second implementation would show up here
  // as two Vabantik rows or as a succession firing against itself.
  const { eng, lastTs } = replay(P3)
  const rows = petRows(eng, lastTs)
  assert.equal([...rows.keys()].filter((n) => n === 'Vabantik').length, 1)
  assert.deepEqual(eng.charmedPetNames(), [], 'a SUMMONED bind — class pets zone with you')
})

test('P3: binding the successor moves NO other number', { skip }, () => {
  // The design's promise as arithmetic: your own damage is byte-identical, and the segment total
  // grows by exactly the pet's own contribution.
  const before = replay(P3.filter((l) => !/\] You begin casting Intensify Death\.$/.test(l)))
  const after = replay(P3)
  const you = (r: { eng: CombatEngine; lastTs: number }): number => {
    const snap = r.eng.snapshot(r.lastTs + 120_000, { selectedId: 'zone' })
    return (snap.selected?.entities ?? []).filter((e) => e.kind === 'you').reduce((n, e) => n + e.total, 0)
  }
  assert.equal(you(after), you(before))
  const petTotal = (r: { eng: CombatEngine; lastTs: number }): number =>
    [...petRows(r.eng, r.lastTs).values()].reduce((n, v) => n + v.total, 0)
  assert.equal(petTotal(after) - petTotal(before), 1307)
})

// ── 3. THE MESSAGE IS NOT THE GATE ─────────────────────────────────────────────────────────

test('P1: a real landing with NO pet-only cast behind it binds nothing', { skip: skipP1 }, () => {
  // The negative control the repo already had and nobody had used: p1-unbound-pet.log carries
  // `Gtik's eyes gleam with madness.` one second after `You begin casting Color Skew.` — the
  // same landing sentence as the golden window's, with an unrelated spell behind it. The message
  // says only that SOMEBODY buffed somebody's pet, which is the JOS-49 lesson about `says` in a
  // different grammar, so it must bind nothing at all.
  assert.ok(P1.some((l) => /\] Gtik's eyes gleam with madness\.$/.test(l)))
  assert.ok(P1.some((l) => /\] You begin casting Color Skew\.$/.test(l)))
  const { eng } = replay(P1)
  assert.deepEqual(eng.petDisplayNames(), [], 'twenty minutes, one such landing, no pet')
})

const CAST = (t: string, spell: string): string => `[Sun Jul 19 ${t} 2026] You begin casting ${spell}.`
const GLEAM = (t: string, name: string): string => `[Sun Jul 19 ${t} 2026] ${name}'s eyes gleam with madness.`
const SWING = (t: string, name: string, n: number): string =>
  `[Sun Jul 19 ${t} 2026] ${name} pierces an ogre guard for ${n} points of damage.`

test('the pair binds, in the log shapes the fixture uses', () => {
  const { eng, lastTs } = replay([
    CAST('21:09:55', 'Intensify Death'),
    GLEAM('21:10:02', 'Vabantik'),
    SWING('21:10:44', 'Vabantik', 40)
  ])
  assert.deepEqual(eng.petDisplayNames(), ['Vabantik'])
  assert.deepEqual(petRows(eng, lastTs).get('Vabantik'), { hits: 1, total: 40 })
})

test('a landing whose candidates do NOT include the armed spell binds nothing', () => {
  // Cast Burnout, and inside its window a heal lands on somebody. `feels much better.` resolves
  // to a heal family that Burnout is not in, so the line did not resolve OUR cast. This is the
  // collision the whole `spellKeys.some(...)` test exists for: two pet-only spells share their
  // landing message with ordinary ones, and a window is 8 seconds wide.
  const { eng } = replay([
    CAST('21:09:55', 'Burnout'),
    `[Sun Jul 19 21:09:58 2026] Xxlmilkers feels much better.`,
    SWING('21:10:44', 'Xxlmilkers', 40)
  ])
  assert.deepEqual(eng.petDisplayNames(), [])
})

test('a landing OUTSIDE the arm window binds nothing', () => {
  // Intensify Death is a 6.5 s cast, so the window is 8 s (charmModel.CAST_SLACK_MS). A landing
  // nine seconds later is a different cast's business, and there is no second arm to catch it.
  const { eng } = replay([CAST('21:09:55', 'Intensify Death'), GLEAM('21:10:04', 'Vabantik')])
  assert.deepEqual(eng.petDisplayNames(), [])
})

test('a fizzle disarms — a cast that never resolved cannot be what a landing resolved', () => {
  const { eng } = replay([
    CAST('21:09:55', 'Intensify Death'),
    `[Sun Jul 19 21:09:56 2026] Your Intensify Death spell fizzles!`,
    GLEAM('21:10:02', 'Vabantik')
  ])
  assert.deepEqual(eng.petDisplayNames(), [])
})

test('a later unrelated cast disarms — you cast one spell at a time', () => {
  const { eng } = replay([
    CAST('21:09:55', 'Intensify Death'),
    CAST('21:09:57', 'Greater Healing'),
    GLEAM('21:10:02', 'Vabantik')
  ])
  assert.deepEqual(eng.petDisplayNames(), [])
})

test('ONE cast binds at most ONE entity — the arm is consumed', () => {
  // A pet spell is single-target, so a second landing in the same window is somebody else's.
  // (A Quick Buff burst prints eleven landings in one second; without this it would bind the
  // whole zone off one arm.)
  const { eng } = replay([
    CAST('21:09:55', 'Intensify Death'),
    GLEAM('21:10:01', 'Vabantik'),
    GLEAM('21:10:02', 'Gonekn')
  ])
  assert.deepEqual(eng.petDisplayNames(), ['Vabantik'])
})

test('a Quick Buff burst binds nothing — it prints landings and NO cast line', () => {
  // `You activate Quick Buff.` re-applies every memorized buff with no `You begin casting` for
  // any of them (AGENTS.md). Nothing arms, so the burst that lands on your pet every few minutes
  // cannot bind it — or anyone standing beside it.
  const { eng } = replay([
    `[Sun Jul 19 21:09:54 2026] You activate Quick Buff.`,
    GLEAM('21:09:57', 'Vabantik'),
    `[Sun Jul 19 21:09:57 2026] Xxlmilkers goes berserk.`
  ])
  assert.deepEqual(eng.petDisplayNames(), [])
})

test('a landing on YOURSELF is never a pet', () => {
  const { eng } = replay([CAST('21:09:55', 'Intensify Death'), GLEAM('21:10:02', 'Primitive')])
  assert.deepEqual(eng.petDisplayNames(), [])
})

// ── 4. IT IS THE SAME BIND, NOT A FOURTH MODEL ─────────────────────────────────────────────

test('a name a charm broadcast has named binds CHARMED, exactly as a tell would', () => {
  // The `everCharmed` PROMOTE rule (AGENTS.md): a claim from a name the zone has seen charmed
  // re-arms the charmed set, never the permanent one — a charmed mob must not be credited to you
  // forever. Sharing `bindPetClaim` is what makes this true here for free.
  const { eng } = replay([
    `[Sun Jul 19 21:09:50 2026] an ice giant has been charmed.`,
    CAST('21:09:55', 'Intensify Death'),
    `[Sun Jul 19 21:10:02 2026] an ice giant's eyes gleam with madness.`
  ])
  assert.deepEqual(eng.petDisplayNames(), ['an ice giant'])
  assert.deepEqual(eng.charmedPetNames(), ['an ice giant'], 'charmed, not summoned')
})

test('the buff bind retires a prior summoned pet, and a later tell for it does not undo that', () => {
  // The reporter's sequence in miniature: an ordered predecessor, an upgrade nobody announces,
  // and a successor named only by the buff. One pet at a time, whichever line did the binding.
  const { eng, lastTs } = replay([
    `[Sun Jul 19 21:06:26 2026] Vebann told you, 'Attacking Lost Crusader Master.'`,
    SWING('21:06:28', 'Vebann', 10),
    CAST('21:09:55', 'Intensify Death'),
    GLEAM('21:10:02', 'Vabantik'),
    SWING('21:10:44', 'Vabantik', 40),
    `[Sun Jul 19 21:12:31 2026] Vabantik told you, 'Attacking an ogre guard Master.'`,
    SWING('21:12:36', 'Vabantik', 20)
  ])
  assert.deepEqual(eng.petDisplayNames(), ['Vabantik'])
  const rows = petRows(eng, lastTs)
  assert.deepEqual(rows.get('Vebann'), { hits: 1, total: 10 })
  assert.deepEqual(rows.get('Vabantik'), { hits: 2, total: 60 })
})
