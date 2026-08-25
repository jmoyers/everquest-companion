// GOLDEN WINDOW — THE PET THE METER HAD AND THE LEVELING TAB DID NOT (JOS-454).
//
// tests/fixtures/p4-pet-buff-kill-credit.log, Sun Aug 23 13:42–13:53 in The Plane of Hate 4
// (Refined), cut verbatim through the shared scrub by tests/extract-pet-claim-fixtures.mjs (raw
// 2442745–2446766). Eleven minutes that hold the whole defect:
//
//   13:42:27  `You begin casting Cackling Bones.`      the necromancer pet summon
//   13:42:42  `You begin casting Augment Death.`       a `targetType: Pet` spell
//   13:42:43  `Vibartik's eyes gleam with madness.`    the landing — JOS-188's third binding
//                                                      signal, and the combat engine binds here
//   13:49:08  `A revultant rat has been slain by Vibartik!`
//   13:52:46  `An evil little imp has been slain by Vibartik!`
//
// …and NO `… Master.'` tell, in this window or for another 45 minutes (the owner's first is at
// 14:37:53). The extractor asserts that absence, because the absence is what makes the window
// evidence.
//
// WHAT WAS WRONG. JOS-188's rung is an ARM plus a LANDING — two lines — so it cannot be a parsed
// event, and it lived entirely inside `EngineState`. Every other model binds a pet off the
// `petClaim` LOG event, so the ProgressionModule (the fold behind the Leveling tab's kill counts,
// levels-per-hour and idle classifier) knew only the tell and the charm broadcast and filed both
// of those kills as `witnessTs` — somebody else's — while the DPS meter beside it had Vibartik
// bound the whole time. The owner reported it as "0 kills" on a Plane of Hate selection.
//
// WHAT THIS PINS. The seam `combat/petClaims.ts` named and refused to build without a
// measurement: the engine EMITS a derived `petClaim{via:'petBuff'}` on the same `bus.emitDerived`
// queue the buffs module's `buffExpired` rides, and the other models learn the pet at the instant
// the meter did. Wired here through the REAL `LogBus` in the REAL registration order, so what is
// tested is the delivery discipline (queued, drained after the primary event, one producer that
// ignores its own kind) and not a hand-rolled imitation of it.
//
// THE OWNERSHIP GATE IS UNTOUCHED, and the second half of this file is what says so: the arm is
// still your own cast in its own window with the landing's candidates naming it, so a mob nobody
// buffed can never be credited — which is the precise fear the ticket raised about loosening
// charm-pet ownership.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { parseEvent } from '../src/main/log/parser'
import { installCharacterName, installSpellDb } from '../src/main/log/rulesets'
import { loadSpellDb } from '../src/main/data/spellDb'
import { LogBus } from '../src/main/log/bus'
import { CombatEngine } from '../src/main/combat/engine'
import { ProgressionModule } from '../src/main/modules/progression'
import { rangeStats } from '../src/shared/progressionStats'
import type { LogEvent, PetClaimEvent } from '../src/shared/logEvents'
import type { ProgressionSnap } from '../src/shared/progressionTypes'

// PRODUCTION'S CONFIGURATION, both halves. The spell DB is what turns `Vibartik's eyes gleam with
// madness.` into a `buffApply` carrying `Augment Death` in its candidate list — with no DB the
// line does not parse as a landing at all and this window would prove nothing (harness.mts's
// header makes the same argument for the buff goldens). The character name is what the
// `/pet who leader` rule reads; this fixture holds no such line, so it moves nothing here.
installSpellDb(loadSpellDb())
installCharacterName('Primitive')

const HERE = dirname(fileURLToPath(import.meta.url))
const FIXTURE = join(HERE, 'fixtures', 'p4-pet-buff-kill-credit.log')
const P4 = existsSync(FIXTURE) ? readFileSync(FIXTURE, 'utf8').split(/\r?\n/).filter((l) => l.length > 0) : []

interface Replay {
  snap: ProgressionSnap
  pets: string[]
  derived: PetClaimEvent[]
}

/**
 * Fold the window through the REAL bus with both consumers on it, in pipeline.ts's registration
 * order (modules first, the engine after). `wired` is the whole variable under test: with the
 * emitter installed the engine's JOS-188 bind reaches the bus; without it, the engine behaves
 * exactly as it did before this ticket, which is what makes the two arms a before/after over one
 * body of bytes rather than two different experiments.
 */
function replay(lines: string[], wired: boolean): Replay {
  const bus = new LogBus()
  const prog = new ProgressionModule()
  prog.reset()
  const combat = new CombatEngine()
  combat.reset()
  const derived: PetClaimEvent[] = []
  bus.subscribe((ev: LogEvent) => {
    prog.onEvent(ev)
  })
  bus.subscribe((ev: LogEvent, live: boolean) => {
    combat.ingestEvent(ev, live)
  })
  if (wired) {
    combat.setDerivedEmitter((ev, live) => {
      if (ev.kind === 'petClaim') derived.push(ev)
      bus.emitDerived(ev, live)
    })
  }
  let seq = 0
  for (const raw of lines) {
    const ev = parseEvent(raw, seq++)
    if (ev) bus.emit(ev, false)
  }
  return { snap: prog.snapshot().state, pets: combat.petDisplayNames(), derived }
}

