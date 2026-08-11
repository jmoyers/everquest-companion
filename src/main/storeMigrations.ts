// Persisted-settings schema migrations — "an upgrade must be clean, going back indefinitely".
//
// THE PROBLEM. `<userData>/everquest-companion-progress.json` is written by whatever build
// the user happened to be running. Builds go back to the very first commit and forward
// forever; auto-update means a user can jump many versions in one step (and the pre-rename
// `eq-tools` store is copied into this channel verbatim — see channel.ts `seedFromLegacy`,
// which runs BEFORE any of this). Every one of those files must load cleanly in the build
// running today. Before this module the app only had ad-hoc, per-reader fixups (a flat
// `overlay` folded on read, an `alertSoundMigration` stamp) — and at least one shape change
// shipped with NO fixup at all: `progress` → `byCharacter` (commit 41831cc) silently
// orphaned every pre-character store.
//
// THE SHAPE. An explicit integer `schemaVersion` INSIDE the file plus an ordered chain of
// migrations, applied once at startup before anything reads the store.
//
//   * Integer, not app semver. CI stamps versions from tags and dev runs unstamped, so
//     semver-keyed migrations (electron-store's built-in `migrations` option) fire in
//     surprising orders across channels. An ordered integer chain is deterministic: the
//     file says where it is, the code says where it must get to, the steps between are the
//     only thing that runs.
//   * Absent version ⇒ 1. That covers every store ever written before this framework, so
//     the chain starts from a single, well-defined floor.
//   * PURE runner over plain objects (`migrateStoreData`), file I/O separated
//     (`migrateStoreFile`) — the src/shared/update.ts precedent. Tests need no Electron.
//
// THE CONTRACT (this is what makes "indefinitely" real, and it lives in AGENTS.md too):
// any commit that changes a persisted shape ships a migration in the SAME commit. Never
// mutate what an old key means without a step that rewrites it.
//
// FAILURE POLICY. Startup never dies here. Every path is best-effort and logs:
//   * unreadable file  → leave it alone, no stamp (electron-store will raise its own error)
//   * unparseable file → QUARANTINE it to `<name>.corrupt.json` and start fresh. conf's
//     `clearInvalidConfig` defaults to false, so a truncated write (power loss mid-save)
//     otherwise throws on EVERY read forever — an app bricked by one bad byte.
//   * a step throws    → keep everything the earlier steps produced, stamp the last version
//     that fully succeeded, log, and retry the failing step on the next launch.
//   * newer than we know → see the downgrade note on `migrateStoreData`.
// Before the FIRST write of a run the original file is copied byte-for-byte to
// `<name>.v<from>.backup.json` (written once per source version — a later run never
// overwrites the pristine copy). At most one small file per schema version the machine has
// ever held: cheap insurance for a promise that has to hold forever.

import { existsSync, readFileSync, renameSync, writeFileSync } from 'fs'
// The ONE dependency this module takes, and a deliberate exception to the note below about
// LAUNCH_MS: shared/speechText.ts is a pure content module (it imports one rank helper and
// nothing else — no Electron, no parser, no LogEvent union), and duplicating the speech mode
// list or the 120-char cap here would create a second answer to "what is a valid speech
// config" that could drift from the one the editor and the resolver use.
import {
  ALERT_AUDIO_ACTIONS,
  MAX_SPEECH_CHARS,
  SPEECH_MODES,
  normalizeVoicePrefs
} from '../shared/speechText'
// The SECOND such exception, for exactly the same reason: shared/presencePrefs.ts is a pure
// prefs module (no Electron, no types.ts, no LogEvent union) and duplicating the ring's clamps
// here would create a second answer to "what is a valid cursor-ring config".
import { normalizeCursorRing, normalizeOverlayAutoHide } from '../shared/presencePrefs'
// The THIRD such exception, and the strictest of the three: shared/telemetry.ts is the pure,
// ZERO-IMPORT usage-analytics contract (no Electron, no parser, no types.ts), and its prefs
// normalizer is the one answer to "what is a valid telemetry pref block" that the store, the
// IPC handler and this migration all have to agree on.
import { normalizeTelemetryPrefs } from '../shared/telemetry'
// The FOURTH, and identical in kind to the third: shared/perf.ts is the pure, ZERO-IMPORT
// performance contract, and its prefs normalizer is the one answer to "what is a valid perf-HUD
// pref block" that the store, the IPC handler and this migration all have to agree on.
import { normalizePerfHudPrefs } from '../shared/perf'
// The FIFTH, and identical in kind to the third and fourth: shared/graphicsPrefs.ts is the pure,
// ZERO-IMPORT graphics-compatibility contract, and its normalizer is the one answer to "what is a
// valid graphics pref block" that the store, the IPC handler and this migration all share.
import { normalizeGraphicsPrefs } from '../shared/graphicsPrefs'

/** A store file, parsed. Deliberately untyped: a migration's INPUT is a shape the current
 *  code no longer describes, so `StoreShape` would be a lie at every step but the last. */
export type StoreData = Record<string, unknown>

