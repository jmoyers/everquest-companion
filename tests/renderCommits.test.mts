// renderCommits — the render meter's arithmetic, and the audit that keeps it out of a build
// (JOS-513, ruling 19 extended to the renderer).
//
// TWO KINDS OF CLAIM, and both can be made here:
//
//   * THE ARITHMETIC. `src/renderer/src/lib/renderCommits.ts` is a ring and four questions asked of
//     it, with a clock the caller supplies — so every rate, every window boundary and every
//     "there is no answer" case is drivable by hand, with no React and no DOM. That is the whole
//     reason the arithmetic lives in a file that imports nothing.
//   * THE GATE. "DEV-MODE ONLY instrumentation (zero production cost)" is a claim about WHERE the
//     Profiler is mounted, which no runtime test in this suite can see — so it is audited as a fact
//     about the SOURCE, the shape `tests/domainMunging.test.mts` and `tests/alertTargetToken.test.mts`
//     already use: the set of files that mount a Profiler is pinned, and each one must check the
//     gate. The end-to-end half of the same claim is `tests/e2e/perf.e2e.mts`, which opens the real
//     popover in a real production-shaped build and asserts the section is ABSENT.
//
// Relative value imports, per repo law: this suite resolves no `@shared/*` alias.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import {
  RENDER_RING_CAPACITY,
  RENDER_WINDOW_MS,
  createRing,
  recordCommit,
  summarizeCommits,
  type CommitRing
} from '../src/renderer/src/lib/renderCommits'

const ROOT = 'app'

/** Record a run of cheap commits on one id, one millisecond apart from `from`. Durations that
 *  MATTER to a test are written out with `recordCommit` at the site that cares. */
function burst(ring: CommitRing, id: string, from: number, count: number): void {
  for (let n = 0; n < count; n += 1) recordCommit(ring, id, from + n, 1)
}

const read = (ring: CommitRing, now: number, windowMs = RENDER_WINDOW_MS): ReturnType<typeof summarizeCommits> =>
  summarizeCommits(ring, now, { rootId: ROOT, windowMs })

// ---- 1. the zero that is allowed, and the ones that are not -------------------------------------

test('an idle app reads zero app-wide — a measurement, not an absence', () => {
  const ring = createRing(0)
  const sample = read(ring, 10_000)
  assert.equal(sample.root.commits, 0)
  assert.equal(sample.root.perSecond, 0, 'zero commits over a measured window IS a rate of zero')
  // The honest test of the whole render program: idle means idle, and the panel says so in a row
  // rather than by disappearing.
  assert.equal(sample.root.worstMs, null, 'no commit in the window means there is no worst commit')
  assert.deepEqual(sample.surfaces, [], 'a surface with nothing behind it is omitted, not zeroed')
})

test('a surface stops being a row the moment its commits age out of the window', () => {
  const ring = createRing(0)
  burst(ring, 'overview', 100, 3)
  assert.equal(read(ring, 1_000).surfaces.length, 1, 'while it is in the window it is a row')
  assert.deepEqual(read(ring, 20_000).surfaces, [], 'once it is not, the row is gone entirely')
})

// ---- 2. a rate needs an interval ---------------------------------------------------------------

test('a meter younger than a second reports no rate at all', () => {
  const ring = createRing(1_000)
  burst(ring, ROOT, 1_100, 5)
  const sample = read(ring, 1_500)
  assert.equal(sample.spanMs, 500, 'the span is the meter’s own age while that is shorter than the window')
  assert.equal(sample.root.perSecond, null, 'five commits in 500 ms is not "10/s" — it is not yet measured')
  assert.equal(sample.root.commits, 5, '…but the COUNT is exact from the first commit')
})

test('the rate divides by the window once the meter is older than it', () => {
  const ring = createRing(0)
  burst(ring, ROOT, 2_000, 10)
  const sample = read(ring, 6_000)
  assert.equal(sample.spanMs, RENDER_WINDOW_MS)
  assert.equal(sample.root.perSecond, 2, '10 commits over a 5 s window is 2.0/s')
})

