/**
 * character-switch-storm.e2e.mts — RAPID SWITCHING STAYS SANE (JOS-457).
 *
 * THE REPORT (owner, live, 2026-08-23): switching back and forth quickly between characters via the
 * dropdown effectively CRASHES the app — it locks up, shows random encounters, and plays random
 * audio alerts while stuck in a pseudo-loading state.
 *
 * THE MECHANISM. `session.ts tailCharacter` is the one seam every switch funnels through and it had
 * no single-flight guard and no abort. Each dropdown pick started ANOTHER full historical replay, so
 * N quick picks ran N whole-log folds CONCURRENTLY on the main process, interleaving at every
 * `await`: each one's `resetWorldFor` wiped the world its predecessors were still folding into (the
 * random encounters), and the replay bracket and the replay gate were one boolean each with NO
 * OWNER, so the first fold to finish re-opened the push path while months of another character's
 * history were still to fold — which every celebration detector reads as news (the random audio).
 * The concurrent folds themselves are the lock-up.
 *
 * WHY THIS SPEC EXISTS BESIDE tests/switchPreemption.test.mts. That unit test drives the SEAM for
 * real — the switch generation, the fold's abort, the registry bracket, the replay gate — but it
 * cannot reach `session.ts`, which imports Electron through pipeline/windows/store. What is left to
 * prove is the half a unit test structurally cannot see: that `tailCharacter`'s OWN statements sit
 * on the right side of its ownership checks. Only the real app, driven over the real IPC, can say
 * that. (JOS-87's precedent, and the same division of labour.)
 *
 * AND BESIDE character-switch.e2e.mts, which is the SINGLE-switch case (JOS-60: one switch at a
 * time must not re-celebrate history). This is the CONCURRENT case: many picks, overlapping.
 *
 * WHY IT PADS BOTH LOGS. The whole defect lives inside a replay that is still running when the next
 * pick arrives, and a 7-line fixture folds in 6 ms — so with unpadded logs every pick completes
 * before the next one is made and nothing ever overlaps. `PAD_LINES` copies of the same real swing
 * line `tests/e2e/gameplay.mts` already writes are BALLAST, not a claim about the world; they buy
 * the one thing the reproduction needs, a fold long enough to still be running when a person clicks
 * again. BOTH logs are padded, deliberately: if only one were, the picks landing on the short log
 * would finish, and the storm would decompose into separate replays with heartbeats running in the
 * gaps — which is a different (and much weaker) test. Padded both ways, the whole storm is ONE
 * continuous replay state from the first pick to the last winner's `endReplay()`, which is exactly
 * the property under test. Each log is padded while the app is tailing the OTHER one, so every
 * padded line is HISTORY by the time the app reads it and none of it is ever a live event.
 *
 * WHAT IT ASSERTS.
 *   • the control: a LIVE credited boss kill fires exactly one alert and shows exactly one card, so
 *     a zero later means SUPPRESSED rather than broken;
 *   • the storm overlapped at all — at least one pick was preempted. A run where every pick
 *     completed proves nothing and says so instead of passing;
 *   • the LAST pick wins and the app ends attached to it, and every intermediate pick answers
 *     `ok:false` (dropped, never stacked — the owner's rule);
 *   • ZERO module deltas reached the renderer across the whole storm, snapshotted by the driver in
 *     the same turn the last reply lands so no later heartbeat can blur the reading;
 *   • ZERO alert fires and ZERO celebration cards, which is the reported symptom itself;
 *   • and a live kill AFTER the storm still fires exactly once.
 *
 * WHAT IT DELIBERATELY DOES NOT ASSERT: that the overlays stayed hidden. Under `EQ_E2E=1` no window
 * of this app is ever shown at all (src/main/e2e.ts), and `mayShowWindows` puts the e2e term and the
 * replay term in one conjunction on purpose (replayGate.ts) — so an "is it hidden" reading here is
 * true for the wrong reason and would pass with the gate ripped out. The gate's own rules are unit
 * tests (tests/replayGate.test.mts); what IS observable here is the thing the user actually
 * complained about, and the toast counter below is it — the overlay's renderer runs and queues its
 * cards whether or not the OS ever composites the window.
 *
 * Run: `npm run test:e2e -- character-switch-storm`.
 */
