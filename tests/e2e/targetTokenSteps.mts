/**
 * JOS-353 — `{target}` FROM THE PLAIN EDITOR, ON A LIVE-TAILED LINE.
 *
 * A step module rather than a spec of its own (the alwaysPlayAllSteps.mts precedent, and the same
 * arithmetic): everything it needs — a launched app, a staged log it can append to, the Alerts tab,
 * the engine seam's utterance ring — is already standing in voice-alerts.e2e.mts, and that spec is
 * at its 400-line budget. A second Electron launch to say one sentence would buy nothing but 40
 * seconds.
 *
 * WHY IT IS AN E2E CLAIM AT ALL. tests/alertTargetToken.test.mts pins every link of the chain in
 * isolation — the table, the sentinels, the sanitizer, the module's firing, the resolver's output.
 * What no unit can see is the TRIP: `FiredAlert.captures` is JSON over IPC, the renderer's player
 * holds its own copy of the defs, and the value only leaves main if the def's phrase asked for it
 * (a compile-time gate in the alerts module). A hand-off that dropped the derived key would
 * type-check perfectly and ship an alert that speaks the literal characters `{target}` — which is
 * exactly the failure the owner's ruling exists to prevent. Only the real app can show the mob's
 * name coming out the far end.
 *
 * THE DEF HAS NO REGEX IN IT, and that is the whole assertion. An event kind and two literal
 * `where` values — the plain condition editor's own output shape. §5 of the host spec proves a
 * DECLARED capture group survives the trip; this proves the UNDECLARED one does, which is the
 * difference the ticket is about.
 *
 * THE LINE IS THE REPORTERS' OWN SENTENCE. `Your <hold> spell has worn off of <mob>.` is what both
 * "Mez has dropped on a ghoul" and "Soothe has worn off a Fire Giant" are — a `cc` break, which
 * spells its entity `mob` rather than `target`. That the user never has to know that is the point
 * of the table in shared/alertTargets.ts.
 *
 * IT ASSERTS THE EDITOR TOO. A token nobody is told about is a token nobody uses, so the second
 * half re-opens the def in the real dialog and reads the auto-token hint off the real DOM.
 */
import type { Page } from 'playwright-core'
import { check, countOf, settle, settleGone } from './appHarness.mjs'

const ALERT_ID = 'e2e:target-mez-break'
const PHRASE = 'Mez has dropped on {target}'
/** What the alert must SAY once the line lands. No pattern anywhere in the def produced this. */
const EXPECTED = 'Mez has dropped on a ghoul'
/** The break line, EQ's own shape. The harness restamps it to now — the module fires live-only. */
const BREAK_LINE = 'Your Mesmerization spell has worn off of a ghoul.'

/** The engine seam's utterance ring, as the host spec reads it. */
interface Spoken {
  text: string
  uttered: boolean
}

function spoken(page: Page): Promise<Spoken[]> {
  return page.evaluate(
    () => (window as unknown as { __eqSpeech?: { spoken: Spoken[] } }).__eqSpeech?.spoken ?? []
  ) as Promise<Spoken[]>
}

function textOf(page: Page, selector: string): Promise<string> {
  return page.evaluate(
    (sel) => (document.querySelector(sel) as HTMLElement | null)?.innerText ?? '',
    selector
  )
}

/** Store the def through the app's OWN IPC — the exact call AlertDialog makes on save. */
async function saveDef(page: Page): Promise<number> {
  return page.evaluate(
    async ({ id, phrase }) => {
      const eq = (window as unknown as { eq: { saveAlert: (d: unknown) => Promise<unknown[]> } }).eq
      const defs = await eq.saveAlert({
        id,
        name: 'Mez broke',
        enabled: true,
        // NO REGEX. A kind and two literal `where` values.
        trigger: { type: 'event', kind: 'cc', where: { spell: 'Mesmerization', refresh: 'true' } },
        sound: { packId: 'alan-rickman', soundId: 'task-error-task-error-08' },
        cooldownMs: 0,
        audio: 'speech',
        speech: { mode: 'custom', phrase }
      })
      return defs.length
    },
    { id: ALERT_ID, phrase: PHRASE }
  )
}

