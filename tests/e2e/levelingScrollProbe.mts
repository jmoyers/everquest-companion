/**
 * levelingScrollProbe.mts — A DIAGNOSTIC PROBE, NOT A SPEC (JOS-509 investigation).
 *
 * The owner reports hitching while SCROLLING the Leveling page and suspects React. This file is
 * the instrument that answers it with numbers. It asserts NOTHING and gates NOTHING: it drives one
 * realistic scroll four different ways over one launch and prints what each one cost.
 *
 * ── WHY THE NAME HAS NO `.e2e.` IN IT ──────────────────────────────────────────────────────────
 *
 * `run-all.mts:212` discovers specs with `readdirSync(here).filter((f) => f.endsWith('.e2e.mts'))`.
 * A probe that measures rather than asserts has no business in the sweep — it would burn a launch
 * slot and could never fail usefully — so it is kept out by the ONE property the runner reads,
 * rather than by an exclusion list somebody has to remember to update.
 *
 *   node --import tsx tests/e2e/levelingScrollProbe.mts
 *
 * ── THE INSTRUMENT, AND THE ONE THE BRIEF ASKED FOR THAT DOES NOT WORK HERE ────────────────────
 *
 * The obvious instrument is rAF frame deltas. IT IS INVALID IN THIS HARNESS, and the repo has
 * already paid to learn it twice: `EQ_E2E=1` never shows the window, so it is never composited,
 * `requestAnimationFrame` can be throttled to nothing and `backgroundThrottling` can stretch a
 * timer to a second (AGENTS.md records both traps; dragPerfSteps.mts:41-45 records the decision to
 * profile instead). A frame-delta histogram from this window would be a measurement of Chromium's
 * idle policy, not of the Leveling page.
 *
 * SO THE PRIMARY INSTRUMENT IS THE CDP SAMPLING PROFILER, exactly as `stepDragCost` uses it:
 * non-idle main-thread milliseconds over a fixed gesture. A hitch IS main-thread occupancy, so
 * this measures the thing itself rather than a proxy for it, and it cares about neither trap.
 * `PerformanceObserver('longtask')` is captured beside it as a corroborating signal only.
 *
 * Three ATTRIBUTION counters run alongside, because "it cost 900 ms" is a symptom and this ticket
 * needs a mechanism:
 *   • REACT COMMITS — via a minimal `__REACT_DEVTOOLS_GLOBAL_HOOK__` shim installed with
 *     `addInitScript` before react-dom evaluates (hence the reload below).
 *   • DOM MUTATIONS — a MutationObserver over the one scroller.
 *   • ENGINE PUSHES — an extra `window.eq.onModuleChanged` listener, per moduleId.
 *
 * ── THE FOUR ARMS, AND WHAT EACH DIFFERENCE ISOLATES ───────────────────────────────────────────
 *
 *   WARMUP  discarded. First scroll pays for lazy work no later arm should be charged for.
 *   QUIET_NOHOVER  engine silent, `pointer-events:none` over the scroller.  → the floor: layout,
 *                  paint and style for an unvirtualized list (suspects S4/S5).
 *   QUIET_HOVER    engine silent, pointer live over the rows.  (QUIET_HOVER − QUIET_NOHOVER) is
 *                  what the hover machinery costs while rows slide under the cursor (S2).
 *   LIVE_HOVER     the log is being appended to throughout, so `moduleChanged` pushes land DURING
 *                  the scroll.  (LIVE_HOVER − QUIET_HOVER) is what the cursor-push re-render costs
 *                  (S1).
 *
 * ORDER IS FIXED AND THE REASON IS STATED: the live arm APPENDS, which moves the world the earlier
 * arms measured, so it can only run last. The scroller is returned to the top and the engine is
 * waited back into silence between arms, and the warmup absorbs first-run cost — but this remains
 * a within-launch comparison and the run-to-run spread in the summary is the honest error bar.
 */
import type { CDPSession, ElectronApplication, Page } from 'playwright-core'
import { buildEngineIfStale, buildIfStale } from './build.mjs'
import { launchOnRealInstall, mainWindow } from './appWindow.mjs'
import { launchOnFixture, type FixtureLog } from './logFixture.mjs'
import { waitHydrated } from './appHarness.mjs'
import { dismissFirstRunNotice } from './levelingLayoutSteps.mjs'

