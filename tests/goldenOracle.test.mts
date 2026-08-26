/**
 * ============================================================================
 * goldenOracle.test.mts — THE RECORDER IS A FUNCTION OF THE BYTES (JOS-465).
 * ============================================================================
 *
 * `tests/bench/goldenOracle.mts` records what the future Rust engine must reproduce, and
 * `npm run oracle:check` is the acceptance gate a cutover will be argued from. Both of those
 * claims rest on a property nobody had asserted: that a golden is a function of the LOG and of
 * nothing else — not of when it was recorded, not of how the replay was sliced, and not of
 * whether the comparator is actually looking.
 *
 * THE SIX SLICES CANNOT BE THE INPUT HERE. They are gitignored (the owner's real game log) and
 * absent from CI, and a suite that silently skips on a machine without them is a suite that
 * stops watching the moment it matters. So every test below runs the REAL record/check path over
 * a COMMITTED fixture, in a temp directory, in about a second.
 *
 * WHAT THIS DELIBERATELY DOES NOT DO: re-assert that the fold reads no wall clock.
 * `tests/foldDeterminism.test.mts` owns that property — dynamically, over the real program —
 * and it is the guarantee that makes goldens meaningful in the first place. What it does NOT
 * cover, and what the recorder needed, is the half OUTSIDE its measured window: the world's
 * CONSTRUCTION, which its own header exempts by name ("a fresh fold is entitled to today's
 * reading"). That exemption is correct for the app and fatal for a golden, and the third test
 * below is where the two meet.
 */
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { REPLAY_SLICE_MS, createSlicer } from '../src/main/log/replaySlicer'
import { checkSlice, eventsPath, isParserEvent, recordSlice, snapshotsPath, type SliceRef } from './bench/goldenOracle.mjs'
import { foldForGoldens } from './bench/foldArm.mjs'
import type { LogEvent } from '../src/shared/logEvents'

/**
 * A committed fixture dressed as a slice. The oracle reads the character out of the FILENAME
 * (`eqlog_<Name>_<server>.<slice>.txt`), so the fixture is referenced through a name of that
 * shape pointing at the real committed bytes — the fixture is not copied and not modified.
 */
const FIXTURE = join(import.meta.dirname, 'fixtures', 'cw2-loadout-swap-aug2.log')
const SLICE: SliceRef = { name: 'harness', file: 'eqlog_Primitive_freeport.harness.txt', path: FIXTURE }

/** Every test gets its own goldens directory; none of them touch the real one. */
function withDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), 'eqc-golden-'))
  return fn(dir).finally(() => {
    rmSync(dir, { recursive: true, force: true })
  })
}

// --------------------------------------------------------------------------- the round trip

test('the recorder round-trips: what oracle:record writes, oracle:check accepts', async () => {
  await withDir(async (dir) => {
    const rec = await recordSlice(SLICE, { goldensDir: dir })
    assert.ok(rec.golden.parserEvents > 500, `the fixture should fold hundreds of events (${String(rec.golden.parserEvents)})`)
    assert.equal(rec.golden.modules.length, 20, 'every module in modules.ordered is recorded')
    assert.ok(rec.golden.modules.every((m) => m.snapshot !== null), 'every recorded module answered snapshot()')
    assert.ok(rec.golden.lastEventTs > 0, 'the combat instant is the log\'s own last event ts')

    assert.deepEqual(await checkSlice(SLICE, { goldensDir: dir }), [], 'a fresh re-fold agrees with the golden')

    // …and RECORDING twice produces the same bytes, which is the claim `manifest.json`'s
    // per-artifact sha256 is only worth anything if it holds.
    const before = readFileSync(eventsPath(SLICE.name, dir))
    const again = await recordSlice(SLICE, { goldensDir: dir })
    assert.equal(again.eventsSha, rec.eventsSha, 'two recordings of one fixture are byte-identical')
    assert.equal(again.snapshotsSha, rec.snapshotsSha, 'two recordings agree about every snapshot')
    assert.deepEqual(readFileSync(eventsPath(SLICE.name, dir)), before, 'and the file on disk is the same file')
  })
})

// ------------------------------------------------------------------------ the derived exclusion

