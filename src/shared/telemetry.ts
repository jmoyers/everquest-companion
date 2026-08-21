// ============================================================================
// TELEMETRY CONTRACT — the ONE definition of what usage analytics may ever say.
// ============================================================================
//
// Imported by FOUR consumers and owned by none of them:
//   * the renderer          (`window.eq.track()` builds these values and nothing else),
//   * the main process      (re-validates at the IPC boundary before a single event is
//                            buffered — renderer input is untrusted, same law as every
//                            other handler),
//   * the doc generator     (`src/shared/telemetryDoc.ts` renders TELEMETRY.md from the
//                            tables below, so the published doc cannot drift from the code),
//   * the ingest Lambda     (wave A2 — `validateTelemetryBatch` is the server's whole shape
//                            check, exactly as `validateSubmit` is for feedback).
//
// THE VALIDATORS LIVE NEXT DOOR, in `./telemetryValidate.ts`. That split is a factoring
// decision and nothing more (the contract plus its validators is past the repo's 400-code-line
// ceiling); the two files are one definition and only ever move together.
//
// LAWS THIS FILE OBEYS (docs/plans/usage-analytics.md T2):
//
//   * PURE. Zero imports — no `node:`, no Electron, no DOM, not even `shared/types.ts`.
//     It compiles under both tsconfigs, is read by `storeMigrations.ts` at store.ts's module
//     scope, and has to bundle into a Lambda. (`tests/telemetryContract.test.mts` pins the
//     duplicated overlay-kind list against the real `OVERLAY_KINDS`, so the copy cannot rot.)
//
//   * THE SCHEMA CANNOT EXPRESS A NAME. Every string-typed field is either a member of a
//     CLOSED enum declared in this file or PATTERN-BOUND by a regex declared in this file.
//     A character, zone, mob, spell, item or log line has nowhere to go — not because we
//     remember to strip it, but because the type has no slot for it.
//
//     THAT SENTENCE USED TO SAY "there is no free-text field anywhere in the event union",
//     with `analyticsId` and `appVersion` as its only two exceptions, AND JOS-100 CHANGED IT.
//     `errorReport` carries a REDACTED MESSAGE and a stack of BUNDLE-RELATIVE frames, because
//     the owner's ruling on that ticket is that an error report is worth having only if it is
//     specific enough to fix from — diagnosability over pure anonymity, holding ONE bright
//     line: GAMEPLAY DATA NEVER RIDES AUTOMATICALLY. The line is held by shape, not by
//     discipline (src/shared/errorReport.ts states the whole argument):
//       - the message is the OUTPUT of the shared redactor, and the SERVER RE-RUNS the
//         redaction and refuses a message that changes under it;
//       - a frame's file must match `^out/` — the absolute prefix that names a person is cut
//         off before the value exists, not filtered on the way past;
//       - the breadcrumbs are parser event KINDS from a closed enum, never event content.
//     Everything else in the union is unchanged and still enum- or bucket-bound.
//
//   * WHERE A RAW NUMBER IS ITSELF REVEALING, THE SCHEMA CARRIES A BUCKET, and the bucket
//     EDGES are declared here so TELEMETRY.md prints them exactly. "How many characters do
//     you play" and "how big is your log" are facts about a person; "3–4" and "100–512 MB"
//     are facts about a population.
//
//   * The validators are TOTAL and side-effect free: every failure is a typed value, nothing
//     throws, and the same call on the same input always returns the same answer.
//
// THE LIVE-SESSION RIDERS LIVE NEXT DOOR TOO, in `./telemetryLive.ts` (JOS-367) — the three
// optional groups `sessionHeartbeat` / `sessionEnd` carry about a RUNNING session (how late our
// clocks ran, what the tail's reads cost, what was switched on) plus their three ladders. Split
// for the same factoring reason the validators were, and reached DIRECTLY by its importers rather
// than re-exported from here, so every one of those names is spelled in exactly one place. The
// import below is TYPE-ONLY: this file still emits no runtime import, which is the property the
// Lambda bundle and `storeMigrations.ts`'s module-scope read both depend on.

import type { LiveStallStats, SessionStateStats, TailReadStats } from './telemetryLive'

/** Bumped only for a BREAKING wire change; the server rejects anything else outright. */
export const TELEMETRY_API_VERSION = 1

// ---------------------------------------------------------------- closed enums
//
// Every one of these is a CLOSED set that grows by schema PR only. That is the whole point:
// a value not listed here is refused by the validator on the client before it is buffered and
// again on the server before it is counted.

/** `'e2e'` is deliberately absent — the headless harness never sends (T7). */
export const TELEMETRY_CHANNELS = ['prod', 'dev'] as const
export type TelemetryChannel = (typeof TELEMETRY_CHANNELS)[number]

/** `process.platform`, folded to a closed set. A raw platform string is still a string. */
export const TELEMETRY_PLATFORMS = ['win32', 'darwin', 'linux', 'other'] as const
export type TelemetryPlatform = (typeof TELEMETRY_PLATFORMS)[number]

/**
 * The app's top-level views (`renderer/src/appViews.ts`). Duplicated rather than imported
 * because that module is renderer-only (it reads a vite define through `devFlags`), and this
 * file may import nothing at all.
 */
export const TELEMETRY_VIEWS = [
  'overview',
  'combat',
  'mobs',
  'maps',
  'bosses',
  'posky',
  'alerts',
  'leveling',
  'loot',
  'planner',
  'buffs',
  // The respawn clocks (JOS-194). SAME CLOSED-ENUM DEPLOY ORDER as every member added since
  // JOS-119: the ingest Lambda validates through this module, so the server has to learn the value
  // before a client that can emit it ships, or one dwell on this tab 400s the whole batch.
  'timers',
  // The gear planner's search surface (JOS-284). SAME CLOSED-ENUM DEPLOY ORDER as every member
  // added since JOS-119, and it is the reason this comment keeps being written: the ingest Lambda
  // validates through this module, so the server has to learn the value before a client that can
  // emit it ships, or one dwell on this tab 400s the whole batch and drops every counter in it.
  'gear',
  // The gear area's Wish list tab (JOS-324). SAME CLOSED-ENUM DEPLOY ORDER as every member added
  // since JOS-119 — the ingest Lambda validates through this module, so the server has to learn
  // the value before a client that can emit it ships, or one dwell on this tab 400s the whole
  // batch and drops every counter in it. It is here rather than held back with the UNRELEASED
  // views because it is a REACHABLE tab from the day this ships: it draws a placeholder until
  // JOS-326 fills it, and how often anyone opens a placeholder is exactly the sort of thing the
  // dwell histogram is for.
  'wishlist',
  // The gear area's Character tab (JOS-45, released JOS-327). SAME CLOSED-ENUM DEPLOY ORDER as every
  // member added since JOS-119 — the ingest Lambda validates through this module, so the server has
  // to learn the value before a client that can emit it ships, or one dwell on this tab 400s the
  // whole batch and drops every counter in it.
  //
  // IT IS HERE BECAUSE THE GATE CAME OFF, and the two edits are one edit: the tab was held out of
  // this list from JOS-45 for the reason `tests/telemetryContract.test.mts` states — a surface no
  // packaged user can reach is not worth the deploy risk — and that test pins the converse just as
  // hard, so releasing the view without adding it here is a red build. Graduation is both halves at
  // once, which is exactly what JOS-327 did.
  'character',
  'preferences',
  'triage'
] as const
export type TelemetryView = (typeof TELEMETRY_VIEWS)[number]

