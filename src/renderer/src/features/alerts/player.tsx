// AlertPlayer — an always-mounted (App-level) component that turns fired alerts
// into sound, SPEECH and (JOS-378) A LINE ON SCREEN, and the `fireAppSignal` entry point for
// renderer-side app triggers.
//
// THE BANNER RIDES THE SAME PATHS AS THE AUDIO, which is why it lives here rather than in a
// second always-mounted component: "which alerts fired" is a question with one answer, and a
// surface that re-derived it would eventually disagree. It is sent FIRST and outside every audio
// rule — see `showAlertBanner` and `playAlertNow` for the two owner rulings that placement
// enforces (a muted app still shows lines; coalescing folds noise, never text).
//
// SPEECH (docs/plans/voice-alerts.md §3, wave 2) rides the SAME firing paths, decided by ONE
// pure function — `speechPlan` in lib/speech.ts — rather than by a branch at each call site:
//   audio:'sound'  (or absent) → unchanged: the pack sound, as it always was.
//   audio:'speech'            → the utterance INSTEAD of the sound.
// A def still storing the retired 'both' (JOS-362) resolves to one of those two inside
// `speechPlan` — see `resolveAlertAudio` — so this path plays ONE channel per firing, always.
// The alerts module's master MUTE and its volumes govern both halves: mute silences speech
// too, and the utterance is spoken at VoicePrefs.volume × this alert's effective volume. The
// engine itself (which tier, which voice, and the fact that the e2e channel never utters)
// lives entirely behind `speak()` — this file never touches speechSynthesis.
//
// Two firing paths converge here:
//   1. module:delta 'alerts' — the main-side AlertsModule fired an event/raw
//      trigger on a LIVE log event. We look up the def, respect mute, and play at
//      globalVolume × alert.volume. (Cooldown/enabled were already enforced in the
//      module; we don't re-check here.)
//   2. fireAppSignal('bossDefeat') — a renderer-only signal (main can't evaluate
//      it because it depends on derived boss state). App calls this exactly where
//      boss confetti fires. We match it against every enabled 'app' alert with the
//      matching signal, applying the SAME cooldown the module would.
//
// The player keeps a live copy of defs + prefs (hydrated on mount, refreshed on
// window focus and after any save via the shared store below) so both paths have
// what they need without prop-drilling.

import { useEffect } from 'react'
import type {
  AlertDef,
  AlertPrefs,
  AlertsDelta,
  AppSignal,
  FiredAlert,
  ModuleDelta
} from '@shared/types'
import {
  alertBannerText,
  alertShowsOnScreen,
  type AlertBannerPayload
} from '@shared/alertBanner'
import { playSound } from './soundCache'
import { currentVoicePrefs, loadVoicePrefs, speak, speechPlan } from '../../lib/speech'
import { audioIdentity, coalesceAudio, type AudioWindow } from './audioThrottle'
import { previewDef } from './preview'

// ---- shared, module-level alert state (so fireAppSignal works outside React) ----

let defs: AlertDef[] = []
let prefs: AlertPrefs = { globalVolume: 0.7, muted: false }
const appCooldown = new Map<string, number>()
const DEFAULT_COOLDOWN_MS = 2000
/**
 * The audio channel's current occupancy — when it was last opened, and everything already heard
 * inside that window (audioThrottle.ts). One cell for the whole app on purpose: coalescing is
 * CROSS-alert — three different alerts landing together is the case it exists for — so a per-def
 * cell would gate nothing that `cooldownMs` doesn't already gate. What makes it per-def-SAFE is
 * that the window folds by what would be HEARD (JOS-347), not by which def said it.
 */
let audioWindow: AudioWindow | null = null

const subscribers = new Set<() => void>()
/** Subscribe to defs/prefs changes (AlertsView re-reads after it saves). */
export function onAlertStoreChange(cb: () => void): () => void {
  subscribers.add(cb)
  return () => subscribers.delete(cb)
}
function notify(): void {
  for (const cb of subscribers) cb()
}