/** Where the version lives inside the store file. */
export const SCHEMA_VERSION_KEY = 'schemaVersion'

/**
 * The schema the code running right now expects. Bump by exactly one whenever a persisted
 * shape changes, and add the matching MIGRATIONS entry in the same commit.
 */
export const CURRENT_SCHEMA_VERSION = 11

export interface Migration {
  /** Version this step produces. Steps run in ascending `to` order, contiguously. */
  readonly to: number
  /** One line, for the startup log and for whoever reads this file in three years. */
  readonly describe: string
  /** Rewrite `data` (a private clone — mutate it freely) into the `to` shape. */
  migrate(data: StoreData): StoreData
}

const isPlainObject = (v: unknown): v is StoreData =>
  typeof v === 'object' && v !== null && !Array.isArray(v)

/** Progress worth keeping: anything the user actually accumulated. */
function hasProgressContent(p: StoreData): boolean {
  const quests = p.completedQuests
  const inventory = p.inventory
  return (
    (Array.isArray(quests) && quests.length > 0) ||
    (isPlainObject(inventory) && Object.keys(inventory).length > 0)
  )
}

/**
 * Reserved `byCharacter` id for progress recovered from the single-character era. It is NOT
 * a real `name_server` id, so no code path can ever resolve to it (`activeCharId()` only
 * ever produces a parsed character id or 'none') — the data is preserved without INVENTING
 * an owner for it. World-model law 1: never silently guess.
 */
export const PRE_CHARACTER_PROGRESS_KEY = 'legacy:pre-character'

/**
 * 1 → 2. The framework's first step, and deliberately not a no-op: it stamps the version and
 * pays off three real debts left by shape changes that shipped without migrations.
 *
 *  (a) `progress` → `byCharacter`. The first two builds persisted ONE top-level `progress`
 *      blob; commit 41831cc re-keyed progress by character and simply stopped reading the
 *      old key. Salvaged (never guessed at an owner — see PRE_CHARACTER_PROGRESS_KEY) only
 *      when there are no real characters yet and the blob holds something; then dropped.
 *  (b) `liveLoot` inside a ProgressState. Live loot became a replayed module in commit
 *      40b274b; the persisted map has been dead weight in first-build stores ever since.
 *  (c) flat `overlay` → `overlays.fight`. Task #54 made the overlay per-kind. This used to
 *      be folded lazily on every `getOverlayConfig()` read — exactly the ad-hoc pattern
 *      this framework replaces, so it moves here and runs once.
 */
const migrateToV2: Migration = {
  to: 2,
  describe: 'stamp schemaVersion; recover pre-character progress; drop liveLoot; fold overlay → overlays.fight',
  migrate(data) {
    // (a) + (b) — per-character progress.
    const byCharacter: StoreData = isPlainObject(data.byCharacter) ? { ...data.byCharacter } : {}
    const legacyProgress = data.progress
    if (isPlainObject(legacyProgress)) {
      if (Object.keys(byCharacter).length === 0 && hasProgressContent(legacyProgress)) {
        byCharacter[PRE_CHARACTER_PROGRESS_KEY] = legacyProgress
      }
      delete data.progress
    }
    for (const [charId, progress] of Object.entries(byCharacter)) {
      if (isPlainObject(progress) && 'liveLoot' in progress) {
        const next = { ...progress }
        delete next.liveLoot
        byCharacter[charId] = next
      }
    }
    data.byCharacter = byCharacter

    // (c) — overlay config.
    const legacyOverlay = data.overlay
    if (isPlainObject(legacyOverlay)) {
      const overlays: StoreData = isPlainObject(data.overlays) ? { ...data.overlays } : {}
      // A per-kind config already written by a newer build always wins over the flat legacy one.
      if (!isPlainObject(overlays.fight)) overlays.fight = legacyOverlay
      data.overlays = overlays
      delete data.overlay
    }
    return data
  }
}

/**
 * The character-EPOCH anchor, duplicated from log/epochDetector.ts ON PURPOSE.
 *
 * This module is deliberately dependency-free: it runs from store.ts's module scope BEFORE
 * electron-store is constructed, and it is driven by a test that loads no Electron and no
 * parser. Importing the detector to reach one constant would drag the whole LogEvent union in
 * behind it. The number is the OFFICIAL LAUNCH instant (2026-07-28 00:00 local) and it can
 * never change — it is a historical fact about a game that has already launched.
 */
const LAUNCH_MS = new Date(2026, 6, 28, 0, 0, 0, 0).getTime()

/** A persisted combo correction, checked structurally — a hand-edited file can hold anything. */
function isLiveCorrection(v: unknown): boolean {
  if (!isPlainObject(v)) return false
  const startTs = v.startTs
  if (typeof startTs !== 'number' || !Number.isFinite(startTs)) return false
  // Pre-launch corrections describe the BETA character that was wiped at launch and shares this
  // log file. The module drops them in memory too; doing it here as well means an upgrading
  // user's file stops carrying them at all.
  return startTs >= LAUNCH_MS
}

