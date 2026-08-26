/**
 * build.mts — where the e2e suite gets its BINARIES: the checkout root, Node's own resolver
 * rooted at it, the out-e2e/ build gate and its cross-process lock, the Electron executable, and
 * (JOS-470) the engine binary cargo produces.
 *
 * Split out of appHarness.mts, which the lock pushed past the 400-code-line factoring ceiling.
 * The split is also honest about the dependency shape: nothing here knows what a `Page` is, so
 * the runner (run-all.mts) can ask for a build without dragging playwright in behind it.
 */

import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmdirSync,
  statSync,
  writeFileSync
} from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
// ONE NAME FOR THE BINARY, shared with the resolver that has to find it. The old hardcoded
// `'engined.exe'` here was a latent divergence from `engineProtocol.ts`'s platform-aware constant:
// on any non-Windows host the probe could never see the file, always built, and then threw
// "cargo reported success but … is missing".
import { ENGINE_BIN_NAME } from '../../src/main/dataServer/engineProtocol'
// WHERE CARGO IS, ASKED ONCE FOR THE WHOLE REPO. `scripts/build-engine.mts` owns that resolution
// because the SHIPPING build needs it too (JOS-473) — and a second copy here would not be untidy
// so much as a machine where one of the two finds a toolchain and the other does not. The
// dependency points this way on purpose: the harness leans on the build script, never the reverse.
import { cargoBinary } from '../../scripts/build-engine.mts'

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')

/**
 * Node's own resolver, rooted at THIS checkout — never `join(ROOT, 'node_modules', …)`.
 *
 * A `git worktree` has no `node_modules` of its own but does have the repo root as a filesystem
 * ancestor, so the resolver's upward walk finds the real install while a hardcoded join finds
 * nothing. That difference is the whole reason the harness could not run in a worktree.
 */
const requireFromRoot = createRequire(join(ROOT, 'package.json'))

/**
 * Its OWN build output, never `out/`: the user keeps `npm run dev --watch` running, which
 * owns out/main + out/preload and rewrites them on every source edit. Building into out-e2e/
 * means the harness can never race that watcher (or leave a production bundle where the dev
 * app expects its own). The main bundle resolves preload/renderer relative to __dirname, so
 * an alternate root just works.
 */
const OUT_DIR = join(ROOT, 'out-e2e')
export const MAIN_ENTRY = join(OUT_DIR, 'main', 'index.js')

// ── build (reuse out-e2e/ when it's newer than every source file) ──────────────────────

function newestMtime(dir: string): number {
  let newest = 0
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name)
    newest = Math.max(newest, entry.isDirectory() ? newestMtime(p) : statSync(p).mtimeMs)
  }
  return newest
}

/**
 * Is `out-e2e/` newer than everything that goes into it?
 *
 * THE ENGINE'S RUST IS DELIBERATELY NOT IN THIS QUESTION, and the omission is a decision rather
 * than a gap — see `buildEngineIfStale` below for the whole argument. In one line: nothing under
 * `engine/` is in electron-vite's graph, so a `.rs` edit cannot change a single byte of `out-e2e/`,
 * and folding it in here would make every Rust edit pay for a ~12 s bundle rebuild that could only
 * ever produce the same output — while STILL not answering the question that actually matters,
 * which is whether `engined.exe` is stale.
 */
function isFresh(): boolean {
  let outMs = 0
  try {
    outMs = statSync(MAIN_ENTRY).mtimeMs
  } catch {
    outMs = 0
  }
  const srcMs = Math.max(
    newestMtime(join(ROOT, 'src')),
    statSync(join(ROOT, 'electron.vite.config.ts')).mtimeMs
  )
  return outMs > srcMs
}

// ── the ENGINE build (JOS-470; RELEASE and content-addressed since JOS-501) ────────────
//
// TWO OUTPUTS, TWO GATES. `out-e2e/` is electron-vite's; `engine/target/release/engined.exe` is
// cargo's. They share no input file and neither can invalidate the other, so one boolean cannot
// honestly answer for both: a `.rs` edit leaves the bundle perfectly fresh, and a `.ts` edit leaves
// the binary perfectly fresh. Asking the two questions separately is what lets each answer be true.
//
// AND SINCE JOS-490 EVERY SPEC NEEDS THE BINARY, so `buildIfStale()` asks both gates (see its own
// comment). It used to be asked by the ONE spec that opted in, on the argument that thirty-nine
// specs must not serialize behind a cargo build they will never look at — an argument that ended the
// moment the harness began launching every app with `EQC_ENGINE=1`. A spec that ran engine-on
// against a missing or stale binary would take the ABSENCE path and go green, which is precisely the
// silent pass this suite's engine work exists to make impossible.
//
// NO LOCK OF ITS OWN, unlike the bundle above, and for a reason rather than an oversight: cargo
// takes a file lock on its own target directory, so two concurrent invocations already queue behind
// each other instead of writing over one another's output. Re-implementing that here would be a
// second, worse copy of a guarantee the tool already gives.