test('phase 1 records the PARSER\'s events: the three derived kinds never reach the stream', async () => {
  // The exclusion is only meaningful if the fold actually produces some — otherwise the filter is
  // untested and a regression that deleted it would leave every test above green.
  const kinds = new Map<string, number>()
  await foldForGoldens(
    { name: 'Primitive', server: 'freeport', logPath: FIXTURE },
    { constructionNowMs: 0, observe: (ev: LogEvent) => kinds.set(ev.kind, (kinds.get(ev.kind) ?? 0) + 1) }
  )
  const derived = ['buffExpired', 'epoch', 'offlineGap'].reduce((n, k) => n + (kinds.get(k) ?? 0), 0)
  assert.ok(derived > 0, 'this fixture must actually emit derived events, or the exclusion is untested')

  await withDir(async (dir) => {
    await recordSlice(SLICE, { goldensDir: dir })
    const lines = readFileSync(eventsPath(SLICE.name, dir), 'utf8').trimEnd().split('\n')
    const seen = lines.map((l) => (JSON.parse(l) as LogEvent).kind)
    for (const k of ['buffExpired', 'epoch', 'offlineGap']) {
      assert.ok(!seen.includes(k), `${k} is produced downstream of the parser and must not be in a phase-1 golden`)
    }
    assert.equal(lines.length + derived, [...kinds.values()].reduce((a, b) => a + b, 0), 'and exactly the derived ones were dropped')
  })

  assert.equal(isParserEvent({ kind: 'buffExpired' } as unknown as LogEvent), false)
  assert.equal(isParserEvent({ kind: 'dmg' } as unknown as LogEvent), true)
})

// ------------------------------------------------------------------- the construction-clock pin

/**
 * THE PROPERTY, AND AN HONEST NOTE ABOUT THE PIN THAT DEFENDS IT.
 *
 * What is asserted is the thing `oracle:check` needs: build the same world at two instants an
 * hour apart and every published snapshot is the same. A module that starts leaking its
 * construction clock into `snapshot()` fails here, which is the guard worth having.
 *
 * WHAT IS NOT CLAIMED, because it was MEASURED and is not true today: that the pin is currently
 * changing an answer. The one known reader is `RespawnModule`, which seeds its ordering clock
 * from `Date.now()` at `reset()` and carries it into `orderRespawnRows` — but a respawn ROW is
 * only published for a WATCHED mob, watches are a user-store fact, and the bench world has no
 * store. Measured on all six of the owner's slices at record time: `rows: []`, every one. So
 * this test would pass with the pin removed, and it is recorded here that it would, so nobody
 * later reads a green as evidence the pin is doing work.
 *
 * THE PIN STAYS ANYWAY, and the reason is the asymmetry: it costs one assignment at construction
 * and it closes a whole CLASS — any module seeded from the wall clock before the first event —
 * without anyone having to re-audit twenty modules each time one grows a field. The day a watch
 * pref reaches this harness, or a second module does what respawn does, the goldens keep meaning
 * what they say instead of quietly becoming a function of the hour they were recorded in.
 */
test('a golden does not depend on WHEN the world was built', async () => {
  const fold = async (constructionNowMs: number): Promise<string> => {
    const { world } = await foldForGoldens({ name: 'Primitive', server: 'freeport', logPath: FIXTURE }, { constructionNowMs })
    return JSON.stringify(world.moduleIds.map((id) => world.registry.snapshot(id)))
  }
  const t = 1_787_000_000_000
  assert.equal(await fold(t), await fold(t + 3_600_000), 'every module\'s published snapshot is a function of the log, not of the hour')
})

// ---------------------------------------------------------------------------- slicer invariance

/**
 * `tests/replayChunking.test.mts` proves a yield cannot change the event stream or ONE module's
 * state over a synthetic corpus. This asks the same question of the WHOLE recorded world — all
 * 20 modules, the combat engine and its scope walk — over a real fixture, and it asks it THROUGH
 * THE RECORDER, so what is proven slicer-invariant is the artifact `oracle:check` compares
 * rather than a hand-rolled restatement of it that could drift from it.
 *
 * The arms are that file's, and the rest is faked for the reason it states: the corpus yields
 * after every event, so real rests would be hours, and a pause of zero exercises the same branch
 * as a pause of 15.6 ms.
 */