/**
 * `--real` launches on the OWNER'S OWN INSTALL instead of the staged fixture.
 *
 * It is the higher-fidelity arm and the reason is measurable rather than sentimental: the committed
 * fixture was cut for the CHARTS and carries no loot at all, so `WindowDropsPanel` draws its empty
 * state there while the owner's log gives it 641 rows (the panel's own header measures this). The
 * fixture is the reproducible control; the real install is the page the owner is complaining about.
 * Nothing from a real-install run is ever committed.
 */
const REAL = process.argv.includes('--real')

const CONTENT = '[data-testid="app-content"]'
const NAV = '[data-testid="nav-leveling"]'
const VIEW = '[data-testid="leveling-view"]'

/** Wheel ticks per episode, and the pixels each one asks for. ~40 ticks is a few seconds of real
 *  scrolling and enough samples for the profiler at a 100 us interval. */
const TICKS = 40
const WHEEL_PX = 120

/** How long the engine must say nothing before an arm counts as running in silence. */
const QUIET_MS = 2_500
const QUIET_TIMEOUT_MS = 45_000

interface ProfileNode {
  id: number
  callFrame: { functionName: string; url: string; lineNumber: number }
  children?: number[]
}
interface Profile {
  nodes: ProfileNode[]
  samples?: number[]
  timeDeltas?: number[]
  startTime: number
  endTime: number
}

interface Counters {
  commits: number
  mutations: number
  longtasks: number
  longtaskMs: number
  pushes: Record<string, number>
}

export interface ArmResult {
  arm: string
  busyMs: number
  perTick: number
  /** Wall time the profiler was running, so arms of different shapes stay comparable. */
  wallMs: number
  counters: Counters
  top: { fn: string; ms: number }[]
  links: number
}

/** The busiest module's push count — every module ships its cursor in LOCKSTEP (measured: identical
 *  counts across all 16-17 of them in every arm), so the max IS the number of world ticks. */
function pushTicks(c: Counters): number {
  return Math.max(0, ...Object.values(c.pushes))
}

/** Non-idle main-thread milliseconds, and the self-cost of the busiest functions beside it.
 *  `timeDeltas` is used when the profile carries it — a sample is only worth the time it stood
 *  for, and assuming a uniform interval smears a burst across an idle stretch. */
function analyse(p: Profile, topN: number): { busyMs: number; top: { fn: string; ms: number }[] } {
  const byId = new Map(p.nodes.map((n) => [n.id, n]))
  const samples = p.samples ?? []
  const deltas = p.timeDeltas ?? []
  const uniform = (p.endTime - p.startTime) / Math.max(1, samples.length)
  const self = new Map<string, number>()
  let busy = 0
  for (let i = 0; i < samples.length; i++) {
    const node = byId.get(samples[i] as number)
    if (!node) continue
    const us = deltas.length === samples.length ? Math.max(0, deltas[i] as number) : uniform
    const fn = node.callFrame.functionName
    if (fn === '(idle)') continue
    busy += us
    // `(program)`/`(garbage collector)` are kept: they are real occupancy and dropping them would
    // flatter whichever arm provoked the most allocation.
    const where = node.callFrame.url ? `${fn || '(anonymous)'} @ ${node.callFrame.url.split('/').pop() ?? ''}:${String(node.callFrame.lineNumber + 1)}` : fn || '(anonymous)'
    self.set(where, (self.get(where) ?? 0) + us)
  }
  const top = [...self.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, topN)
    .map(([fn, us]) => ({ fn, ms: us / 1000 }))
  return { busyMs: busy / 1000, top }
}

/**
 * The DevTools hook shim, installed before react-dom evaluates.
 *
 * React calls `inject` once per renderer and `onCommitFiberRoot` once per COMMIT, which is exactly
 * the count this probe wants and the one a MutationObserver cannot give (a re-render that produces
 * identical DOM mutates nothing and still costs a reconciliation). The shim is deliberately inert
 * otherwise: it walks no fiber tree, because walking one inside the measured window would put the
 * probe's own cost into the profile it is taking.
 */