/**
 * 2 → 3. Class-combo inference (docs/plans/class-combo-inference.md § 7) adds ONE key under
 * every `byCharacter` entry: `combo.corrections`, the user's manual "no, that span was
 * PAL/ROG/BER" statements. Intervals themselves are NEVER persisted — they are re-derived from
 * the log on every replay, and a persisted copy would be a second source of truth that could
 * disagree with the log it claims to describe.
 *
 * Every reader defaults on the missing key, so this step is not strictly REQUIRED for the app
 * to boot against a v2 store. It ships anyway, because the migration law is about the file
 * having a stated shape at a stated version: a v3 store says "combo lives here and it is a
 * list", and the next step that touches it can rely on that instead of re-deriving it.
 */
const migrateToV3: Migration = {
  to: 3,
  describe: 'add byCharacter[*].combo.corrections; drop pre-launch (beta-character) corrections',
  migrate(data) {
    if (!isPlainObject(data.byCharacter)) {
      data.byCharacter = {}
      return data
    }
    const byCharacter: StoreData = { ...data.byCharacter }
    for (const [charId, progress] of Object.entries(byCharacter)) {
      if (!isPlainObject(progress)) continue
      const existing = isPlainObject(progress.combo) ? progress.combo : {}
      const corrections = Array.isArray(existing.corrections) ? existing.corrections : []
      byCharacter[charId] = { ...progress, combo: { corrections: corrections.filter(isLiveCorrection) } }
    }
    data.byCharacter = byCharacter
    return data
  }
}

// ------------------------------------------------------------------ 3 → 4: voice alerts
//
// docs/plans/voice-alerts.md §2 + decision D6. Two persisted shapes move at once, so they move
// in one step: a new top-level `voice` prefs blob, and two new OPTIONAL fields on every
// `AlertDef` (`audio`, `speech`).
//
// THE ALERT HALF IS TOLERATE-AND-NORMALIZE, NOT REWRITE. An alert written before voice existed
// is already correct — an absent `audio` MEANS 'sound' and an absent `speech` MEANS "say your
// own name" — so this step never adds either key to a def that lacks it. What it does is make
// the v4 shape a PROMISE: after it runs, any `audio`/`speech` present in the file is one of the
// values the code understands. A hand-edited file, a share-import from a future build, or a
// half-written save can otherwise leave `speech.mode: "shout"` sitting in the store forever,
// where every reader has to re-check it. Malformed values are DROPPED (back to the documented
// default), never coerced into a different intent.

/** One of the closed string sets, or undefined when the value is not a member. */
function pickLiteral<T extends string>(value: unknown, allowed: readonly T[]): T | undefined {
  return typeof value === 'string' && (allowed as readonly string[]).includes(value)
    ? (value as T)
    : undefined
}

/**
 * One alert's `speech` block, or undefined when it holds nothing usable. An unknown mode is not
 * repaired into a guess — the block goes, and the def falls back to speaking its own name.
 */
function normalizeAlertSpeech(value: unknown): StoreData | undefined {
  if (!isPlainObject(value)) return undefined
  const mode = pickLiteral(value.mode, SPEECH_MODES)
  if (mode === undefined) return undefined
  const out: StoreData = { mode }
  const phrase = typeof value.phrase === 'string' ? value.phrase.trim() : ''
  if (phrase) out.phrase = phrase.slice(0, MAX_SPEECH_CHARS)
  const voiceId = typeof value.voiceId === 'string' ? value.voiceId.trim() : ''
  if (voiceId) out.voiceId = voiceId
  return out
}

/** Normalize the two voice fields on one stored alert, leaving every other field untouched. */
function normalizeAlertVoiceFields(alert: unknown): unknown {
  if (!isPlainObject(alert)) return alert
  if (!('audio' in alert) && !('speech' in alert)) return alert
  const next = { ...alert }
  const audio = pickLiteral(next.audio, ALERT_AUDIO_ACTIONS)
  if (audio === undefined) delete next.audio
  else next.audio = audio
  const speech = normalizeAlertSpeech(next.speech)
  if (speech === undefined) delete next.speech
  else next.speech = speech
  return next
}

/**
 * The v4-era voice blob: today's normalized fields PLUS the `enabled` master switch that existed
 * back then.
 *
 * WHY THIS IS NOT "EDITING A SHIPPED STEP". `normalizeVoicePrefs` stopped emitting `enabled` when
 * the master switch was retired (schema v8), and this step calls it — so without this wrapper the
 * step's OUTPUT would have silently changed under it, dropping the flag on the floor. The v8 step
 * is the one that reads that flag to decide whether the user's spoken alerts stay spoken, and for
 * a store entering the chain at v3 both steps run in the same pass. So this exists to keep v4's
 * result byte-identical to what it always produced; the value it preserves is consumed and
 * removed exactly one step later.
 */
function normalizeLegacyVoicePrefs(value: unknown): StoreData {
  return { ...normalizeVoicePrefs(value), enabled: isPlainObject(value) && value.enabled === true }
}

