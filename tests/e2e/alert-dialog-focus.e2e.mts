/**
 * Headless Electron regression test for JOS-122 — THE ADD-ALERT DIALOG KEEPS YOUR WORK ACROSS A
 * FOCUS LOSS.
 *
 * THE DEFECT, as a 0.13.0 user reported it: Alerts → "Add from suggestion…" → "Create manually" →
 * type a name and change some fields → alt-tab away → alt-tab back → the dialog is blank again.
 * Everything typed is gone, in a core feature, with no way to get it back.
 *
 * THE CAUSE was one dependency. `AlertDialog`'s form hydrates from `initial` (or from blanks) in
 * an effect, and that effect listed `packs` — the installed sound packs — among its inputs. The
 * always-mounted `AlertPlayer` re-reads the shared alert store ON WINDOW FOCUS (player.tsx), the
 * alerts view reloads defs/prefs/PACKS behind it (useAlertsStore.ts), and a reload hands down a
 * BRAND-NEW ARRAY every time. So every return to the app was, to that effect, indistinguishable
 * from the dialog being opened afresh. The fix (alertForm.ts) is to hydrate on an OPENING rather
 * than on a prop identity.
 *
 * WHY IT IS AN E2E SPEC. Every link in that chain is a seam between real parts — a window event,
 * a module-level store, an IPC round trip, a React effect — and the bug lives in the JOIN, not in
 * any one of them. There is no renderer component-test rig in this repo, and a unit test that
 * called the hook directly would have to fake the very array identity that IS the bug. Only the
 * real app can show that coming back to it leaves the form alone.
 *
 * HOW THE FOCUS CYCLE IS DRIVEN, honestly: `window.dispatchEvent(new Event('focus'))`, which is
 * the exact listener a returning user trips (voice-alerts.e2e.mts already drives it this way and
 * says why — a hidden e2e window is never given real OS focus, by design).
 *
 * AND HOW IT IS PROVEN NOT TO BE A NO-OP. A focus event that did nothing would make this spec
 * pass for the wrong reason, so the cycle is GATED on its own consequence: an alert is written
 * straight through `window.eq.saveAlert` first, which the open view cannot see until something
 * makes it reload. The new row appearing in the list behind the dialog is proof that the whole
 * refresh ran — including the `setPacks` that used to wipe the form — before anything is
 * asserted. Under the old code the fields are already blank at that instant.
 *
 * IT ALSO CARRIES THE SUGGESTION PICKER'S LAYOUT CONTRACT (JOS-190, GitHub issue 22): this is the
 * spec that already opens that dialog, so the claim that its rows never print on top of themselves
 * runs here too. The measurement lives in `suggestRowSteps.mts`.
 *
 * Run: `npm run test:e2e -- alert-dialog-focus` (or
 * `node --import tsx tests/e2e/alert-dialog-focus.e2e.mts`).
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
  settle,
  settleGone
} from './appHarness.mjs'
import { mainWindow } from './appWindow.mjs'
import { launchOnFixture } from './logFixture.mjs'
// The suggestion picker's ROW LAYOUT (JOS-190) — next door because this spec is at its line
// budget, and here because this is the spec that already opens that dialog. See that file's
// header for what the reporter's screenshot showed and how the collision is measured.
import { stepSuggestRowLayout } from './suggestRowSteps.mjs'

const DIALOG = '[data-testid="alert-dialog"]'
const SUGGEST = '[data-testid="suggest-dialog"]'

/** What the user types. Deliberately unlike any default, so a reset cannot look like a survival. */
const TYPED = {
  name: 'Charm break on the wizard',
  fieldKey: 'target',
  fieldVal: 'Sonista',
  cooldown: '7500',
  phrase: 'the charm broke'
}

/** What the user changes an EXISTING alert to, in the second half of the spec. */
const EDITED = { name: 'Renamed while alt-tabbed', cooldown: '9250' }

/** The value of an input inside a MUI TextField, addressed by the field's own testid. */
function valueOf(page: Page, testid: string): Promise<string> {
  return page.evaluate(
    (sel) => (document.querySelector(sel) as HTMLInputElement | null)?.value ?? '<missing>',
    `[data-testid="${testid}"] input`
  )
}