/** The whole fixture as one range — first sample to just past the last event. */
function wholeOf(snap: ProgressionSnap): ReturnType<typeof rangeStats> {
  return rangeStats({ snap, range: { t0: snap.expTs[0], t1: snap.lastTs + 1000 } })
}

test('P4: the engine binds the pet off its own pet-only buff, with no tell anywhere', { skip: P4.length === 0 }, () => {
  const before = replay(P4, false)
  assert.deepEqual(before.pets, ['Vibartik'], 'the meter has had him since 13:42:43 — this never was the bug')
  // The fixture's own precondition, restated where the test can see it: nothing else could bind.
  assert.equal(P4.filter((l) => /Vibartik told you, /.test(l)).length, 0)
  assert.equal(P4.filter((l) => / has been charmed\.$/.test(l)).length, 0)
})

test('P4 BEFORE the seam: the progression fold files a bound pet\'s kills as strangers\'', { skip: P4.length === 0 }, () => {
  const r = wholeOf(replay(P4, false).snap)
  assert.equal(r.killsPet, 0, 'no petClaim event ever arrived, so no kill could be credited to one')
  assert.equal(r.killsWitnessed, 2, 'both of Vibartik\'s kills — the owner\'s "0 kills", in miniature')
  assert.equal(r.killsSelf, 8)
  assert.equal(r.kills, 8)
})

test('P4 AFTER the seam: the same two kills are the pet\'s, and nothing else moves', { skip: P4.length === 0 }, () => {
  const after = replay(P4, true)
  const r = wholeOf(after.snap)
  assert.equal(r.killsPet, 2, 'credited at the instant the meter bound him, not 45 minutes later')
  assert.equal(r.killsWitnessed, 0, 'nobody else killed anything in this window')
  assert.equal(r.killsSelf, 8, 'the owner\'s own kills are untouched')
  assert.equal(r.kills, 10)
  assert.equal(r.killsSelf + r.killsPet, r.kills, 'the credit halves still sum to the whole')

  // THE EXPERIENCE JOIN IS UNMOVED. A kill line consumes the pending experience line whether it is
  // credited or witnessed (progression.ts's `takeExp`), so re-crediting a kill must not create,
  // destroy or re-attribute a single sample — a regression gate on the dimension this change is
  // NOT about.
  assert.equal(r.expSamples, wholeOf(replay(P4, false).snap).expSamples)
})

test('P4: the derived claim is one event, stamped on its primary, naming its route', { skip: P4.length === 0 }, () => {
  const { derived } = replay(P4, true)
  assert.equal(derived.length, 1, 'ONE bind: the arm is consumed on a hit, so a second buff cannot re-emit')
  const [ev] = derived
  assert.equal(ev.kind, 'petClaim')
  assert.equal(ev.name, 'Vibartik')
  assert.equal(ev.via, 'petBuff', 'it says which of the three routes bound him — never dressed up as a tell')
  assert.equal(new Date(ev.ts).toISOString(), new Date(Date.parse('2026-08-23T13:42:43')).toISOString())
  assert.ok(ev.raw.includes('Vibartik'), 'a synthesized line, because no log line states this')
})

test('P4: the seam cannot loop — the producer ignores its own kind', { skip: P4.length === 0 }, () => {
  // The bus drains derived events through the SAME listener loop, so the engine receives the
  // claim it just emitted. If `ingestWorld` re-bound on it, that delivery would emit again and the
  // drain would never end; the test that it terminates AT ALL is half the assertion, and the
  // single-entry `derived` log above is the other half. `buffExpired` keeps this discipline for
  // the same reason (bus.ts's own note).
  const after = replay(P4, true)
  assert.deepEqual(after.pets, ['Vibartik'], 'and the engine still holds exactly one pet')
})

test('P4: crediting the pet does NOT credit the neighbourhood', { skip: P4.length === 0 }, () => {
  // The ticket's stated fear, tested against the bytes: this window is full of named NPCs the
  // owner never buffed — the mobs he is fighting, and `Cleric of Innoruuk`, a proper-named one he
  // kills himself. The arm is an own cast resolved by a named landing, so exactly ONE name in
  // eleven minutes clears it.
  const { derived, snap } = replay(P4, true)
  assert.deepEqual(derived.map((d) => d.name), ['Vibartik'])
  assert.ok(P4.some((l) => /Cleric of Innoruuk/.test(l)), 'the negative control is present in the window')
  // Every credited kill is either the owner's own killing blow or one of the two Vibartik lines —
  // asserted as a COUNT identity rather than by name, because the columns carry no names.
  const r = wholeOf(snap)
  assert.equal(r.kills, P4.filter((l) => /\] You have slain .+!$/.test(l)).length + 2)
})