const migrateToV4: Migration = {
  to: 4,
  describe: 'add the voice prefs blob; normalize AlertDef.audio/.speech',
  migrate(data) {
    data.voice = normalizeLegacyVoicePrefs(data.voice)
    if (Array.isArray(data.alerts)) {
      data.alerts = (data.alerts as unknown[]).map(normalizeAlertVoiceFields)
    }
    return data
  }
}

// ------------------------------------------- 4 → 5: cursor ring + overlay auto-hide
//
// Two new top-level blobs, added in one step because they ship as one feature: the app now has
// an opinion about the EverQuest WINDOW (is it running, is it focused, where is it), and both
// settings are consumers of that one answer.
//
//   `cursorRing`       {enabled:false, sizePx:44, thicknessPx:4} — the opt-in halo.
//   `overlayAutoHide`  {hideWhenNotRunning:true, hideWhenUnfocused:false}.
//
// Same treatment as the voice blob in 3→4 and for the same reason: every reader defaults, so
// this step is not strictly required for a v4 store to boot — it ships so that a v5 store is a
// PROMISE. After it runs, whatever is in those keys is a complete, in-range blob, and the next
// step that touches them can rely on that instead of re-deriving it. Malformed values are
// replaced by the documented default (`normalize*` clamps field by field), never coerced into
// a different intent.
//
// The defaults are DELIBERATE and are the whole feature's posture: the ring is off (it costs a
// window plus an 8 ms poll), and only the uncontroversial half of auto-hide is on (overlays
// with no game to sit on are clutter; overlays vanishing every alt-tab is a preference).
const migrateToV5: Migration = {
  to: 5,
  describe: 'add the cursorRing + overlayAutoHide prefs blobs',
  migrate(data) {
    data.cursorRing = normalizeCursorRing(data.cursorRing)
    data.overlayAutoHide = normalizeOverlayAutoHide(data.overlayAutoHide)
    return data
  }
}

// -------------------------------------------------- 5 → 6: usage-analytics prefs
//
// docs/plans/usage-analytics.md wave A1. ONE new top-level blob:
//
//   `telemetry` {enabled:true, noticeShown:false, analyticsId:null}
//
// THE DEFAULTS ARE THE POLICY, and each one is a decision:
//
//   * `enabled: true` — OPT-OUT. The owner's call, taken over the integrator's opt-in
//     recommendation and recorded as such in the plan (decision T1).
//   * `noticeShown: false` — and this is what makes opt-out honest. Collection may buffer to
//     the local ring, but the NETWORK gate (`telemetryFlushEnabled`, src/main/telemetry/net.ts)
//     additionally requires this flag, so nothing can ever be transmitted before the first-run
//     notice has rendered. An upgrading user is a first-run user for this purpose: they have
//     not been told either, so they get the notice too.
//   * `analyticsId: null` — NOT minted here. A migration runs for every user, including one who
//     opens Preferences and immediately switches the feature off; creating an identifier for
//     them would be creating exactly the thing they just declined. The collector mints it on
//     its first start, and only while the switch is on.
//
// Same treatment as 3→4 and 4→5: every reader defaults, so this step is not strictly required
// for a v5 store to boot — it ships so a v6 store is a PROMISE that whatever is in the key is a
// complete, in-range block. A malformed `analyticsId` is DROPPED (⇒ the collector mints a fresh
// one) rather than repaired into something that is not a UUID.
const migrateToV6: Migration = {
  to: 6,
  describe: 'add the telemetry prefs blob (opt-out, notice not yet shown, no analytics id yet)',
  migrate(data) {
    data.telemetry = normalizeTelemetryPrefs(data.telemetry)
    return data
  }
}

// ------------------------------------------------------ 6 → 7: the performance HUD switch
//
// docs/plans/perf-profiling.md P5. ONE new top-level blob, holding one boolean:
//
//   `perfHud` {enabled:false}
//
// OFF IS THE POLICY, not a placeholder. The switch is the ONLY thing that creates the 2 s
// metrics poll and the 500 ms event-loop probe — with it off, main creates no timer at all, so
// a user who never opens Preferences → Performance pays literally nothing for this feature.
// A HUD is an instrument you reach for, not a tax on everyone who might one day want one.
//
// Nothing else about the feature is persisted here, deliberately: the live samples are a
// two-minute ring in renderer memory, and the startup profile is one disposable file
// (`<userData>/perf-startup.json`) that is rewritten every launch. Neither has any business in a
// settings file that must load cleanly in every future build, forever.
//
// Same treatment as 4→5 and 5→6: every reader defaults, so a v6 store boots fine without this
// step — it ships so a v7 store is a PROMISE that whatever is in the key is a complete, in-range
// block. A malformed value is replaced by the documented default, never coerced.
const migrateToV7: Migration = {
  to: 7,
  describe: 'add the perfHud prefs blob (performance HUD off by default)',
  migrate(data) {
    data.perfHud = normalizePerfHudPrefs(data.perfHud)
    return data
  }
}

