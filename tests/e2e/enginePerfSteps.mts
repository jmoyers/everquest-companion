/**
 * THE ENGINE SECTION OF THE PERFORMANCE PANEL, in the running app (JOS-483, owner ruling 19).
 *
 * > "i want to see the server in the cpu/performance overlay in app." — owner.
 *
 * Its own module for `perfProfileSteps.mts`'s reason exactly: the spec it serves already owns a
 * full launch and a full fold, and a second subject inside one file makes each claim's evidence
 * depend on the other's setup. It is called from there rather than given a launch of its own
 * because THE ONLY EXPENSIVE THING IT NEEDS IS AN ENGINE THAT HAS FOLDED SOMETHING — which is
 * precisely the state that spec has just spent a whole scan reaching.
 *
 * ── ITS HOST SPEC, AND THE TWO YEARS THIS MODULE SPENT NOT RUNNING ─────────────────────────────
 *
 * It was written to be called from `engine-parity.e2e.mts`. THAT SPEC NO LONGER EXISTS — it went
 * with the parity probe when JOS-499 deleted the TypeScript fold — and nothing was wired up in its
 * place, so from that deletion until JOS-502 this module was dead code that no runner touched. It
 * had rotted, too, and in exactly the way dead test code does: it still demanded that the parity
 * row say `agree`, which had been unsatisfiable since the day there stopped being two folds to
 * compare. Both facts are the same lesson JOS-501 wrote down about `wireCrumbs` — when a thing's
 * failure mode is silence, what keeps it honest is somebody running it, not somebody reading it.
 *
 * IT IS CALLED FROM `engine-loot-view.e2e.mts` NOW, and that spec is the right host for the same
 * reason the old one was: it launches with `EQC_ENGINE=1`, folds a real fixture, and opens a real
 * subscription — so by the time these steps run, the engine has an ingest cost worth reporting AND
 * a serve table with a source in it, which is the only state in which this section is fully drawn.
 *
 * WHY THIS IS THE E2E AND NOT A UNIT TEST. Everything above the FFI boundary is already pinned by
 * `tests/enginePerf.test.mts` (the per-pid arithmetic over a fake pid, the formatters' absent cases,
 * the hook's arming and disarming run for real). What no unit can see is the WHOLE CHAIN: a real
 * engine process answering `perf.snapshot` over a real loopback socket, a real Win32 read of a real
 * pid, main joining the two, and the numbers coming out the other end of the preload bridge into a
 * DOM node. Four processes and two languages; only a launched app has all of them.
 *
 * IT DRIVES THE UI RATHER THAN THE CHANNEL. Reading `window.eq.onEnginePerf` directly would be a
 * shorter spec and a weaker one — it would prove the IPC and prove nothing about the section being
 * rendered, which is the entire deliverable. So the HUD is switched on the way a person switches it
 * on, the chip is clicked, and the assertion is against the text that appears.
 *
 * AND IT PRINTS WHAT IT SAW. The acceptance bar for this ticket is the panel's content reported
 * VERBATIM from a real run on a staged fixture, so the section's own `innerText` is echoed into the
 * run's notes — which also makes a future regression legible as a diff of what the panel says
 * rather than as a failed boolean.
 *
 * ── THE PROCESS ROW IS ASSERTED HERE AND NOWHERE ELSE ──────────────────────────────────────────
 *
 * `EQ_E2E` is deliberately NOT a gate on the native per-pid read (`processSample.ts` argues why:
 * that module only reads, so `engineHost.ts`'s rule applies rather than `priorityIsSupported`'s),
 * which means this spec exercises the SAME code path a player does — koffi mapped into main, a
 * handle opened on the engine's pid, `GetProcessTimes` and `GetProcessMemoryInfo`. Those four Win32
 * calls are the one part of this feature no unit test can reach, and this is the only place in the
 * suite where they run against a real engine process.
 *
 * THE CPU FIGURE IS ALLOWED TO SAY "measuring". It is a RATE, so the first reading of a pid has no
 * interval behind it, and whether a second poll has landed before the assertion is a race with a
 * two-second cadence. The row is therefore asserted as "a pid and a working set, and a CPU field
 * that is either a percentage or the honest placeholder" — which is a claim about the reading
 * having happened, and does not turn a timing accident into a red run.
 */