function installReactHook(): void {
  const w = window as unknown as Record<string, unknown>
  w.__probeCommits = 0
  w.__REACT_DEVTOOLS_GLOBAL_HOOK__ = {
    supportsFiber: true,
    renderers: new Map(),
    inject(renderer: unknown): number {
      const r = (this as { renderers: Map<number, unknown> }).renderers
      const id = r.size + 1
      r.set(id, renderer)
      return id
    },
    onCommitFiberRoot(): void {
      w.__probeCommits = (w.__probeCommits as number) + 1
    },
    onPostCommitFiberRoot(): void {
      /* not counted: a commit is already counted above */
    },
    onCommitFiberUnmount(): void {
      /* unmounts are not the question here */
    },
    checkDCE(): void {
      /* react calls this to detect a dev build shipped to production */
    },
    on(): void {
      /* the devtools event bus; nothing subscribes in this probe */
    },
    off(): void {
      /* see on() */
    },
    sub(): () => void {
      return () => undefined
    },
    emit(): void {
      /* see on() */
    }
  }
}

/** Start the in-page counters. Returns nothing; `stopCounters` reads them back. */
function startCounters(contentSel: string): void {
  const w = window as unknown as Record<string, unknown>
  const pushes: Record<string, number> = {}
  const base = (w.__probeCommits as number | undefined) ?? 0
  let mutations = 0
  let longtasks = 0
  let longtaskMs = 0

  const mo = new MutationObserver((records) => {
    mutations += records.length
  })
  const root = document.querySelector(contentSel)
  if (root) mo.observe(root, { childList: true, subtree: true, attributes: true, characterData: true })

  let po: PerformanceObserver | null = null
  try {
    po = new PerformanceObserver((list) => {
      for (const e of list.getEntries()) {
        longtasks++
        longtaskMs += e.duration
      }
    })
    po.observe({ entryTypes: ['longtask'] })
  } catch {
    // longtask is a corroborating signal only; a build without it costs the probe nothing.
    po = null
  }

  const eq = (w.eq ?? {}) as { onModuleChanged?: (cb: (c: { moduleId: string }) => void) => () => void }
  const offPush = eq.onModuleChanged
    ? eq.onModuleChanged((c) => {
        pushes[c.moduleId] = (pushes[c.moduleId] ?? 0) + 1
      })
    : (): void => undefined

  w.__probeStop = (): Counters => {
    mo.disconnect()
    po?.disconnect()
    offPush()
    return {
      commits: ((w.__probeCommits as number | undefined) ?? 0) - base,
      mutations,
      longtasks,
      longtaskMs,
      pushes
    }
  }
}

function stopCounters(): Counters {
  const w = window as unknown as Record<string, unknown>
  const stop = w.__probeStop as (() => Counters) | undefined
  return stop ? stop() : { commits: 0, mutations: 0, longtasks: 0, longtaskMs: 0, pushes: {} }
}

/** Wait until no `moduleChanged` push has arrived for `QUIET_MS`. The live arm is the only one
 *  that wants pushes; every other arm is a claim about a page nobody is pushing at. */
async function settleQuiet(page: Page): Promise<boolean> {
  await page.evaluate(() => {
    const w = window as unknown as Record<string, unknown>
    const eq = (w.eq ?? {}) as { onModuleChanged?: (cb: () => void) => () => void }
    ;(w.__probeOffQuiet as (() => void) | undefined)?.()
    w.__probeLastPush = Date.now()
    w.__probeOffQuiet = eq.onModuleChanged
      ? eq.onModuleChanged(() => {
          w.__probeLastPush = Date.now()
        })
      : (): void => undefined
  })
  const deadline = Date.now() + QUIET_TIMEOUT_MS
  while (Date.now() < deadline) {
    const since = await page.evaluate(() => Date.now() - ((window as unknown as Record<string, number>).__probeLastPush ?? 0))
    if (since >= QUIET_MS) return true
    await page.evaluate((ms) => new Promise((r) => setTimeout(r, ms)), 400)
  }
  return false
}

/** Where the spell names are, and how many of them there are. Since JOS-508 every linked spell
 *  name carries `role="link"`, which makes the densest part of the page findable rather than
 *  guessed at — and the count is itself evidence for the unvirtualized-list suspect. */
