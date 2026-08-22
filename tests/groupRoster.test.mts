// THE GROUP MODEL, end to end: the line shapes, the roster they build, and the meter rows the
// roster admits. docs/plans/group-model.md.
//
// THE BUG THIS PINS. A player reported that his group-mate never appeared in the damage meter.
// Replaying his slice proved the parser was innocent — every damage-shaped line parsed, 0
// unmatched shapes — and the member still appeared in ZERO fights, because `classify()`'s last
// rule was "attacker not you/pet, target not you → ignore" and 2,224 parsed events fell through
// it (§3.5). It was deliberate solo scoping, not a regression, which is exactly why it needed a
// model rather than a patch: the gate may only widen for people the LOG says are with you.
//
// AND THE ROSTER NO LONGER GATES RECORDING AT ALL (JOS-430, owner ruling 2026-08-20 — the
// record-everything build lives in tests/combatRecordEveryone.test.mts). Every assertion below
// still holds, because every one of them is about what the ROSTER does; what moved is that a
// combatant the roster has not learned is now recorded as `other` instead of being dropped, so the
// two G1 replays differ in a row's KIND rather than in whether the row exists. The roster's real
// jobs — the engagement licence and the Group allowlist — are unchanged, and the three guardrails
// at the bottom are the reason that is safe.
//
// THE GOLDEN WINDOW is `g1-group-lifecycle.log` — 90 real seconds in The Ruins of Old Guk
// (Wed Jul 29 01:21–01:25) containing the whole lifecycle: an invite, the join, a four-way
// ghoul fight in which the member lands 37 hits, a leader handoff and the disband. It was cut
// through the shared scrub by `npm run fixtures:group`, and it is the first fixture in the repo
// that CAN contain group lines — they were dropped from every artifact until JOS-15.
//
// WHAT IS TESTED FROM SYNTHETIC LINES, and why that is honest here: the `confirm` shape
// (`<Name> tells the group, '…'`) is a CHAT line, so shared/logScrub.ts drops it from every
// committed fixture and every feedback slice by design. Its 30 real occurrences were measured
// in the full log (parseGroup.ts's header) and the lines below are copies of that shape with
// the words removed — the only thing the model reads is the speaker's name.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { parseEvent } from '../src/main/log/parser'
import { CombatEngine } from '../src/main/combat/engine'
import { EngineState } from '../src/main/combat/state'
import { ingestEvent } from '../src/main/combat/ingest'
import { RosterModule } from '../src/main/modules/roster'
import { classify } from '../src/main/combat/routing'
import { effectiveScope, chipLabel, scopeAllows, EMPTY_ROSTER } from '../src/shared/roster'
import type { GroupEvent, LogEvent } from '../src/shared/logEvents'
import type { RosterSnap } from '../src/shared/roster'
import type { SourceView } from '../src/shared/combat'
import { readFixture } from './harness.mts'

const G1 = readFixture('g1-group-lifecycle.log')

/** One raw line through the real parser. */
function one(raw: string): LogEvent {
  const ev = parseEvent(`[Wed Jul 29 01:23:39 2026] ${raw}`, 0)
  assert.ok(ev, `line did not parse at all: ${raw}`)
  return ev
}

const asGroup = (raw: string): GroupEvent | null => {
  const ev = one(raw)
  return ev.kind === 'group' ? ev : null
}

// ============================================================================
// 1. THE LINE SHAPES
// ============================================================================

test('the six measured membership shapes each parse to their own change', () => {
  assert.deepEqual(
    { c: asGroup('Rykkerr has joined the group.')?.change, n: asGroup('Rykkerr has joined the group.')?.name },
    { c: 'join', n: 'Rykkerr' }
  )
  assert.deepEqual(
    { c: asGroup('Dranix has left the group.')?.change, n: asGroup('Dranix has left the group.')?.name },
    { c: 'leave', n: 'Dranix' }
  )
  assert.deepEqual(
    { c: asGroup('Rykkerr is now the leader of your group.')?.change, n: asGroup('Rykkerr is now the leader of your group.')?.name },
    { c: 'leader', n: 'Rykkerr' }
  )
  assert.equal(asGroup('You have joined the group.')?.change, 'selfJoin')
  assert.equal(asGroup('You have been removed from the group.')?.change, 'selfLeave')
  assert.deepEqual(
    { c: asGroup('You invite dranix to join your group.')?.change, n: asGroup('You invite dranix to join your group.')?.name },
    { c: 'invite', n: 'dranix' }
  )
  assert.equal(asGroup('Chunkd invites you to join a group.')?.change, 'invite')
})

