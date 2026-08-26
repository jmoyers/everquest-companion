/**
 * JOS-360 — WRITING A CUSTOM SPOKEN PHRASE, FROM THE ROW AND FROM THE EDITOR.
 *
 * THE OWNER'S RULING (2026-08-14, hands-on, release-blocking): "we lost the ability to write custom
 * spoken alerts. we must retain that. and we must be able to parse {target} and such in those
 * custom alerts."
 *
 * THE REGRESSION THIS REPRODUCES. The alert ROW's "Speak: custom…" entry opened its phrase popover
 * from the Select's `onChange`, and a MUI Select fires `onChange` only when the value CHANGES. A
 * def already sitting at `speech.mode:'custom'` therefore had a DEAD entry — clicking it did
 * nothing, so the phrase could not be reworded without opening the editor. It was survivable while
 * `landsOnOther` was the only suggestion template that shipped a phrase; JOS-347 and JOS-353 gave
 * six more templates a default `{target}` phrase, so every suggestion a user installs now arrives
 * in custom mode and every one of them hit the dead entry. The unit half — the state, the round
 * trip through parser/module/resolver, the no-clobber rule — is tests/customSpeechAuthoring.test.
 * mts. What only the real app can show is that a CLICK on that entry opens the popover at all,
 * which is why this is an e2e claim and not a unit one.
 *
 * A STEP MODULE RATHER THAN A SPEC (the alwaysPlayAllSteps.mts / targetTokenSteps.mts precedent):
 * everything it needs — a launched app, a staged log it can append to, the Alerts tab, the engine
 * seam's utterance ring — is already standing in voice-alerts.e2e.mts, and that spec is at its
 * 400-line budget. A second Electron launch to type one sentence would buy nothing but 40 seconds.
 *
 * THE DEF IS SHAPED LIKE A SUGGESTION AS AN OLDER BUILD SAVED IT: an `audio:'both'` fade alert
 * carrying the template's own `{target}` phrase (suggestions.ts). That was the def the owner had
 * in his hands, and it is now also the MIGRATION case — JOS-362 retired the combined channel, so
 * a stored 'both' has to resolve on read (`resolveAlertAudio`: a phrase means spoken). The walk
 * therefore starts one step earlier than his did: the row must already read "Voice (spoken)" and
 * show the say picker, with no channel switch available to make it do so.
 *
 * THE LINE IS EQ'S OWN `Your <Spell> spell has worn off of <mob>.`, which the parser reads as a
 * `buffFade` naming the mob — the same family the fade suggestion watches. Restamped to now by the
 * harness, because the module fires live-only.
 */
import type { Page } from 'playwright-core'
import { check, countOf, settle, settleGone } from './appHarness.mjs'

const ALERT_ID = 'e2e:custom-phrase'
/** What the TEMPLATE ships — the phrase the user is trying to get away from. */
const TEMPLATE_PHRASE = 'Clarity faded on {target}'
/** What the user types on the ROW, tokens and all. */
const ROW_PHRASE = 'clarity dropped off {target}'
const ROW_EXPECTED = 'clarity dropped off Bonbonz'
/** What the user then types in the EDITOR, proving the second surface writes it too. */
const EDITOR_PHRASE = 'no more clarity on {target}'
const EDITOR_EXPECTED = 'no more clarity on Bonbonz'
const FADE_LINE = 'Your Clarity spell has worn off of Bonbonz.'

const ROW = `[data-alert-id="${ALERT_ID}"]`
const DIALOG = '[data-testid="alert-dialog"]'
const PHRASE_BOX = '[data-testid="alert-row-phrase"] input'

interface Spoken {
  text: string
  uttered: boolean
}

function spoken(page: Page): Promise<Spoken[]> {
  return page.evaluate(
    () => (window as unknown as { __eqSpeech?: { spoken: Spoken[] } }).__eqSpeech?.spoken ?? []
  ) as Promise<Spoken[]>
}

/** The stored def's speech block, straight out of main. */
function storedSpeech(page: Page): Promise<{ mode?: string; phrase?: string } | null> {
  return page.evaluate(
    (id) =>
      (window as unknown as {
        eq: { listAlerts: () => Promise<{ id: string; speech?: { mode?: string; phrase?: string } }[]> }
      }).eq
        .listAlerts()
        .then((defs) => defs.find((d) => d.id === id)?.speech ?? null),
    ALERT_ID
  ) as Promise<{ mode?: string; phrase?: string } | null>
}

