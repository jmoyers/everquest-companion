// protocolCodegen.mts — the TypeScript half of `npm run gen:protocol`.
//
// It is a MODULE, not an entry point, for the same reason `src/shared/telemetryDoc.ts` is: the
// staleness suite has to be able to render a fresh artifact in memory and compare it to the
// committed bytes, and a renderer that only exists inside a script can never be checked. The
// entry point (`scripts/gen-protocol.mts`) does the writing and drives the Rust half.

import { compile } from 'json-schema-to-typescript'
import type { JSONSchema } from 'json-schema-to-typescript'
import {
  bundleSchema,
  digestLine,
  protocolVersion,
  readSchemaFiles,
  schemaDigest
} from './protocolSchema.mjs'

/** The header both generated files carry. `header` is spelled per language by the caller. */
export function generatedBanner(digest: string, comment: string): string {
  const lines = [
    'GENERATED FILE - DO NOT EDIT.',
    '',
    'Generated from protocol/schema/*.schema.json by `npm run gen:protocol`.',
    'Edit the schema, run the generator, commit both sides.',
    '',
    'Neither language is privileged: this file and its Rust twin',
    '(engine/crates/protocol/src/generated.rs) come from the same neutral JSON Schema, and a',
    'schema edit that lands without regenerating turns tests/protocolSchema.test.mts red on the',
    'TypeScript side and the protocol-codegen staleness test red on the Rust side.',
    '',
    digestLine(digest)
  ]
  return lines.map((l) => (l === '' ? comment.trimEnd() : `${comment}${l}`)).join('\n')
}

/**
 * json-schema-to-typescript stamps a two-line provenance note into the doc comment of every type
 * it reached through a `$ref` ("This interface was referenced by X's JSON-Schema via the
 * definition Y"). In a bundle that is nothing but `$defs`, that is EVERY type — roughly a third of
 * the committed artifact restating the same fact, in front of the prose that actually says what
 * each message is for. The banner at the top of the file already says where the whole thing came
 * from, so the notes are stripped here rather than read past forever.
 *
 * Two shapes: the note as the tail of a real doc comment (drop the note, keep the prose), and the
 * note as an entire doc comment on a type whose schema carried no description (drop the comment).
 * The suite asserts the phrase is absent from the committed file, so a generator upgrade that
 * changes the wording is caught rather than silently reintroducing the noise.
 */
export function stripProvenanceNotes(ts: string): string {
  return ts
    .replace(
      /^\/\*\*\n \* This interface was referenced by [^\n]*\n \* via the `definition` "[^"]*"\.\n \*\/\n/gm,
      ''
    )
    .replace(/\n \*\n \* This interface was referenced by [^\n]*\n \* via the `definition` "[^"]*"\./g, '')
}

/**
 * The committed TypeScript artifact, rendered.
 *
 * `unreachableDefinitions` is ON because the bundle is nothing BUT definitions: it carries no root
 * type at all (see `bundleSchema`), so without this flag json-schema-to-typescript would emit an
 * empty file. `additionalProperties: false` matches what every object in the schema already says
 * and keeps the generator from adding an index signature to types that closed themselves.
 */
export async function renderTypeScript(): Promise<string> {
  const files = readSchemaFiles()
  const bundle = bundleSchema(files) as JSONSchema
  const version = protocolVersion(files)
  const body = await compile(bundle, 'Protocol', {
    bannerComment: '',
    unreachableDefinitions: true,
    additionalProperties: false,
    declareExternallyReferenced: true,
    enableConstEnums: false,
    format: true,
    style: { semi: false, singleQuote: true, printWidth: 100 }
  })
  const clean = stripProvenanceNotes(body).trimEnd()
  const banner = generatedBanner(schemaDigest(files), '// ')
  const tail = [
    '/**',
    ' * THE WIRE VERSION. A single integer, bumped on any breaking change. A client presents it in',
    ' * `Hello.protocolVersion`; the engine answers with its own in `HelloReply.protocolVersion`. A',
    ' * mismatch is FATAL by ruling - both sides log and the connection closes. Version skew is a',
    ' * build error, not a runtime state to recover from, because both sides generate from this one',
    ' * artifact.',
    ' */',
    `export const PROTOCOL_VERSION = ${String(version)}`,
    ''
  ].join('\n')
  return `${banner}\n\n${clean}\n\n${tail}`
}
