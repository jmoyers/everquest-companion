// JOS-134 — THE OFFLINE PAUSE IS ASYMMETRIC, AND IT SURVIVES A REAL CAMP.
//
// tests/sessionWindows.test.mts owns the session FRAME: the parser goldens for the login/camp
// line families, the derived `offlineGap` goldens over five real windows, and the S5 EVIDENCE
// that a buff's timer stops while you are out of the world (a 16-minute haste that wears off
// 13h58m of wall clock after it landed can only be explained by a paused clock). This file owns
// what the model does about it.
//
// Its contract could only ever be shown there for absences SHORTER than the 30-minute log hole,
// because the hole wiped every live instance before the gap that explains it could arrive. That
// is the defect this file closes, and the owner's design it encodes is one sentence with two
// halves (2026-08-09):
//
//   YOUR CHARACTER is paused, so YOUR BUFFS freeze.
//   THE WORLD is not, so the DEBUFFS you left on it keep burning down in world time.
//
// Both halves are asserted in the same event stream, because either one alone is satisfiable by
// code that is wrong about the other. And both are driven through the REAL modules and the REAL
// SessionDetector — no hand-fed `offlineGap` — so what is pinned includes the wiring index.ts
// does: the reconnect preamble opens the hole, the Welcome resolves it, and the derived gap is
// drained onto the same bus behind the primary event that produced it.
//
// Run: `npm test`.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseEvent } from '../src/main/log/parser'
import type { LogEvent } from '../src/shared/logEvents'
import { SessionDetector } from '../src/main/log/sessionDetector'
import { BuffsModule } from '../src/main/modules/buffs'
import { BuffTimersModule } from '../src/main/modules/buffTimers'
import { LOGIN_CONFIRM_MS, MAX_SAMPLE_MS, SESSION_GAP_MS } from '../src/main/modules/buffsShapes'
import { loadSpellDb } from '../src/main/data/spellDb'
import { installSpellDb } from '../src/main/log/rulesets'
import type { BuffsSnap } from '../src/shared/types'

const SEC = 1000
const MIN = 60 * SEC

/** An EQ-format timestamp → epoch ms, so the numbers below read as the log's own clock. */
function at(text: string): number {
  const ev = parseEvent(`[${text}] x`, 0)
  assert.ok(ev && ev.ts > 0, `unparseable stamp: ${text}`)
  return ev.ts
}

/** One module as the bus sees it (BuffsModule's `live` parameter defaults, so both fit). */
interface BusModule {
  onEvent: (ev: LogEvent) => void
}

/** An event as these tests write it — the bus stamps `seq` and tolerates a missing `raw`. */
type Sent = Omit<LogEvent, 'seq' | 'raw'> & { raw?: string }

/**
 * index.ts's wiring, in miniature: every event reaches the modules first, THEN the detector
 * observes it, and any `offlineGap` it synthesizes is drained onto the same bus behind the
 * primary event. Feeding a gap by hand would prove the modules fold one; this proves the log
 * produces one.
 */
function busTo(...mods: BusModule[]): (ev: Sent) => void {
  const det = new SessionDetector()
  let seq = 0
  return (ev) => {
    const full = { ...ev, seq: seq++, raw: ev.raw ?? '' } as LogEvent
    for (const m of mods) m.onEvent(full)
    const gap = det.observe(full)
    if (gap) for (const m of mods) m.onEvent({ ...gap, seq: seq++ })
  }
}

/** A DB-backed buffs module — buff vs debuff is a DB property, so the asymmetry needs one. */
function dbBuffsModule(): BuffsModule {
  const db = loadSpellDb()
  installSpellDb(db)
  const mod = new BuffsModule(db)
  mod.reset()
  return mod
}

/** An own cast that LANDS on a named target — the only shape that opens an instance (JOS-118). */
function castAndLand(
  send: (ev: Sent) => void,
  spec: { spell: string; target: string; durationMs: number; landTs: number }
): void {
  const { spell, target, durationMs, landTs } = spec
  send({ kind: 'castBegin', ts: landTs - SEC, spell } as LogEvent)
  send({
    kind: 'buffApply',
    ts: landTs,
    spell,
    target,
    illusion: false,
    durationMs,
    candidates: [{ name: spell, durationMs, illusion: false }]
  } as LogEvent)
}