async function linkField(page: Page): Promise<{ x: number; y: number; n: number }> {
  return page.evaluate((contentSel) => {
    const box = document.querySelector(contentSel)?.getBoundingClientRect()
    const links = Array.from(document.querySelectorAll('[role="link"]'))
    const cx = box ? box.left + box.width * 0.5 : 400
    const cy = box ? box.top + box.height * 0.5 : 400
    if (links.length === 0) return { x: cx, y: cy, n: 0 }
    // The MEDIAN link's centre: a point rows genuinely slide under, rather than the middle of a
    // box whose middle may be a chart.
    const rects = links.map((l) => l.getBoundingClientRect()).sort((a, b) => a.top - b.top)
    const mid = rects[Math.floor(rects.length / 2)] as DOMRect
    return { x: Math.round(mid.left + mid.width / 2), y: Math.round(cy), n: links.length }
  }, CONTENT)
}

/**
 * WHAT IS ACTUALLY ON THE PAGE when the arms run.
 *
 * Run 1 of this probe measured a hover arm with ZERO spell names under the cursor and did not say
 * so — the numbers looked like a finding and were an artefact. A census printed beside every run is
 * what makes that failure visible instead of silent, and the row counts are themselves the evidence
 * for the unvirtualized-list suspect.
 */
// NO const-ASSIGNED ARROW INSIDE THIS FUNCTION, and the reason is a real failure rather than
// style: tsx/esbuild compiles a named arrow with a `__name(...)` keepNames wrapper, and a function
// serialized into `page.evaluate` carries that call into a page where the helper does not exist.
// Run 2 of this probe died on exactly that (`ReferenceError: __name is not defined`). Inline
// callbacks are untouched by it; a `const n = (sel) => …` helper is not.
function census(): Record<string, number> {
  return {
    links: document.querySelectorAll('[role="link"]').length,
    unlockRows: document.querySelectorAll('[data-testid="unlock-row"]').length,
    bestSpellRows: document.querySelectorAll('[data-testid="best-spells-row"]').length,
    aaLedgerRows: document.querySelectorAll('[data-testid="aa-ledger-row"]').length,
    dropRows: document.querySelectorAll('[data-testid="leveling-drop-row"]').length,
    zoneRows: document.querySelectorAll('[data-testid="leveling-range-zone-row"]').length,
    muiRoots: document.querySelectorAll('[class*="Mui"]').length,
    domNodes: document.querySelectorAll('*').length,
    scrollHeight: document.querySelector('[data-testid="app-content"]')?.scrollHeight ?? 0
  }
}

/** Give the loadout-dependent panels their chance to fill before anything is measured. A page with
 *  no spell names is a legitimate state (see `stepNewAtLevel`), but it is a DIFFERENT page and the
 *  probe must say which one it measured. */
async function settleLinks(page: Page, timeoutMs = 30_000): Promise<number> {
  const deadline = Date.now() + timeoutMs
  let seen = 0
  while (Date.now() < deadline) {
    seen = await page.evaluate(() => document.querySelectorAll('[role="link"]').length)
    if (seen > 0) return seen
    await page.evaluate((ms) => new Promise((r) => setTimeout(r, ms)), 500)
  }
  return seen
}

async function scrollTop(page: Page): Promise<void> {
  await page.evaluate((s) => {
    document.querySelector(s)?.scrollTo(0, 0)
  }, CONTENT)
}

async function setHoverSuppressed(page: Page, off: boolean): Promise<void> {
  await page.evaluate(
    ({ on, sel }) => {
      const id = 'probe-no-hover'
      document.getElementById(id)?.remove()
      if (!on) return
      const st = document.createElement('style')
      st.id = id
      st.textContent = `${sel} *, ${sel} { pointer-events: none !important; }`
      document.head.appendChild(st)
    },
    { on: off, sel: CONTENT }
  )
}

/**
 * One measured episode.
 *
 * `ticks: 0` is the IDLE CONTROL and it is the most important arm in the file. Run 3 found that
 * once the arms are normalized by how many `moduleChanged` pushes landed inside them, the cost per
 * push is the SAME whether the page is being scrolled, hovered or neither (271 / 272 / 288 ms).
 * That is a claim that scrolling is not the mechanism at all — the page re-renders constantly and
 * scrolling is merely when a user needs frames and therefore notices. An idle arm of comparable
 * wall time is what turns that from an inference into a measurement.
 */
