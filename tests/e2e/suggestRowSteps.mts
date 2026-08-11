// THE SUGGESTED-ALERTS ROW NEVER PRINTS ON TOP OF ITSELF (JOS-190 — GitHub issue 22, relayed
// in-app as reports 01KZNYDPVP09VK24SKW2KJ34VY and 01KZPS5QJAG9GN8Q17A5AQET33).
//
// WHAT THE DEFECT WAS. A suggestion row is two flex groups on ONE line: the FACTS on the left
// (spell name, buff/debuff, class levels, the recent-rank and usage chips) and the one-click
// template CHIPS on the right. The right group was `flexShrink: 0` and the left group was the
// one that gave — but the left group is itself a nowrap flex box with no clipping, so once the
// two together wanted more than the dialog's ~836px of content width, the left box was squeezed
// to a fraction of its contents and its chips simply KEPT DRAWING, straight across the template
// chips beside them. The reporter's screenshot is a page of that: "When it wears off (you or
// your pet)" with a class-level chip printed through the middle of it. It has nothing to do with
// the window size — the dialog is `maxWidth="md"`, so the reporter saw it at 1979px wide — and
// everything to do with how many chips a row wears, which is why the rows with a RECENT-rank chip
// (an extra "When you cast <rank>" and, on a debuff, "When <rank> is resisted") were the worst.
//
// WHY IT IS AN E2E SPEC AND NOT A UNIT TEST. The collision is one flex line meeting one real
// width with real text metrics in it; nothing short of the running app has any of those. This is
// the JOS-151 instrument (levelingLayoutSteps.mts) pointed at a row instead of a tab, and it is
// shaped the same way for the same reason: overlap is only an honest question about boxes the
// user can SEE, so every box is intersected with each CLIPPING ancestor first — the results list
// is a scroller and the fixed row shell now clips its own facts group, and a raw
// `getBoundingClientRect()` would report both as colliding with things that are not on screen.
//
// LIVING NEXT DOOR to alert-dialog-focus.e2e.mts (which already opens this dialog) because that
// spec is near the repo's line budget and the rule here is to SPLIT, never ratchet —
// levelingLayoutSteps.mts and sliceSteps.mts set the precedent.
//
// VERIFIED TO CATCH IT. With the pre-fix row shell restored, this step reports 3 of 200 rows
// colliding at BOTH widths — every one of the three watched spells it plays in, and no others —
// naming pairs like `"DRU 10" over "When it wears off (you or your pet" (32x18px)`, which is the
// reporter's screenshot in words. With the fix, 200 rows all clear at both widths, and the three
// heavy rows are 44px tall instead of 26 while every other row on screen is untouched at 26.

import type { ElectronApplication, Page } from 'playwright-core'
import { check, note, settle, settleStable } from './appHarness.mjs'
import type { FixtureLog } from './logFixture.mjs'

/** The app's own minimum window width (src/main/windows.ts) — the narrowest a user can reach. */
const MIN_W = 900

const SUGGEST = '[data-testid="suggest-dialog"]'
const ROW = '[data-testid="suggest-row"]'

/**
 * THE ROWS THE REPORTER ACTUALLY HAD, PLAYED IN.
 *
 * A row's width is decided by how many chips it wears, and the heaviest rows — the ones the
 * screenshot is full of — are the ones the app has WATCHED: a spell the log has seen cast wears a
 * recency chip, a usage count, AND two extra template chips ("When you cast <rank>", plus a resist
 * one on a debuff). `tests/fixtures/e2e-voice.log` contains no buffs at all (the picker opens
 * saying "0 you've used"), so without this the spec would measure only the light two-chip rows
 * and prove nothing about the defect.
 *
 * Each entry is a WHOLE CYCLE — cast, land, wear off — because that is what the catalog counts:
 * `usageCount` is the buffs module's per-spell DURATION SAMPLE count (buffsStats.ts), and a buff
 * that never ends yields no sample (measured: cast + landing alone leaves the picker still saying
 * "0 you've used"). The landing and wear-off sentences are quoted from the committed spell DB
 * (`src/main/data/spells.json` — `msgCastOnYou` / `msgWearsOff`), which is the same text the app
 * matches on; buffs-overlay.e2e.mts plays Valor the same way. All three are spells the reporter's
 * screenshot shows overlapping, and all three are multi-class, which is what puts a "+N" chip on
 * the row as well.
 */
