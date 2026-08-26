// ============================================================================
// THE BREADCRUMB VOCABULARY — what a crash report may say it was doing.
// ============================================================================
//
// Split out of `tests/errorReportContract.test.mts` (JOS-501) when it pushed that file past the
// repo's 400-code-line ceiling, and it is a cut on the file's own seam rather than a widened
// threshold — the same answer, for the same reason, that produced
// `tests/errorReportLocation.test.mts`.
//
// WHAT IT GUARDS, and why it is worth a file. The breadcrumb ring is the one part of an error
// report that says what the app was DOING, and it has a producer on one side of the process and a
// contract on the other. JOS-499 moved the producer (the parser left; the engine's cursors
// arrived) and did not move the contract, so `errorReports.ts wireCrumbs` — a FAIL-SAFE filter
// that drops what the contract does not admit — discarded every crumb on every report the deletion
// release shipped. `breadcrumbs: []`, in silence, for a whole release.
//
// The filter is not the bug and must not be made strict: dropping one crumb is much better than
// failing a real crash report. What was missing is a test ABOVE it, comparing what producers emit
// against what the contract admits. That is this file.
//
// No Electron, no network, no fixtures — it reads the engine's Rust sources as text, which is the
// same thing `tests/enginePackaging.test.mts` does with electron-builder.yml. It NEVER SKIPS.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { TELEMETRY_BREADCRUMB_KINDS, isBreadcrumbKind } from '../src/shared/telemetry'
import { ALL_LOG_EVENT_KINDS } from '../src/shared/logEventKinds'

/** The checkout, for the audit that re-reads the engine's own module list. */
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')

test('the breadcrumb vocabulary still CONTAINS the parser kind list — the duplicate cannot rot', () => {
  // It used to be EQUAL to it. Since JOS-501 the wire list is the parser kinds PLUS two families
  // this process actually produces (engine edges, module movement), so containment is the strongest
  // true statement. The parser kinds themselves are historical — nothing in this process emits one
  // since JOS-499 — and are kept so older reports on the backend stay representable.
  const wire = new Set<string>(TELEMETRY_BREADCRUMB_KINDS)
  const missing = [...ALL_LOG_EVENT_KINDS].filter((k) => !wire.has(k))
  assert.deepEqual(
    missing,
    [],
    'shared/telemetry.ts duplicates ALL_LOG_EVENT_KINDS because it may import nothing — keep it a superset'
  )
})

test('EVERY MODULE THE ENGINE FOLDS HAS A BREADCRUMB KIND — the list that was silently missing', () => {
  // THE DEFECT THIS GUARDS, because it shipped and nobody saw it. JOS-499 pointed the breadcrumb
  // ring at the engine's cursors (`serveDeltas.ts` writes `module:<id>`) and reasoned that a module
  // id is a closed vocabulary carrying no log content — which is true — but never added that
  // vocabulary to the WIRE list. `errorReports.ts wireCrumbs` filters against it and DROPS what it
  // does not recognise, so every error report shipped after the deletion release carried
  // `breadcrumbs: []`. The filter is fail-safe on purpose (drop a crumb, never fail a report), which
  // is exactly why the loss was invisible and why it needs a test rather than a reader.
  //
  // THE ORIGINAL IS THE ENGINE'S OWN SOURCE, re-derived here rather than restated: a duplicated
  // list is fine when something compares it against the thing it duplicates.
  const dir = join(ROOT, 'engine', 'crates', 'fold', 'src', 'modules')
  const ids = new Set<string>()
  const walk = (at: string): void => {
    for (const entry of readdirSync(at, { withFileTypes: true })) {
      const p = join(at, entry.name)
      if (entry.isDirectory()) walk(p)
      else if (entry.name.endsWith('.rs')) {
        const src = readFileSync(p, 'utf8')
        for (const m of src.matchAll(/fn\s+id\s*\(\s*&self\s*\)[^{]*\{\s*"([A-Za-z]+)"/g)) {
          ids.add(m[1])
        }
      }
    }
  }
  walk(dir)
  assert.ok(ids.size >= 15, `the audit found only ${String(ids.size)} module ids — the probe broke, not the list`)

  const refused = [...ids].filter((id) => !isBreadcrumbKind(`module:${id}`)).sort()
  assert.deepEqual(
    refused,
    [],
    'a module the engine folds produces a crumb the wire refuses — its cursors would be dropped in silence'
  )
})

test('…AND THE MODULE PATTERN STILL CANNOT CARRY A NAME', () => {
  // The pattern is the only non-enum breadcrumb kind, so it is the only place a log string could
  // ever reach this event. Letters only, 24 max: no space, no separator, no digit, no punctuation.
  for (const bad of [
    'module:Innoruuk`s Chosen',
    'module:Primitive',           // …a plain name IS admitted, and is checked below instead
    'module:loot/../../etc',
    'module:C:\\Users\\jmoye',
    'module:a b',
    'module:with-dash',
    'module:with_underscore',
    'module:has1digit',
    'module:',
    'module:' + 'x'.repeat(25),
    'modulesomething',
    'engine:made-up'
  ]) {
    const admitted = isBreadcrumbKind(bad)
    // A bare capitalised word IS shape-admissible — the bound is a SHAPE bound, and no shape check
    // can tell `Primitive` from a module id. That is stated rather than hidden, and it is why the
    // producer side is typed and closed too (`serveDeltas.ts` passes the engine's own frame id, and
    // `noteEngineEdge` takes a four-member union): the wire is the LAST defence, not the only one.
    if (bad === 'module:Primitive') {
      assert.equal(admitted, true, 'shape cannot distinguish a name from an id — the producer must')
      continue
    }
    assert.equal(admitted, false, `the wire must refuse ${bad}`)
  }
  assert.equal(isBreadcrumbKind('module:observedSpellRanks'), true, 'the longest real id fits')
  assert.equal(isBreadcrumbKind('damage'), true, 'a fixed member is still admitted')
  assert.equal(isBreadcrumbKind('engine:ready'), true, 'and so is an engine edge')
})