/** The floating-overlay kinds (`shared/types.ts OVERLAY_KINDS`; parity is pinned). */
export const TELEMETRY_OVERLAY_KINDS = [
  'fight',
  'overall',
  'heal-fight',
  'heal-overall',
  'events',
  'toast',
  'buffs',
  // JOS-119 split the one buff/timer window into two placeable windows. A CLOSED ENUM the server
  // validates, so this member has to reach the ingest Lambda BEFORE any client that can emit it:
  // `validateTelemetryBatch` fails the WHOLE batch on one unknown value and the endpoint answers
  // 400, which the client classes as a permanent refusal and drops. Deploy order, not a preference.
  'debuffs',
  // JOS-195 added the XP window. SAME DEPLOY ORDER AS THE ROW ABOVE, and for the same reason:
  // the enum is CLOSED and the ingest Lambda validates it through this very module, so a batch
  // carrying an unknown value is refused WHOLE with a 400 that the client classes as permanent
  // and drops. The server ships first.
  'xp',
  // JOS-194 added the respawn-clock window. THE SAME DEPLOY ORDER APPLIES A THIRD TIME, for the
  // third identical reason: the enum is CLOSED, the ingest Lambda validates through this module,
  // and a batch carrying a value the server has not learned yet is refused WHOLE with a 400 the
  // client classes as permanent and drops. The server ships first.
  'respawn',
  // JOS-378 added the alert banner. THE SAME DEPLOY ORDER APPLIES A FOURTH TIME, for the fourth
  // identical reason: the enum is CLOSED, the ingest Lambda validates through this module, and a
  // batch carrying a value the server has not learned yet is refused WHOLE with a 400 the client
  // classes as permanent and drops. The server ships first.
  'alertBanner',
  // JOS-383 added the con card. THE SAME DEPLOY ORDER APPLIES A FIFTH TIME, for the fifth identical
  // reason: the enum is CLOSED, the ingest Lambda validates through this module, and a batch
  // carrying a value the server has not learned yet is refused WHOLE with a 400 the client classes
  // as permanent and drops. The server ships first.
  'conCard'
] as const
export type TelemetryOverlayKind = (typeof TELEMETRY_OVERLAY_KINDS)[number]

/**
 * The feature-reach enum (plan §2). It is deliberately WIDER than the call sites wave A1
 * wires: the enum exists so later waves add a `track()` call without touching the schema,
 * the doc, or the server. An entry with no call site simply never appears in the data.
 */
export const TELEMETRY_FEATURES = [
  'mapOpen',
  'mapSearch',
  'rangeSelect',
  'comboCorrection',
  'feedbackOpen',
  'alertGroupAdd',
  'drillPet',
  'copyView',
  'speechPreview',
  'procAnalyticsOpen',
  'questFavorite',
  'lootFilter',
  'profileSwitch'
] as const
export type TelemetryFeature = (typeof TELEMETRY_FEATURES)[number]

/**
 * Which TTS tier a session would speak with (voice-alerts §2).
 *
 * 'off' HAD TO BE REDEFINED and this is the honest replacement. It used to mean "the Preferences
 * master switch is off" — the switch that decided whether any alert could speak. That switch was
 * retired (2026-08-04, schema v8): an alert speaks because ITS OWN `audio` says so, and the tier
 * is now pure configuration that is always set to something. So 'off' now means the only thing
 * "this install does not use speech" can still mean: NO ENABLED ALERT IS SET TO SPEAK. 'system' /
 * 'kokoro' therefore say "at least one alert speaks, through this tier", which is what the
 * question was always after.
 *
 * The producer is unbuilt (usage-analytics A1 ships `setupSnapshot` deliberately dark), so this
 * is a contract note, not a description of running code — the mapping is stated here so whoever
 * builds the emitter cannot re-derive the old meaning from the old name.
 */
export const TELEMETRY_VOICE_ENGINES = ['system', 'kokoro', 'off'] as const
export type TelemetryVoiceEngine = (typeof TELEMETRY_VOICE_ENGINES)[number]

// ---------------------------------------------------------------- the machine class (JOS-364)
//
// THE AXIS EVERY PERFORMANCE NUMBER GETS SLICED BY, and it exists because a field report this
// app could not answer: "EverQuest freezes for about a second when an overlay shows". Nothing
// in the fleet said what the machine WAS — how many cores, how much memory, whose GPU, whether
// Chromium was compositing in hardware at all, how many displays, or whether the game was
// running fullscreen rather than windowed. Every reading below is a CLOSED ENUM or a BUCKET
// INDEX: none of them can carry a path, a device string or a name.

/**
 * Who made the GPU, from `app.getGPUInfo('basic')`'s PCI vendor id — 0x10de, 0x1002, 0x8086 and
 * then 'other'. `unknown` is a real member and is not a failure: the call is asynchronous and is
 * given a hard cap, and a machine that has not answered in time is honestly unknown rather than
 * quietly filed under 'other'.
 *
 * A VENDOR IS NOT A DEVICE. The model name Chromium also offers ('NVIDIA GeForce RTX 4070 Ti
 * SUPER') is a far narrower fingerprint than this app has any use for, so the schema cannot
 * express it — three ids and a fallback is the whole vocabulary.
 */
export const TELEMETRY_GPU_VENDORS = ['nvidia', 'amd', 'intel', 'other', 'unknown'] as const
export type TelemetryGpuVendor = (typeof TELEMETRY_GPU_VENDORS)[number]

/**
 * How Chromium is compositing, folded from `app.getGPUFeatureStatus().gpu_compositing` — whose
 * raw vocabulary ('enabled', 'disabled_software', 'enabled_readback', 'unavailable_off', …) is
 * neither closed nor stable across Chromium versions, which is exactly why it is folded into
 * three named states plus `unknown` HERE rather than sent verbatim.
 *
 * It is the reading that separates two machines with the same GPU: a driver that has fallen back
 * to software compositing draws every overlay show on the CPU, and that is a different app.
 */
export const TELEMETRY_GPU_COMPOSITING = ['hardware', 'software', 'off', 'unknown'] as const
export type TelemetryGpuCompositing = (typeof TELEMETRY_GPU_COMPOSITING)[number]

/**
 * How EverQuest itself is drawing, read ONCE per session from the install's `eqclient.ini`
 * (`WindowedMode=TRUE` ⇒ windowed, `FALSE` ⇒ fullscreen; the live Legends client writes no such
 * key and is read from `Fullscreen=1|0` instead — see `eqWindowModeOf`).
 *
 * `fullscreen` MEANS THE GAME'S OWN FULLSCREEN SETTING IS ON, AND NOTHING MORE (JOS-375). On the
 * current client that setting produces a BORDERLESS FULLSCREEN WINDOW, not an exclusive display
 * mode: an always-on-top window shares the screen with it, and showing one costs no mode switch.
 * The member was called `exclusive` when this field was written (JOS-364) on the assumption that
 * it was the DirectX-era exclusive mode, and the name was a claim the reading could not support
 * — the ini says which setting is on, never which of the two kinds of fullscreen the client
 * implements. It was renamed rather than kept, because a dimension that lies is worse than one
 * that is coarse.
 *
 * IT IS A DISPLAY SETTING, NOT GAMEPLAY. Nothing about a character, a server or a log line is
 * involved — the file is read for one boolean and nothing else is retained. The reason it is
 * worth a field at all is that it is still the best axis the fleet has for "the game froze for a
 * second when the overlay appeared": how the game presents itself is the other half of every
 * z-order stall, whichever kind of fullscreen turns out to be behind it. `unknown` when there is
 * no install dir, no file, or no key — the honest answer, and the common one on a machine where
 * discovery never found EverQuest.
 */
export const TELEMETRY_EQ_WINDOW_MODES = ['fullscreen', 'windowed', 'unknown'] as const
export type TelemetryEqWindowMode = (typeof TELEMETRY_EQ_WINDOW_MODES)[number]

/** The auto-update release channel. */
export const TELEMETRY_UPDATE_CHANNELS = ['main', 'stable'] as const
export type TelemetryUpdateChannel = (typeof TELEMETRY_UPDATE_CHANNELS)[number]

/** The three funnels of plan §3. */
export const TELEMETRY_FUNNELS = ['first-run', 'voice-install', 'feedback'] as const
export type TelemetryFunnel = (typeof TELEMETRY_FUNNELS)[number]

/**
 * Each funnel's steps, in ORDER — the order is the funnel (the panel reads conversion between
 * adjacent entries). A step is legal only inside its own funnel; `validateFunnelStep` checks
 * the PAIR, so `{funnel:'feedback', step:'downloadStarted'}` is refused.
 */
export const TELEMETRY_FUNNEL_STEPS: Readonly<Record<TelemetryFunnel, readonly string[]>> = {
  'first-run': [
    'installed',
    'logDetected',
    'firstParse',
    'firstNonOverviewView',
    'firstOverlayEnabled'
  ],
  'voice-install': ['engineSelected', 'downloadStarted', 'downloadCompleted', 'firstUtterance'],
  feedback: ['dialogOpened', 'sendPressed', 'sendFinished']
}

