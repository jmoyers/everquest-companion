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
//
// WHAT IS NOT HERE. That the arm path actually consults the verdict, that the module actually goes
// quiet, and that exactly ONE sound comes out of a matching live line are claims about a running
// app with a running engine — `tests/e2e/engine-alert-fires.e2e.mts` drives all three end to end.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { armVerdict, fireToFiring } from '../src/main/dataServer/alertsAudioRules'
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

test('…and it carries NOTHING ELSE. No captures, no spell, no dueAt — a frame has four fields', () => {
  const firing = fireToFiring(fire(), [def({ id: 'charm-break', name: 'Charm break' })])
  assert.deepEqual(Object.keys(firing ?? {}).sort(), ['alertId', 'matchedText', 'ts'])
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
