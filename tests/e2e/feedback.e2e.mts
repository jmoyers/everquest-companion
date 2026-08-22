/**
 * Headless Electron integration test for the IN-APP FEEDBACK dialog (Task #65).
 *
 * WHY IT IS AN E2E SPEC AND NOT A UNIT TEST: everything this feature promises is a SEAM.
 *   - "the dialog opens from the nav" crosses App.tsx state, a portal, and MUI's Dialog;
 *   - "Send is gated by the shared validator" crosses the renderer, `src/shared/feedback.ts`
 *     and (later) the ingest Lambda — the whole point is that one function decides for all
 *     three, and only the real app can show that the button and the message agree;
 *   - "the preview shows what would be sent" crosses IPC into the main process, which opens
 *     the REAL, live, growing EverQuest log READ-ONLY, windows it, scrubs it and gzips it.
 *     No fixture can prove that path works against the file that actually exists today.
 *   - "this build cannot send" is a property of the BUILD (`FEEDBACK_API_URL === ''`), which is
 *     exactly the state every build is in until wave F2 deploys the stack.
 *
 * WHAT IT DELIBERATELY DOES NOT DO: submit anything. `EQ_E2E=1` hard-guards `submitFeedback`
 * (§4.5) and this build has no endpoint anyway — the harness must never touch the network or
 * create a row. So Send is asserted as a GATE, never pressed to completion.
 *
 * ON THE SEND BUTTON STAYING DISABLED: in a dark build (`endpointConfigured: false`) Send is
 * disabled no matter how good the draft is, which is the honest thing for a build that cannot
 * send. That means the button alone cannot show the validator flipping, so the validator gate is
 * asserted where it actually speaks: the description field's helper text carries `validateDraft`'s
 * own message while the draft is short, and stops carrying it the moment the draft is valid.
 *
 * Identities only, never today's numbers: the preview is asserted to STATE counts in the app's
 * own vocabulary and to span a window, never to hold N lines.
 *
 * Run: `npm run test:e2e` (or `node --import tsx tests/e2e/feedback.e2e.mts`).
 */
import type { Page } from 'playwright-core'
import {
  buildIfStale,
  check,
  countOf,
  dumpArtifacts,
  failures,
  note,
  reportRun,
  settle
} from './appHarness.mjs'
import { mainWindow } from './appWindow.mjs'
import { launchOnFixture } from './logFixture.mjs'

const DIALOG = '[data-testid="feedback-dialog"]'
const DESCRIPTION = '[data-testid="feedback-description"]'
/** MUI's multiline TextField renders a SECOND, aria-hidden textarea purely to measure rows. */
const DESCRIPTION_INPUT = `${DESCRIPTION} textarea:not([aria-hidden="true"])`
const SEND = '[data-testid="feedback-send"]'
const PREVIEW = '[data-testid="feedback-preview"]'
const PREVIEW_META = '[data-testid="feedback-preview-meta"]'
const INV_META = '[data-testid="feedback-inventory-meta"]'
const INV_PREVIEW = '[data-testid="feedback-inventory-preview"]'
/** The third attachment's own preview (JOS-441) — its own testids, never the inventory's. */
const ACH_META = '[data-testid="feedback-achievements-meta"]'
/** How long main may take to tail + window + scrub + gzip a slice of the real log. */
const SLICE_WAIT_MS = 30_000
/** Reading + gzipping a ~10 KB dump is fast, but it still crosses IPC behind a React effect. */
const DUMP_WAIT_MS = 15_000

function textOf(page: Page, selector: string): Promise<string> {
  return page.evaluate(
    (sel) => (document.querySelector(sel) as HTMLElement | null)?.innerText ?? '',
    selector
  )
}

/** MUI renders a disabled Button as `<button disabled class="… Mui-disabled">`; accept either,
 *  so a styling-only change cannot silently pass the assertion. `null` = not in the DOM. */
function disabledState(page: Page, selector: string): Promise<boolean | null> {
  return page.evaluate((sel) => {
    const btn = document.querySelector(sel)
    if (!btn) return null
    return btn.matches('[disabled]') || btn.classList.contains('Mui-disabled')
  }, selector)
}

