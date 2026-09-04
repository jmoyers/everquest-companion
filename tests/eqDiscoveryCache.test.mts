// EQ INSTALL-DISCOVERY: PERSIST + GUARD (JOS-112).
//
// Onboarding's auto-detection re-ran on every launch and could HANG on certain directory configs
// (a huge Uninstall hive, an offline mapped network drive whose readdir blocks on the SMB timeout).
// The fix is persist-and-guard, and both halves are pure functions over injected dependencies —
// no store, no disk — so this file pins the exact rules config.ts binds to electron-store + the
// real sweep. The end-to-end path is `tests/e2e/eq-folder.e2e.mts`; the sibling `eqDiscovery.test.mts`
// covers the ordered sweep + the manual-override normalization.
//
//   1. resolveDiscoveredRoot — the CROSS-LAUNCH cache: a valid persisted root skips the sweep, a
//      dead one self-heals, and a null "not found" is NEVER remembered.
//   2. discoverEqRoot's wall-clock CEILING — a bounded miss beats an unbounded hang, and the drive
//      filter keeps offline shares out of the candidate list to begin with.
// Run: `npm test`.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  discoverEqRoot,
  resolveDiscoveredRoot,
  type CachedRootDeps
} from '../src/main/log/discovery'

const lc = (s: string): string => s.replace(/[\\/]+$/, '').toLowerCase()

// --- PERSIST ACROSS LAUNCHES: resolveDiscoveredRoot -------------------------
//
// A positive discovery is remembered so the NEXT launch skips the eight-tree registry read +
// drive walk entirely; a remembered root that no longer holds self-heals; a null is never cached
// (a fresh user who has not run `/log on` keeps getting the cheap idle rescan, not a sticky no).

/** A deps builder with spies: records whether the (expensive) sweep ran and what got persisted. */
function cachedDeps(
  over: Partial<CachedRootDeps> & { sweepResult?: string | null }
): { deps: CachedRootDeps; log: { swept: number; persisted: string[]; dropped: number } } {
  const log = { swept: 0, persisted: [] as string[], dropped: 0 }
  const deps: CachedRootDeps = {
    persisted: over.persisted ?? null,
    hasLogs: over.hasLogs ?? ((): boolean => true),
    sweep:
      over.sweep ??
      ((): string | null => {
        log.swept++
        return over.sweepResult ?? null
      }),
    persist: over.persist ?? ((r): void => void log.persisted.push(r)),
    dropPersisted: over.dropPersisted ?? ((): void => void log.dropped++)
  }
  return { deps, log }
}

test('resolveDiscoveredRoot: a valid persisted root skips the sweep entirely', () => {
  const root = 'D:\\Games\\EverQuest Legends'
  const { deps, log } = cachedDeps({ persisted: root, hasLogs: () => true })
  assert.equal(resolveDiscoveredRoot(deps), root)
  assert.equal(log.swept, 0, 'the expensive sweep must NOT run when the cache is valid')
  assert.equal(log.persisted.length, 0, 'a re-served cache hit is not re-persisted')
  assert.equal(log.dropped, 0)
})

test('resolveDiscoveredRoot: a persisted root that fails revalidation self-heals via the sweep', () => {
  const stale = 'D:\\Games\\EverQuest Legends'
  const fresh = 'E:\\EQ'
  // hasLogs=false ⇒ the readdir revalidation fails (install moved / uninstalled).
  const { deps, log } = cachedDeps({ persisted: stale, hasLogs: () => false, sweepResult: fresh })
  assert.equal(resolveDiscoveredRoot(deps), fresh)
  assert.equal(log.dropped, 1, 'the dead persisted root is dropped')
  assert.equal(log.swept, 1, 'and re-discovered')
  assert.deepEqual(log.persisted, [fresh], 'the fresh positive hit is persisted')
})

test('resolveDiscoveredRoot: no persisted root ⇒ sweep, and a positive hit is persisted', () => {
  const found = 'C:\\Users\\Public\\Daybreak Game Company\\Installed Games\\EverQuest Legends'
  const { deps, log } = cachedDeps({ persisted: null, sweepResult: found })
  assert.equal(resolveDiscoveredRoot(deps), found)
  assert.equal(log.swept, 1)
  assert.deepEqual(log.persisted, [found])
  assert.equal(log.dropped, 0)
})

