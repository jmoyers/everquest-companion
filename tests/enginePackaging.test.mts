// ============================================================================
// enginePackaging.test.mts — the shipped engine's ADDRESS and its SIGNATURE (JOS-473, phase 3).
// ============================================================================
//
// Two facts live in two files that cannot see each other, and both fail SILENTLY when they drift:
//
//   1. WHERE THE BINARY LANDS. `electron-builder.yml` decides; `engineBinaryCandidates`
//      (src/main/dataServer/engineProtocol.ts) probes. A `to:` renamed on one side produces a
//      packaged app that logs "engine binary not found" and runs on without it — which is the
//      ORDINARY, expected state for every build before this one, so nobody would read it as a
//      regression. This suite composes the config's destination and requires it to BE the
//      resolver's first packaged candidate, rather than restating a string a reader would have to
//      diff by eye.
//
//   2. WHETHER IT IS SIGNED. Ruling 16 (docs/plans/data-server.md): a shipped Rust engine is
//      acceptable and "joins the code-signing set like any shipped executable". Nothing in this
//      repo signs it explicitly — app-builder-lib does, but only under conditions our config has
//      to keep holding. Measured in app-builder-lib 26:
//
//        * `fileMatcher.copyFiles` hands the sign transformer to the DIRECTORY branch only. A
//          matcher whose `from` is a single FILE is copied by `copyOrLinkFile`, which has never
//          heard of signing. That one-word difference between two configs that both "work" is the
//          entire reason this suite exists.
//        * `WinPackager.createTransformerForExtraFiles` returns null wholesale when
//          `signAndEditExecutable` or `signExecutable` is false, and otherwise signs a copied file
//          when `shouldSignFile` says so — `.exe` by default, but `signExts` REPLACES that default
//          and could drop the engine out of the set while the installer still signs.
//        * `windowsSignToolManager.signFile` invokes the custom `sign` hook when one is
//          configured, cert or no cert, which is what makes `scripts/azure-sign.cjs` the single
//          door every signed file in this product goes through.
//
//      So the test asserts the PRECONDITIONS, in the config, with the code path that reads each
//      one named beside it. It cannot prove a signature exists (that needs the AZURE_* secrets and
//      therefore CI), and it does not pretend to: what it prevents is the config quietly ceasing
//      to ask.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  ENGINE_BIN_NAME,
  engineBinaryCandidates
} from '../src/main/dataServer/engineProtocol'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')

/** Read a config as LF-normalized text. A line ending is not a configuration change — JOS-458's
 *  fixup learned that the hard way when a CRLF checkout reddened a byte-counting gate — and every
 *  pattern below is about structure, so the separator must not be part of the question. */
function config(...parts: string[]): string {
  return readFileSync(join(ROOT, ...parts), 'utf8').replace(/\r\n/g, '\n')
}

const builderYml = config('electron-builder.yml')
const packageJson = config('package.json')
const workflow = config('.github', 'workflows', 'build.yml')

/** The version `release/<version>/` is named after. Read rather than hardcoded: CI stamps it from
 *  the tag, so a literal here would only ever be right on a dev machine. */
function version(): string {
  return (JSON.parse(packageJson) as { version: string }).version
}

/**
 * The `- …` entries of one top-level list in electron-builder.yml, comments and blank lines
 * dropped. A block ends at the first line that starts in column 0, which is what keeps `files:`
 * from reading the annotation of whatever follows it as its own.
 */
function listEntries(key: string): string[] {
  const lines = builderYml.split('\n')
  const start = lines.indexOf(`${key}:`)
  assert.notEqual(start, -1, `electron-builder.yml has no top-level ${key}`)
  const out: string[] = []
  for (const line of lines.slice(start + 1)) {
    if (/^\S/.test(line)) break
    const entry = /^\s+- (.*)$/.exec(line)
    if (entry) out.push(entry[1])
  }
  return out
}