const PLAYED_BUFFS: readonly (readonly [string, string, string])[] = [
  ['Spirit of Wolf', 'You feel the spirit of wolf enter you.', 'The spirit of wolf leaves you.'],
  ['Regeneration', 'You begin to regenerate.', 'You have stopped regenerating.'],
  ['Quickness', 'You feel much faster.', 'Your speed returns to normal.']
]

/** One row's verdict, as the user would see it: what overlapped what, and by how much. */
interface RowProbe {
  /** the row's first line of text — what makes a failure readable */
  name: string
  /** "<a>" over "<b>" (WxHpx) for every pair of the row's own boxes that share pixels */
  overlaps: string[]
  /** px by which any of its boxes is drawn outside the row itself */
  spill: number
}

interface Probe {
  rows: number
  bad: RowProbe[]
  /** does the results list scroll SIDEWAYS? (a row that overflows instead of wrapping makes it) */
  hScroll: number
  /** the most chips any one row is wearing — the gate on this spec measuring anything at all */
  maxChips: number
}

/** One measured box, already clipped by every ancestor that hides overflow. */
interface Box {
  /** which suggestion row it belongs to */
  row: number
  /** the row shell itself, rather than one of the things inside it */
  shell: boolean
  text: string
  x0: number
  y0: number
  x1: number
  y1: number
}

interface Raw {
  boxes: Box[]
  /** chips per row, in DOM order */
  chips: number[]
  hScroll: number
}

/**
 * THE MEASUREMENT ONLY — every visible box inside every suggestion row, clipped by every
 * scrolling/hiding ancestor, handed back as plain numbers. The verdict is worked out in node
 * (`verdicts`), because the page is the wrong place to do arithmetic that a reader has to trust:
 * NO NAMED FUNCTION BINDINGS may exist in here (repo law — appHarness.mts, buffTimerSteps.mts),
 * since tsx/esbuild's `keepNames` wraps `const f = (…) => …` in a `__name` helper that lives in
 * the NODE bundle and the page dies on `ReferenceError: __name is not defined`.
 *
 * The items are the row's own leaves — chips, the name, the caption, the dismiss button — with
 * anything INSIDE a chip skipped, since a chip's label is part of the chip and not a thing that
 * can collide with it. A chip the row has legitimately cut off ends up with no area at all, and
 * so cannot "collide" with anything.
 */
function measureRows(page: Page): Promise<Raw> {
  return page.evaluate(
    ({ rowSel, listSel }) => {
      const owners: number[] = []
      const shells: boolean[] = []
      const nodes: HTMLElement[] = []
      const chips: number[] = []
      const rows = Array.from(document.querySelectorAll(rowSel))
      for (let i = 0; i < rows.length; i++) {
        const row = rows[i] as HTMLElement
        chips.push(row.querySelectorAll('.MuiChip-root').length)
        nodes.push(row)
        owners.push(i)
        shells.push(true)
        for (const n of Array.from(
          row.querySelectorAll('.MuiChip-root, .MuiTypography-root, .MuiButtonBase-root')
        )) {
          if (n.parentElement?.closest('.MuiChip-root, .MuiButtonBase-root')) continue
          nodes.push(n as HTMLElement)
          owners.push(i)
          shells.push(false)
        }
      }
      const boxes: Box[] = []
      for (let k = 0; k < nodes.length; k++) {
        const node = nodes[k]
        const r = node.getBoundingClientRect()
        let x0 = r.left
        let y0 = r.top
        let x1 = r.right
        let y1 = r.bottom
        for (let p = node.parentElement; p; p = p.parentElement) {
          const cs = getComputedStyle(p)
          if (cs.overflowX === 'visible' && cs.overflowY === 'visible') continue
          const pr = p.getBoundingClientRect()
          x0 = Math.max(x0, pr.left)
          y0 = Math.max(y0, pr.top)
          x1 = Math.min(x1, pr.right)
          y1 = Math.min(y1, pr.bottom)
        }
        const text = (node.innerText || node.textContent || '').trim().split('\n')[0]
        boxes.push({ row: owners[k], shell: shells[k], text: text.slice(0, 34), x0, y0, x1, y1 })
      }
      const list = document.querySelector(listSel) as HTMLElement | null
      return { boxes, chips, hScroll: list ? Math.max(0, list.scrollWidth - list.clientWidth) : 0 }
    },
    { rowSel: ROW, listSel: `${SUGGEST} .MuiDialogContent-root` }
  )
}

