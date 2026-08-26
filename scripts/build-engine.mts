/**
 * build-engine.mts — the RELEASE `engined.exe` the installer ships (JOS-473, phase 3), and the
 * ONE place in this repo that knows where `cargo` lives.
 *
 * `npm run build:engine`. It runs before electron-builder in both `dist` scripts, and as its own
 * step in the CI jobs that package (.github/workflows/build.yml), because electron-builder's
 * `extraResources` treats a missing source as a WARNING and carries on — verified in
 * app-builder-lib 26 (`fileMatcher.copyFiles`: `log.warn(…, "file source doesn't exist")` and
 * `return`). An installer that quietly shipped without its engine is exactly the v0.3.1 shape
 * (a release that "succeeded" with assets absent), so the assertion at the bottom of
 * `buildEngineRelease` is the load-bearing line in this file, not the spawn above it.
 *
 * ONE CARGO RESOLUTION FOR THE WHOLE REPO. `tests/e2e/build.mts` used to carry its own copy of
 * `cargoBinary()`; it now imports this one. A second copy is not a duplication in the tidiness
 * sense — it is a machine where the e2e gate finds a toolchain and the shipping build does not.
 *
 * NOTHING HERE SPAWNS POWERSHELL, at build time or any other time (engine/Cargo.toml states the
 * rule for everything under engine/, and plan ruling 16 is why it exists: PowerShell binaries are
 * the antivirus trigger this app already spent a release eliminating). cargo is invoked directly,
 * as a real argv, never through a shell.
 *
 * DEBUG IS NOT AN OPTION HERE, and that asymmetry with the e2e gate is deliberate. The e2e suite
 * builds DEBUG because that is what the resolver probes first and what a developer just produced;
 * an installer ships RELEASE because it runs on somebody else's machine beside a game.
 */

import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { ENGINE_BIN_NAME } from '../src/main/dataServer/engineProtocol'

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
export const ENGINE_DIR = join(ROOT, 'engine')

/** Where cargo writes the release binary — and, via `electron-builder.yml`'s `extraResources`,
 *  the file that becomes `resources/engine/engined.exe` in a packaged app. The NAME comes from the
 *  resolver's own constant so the packaging and the probe cannot drift apart. */
export const ENGINE_RELEASE_BIN = join(ENGINE_DIR, 'target', 'release', ENGINE_BIN_NAME)

/**
 * `cargo`, which is NOT on PATH in a fresh shell on this machine (AGENTS.md's toolchain note).
 * Rustup's default install location FIRST, deterministically — it is the toolchain
 * `engine/rust-toolchain.toml` pins — and bare `cargo` only as the fallback for a machine that
 * installed Rust some other way.
 */
export function cargoBinary(): string {
  const home = process.env.USERPROFILE ?? process.env.HOME ?? ''
  const fallback = home === '' ? null : join(home, '.cargo', 'bin', 'cargo.exe')
  if (fallback !== null && existsSync(fallback)) return fallback
  return 'cargo'
}

/**
 * Build the release engine and hand back its path.
 *
 * NO STALENESS GATE, unlike the e2e one. That gate exists to save ~200 ms of cargo startup on a
 * suite that runs dozens of times an hour; this runs once per installer, where cargo's own
 * fingerprints already make the no-op case fast and where "I was sure it was fresh" is a way to
 * ship yesterday's engine.
 *
 * Throws when cargo fails AND when cargo claims success with no binary on disk — see the header
 * for why the second one is the whole point.
 */
export function buildEngineRelease(): string {
  const res = spawnSync(cargoBinary(), ['build', '--release', '-p', 'engined'], {
    cwd: ENGINE_DIR,
    stdio: 'inherit'
  })
  if (res.error) throw new Error(`build:engine: could not run cargo — ${res.error.message}`)
  if (res.status !== 0) {
    throw new Error(`build:engine: cargo build --release -p engined failed (exit ${String(res.status)})`)
  }
  if (!existsSync(ENGINE_RELEASE_BIN)) {
    throw new Error(`build:engine: cargo reported success but ${ENGINE_RELEASE_BIN} is missing`)
  }
  return ENGINE_RELEASE_BIN
}

if ((process.argv[1] ?? '').endsWith('build-engine.mts')) {
  console.log(`build:engine: ${buildEngineRelease()}`)
}