test('a golden does not depend on HOW the replay was sliced', async () => {
  await withDir(async (dir) => {
    await recordSlice(SLICE, { goldensDir: dir })
    const arms = [
      { name: 'budget 0ms, no rest', make: () => createSlicer({ budgetMs: 0, duty: 1 }) },
      { name: `budget ${String(REPLAY_SLICE_MS)}ms, no rest`, make: () => createSlicer({ budgetMs: REPLAY_SLICE_MS, duty: 1 }) },
      { name: 'budget 0ms, RESTING', make: () => createSlicer({ budgetMs: 0, restFor: () => Promise.resolve() }) },
      { name: `budget ${String(REPLAY_SLICE_MS)}ms, RESTING`, make: () => createSlicer({ budgetMs: REPLAY_SLICE_MS, restFor: () => Promise.resolve() }) }
    ]
    for (const arm of arms) {
      assert.deepEqual(await checkSlice(SLICE, { goldensDir: dir, slicer: arm.make() }), [], `${arm.name}: the whole golden is unmoved`)
    }
  })
})

// ------------------------------------------------------------------------- the comparator's own tripwire

/**
 * A CHECKER THAT CANNOT FAIL IS NOT A GATE. `foldDeterminism.test.mts` sets the precedent: prove
 * the instrument reacts, or every green above is compatible with the instrument being switched
 * off. Both halves of the artifact are corrupted by hand and both must be caught, at the right
 * place, with a report a person can act on.
 */
test('a planted divergence is caught, in the right place, and named', async () => {
  await withDir(async (dir) => {
    await recordSlice(SLICE, { goldensDir: dir })
    const eventsFile = eventsPath(SLICE.name, dir)
    const snapsFile = snapshotsPath(SLICE.name, dir)
    const events = readFileSync(eventsFile, 'utf8')
    const snaps = readFileSync(snapsFile, 'utf8')

    // (1) ONE byte of ONE event, four hundred events in.
    const lines = events.trimEnd().split('\n')
    const victim = JSON.parse(lines[400]) as LogEvent & { ts: number }
    lines[400] = JSON.stringify({ ...victim, ts: victim.ts + 1 })
    writeFileSync(eventsFile, lines.join('\n') + '\n')
    const evDiff = await checkSlice(SLICE, { goldensDir: dir })
    assert.ok(evDiff.length > 0, 'a corrupted event stream must be caught')
    assert.equal(evDiff[0].where, 'events')
    assert.equal(evDiff[0].seq, 401, 'and reported at the event it actually diverged on (1-based)')
    writeFileSync(eventsFile, events)

    // (2) A TRUNCATED stream — the failure mode a crashed recorder produces, which a
    //     line-for-line comparison would otherwise walk off the end of in silence.
    writeFileSync(eventsFile, lines.slice(0, 500).join('\n') + '\n')
    const cut = await checkSlice(SLICE, { goldensDir: dir })
    assert.ok(cut.length > 0 && cut[0].where === 'events', 'a golden that ends early is a divergence, not a pass')
    writeFileSync(eventsFile, events)

    // (3) A single number inside a module's published state, reported with the MODULE'S NAME —
    //     which is the difference between a usable acceptance report and a diff of two 3 MB files.
    const parsed = JSON.parse(snaps) as { modules: { id: string; snapshot: { seq: number } | null }[] }
    const i = parsed.modules.findIndex((m) => m.snapshot !== null)
    ;(parsed.modules[i].snapshot as { seq: number }).seq += 1
    writeFileSync(snapsFile, JSON.stringify(parsed))
    const snapDiff = await checkSlice(SLICE, { goldensDir: dir })
    assert.ok(snapDiff.length > 0, 'a corrupted snapshot must be caught')
    const d = snapDiff[snapDiff.length - 1]
    assert.equal(d.where, 'snapshots')
    assert.equal(d.module, parsed.modules[i].id, 'the report names the module, not just an array index')
    assert.match(d.path ?? '', /^\.modules\[\d+\]\.snapshot\.seq$/, 'and the dotted path points at the field')
  })
})