/** Rendered text of the first match; '' when the node isn't mounted (the plannerSteps helper). */
function textOf(page: Page, sel: string): Promise<string> {
  return page.evaluate((s) => (document.querySelector(s) as HTMLElement | null)?.innerText ?? '', sel)
}

/** The value a MUI Select is holding, read off the hidden native input it renders. */
function selectValueOf(page: Page, selector: string): Promise<string> {
  return page.evaluate(
    (sel) => (document.querySelector(`${sel} input`) as HTMLInputElement | null)?.value ?? '<missing>',
    selector
  )
}

/** Which def the editor says it is editing ("Edit alert - <name>") — the failure detail. */
async function dialogTitle(page: Page): Promise<string> {
  const t = await page.evaluate(
    () => (document.querySelector('[data-testid="alert-dialog"] .MuiDialogTitle-root') as HTMLElement | null)?.innerText ?? ''
  )
  return t.replace(/\s+/g, ' ').trim()
}

/**
 * The phrase field's value once the dialog has HYDRATED — never on the first frame.
 *
 * The speech sub-form is hydrated from `initial` by an EFFECT (SpeechBlock's `useSpeechForm`, and
 * JOS-122's rule that hydration answers an opening), so the field exists for one paint still
 * holding whatever the PREVIOUS opening put in it. Reading it the moment `waitForSelector`
 * returned is a bet on that frame — it lost once here, showing the phrase of the alert edited two
 * steps earlier. Wait for the condition, never for the clock (settle.mts).
 */
function settledPhrase(page: Page, want: string): Promise<string> {
  return settle(
    () => page.inputValue('[data-testid="alert-speech-phrase"] input'),
    (v) => v === want,
    { timeoutMs: 10_000 }
  ).catch(() => page.inputValue('[data-testid="alert-speech-phrase"] input'))
}

/**
 * Store the def through the app's OWN IPC — the exact call AlertDialog and the row both save with
 * — then make the renderer's player re-read the set. A hidden e2e window is never focused, and
 * `refreshAlertStore` (player.tsx) re-reads on the app's own focus event; dispatching it is the
 * same listener a returning user trips, not a test-only back door.
 */
async function seedSuggestedDef(page: Page): Promise<number> {
  const saved = await page.evaluate(
    async ({ id, phrase }) => {
      const eq = (window as unknown as { eq: { saveAlert: (d: unknown) => Promise<unknown[]> } }).eq
      const defs = await eq.saveAlert({
        id,
        name: 'Clarity fades',
        enabled: true,
        // No regex: the plain condition editor's own output shape, exactly as the wizard builds it.
        trigger: { type: 'event', kind: 'buffFade', where: { spell: 'Clarity' } },
        sound: { packId: 'alan-rickman', soundId: 'resource-limit-resource-limit-09' },
        cooldownMs: 0,
        // The shape JOS-353 gave the fade template: sound + voice, saying the template's phrase.
        audio: 'both',
        speech: { mode: 'custom', phrase }
      })
      return defs.length
    },
    { id: ALERT_ID, phrase: TEMPLATE_PHRASE }
  )
  await page.click('[data-testid="nav-alerts"]', { timeout: 60_000 })
  await page.evaluate(() => window.dispatchEvent(new Event('focus')))
  await settle(() => countOf(page, ROW), (n) => n === 1, { timeoutMs: 20_000 })
  return saved
}