/**
 * Make the renderer's player re-read the def set.
 *
 * `refreshAlertStore` (player.tsx) re-reads on mount and on window FOCUS, and a hidden e2e window
 * is never focused — so a def stored straight through the IPC would fire in main and find no def
 * renderer-side. Dispatching the app's own focus event is the honest way to say "re-read now": the
 * same listener a returning user trips, not a test-only back door. (§5 of the host spec argues
 * this first; it is repeated here because this module can be read alone.)
 */
async function republish(page: Page): Promise<void> {
  await page.click('[data-testid="nav-alerts"]', { timeout: 60_000 })
  await page.evaluate(() => window.dispatchEvent(new Event('focus')))
  await settle(
    () =>
      page.evaluate(
        (id) =>
          (window as unknown as { eq: { listAlerts: () => Promise<{ id: string }[]> } }).eq
            .listAlerts()
            .then((d) => d.some((a) => a.id === id)),
        ALERT_ID
      ),
    (present) => present,
    { timeoutMs: 15_000 }
  )
}

/** The editor half: the plain condition editor announces the token it fills in for you. */
async function assertHint(page: Page): Promise<void> {
  const row = `[data-alert-id="${ALERT_ID}"]`
  await settle(() => countOf(page, row), (n) => n === 1, { timeoutMs: 15_000 })
  await page.click(`${row} [data-testid="alert-edit"]`)
  await page.waitForSelector('[data-testid="alert-dialog"]', { timeout: 15_000 })
  // `innerText` is EMPTY for a node that is not laid out yet and MUI's Dialog fades in, so the
  // selector existing is not the condition — the TEXT arriving is (settle.mts's whole argument).
  const hint = (
    await settle(
      () => textOf(page, '[data-testid="alert-speech-auto-tokens"]'),
      (t) => t.trim().length > 0,
      { timeoutMs: 10_000 }
    ).catch(() => '')
  ).replace(/\s+/g, ' ')
  check(
    'the editor offers {target} on a trigger that declares no capture group',
    hint.includes('{target}'),
    hint.slice(0, 110) || '(no auto-token hint rendered)'
  )
  await page.keyboard.press('Escape')
  await settleGone(page, '[data-testid="alert-dialog"]', { timeoutMs: 10_000 })
}

export async function stepTargetToken(
  page: Page,
  log: { appendAt: (at: Date, ...m: readonly string[]) => number }
): Promise<void> {
  // ── RESTORED BY JOS-500 (owner ruling 27) — THE FRAME CARRIES THE ENTITY FIELDS ─────────────
  //
  // WHAT THIS CLAIMS: the parser-extracted `{target}` — the mob a spell is affecting — reaches the
  // SPEECH seam substituted, with no regex in the def. JOS-353's acceptance, in the owner's words,
  // and the assertion below is unchanged from the one JOS-499 gated off.
  //
  // IT IS THE HARDEST OF THE THREE PARITY CLAIMS and that is why it is a separate step. `{target}`
  // is the one token filled in WITHOUT a declared capture group, which means nothing in the def
  // itself says where the value comes from: it is resolved engine-side from a closed table of
  // parser-extracted entity fields on the very event that matched, merged into the capture map
  // under the same bound and the same collision rule as a declared group, and gated on the def's
  // own phrase having written `{target}` at all. Every one of those is an evaluator decision the
  // app deliberately does not re-make (`alertsAudioRules.ts`), so the ONLY honest proof that the
  // whole chain agrees is a real def, a real live-tailed line, and the sentence that comes out.
  const saved = await saveDef(page)
  if (!check('a no-regex target alert saves through the app’s own IPC', saved > 0, `${String(saved)} defs stored`)) {
    return
  }
  await republish(page)

  // Wait for the utterance THIS step caused, by its text — the ring is app-wide and a step that
  // asserted "the newest entry" would be asserting against whatever spoke last.
  const before = (await spoken(page)).length
  log.appendAt(new Date(), BREAK_LINE)
  const all = await settle(
    () => spoken(page),
    (list) => list.slice(before).some((s) => s.text === EXPECTED),
    { timeoutMs: 20_000 }
  ).catch(() => null)
  const hit = all?.slice(before).find((s) => s.text === EXPECTED)
  check(
    'the affected mob reaches the speech seam with no regex in the def — THE ACCEPTANCE',
    hit !== undefined,
    hit ? `spoke "${hit.text}"` : `never spoke "${EXPECTED}"`
  )
  if (hit) check('…and this channel stayed mute doing it', hit.uttered === false, `uttered=${String(hit.uttered)}`)

  await assertHint(page)
}