// ── WHY RELEASE, AND WHY THE HARNESS NAMES THE BINARY (JOS-501) ────────────────────────
//
// This built DEBUG until JOS-501, on the argument that debug is what the resolver in
// `src/main/dataServer/engineProtocol.ts` probes first. That argument was about which binary the app
// would FIND; it said nothing about whether the suite could afford the one it found. It could not.
// A debug engine's spell-db parse alone measures 4.3 s, and `bosses-week` — which folds the owner's
// whole log twice — did not reach its go-live sentence in 900 s under one. Both `run-all.mts`
// docblocks asked for this change by name and told the integrator to delete their workarounds the
// day it landed.
//
// AND THE SWITCH IS ONLY HALF THE FIX, because the resolver prefers DEBUG over release (deliberately
// — a debug build is what a developer just produced and a stale release must not silently win). On
// any machine that has ever run a plain `cargo build`, a harness that built release would still have
// launched the app against the debug binary sitting beside it: the suite would pay for the release
// build and then prove things about the other one. So the harness HANDS THE PATH OVER
// (`EQ_ENGINE_BIN`, honoured only under `EQ_E2E=1`), exactly as it already hands over the staged EQ
// install with `EQ_INSTALL_DIR`. The harness owns the binary it built; the product is told which one
// to run rather than left to guess.

/** The engine binary this checkout's Rust produces, and the one every spec runs against. */
export const ENGINE_BIN = join(ROOT, 'engine', 'target', 'release', ENGINE_BIN_NAME)

/** Cargo's own answer to "what did this binary come from" — written beside it on every build. */
const ENGINE_DEP_INFO = join(ROOT, 'engine', 'target', 'release', 'engined.d')

/** Where the digest of the inputs the CURRENT binary was built from is recorded. */
const ENGINE_STAMP = join(ROOT, 'engine', 'target', 'release', '.e2e-engine-stamp')

/**
 * Parse a cargo/GNU-make dep-info file into its input paths.
 *
 * Spaces inside a path are escaped `\ ` by the writer, so the split is on spaces NOT preceded by a
 * backslash — which matters on Windows only for a checkout under a directory like `Program Files`,
 * and is exactly the sort of machine-shaped difference a harness should not have opinions about.
 */
function depInfoInputs(text: string): string[] {
  const line = text.split(/\r?\n/).find((l) => l.includes(': '))
  if (line === undefined) return []
  return line
    .slice(line.indexOf(': ') + 2)
    .split(/(?<!\\) /)
    .map((p) => p.replace(/\\ /g, ' ').trim())
    .filter((p) => p !== '')
}

/**
 * THE INPUTS CARGO WOULD REBUILD FROM, AS CONTENT — the real staleness check (JOS-501).
 *
 * The old gate compared the binary's mtime against the newest mtime under `engine/crates` plus the
 * three workspace manifests, and it DISAGREED WITH CARGO in three ways. Two of them were merely
 * wasteful; the third let specs prove things about the wrong binary, which is why this is a
 * correctness fix rather than a tidy-up:
 *
 *  1. **Cargo does not touch the binary's mtime on a no-op build.** So anything that bumps a `.rs`
 *     mtime without changing its content — a `git checkout`, a branch switch, a worktree add —
 *     left the gate permanently answering "stale", cargo doing nothing, and the mtime staying put.
 *     Every one of ~130 specs then paid a cargo invocation, forever.
 *  2. **`include_str!` inputs were invisible to it.** The engine embeds `spells.json`, `items.json`,
 *     `mobs.json`, `bosses.json`, `posky.json`, `quests.json`, `respawns.json`, `classes.json` and
 *     `messageOverlay.baseline.json` — NONE of which live under `engine/crates`. Editing any one of
 *     them changes the binary and left the gate saying "fresh". THIS is the mode that hands a spec
 *     an engine built from data the repo no longer contains.
 *  3. **mtime is not cargo's fingerprint.** Toolchain, profile and feature set are all inputs and
 *     none of them appeared in a timestamp comparison.
 *
 * All three dissolve by asking the two authorities instead of guessing. CARGO ITSELF names the input
 * set, in the dep-info file it writes beside the binary — 153 paths today, `include_str!`'d JSON
 * included — so the list cannot drift when someone adds an embed: the `.rs` file that adds it is
 * itself an input, so its content change forces the rebuild that rewrites the list. And the inputs
 * are compared BY CONTENT, so a touched-but-unchanged file is correctly no change at all.
 *
 * `rustc -V` is deliberately NOT spawned: `rust-toolchain.toml` pins an exact channel (`1.98.0`, and
 * the pin is load-bearing for the generated-protocol staleness test), so hashing that file's bytes
 * already answers "which compiler" without paying a process launch in every one of ~130 specs.
 *
 * Returns `null` when there is no dep-info to read — a checkout that has never built the engine,
 * where the only honest answer is to build.
 */