/** The one active row for `spell`, or undefined. */
function rowOf(snap: BuffsSnap, spell: string): BuffsSnap['active'][number] | undefined {
  return snap.active.find((a) => a.spell.toLowerCase() === spell.toLowerCase())
}

/** How many duration samples the model has mined for `spell`. */
function samplesFor(snap: BuffsSnap, spell: string): number {
  return Object.values(snap.stats).find((s) => s.spell.toLowerCase() === spell.toLowerCase())?.n ?? 0
}

const SWIFT = 'Swift Like The Wind'
const SWIFT_DB_MS = 16 * MIN

test('a buff camped overnight is still up at login, resumed where it stopped', () => {
  // S5's own chain, replayed through the model that has to agree with it. Every stamp below is a
  // line in tests/fixtures/s5-session-buff-pause-evidence.log; the evidence test in
  // sessionWindows.test.mts proves the arithmetic can ONLY be explained by a paused timer, and
  // this proves the model now does it.
  const mod = dbBuffsModule()
  const send = busTo(mod)

  const land = at('Fri Jul 31 00:51:59 2026')
  castAndLand(send, { spell: SWIFT, target: 'self', durationMs: SWIFT_DB_MS, landTs: land })
  assert.equal(rowOf(mod.snapshot().state, SWIFT)?.startedTs, land)

  // The camp, its last countdown tick (the last instant the character is known to be in world),
  // then 13h43m08s of nothing.
  send({ kind: 'campStart', ts: at('Fri Jul 31 01:05:43 2026') } as LogEvent)
  const lastTick = at('Fri Jul 31 01:06:07 2026')
  send({ kind: 'unknown', ts: lastTick } as LogEvent)

  // THE RECONNECT PREAMBLE opens the hole — and this is precisely where the old model wiped the
  // buff, six seconds before the Welcome that would have explained the absence. It is HELD now:
  // still standing, and still on its original clock, because nothing has yet said the character
  // LEFT rather than that we lost the thread.
  const preamble = at('Fri Jul 31 14:49:09 2026')
  send({ kind: 'unknown', ts: preamble } as LogEvent)
  assert.ok(preamble - lastTick >= SESSION_GAP_MS, 'the absence really is past the log-hole boundary')
  const held = rowOf(mod.snapshot().state, SWIFT)
  assert.ok(held, 'the buff is not wiped by the hole alone — the old behaviour this ticket removes')
  assert.equal(held.startedTs, land, 'and it is not shifted yet either: nothing has explained the hole')

  // THE WELCOME explains it. The detector measures the absence and the pause lands.
  const welcome = at('Fri Jul 31 14:49:15 2026')
  send({ kind: 'sessionStart', ts: welcome } as LogEvent)
  const back = rowOf(mod.snapshot().state, SWIFT)
  assert.ok(back, 'the buff EQ froze with the character is up when the character is back')
  assert.equal(back.startedTs, land + (welcome - lastTick))
  // 14m08s of the 16-minute timer had run before the camp completed, so that is what the bar
  // reads at the login instant — not the 13h57m of wall clock that had passed.
  assert.equal(welcome - back.startedTs, 14 * MIN + 8 * SEC)
  assert.ok(welcome - land > MAX_SAMPLE_MS, 'the wall clock, by contrast, is past the sanity ceiling')

  // …and the remainder runs out 73 seconds later, exactly as the real log printed it.
  const wearOff = at('Fri Jul 31 14:50:28 2026')
  send({ kind: 'buffWearOff', ts: wearOff, spell: SWIFT, candidates: [SWIFT], target: 'self' } as LogEvent)
  const snap = mod.snapshot().state
  assert.equal(rowOf(snap, SWIFT), undefined, 'the wears-off line is still the authority (law 1)')
  assert.equal(wearOff - welcome, 73 * SEC)
  // THE LEARNER (the ticket's other half): 15m21s of ONLINE time is the truth here, but the span
  // this model actually observed is 13h58m29s of wall clock with an absence inside it that is
  // known only to within the reconnect window. It is CENSORED, not corrected — the `spannedGap`
  // doc in buffsShapes.ts states why subtracting the gap is not something we can do exactly.
  assert.equal(samplesFor(snap, SWIFT), 0, 'no duration sample may be mined across an absence')
})

const SLOW = 'Shiftless Deeds'
const SLOW_DB_MS = 150 * SEC
const MOB = 'a fire giant warrior'

