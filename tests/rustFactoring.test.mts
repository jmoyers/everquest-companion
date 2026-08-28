// THE ENGINE'S FACTORING RATCHET (JOS-523) — the counters, and the day it has to say no.
//
// `npm run check:rust-factoring` is CI's engine-lane gate: complexity 12, 400 code lines per file,
// 100 per function over `engine/crates`, frozen at today's debt by `engine/factoring-baseline.json`.
// The bars and the counting rules are argued in `scripts/rustFactoring.mts`'s header.
//
// A ratchet is only worth having if it is red when it should be, so the middle of this file is the
// NEGATIVE proof: a baseline plus a violation that grew past it, asserted red. Everything above it
// is the measurement that red claim rests on — a hand-written Rust sample whose every number was
// counted by a person first, plus the traps that make Rust harder to lex than TypeScript (`'a`
// lifetimes that look like unterminated char literals, `r#"…"#` raw strings, `||` that is a
// closure's empty parameter list rather than an OR).
//
// And the LIVE claim at the bottom: the committed register matches the tree it describes, exactly,
// today — the same thing CI asserts, so a red here and a red there have one cause.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { blankNonCode, complexityOf, measureRustSource } from '../scripts/rustFactoring.mjs'
import {
  BARS,
  BASELINE_PATH,
  ENGINE_DIR,
  compare,
  isClean,
  measureTree,
  readBaseline,
  rustSources,
  writeBaseline,
  type Baseline,
  type Violation,
} from '../scripts/checkRustFactoring.mjs'

// ── the counters ───────────────────────────────────────────────────────────────────────────────

const SAMPLE = `//! A module doc comment. Not code.

use std::fmt;

/// Doc comment above an impl. Not code.
pub struct Clock {
    tz: i32,
}

impl Clock {
    pub fn new(tz: i32) -> Self {
        Clock { tz } // trailing comment, the line is still code
    }

    /* a block comment
       spanning lines */
    pub fn describe(&self, n: u32) -> &'static str {
        let label = "a literal with // in it and a { brace";
        let raw = r#"a raw string with "quotes" and a } brace"#;
        let tick = '}';
        let _ = (label, raw, tick);
        match n {
            0 if self.tz > 0 && n < 9 => "zero",
            1 | 2 => "small",
            _ => "big",
        }
    }
}

fn helper() -> u32 {
    let f = || 7;
    let g = move || 8;
    if f() > 1 || g() > 2 {
        for _ in 0..3 {
            while f() == 0 {}
        }
        loop {
            break;
        }
    }
    f()
}
`

test('comments are erased, literals are not — a literal-only line is still code', () => {
  const blanked = blankNonCode(SAMPLE)
  assert.equal(blanked.includes('module doc comment'), false)
  assert.equal(blanked.includes('block comment'), false)
  assert.equal(blanked.includes('trailing comment'), false)
  // The literal's INSIDES go, its outer characters stay, so the line still reads as code and the
  // `//`, `{` and `}` hiding inside it can never be mistaken for a comment or a brace.
  assert.equal(blanked.includes('a literal with'), false)
  assert.match(blanked, /let label = "\.+";/)
  assert.equal(blanked.split('\n')[0].trim(), '')
})

test('a lifetime is not an unterminated char literal', () => {
  // `&'static str` in the sample: if `'static` were read as an opening quote the rest of the file
  // would be swallowed and no function after it would be found.
  const m = measureRustSource(SAMPLE)
  assert.equal(m.unbalanced, false)
  assert.deepEqual(
    m.functions.map((f) => f.name),
    ['Clock::new', 'Clock::describe', 'helper']
  )
})

test('functions are named by the scope around them, and measured from `fn` to the closing brace', () => {
  const m = measureRustSource(SAMPLE)
  const describe = m.functions[1]
  assert.equal(describe.name, 'Clock::describe')
  // Hand-counted: the signature, four `let` lines, `match n {`, three arms, `}`, `}` = 11. The
  // block comment above it and the blank lines around it are not lines of code.
  assert.equal(describe.lines, 11)
  assert.equal(m.functions[0].lines, 3)
})