/** Re-fetch defs + prefs (including the voice prefs) from main into the shared player state. */
export async function refreshAlertStore(): Promise<void> {
  const [d, p] = await Promise.all([
    window.eq.listAlerts(),
    window.eq.getAlertPrefs(),
    // Hydrates lib/speech's own cache — the engine seam owns that copy, not this module.
    loadVoicePrefs()
  ])
  defs = d
  prefs = p
  notify()
}

export function currentPrefs(): AlertPrefs {
  return prefs
}
export function currentDefs(): AlertDef[] {
  return defs
}

/** Effective volume for an alert: globalVolume × (alert.volume ?? 1), clamped. */
function effectiveVolume(def: AlertDef): number {
  const v = (def.volume ?? 1) * prefs.globalVolume
  return Math.max(0, Math.min(1, v))
}

/**
 * Put this firing on the ALERT BANNER overlay (JOS-378), when the alert asks to be shown.
 *
 * THE PER-ALERT HALF OF THE GATE IS HERE because this is where the def is; the OVERLAY half is in
 * main, which owns the window (main/alertBanner.ts). Neither side can answer the other's question,
 * and sending an unwanted payload that main then drops would be a wire full of noise.
 *
 * WHAT IT SAYS IS NOT DECIDED HERE. `alertBannerText` resolves the def's optional override and
 * otherwise prints the alert's NAME (JOS-380) — deliberately not the spoken sentence, which is
 * written for the ear. Null means there was nothing truthful to print, and nothing is sent.
 *
 * EVERY FIRING IS ITS OWN LINE. The queue's dedupe key carries the timestamp, so a second landing
 * of the same alert stacks a second line rather than re-clocking the first — which is what the
 * reporter asked for: a banner is a short-lived record of what just happened, not a status field.
 */
function showAlertBanner(def: AlertDef, firing?: Pick<FiredAlert, 'spell' | 'captures' | 'dueAt'>): void {
  if (!alertShowsOnScreen(def)) return
  const text = alertBannerText(def)
  if (!text) return
  const ts = Date.now()
  const payload: AlertBannerPayload = { id: `${def.id}:${String(ts)}`, alertId: def.id, ts, text }
  if (def.bannerColor) payload.color = def.bannerColor
  // The COUNTDOWN, where the firing has one (JOS-216 early warnings): the card prints "… in 12s"
  // and leaves when it reaches zero instead of on the configured hold. Passed straight through —
  // this side never computes a deadline, because main is the only place one exists.
  if (firing?.dueAt !== undefined) payload.dueAt = firing.dueAt
  window.eq.showAlertBanner(payload)
}

/**
 * Fire ONE alert's audio now — sound, speech, or both — respecting the master mute. Used by
 * both firing paths and by the list's Test button.
 *
 * `firing` carries the matched event's SPELL CONTEXT (rank intact, see FiredAlert.spell) so the
 * `spellName`/`spellFirstWord` modes have something to say; omitted for a Test or an app signal,
 * where `speechTextFor` falls back to the alert's own name rather than inventing one.
 *
 * CROSS-ALERT COALESCING is applied here and only here, AFTER the sound/speech plan and only
 * when something would actually have been audible: a muted app (or a plan that resolved to
 * nothing) must not consume the window and silence the next alert for 1.5s. The firing itself
 * is already recorded upstream — this drops noise, never history. The global "always play"
 * preference (JOS-222) rides the SAME call: it is an argument to the pure decision, read off the
 * prefs copy this module already keeps live, so nothing here branches on it.
 */
