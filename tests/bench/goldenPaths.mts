// ============================================================================
// goldenPaths.mts — WHERE THE GOLDENS LIVE, AND HOW THEY ARE SPELLED (JOS-499 item 5).
// ============================================================================
//
// This is the half of `goldenOracle.mts` that describes the ARTIFACTS rather than the fold that
// produces them: the two fixture directories, the slice manifest, the per-slice file names, and
// the one normalization both sides of a comparison have to agree on.
//
// ── WHY IT IS ITS OWN FILE NOW ─────────────────────────────────────────────────────────────────
//
// `goldenOracle.mts` imports the TypeScript fold (`foldArm.mjs`, the parser, the replay slicer,
// the combat engine, the module registry) because RECORDING a golden means running that fold.
// All of it is deleted in this release. `rustParity.mts` imports none of it — it compares the
// ENGINE against goldens already on disk — but it reached those artifacts through `goldenOracle`
// and so inherited the whole doomed import graph transitively.
//
// Owner ruling 26 is what makes the split worth doing rather than deleting both: **the goldens
// outlive the TS fold as a ONE-RELEASE SAFETY NET.** The goldens were re-recorded on the commit
// before the deletion; `oracle:rust-parser` and `oracle:rust-fold` go on gating this release and
// phase-4 stabilization against those recorded bytes, and retire when the engine's own CI budgets
// land. `oracle:record` and `oracle:check` — the two that RUN the TS fold — die with it. So the
// recorded artifacts need a home that does not know how they were made, and this is it.
//
// NOTHING HERE IMPORTS A FOLD, AND NOTHING HERE MAY. That is the file's whole contract: if a
// future edit needs the parser or a module to answer a question, the question belongs in
// `goldenOracle.mts` (while it exists) or in the Rust harness, never here.
//
// ── THE RECORDED ABSOLUTE PATH IS A KNOWN WART, AND IT IS DOCUMENTED RATHER THAN NORMALIZED ────
//
// A golden's `character.logPath` records the RECORDING CHECKOUT's absolute path to the slice. The
// JOS-497 wave hit this: a worktree whose fixtures are junctioned in fails the comparison on that
// field alone, because the junction spells the same bytes under a different absolute path. The
// remedy in force is the one that ticket found and this file states so the next reader does not
// re-derive it: pass `--slices=` and `--goldens=` at the REAL directories rather than linking them
// in. Normalizing the field was considered and NOT done — it is the one field that says which file
// on which machine a golden describes, and a harness that silently accepted a golden recorded
// against a different log would be a safety net with a hole in exactly the shape of the mistake it
// exists to catch.

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { ROOT } from '../e2e/build.mjs'

export interface SliceRef {
  name: string
  file: string
  path: string
}

export const SLICES_DIR = join(ROOT, 'tests', 'bench', 'fixtures', 'slices')
export const GOLDENS_DIR = join(ROOT, 'tests', 'bench', 'fixtures', 'goldens')

/** Every slice the manifest declares, in manifest order. Throws if the corpus is absent — the
 *  slices are gitignored by design, so "no goldens" and "no input" must not look alike. */
export function readSlices(): SliceRef[] {
  const manifest = join(SLICES_DIR, 'manifest.json')
  const raw = JSON.parse(readFileSync(manifest, 'utf8')) as {
    slices: { name: string; file: string }[]
  }
  return raw.slices.map((s) => ({ name: s.name, file: s.file, path: join(SLICES_DIR, s.file) }))
}

/**
 * The character the slice was cut from, DERIVED FROM THE FILENAME —
 * `eqlog_<Name>_<server>.<slice>.txt`. The self-`/who` rule and the pet-leader carve-out both
 * need the same name the app would install, and hardcoding it here would make the corpus and
 * the harness able to drift apart silently.
 */
export function characterOf(slice: SliceRef): { name: string; server: string; logPath: string } {
  const m = /^eqlog_(.+?)_([^_]+?)\.[^.]+\.txt$/i.exec(slice.file)
  if (!m) throw new Error(`goldenPaths: cannot read a character out of "${slice.file}"`)
  return { name: m[1], server: m[2], logPath: slice.path }
}

/**
 * The artifact paths. `dir` defaults to the real goldens directory and is overridden by callers
 * that run against a corpus somewhere else — the worktree flag path above, and (while it existed)
 * the record/check round-trip test over a COMMITTED fixture in a temp dir. The corpus location is
 * never baked in, because a machine that has never seen the owner's slices has to be able to run
 * what it can.
 */
export const eventsPath = (name: string, dir = GOLDENS_DIR): string => join(dir, `${name}.events.ndjson`)
export const snapshotsPath = (name: string, dir = GOLDENS_DIR): string => join(dir, `${name}.snapshots.json`)

/**
 * THE ONE NORMALIZATION BOTH SIDES OF A COMPARISON APPLY.
 *
 * `updatedAt` — and ONLY `updatedAt` — is dropped, on `tests/replayChunking.test.mts`'s precedent:
 * the message-overlay miner stamps it when the SNAPSHOT is taken, so it is a statement about the
 * reader rather than about what was folded. Every other field is compared verbatim, which is the
 * point — a golden that quietly forgave a second field would forgive the divergence it exists to
 * find.
 *
 * IT LIVES HERE BECAUSE BOTH HARNESSES NEED IT and only one of them has a fold. `rustParity.mts`
 * applies it to the ENGINE's answer and to the golden alike; a normalization that lived with the
 * recorder would have left the reader guessing at it.
 */
export function normalizeJson(value: unknown): string {
  return JSON.stringify(value, (key, v: unknown) => (key === 'updatedAt' ? undefined : v))
}
