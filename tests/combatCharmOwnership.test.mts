// GOLDEN WINDOWS: a charm broadcast is not a deed of ownership (Task #65).
//
// TWO OWNER-REPORTED DEFECTS, one root cause. `<mob> has been charmed.` and
// `<mob> has been mesmerized.` are BROADCASTS — they are the spell DB's own
// `msg_cast_on_other` ("Someone has been charmed.") — so everyone in the zone sees them and
// none of them names a caster. The engine bound every charm line into `petNames` and opened a
// 120s CC hold on every mez line, which meant:
//
//   1. ANOTHER PLAYER'S PET became yours, permanently (the only unbind was
//      `Your <spell> spell has worn off of <mob>`, which is own-cast-only).
//   2. That foreign pet's TARGET — a PLAYER — entered `enc.engaged` as a hostile, where his
//      self-heals were booked as enemy healing and kept refreshing his own presence, so the
//      pull could never death-close and swallowed the owner's next pulls whole.
//
// Fixed by src/main/combat/charmModel.ts (ownership by own-cast correlation; its header
// carries the whole-log measurements), the known-player + engage discipline in routing.ts,
// and the hold/fallback split in lifecycle.evalClosure.
//
// The pure state-machine half of these rules is unit-tested in tests/charmModel.test.mts.
// Regenerate the fixtures with `npm run fixtures:combat -- <path to the real log>`.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { parseEvent } from '../src/main/log/parser'
import { CombatEngine } from '../src/main/combat/engine'
import type { SegmentSummary } from '../src/shared/combat'

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), 'fixtures')
const read = (name: string): string[] => {
  const p = join(FIXTURES, name)
  return existsSync(p) ? readFileSync(p, 'utf8').split(/\r?\n/).filter((l) => l.length > 0) : []
}
const W44 = read('w44-foreign-charm-player-hostile.log')
const W45 = read('w45-owner-charm-bind.log')

const AUG4 = (clock: string): number => Date.parse(`Tue Aug 04 ${clock} 2026`)

/** Replay through the real parser + engine. `pollLagMs` models the live app polling
 *  snapshot(Date.now()) while the tailer is still catching up (the tick race). */
function replay(lines: string[], pollLagMs = 0): { eng: CombatEngine; lastTs: number } {
  const eng = new CombatEngine()
  // LIVE FROM THE START, because that is the only state anybody ever LOOKS at a meter in, and
  // since JOS-208 phase 4 it is also the only state the wall-clock closure sweep runs in: a
  // replay is not a moment in time, so `snapshot(now)` no longer finalizes a fight while the
  // historical fold is still reading (engine.ts). Every window below asks what the meter shows
  // after its span, which is a live question; the poll-lag arms model the live tick race and
  // still exercise it.
  eng.setLive()
  eng.setPlayerName('Primitive')
  let seq = 0
  let lastTs = 0
  for (const raw of lines) {
    const ev = parseEvent(raw, seq++)
    if (!ev) continue
    eng.ingestEvent(ev, false)
    lastTs = ev.ts
    if (pollLagMs > 0) eng.snapshot(ev.ts + pollLagMs, {})
  }
  return { eng, lastTs }
}

const fights = (eng: CombatEngine, lastTs: number): SegmentSummary[] =>
  eng
    .snapshot(lastTs + 120_000, {})
    .segments.filter((s) => s.kind === 'fight')
    .reverse()