test('the span never exceeds the meter’s own life — a young meter is not divided by the window', () => {
  const ring = createRing(0)
  burst(ring, ROOT, 100, 6)
  const sample = read(ring, 2_000)
  assert.equal(sample.spanMs, 2_000)
  assert.equal(sample.root.perSecond, 3, '6 commits in the 2 s this meter has existed is 3.0/s')
})

// ---- 3. the window boundary --------------------------------------------------------------------

test('commits older than the window are not counted, and the worst case leaves with them', () => {
  const ring = createRing(0)
  recordCommit(ring, ROOT, 500, 40)
  recordCommit(ring, ROOT, 4_000, 3)
  recordCommit(ring, ROOT, 4_001, 3)
  const inside = read(ring, 5_000)
  assert.equal(inside.root.commits, 3)
  assert.equal(inside.root.worstMs, 40, 'the 40 ms commit is still inside a 5 s window at t=5000')

  const after = read(ring, 6_000)
  assert.equal(after.root.commits, 2, 'the 500 ms commit has aged out')
  assert.equal(after.root.worstMs, 3, '…and so has the worst case it carried — this is a WINDOW, not a session')
})

// ---- 4. the per-surface breakdown --------------------------------------------------------------

test('the root row is the app-wide one and never appears twice', () => {
  const ring = createRing(0)
  burst(ring, ROOT, 1_000, 4)
  burst(ring, 'overview', 1_000, 2)
  const sample = read(ring, 5_000)
  assert.equal(sample.root.commits, 4)
  assert.deepEqual(
    sample.surfaces.map((s) => s.id),
    ['overview'],
    'the root id is the app-wide row above, not one of the surfaces below it'
  )
})

test('surfaces sort busiest first, with a stable tie-break so 1 Hz reads do not flicker', () => {
  const ring = createRing(0)
  burst(ring, 'combat', 1_000, 2)
  burst(ring, 'overview', 1_100, 9)
  burst(ring, 'alerts', 1_200, 2)
  const ids = read(ring, 5_000).surfaces.map((s) => s.id)
  assert.deepEqual(ids, ['overview', 'alerts', 'combat'], 'busiest first; equal counts fall back to the id')
})

test('each surface carries its own worst commit, not the app’s', () => {
  const ring = createRing(0)
  recordCommit(ring, ROOT, 1_000, 90)
  recordCommit(ring, 'overview', 1_000, 12)
  const sample = read(ring, 5_000)
  assert.equal(sample.root.worstMs, 90)
  assert.equal(sample.surfaces[0]?.worstMs, 12)
})

// ---- 5. the ring's own limit, reported rather than hidden ---------------------------------------

test('a ring overrun says so, and its counts read as a floor', () => {
  const ring = createRing(0, 4)
  burst(ring, ROOT, 1_000, 6)
  const sample = read(ring, 2_000)
  assert.equal(sample.saturated, true, 'two commits were overwritten while still inside the window')
  assert.equal(sample.root.commits, 4, 'the count is what survived — the panel prints it as "or more"')
  assert.equal(ring.offered, 6, '…and the ring still knows how many it was actually offered')
})

test('a full ring whose records have all aged out is NOT saturated', () => {
  const ring = createRing(0, 4)
  burst(ring, ROOT, 0, 6)
  const sample = read(ring, 60_000)
  assert.equal(sample.saturated, false, 'nothing in the window was lost, because nothing is in the window')
  assert.equal(sample.root.commits, 0)
})

test('the shipped capacity absorbs a hundred commits a second without a caveat', () => {
  const ring = createRing(0)
  burst(ring, ROOT, 1_000, 500)
  const sample = read(ring, 6_000)
  assert.equal(sample.saturated, false, `${String(RENDER_RING_CAPACITY)} slots hold a 5 s window at 100/s`)
  assert.equal(sample.root.commits, 500)
})