/** How a step ended, when it ended at all. Absent means "reached", which is the common case. */
export const TELEMETRY_OUTCOMES = ['ok', 'failed', 'queued'] as const
export type TelemetryOutcome = (typeof TELEMETRY_OUTCOMES)[number]

/** A COARSE class, never a message. Five values, and 'other' is where everything else lands. */
export const TELEMETRY_FAILURE_CLASSES = [
  'network',
  'checksum',
  'disk',
  'timeout',
  'other'
] as const
export type TelemetryFailureClass = (typeof TELEMETRY_FAILURE_CLASSES)[number]

/** The auto-updater's three observable steps. */
export const TELEMETRY_UPDATE_STEPS = ['check', 'download', 'apply'] as const
export type TelemetryUpdateStep = (typeof TELEMETRY_UPDATE_STEPS)[number]

// ------------------------------------------------------------- the error report (JOS-100)
//
// Everything below belongs to `EvErrorReport`. It is grouped rather than scattered because it
// is the ONE part of this contract whose strings are pattern-bound rather than enum-bound, and
// a reader auditing that claim should be able to read every pattern in one place.

/** Which half of the app was running when it threw. The registry's replay bracket decides
 *  (JOS-60: a replay is a STATE, not a per-event flag), so this cannot disagree with it. */
export const TELEMETRY_ERROR_MODES = ['live', 'replay'] as const
export type TelemetryErrorMode = (typeof TELEMETRY_ERROR_MODES)[number]

/**
 * The views an error may be attributed to: every dwell view, plus `unknown`.
 *
 * `unknown` IS NOT A GAP, it is the honest answer for a main-process error that fired before
 * any window told us what it was showing. Guessing 'overview' because it is the default would
 * put a made-up number in the one column a reader would use to decide where to look.
 */
export const TELEMETRY_ERROR_VIEWS = [...TELEMETRY_VIEWS, 'unknown'] as const
export type TelemetryErrorView = (typeof TELEMETRY_ERROR_VIEWS)[number]

/**
 * THE BREADCRUMB VOCABULARY: every `LogEventKind`, duplicated from `./logEventKinds.ts` rather
 * than imported — this file may import nothing at all, and that module reaches `./types.ts`.
 * The `TELEMETRY_OVERLAY_KINDS` precedent exactly, and it is pinned the same way:
 * `tests/errorReportContract.test.mts` asserts this list equals `ALL_LOG_EVENT_KINDS`, so the
 * copy cannot rot.
 *
 * A KIND IS NOT CONTENT. `damage` says a damage line was parsed; it does not say who hit what
 * for how much. That distinction is the entire reason breadcrumbs are allowed to exist.
 */
export const TELEMETRY_BREADCRUMB_KINDS = [
  'zone', 'loot', 'offer', 'trade', 'level', 'aaGain', 'aaSpend', 'aaPotion', 'aaActivate',
  'death', 'playerDeath', 'damage', 'heal', 'healUnstated', 'mitigation', 'miss', 'resist',
  'charm', 'uncharm', 'cc', 'petClaim', 'petSay', 'castBegin', 'castFizzle', 'castInterrupted',
  'buffApply', 'buffFade', 'buffWearOff', 'illusionFade', 'buffExpired', 'spellEmote',
  'stanceChange', 'invocationChange', 'spellMemorize', 'spellForget', 'spellSet',
  'consider', 'poisonProc', 'poisonCoat', 'poisonDry',
  'epoch', 'unknown'
] as const
export type TelemetryBreadcrumbKind = (typeof TELEMETRY_BREADCRUMB_KINDS)[number]

/** How old the session was when it threw. 1 min / 5 min / 30 min / 2 h ⇒ five buckets. A raw
 *  uptime beside a timestamp is more identifying than the fact "it broke early". */
export const SESSION_AGE_MS_EDGES = [60_000, 5 * 60_000, 30 * 60_000, 2 * 60 * 60_000] as const

/** Breadcrumbs per report — the same ten as the frames, and for the same reason. */
export const MAX_BREADCRUMBS = 10
/** Ceiling for a breadcrumb's offset: ten minutes. Anything older is not context. */
export const MAX_BREADCRUMB_OFFSET_MS = 10 * 60_000
/** Distinct fingerprints one report may carry per drain — the client's own storm bound. */
export const MAX_SESSION_FINGERPRINTS = 20

/**
 * WIRE BOUNDS FOR THE ERROR REPORT. Restated here rather than imported from
 * `./errorReport.ts` so this file keeps its no-imports property; the contract test pins each
 * pair equal, so a change in one place fails the suite rather than drifting.
 */
export const MAX_REDACTED_MESSAGE_WIRE = 200
export const MAX_ERROR_FRAMES_WIRE = 10
export const MAX_FRAME_POSITION_WIRE = 1_000_000
export const MAX_FRAME_FUNC_WIRE = 80
/** External (non-bundle) frames per report — JOS-111, `MAX_EXTERNAL_FRAMES` in errorReportLocation.ts. */
export const MAX_EXTERNAL_FRAMES_WIRE = 5
/** Component names in a `componentPath` — JOS-111, and the `{0,7}` inside `COMPONENT_PATH_RE`. */
export const MAX_COMPONENT_DEPTH_WIRE = 8

/**
 * WHERE `frames` CAME FROM (JOS-111). `thrown` is the throw's own stack, which is what every
 * frame on this event meant before the field existed. `capture` is the site that CAUGHT it,
 * synthesised because the payload had no stack of its own — a forwarded renderer console error,
 * a failed load, a rejected string.
 *
 * THE FIELD IS OPTIONAL AND ABSENT MEANS `thrown`, which is how an exemplar stored by an older
 * client still reads correctly. It exists so that a capture-site frame is never silently
 * presented as a throw site: the two answer different questions, and a reader who cannot tell
 * them apart would go looking for a bug in the console forwarder.
 */
export const TELEMETRY_FRAME_ORIGINS = ['thrown', 'capture'] as const
export type TelemetryFrameOrigin = (typeof TELEMETRY_FRAME_ORIGINS)[number]

/** `TypeError`, `Error`, `EqError`. An identifier — a sentence cannot be one. */
export const ERROR_NAME_RE = /^[A-Za-z_$][A-Za-z0-9_$]{0,63}$/
/** `ENOENT`, `ERR_MODULE_NOT_FOUND`, `-4058`. Machine-readable, never prose. */
export const ERROR_CODE_RE = /^[A-Za-z0-9_.-]{1,32}$/
/** Sixteen lowercase hex characters (`errorFingerprint`). */
export const FINGERPRINT_RE = /^[0-9a-f]{16}$/
/**
 * A frame's file: BUNDLE-RELATIVE, forward slashes, anchored on `out/`. The anchor is the
 * privacy property — an absolute path cannot satisfy it, so `C:\Users\<name>\…` is not a value
 * this field can hold however it was constructed.
 *
 * EVERY SEGMENT MUST START WITH A NON-DOT, which is what refuses `out/../../secret.txt`. The
 * first draft of this pattern allowed `[A-Za-z0-9_.-]+` per segment, `..` satisfied it, and
 * `tests/errorReportContract.test.mts` caught a traversal that would have let a crafted client
 * name any file on the owner's disk in a stored exemplar. No file this bundler emits begins
 * with a dot, so the restriction costs nothing real.
 */
export const FRAME_FILE_RE =
  /^out\/[A-Za-z0-9_-][A-Za-z0-9_.-]*(?:\/[A-Za-z0-9_-][A-Za-z0-9_.-]*)*$/
/**
 * AN EXTERNAL FRAME'S FILE (JOS-111): a PUBLIC module name, and nothing that is not one.
 *
 * `node:fs`, `node:internal/fs/promises`, `electron/js2c/renderer_init`, `node_modules/chokidar`,
 * `node_modules/@scope/pkg` — three arms, each naming an artefact that is identical on every
 * install in the fleet. The privacy property is the same one `FRAME_FILE_RE` has and is held the
 * same way: an absolute path cannot satisfy this pattern, so the install directory (and therefore
 * the user's account name) is not a value this field can hold however it was constructed. Every
 * segment must start with a non-dot, which refuses `node_modules/../../secret`. At most three
 * segments on the two path-shaped arms, each at most 40 characters.
 *
 * `EXTERNAL_FILE_PATTERN` in `./errorReportLocation.ts` is the producer's copy; the contract test
 * pins the two source strings equal.
 */