test('the world does not pause with you: a debuff keeps burning while a buff freezes', () => {
  const mod = dbBuffsModule()
  const send = busTo(mod)

  // TWO MINUTES, and the length is the experiment. It is long enough that a paused clock and a
  // running one give visibly different readings, and short enough that BOTH instances are still
  // in the model at login — which is the only condition under which the two clocks can be read
  // side by side and compared. (It used to be 45 minutes. JOS-140's unwitnessed-expiry cull, the
  // owner's third amendment, retires an overdue DEBUFF after its own grace rather than leaving it
  // squatting at 0s for ninety minutes, so at 45 minutes there is no debuff left to read. The
  // test below is that case, and it turns the disappearance itself into the assertion.)
  const OFFLINE = 2 * MIN
  const t0 = at('Sat Aug 01 20:00:00 2026')
  castAndLand(send, { spell: SWIFT, target: 'self', durationMs: SWIFT_DB_MS, landTs: t0 })
  castAndLand(send, { spell: SLOW, target: MOB, durationMs: SLOW_DB_MS, landTs: t0 + 30 * SEC })

  const lastSeen = t0 + 60 * SEC
  send({ kind: 'unknown', ts: lastSeen } as LogEvent)
  const welcome = lastSeen + OFFLINE
  send({ kind: 'sessionStart', ts: welcome } as LogEvent)

  const snap = mod.snapshot().state
  const buff = rowOf(snap, SWIFT)
  const debuff = rowOf(snap, SLOW)
  assert.ok(buff && debuff, `both instances survive the absence: ${JSON.stringify(snap.active)}`)
  assert.equal(buff.cls, 'buff')
  assert.equal(debuff.cls, 'debuff')

  // THE ASYMMETRY, one line each. Your character was paused, so your haste is 60 seconds old.
  assert.equal(buff.startedTs, t0 + OFFLINE)
  assert.equal(welcome - buff.startedTs, 60 * SEC)
  // The mob was not, so the slow you left on it is 150 seconds old — its whole stated duration,
  // spent while you were not there. The model says so rather than pretending you were watching.
  assert.equal(debuff.startedTs, t0 + 30 * SEC, 'a debuff clock is never shifted')
  assert.equal(welcome - debuff.startedTs, SLOW_DB_MS, 'and it ran out exactly while you were gone')

  // THE LEARNER IS CENSORED ON BOTH SIDES, for two different reasons (buffsShapes.ts states them
  // separately). The debuff's span is arithmetically world time — but the wear-off LINE only
  // exists while you are logged in, so its arrival dates the moment you were there to see it and
  // not the moment the spell ended. Both errors run long; both are refused.
  send({ kind: 'buffFade', ts: welcome + 10 * SEC, spell: SLOW, target: MOB } as LogEvent)
  send({
    kind: 'buffWearOff',
    ts: welcome + 20 * SEC,
    spell: SWIFT,
    candidates: [SWIFT],
    target: 'self'
  } as LogEvent)
  const after = mod.snapshot().state
  assert.equal(rowOf(after, SLOW), undefined)
  assert.equal(rowOf(after, SWIFT), undefined)
  assert.equal(samplesFor(after, SLOW), 0, 'a debuff cycle spanning an absence mints nothing either')
  assert.equal(samplesFor(after, SWIFT), 0)
})