/** The one `extraResources` matcher, as the three fields that decide everything below. */
function engineMatcher(): { from: string; to: string; filter: string } {
  const block = /extraResources:\n\s*- from: (\S+)\n\s*to: (\S+)\n\s*filter:\n\s*- (\S+)\n/.exec(builderYml)
  assert.ok(block, 'electron-builder.yml must ship the engine via an extraResources matcher')
  return { from: block[1], to: block[2], filter: block[3] }
}

// =========================================================================================
// 1. the address
// =========================================================================================

test('THE SHIPPED PATH IS THE PROBED PATH — composed, not restated', () => {
  const { to, filter } = engineMatcher()
  // `to` is relative to the packaged `resources/` directory (extraResources' base), so the file's
  // packaged address is exactly this. `resourcesPath` is a stand-in: what is being compared is the
  // SHAPE below the resources root, which is the half the two files have to agree on.
  const shipped = `RES/${to}/${filter}`
  const [firstPackagedCandidate] = engineBinaryCandidates({
    appPath: '',
    resourcesPath: 'RES'
  })
  assert.equal(
    shipped,
    firstPackagedCandidate,
    'electron-builder must put the engine where engineBinaryCandidates looks FIRST among the ' +
      'packaged candidates — a mismatch here is a packaged app that silently runs with no engine'
  )
  // …and the name is the resolver's own constant rather than a second spelling of it.
  assert.equal(filter, ENGINE_BIN_NAME)
})

test('the binary comes out of cargo`s RELEASE directory, and only the binary does', () => {
  const { from, filter } = engineMatcher()
  assert.equal(from, 'engine/target/release')
  // The filter is load-bearing for SIZE, not just tidiness: `engine/target/release` also holds
  // deps/, build/, incremental/ and a 1.6 MB .pdb. `createFilter` prunes a non-matching directory
  // before walking into it, so the copy visits one file.
  assert.equal(filter, 'engined.exe')
})

test('the engine is NOT in `files`, and therefore needs no asarUnpack entry', () => {
  // extraResources land beside the asar, never inside it — which is the only arrangement a native
  // executable can be launched from. The `files` allowlist names `resources/wiki-images/**` and
  // nothing else under resources/, so there is nothing to unpack and no second address to keep.
  // ENTRIES ONLY, never the comments around them: this file's comments are essays that mention
  // engines, DLLs and asars constantly (an antivirus engine, `speech:say`'s
  // 'engine-not-installed'), so a substring search over the whole block answers about prose.
  const files = listEntries('files')
  assert.ok(files.length > 0, 'electron-builder.yml must keep its files allowlist')
  assert.equal(
    files.some((entry) => entry.includes('engine')),
    false,
    'the engine must not enter the asar'
  )
  assert.equal(
    listEntries('asarUnpack').some((entry) => entry.includes('engine')),
    false
  )
})

// =========================================================================================
// 2. the signature — the preconditions, each beside the code path that reads it
// =========================================================================================

test('THE MATCHER IS A DIRECTORY — a file `from` would ship an UNSIGNED engine and say nothing', () => {
  const { from } = engineMatcher()
  // `fileMatcher.copyFiles`: `fromStat.isFile()` → `copyOrLinkFile`, transformer never consulted.
  // Only the directory branch reaches `copyDir(..., { transformer })`. Both configs produce a
  // working app; exactly one produces a signed one.
  assert.equal(
    from.endsWith(ENGINE_BIN_NAME),
    false,
    'extraResources `from` must be a DIRECTORY (with a filter) or the sign transformer is skipped'
  )
})

test('the sign hook is wired, and it is the one every shipped executable goes through', () => {
  // `windowsSignToolManager.signFile` resolves `win.signtoolOptions.sign` and calls it even when no
  // certificate is configured, which is what lets the hook self-skip locally and sign in CI.
  assert.match(builderYml, /sign: scripts\/azure-sign\.cjs/)
  assert.match(builderYml, /signAndEditExecutable: true/)
})