// ---- 6. the gate, audited as a fact about the source --------------------------------------------

const RENDERER = join(process.cwd(), 'src', 'renderer', 'src')

/** Every source file under `src/renderer/src`, as `<relative path>` → contents. */
function rendererSources(dir: string, prefix = ''): Map<string, string> {
  const found = new Map<string, string>()
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const rel = prefix === '' ? entry.name : `${prefix}/${entry.name}`
    if (entry.isDirectory()) {
      for (const [k, v] of rendererSources(join(dir, entry.name), rel)) found.set(k, v)
    } else if (/\.tsx?$/.test(entry.name)) {
      found.set(rel, readFileSync(join(dir, entry.name), 'utf8'))
    }
  }
  return found
}

/** A JSX mount of either Profiler — the thing that has a production cost if it is ever ungated. */
const MOUNT = /<\s*(Render)?Profiler[\s>]/

test('React’s Profiler is mounted in exactly two places, and both check the dev gate', () => {
  const sources = rendererSources(RENDERER)
  const mounts = [...sources.entries()].filter(([, text]) => MOUNT.test(text)).map(([path]) => path)
  assert.deepEqual(
    mounts.sort((a, b) => a.localeCompare(b)),
    ['components/MainColumn.tsx', 'lib/renderMeter.tsx', 'main.tsx'],
    'JOS-513 mounts ONE Profiler at the ViewContent seam and ONE at the app root — "do not wrap ' +
      'every component". A third is a decision somebody should have to make on purpose, which is ' +
      'what this failure is asking for.'
  )
  for (const path of mounts) {
    if (path === 'lib/renderMeter.tsx') continue
    assert.match(
      sources.get(path) ?? '',
      /import\.meta\.env\.DEV \?/,
      `${path} mounts a Profiler without the dev gate — that is a production cost`
    )
  }
})

test('the popover’s section is gated too — that gate is what makes the meter DELETABLE', () => {
  const chip = readFileSync(join(RENDERER, 'components', 'PerfChip.tsx'), 'utf8')
  assert.match(
    chip,
    /import\.meta\.env\.DEV && <PerfRenderSection/,
    'an ungated <PerfRenderSection> keeps the section, the meter and the ring reachable, so rollup ' +
      'ships all three into every installer — inert, but shipped'
  )
})

test('the gate is spelled inline everywhere, because a shared constant did NOT strip', () => {
  const meter = readFileSync(join(RENDERER, 'lib', 'renderMeter.tsx'), 'utf8')
  assert.match(meter, /import\.meta\.env\.DEV/, 'the meter is anchored on vite’s own builtin')
  // devFlags.ts's argument, applied: a `define` only exists from the moment a dev server booted,
  // so a stale `npm run dev` would silently lose the instrument.
  assert.doesNotMatch(meter, /__EQ_[A-Z_]+__/, 'the meter must not depend on a vite `define`')
  // THE REGRESSION THIS PINS IS ONE THIS TICKET SHIPPED AND THEN MEASURED. The first version
  // exported `RENDER_METER` and every site read it; rollup does not inline that across modules, so
  // `out-e2e/renderer/assets/index-*.js` still carried `perf-render`, `saturated` and the entire
  // ring. Only the per-module builtin folds before rollup sees the branch. Re-introducing the
  // shared constant would silently re-ship the meter.
  assert.doesNotMatch(
    meter,
    /export const RENDER_METER/,
    'a shared gate constant is NOT constant-folded across modules — spell import.meta.env.DEV at ' +
      'each site instead, and see this file’s header for the grep that measured it'
  )
})

test('the panel section draws nothing without a sample — absence, not an empty heading', () => {
  const section = readFileSync(join(RENDERER, 'components', 'PerfRenderSection.tsx'), 'utf8')
  assert.match(section, /if \(sample === null\) return null/)
})