test('…and over a LONG absence the unshifted debuff is culled, while the frozen buff is not', () => {
  // THE ASYMMETRY READ FROM THE OTHER END, and the owner's own case (JOS-140, third amendment):
  // slow a boss, then die — or camp, or zone — and the wear-off line is printed to a character
  // who is not there to receive it. Nothing witnesses the close, so the bar used to sit at 0s
  // until the ninety-minute hygiene cap noticed.
  //
  // Why it belongs in THIS file: the cull only fires because the debuff's clock was NEVER
  // SHIFTED. Had it been paused like the buff beside it, it would read 60 seconds old at login
  // and stay. So the disappearance is the same one-sentence design as the test above, observed
  // where reading `startedTs` no longer can: your character is paused, the world is not.
  const mod = dbBuffsModule()
  const send = busTo(mod)

  const OFFLINE = 45 * MIN
  const t0 = at('Sat Aug 01 21:00:00 2026')
  castAndLand(send, { spell: SWIFT, target: 'self', durationMs: SWIFT_DB_MS, landTs: t0 })
  castAndLand(send, { spell: SLOW, target: MOB, durationMs: SLOW_DB_MS, landTs: t0 + 30 * SEC })

  const lastSeen = t0 + 60 * SEC
  send({ kind: 'unknown', ts: lastSeen } as LogEvent)
  const welcome = lastSeen + OFFLINE
  send({ kind: 'sessionStart', ts: welcome } as LogEvent)

  const snap = mod.snapshot().state
  const buff = rowOf(snap, SWIFT)
  assert.ok(buff, 'your own buff is still up — EQ froze it with you and the pause gave it back')
  assert.equal(welcome - buff.startedTs, 60 * SEC, 'and it reads its true remaining, not the wall clock')
  assert.equal(rowOf(snap, SLOW), undefined, 'the slow you could not see expire is gone, not squatting at 0s')

  // A CULL IS NOT EVIDENCE. Nothing was observed, so nothing may be learned from it — the whole
  // difference between a cull and a wear-off.
  assert.equal(samplesFor(snap, SLOW), 0, 'an unwitnessed expiry mints no duration sample')
})

const HASTE = 'Alacrity'
const HASTE_DB_MS = 11 * MIN
const PET = 'Giber'

test('a PET buff freezes with you too — its timeout is judged in ONLINE time, never wall clock', () => {
  // JOS-149 widened the unwitnessed-expiry cull to rows that are NOT yours: a buff on a pet or an
  // ally has no wear-off line you are promised (the pet fade the game does print resolves against
  // the CURRENT pet, so a despawned pet's rows can never be named again), and the owner's
  // screenshot was two of them squatting at 0s for weeks.
  //
  // WHICH PUTS THE CULL ON THE PAUSED SIDE OF THE ASYMMETRY, and that is what this test pins. The
  // haste below is 11 minutes and its timeout is 60 s, so 45 minutes of ABSENCE is four times the
  // budget: if the sweep judged it against a `now` from the far side of the hole it would be gone
  // at login. It is not, twice over — the sweep HOLDS every buff row while a hole is unexplained,
  // and the pause then rewinds the clock the cull reads. The debuff test above is the same
  // sentence from the other end.
  const mod = dbBuffsModule()
  const send = busTo(mod)

  const OFFLINE = 45 * MIN
  const t0 = at('Sat Aug 01 22:00:00 2026')
  castAndLand(send, { spell: SWIFT, target: 'self', durationMs: SWIFT_DB_MS, landTs: t0 })
  castAndLand(send, { spell: HASTE, target: PET, durationMs: HASTE_DB_MS, landTs: t0 })

  const lastSeen = t0 + 60 * SEC
  send({ kind: 'unknown', ts: lastSeen } as LogEvent)
  const welcome = lastSeen + OFFLINE
  send({ kind: 'sessionStart', ts: welcome } as LogEvent)

  const back = rowOf(mod.snapshot().state, HASTE)
  assert.ok(back, 'the pet buff EQ froze with the character is up when the character is back')
  assert.equal(back.self, false, 'and it really is one of the rows the cull now reaches')
  assert.equal(back.startedTs, t0 + OFFLINE, 'shifted by the absence, exactly like the self buff beside it')
  assert.equal(welcome - back.startedTs, 60 * SEC, 'so it reads 60 s old, not 46 minutes')
  assert.ok(rowOf(mod.snapshot().state, SWIFT), 'the self buff is untouched by any of this')

  // ELEVEN MINUTES OF ONLINE TIME LATER it is exactly at zero, and still drawn: an overdue row for
  // a beat says the app is waiting for a line rather than pretending one arrived.
  send({ kind: 'unknown', ts: welcome + 10 * MIN } as LogEvent)
  assert.ok(rowOf(mod.snapshot().state, HASTE), 'at its stated end it is still there')

  // A MINUTE PAST THAT, nothing can close it and it stops being waited for.
  send({ kind: 'unknown', ts: welcome + 11 * MIN + 40 * SEC } as LogEvent)
  const after = mod.snapshot().state
  assert.equal(rowOf(after, HASTE), undefined, 'the pet buff nobody could see expire times out')
  assert.ok(rowOf(after, SWIFT), 'and a SELF buff at the same age is NOT culled — the exemption is `self`')
  assert.equal(samplesFor(after, HASTE), 0, 'a timeout is not evidence: no duration sample, ever')
})

