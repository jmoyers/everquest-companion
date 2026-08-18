// buffRestartSteps — THE COLD START WITH THE OVERLAY ALREADY OPEN (JOS-172).
//
// Its own module for the reason `buffTimerSteps.mts` and `overlayTotalSteps.mts` are: the spec
// that uses it is at the repo's 400-code-line factoring ceiling, and this step is a SECOND LAUNCH
// with a narrative of its own.
//
// WHAT IT IS FOR. Every other assertion in buffs-overlay.e2e.mts opens the window AFTER the app
// has started, which is the one arrangement the defect cannot appear in. The owner's was the
// other one: quit with the window open, start again, and a debuff that genuinely survived the
// historical fold — a charm, an Ensnare — was in the model, on screen in the app, and missing
// from the floating window whose entire job is to show it. An overlay window hydrated ONCE,
// part-way through the fold, and then rode only deltas — and `endReplay()` discards everything
// the fold accumulated, so no delta ever described the rest of it (the mechanism, and the
// unit-level half of the evidence, are in tests/overlayRehydrate.test.mts).
//
// ENSNARE, AND WHY. It is a real druid/ranger snare in the committed spells.json, `11 Min`, so it
// is still standing minutes later when the next launch has finished re-folding the log — which is
// exactly the class of debuff the report is about. `You begin casting Ensnare.` is what narrows
// the landing broadcast (`… has been ensnared.` is Snare AND Ensnare — JOS-84's law), so the row
// can name the spell and count down from a duration the DB states rather than up from nothing.
//
// WAIT FOR THE CONDITION, NEVER FOR THE CLOCK (wave E3): every read goes through `settle`.

import type { ElectronApplication, Page } from 'playwright-core'
import { check, note, settle, settleStable, snapshot, waitHydrated } from './appHarness.mjs'
import { mainWindow, overlayWindow } from './appWindow.mjs'
import { launchOnFixture, type FixtureLog } from './logFixture.mjs'
import { timerRows } from './buffTimerSteps.mjs'
// THE ALLOW-LIST'S OWN RESTART CLAIM (JOS-168). It rides THIS launch rather than getting a third
// one of its own: the preference is in the settings store and is not part of any module snapshot,
// so what has to be proved is exactly that a quit and a whole-world re-fold leave it alone — and
// this is the launch that performs both.
import { stepAllowSurvivesRestart } from './buffAllowSteps.mjs'

const SPELL = 'Ensnare'
/**
 * TWO ENEMIES, ON TWO SIDES OF THE MOMENT THE OVERLAY HYDRATES — which is the whole design of this
 * step. `EARLY` is snared while launch 1 is running, so launch 2 re-folds it near the START of the
 * log and a mid-fold hydrate ALREADY HOLDS IT. `LATE` is snared behind the padding below, so the
 * fold reaches it only after that hydrate has happened — and it is therefore the row that can only
 * arrive by re-hydration. Asserting both is what separates "the window has some rows" from "the
 * window has the rows the fold finished with". Ordinary Plane of Fear trash, the same two names
 * the chain-mez step uses.
 */
const SNARED_EARLY = 'a turmoil toad'
const SNARED_LATE = 'a scareling'

/** The real two-line shape: the cast that names the rank, then the landing broadcast a second on. */
function castEnsnare(log: FixtureLog, target: string): void {
  const at = new Date()
  log.appendAt(at, `You begin casting ${SPELL}.`)
  log.appendAt(new Date(at.getTime() + 1_000), `${target} has been ensnared.`)
}

interface OverlayBridge {
  getOverlayState: () => Promise<Record<string, boolean>>
  toggleOverlay: (k: string) => Promise<boolean>
}
function state(page: Page): Promise<Record<string, boolean>> {
  return page.evaluate(() => (window as unknown as { eq: OverlayBridge }).eq.getOverlayState())
}
/** ASK, NEVER TOGGLE BLIND: `overlay:toggle` is a toggle and the open-state is PERSISTED. */
async function ensureOpen(page: Page, kind: string): Promise<void> {
  await page.evaluate(async (k) => {
    const eq = (window as unknown as { eq: OverlayBridge }).eq
    if (!(await eq.getOverlayState())[k]) await eq.toggleOverlay(k)
  }, kind)
}

