// THE SECOND RECOVERY PATH — golden window for user report 01KZEWFNSEHJN33W1BA797F806 (JOS-85),
// "the combat parser doesn't seem to be picking my group members sometimes".
//
// ── THE DIAGNOSIS, from the reporter's own slice ────────────────────────────────────────────
//
// His 12,376-line session, replayed through the real parser, produces 5,726 damage events,
// 2,949 misses, 290 heals — and **ZERO group events of any kind**. Not a missed variant: there
// is no join line, no leave line, no leader line and no group chat in the whole window, because
// the group formed before it and EQ prints each of those once. The roster therefore stayed
// `{members: [], seen: false}` for the entire session, and `classify()`'s admission set was
// empty, so both his group-mates fell through the gate:
//
//   Dillydally  1,544 damage events / 174,922 points
//   Bonbonz       612 damage events /  84,277 points
//
// Missing under Group, and missing under Everyone too — the Group scope's show-everyone
// fallback cannot help, because "everyone" means every RECORDED source and nothing was ever
// recorded. That is why it reads as intermittent: a group that chats is recovered by the
// `confirmed` rung, a quiet one is never recovered at all.
//
// ── WHAT THE LOG DOES SAY, and what this file pins ──────────────────────────────────────────
//
// Two facts, both stated outright, neither sufficient alone:
//
//   `You gain party experience!`      a group exists — but it names nobody (17 in the slice)
//   one Quick Buff burst              names everyone your buffs reached, in one second
//
// The burst is the enumeration the model was discarding. Measurement and the reason it is about
// `Quick Buff` rather than about spell target types: src/main/modules/buffFanOut.ts. The
// party-experience gate and the never-a-member refusals: src/main/modules/roster.ts.
//
// ── THE FIXTURE, AND THE THREE INJECTED LINES ───────────────────────────────────────────────
//
// A REPORTER'S SLICE NEVER BECOMES A FIXTURE (AGENTS.md), so the window is the OWNER's real
// bytes — `tests/fixtures/g2-buff-fanout.log`, Tue Jul 28 21:49:08–21:51:22 in The Ruins of Old
// Guk — chosen because it reproduces the reporter's situation exactly: Dranix joined at
// 21:09:31, FORTY MINUTES and 12,000 lines earlier, so the window carries no membership line at
// all, while carrying the party-exp lines, the charm, the `You activate Quick Buff.` and the
// three-name `Center` fan-out at 21:50:01. That 40-minutes-earlier join line is the independent
// ground truth for the name this window recovers.
//
// The reporter's own three lines are INJECTED as parsed events in the last section, quoted
// verbatim in shape from report 01KZEWFNSEHJN33W1BA797F806 with the mob's name swapped for one
// this window is actually fighting — the petClaimWindows / mobLifetapPlayer precedent. They are
// the two-spell burst his log printed at 12:27:44, and they are here because the shape that
// broke is his, not the owner's.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseEvent } from '../src/main/log/parser'
import { CombatEngine } from '../src/main/combat/engine'
import { RosterModule } from '../src/main/modules/roster'
import { BuffFanOut } from '../src/main/modules/buffFanOut'
import { SOURCE_LABEL, outranks } from '../src/shared/roster'
import type { HealEvent, LogEvent } from '../src/shared/logEvents'
import type { RosterSnap } from '../src/shared/roster'
import type { SourceView } from '../src/shared/combat'
import { readFixture } from './harness.mts'

const G2 = readFixture('g2-buff-fanout.log')

const names = (s: RosterSnap): string[] => s.members.map((m) => m.name)

/** Replay through the real parser + roster module, wired the way pipeline.ts wires it. */
function roster(lines: string[], selfName = 'Primitive'): RosterModule {
  const mod = new RosterModule()
  mod.reset()
  mod.setSelfName(selfName)
  let seq = 0
  for (const raw of lines) {
    const ev = parseEvent(raw, seq++)
    if (ev) mod.onEvent(ev)
  }
  return mod
}

/** Replay through parser + roster + engine, modules folding first (pipeline.ts order). */
function replay(lines: string[], selfName = 'Primitive'): {
  eng: CombatEngine
  mod: RosterModule
  lastTs: number
} {
  const eng = new CombatEngine()
  const mod = new RosterModule()
  mod.reset()
  mod.setSelfName(selfName)
  eng.setPlayerName(selfName)
  eng.setRoster(mod)
  let seq = 0
  let lastTs = 0
  for (const raw of lines) {
    const ev = parseEvent(raw, seq++)
    if (!ev) continue
    mod.onEvent(ev)
    eng.ingestEvent(ev, false)
    lastTs = ev.ts
  }
  return { eng, mod, lastTs }
}

