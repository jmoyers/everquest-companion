// EVERYONE MEANS ANY FIGHT THE LOG CAN SEE (JOS-430 — owner ruling 2026-08-20).
//
// THE REPORTS. 01KZT5PBDQHMNMD68SJBMKD3V1: "Player NYANAKO missing from Combat log but shows up in
// eqlog, both with group and everyone setting." 01KZVK0T3H2BAD5G2KJS8VZYYX: a group member's spell
// damage books nothing while her charm pet books fine. 01M022Y1BZBW9XHE31PWEJ0F07 and
// 01M015KSNDJ9T5Q4NZFWK2MJM4 say the same with logs attached; a YouTube commenter (k1tn1031) saw a
// raid meter showing 5-6 of 8 raiders.
//
// THE MECHANISM, from JOS-243's characterization: ADMISSION GATED RECORDING. `classify()`'s last
// rule was "attacker not you/pet, target not you → ignore", so with an empty roster snapshot the
// engine recorded nobody but you and your pet — and "Everyone" cannot show what nothing recorded.
// The owner's ruling selects the structural alternative that characterization named, which is also
// the two-decade-proven shape from classic EQ (JOS-243's market survey: EQLogParser and GamParse
// both record everything and filter at display): RECORD every player-vs-mob row, SCOPE at display.
//
// WHAT THIS FILE PINS, in four parts:
//   1. THE LADDER — every refusal that keeps the meter from booking an NPC as a combatant, each
//      stated against the rung it protects. src/main/combat/otherCombatants.ts carries the
//      argument and the whole-log measurements; this is where they are held.
//   2. THE DISCIPLINE — a recorded row is aggregate-only. It opens no fight, engages nothing,
//      enters no target list and never appears as incoming. Task #65's 214-second merged pull is
//      what that discipline costs when it is missing.
//   3. THE RETRACTION — the charm/pet model stays authoritative: when it claims a name, the row
//      the ladder booked goes away rather than standing beside the pet's own.
//   4. THE SCOPES — Everyone shows every recorded combatant, Group still filters by the roster,
//      You still shows only you and your pets.
//
// THE FIXTURES ARE THE OWNER'S OWN BYTES. A reporter's slice never becomes a fixture (AGENTS.md,
// .gitignore `.triage/`), and it does not need to here: the owner's committed windows are full of
// strangers fighting mobs beside him — Scooba in w44, Rekt and Fickle in w45, Rykkerr before his
// join line in g1. The two sentences the REPORTERS' logs carry and the owner's do not are INJECTED
// in part 5, quoted verbatim by report id with the mob's name swapped for one this corpus knows —
// the petClaimWindows / mobLifetapPlayer precedent.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { parseEvent } from '../src/main/log/parser'
import { installCharacterName, installSpellDb } from '../src/main/log/rulesets'
import { loadSpellDb } from '../src/main/data/spellDb'
import { CombatEngine } from '../src/main/combat/engine'
import { EngineState } from '../src/main/combat/state'
import { ingestEvent } from '../src/main/combat/ingest'
import { RosterModule } from '../src/main/modules/roster'
import { scopeSources } from '../src/renderer/src/features/combat/meterScope'
import { EMPTY_ROSTER, scopeAllows } from '../src/shared/roster'
import type { RosterSnap } from '../src/shared/roster'
import type { SegmentView, SourceView } from '../src/shared/combat'

installSpellDb(loadSpellDb())
installCharacterName('Primitive')

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), 'fixtures')
const read = (name: string): string[] => {
  const p = join(FIXTURES, name)
  return existsSync(p) ? readFileSync(p, 'utf8').split(/\r?\n/).filter((l) => l.length > 0) : []
}

/** Scooba fights his own mobs for ninety seconds before the owner touches anything. */
const W44 = read('w44-foreign-charm-player-hostile.log')
/** Rekt and Fickle swing beside the owner while he charms a kodiak. */
const W45 = read('w45-owner-charm-bind.log')
/** Rykkerr, two minutes before the join line that makes him a group-mate. */
const G1 = read('g1-group-lifecycle.log')

