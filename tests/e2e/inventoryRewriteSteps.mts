// THE JOS-431 STEPS of the Sky inventory-freshness spec, living next door because
// sky-inventory-autoload.e2e.mts is AT the repo max-lines budget and the rule here is to SPLIT,
// never ratchet (drill.mts set the precedent; conCardChipSteps.mts and combatSteps.mts followed
// it). The spec still owns the ORDER, the two launches and the selector table it documents.
//
// WHY THERE IS A SECOND ACT AT ALL. Everything the spec next door proves rests on ONE act of
// writing: the dump is OVERWRITTEN in place while the app is up, and the app follows it. Report
// 01M0FMGA4DQRMG46290GWVVHQ6 (v1.6.0) is what happens when the writer REPLACES the file instead —
// the player re-ran `/outputfile inventory`, the dump on disk was demonstrably fresh (their log
// named the write to the second and the attached file's mtime matched it), and the running app
// kept showing a days-old timestamp until it was restarted. Deleting and recreating is `unlink`
// plus a return rather than a `change`, and the watcher used to hear neither
// (src/main/outputs/watch.ts, and the always-armed directory watcher in registry.ts).
//
// AND THE DOOR FOR THE DAY IT STILL MISSES ONE, which the same reporter asked for in as many
// words: "is there a way to refresh". It is one quiet word in the row that already dates the file,
// not the JOS-268 button returning — the spec keeps asserting that control's absence beside this
// one's presence, because the difference between them IS the earlier ruling.

import { statSync, unlinkSync, utimesSync } from 'node:fs'
import { join } from 'node:path'
import type { Page } from 'playwright-core'
import { check, countOf, settle } from './appHarness.mjs'
import { writeInventoryDump } from './logFixture.mjs'

/** The two slots of the freshness line: when the PLAYER wrote the dump, and when THIS APP read it. */
export const AGE = '[data-testid="posky-inventory-fresh-age"]'
export const LOADED = '[data-testid="posky-inventory-fresh-loaded"]'
/** THE MANUAL RE-READ (JOS-431) — the reporter's own ask, in the row that dates the file. */
export const REFRESH = '[data-testid="posky-inventory-fresh-refresh"]'
/** The committed dump a real `/outputfile inventory` produced (tests/fixtures/). */
export const DUMP = 'Primitive_freeport-Inventory.txt'

/** A slot, as the user sees it and as the DOM knows it: the words, the exact clock, the colour. */
export interface Slot {
  text: string
  title: string
  color: string
}

export function slot(page: Page, sel: string): Promise<Slot> {
  return page.evaluate((s) => {
    const el = document.querySelector(s)
    if (!el) return { text: '', title: '', color: '' }
    return {
      text: (el as HTMLElement).innerText.trim(),
      title: el.getAttribute('title') ?? '',
      color: getComputedStyle(el).color
    }
  }, sel)
}

/** The second a `mtimeMs` falls in — the resolution the line's own hover text is printed at. */
const second = (ms: number): number => Math.floor(ms / 1000)

/**
 * THE EVIDENCE IS THE FILE'S OWN CLOCK MOVING, and getting that right is most of this step.
 *
 * The visible words are useless here: every write in this suite is stamped `now`, so the dump
 * before the replacement and the dump after it both read "updated just now" and an app that never
 * noticed would pass. The exact clock behind the words is the real reading — but only if the two
 * writes fall in DIFFERENT SECONDS, because that is the resolution it is printed at.
 *
 * So the replacement is re-stamped until the disk agrees that it is a different second from the
 * file it replaced. That is a loop rather than one call for a MEASURED reason: with a watcher
 * holding the directory, Windows can apply the copy's own last-write stamp AFTER the `utimes` that
 * follows it, so a single stamp is silently clobbered. Re-stamping until `stat` reports what was
 * asked for costs one call when the platform behaves, and turns a coin flip into a fact when it
 * does not.
 */
async function restamp(path: string, differsFrom: number): Promise<number> {
  return settle(
    () => {
      const at = new Date()
      utimesSync(path, at, at)
      return Promise.resolve(statSync(path).mtimeMs)
    },
    (ms) => second(ms) !== second(differsFrom),
    { timeoutMs: 8_000, pollMs: 250 }
  )
}

/** Delete the dump and write it again — the rewrite that DESTROYS the file the watcher is on. */
export async function stepReplacedNotOverwritten(page: Page, installDir: string): Promise<void> {
  // The dump the auto-load step wrote, and the watcher is on it right now. `writeInventoryDump`
  // names its target from the same staged character the spec tails, so this is that file.
  const path = join(installDir, DUMP)
  const before = await slot(page, AGE)
  const replaced = statSync(path).mtimeMs
  unlinkSync(path)
  // …and now it comes back, the way a writer that swaps the file leaves it: a NEW file at the same
  // name, carrying a write time of its own.
  writeInventoryDump(installDir, DUMP)
  const stamped = await restamp(path, replaced)
  const distinct = check(
    'the replacement carries a write clock of its own',
    second(stamped) !== second(replaced),
    `replaced ${new Date(replaced).toISOString()} · wrote ${new Date(stamped).toISOString()}`
  )
  if (!distinct) return

  const age = await settle(
    () => slot(page, AGE),
    (s) => s.title !== '' && s.title !== before.title,
    { timeoutMs: 30_000 }
  )
  const seen = check(
    'a dump DELETED and written again under the running app is picked up, with no restart',
    age.title !== '' && age.title !== before.title,
    `the tab dated the old file ${before.title} and now dates ${age.title}`
  )
  if (!seen) return
  check('…as a file the player has only just written', age.text === 'updated just now', age.text)
  const loaded = await slot(page, LOADED)
  check('…read the moment the replacement settled', loaded.text === 'loaded just now', loaded.text)
  check('…and nothing on the line is flagged stale', loaded.color === age.color, `${loaded.color} vs ${age.color}`)
}

/**
 * PRESSING REFRESH RE-READS THE DUMP.
 *
 * What the click has to prove is that MAIN went back to the disk, so the evidence is the load
 * instant moving — read as the exact clock behind the coarse words, for the reason the spec's own
 * header gives (the visible text is deliberately too coarse to tell two loads apart).
 *
 * IT RUNS LAST, IN LAUNCH 2, and the ordering is the assertion's precondition rather than
 * convenience: the instants are formatted to the second, so a re-read a few hundred milliseconds
 * after the one before it can print the same string and prove nothing. By this point the app has
 * been up for a tab open, a dropdown pick and two settles, and the gap is seconds.
 */
export async function stepRefreshRereads(page: Page, before: Slot): Promise<void> {
  if (!check('the line carries the re-read affordance', (await countOf(page, REFRESH)) === 1)) return
  await page.click(REFRESH, { timeout: 15_000 })
  const loaded = await settle(
    () => slot(page, LOADED),
    (s) => s.title.length > 0 && s.title !== before.title,
    { timeoutMs: 20_000 }
  )
  check(
    'pressing Refresh reads the dump again, and the line says when',
    loaded.title !== '' && loaded.title !== before.title,
    `was read at ${before.title} · now ${loaded.title}`
  )
  check('…in the same quiet words, not a control that grew', loaded.text === 'loaded just now', loaded.text)
}
