// THE ALERT BANNER (JOS-378) — everything about it that is decidable without a window.
//
// The claims under test, stated as the product states them:
//   * a fresh install shows no banner — the kind ships OFF and holds no slot in the meter grid;
//   * what a line SAYS is ONE derivation, and it is NOT the spoken sentence (JOS-380): a filled
//     "On-screen text" wins, otherwise the line is the alert's own NAME — the short thing the
//     player wrote, where the phrase is written for the ear;
//   * the per-alert switch is absent-means-shown, so no store migration exists and nothing an
//     existing user already wrote has changed meaning;
//   * an editor that touched none of this saves the alert BYTE-IDENTICALLY (import dedupe);
//   * the wire is re-validated at main's handler: rebuilt field by field, capped, closed unions;
//   * the queue the strip runs on is the toast's, generic — its own cap and its own hold, with
//     the toast's own behaviour unchanged through the façade.
//
// Pure: no DOM, no timers, no Electron, never skips.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  ALERT_BANNER_COLORS,
  BANNER_INTRO_TEXT,
  BANNER_MAX_HOLD_MS,
  DEFAULT_ALERT_BANNER_CONFIG,
  MAX_BANNER_CHARS,
  alertBannerText,
  alertShowsOnScreen,
  introBannerPayload,
  normalizeAlertBannerConfig,
  normalizeBannerColor,
  validateAlertBannerPayload
} from '../src/shared/alertBanner'
import { speechTextFor } from '../src/shared/speechText'
import { OVERLAY_KINDS } from '../src/shared/types'
import { METER_KINDS, defaultOverlayBounds, overlayDefaultSize } from '../src/main/overlayLayout'
import { AlertsModule } from '../src/main/modules/alerts'
import { parseEvent } from '../src/main/log/parser'
import { cardReduce, type CardState } from '../src/renderer/src/overlay/cardQueue'
import { TOAST_CAP, toastReduce, type ToastCardState } from '../src/renderer/src/overlay/toastQueue'
import type { AlertDef } from '../src/shared/alertTypes'

function def(over: Partial<AlertDef> = {}): AlertDef {
  return {
    id: 'a1',
    name: 'Mez broke',
    enabled: true,
    trigger: { type: 'raw', regex: 'broke' },
    sound: { packId: 'base', soundId: 'ding' },
    ...over
  }
}

// ---- the kind itself -------------------------------------------------------------------

test('the alert banner is an overlay kind, appended after the meters, and holds no meter slot', () => {
  assert.ok(OVERLAY_KINDS.includes('alertBanner'), 'the kind exists')
  // It was the LAST kind until JOS-383 appended the con card behind it. What the claim is really
  // about is that nothing was INSERTED in front of it — an index here is a reserved dock slot, so
  // an insertion moves somebody's window (shared/types.ts states the rule).
  assert.ok(
    OVERLAY_KINDS.indexOf('alertBanner') > OVERLAY_KINDS.indexOf('respawn'),
    'APPENDED, never inserted — see shared/types.ts'
  )
  assert.ok(!METER_KINDS.includes('alertBanner'), 'a strip is not a meter and must not consume a slot')
})

test('its first-open geometry is a wide strip in the UPPER THIRD, centred, not a screen filler', () => {
  const area = { x: 0, y: 0, width: 1920, height: 1040 }
  const b = defaultOverlayBounds('alertBanner', area)
  const size = overlayDefaultSize('alertBanner', area)
  assert.deepEqual({ width: b.width, height: b.height }, size, 'the bounds carry the kind’s own size')
  assert.ok(b.width < area.width && b.height < area.height * 0.4, `not a screen filler: ${JSON.stringify(b)}`)
  assert.equal(b.x, Math.round((area.width - b.width) / 2), 'horizontally centred')
  const third = area.height / 3
  assert.ok(Math.abs(b.y - third) <= 1, `top edge a third of the way down (got ${String(b.y)})`)
})

test('the config normalizer clamps the hold and the line budget, and defaults `introduced` false', () => {
  assert.deepEqual(normalizeAlertBannerConfig(undefined), DEFAULT_ALERT_BANNER_CONFIG)
  assert.equal(normalizeAlertBannerConfig({ holdMs: 99_000 }).holdMs, BANNER_MAX_HOLD_MS, 'capped at 15s')
  assert.equal(normalizeAlertBannerConfig({ holdMs: 1 }).holdMs, 1000, 'floored at 1s')
  assert.equal(normalizeAlertBannerConfig({ maxLines: 400 }).maxLines, 8)
  assert.equal(normalizeAlertBannerConfig({ maxLines: 0 }).maxLines, 1)
  assert.equal(normalizeAlertBannerConfig({ introduced: 1 }).introduced, false, 'only a literal true counts')
  assert.equal(normalizeAlertBannerConfig({ holdMs: 'soon', maxLines: null }).holdMs, 4000, 'garbage ⇒ default')
})