/** Every outgoing source row across the whole zone session. */
function zoneSources(eng: CombatEngine, lastTs: number): SourceView[] {
  return eng.snapshot(lastTs + 300_000, { selectedId: 'zone' }).selected?.entities ?? []
}

// ============================================================================
// 1. THE WINDOW IS THE BUG'S OWN SHAPE
// ============================================================================

test('the golden window carries NO membership line — there is nothing to read', () => {
  // If this ever fails the fixture has stopped reproducing the report and every assertion below
  // is testing something easier than the bug.
  const membership = G2.filter((l) =>
    /(has joined the group|has left the group|leader of your group|removed from the group|tells the group)/.test(l)
  )
  assert.deepEqual(membership, [], 'the group formed 40 minutes before this window')
})

test('…and it carries the two lines that TOGETHER say who you are with', () => {
  const party = G2.filter((l) => /You gain party experience!/.test(l))
  const burst = G2.filter((l) => /You activate Quick Buff\.$/.test(l))
  assert.equal(party.length, 3, 'the gate: the game says outright that a group exists')
  assert.equal(burst.length, 1, 'the enumeration: one ability, everyone it reached, one second')
})

// ============================================================================
// 2. THE DETECTOR — what one cast reached, and nothing more
// ============================================================================

const heal = (ts: number, target: string, spell: string, extra: Partial<HealEvent> = {}): HealEvent => ({
  kind: 'heal',
  seq: 0,
  ts,
  raw: '',
  target,
  amount: 1,
  spell,
  healer: 'You',
  ...extra
})

test('two distinct targets in one second under one spell IS the fan-out — and it reports both', () => {
  const f = new BuffFanOut()
  assert.equal(f.onHeal(heal(1000, 'Primitive', 'Center')), null, 'one name proves nothing')
  assert.deepEqual(f.onHeal(heal(1000, 'Dranix', 'Center')), ['Primitive', 'Dranix'],
    'the second name is what makes the first one evidence')
  assert.deepEqual(f.onHeal(heal(1000, 'a froglok ton warrior', 'Center')), ['a froglok ton warrior'],
    'later arrivals in the same cast report only themselves')
  assert.equal(f.onHeal(heal(1000, 'Dranix', 'Center')), null, 'a repeat of the same target is not a new name')
})

test('a different spell, or a different second, is a DIFFERENT cast', () => {
  const f = new BuffFanOut()
  assert.equal(f.onHeal(heal(1000, 'Primitive', 'Center')), null)
  assert.equal(f.onHeal(heal(1000, 'Dranix', 'Symbol of Transal')), null, 'another spell starts its own bucket')
  const g = new BuffFanOut()
  assert.equal(g.onHeal(heal(1000, 'Primitive', 'Center')), null)
  assert.equal(g.onHeal(heal(2000, 'Dranix', 'Center')), null, 'a second later is a second cast')
})

test('HEAL-OVER-TIME TICKS are excluded — a tick is cast-detached and can collide by accident', () => {
  // Two unrelated single-target HoTs on two people can tick in the same second and look exactly
  // like one cast reaching both. No such collision exists in the owner's 900,562-line log (all
  // 83 fan-outs are direct landings), so the exclusion costs nothing and closes the only
  // realistic way this rule could name a stranger.
  const f = new BuffFanOut()
  assert.equal(f.onHeal(heal(1000, 'Primitive', 'Efflorescing Heal', { overTime: true })), null)
  assert.equal(f.onHeal(heal(1000, 'Dranix', 'Efflorescing Heal', { overTime: true })), null)
})

test("ANOTHER player's group buff enumerates THEIR group, so it is refused", () => {
  // `<X> healed <Y>` prints for everyone in earshot; only `You healed …` is your own cast.
  const f = new BuffFanOut()
  assert.equal(f.onHeal(heal(1000, 'Primitive', 'Center', { healer: 'Sir Iot' })), null)
  assert.equal(f.onHeal(heal(1000, 'Sir Fosco', 'Center', { healer: 'Sir Iot' })), null)
})

// ============================================================================
// 3. THE ROSTER — the conjunction, and the refusals
// ============================================================================

test('THE HEADLINE: the golden window recovers the member the join line named 40 minutes earlier', () => {
  const snap = roster(G2).snap()
  assert.deepEqual(names(snap), ['Dranix'])
  assert.equal(snap.members[0].source, 'buffed')
  assert.equal(snap.seen, true, 'a burst comes WITH names, so it is a roster and the chip may say so')
})