test('complexity: arms, keywords and short-circuits count; the wildcard arm and `?` do not', () => {
  const m = measureRustSource(SAMPLE)
  // describe: base 1 + two counted arms (`0 if …`, `1 | 2`; the `_` arm is ESLint's `default:`)
  // + the `if` guard + the `&&` = 5.
  assert.equal(m.functions[1].complexity, 5)
  // helper: base 1 + `if` + `for` + `while` + `loop` + the one real `||` = 6. The two closures —
  // `|| 7` and `move || 8` — are parameter lists, not ORs, and contribute nothing.
  assert.equal(m.functions[2].complexity, 6)
})

test('an empty body is complexity 1, and `?` never adds', () => {
  assert.equal(complexityOf('{}'), 1)
  assert.equal(complexityOf('{ let a = b()?; let c = d()?; Ok(a + c) }'), 1)
})

test('a signature without a body is not a function', () => {
  const m = measureRustSource(`
trait Tick {
    fn tick(&self) -> u32;
    fn tock(&self) -> u32 {
        1
    }
}
`)
  assert.deepEqual(
    m.functions.map((f) => f.name),
    ['Tick::tock']
  )
})

test('two same-named functions in one file get a stable ordinal, never a line number', () => {
  // Line numbers move when the comment waves run; the register must not.
  const m = measureRustSource(`
impl A {
    fn new() -> Self { A }
}
impl B {
    fn new() -> Self { B }
}
mod inner {
    fn new() -> u32 { 1 }
    fn new() -> u32 { 2 }
}
`)
  assert.deepEqual(
    m.functions.map((f) => f.name),
    ['A::new', 'B::new', 'inner::new', 'inner::new#2']
  )
})

test('a nested fn carries its own complexity, and its lines still count toward the outer', () => {
  const m = measureRustSource(`
fn outer(n: u32) -> u32 {
    fn inner(n: u32) -> u32 {
        if n > 1 {
            return 2;
        }
        if n > 0 {
            return 1;
        }
        0
    }
    inner(n)
}
`)
  const outer = m.functions.find((f) => f.name === 'outer')
  const inner = m.functions.find((f) => f.name === 'outer::inner')
  assert.equal(inner?.complexity, 3)
  // The two `if`s belong to `inner`; `outer` is straight-line.
  assert.equal(outer?.complexity, 1)
  // …but they are still lines `outer` is long by, which is ESLint's rule for a nested function.
  assert.equal(outer?.lines, 12)
})

// ── the ratchet says no ────────────────────────────────────────────────────────────────────────

const violation = (over: Partial<Violation> = {}): Violation => ({
  file: 'crates/fold/src/lib.rs',
  metric: 'file-lines',
  name: '',
  value: 1512,
  ...over,
})

const baselineOf = (entries: Violation[]): Baseline => ({ bars: { ...BARS }, entries })

test('THE NEGATIVE PROOF: a baselined violation that GREW turns the gate red', () => {
  const before = baselineOf([violation()])
  const held = compare([violation()], before, [])
  assert.equal(isClean(held), true)

  const grown = compare([violation({ value: 1513 })], before, [])
  assert.equal(isClean(grown), false)
  assert.equal(grown.grown.length, 1)
  assert.equal(grown.grown[0].was, 1512)
  assert.equal(grown.grown[0].now.value, 1513)
  assert.deepEqual(grown.added, [])
})

test('a violation nobody has ever seen turns the gate red', () => {
  const fresh = compare([violation(), violation({ file: 'crates/fold/src/new.rs' })], baselineOf([violation()]), [])
  assert.equal(isClean(fresh), false)
  assert.deepEqual(
    fresh.added.map((v) => v.file),
    ['crates/fold/src/new.rs']
  )
})

test('a function that grew is red on its NAME, so the comment waves cannot move it', () => {
  const fn = violation({ metric: 'complexity', name: 'BuffsModule::on_event', value: 27 })
  assert.equal(isClean(compare([fn], baselineOf([fn]), [])), true)
  assert.equal(isClean(compare([{ ...fn, value: 28 }], baselineOf([fn]), [])), false)
})

