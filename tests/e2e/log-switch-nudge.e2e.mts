/**
 * log-switch-nudge.e2e.mts — "another character's log is active — switch?", and the never-spam law.
 *
 * THE REPORT (JOS-432, 01M0G79DKNG0VK2B74N5TRB126). The app pins itself to one character's log and
 * nothing subscribes to "this character left the world", so a player who switches characters in
 * game is left attached to a file nobody writes any more — with a "connected" dot that means only
 * "a module delta arrived since the last rebuild" and therefore goes dark and stays dark. The
 * reporter read that as a dead app and spent an afternoon on an update, a reboot and a manual
 * re-point, none of which could have helped.
 *
 * THE OWNER'S RULING (2026-08-21) was a NUDGE and nothing else: offer the switch, never take it.
 * Two accounts on one PC must never get yanked between characters. And the constraint came as
 * verbatim law — the nudge must be structurally incapable of nagging.
 *
 * WHAT THIS SPEC IS FOR. The one-ask-per-log guarantee is a property of a pure decision core and is
 * pinned exhaustively in `tests/quietSwitch.test.mts`; what a unit test structurally cannot see is
 * the WHOLE path — a real tailer going silent on a real file, a real `readdir` watching a sibling
 * grow, the IPC, the card, the click, and the app really re-tailing. So this drives all of it:
 *
 *   • quiet log + growing sibling ⇒ EXACTLY ONE card, naming the right two characters;
 *   • the sibling keeps growing for seconds afterwards ⇒ still exactly one card, ever;
 *   • dismiss it, keep growing ⇒ it stays gone;
 *   • our own log comes back to life and goes quiet AGAIN ⇒ still no second card for that log;
 *   • a DIFFERENT sibling growing ⇒ that one may ask (one per LOG, not one per session);
 *   • clicking Switch re-tails to it, and the live dot lights on its next line;
 *   • and afterwards, the first sibling growing while the new one is quiet ⇒ silence, which is the
 *     two-account alternation bound.
 *
 * TIME IS COMPRESSED BY THE PRODUCT'S OWN E2E KNOB. The shipped threshold is five minutes of total
 * silence (quietSwitch.ts `QUIET_MS`), which no spec can wait for; `EQ_QUIET_SWITCH_MS` and
 * `EQ_QUIET_SWITCH_POLL_MS` are read ONLY under `EQ_E2E` (src/main/switchNudge.ts), so a packaged
 * app cannot be told to nag faster. Everything else here is the production path untouched, and the
 * compression keeps the SHAPE: the threshold is still several polls wide, so the baseline-then-
 * growth handshake the decision core requires still has to happen for real.
 *
 * THE CARD COUNT IS CUMULATIVE, via a MutationObserver installed before anything is driven — the
 * same instrument character-switch.e2e uses on the toast strip, and for the same reason: "how many
 * are on screen" answers a different question than "how many has this app ever shown me".
 *
 * Run: `npm run test:e2e -- log-switch-nudge`.
 */
import { appendFileSync } from 'node:fs'
import type { Page } from 'playwright-core'
import {
  buildIfStale,
  check,
  dumpArtifacts,
  failures,
  note,
  reportRun,
  settle,
  settleCount,
  settleGone,
  settleStable,
  waitHydrated
} from './appHarness.mjs'
import { mainWindow } from './appWindow.mjs'
import { launchOnFixture, stamp } from './logFixture.mjs'

/** The two other characters staged beside Primitive — same fixture, so all three start identical. */
const OTHER = 'Alterna'
const THIRD = 'Bantam'

/** The compressed clock (see the header). */
const QUIET_MS = 1_200
const POLL_MS = 300
/** How fast a "being played right now" log grows here. Comfortably inside one poll. */
const GROW_MS = 150
/** One real line from a real log, repeated. Only its BYTES matter to the detector. */
const GROW_LINE = 'You crush a fire giant warrior for 37 points of damage.'
/** Lines that MOVE A MODULE — the character module's zone — so the live dot has to light. */
const ZONES = ['You have entered The Ruins of Old Guk.', 'You have entered Innothule Swamp.'] as const

const NUDGE = '[data-testid="log-switch-nudge"]'
const SWITCH_BUTTON = '[data-testid="log-switch-nudge-switch"]'
const DISMISS_BUTTON = '[data-testid="log-switch-nudge-dismiss"]'
const LIVE_DOT = '[data-testid="live-dot"]'

/**
 * Write EQ-stamped lines into one of the OTHER staged logs. `FixtureLog.append` only ever writes
 * the primary log, and the whole subject here is the file the app is NOT reading.
 */
function appendTo(path: string, ...messages: readonly string[]): void {
  const prefix = stamp(new Date())
  appendFileSync(path, `${messages.map((m) => `${prefix} ${m}`).join('\n')}\n`)
}

