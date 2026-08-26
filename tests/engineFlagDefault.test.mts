// THE ENGINE IS THE DEFAULT (JOS-495) — the inverted flag matrix, pinned.
//
// The owner's cutover ruling turned three opt-ins into three escape hatches: `EQC_ENGINE`,
// `EQC_ENGINE_SERVE` and `EQC_ENGINE_ALERTS` are ON unless something says `=0`. That is a one-token
// change at each gate (`=== '1'` → `engineFlagOn`) and it is exactly the kind of change that ships
// four-fifths done: the four gates somebody remembered come up default-on, the fifth stays
// default-off, and the app runs in a state no launch was ever meant to be in — served snapshots
// with suppressed cursors (`serveDeltas.ts`, the JOS-490 freeze), or an engine main is running that
// the renderer never tries to connect to (`preload/engine.ts`).
//
// SO THIS FILE ASKS TWO DIFFERENT KINDS OF QUESTION, and needs both:
//
//   1. WHAT DOES THE PREDICATE ANSWER — behavioural, over the pure module every gate now shares
//      (`src/shared/dataServer/engineFlags.ts`). Default on, `'0'` off, `'1'` still on, and no
//      invented vocabulary in between.
//   2. WHO ASKS IT — source pins, because the five gates are `const`s computed at module load in
//      files that import Electron, the pipeline and the error log. Their value cannot be observed
//      from a node test at all; what CAN be held is that each one is spelled through the shared
//      predicate and composed the way the ruling says. `tests/serveDeltaArm.test.mts` is the
//      precedent for the technique, comment-stripping included — this repo explains itself in prose
//      that would otherwise satisfy its own greps.
//
// WHAT IS NOT HERE. That a default-on launch actually spawns an engine, and that `EQC_ENGINE=0`
// actually stops it, are claims about two real processes: `tests/e2e/engine-boots.e2e.mts` makes
// both (step 1 and step 5, the absence contract read inverted).
//
// Imported RELATIVELY: node tests run through tsx with no `@shared` alias.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { engineFlagOn } from '../src/shared/dataServer/engineFlags'

const src = (rel: string): string => readFileSync(new URL(rel, import.meta.url), 'utf8')

/** The same file with its COMMENTS removed — see the header. */
const code = (rel: string): string =>
  src(rel)
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1')

const HOST = '../src/main/dataServer/engineHost.ts'
const SHIM = '../src/main/dataServer/serveShim.ts'
const AUDIO = '../src/main/dataServer/alertsAudio.ts'
const DELTAS = '../src/main/dataServer/serveDeltas.ts'
const PRELOAD = '../src/preload/engine.ts'

/** Every module that turns one of the three variables into a boolean. If a sixth appears, it must
 *  be added here — the audit at the bottom of this file is what makes that true. */
const GATES = [HOST, SHIM, AUDIO, DELTAS, PRELOAD] as const

// ── 1. the predicate itself ────────────────────────────────────────────────────────────

test('AN UNSET FLAG MEANS ON — the whole ticket, in one assertion', () => {
  assert.equal(engineFlagOn(undefined), true)
})

test('`0` is the escape hatch, and the only one', () => {
  assert.equal(engineFlagOn('0'), false)
})

test('`1` still means on, so every shell, script and spec that carries it keeps working', () => {
  assert.equal(engineFlagOn('1'), true)
})

test('nothing else is an off switch — the vocabulary is one token wide', () => {
  // A predicate that also honoured these would be inventing spellings nobody documented, and the
  // failure is silent in the worst direction: a developer who typed one of them to take the engine
  // OUT of a diagnosis would spend the next hour reading the wrong process. `engineFlags.ts` says so
  // in prose; this is the prose held to account.
  for (const value of ['false', 'off', 'no', 'FALSE', '', ' ', '00', '0.0', 'disabled']) {
    assert.equal(engineFlagOn(value), true, `"${value}" was treated as the documented off switch`)
  }
})

// ── 2. the matrix the three gates compose out of it ────────────────────────────────────

/** The three gates as the product composes them, re-derived here from the ONE predicate the product
 *  uses. The compositions themselves (`engineEnabled() && …`, `serve && alerts`) are held by the
 *  source pins below; this table is what those compositions MEAN, launch by launch. */
function matrix(env: {
  EQC_ENGINE?: string
  EQC_ENGINE_SERVE?: string
  EQC_ENGINE_ALERTS?: string
}): { engine: boolean; serving: boolean; alerts: boolean } {
  const engine = engineFlagOn(env.EQC_ENGINE)
  const serving = engine && engineFlagOn(env.EQC_ENGINE_SERVE)
  // `alertsAudio.ts` reads both narrower flags and is REACHED only from inside the engine guard, so
  // the first term is structural rather than spelled. Modelled here as the conjunction it is.
  const alerts = engine && engineFlagOn(env.EQC_ENGINE_SERVE) && engineFlagOn(env.EQC_ENGINE_ALERTS)
  return { engine, serving, alerts }
}

test('THE ORDINARY LAUNCH — nothing set — gets all three', () => {
  assert.deepEqual(matrix({}), { engine: true, serving: true, alerts: true })
})

test('EQC_ENGINE=0 disables EVERYTHING, whatever the granular flags say', () => {
  for (const over of [
    {},
    { EQC_ENGINE_SERVE: '1' },
    { EQC_ENGINE_ALERTS: '1' },
    { EQC_ENGINE_SERVE: '1', EQC_ENGINE_ALERTS: '1' }
  ]) {
    assert.deepEqual(
      matrix({ EQC_ENGINE: '0', ...over }),
      { engine: false, serving: false, alerts: false },
      `EQC_ENGINE=0 left something armed with ${JSON.stringify(over)}`
    )
  }
})

