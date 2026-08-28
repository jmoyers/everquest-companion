// THE PROTOCOL SCHEMA AS A CHECKED ARTIFACT (JOS-464, phase 0 of the data-server program).
//
// `protocol/schema/*.schema.json` is the source of truth for the wire contract between the app and
// the future Rust engine (owner ruling 1a: neutral JSON Schema, neither language privileged). Two
// generated files come out of it and BOTH are committed —
// `src/shared/dataServer/protocol.generated.ts` and `engine/crates/protocol/src/generated.rs`.
// Committing generated code is only honest if a stale copy CANNOT SHIP, and this file is what makes
// that true on the TypeScript side, exactly as `tests/telemetryDoc.test.mts` does for TELEMETRY.md
// and `tests/dataWeight.test.mts` for the data-weight ledger.
//
// IT CHECKS FIVE DIFFERENT THINGS, and they fail for five different reasons:
//
//   * PARITY — the committed TypeScript equals a fresh render. Red when a schema edit lands without
//     `npm run gen:protocol`, or when somebody hand-edits the generated file.
//   * THE RUST ARTIFACT — checked HERE, by digest, and not only in `cargo test`. CI's `npm test`
//     runs on a box that may have no Rust toolchain, and a staleness check that can only run where
//     the compiler is is a check that goes missing exactly when it matters. The engine's own suite
//     still regenerates the file in full and diffs every byte; this is the half that always runs.
//   * COVERAGE — every definition in the schema became a type in BOTH languages. That is the guard
//     on the one piece of logic this repo maintains twice (the $defs merge, mirrored in
//     `scripts/protocolSchema.mts` and `engine/crates/protocol-codegen/src/lib.rs`): a definition
//     one merge dropped simply would not be there.
//   * THE FIXTURES — the four worked moments from the diff-protocol section of
//     docs/plans/data-server.md, validated against the schema itself and narrowed through the
//     generated union with an exhaustive switch. `engine/crates/protocol/tests/fixtures.rs` runs the
//     same bytes through the Rust types. They are the first cross-language artifacts in this repo.
//   * THE SCHEMA'S OWN LAW — that it describes MESSAGES and never bytes. The owner's constraint on
//     this protocol is that the wire method must be swappable by replacing one adapter, and a
//     schema that grew a `frameLength` property would break that quietly.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import Ajv2020 from 'ajv/dist/2020.js'
import type { ValidateFunction } from 'ajv'
import {
  FIXTURE_DIR,
  RUST_OUT,
  TS_OUT,
  bundleSchema,
  digestLine,
  protocolVersion,
  readFixtureNames,
  readSchemaFiles,
  schemaDigest
} from '../scripts/protocolSchema.mjs'
import { renderTypeScript, stripProvenanceNotes } from '../scripts/protocolCodegen.mjs'
import {
  PROTOCOL_VERSION,
  type ClientMessage,
  type EngineMessage
} from '../src/shared/dataServer/protocol.generated'
import {
  MAX_TOKEN_CHARS,
  MIN_TOKEN_CHARS,
  isWellFormedToken
} from '../src/shared/dataServer/token'

// CRLF-normalized for the same reason `telemetryDoc.test.mts` normalizes: this repo checks out with
// core.autocrlf=true, so the committed file's on-disk bytes carry \r\n while a renderer emits \n.
// Comparing raw bytes would make the suite red on every Windows checkout of a file nobody touched.
const committed = (path: string): string => readFileSync(path, 'utf8').replace(/\r\n/g, '\n')

const files = readSchemaFiles()
const bundle = bundleSchema(files)

// ---- 1. the schema itself ----------------------------------------------------------------------

test('every schema file is draft 2020-12 and carries nothing but $defs of substance', () => {
  assert.ok(files.length >= 3, 'the schema was expected to be split into topic files')
  for (const file of files) {
    assert.equal(
      file.json.$schema,
      'https://json-schema.org/draft/2020-12/schema',
      `${file.name} does not declare draft 2020-12`
    )
    const defs = file.json.$defs as Record<string, unknown>
    assert.ok(Object.keys(defs).length > 0, `${file.name} defines nothing`)
    for (const [name, def] of Object.entries(defs)) {
      const title = (def as { title?: unknown }).title
      assert.equal(title, name, `$defs/${name} in ${file.name} has title ${String(title)}`)
    }
  }
})

