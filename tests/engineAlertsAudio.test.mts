// THE AUDIO CUTOVER'S TWO DECISIONS (JOS-491).
//
// Behind `EQC_ENGINE_ALERTS=1` the app plays alert audio from ENGINE fires and this process's own
// evaluator goes silent. Two things decide whether that is safe and whether it works, and both are
// pure (`src/main/dataServer/alertsAudioRules.ts`) precisely so they can be asked here rather than
// inferred from a running raid:
//
//   1. THE GATE, WHICH SINCE JOS-492 REFUSES NOTHING. It used to refuse over a def carrying
//      `earlyWarnSec`, because the engine COMPILED such a def out — its fire is one the app MOVES,
//      and JOS-482's engine had neither the wall clock nor the timer projection to move it with. It
//      has both now and honours the offset end to end, reading it through this app's own
//      normalizer, so the category the gate guarded is empty and the refusal is deleted rather than
//      left standing over nothing. The tests below pin the ARMING, including over the exact defs
//      that used to block.
//   2. THE TRANSLATION. A fire frame names its rule by LABEL; the renderer's player needs an ID.
//   3. THE WORDS (JOS-500, ruling 27). A fire frame carries what the firing may SAY — the JOS-103
//      captures, the JOS-353 `{target}` token, the JOS-84 resolved spell and the JOS-378 `dueAt` —
//      and this file copies them onto the firing rather than deriving them. Until that frame grew,
//      each of those resolved to nothing and a `custom` phrase spoke its tokens literally; the
//      owner ruled the loss release-gating, which is why the sentences below are asserted as
//      SENTENCES and not as field copies.
//
// WHAT IS NOT HERE. That the arm path actually consults the verdict, that the module actually goes
// quiet, and that exactly ONE sound comes out of a matching live line are claims about a running
// app with a running engine — `tests/e2e/engine-alert-fires.e2e.mts` drives all three end to end.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { armVerdict, fireToFiring } from '../src/main/dataServer/alertsAudioRules'
// THE OTHER HALF OF PARITY. `speechTextFor` is what turns a firing into words, and it is pure — no
// clock, no store, no I/O — so the frame-to-sentence claim can be made in one process rather than
// inferred from a running raid. It is the same function the renderer's player calls.
import { speechTextFor } from '../src/shared/speechText'
import type { FireMessage } from '../src/shared/dataServer/protocol.generated'
import type { AlertDef } from '../src/shared/types'

/** A minimal stored def. `trigger` is never read by either decision — both are about the def's
 *  IDENTITY and its offset — so it is the simplest shape the type accepts. */
function def(over: Partial<AlertDef> & Pick<AlertDef, 'id' | 'name'>): AlertDef {
  return {
    enabled: true,
    trigger: { type: 'raw', regex: 'x' },
    sound: { packId: 'classic', soundId: 'ding' },
    ...over
  }
}

function fire(over: Partial<FireMessage> = {}): FireMessage {
  return {
    kind: 'fire',
    at: 1_700_000_000_000,
    rule: 'Charm break',
    sound: 'classic/ding',
    message: 'Your charm spell has worn off.',
    ...over
  }
}

// ---- the gate -----------------------------------------------------------------------------------

test('THE GATE ARMS, and the line still SAYS SO', () => {
  const defs = [def({ id: 'charm-break', name: 'Charm break' }), def({ id: 'b', name: 'Mote dropped' })]
  const verdict = armVerdict(defs)
  assert.equal(verdict.arm, true)
  // The armed line is the reason the verdict is still a verdict and not a boolean: a silent
  // evaluator with no line explaining itself is the state a developer cannot tell apart from a
  // flag nobody set.
  assert.match(verdict.line, /the ENGINE now plays alert audio/)
})

test('AND IT ARMS OVER THE DEFS THAT USED TO BLOCK IT (JOS-492)', () => {
  // THE EXACT DEF THAT BLOCKED. `group:slow:mob` with `earlyWarnSec: 5` is what the owner's dev
  // profile carries and is what this gate refused over from JOS-491 until the offset landed
  // engine-side. The engine arms that warning off the timer projection now and fires it five
  // seconds before the row's stated end — proven in `fold`'s own suite against this same def —
  // so there is nothing left to swallow and nothing left to refuse.
  const slow = def({ id: 'group:slow:mob', name: 'Slow wore off a mob', earlyWarnSec: 5 })
  assert.equal(armVerdict([def({ id: 'charm-break', name: 'Charm break' }), slow]).arm, true)

  // …INCLUDING THE ONE INPUT THE TWO NORMALIZERS USED TO DISAGREE ABOUT. The app clamps 5000 to
  // its 120 s ceiling; JOS-482's engine read anything out of range as absent and would have fired
  // it immediately, which is why this case blocked hardest. The engine runs the app's normalizer
  // now, bound for bound, so both sides clamp to the same 120.
  assert.equal(armVerdict([def({ id: 'huge', name: 'Huge', earlyWarnSec: 5000 })]).arm, true)

  // …and the values NEITHER side acts on are still nothing to anybody: a zero is below the 1 s
  // floor and the other two are not finite numbers, so no warning is armed on either side.
  for (const raw of [0, Number.NaN, '10' as unknown as number]) {
    assert.equal(armVerdict([def({ id: 'junk', name: 'Junk', earlyWarnSec: raw })]).arm, true)
  }
})