export const EXTERNAL_FRAME_FILE_RE =
  /^(?:node:[A-Za-z0-9_-][A-Za-z0-9_.-]{0,39}(?:\/[A-Za-z0-9_-][A-Za-z0-9_.-]{0,39}){0,2}|electron\/[A-Za-z0-9_-][A-Za-z0-9_.-]{0,39}(?:\/[A-Za-z0-9_-][A-Za-z0-9_.-]{0,39}){0,2}|node_modules\/(?:@[A-Za-z0-9_-][A-Za-z0-9_.-]{0,39}\/)?[A-Za-z0-9_-][A-Za-z0-9_.-]{0,39})$/
/**
 * A REACT COMPONENT PATH (JOS-111): up to eight identifier-shaped component names, innermost
 * first, joined with `>`. `Tooltip>InventoryRow>InventoryPanel`.
 *
 * Component names are OUR OWN identifiers — they come out of this repo's `.tsx` files, not out of
 * the game — but the field is still bound by shape rather than by that argument: no spaces, no
 * punctuation beyond the dot a namespaced component uses, forty characters per name and eight
 * names. A sentence cannot be one, and neither can a zone, a mob or a character.
 */
export const COMPONENT_PATH_RE =
  /^[A-Za-z_$][A-Za-z0-9_$.]{0,39}(?:>[A-Za-z_$][A-Za-z0-9_$.]{0,39}){0,7}$/
/** A frame's function: identifier-shaped, dotted method paths and `<anonymous>` allowed.
 *  A NAME WITH A SPACE IN IT IS REFUSED — that is prose wearing a function's clothes. */
export const FRAME_FUNC_RE = /^[A-Za-z0-9_$.<>[\]]{1,80}$/
/**
 * The redacted message: PRINTABLE ASCII ONLY, and at most `MAX_REDACTED_MESSAGE_WIRE` of it.
 *
 * This is what makes the adversarial pin in `tests/wireSanitize.test.mts` hold for the one
 * string field in this schema that is not an enum member: an ESC, a NUL, a newline and a BiDi
 * override are all outside the class, so none of them can reach the owner's terminal. It is
 * the SECOND of two checks — the first is that the message equals its own re-redaction.
 */
export const REDACTED_MESSAGE_RE = /^[\x20-\x7E]{0,200}$/

// ---------------------------------------------------------------- buckets
//
// EDGES, not labels: bucket `i` is the number of edges strictly at or below the value, so
// bucket 0 is "below the first edge" and bucket `edges.length` is "at or above the last".
// `edges.length + 1` buckets in total, and TELEMETRY.md prints every range from these arrays.

/** Time from process start to the first window paint. */
export const COLD_START_MS_EDGES = [1_000, 2_500, 5_000, 10_000, 20_000] as const
/** How many character logs the install can see. 1 is the overwhelming common case. */
export const CHAR_COUNT_EDGES = [1, 2, 3, 5, 9] as const
/** Size of the tailed log on disk. A raw byte count is a fingerprint; a decade is not. */
// (1 MB / 10 MB / 100 MB / 512 MB / 2 GB — spelled on one line so the section stays inside the
//  repo's 400-code-line ceiling now that JOS-364's four ladders share it. Same numbers.)
export const LOG_SIZE_BYTES_EDGES = [1_048_576, 10_485_760, 104_857_600, 536_870_912, 2_147_483_648] as const
/** How many alert definitions the user keeps. */
export const ALERT_COUNT_EDGES = [1, 5, 10, 25, 50] as const
/**
 * BYTES THE LOG GREW BY WHILE THE APP WAS NOT RUNNING (JOS-57 scope addition) — 64 KB / 256 KB /
 * 1 MB / 4 MB / 16 MB / 64 MB / 256 MB ⇒ eight buckets.
 *
 * A DELTA, not a size, so it needs its own ladder rather than `LOG_SIZE_BYTES_EDGES`: a whole log
 * is measured in tens or hundreds of megabytes and one evening of play appends a few hundred
 * kilobytes, so the size edges would report almost every launch as bucket 0 and answer nothing.
 * It is bucketed for the same reason the size is — a raw byte count is a fingerprint of one
 * player's evening; a decade is not.
 */
export const NEW_BYTES_EDGES = [65_536, 262_144, 1_048_576, 4_194_304, 16_777_216, 67_108_864, 268_435_456] as const
/**
 * OBSERVED TIMER DRIFT DURING THE REPLAY (JOS-57 scope addition) — 2 / 5 / 10 / 25 / 50 / 100 /
 * 250 ms ⇒ eight buckets.
 *
 * The low edges are where the ANSWER is, which is why three of them sit under 15.6 ms: a heartbeat
 * on an unloaded Windows box should land on its tick edge and drift a millisecond or two, so a p50
 * that has climbed to the 25-50 ms bucket is already the machine failing to schedule us. The top
 * edges bracket what a person feels a whole system do — a hitch, and a freeze.
 */
export const STUTTER_MS_EDGES = [2, 5, 10, 25, 50, 100, 250] as const

// --- the machine class's four ladders (JOS-364). Raw values are not sent: a core count beside a
// --- memory size beside a scale factor is a machine fingerprint, and the questions these exist to
// --- answer ("do stalls cluster on 4-core boxes", "on 4K displays") are answered by ranges.

/** Logical processors (`os.cpus().length`) — 2 / 4 / 6 / 8 / 12 / 16 / 24 ⇒ eight buckets. The
 *  low edges are where the answer is: a 4-thread machine running EQ, a browser and this app is a
 *  different world from a 16-thread one, and the top edges only have to say "plenty". */
export const CPU_COUNT_EDGES = [2, 4, 6, 8, 12, 16, 24] as const
/** Installed memory in WHOLE GIBIBYTES (`os.totalmem()` folded down) — 4 / 8 / 12 / 16 / 24 / 32
 *  / 64 ⇒ eight buckets. Gibibytes rather than bytes so the ladder is readable and so the number
 *  that crosses the wire cannot be a byte-exact machine signature. */
export const TOTAL_MEM_GB_EDGES = [4, 8, 12, 16, 24, 32, 64] as const
/** Attached displays (`screen.getAllDisplays().length`) ⇒ four buckets. Bucket 0 means the app
 *  saw NO display, which is not a number of monitors — it is a machine that answered strangely. */
export const DISPLAY_COUNT_EDGES = [1, 2, 3] as const
/** The primary display's scale factor × 100 — 100% / 125% / 150% / 175% / 200% ⇒ six buckets.
 *  Overlay work is done in device pixels, so a 4K display at 150% is drawing 2.25× the pixels a
 *  100% display is, and that belongs beside every stall reading. */
export const PRIMARY_SCALE_EDGES = [100, 125, 150, 175, 200] as const

/** The bucket index of `value` under `edges`. Non-finite input lands in bucket 0. */
export function bucketOf(value: number, edges: readonly number[]): number {
  if (!Number.isFinite(value)) return 0
  let i = 0
  while (i < edges.length && value >= edges[i]) i++
  return i
}

/** The half-open range bucket `i` covers: `[lo, hi)`, with `hi: null` for the open top. */
export function bucketRange(
  edges: readonly number[],
  i: number
): { lo: number; hi: number | null } {
  return { lo: i === 0 ? 0 : edges[i - 1], hi: i < edges.length ? edges[i] : null }
}

/** UTC offset in WHOLE HOURS — the coarsest useful "when do people play" signal. */
export const MIN_TZ_OFFSET_HOURS = -12
export const MAX_TZ_OFFSET_HOURS = 14

/** Offset in minutes (`-new Date().getTimezoneOffset()`) → whole hours, clamped. */
export function tzOffsetBucket(offsetMinutes: number): number {
  if (!Number.isFinite(offsetMinutes)) return 0
  const hours = Math.round(offsetMinutes / 60)
  return Math.max(MIN_TZ_OFFSET_HOURS, Math.min(MAX_TZ_OFFSET_HOURS, hours))
}