/**
 * THE FOLD HAS TO OUTLAST THE WINDOW'S PAGE LOAD, AND THAT IS MEASURED, NOT ASSUMED.
 *
 * The defect needs an overlay that hydrates PART-WAY through the fold. On the owner's own log —
 * 1.4M lines, ~8.5 s — that is every launch. On a 1.6k-line committed fixture the fold is over in
 * a few tens of milliseconds, long before a second BrowserWindow has finished loading its bundle:
 * MEASURED here first, and the step read `hydrating: false` at the instant the overlay bridge came
 * up, i.e. it would have passed with the bug still in place.
 *
 * So the restart launch reads a log with a REAL fold in front of the row under test. The padding
 * is one real line out of this very fixture (`e2e-overlay.log` line 8), replayed through the hot
 * path a fold actually spends its time in — parser, then every module, then the engine — so what
 * is bought is fold TIME rather than a special case. MEASURED: 400k lines is a ~4 s fold on this
 * machine, and the overlay bridges come up inside it.
 *
 * The number is a floor with headroom, not a stopwatch: `stepRestartRehydrate` CHECKS that the
 * fold really was still running, so a machine fast enough to finish it anyway fails loudly instead
 * of quietly asserting nothing.
 */
const PAD_LINES = 400_000
const PAD_CHUNK = 5_000
const PAD_LINE = 'You strike a fire giant warrior for 38 points of damage.'

function padForASlowFold(log: FixtureLog): void {
  const at = new Date()
  for (let written = 0; written < PAD_LINES; written += PAD_CHUNK) {
    // In chunks: `appendAt` takes its messages as a rest parameter, and spreading a
    // several-hundred-thousand-element array into a call is a stack overflow, not a big write.
    log.appendAt(at, ...(Array.from({ length: PAD_CHUNK }, () => PAD_LINE) as string[]))
  }
}

/** The drop notices currently on a timer window (the buffs surface's flash). */
function dropNotices(overlay: Page): Promise<string[]> {
  return overlay.evaluate(() =>
    [...document.querySelectorAll('[data-testid="buff-timer-drop"]')].map((e) => e.textContent?.trim() ?? '')
  )
}

/** The Ensnare row for one enemy, whichever arrangement the window is drawn in. */
function snareOn(rows: { name: string; target: string; mode: string }[], target: string): { name: string; target: string; mode: string } | undefined {
  return rows.find((r) => r.name === SPELL && r.target.includes(target))
}

/**
 * LAUNCH 1 EXISTS TO LEAVE STATE BEHIND (the overlay-sync precedent): both timer windows OPEN in
 * the store, and a long debuff standing in the log the next launch will re-fold.
 *
 * The snare is played into the LIVE log and read back before we quit, so the next launch's
 * assertion cannot be blamed on a sentence the model never accepted in the first place.
 */
export async function seedRestart(page: Page, app: ElectronApplication, log: FixtureLog): Promise<void> {
  await ensureOpen(page, 'buffs')
  await ensureOpen(page, 'debuffs')
  const open = await settle(() => state(page), (s) => s.buffs === true && s.debuffs === true, {
    timeoutMs: 15_000
  })
  if (
    !check(
      'launch 1 leaves BOTH timer overlays open in the store',
      open.buffs === true && open.debuffs === true,
      JSON.stringify(open)
    )
  ) {
    return
  }
  const overlay = await overlayWindow(app, 'debuffs')
  if (!check('…and the debuffs window is back on screen to receive the snare', overlay !== null)) return

  castEnsnare(log, SNARED_EARLY)
  const rows = await settle(() => timerRows(overlay as Page), (r) => snareOn(r, SNARED_EARLY) !== undefined, {
    timeoutMs: 30_000
  })
  check(
    'a long debuff cast live lands on the debuffs window before the restart',
    snareOn(rows, SNARED_EARLY) !== undefined,
    JSON.stringify(rows.map((r) => `${r.name}|${r.target}`))
  )
}