test('the burst also landed on the player and on his charmed pet — neither is a group member', () => {
  // Both are in the SAME second as Dranix: `You healed Primitive …` and `You healed a froglok
  // ton warrior …`, the latter charmed 50 seconds earlier at 21:49:11. A pet on the roster
  // would put a friendly on the Group meter as a person and — worse — make engageHostile()
  // refuse the mob for the rest of its life, after the charm breaks and it is hostile again.
  const keys = roster(G2).view().members
  assert.equal(keys.has('primitive'), false, 'the tailed character is not his own group-mate')
  assert.equal(keys.has('a froglok ton warrior'), false, 'a charmed mob is a pet, not a member')
})

test('WITHOUT the self name installed, the player would be on his own roster — so session.ts installs it', () => {
  // Stated as a test rather than trusted: `setSelfName` is a one-line wiring call in
  // session.ts's resetWorldFor, and a wiring call that nothing asserts is a wiring call that
  // gets dropped in a refactor.
  const snap = roster(G2, '').snap()
  assert.ok(names(snap).includes('Primitive'), 'this is the failure the injection prevents')
})

test('THE GATE: the same burst with no party experience in front of it proves nothing', () => {
  // The measurement this rule stands on: across the owner's whole log the fan-out names three
  // other players, of whom one is inside a join-proven group window and two are a townside buff
  // hand-out. Requiring `You gain party experience!` EARLIER IN THE SESSION removes exactly
  // those two — 2 admissions, 2 correct, 0 false positives, unchanged at every backward window
  // from 2 minutes to 6 hours.
  const withoutGate = G2.filter((l) => !/You gain party experience!/.test(l))
  assert.deepEqual(names(roster(withoutGate).snap()), [], 'recipients are not members on their own')
  assert.equal(roster(withoutGate).snap().seen, false, 'and nothing is claimed about the group')
})

test('the gate is BACKWARD-ONLY: a burst before the first party-exp line is not evidence yet', () => {
  // A player buffs up before the first pull, so a forward window would recover more members —
  // and would also admit the one unproven name in the measurement. A fact in hand beats a
  // prediction, and bursts are frequent enough that the next one lands inside the gate.
  const burstAt = G2.findIndex((l) => /You activate Quick Buff\.$/.test(l))
  const reordered = [
    ...G2.slice(0, burstAt).filter((l) => !/You gain party experience!/.test(l)),
    ...G2.slice(burstAt)
  ]
  assert.deepEqual(names(roster(reordered).snap()), [], 'the party-exp line after the burst comes too late')
})

test('a pet claim ARRIVING AFTER the burst retracts the pet, and only the weakest rung', () => {
  // The `… Master.'` tell routinely lands after you have finished buffing, and a pet is not a
  // member whichever line came first. A `joined` member is never touched by this.
  const buffed = roster([
    ...G2,
    "[Tue Jul 28 21:51:30 2026] Dranix told you, 'Attacking a froglok ton knight Master.'"
  ])
  assert.deepEqual(names(buffed.snap()), [], 'the burst-derived row is retracted by the pet evidence')

  const joined = roster([
    '[Tue Jul 28 21:49:00 2026] Dranix has joined the group.',
    ...G2,
    "[Tue Jul 28 21:51:30 2026] Dranix told you, 'Attacking a froglok ton knight Master.'"
  ])
  assert.deepEqual(names(joined.snap()), ['Dranix'], 'a stated membership fact outranks this rule entirely')
  assert.equal(joined.snap().members[0].source, 'joined')
})

test('the rung is the WEAKEST on the ladder, and it says so in the popover', () => {
  assert.equal(outranks('confirmed', 'buffed'), true, 'even group chat is a stronger statement')
  assert.equal(outranks('buffed', 'confirmed'), false)
  assert.equal(outranks('buffed', 'joined'), false)
  assert.equal(outranks('buffed', 'user'), false)
  assert.equal(SOURCE_LABEL.buffed, 'group buff')
})

test('a self-leave ends the licence, not just the roster', () => {
  // The group is over; the next burst describes whoever is standing around. Only a fresh
  // `You gain party experience!` says a new group exists.
  const after = roster([
    ...G2,
    '[Tue Jul 28 21:51:40 2026] You have been removed from the group.',
    '[Tue Jul 28 21:52:00 2026] You activate Quick Buff.',
    '[Tue Jul 28 21:52:03 2026] You healed Primitive for 36 hit points by Center.',
    '[Tue Jul 28 21:52:03 2026] You healed Rykkerr for 57 hit points by Center.'
  ])
  assert.deepEqual(names(after.snap()), [], 'the burst after the disband names nobody')
})