test('a crowd-control hold is a timer in the world, and never pauses', () => {
  // The two modules on ONE bus, one absence, two answers — the whole design in a single stream.
  // Ensnare is 660 s, comfortably longer than the absence, so the hold is still live at login and
  // its clock is the only thing under test.
  const db = loadSpellDb()
  installSpellDb(db)
  const buffs = new BuffsModule(db)
  buffs.reset()
  // ONE MODEL, TWO MODULES (JOS-140): the CC half folds through the buffs module's own cast
  // anchors and mints into its own learner, exactly as modules/wiring.ts wires it.
  const timers = new BuffTimersModule(buffs.castAnchors(), buffs.spellStats())
  timers.reset()
  const send = busTo(buffs, timers)
  const MOB = 'a scareling'
  const OFFLINE = 5 * MIN

  const t0 = at('Sat Aug 01 21:00:00 2026')
  castAndLand(send, { spell: SWIFT, target: 'self', durationMs: SWIFT_DB_MS, landTs: t0 })
  send({ kind: 'castBegin', ts: t0 + SEC, spell: 'Ensnare' } as LogEvent)
  send({
    kind: 'cc',
    ts: t0 + 2 * SEC,
    mob: MOB,
    candidates: [
      { name: 'Ensnare', durationMs: 660 * SEC },
      { name: 'Snare', durationMs: 180 * SEC }
    ]
  } as LogEvent)
  const hold = timers.snapshot().state.holds[0]
  assert.ok(hold, 'the own cast narrows the two-spell sentence to one hold')
  assert.equal(hold.spell, 'Ensnare')

  const lastSeen = t0 + 30 * SEC
  send({ kind: 'unknown', ts: lastSeen } as LogEvent)
  const welcome = lastSeen + OFFLINE
  send({ kind: 'sessionStart', ts: welcome } as LogEvent)

  assert.equal(rowOf(buffs.snapshot().state, SWIFT)?.startedTs, t0 + OFFLINE, 'your buff froze')
  const stillHeld = timers.snapshot().state.holds[0]
  assert.ok(stillHeld, 'the root outlasts the absence — 660 s against five minutes')
  assert.equal(stillHeld.startedTs, t0 + 2 * SEC, 'and the mob it is on never stopped counting')
  assert.equal(welcome - stillHeld.startedTs, OFFLINE + 28 * SEC)
})

test('a hole no login explains still drops what predates it, and only that', () => {
  // The other branch. Waiting for a login is not the same as trusting every hole: when nothing
  // explains one, we lost the thread rather than the character having left, and the old blanket
  // clear is still the honest answer for whatever was standing when it opened.
  const mod = dbBuffsModule()
  const send = busTo(mod)
  const VALOR = 'Valor'
  const VALOR_DB_MS = 54 * MIN

  const t0 = at('Sat Aug 01 09:00:00 2026')
  castAndLand(send, { spell: SWIFT, target: 'self', durationMs: SWIFT_DB_MS, landTs: t0 })
  const lastSeen = t0 + 30 * SEC
  send({ kind: 'unknown', ts: lastSeen } as LogEvent)

  // The hole opens, and a buff is raised INSIDE the window where its explanation is still awaited.
  const holeAt = lastSeen + 45 * MIN
  send({ kind: 'unknown', ts: holeAt } as LogEvent)
  assert.ok(rowOf(mod.snapshot().state, SWIFT), 'the pre-hole buff is held, not yet judged')
  castAndLand(send, { spell: VALOR, target: 'self', durationMs: VALOR_DB_MS, landTs: holeAt + 2 * SEC })

  // The window elapses with no Welcome. Now it is judged — and the SCOPE of the ruling is the
  // point: the hole says nothing about a buff raised on this side of it.
  send({ kind: 'unknown', ts: holeAt + LOGIN_CONFIRM_MS + SEC } as LogEvent)
  const snap = mod.snapshot().state
  assert.equal(rowOf(snap, SWIFT), undefined, 'what was standing when the hole opened is dropped')
  const kept = rowOf(snap, VALOR)
  assert.ok(kept, 'what was cast after it is not')
  assert.equal(kept.startedTs, holeAt + 2 * SEC, 'and its clock was never touched')
})
