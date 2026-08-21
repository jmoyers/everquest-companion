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
//     (`migrateStoreFile`, now in ./storeFile.ts) — the src/shared/update.ts precedent. Tests
//     need no Electron.
//
// THE CONTRACT (this is what makes "indefinitely" real, and it lives in AGENTS.md too):
// any commit that changes a persisted shape ships a migration in the SAME commit. Never
// mutate what an old key means without a step that rewrites it.
//
// FAILURE POLICY, AND WHERE IT LIVES. Startup never dies over the store. The pure chain below
// answers for the DATA (a step that throws keeps what the earlier steps produced, stamps the last
// version that fully succeeded, and retries next launch; a store from a newer build is never
// rewritten — see the downgrade note on `migrateStoreData`). Everything about the FILE — reading
// it, quarantining an unparseable one, SALVAGING it before accepting defaults, the pristine
// per-version backup, and the atomic write-back — moved to `./storeFile.ts` in JOS-272, which was
// the only way to add a recovery path to a module already sitting at the 400-code-line ceiling.
// That file's header carries the whole of the failure policy it owns.

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
// The SIXTH, and identical in kind to the third, fourth and fifth: shared/processPriority.ts is a
// pure, ZERO-IMPORT contract, and its normalizer is the one answer to "what is a valid
// process-priority pref block" that the store, the IPC handler and this migration all share.
import { normalizeProcessPriorityPrefs } from '../shared/processPriority'
// The SEVENTH, and identical in kind to the third through sixth: shared/resistPrefs.ts is a pure,
// ZERO-IMPORT contract, and its normalizer is the one answer to "what is a valid resist-evidence
// pref block" that the store, the IPC handler and this migration all share.
import { normalizeResistPrefs } from '../shared/resistPrefs'

/** A store file, parsed. Deliberately untyped: a migration's INPUT is a shape the current
 *  code no longer describes, so `StoreShape` would be a lie at every step but the last. */
export type StoreData = Record<string, unknown>

/** Where the version lives inside the store file. */
export const SCHEMA_VERSION_KEY = 'schemaVersion'

/**
 * The schema the code running right now expects. Bump by exactly one whenever a persisted
 * shape changes, and add the matching MIGRATIONS entry in the same commit.
 */
export const CURRENT_SCHEMA_VERSION = 14

export interface Migration {
  /** Version this step produces. Steps run in ascending `to` order, contiguously. */
  readonly to: number
  /** One line, for the startup log and for whoever reads this file in three years. */
  readonly describe: string
  /** Rewrite `data` (a private clone — mutate it freely) into the `to` shape. */
  migrate(data: StoreData): StoreData
}

/** Exported for `./storeFile.ts`, the file half split out of here (JOS-272): "is this parsed value
 *  a store at all" has to have one answer on both sides of that cut. */
export const isPlainObject = (v: unknown): v is StoreData =>
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

// ------------------------------- 11 → 12: the companion yields the CPU to the game (JOS-366)
//
// ONE new top-level blob, holding one boolean:
//
//   `processPriority` {yieldToGame:true}
//
// ON IS THE POLICY, and it is the opposite call from the two blobs above it — which is worth
// stating plainly, because "a new switch ships off" is otherwise the house rule. `perfHud` and
// `graphics` are INSTRUMENTS and WORKAROUNDS: a HUD is something you reach for, a software
// renderer is a fix for a driver most machines do not have, and shipping either one on would be
// charging everybody for a minority's need. This is neither. Below-normal priority is a statement
// about what this app IS relative to the game it sits beside — it is never the foreground
// experience, and nothing it does is latency-critical — so the honest default is the one the
// player would pick if they knew the question existed. The people it helps most are precisely the
// ones who will never open Preferences → Performance.
//
// EXISTING INSTALLS GET `true` TOO, deliberately: an absent key normalizes to the default, so
// this step writes `true` into every store that predates the feature. That is not overruling
// anybody — nobody has ever expressed a preference here, because there was no control to express
// it with. The moment there is one, a stored `false` is a decision, and no future step gets to
// reinterpret it (the 8 → 9 step's promise, kept).
const migrateToV12: Migration = {
  to: 12,
  describe: 'add the processPriority prefs blob (yield CPU to the game, on by default)',
  migrate(data) {
    data.processPriority = normalizeProcessPriorityPrefs(data.processPriority)
    return data
  }
}

// ------------------------------- 12 → 13: the exclusive-fullscreen note's memory (JOS-375)
//
// ONE key deleted: `eqExclusiveNoticeDismissedVersion`, the app version at which an install
// dismissed the JOS-368 Preferences note about EverQuest running in exclusive fullscreen.
//
// THE NOTE WAS WRONG, NOT MERELY UNWANTED. It told a player their game was in an EXCLUSIVE
// display mode — the one an always-on-top overlay cannot share — on the strength of
// `Fullscreen=1` in `eqclient.ini`. On the current client that setting is a BORDERLESS
// fullscreen WINDOW, which shares the screen with an overlay perfectly well, so the sentence
// could never be true for anybody it was shown to. It was removed rather than reworded, and its
// memory has nothing left to remember.
//
// A STEP RATHER THAN A TOLERATED ORPHAN, which is this file's standing answer for a key whose
// reader is gone (1 → 2's `liveLoot`, verbatim): a dead key left in the file is a thing a future
// reader has to look up before they can rule it out, and the whole point of a versioned chain is
// that the file on disk matches the shape the code believes in. `delete` on a key that is not
// there is a no-op, so this is a no-op for every install that never dismissed the note — which,
// since JOS-368 shipped in no release at all, is every install outside the dev cohort.
const migrateToV13: Migration = {
  to: 13,
  describe: "drop eqExclusiveNoticeDismissedVersion (the note it remembered is gone)",
  migrate(data) {
    delete data.eqExclusiveNoticeDismissedVersion
    return data
  }
}

// ------------------------------- 13 → 14: which casters teach the resist profiles (JOS-385)
//
// ONE new top-level blob, holding one boolean:
//
//   `resists` {includeNpcCasters:true}
//
// ON IS THE POLICY, and it was MEASURED rather than assumed — which is the whole reason this
// switch exists at all. JOS-382 refused NPC-on-NPC evidence outright; the owner's worry when he
// reopened it was specific and testable (a player's fire spells get resisted where a charmed pet's
// do not, because pets are tuned differently, so folding pet casts in would quietly drag a mob's
// fire number down). The `--compare` mode of scripts/gen-resist-baseline.ts put both populations
// through the same estimator on the owner's log, and the skew the worry describes is not there.
// So the family ships on, and the switch stays because the answer is the kind that can change.
//
// EXISTING INSTALLS GET `true` TOO, deliberately, and for the 11 → 12 step's reason verbatim: an
// absent key normalizes to the default anyway, nobody has ever expressed a preference here because
// there was no control to express it with, and after this step a stored `false` is a decision that
// no future step gets to reinterpret.
//
// NOTHING ABOUT THE LEDGER MOVES. The switch is read when a card is DRAWN, never when a log is
// folded (shared/resistPrefs.ts says why at length), so this step changes what a number weighs and
// not one byte of what was observed. There is no data to rewrite and nothing to invalidate.
const migrateToV14: Migration = {
  to: 14,
  describe: 'add the resists prefs blob (NPC and pet casters count as evidence, on by default)',
  migrate(data) {
    data.resists = normalizeResistPrefs(data.resists)
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
  migrateToV11,
  migrateToV12,
  migrateToV13,
  migrateToV14
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