export function playAlertNow(
  def: AlertDef,
  firing?: Pick<FiredAlert, 'spell' | 'captures' | 'dueAt'>
): void {
  // THE BANNER GOES FIRST, AND OUTSIDE EVERYTHING BELOW (JOS-378). Two rules the owner ruled on
  // are enforced by that one placement:
  //   MUTE IS ABOUT SOUND. A player on Discord runs the app muted precisely so they can still be
  //   told things — that report is the whole reason this overlay exists — so the banner must be
  //   sent before `speechPlan`, which returns silence for a muted app.
  //   COALESCING IS ABOUT NOISE. The 1.5 s cross-alert window (JOS-347) folds a smear of
  //   simultaneous SOUNDS into one thing to hear; four distinct alerts landing together are four
  //   things to READ, and a line that is one of four is not a smear. So it is sent before the gate
  //   too, and it neither consumes the window nor is gated by it.
  showAlertBanner(def, firing)
  const voice = currentVoicePrefs()
  const plan = speechPlan(def, firing ?? null, prefs.muted)
  if (!plan.sound && !plan.speak) return
  // The plan is resolved FIRST because the throttle folds by what would be heard, not by which
  // def is speaking: two alerts pointed at one sound with nothing to say are one audio alert,
  // and two alerts with different voice lines are two things to hear (JOS-347).
  const gate = coalesceAudio(def, Date.now(), audioWindow, {
    allAlwaysPlay: prefs.alwaysPlayAll === true,
    heard: audioIdentity(def, plan)
  })
  audioWindow = gate.window
  if (!gate.play) return
  const gain = effectiveVolume(def)
  // One channel or the other, never both (JOS-362): a plan carries a sound or an utterance. WHICH
  // VOICE says it is `voice` — the live prefs copy, read at firing time — and nothing off the def:
  // a stored `speech.voiceId` is ignored, so changing the preference changes every alert at once.
  if (plan.speak) {
    void speak(plan.speak, voice, { gain })
    return
  }
  void playSound(def.sound.packId, def.sound.soundId, gain)
}

/**
 * The row's ▶ — audition ONE alert exactly as a real firing of it would sound.
 *
 * It lives here, in the firing path's own file, rather than in the view that renders the button:
 * "preview == firing" is a property of this module, and a view that rebuilt the def itself is how
 * the two drift apart. `previewDef` (preview.ts) is the pure half — the two forced fields and
 * nothing else — so what this does is pinned by tests/alertPreview.test.mts rather than by prose.
 */
export function previewAlertNow(def: AlertDef): void {
  playAlertNow(previewDef(def))
}

/**
 * Fire a renderer-side app signal (e.g. 'bossDefeat'). Plays every enabled 'app'
 * alert whose trigger.signal matches, honoring each alert's cooldown so a
 * double-invocation in the same tick can't double-play. `context` (e.g. the boss
 * name) is reported to main via appFired so the module's recent-fires history —
 * the single source of truth — records the signal with meaningful matched text.
 */
export function fireAppSignal(signal: AppSignal, context = ''): void {
  const now = Date.now()
  for (const def of defs) {
    if (!def.enabled) continue
    if (def.trigger.type !== 'app' || def.trigger.signal !== signal) continue
    const cd = def.cooldownMs ?? DEFAULT_COOLDOWN_MS
    const last = appCooldown.get(def.id)
    if (last !== undefined && now - last < cd) continue
    appCooldown.set(def.id, now)
    playAlertNow(def)
    // Route the fire through main so history stays the single source of truth.
    window.eq.appFired(def.id, context)
  }
}