// ---------------------------------------------------------------- limits

/** Ring capacity of `<userData>/telemetry.json`. Oldest is dropped; nothing is ever refused. */
export const TELEMETRY_BUFFER_CAP = 500
/** Most events one flush may carry. Same number: a full buffer is one batch. */
export const MAX_BATCH_EVENTS = TELEMETRY_BUFFER_CAP
/**
 * The ingest body cap, checked BEFORE `JSON.parse` (the Lambda's cheapest step, and the only
 * one that runs on a hostile body). Deliberately larger than feedback's 32 KB: a feedback body
 * is one description, a telemetry body is up to `MAX_BATCH_EVENTS` records.
 *
 * MEASURED CEILING: the fattest record in the union is a `setupSnapshot` carrying all five
 * overlay kinds — ~260 bytes with its `{ts, ev}` wrapper — so a maximal 500-record batch is
 * ~130 KB. 256 KB is that with room to spare and still small enough that a flood of maximal
 * bodies stays inside the route throttle's cost model.
 */
export const MAX_TELEMETRY_BODY_BYTES = 256 * 1024

/** Ceiling for every plain count field. Well past any real session; refuses nonsense. */
export const MAX_COUNT = 1_000_000
/**
 * Ceiling for a REPLAY event count, and it is deliberately not `MAX_COUNT`.
 *
 * MEASURED: the owner's own log is past 1.35M lines and the startup replay folds every one of
 * them, so `MAX_COUNT` is not "well past any real session" for this one number — it sits BELOW
 * the logs the measurement exists to describe, and clamping there would report every big log as
 * exactly one million. `linesParsed` can live with the cap because it is a delta that keeps its
 * remainder for the next heartbeat (collector.ts); a single launch's `eventsReplayed` has no
 * next report to carry a remainder into, so it needs a ceiling that is genuinely out of reach.
 */
export const MAX_REPLAY_EVENTS = 100_000_000
/** Ceiling for every duration field (30 days). A longer session is a broken clock. */
export const MAX_DURATION_MS = 30 * 24 * 60 * 60 * 1000

/** `crypto.randomUUID()` shape — the analyticsId's only permitted spelling. */
export const UUID_V4_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
/** `app.getVersion()` — semver, optionally with the CI channel prerelease tag. */
export const APP_VERSION_RE = /^\d+\.\d+\.\d+(?:-[\w.]+)?$/

// ------------------------------------------------------- the startup replay reading (JOS-57)
//
// WHAT THIS IS FOR. The chunked replay (docs/plans/chunked-replay.md) and its duty cycle (JOS-50)
// are throttles tuned on ONE developer machine against ONE 1.35M-line log. Everything the app
// knows about whether they work is therefore a fact about that machine. These six numbers are the
// same launch measured on machines nobody here owns — the whole point of the ticket.
//
// NUMBERS ONLY, and structurally so: the same posture as `updateOutcome`'s `failureClass` (a
// message reduced to one of five words before it can reach an event). There is no field here a
// character, a server, a zone or a PATH could go in, and the one number that would itself be
// revealing — how big your log is — is a BUCKET INDEX before it is ever assigned.
//
// ONE LAUNCH IS ONE READING, and `src/main/perf.ts` enforces that at the seam: it is produced when
// the `replayDone` startup phase lands, which happens exactly once per process (`addMark` refuses
// a duplicate). A character SWITCH replays a log too — and is deliberately not measured, because a
// switch replay and a launch replay are different work under different conditions, and a
// population that mixed them could not answer "how long does starting this app take".

export interface StartupReplayStats {
  /** Wall clock of the startup replay, ms: `tailAttached` → `replayDone`. */
  replayMs: number
  /** Log events the historical scan folded. Ceiling `MAX_REPLAY_EVENTS`, not `MAX_COUNT`. */
  eventsReplayed: number
  /**
   * The duty the fold ACHIEVED, whole percent 0..100 — measured by the slicer, never the setting
   * it aimed at (Windows' 15.6 ms timer quantum decides what a rest is actually worth).
   */
  dutyPct: number
  /** The worst single main-loop block observed during the replay, ms. */
  maxBlockMs: number
  /** Probe ticks that were at least 50 ms late (`STARTUP_BLOCK_THRESHOLD_MS`). */
  blocksOver50: number
  /** Index into `LOG_SIZE_BYTES_EDGES`. A raw byte count is a fingerprint; a decade is not. */
  logSizeBucket: number
  /**
   * NEW BYTES SINCE THE LAST CLEAN SHUTDOWN, as an index into `NEW_BYTES_EDGES` (JOS-57 scope
   * addition, from the first-start-stutter investigation).
   *
   * WHY IT IS THE DISCRIMINATOR THE OTHER NUMBERS ARE MISSING: every existing figure here scales
   * with the WHOLE log, and the leading hypothesis for a first-launch stutter — an on-access
   * virus scanner reading bytes the OS has never cached — predicts the cost scales with the part
   * of the log nobody has read yet. Those two are the same number on a fresh install and very
   * different numbers on the tenth launch of the same day, which is exactly the pair of launches
   * the fleet can now tell apart.
   *
   * OPTIONAL, and absent means UNKNOWN rather than zero: no previous clean shutdown left a mark
   * (a first run, or a launch after a crash), or the log had shrunk under the mark (a rotation),
   * in which case the delta is not a smaller measurement but a meaningless one.
   */
  newBytesBucket?: number
  /** The replay's own timer drift, when enough ticks were observed to describe it. Optional. */
  stutter?: StartupStutterStats
  /**
   * How long the FIRST MEGABYTE of the log took to arrive, ms — the cold-disk hint. Optional:
   * absent when the log is smaller than a megabyte, which is a launch with nothing to read rather
   * than a launch that read it instantly.
   */
  firstMbMs?: number
}

/**
 * THE SYSTEM-STUTTER PROXY (JOS-57 scope addition) — what OUR OWN clock did during the replay.
 *
 * A fixed-interval heartbeat runs for the length of the fold and records how late each tick was.
 * Read BESIDE `maxBlockMs` and `dutyPct`, it separates two launches that look identical today:
 * drift that spikes while the worst main-loop block stays small is the MACHINE stuttering around
 * a process that is behaving, which is what report ...8QQC describes and what a max-block figure
 * structurally cannot see.
 *
 * THE HONEST LIMIT, stated where the numbers are declared: an in-process timer cannot prove WHO
 * failed to schedule it. What makes this a discriminator is the PAIR — a drift distribution that
 * moved while the block figure and the achieved duty did not — never this reading alone.
 *
 * ALL THREE OR NONE, and it is a shape rather than a rule: a percentile with no companion
 * percentile beside it, or a late-tick rate with no distribution, is uninterpretable.
 */
export interface StartupStutterStats {
  /** Median observed drift, as an index into `STUTTER_MS_EDGES` — the baseline. */
  p50Bucket: number
  /** 95th-percentile observed drift, same edges — the tail, and the interesting half. */
  p95Bucket: number
  /** Whole percent of ticks that were LATE by the probe's own threshold, 0..100. */
  latePct: number
}

// THE PRODUCER — `startupReplayStats`, which BUILDS one of these out of the raw facts main holds —
// lives in `./telemetryStartup.ts`, split out when JOS-57's scope addition pushed this file past
// the repo's 400-code-line ceiling. The cut follows a seam that was already there: what is HERE is
// the CONTRACT (the shape, the edges, the ceilings), which the validator and the Lambda need; what
// is there is the CLIENT-SIDE constructor, which nothing on the server has ever needed and which
// the ingest bundle no longer carries.