/** Type into the description field, replacing whatever is there. */
async function setDescription(page: Page, text: string): Promise<void> {
  const before = await textOf(page, DESCRIPTION)
  await page.fill(DESCRIPTION_INPUT, text)
  // The gate is derived state, not an effect, but MUI's helper text re-renders on the next frame.
  // The CONDITION is that the field's own rendering has caught up with what was typed — its text
  // carries the live `n / max` counter, so any real keystroke changes it.
  await settle(() => textOf(page, DESCRIPTION), (t) => t !== before, { timeoutMs: 8_000 })
}

/** Does `window.eq.triageOps()` resolve in this run? Never throws out of the page. */
function triageReachable(page: Page): Promise<boolean> {
  return page.evaluate(async () => {
    const call = (window as unknown as { eq: Record<string, unknown> }).eq.triageOps
    if (typeof call !== 'function') return false
    try {
      await (call as () => Promise<unknown>)()
      return true
    } catch {
      return false
    }
  })
}

/** What the preload lifted out of `EQ_OWNER_TOOLS` — the renderer's only door to the opt-in. */
function ownerToolsFlag(page: Page): Promise<unknown> {
  return page.evaluate(() => (window as unknown as { eq: Record<string, unknown> }).eq.ownerTools)
}

/**
 * THE STRIP, asserted against a real running app.
 *
 * The owner-only feedback-TRIAGE tab (`src/renderer/src/features/triage/**`) is gated on
 * `DEV_TOOLS`, anchored on `import.meta.env.DEV`, which `electron-vite build` makes a literal
 * `false`. This harness builds exactly that way (`buildIfStale` → `electron-vite build
 * --outDir=out-e2e`), so this run is production-shaped and the nav row must NOT exist. If it
 * appears here, it appears in the installer — and the installer would be shipping a button aimed
 * at the owner's backlog.
 *
 * Absence is asserted on the DOM, not on the bundle: the grep-for-a-marker proof lives beside
 * the build, and this proves the user-visible consequence.
 */
async function stepTriageStripped(page: Page): Promise<void> {
  check(
    'the owner-only Triage tab is STRIPPED from a production-shaped build (no nav row)',
    (await countOf(page, '[data-testid="nav-triage"]')) === 0
  )
  // …and the bridge method the tab would call is a door with nothing behind it. It is still on
  // the preload (channel names are not secrets), but the handler is registered only under
  // `OWNER_TOOLS` — `EQ_OWNER_TOOLS=1` AND not packaged AND not E2E — so under EQ_E2E=1 an
  // invoke must reject.
  const reachable = await triageReachable(page)
  check(
    '…and its IPC handlers are not registered in this build either',
    reachable === false,
    `triage:ops ${reachable ? 'ANSWERED' : 'rejected, as designed'}`
  )
  // JOS-72's default, read where the renderer reads it. An ambient `EQ_OWNER_TOOLS` in whatever
  // shell ran the suite would show up right here rather than silently arming the second launch.
  const flag = await ownerToolsFlag(page)
  check(
    '…and the owner-tools opt-in reads FALSE with nothing set — the default is hidden',
    flag === false,
    `window.eq.ownerTools = ${String(flag)}`
  )
}

/**
 * THE OPT-IN'S POLARITY (JOS-72), and an honest account of what an e2e can prove about it.
 *
 * An absence assertion is the weakest kind — it passes just as happily when the feature was
 * never wired up. The character-sheet spec answers that by launching a second time with
 * `EQ_UNRELEASED=1` and watching the same IPC channel answer. THIS TIER CANNOT DO THAT, BY
 * DESIGN: `ownerToolsEnabled` refuses whenever `EQ_E2E=1`, because the harness must never reach
 * the owner's AWS account, and the renderer half is a compile-time strip no env var can undo.
 * Both refusals below are therefore the assertions, not limitations to work around.
 *
 * What the second launch DOES prove is the piece no unit test can reach: that the preload's
 * runtime read exists and lands on the bridge. `window.eq.ownerTools` flipping to `true` on the
 * SAME bytes is what makes the first launch's `false` a gate rather than a missing field — and a
 * missing field would degrade closed, hiding the owner's tab with no error to grep, which is the
 * exact failure mode this repo has paid for twice.
 */
async function stepOptInPolarity(page: Page): Promise<void> {
  const flag = await ownerToolsFlag(page)
  check(
    'EQ_OWNER_TOOLS=1 reaches the renderer through the preload — the bridge field is real',
    flag === true,
    `window.eq.ownerTools = ${String(flag)}`
  )
  check(
    '…but the nav row STAYS absent: the renderer half is a compile-time strip, not a switch',
    (await countOf(page, '[data-testid="nav-triage"]')) === 0
  )
  const reachable = await triageReachable(page)
  check(
    '…and main STILL refuses to register the handlers, because EQ_E2E outranks the opt-in',
    reachable === false,
    `triage:ops ${reachable ? 'ANSWERED — the harness could reach the owner’s AWS account' : 'rejected, as designed'}`
  )
}