// ------------------------------------------------ 7 → 8: the voice master switch is retired
//
// Owner, 2026-08-04: "duplicative settings; you should not have to enable voice in Preferences."
// `VoicePrefs.enabled` is gone from the model, the UI and every runtime gate — an alert whose
// `audio` says 'speech'/'both' now speaks, full stop. Which voice, how fast, how loud all stay:
// they are the voice's CONFIGURATION, never its permission.
//
// THIS STEP EXISTS SO THAT SIMPLIFYING A SETTING CANNOT CHANGE WHAT A USER HEARS. That is the
// whole of it, and it cuts one way only:
//
//   * The switch was ON  → nothing happens to the alerts. They spoke yesterday; they speak today.
//   * The switch was OFF → every alert def with `audio:'speech'` or `audio:'both'` is rewritten to
//     'sound'. Those alerts were ALREADY playing their pack sound (the retired gate degraded them
//     to it — never to silence), so this preserves exactly what the user was hearing. Leaving them
//     alone would have been the loud failure mode: a user who muted voice globally chose quiet,
//     and an update that made every one of their alerts start talking would be the app overruling
//     a decision it had just deleted the control for.
//
// ABSENT / MALFORMED COUNTS AS OFF, and that is not a guess: `enabled` was written by
// `normalizeVoicePrefs`, whose rule was `raw.enabled === true` — anything else already behaved as
// off, for years, in the only code that ever read it. So the test here is the same test.
//
// 'speech'/'both' → 'sound' is expressed by DELETING the key: absent `audio` means 'sound' by
// construction (shared/alertTypes.ts), it is the shape every pre-voice def has, and it is what
// keeps the share-string fingerprint of a rewritten def identical to a never-spoke one.
//
// THE `speech` BLOCK IS KEPT. It is inert on a sound-only def (no reader consults it unless the
// def speaks), and it is the user's own configuration — the phrase they typed, the voice they
// chose. Deleting it would turn a behavior-preserving migration into data loss, and re-picking
// "Voice (spoken)" in the row should find their words where they left them.

/** One stored alert, with a spoken `audio` folded back to the sound it was actually playing. */
function silenceSpokenAlert(alert: unknown): unknown {
  if (!isPlainObject(alert)) return alert
  if (alert.audio !== 'speech' && alert.audio !== 'both') return alert
  const next = { ...alert }
  delete next.audio
  return next
}

const migrateToV8: Migration = {
  to: 8,
  describe: 'retire voice.enabled; a store that had it off keeps its alerts on their sounds',
  migrate(data) {
    const wasEnabled = isPlainObject(data.voice) && data.voice.enabled === true
    // Drops the key: today's normalizer has no `enabled` field to emit.
    data.voice = normalizeVoicePrefs(data.voice)
    if (!wasEnabled && Array.isArray(data.alerts)) {
      data.alerts = (data.alerts as unknown[]).map(silenceSpokenAlert)
    }
    return data
  }
}

// ------------------------------------------ 8 → 9: the celebration toast defaults ON
//
// Owner, 2026-08-05: "it should be on by default." The toast overlay shipped the day before with
// `open: false` in DEFAULT_OVERLAY_CONFIG, like the five meters — and it is not like the five
// meters. A meter is a window you open when you want numbers; the toast is invisible and
// click-through except for the few seconds a card is on screen. Off by default meant a
// celebration feature nobody would ever see. The default is now `true` (store.ts).
//
// WHY A STORED `false` IS FLIPPED, and why that is honest rather than presumptuous. A default is
// only the value for an ABSENT key, so flipping it would leave every store written since
// yesterday stuck at off — and `overlays.toast.open` is written on the FIRST launch of any build
// that touches the overlay config, not only when a user reaches for the switch. The feature is
// hours old: no stored `false` in existence is a person's decision to decline it, they are all
// yesterday's default written down. So this step rewrites exactly that value, once.
//
// WHAT IT WILL NEVER DO AGAIN. This is a one-time correction of a default, not a policy that the
// app may re-enable things. It is pinned to this one version step: a user who turns the toast off
// tomorrow writes `false` into a v9 store, this step never runs against it, and the switch stays
// where they put it. (`open` is also the toast's ONLY enable — the design's `enabled` IS the
// window's open-state, so there is nothing else here to correct.)
//
// The same commit stops READING `overlays.toast.sound` / `.volume` (the sound picker is gone —
// the seeded alerts own that audio). Those keys are deliberately NOT deleted here: dropping a
// read of optional keys needs no migration, every reader defaults, and `normalizeToastConfig`
// simply stops emitting them the next time the blob is written.
const migrateToV9: Migration = {
  to: 9,
  describe: 'celebration toast defaults ON; a stored pre-default false is corrected once',
  migrate(data) {
    if (!isPlainObject(data.overlays)) return data
    const overlays: StoreData = { ...data.overlays }
    const toast = overlays.toast
    if (isPlainObject(toast) && toast.open === false) overlays.toast = { ...toast, open: true }
    data.overlays = overlays
    return data
  }
}

