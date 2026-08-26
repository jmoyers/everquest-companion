// protocolSchema.mts — reading, bundling and fingerprinting the data-server protocol schema.
//
// THE SOURCE OF TRUTH IS `protocol/schema/*.schema.json` (owner ruling 1a, JOS-464): neutral JSON
// Schema draft 2020-12, privileging neither language. TypeScript types are generated from it into
// `src/shared/dataServer/protocol.generated.ts`; Rust types into
// `engine/crates/protocol/src/generated.rs`. Both generated files are COMMITTED and pinned by
// tests that regenerate and diff — the same contract `gen-telemetry-doc.mts` has with
// `tests/telemetryDoc.test.mts` and `gen-data-weight.mts` with `tests/dataWeight.test.mts`.
//
// WHY THERE IS A BUNDLE STEP. The schema is split into topic files a person can read
// (messages / stream / views), but the Rust generator (typify) refuses cross-FILE `$ref`s
// outright — `external references are not supported` is a panic, not a warning. So every `$ref`
// in this repo is a local pointer of the form `#/$defs/Name`, and `bundleSchema()` merges the
// files' `$defs` maps into one document in which every such pointer resolves. A duplicate name
// across files is a hard error rather than a last-write-wins merge: two definitions of `Row`
// would generate one type and silently drop the other.
//
// WHY THE DIGEST IS NORMALIZED. `git config core.autocrlf=true` on this machine, so a checkout's
// on-disk bytes carry \r\n while a generator emits \n. JOS-458 already paid for that lesson once
// (CI measured a one-byte difference on the same commit and reddened a build over a line ending).
// The fingerprint is taken over LF-normalized content so every checkout agrees.

import { createHash } from 'node:crypto'
import { readFileSync, readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
export const SCHEMA_DIR = join(ROOT, 'protocol', 'schema')
export const FIXTURE_DIR = join(ROOT, 'protocol', 'fixtures')
export const TS_OUT = join(ROOT, 'src', 'shared', 'dataServer', 'protocol.generated.ts')
export const RUST_OUT = join(ROOT, 'engine', 'crates', 'protocol', 'src', 'generated.rs')

/** The `$id` the bundled document carries. Identity of the merge, not of any one source file. */
export const BUNDLE_ID = 'https://everquest-companion.local/protocol'

/** The extension keyword one schema file carries to state the wire version. See `protocolVersion`. */
const VERSION_KEY = 'x-protocolVersion'

export interface SchemaFile {
  /** File name only, e.g. `messages.schema.json` — the digest's stable key. */
  readonly name: string
  /** LF-normalized text, exactly as the digest measures it. */
  readonly text: string
  readonly json: Record<string, unknown>
}

/** Every `*.schema.json` in `protocol/schema/`, name-sorted so the digest is order-independent. */
export function readSchemaFiles(): SchemaFile[] {
  const names = readdirSync(SCHEMA_DIR)
    .filter((n) => n.endsWith('.schema.json'))
    .sort()
  if (names.length === 0) throw new Error(`no *.schema.json in ${SCHEMA_DIR}`)
  return names.map((name) => {
    const text = readFileSync(join(SCHEMA_DIR, name), 'utf8').replace(/\r\n/g, '\n')
    return { name, text, json: JSON.parse(text) as Record<string, unknown> }
  })
}

/**
 * The single document both generators read: `$defs` merged across every source file, with the
 * per-file metadata (`$id`, `title`, the `x-` extensions) dropped.
 *
 * THE ROOT IS NOT EMPTY, and that is deliberate. Both generators emit a type for the document's
 * root whether or not it says anything — json-schema-to-typescript names it after the `$id` and
 * gives it an index signature; typify manufactures one from the title. Rather than fight for an
 * absence, the root IS a type worth having: `ProtocolMessage`, anything that can travel the wire
 * in either direction, which is exactly the type a transport adapter is generic over.
 */
export function bundleSchema(files: SchemaFile[] = readSchemaFiles()): Record<string, unknown> {
  const defs: Record<string, unknown> = {}
  const source = new Map<string, string>()
  for (const file of files) {
    const fileDefs = file.json.$defs
    if (typeof fileDefs !== 'object' || fileDefs === null) {
      throw new Error(`${file.name}: every schema file must carry a top-level $defs object`)
    }
    for (const [name, def] of Object.entries(fileDefs as Record<string, unknown>)) {
      const previous = source.get(name)
      if (previous !== undefined) {
        throw new Error(`$defs/${name} is defined in both ${previous} and ${file.name}`)
      }
      source.set(name, file.name)
      defs[name] = def
    }
  }
  // Name-sorted: the generated files' declaration order must not depend on which topic file a
  // definition happens to live in, or moving one between files would produce a diff that looks
  // like a protocol change.
  const sorted = Object.fromEntries(Object.entries(defs).sort(([a], [b]) => (a < b ? -1 : 1)))
  for (const required of ['ClientMessage', 'EngineMessage']) {
    if (!(required in sorted)) throw new Error(`$defs/${required} is missing from the bundle`)
  }
  return {
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    $id: BUNDLE_ID,
    title: 'ProtocolMessage',
    description:
      'Anything that can travel the wire, in either direction. The transport adapters are generic over exactly this: a transport moves ProtocolMessages and knows nothing else about the protocol.',
    oneOf: [{ $ref: '#/$defs/ClientMessage' }, { $ref: '#/$defs/EngineMessage' }],
    $defs: sorted
  }
}

/**
 * THE WIRE VERSION: a single integer, bumped on any breaking change, fatal on mismatch at hello.
 * Exactly one schema file may declare it, so there is one place to edit and no way for two files
 * to disagree. It is an `x-` extension rather than a `$defs` entry because it is a FACT ABOUT the
 * schema, not a type in it — a `{"const": 1}` definition would generate a useless type on both
 * sides and still not give either language a usable constant.
 */
export function protocolVersion(files: SchemaFile[] = readSchemaFiles()): number {
  const declaring = files.filter((f) => f.json[VERSION_KEY] !== undefined)
  if (declaring.length !== 1) {
    throw new Error(
      `exactly one schema file must declare "${VERSION_KEY}"; found ${String(declaring.length)}`
    )
  }
  const value = declaring[0].json[VERSION_KEY]
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1) {
    throw new Error(`"${VERSION_KEY}" must be a positive integer, got ${JSON.stringify(value)}`)
  }
  return value
}

/**
 * The fingerprint both generated files carry in their header. It is what lets the node suite say
 * "the Rust file is stale" WITHOUT a Rust toolchain: CI's `npm test` runs on a box that may have
 * no cargo, and a staleness check that can only run where the compiler is is a check that goes
 * missing exactly when it matters. The engine's own suite still regenerates and diffs in full.
 */
export function schemaDigest(files: SchemaFile[] = readSchemaFiles()): string {
  const hash = createHash('sha256')
  for (const file of files) {
    hash.update(file.name)
    hash.update('\n')
    hash.update(file.text)
    hash.update('\n')
  }
  return hash.digest('hex')
}

/** The line both generated files carry, verbatim, so one regex finds it in either language. */
export function digestLine(digest: string): string {
  return `schema-digest: sha256:${digest}`
}

/** Every fixture file, name-sorted. The four worked moments plus the handshake. */
export function readFixtureNames(): string[] {
  return readdirSync(FIXTURE_DIR)
    .filter((n) => n.endsWith('.json'))
    .sort()
}