/** Keep a log growing the way a character being actively played does, until stopped. */
function keepGrowing(path: string): () => void {
  appendTo(path, GROW_LINE)
  const timer = setInterval(() => {
    appendTo(path, GROW_LINE)
  }, GROW_MS)
  return () => {
    clearInterval(timer)
  }
}

/** Count every nudge card this window ever MOUNTS, not the ones standing there now. */
function watchNudges(page: Page): Promise<void> {
  return page.evaluate((sel) => {
    const w = window as unknown as { __eqNudgeSeen?: number }
    if (typeof w.__eqNudgeSeen === 'number') return
    w.__eqNudgeSeen = 0
    new MutationObserver((records) => {
      for (const record of records) {
        for (const node of record.addedNodes) {
          if (node.nodeType !== 1) continue
          const el = node as HTMLElement
          if (el.matches(sel)) w.__eqNudgeSeen = (w.__eqNudgeSeen ?? 0) + 1
          else w.__eqNudgeSeen = (w.__eqNudgeSeen ?? 0) + el.querySelectorAll(sel).length
        }
      }
    }).observe(document.body, { childList: true, subtree: true })
  }, NUDGE)
}

function nudgesSeen(page: Page): Promise<number> {
  return page.evaluate(() => (window as unknown as { __eqNudgeSeen?: number }).__eqNudgeSeen ?? 0)
}

function cardText(page: Page): Promise<string> {
  return page.evaluate(
    (sel) => document.querySelector(sel)?.textContent?.replace(/\s+/g, ' ').trim() ?? '',
    NUDGE
  )
}

/** Who main says it is tailing right now. */
function tailedName(page: Page): Promise<string> {
  return page.evaluate(async () => {
    const bridge = window as unknown as { eq: { getCharacter: () => Promise<{ name?: string } | null> } }
    return (await bridge.eq.getCharacter())?.name ?? ''
  })
}

/** Switch through the app's own IPC (the title bar's path), and wait for main to finish. */
async function switchTo(page: Page, logPath: string): Promise<string> {
  await page.evaluate(
    (p) =>
      (window as unknown as { eq: { setCharacter: (x: string) => Promise<unknown> } }).eq.setCharacter(p),
    logPath
  )
  return settle(() => tailedName(page), (n) => n !== '', { timeoutMs: 60_000 })
}

/**
 * Wait for the cumulative card count to stop moving, then read it — the positive signal behind
 * every "and nothing else happened" assertion below.
 *
 * TEN SAMPLES AT 250 ms IS A STATED DURATION, not a habit: 2.5 s is longer than a whole quiet
 * threshold plus the two polls a nudge would need, so a defect that re-fires on the poll has had
 * several chances to do so before this returns.
 */
function settledCount(page: Page): Promise<number> {
  return settleStable(() => nudgesSeen(page), { timeoutMs: 12_000, stable: 10, pollMs: 250 })
}