// ------------------------------------------------ 9 → 10: the graphics compatibility switches
//
// JOS-40. ONE new top-level blob, holding two booleans:
//
//   `graphics` {safeMode:false, opaqueOverlays:false}
//
// OFF IS THE POLICY, not a placeholder — see shared/graphicsPrefs.ts. Hardware acceleration and
// a see-through overlay are what every machine should get; these two switches exist for the
// machine that cannot, and shipping either one ON would be handing every install a workaround
// for a driver it does not have.
//
// Same treatment as 4→5, 5→6 and 6→7: every reader defaults, so a v9 store boots fine without
// this step — it ships so a v10 store is a PROMISE that whatever is in the key is a complete
// block. A malformed value is replaced by the documented default, never coerced.
//
// IT NORMALIZES LOCALLY RATHER THAN THROUGH `normalizeGraphicsPrefs`, AND THAT IS THE APPEND-ONLY
// LAW, NOT A DUPLICATION SLIP (JOS-31). This step used to call the shared normalizer, which was
// correct for exactly as long as the shared normalizer produced the v10 shape. JOS-31 changed that
// shape (booleans → 'auto' | 'on' | 'off'), so a step that kept calling it would silently start
// emitting a v11 block while claiming to have produced a v10 one — and the 10 → 11 step below,
// whose whole job is to read the v10 booleans and decide what they MEANT, would find strings.
// A shipped step's output is frozen; these two lines are what freezing it costs. (`=== true` is
// the original `typeof x === 'boolean' ? x : false` exactly — every non-`true` value, readable or
// not, was and is `false` here.)
const migrateToV10: Migration = {
  to: 10,
  describe: 'add the graphics prefs blob (software rendering + opaque overlays, both off)',
  migrate(data) {
    const v = isPlainObject(data.graphics) ? data.graphics : {}
    data.graphics = { safeMode: v.safeMode === true, opaqueOverlays: v.opaqueOverlays === true }
    return data
  }
}

// ------------------------------- 10 → 11: the graphics switches gain an `auto` state (JOS-31)
//
// A Wine user reported the celebration overlay becoming a stuck black box after a level-up
// (01KZGQZJ2HMZGRY28A7CVRG4QT, v0.7.0), which is the JOS-40 family arriving through Wine's
// compositor rather than through a driver. The fix is that the app DETECTS the prefix and takes
// the compatibility path by itself — and a two-state switch cannot express that, because it has
// no way to say "the user refused". So each switch becomes 'auto' | 'on' | 'off'
// (shared/graphicsPrefs.ts) and this step decides what each stored boolean MEANT.
//
// `false` BECOMES 'auto', AND THAT IS THE ONE JUDGEMENT IN THIS FILE WORTH ARGUING ABOUT. It is
// the same argument the 8 → 9 step made about the toast: `graphics` was WRITTEN ON EVERY LAUNCH
// that ran the 9 → 10 step, not when somebody reached for a switch, so a stored `false` is
// overwhelmingly yesterday's default written down rather than a person declining anything. Reading
// all of them as an explicit refusal would mean every Wine install that ever ran a v10 build is
// permanently excluded from the fix this ticket exists to deliver — a fix they cannot discover,
// because the symptom is that they cannot see the window that holds the switch.
//
// `true` STAYS 'on'. Nothing but a deliberate act ever wrote it, and detection must never be able
// to take a switch away from somebody who asked for it. That asymmetry is the whole step: the
// value that could only be a choice is preserved as a choice, and the value that was equally a
// choice and a default is handed to the thing that can tell them apart at runtime.
//
// WHAT THIS WILL NEVER DO AGAIN, in the 8 → 9 step's words: it is a one-time reinterpretation of a
// shape, pinned to this one version step. A user who turns a switch off tomorrow writes 'off' into
// a v11 store, and no future step gets to decide that they did not mean it.
const migrateToV11: Migration = {
  to: 11,
  describe: "graphics switches become 'auto'|'on'|'off' (a stored false was the default, so: auto)",
  migrate(data) {
    const v = isPlainObject(data.graphics) ? data.graphics : {}
    data.graphics = normalizeGraphicsPrefs({
      safeMode: v.safeMode === true ? 'on' : 'auto',
      opaqueOverlays: v.opaqueOverlays === true ? 'on' : 'auto'
    })
    return data
  }
}

/**
 * The chain, ascending. APPEND ONLY — never renumber, never edit a shipped step (a store
 * out there was migrated by the old text and will never run it again), never delete one:
 * a file written years ago still enters the chain at its own version.
 */
export const MIGRATIONS: readonly Migration[] = [
  migrateToV2,
  migrateToV3,
  migrateToV4,
  migrateToV5,
  migrateToV6,
  migrateToV7,
  migrateToV8,
  migrateToV9,
  migrateToV10,
  migrateToV11
]

/** Version recorded in `data`; anything absent, non-integer or < 1 means "pre-framework" ⇒ 1. */
export function readSchemaVersion(data: StoreData): number {
  const v = data[SCHEMA_VERSION_KEY]
  return typeof v === 'number' && Number.isInteger(v) && v >= 1 ? v : 1
}