// ---------------------------------------------------------------- the event union
//
// THE ADDITIVE-FIELD RULE (learned while adding `linesParsed`, 2026-08-06). A shipped client can
// be talking to a server running an OLDER copy of this contract, because the app auto-updates
// itself and the Lambda is deployed by hand. The two ways to add a measurement are NOT equally
// safe under that skew:
//
//   * A NEW EVENT KIND is fatal. `validateTelemetryBatch` fails the WHOLE batch on an unknown
//     `t`, the endpoint answers 400, and `telemetryPermanentRefusal` (main/telemetry/net.ts)
//     classes 400 as "these bytes will never be accepted" and DROPS the batch. So a client that
//     emits an event the deployed server has never heard of throws away every counter it is
//     carrying, on every flush, until the deploy lands.
//
//   * A NEW OPTIONAL FIELD on an existing kind is free. The validators do not sanitize an object,
//     they CONSTRUCT one field by field — so an older server simply does not copy the field
//     across, accepts the batch, and counts everything else exactly as before. The measurement
//     starts at zero and begins moving the moment the Lambda is redeployed.
//
// That is why `linesParsed` rides on `sessionHeartbeat`/`sessionEnd` instead of arriving as its
// own event: the client half of this feature is safe to ship BEFORE the additive infra apply.
//
// `startup` (JOS-57) is the SECOND measurement to take that deal, and it took it for exactly the
// same reason. A `startupReplay` event of its own would have read better and would have blacked
// out every counter this app collects — not just the startup ones — on every install that
// auto-updated ahead of the Lambda deploy. What it costs instead is stated on the field itself:
// the reading rides the next session report, so a launch killed before either one is lost.

export interface EvSessionStart {
  t: 'sessionStart'
  coldStartMsBucket: number
}
export interface EvSessionHeartbeat {
  t: 'sessionHeartbeat'
  uptimeMs: number
  /** Log lines parsed since the previous report. OPTIONAL — see THE ADDITIVE-FIELD RULE below. */
  linesParsed?: number
  /** This launch's startup replay, if it has not been reported yet. Optional, same rule. */
  startup?: StartupReplayStats
  /** How late our own two clocks ran since the previous report (JOS-367). Optional, same rule. */
  live?: LiveStallStats
  /** What the live tail's reads cost over the same interval. Absent when nothing is attached. */
  tail?: TailReadStats
  /** What the app was doing while the two above were measured. */
  state?: SessionStateStats
}
export interface EvSessionEnd {
  t: 'sessionEnd'
  durationMs: number
  viewsVisited: number
  /** The tail of the same counter: lines parsed since the last heartbeat. Optional, same rule. */
  linesParsed?: number
  /** This launch's startup replay, if no heartbeat carried it first. Optional, same rule. */
  startup?: StartupReplayStats
  /** The tail of the live readings, on the same terms as `linesParsed` beside them (JOS-367). */
  live?: LiveStallStats
  tail?: TailReadStats
  state?: SessionStateStats
}

export interface EvViewDwell {
  t: 'viewDwell'
  view: TelemetryView
  ms: number
}
export interface EvOverlayToggle {
  t: 'overlayToggle'
  kind: TelemetryOverlayKind
  open: boolean
}
export interface EvFeatureUse {
  t: 'featureUse'
  feature: TelemetryFeature
  count: number
}
export interface EvAlertFired {
  t: 'alertFired'
  count: number
  spokenCount: number
}
export interface EvSetupSnapshot {
  t: 'setupSnapshot'
  charCountBucket: number
  logSizeBucket: number
  alertCountBucket: number
  overlaysEnabled: TelemetryOverlayKind[]
  cursorRing: boolean
  autoHide: boolean
  voiceEngine: TelemetryVoiceEngine
  soundPackCount: number
  updateChannel: TelemetryUpdateChannel
  // ---- THE MACHINE CLASS (JOS-364). Every one of these is OPTIONAL, under THE ADDITIVE-FIELD
  // ---- RULE stated above: they ride an event KIND that has been in the contract since wave A1,
  // ---- so an ingest that has never heard of them simply does not copy them across and keeps
  // ---- counting everything else — which is what lets the client half ship before the deploy.
  // ---- The producer (src/main/telemetry/setupSnapshot.ts) sends all eight on every launch,
  // ---- with `unknown` where the machine would not answer; optional here is about SKEW, not
  // ---- about a client that measures some launches and not others.
  /** Logical processors, as an index into `CPU_COUNT_EDGES`. */
  cpuCountBucket?: number
  /** Installed memory, as an index into `TOTAL_MEM_GB_EDGES`. */
  totalMemBucket?: number
  gpuVendor?: TelemetryGpuVendor
  gpuCompositing?: TelemetryGpuCompositing
  /** Graphics safe mode is ON for this launch — the app is drawing without hardware
   *  acceleration (src/main/graphics.ts). The one setting of ours that changes the answer to
   *  every question the four readings above are asked. */
  safeMode?: boolean
  /** Attached displays, as an index into `DISPLAY_COUNT_EDGES`. */
  displayCountBucket?: number
  /** The primary display's scale factor × 100, as an index into `PRIMARY_SCALE_EDGES`. */
  primaryScaleBucket?: number
  eqWindowMode?: TelemetryEqWindowMode
}
export interface EvFunnelStep {
  t: 'funnelStep'
  funnel: TelemetryFunnel
  step: string
  outcome?: TelemetryOutcome
  failureClass?: TelemetryFailureClass
}
export interface EvHealthCounters {
  t: 'healthCounters'
  rendererCrashes: number
  mainErrorLogLines: number
  parserStalls: number
  presenceRestarts: number
  speechFailures: number
  /**
   * Image fetches that failed at the NETWORK leg (JOS-133). OPTIONAL under the additive-field
   * rule above: this rides an event kind that has shipped, so a deployed ingest that has never
   * heard of the field ignores it and keeps counting everything else, and a client too old to
   * send it must not fail validation on the day the field lands. The producer always sends it.
   *
   * NOT AN ERROR, and the rollup keeps that promise structurally: the field is listed in
   * `HEALTH_NON_ERROR_FIELDS` (./telemetryRollup.ts) and so is excluded from the release-health
   * error rate, while still being counted, reported and rendered in the health mix.
   */
  imageFetchFailures?: number
  /**
   * Error lines withheld from `<userData>/errors.log` because the identical line had already been
   * written `MAX_IDENTICAL_ERROR_LINES` times this session (src/main/errorRepeat.ts). Optional for
   * the same reason as the field above.
   *
   * IT IS AN ERROR — it counts occurrences of something that really went wrong and really would
   * have been logged — so unlike `imageFetchFailures` it IS summed into the error rate. That is
   * the whole point of having it: the cap must not be able to make a looping build look healthy.
   */
  suppressedErrorLines?: number
  /**
   * Images the app had already cached on disk that could not be READ BACK (JOS-266). Optional for
   * the same deploy-skew reason as the two fields above — it rides an event kind that has shipped.
   *
   * NOT AN ERROR, and for a stronger reason than `imageFetchFailures` has: the cache HEALS. The bad
   * entry is evicted and the image is re-fetched as though it had never been cached, so the outcome
   * the user gets is the picture. The field is in `HEALTH_NON_ERROR_FIELDS` — see
   * ./telemetryRollup.ts — so it is counted and rendered without moving the release error rate.
   */
  imageCacheReadFailures?: number
  /**
   * THE GPU PROCESS DIED (JOS-364) — `child-process-gone` with `type: 'GPU'` and a reason that is
   * not a clean exit. Optional for the same deploy-skew reason as the three fields above.
   *
   * IT IS AN ERROR, and counted as one exactly like `rendererCrashes`: Chromium restarts the GPU
   * process, so the app survives, but every window it was compositing goes through a black frame
   * and an overlay show around that moment is the ~1 s freeze this app has field reports of and
   * no evidence for. The matching `logError('main:gpu-process-gone')` gives the fleet's error
   * store an exemplar carrying the reason and the exit code, which a count cannot — and since
   * JOS-418 it actually SAYS them: for four releases that exemplar was a bare `{ reason, exitCode }`
   * with no `message` on it, so the store filed the whole family as the text `Error: `. It now
   * arrives under its own error name (`GpuProcessGone`), which also means the rows filed before
   * that fix keep their old fingerprint and are not silently merged with the readable ones.
   *
   * A CLEAN EXIT IS NOT COUNTED. The GPU process also goes away when the app is shutting down,
   * and a counter that included that would report one loss on every ordinary quit.
   */
  gpuProcessGone?: number
  /**
   * A UTILITY PROCESS died the same way (`type: 'Utility'`), and it is NOT an error — it is in
   * `HEALTH_NON_ERROR_FIELDS` (./telemetryRollup.ts). Chromium runs utility processes for audio,
   * networking and storage, they come and go by design, and nothing here can tell a torn-down one
   * from a crashed one beyond the clean-exit filter the field above describes. It is counted
   * because a fleet where this climbs beside `gpuProcessGone` is a fleet with a driver or a
   * security product killing our children — which is the whole reason both numbers exist.
   */
  utilityProcessGone?: number
}
export interface EvUpdateOutcome {
  t: 'updateOutcome'
  step: TelemetryUpdateStep
  ok: boolean
  failureClass?: TelemetryFailureClass
}