/**
 * Watch the machine's audio hardware for changes, and leave a BREADCRUMB when one happens
 * (JOS-442, trimmed to this by JOS-443).
 *
 * WHY IT IS HERE: this component is always mounted, and a device change is a fact about the app,
 * not about whichever tab happens to be open. `navigator.mediaDevices.devicechange` is the only
 * signal the renderer gets when a headset is powered on, an HDMI monitor re-enumerates, or
 * Windows moves the default endpoint — and the owner's machine did two of those in the half hour
 * before every sound in the app went silent (Microsoft-Windows-Audio/Operational, 2026-08-21:
 * the wireless headset returned to ACTIVE at 18:31:01 and both NVIDIA HDMI endpoints churned
 * NOTPRESENT→ACTIVE at 18:34:34). Nothing in the app noticed either one; now the dev log does.
 *
 * A LINE, NOT A RECORD. The timestamp used to be kept in audio health state for the Preferences
 * sound check to print beside "a sound last played 40 minutes ago". That card is gone (owner:
 * no special audio debugging tools), and state nobody reads is state that rots — so what is left
 * is the one console line, which costs nothing and is still there in dev stdout when somebody is
 * looking at a silence.
 *
 * THE BLOB CACHES ARE DELIBERATELY *NOT* DROPPED, and this is the one place to say why. A cached
 * entry is a Blob URL over bytes already in this renderer's memory: it names no device, no sink
 * and no stream, and playback binds to an output only when `new Audio(url)` is constructed and
 * played — which this app does FRESH for every single firing (soundCache.ts `playSound`, one
 * element per play, never pooled, never `setSinkId`-ed). So there is no per-sound state that can
 * go stale against a device, and dropping the cache would buy nothing but a re-fetch and a slower
 * first alert after every device change. The binding that CAN go stale is Chromium's output
 * stream, which lives in the audio service process and is not reachable from here at all — a
 * cache flush would not touch it either. Stated as measured rather than assumed: the per-play
 * element is verified in tests/soundCacheRetry.test.mts.
 */
function useAudioDeviceWatch(): void {
  useEffect(() => {
    const media = navigator.mediaDevices as MediaDevices | undefined
    if (!media?.addEventListener) return
    const onChange = (): void => {
      // console.info, NOT reportError: a device change is a normal event on a desktop and does
      // not belong in the error store's fingerprints (every one of them would be a new issue to
      // triage). The dev-stdout breadcrumb is the whole of what the app does with it.
      // eslint-disable-next-line no-console -- the tree's convention for a note that is not an error
      console.info('[everquest-companion] audio devices changed')
    }
    media.addEventListener('devicechange', onChange)
    return () => media.removeEventListener('devicechange', onChange)
  }, [])
}

/** The mounted component: hydrates the store + plays main-fired alert deltas. */
export default function AlertPlayer(): null {
  useAudioDeviceWatch()
  useEffect(() => {
    void refreshAlertStore()
    // Refresh on focus so prefs edited elsewhere (or seeded on first run) apply.
    const onFocus = (): void => void refreshAlertStore()
    window.addEventListener('focus', onFocus)

    const offDelta = window.eq.onModuleDelta<AlertsDelta>((d: ModuleDelta<AlertsDelta>) => {
      if (d.moduleId !== 'alerts') return
      for (const fire of d.delta.fired) {
        // AN ECHO IS NOT A FIRING (JOS-380). `origin: 'app'` marks the record main queued because
        // THIS player told it about a signal it had just played — replaying it here is the same
        // alert twice. It was inaudible for the life of the feature (audio coalescing swallows a
        // repeat within 1.5 s) and visible the day the banner arrived: two lines, one raid target.
        // The record still reaches history and the feed; only playback is skipped, and the play
        // stays where it is rather than moving into the echo, which would add a flush of latency
        // to the celebration sound.
        if (fire.origin === 'app') continue
        const def = defs.find((a) => a.id === fire.alertId)
        // The firing is passed through: it is where the spell context lives (W1), and the
        // speech modes are the only thing that reads it.
        if (def) playAlertNow(def, fire)
      }
    })
    // CELEBRATION TOASTS make no sound (owner, 2026-08-05). This player briefly owned a second
    // subscription — `toast:sound` — because the overlay bundle has no audio stack. It is gone:
    // the boss-kill and quest-complete ALERTS already speak on those exact events, from this
    // same player, with their own cooldowns. A card is a thing you see.
    return () => {
      window.removeEventListener('focus', onFocus)
      offDelta()
    }
  }, [])

  return null
}