async function runArm(
  page: Page,
  cdp: CDPSession,
  arm: string,
  opts: { hover: boolean; ticks?: number; idleMs?: number }
): Promise<ArmResult> {
  await scrollTop(page)
  await setHoverSuppressed(page, !opts.hover)
  const field = await linkField(page)
  // Park the pointer over the rows BEFORE the profiler starts, so the initial hover resolution is
  // not charged to the scroll it is meant to measure.
  await page.mouse.move(field.x, field.y)
  await page.evaluate((ms) => new Promise((r) => setTimeout(r, ms)), 600)

  const ticks = opts.ticks ?? TICKS
  await page.evaluate(startCounters, CONTENT)
  const began = Date.now()
  await cdp.send('Profiler.start')

  for (let i = 0; i < ticks; i++) await page.mouse.wheel(0, WHEEL_PX)
  // Let the last wheel's work land inside the measured window rather than after it — and, for the
  // idle arm, BE the window.
  await page.evaluate((ms) => new Promise((r) => setTimeout(r, ms)), opts.idleMs ?? 800)

  const profile = (await cdp.send('Profiler.stop')).profile as Profile
  const wallMs = Date.now() - began
  const counters = await page.evaluate(stopCounters)
  await setHoverSuppressed(page, false)

  const { busyMs, top } = analyse(profile, 12)
  return { arm, busyMs, perTick: busyMs / Math.max(1, ticks), wallMs, counters, top, links: field.n }
}

/** The live arm's other half: keep the log growing while the scroll runs, so the engine is
 *  genuinely pushing. Kill/exp pairs are what an ordinary camp produces, and they move the
 *  progression module the tab reads. */
function startAppending(log: FixtureLog): () => number {
  let written = 0
  const timer = setInterval(() => {
    written += log.append('You gain experience!  (0.42%)', 'You have slain a fire giant warrior!')
  }, 250)
  return () => {
    clearInterval(timer)
    return written
  }
}

/** THE NORMALIZED LINE. Raw busy-ms cannot be compared across arms whose push counts differ — and
 *  on a live install they always differ, because the world is not the probe's to hold still. Per
 *  PUSH is the comparison that survives that, and it is the one that produced the verdict. */
function line(r: ArmResult): string {
  const ticks = pushTicks(r.counters)
  const perPush = ticks > 0 ? (r.busyMs / ticks).toFixed(0) : '—'
  const commitsPerPush = ticks > 0 ? (r.counters.commits / ticks).toFixed(1) : '—'
  return (
    `${r.arm.padEnd(15)} busy ${r.busyMs.toFixed(0).padStart(6)} ms / ${(r.wallMs / 1000).toFixed(1).padStart(5)} s wall  ` +
    `${((100 * r.busyMs) / Math.max(1, r.wallMs)).toFixed(0).padStart(3)}% busy  ` +
    `${r.perTick.toFixed(1).padStart(6)} ms/wheel  ` +
    `pushes ${String(ticks).padStart(4)}  ` +
    `${perPush.padStart(4)} ms/push  ` +
    `${commitsPerPush.padStart(5)} commits/push  ` +
    `commits ${String(r.counters.commits).padStart(4)}  ` +
    `longtask ${String(r.counters.longtasks)}/${r.counters.longtaskMs.toFixed(0)}ms  ` +
    `links ${String(r.links)}`
  )
}

/** The launch, either way. The real-install arm has no `FixtureLog`, so it has no live arm — the
 *  probe must never write to the owner's real game log (AGENTS.md). Its live arm is whatever the
 *  running game is already appending, which is honest but not controllable, so it is skipped. */
async function launch(): Promise<{ app: ElectronApplication; close: () => Promise<void>; log: FixtureLog | null }> {
  if (REAL) {
    const { app, close } = await launchOnRealInstall({}, 'leveling-scroll-probe')
    return { app, close, log: null }
  }
  const { app, close, log } = await launchOnFixture('e2e-leveling.log', {
    inventory: 'Primitive_freeport-Inventory.txt'
  })
  return { app, close, log }
}