async function run(): Promise<void> {
  buildIfStale()

  console.log('launch: hidden Electron (EQ_E2E=1), three characters staged, quiet threshold compressed…')
  const { app, close, log } = await launchOnFixture('e2e-toast.log', {
    others: { [OTHER]: 'e2e-toast.log', [THIRD]: 'e2e-toast.log' },
    env: {
      EQ_QUIET_SWITCH_MS: String(QUIET_MS),
      EQ_QUIET_SWITCH_POLL_MS: String(POLL_MS)
    }
  })

  let win: Page | null = null
  const stops: (() => void)[] = []
  try {
    win = await mainWindow(app)
    const page = win
    const consoleErrors: string[] = []
    page.on('console', (m) => {
      if (m.type() === 'error') consoleErrors.push(m.text())
    })
    page.on('pageerror', (e) => consoleErrors.push(String(e)))

    await page.waitForSelector('[data-testid="nav-preferences"]', { timeout: 60_000 })
    await waitHydrated(page)
    await watchNudges(page)

    const otherPath = log.others[OTHER]
    const thirdPath = log.others[THIRD]
    if (
      !check(
        `two more characters (${OTHER}, ${THIRD}) are staged beside Primitive`,
        typeof otherPath === 'string' && typeof thirdPath === 'string',
        `${String(otherPath)} · ${String(thirdPath)}`
      )
    ) {
      return
    }

    // Start from a STATED character rather than whichever copy the mtime resolver liked best. This
    // also restarts the quiet clock, so the silent stretch below begins here.
    const first = await switchTo(page, log.logPath)
    check('the app is tailing Primitive', first === 'Primitive', first)

    // ── THE REPORT: our log goes silent while another character's is written to ───────────────
    // Nothing appends to Primitive's log from here on. That IS the defect's precondition.
    const stopOther = keepGrowing(otherPath)
    stops.push(stopOther)

    const appeared = await settleCount(page, NUDGE, 1, { timeoutMs: 25_000, pollMs: 150 })
    check(`a quiet log + a growing ${OTHER} log offers a switch`, appeared === 1, `${String(appeared)} card(s)`)
    const text = await cardText(page)
    check(
      '…and the card names both characters: the quiet one, and the one to switch to',
      text.includes('Primitive') && text.includes(OTHER),
      text
    )
    check('…and it offers exactly one switch button', (await page.locator(SWITCH_BUTTON).count()) === 1)

    // ── NEVER SPAM, part 1: the sibling keeps growing and nothing else is ever shown ──────────
    const afterGrowth = await settledCount(page)
    check(
      `${OTHER} keeps being played for seconds — still exactly ONE card, ever`,
      afterGrowth === 1,
      `${String(afterGrowth)} card(s) seen`
    )

    // ── NEVER SPAM, part 2: dismissing it is remembered ───────────────────────────────────────
    await page.click(DISMISS_BUTTON)
    check('dismissing the card takes it off screen', await settleGone(page, NUDGE, { timeoutMs: 8_000 }))
    const afterDismiss = await settledCount(page)
    check(
      '…and it never comes back while that log keeps growing — no timer re-fire, no re-show',
      afterDismiss === 1,
      `${String(afterDismiss)} card(s) seen`
    )

    // ── NEVER SPAM, part 3: a FRESH quiet stretch does not un-spend the answer ────────────────
    // Primitive plays again (the dot lights, the quiet clock resets) and then wanders off again.
    log.append(...ZONES)
    check(
      'Primitive playing again lights the live dot',
      (await settleCount(page, LIVE_DOT, 1, { timeoutMs: 20_000, pollMs: 150 })) === 1
    )
    const afterRevival = await settledCount(page)
    check(
      'going quiet a SECOND time does not re-ask about a character we already asked about',
      afterRevival === 1,
      `${String(afterRevival)} card(s) seen`
    )

    // ── THE ONE THING THAT MAY ASK AGAIN: a DIFFERENT sibling starts being played ─────────────
    const stopThird = keepGrowing(thirdPath)
    stops.push(stopThird)
    const second = await settle(() => nudgesSeen(page), (n) => n >= 2, { timeoutMs: 25_000, pollMs: 150 })
    check(
      `a DIFFERENT sibling (${THIRD}) starting up is a genuinely new situation and may ask`,
      second === 2,
      `${String(second)} card(s) seen`
    )
    const secondText = await cardText(page)
    check(
      `…and that card is about ${THIRD}, not ${OTHER}`,
      secondText.includes(THIRD) && !secondText.includes(OTHER),
      secondText
    )

    // ── THE CLICK: the app switches only because the user said so ─────────────────────────────
    // Bantam stops being played BEFORE the click, so the assertions below are about lines this
    // spec writes on purpose rather than about a driver still running in the background.
    stopThird()
    await page.click(SWITCH_BUTTON)
    const tailing = await settle(() => tailedName(page), (n) => n === THIRD, { timeoutMs: 60_000 })
    check(`clicking Switch re-tails to ${THIRD}`, tailing === THIRD, tailing)

    // …and the dot lights on that character's next line. It goes dark on the rebuild (App.tsx sets
    // `live` false on every `log:character`), which is exactly the state the reporter was staring
    // at — so this is the assertion that taking the offer fixes what they were looking at.
    check('the dot goes dark across the rebuild', await settleGone(page, LIVE_DOT, { timeoutMs: 10_000 }))
    appendTo(thirdPath, ...ZONES)
    check(
      `…and lights again on ${THIRD}'s next line`,
      (await settleCount(page, LIVE_DOT, 1, { timeoutMs: 20_000, pollMs: 150 })) === 1
    )

    // ── THE ALTERNATION BOUND: at most one ask per LOG, whichever way the pair alternates ─────
    // We are on Bantam now and nothing writes to its log, while Alterna is still being played hard.
    const afterAlternation = await settledCount(page)
    check(
      `${THIRD} going quiet while ${OTHER} is still being played asks NOTHING — both logs are spent`,
      afterAlternation === 2,
      `${String(afterAlternation)} card(s) seen`
    )
    check('no card is on screen at the end', (await page.locator(NUDGE).count()) === 0)

    check('no renderer console errors', consoleErrors.length === 0, consoleErrors.slice(0, 3).join(' | '))
    if (failures.length) await dumpArtifacts(page, 'log-switch-nudge-FAIL')
  } finally {
    for (const stop of stops) stop()
    await close()
  }

  reportRun()
}

run().catch((err: unknown) => {
  console.error('e2e: harness error —', err)
  note('the log-switch-nudge spec did not complete')
  process.exitCode = 1
})
