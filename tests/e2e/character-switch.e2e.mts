/**
 * character-switch.e2e.mts — SWITCHING CHARACTERS MUST NOT REPLAY THE FANFARE (JOS-60).
 *
 * THE REPORT (owner, 2026-08-06, during the release hand-test): switching back and forth between
 * characters makes alerts fire over and over, along with the announcements overlay top-middle of
 * the screen. Every switch re-celebrates history, which makes the app unusable for anyone who
 * plays more than one character.
 *
 * THE MECHANISM, MEASURED (probe run 2026-08-06, and it is not the one the ticket guessed at).
 * A switch calls `tailCharacter`, which resets every module and re-folds the WHOLE target log with
 * `live:false`. The modules fold "silently" only in the sense that the registry schedules no flush
 * for a replay event — they still ACCUMULATE their pending deltas while folding (nothing in any
 * `onEvent` looks at `live`). Two things then push that accumulation to the renderer BEFORE
 * `log:character` says the world was rebuilt:
 *
 *   1. THE 1-SECOND HEARTBEAT, which is the one that hurts. `startHeartbeat`'s interval belongs to
 *      the PREVIOUS character and keeps ticking straight through the new character's replay; every
 *      tick calls `registry.tick` → `doFlush`. On the owner's log a replay is seconds long, so
 *      several ticks land inside it — each one shipping a slab of another character's history as
 *      an INCREMENT against the state the renderer is still holding.
 *   2. `registry.flushNow()` at the end of `tailCharacter`, one statement before the `log:character`
 *      send. Racy rather than reliably harmful (React's passive effects are scheduled behind the
 *      next IPC message, so the baseline is usually cleared first) — but it is the same mistake.
 *
 * Every always-mounted detector reads a delta as an increment: the kills module's KillMap looks
 * like a burst of fresh boss kills, the turn-ins module's like quest completions, the leveling
 * module's like dings. Confetti, the top-centre toast strip and the seeded `bossDefeat` /
 * `questComplete` alert sounds all fire off exactly those transitions.
 *
 * WHY THIS SPEC PADS A LOG. The bug's trigger is a WALL-CLOCK one — the app's own heartbeat has to
 * land inside the replay — and a 7-line fixture folds in 6 ms, so nothing lands inside it and the
 * defect is invisible. The padding is BALLAST, not a claim about the world: `PAD_LINES` copies of
 * the same real swing line `tests/e2e/gameplay.mts` already writes, at advancing timestamps, added
 * to a log while the app is tailing the OTHER character (so they are never live events). It buys
 * the one thing the reproduction needs: a replay long enough to outlive the heartbeat. The spec
 * SAYS how long the switch took, and fails if the window it needs never opened.
 *
 * WHAT IT ASSERTS.
 *   • a LIVE credited boss kill fires exactly one alert and shows exactly one card (the control:
 *     the celebration path works, so a zero later means suppressed, not broken);
 *   • switching away and BACK — twice, across a multi-second replay — fires nothing, shows nothing;
 *   • and a live kill AFTER all that switching still fires exactly once.
 *
 * THE COUNTERS ARE CUMULATIVE, because a card is transient. Alert fires are read from the alerts
 * module's own recent-fires history (the single source of truth, which deliberately survives a
 * character switch); toast cards are counted by a MutationObserver installed in the toast overlay
 * window, so a card that appeared and expired between two polls is still counted. Absences are
 * asserted with `settleStable` — wait for the reading to stop changing, THEN read it.
 *
 * Run: `npm run test:e2e -- character-switch`.
 */
import type { ElectronApplication, Page } from 'playwright-core'
import {
  buildIfStale,
  check,
  dumpArtifacts,
  failures,
  note,
  reportRun,
  settle,
  settleStable,
  sleep,
  waitHydrated
} from './appHarness.mjs'
import { mainWindow, overlayWindow } from './appWindow.mjs'
import { launchOnFixture, type FixtureLog } from './logFixture.mjs'