export type MigrationStatus =
  /** Already at CURRENT_SCHEMA_VERSION — nothing ran, nothing written. */
  | 'up-to-date'
  /** The full chain from `from` to CURRENT_SCHEMA_VERSION ran. */
  | 'migrated'
  /** A step threw; `to` is the last version that fully succeeded. Retried next launch. */
  | 'partial'
  /** The file is NEWER than this build understands — see the downgrade note below. */
  | 'future'

/** TEST SEAM ONLY — production always uses MIGRATIONS + CURRENT_SCHEMA_VERSION. */
export interface MigrateOptions {
  migrations?: readonly Migration[]
  target?: number
}

export interface MigrationOutcome {
  status: MigrationStatus
  /** Version the data was at on the way in. */
  from: number
  /** Version the data is at on the way out. */
  to: number
  /** `to` of each step that ran, in order. */
  applied: number[]
  /** Set only when status is 'partial'. */
  failed?: { to: number; error: string }
  /** The migrated data. Never the same object as the input when anything ran. */
  data: StoreData
  /** Whether `data` differs from the input (⇒ the caller should persist it). */
  changed: boolean
}

/**
 * Apply the chain. PURE: no I/O, no Electron, input never mutated.
 *
 * DOWNGRADE (file version > CURRENT_SCHEMA_VERSION). The user ran a newer build and then an
 * older one — the updater's allowDowngrade is off, but a manual install regresses. We
 * DO NOT touch the data: no down-migration (a lossy inverse of a step we don't have), no
 * reset (that is the one truly unrecoverable outcome), no stamping the version backwards.
 * The old build simply runs against it best-effort, which is safe by construction here:
 * every reader in store.ts defaults on a missing or malformed key, and electron-store
 * rewrites the WHOLE parsed object on every `set`, so keys this build has never heard of
 * survive round-trips untouched. Worst case the user sees defaults for a setting this build
 * spells differently, for one session; re-upgrading restores everything. The caller takes a
 * pristine backup on this path (`migrateStoreFile`) before the old build writes anything.
 */
export function migrateStoreData(input: StoreData, opts: MigrateOptions = {}): MigrationOutcome {
  // The overrides exist for ONE reason: with a short chain there is no way to reach the
  // 'partial' path through the real registry, and a failure policy that is only asserted
  // against a copy of the loop is not asserted at all. Production never passes them.
  const chain = opts.migrations ?? MIGRATIONS
  const target = opts.target ?? CURRENT_SCHEMA_VERSION

  const from = readSchemaVersion(input)
  if (from > target) {
    return { status: 'future', from, to: from, applied: [], data: input, changed: false }
  }
  if (from === target) {
    return { status: 'up-to-date', from, to: from, applied: [], data: input, changed: false }
  }

  const ordered = [...chain].sort((a, b) => a.to - b.to)
  let data = structuredClone(input)
  let at = from
  const applied: number[] = []
  for (const step of ordered) {
    if (step.to <= at || step.to > target) continue
    try {
      // Each step gets its own clone, so a step that throws HALFWAY through mutating
      // cannot leave a torn shape behind — we simply keep the last good snapshot.
      const next = step.migrate(structuredClone(data))
      next[SCHEMA_VERSION_KEY] = step.to
      data = next
      at = step.to
      applied.push(step.to)
    } catch (err) {
      return {
        status: 'partial',
        from,
        to: at,
        applied,
        failed: { to: step.to, error: err instanceof Error ? err.message : String(err) },
        data,
        changed: applied.length > 0
      }
    }
  }
  return { status: 'migrated', from, to: at, applied, data, changed: true }
}

// --------------------------------------------------------------------- file half

export interface MigrationHooks {
  info?: (message: string) => void
  error?: (message: string) => void
}

export interface StoreFileMigration extends MigrationOutcome {
  path: string
  /** Where the pristine pre-migration copy went (absent ⇒ nothing needed backing up). */
  backupPath?: string
  /** Whether the migrated data was written back. */
  wrote: boolean
  /** No store file yet — a fresh install. Nothing to migrate; the store starts CURRENT. */
  fileMissing: boolean
  /** The file was unparseable and was moved aside; the store starts CURRENT and empty. */
  quarantinedPath?: string
  /** The file exists but could not be read. Nothing was touched and nothing may be stamped. */
  readError?: string
}

/** `…/x.json` → `…/x.v3.backup.json` — one per source version, self-describing, bounded. */
export function backupPathFor(storePath: string, fromVersion: number): string {
  const stem = storePath.replace(/\.json$/i, '')
  return `${stem}.v${fromVersion}.backup.json`
}

/** `…/x.json` → `…/x.corrupt.json`. */
export function quarantinePathFor(storePath: string): string {
  const stem = storePath.replace(/\.json$/i, '')
  return `${stem}.corrupt.json`
}

/** A store that needs nothing: a fresh install, or one we just quarantined. */
const startsCurrent = (): MigrationOutcome => ({
  status: 'up-to-date',
  from: CURRENT_SCHEMA_VERSION,
  to: CURRENT_SCHEMA_VERSION,
  applied: [],
  data: {},
  changed: false
})