/** Do these two boxes share pixels? (a box with no area cannot — it is scrolled or clipped away) */
function shared(a: Box, b: Box): { ox: number; oy: number } | null {
  if (a.x1 - a.x0 <= 0 || a.y1 - a.y0 <= 0 || b.x1 - b.x0 <= 0 || b.y1 - b.y0 <= 0) return null
  const ox = Math.min(a.x1, b.x1) - Math.max(a.x0, b.x0)
  const oy = Math.min(a.y1, b.y1) - Math.max(a.y0, b.y0)
  return ox > 1 && oy > 1 ? { ox, oy } : null
}

/** One row's verdict: every pair of its own boxes that share pixels, and anything drawn outside. */
function verdictOf(shell: Box, items: Box[]): RowProbe {
  const overlaps: string[] = []
  for (let i = 0; i < items.length; i++) {
    for (let j = i + 1; j < items.length; j++) {
      const hit = shared(items[i], items[j])
      if (hit) {
        overlaps.push(
          `"${items[i].text}" over "${items[j].text}" (${String(Math.round(hit.ox))}x${String(Math.round(hit.oy))}px)`
        )
      }
    }
  }
  const spill = items
    .filter((b) => b.x1 - b.x0 > 0)
    .reduce((n, b) => Math.max(n, Math.round(b.x1 - shell.x1), Math.round(shell.x0 - b.x0)), 0)
  return { name: shell.text, overlaps, spill: Math.max(spill, 0) }
}

/** The whole picker, row by row — only the rows with something to answer for are kept. */
async function probeRows(page: Page): Promise<Probe> {
  const raw = await measureRows(page)
  const bad: RowProbe[] = []
  for (let i = 0; i < raw.chips.length; i++) {
    const mine = raw.boxes.filter((b) => b.row === i)
    const shell = mine.find((b) => b.shell)
    if (!shell) continue
    const verdict = verdictOf(shell, mine.filter((b) => !b.shell))
    if (verdict.overlaps.length > 0 || verdict.spill > 1) bad.push(verdict)
  }
  return {
    rows: raw.chips.length,
    bad,
    hScroll: raw.hScroll,
    maxChips: raw.chips.reduce((n, c) => Math.max(n, c), 0)
  }
}

/**
 * Is this control the thing at its own centre? A chip drawn over is a chip a click cannot reach,
 * which is the user-facing half of the ticket. Same shape as levelingLayoutSteps' hit test — a
 * DISABLED chip (an alert the user already created) has `pointer-events: none`, so the topmost
 * element there is the row that CONTAINS it, and that still counts as reached.
 */
function hitTest(page: Page, sel: string, nth: number): Promise<string> {
  return page.evaluate(
    ({ s, n }) => {
      const el = document.querySelectorAll(s)[n]
      if (!el) return 'absent'
      const r = el.getBoundingClientRect()
      if (r.width < 1 || r.height < 1) return 'collapsed to nothing'
      const top = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2)
      if (!top) return 'nothing at its centre'
      if (el.contains(top) || top.contains(el)) return 'hit'
      return `covered by ${top.tagName}.${String(top.className).slice(0, 40)}`
    },
    { s: sel, n: nth }
  )
}

/** Resize and wait for the RENDERER to agree, then for the rows to stop moving (wave E3). */
async function resizeTo(app: ElectronApplication, page: Page, width: number, height: number): Promise<number> {
  const win = await app.browserWindow(page)
  await win.evaluate((w, b) => {
    w.setMinimumSize(360, 360)
    w.setBounds({ ...w.getBounds(), width: b.w, height: b.h })
  }, { w: width, h: height })
  const got = await settle(
    () => page.evaluate(() => document.documentElement.clientWidth),
    (v) => Math.abs(v - width) <= 24,
    { timeoutMs: 15_000 }
  )
  await settleStable(() => probeRows(page).then((p) => `${String(p.rows)}:${String(p.bad.length)}`), {
    timeoutMs: 15_000
  })
  return got
}

