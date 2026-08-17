// ============================================================================
// copyNoEmDash.test.mts — no em dashes in user-facing copy (JOS-106).
// ============================================================================
//
// THE RULE (owner, 2026-08-08, recorded in AGENTS.md's UI conventions): user-facing copy uses a
// NORMAL dash with spaces (` - `), never U+2014 (—) or U+2013 (–). JOS-106 swept the backlog;
// this suite is what stops it growing back one string at a time.
//
// WHY AN AST AND NOT A GREP. This repo comments HEAVILY and its comments are full of em dashes
// on purpose — a whole-file grep would report hundreds of false positives on prose nobody ever
// sees, and the only way to keep such a test green would be to stop writing comments. So the
// scan parses each file with the TypeScript compiler and looks ONLY at the four node kinds that
// can reach a screen: string literals, template text (head/middle/tail and the no-substitution
// form), and JSX text. Comments, identifiers and regex literals are invisible to it by
// construction, which is the whole reason it can be strict about what it does see.
//
// WHAT IT COVERS
//   * every `.ts`/`.tsx` under `src/renderer/` — views, overlay, tooltips, empty states, the
//     string tables the views read.
//   * every `.ts` under `src/shared/` — including `releaseNotes.ts`, whose HISTORICAL entries
//     render in the What's-new panel exactly like the newest one, so they are copy too.
//   * a NAMED list of `src/main/` modules whose strings travel over IPC and get drawn: the
//     seeded alert copy, the combat engine's session log and label builders, the proc-analytics
//     explanations, the feedback and updater sentences, the sound-import refusal.
//
// WHAT IT DELIBERATELY DOES NOT COVER, and why — a guard that overclaims is worse than a narrow
// one, so these are stated rather than left to be discovered:
//   * COMMENTS, anywhere, including in the files it does scan. Out of scope by owner direction;
//     see the AST note above.
//   * `src/main/` AT LARGE. Most main-process strings are diagnostics: errors.log lines, console
//     forwards, log-format patterns. A directory-wide guard there would be a rule about process
//     logging rather than about copy, so main is covered by the explicit list above and a new
//     main module that starts carrying copy must be ADDED to it. That is a known limit.
//   * `docs/`, `AGENTS.md`, `TELEMETRY.md` and the other repo prose. Not user-facing app copy.
//   * `src/shared/telemetryDoc.ts` and `telemetryDocEvents.ts`, which exist to GENERATE
//     TELEMETRY.md and are pinned against it by `tests/telemetryDoc.test.mts`. They render into
//     a repo doc, never into the app.
//   * `src/main/speech/phonemes.ts`, where U+2014 is a token id in the Kokoro TTS model's
//     phoneme VOCABULARY. Rewriting it would corrupt the mapping; it is data, not prose.
//   * `src/main/presence.ts` was carved out here until JOS-182, for em dashes that sat inside an
//     embedded PowerShell script's own `#` comments. The script is gone and so is the carve-out;
//     the file is now ordinary main-process code covered by the paragraph above.
//   * the three `.html` shells (index/overlay/cursor). Their em dashes are all inside `<!-- -->`
//     and `/* */` comments; they carry no rendered sentences.
//   * the GLYPH AS A DATA PLACEHOLDER is not a special case here — JOS-106 replaced those with
//     `-` (or, where a bare mark read as broken, with a short label: see `UNSTATED_AMOUNT` in
//     renderer/src/features/combat/healRows.ts), so they are held to the same rule.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'

const TEST_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')

/** Directories whose every TS/TSX file is copy or feeds copy. */
const COPY_DIRS = ['src/renderer', 'src/shared'] as const

/** Main-process modules whose strings are drawn by the renderer. See the header's limit note. */
const COPY_FILES = [
  'src/main/store.ts',
  'src/main/combat/ingest.ts',
  'src/main/combat/lifecycle.ts',
  'src/main/combat/procWindows.ts',
  'src/main/combat/segmentViews.ts',
  'src/main/combat/state.ts',
  'src/main/feedback/slice.ts',
  'src/main/feedback/submit.ts',
  'src/main/updater.ts',
  'src/main/userSounds.ts',
  // The tray icon's tooltip and its context menu (JOS-139) — three labels a player reads, in a
  // main-process module. Added here rather than left to the header's "main at large" carve-out,
  // which is exactly what that paragraph asks a new copy-carrying main module to do.
  'src/main/tray.ts'
] as const