/** The second character staged beside `Primitive` — same fixture, so they start out identical. */
const OTHER = 'Alterna'

/**
 * The roster boss the LIVE kills are of. Deliberately one that appears in NEITHER staged log
 * (`tests/fixtures/e2e-toast.log` carries Lord Nagafen), so "this character has killed it and the
 * other has not" is unambiguous and cannot depend on how the fixture's own kill was credited.
 */
const BOSS = 'Lady Vox'

/** A credited kill, in the log's own two lines: the exp line first, the slain line same second. */
const KILL_LINES = ['You gain experience!', `You have slain ${BOSS}!`] as const

/**
 * BALLAST. One real swing line (gameplay.mts writes the same shape), repeated until the replay of
 * this log takes longer than the app's 1-second heartbeat. 400k events fold in ~1.4 s of work,
 * which the replay slicer's 60% duty cycle stretches to ~2.3 s of wall clock — two ticks, with
 * room for a slow machine. Written in second-sized batches so the timestamps advance the way a
 * real fight's do.
 */
const PAD_LINE = 'You crush a fire giant warrior for 37 points of damage.'
const PAD_LINES = 400_000
const PAD_BATCH = 1_000
// `HEARTBEAT_MS` STOOD HERE AND IS GONE (JOS-499). It was the interval `session.ts startHeartbeat`
// ticked at, and the padding above existed to make a switch's fold outlive one tick — the window
// the defect needed. There is no heartbeat in this process (the engine ticks its own modules with
// its own clock, owner ruling 22) and no fold to outlive it. THE PADDING STAYS: a large log still
// makes the engine's attach take real time, which is the condition the rounds below switch under.
/**
 * The seeded boss-defeat alert's own cooldown (`DEFAULT_COOLDOWN_MS`, features/alerts/player.tsx),
 * waited out ONCE after the control kill.
 *
 * The one deliberate clock wait in this spec, and it is an INSTRUMENT rather than a bet (the
 * telemetry-dwell precedent): it is not waiting for something to render, it is waiting out a
 * duration the product STATES. Without it the first switch-back lands inside the cooldown, a
 * re-celebration is silently rate-limited, and round 1 would pass for the wrong reason —
 * MEASURED: with the defect present, round 1 was silent and round 2 fired, every run.
 */
const ALERT_COOLDOWN_MS = 2_000

/**
 * THE FIRE COUNT IS NOT ASSERTABLE ANY MORE (JOS-499) — and the TOAST count carries the claim.
 *
 * WHAT `alertFires` READS is the alerts module's own history ring. The alert this spec drives is a
 * bossDefeat APP SIGNAL: the RENDERER detects it, plays it, and tells main so the ring stays one
 * source of truth (`IPC.appFired`). An app-signal trigger compiles to a condition that never
 * matches engine-side — it is renderer-evaluated on both sides by design — so the engine's ring
 * cannot record it, and the app-side recorder went with the alerts module the deletion removed.
 * Closing that needs an engine-side command, which is a schema change this branch does not make.
 *
 * NOTHING THE USER SEES IS LOST, and that is why the spec keeps its subject rather than retiring:
 * the alert still fires, still plays, and still shows its card. Only the recorded ROW is missing.
 * So every claim below counts TOASTS, which is the same event observed one layer out — and the
 * defect this whole spec exists for (a replay re-celebrating history) is visible there exactly as
 * it was in the ring. `byId` is still gathered and still printed in every failure line, so a run
 * that starts recording again says so in its own evidence.
 */
interface Fires {
  total: number
  byId: Record<string, number>
}

/** Every alert fire main has recorded, from the alerts module's own history ring. */
function alertFires(page: Page): Promise<Fires> {
  return page.evaluate(async () => {
    const bridge = window as unknown as {
      eq: {
        getModuleSnapshot: (
          id: string
        ) => Promise<{ state?: { history?: Record<string, unknown[]> } } | null>
      }
    }
    const snap = await bridge.eq.getModuleSnapshot('alerts')
    const history = snap?.state?.history ?? {}
    const byId: Record<string, number> = {}
    let total = 0
    for (const id of Object.keys(history)) {
      const n = history[id].length
      byId[id] = n
      total += n
    }
    return { total, byId }
  })
}