async function main(): Promise<void> {
  buildIfStale()
  buildEngineIfStale()

  const { app, close, log } = await launch()
  const results: ArmResult[] = []
  try {
    const page = await mainWindow(app)
    // THE HOOK HAS TO BEAT REACT-DOM, so it is installed as an init script and the renderer is
    // reloaded onto it. Main keeps its world across a renderer reload, so this costs a re-hydrate
    // and nothing else.
    await page.addInitScript(installReactHook)
    await page.reload({ waitUntil: 'domcontentloaded' })
    await waitHydrated(page)

    await page.waitForSelector(NAV, { timeout: 60_000 })
    await page.click(NAV, { timeout: 15_000 })
    await page.waitForSelector(VIEW, { timeout: 30_000 })
    // The analytics first-run notice is a fixed overlay across the bottom and would eat wheel
    // events; the leveling spec dismisses it first for the same reason.
    await dismissFirstRunNotice(page)
    await page.evaluate((ms) => new Promise((r) => setTimeout(r, ms)), 2_000)

    const hooked = await page.evaluate(() => (window as unknown as Record<string, number>).__probeCommits ?? -1)
    console.log(`probe: react commit hook ${hooked >= 0 ? `INSTALLED (${String(hooked)} commits so far)` : 'NOT INSTALLED — commit counts are void'}`)

    // ONE CDP SESSION FOR THE WHOLE RUN. A session per arm, attached and detached five times, raced
    // playwright's own dispatcher into an `Assertion error` on the run that added the fifth
    // (`coreBundle.js:34801`) — and there was never a reason for more than one: `Profiler.start` and
    // `Profiler.stop` are per-call, not per-session.
    const cdp = await page.context().newCDPSession(page)
    await cdp.send('Profiler.enable')
    await cdp.send('Profiler.setSamplingInterval', { interval: 100 })

    const found = await settleLinks(page)
    console.log(`probe: ${String(found)} linked spell names on the page${found === 0 ? ' — THE HOVER ARMS ARE VOID, nothing is under the cursor' : ''}`)
    console.log(`probe: census ${JSON.stringify(await page.evaluate(census))}`)

    console.log(`probe: waiting for engine silence… ${(await settleQuiet(page)) ? 'quiet' : 'STILL PUSHING (quiet arms are not quiet)'}`)
    results.push(await runArm(page, cdp, 'WARMUP', { hover: true }))

    await settleQuiet(page)
    results.push(await runArm(page, cdp, 'QUIET_NOHOVER', { hover: false }))

    await settleQuiet(page)
    results.push(await runArm(page, cdp, 'QUIET_HOVER', { hover: true }))

    // THE CONTROL: nobody touches anything. Its wall time is matched to what a scroll arm actually
    // took, so `% busy` and `ms/push` compare like with like. If this arm is as expensive per push
    // as the scrolling ones, scrolling is not the mechanism.
    await settleQuiet(page)
    const scrollWall = Math.round(
      results.filter((r) => r.arm !== 'WARMUP').reduce((a, r) => a + r.wallMs, 0) /
        Math.max(1, results.filter((r) => r.arm !== 'WARMUP').length)
    )
    results.push(await runArm(page, cdp, 'IDLE_NOSCROLL', { hover: false, ticks: 0, idleMs: scrollWall }))

    // LAST, because it moves the world the arms above measured — and only where the harness owns
    // the log file. Never on the owner's real install.
    if (log) {
      // THE THREE LIVE ARMS, and the third is the one that settles the ticket. With the log growing
      // throughout: scroll+hover, scroll with hover suppressed, and then NEITHER — no wheel, no
      // pointer, the page simply sitting there. If the idle-live arm costs what the scrolling ones
      // cost, the scroll is not the mechanism and the page is re-rendering itself continuously.
      const stopAppending = startAppending(log)
      results.push(await runArm(page, cdp, 'LIVE_HOVER', { hover: true }))
      results.push(await runArm(page, cdp, 'LIVE_NOHOVER', { hover: false }))
      results.push(await runArm(page, cdp, 'LIVE_IDLE', { hover: false, ticks: 0, idleMs: scrollWall }))
      console.log(`probe: appended ${String(stopAppending())} lines across the three live arms`)
    } else {
      console.log('probe: real install — no live arm (the probe never writes to the real game log)')
    }

    console.log('\n── ARMS ─────────────────────────────────────────────────────────────────')
    for (const r of results) console.log(line(r))
    console.log('\n── TOP SELF-COST BY FUNCTION ────────────────────────────────────────────')
    for (const r of results) {
      if (r.arm === 'WARMUP') continue
      console.log(`\n[${r.arm}]`)
      for (const t of r.top) console.log(`  ${t.ms.toFixed(1).padStart(7)} ms  ${t.fn}`)
    }
    console.log(`\nPROBE_JSON ${JSON.stringify(results)}`)
  } finally {
    await close()
  }
}

main().catch((err: unknown) => {
  console.error('probe: harness error —', err)
  process.exitCode = 1
})