test('AN EMPTY STORE ARMS. No defs is no alerts, not an unknown', () => {
  assert.equal(armVerdict([]).arm, true)
})

// ---- the translation ---------------------------------------------------------------------------

test('A FIRE BECOMES A FIRING the renderer can play: the label resolves back to the def ID', () => {
  const defs = [def({ id: 'charm-break', name: 'Charm break' })]
  const firing = fireToFiring(fire(), defs)
  assert.deepEqual(firing, {
    alertId: 'charm-break',
    // THE LOG'S CLOCK, carried through verbatim — `FireMessage.at` is the ts of the event that
    // matched, which is exactly what a main-side `FiredAlert.ts` has always been.
    ts: 1_700_000_000_000,
    matchedText: 'Your charm spell has worn off.'
  })
})

test('…and a frame with nothing to say still carries nothing, which is nearly every alert', () => {
  // THE COMMON CASE IS STILL THE COMMON CASE (JOS-500). This def declares no capture group, writes
  // no `{target}` phrase, matched a family that names no spell and carries no offset — so the
  // firing is byte-identical to the one this function produced before the frame grew. An absent key
  // is the honest encoding of "nothing true to say here"; `undefined`-valued keys would make every
  // downstream deepEqual a different assertion for no gain.
  const firing = fireToFiring(fire(), [def({ id: 'charm-break', name: 'Charm break' })])
  assert.deepEqual(Object.keys(firing ?? {}).sort(), ['alertId', 'matchedText', 'ts'])
})

// ---- the words (JOS-500, ruling 27) -------------------------------------------------------------
//
// The frame grew three fields and this function COPIES them. What is proven here is the copy and
// the parity it buys — that the same def, fired by the engine, speaks the sentence the retired
// evaluator spoke. `speechTextFor` is the thing that turns a firing into words and it is pure, so
// the two halves can be joined in one process: build the frame the engine sends, translate it, and
// ask the resolver what comes out. WHAT IS NOT HERE is that the engine PRODUCES such a frame —
// that is `fold`'s own suite (`alerts_rules.rs`, `alerts.rs`) — and that a running app makes the
// sound, which is `tests/e2e/voice-alerts.e2e.mts`.

test('A CUSTOM PHRASE SPEAKS THE NAME ITS PATTERN CAPTURED — the JOS-103 claim, end to end', () => {
  const puma = def({
    id: 'puma',
    name: 'Spirit of the puma',
    audio: 'speech',
    speech: { mode: 'custom', phrase: 'Puma on {player}' }
  })
  const firing = fireToFiring(
    fire({ rule: 'Spirit of the puma', captures: { player: 'Fail' } }),
    [puma]
  )
  assert.deepEqual(firing?.captures, { player: 'Fail' })
  // THE SENTENCE ITSELF. Before the frame grew, `{player}` had nothing to resolve to and the same
  // def spoke the literal "Puma on {player}" — a token rendered verbatim, which is the documented
  // behaviour for a value that is not there and was exactly the regression ruling 27 names.
  assert.equal(speechTextFor(puma, firing), 'Puma on Fail')
  assert.equal(speechTextFor(puma, null), 'Puma on {player}')
})

test('…and the `{target}` token speaks the mob, from a def with no regex in it (JOS-353)', () => {
  const mez = def({
    id: 'mez',
    name: 'Mez broke',
    audio: 'speech',
    speech: { mode: 'custom', phrase: 'Mez broke on {target}' }
  })
  const firing = fireToFiring(
    fire({ rule: 'Mez broke', captures: { target: 'a young puma' } }),
    [mez]
  )
  assert.equal(speechTextFor(mez, firing), 'Mez broke on a young puma')
})