function fill(page: Page, testid: string, value: string): Promise<void> {
  return page.fill(`[data-testid="${testid}"] input`, value)
}

/** Pick a value out of a MUI Select (its popup renders `li[data-value=…]`). */
async function selectValue(page: Page, testid: string, value: string): Promise<void> {
  await page.click(`[data-testid="${testid}"]`)
  await page.waitForSelector(`li[data-value="${value}"]`, { timeout: 10_000 })
  await page.click(`li[data-value="${value}"]`)
  // MUI's menu animates out; its LEAVING is the condition, not a fixed beat.
  await settleGone(page, '.MuiMenu-root', { timeoutMs: 8_000 })
}

/**
 * THE FOCUS CYCLE, gated on its own consequence.
 *
 * Writes one alert straight through the IPC the dialog itself saves with, dispatches the blur/
 * focus pair, and waits for that alert's ROW to appear in the list behind the open dialog. The
 * row can only arrive via `useAlertsStore.reload()`, which is the same call that replaces the
 * `packs` array — so once it is on screen, the commit that used to blank the form has happened.
 */
async function focusCycle(page: Page, id: string): Promise<boolean> {
  const row = `[data-alert-id="${id}"]`
  const seenBefore = await countOf(page, row)
  await page.evaluate(
    async (alertId) => {
      const eq = (window as unknown as { eq: { saveAlert: (d: unknown) => Promise<unknown[]> } }).eq
      await eq.saveAlert({
        id: alertId,
        name: alertId,
        enabled: true,
        trigger: { type: 'raw', regex: 'never matches anything at all' },
        sound: { packId: 'alan-rickman', soundId: 'task-acknowledge-task-acknowledge-05' },
        cooldownMs: 0
      })
    },
    id
  )
  // The write alone must NOT move the view — that is what makes the row a gate rather than a
  // coincidence. Read it once more before the focus event so the claim is measured, not assumed.
  const seenStored = await countOf(page, row)
  await page.evaluate(() => {
    window.dispatchEvent(new Event('blur'))
    window.dispatchEvent(new Event('focus'))
  })
  const seen = await settle(() => countOf(page, row), (n) => n === 1, { timeoutMs: 20_000 })
  return check(
    'the window regaining focus really does reload the alerts view underneath the dialog',
    seenBefore === 0 && seenStored === 0 && seen === 1,
    `row: ${String(seenBefore)} before the write, ${String(seenStored)} after it, ${String(seen)} after focus — anything but 0/0/1 means this spec proved nothing`
  )
}

/** Open the manual editor exactly the way the report describes: through the suggestion picker. */
async function openManualEditor(page: Page): Promise<boolean> {
  await page.click('[data-testid="nav-alerts"]', { timeout: 60_000 })
  await page.waitForSelector('[data-testid="alerts-add-suggestion"]', { timeout: 30_000 })
  await page.click('[data-testid="alerts-add-suggestion"]')
  await page.waitForSelector(SUGGEST, { timeout: 20_000 })
  await page.click('[data-testid="suggest-create-manually"]')
  await settleGone(page, SUGGEST, { timeoutMs: 10_000 })
  await page.waitForSelector(DIALOG, { timeout: 20_000 })
  return check('the suggestion picker’s escape hatch opens the manual editor', (await countOf(page, DIALOG)) === 1)
}

/** Type into every kind of control the form owns, and prove it took. */
async function dirtyTheForm(page: Page): Promise<boolean> {
  await fill(page, 'alert-name', TYPED.name)
  await fill(page, 'alert-field-key', TYPED.fieldKey)
  await fill(page, 'alert-field-val', TYPED.fieldVal)
  await fill(page, 'alert-cooldown', TYPED.cooldown)
  // The Speech block is a sub-form of its own (SpeechBlock.tsx) with its own hydration, so a
  // written phrase is a second, independent thing the focus cycle could destroy.
  await selectValue(page, 'alert-audio-action', 'speech')
  await selectValue(page, 'alert-speech-mode', 'custom')
  await page.waitForSelector('[data-testid="alert-speech-phrase"] input', { timeout: 10_000 })
  await fill(page, 'alert-speech-phrase', TYPED.phrase)
  return check(
    'the form accepted the work: name, condition, cooldown and a written phrase',
    (await valueOf(page, 'alert-name')) === TYPED.name &&
      (await valueOf(page, 'alert-speech-phrase')) === TYPED.phrase
  )
}