interface Replayed {
  eng: CombatEngine
  mod: RosterModule
  lastTs: number
}

/** Replay through the real parser + engine + roster module, wired the way pipeline.ts wires them
 *  (modules fold first, engine second). */
function replay(lines: string[]): Replayed {
  const eng = new CombatEngine()
  const mod = new RosterModule()
  mod.reset()
  eng.setPlayerName('Primitive')
  eng.setRoster(mod)
  let lastTs = 0
  let seq = 0
  for (const raw of lines) {
    const ev = parseEvent(raw, seq++)
    if (!ev) continue
    mod.onEvent(ev)
    eng.ingestEvent(ev, false)
    lastTs = ev.ts
  }
  return { eng, mod, lastTs }
}

/** The same fold into a RAW `EngineState`, so a test can read `enc.engaged` — the set part 2 is
 *  about, which no snapshot field exposes. groupRoster.test.mts's `replayState` is the precedent. */
function replayState(lines: string[]): { st: EngineState; lastTs: number } {
  const st = new EngineState()
  const mod = new RosterModule()
  mod.reset()
  st.setPlayerName('Primitive')
  st.rosterProvider = () => mod.view()
  st.rosterSnapProvider = () => mod.snap()
  let lastTs = 0
  let seq = 0
  for (const raw of lines) {
    const ev = parseEvent(raw, seq++)
    if (!ev) continue
    mod.onEvent(ev)
    ingestEvent(st, ev, false)
    lastTs = ev.ts
  }
  return { st, lastTs }
}

const zone = (r: Replayed): SegmentView =>
  r.eng.snapshot(r.lastTs + 300_000, { selectedId: 'zone' }).selected as SegmentView

const rows = (r: Replayed): SourceView[] => zone(r).entities
const others = (r: Replayed): string[] =>
  rows(r).filter((e) => e.kind === 'other').map((e) => e.name).sort()

// ============================================================================
// 1. THE LADDER — who gets recorded, and every refusal that keeps an NPC out
// ============================================================================

test('the reported bug: a stranger fighting mobs beside you is recorded, with no roster at all', () => {
  // w44 is ninety seconds of Scooba brawling before the owner swings once. Under the old law the
  // meter saw none of it; a user looking at Everyone saw one bar and reported the app broken.
  const r = replay(W44)
  assert.equal(r.mod.snap().seen, false, 'no group signal exists in this window — the empty roster')
  assert.deepEqual(others(r), ['Scooba'])
  const scooba = rows(r).find((e) => e.kind === 'other')
  assert.ok(scooba)
  assert.equal(scooba.id, 'member:scooba', 'one id namespace with a group-mate — see part 4')
  assert.equal(scooba.total, 8_725)
})

test('an ARTICLE-LED name is never recorded, whatever it is doing', () => {
  // The mob-name marker EQ prints, and the cheapest rung in the ladder. w44 is wall-to-wall
  // mob-vs-mob traffic — a charmed dragoon, an elite Knight, everything they fight — and not one
  // line of it may reach a row of its own.
  const r = replay(W44)
  for (const e of rows(r)) {
    if (e.kind !== 'other') continue
    assert.ok(!/^(a|an|the)\s/i.test(e.name), `an article-led name was recorded: ${e.name}`)
  }
  // …and the mobs by name, so the assertion is about these bytes rather than about a regex.
  const names = others(r).join('|').toLowerCase()
  assert.ok(!names.includes('dragoon') && !names.includes('knight'))
})