function engineInputDigest(): string | null {
  let inputs: string[]
  try {
    inputs = depInfoInputs(readFileSync(ENGINE_DEP_INFO, 'utf8'))
  } catch {
    return null
  }
  if (inputs.length === 0) return null
  // The manifests and the toolchain pin are cargo's fingerprint rather than rustc's, so they are
  // never in dep-info and are added here by name.
  for (const name of ['Cargo.toml', 'Cargo.lock', 'rust-toolchain.toml']) {
    inputs.push(join(ROOT, 'engine', name))
  }
  for (const crate of readdirSync(join(ROOT, 'engine', 'crates'), { withFileTypes: true })) {
    if (crate.isDirectory()) inputs.push(join(ROOT, 'engine', 'crates', crate.name, 'Cargo.toml'))
  }
  const h = createHash('sha256')
  for (const path of [...new Set(inputs)].sort()) {
    h.update(path.replace(/\\/g, '/'))
    h.update(' ')
    try {
      h.update(readFileSync(path))
    } catch {
      // A named input that is gone IS a change, and hashing its absence records that.
      h.update(' absent')
    }
    h.update(' ')
  }
  return h.digest('hex')
}

/**
 * Build `engined.exe` if the inputs cargo would rebuild from have changed since it was written.
 *
 * INCREMENTALITY IS STILL CARGO'S STORY, NOT OURS. This gate answers one question — "were the
 * current inputs the ones this binary came from?" — and hands the real decision to cargo, which then
 * does nothing at all when its own fingerprints agree. What the digest buys is skipping cargo's
 * startup on the overwhelmingly common no-op run, and (unlike the mtime gate it replaces) actually
 * being right about it.
 *
 * Returns the binary's path. Throws when the build fails or when the build claimed success and the
 * binary still is not there — a spec that silently ran against no engine would assert the ABSENCE
 * path and pass, which is the one failure this whole file exists to prevent.
 */
export function buildEngineIfStale(): string {
  const want = engineInputDigest()
  if (want !== null && existsSync(ENGINE_BIN) && readStamp() === want) {
    console.log(`build: ${ENGINE_BIN} is fresh — reusing it`)
    return ENGINE_BIN
  }
  console.log('build: cargo build --release -p engined (the engine binary is stale)…')
  const res = spawnSync(cargoBinary(), ['build', '--release', '-p', 'engined'], {
    cwd: join(ROOT, 'engine'),
    stdio: 'inherit'
  })
  if (res.error) throw new Error(`e2e: could not run cargo — ${res.error.message}`)
  if (res.status !== 0) {
    throw new Error(`cargo build --release -p engined failed (exit ${String(res.status)})`)
  }
  if (!existsSync(ENGINE_BIN)) {
    throw new Error(`e2e: cargo reported success but ${ENGINE_BIN} is missing`)
  }
  // Re-read the digest AFTER the build: the dep-info this binary was actually produced from is the
  // one to record, and it is the file cargo has just rewritten.
  const built = engineInputDigest()
  if (built !== null) writeFileSync(ENGINE_STAMP, built)
  return ENGINE_BIN
}

/** The digest recorded when the binary beside it was built, or null when there is none. */
function readStamp(): string | null {
  try {
    return readFileSync(ENGINE_STAMP, 'utf8').trim()
  } catch {
    return null
  }
}

/** electron-vite's CLI entry, via its package manifest — `bin` is the field that names it, and
 *  the subpath itself is not in the package's `exports` map, so it cannot be resolved directly. */