import type { Page } from 'playwright'
import { check, countIn, note, settle, settleCount, settleGone, settleStable } from './appHarness.mjs'

const CHIP = '[data-testid="perf-chip"]'
const POPOVER = '[data-testid="perf-popover"]'
const ENGINE = '[data-testid="perf-engine"]'

/** The sampler emits one sample immediately when the HUD is switched on; the engine poll emits one
 *  immediately when the panel opens. Both are generous bounds on a machine under an e2e load, and
 *  neither is a budget — every wait below is for a CONDITION. */
const SAMPLE_WAIT_MS = 15_000

function textOf(page: Page, selector: string): Promise<string> {
  return page.evaluate(
    (sel) => (document.querySelector(sel) as HTMLElement | null)?.innerText ?? '',
    selector
  )
}

/** Turn the HUD on through the app's own bridge — the same call the Preferences switch makes. The
 *  switch itself is `perf.e2e.mts`'s subject; this spec needs the chip, not the setting's UI. */
async function enableHud(page: Page): Promise<boolean> {
  await page.evaluate(() =>
    (
      window as unknown as { eq: { setPerfHudEnabled: (on: boolean) => Promise<unknown> } }
    ).eq.setPerfHudEnabled(true)
  )
  const chips = await settleCount(page, CHIP, 1, { timeoutMs: SAMPLE_WAIT_MS })
  return check(
    'the performance chip appears once the HUD is switched on',
    chips === 1,
    `${String(chips)} chip(s)`
  )
}

/**
 * THE ABSENCE ASSERTION, and it is worth having: the engine poll must not be running before anybody
 * opens the panel. It is checked at the DOM rather than at the timer because the DOM is what a user
 * has — and because a section that rendered with the popover shut would mean main was polling a
 * child process over a socket for nobody, which is exactly the cost this feature is not allowed to
 * have.
 */
async function stepNothingPollsWhileThePanelIsShut(page: Page): Promise<void> {
  // AN ABSENCE ASSERTION NEEDS A POSITIVE SIGNAL FIRST (`settle.mts`'s rule): the title bar is
  // still settling right after the chip appears, so a settled count of 0 says something a bare
  // read does not.
  const sections = await settleStable(() => countIn(page, ENGINE), {
    timeoutMs: 8_000,
    stable: 6,
    pollMs: 150
  })
  check(
    'the engine section is not rendered while the popover is shut — the poll is armed by opening it',
    sections === 0,
    `${String(sections)} section(s)`
  )
}

/** Open the popover and wait for the section the engine fills. */
async function openPanel(page: Page): Promise<boolean> {
  await page.click(CHIP, { timeout: SAMPLE_WAIT_MS })
  const popovers = await settleCount(page, POPOVER, 1, { timeoutMs: SAMPLE_WAIT_MS })
  check('clicking the chip opens the performance panel', popovers === 1, `${String(popovers)}`)
  const sections = await settleCount(page, ENGINE, 1, { timeoutMs: SAMPLE_WAIT_MS })
  return check(
    'the panel grows an ENGINE section — the data-server engine appears in the app’s own performance surface',
    sections === 1,
    sections === 1 ? 'section rendered' : await textOf(page, POPOVER)
  )
}

/**
 * WHAT THE SECTION SAYS. Each claim is a substring of the section's own text, because the thing
 * being proven is that a NUMBER FROM THE ENGINE reached a pixel — not that a component rendered.
 *
 * The serve table is the load-bearing one: `loot.ledger` can only be in that list because the ENGINE
 * put it there, from counters kept on its own ingest thread and read through the one door. No part
 * of this app has any other way to know that name in this context.
 */