test('SELF-DAMAGE is not a fight: `X hit X` books nothing and proves nothing', () => {
  // MEASURED, and it is why the rung exists: the JOS-243 slice carries
  // `Vektik hit Vektik for 6 points of magic damage by Lifespike.` — a lifetap resolving on its
  // own caster — sixty-odd times. Booking it would credit a man for hitting himself, and reading
  // it as "he attacked one of ours" (he is one of ours) would then disqualify him outright. The
  // name below is the owner's own corpus; the SHAPE is the reporter's, quoted from that slice.
  const st = new EngineState()
  st.setPlayerName('Primitive')
  const lines = [
    '[Sun Jul 19 15:00:00 2026] Rekt hit Rekt for 6 points of magic damage by Lifespike.',
    '[Sun Jul 19 15:00:02 2026] Rekt slashes a kodiak for 40 points of damage.'
  ]
  let seq = 0
  for (const raw of lines) {
    const ev = parseEvent(raw, seq++)
    if (ev) ingestEvent(st, ev, false)
  }
  const row = st.zoneAgg.out.get('member:rekt')
  assert.ok(row, 'the swing at the kodiak IS recorded')
  assert.equal(row.total, 40, 'and the self-hit is not in it')
})

test('a name that LANDED DAMAGE ON YOU is a hostile, and never a recorded combatant', () => {
  // THE ONE RUNG THAT IS NOT BORROWED FROM AN EXISTING GUARD, so it is the one that was measured:
  // over the owner's 2,192,988-line log it fires for 24 names and every one is a real
  // single-word-named mob (Najena, Drelzna, Lockjaw, Gorgalosk, Phoboplasm, Bzzazzt, Terror,
  // Fright, Dread, Xicotl, …) — zero players. The WIDER version ("it hit anything of ours") was
  // measured WRONG on the same log: it marked 59 real players as mobs, because other people in
  // the zone attack the mob YOU have charmed. Both numbers are in otherCombatants.ts.
  const st = new EngineState()
  st.setPlayerName('Primitive')
  const lines = [
    '[Sun Jul 19 15:00:00 2026] Drelzna hits a kodiak for 100 points of damage.',
    '[Sun Jul 19 15:00:01 2026] Drelzna hits YOU for 55 points of damage.',
    '[Sun Jul 19 15:00:02 2026] Drelzna hits a kodiak for 100 points of damage.'
  ]
  let seq = 0
  for (const raw of lines) {
    const ev = parseEvent(raw, seq++)
    if (ev) ingestEvent(st, ev, false)
  }
  assert.equal(st.others.isHostile('drelzna'), true, 'the swing at you settled what it is')
  assert.equal(st.zoneAgg.out.get('member:drelzna')?.total, 100, 'only the line BEFORE the proof')
  // FORWARD-ONLY, exactly like world-model law 4's `everStruck` refusal: what was recorded before
  // the evidence arrived is not un-recorded. The alternative — retracting on hostility — was
  // rejected for the reason law 4 gives ("the refusal never RETIRES a filing the heal got in ahead
  // of"), and part 3 below is the ONE kind of proof that does retract.
})

test('…and a HEAL ON YOU outranks a swing at you', () => {
  // Law 4's own counterexample: a raid boss mind-controls your healer and she hits you 27 seconds
  // before she heals you (`Sonista slashes YOU`, then `Sonista healed you for 1219`). A mob cannot
  // heal the owner, so the heal is the line with a person behind it and it un-marks the name.
  const st = new EngineState()
  st.setPlayerName('Primitive')
  const lines = [
    '[Sun Jul 19 15:00:00 2026] Rekt hits YOU for 5 points of damage.',
    '[Sun Jul 19 15:00:27 2026] Rekt healed you for 1219 hit points by Healing Light.',
    '[Sun Jul 19 15:00:30 2026] Rekt slashes a kodiak for 70 points of damage.'
  ]
  let seq = 0
  for (const raw of lines) {
    const ev = parseEvent(raw, seq++)
    if (ev) ingestEvent(st, ev, false)
  }
  assert.equal(st.others.isHostile('rekt'), false, 'the heal cleared the mark')
  assert.equal(st.knownPlayers.has('rekt'), true)
  assert.equal(st.zoneAgg.out.get('member:rekt')?.total, 70, 'and he is recorded again afterwards')
})