/** The dialog opens from the drawer's footer row, which is an ACTION, not a view. */
async function stepOpen(page: Page): Promise<boolean> {
  await page.click('[data-testid="nav-feedback"]', { timeout: 60_000 })
  await page.waitForSelector(DIALOG, { timeout: 15_000 })
  const open = await countOf(page, DIALOG)
  return check('the feedback dialog opens from the nav drawer footer', open === 1, `${String(open)} dialog(s)`)
}

/**
 * The build-honesty state. Every build before wave F2 has `FEEDBACK_API_URL === ''`, so this is
 * the state the user actually sees today — and it must SAY so rather than letting Send fail.
 */
async function stepDarkBuild(page: Page): Promise<void> {
  const shown = await countOf(page, '[data-testid="feedback-unavailable"]')
  if (shown === 0) {
    note('this build reports an ingest endpoint — the dark-build state is not asserted this run')
    return
  }
  const text = (await textOf(page, '[data-testid="feedback-unavailable"]')).replace(/\s+/g, ' ')
  check(
    'a build with no endpoint says so, in the dialog, before anything is typed',
    /isn’t available in this build|is not available in this build/.test(text),
    text.slice(0, 100)
  )
  check(
    '…and Send stays disabled in that build, however good the draft is',
    (await disabledState(page, SEND)) === true
  )
}

/**
 * The VALIDATOR GATE. `validateDraft` (src/shared/feedback.ts) is the one function the dialog,
 * the main process and the ingest Lambda all run, so its complaint is what the field shows.
 */
async function stepValidatorGate(page: Page): Promise<void> {
  check('Send starts disabled — an empty report is not sendable', (await disabledState(page, SEND)) === true)

  await setDescription(page, 'too short')
  const short = (await textOf(page, DESCRIPTION)).replace(/\s+/g, ' ')
  check(
    'a too-short description is refused by the SHARED validator, in its own words',
    /at least \d+ characters/i.test(short),
    short.slice(0, 110)
  )
  check('…and Send is still disabled', (await disabledState(page, SEND)) === true)

  await setDescription(page, 'The overlay meter goes blank right after I zone into Plane of Sky.')
  const good = (await textOf(page, DESCRIPTION)).replace(/\s+/g, ' ')
  check(
    'a valid description clears the validator’s complaint (the gate is the validator, not a length guess)',
    !/at least \d+ characters/i.test(good) && /\d+ \/ \d+/.test(good),
    good.slice(0, 110)
  )
}

/**
 * Wait for main to hand back a slice for the tailed log; '' when it never did.
 *
 * THE EMPTY STATE IS ALSO THE LOADING STATE, which is why this is not a plain two-way race: the
 * dialog renders "no slice" while main is still tailing, windowing, scrubbing and gzipping the
 * log, so a reader that accepts the first empty it sees concludes there is nothing to send and
 * silently skips every count below (it did — the assertions went to a note the moment a faster
 * gate stopped incidentally waiting out the round trip). A slice ENDS the wait immediately;
 * "nothing to slice" has to hold still for a while before it is believed.
 */
async function waitForPreviewMeta(page: Page): Promise<string> {
  let emptyRun = 0
  const state = await settle(
    async () => {
      const meta = await countOf(page, PREVIEW_META)
      const empty = await countOf(page, '[data-testid="feedback-preview-empty"]')
      emptyRun = meta === 0 && empty > 0 ? emptyRun + 1 : 0
      return { meta, emptyRun }
    },
    (s) => s.meta > 0 || s.emptyRun >= 10,
    { timeoutMs: SLICE_WAIT_MS, pollMs: 200 }
  )
  if (state.meta === 0) return ''
  return (await textOf(page, PREVIEW_META)).replace(/\s+/g, ' ')
}

/**
 * The log attachment. A bug report ticks it BY DEFAULT and shows the slice EXPANDED — a log
 * slice you have to go looking for is not one you have read.
 */