/** THE REGRESSION: reword a suggestion's phrase from the row, without opening the editor. */
async function rewordFromTheRow(page: Page): Promise<boolean> {
  // JOS-362, in the real app: the def on disk still says `audio:'both'`, a channel this build no
  // longer offers. It carries a phrase, so it resolves to SPOKEN — the output select reads
  // "Voice (spoken)" and the say picker is the second column, with no switch to make first. A
  // Select holding a value none of its items carry renders BLANK, so this also proves the
  // resolution happens on the way in rather than being papered over in the label.
  if (
    !check(
      'a def stored on the retired sound+voice channel opens on the voice output, not blank',
      (await selectValueOf(page, `${ROW} [data-testid="alert-output"]`)) === 'output:speech',
      await selectValueOf(page, `${ROW} [data-testid="alert-output"]`)
    )
  ) {
    return false
  }
  if (
    !check(
      'a suggested alert shows the say picker, already on the template’s phrase',
      (await countOf(page, `${ROW} [data-testid="alert-say"]`)) === 1 &&
        (await selectValueOf(page, `${ROW} [data-testid="alert-say"]`)) === 'custom',
      await selectValueOf(page, `${ROW} [data-testid="alert-say"]`)
    )
  ) {
    return false
  }

  // THE COLLAPSED VALUE IS A READOUT (JOS-362): closed, the picker says what the alert will SAY,
  // not what clicking it would do.
  check(
    'the closed say picker states the phrase the alert speaks',
    (await textOf(page, `${ROW} [data-testid="alert-say"]`)).includes(TEMPLATE_PHRASE),
    await textOf(page, `${ROW} [data-testid="alert-say"]`)
  )

  // …and THIS is the click that did nothing. The entry is the mode the def is already in, so the
  // Select fires no `onChange` — the popover has to be opened by the MenuItem's own onClick.
  await page.click(`${ROW} [data-testid="alert-say"]`)
  await page.waitForSelector('li[data-value="custom"]', { timeout: 10_000 })
  // THE OPEN ENTRY IS AN ACTION (JOS-362, the owner's report: "it reads as a status, not an
  // affordance - selecting it edits the phrase but nothing says so"). Both halves in one claim:
  // the entry names the edit, and it still shows the phrase that edit would act on.
  const entry = await textOf(page, 'li[data-value="custom"]')
  check(
    'the custom entry reads as an edit action, alongside the phrase it would edit',
    entry.includes('Edit spoken phrase') && entry.includes(TEMPLATE_PHRASE),
    entry
  )
  await page.click('li[data-value="custom"]')
  const opened = await settle(() => countOf(page, PHRASE_BOX), (n) => n === 1, { timeoutMs: 10_000 }).catch(
    () => 0
  )
  if (
    !check(
      'THE REGRESSION: re-picking "Speak: custom…" on an alert already in custom mode opens the phrase box',
      opened === 1,
      opened === 1 ? '' : 'the popover never rendered — the row cannot reword a suggested phrase'
    )
  ) {
    return false
  }

  check(
    '…prefilled with what the alert says today, so a reword is an edit and not a retype',
    (await page.inputValue(PHRASE_BOX)) === TEMPLATE_PHRASE,
    await page.inputValue(PHRASE_BOX)
  )

  // …and it TEACHES the token, in the dialog's own words (owner, mid-JOS-362: "add a small bit of
  // explanatory text ... around {target} and what it can do"). The names come from this alert's own
  // trigger, so this is also the claim that the row is not promising a token the def cannot fill.
  const hint = await textOf(page, '[data-testid="alert-row-phrase-tokens"]')
  check('the phrase box says which token the app fills in for this alert', hint.includes('{target}'), hint)

  await page.fill(PHRASE_BOX, ROW_PHRASE)
  await page.press(PHRASE_BOX, 'Enter')
  await settleGone(page, PHRASE_BOX, { timeoutMs: 10_000 })
  const stored = await settle(() => storedSpeech(page), (s) => s?.phrase === ROW_PHRASE, {
    timeoutMs: 15_000
  }).catch(() => null)
  return check(
    'the row wrote the user’s words onto the stored def — no editor was opened',
    stored?.mode === 'custom' && stored.phrase === ROW_PHRASE,
    JSON.stringify(stored)
  )
}