test('EQC_ENGINE_SERVE=0 keeps the engine and takes the read path — and the sound with it', () => {
  // The sound goes too, and that is not an oversight: a launch whose reads come from the app's own
  // fold is a launch where an engine fire would be a second world sharing one alert lane.
  assert.deepEqual(matrix({ EQC_ENGINE_SERVE: '0' }), {
    engine: true,
    serving: false,
    alerts: false
  })
})

test('EQC_ENGINE_ALERTS=0 takes ONLY the sound — the reads are still served', () => {
  assert.deepEqual(matrix({ EQC_ENGINE_ALERTS: '0' }), {
    engine: true,
    serving: true,
    alerts: false
  })
})

test('explicit `=1` everywhere is the same launch as setting nothing at all', () => {
  assert.deepEqual(
    matrix({ EQC_ENGINE: '1', EQC_ENGINE_SERVE: '1', EQC_ENGINE_ALERTS: '1' }),
    matrix({})
  )
})

// ── 3. who asks it ─────────────────────────────────────────────────────────────────────

test('EVERY gate reads its variable through the shared predicate', () => {
  for (const gate of GATES) {
    const mod = code(gate)
    assert.match(mod, /\bengineFlagOn\(/, `${gate} does not go through engineFlags.ts`)
    assert.match(
      mod,
      /from '[^']*shared\/dataServer\/engineFlags'/,
      `${gate} calls engineFlagOn without importing it from the one module that defines it`
    )
  }
})

test('and NO gate compares a flag to a literal — that is the shape the flip had to delete', () => {
  for (const gate of GATES) {
    const mod = code(gate)
    assert.doesNotMatch(
      mod,
      /process\.env\.EQC_ENGINE[A-Z_]*\s*[!=]==?\s*'/,
      `${gate} still decides a gate by comparing the variable to a string literal`
    )
  }
})

test('engineEnabled is the ONE reading of EQC_ENGINE in main, and it is default-on', () => {
  const host = code(HOST)
  assert.match(
    host,
    /export function engineEnabled\(\): boolean \{\s*return engineFlagOn\(process\.env\.EQC_ENGINE\)\s*\}/,
    'engineHost.ts no longer states the whole feature gate in one expression'
  )
  // Every other main-process module reaches this answer by importing it. `serveDeltas.ts` is the
  // documented exception and its header says why (an import cycle for a boolean already true).
  for (const gate of [SHIM, AUDIO]) {
    assert.doesNotMatch(
      code(gate),
      /process\.env\.EQC_ENGINE\b(?!_)/,
      `${gate} re-reads the feature variable instead of importing engineEnabled()`
    )
  }
})

test('the serve gate is still the AND of both — a granular flag is meaningless alone', () => {
  assert.match(
    code(SHIM),
    /const SERVING = engineEnabled\(\) && engineFlagOn\(process\.env\.EQC_ENGINE_SERVE\)/,
    'serveShim.ts stopped gating the serve flag on the feature flag'
  )
})

test('the alerts gate reads BOTH narrower flags, so a bisecting developer can separate them', () => {
  const audio = code(AUDIO)
  assert.match(audio, /engineFlagOn\(process\.env\.EQC_ENGINE_SERVE\)/, 'the serve term is gone')
  assert.match(audio, /engineFlagOn\(process\.env\.EQC_ENGINE_ALERTS\)/, 'the alerts term is gone')
  assert.match(audio, /const WANTED =[\s\S]{0,160}?&&/, 'WANTED is no longer a conjunction')
})

test('THE DELTA ARM INVERTED WITH THE SHIM — the half a four-fifths flip would have missed', () => {
  // Served snapshots with suppressed cursors is the JOS-490 freeze, and a `=== '1'` left standing
  // here would have shipped it to every ordinary launch rather than to the developers who opted in.
  const mod = code(DELTAS)
  assert.match(mod, /const SERVE_ASKED = engineFlagOn\(process\.env\.EQC_ENGINE_SERVE\)/)
  for (const fn of ['pushModuleChanged', 'pushWorldChanged']) {
    const decl = new RegExp(`export function ${fn}\\([^)]*\\): void \\{\\s*if \\(!SERVE_ASKED\\) return`)
    assert.match(mod, decl, `${fn} is not gated on the serve flag`)
  }
})

test('THE RENDERER READOUT INVERTED TOO — the other half a four-fifths flip would have missed', () => {
  // `engineProvider.tsx` will not attempt a connect this says no to, so a readout still comparing
  // `=== '1'` leaves the brokered renderer client dark in exactly the builds it is meant to run in,
  // silently at both ends: main refuses nothing, because the renderer asks nothing.
  assert.match(
    code(PRELOAD),
    /engineEnabled: engineFlagOn\(process\.env\.EQC_ENGINE\)/,
    'the preload readout no longer agrees with main about what the flag means'
  )
})

// ── 4. the audit: a sixth reader must come here ────────────────────────────────────────

test('no OTHER file in main, preload or shared decides anything by reading these variables', () => {
  const suspects = [
    '../src/main/dataServer/engineClientHost.ts',
    '../src/main/dataServer/rendererBroker.ts',
    '../src/main/dataServer/definePush.ts',
    '../src/main/dataServer/parityProbe.ts',
    '../src/main/enginePerfWatch.ts',
    '../src/main/pipeline.ts',
    '../src/main/ipc/world.ts',
    '../src/main/ipc/index.ts',
    '../src/main/index.ts',
    '../src/preload/index.ts',
    '../src/preload/overlay.ts'
  ]
  for (const file of suspects) {
    assert.doesNotMatch(
      code(file),
      /process\.env\.EQC_ENGINE/,
      `${file} grew a gate of its own — add it to GATES above and give it the shared predicate`
    )
  }
})