async function stepAttachAndPreview(page: Page): Promise<void> {
  await page.click('[data-testid="feedback-type-bug"]')
  // The tick is what the click is FOR, so waiting for it is waiting for the assertion's subject.
  const readCheck = (): Promise<boolean | null> =>
    page.evaluate(
      () =>
        (document.querySelector('[data-testid="feedback-attach-log"] input') as HTMLInputElement | null)
          ?.checked ?? null
    )
  const checked = await settle(readCheck, (c) => c === true, { timeoutMs: 8_000 })
  check('choosing Bug report ticks "attach my log" by default', checked === true, String(checked))

  const disclosure = (await textOf(page, DIALOG)).replace(/\s+/g, ' ')
  check(
    'the dialog states what survives the scrub, in plain language, before you send',
    disclosure.includes('Chat, tells, group and /who lines are removed'),
    disclosure.includes('Chat, tells') ? 'present' : 'the §5.3 disclosure is missing'
  )

  const meta = await waitForPreviewMeta(page)
  if (!meta) {
    note('main built no slice for the live log this run (no character log, or an empty window) — the preview counts are not asserted')
    return
  }
  // State, never process: lines · span · removed · compressed size. Counts are identities
  // (a real number in the app's own units), never today's totals.
  check(
    'the preview states the slice as COUNTS: lines, the window it spans, what was removed, and its compressed size',
    /[\d,]+ lines/.test(meta) &&
      /\d{1,2}:\d{2}.\d{1,2}:\d{2}/.test(meta) &&
      /[\d,]+ lines removed/.test(meta) &&
      /\d+(\.\d+)? (KB|MB) compressed/.test(meta),
    meta.slice(0, 120)
  )

  const box = await page.evaluate((sel) => {
    const el = document.querySelector(sel) as HTMLElement | null
    if (!el) return null
    const style = getComputedStyle(el)
    return {
      h: Math.round(el.getBoundingClientRect().height),
      scrolls: style.overflowY === 'auto' || style.overflowY === 'scroll',
      rows: el.querySelectorAll('div').length
    }
  }, PREVIEW)
  if (!check('the preview box is rendered', box !== null)) return
  const b = box as { h: number; scrolls: boolean; rows: number }
  // AGENTS.md UI law: a growing list lives in a FIXED-height scroll box. A preview that sized
  // itself to 5,000 lines would push the dialog's own actions off the screen.
  check(
    'the preview is a FIXED-height box that scrolls its own content',
    b.h > 0 && b.h <= 320 && b.scrolls,
    `${String(b.h)}px · overflow ${b.scrolls ? 'auto' : 'visible'}`
  )
  // Windowed through lib/useWindowedRows: only the visible slice is mounted, so a 5,000-line
  // preview costs a screenful of nodes, not 5,000.
  check(
    '…and it is windowed, not fully mounted',
    b.rows > 0 && b.rows < 200,
    `${String(b.rows)} mounted row nodes`
  )
  check('"Save a copy…" is offered — the escape hatch that makes the preview honest', (await countOf(page, '[data-testid="feedback-save-copy"]')) === 1)
}

/**
 * THE INVENTORY ATTACHMENT (JOS-296), asserted in the running app.
 *
 * Why it belongs here and not in a unit test, for the same reasons the slice's step does: the
 * default tick is renderer state, the dump behind it is read by MAIN out of a real EQ install
 * root discovered through `effectiveEqRoot()`, and the two are joined by an IPC handler. The
 * harness stages a REAL committed dump (`Primitive_freeport-Inventory.txt`) into the fake
 * install beside the log, so what the dialog previews is a file the game actually wrote.
 *
 * Identities, never today's numbers: the meta line is asserted to state an AGE, a row count, the
 * file's name and a compressed size — never that it holds 295 rows.
 */
async function stepAttachInventory(page: Page): Promise<void> {
  const readCheck = (): Promise<boolean | null> =>
    page.evaluate(
      () =>
        (document.querySelector('[data-testid="feedback-attach-inventory"] input') as HTMLInputElement | null)
          ?.checked ?? null
    )
  const checked = await settle(readCheck, (c) => c === true, { timeoutMs: 8_000 })
  check(
    'a bug report ticks "attach my inventory export" BY DEFAULT (the owner ruling)',
    checked === true,
    String(checked)
  )

  const dialog = (await textOf(page, DIALOG)).replace(/\s+/g, ' ')
  check(
    'the dialog states what the export is and that nothing is removed from it',
    dialog.includes('Your inventory export is included') && dialog.includes('no chat in it'),
    dialog.includes('Your inventory export is included') ? 'present' : 'the disclosure is missing'
  )

  // The dump is staged, so the preview must resolve. An empty run here would mean main did not
  // find the file the harness planted — which is a failure, not a "not asserted this run".
  const seen = await settle(() => countOf(page, INV_META), (n) => n > 0, {
    timeoutMs: DUMP_WAIT_MS,
    pollMs: 200
  })
  if (!check('main packaged the staged inventory export for preview', seen > 0)) {
    const empty = (await textOf(page, '[data-testid="feedback-inventory-empty"]')).replace(/\s+/g, ' ')
    note(`the dialog said: ${empty.slice(0, 140)}`)
    return
  }

  await stepInventoryPreview(page)
}