/** How every failure path below names a thrown value. One spelling, so the logged text of a
 *  read/rename/write failure is identical whichever step produced it. */
const errText = (err: unknown): string => (err instanceof Error ? err.message : String(err))

/** Either the file's bytes, or the finished outcome the caller must return unchanged. */
type ReadStoreStep = { raw: string; result?: undefined } | { raw?: undefined; result: StoreFileMigration }

/** Read the store bytes. A missing file is a fresh install; any other read failure leaves the
 *  file untouched and unstamped (a file we could not read is a file we must not describe). */
function readStoreBytes(storePath: string, hooks: MigrationHooks): ReadStoreStep {
  try {
    return { raw: readFileSync(storePath, 'utf8') }
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      return { result: { ...startsCurrent(), path: storePath, wrote: false, fileMissing: true } }
    }
    const message = errText(err)
    hooks.error?.(`store schema: cannot read ${storePath} (${message}); leaving it untouched`)
    return { result: { ...startsCurrent(), path: storePath, wrote: false, fileMissing: false, readError: message } }
  }
}

/** Unparseable (or not an object): conf would throw on every single read from here on. */
function quarantineStore(storePath: string, hooks: MigrationHooks): StoreFileMigration {
  const quarantine = quarantinePathFor(storePath)
  try {
    renameSync(storePath, quarantine)
    hooks.error?.(
      `store schema: ${storePath} is not valid JSON - moved to ${quarantine} and starting from defaults`
    )
    return { ...startsCurrent(), path: storePath, wrote: false, fileMissing: true, quarantinedPath: quarantine }
  } catch (err) {
    const message = errText(err)
    hooks.error?.(`store schema: ${storePath} is not valid JSON and could not be moved aside (${message})`)
    return { ...startsCurrent(), path: storePath, wrote: false, fileMissing: false, readError: message }
  }
}

/**
 * Pristine copy of the ORIGINAL bytes, once per source version. A failure here is logged
 * but never blocks the migration: refusing to upgrade forever because a backup could not
 * be written is strictly worse than upgrading without one.
 */
function writeBackupOnce(
  storePath: string,
  raw: string,
  fromVersion: number,
  hooks: MigrationHooks
): string | undefined {
  const backup = backupPathFor(storePath, fromVersion)
  try {
    if (!existsSync(backup)) writeFileSync(backup, raw, 'utf8')
    return backup
  } catch (err) {
    hooks.error?.(`store schema: backup to ${backup} failed (${errText(err)})`)
    return undefined
  }
}

/** Write the migrated data back, recording the result of the attempt on `result`. */
function writeMigrated(
  storePath: string,
  outcome: MigrationOutcome,
  result: StoreFileMigration,
  hooks: MigrationHooks
): void {
  try {
    // Tab-indented to match conf's serializer, so our write and electron-store's writes
    // produce identical formatting instead of churning the whole file.
    writeFileSync(storePath, JSON.stringify(outcome.data, undefined, '\t'), 'utf8')
    result.wrote = true
    hooks.info?.(
      `store schema: v${outcome.from} → v${outcome.to} (${outcome.applied.join(', ') || 'no steps'}); ` +
        `backup ${result.backupPath ?? 'none'}`
    )
  } catch (err) {
    const message = errText(err)
    hooks.error?.(`store schema: v${outcome.from} → v${outcome.to} could not be written (${message}); will retry next launch`)
    result.wrote = false
    // Nothing persisted ⇒ nothing may be stamped, or the failed steps would be skipped forever.
    result.to = outcome.from
  }
}

/**
 * Read the store file, run the chain, back it up, write it back. Call ONCE at startup,
 * before electron-store is constructed. Never throws.
 */
export function migrateStoreFile(storePath: string, hooks: MigrationHooks = {}): StoreFileMigration {
  const read = readStoreBytes(storePath, hooks)
  if (read.result) return read.result
  const raw = read.raw

  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (err) {
    parsed = undefined
    void err
  }
  if (!isPlainObject(parsed)) return quarantineStore(storePath, hooks)

  const outcome = migrateStoreData(parsed)
  const result: StoreFileMigration = { ...outcome, path: storePath, wrote: false, fileMissing: false }
  if (outcome.status === 'up-to-date') return result

  const backup = writeBackupOnce(storePath, raw, outcome.from, hooks)
  if (backup !== undefined) result.backupPath = backup

  if (outcome.status === 'future') {
    hooks.error?.(
      `store schema: ${storePath} is at v${outcome.from} but this build only knows v${CURRENT_SCHEMA_VERSION}. ` +
        'Leaving it untouched and running best-effort - a downgrade never rewrites a newer store.'
    )
    return result
  }

  writeMigrated(storePath, outcome, result, hooks)
  if (outcome.status === 'partial' && outcome.failed) {
    hooks.error?.(
      `store schema: migration to v${outcome.failed.to} failed (${outcome.failed.error}); ` +
        `store left at v${result.to}, retrying next launch`
    )
  }
  return result
}