test('party experience alone NEVER puts a name on the roster, and never claims one exists', () => {
  // The gate must not flip the Group scope out of its show-everyone fallback on a fact that
  // names nobody — that would hide the very people this feature exists to show.
  const snap = roster(['[Tue Jul 28 21:49:08 2026] You gain party experience! (1.696%)']).snap()
  assert.deepEqual(names(snap), [])
  assert.equal(snap.seen, false, 'unknown must stay unknown')
})

// ============================================================================
// 4. THE ENGINE — the member's damage actually lands on the meter
// ============================================================================

test('THE FIX: the recovered member is named a group-mate; without the rung he is merely recorded', () => {
  const { eng, lastTs } = replay(G2)
  const member = zoneSources(eng, lastTs).find((s) => s.id === 'member:dranix')
  assert.ok(member, 'the member the burst recovered now has a row of his own')
  assert.equal(member.name, 'Dranix')
  assert.equal(member.kind, 'member')
  assert.ok(member.total > 0, `and real damage on it (${String(member.total)})`)

  // The SAME bytes with the gate removed — the engine exactly as it behaved before JOS-85, except
  // for the one thing JOS-430 changed: the damage is recorded either way now. What this rung buys
  // is the PROVENANCE, which is what the Group scope filters on; it no longer buys the row itself.
  const before = replay(G2.filter((l) => !/You gain party experience!/.test(l)))
  const rows = zoneSources(before.eng, before.lastTs)
  assert.equal(rows.some((s) => s.kind === 'member'), false, 'no roster, no group-mate')
  assert.equal(rows.find((s) => s.id === 'member:dranix')?.kind, 'other', '…but the damage is there')
})

test('the member is never engaged as a hostile, and never files as incoming', () => {
  // The 214-second-merged-pull guardrail, re-asserted for a member this rule admitted rather
  // than one a join line did. `engageHostile` refuses members by key, so the door is the same.
  const { eng, lastTs } = replay(G2)
  const incoming = eng.snapshot(lastTs + 300_000, { selectedId: 'zone' }).selected?.incoming ?? []
  assert.equal(
    incoming.some((s) => s.name.toLowerCase() === 'dranix'),
    false,
    'a group-mate is never in the enemy list'
  )
})

test('law 8: the ONLY difference between the two replays is what the row is CALLED', () => {
  // Recovering a member must not move one point of anything already recorded. Both the outgoing
  // list and the incoming list are compared whole — a per-row spot check would miss a re-keyed
  // instance, and the incoming side is where a friendly wrongly read as a hostile would show up.
  //
  // JOS-430 SHARPENED THIS ASSERTION rather than weakening it. The gate-less replay used to
  // produce an EMPTY outgoing list; now it produces the same row with the same total under
  // `other`, because recording no longer waits for the roster. So the two lists differ in exactly
  // one field — which is a stricter statement of "the rung only ADDS provenance" than the
  // empty-vs-one-row pair ever was.
  //
  // AND THE NUMBER ITSELF MOVED, 881 → 2,368, which is the whole ruling in one integer. The member
  // used to be recorded only from the instant the burst admitted him (line 250 of 555), so the 30
  // seconds of his fight before that were thrown away; they are recorded now and the admission
  // relabels a row that already holds them.
  const withGate = replay(G2)
  const without = replay(G2.filter((l) => !/You gain party experience!/.test(l)))
  const out = (r: { eng: CombatEngine; lastTs: number }): string[] =>
    zoneSources(r.eng, r.lastTs).map((s) => `${s.id}|${s.kind}|${String(s.total)}`).sort()
  const inc = (r: { eng: CombatEngine; lastTs: number }): string[] =>
    (r.eng.snapshot(r.lastTs + 300_000, { selectedId: 'zone' }).selected?.incoming ?? [])
      .map((s) => `${s.id}|${String(s.total)}`).sort()

  assert.deepEqual(out(without), ['member:dranix|other|2368'], 'without the rung: recorded, unnamed')
  assert.deepEqual(out(withGate), ['member:dranix|member|2368'], 'with it: the same 2,368, now a group-mate')
  assert.deepEqual(inc(withGate), inc(without), 'the incoming meter is untouched, to the point')
})