// ============================================================================
// W44 — THE FOREIGN CHARM. tests/fixtures/w44-foreign-charm-player-hostile.log, raw log
// 1256800..1259658 (Tue Aug 04 16:58:32 → 17:05:08), extracted verbatim.
//
// Hand-read: the player Scooba charms `a Knight of Innoruuk` (16:59:27) and `an elite
// dragoon` (16:59:43) with Allure VII and AE-mezzes two mobs with Mesmerization VI
// (16:59:35); the owner is idle throughout (his previous swing was at 16:48:45) and casts no
// charm or CC spell anywhere in the window. He then pulls three times: a Disciple of Innoruuk
// (17:00:55 → slain 17:01:39), a Champion of Innoruuk (17:01:43 → slain 17:03:09) and a
// second Champion (17:03:23 → slain 17:05:08).
//
// MEASURED PRE-FIX (this exact fixture, engine at 5f4e2bd):
//   pets                 [a Knight of Innoruuk, an elite dragoon]  ← both a stranger's
//   foreign pet damage   10,016 over 91 hits (dragon 8,570/72, knight 1,446/19)
//   enemy healing        1,840  ← Scooba's four self-heals, 17:00:10–17:00:33
//   fights               2, the first being "a Champion of Innoruuk +3", 214s, 47,853
//                        — the Scooba brawl and TWO of the owner's pulls in one segment.
//
// ─────────────────────────────────────────────────────────────────────────────
// THE LAW CHANGED HERE, AND THIS BLOCK IS WHERE IT IS WRITTEN DOWN (JOS-250).
//
// Task #65's answer was "a stranger's charm binds NOTHING", and that was the right answer to the
// question it could answer. JOS-250 answers a bigger one: `Scooba begins casting Allure VII.` is
// in this very fixture, one second before each broadcast, and it NAMES THE CHARMER. So the pet is
// attributable — to SCOOBA. What must never happen is the thing this window originally caught,
// and the assertions below now state it as a positive rather than as an absence: not one point of
// it reaches YOUR row, your fights, your engaged set or your closure clock.
//
// MEASURED POST-JOS-250 on this exact fixture, and the split is exact:
//   you                   64,102 over 876 hits — BYTE-IDENTICAL to the Task #65 engine.
//   a Knight of Innoruuk  bound 16:59:27, UNBOUND 16:59:29 by
//                         `A Knight of Innoruuk tries to punch Scooba, but misses!` — two
//                         seconds, zero damage credited. Its pre-fix 1,446 points are still
//                         gone, now for a reason the log states rather than by refusing to look.
//   an elite dragoon      bound 16:59:43 and never turns on anybody friendly, so all 8,570
//                         points over 72 hits (and 47 misses) go to `Pet (an elite dragoon) -
//                         Scooba`. That is the WHOLE of the pre-fix dragoon figure: the honest
//                         part of the 10,016 was always real damage by a real pet with a real
//                         owner; only the owner was wrong.
//   zone outTotal         72,672 = 64,102 + 8,570.
//   fights                unchanged in every respect (see the segmentation test below).
// ============================================================================