test('a name YOU have been killing is never recorded, however it is spelled', () => {
  // world-model law 4 / JOS-48's `everStruck`, borrowed whole: your own swing is the one signal
  // with a person behind it, and a single-word proper-named boss is exactly what the name-shape
  // test cannot refuse on its own.
  const st = new EngineState()
  st.setPlayerName('Primitive')
  const lines = [
    '[Sun Jul 19 15:00:00 2026] You slash Innoruuk for 200 points of damage.',
    '[Sun Jul 19 15:00:01 2026] Innoruuk hits a kodiak for 300 points of damage.'
  ]
  let seq = 0
  for (const raw of lines) {
    const ev = parseEvent(raw, seq++)
    if (ev) ingestEvent(st, ev, false)
  }
  assert.equal(st.everStruck.has('innoruuk'), true)
  assert.equal(st.zoneAgg.out.has('member:innoruuk'), false, 'a boss you are fighting has no bar')
})

test('a combatant swinging at ONE OF OURS is dropped, never booked and never filed as incoming', () => {
  // The same rule `memberAttacker` has always applied to a group-mate's stray damage-shield tick:
  // the incoming meter answers "what is hitting ME", which in this game means hostiles, and a
  // friendly's swing at another friendly is not a fight this model has.
  const st = new EngineState()
  st.setPlayerName('Primitive')
  const lines = [
    '[Sun Jul 19 15:00:00 2026] Rekt slashes a kodiak for 40 points of damage.',
    '[Sun Jul 19 15:00:01 2026] Fickle slashes Rekt for 90 points of damage.'
  ]
  let seq = 0
  for (const raw of lines) {
    const ev = parseEvent(raw, seq++)
    if (ev) ingestEvent(st, ev, false)
  }
  assert.equal(st.zoneAgg.out.has('member:fickle'), false, 'the swing at a recorded combatant is dropped')
  assert.equal(st.zoneAgg.inc.size, 0, 'and it is nobody\'s incoming damage')
})

// ============================================================================
// 2. THE DISCIPLINE — a recorded row is aggregate-only
// ============================================================================
//
// Every omission below is Task #65's cautionary tale refusing to come back through a wider door:
// one friendly in `engaged` merged three of the owner's pulls into a single 214-second segment,
// because a player does not die on our schedule and nothing ever retires him.

test('a recorded combatant NEVER opens a fight of yours', () => {
  // w44's whole point, restated for the sixth source kind: Scooba's brawl runs for ninety seconds
  // before the owner's first swing at 17:00:55. If a recorded row could open an encounter, the
  // first segment would start on somebody else's fight — which is the exact pre-JOS-250 defect.
  const r = replay(W44)
  const segs = r.eng.snapshot(r.lastTs + 120_000, { maxSegments: 100_000 }).segments
  const fights = segs.filter((s) => s.kind === 'fight' || s.kind === 'current')
  assert.ok(fights.length > 0, 'the owner does fight in this window')
  const first = Math.min(...fights.map((s) => s.startTs))
  assert.equal(first, Date.parse('Tue Aug 04 17:00:55 2026'), 'his first hit, not a stranger\'s')
})

test('a recorded combatant never ENGAGES, is never a TARGET, and is never INCOMING', () => {
  const r = replay(W44)
  const { st } = replayState(W44)
  const engaged = [...(st.current?.engaged ?? []), ...st.history.flatMap((e) => [...e.engaged])]
    .join('|').toLowerCase()
  assert.ok(engaged.length > 0, 'the owner really did engage things in this window')
  assert.ok(!engaged.includes('scooba'), 'never a hostile of ours')
  const z = zone(r)
  assert.ok(!(z.targets ?? []).some((t) => /scooba/i.test(t.name)), 'never something we were fighting')
  assert.ok(!z.incoming.some((e) => /scooba/i.test(e.name)), 'never something that hits us')
})