/**
 * LAUNCH 2: the app starts with both windows already open, re-folds the whole log, and the row the
 * END of that fold rebuilt has to reach a window that hydrated in the MIDDLE of it.
 *
 * The overlay pages are taken FIRST, before the hydration wait, and the app's own `hydrating` flag
 * is read at that instant — so the run states, and asserts, that it really reproduced the mid-fold
 * hydrate rather than quietly passing on a fold that was over before the window had loaded.
 */
export async function stepRestartRehydrate(log: FixtureLog, userData: string): Promise<void> {
  console.log('launch 2: the timer overlays were already open when the app started…')
  padForASlowFold(log)
  // BEHIND the padding, so the fold reaches it last — see SNARED_LATE.
  castEnsnare(log, SNARED_LATE)

  const { app, close } = await launchOnFixture(log, { userData })
  const consoleErrors: string[] = []
  try {
    const page = await mainWindow(app)
    const debuffs = await overlayWindow(app, 'debuffs')
    const buffs = await overlayWindow(app, 'buffs')
    if (!check('a restart brings both timer overlays back by itself', debuffs !== null && buffs !== null)) return
    for (const [kind, o] of [['buffs', buffs] as const, ['debuffs', debuffs] as const]) {
      o?.on('console', (m) => {
        if (m.type() === 'error') consoleErrors.push(`${kind} overlay: ${m.text()}`)
      })
    }

    // THE STEP'S OWN PREMISE, ASSERTED. Everything below is only a test of the delivery if these
    // windows hydrated while the fold was still running — see `padForASlowFold`. A machine that
    // finished the fold anyway must say so here rather than pass on an arrangement the defect
    // could never appear in.
    const midFold = await snapshot(page)
      .then((s) => s.hydrating)
      .catch(() => false)
    check(
      'the historical fold is STILL RUNNING when the overlay bridges come up (the mid-fold hydrate this is about)',
      midFold,
      `hydrating=${String(midFold)} behind ${String(PAD_LINES)} padding lines`
    )
    const hydrated = await waitHydrated(page)
    note(`the padded fold took ${String(hydrated.ms)} ms`)

    // THE TICKET. The row the fold finished with reaches the window that was already open.
    const rows = await settle(() => timerRows(debuffs as Page), (r) => snareOn(r, SNARED_LATE) !== undefined, {
      timeoutMs: 45_000
    })
    const late = snareOn(rows, SNARED_LATE)
    const listed = JSON.stringify(rows.map((r) => `${r.name}|${r.target}`))
    if (
      !check(
        'a debuff folded AFTER the overlay hydrated reaches an overlay that was ALREADY OPEN',
        late !== undefined,
        listed
      )
    ) {
      return
    }
    check('…naming the enemy it is still on', late?.target.includes(SNARED_LATE) === true, JSON.stringify(late))
    check('…and counting DOWN from the duration spells.json states', late?.mode === 'countdown', JSON.stringify(late))
    // …and the half a mid-fold hydrate could already see is still there beside it: a re-hydrate
    // REPLACES the window's world, so a fix that dropped what it already held would be no fix.
    check('…while the debuff the mid-fold snapshot already held is still standing', snareOn(rows, SNARED_EARLY) !== undefined, listed)

    // NO PHANTOM DROP-FLASH. The mid-fold hydrate and the post-fold one are two readings of the
    // same log at two different instants, so buffs legitimately disappear between them — every one
    // of which would flash as a fresh loss the first time the user ever looks at the window.
    // settleStable, because the claim is an ABSENCE (wave E3's rule).
    const drops = await settleStable(() => dropNotices(buffs as Page), { timeoutMs: 15_000 })
    check(
      'and the buffs window announces NO drops for a re-hydrate — a rebuild is not a loss',
      drops.length === 0,
      JSON.stringify(drops)
    )
    await stepAllowSurvivesRestart(page, buffs)

    check('no overlay console errors across the restart', consoleErrors.length === 0, consoleErrors.slice(0, 3).join(' | '))
  } finally {
    await close()
  }
}