/** One stack frame, bundle-relative. Mirrors `ErrorFrame` in `./errorReport.ts`. */
export interface TelemetryFrame {
  file: string
  line: number
  col: number
  func: string
}

/**
 * One parser event that happened before the throw: WHICH KIND, and HOW LONG BEFORE the newest
 * breadcrumb — never what the event said.
 *
 * `offsetMs` IS MEASURED IN LOG TIME, back from the newest breadcrumb, and that is a decision
 * with a performance argument behind it (src/main/telemetry/breadcrumbs.ts). The ring is fed
 * from `LogBus.emit`, which folds 1.35M events during a startup replay, and a wall-clock read
 * per event is a cost the hot path does not have to pay: every `LogEvent` already carries its
 * own `ts`, so the offsets come out of arithmetic the app had already done. During a live tail
 * log time and wall time agree to within a second; during a replay this reads as the spacing
 * of the historical lines, which is what a reader of a replay-mode crash actually wants.
 */
export interface TelemetryBreadcrumb {
  kind: TelemetryBreadcrumbKind
  offsetMs: number
}

/**
 * AN ERROR SOMEBODY COULD ACTUALLY FIX FROM (JOS-100).
 *
 * THIS IS A NEW EVENT KIND, WHICH THE ADDITIVE-FIELD RULE BELOW CALLS FATAL UNDER DEPLOY SKEW,
 * AND IT IS THE FIRST ONE ADDED SINCE THAT RULE WAS WRITTEN. It could not ride an existing
 * event: `healthCounters` is five integers by construction (telemetry/health.ts refuses a
 * parameter that could carry text, deliberately), and stapling ten fields onto a session report
 * would make every heartbeat carry a shape that is empty 99.9% of the time.
 *
 * SO THE DEPLOY ORDER IS PART OF THE FEATURE, not an operational detail: the ingest Lambda and
 * the migration MUST land BEFORE a client that emits this reaches anyone. A client talking to a
 * Lambda that has never heard of `errorReport` gets a 400 on the whole batch,
 * `telemetryPermanentRefusal` classes that as permanent, and the client DROPS every counter it
 * was carrying — on every flush, until the deploy lands. That is a fleet-wide analytics
 * blackout, not a missing feature.
 */
export interface EvErrorReport {
  t: 'errorReport'
  /** `TypeError`, `Error`, … — `ERROR_NAME_RE`. */
  errorName: string
  /** Node's machine-readable code when the throw carried one — `ERROR_CODE_RE`. */
  code?: string
  /** The OUTPUT of `redactMessage`. The server re-runs the redaction and refuses a message
   *  that changes under it, so an unredacted one cannot be stored even if a client sends it. */
  redactedMessage: string
  /** At most `MAX_ERROR_FRAMES_WIRE`, newest first, every file `^out/`. */
  frames: TelemetryFrame[]
  /**
   * WHETHER `frames` IS THE THROW SITE OR THE CATCH SITE (JOS-111). Absent means `thrown`, which
   * is what every frame meant before this field existed and is what an older client's stored
   * exemplar still means. See `TELEMETRY_FRAME_ORIGINS`.
   */
  frameOrigin?: TelemetryFrameOrigin
  /**
   * THE FRAMES THAT ARE NOT OURS (JOS-111): at most `MAX_EXTERNAL_FRAMES_WIRE`, newest first,
   * each a public module name matching `EXTERNAL_FRAME_FILE_RE` — `node:internal/fs/promises`,
   * `node_modules/chokidar`, `electron/js2c/renderer_init`.
   *
   * A SEPARATE FIELD RATHER THAN A WIDER `frames`, and the reason is the deploy-skew law above:
   * widening `FRAME_FILE_RE` would make every new client's report ILLEGAL to the deployed
   * validator, which 400s the whole batch and drops every counter the client was carrying. A new
   * optional field is free — the validators construct their result field by field, so an older
   * server simply does not copy it across.
   */
  externalFrames?: TelemetryFrame[]
  /**
   * WHICH REACT COMPONENTS IT CAME THROUGH (JOS-111), innermost first, `>`-joined —
   * `COMPONENT_PATH_RE`. Present only for a renderer error our ErrorBoundary caught.
   */
  componentPath?: string
  /** `hash(errorName + top app frames)` — the grouping key, 16 hex characters. */
  fingerprint: string
  /** At most `MAX_BREADCRUMBS` parser event KINDS, newest first. */
  breadcrumbs: TelemetryBreadcrumb[]
  view: TelemetryErrorView
  /** Index into `SESSION_AGE_MS_EDGES`. */
  sessionAgeBucket: number
  mode: TelemetryErrorMode
  /**
   * HOW MANY TIMES THIS FINGERPRINT FIRED since the last report, and it is the field that makes
   * the client-side dedupe expressible. One exemplar per fingerprint per SESSION: the first
   * occurrence keeps its message, frames and breadcrumbs, and every repeat afterwards adds to
   * this number instead of minting a second copy of the same stack.
   *
   * IT IS A FLOOR, NOT A TOTAL (JOS-197). This used to say "a loop that throws ten thousand times
   * is one row with `count: 10000`" — which was written as a boast about how cheap a repeat is,
   * and is exactly why nothing bounded it: an install then filed 7,272,196 occurrences of one
   * fingerprint in a day, and the store was unreadable around the row. The client now stops
   * counting a fingerprint at `MAX_REPORTS_PER_FINGERPRINT` per session (src/main/errorBudget.ts),
   * so a looping issue reports that number and goes quiet.
   *
   * THE TOTAL IS STILL KNOWABLE, from the other side: `mainErrorLogLines + suppressedErrorLines`
   * on `healthCounters` counts every occurrence whether it was reported or silenced, which is the
   * ledger JOS-133 built for precisely this. So a build that starts looping still shows up in the
   * error RATE; what the cap takes away is only the ability of one issue to say it ten thousand
   * times over in the exemplar table.
   */
  count: number
}

// ------------------------------------------------------- the switch itself (JOS-109)
//
// THE HONEST-MEASUREMENT PROBLEM, stated once, here, because everything downstream of these two
// kinds is only as honest as this paragraph.
//
// The owner's question is "how many installs turn usage analytics OFF". It cannot be answered
// exactly, and the reason is structural rather than a gap in the instrumentation: AN INSTALL THAT
// GOES DARK BEFORE IT EVER REPORTS IS INVISIBLE BY DEFINITION. Somebody who opens the app, reads
// the first-run notice and dismisses it before the flush loop's first tick has sent anything is,
// to this pipeline, indistinguishable from somebody who never downloaded the app at all — and
// making them distinguishable would mean sending something before they answered, which is exactly
// the promise the notice exists to keep.
//
// So the ticket is TWO MEASUREMENTS, and they are labelled differently everywhere they are
// rendered because conflating them would produce a confident wrong number:
//
//   1. OPT-OUT FLIPS — EXACT, over the population that ever reported. These two events. When the
//      user turns the switch off, the app sends ONE final minimal notice and then goes quiet;
//      turning it back on sends the counterpart. Both are exact counts of an action a user took.
//      What they cannot count is the install that was never in the population to begin with.
//   2. THE DARK COHORT — an ESTIMATE, and only ever a comparison. GitHub download counts beside
//      distinct reporting installs, both printed, never subtracted. `src/main/triage/coverage.ts`
//      argues that half; the short version is that a download is not an install (re-downloads,
//      the auto-updater, curiosity clicks) so the difference of the two numbers is not a count of
//      anything, and the panel refuses to print it.
//
// FIELDLESS ON PURPOSE. The envelope already carries everything a flip is worth knowing by —
// version, channel, platform, timezone — and the event itself has nothing to add. It is also the
// strongest form of the disclosure in TELEMETRY.md: "one final anonymous notice" is a claim the
// SHAPE keeps, because there is no slot on either of these for anything else to ride along in.
//
// THEY ARE NEW EVENT KINDS, so THE ADDITIVE-FIELD RULE below applies in its fatal form and the
// deploy order is part of the feature: the ingest Lambda must understand `optOut`/`optIn` BEFORE
// any client emits one. `optOut` travels as its own single-event batch (main/telemetry/optOut.ts),
// so under deploy skew it would only lose ITSELF — but `optIn` does not, and a 400 on a batch is a
// dropped batch. Server first, client on the next tag. (JOS-100 is where that lesson was paid for.)