test('law 8: recording everyone moves not one point of YOUR damage', () => {
  // The tripwire, on three real windows at once. Each figure is the pre-JOS-430 value, and each
  // comes from the test that already owned it (combatCharmOwnership W44/W45, groupRoster G1).
  const w44 = replay(W44)
  assert.equal(rows(w44).find((e) => e.id === 'you')?.total, 64_102)
  assert.equal(rows(w44).find((e) => e.kind === 'allyPet')?.total, 8_570)

  const w45 = replay(W45)
  assert.equal(rows(w45).find((e) => e.id === 'you')?.total, 706)
  assert.equal(rows(w45).find((e) => e.kind === 'pet')?.total, 263)

  // …and the category partition still re-sums exactly on every row, the new kind included.
  for (const r of [w44, w45, replay(G1)]) {
    for (const e of [...rows(r), ...zone(r).incoming]) {
      assert.equal(e.categories.reduce((n, c) => n + c.total, 0), e.total, `${e.name}: Σ categories == total`)
    }
  }
})

// ============================================================================
// 3. THE RETRACTION — the pet/charm model stays authoritative
// ============================================================================

test('a pet that swings before its binding line ends up with ONE row, its own', () => {
  // THE DOUBLE-COUNT THIS PREVENTS, measured on the owner's whole log: 53 of his own summoned pets
  // swung a few times before the `… Master.'` tell that binds them. Under a bare record-everything
  // rule each would have kept a second bar beside the pet's, which is world-model law 5's
  // "aggregates lie" failure with the same creature on both sides of it.
  const st = new EngineState()
  st.setPlayerName('Primitive')
  const lines = [
    '[Sun Jul 19 15:00:00 2026] Vebarn slashes a kodiak for 40 points of damage.',
    '[Sun Jul 19 15:00:01 2026] Vebarn slashes a kodiak for 60 points of damage.',
    "[Sun Jul 19 15:00:05 2026] Vebarn told you, 'Attacking a kodiak Master.'",
    '[Sun Jul 19 15:00:07 2026] Vebarn slashes a kodiak for 50 points of damage.'
  ]
  let seq = 0
  for (const raw of lines) {
    const ev = parseEvent(raw, seq++)
    if (ev) ingestEvent(st, ev, false)
  }
  assert.equal(st.zoneAgg.out.has('member:vebarn'), false, 'the ladder gave the row back')
  const pet = [...st.zoneAgg.out.entries()].filter(([id]) => id.startsWith('pet:'))
  assert.equal(pet.length, 1, 'exactly one row, and it is the pet\'s')
  assert.equal(pet[0][1].total, 50, 'from the bind onward — the tell is what makes it yours')
})

test('one of the six PET-VOICED SAYS settles a stranger\'s pet too', () => {
  // JOS-49 cut the question these sentences used to answer ("is this one YOURS?") and that stays
  // cut: a `says` line is broadcast and names no owner. What it proves is that the speaker is
  // SOMEBODY's pet, which is the one fact the ladder cannot get any other way — EQ spells a
  // summoned pet's name with the same one-word grammar it gives people. Measured on the owner's
  // whole log: 8 names no other rung reaches.
  const st = new EngineState()
  st.setPlayerName('Primitive')
  const lines = [
    '[Sun Jul 19 15:00:00 2026] Jenantik slashes a kodiak for 40 points of damage.',
    "[Sun Jul 19 15:00:03 2026] Jenantik says, 'Following you, Master.'",
    '[Sun Jul 19 15:00:05 2026] Jenantik slashes a kodiak for 40 points of damage.'
  ]
  let seq = 0
  for (const raw of lines) {
    const ev = parseEvent(raw, seq++)
    if (ev) ingestEvent(st, ev, false)
  }
  assert.equal(st.zoneAgg.out.has('member:jenantik'), false, 'not a person, and not a row')
  assert.equal(st.petNames.has('jenantik'), false, 'and emphatically not YOUR pet either')
})

