/**
 * testGate.mts — the MACHINE-WIDE test-concurrency gate (owner directive 2026-08-21).
 *
 * The problem it exists for, measured the night it was built: five agent worktrees ran
 * `npm test` / `npm run test:e2e` at once on the 24-core box. Each unit run spawns one process
 * per test file up to `os.availableParallelism()` (32 here), and each e2e run boots up to four
 * full Electron apps — 58 node/electron processes, CPU pinned at 100%, and the desktop (the
 * owner's game included) locked up. The per-run limits below were fine alone; nothing bounded
 * the SUM.
 *
 * The gate is a slot-file semaphore in the USER'S HOME DIR — deliberately outside the checkout,
 * because the contenders are git worktrees that share nothing but the machine:
 *
 *   ~/.eqc-test-gate/<pool>/slot-<i>.json    { pid, started, label }
 *
 * Acquire = create a slot file with O_EXCL; the pools are small so a linear probe is the whole
 * algorithm. A slot whose owner is DEAD (kill(pid, 0) fails) or IMPLAUSIBLY OLD (a crashed run
 * whose pid was reused) is stolen. While every slot is honestly busy, we wait and say so, so an
 * agent's stalled log explains itself.
 *
 * Sizing, from the box (i9-13900KF, 24C/32T, 64 GB) rather than from vibes:
 *   unit: 2 slots, and package.json caps each run at --test-concurrency=10 → ≤ ~20 busy threads
 *         from unit testing no matter how many agents ask. Two full suites run at speed; a third
 *         waits the ~45 s a suite costs, which is cheaper than three suites thrashing.
 *   e2e:  2 slots × the runner's own ≤4 apps → ≤ 8 Electron apps machine-wide (the e2e bound is
 *         memory/GPU, not CPU — run-all.mts says so and caps itself accordingly).
 *   Worst case ≈ 28 of 32 threads with the desktop still owning the rest.
 *
 * Override per machine with EQC_UNIT_SLOTS / EQC_E2E_SLOTS. On CI the gate is a no-op in
 * practice: one tenant, zero contention, the O_EXCL succeeds first try.
 *
 * Usage (package.json is the only intended caller — agents inherit the gate by running the
 * npm scripts, which is the point: policy in the harness, not in briefs):
 *
 *   node --import tsx scripts/testGate.mts <pool> -- <command...>
 */
import { spawn } from 'node:child_process'
import { mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import { availableParallelism, homedir } from 'node:os'
import { join } from 'node:path'

const POOLS: Record<string, { slots: number; staleMs: number }> = {
  // staleMs backs up the pid-liveness check (pid reuse can fake a live owner): a unit suite is
  // ~1 min, a FULL e2e sweep ~25 min — both stale bounds are several times their run's length.
  unit: { slots: Number(process.env.EQC_UNIT_SLOTS ?? 2), staleMs: 30 * 60_000 },
  e2e: { slots: Number(process.env.EQC_E2E_SLOTS ?? 2), staleMs: 90 * 60_000 }
}

const [poolName, dashDash, ...cmd] = process.argv.slice(2)
const pool = POOLS[poolName ?? '']
if (!pool || dashDash !== '--' || cmd.length === 0) {
  console.error('usage: testGate.mts <unit|e2e> -- <command...>')
  process.exit(2)
}

// `--test-concurrency=auto` is this gate's token, resolved to min(10, the machine's own
// parallelism). A FIXED 10 was the first cut and it broke CI the same day (run 32446378546):
// on a small runner ten contending test processes blow the F13 timing budget, where node's
// default — one per core — was already right. The 10 is the LOCAL cap (the 24-core box is where
// unbounded concurrency starved the desktop); a machine with fewer cores keeps its native count.
const CONCURRENCY_TOKEN = '--test-concurrency=auto'
const resolved = cmd.map((a) =>
  a === CONCURRENCY_TOKEN ? `--test-concurrency=${String(Math.min(10, availableParallelism()))}` : a
)

const dir = join(homedir(), '.eqc-test-gate', poolName)
mkdirSync(dir, { recursive: true })

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

/** Steal a held slot when its owner is dead or implausibly old. True ⇒ the slot is free again. */
function stealIfStale(slot: string): boolean {
  let abandoned = false
  try {
    const held = JSON.parse(readFileSync(slot, 'utf8')) as { pid: number; started: number }
    abandoned = !alive(held.pid) || Date.now() - held.started >= pool.staleMs
  } catch {
    // Unreadable or vanished mid-probe — not provably stale; let the next sweep look again.
  }
  if (!abandoned) return false
  try {
    unlinkSync(slot)
  } catch {
    /* the owner released or another prober stole it first — same outcome */
  }
  return true
}

/** One probe over the pool: the slot path we now own, or null when every slot is honestly busy. */
function tryAcquire(): string | null {
  for (let i = 0; i < pool.slots; i++) {
    const slot = join(dir, `slot-${String(i)}.json`)
    try {
      writeFileSync(slot, JSON.stringify({ pid: process.pid, started: Date.now(), label: cmd.join(' ') }), {
        flag: 'wx'
      })
      return slot
    } catch {
      // Held. Steal it only from the dead or the implausibly old; otherwise probe the next slot.
      if (stealIfStale(slot)) i--
    }
  }
  return null
}

const started = Date.now()
let slot = tryAcquire()
while (slot === null) {
  await new Promise((r) => setTimeout(r, 2000))
  if ((Date.now() - started) % 16000 < 2000)
    console.error(`[test-gate] waiting for a ${poolName} slot (${String(pool.slots)} busy, ${String(Math.round((Date.now() - started) / 1000))}s)`)
  slot = tryAcquire()
}

const release = (): void => {
  try {
    if (slot) unlinkSync(slot)
  } catch {
    /* released twice or stolen as stale — either way it is not ours to hold */
  }
  slot = null
}
process.on('exit', release)
process.on('SIGINT', () => {
  release()
  process.exit(130)
})
process.on('SIGTERM', () => {
  release()
  process.exit(143)
})

const child = spawn(resolved[0], resolved.slice(1), { stdio: 'inherit' })
child.on('exit', (code, signal) => {
  release()
  process.exit(code ?? (signal ? 1 : 0))
})