function stepSectionCarriesTheEngineNumbers(text: string): void {
  const flat = text.replace(/\s+/g, ' ').trim()
  // THE OWNER'S ASK, LITERALLY: a process Chromium's own metrics call cannot see, with its pid and
  // its memory, sitting in the table beside main and the renderers. See the header for why the CPU
  // half accepts the placeholder.
  check(
    'the engine’s OWN PROCESS is in the table — the pid this app spawned, which app.getAppMetrics() cannot report',
    /engine \(pid \d+\)/.test(flat),
    flat
  )
  check(
    '…with a working set read off Windows, and a CPU figure that is either a rate or the honest "measuring"',
    /engine \(pid \d+\) (measuring|\d+%) · \d/.test(flat),
    flat
  )
  check(
    'it names the engine’s own state and generation — the two terms that decide what everything else means',
    /\b(live|folding|attaching|starting|idle)\b/.test(flat) && /epoch \d+/.test(flat),
    flat
  )
  check(
    '…the events the ENGINE folded, which no other part of this app counts',
    /events folded/.test(flat) && /[1-9][\d,]* /.test(flat),
    flat
  )
  check(
    '…what the scan cost it: a spell-db time and a scan over a real byte count',
    /spell db/.test(flat) && /scan/.test(flat),
    flat
  )
  check(
    '…the serve table off its own meter, or the honest sentence when nobody has subscribed',
    /views/.test(flat) || /loot\.ledger/.test(flat),
    flat
  )
  // THE BUDGETS (JOS-502, ruling 19's completion). This is the claim no unit test can make: the
  // VERDICT in this pixel was computed inside the Rust process, against the generation this app
  // just spent a scan building, and travelled the same socket the numbers above it did. The label
  // and the verdict are both the engine's own words — nothing in the renderer knows that a budget
  // is called "fold rate" or which side of a floor a measurement fell on.
  check(
    'the engine’s own BUDGETS are drawn, with the verdict IT reached about the generation it just built',
    /fold rate/.test(flat) && /serve latency/.test(flat),
    flat
  )
  check(
    '…and each says pass, fail, or the honest "not yet measured" — never a zero and never a blank',
    /(fold rate|serve latency)[^·]*·?\s*(pass|fail|not yet measured)/.test(flat) ||
      /(pass|fail|not yet measured)/.test(flat),
    flat
  )
  // THE PARITY LINE IS PERMANENTLY EMPTY AND THAT IS THE ASSERTION NOW (JOS-499 deleted the probe;
  // corrected here at JOS-502, which is when this module was first RUN by a spec). It used to
  // demand `/agree/`, which had been unsatisfiable since the TS fold was deleted — a check nothing
  // executed, rotting quietly. The row stays on screen because "no verdict" is the permanent truth
  // about a build with one fold, and the row saying so is better than a row that vanished.
  check(
    '…and the parity row states the permanent post-deletion truth: there is one fold, so nothing agrees with anything',
    /parity, last probe/.test(flat) && /no probe has run/.test(flat),
    flat
  )
}

/** Closing it takes the section away again — the other half of the polling discipline. */
async function stepClosingDisarms(page: Page): Promise<void> {
  await page.keyboard.press('Escape')
  const gone = await settleGone(page, ENGINE, { timeoutMs: SAMPLE_WAIT_MS })
  check(
    'closing the panel takes the engine section with it — the poll stops when nobody is looking',
    gone
  )
}

/**
 * The whole subject, driven. Returns the section's verbatim text so the spec can report it.
 */
export async function stepEnginePerfPanel(page: Page): Promise<string | null> {
  if (!(await enableHud(page))) return null
  await stepNothingPollsWhileThePanelIsShut(page)
  if (!(await openPanel(page))) return null
  // GIVE THE RATE ITS INTERVAL. The first poll of a pid has none behind it and honestly says
  // "measuring"; the second, one cadence later, has one. This waits for the number rather than
  // asserting on it — `settle` returns whatever it last read, so a slow machine yields the
  // placeholder and the check below still passes, while the ordinary run reports a real
  // percentage into the ticket's acceptance evidence.
  const text = await settle(() => textOf(page, ENGINE), (t) => /\d+%/.test(t), {
    timeoutMs: SAMPLE_WAIT_MS
  })
  stepSectionCarriesTheEngineNumbers(text)
  note(`the ENGINE section read, verbatim:\n${text}`)
  await stepClosingDisarms(page)
  return text
}
