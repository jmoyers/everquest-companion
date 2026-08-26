/**
 * budget-g3.mts — THE G3 CHECK, run by the integrator at the release cut (JOS-501).
 *
 * `npm run budget:g3`. It folds the owner's pinned 209 MB fixture through the REAL engine, at full
 * speed, and prints what it cost. The number goes in the release notes.
 *
 * ── WHY THIS IS A SCRIPT AND NOT JUST A CARGO INVOCATION ──────────────────────────────────────
 *
 * Three things a `"cargo test …"` string in package.json cannot do: find the fixture (it is
 * gitignored and lives in the MAIN checkout, so a worktree has to reach for it), set an environment
 * variable portably (there is no `cross-env` in this tree and adding one for a single script would
 * be a dependency for a shell feature), and say something useful when the fixture is simply not
 * there — which is the state of every machine but the owner's.
 *
 * ── WHAT IT DOES NOT DO: FAIL ─────────────────────────────────────────────────────────────────
 *
 * G3's goal is a fold of the fixture in under 20 s, and this script will not assert it. A
 * wall-clock ceiling is a claim about a MACHINE, and neither this script nor the test behind it
 * knows the machine a release is being cut on. The budget that CI enforces is the synthetic one
 * (`npm run budget:ci`), whose corpus is identical everywhere; this is an instrument the integrator
 * reads. See `engine/crates/engined/tests/budget.rs` for the whole two-tier argument.
 *
 * MEASURED at the time of writing, on the owner's desktop (i9-13900KF, release build,
 * below-normal priority): 199.6 MB in 52,482 ms = 3.8 MB/s over 2,544,710 events. The 20 s goal is
 * NOT met today, and printing that is the entire point of having the instrument.
 */
import { spawnSync } from 'node:child_process'
import { existsSync, readdirSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { cargoBinary } from './build-engine.mjs'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')

/**
 * Where the pinned fixture lives.
 *
 * A WORKTREE HAS TO REACH FOR IT. The fixture is gitignored, so it exists only in the checkout it
 * was cut into — the owner's main one. A worker running this from `.claude/worktrees/<agent>` finds
 * nothing under its own root, and the honest fallback is the repo two levels up rather than a
 * guess. Both are probed and the first that exists wins; neither is invented.
 */
const CANDIDATE_DIRS = [
  join(ROOT, 'tests', 'bench', 'fixtures', 'Logs'),
  join(ROOT, '..', '..', '..', 'tests', 'bench', 'fixtures', 'Logs')
]

function findFixture(): string | null {
  for (const dir of CANDIDATE_DIRS) {
    if (!existsSync(dir)) continue
    const logs = readdirSync(dir).filter((f) => f.startsWith('eqlog_') && f.endsWith('.txt'))
    // THE BIGGEST ONE, when there is more than one: G3 is about the full-speed fold of the whole
    // corpus, and a small second log in the same directory would quietly measure the wrong thing.
    let best: { path: string; size: number } | null = null
    for (const name of logs) {
      const path = join(dir, name)
      const size = statSync(path).size
      if (best === null || size > best.size) best = { path, size }
    }
    if (best !== null) return best.path
  }
  return null
}

const fixture = findFixture()
if (fixture === null) {
  console.log('budget:g3 — no pinned fixture found. Looked in:')
  for (const dir of CANDIDATE_DIRS) console.log(`  ${dir}`)
  console.log(
    '\nThis check folds the owner\'s real log and is MACHINE-LOCAL by design: the fixture is\n' +
      'gitignored and never enters git. Nothing is wrong — there is simply nothing to measure here.\n' +
      'The budget CI actually enforces is `npm run budget:ci`, whose corpus is generated.'
  )
  process.exit(0)
}

const bytes = statSync(fixture).size
console.log(`budget:g3 — folding ${(bytes / 1_048_576).toFixed(1)} MB through the real engine…`)
console.log(`budget:g3 — ${fixture}`)
console.log('budget:g3 — this takes about a minute; the engine runs at below-normal priority.\n')

const res = spawnSync(
  cargoBinary(),
  [
    'test',
    '--release',
    '-p',
    'engined',
    '--test',
    'budget',
    'the_owners_full_log',
    '--',
    '--nocapture',
    '--test-threads=1'
  ],
  {
    cwd: join(ROOT, 'engine'),
    stdio: 'inherit',
    env: { ...process.env, EQC_BUDGET_LOG: fixture }
  }
)

if (res.error) {
  console.error(`budget:g3 — could not run cargo: ${res.error.message}`)
  process.exit(1)
}
// A NON-ZERO EXIT HERE IS A BROKEN MEASUREMENT, NEVER A BREACHED GOAL — the test does not assert
// the 20 s goal. So this propagates a build or a wedge, and nothing else.
process.exit(res.status ?? 1)