/** …and the mob's name comes out the far end, from a phrase nobody typed a regex for. */
async function speaksTheMob(
  page: Page,
  log: { appendAt: (at: Date, ...m: readonly string[]) => number },
  expected: string
): Promise<void> {
  // ── RESTORED BY JOS-500 (owner ruling 27) — THE FRAME CARRIES THE WORDS ─────────────────────
  //
  // WHAT THIS CLAIMS: a `{target}` token typed BY HAND into an alert's own phrase reaches the
  // speech seam substituted. Same mechanism as `targetTokenSteps.mts`, from the other direction —
  // that one proves the app OFFERS the token, this one proves a user can write it themselves and be
  // understood. Both matter, because the compile-time gate that decides whether a firing carries a
  // target at all reads the PHRASE (`autoTokensWanted`, ported engine-side as `wants_target_token`)
  // — so a phrase the user typed by hand is the input that gate actually runs on in the wild.
  //
  // JOS-499 gated this off behind `RETIRED_5a` rather than deleting it, because the frame had four
  // fields and nowhere to put a capture map. It has the fields now, and the assertion below is
  // unchanged.
  const before = (await spoken(page)).length
  log.appendAt(new Date(), FADE_LINE)
  const all = await settle(
    () => spoken(page),
    (list) => list.slice(before).some((s) => s.text === expected),
    { timeoutMs: 20_000 }
  ).catch(() => null)
  const hit = all?.slice(before).find((s) => s.text === expected)
  check(
    `a hand-typed {target} reaches the speech seam substituted — “${expected}”`,
    hit !== undefined,
    hit ? `spoke "${hit.text}"` : `never spoke "${expected}"`
  )
  if (hit) check('…and this channel stayed mute doing it', hit.uttered === false, `uttered=${String(hit.uttered)}`)
}

/**
 * THE EDITOR ROUND TRIP: reopen, still custom, still the user's words — then write a new phrase in
 * the dialog and find it there again. The clobber clause of the ticket is the second reopen: the
 * template's default must never come back over what the user wrote.
 */
async function editorRoundTrip(page: Page): Promise<void> {
  await page.click(`${ROW} [data-testid="alert-edit"]`)
  await page.waitForSelector(DIALOG, { timeout: 15_000 })
  await page.waitForSelector('[data-testid="alert-speech-phrase"] input', { timeout: 10_000 })
  const shown = await settledPhrase(page, ROW_PHRASE)
  check(
    'reopening the editor finds the alert still on a phrase the user wrote',
    (await selectValueOf(page, '[data-testid="alert-speech-mode"]')) === 'custom' && shown === ROW_PHRASE,
    `${shown} — dialog: ${await dialogTitle(page)}`
  )
  check(
    '…and the editor still says which token it fills in for you (JOS-353)',
    (await countOf(page, '[data-testid="alert-speech-auto-tokens"]')) === 1
  )

  await page.fill('[data-testid="alert-speech-phrase"] input', EDITOR_PHRASE)
  await page.click('[data-testid="alert-save"]')
  await settleGone(page, DIALOG, { timeoutMs: 15_000 })

  const stored = await settle(() => storedSpeech(page), (s) => s?.phrase === EDITOR_PHRASE, {
    timeoutMs: 15_000
  }).catch(() => null)
  check(
    'the editor writes a custom phrase too, and the template’s default never returns',
    stored?.mode === 'custom' && stored.phrase === EDITOR_PHRASE,
    JSON.stringify(stored)
  )

  await page.click(`${ROW} [data-testid="alert-edit"]`)
  await page.waitForSelector('[data-testid="alert-speech-phrase"] input', { timeout: 15_000 })
  const reopened = await settledPhrase(page, EDITOR_PHRASE)
  check('and a second reopen still shows it — the round trip closes', reopened === EDITOR_PHRASE, reopened)
  await page.keyboard.press('Escape')
  await settleGone(page, DIALOG, { timeoutMs: 10_000 })
}

export async function stepCustomPhrase(
  page: Page,
  log: { appendAt: (at: Date, ...m: readonly string[]) => number }
): Promise<void> {
  const saved = await seedSuggestedDef(page)
  if (!check('a suggestion-shaped speaking def saves through the app’s own IPC', saved > 0, `${String(saved)} defs stored`)) {
    return
  }
  if (!(await rewordFromTheRow(page))) return
  await speaksTheMob(page, log, ROW_EXPECTED)
  await editorRoundTrip(page)
  // The editor's own phrase has to travel the same live path the row's did — same parser, same
  // module, same resolver, different authoring surface.
  await page.evaluate(() => window.dispatchEvent(new Event('focus')))
  await speaksTheMob(page, log, EDITOR_EXPECTED)
}