for (const lag of [0, 6_000]) {
  const label = lag === 0 ? 'plain replay' : 'with a 6s snapshot-poll lag'

  test(`W44 (${label}): a stranger's charm binds nothing OF YOURS`, { skip: W44.length === 0 && 'fixture not present' }, () => {
    const { eng } = replay(W44, lag)
    assert.deepEqual(eng.petDisplayNames(), [], 'no pet of YOURS was ever bound in this window')
    assert.deepEqual(eng.charmedPetNames(), [], 'and your charm roster is empty')
    // …while the ALLY roster holds the one bind that survived its own soft-hostile proof. The
    // Knight is absent from it because the Knight turned on Scooba two seconds in.
    assert.deepEqual(eng.allyPetNames(), ['an elite dragoon'], "Scooba's pet, bound to Scooba")
  })

  test(`W44 (${label}): the ally pet's damage is Scooba's, and YOUR row is byte-identical`, { skip: W44.length === 0 && 'fixture not present' }, () => {
    const { eng, lastTs } = replay(W44, lag)
    const sel = eng.snapshot(lastTs + 120_000, { selectedId: 'zone' }).selected!
    // THE ORIGINAL ASSERTION, UNCHANGED AND STILL THE POINT: none of this is yours. `kind: 'pet'`
    // is the attribution set the meter nests inside your breakdown, and a stranger's pet is not
    // in it — not before JOS-250 and not after.
    assert.equal(sel.entities.filter((e) => e.kind === 'pet').length, 0, 'no pet source row of yours exists')
    const you = sel.entities.find((e) => e.id === 'you')!
    assert.equal(you.total, 64_102, "the pre-JOS-250 figure, to the point — your row cannot move")
    assert.equal(you.hits, 876)

    const ally = sel.entities.filter((e) => e.kind === 'allyPet')
    assert.equal(ally.length, 1, 'one ally pet survived its own break test')
    assert.equal(ally[0].id, 'allypet:scooba:an elite dragoon', 'keyed by CHARMER then pet')
    assert.equal(ally[0].name, 'Pet (an elite dragoon) - Scooba')
    assert.equal(ally[0].total, 8_570)
    assert.equal(ally[0].hits, 72)
    assert.equal(ally[0].misses, 47)
    // AND THE CHARMER HIMSELF HAS A ROW NOW (JOS-430). Scooba is a combatant the log named and no
    // model of ours claims, so his own swings at his own mobs are recorded as `other` — which is
    // the owner's 2026-08-20 ruling in one row. It costs the two figures above nothing: the
    // ally-pet bind is still the ally model's, and your 64,102 is still to the point.
    const scooba = sel.entities.filter((e) => e.kind === 'other')
    assert.equal(scooba.length, 1)
    assert.equal(scooba[0].id, 'member:scooba', 'the same id a group-mate would have — one person, one row')
    assert.equal(scooba[0].total, 8_725)
    assert.equal(sel.outTotal, 81_397, 'you 64,102 + his pet 8,570 + the man himself 8,725')

    // THE KNIGHT IS THE SOFT-HOSTILE PROOF, and its whole contribution is the assertion: it was
    // bound for two seconds and landed nothing in them.
    assert.ok(!ally.some((e) => /knight/i.test(e.name)), 'the Knight turned on its charmer and stopped counting')

    // Law 8 tripwire: the category partition still re-sums exactly, on every row including the
    // new kind.
    for (const e of [...sel.entities, ...sel.incoming]) {
      assert.equal(e.categories.reduce((n, c) => n + c.total, 0), e.total, `${e.name}: category sum == total`)
    }
  })

  test(`W44 (${label}): the PLAYER Scooba is never YOURS, never a hostile and never a healer`, { skip: W44.length === 0 && 'fixture not present' }, () => {
    const { eng, lastTs } = replay(W44, lag)
    const ids = [...fights(eng, lastTs).map((f) => f.id), 'zone']
    for (const id of ids) {
      const snap = eng.snapshot(lastTs + 120_000, { selectedId: id, timeline: true })
      const sel = snap.selected!
      // THE ORIGINAL ASSERTION, RE-EXPRESSED TWICE NOW. JOS-250 made Scooba's NAME appear inside
      // the label of the row his pet earned; JOS-430 gives him a row of his OWN, as `other`. Both
      // are the feature. What has never been allowed, and still is not, is Scooba being one of
      // OURS or one of THEIRS: no `you`/`pet`/`member` row, no entry in the incoming list, no
      // instant aimed at him, no enemy healing credited to him.
      for (const e of sel.entities) {
        const named = e.kind === 'allyPet' || e.kind === 'other'
        assert.ok(!/scooba/i.test(e.name) || named, `${id}: Scooba is not one of yours (${e.kind} ${e.name})`)
      }
      for (const e of sel.incoming) {
        assert.ok(!/scooba/i.test(e.name), `${id}: Scooba is never something that hits you`)
      }
      assert.equal(sel.enemyHealTotal, 0, `${id}: a player's self-heals are not enemy healing`)
      for (const ev of snap.timeline?.events ?? []) {
        assert.ok(!/scooba/i.test(ev.target ?? ''), `${id}: no instant is aimed at a player`)
      }
    }
  })

  test(`W44 (${label}): the ally pet never opens, joins or extends one of YOUR fights`, { skip: W44.length === 0 && 'fixture not present' }, () => {
    // The 214-second merged pull, re-asserted under the new law. Every point the ally pet earned
    // in this window lands before the owner's first swing, so it belongs to the zone lane and to
    // nothing else — which is exactly the miss/resist rule (world-model law 8) applied to a
    // fifth source kind. If an ally pet could open an encounter, this sum would move.
    const { eng, lastTs } = replay(W44, lag)
    const fs = fights(eng, lastTs)
    assert.equal(fs.reduce((n, f) => n + f.total, 0), 64_102, 'the fights hold only the owner')
    for (const f of fs) {
      const sel = eng.snapshot(lastTs + 120_000, { selectedId: f.id }).selected!
      assert.equal(sel.entities.filter((e) => e.kind === 'allyPet').length, 0, `${f.name}: no ally row`)
    }
  })

  test(`W44 (${label}): no fight begins before the owner's own first swing`, { skip: W44.length === 0 && 'fixture not present' }, () => {
    const { eng, lastTs } = replay(W44, lag)
    const fs = fights(eng, lastTs)
    // THE regression pin, and the one assertion that holds under either clock: pre-fix the
    // first segment opened at 16:59:35 — on Scooba's brawl, ninety seconds before the owner
    // touched anything — because a foreign pet's damage opened an encounter for us.
    assert.equal(fs[0].startTs, AUG4('17:00:55'), 'the owner\'s first hit, not a stranger\'s')
    assert.equal(fs.reduce((n, f) => n + f.total, 0), 64_102, 'and the fights hold every point of it')

    // The LAST pull is separated by the 14s gap after the first Champion dies — a gap that
    // could only ever close a fight once Scooba stopped vetoing the death-close.
    const lastFight = fs[fs.length - 1]
    assert.equal(lastFight.name, 'a Champion of Innoruuk (2)')
    assert.equal(lastFight.startTs, AUG4('17:03:23'))
    assert.equal(lastFight.durationSec, 105, '17:03:23 → 17:05:08')
    assert.equal(lastFight.total, 26_265)
  })
}