test('resolveDiscoveredRoot: a NULL (not found) is NEVER persisted', () => {
  // The fresh-user case: nothing found yet ⇒ no sticky negative, so the idle rescan stays cheap.
  const { deps, log } = cachedDeps({ persisted: null, sweepResult: null })
  assert.equal(resolveDiscoveredRoot(deps), null)
  assert.equal(log.swept, 1)
  assert.equal(log.persisted.length, 0, 'a null result must not be cached')
})

// --- GUARD THE SWEEP: the wall-clock ceiling --------------------------------
//
// A slow/offline drive makes a `readdir` block on the SMB timeout for tens of seconds. A
// synchronous probe cannot be aborted mid-flight, so the guarantee is "no FURTHER probes after
// the deadline" — one unavoidable stall, then null (fall back to the manual picker) rather than
// probing the rest of the machine behind it. The injected clock advances deterministically.

test('discoverEqRoot: the ceiling stops probing once the budget is spent, and returns null', () => {
  let clock = 1_000
  const probed: string[] = []
  const root = discoverEqRoot({
    hasLogs: (c): boolean => {
      probed.push(c)
      clock += 40 // each probe "costs" 40 ms of wall clock
      return false
    },
    extraCandidates: () => ['A', 'B', 'C', 'D'],
    fixedDrives: () => [],
    budgetMs: 100,
    now: () => clock
  })
  assert.equal(root, null, 'a bounded miss, not an unbounded hang')
  // deadline = 1000 + 100. Probes at clock 1000, 1040, 1080 run; at 1120 we are over budget.
  assert.deepEqual(probed, ['A', 'B', 'C'], 'the 4th candidate is never probed')
})

test('discoverEqRoot: a candidate found BEFORE the deadline is still returned', () => {
  let clock = 0
  const target = 'D:\\EQ'
  const root = discoverEqRoot({
    hasLogs: (c): boolean => {
      clock += 10
      return c === target
    },
    extraCandidates: () => ['slow', target, 'never'],
    fixedDrives: () => [],
    budgetMs: 100,
    now: () => clock
  })
  assert.equal(root, target, 'the ceiling never denies a hit that lands within budget')
})

test('discoverEqRoot: a single blocking (offline-share) probe caps the whole call', () => {
  // The reported hang, in miniature: the FIRST candidate is an offline mapped drive whose readdir
  // blocks past the entire budget. The real install sits behind it — and must NOT be waited for.
  //
  // THE BLOCKING CANDIDATE NAMES LEGENDS ON PURPOSE (2026-08-17). `legendsFirst` partitions each
  // tier, so a stale `Z:\offline` that did not name the game would now be reordered BEHIND the
  // real install and this test would stop exercising the ceiling it exists for — it would pass on
  // the ordering rather than on the budget. Both candidates sitting in the same partition bucket
  // keeps the blocking one genuinely first, which is what makes the assertions below mean
  // something. It is also the more faithful shape: the share that hung was somebody's EQ install.
  let clock = 0
  const probed: string[] = []
  const offlineShare = 'Z:\\Games\\EverQuest Legends'
  const realInstall = 'C:\\Users\\Public\\Daybreak Game Company\\Installed Games\\EverQuest Legends'
  const root = discoverEqRoot({
    hasLogs: (c): boolean => {
      probed.push(c)
      if (c === offlineShare) {
        clock += 30_000 // the SMB timeout
        return false
      }
      return c === realInstall
    },
    extraCandidates: () => [offlineShare, realInstall],
    fixedDrives: () => [],
    budgetMs: 6_000,
    now: () => clock
  })
  assert.equal(root, null, 'the one blocking probe exhausts the budget; we do not hang on the rest')
  assert.deepEqual(probed, [offlineShare], 'the real install behind it is never reached')
})

test('discoverEqRoot: a filtered (non-fixed) drive is never probed at all', () => {
  // The OTHER half of the guard: `fixedDrives` skips network/removable drives by TYPE, so an
  // offline share is not even a candidate and the blocking probe above never happens. Here the
  // injected fixedDrives has already removed Z:, so only C: paths are ever asked about.
  const probed: string[] = []
  const target = 'C:\\Users\\Public\\Daybreak Game Company\\Installed Games\\EverQuest Legends'
  const root = discoverEqRoot({
    hasLogs: (c): boolean => {
      probed.push(c)
      return lc(c) === lc(target)
    },
    extraCandidates: () => [],
    fixedDrives: () => ['C:'] // Z: was filtered out by drive type before we got here
  })
  assert.equal(root, target)
  assert.ok(!probed.some((p) => /^z:/i.test(p)), 'no Z: candidate is ever probed')
})