/** THE ASSERTION THE TICKET IS ABOUT: every field still holds what the user typed. */
async function checkFormSurvived(page: Page): Promise<void> {
  if (!check('the dialog is still open after the focus cycle', (await countOf(page, DIALOG)) === 1)) return
  const expected: [string, string][] = [
    ['alert-name', TYPED.name],
    ['alert-field-key', TYPED.fieldKey],
    ['alert-field-val', TYPED.fieldVal],
    ['alert-cooldown', TYPED.cooldown],
    ['alert-speech-phrase', TYPED.phrase]
  ]
  for (const [testid, want] of expected) {
    const got = await valueOf(page, testid)
    check(
      `${testid} kept its value across the focus loss`,
      got === want,
      `read "${got}", expected "${want}"`
    )
  }
  // The phrase field only RENDERS while the speech mode is 'custom', so reading a value out of
  // it is also the assertion that the Speech block's own selectors were not put back either.
}

/** The stored def with this name, or null. `settle`d because the save writes through main. */
function storedByName(page: Page, name: string): Promise<StoredDef | null> {
  return settle(
    () =>
      page.evaluate(
        (want) =>
          (window as unknown as {
            eq: { listAlerts: () => Promise<StoredDef[]> }
          }).eq.listAlerts().then((defs) => defs.find((d) => d.name === want) ?? null),
        name
      ) as Promise<StoredDef | null>,
    (def) => def !== null,
    { timeoutMs: 15_000 }
  )
}

interface StoredDef {
  name: string
  audio?: string
  cooldownMs?: number
  trigger?: { where?: Record<string, string> }
  speech?: { phrase?: string }
}

/**
 * THE ADD BUTTON NEEDS A SOUND, AND THIS CHANNEL MAY HAVE NONE.
 *
 * `formCanSave` requires a `soundId`, a brand-new alert takes one from the installed packs, and
 * the shipped default pack SELF-PROVISIONS over the network into a userData directory this run
 * throws away (provisionPacks.ts). So on a machine that cannot reach the registry there is no
 * sound to offer and Add is legitimately disabled — a fact about pack-less installs, not about
 * JOS-122. The save half of the claim is therefore made where it is deterministic: on the EDIT
 * path below, whose def already carries a sound. This branch reports which world it ran in
 * instead of silently asserting nothing.
 */
async function checkAddSaves(page: Page): Promise<void> {
  const packs = await page.evaluate(() =>
    (window as unknown as { eq: { listSoundPacks: () => Promise<{ id: string }[]> } }).eq
      .listSoundPacks()
      .then((list) => list.length)
  )
  if (packs === 0) {
    note('no sound pack is installed in this channel, so Add is disabled for a NEW alert — the save half of the claim is asserted on the edit path instead')
    await page.keyboard.press('Escape')
    await settleGone(page, DIALOG, { timeoutMs: 10_000 })
    return
  }
  await page.click('[data-testid="alert-save"]')
  await settleGone(page, DIALOG, { timeoutMs: 15_000 })
  const stored = await storedByName(page, TYPED.name)
  if (!check('the alert the user was writing saves', stored !== null, JSON.stringify(stored))) return
  check(
    '…carrying the cooldown, the condition, the channel and the phrase that were on screen',
    isTypedWork(stored),
    JSON.stringify(stored)
  )
}

/** Does this stored def carry every field `dirtyTheForm` typed? */
function isTypedWork(def: StoredDef | null): boolean {
  if (def === null) return false
  if (def.cooldownMs !== Number(TYPED.cooldown)) return false
  if (def.audio !== 'speech') return false
  if (def.speech?.phrase !== TYPED.phrase) return false
  return def.trigger?.where?.[TYPED.fieldKey] === TYPED.fieldVal
}

/**
 * THE SAME DIALOG, OPENED ON AN EXISTING ALERT — and the same defect, pointed the other way: a
 * re-hydration in edit mode does not blank the form, it silently REVERTS it to the stored def,
 * which is the more insidious half (the dialog still looks full, and Save then writes back what
 * was already there). This path also carries a sound, so it is where pressing Save and reading
 * the def back out of main is deterministic on any machine.
 */
