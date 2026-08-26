// gen-protocol.mts — regenerates BOTH sides of the data-server wire contract. `npm run gen:protocol`.
//
// ONE COMMAND, TWO LANGUAGES, ONE SOURCE (owner ruling 1a, JOS-464). `protocol/schema/*.schema.json`
// is neutral JSON Schema draft 2020-12; this writes `src/shared/dataServer/protocol.generated.ts`
// with json-schema-to-typescript and `engine/crates/protocol/src/generated.rs` with typify. Both
// artifacts are COMMITTED, and both are pinned by tests that regenerate and diff — the same
// contract `gen-telemetry-doc.mts` has with `tests/telemetryDoc.test.mts` and `gen-data-weight.mts`
// with `tests/dataWeight.test.mts`. Edit the schema, run this, commit all three.
//
// THE RUST HALF NEEDS CARGO, and this script says so plainly rather than skipping it: a generator
// that quietly does half its job leaves a repo where one language's types are a version ahead of
// the other's, which is the exact failure the checked artifact exists to prevent. If cargo is
// missing, the TypeScript file is still written (so a schema edit does not leave a broken tree) and
// the script exits non-zero with the reason.
//
// IT SPAWNS CARGO DIRECTLY, never through a shell and above all never through powershell.exe —
// PowerShell binaries are the antivirus trigger this app spent a release eliminating, and nothing
// in the engine or its build may reintroduce one.
//
// IT TOUCHES NO NETWORK AND NO GAME LOG. It reads files already committed to this repo.

import { spawnSync } from 'node:child_process'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { renderTypeScript } from './protocolCodegen.mjs'
import { ROOT, RUST_OUT, TS_OUT, protocolVersion, readSchemaFiles, schemaDigest } from './protocolSchema.mjs'

/**
 * Write only if the CONTENT moved, comparing LF-normalized.
 *
 * The normalization is not cosmetic. This repo checks out with `core.autocrlf=true`, so the moment
 * a generated file is committed it comes back to the working tree with CRLF while this generator
 * emits LF. A raw byte compare therefore reports "written" on every single run, rewrites a file
 * nobody changed, and churns its mtime — which is enough to make `git status` list the file as
 * modified until something refreshes the stat cache, so the tree looks dirty when it is not. That
 * is a generator lying about its own work, and it is exactly the class of thing JOS-458 already
 * paid for once. The staleness suites compare the same way.
 */
function writeIfChanged(path: string, next: string): boolean {
  let before = ''
  try {
    before = readFileSync(path, 'utf8')
  } catch {
    before = ''
  }
  if (before.replace(/\r\n/g, '\n') === next.replace(/\r\n/g, '\n')) return false
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, next, 'utf8')
  return true
}

const files = readSchemaFiles()
const version = protocolVersion(files)
const digest = schemaDigest(files)

console.log(`gen:protocol: ${String(files.length)} schema files, protocol version ${String(version)}`)
console.log(`gen:protocol: schema-digest sha256:${digest}`)

const ts = await renderTypeScript()
const tsChanged = writeIfChanged(TS_OUT, ts)
console.log(
  `gen:protocol: ${relative(ROOT, TS_OUT)} ${tsChanged ? 'written' : 'already current'}`
)

// --- the Rust half ------------------------------------------------------------------------------
// `cargo run -p protocol-codegen` writes engine/crates/protocol/src/generated.rs. It is a separate
// process rather than a port of typify because typify IS the ruling's named generator, and a
// reimplementation of it in TypeScript would be a third thing to keep correct.
const cargo = spawnSync('cargo', ['run', '--quiet', '-p', 'protocol-codegen'], {
  cwd: join(ROOT, 'engine'),
  stdio: 'inherit',
  shell: false
})

if (cargo.error !== undefined) {
  console.error(
    `gen:protocol: could not run cargo (${cargo.error.message}).\n` +
      '  The Rust half of the contract was NOT regenerated. Install the toolchain\n' +
      '  (rustup, then let engine/rust-toolchain.toml pin the version) and run this again —\n' +
      '  a tree where only one language regenerated is exactly what the staleness tests catch.'
  )
  process.exit(1)
}
if (cargo.status !== 0) {
  console.error(`gen:protocol: cargo exited ${String(cargo.status)}`)
  process.exit(cargo.status ?? 1)
}

console.log(`gen:protocol: ${relative(ROOT, RUST_OUT)} done`)
console.log('gen:protocol: commit the schema and BOTH generated files together')