test('a charm broadcast retracts the row, whoever cast it', () => {
  const st = new EngineState()
  st.setPlayerName('Primitive')
  const lines = [
    '[Sun Jul 19 15:00:00 2026] Grymloq slashes a kodiak for 40 points of damage.',
    '[Sun Jul 19 15:00:03 2026] Grymloq has been charmed.',
    '[Sun Jul 19 15:00:05 2026] Grymloq slashes a kodiak for 40 points of damage.'
  ]
  let seq = 0
  for (const raw of lines) {
    const ev = parseEvent(raw, seq++)
    if (ev) ingestEvent(st, ev, false)
  }
  assert.equal(st.zoneAgg.out.has('member:grymloq'), false)
  assert.equal(st.charm.everCharmed('grymloq'), true)
})

test('a ROSTER MEMBER is never retracted, even by a proof that would retract anyone else', () => {
  // The guard that matters most, because both retracting proofs can name a real group-mate: a raid
  // boss mind-controls one (`<mate> has been charmed.`), or your own AE catches one. Their row is
  // the roster's, not this ladder's, and deleting a group-mate's bar is exactly the
  // "a wrong roster can hide a row but never corrupt a number" promise inverted.
  const st = new EngineState()
  const mod = new RosterModule()
  mod.reset()
  st.setPlayerName('Primitive')
  st.rosterProvider = () => mod.view()
  st.rosterSnapProvider = () => mod.snap()
  const lines = [
    '[Sun Jul 19 15:00:00 2026] Rykkerr has joined the group.',
    '[Sun Jul 19 15:00:01 2026] Rykkerr slashes a kodiak for 40 points of damage.',
    '[Sun Jul 19 15:00:03 2026] Rykkerr has been charmed.'
  ]
  let seq = 0
  for (const raw of lines) {
    const ev = parseEvent(raw, seq++)
    if (!ev) continue
    mod.onEvent(ev)
    ingestEvent(st, ev, false)
  }
  assert.equal(st.zoneAgg.out.get('member:rykkerr')?.total, 40, 'the group-mate keeps his damage')
})

// ============================================================================
// 4. THE SCOPES — one row per person, and the roster decides what it is CALLED
// ============================================================================

test('a person recorded before the join and after it is ONE row, whose kind upgrades', () => {
  // g1 opens two minutes before `Rykkerr has joined the group.` with him already fighting the same
  // ghouls. Before JOS-430 that damage was thrown away and his row started at the join; now the
  // join RELABELS a row that already holds it. One id, one bar, one number.
  const r = replay(G1)
  const row = rows(r).find((e) => e.id === 'member:rykkerr')
  assert.ok(row)
  assert.equal(row.kind, 'member', 'the roster learned his name, so the row says so')

  // The same fixture cut at the join line: the identical row, still called `other`.
  const joinIdx = G1.findIndex((l) => l.includes('Rykkerr has joined the group.'))
  const before = replay(G1.slice(0, joinIdx))
  const early = rows(before).find((e) => e.id === 'member:rykkerr')
  assert.ok(early, 'recorded before anything named him')
  assert.equal(early.kind, 'other')
  assert.ok(row.total > early.total, 'and the later row contains the earlier one')
})

test('the kind never moves BACK when the group ends', () => {
  // g1 ends with the disband, which clears the roster's admission set. What this fight's damage WAS
  // does not change when the group ends, so `Agg.reid` upgrades `other` → `member` and stops.
  const r = replay(G1)
  assert.deepEqual(r.mod.snap().members, [], 'the window really does end disbanded')
  assert.equal(rows(r).find((e) => e.id === 'member:rykkerr')?.kind, 'member')
})

const withMembers = (keys: string[]): RosterSnap => ({
  members: keys.map((k) => ({ key: k, name: k, source: 'joined' as const, sinceTs: 0, lastConfirmedTs: 0, stale: false })),
  seen: true,
  lastSignalTs: 1
})