async function checkEditSurvives(page: Page): Promise<void> {
  await page.click('[data-testid="nav-alerts"]', { timeout: 60_000 })
  await page.waitForSelector('[data-testid="alert-row"]', { timeout: 30_000 })
  await page.click('[data-testid="alert-row"]:first-of-type [data-testid="alert-edit"]')
  await page.waitForSelector(DIALOG, { timeout: 20_000 })
  const before = await valueOf(page, 'alert-name')
  await fill(page, 'alert-name', EDITED.name)
  await fill(page, 'alert-cooldown', EDITED.cooldown)
  if (!check('an existing alert opens in the editor and accepts a change', before !== EDITED.name && (await valueOf(page, 'alert-name')) === EDITED.name, before)) {
    return
  }
  if (!(await focusCycle(page, 'e2e:focus-probe-3'))) return
  const name = await valueOf(page, 'alert-name')
  check(
    'an EDIT survives the focus loss too, instead of reverting to the stored def',
    name === EDITED.name,
    name === before ? `reverted to the stored "${before}"` : `read "${name}"`
  )
  const cooldown = await valueOf(page, 'alert-cooldown')
  check('…including the cooldown', cooldown === EDITED.cooldown, `read "${cooldown}"`)

  await page.click('[data-testid="alert-save"]')
  await settleGone(page, DIALOG, { timeoutMs: 15_000 })
  const stored = await storedByName(page, EDITED.name)
  check(
    'and Save writes the EDITED def through main — surviving on screen is not enough',
    stored !== null && stored.cooldownMs === Number(EDITED.cooldown),
    JSON.stringify(stored)
  )
}

/**
 * The SUGGESTION picker's own typing survives the same cycle. Its search box hydrates on `open`
 * alone and so never carried the defect — this is the guard that keeps it that way, since the
 * dialog re-renders on every focus (its `alerts` prop is replaced by the same reload).
 */
async function checkSuggestSearchSurvived(page: Page): Promise<void> {
  await page.click('[data-testid="nav-alerts"]', { timeout: 60_000 })
  await page.waitForSelector('[data-testid="alerts-add-suggestion"]', { timeout: 30_000 })
  await page.click('[data-testid="alerts-add-suggestion"]')
  await page.waitForSelector(SUGGEST, { timeout: 20_000 })
  await fill(page, 'suggest-search', 'type:buff')
  if (!(await focusCycle(page, 'e2e:focus-probe-2'))) return
  check('the suggestion picker is still open', (await countOf(page, SUGGEST)) === 1)
  const query = await valueOf(page, 'suggest-search')
  check('…and the search the user typed is still in the box', query === 'type:buff', `read "${query}"`)
  await page.keyboard.press('Escape')
  await settleGone(page, SUGGEST, { timeoutMs: 10_000 })
}

async function main(): Promise<void> {
  buildIfStale()

  console.log('launch: hidden Electron (EQ_E2E=1) against tests/fixtures/e2e-voice.log…')
  const { app, close, log } = await launchOnFixture('e2e-voice.log')

  let page: Page | null = null
  try {
    page = await mainWindow(app)
    const consoleErrors: string[] = []
    page.on('console', (m) => {
      if (m.type() === 'error') consoleErrors.push(m.text())
    })
    page.on('pageerror', (e) => consoleErrors.push(String(e)))

    await page.waitForSelector('[data-testid="nav-alerts"]', { timeout: 60_000 })
    if ((await openManualEditor(page)) && (await dirtyTheForm(page))) {
      if (await focusCycle(page, 'e2e:focus-probe-1')) {
        await checkFormSurvived(page)
        await checkAddSaves(page)
      }
    }
    await checkSuggestSearchSurvived(page)
    await checkEditSurvives(page)
    // LAST, because it moves the window: it puts the size and the app's minimum back before it
    // returns, but nothing after it should have to trust that (the JOS-151 precedent).
    await stepSuggestRowLayout(app, page, log)

    check('no renderer console errors', consoleErrors.length === 0, consoleErrors.slice(0, 3).join(' | '))
    if (failures.length) await dumpArtifacts(page, 'alert-dialog-focus-FAIL')
  } finally {
    await close()
  }

  reportRun()
}

main().catch((err: unknown) => {
  console.error('e2e: harness error —', err)
  process.exitCode = 1
})