test('every $ref resolves inside the bundle — a dangling pointer is a generator crash, not a warning', () => {
  const defs = bundle.$defs as Record<string, unknown>
  const seen: string[] = []
  const walk = (node: unknown): void => {
    if (Array.isArray(node)) {
      for (const child of node) walk(child)
      return
    }
    if (typeof node !== 'object' || node === null) return
    for (const [key, value] of Object.entries(node)) {
      if (key === '$ref' && typeof value === 'string') {
        seen.push(value)
        // LOCAL POINTERS ONLY. typify treats a cross-file `$ref` as a panic, not a warning, which
        // is why the topic files are merged before either generator sees them.
        assert.match(value, /^#\/\$defs\/[A-Za-z0-9_]+$/, `${value} is not a local $defs pointer`)
        assert.ok(value.slice('#/$defs/'.length) in defs, `${value} points at nothing`)
        continue
      }
      walk(value)
    }
  }
  walk(defs)
  assert.ok(seen.length > 20, `only ${String(seen.length)} refs — did the bundle lose a file?`)
})

test('THE SCHEMA DESCRIBES MESSAGES AND NEVER BYTES — the owner constraint, as a structural check', () => {
  // "lets make sure the way this works we could change the wire method at a later date and need to
  // just swap an artifact. im thinking over the open internet via websockets etc." A schema that
  // grew a byte-count, a port or a frame length would make that impossible, and would do it
  // quietly. The check is over PROPERTY NAMES rather than prose: the prose has to be able to
  // explain why framing is absent, which is not the same as declaring it.
  const forbidden = /^(frame|framing|delimiter|newline|bytes|byteLength|port|host|socket|url|payloadBytes)$/i
  const names: string[] = []
  const walk = (node: unknown): void => {
    if (Array.isArray(node)) {
      for (const child of node) walk(child)
      return
    }
    if (typeof node !== 'object' || node === null) return
    const props = (node as { properties?: Record<string, unknown> }).properties
    if (props !== undefined) names.push(...Object.keys(props))
    for (const [key, value] of Object.entries(node)) {
      if (key === 'description' || key === 'title') continue
      walk(value)
    }
  }
  walk(bundle.$defs)
  assert.ok(names.length > 30, 'the walk found almost no properties — it is not looking')
  for (const name of names) {
    assert.doesNotMatch(name, forbidden, `\`${name}\` is a framing concern and belongs in a transport adapter`)
  }
})

// ---- 2. the generated artifacts are current -----------------------------------------------------

test('PARITY: the committed TypeScript is exactly what the schema renders today', async () => {
  assert.equal(
    committed(TS_OUT),
    await renderTypeScript(),
    'src/shared/dataServer/protocol.generated.ts is out of date — run `npm run gen:protocol` and commit BOTH generated files'
  )
})

test('THE RUST ARTIFACT IS CURRENT TOO, and this suite can say so without a Rust toolchain', () => {
  // By DIGEST rather than by regeneration — see this file's header for why the cheap check is the
  // one that always runs. `engine/crates/protocol-codegen/tests/staleness.rs` does the expensive
  // one, and computes this same digest the same way so the two can never disagree.
  const line = digestLine(schemaDigest(files))
  const rust = committed(RUST_OUT)
  assert.ok(
    rust.includes(line),
    `engine/crates/protocol/src/generated.rs was generated from a different schema — run \`npm run gen:protocol\` and commit it (expected ${line})`
  )
  // …and the TypeScript file carries the same line, so one grep answers "are these two in step".
  assert.ok(committed(TS_OUT).includes(line))
})

test('COVERAGE: every definition became a type in BOTH languages', () => {
  const ts = committed(TS_OUT)
  const rust = committed(RUST_OUT)
  const names = Object.keys(bundle.$defs as Record<string, unknown>)
  assert.ok(names.length >= 30, `only ${String(names.length)} definitions — did the merge drop a file?`)

  for (const name of names) {
    assert.ok(
      ts.includes(`export interface ${name} `) ||
        ts.includes(`export interface ${name} {`) ||
        ts.includes(`export type ${name} =`),
      `$defs/${name} produced no TypeScript type`
    )
    // THE TWO DELIBERATE ABSENCES on the Rust side, and they are the same defect twice: typify
    // lowers a multi-type schema to an enum whose number arm is f64, so `184220` comes back
    // `184220.0`. Both replacements are declared in `engine/crates/protocol-codegen/src/lib.rs`
    // and both are named HERE, so a third one cannot appear without editing this list.
    if (name === 'Cell') {
      // `Cell` is replaced by the hand-written `protocol::cell::Cell` — see that module's header.
      assert.ok(rust.includes('crate::cell::Cell'), 'the hand-written Cell replacement is not in use')
      continue
    }
    if (name === 'ModuleState') {
      // `ModuleState` says "any JSON, the module owns the shape"; in Rust that sentence IS
      // `serde_json::Value`, so there is nothing to hand-write and nothing to generate.
      assert.ok(
        rust.includes('pub state: ::serde_json::Value'),
        'the ModuleState replacement is not in use'
      )
      continue
    }
    assert.ok(
      [`pub struct ${name} `, `pub struct ${name}(`, `pub struct ${name} {`, `pub enum ${name} `, `pub type ${name} `].some(
        (needle) => rust.includes(needle)
      ),
      `$defs/${name} produced no Rust type`
    )
  }
})

test('the generated TypeScript carries no generator boilerplate', () => {
  // `stripProvenanceNotes` removes json-schema-to-typescript's per-type "this interface was
  // referenced by…" note, which in a bundle of nothing but $defs is every type. Pinned so a
  // generator upgrade that rewords the note is caught rather than silently restoring the noise.
  const ts = committed(TS_OUT)
  assert.doesNotMatch(ts, /This interface was referenced by/)
  assert.doesNotMatch(ts, /via the `definition`/)
  assert.equal(stripProvenanceNotes(ts), ts, 'the stripper is not idempotent')
})

// ---- 3. the constants three files spell separately ----------------------------------------------

test('THE WIRE VERSION agrees everywhere it is written down', () => {
  const version = protocolVersion(files)
  assert.equal(PROTOCOL_VERSION, version, 'the generated TypeScript constant disagrees with the schema')
  assert.ok(
    committed(RUST_OUT).includes(`pub const PROTOCOL_VERSION: i64 = ${String(version)};`),
    'the generated Rust constant disagrees with the schema'
  )
  assert.ok(Number.isInteger(version) && version >= 1)
})

test('THE TOKEN BOUNDS agree between the schema, the shared module and the Rust crate', () => {
  const token = (bundle.$defs as Record<string, { minLength: number; maxLength: number }>).Token
  assert.equal(token.minLength, MIN_TOKEN_CHARS)
  assert.equal(token.maxLength, MAX_TOKEN_CHARS)

  const rustToken = readFileSync(
    join(RUST_OUT, '..', 'token.rs'),
    'utf8'
  )
  assert.ok(
    rustToken.includes(`pub const MIN_TOKEN_BYTES: usize = ${String(token.minLength)};`),
    'engine/crates/protocol/src/token.rs disagrees with the schema about the floor'
  )
  assert.ok(
    rustToken.includes(`pub const MAX_TOKEN_BYTES: usize = ${String(token.maxLength)};`),
    'engine/crates/protocol/src/token.rs disagrees with the schema about the ceiling'
  )
})

// ---- 4. the fixtures — the first cross-language artifacts ---------------------------------------

interface Frame {
  dir: 'client' | 'engine'
  message: unknown
}
interface Fixture {
  name: string
  moment: string
  messages: Frame[]
}

const fixtures: Fixture[] = readFixtureNames().map((name) => {
  const doc = JSON.parse(readFileSync(join(FIXTURE_DIR, name), 'utf8')) as Omit<Fixture, 'name'>
  return { name, ...doc }
})

const ajv = new Ajv2020({ strict: false, allErrors: true })
ajv.addSchema(bundle, 'protocol')
const validator = (def: string): ValidateFunction => {
  const v = ajv.getSchema(`protocol#/$defs/${def}`)
  assert.ok(v, `no validator for ${def}`)
  return v
}
const isClientMessage = validator('ClientMessage')
const isEngineMessage = validator('EngineMessage')

import { describeClient, describeEngine } from './protocolDescribe.mjs'

test('THE FOUR WORKED MOMENTS from the plan doc are committed as fixtures', () => {
  const names = fixtures.map((f) => f.name)
  for (const expected of [
    '01-subscribe.json',
    '02-live-diff.json',
    '03-meter-tick.json',
    '04-character-switch.json'
  ]) {
    assert.ok(names.includes(expected), `${expected} is missing`)
  }
  for (const fixture of fixtures) {
    assert.ok(fixture.moment.length > 3, `${fixture.name} does not name its moment`)
    assert.ok(fixture.messages.length > 0, `${fixture.name} carries no messages`)
  }
})

test('every fixture message VALIDATES against the schema and narrows through the union', () => {
  let frames = 0
  const seen = new Set<string>()
  for (const fixture of fixtures) {
    for (const frame of fixture.messages) {
      const where = `${fixture.name} frame ${String(frames)}`
      if (frame.dir === 'client') {
        assert.ok(
          isClientMessage(frame.message),
          `${where}: ${JSON.stringify(isClientMessage.errors)}`
        )
        const typed = frame.message as ClientMessage
        seen.add(typed.op)
        assert.ok(describeClient(typed).length > 0)
      } else {
        assert.ok(
          isEngineMessage(frame.message),
          `${where}: ${JSON.stringify(isEngineMessage.errors)}`
        )
        const typed = frame.message as EngineMessage
        seen.add(typed.kind)
        assert.ok(describeEngine(typed).length > 0)
      }
      frames += 1
    }
  }
  assert.ok(frames >= 12, `only ${String(frames)} frames were exercised`)
  // Every op and every message kind the v0 set defines appears somewhere in the fixtures, so a new
  // one cannot be added to the schema and left undemonstrated.
  for (const tag of [
    'hello',
    'echo',
    'session.attach',
    'session.health',
    'session.progress',
    'module.snapshot',
    'view.subscribe',
    'view.unsubscribe',
    'alerts.define',
    'buffTrust.define',
    'respawn.define',
    'combo.define',
    'roster.define',
    'knowledge.item', 'knowledge.mob', 'knowledge.spell',
    'knowledge.search', 'knowledge.define',
    'reply',
    'error',
    'reset',
    'diff',
    'epoch',
    'fire',
    'knowledgeMiss',
    'sessionMarks.add',
    'respawn.confirmSighting',
    'conCard',
    'moduleChanged'
  ]) {
    assert.ok(seen.has(tag), `no fixture demonstrates \`${tag}\``)
  }
})

test('THE SCHEMA HAS TEETH — the shapes it forbids are actually refused', () => {
  // A validator that accepts everything would pass every assertion above. These are the four
  // constraints the contract leans on hardest.
  const cases: [string, unknown][] = [
    [
      'a reply that says ok:false',
      { kind: 'reply', id: 1, ok: false, result: {} }
    ],
    [
      'a stream message with an unknown field',
      { kind: 'epoch', epoch: 1, reason: 'attach', surprise: true }
    ],
    [
      'a sort direction that is not asc or desc',
      { id: 1, op: 'view.subscribe', params: { source: 'loot.ledger', sort: [['at', 'sideways']] } }
    ],
    [
      'a cell holding structure',
      {
        kind: 'reset',
        id: 1,
        epoch: 0,
        total: 1,
        rows: [{ key: 'row:1', cells: { nested: { a: 1 } } }]
      }
    ],
    ['an error code nobody defined', { kind: 'error', id: 1, ok: false, error: { code: 'oops', message: 'x' } }],
    [
      'a token below the entropy floor',
      { op: 'hello', token: 'short', protocolVersion: 1 }
    ]
  ]
  for (const [why, message] of cases) {
    const accepted = isEngineMessage(message) || isClientMessage(message)
    assert.equal(accepted, false, `the schema accepted ${why}`)
  }
})

test('THE FOLD PERCENT IS FRACTIONAL, and comes back as the same text in both languages', () => {
  // `pct` is a float by owner ruling: the engine emits what it measured and the renderer rounds for
  // display. That makes the WORKED EXAMPLE's value load-bearing — Rust writes a whole f64 as `62.0`,
  // so a fixture carrying `62` would stop being byte-verbatim across the two languages the moment
  // the Rust side re-serialized it. 62.4 round-trips identically in both, and both sides pin it:
  // this assertion, and `rule_three_...` in engine/crates/protocol/tests/fixtures.rs.
  const switchMoment = fixtures.find((f) => f.name === '04-character-switch.json')
  assert.ok(switchMoment)
  const bump = switchMoment.messages[0].message as EngineMessage
  assert.equal(bump.kind, 'epoch')
  const progress = bump.progress
  assert.ok(progress)
  assert.equal(progress.pct, 62.4)
  assert.equal(Number.isInteger(progress.pct), false, 'a whole value would not prove anything')
  assert.match(JSON.stringify(progress), /"pct":62\.4/)
})

test('A PROGRESS FRAME SAYS WHICH LOOP EMITTED IT, and says it by being absent (JOS-518)', () => {
  // The engine has two loops that emit this same shape — the historical scan and the live tail —
  // and their NUMBERS do not distinguish them: a caught-up tail sits at 100% with the event count
  // climbing, which is what a scan that has just finished looks like. `live` is the engine saying
  // which one it is in, and it is OPTIONAL because a scan frame says nothing rather than saying
  // false (the `song`/`rare` idiom already on this wire).
  const fold = (bundle.$defs as Record<string, {
    properties: Record<string, { type?: string }>
    required: string[]
  }>).FoldProgress
  assert.equal(fold.properties.live.type, 'boolean')
  assert.equal(fold.required.includes('live'), false, '`live` is present only when true')

  const framed = (live?: boolean): unknown => ({
    kind: 'epoch',
    epoch: 2,
    reason: 'progress',
    progress: { pct: 62.4, events: 9087066, offset: 128, logSize: 205, ...(live === undefined ? {} : { live }) }
  })
  assert.ok(isEngineMessage(framed()), 'a scan frame carries no flag')
  assert.ok(isEngineMessage(framed(true)), 'a tail frame carries it')
  // …and it is a BOOLEAN, not a loop name: `additionalProperties: false` plus a typed member is
  // what stops a future engine inventing a third value nobody branched on.
  assert.equal(
    isEngineMessage({
      kind: 'epoch',
      epoch: 2,
      reason: 'progress',
      progress: { pct: 62.4, events: 1, offset: 1, logSize: 1, live: 'tail' }
    }),
    false
  )
})

test('`timeout` IS AN ERROR CODE A CLIENT MINTS, and it is in the one closed set (JOS-518)', () => {
  // A per-request deadline needs a code its caller can branch on, and the type a caller branches on
  // is `ErrorCode`. A second, client-only union beside it would be two spellings of one question —
  // so the member lives here, and the schema's own description says which side sends it.
  const codes = (bundle.$defs as Record<string, { enum: string[] }>).ErrorCode.enum
  assert.ok(codes.includes('timeout'))
  assert.ok(
    isEngineMessage({ kind: 'error', id: 1, ok: false, error: { code: 'timeout', message: 'x' } })
  )
})

test('the fixture token is the shape the app mints, and is nobody’s secret', () => {
  const handshake = fixtures.find((f) => f.name === '05-handshake.json')
  assert.ok(handshake)
  const hello = handshake.messages[0].message as ClientMessage
  assert.equal(hello.op, 'hello')
  assert.ok(isWellFormedToken(hello.token))
  assert.equal(hello.protocolVersion, PROTOCOL_VERSION)
})