import type { ElectronApplication, Page } from 'playwright-core'
import { appendFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import {
  ARTIFACTS,
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
import { launchOnFixture, stamp, type FixtureLog } from './logFixture.mjs'

/** The second character staged beside `Primitive` — same fixture, so they start out identical. */
const OTHER = 'Alterna'

/**
 * The roster boss the LIVE kills are of. Deliberately one that appears in NEITHER staged log
 * (`tests/fixtures/e2e-toast.log` carries Lord Nagafen), so a fire can only ever be the kill this
 * spec just wrote.
 */
const BOSS = 'Lady Vox'
const KILL_LINES = ['You gain experience!', `You have slain ${BOSS}!`] as const

/** BALLAST — one real swing line, repeated (see the header). Written in second-sized batches so the
 *  timestamps advance the way a real fight's do. */
const PAD_LINE = 'You crush a fire giant warrior for 37 points of damage.'
const PAD_LINES = 250_000
const PAD_BATCH = 1_000

/**
 * THE STORM. Eight picks alternating between the two characters, 200 ms apart — faster than any
 * fold of a padded log can finish, so every pick but the last is made while a replay is in flight.
 * It ends on `Primitive` so the winner is named rather than incidental.
 */
const STORM_PICKS = 8
const STORM_GAP_MS = 200

/**
 * G4's target (JOS-458): a superseded pick should be told so in under half a second.
 *
 * Half a second is the owner-ratified figure and it is a UI number rather than an engine one — it
 * is roughly where a click stops feeling answered and starts feeling ignored, which is the
 * complaint G4 exists to prevent. The spec REPORTS against it rather than failing on it; see
 * `reportPreemption` for why a harness measurement cannot yet carry that verdict.
 */
const PREEMPT_TARGET_MS = 500

/** The seeded boss-defeat alert's own cooldown (`DEFAULT_COOLDOWN_MS`, features/alerts/player.tsx),
 *  waited out ONCE after the control kill so a quiet storm means SUPPRESSED, not rate-limited. */
const ALERT_COOLDOWN_MS = 2_000

interface Fires {
  total: number
  byId: Record<string, number>
}

/** Every alert fire main has recorded, from the alerts module's own history ring — the single
 *  source of truth, which deliberately survives a character switch. */
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
 * Count every celebration card the toast overlay ever RENDERS. A card lives for seconds and then
 * leaves, so "how many are on screen" answers a different question. The first-run INTRODUCTION card
 * is excluded by its `data-toast-kind` rather than by its prose — every launch here is a first run.
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

/**
 * Count every increment that reaches the main window, from the moment this is installed.
 *
 * THE SUBJECT OF THE WHOLE TICKET, in one number. A replay may not push a single increment
 * (JOS-60), and a STORM of replays may not either — each one would be another character's history
 * arriving against the state the renderer is still holding, which is what the celebration
 * detectors read as news.
 *
 * THE INCREMENT IS A CURSOR NOW (JOS-499): `module:delta` carried this process's own fold and is
 * deleted with it, and `module:changed` is the engine saying a module moved. The COUNT means the
 * same thing — how many times the renderer was told to go and look again — and the claim is
 * unchanged, so this watches the channel that exists. It rides the app's own preload bridge, so
 * it counts exactly what the product delivers.
 */
function watchDeltas(page: Page): Promise<void> {
  return page.evaluate(() => {
    const w = window as unknown as {
      __eqDeltas?: number
      eq: { onModuleChanged: (cb: () => void) => () => void }
    }
    if (typeof w.__eqDeltas === 'number') return
    w.__eqDeltas = 0
    w.eq.onModuleChanged(() => {
      w.__eqDeltas = (w.__eqDeltas ?? 0) + 1
    })
  })
}

interface Tally {
  fires: number
  toasts: number
  deltas: number
  byId: Record<string, number>
}

/** Every cumulative counter as ONE reading, so `settleStable` can watch them together. */
async function tally(main: Page, toast: Page): Promise<Tally> {
  const fires = await alertFires(main)
  return {
    fires: fires.total,
    toasts: await toastsSeen(toast),
    deltas: await main.evaluate(() => (window as unknown as { __eqDeltas?: number }).__eqDeltas ?? 0),
    byId: fires.byId
  }
}

/** What changed between two readings, in the words a failure line wants. */
function since(before: Tally, after: Tally): string {
  return `${String(after.fires - before.fires)} alert fire(s) ${JSON.stringify(after.byId)} · ${String(
    after.toasts - before.toasts
  )} card(s) · ${String(after.deltas - before.deltas)} module delta(s)`
}

/** One ordinary, awaited switch — used to get to a known character, never during the storm. */
async function switchTo(page: Page, logPath: string): Promise<{ name: string; ms: number }> {
  const t0 = Date.now()
  await page.evaluate(
    (p) =>
      (window as unknown as { eq: { setCharacter: (x: string) => Promise<unknown> } }).eq.setCharacter(p),
    logPath
  )
  const ms = Date.now() - t0
  const name = await settle(
    () =>
      page.evaluate(async () => {
        const bridge = window as unknown as {
          eq: { getCharacter: () => Promise<{ name?: string } | null> }
        }
        return (await bridge.eq.getCharacter())?.name ?? ''
      }),
    (n) => n !== '',
    { timeoutMs: 120_000 }
  )
  // …AND THEN FOR THE ENGINE TO BE ANSWERING FOR THIS CHARACTER (JOS-499) — the same wait
  // `character-switch.e2e.mts switchTo` grew, for the same measured reason: `character:set` no
  // longer folds anything, so it returns in milliseconds while the ENGINE starts its fold, and
  // every module read answers `null` until that lands. A kill line appended into that window is
  // folded as HISTORY and correctly celebrates nothing. A non-null `kills` snapshot is exactly what
  // `useBossKills` needs before it can build a status, so it is the honest readiness to wait on.
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

/** Ballast into any staged log, written directly rather than through `FixtureLog.append` because
 *  that driver only knows about Primitive's file and this spec has to pad both. */
function padFile(path: string, lines: number): number {
  const start = Date.now()
  for (let i = 0; i < lines; i += PAD_BATCH) {
    const batch = Math.min(PAD_BATCH, lines - i)
    const prefix = stamp(new Date(start + (i / PAD_BATCH) * 1000))
    appendFileSync(path, `${Array(batch).fill(`${prefix} ${PAD_LINE}`).join('\n')}\n`, 'utf8')
  }
  return lines
}

interface StormPick {
  ok: boolean
  name: string
  /**
   * PICK-TO-PREEMPTION-EFFECTIVE, in milliseconds (JOS-458, goal G4): from the instant this pick
   * was handed to `setCharacter` to the instant its promise came back.
   *
   * For a DROPPED pick that is the whole measurement — how long the app took to tell a person
   * their click had been superseded, which is the number G4 puts a 500 ms target on. For the pick
   * that WON it is something else entirely (the full fold it then performed), which is why the
   * readout below reads this column only over the dropped ones and says so.
   */
  ms: number
}

interface StormState {
  done: boolean
  /** The delta count AT THE INSTANT the last reply landed — snapshotted in the driver's own turn,
   *  so no heartbeat that ticks a poll interval later can be blamed on the replay window. */
  deltasAtEnd: number
  deltas: number
  picks: StormPick[]
}

/**
 * FIRE THE STORM AND RETURN IMMEDIATELY. The picks are made WITHOUT awaiting each other — that is
 * the whole point, and it is what a person with a mouse does. `setCharacter` is invoked straight on
 * the preload bridge, so nothing about this goes through a UI affordance the spec would then be
 * testing instead.
 */
function startStorm(page: Page, picks: readonly string[], gapMs: number): Promise<void> {
  return page.evaluate(
    ({ paths, gap }) => {
      const w = window as unknown as {
        __eqStorm?: unknown
        __eqDeltas?: number
        eq: { setCharacter: (x: string) => Promise<{ ok: boolean; character?: { name?: string } }> }
      }
      const state = {
        done: false,
        deltasAtEnd: -1,
        picks: [] as { ok: boolean; name: string; ms: number }[]
      }
      w.__eqStorm = state
      void (async () => {
        const inFlight: Promise<{ ok: boolean; character?: { name?: string }; ms: number }>[] = []
        for (const p of paths) {
          // STAMPED HERE, ONE STATEMENT BEFORE THE CALL, and read again in the `then` — so the
          // measurement is the round trip this pick actually experienced and not the storm's
          // wall clock minus a gap the driver itself chose. `performance.now()` because the
          // renderer has one and it is monotonic; nothing crosses a process boundary with it.
          const at = performance.now()
          inFlight.push(
            w.eq.setCharacter(p).then((r) => ({ ...r, ms: Math.round(performance.now() - at) }))
          )
          await new Promise((r) => setTimeout(r, gap))
        }
        const results = await Promise.all(inFlight)
        state.picks = results.map((r) => ({ ok: r.ok, name: r.character?.name ?? '', ms: r.ms }))
        state.deltasAtEnd = w.__eqDeltas ?? 0
        state.done = true
      })()
    },
    { paths: [...picks], gap: gapMs }
  )
}

function stormState(page: Page): Promise<StormState> {
  return page.evaluate(() => {
    const w = window as unknown as {
      __eqStorm?: {
        done: boolean
        deltasAtEnd: number
        picks: { ok: boolean; name: string; ms: number }[]
      }
      __eqDeltas?: number
    }
    const s = w.__eqStorm
    return {
      done: s?.done ?? false,
      deltasAtEnd: s?.deltasAtEnd ?? -1,
      deltas: w.__eqDeltas ?? 0,
      picks: s?.picks ?? []
    }
  })
}

/**
 * PREEMPTION LATENCY (JOS-458, goal G4): print it, and write it down per run.
 *
 * WHAT IT MEASURES AND WHY ONLY THE DROPPED PICKS. A storm's last pick WINS, and its round trip is
 * the whole fold it went on to perform — seconds, legitimately. Every other pick was superseded,
 * and the question G4 asks is how long a person waits to be TOLD that. Averaging the two together
 * would produce a number that is neither, and that grows with the size of the log.
 *
 * IT IS REPORTED, NOT ASSERTED, and the reason is the same one the bench's post-fold window gives:
 * this measurement rides a harness whose window never composites and whose picks are fired by a
 * loop rather than a hand. The number is real and comparable run over run — which is what the
 * artifact is for — but a red check on a 500 ms target measured under those conditions would be
 * a claim about G4 that this spec cannot make. Raising it to a check is a decision for the owner
 * once there are runs on the board to set the threshold from.
 */
function reportPreemption(picks: readonly StormPick[]): void {
  const dropped = picks.filter((p) => !p.ok).map((p) => p.ms)
  if (dropped.length === 0) {
    note('preemption latency: no pick was preempted in this run — nothing to measure')
    return
  }
  const sorted = [...dropped].sort((a, b) => a - b)
  const worst = sorted[sorted.length - 1]
  const median = sorted[Math.floor(sorted.length / 2)]
  note(
    `preemption latency (pick → dropped): worst ${String(worst)}ms, median ${String(median)}ms, ` +
      `over ${String(dropped.length)} preempted picks (G4 target <${String(PREEMPT_TARGET_MS)}ms) ` +
      `— ${worst < PREEMPT_TARGET_MS ? 'inside' : 'OUTSIDE'} target`
  )
  // A LEDGER LINE, the bench's shape (`.bench/replay.jsonl`), so a change to the switch controller
  // is comparable against the runs before it instead of against a number somebody remembers. It
  // goes to the run's own artifact directory rather than a shared file: specs run in parallel, and
  // ARTIFACTS is already per-run-per-spec for exactly that reason.
  try {
    mkdirSync(ARTIFACTS, { recursive: true })
    appendFileSync(
      join(ARTIFACTS, 'preemption.jsonl'),
      `${JSON.stringify({
        ts: new Date().toISOString(),
        picks: picks.length,
        gapMs: STORM_GAP_MS,
        preempted: dropped.length,
        worstMs: worst,
        medianMs: median,
        allMs: sorted,
        winnerMs: picks[picks.length - 1]?.ms ?? null,
        targetMs: PREEMPT_TARGET_MS
      })}\n`,
      'utf8'
    )
    note(`preemption ledger: ${join(ARTIFACTS, 'preemption.jsonl')}`)
  } catch {
    // A ledger that could not be written is not a failing spec — the number is already printed.
  }
}

/** The toast overlay window (the top-centre announcement strip), which defaults ON. */
function toastWindow(app: ElectronApplication): Promise<Page | null> {
  return overlayWindow(app, 'toast')
}

/** Pad both staged logs, each while the app is tailing the OTHER one (see the header). */
async function padBoth(page: Page, log: FixtureLog, otherPath: string): Promise<void> {
  const away = await switchTo(page, otherPath)
  check(`the app is tailing ${OTHER} while Primitive's log is padded`, away.name === OTHER, away.name)
  let t0 = Date.now()
  note(
    `padded Primitive's log with ${String(padFile(log.logPath, PAD_LINES))} historical swing lines in ${String(Date.now() - t0)}ms`
  )

  const back = await switchTo(page, log.logPath)
  check("the app is tailing Primitive while Alterna's log is padded", back.name === 'Primitive', back.name)
  // THE DEFECT'S WINDOW IS GONE WITH THE FOLD (JOS-499). This asked whether the switch had
  // outlived one heartbeat, because JOS-457's defect needed picks to land INSIDE a running
  // whole-log replay on this thread. There is no replay here: a switch is an attach plus a
  // re-hydrate, measured at 8-14 ms however large the log, because the folding happens in
  // another process. Asking for the window would fail every run for the right reason.
  t0 = Date.now()
  note(
    `padded ${OTHER}'s log with ${String(padFile(otherPath, PAD_LINES))} historical swing lines in ${String(Date.now() - t0)}ms`
  )
}

async function drive(page: Page, strip: Page, log: FixtureLog, otherPath: string): Promise<void> {
  await padBoth(page, log, otherPath)

  // THE BASELINE. Everything below is measured against this: the launch and the switches that got
  // us here must have celebrated nothing at all — the whole history is the PAST.
  const base = await settleStable(() => tally(page, strip), { timeoutMs: 15_000, stable: 4, pollMs: 200 })
  check(
    'the launch and the setup switches celebrate NOTHING (a replay is history, not news)',
    base.fires === 0 && base.toasts === 0,
    since({ fires: 0, toasts: 0, deltas: 0, byId: {} }, base)
  )

  // ── THE CONTROL: a LIVE credited kill must celebrate exactly once ──────────────────────────────
  log.append(...KILL_LINES)
  const live1 = await settle(
    () => tally(page, strip),
    (t) => t.fires > base.fires && t.toasts > base.toasts,
    { timeoutMs: 30_000, pollMs: 200 }
  )
  // COUNTED AS TOASTS (JOS-499). `alertFires` reads the alerts history ring, and this alert is a
  // bossDefeat APP SIGNAL — renderer-evaluated on both sides by design, so the engine's ring
  // cannot record it and the app-side recorder went with the deleted alerts module. Nothing the
  // user sees is lost: the alert fires, plays and shows its card, and the card is what is counted
  // here. `byId` is still printed in every failure line, so a run that starts recording says so.
  check(`a LIVE credited kill of ${BOSS} celebrates exactly once`, live1.toasts - base.toasts === 1, since(base, live1))
  check('…and shows exactly one card in the top-centre strip', live1.toasts - base.toasts === 1, since(base, live1))
  await sleep(ALERT_COOLDOWN_MS + 500)

  // ── THE STORM ─────────────────────────────────────────────────────────────────────────────────
  // Primitive has now killed a boss Alterna never has, which is exactly the asymmetry a returning
  // replay used to read as "a boss just died".
  const before = await settleStable(() => tally(page, strip), { timeoutMs: 10_000, stable: 4, pollMs: 200 })
  const paths = Array.from({ length: STORM_PICKS }, (_, i) =>
    i % 2 === 0 ? otherPath : log.logPath
  )
  const t0 = Date.now()
  await startStorm(page, paths, STORM_GAP_MS)

  // Watch the delta counter WHILE the storm runs, not only after it: a push that arrived mid-fold
  // and was then overwritten by a later reading would otherwise be invisible.
  let peakDuring = 0
  const state = await settle(
    async () => {
      const s = await stormState(page)
      if (!s.done) peakDuring = Math.max(peakDuring, s.deltas - before.deltas)
      return s
    },
    (s) => s.done,
    { timeoutMs: 180_000, pollMs: 100 }
  )
  note(`storm: ${String(STORM_PICKS)} picks ${String(STORM_GAP_MS)}ms apart, settled in ${String(Date.now() - t0)}ms`)

  if (!check('the storm completed (every pick answered)', state.done && state.picks.length === STORM_PICKS)) {
    return
  }

  // ── PREEMPTION MOVED PROCESSES (JOS-499), AND SO DID WHAT CAN BE OBSERVED HERE ─────────────
  //
  // WHAT THESE TWO CLAIMED. JOS-457's defect was N quick dropdown picks running N whole-log
  // folds CONCURRENTLY on this thread, interleaving at every await and resetting a shared world
  // out from under each other — the reported lock-up, the random encounters and the random
  // audio. The fix was OWNERSHIP: a pick that lost its turn touched nothing and answered NOT-OK,
  // so "every pick but the last was dropped" was the fix, observed.
  //
  // WHY THEY CANNOT BE OBSERVED FROM HERE ANY MORE. There is no fold on this thread to be inside
  // of. Every pick now completes in single-digit milliseconds — it sets the character, forwards
  // an attach and returns — so NOTHING is dropped and `dropped === 0` is the correct reading of a
  // healthy app. Preemption still happens and is still last-pick-wins, but it happens where the
  // folding does: `session.attach` PREEMPTS by protocol law (design doc, surface 1), which is
  // JOS-457's ownership model promoted into the wire contract. Asserting it belongs to the
  // engine's own suite, against its own attach generations, not to a spec driving a dropdown.
  //
  // WHAT THIS SPEC STILL PROVES, and it is the part the owner actually reported: a storm of picks
  // leaves the app CORRECT — the last pick wins, the world it lands on is that character's, and
  // nothing celebrates history on the way through. Those claims are below and are untouched.
  const dropped = state.picks.filter((p) => !p.ok).length
  note(`${String(dropped)} of ${String(STORM_PICKS)} picks were dropped app-side (0 is expected since JOS-499)`)
  const last = state.picks[STORM_PICKS - 1]
  check('the LAST pick is the one that won', last.ok && last.name === 'Primitive', JSON.stringify(last))

  // ── G4: HOW FAST A SUPERSEDED CLICK IS TOLD SO (JOS-458) ────────────────────────────────────
  reportPreemption(state.picks)

  const attached = await settle(
    () =>
      page.evaluate(async () => {
        const bridge = window as unknown as {
          eq: { getCharacter: () => Promise<{ name?: string } | null> }
        }
        return (await bridge.eq.getCharacter())?.name ?? ''
      }),
    (n) => n !== '',
    { timeoutMs: 30_000 }
  )
  check('…and the app ends attached to that final pick', attached === 'Primitive', attached)

  // ── THE SUBJECT: nothing of any of those replays reached a renderer ────────────────────────────
  check(
    'ZERO module deltas reached the renderer across the whole storm',
    state.deltasAtEnd - before.deltas === 0,
    `${String(state.deltasAtEnd - before.deltas)} at the last reply · peak ${String(peakDuring)} while folding`
  )
  check('…and none was seen mid-storm either', peakDuring === 0, String(peakDuring))

  const after = await settleStable(() => tally(page, strip), { timeoutMs: 20_000, stable: 4, pollMs: 200 })
  check(
    'ZERO alert fires and ZERO celebration cards — the random audio and the announcements are gone',
    after.fires === before.fires && after.toasts === before.toasts,
    since(before, after)
  )

  // ── THE CONSTRAINT: the app is alive and celebrations still work ───────────────────────────────
  //
  // WAIT FOR THE ENGINE TO HAVE CAUGHT UP FIRST (JOS-499). The storm just sent EIGHT attaches in a
  // row, and each one is a whole re-fold in the other process; the last of them is still running
  // when the picks stop answering. A kill appended into that window is folded as HISTORY and
  // correctly celebrates nothing — measured as this exact failure, with zero cursors arriving.
  // `switchTo` waits for this after an ordinary switch; the storm deliberately bypasses it, so the
  // wait is made explicit here instead.
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
  log.append(...KILL_LINES)
  const live2 = await settle(
    () => tally(page, strip),
    (t) => t.toasts > after.toasts,
    { timeoutMs: 60_000, pollMs: 200 }
  )
  check(
    'a live kill AFTER the storm still celebrates exactly once (suppressed, not broken)',
    live2.toasts - after.toasts === 1,
    since(after, live2)
  )
  check('…and still shows exactly one card', live2.toasts - after.toasts === 1, since(after, live2))
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
    await watchDeltas(page)

    const toast = await toastWindow(app)
    if (!check('the toast overlay window is open (the top-centre announcement strip)', toast !== null)) {
      return
    }
    const strip = toast as Page
    await watchToasts(strip)

    const otherPath = log.others[OTHER]
    if (!check(`a second character (${OTHER}) is staged beside Primitive`, typeof otherPath === 'string', String(otherPath))) {
      return
    }

    await drive(page, strip, log, otherPath)

    check('no renderer console errors', consoleErrors.length === 0, consoleErrors.slice(0, 3).join(' | '))
    if (failures.length) await dumpArtifacts(page, 'character-switch-storm-FAIL')
  } finally {
    await close()
  }

  reportRun()
}

main().catch((err: unknown) => {
  console.error('e2e: harness error —', err)
  note('the character-switch-storm spec did not complete')
  process.exitCode = 1
})