test('A SPELL MODE SPEAKS THE SPELL, rank folded out by the resolver (JOS-84)', () => {
  const slow = def({ id: 'slow', name: 'Slow landed', audio: 'speech', speech: { mode: 'spellName' } })
  const firing = fireToFiring(fire({ rule: 'Slow landed', spell: 'Mesmerization III' }), [slow])
  // THE RANK ARRIVES INTACT AND IS FOLDED OUT WHERE IT SHOULD BE. The producer carries what the log
  // spelled; `speechTextFor` strips the numeral, because ranks are noise aloud and a consumer that
  // wants one must still be able to see it.
  assert.equal(firing?.spell, 'Mesmerization III')
  assert.equal(speechTextFor(slow, firing), 'Mesmerization')
  // `spellFirstWord` is the shortest useful utterance and reads the same field.
  const short = { ...slow, speech: { mode: 'spellFirstWord' } } as AlertDef
  assert.equal(speechTextFor(short, firing), 'Mesmerization')
})

test('…and a spell mode with NO spell still says something true: the alert’s own name', () => {
  // World-model law 1, and the behaviour that used to swallow EVERY spell-mode alert under the
  // engine because no frame could carry a spell at all. It is still the right answer for the
  // families that genuinely name none — an app signal, a raw trigger on a spell-less line.
  const slow = def({ id: 'slow', name: 'Slow landed', audio: 'speech', speech: { mode: 'spellName' } })
  assert.equal(speechTextFor(slow, fireToFiring(fire({ rule: 'Slow landed' }), [slow])), 'Slow landed')
})

test('AN EARLY WARNING CARRIES ITS DEADLINE, so the banner has something to count down to', () => {
  const slow = def({ id: 'group:slow:mob', name: 'Slow wore off a mob', earlyWarnSec: 5 })
  const firing = fireToFiring(
    fire({ rule: 'Slow wore off a mob', at: 1_700_000_056_000, dueAt: 1_700_000_061_000 }),
    [slow]
  )
  assert.equal(firing?.dueAt, 1_700_000_061_000)
  // THE GAP IS THE LEAD TIME THE USER CONFIGURED. `ts` is when the sound was made and `dueAt` is
  // what it was early for, so the difference is the def's own five seconds — which is the whole of
  // what JOS-378 put on screen.
  assert.equal((firing?.dueAt ?? 0) - (firing?.ts ?? 0), 5_000)
})

test('THE THREE FIELDS ARE COPIED, NEVER RE-DERIVED — the second-evaluator refusal, as source', () => {
  // Every one of them is an evaluator's answer (which candidate satisfied the matcher, which text
  // the matching condition tested, whether the phrase asked for a target). This file's whole
  // discipline is that it decides none of that, so the copy is asserted to be a copy: a capture map
  // the app could not possibly have derived — the def carries no pattern at all — arrives intact.
  const opaque = def({ id: 'opaque', name: 'Opaque', speech: { mode: 'custom', phrase: '{a} {b}' } })
  const firing = fireToFiring(fire({ rule: 'Opaque', captures: { a: 'one', b: 'two' } }), [opaque])
  assert.deepEqual(firing?.captures, { a: 'one', b: 'two' })
  assert.equal(speechTextFor(opaque, firing), 'one two')
  // …and it is a COPY rather than the frame's own object, so nothing downstream holds a reference
  // into a decoded frame.
  const frame = fire({ rule: 'Opaque', captures: { a: 'one' } })
  assert.notEqual(fireToFiring(frame, [opaque])?.captures, frame.captures)
})

test('A LABEL NOTHING ANSWERS TO IS DROPPED, never played as somebody else', () => {
  const defs = [def({ id: 'charm-break', name: 'Charm break' })]
  assert.equal(fireToFiring(fire({ rule: 'A def the user deleted' }), defs), null)
  assert.equal(fireToFiring(fire(), []), null)
})

test('TWO DEFS WITH ONE NAME are separated by the SOUND the engine stated', () => {
  const defs = [
    def({ id: 'quiet', name: 'Slow landed', sound: { packId: 'classic', soundId: 'blip' } }),
    def({ id: 'loud', name: 'Slow landed', sound: { packId: 'alan-rickman', soundId: 'oh-dear' } })
  ]
  assert.equal(fireToFiring(fire({ rule: 'Slow landed', sound: 'alan-rickman/oh-dear' }), defs)?.alertId, 'loud')
  assert.equal(fireToFiring(fire({ rule: 'Slow landed', sound: 'classic/blip' }), defs)?.alertId, 'quiet')
})