/** The preview half of the inventory step — split out because the two halves together are one
 *  function too branchy for the repo's complexity ceiling, not because they are two ideas. */
async function stepInventoryPreview(page: Page): Promise<void> {
  const meta = (await textOf(page, INV_META)).replace(/\s+/g, ' ')
  const states =
    /updated .+ ago|updated just now/.test(meta) &&
    /[\d,]+ rows/.test(meta) &&
    /-Inventory\.txt/.test(meta) &&
    /\d+(\.\d+)? (KB|MB) compressed/.test(meta)
  check(
    'the preview states the export as STATE: how old it is, how many rows, which file, what it costs',
    states,
    meta.slice(0, 140)
  )
  // THE FRESHNESS TRUTH LEADS. It is the fact that turns an export-shaped bug report into an
  // answer, so it is first in the line rather than buried behind two counts.
  check('…and the AGE is the first thing it says', /^updated /.test(meta), meta.slice(0, 60))

  const box = await page.evaluate((sel) => {
    const el = document.querySelector(sel) as HTMLElement | null
    if (!el) return null
    const style = getComputedStyle(el)
    return {
      h: Math.round(el.getBoundingClientRect().height),
      scrolls: style.overflowY === 'auto' || style.overflowY === 'scroll',
      rows: el.querySelectorAll('div').length
    }
  }, INV_PREVIEW)
  if (!check('the export preview box is rendered', box !== null)) return
  const b = box as { h: number; scrolls: boolean; rows: number }
  // Same UI law as the slice's box, and the same box: fixed height, own scroll, windowed rows.
  const windowed = b.h > 0 && b.h <= 320 && b.scrolls && b.rows > 0 && b.rows < 200
  check(
    'the export preview is a FIXED-height box that scrolls its own content, windowed like the slice',
    windowed,
    `${String(b.h)}px · overflow ${b.scrolls ? 'auto' : 'visible'} · ${String(b.rows)} mounted rows`
  )

  // Un-ticking it collapses the whole block — the preview is not a thing you keep reading after
  // deciding not to send it.
  await page.click('[data-testid="feedback-attach-inventory"] input')
  const gone = await settle(() => countOf(page, INV_META), (n) => n === 0, { timeoutMs: 8_000 })
  check('un-ticking the box takes the preview away with it', gone === 0, `${String(gone)} meta line(s)`)
  await page.click('[data-testid="feedback-attach-inventory"] input')
}

/**
 * THE THIRD ATTACHMENT (JOS-441) — its OWN box, its OWN disclosure, its OWN preview.
 *
 * WHY IT IS ASSERTED SEPARATELY AND NOT FOLDED INTO THE STEP ABOVE: consent here is per-FILE, and
 * the failure this guards against is precisely a shared tick. The two exports say different things
 * about a player and carry different disclosures, so a run where ticking one sent the other would
 * be consent to something the user was never shown. Two independent boxes, proved by un-ticking
 * one and watching the other's preview stay.
 *
 * The harness stages the REAL committed dump (`Primitive_freeport-Achievements.txt`) into the fake
 * install beside the inventory one, so what the dialog previews is a file the game actually wrote.
 */
