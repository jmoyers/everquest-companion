// ============================================================================
// THE ERROR REPORT, END TO END (JOS-100) — steps for tests/e2e/telemetry.e2e.mts.
// ============================================================================
//
// A MODULE RATHER THAN MORE OF THAT SPEC, because adding these steps put it past the repo's
// 400-code-line ceiling and the answer to that here is a split, not a widened threshold. The cut
// is a real seam: everything in this file is about the one event kind whose journey nothing else
// in that spec touches, and the spec keeps its own subject (consent, the bar, the switch, the
// buffer).
//
// WHY THESE ASSERTIONS CANNOT BE UNIT TESTS. Every hop of this feature is a seam:
//
//     window.onerror  →  error:report IPC  →  logError's funnel in main  →  the redactor
//         →  the breadcrumb ring (fed by the ENGINE lifecycle edges and its module cursors)
//         →  the drain onto sessionEnd  →  <userData>/telemetry.json
//
// `tests/errorReportProducer.test.mts` drives the leaves directly and proves their arithmetic;
// only the running app proves they are WIRED to each other. And the read happens AFTER the
// process exits, because the drain rides `sessionEnd` — which is written only when the app quits
// the way a user quits (the `byWindow` launch; see `closeWindows` in the spec).

import type { Page } from 'playwright-core'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { check, note, settle, sleep } from './appHarness.mjs'
import type { FixtureLog } from './logFixture.mjs'
// The SERVER's own validator, run here on the bytes a real launch produced — so this asserts
// "the ingest Lambda would accept this", not "it looks about right".
import { validateTelemetryEvent } from '../../src/shared/telemetryValidate'

/**
 * The marker in the error `stepThrowRendererError` throws ON PURPOSE. The spec's `watch` drops
 * anything carrying it, so it can throw a real uncaught error into a real renderer and still
 * assert that nothing ELSE went wrong — which is the assertion that actually has teeth. Matching
 * one deliberate string beats muting the whole check for one launch.
 */
export const DELIBERATE = 'parseDamage failed on'

/** A damage line out of the staged fixture — a REAL one, with real names and numbers in it. */
function gameplayLine(log: FixtureLog): string | null {
  const lines = readFileSync(log.logPath, 'utf8').split(/\r?\n/)
  return lines.find((l) => / for \d+ points of damage/.test(l)) ?? lines.find((l) => l.length > 40) ?? null
}

/**
 * THROW A REAL RENDERER ERROR, CARRYING A REAL LOG LINE.
 *
 * THE MESSAGE IS A LINE OUT OF THE FIXTURE THE APP IS TAILING — not a hand-written imitation of
 * one — because the claim under test is "no gameplay string reaches the wire", and the only
 * honest way to test that is to hand a real one to the thing that must not publish it. It is
 * also the plausible accident: a parser that throws carrying the line it choked on.
 *
 * It is thrown from a `setTimeout` so it escapes Playwright's evaluate boundary and becomes a
 * genuinely uncaught error the way a real one would, rather than a rejected promise Playwright
 * would hand straight back. That path is `window.onerror` — NOT the ErrorBoundary — so the app
 * stays usable and this step can run last in a launch without disturbing anything before it.
 */
export async function stepThrowRendererError(page: Page, log: FixtureLog): Promise<void> {
  const line = gameplayLine(log)
  if (line === null) {
    check('the staged fixture carries a gameplay line to throw', false, log.logPath)
    return
  }
  await page.evaluate((raw) => {
    setTimeout(() => {
      throw new TypeError(`parseDamage failed on ${raw}`)
    }, 0)
  }, line)
  // There is nothing in the DOM this changes, so there is no condition to settle on: the whole
  // observable consequence is written by the session's CLOSE, and is asserted in
  // `stepErrorReport` against the file that close produced. This short wait exists only so the
  // fire-and-forget IPC lands before the windows are told to shut — one of the two places in
  // this suite where a clock is the honest instrument, because the thing being waited for is a
  // message with no reply.
  await settle(() => page.evaluate(() => document.readyState), (s) => s === 'complete', {
    timeoutMs: 5_000
  }).catch(() => undefined)
  await sleep(500)
  note(`threw a renderer TypeError carrying a real log line: ${line.slice(0, 60)}…`)
}

/** Read the ring the closing session wrote. Same post-exit shape as `stepStartupReading`. */
function ringEvents(userData: string): { ev: Record<string, unknown> }[] | null {
  try {
    const raw = readFileSync(join(userData, 'telemetry.json'), 'utf8')
    return (JSON.parse(raw) as { events?: { ev: Record<string, unknown> }[] }).events ?? []
  } catch (err) {
    check('the error report reached the ring on disk', false, String(err))
    return null
  }
}

/**
 * THE BRIGHT LINE, MEASURED. The message handed to the throw was a real line out of the fixture;
 * not one word of it may appear anywhere in the serialized report.
 *
 * Word-by-word rather than "does it contain the line": a redactor that dropped the timestamp and
 * kept the rest would pass a whole-string comparison and fail this.
 */