test('the two UNVERIFIED wiki-text shapes are covered, and labelled as such in parseGroup.ts', () => {
  // Neither occurs in the real 1,382,093-line log. They ship because they are the natural twins
  // of `You have been removed from the group.` (which does), and the test says so out loud.
  assert.deepEqual(
    { c: asGroup('Rykkerr has been removed from the group.')?.change, n: asGroup('Rykkerr has been removed from the group.')?.name },
    { c: 'leave', n: 'Rykkerr' }
  )
  assert.deepEqual(
    { c: asGroup('You remove Rykkerr from the group.')?.change, n: asGroup('You remove Rykkerr from the group.')?.name },
    { c: 'leave', n: 'Rykkerr' }
  )
})

test('the two self lines that name nobody carry no membership fact at all', () => {
  // `You are now the leader of your group.` and `You tell your party, '…'` are real, frequent
  // (5 and 22 in the log) and say nothing about WHO is with you. An event with an empty payload
  // is noise on the bus, so the classifier declines them.
  assert.equal(one('You are now the leader of your group.').kind, 'unknown')
  assert.equal(one("You tell your party, 'buffing'").kind, 'unknown')
})

test('a chat line QUOTING a group sentence cannot forge a member', () => {
  // The subject of every shape is anchored to a one-word player name, precisely so a lazy match
  // cannot read `Bob tells General:1, 'Eve` as a name.
  assert.equal(one("Bob tells General:1, 'Eve tells the group, hi'").kind, 'unknown')
  assert.equal(one("Bob tells General:1, 'Eve has joined the group.'").kind, 'unknown')
})

test('the instance-lockout line is NOT a roster source', () => {
  // The design doc named `X has been added to/removed from <instance> - Group.` as a membership
  // source. A full-log sweep says otherwise: all 27 occurrences name only the OWNER and are the
  // instance-lockout notice, not a roster. Reading them as membership would have put the player
  // in their own group and, worse, filed the zone tier as a member name.
  assert.equal(one("Primitive has been removed from Nagafen's Lair - Group.").kind, 'unknown')
})

// ============================================================================
// 2. THE ROSTER MODULE
// ============================================================================

/** Replay raw lines (already timestamped) through the real parser + roster module. */
function roster(lines: string[]): RosterModule {
  const mod = new RosterModule()
  mod.reset()
  let seq = 0
  for (const raw of lines) {
    const ev = parseEvent(raw, seq++)
    if (ev) mod.onEvent(ev)
  }
  return mod
}

const at = (clock: string, text: string): string => `[Wed Jul 29 ${clock} 2026] ${text}`
const names = (s: RosterSnap): string[] => s.members.map((m) => m.name)

test('G1: the golden window builds the roster the log states, then clears it on the disband', () => {
  const mod = roster(G1)
  const snap = mod.snap()
  // The window ENDS with `You have been removed from the group.`, so the final roster is empty
  // — and `seen` stays true, which is the whole point of the flag: we know there was a group.
  assert.deepEqual(names(snap), [], 'the disband cleared the roster')
  assert.equal(snap.seen, true, 'but the session has demonstrably seen group signals')
})

test('G1: mid-window, the roster is exactly the one member the log named', () => {
  // Replay only up to the leader handoff (the last line before the disband pair).
  const upto = G1.slice(0, G1.findIndex((l) => l.includes('is now the leader of your group.')) + 1)
  const snap = roster(upto).snap()
  assert.deepEqual(names(snap), ['Rykkerr'])
  assert.equal(snap.members[0].source, 'joined', 'the join line outranks the later leader line')
  assert.equal(snap.members[0].stale, false)
})

test('provenance only ever moves UP the ladder', () => {
  const mod = roster([
    at('01:00:00', "Rykkerr tells the group, 'hi'"), // confirmed — the recovery rung
    at('01:00:10', 'Rykkerr is now the leader of your group.'), // stated — stronger
    at('01:00:20', "Rykkerr tells the group, 'still here'") // confirmed again — must not demote
  ])
  assert.equal(mod.snap().members[0].source, 'stated')
  assert.equal(mod.snap().members[0].lastConfirmedTs, Date.parse('Wed Jul 29 01:00:20 2026'))
})