async function stepAttachAchievements(page: Page): Promise<void> {
  const readCheck = (): Promise<boolean | null> =>
    page.evaluate(
      () =>
        (
          document.querySelector(
            '[data-testid="feedback-attach-achievements"] input'
          ) as HTMLInputElement | null
        )?.checked ?? null
    )
  const checked = await settle(readCheck, (c) => c === true, { timeoutMs: 8_000 })
  check(
    'a bug report ticks "attach my achievements export" BY DEFAULT, like its sibling',
    checked === true,
    String(checked)
  )

  const dialog = (await textOf(page, DIALOG)).replace(/\s+/g, ' ')
  check(
    'the dialog states what THIS export is, and that it does not even carry the character name',
    dialog.includes('Your achievements export is included') &&
      dialog.includes('does not even carry your character'),
    dialog.includes('Your achievements export is included') ? 'present' : 'the disclosure is missing'
  )

  const seen = await settle(() => countOf(page, ACH_META), (n) => n > 0, {
    timeoutMs: DUMP_WAIT_MS,
    pollMs: 200
  })
  if (!check('main packaged the staged achievements export for preview', seen > 0)) {
    const empty = (await textOf(page, '[data-testid="feedback-achievements-empty"]')).replace(
      /\s+/g,
      ' '
    )
    note(`the dialog said: ${empty.slice(0, 140)}`)
    return
  }

  const meta = (await textOf(page, ACH_META)).replace(/\s+/g, ' ')
  const states =
    /^updated /.test(meta) &&
    /[\d,]+ rows/.test(meta) &&
    /-Achievements\.txt/.test(meta) &&
    /\d+(\.\d+)? (KB|MB) compressed/.test(meta)
  check(
    'the preview states it in the SAME vocabulary as the inventory one, naming ITS file',
    states,
    meta.slice(0, 140)
  )

  // THE CONSENT IS PER FILE. Un-ticking the achievements box must not disturb the inventory one.
  await page.click('[data-testid="feedback-attach-achievements"] input')
  const gone = await settle(() => countOf(page, ACH_META), (n) => n === 0, { timeoutMs: 8_000 })
  check('un-ticking THIS box takes only its own preview away', gone === 0, `${String(gone)} left`)
  check(
    '…and the inventory export is still attached, because the two ticks are not one tick',
    (await countOf(page, INV_META)) > 0
  )
  await page.click('[data-testid="feedback-attach-achievements"] input')
}

async function main(): Promise<void> {
  buildIfStale()

  console.log('launch: hidden Electron (EQ_E2E=1) against tests/fixtures/e2e-feedback.log…')
  // The install root carries a REAL committed `/outputfile inventory` dump beside the log, so
  // the JOS-296 attachment has something the game actually wrote to package (see
  // stepAttachInventory). The slice half of this spec is unaffected — the dump lives in the
  // install ROOT, the log in `Logs\`.
  const { app, close } = await launchOnFixture('e2e-feedback.log', {
    inventory: 'Primitive_freeport-Inventory.txt',
    // …and the achievements export beside it (JOS-441), for the same reason and in the same root.
    achievements: 'Primitive_freeport-Achievements.txt'
  })

  let page: Page | null = null
  try {
    page = await mainWindow(app)
    const consoleErrors: string[] = []
    page.on('console', (m) => {
      if (m.type() === 'error') consoleErrors.push(m.text())
    })
    page.on('pageerror', (e) => consoleErrors.push(String(e)))

    await page.waitForSelector('[data-testid="nav-feedback"]', { timeout: 60_000 })
    await stepTriageStripped(page)
    if (await stepOpen(page)) {
      await stepDarkBuild(page)
      await stepValidatorGate(page)
      await stepAttachAndPreview(page)
      await stepAttachInventory(page)
      await stepAttachAchievements(page)
    }

    // A missing IPC handler shows up here first (`invoke` rejects into an unhandled rejection),
    // so a clean console is part of what "the dialog works" means.
    check('no renderer console errors', consoleErrors.length === 0, consoleErrors.slice(0, 3).join(' | '))

    if (failures.length) await dumpArtifacts(page, 'feedback-FAIL')
  } finally {
    await close()
  }

  // The SAME build, launched again with the opt-in set — see stepOptInPolarity for what that
  // can and cannot prove. Its own fixture stage, so nothing about the run above is disturbed.
  console.log('launch 2: the same build with EQ_OWNER_TOOLS=1 — the opt-in’s polarity…')
  const second = await launchOnFixture('e2e-feedback.log', { env: { EQ_OWNER_TOOLS: '1' } })
  let opted: Page | null = null
  try {
    opted = await mainWindow(second.app)
    await opted.waitForSelector('[data-testid="nav-feedback"]', { timeout: 60_000 })
    await stepOptInPolarity(opted)
    if (failures.length) await dumpArtifacts(opted, 'feedback-optin-FAIL')
  } finally {
    await second.close()
  }

  reportRun()
}

main().catch((err: unknown) => {
  console.error('e2e: harness error —', err)
  process.exitCode = 1
})
