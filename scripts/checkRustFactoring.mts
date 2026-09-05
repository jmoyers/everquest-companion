/**
 * checkRustFactoring.mts — THE ENGINE'S FACTORING RATCHET (JOS-523). `npm run check:rust-factoring`.
 *
 * The TypeScript half of this tree has had hard factoring limits since 2026-08-03 — complexity 12,
 * 400 code lines per file, 100 per function — enforced by ESLint and frozen at today's debt by
 * `eslint.ratchet.mjs`. The engine had nothing playing that role: stock clippy has no lint that can
 * express a FILE length, and every lint that comes close is allow-by-default with an in-source
 * `#[allow]` as its only escape hatch. So the gate is this script, and the debt register is
 * `engine/factoring-baseline.json`.
 *
 * SAME NUMBERS, SAME COUNTING. The bars are `eslint.config.mjs`'s FACTORING_RULES verbatim — read
 * that header for why each one is what it is. How they are counted on Rust is documented in
 * `scripts/rustFactoring.mts`; the one-line version is that comments and blanks never count, so the
 * comment-pruning waves cannot move a single number here.
 *
 * ── THE RATCHET ONLY SHRINKS ──────────────────────────────────────────────────────────────────
 *
 *   * A NEW violation, or an existing one that GREW, is red. That is the whole point.
 *   * A violation that SHRANK or went away is ALSO red — with `--write` as the fix, in the same
 *     commit. This mirrors ESLint's `reportUnusedDisableDirectives`: a register that claims debt
 *     the code no longer owes is a lie about the code, and letting it rot leaves headroom for the
 *     next growth to hide in.
 *   * `--write` REFUSES while anything is new or grown. Widening the register is the integrator's
 *     call and is made by editing the JSON by hand, never by re-running a tool until it is green.
 *   * `--seed` rewrites the register wholesale, growth and all. It is the twin of `npm run
 *     lint:ratchet` and carries the same warning: it exists to SEED the file and to re-baseline
 *     after a deliberate bar change. Running it on red code silently widens the register and
 *     defeats the entire design. It is deliberately not an npm script — you have to mean it.
 *   * The engine's refactor wave (JOS-525) empties this file. Entries are deleted by making them
 *     untrue, not by deleting the line.
 */
import { readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { measureRustSource } from './rustFactoring.mjs'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
export const ENGINE_DIR = join(ROOT, 'engine')
export const BASELINE_PATH = join(ENGINE_DIR, 'factoring-baseline.json')

/** Verbatim from `eslint.config.mjs`'s FACTORING_RULES. Changing one means re-running that file's
 *  measurement (`npm run lint:measure`) on BOTH languages, not editing a number here. */
export const BARS = { 'file-lines': 400, 'function-lines': 100, complexity: 12 } as const
export type Metric = keyof typeof BARS

export interface Violation {
  /** Slash-separated and relative to `engine/`, so the register reads the same on every machine. */
  file: string
  metric: Metric
  /** The qualified function name, or `''` for the whole-file metric. */
  name: string
  value: number
}

export interface Baseline {
  bars: Record<string, number>
  entries: Violation[]
}

export interface Comparison {
  added: Violation[]
  grown: { now: Violation; was: number }[]
  stale: Violation[]
  unreadable: string[]
}

const keyOf = (v: Pick<Violation, 'file' | 'metric' | 'name'>): string =>
  `${v.file}\u0000${v.metric}\u0000${v.name}`

const order = (a: Violation, b: Violation): number =>
  a.file.localeCompare(b.file) || a.metric.localeCompare(b.metric) || a.name.localeCompare(b.name)

// ── what gets measured ─────────────────────────────────────────────────────────────────────────

/**
 * Every `.rs` the ratchet has an opinion about. `target` is cargo's; a `tests` directory is a
 * crate's integration suite; `generated.rs` is written by `npm run gen:protocol` and nobody edits
 * it. The rest is code a person wrote.
 */
export function rustSources(engineDir: string): string[] {
  const found: string[] = []
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name)
      if (entry.isDirectory() && entry.name !== 'target' && entry.name !== 'tests') walk(full)
      else if (entry.isFile() && entry.name.endsWith('.rs') && entry.name !== 'generated.rs')
        found.push(full)
    }
  }
  walk(join(engineDir, 'crates'))
  return found.sort((a, b) => a.localeCompare(b))
}