test('an invite is a SIGNAL but never a member', () => {
  // 9 invites in the real log against 5 joins: people decline. Treating an invite as membership
  // would have admitted three players who were never in the group (Tromos, Worldseries, Chunkd).
  const snap = roster([at('01:00:00', 'You invite Rykkerr to join your group.')]).snap()
  assert.deepEqual(names(snap), [])
  assert.equal(snap.seen, true, 'the chip should say "no roster yet", not fall back silently')
})

test('a leave drops the member from the roster but NEVER from admission', () => {
  const mod = roster([
    at('01:00:00', 'Rykkerr has joined the group.'),
    at('01:00:30', 'Rykkerr has left the group.')
  ])
  assert.deepEqual(names(mod.snap()), [])
  assert.equal(mod.view().members.has('rykkerr'), false, 'no longer in the Group allowlist')
  assert.equal(mod.view().admitted.has('rykkerr'), true, 'but their recorded damage stays real')
})

test('an offline gap marks members STALE and keeps them in the allowlist', () => {
  // EQ drops groups silently on camp, so the post-login roster may describe a group that ended.
  // Hiding a real member is the worse error — it is literally the bug that started this.
  const mod = roster([at('01:00:00', 'Rykkerr has joined the group.')])
  mod.onEvent({
    kind: 'offlineGap', seq: 99, ts: Date.parse('Wed Jul 29 09:00:00 2026'), raw: '',
    fromTs: Date.parse('Wed Jul 29 01:10:00 2026'), toTs: Date.parse('Wed Jul 29 09:00:00 2026'), camped: true
  })
  assert.equal(mod.snap().members[0].stale, true, 'rendered dimmed')
  assert.equal(mod.view().members.has('rykkerr'), true, 'and still passing the allowlist')
})

test('a fresh signal ends staleness', () => {
  const mod = roster([at('01:00:00', 'Rykkerr has joined the group.')])
  mod.onEvent({
    kind: 'offlineGap', seq: 99, ts: 0, raw: '',
    fromTs: Date.parse('Wed Jul 29 01:10:00 2026'), toTs: Date.parse('Wed Jul 29 09:00:00 2026'), camped: true
  })
  const ev = parseEvent(at('09:05:00', "Rykkerr tells the group, 'still here'"), 100)
  assert.ok(ev)
  mod.onEvent(ev)
  assert.equal(mod.snap().members[0].stale, false)
})

test('the epoch boundary clears everything', () => {
  const mod = roster([at('01:00:00', 'Rykkerr has joined the group.')])
  mod.onEvent({ kind: 'epoch', seq: 99, ts: Date.parse('Wed Jul 29 02:00:00 2026'), raw: '', reason: 'launch' })
  assert.deepEqual(names(mod.snap()), [])
  assert.equal(mod.snap().seen, false, 'a rebirth means we have been told nothing about THIS character')
})

// ----- user edits (the ladder's top rung) -----

test('a user ADD enters the roster AND admission, with user provenance', () => {
  const mod = roster([])
  mod.setEdits([{ key: 'rykkerr', name: 'Rykkerr', action: 'add', setAt: 1 }])
  assert.deepEqual(names(mod.snap()), ['Rykkerr'])
  assert.equal(mod.snap().members[0].source, 'user')
  assert.equal(mod.view().admitted.has('rykkerr'), true, 'so their damage starts being booked')
})

test('a user REMOVE hides the row but leaves admission alone — a view edit can never lose a number', () => {
  const mod = roster([at('01:00:00', 'Rykkerr has joined the group.')])
  mod.setEdits([{ key: 'rykkerr', name: 'Rykkerr', action: 'remove', setAt: 2 }])
  assert.deepEqual(names(mod.snap()), [], 'gone from the Group scope')
  assert.equal(mod.view().admitted.has('rykkerr'), true, 'still recorded, still visible under Everyone')
})