test('W44: the Disciple and the first Champion are ONE pull on a pure replay', { skip: W44.length === 0 && 'fixture not present' }, () => {
  // The Disciple's last damage is 17:01:39 and the Champion's first is 17:01:43 — a 4s gap,
  // INSIDE the 5s death-linger, which law 7 says is one continuous pull (the same rule W29's
  // back-to-back pulls are pinned on). Asserted on the pure replay only: with a 6s poll lag
  // the wall clock outruns the linger while the tailer is still buffering, so the pair splits
  // into "a Disciple of Innoruuk" (11,574) + "a Champion of Innoruuk" (26,263). That race is
  // the death-linger's pre-existing behavior for any sub-linger gap — pre-fix the same lag
  // produced the same split, just with the whole Scooba brawl fused onto the front of it
  // ("a Disciple of Innoruuk +2", 21,590, opening at 16:59:35).
  const { eng, lastTs } = replay(W44)
  const fs = fights(eng, lastTs)
  assert.equal(fs.length, 2)
  assert.equal(fs[0].name, 'a Champion of Innoruuk +1', 'two targets, both the owner\'s')
  assert.equal(fs[0].durationSec, 134, '17:00:55 → 17:03:09')
  assert.equal(fs[0].total, 37_837)
})

test('W44: a foreign MEZ opens no hold and engages nothing', { skip: W44.length === 0 && 'fixture not present' }, () => {
  // Replay ONLY up to 16:59:50 — after Scooba's AE mez (three broadcasts, 16:59:35–16:59:43)
  // and before the owner's first pull. Pre-fix each of those lines engaged its mob and opened
  // a 120-second hold on an encounter the owner was not in.
  const upTo = AUG4('16:59:50')
  const { eng } = replay(W44.filter((l) => (parseEvent(l, 0)?.ts ?? 0) <= upTo))
  const snap = eng.snapshot(upTo, {})
  assert.equal(snap.segments.filter((s) => s.kind === 'current').length, 0, 'no encounter was opened')
  assert.equal(snap.segments.filter((s) => s.kind === 'fight').length, 0, 'and none was finalized')
  assert.equal(snap.inCombat, false)
})

// ============================================================================
// W45 — THE OWNER'S OWN CHARM. tests/fixtures/w45-owner-charm-bind.log, raw log
// 213988..214240 (Tue Jul 28 16:47:14 → 16:49:12), extracted verbatim from the owner's
// enchanter epoch. The positive control: everything above must not cost a single real bind.
//
// Hand-read beats (and the arm-window measurements they anchor):
//   16:47:33  `You begin casting Charm.`  → 16:47:35 `a kodiak has been charmed.`  (+2s)
//   16:47:41  `Your Charm spell has worn off of a kodiak.` — bound and unbound inside 6s,
//             with NO pet damage and NO Master tell in between.
//   16:48:00  `You begin casting Charm.`  → 16:48:03 `a kodiak has been charmed.`  (+3s,
//             which is why the window is castTime+slack and not a flat 2s)
//   16:48:05  `A kodiak told you, 'Attacking a Dervish Cutthroat Master.'` — corroboration.
//   then      the pet kills a Dervish Cutthroat and a black bear and tanks an orc legionnaire.
//
// HAND-COUNTED pet damage from the fixture: 67 over 8 hits in the Cutthroat fight
// (22+6+3+10+15+1+9+1) and 196 over 15 in the legionnaire/bear fight = 263 over 23.
// These totals are BYTE-IDENTICAL to the pre-fix engine — that is the point of this window.
// ============================================================================