function checkNoGameplay(ev: Record<string, unknown>, log: FixtureLog): void {
  const line = gameplayLine(log) ?? ''
  const words = line
    .replace(/^\[[^\]]*\]\s*/, '')
    .split(/[\s.,!']+/)
    .filter((w) => w.length >= 4 && /[A-Za-z]/.test(w))
  const wire = JSON.stringify(ev)
  const leaked = words.filter((w) => wire.includes(w))
  check(
    'NO GAMEPLAY STRING SURVIVES — not a name, not a verb, not an amount',
    leaked.length === 0,
    `leaked ${leaked.slice(0, 5).join(', ')} into ${String(ev.redactedMessage)}`
  )
  check(
    '…because the whole log line collapsed to one placeholder',
    String(ev.redactedMessage).endsWith('<logline>'),
    String(ev.redactedMessage)
  )
}

/** …and the report that throw produced, read off the ring after the process is gone. */
export function stepErrorReport(userData: string, log: FixtureLog): void {
  const events = ringEvents(userData)
  if (events === null) return
  const reports = events.filter((r) => r.ev.t === 'errorReport')
  if (
    !check(
      'a thrown renderer error becomes an errorReport in the ring',
      reports.length >= 1,
      `${String(reports.length)} of ${String(events.length)}: ${[...new Set(events.map((r) => String(r.ev.t)))].join(', ')}`
    )
  ) {
    return
  }
  const ev = reports[0].ev
  const valid = validateTelemetryEvent(ev)
  check(
    '…and it is a report the SERVER would accept — the same validator, on real bytes',
    valid.ok,
    JSON.stringify(valid)
  )
  // THE RING, AND THE WINDOW IT COULD NOT COVER UNTIL JOS-501.
  //
  // This assertion was RED after JOS-499. The parser left this process, so the ring's only
  // producer became the engine's module CURSORS — which cannot fire until an engine is connected,
  // attached and live. This spec throws its error moments after the window comes up, i.e. squarely
  // inside the boot window, where the ring was therefore always empty. So was every real
  // boot-window crash report, which is where the interesting crashes are.
  //
  // The engine's own lifecycle edges feed the ring now (`telemetry/breadcrumbs.ts noteEngineEdge`),
  // and they are the only things that HAPPEN in that window. A closed set — four, and `engine:cycled`
  // since JOS-519 — carrying no log content, no path, no pid; the bright line is unchanged.
  const crumbs = ev.breadcrumbs as { kind: string }[] | undefined
  check(
    '…with breadcrumbs — the engine lifecycle edges that are all a boot-window crash can have',
    Array.isArray(crumbs) && crumbs.length > 0,
    JSON.stringify(crumbs)
  )
  check(
    '…and every one of them is a kind, never content',
    Array.isArray(crumbs) && crumbs.every((c) => /^(engine:[a-z]+|module:[a-zA-Z]+|[a-zA-Z]+)$/.test(c.kind)),
    JSON.stringify(crumbs?.map((c) => c.kind))
  )
  // FRAMES ARE EMPTY IN THIS SPEC, AND THAT IS CORRECT RATHER THAN A GAP — measured, after a
  // version of this step asserted `length > 0` and went red.
  //
  // A throw injected by `page.evaluate` runs in code that was never in the bundle: V8 gives it
  // `at <anonymous>:3:13` and no file at all, so there is nothing for `normalizeFrameFile` to
  // keep. The harness cannot produce an app-frame stack without the app itself throwing, and
  // making it throw on purpose from bundled code would mean shipping a test hook into the
  // product. So the split is deliberate: THIS spec proves the WIRING (a real uncaught renderer
  // error becomes a validated report carrying real breadcrumbs, with the redaction applied),
  // and `tests/errorReportContract.test.mts` proves frame EXTRACTION against real V8 stacks in
  // every root spelling — including `out-e2e/`, which this harness builds into and which folds
  // to `out/` precisely so a real renderer frame under it would survive.
  //
  // What IS asserted here is the property that must hold either way: whatever frames there are,
  // none of them — and nothing else in the report — names a directory on this machine.
  const frames = ev.frames as { file: string }[] | undefined
  check(
    '…and frames that are BUNDLE-relative, never a path on this machine',
    Array.isArray(frames) && frames.every((f) => f.file.startsWith('out/')),
    JSON.stringify(frames)
  )
  const segments = userData.split(/[/\\]/).filter((seg) => seg.length > 2)
  const wire = JSON.stringify(ev)
  const named = segments.filter((seg) => wire.includes(seg))
  check(
    '…and NO segment of this machine’s own userData path appears anywhere in the report',
    named.length === 0,
    `${named.join(', ')} in ${wire.slice(0, 120)}`
  )
  checkNoGameplay(ev, log)
}