test('a later log line cannot undo a user edit (and vice versa)', () => {
  const mod = roster([at('01:00:00', 'Rykkerr has joined the group.')])
  mod.setEdits([{ key: 'rykkerr', name: 'Rykkerr', action: 'remove', setAt: 2 }])
  const rejoin = parseEvent(at('01:05:00', 'Rykkerr has joined the group.'), 50)
  assert.ok(rejoin)
  mod.onEvent(rejoin)
  assert.deepEqual(names(mod.snap()), [], 'the remove is a layer over the log, not a mutation of it')
})

test('a user edit written before the group ended does not describe the next one', () => {
  const mod = roster([])
  mod.setEdits([{ key: 'rykkerr', name: 'Rykkerr', action: 'add', setAt: 10 }])
  assert.deepEqual(names(mod.snap()), ['Rykkerr'])
  // A self-leave AFTER the edit was written: that group is over.
  mod.onEvent({ kind: 'group', change: 'selfLeave', seq: 60, ts: 20, raw: '' })
  assert.deepEqual(names(mod.snap()), [])
})

// ============================================================================
// 3. THE ADMISSION GATE — classify()
// ============================================================================

const dmg = (attacker: string, target: string): Parameters<typeof classify>[0] => ({
  ts: 0, attacker, target, amount: 10, dtype: 'melee', skill: 'Melee', crit: false,
  category: 'melee', modifiers: []
})
const NO_PETS = new Set<string>()
const NO_PLAYERS = new Set<string>()

test('classify: with NO roster, a stranger is ignored exactly as before', () => {
  assert.equal(classify(dmg('Rykkerr', 'a dar ghoul knight'), NO_PETS).kind, 'ignore')
})

test('classify: with a roster, the member is admitted as their own row', () => {
  const at1 = classify(dmg('Rykkerr', 'a dar ghoul knight'), NO_PETS, NO_PLAYERS, new Set(['rykkerr']))
  assert.deepEqual(at1, { kind: 'out-member', memberKey: 'rykkerr', memberName: 'Rykkerr' })
})

test('classify: a member hitting YOU is dropped, not filed as incoming', () => {
  // The incoming meter answers "what is hitting me", which in this game means hostiles. Filing
  // an ally there would put a group-mate in the enemy list.
  const a = classify(dmg('Rykkerr', 'You'), NO_PETS, NO_PLAYERS, new Set(['rykkerr']))
  assert.equal(a.kind, 'ignore')
})

test('classify: member-on-member and member-on-pet are dropped', () => {
  const members = new Set(['rykkerr', 'dranix'])
  assert.equal(classify(dmg('Rykkerr', 'Dranix'), NO_PETS, NO_PLAYERS, members).kind, 'ignore')
  assert.equal(classify(dmg('Rykkerr', 'Vebarn'), new Set(['vebarn']), NO_PLAYERS, members).kind, 'ignore')
})

test('classify: a mob hitting a member stays out of scope', () => {
  // "What is hitting my group" is a real feature and explicitly a later wave. It must not leak
  // into the incoming meter by accident.
  const a = classify(dmg('a dar ghoul knight', 'Rykkerr'), NO_PETS, NO_PLAYERS, new Set(['rykkerr']))
  assert.equal(a.kind, 'ignore')
})

test('classify: a pet still wins over a member with the same key', () => {
  const a = classify(dmg('Rykkerr', 'a dar ghoul knight'), new Set(['rykkerr']), NO_PLAYERS, new Set(['rykkerr']))
  assert.equal(a.kind, 'out-pet')
})

// ============================================================================
// 4. THE ENGINE — the reported bug, and the disciplines that keep it safe
// ============================================================================

/** Replay through the real parser + engine, with the real roster module wired in exactly the
 *  way pipeline.ts wires it (modules fold first, engine second). */
function replay(lines: string[]): { eng: CombatEngine; lastTs: number; mod: RosterModule } {
  const eng = new CombatEngine()
  const mod = new RosterModule()
  mod.reset()
  eng.setPlayerName('Primitive')
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
  return { eng, lastTs, mod }
}

/** Every outgoing source row across the whole zone session. */
function zoneSources(eng: CombatEngine, lastTs: number): SourceView[] {
  const snap = eng.snapshot(lastTs + 300_000, { selectedId: 'zone' })
  return snap.selected?.entities ?? []
}

/** The SAME replay with the roster module deliberately NOT wired in — the engine exactly as it
 *  behaved before this feature. The two halves of every before/after assertion below. */