function electronViteCli(): string {
  const manifestPath = requireFromRoot.resolve('electron-vite/package.json')
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as {
    bin?: Record<string, string> | string
  }
  const rel = typeof manifest.bin === 'string' ? manifest.bin : manifest.bin?.['electron-vite']
  if (!rel) throw new Error('e2e: electron-vite declares no bin entry')
  return join(dirname(manifestPath), rel)
}

const BUILD_LOCK = join(OUT_DIR, '.build-lock')
/** A build that has been holding the lock this long is a crashed one, not a slow one. */
const BUILD_LOCK_STALE_MS = 600_000

/** Reclaim a lock whose holder died. Separate from the wait loop below because the two throwing
 *  calls need their own try — and inlining it nests four blocks deep. */
function reclaimIfStale(): void {
  try {
    if (Date.now() - statSync(BUILD_LOCK).mtimeMs > BUILD_LOCK_STALE_MS) rmdirSync(BUILD_LOCK)
  } catch {
    // The holder finished between the two calls — the caller re-checks freshness anyway.
  }
}

/**
 * Take the build lock, or wait for whoever holds it. `mkdir` is the atomic primitive here (it
 * either creates or throws EEXIST — no read-then-write window), and the lock exists because
 * out-e2e/ is per CHECKOUT while runs are not: two invocations from one worktree would otherwise
 * both find the output stale and both rewrite main/index.js under each other's launching app.
 *
 * Returns false when the wait ended because someone ELSE produced a fresh build — there is then
 * nothing left to do and no lock to release.
 */
function acquireBuildLock(): boolean {
  for (let i = 0; i < 600; i++) {
    try {
      mkdirSync(BUILD_LOCK, { recursive: false })
      return true
    } catch {
      reclaimIfStale()
      if (isFresh()) return false
      // Synchronous by necessity — buildIfStale() is called before any await in every spec.
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 500)
    }
  }
  throw new Error(`e2e: the build lock at ${BUILD_LOCK} never cleared`)
}

/**
 * THE SUITE'S BINARIES, BOTH OF THEM (JOS-490).
 *
 * The engine gate goes FIRST and unconditionally — ahead of the bundle's own `isFresh()` early
 * return, which is the whole trick: a checkout whose `out-e2e/` is fresh and whose `engined.exe` is
 * stale is the ordinary state after a `.rs` edit, and an early return that skipped the engine would
 * hand every spec a binary older than the Rust it is supposed to be proving.
 *
 * THE RUNNER PAYS FOR IT ONCE. `run-all.mts` calls this before it spawns a single spec, so the one
 * cargo build that a stale checkout needs happens with nothing else running; the per-spec call that
 * every spec still makes then finds both outputs fresh and costs a handful of `stat`s. That ordering
 * is also what keeps four parallel specs from meeting at the cargo lock.
 */
export function buildIfStale(): void {
  buildEngineIfStale()
  if (isFresh()) {
    console.log(`build: ${OUT_DIR}/ is fresh — reusing it`)
    return
  }
  mkdirSync(OUT_DIR, { recursive: true })
  if (!acquireBuildLock()) {
    console.log(`build: ${OUT_DIR}/ was built by a concurrent run — reusing it`)
    return
  }
  try {
    if (isFresh()) {
      console.log(`build: ${OUT_DIR}/ is fresh — reusing it`)
      return
    }
    console.log(`build: electron-vite build --outDir=${OUT_DIR} (it is stale)…`)
    // ABSOLUTE outDir on purpose: electron-vite resolves a relative --outDir against each
    // section's own `root`, and the renderer's root is src/renderer — a relative 'out-e2e'
    // silently emits the HTML into src/renderer/out-e2e/ and the app then loads a 404.
    const res = spawnSync(
      process.execPath,
      [electronViteCli(), 'build', `--outDir=${OUT_DIR.replace(/\\/g, '/')}`],
      { cwd: ROOT, stdio: 'inherit' }
    )
    if (res.status !== 0) throw new Error(`electron-vite build failed (exit ${String(res.status)})`)
  } finally {
    try {
      rmdirSync(BUILD_LOCK)
    } catch {
      // Someone stole a lock we still held (only possible after BUILD_LOCK_STALE_MS).
    }
  }
}

/**
 * The Electron executable. `require('electron')` IS the answer — the package's index.js reads
 * its own `path.txt` and honours ELECTRON_OVERRIDE_DIST_PATH — so this asks it rather than
 * rebuilding its logic around a hardcoded dist/ path that no worktree has.
 */
export function electronBinary(): string {
  const exe: unknown = requireFromRoot('electron')
  if (typeof exe !== 'string') throw new Error('e2e: the electron package did not resolve to a path')
  return exe
}