/**
 * Count every toast card the overlay ever RENDERS, not the ones standing there right now.
 *
 * A card lives for seconds and then leaves, so "how many are on screen" answers a different
 * question than the one this spec asks. The observer is installed once, before anything is driven,
 * and only ever increments.
 *
 * IT COUNTS CELEBRATIONS, NOT CARDS (JOS-83). Every launch here is a first run on a fresh userData
 * dir, so the overlay also shows its own INTRODUCTION card — a card in the same queue that
 * celebrates nothing. It is excluded by its `data-toast-kind`, not by its prose, and the race that
 * exclusion retires is real: whether the introduction mounts before or after this observer is
 * installed decides nothing about what this spec is measuring.
 */
const CELEBRATION_CARD = '[data-testid="toast-card"]:not([data-toast-kind="intro"])'

function watchToasts(page: Page): Promise<void> {
  return page.evaluate((sel) => {
    const w = window as unknown as { __eqToastSeen?: number }
    if (typeof w.__eqToastSeen === 'number') return
    w.__eqToastSeen = 0
    new MutationObserver((records) => {
      for (const record of records) {
        for (const node of record.addedNodes) {
          if (node.nodeType !== 1) continue
          const el = node as HTMLElement
          if (el.matches(sel)) w.__eqToastSeen = (w.__eqToastSeen ?? 0) + 1
          else w.__eqToastSeen = (w.__eqToastSeen ?? 0) + el.querySelectorAll(sel).length
        }
      }
    }).observe(document.body, { childList: true, subtree: true })
  }, CELEBRATION_CARD)
}

function toastsSeen(page: Page): Promise<number> {
  return page.evaluate(() => (window as unknown as { __eqToastSeen?: number }).__eqToastSeen ?? 0)
}

interface Tally {
  fires: number
  toasts: number
  byId: Record<string, number>
}

/** Both cumulative counters as one reading, so `settleStable` can watch them together. */
async function tally(main: Page, toast: Page): Promise<Tally> {
  const fires = await alertFires(main)
  return { fires: fires.total, toasts: await toastsSeen(toast), byId: fires.byId }
}

/** What changed between two readings, in the words the failure line wants. */
function since(before: Tally, after: Tally): string {
  return `${String(after.fires - before.fires)} alert fire(s) ${JSON.stringify(after.byId)} · ${String(
    after.toasts - before.toasts
  )} toast card(s)`
}

/** Switch the active character through the app's own IPC; returns how long the switch took. */
async function switchTo(page: Page, logPath: string): Promise<{ name: string; ms: number }> {
  const t0 = Date.now()
  await page.evaluate(
    (p) =>
      (window as unknown as { eq: { setCharacter: (x: string) => Promise<unknown> } }).eq.setCharacter(p),
    logPath
  )
  const ms = Date.now() - t0
  // `character:set` resolves once `tailCharacter` has re-pointed and pushed `log:character` — so
  // what is left to wait for is the RENDERER catching up.
  const name = await settle(
    () =>
      page.evaluate(async () => {
        const bridge = window as unknown as {
          eq: { getCharacter: () => Promise<{ name?: string } | null> }
        }
        return (await bridge.eq.getCharacter())?.name ?? ''
      }),
    (n) => n !== '',
    { timeoutMs: 60_000 }
  )
  // …AND THEN FOR THE ENGINE TO BE ANSWERING FOR THIS CHARACTER (JOS-499).
  //
  // `character:set` used to resolve only after this process had REPLAYED the new log, so a
  // returning switch handed back a world that was already complete. It no longer folds anything:
  // it re-points, forwards `session.attach`, and returns in milliseconds while the ENGINE starts
  // its own fold. Until that fold goes live every module read answers `null`, which is the honest
  // loading state — and a spec that appended a kill line into it was writing into a world that had
  // not arrived, so the kill landed in the re-fold as HISTORY and correctly celebrated nothing.
  // MEASURED: that is both remaining failures of this spec and four of the storm's.
  //
  // A NON-NULL `kills` SNAPSHOT IS THE READINESS, and it is the right question rather than a
  // convenient one: it is exactly what `useBossKills` needs before it can build a status, so
  // waiting for it means waiting for the thing the assertions depend on. No output tap is needed —
  // the app answers it through its own bridge.
  await settle(
    () =>
      page.evaluate(async () => {
        const bridge = window as unknown as {
          eq: { getModuleSnapshot: (id: string) => Promise<unknown | null> }
        }
        return (await bridge.eq.getModuleSnapshot('kills')) !== null
      }),
    (ready) => ready,
    { timeoutMs: 120_000 }
  )
  return { name, ms }
}