/** Excluded with a reason, every one of them spelled out in the header. */
const EXCLUDED = new Set(['src/shared/telemetryDoc.ts', 'src/shared/telemetryDocEvents.ts'])

const BANNED = /[—–]/

/** Every `.ts`/`.tsx` under `dir`, repo-relative, POSIX-separated. */
function sourcesUnder(dir: string): string[] {
  const out: string[] = []
  const walk = (abs: string): void => {
    for (const e of readdirSync(abs, { withFileTypes: true })) {
      const next = join(abs, e.name)
      if (e.isDirectory()) walk(next)
      else if (/\.tsx?$/.test(e.name)) out.push(relative(TEST_ROOT, next).replace(/\\/g, '/'))
    }
  }
  walk(join(TEST_ROOT, dir))
  return out.sort()
}

/** The node kinds that can carry text to a screen. Nothing else is inspected. */
function isCopyNode(kind: ts.SyntaxKind): boolean {
  return (
    kind === ts.SyntaxKind.StringLiteral ||
    kind === ts.SyntaxKind.NoSubstitutionTemplateLiteral ||
    kind === ts.SyntaxKind.TemplateHead ||
    kind === ts.SyntaxKind.TemplateMiddle ||
    kind === ts.SyntaxKind.TemplateTail ||
    kind === ts.SyntaxKind.JsxText
  )
}

/** `file:line  offending text` for every banned dash in a file's copy nodes. */
function offencesIn(rel: string): string[] {
  const src = readFileSync(join(TEST_ROOT, rel), 'utf8')
  if (!BANNED.test(src)) return []
  const sf = ts.createSourceFile(
    rel,
    src,
    ts.ScriptTarget.Latest,
    true,
    rel.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS
  )
  const found: string[] = []
  const visit = (node: ts.Node): void => {
    const text = isCopyNode(node.kind) ? src.slice(node.getStart(sf), node.getEnd()) : ''
    if (BANNED.test(text)) {
      const line = sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1
      found.push(`${rel}:${String(line)}  ${text.replace(/\s+/g, ' ').trim().slice(0, 160)}`)
    }
    ts.forEachChild(node, visit)
  }
  visit(sf)
  return found
}

test('user-facing copy uses normal dashes, never an em dash or an en dash', () => {
  const files = [...COPY_DIRS.flatMap(sourcesUnder), ...COPY_FILES].filter((f) => !EXCLUDED.has(f))
  // A sanity floor: if the walk ever resolves to nothing, an empty result would read as a pass.
  assert.ok(files.length > 200, `the scan found only ${String(files.length)} copy files`)

  const offences = files.flatMap(offencesIn)
  assert.deepEqual(
    offences,
    [],
    `user-facing copy must use ' - ', never U+2014/U+2013 (AGENTS.md, UI conventions):\n${offences.join('\n')}`
  )
})

test('the scan can actually SEE a violation, and ignores one in a comment', () => {
  // A guard that cannot fail is not a guard. Both halves are asserted against the real parser on
  // a synthetic source, so neither the detection nor the comment blindness is taken on trust.
  const sf = ts.createSourceFile(
    'probe.tsx',
    [
      '// a comment — with an em dash, which must be invisible to the scan',
      "const bad = 'copy — with an em dash'",
      'const jsx = <p>text – here</p>',
      "const ok = 'copy - with a normal dash'"
    ].join('\n'),
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TSX
  )
  const hits: number[] = []
  const visit = (node: ts.Node): void => {
    if (isCopyNode(node.kind) && BANNED.test(node.getText(sf))) {
      hits.push(sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1)
    }
    ts.forEachChild(node, visit)
  }
  visit(sf)
  assert.deepEqual(hits, [2, 3], 'the scan must catch the string and the JSX text, and only those')
})

test('the named main-process copy modules all exist', () => {
  // The list above is hand-maintained, so a rename that silently drops a module from the guard
  // fails here rather than going quiet.
  for (const f of COPY_FILES) {
    assert.doesNotThrow(() => readFileSync(join(TEST_ROOT, f), 'utf8'), `${f} is listed but missing`)
  }
})