test('W45: the owner\'s own charm still binds, and the pet still attributes', { skip: W45.length === 0 && 'fixture not present' }, () => {
  const { eng, lastTs } = replay(W45)
  assert.deepEqual(eng.charmedPetNames(), ['a kodiak'], 'bound by an own-cast-correlated broadcast')
  const sel = eng.snapshot(lastTs + 120_000, { selectedId: 'zone' }).selected!
  const pet = sel.entities.find((e) => e.kind === 'pet')
  assert.ok(pet, 'the charmed kodiak is a pet source row')
  assert.match(pet!.name, /kodiak/i)
  assert.equal(pet!.total, 263, 'hand-counted pet damage — unchanged by the gating')
  assert.equal(pet!.hits, 23)
  assert.equal(pet!.misses, 9)
  assert.equal(sel.entities.find((e) => e.id === 'you')!.total, 706)
  // 969 = 706 + 263, and both halves are still exactly what they were. The segment total is 1,026
  // because two bystanders in the same zone — Rekt (32) and Fickle (25) — are recorded now
  // (JOS-430); neither is yours, neither is a pet, and neither moves the two numbers above.
  assert.deepEqual(
    sel.entities.filter((e) => e.kind === 'other').map((e) => `${e.name}|${String(e.total)}`).sort(),
    ['Fickle|25', 'Rekt|32']
  )
  assert.equal(sel.outTotal, 1_026, '706 + 263 + 57 of other people\'s')
})

test('W45: the SHORT-LIVED first bind is real, then its own wear-off releases it', { skip: W45.length === 0 && 'fixture not present' }, () => {
  const upTo = (clock: string): number => Date.parse(`Tue Jul 28 ${clock} 2026`)
  const through = (clock: string): CombatEngine =>
    replay(W45.filter((l) => (parseEvent(l, 0)?.ts ?? 0) <= upTo(clock))).eng

  // 16:47:35 the charm lands (2s after `You begin casting Charm.`). It draws no Master tell
  // and lands no pet damage before it breaks — the measured 8% of owner charms that produce
  // nothing at all — so corroboration may gate DEMOTION but must never gate the BIND itself.
  assert.deepEqual(through('16:47:38').charmedPetNames(), ['a kodiak'], 'bound on the cast alone')
  // 16:47:41 `Your Charm spell has worn off of a kodiak.` — only the caster sees this line,
  // so it is both the release AND retroactive proof the bind was ours.
  assert.deepEqual(through('16:47:50').charmedPetNames(), [], 'released by its own wear-off')
  // 16:48:03 re-charmed, 16:48:05 corroborated by the pet's own `… Master.' tell.
  assert.deepEqual(through('16:48:10').charmedPetNames(), ['a kodiak'], 'and bound again')
})

test('W45: fight SEGMENTATION is byte-identical, and only recorded bystanders moved a total', { skip: W45.length === 0 && 'fixture not present' }, () => {
  const { eng, lastTs } = replay(W45)
  const fs = fights(eng, lastTs)
  assert.equal(fs.length, 2, 'two fights, exactly as before — nothing new may OPEN or MERGE one')
  assert.equal(fs[0].name, 'a Dervish Cutthroat')
  assert.equal(fs[1].name, 'an orc legionnaire +2')
  // 380 → 388 and 589 → 614: the two bystanders landed 8 and 25 of their own INSIDE these two
  // fights' windows, and a recorded combatant's damage attaches to an ALREADY-OPEN fight the way
  // an ally pet's does (world-model law 8's rule — it may join, never open or extend). Their zone
  // total is 57, so 24 of it fell outside both fights and lives in the zone lane alone — which is
  // the same accounting a miss out of combat gets, and the proof that no fight was stretched to
  // reach it.
  assert.equal(fs[0].total, 388)
  assert.equal(fs[1].total, 614)
  const yours = (id: string): number =>
    (eng.snapshot(lastTs + 120_000, { selectedId: id }).selected?.entities ?? [])
      .filter((e) => e.kind === 'you' || e.kind === 'pet')
      .reduce((n, e) => n + e.total, 0)
  assert.equal(yours(fs[0].id) + yours(fs[1].id), 969, 'you + your pet: the pre-fix 380 + 589')
})