/** The claim, at one width: every row's boxes sit beside each other, inside the row. */
async function checkAt(page: Page, tag: string): Promise<void> {
  const probe = await probeRows(page)
  if (!check(`${tag}: the dialog is showing suggestion rows to measure`, probe.rows > 0, `${String(probe.rows)} rows`)) {
    return
  }
  const colliding = probe.bad.filter((r) => r.overlaps.length > 0)
  check(
    `${tag}: no suggestion row prints on top of itself`,
    colliding.length === 0,
    colliding.length === 0
      ? `${String(probe.rows)} rows, all clear`
      : `${String(colliding.length)}/${String(probe.rows)} rows collide: ${colliding
          .slice(0, 3)
          .map((r) => `[${r.name}] ${r.overlaps[0]}`)
          .join(' · ')}`
  )
  const spilling = probe.bad.filter((r) => r.spill > 1)
  check(
    `${tag}: …and no row draws outside its own box, over the row above or below`,
    spilling.length === 0,
    spilling.length === 0
      ? 'nothing spills'
      : `${String(spilling.length)} rows spill: ${spilling.slice(0, 3).map((r) => `[${r.name}] +${String(r.spill)}px`).join(' · ')}`
  )
  check(`${tag}: the list never has to scroll sideways`, probe.hScroll <= 1, `+${String(probe.hScroll)}px`)
  const hit = await hitTest(page, `${ROW} .MuiChip-clickable`, 0)
  check(`${tag}: the first one-click template chip is still the thing at its own centre`, hit === 'hit', hit)
  // THE GATE ON THE WHOLE MEASUREMENT. A picker showing only the light two-chip rows cannot
  // collide at any width, so it would pass this step while proving nothing. The played buffs
  // (PLAYED_BUFFS) are what put a watched spell's full complement on a row — name, type, two class
  // levels, "+N", recency, usage and up to four template chips — and this says they arrived.
  check(
    `${tag}: …and the heaviest row on screen is a WATCHED spell's, the kind the report is about`,
    probe.maxChips >= 9,
    `${String(probe.maxChips)} chips on the heaviest row`
  )
}

/**
 * THE SUGGESTED-ALERTS ROW LAYOUT (JOS-190). Opens the picker the way the reporter did, measures
 * every row it draws at the app's default window, then at the narrowest window the app allows,
 * and puts the window back.
 *
 * BOTH widths, because the defect is not a narrow-window one: the paper is `maxWidth="md"`, so the
 * reporter hit it at 1979px. The minimum is measured too because it is the worst case for a row
 * that has to fit its facts and its chips into one line.
 */
export async function stepSuggestRowLayout(
  app: ElectronApplication,
  page: Page,
  log: FixtureLog
): Promise<void> {
  const win = await app.browserWindow(page)
  const wide = await win.evaluate((w) => w.getBounds())

  // Play the watched buffs and wait for MAIN to have absorbed them — the picker reads the catalog
  // once, when it opens, so the wait has to happen before the click. `withUsage` is the catalog's
  // own count of spells the log has seen, which is the number the dialog title prints.
  // A minute back, so the whole cycle (cast → land → wear off, half a minute of buff) is already
  // history by the time it is written: the sample is what the catalog counts, not the timer.
  const at = new Date(Date.now() - 60_000)
  for (const [spell, landed, faded] of PLAYED_BUFFS) {
    log.appendAt(at, `You begin casting ${spell}.`)
    log.appendAt(new Date(at.getTime() + 1_000), landed)
    log.appendAt(new Date(at.getTime() + 30_000), faded)
  }
  const used = await settle(
    () =>
      page.evaluate(() =>
        (window as unknown as {
          eq: { getSpellCatalog: () => Promise<{ withUsage: number }> }
        }).eq.getSpellCatalog().then((c) => c.withUsage)
      ) as Promise<number>,
    (n) => n >= PLAYED_BUFFS.length,
    { timeoutMs: 30_000 }
  )
  check(
    'the log the app is tailing now has watched buffs in it, the way the reporter’s did',
    used >= PLAYED_BUFFS.length,
    `${String(used)} spells with usage, played ${String(PLAYED_BUFFS.length)}`
  )

  await page.click('[data-testid="nav-alerts"]', { timeout: 60_000 })
  await page.waitForSelector('[data-testid="alerts-add-suggestion"]', { timeout: 30_000 })
  await page.click('[data-testid="alerts-add-suggestion"]')
  await page.waitForSelector(SUGGEST, { timeout: 20_000 })
  // The catalog arrives over IPC, so the rows appear a beat after the paper does.
  await settle(() => page.evaluate((s) => document.querySelectorAll(s).length, ROW), (n) => n > 0, {
    timeoutMs: 20_000
  })
  await settleStable(() => probeRows(page).then((p) => String(p.rows)), { timeoutMs: 15_000 })

  await checkAt(page, `default ${String(wide.width)}px`)

  const got = await resizeTo(app, page, MIN_W, Math.min(wide.height, 760))
  note(`narrowed the window to the app's own minimum: ${String(got)}px of viewport`)
  await checkAt(page, 'narrow')

  // Back where it started, minimum LAST — `resizeTo` lowers it every time, and nothing after this
  // step should have to trust a 360px-wide app.
  await resizeTo(app, page, wide.width, wide.height)
  await win.evaluate((w, min) => w.setMinimumSize(min, 600), MIN_W)
  await page.keyboard.press('Escape')
}