test('a violation that SHRANK is red too — the register may not claim debt the code has paid', () => {
  const shrunk = compare([violation({ value: 1400 })], baselineOf([violation()]), [])
  assert.equal(isClean(shrunk), false)
  assert.equal(shrunk.stale.length, 1)
  assert.deepEqual(shrunk.added, [])
  assert.deepEqual(shrunk.grown, [])
})

test('a violation that went away entirely is red for the same reason', () => {
  const gone = compare([], baselineOf([violation()]), [])
  assert.equal(isClean(gone), false)
  assert.equal(gone.stale.length, 1)
})

test('a file the lexer lost the thread on is red rather than quietly measured', () => {
  assert.equal(isClean(compare([], baselineOf([]), ['crates/fold/src/lib.rs'])), false)
  assert.equal(measureRustSource('fn f() { { }').unbalanced, true)
})

test('a register measured against a different bar refuses to be read', () => {
  // A bar change invalidates every number in the file. Silently re-reading it against the new bar
  // would keep entries that are no longer violations and drop ones that now are.
  const dir = mkdtempSync(join(tmpdir(), 'eqc-factoring-'))
  const path = join(dir, 'factoring-baseline.json')
  writeFileSync(path, JSON.stringify({ bars: { ...BARS, complexity: 15 }, entries: [] }), 'utf8')
  assert.throws(() => readBaseline(path), /complexity 15, the bar is now 12/)
  rmSync(dir, { recursive: true, force: true })
})

test('the seeded register round-trips: written, read back, and clean against itself', () => {
  const dir = mkdtempSync(join(tmpdir(), 'eqc-factoring-'))
  const path = join(dir, 'factoring-baseline.json')
  const entries = [violation(), violation({ metric: 'complexity', name: 'f', value: 20 })]
  writeBaseline(path, entries)
  assert.equal(isClean(compare(entries, readBaseline(path), [])), true)
  rmSync(dir, { recursive: true, force: true })
})

// ── the live claim ─────────────────────────────────────────────────────────────────────────────

/**
 * A comment wave, applied to a string: delete every WHOLE-LINE comment, then staple a fat new
 * header on the front. Which lines are whole-line comments comes from the blanked text, so a `//`
 * living inside a string literal is never mistaken for one and never deleted.
 */
function commentWave(src: string): string {
  const blanked = blankNonCode(src).split('\n')
  const kept = src
    .split('\n')
    .filter((line, i) => !(blanked[i].trim() === '' && line.trim() !== ''))
  const header = Array.from({ length: 40 }, () => '//! Another line of prose nobody asked for.')
  return [...header, ...kept, '// and a trailing thought.'].join('\n')
}

test('THE DISJOINTNESS CLAIM: a comment wave over the real engine moves no number', () => {
  // The register was seeded while JOS-524 pruned comments across every engine crate in a parallel
  // worktree. The two are only disjoint if comments genuinely cannot reach these counters, so this
  // asserts it over all 145 real files rather than on a sample: delete every comment line in the
  // engine, add forty more, and every file length, function length and complexity is unchanged.
  let files = 0
  for (const path of rustSources(ENGINE_DIR)) {
    files++
    const src = readFileSync(path, 'utf8')
    const before = measureRustSource(src)
    const after = measureRustSource(commentWave(src))
    const shape = (m: typeof before): string =>
      `${m.lines}|${m.functions.map((f) => `${f.name}:${f.lines}:${f.complexity}`).join(',')}`
    assert.equal(shape(after), shape(before), `a comment pass moved a number in ${path}`)
  }
  assert.ok(files > 100, `expected the whole engine, measured ${files} files`)
})

test('the committed register describes the engine as it stands today', () => {
  const { violations, unreadable } = measureTree(ENGINE_DIR)
  assert.deepEqual(unreadable, [], 'every engine .rs file lexed cleanly')
  const c = compare(violations, readBaseline(BASELINE_PATH), unreadable)
  assert.deepEqual(c.added, [], 'new factoring debt — run the gate for the list')
  assert.deepEqual(c.grown, [], 'a baselined violation grew')
  assert.deepEqual(c.stale, [], 'the register is stale: rerun with --write in this commit')
})
