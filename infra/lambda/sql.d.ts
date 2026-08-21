/**
 * `*.sql` as a module — esbuild's `text` loader, declared for TypeScript.
 *
 * ONE IMPORTER AND ONE REASON (JOS-398). `infra/lambda/export.ts` puts a `schemaRevision` in every
 * export manifest — the statement count of `infra/schema.sql`, which is what answers "was this
 * copy taken from the shape the code expects" during a restore. A Lambda cannot read the repo at
 * run time, so the file travels INSIDE the bundle: `infra/build.mjs` maps `.sql` to the `text`
 * loader and esbuild inlines it as a string.
 *
 * The useful side effect is that a schema change moves the export bundle's `source_code_hash` and
 * therefore redeploys it, which is exactly right — the revision number must track the file.
 */
declare module '*.sql' {
  const content: string
  export default content
}