test('Everyone shows a recorded combatant; Group hides them; You hides them', () => {
  const roster = withMembers(['rykkerr'])
  assert.equal(scopeAllows('everyone', roster, 'other', 'scooba'), true)
  assert.equal(scopeAllows('group', roster, 'other', 'scooba'), false, 'not on the roster')
  assert.equal(scopeAllows('group', roster, 'other', 'rykkerr'), true, 'unless he is')
  assert.equal(scopeAllows('you', roster, 'other', 'scooba'), false)
  // Law 1 (unknown must not hide people): Group over an EMPTY roster still renders as Everyone.
  assert.equal(scopeAllows('group', EMPTY_ROSTER, 'other', 'scooba'), true)
})

test('the row filter both surfaces run agrees with the row rule', () => {
  // `scopeSources` is what the Combat tab and both overlays actually call; `scopeAllows` is what
  // the shared rule says. Two implementations of one question is how they come to disagree, so the
  // fixture rows go through the real filter here.
  const r = replay(W44)
  const all = rows(r)
  assert.ok(all.some((e) => e.kind === 'other'))
  assert.equal(scopeSources(all, 'everyone', EMPTY_ROSTER).length, all.length, 'Everyone filters nobody')
  const grouped = scopeSources(all, 'group', withMembers(['nobody']))
  assert.ok(!grouped.some((e) => e.kind === 'other'), 'Group is an allowlist and he is not on it')
  const mine = scopeSources(all, 'you', withMembers(['nobody']))
  assert.deepEqual(mine.map((e) => e.kind).sort(), ['you'], 'You is you and your pets')
})

// ============================================================================
// 5. THE REPORTERS' OWN SENTENCES, INJECTED
// ============================================================================
//
// A reporter's slice never becomes a fixture, so the two shapes their logs carry and the owner's
// does not are quoted VERBATIM here with the mob's name swapped for one this corpus knows — the
// precedent petClaimWindows set and mobLifetapPlayer needed. Both are the ACCEPTANCE case of
// JOS-430 stated as bytes: with zero group lines anywhere, both must book.

const INJECTED = [
  // 01KZT5PBDQHMNMD68SJBMKD3V1, quoted in the report itself (`a Tesch Mal Gnoll` → `a kodiak`).
  '[Sun Jul 19 15:00:00 2026] Nyanako bashes a kodiak for 72 points of damage.',
  '[Sun Jul 19 15:00:00 2026] Nyanako pierces a kodiak for 24 points of damage.',
  // …and the damage-shield line that lands ON her in the same second, which must stay a fact about
  // the GNOLL and never make her a hostile.
  '[Sun Jul 19 15:00:00 2026] Nyanako is burned by a kodiak\'s flames for 16 points of non-melee damage.',
  // 01KZVK0T3H2BAD5G2KJS8VZYYX, quoted on JOS-243 (`a forsaken revenant` → `a kodiak`). Her spell
  // damage books nothing today while her charm pet books fine — the member-spell-damage gap.
  '[Sun Jul 19 15:00:02 2026] A kodiak has taken 198 damage from Drifting Death by Arweena.',
  '[Sun Jul 19 15:00:03 2026] Arweena hit a kodiak for 115 points of magic damage by Gasping Embrace.'
]

test('ACCEPTANCE: with no roster and no group line, both reporters\' members book', () => {
  const st = new EngineState()
  st.setPlayerName('Primitive')
  let seq = 0
  for (const raw of INJECTED) {
    const ev = parseEvent(raw, seq++)
    assert.ok(ev, `line did not parse: ${raw}`)
    ingestEvent(st, ev, false)
  }
  assert.equal(st.zoneAgg.out.get('member:nyanako')?.total, 96, 'her melee: 72 + 24')
  assert.equal(st.zoneAgg.out.get('member:arweena')?.total, 313, 'her spell damage: 198 + 115')
  assert.equal(st.others.isHostile('nyanako'), false, 'a damage shield burning HER names the gnoll')
  assert.equal(st.zoneAgg.inc.size, 0, 'and nothing about either of them is incoming damage of ours')
})