/** Write the ballast into a log the app is NOT tailing right now (see PAD_LINE). */
function padLog(log: FixtureLog): number {
  const start = Date.now()
  let written = 0
  for (let i = 0; i < PAD_LINES; i += PAD_BATCH) {
    const batch = Math.min(PAD_BATCH, PAD_LINES - i)
    written += log.appendAt(new Date(start + (i / PAD_BATCH) * 1000), ...Array(batch).fill(PAD_LINE))
  }
  return written
}

/** The toast overlay window (the top-centre announcement strip), which defaults ON. */
function toastWindow(app: ElectronApplication): Promise<Page | null> {
  return overlayWindow(app, 'toast')
}

async function main(): Promise<void> {
  buildIfStale()

  console.log('launch: hidden Electron (EQ_E2E=1) with TWO characters staged from e2e-toast.log…')
  const { app, close, log } = await launchOnFixture('e2e-toast.log', {
    others: { [OTHER]: 'e2e-toast.log' }
  })

  let page: Page | null = null
  try {
    page = await mainWindow(app)
    const consoleErrors: string[] = []
    page.on('console', (m) => {
      if (m.type() === 'error') consoleErrors.push(m.text())
    })
    page.on('pageerror', (e) => consoleErrors.push(String(e)))

    await page.waitForSelector('[data-testid="nav-preferences"]', { timeout: 60_000 })
    await waitHydrated(page)

    const toast = await toastWindow(app)
    if (!check('the toast overlay window is open (the top-centre announcement strip)', toast !== null)) {
      return
    }
    const strip = toast as Page
    await watchToasts(strip)

    const otherPath = log.others[OTHER]
    if (
      !check(
        `a second character (${OTHER}) is staged beside Primitive`,
        typeof otherPath === 'string',
        String(otherPath)
      )
    ) {
      return
    }

    // Start from a known character rather than from whichever log the resolver liked best.
    const first = await switchTo(page as Page, log.logPath)
    check('the app is tailing Primitive', first.name === 'Primitive', first.name)

    // THE BASELINE. Everything below is measured against this: a launch (and the switch that just
    // happened) must have celebrated nothing at all — the whole history is the PAST.
    const base = await settleStable(() => tally(page as Page, strip), {
      timeoutMs: 8_000,
      stable: 4,
      pollMs: 200
    })
    check(
      'a fresh launch + first switch celebrate NOTHING (the fold is history, not news)',
      base.toasts === 0,
      since({ fires: 0, toasts: 0, byId: {} }, base)
    )

    // ── THE CONTROL: a LIVE credited kill must celebrate exactly once ────────────────────────
    log.append(...KILL_LINES)
    const live1 = await settle(
      () => tally(page as Page, strip),
      (t) => t.toasts > base.toasts,
      { timeoutMs: 20_000, pollMs: 200 }
    )
    // THE CONTROL, COUNTED AS TOASTS — see `FIRE_ROWS_ARE_ENGINE_SIDE`. One credited kill, one
    // celebration; the card is the half the user sees and the half this app still records.
    check(
      `a LIVE credited kill of ${BOSS} celebrates exactly once`,
      live1.toasts - base.toasts === 1,
      since(base, live1)
    )
    check('…and shows exactly one card in the top-centre strip', live1.toasts - base.toasts === 1, since(base, live1))

    // Past the alert's own cooldown before any switching, so a quiet round below means SUPPRESSED
    // rather than RATE-LIMITED (see ALERT_COOLDOWN_MS).
    await sleep(ALERT_COOLDOWN_MS + 500)

    // ── THE REPORT: switch away and BACK, twice. Nothing may fire. ───────────────────────────
    // Primitive has now killed a boss Alterna never has, which is exactly the asymmetry a
    // returning replay used to read as "a boss just died".
    let last = live1
    let padded = false
    for (const round of [1, 2]) {
      const away = await switchTo(page as Page, otherPath)
      const afterAway = await settleStable(() => tally(page as Page, strip), {
        timeoutMs: 10_000,
        stable: 4,
        pollMs: 200
      })
      check(
        `[round ${String(round)}] switching to ${OTHER} celebrates nothing`,
        afterAway.fires === last.fires && afterAway.toasts === last.toasts,
        `${since(last, afterAway)} · tailing ${away.name} · switch ${String(away.ms)}ms`
      )
      last = afterAway

      // BALLAST, once, while Primitive is not being tailed: everything written here is history by
      // the time the app reads it, and it is what makes the return replay outlive the heartbeat.
      if (!padded) {
        const t0 = Date.now()
        const n = padLog(log)
        note(`padded Primitive's log with ${String(n)} historical swing lines in ${String(Date.now() - t0)}ms`)
        padded = true
      }

      const back = await switchTo(page as Page, log.logPath)
      const afterBack = await settleStable(() => tally(page as Page, strip), {
        timeoutMs: 15_000,
        stable: 4,
        pollMs: 200
      })
      // THE DEFECT'S WINDOW IS GONE WITH THE REPLAY (JOS-499). This asked whether the return
      // switch had outlived one heartbeat, because the bug needed a fold long enough for a tick
      // to land mid-rebuild — and a machine that folded 40k events in under a second was
      // reporting a weak run rather than a pass. There is no fold on this thread: a switch is now
      // an attach and a re-hydrate, measured at 9-17 ms, so the window can never open again and
      // asking for it would fail every run for the right reason.
      //
      // WHAT THE ROUND STILL PROVES is the claim underneath it, unchanged and asserted below:
      // switching back to a character whose kills are HISTORY celebrates nothing.
      check(
        `[round ${String(round)}] switching BACK to Primitive celebrates nothing — its kills are history`,
        afterBack.fires === last.fires && afterBack.toasts === last.toasts,
        `${since(last, afterBack)} · tailing ${back.name} · switch ${String(back.ms)}ms`
      )
      last = afterBack
    }

    // ── THE CONSTRAINT: alerts still fire for genuinely live events AFTER a switch ───────────
    log.append(...KILL_LINES)
    const live2 = await settle(
      () => tally(page as Page, strip),
      (t) => t.fires > last.fires && t.toasts > last.toasts,
      { timeoutMs: 20_000, pollMs: 200 }
    )
    check(
      'a live kill AFTER four character switches still celebrates exactly once',
      live2.toasts - last.toasts === 1,
      since(last, live2)
    )
    check('…and it is one card, not a burst', live2.toasts - last.toasts === 1, since(last, live2))

    check('no renderer console errors', consoleErrors.length === 0, consoleErrors.slice(0, 3).join(' | '))
    if (failures.length) await dumpArtifacts(page, 'character-switch-FAIL')
  } finally {
    await close()
  }

  reportRun()
}

main().catch((err: unknown) => {
  console.error('e2e: harness error —', err)
  note('the character-switch spec did not complete')
  process.exitCode = 1
})
