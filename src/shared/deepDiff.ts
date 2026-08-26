// ============================================================================
// deepDiff.ts — WHERE TWO STRUCTURES STOPPED AGREEING, and what each said there.
// ============================================================================
//
// It was written for the golden oracle (`tests/bench/goldenOracle.mts`, JOS-208's differential
// harness reborn language-neutral) and it lives HERE since JOS-479, because the in-app parity probe
// (`src/main/dataServer/parityProbe.ts`) asks the identical question of the identical pair of
// worlds — one module's published state, folded twice — and the answer to "are these the same?"
// must not have two implementations in one repo. The oracle re-exports it, so every existing caller
// (`tests/bench/rustParity.mts`, `goldenCli`) is unchanged and there is still exactly one walk.
//
// DEEP EQUALITY RATHER THAN A BYTE COMPARE, and the reason is a claim about the fold rather than a
// convenience: a snapshot is assembled on demand out of maps and view builders, so key ORDER is not
// something the engine promises and pinning it would fail a Rust fold for being right in a
// different order. The EVENT STREAM is where emission order IS the claim, and that half is compared
// byte for byte instead (rustParity.mts).
//
// IT REPORTS THE FIRST DISAGREEMENT AND STOPS. A diff tool would list a thousand; a DIAGNOSIS names
// one path and the two values at it, which is what a person reads. Two shapes of report are
// deliberate:
//   * an array whose LENGTH differs reports `.length` and does not walk — "the buffs module
//     published 41 actives where the other has 40" is a diagnosis; the first index that happens to
//     differ afterwards is noise;
//   * a key present on one side only reports that key with `undefined` on the absent side, in both
//     directions, so a field one world grew is as visible as a field the other lost.
//
// PURE, AND WITH NO IMPORTS ON PURPOSE. It is loaded by the Electron main process, by `node:test`
// units and by a bench that runs outside Electron.

/** What {@link firstDiff} hands back: where two structures stopped agreeing, and what each said. */
export interface Diff {
  /** Dotted path from the root the caller named — `.modules[7].snapshot.state.rows[3].display`. */
  path: string
  expected: unknown
  actual: unknown
}

/**
 * The first structural disagreement between two parsed JSON values, with its dotted path, or null
 * when they are deep-equal.
 *
 * `path` is the caller's root and is conventionally `''`, which is why every path this returns
 * opens with a dot.
 */
export function firstDiff(a: unknown, b: unknown, path: string): Diff | null {
  if (a === b) return null
  if (Array.isArray(a) || Array.isArray(b)) return arrayDiff(a, b, path)
  if (a !== null && b !== null && typeof a === 'object' && typeof b === 'object') {
    return objectDiff(a as Record<string, unknown>, b as Record<string, unknown>, path)
  }
  return { path, expected: a, actual: b }
}

function arrayDiff(a: unknown, b: unknown, path: string): Diff | null {
  if (!Array.isArray(a) || !Array.isArray(b)) return { path, expected: a, actual: b }
  // LENGTH FIRST, and reported as its own path — see the header.
  if (a.length !== b.length) return { path: `${path}.length`, expected: a.length, actual: b.length }
  for (let i = 0; i < a.length; i++) {
    const d = firstDiff(a[i], b[i], `${path}[${String(i)}]`)
    if (d) return d
  }
  return null
}

function objectDiff(a: Record<string, unknown>, b: Record<string, unknown>, path: string): Diff | null {
  const rest = new Set(Object.keys(b))
  for (const k of Object.keys(a)) {
    if (!rest.has(k)) return { path: `${path}.${k}`, expected: a[k], actual: undefined }
    const d = firstDiff(a[k], b[k], `${path}.${k}`)
    if (d) return d
    rest.delete(k)
  }
  // Whatever `b` has that `a` never mentioned — a field the other side grew.
  for (const k of rest) return { path: `${path}.${k}`, expected: undefined, actual: b[k] }
  return null
}