/** Measure the tree. `unreadable` names files the lexer lost the thread on — see RustFileMetrics. */
export function measureTree(engineDir: string): { violations: Violation[]; unreadable: string[] } {
  const violations: Violation[] = []
  const unreadable: string[] = []
  for (const path of rustSources(engineDir)) {
    const file = relative(engineDir, path).split('\\').join('/')
    const m = measureRustSource(readFileSync(path, 'utf8'))
    if (m.unbalanced) unreadable.push(file)
    if (m.lines > BARS['file-lines'])
      violations.push({ file, metric: 'file-lines', name: '', value: m.lines })
    for (const fn of m.functions) {
      if (fn.lines > BARS['function-lines'])
        violations.push({ file, metric: 'function-lines', name: fn.name, value: fn.lines })
      if (fn.complexity > BARS.complexity)
        violations.push({ file, metric: 'complexity', name: fn.name, value: fn.complexity })
    }
  }
  return { violations: violations.sort(order), unreadable }
}

// ── the ratchet ────────────────────────────────────────────────────────────────────────────────

export function compare(now: Violation[], baseline: Baseline, unreadable: string[]): Comparison {
  const before = new Map(baseline.entries.map((e) => [keyOf(e), e]))
  const out: Comparison = { added: [], grown: [], stale: [], unreadable }
  const live = new Set<string>()
  for (const v of now) {
    live.add(keyOf(v))
    const prev = before.get(keyOf(v))
    if (prev === undefined) out.added.push(v)
    else if (v.value > prev.value) out.grown.push({ now: v, was: prev.value })
    else if (v.value < prev.value) out.stale.push(prev)
  }
  for (const e of baseline.entries) if (!live.has(keyOf(e))) out.stale.push(e)
  return out
}

export const isClean = (c: Comparison): boolean =>
  c.added.length === 0 && c.grown.length === 0 && c.stale.length === 0 && c.unreadable.length === 0

export function readBaseline(path: string): Baseline {
  const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'))
  const b = parsed as Baseline
  for (const [metric, bar] of Object.entries(BARS))
    if (b.bars[metric] !== bar)
      throw new Error(
        `${path} was measured against ${metric} ${String(b.bars[metric])}, the bar is now ` +
          `${String(bar)}. A bar change means re-baselining the whole register on purpose.`
      )
  return b
}

const PREAMBLE = [
  'GENERATED debt register — engine factoring ratchet (JOS-523). IT ONLY SHRINKS.',
  'Every entry is a file or function that breaks a bar TODAY. Fix one and the gate says so;',
  'rerun `npm run check:rust-factoring -- --write` in the SAME commit to record the shrink.',
  'Adding or widening an entry is the integrator call, made by hand. Never by re-running a tool.',
]

export function writeBaseline(path: string, violations: Violation[]): void {
  const body = {
    $comment: PREAMBLE,
    bars: { ...BARS },
    entries: violations,
  }
  writeFileSync(path, `${JSON.stringify(body, null, 2)}\n`, 'utf8')
}

// ── the report ─────────────────────────────────────────────────────────────────────────────────

const label = (v: Violation): string =>
  v.name === '' ? `${v.file} (whole file)` : `${v.file} — ${v.name}`

function report(c: Comparison): string[] {
  const lines: string[] = []
  for (const f of c.unreadable) lines.push(`  UNREADABLE  ${f} — braces never balanced`)
  for (const v of c.added) lines.push(`  NEW    ${v.metric} ${String(v.value)}  ${label(v)}`)
  for (const g of c.grown)
    lines.push(
      `  GREW   ${g.now.metric} ${String(g.was)} → ${String(g.now.value)}  ${label(g.now)}`
    )
  for (const v of c.stale) lines.push(`  FIXED  ${v.metric} was ${String(v.value)}  ${label(v)}`)
  return lines
}

function main(): void {
  const write = process.argv.includes('--write')
  const { violations, unreadable } = measureTree(ENGINE_DIR)
  if (process.argv.includes('--seed')) {
    writeBaseline(BASELINE_PATH, violations)
    console.log(`rust factoring: SEEDED with ${String(violations.length)} violations.`)
    return
  }
  const comparison = compare(violations, readBaseline(BASELINE_PATH), unreadable)
  if (isClean(comparison)) {
    console.log(
      `rust factoring: green — ${String(violations.length)} baselined violations, none new, none grown.`
    )
    return
  }
  console.log(report(comparison).join('\n'))
  const blocked = comparison.added.length + comparison.grown.length + comparison.unreadable.length
  if (write && blocked === 0) {
    writeBaseline(BASELINE_PATH, violations)
    console.log(`rust factoring: baseline shrunk to ${String(violations.length)} violations.`)
    return
  }
  console.log(
    write
      ? '\nrust factoring: REFUSING to write — the register may only shrink, and this run grew it.'
      : '\nrust factoring: RED. Shrinks are recorded with `npm run check:rust-factoring -- --write`.'
  )
  process.exitCode = 1
}

if ((process.argv[1] ?? '').endsWith('checkRustFactoring.mts')) main()