test('…and when even the sound cannot separate them, the FIRST is played rather than none', () => {
  // Same name, same pack sound: whichever is picked makes the identical noise, so the worst case
  // left is a volume. A dropped alert would be a strictly worse answer.
  const defs = [
    def({ id: 'first', name: 'Twin', volume: 0.2 }),
    def({ id: 'second', name: 'Twin', volume: 1 })
  ]
  assert.equal(fireToFiring(fire({ rule: 'Twin' }), defs)?.alertId, 'first')
  // A sound key matching NEITHER of them still resolves — the label is the identity, and the
  // narrowing is a tiebreak rather than a second test the fire has to pass.
  assert.equal(fireToFiring(fire({ rule: 'Twin', sound: 'gone/missing' }), defs)?.alertId, 'first')
})

test('MATCHING IS EXACT: a label that differs by case is a different alert', () => {
  const defs = [def({ id: 'charm-break', name: 'Charm break' })]
  assert.equal(fireToFiring(fire({ rule: 'charm break' }), defs), null)
})

// ---- 3. WHERE the swap is thrown (JOS-496) ----------------------------------------------
//
// A THIRD DECISION, added because getting it wrong shipped a silence. The two above ask WHETHER the
// engine may own the sound and WHAT a fire means; this asks WHEN the handoff happens, and the answer
// has to be an edge that means "there is an engine" rather than a flag that means "nobody asked for
// it to be gone".
//
// THE DEFECT, for whoever reads this next. `armEngineAlerts()` was called from
// `startEngineSupervisor()`, before any binary had been probed for. Its two flags are DEFAULT-ON
// since JOS-495, so a dev checkout that had never run `cargo build` armed — and arming calls
// `alertsModule.setEngineOwnsAudio(true)`, which makes this process's own `publish` a no-op. No
// binary, no client, no `fire` frame, ever: the app silenced its own evaluator in favour of an
// engine that did not exist and played NO ALERTS AT ALL until quit. The same state is reachable in a
// packaged build whose engine fails to spawn or sits in the crash-loop backoff.
//
// Source pins, in `serveDeltaArm.test.mts`' technique (comments stripped first — this repo explains
// itself in prose that would otherwise satisfy its own greps), because every module on this path
// reaches Electron. The BEHAVIOURAL half is `dataServerSupervisor.test.mts`: with no binary the
// READY edge never fires in either direction, so nothing is ever handed over.

const hostCode = (): string =>
  readFileSync(new URL('../src/main/dataServer/engineHost.ts', import.meta.url), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1')

test('THE SWAP HANGS OFF THE READY EDGE, never off process start', () => {
  const host = hostCode()
  // Both directions, in the one callback that knows whether an engine exists.
  assert.match(host, /if \(info === null\) disarmEngineAlerts\(\)\s*\n\s*else armEngineAlerts\(\)/)
  // …and the call that shipped the silence is gone from where it shipped it. The precise claim is
  // about the STRAIGHT-LINE body of `startEngineSupervisor` — everything that runs before the
  // supervisor object even exists, and therefore before any binary has been probed for. An arm
  // anywhere in that stretch is the same bug wearing a new line number. (The `onReady` callback is
  // lexically inside the same function and is exactly where the arm is SUPPOSED to be, which is why
  // this reads the prefix rather than the whole body.)
  const starter = /export function startEngineSupervisor\(\): void \{([\s\S]*?)supervisor \?\?= createEngineSupervisor\(/.exec(host)
  assert.ok(starter, 'startEngineSupervisor is gone, or no longer builds the supervisor')
  assert.doesNotMatch(starter[1], /armEngineAlerts\(\)/)
  assert.doesNotMatch(starter[1], /disarmEngineAlerts\(\)/)
})

test('THE SWAP IS STILL NOT LATE: it completes before the client that hears a fire exists', () => {
  // The original placement's one good reason, and it is preserved rather than traded away: a frame
  // landing on an app that has not yet decided who owns the sound is one alert played by the wrong
  // world. `onEngineReady` is what opens the connection carrying `onFire`, so the arm must precede
  // it in the same callback.
  const host = hostCode()
  const arm = host.indexOf('else armEngineAlerts()')
  const connect = host.indexOf('onEngineReady(info)')
  assert.ok(arm > 0 && connect > 0)
  assert.ok(arm < connect, 'the connection is opened before the sound has been handed over')
})

test('the teardown still gives the sound back, so a quit cannot leave a silenced app', () => {
  const host = hostCode()
  const stop = /export function stopEngineSupervisor\(\): void \{([\s\S]*?)\n\}/.exec(host)
  assert.ok(stop, 'stopEngineSupervisor is gone')
  assert.match(stop[1], /disarmEngineAlerts\(\)/)
})