test('nothing in the config narrows the signable set out from under the engine', () => {
  // `shouldSignFile` signs `.exe` by DEFAULT — but `signExts`, if present, REPLACES that default,
  // and `signExecutable: false` / `signAndEditExecutable: false` make
  // `createTransformerForExtraFiles` return null so extra resources are copied unsigned. None of
  // the three is set today; each would be a silent downgrade.
  assert.equal(/^\s*signExts:/m.test(builderYml), false, 'signExts would replace the .exe default')
  assert.equal(/signExecutable: false/.test(builderYml), false)
  assert.equal(/signAndEditExecutable: false/.test(builderYml), false)
  // …and the file that gets signed has to be the extension `shouldSignFile` recognises.
  assert.match(engineMatcher().filter, /\.exe$/)
})

// =========================================================================================
// 3. the binary exists by the time electron-builder looks for it
// =========================================================================================

test('BOTH dist scripts build the engine BEFORE packaging', () => {
  // A missing extraResources source is a WARNING in electron-builder ("file source doesn't exist")
  // and the installer is produced anyway — so ORDER is the whole guarantee. `npm run build:engine`
  // additionally asserts cargo actually left a binary behind (scripts/build-engine.mts).
  const scripts = JSON.parse(packageJson) as { scripts: Record<string, string> }
  assert.match(scripts.scripts['build:engine'], /build-engine\.mts/)
  for (const name of ['dist', 'dist:dir']) {
    const script = scripts.scripts[name]
    assert.ok(script.includes('build:engine'), `${name} must build the engine`)
    assert.ok(
      script.indexOf('build:engine') < script.indexOf('electron-builder'),
      `${name} must build the engine BEFORE electron-builder copies it`
    )
  }
})

test('ROUND TRIP: the resolver finds the engine in a real dist:dir output', (t) => {
  // SKIPS WITHOUT A BUILD, `symbolicate.test.mts`'s pattern and its reason: `release/` is
  // gitignored and CI runs this suite before it packages, so a test that demanded the artifact
  // would be one nobody could keep green. When the artifact IS there, this is the only assertion
  // in the file that checks a real packaged tree rather than a config — the two halves of the
  // question ("does the config say the right path" and "is a binary actually at it") answered by
  // the code that will ask it at runtime.
  const unpacked = join(ROOT, 'release', version(), 'win-unpacked')
  if (!existsSync(join(unpacked, 'resources', 'engine', ENGINE_BIN_NAME))) {
    t.skip('no dist:dir output — run `npm run dist:dir`')
    return
  }
  // What Electron hands `resolveEngineBinary` in a packaged app: the asar as appPath, the
  // resources directory as resourcesPath.
  const candidates = engineBinaryCandidates({
    appPath: join(unpacked, 'resources', 'app.asar'),
    resourcesPath: join(unpacked, 'resources'),
    cwd: unpacked
  })
  const found = candidates.find((path) => existsSync(path))
  // The resolver joins with `/` and leaves the caller's separators alone, so this is the exact
  // string it produces — spelled the same way here rather than normalized, because normalizing
  // would hide a resolver that had started rewriting paths.
  assert.equal(
    found,
    `${join(unpacked, 'resources')}/engine/${ENGINE_BIN_NAME}`,
    `the first candidate that exists must be the shipped engine; looked in ${candidates.join(', ')}`
  )
})

test('both CI jobs that PACKAGE build the engine first', () => {
  // The tag job is the one that ships; the main-push job uploads the installer people test, and an
  // artifact missing the engine would verify a build nobody releases. Neither is the `engine` job,
  // which builds DEBUG for `cargo test`.
  assert.equal(
    (workflow.match(/^ {6}- name: Build the engine \(release\)$/gm) ?? []).length,
    2,
    'the build job and the release job each need their own release engine build'
  )
})