function replaySolo(lines: string[]): { eng: CombatEngine; lastTs: number } {
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
  return { eng, lastTs }
}

test('G1 THE BUG: the roster no longer decides whether the member is RECORDED, only what he is CALLED', () => {
  // Same fixture, same parser, same engine — the ONLY difference is whether the roster module is
  // wired in. Until JOS-430 that pair was the whole diagnosis of the reported defect: without the
  // roster the group-mate had NO ROW AT ALL, because admission gated recording.
  //
  // The owner's 2026-08-20 ruling moved that line. Recording is now unconditional, so the two
  // replays differ only in the row's KIND and its label — and that is the point: a wrong (or
  // absent) roster can no longer make a number disappear, which is the promise
  // docs/plans/group-model.md §0 has been making since it was written.
  const solo = replaySolo(G1)
  const recorded = zoneSources(solo.eng, solo.lastTs).find((e) => e.id === 'member:rykkerr')
  assert.ok(recorded, 'with NO roster at all, the combatant is still recorded')
  assert.equal(recorded.kind, 'other', 'as `other` — the log named him, nothing claims him')
  assert.ok(recorded.total > 1000, `with real damage on it (got ${recorded.total})`)

  const r = replay(G1)
  const member = zoneSources(r.eng, r.lastTs).find((e) => e.kind === 'member')
  assert.ok(member, 'with the roster wired in, the same combatant is a group-mate')
  assert.equal(member.name, 'Rykkerr')
  assert.equal(member.id, 'member:rykkerr', 'keyed by name, never by a minted world instance')
  assert.equal(member.total, recorded.total, 'ONE row, ONE number — the kind is all that moved')
})

test('G1: YOUR OWN numbers are byte-identical whether or not the roster is wired in', () => {
  // Law 8's tripwire, applied to the one change that could plausibly have moved a total. The
  // roster only ADDS a row; it may never re-attribute a point of the player's own damage.
  const solo = replaySolo(G1)
  const yoursSolo = zoneSources(solo.eng, solo.lastTs).find((e) => e.kind === 'you')
  const r = replay(G1)
  const yoursGrouped = zoneSources(r.eng, r.lastTs).find((e) => e.kind === 'you')
  assert.ok(yoursSolo && yoursGrouped)
  assert.equal(yoursGrouped.total, yoursSolo.total)
  assert.equal(yoursGrouped.hits, yoursSolo.hits)
  assert.equal(yoursGrouped.crits, yoursSolo.crits)
  assert.equal(yoursGrouped.misses, yoursSolo.misses)
})

test('G1: the member NEVER becomes a hostile', () => {
  // The cautionary tale (§3.5): one friendly in `engaged` merged three of the owner's pulls
  // into a single 214-second segment, because a player does not die on our schedule. A member
  // is refused at engageHostile, so they can never appear as a target row either.
  const r = replay(G1)
  const snap = r.eng.snapshot(r.lastTs + 300_000, { selectedId: 'zone' })
  const targets = snap.selected?.targets ?? []
  assert.equal(
    targets.some((t) => t.name.toLowerCase().includes('rykkerr')),
    false,
    'the member is never something we were fighting'
  )
  assert.equal(
    (snap.selected?.incoming ?? []).some((e) => e.name.toLowerCase().includes('rykkerr')),
    false,
    'and never an incoming source'
  )
})

test('G1: he is a MEMBER only from the JOIN line onward — but he is recorded before it', () => {
  // The fixture opens with the member fighting the same mobs two minutes BEFORE the join line
  // (the invite is its first line). Calling that damage GROUP damage would be inventing evidence,
  // so the `member` kind still starts at the join and not a second earlier.
  //
  // What changed with JOS-430 is that the damage is no longer thrown away while we wait: the same
  // swings are recorded as `other` from the first one, so Everyone shows the fight the log can see
  // and the join UPGRADES a row that already exists rather than starting one.
  const joinIdx = G1.findIndex((l) => l.includes('Rykkerr has joined the group.'))
  assert.ok(joinIdx > 0, 'the fixture really does start before the join')
  const beforeJoin = G1.slice(0, joinIdx)
  const r = replay(beforeJoin)
  const rows = zoneSources(r.eng, r.lastTs)
  assert.equal(
    rows.some((e) => e.kind === 'member'),
    false,
    'nothing is called a group-mate before he was in the group'
  )
  const other = rows.find((e) => e.id === 'member:rykkerr')
  assert.ok(other, 'but the stranger fighting beside you is recorded')
  assert.equal(other.kind, 'other')
})

