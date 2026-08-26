/**
 * ============================================================================
 * parityLedger.mts — WHAT A PARTIAL PORT IS ALLOWED TO CLAIM (JOS-477).
 * ============================================================================
 *
 * `goldenOracle.mts firstDiff` answers "are these the same?", and it is the right instrument for a
 * bar that is binary: phase 1 and every module of phase 2 are green or they are not, and the first
 * place two structures stopped agreeing is the whole diagnosis.
 *
 * THE COMBAT ENGINE IS NOT THAT SHAPE. It is ~33 files and 12,400 lines of TypeScript, the largest
 * surface in the JOS-459 program, and it will be RED for several shifts before it is green. Over
 * that stretch "it diverged at `.combat.selected`" is true on the first shift and true on the
 * fifth, and it says nothing about whether the fourth shift moved anything. The only honest
 * progress report is a COUNT: how many leaves agreed, how many diverged, and — grouped by CLASS —
 * where.
 *
 * So this file walks BOTH structures to the end and buckets every disagreement by its dotted path
 * with the array indices erased: `.combat.segments[0].total` and `.combat.segments[41].total` are
 * ONE class, `.combat.segments[].total`, counted twice. A class is a piece of work; a leaf is an
 * instance of it.
 *
 * ── IT IS NOT A SECOND BAR, AND IT CANNOT TURN A RED RUN GREEN ────────────────────────────────
 *
 * `rustParity.mts` decides the exit code from whether anything diverged at all, exactly as it did
 * before this file existed. The ledger only changes what gets PRINTED about a run that has already
 * failed. A count that could be quoted as an acceptance result would be precisely the silent cap
 * the no-silent-caps law exists to refuse — "94% of leaves agree" is a measurement, and "the fold
 * agrees" is a different sentence.
 *
 * ── NOTHING FROM A SLICE LEAVES THE MACHINE ───────────────────────────────────────────────────
 *
 * The slices are the owner's real game log. `rustParity.mts`'s standing rule is that a divergence
 * report prints ONE diverging pair and never an export; the ledger keeps it per BUCKET rather than
 * per run, and the reporter caps both the number of classes named and the length of each example.
 */
// THE DIFF TYPE, FROM ITS OWN HOME (JOS-499 item 5). It used to come through goldenOracle.mjs,
// which imports the TS fold; this file is part of the engine-vs-goldens safety net ruling 26 keeps
// alive for one release, and it must not inherit the recorder's graph.
import type { Diff } from '../../src/shared/deepDiff'

/** One bucket: a CLASS of disagreement and how often it occurred. */
export interface LedgerClass {
  /** The dotted path with every array index erased — `.combat.segments[].total`. */
  path: string
  count: number
  /** The first worked example in this class, with its real (indexed) path. */
  example: Diff
}

/** The whole walk's result: what agreed, what did not, and the classes it fell into. */
export interface Ledger {
  /** Scalar comparisons made — the denominator of the agreement rate. */
  leaves: number
  agreed: number
  classes: LedgerClass[]
}

/** The walk's accumulators, bundled so the recursion carries one parameter instead of three. */
interface Walk {
  into: Map<string, LedgerClass>
  leaves: number
  agreed: number
}

/** A path with its array indices erased — what makes a bucket a CLASS rather than a leaf. */
const classOf = (path: string): string => path.replace(/\[\d+\]/g, '[]')

/** Record one divergence into its class, minting the class on first sight. */
function record(w: Walk, path: string, expected: unknown, actual: unknown): void {
  w.leaves += 1
  const key = classOf(path)
  const hit = w.into.get(key)
  if (hit) hit.count += 1
  else w.into.set(key, { path: key, count: 1, example: { path, expected, actual } })
}

/**
 * A LENGTH MISMATCH IS RECORDED *AND* DESCENDED, which is the one place this deliberately does
 * more work than `firstDiff`. Over there `.length` is reported and the walk stops, because "41
 * actives where the golden has 40" is a diagnosis on its own. Here the common prefix is still
 * walked: an array short by one and wrong in four places is a different report from one short by
 * one and right everywhere it reaches, and only the walk can tell them apart.
 */
function walkArray(a: unknown[], b: unknown[], path: string, w: Walk): void {
  if (a.length !== b.length) record(w, `${path}.length`, a.length, b.length)
  const n = Math.min(a.length, b.length)
  for (let i = 0; i < n; i++) walkDiffs(a[i], b[i], `${path}[${String(i)}]`, w)
}

/**
 * A MISSING KEY IS A LEAF, NOT A SUBTREE. When one side has an object where the other has nothing,
 * that is ONE divergence at that path — not one per field underneath it. Counting the subtree would
 * let a single absent `selected` object contribute thousands of entries and drown every other class
 * in the ledger, which would make the instrument useless exactly when the gap is largest.
 */
function walkObject(a: Record<string, unknown>, b: Record<string, unknown>, path: string, w: Walk): void {
  const rest = new Set(Object.keys(b))
  for (const k of Object.keys(a)) {
    if (!rest.has(k)) {
      record(w, `${path}.${k}`, a[k], undefined)
      continue
    }
    rest.delete(k)
    walkDiffs(a[k], b[k], `${path}.${k}`, w)
  }
  // Whatever the RUST side grew that the golden never mentioned. An extra field is a divergence in
  // exactly the way a missing one is: the golden was recorded through `JSON.stringify`, so a key it
  // does not carry is a key the TS wrote as `undefined`, and writing `null` there instead is the
  // first trap the fold README names.
  for (const k of rest) record(w, `${path}.${k}`, undefined, b[k])
}

/** True when both sides are plain objects — the only case that descends by key. */
function bothPlainObjects(a: unknown, b: unknown): boolean {
  if (a === null || b === null) return false
  if (typeof a !== 'object' || typeof b !== 'object') return false
  return !Array.isArray(a) && !Array.isArray(b)
}

/** `expected` is the GOLDEN and `actual` is the RUST side, in that order, everywhere. */
function walkDiffs(a: unknown, b: unknown, path: string, w: Walk): void {
  if (a === b) {
    w.leaves += 1
    w.agreed += 1
    return
  }
  if (Array.isArray(a) && Array.isArray(b)) {
    walkArray(a, b, path, w)
    return
  }
  if (bothPlainObjects(a, b)) {
    walkObject(a as Record<string, unknown>, b as Record<string, unknown>, path, w)
    return
  }
  record(w, path, a, b)
}

/** Build the ledger for one pair of structures, classes sorted by count (largest first, then by
 *  path so a re-run of the same pair prints the same order). */
export function buildLedger(want: unknown, got: unknown): Ledger {
  const w: Walk = { into: new Map(), leaves: 0, agreed: 0 }
  walkDiffs(want, got, '', w)
  const classes = [...w.into.values()].sort((x, y) => y.count - x.count || x.path.localeCompare(y.path))
  return { leaves: w.leaves, agreed: w.agreed, classes }
}