test('the introduction names the window, the marking that reaches it, and where to move it', () => {
  const p = introBannerPayload(1000)
  assert.equal(p.text, BANNER_INTRO_TEXT)
  assert.match(p.text, /alert banner/i, 'says what the window is')
  assert.match(p.text, /Show on screen/, 'names the per-alert marking that reaches it')
  assert.match(p.text, /Preferences/, 'points at the switch that moves and closes it')
  assert.ok(!/[–—]/.test(p.text), 'NO EM DASHES in user-facing copy (JOS-106)')
})

// ---- what a line SAYS ------------------------------------------------------------------

test('the banner line is the alert NAME, not the spoken sentence — the eye and the ear differ', () => {
  const d = def({ name: 'Mez broke', speech: { mode: 'custom', phrase: 'Mez has dropped on {target}' } })
  const firing = { spell: 'Mesmerization III', captures: { target: 'a ghoul' } }
  assert.equal(alertBannerText(d), 'Mez broke')
  assert.notEqual(alertBannerText(d), speechTextFor(d, firing), 'the channels are free to differ (JOS-380)')
})

test('a spell mode no longer decides the banner — the name does, on every firing alike', () => {
  const d = def({ name: 'Mez broke', speech: { mode: 'spellName' } })
  assert.equal(alertBannerText(d), 'Mez broke', 'not "Mesmerization" — that is the answer the voice gives')
})

test('a SOUND-ONLY alert shows its own name — which is now simply the rule, not a fallback', () => {
  assert.equal(alertBannerText(def({ name: 'Charm break' })), 'Charm break')
})

test('a filled On-screen text REPLACES the name, and is capped', () => {
  const d = def({ name: 'Mez broke', speech: { mode: 'custom', phrase: 'a long spoken sentence' }, bannerText: 'MEZ BROKE' })
  assert.equal(alertBannerText(d), 'MEZ BROKE')
  const long = def({ bannerText: 'x'.repeat(500) })
  assert.equal((alertBannerText(long) ?? '').length, MAX_BANNER_CHARS, 'capped, never refused')
})

test('an EMPTY (or whitespace) On-screen text is not an override — it means "print the name"', () => {
  assert.equal(alertBannerText(def({ name: 'Slow fading', bannerText: '   ' })), 'Slow fading')
})

test('nothing truthful to say ⇒ null, and the player sends nothing', () => {
  assert.equal(alertBannerText({ name: '   ' }), null)
})

// ---- the echo that used to be a second firing -------------------------------------------

test('an app fire round-trips as HISTORY, not a second firing — one signal, one line', () => {
  const mod = new AlertsModule()
  mod.setDefs([
    def({ id: 'boss-defeat', name: 'Raid target defeated', trigger: { type: 'app', signal: 'bossDefeat' } }),
    def({ id: 'raw-mez', name: 'Raw mez', trigger: { type: 'raw', regex: 'begin casting' }, cooldownMs: 0 })
  ])
  mod.reset()

  // The renderer evaluated the signal, PLAYED it, and told main. Main records it and queues the
  // record onto the same delta the log fires ride — which is where the double came from.
  mod.appFired('boss-defeat', 'Lord Nagafen')
  const echoed = mod.flushDelta()?.delta.fired ?? []
  assert.equal(echoed.length, 1, 'the echo still travels: history is the one source of truth')
  assert.equal(echoed[0].origin, 'app', 'and it is MARKED, which is how the player knows not to replay it')
  // The player's rule, restated (player.tsx onModuleDelta): a marked record is skipped, so the one
  // play is the one the renderer already did. Unmarked, this was two — inaudible under audio
  // coalescing for the life of the feature, and two banner lines the day the banner shipped.
  assert.equal(1 + echoed.filter((f) => f.origin !== 'app').length, 1, 'one signal, one play')

  // …and the mark is NARROW: a main-side fire carries no origin, so the skip above can never
  // silence the alerts that only main can see.
  const cast = parseEvent('[Sat Aug 02 21:14:03 2026] You begin casting Mesmerization III.', 9)
  assert.ok(cast)
  mod.onEvent(cast, true)
  const real = mod.flushDelta()?.delta.fired ?? []
  assert.equal(real.length, 1)
  assert.equal(real[0].origin, undefined, 'a log fire is nobody’s echo')
})

// ---- the per-alert switch --------------------------------------------------------------

test('an alert on a CELEBRATED app signal defaults OFF — the card is already saying it', () => {
  const boss = def({ trigger: { type: 'app', signal: 'bossDefeat' } })
  assert.equal(alertShowsOnScreen(boss), false, 'no banner beside the celebration card')
  assert.equal(alertShowsOnScreen({ ...boss, showOnScreen: true }), true, 'an explicit true still wins')
  assert.equal(alertShowsOnScreen(def({ trigger: { type: 'event', kind: 'buffFade' } })), true, 'everything else shows')
})

test('a composite defaults off only when EVERY branch is a celebrated signal', () => {
  const both = def({
    trigger: { type: 'any', conditions: [{ type: 'app', signal: 'bossDefeat' }, { type: 'app', signal: 'questComplete' }] }
  })
  assert.equal(alertShowsOnScreen(both), false)
  const mixed = def({
    trigger: { type: 'any', conditions: [{ type: 'app', signal: 'bossDefeat' }, { type: 'raw', regex: 'broke' }] }
  })
  assert.equal(alertShowsOnScreen(mixed), true, 'it can fire on something nothing celebrates')
})