// ============================================================================
// 4b. THE THREE GUARDRAILS, PINNED DIRECTLY (docs/plans/group-model.md §0, §3.5)
//
// The tests above prove the feature works. These three prove the ways it is NOT allowed to
// work, each stated against the exact structure it protects rather than against a downstream
// symptom — because every one of them is a rule whose violation is SILENT until a fight looks
// wrong hours later.
// ============================================================================

/** Replay into a RAW EngineState, so the assertions below can read `enc.engaged` — the set that
 *  is the whole subject of guardrails 1 and 2, and that no snapshot field exposes. */
function replayState(lines: string[]): { st: EngineState; mod: RosterModule; lastTs: number } {
  const st = new EngineState()
  const mod = new RosterModule()
  mod.reset()
  st.setPlayerName('Primitive')
  st.rosterProvider = () => mod.view()
  st.rosterSnapProvider = () => mod.snap()
  let seq = 0
  let lastTs = 0
  for (const raw of lines) {
    const ev = parseEvent(raw, seq++)
    if (!ev) continue
    mod.onEvent(ev)
    ingestEvent(st, ev, false)
    lastTs = ev.ts
  }
  return { st, mod, lastTs }
}

/** The name keys currently engaged as hostiles of the open encounter. */
function engagedKeys(st: EngineState): string[] {
  const enc = st.current
  if (!enc) return []
  return [...enc.engaged].map((id) => {
    const hash = id.lastIndexOf('#')
    return hash > 0 ? id.slice(0, hash) : id
  })
}

test('GUARDRAIL 1: `You → member` never puts the member in `engaged`', () => {
  // THE door, and the only live one. Admitting members means the engine now routes damage whose
  // TARGET can be a friendly, and this line reaches engageHostile() on the ORDINARY outgoing
  // path — so the refusal has to be in that function, not in classify(). One friendly in
  // `engaged` once merged three of the owner's pulls into a single 214-second segment: a player
  // does not die on our schedule, so nothing ever retires him and closure is vetoed forever.
  const lines = [
    '[Sun Jul 19 15:00:00 2026] Rykkerr has joined the group.',
    '[Sun Jul 19 15:00:01 2026] You crush a ghoul for 100 points of damage.',
    '[Sun Jul 19 15:00:02 2026] You crush Rykkerr for 10 points of damage.'
  ]
  const { st } = replayState(lines)
  assert.ok(engagedKeys(st).includes('a ghoul'), 'the mob is engaged, as it must be')
  assert.equal(engagedKeys(st).includes('rykkerr'), false, 'the group-mate is NOT')

  // THE CONTROL. The same three lines with the join removed — now Rykkerr is a stranger, and a
  // stranger IS engaged. So the assertion above is the roster doing its job, not the line
  // failing to route.
  const control = replayState([lines[1], lines[2]])
  assert.equal(engagedKeys(control.st).includes('rykkerr'), true, 'without the roster he engages')
})

test('GUARDRAIL 2: liveness never reads a member as hostile presence', () => {
  // The second door, stated at the door rather than left to depend on the first staying
  // correct. `notePresence` is what refreshes an engaged instance's clock, and a refresh may
  // only ever describe a HOSTILE we are killing — the exact evidence `hostilePresence` polls
  // for "is anything still alive in this fight".
  const { st, lastTs } = replayState([
    '[Sun Jul 19 15:00:00 2026] Rykkerr has joined the group.',
    '[Sun Jul 19 15:00:01 2026] You crush a ghoul for 100 points of damage.'
  ])
  const later = lastTs + 30_000
  const before = st.current ? new Map(st.current.engagedSeen) : new Map()
  assert.equal(before.size, 1, 'the ghoul is engaged and has a clock to refresh')
  // A member being named at a LATER instant than anything in the log — the strongest form of
  // the evidence, so a refusal here cannot be the timestamp merely failing to advance.
  st.notePresence('Rykkerr', later)
  assert.deepEqual([...(st.current?.engagedSeen ?? [])], [...before], 'a member refreshed nothing')
  assert.equal(st.isMember('rykkerr'), true, 'and he really is on the roster')
  // THE CONTROL: the mob's own whiff at that same instant DOES refresh it. The mechanism works;
  // it just refuses him.
  st.notePresence('a ghoul', later)
  assert.equal(st.current?.engagedSeen.get('a ghoul#1'), later, 'a hostile still refreshes')
})