/** The user turned usage analytics OFF. The last thing this install ever sends. */
export interface EvOptOut {
  t: 'optOut'
}
/** The user turned it back ON. Under a NEW analyticsId — a re-enable is a new cohort member. */
export interface EvOptIn {
  t: 'optIn'
}

export type TelemetryEvent =
  | EvSessionStart
  | EvSessionHeartbeat
  | EvSessionEnd
  | EvViewDwell
  | EvOverlayToggle
  | EvFeatureUse
  | EvAlertFired
  | EvSetupSnapshot
  | EvFunnelStep
  | EvHealthCounters
  | EvUpdateOutcome
  | EvErrorReport
  | EvOptOut
  | EvOptIn

export type TelemetryEventKind = TelemetryEvent['t']

/** Runtime spelling of the union's tags, in doc order. */
export const TELEMETRY_EVENT_KINDS = [
  'sessionStart',
  'sessionHeartbeat',
  'sessionEnd',
  'viewDwell',
  'overlayToggle',
  'featureUse',
  'alertFired',
  'setupSnapshot',
  'funnelStep',
  'healthCounters',
  'updateOutcome',
  'errorReport',
  // Last, and they read as the coda they are: the doc's "Turning it off" section is directly
  // below them, and a reader who has just been told what the app measures should meet the two
  // events that say "stop" in the same breath as the sentence explaining them.
  'optOut',
  'optIn'
] as const

/** The two kinds a SWITCH FLIP produces. One list, so the client, the doc and the rollup agree. */
export const TELEMETRY_FLIP_KINDS = ['optOut', 'optIn'] as const
export type TelemetryFlipKind = (typeof TELEMETRY_FLIP_KINDS)[number]

// ---------------------------------------------------------------- envelope + batch
//
// Plan §2: "all events carry {v, analyticsId, appVersion, channel, platform, tzOffsetBucket}".
// They do — through the BATCH, which is the unit that crosses the wire. Every one of those
// fields is constant for the life of a session, and stamping six copies onto every event so a
// flush of 500 can repeat them 500 times would be payload, not information.

export interface TelemetryEnvelope {
  /** The rotatable anonymous id. NOT the feedback installId — deliberately non-correlatable. */
  analyticsId: string
  appVersion: string
  channel: TelemetryChannel
  platform: TelemetryPlatform
  /** UTC offset in whole hours (`tzOffsetBucket`). */
  tzOffsetBucket: number
}

/** One buffered event plus the client clock. The SERVER aggregates by arrival day; `ts` exists
 *  so the Preferences payload viewer can say when, and for ordering inside the ring. */
export interface TelemetryRecord {
  ts: number
  ev: TelemetryEvent
}

export interface TelemetryBatch {
  v: typeof TELEMETRY_API_VERSION
  env: TelemetryEnvelope
  events: TelemetryRecord[]
}

/**
 * What the Preferences payload viewer renders (T4: "show the payload"). It crosses the preload
 * bridge, so it is a SHARED shape — main and the renderer name one definition.
 *
 * `lastBatch` is null until a batch has actually been ACCEPTED by the server, and the pane says
 * which silence that is — "nothing sent yet" or "this build has no endpoint". An empty box the
 * user has to interpret would be a worse answer than a sentence explaining why it is empty.
 */
export interface TelemetryPayloadView {
  prefs: TelemetryPrefs
  /** True once an endpoint is compiled in — see `src/main/telemetry/net.ts`. */
  endpointConfigured: boolean
  /** The live ring, oldest first. */
  buffered: TelemetryRecord[]
  lastBatch: TelemetryBatch | null
}

// ---------------------------------------------------------------- prefs (persisted)
//
// The store blob behind schema migration 5 → 6. It lives here rather than in a `telemetryPrefs`
// module because this file is already the pure, import-free home of everything telemetry-shaped
// that main, the renderer and `storeMigrations.ts` all have to agree on.
//
// OPT-OUT (owner decision T1) — `enabled: true` on a fresh install — but `noticeShown: false`,
// and NOTHING may transmit until that flips. `analyticsId: null` until the collector first
// starts: there is no reason to mint an identifier for a user who has not run the app yet.

export interface TelemetryPrefs {
  /** Master switch. False ⇒ the buffer is dropped immediately and nothing is collected. */
  enabled: boolean
  /** Has the first-run notice RENDERED? The network gate, not just a UI flag. */
  noticeShown: boolean
  /** The rotatable anonymous id, or null until the collector mints one. */
  analyticsId: string | null
  /**
   * ONCE-EVER FUNNEL STEPS ALREADY EMITTED, as `"<funnel>:<step>"` marks — see
   * `funnelStepMark` below.
   *
   * The first-run and voice-install funnels ask "how far did this INSTALL get", so each of their
   * steps may contribute at most one event for the life of the install. A counter that could be
   * re-emitted would measure how often somebody re-opens a tab, not how many installs ever
   * reached it, and the panel's conversion rates would exceed 100% by construction.
   *
   * It lives beside the switch rather than in the disposable ring because it must OUTLIVE the
   * ring: the ring is dropped on opt-out, on rotation and on any unreadable file, and a mark that
   * went with it would let `installed` fire a second time on the same machine.
   *
   * It is NOT an identifier and carries nothing personal — a list of at most a dozen schema
   * constants, each of which is printed in TELEMETRY.md.
   */
  funnelsDone: string[]
}

export const DEFAULT_TELEMETRY_PREFS: TelemetryPrefs = {
  enabled: true,
  noticeShown: false,
  analyticsId: null,
  funnelsDone: []
}

/** The one spelling of a once-ever mark, so the writer and the reader cannot disagree. */
export function funnelStepMark(funnel: TelemetryFunnel, step: string): string {
  return `${funnel}:${step}`
}

/** Every mark that could ever be legal — the normalizer's allowlist, built from the schema. */
export function allFunnelStepMarks(): string[] {
  return TELEMETRY_FUNNELS.flatMap((funnel) =>
    TELEMETRY_FUNNEL_STEPS[funnel].map((step) => funnelStepMark(funnel, step))
  )
}

/** A plain object, or not. Shared with every validator in `./telemetryValidate.ts` — one
 *  answer to "is this even a record", so the prefs normalizer and the wire validators can
 *  never disagree about what an object is. */
export function isTelemetryObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

/** Defaulted field by field. Takes `unknown`: a hand edit, a downgrade or a share import can
 *  leave anything in this key, and a malformed id is DROPPED (⇒ a fresh one is minted) rather
 *  than repaired into something that is not a UUID. */
export function normalizeTelemetryPrefs(value: unknown): TelemetryPrefs {
  const v = isTelemetryObject(value) ? value : {}
  const id = v.analyticsId
  return {
    enabled: typeof v.enabled === 'boolean' ? v.enabled : DEFAULT_TELEMETRY_PREFS.enabled,
    noticeShown:
      typeof v.noticeShown === 'boolean' ? v.noticeShown : DEFAULT_TELEMETRY_PREFS.noticeShown,
    analyticsId: typeof id === 'string' && UUID_V4_RE.test(id) ? id : null,
    // ALLOWLISTED, deduped and canonically ordered: the marks are schema constants, so an
    // unrecognized one (a hand edit, a downgrade from a build with more steps) is DROPPED rather
    // than carried. A dropped mark can only ever cost one duplicate event, never a wrong one.
    funnelsDone: normalizeFunnelsDone(v.funnelsDone)
  }
}

function normalizeFunnelsDone(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  const held = new Set(value.filter((m): m is string => typeof m === 'string'))
  return allFunnelStepMarks().filter((mark) => held.has(mark))
}