test('absent showOnScreen means SHOWN — which is why there is no store migration', () => {
  assert.equal(alertShowsOnScreen(def()), true, 'every def written before JOS-378 shows')
  assert.equal(alertShowsOnScreen(def({ showOnScreen: true })), true)
  assert.equal(alertShowsOnScreen(def({ showOnScreen: false })), false, 'false is the taming direction')
})

// ---- the wire --------------------------------------------------------------------------

test('the handler REBUILDS a payload field by field: unknown properties never survive', () => {
  const out = validateAlertBannerPayload({
    id: 'a1:5',
    alertId: 'a1',
    ts: 5,
    text: 'Mez broke',
    evil: 'passed through?',
    color: 'red'
  })
  assert.deepEqual(out, { id: 'a1:5', alertId: 'a1', ts: 5, text: 'Mez broke', color: 'red' })
})

test('a payload with no id, no alertId or no text is REFUSED, never forwarded', () => {
  assert.equal(validateAlertBannerPayload({ alertId: 'a', text: 't' }), null)
  assert.equal(validateAlertBannerPayload({ id: 'a', text: 't' }), null)
  assert.equal(validateAlertBannerPayload({ id: 'a', alertId: 'a', text: '   ' }), null)
  assert.equal(validateAlertBannerPayload('a string'), null)
  assert.equal(validateAlertBannerPayload(null), null)
})

test('the text is capped and the colour is a closed union — a window draws both', () => {
  const out = validateAlertBannerPayload({ id: 'i', alertId: 'a', text: 'y'.repeat(400), color: 'chartreuse' })
  assert.equal(out?.text.length, MAX_BANNER_CHARS)
  assert.equal(out?.color, undefined, 'an unlisted colour is DROPPED, never coerced')
  assert.equal(normalizeBannerColor('default'), undefined, "'default' is absence, not a value")
  for (const c of ALERT_BANNER_COLORS) {
    if (c !== 'default') assert.equal(normalizeBannerColor(c), c, `${c} survives`)
  }
})

test('a payload-named hold is clamped to the same bounds the config is', () => {
  assert.equal(validateAlertBannerPayload({ id: 'i', alertId: 'a', text: 't', holdMs: 99_000 })?.holdMs, BANNER_MAX_HOLD_MS)
  assert.equal(validateAlertBannerPayload({ id: 'i', alertId: 'a', text: 't', holdMs: -5 })?.holdMs, undefined)
})

test('dueAt rides the wire for a countdown, and only when it is a real timestamp', () => {
  assert.equal(validateAlertBannerPayload({ id: 'i', alertId: 'a', text: 't', dueAt: 1_700_000 })?.dueAt, 1_700_000)
  assert.equal(validateAlertBannerPayload({ id: 'i', alertId: 'a', text: 't', dueAt: 'soon' })?.dueAt, undefined)
})

// ---- the shared queue ------------------------------------------------------------------

interface Line {
  id: string
}
const line = (id: string): Line => ({ id })
const showLine = (s: CardState<Line>[], id: string, holdMs = 4000, cap = 4): CardState<Line>[] =>
  cardReduce(s, { type: 'show', payload: line(id), holdMs, cap })

test('the banner queue holds its OWN cap, and a further line evicts the OLDEST', () => {
  let s: CardState<Line>[] = []
  for (const id of ['a', 'b', 'c', 'd', 'e']) s = showLine(s, id, 4000, 4)
  assert.deepEqual(s.map((c) => c.payload.id), ['b', 'c', 'd', 'e'], 'newest last, oldest gone')
})

test('…and its OWN hold: the arrival names it, so Preferences changes the next line', () => {
  const s = showLine([], 'a', 2000)
  assert.equal(s[0].remainingMs, 2000)
  assert.equal(showLine([], 'b', 9000)[0].remainingMs, 9000)
})

test('a line holds, then exits — and pointing at it pauses only that line', () => {
  let s = showLine(showLine([], 'a', 1000), 'b', 1000)
  s = cardReduce(s, { type: 'hover', id: 'a', over: true })
  for (let t = 0; t < 1000; t += 100) s = cardReduce(s, { type: 'tick', dtMs: 100 })
  assert.equal(s.find((c) => c.payload.id === 'a')?.exitingMs, null, 'the pinned line is still holding')
  assert.notEqual(s.find((c) => c.payload.id === 'b')?.exitingMs, null, 'its neighbour left on time')
})

test('THE TOAST IS UNCHANGED through the façade: three cards, and a fourth evicts the oldest', () => {
  let s: ToastCardState[] = []
  for (const id of ['a', 'b', 'c', 'd']) {
    s = toastReduce(s, { type: 'show', payload: { id, kind: 'bossKill', title: id, durationMs: 6000 } })
  }
  assert.equal(s.length, TOAST_CAP)
  assert.deepEqual(s.map((c) => c.payload.id), ['b', 'c', 'd'])
  assert.equal(s[0].remainingMs, 6000, 'a toast’s hold still rides its own payload')
})