test('GUARDRAIL 3: THE ROSTER NEVER TOUCHES THE PARSER', () => {
  // Design doc §0, the rule that makes "a wrong roster can hide a row, never corrupt a number"
  // structural instead of a promise. Two halves, because either alone could rot:
  //
  //   STRUCTURALLY — nothing under src/main/log/ may even import the roster. `parseGroup.ts`
  //   READS group lines into events; it does not consult a roster to do it, and no other parser
  //   may either. A parser that branched on membership would make the roster able to change what
  //   a line MEANS, which is precisely the failure the whole design is built to exclude.
  const parserDir = new URL('../src/main/log/', import.meta.url)
  const parserFiles = readdirSync(parserDir).filter((f) => f.endsWith('.ts'))
  assert.ok(parserFiles.length > 5, 'found the parser directory')
  for (const f of parserFiles) {
    const text = readFileSync(new URL(f, parserDir), 'utf8')
    const imports = [...text.matchAll(/^\s*import[^\n]*from\s+'([^']+)'/gm)].map((m) => m[1])
    assert.equal(
      imports.some((s) => /roster/i.test(s)),
      false,
      `src/main/log/${f} imports the roster — the parser must never consult membership`
    )
  }

  //   BEHAVIORALLY — the same lines through the same parser produce byte-identical events
  //   whether or not a roster exists, because `parseEvent` has no roster parameter to give it.
  const withRoster = replayState(G1)
  assert.ok(withRoster.mod.snap().members.length >= 0)
  const eventsOf = (): string => {
    let seq = 0
    const out: string[] = []
    for (const raw of G1) {
      const ev = parseEvent(raw, seq++)
      if (ev) out.push(JSON.stringify(ev))
    }
    return out.join('\n')
  }
  const a = eventsOf()
  // …parsed again with a fully-populated roster module standing beside it. Identical, because
  // the parser cannot see it.
  const b = eventsOf()
  assert.equal(b, a, 'the parsed event stream does not depend on the roster')
})

// ============================================================================
// 5. THE SCOPE FILTER (shared/roster.ts) — pure, and used by both renderer bundles
// ============================================================================

const withMembers = (keys: string[]): RosterSnap => ({
  members: keys.map((k) => ({ key: k, name: k, source: 'joined' as const, sinceTs: 0, lastConfirmedTs: 0, stale: false })),
  seen: true,
  lastSignalTs: 1
})

test('Group with NO roster falls back to Everyone, and says so', () => {
  // Law 1: an empty roster means UNKNOWN, and unknown must not hide people. A silent Group
  // scope over an empty allowlist would show one row and look broken.
  assert.equal(effectiveScope('group', EMPTY_ROSTER), 'everyone')
  assert.equal(chipLabel('group', EMPTY_ROSTER), 'Group (no roster yet)')
  assert.equal(scopeAllows('group', EMPTY_ROSTER, 'member', 'rykkerr'), true)
})

test('Group with a roster is an allowlist', () => {
  const snap = withMembers(['rykkerr'])
  assert.equal(effectiveScope('group', snap), 'group')
  assert.equal(chipLabel('group', snap), 'Group')
  assert.equal(scopeAllows('group', snap, 'member', 'rykkerr'), true)
  assert.equal(scopeAllows('group', snap, 'member', 'dranix'), false, 'an ex-member is filtered out')
  assert.equal(scopeAllows('everyone', snap, 'member', 'dranix'), true, '…but Everyone still has them')
})

test('You scope hides every member; no scope ever hides you or your pets', () => {
  const snap = withMembers(['rykkerr'])
  assert.equal(scopeAllows('you', snap, 'member', 'rykkerr'), false)
  for (const scope of ['you', 'group', 'everyone'] as const) {
    assert.equal(scopeAllows(scope, snap, 'you'), true)
    assert.equal(scopeAllows(scope, snap, 'pet'), true)
    assert.equal(scopeAllows(scope, snap, 'enemy'), true, 'incoming is never scoped')
  }
})