// ============================================================================
// 5. THE REPORTER'S OWN LINES, INJECTED
// ============================================================================
//
// Quoted verbatim in shape from report 01KZEWFNSEHJN33W1BA797F806 (Fri Aug 07 12:27:41–12:27:44,
// The Plane of Hate - Group 1): one `You activate Quick Buff.` followed by two spells each
// landing on three entities in the same second — his charmed pet and his two group-mates. His
// character is the tailed one, so the names of the two players are what the roster must
// recover; the charmed mob's name is swapped for the one this test's world knows.

const REPORTER_BURST = [
  '[Fri Aug 07 12:25:32 2026] You gain party experience!',
  '[Fri Aug 07 12:27:21 2026] Innoruuk`s Chosen has been charmed.',
  '[Fri Aug 07 12:27:41 2026] You activate Quick Buff.',
  '[Fri Aug 07 12:27:44 2026] You healed Innoruuk`s Chosen for 255 hit points by Skin like Nature.',
  '[Fri Aug 07 12:27:44 2026] You healed Bonbonz for 255 hit points by Skin like Nature.',
  '[Fri Aug 07 12:27:44 2026] You healed Dillydally for 255 hit points by Skin like Nature.',
  '[Fri Aug 07 12:27:44 2026] You healed Innoruuk`s Chosen for 313 hit points by Symbol of Pinzarn.',
  '[Fri Aug 07 12:27:44 2026] You healed Bonbonz for 313 hit points by Symbol of Pinzarn.',
  '[Fri Aug 07 12:27:44 2026] You healed Dillydally for 313 hit points by Symbol of Pinzarn.'
]

test("THE REPORT: the reporter's own burst names both of his group-mates and neither his pet nor himself", () => {
  const snap = roster(REPORTER_BURST, 'Yavi').snap()
  assert.deepEqual(names(snap), ['Bonbonz', 'Dillydally'])
  assert.equal(snap.members.every((m) => m.source === 'buffed'), true)
  const keys = roster(REPORTER_BURST, 'Yavi').view().admitted
  assert.equal(keys.has('innoruuk`s chosen'), false, 'the charmed pet stays a pet')
  assert.equal(keys.has('yavi'), false, 'and the reporter stays himself')
})

test("…and their damage is then admitted, which is the whole of the complaint", () => {
  // The shape his slice is full of, one line per member. Before JOS-85 both fell through
  // `classify()`'s last rule; his real slice had 1,544 such lines for one and 612 for the other.
  const lines = [
    ...REPORTER_BURST,
    '[Fri Aug 07 12:28:00 2026] Dillydally hit a haunted chest for 273 points of magic damage by Drain Spirit.',
    '[Fri Aug 07 12:28:01 2026] Bonbonz reaves a haunted chest for 141 points of damage.',
    '[Fri Aug 07 12:28:02 2026] You slash a haunted chest for 100 points of damage.'
  ]
  const { eng, lastTs } = replay(lines, 'Yavi')
  const rows = zoneSources(eng, lastTs)
  assert.equal(rows.find((s) => s.id === 'member:dillydally')?.total, 273)
  assert.equal(rows.find((s) => s.id === 'member:bonbonz')?.total, 141)
  assert.equal(rows.find((s) => s.id === 'you')?.total, 100)
})

test("the reporter's session BEFORE this change: every one of those lines was dropped", () => {
  // The same three damage lines with no burst in front of them — the state his 0.10.0 install
  // was in for the whole 12,376-line session.
  const lines = [
    '[Fri Aug 07 12:28:00 2026] Dillydally hit a haunted chest for 273 points of magic damage by Drain Spirit.',
    '[Fri Aug 07 12:28:01 2026] Bonbonz reaves a haunted chest for 141 points of damage.',
    '[Fri Aug 07 12:28:02 2026] You slash a haunted chest for 100 points of damage.'
  ]
  const { eng, lastTs } = replay(lines, 'Yavi')
  const rows = zoneSources(eng, lastTs)
  assert.equal(rows.some((s) => s.kind === 'member'), false)
  assert.equal(rows.find((s) => s.id === 'you')?.total, 100, 'his own damage was always fine')
})

test('every line of the injected burst parses — none of this rides on an unrecognized shape', () => {
  const parsed = REPORTER_BURST.map((l): LogEvent | null => parseEvent(l, 0))
  assert.equal(parsed.every((p) => p !== null && p.kind !== 'unknown'), true)
  assert.deepEqual(
    parsed.map((p) => p?.kind),
    ['expGain', 'charm', 'aaActivate', 'heal', 'heal', 'heal', 'heal', 'heal', 'heal']
  )
})
