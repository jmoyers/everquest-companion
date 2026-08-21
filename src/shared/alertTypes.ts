// alertTypes.ts — the ALERTS half of the shared type surface: what an alert IS (trigger →
// sound), what it records when it fires, and the sound packs (local, registry, preview) its
// `sound` points at.
//
// Split out of types.ts, which had grown past the 400-code-line factoring ceiling. The section
// text is UNCHANGED and every name here is still exported from `shared/types` (which
// re-exports this module), so no importer moved and no import path changed.

// TYPE-ONLY, and the cycle it closes (alertBanner.ts imports `AlertDef` from here) is erased at
// compile time — the `TimerGrouping` posture in shared/types.ts, applied. The banner's vocabulary
// lives beside the code that gives it meaning; this file names the field.
import type { AlertBannerColor } from './alertBanner'

// ----- Alerts extension (Task #18) -----
//
// An alert = a trigger (matched against the live LogEvent stream, a raw log line,
// or a renderer-side app signal) → a sound to play. Definitions are stored in
// electron-store (main-owned) and served over IPC. The shape is deliberately
// JSON-serializable and flat enough that a future agent can author one from a
// sentence ("alert me on charm breaks") by writing a def via alerts:save.

/** The kinds a LogEvent can carry — mirrors the `kind` discriminants in logEvents.ts. */
export type LogEventKind =
  | 'zone'
  | 'loot'
  | 'offer'
  | 'trade'
  | 'level'
  | 'aaGain'
  | 'aaSpend'
  // The item-shop AA potion quaff ("You are filled with the spirit of alternate adventure.").
  // Payload-free, so it is a bare `kind` trigger — an alert on it fires once per bottle.
  | 'aaPotion'
  | 'death'
  | 'damage'
  | 'heal'
  // A heal the log ANNOUNCED without an amount — the monk's Mend (JOS-86). Its own kind, not a
  // zero-amount 'heal', so an alert can fire on "I mended" while nothing downstream can sum it.
  | 'healUnstated'
  | 'mitigation'
  | 'miss'
  | 'resist'
  | 'charm'
  | 'uncharm'
  | 'cc'
  | 'petClaim'
  // A pet's PUBLIC response ("Following you, Master.", "Sorry, Master... calming down." — the
  // six in shared/logScrub.ts). Somebody's pet spoke; whose is never stated, which is why the
  // combat model only nominates on it (JOS-47).
  | 'petSay'
  | 'castBegin'
  | 'castFizzle'
  | 'castInterrupted'
  | 'buffFade'
  | 'playerDeath'
  | 'spellEmote'
  | 'buffApply'
  | 'buffWearOff'
  | 'aaActivate'
  | 'illusionFade'
  | 'buffExpired'
  | 'epoch'
  | 'stanceChange'
  | 'invocationChange'
  // WHAT IS IN YOUR GEMS (JOS-391). `spellMemorize` carries `{spell, done}` (so
  // `where:{done:'true'}` is the gem actually loading), `spellForget` `{spell}`, and `spellSet`
  // `{set, action}` — `where:{action:'loaded'}` is "I just swapped my whole bar".
  | 'spellMemorize'
  | 'spellForget'
  | 'spellSet'
  | 'consider'
  // ROGUE POISONS (docs/plans/poison-slow-alerts.md §1). The parser has emitted these three
  // families since Task #64 and the matcher has always been a plain string compare on `kind`
  // — this curated allowlist was the ONLY thing gating them out of the editor and out of a
  // group def. `poisonProc` carries `{strike, candidates, effect, target}` (so
  // `where:{effect:'slow'}` is the rogue slow landing), `poisonCoat` `{poison, group, who}`,
  // `poisonDry` `{group}`.
  | 'poisonProc'
  | 'poisonCoat'
  | 'poisonDry'
  | 'unknown'

/** Renderer-side app signals an alert can fire on (evaluated in the player, not main). */
export type AppSignal = 'bossDefeat' | 'questComplete'

/**
 * A PRIMITIVE alert trigger — the three original shapes:
 *  - event: match a typed LogEvent by `kind`, with optional field matchers. Each
 *    matcher value is either an exact string (case-insensitive equality on the
 *    stringified field) OR a `/regex/` string (slashes delimit → tested as a
 *    case-insensitive RegExp against the stringified field). For a `target` field,
 *    the convention is `where:{target:'self'}` matches only the player-side expiry
 *    and OMITTING target matches any (self OR another entity) — Task #47.
 *  - raw:   match the raw log line with a case-insensitive regex.
 *  - app:   a renderer-side signal (e.g. bossDefeat). Main stores/serves these but
 *           never evaluates them; the always-mounted player fires them.
 */
export type AlertTriggerPrimitive =
  | { type: 'event'; kind: LogEventKind; where?: Record<string, string> }
  | { type: 'raw'; regex: string }
  | { type: 'app'; signal: AppSignal }

/**
 * A COMPOSITE trigger (Task #47) — combine primitive conditions with OR/AND:
 *  - type 'any': fires when ANY condition matches a single incoming event (OR).
 *  - type 'all': fires only when ALL conditions match THE SAME event (AND).
 *
 * SEMANTICS (documented, deliberately narrow): 'all' is same-event correlation only —
 * every condition must match the ONE incoming event. Cross-event correlation windows
 * (e.g. "buff X faded AND boss Y is up") are OUT OF SCOPE. Conditions are the primitive
 * shapes above; nesting is not supported (depth 1), which keeps evaluation O(conditions)
 * per event and the storage flat & JSON-serializable. Cooldown applies per ALERT, not per
 * condition (a composite fires at most once per cooldown, however many conditions matched) —
 * and per alert-and-target when the def sets `cooldownScope:'target'`.
 *
 * 'app' conditions inside a composite are ignored by the main-side matcher (they depend on
 * renderer-derived boss state); compose event/raw conditions for main-side alerts.
 */
export interface AlertTriggerComposite {
  type: 'any' | 'all'
  conditions: AlertTriggerPrimitive[]
}

/** An alert trigger: a primitive shape or an any/all composite (Task #47). */
export type AlertTrigger = AlertTriggerPrimitive | AlertTriggerComposite

/** Which sound a fired alert plays: a pack id + a sound id within that pack. */
export interface AlertSoundRef {
  packId: string
  soundId: string
}

// ----- Voice alerts (docs/plans/voice-alerts.md §1) -----
//
// An alert can SPEAK as well as (or instead of) play a sound. Everything below is the
// CONTENT model — what is said and by which voice. The engine plumbing (system
// speechSynthesis vs the Kokoro tier) is deliberately absent from these shapes: a def
// names a mode and, optionally, a voice, and nothing else. The runtime constants that go
// with these types (the mode list, the char cap, the pref defaults) live beside the
// resolver in `shared/speechText.ts`, which is the one module both sides already import.

/**
 * WHAT an alert says when it speaks.
 *  - 'custom'         → the def's own `phrase`, verbatim.
 *  - 'alertName'      → the alert's display name. Also the universal FALLBACK: a spell mode
 *                       on a firing that carries no spell resolves here rather than to
 *                       silence or to a guess (world-model law 1).
 *  - 'spellName'      → the triggering spell's display name, RANK-STRIPPED ("Mesmerization
 *                       III" → "Mesmerization"). Roman numerals are noise aloud.
 *  - 'spellFirstWord' → the first word of that rank-stripped name ("Swift Like the Wind" →
 *                       "Swift"). The owner's headline ask: the shortest useful utterance.
 */
export type SpeechMode = 'custom' | 'alertName' | 'spellName' | 'spellFirstWord'

/**
 * WHICH audio channel a fired alert uses (decision D5). Absent ⇒ 'sound', which is exactly
 * what every alert written before voice alerts existed meant — so the field is optional and
 * no migration has to touch a def that never asked to speak.
 *
 * 'both' IS RETIRED (owner, 2026-08-14: "also remove sound + spoken - too much garbage"). It
 * stays in the union because it stays READABLE — a store written by an older build, a share
 * string, an exported def — and `resolveAlertAudio` (shared/speechText.ts) is the one place it
 * turns back into a channel the app still has. Nothing OFFERS it any more: the two pickers list
 * `ALERT_AUDIO_CHOICES`, and every write goes through a value of that narrower type. See
 * `AlertAudioChoice` below for the rule, and never widen a picker back onto this union.
 */
export type AlertAudio = 'sound' | 'speech' | 'both'

/**
 * The channels a user can actually CHOOSE — the union every picker offers and every write
 * produces (JOS-362). `AlertAudio` minus the retired member, expressed as a subtraction so a
 * future member of the wider union is offered by default rather than silently dropped.
 */
export type AlertAudioChoice = Exclude<AlertAudio, 'both'>

/** Per-alert speech configuration. Absent on a def ⇒ treated as `{ mode: 'alertName' }`. */
export interface AlertSpeech {
  mode: SpeechMode
  /** Required iff mode === 'custom'; capped at MAX_SPEECH_CHARS (shared/speechText.ts). */
  phrase?: string
  /**
   * RETIRED (JOS-362) — a per-alert voice override, now IGNORED everywhere it is read.
   *
   * The owner's ruling: "our settings shouldn't store which voice per alert, only the preferences
   * should (within Voice (spoken))". A stored id is tolerated so old stores, exports and share
   * strings still load, and it is dropped the next time that alert is saved (`speechFieldsFor`,
   * `speechFieldsOf` — both rebuild this block without it). Nothing reads it: the voice comes from
   * `VoicePrefs.voiceId` at speak time. Do not re-introduce a reader.
   */
  voiceId?: string
}

/**
 * The two engine tiers (decision D1). 'system' is Chromium's own `speechSynthesis` (Windows
 * SAPI voices — zero download, instant); 'kokoro' is the downloaded Kokoro-82M ONNX tier.
 * Chatterbox is a NAMED SEAM, deliberately not a member.
 */
export type SpeechEngine = 'system' | 'kokoro'

/**
 * Global voice preferences (main-owned, persisted under the store's `voice` key).
 *
 * THERE IS NO MASTER SWITCH, and that is the model, not an omission (owner, 2026-08-04:
 * "duplicative settings; you should not have to enable voice in Preferences"). A def's
 * `audio: 'speech' | 'both'` IS the permission — choosing it in the alert row is the whole act
 * of turning speech on for that alert. What survives here is the voice's CONFIGURATION: which
 * tier speaks, in whose voice, how fast, how loud. A global `enabled` on top of a per-alert
 * channel meant two switches for one intent, and the one the user actually pressed was the one
 * that silently lost (schema v8 retires it — see storeMigrations.ts).
 */
export interface VoicePrefs {
  engine: SpeechEngine
  /** Default voice id within the chosen engine; null = "whatever the engine defaults to". */
  voiceId: string | null
  /** Speaking rate multiplier, 0.5–2. */
  rate: number
  /** 0..1, applied on top of the alerts module's own master volume. */
  volume: number
}

/** One voice a tier can speak with, as surfaced to the renderer by `speech:voices`. */
export interface SpeechVoice {
  /** engine-scoped id (a SAPI voice URI, or a Kokoro voice name). */
  id: string
  /** human label for the picker. */
  label: string
  engine: SpeechEngine
  /** BCP-47 tag when the engine states one ('en-US'); absent when it does not. */
  lang?: string
}

/**
 * Why a speech request could not be served. These are STATES, not errors — the UI says
 * what is missing instead of failing silently:
 *  - 'engine-not-installed' → the selected tier has no model/voices on disk yet.
 *  - 'engine-failed'        → the model IS on disk and synthesis still produced no audio.
 *  - 'engine-unloadable'    → the model is on disk and the machine cannot LOAD the engine at
 *                             all: the native module's `dlopen` failed (ERR_DLOPEN_FAILED).
 *  - 'not-implemented'      → this build ships the channel but not the engine behind it.
 *  - 'invalid-request'      → the handler rejected the payload (see ipc/speech.ts).
 *
 * THE LAST TWO ARE JOS-247, AND THEY EXIST BECAUSE ONE OF THEM WAS BEING TOLD AS THE FIRST.
 * Every failure of the downloaded tier used to answer 'engine-not-installed', including a user
 * whose 115 MB download had finished perfectly and whose worker thread then died on startup.
 * The renderer degrades to a Windows voice on any of these (that seam is unchanged and is the
 * point), but it can only SAY what happened if the reason is true — and "not downloaded" is a
 * different sentence, with a different remedy, from "downloaded, and this PC cannot run it".
 *
 * They are separate members rather than one reason plus a message because a message is free
 * text crossing IPC on an error path; a closed union carries the same fact and the renderer
 * owns every word the user reads.
 *
 * There is no 'disabled' member any more: it meant "voice is switched off in preferences", and
 * that switch no longer exists (see VoicePrefs). Nothing ever returned it.
 */
export type SpeechUnavailableReason =
  | 'engine-not-installed'
  | 'engine-failed'
  | 'engine-unloadable'
  | 'not-implemented'
  | 'invalid-request'

/** Args of `speech:say` — re-validated at the handler, never trusted. */
export interface SpeechSayRequest {
  /** the resolved utterance (see `speechTextFor`), already capped by the caller. */
  text: string
  /** voice override; absent ⇒ VoicePrefs.voiceId. */
  voiceId?: string
}

/**
 * Reply of `speech:say`. On success `url` is a playable source the renderer hands to its
 * existing alert audio element (W3 serves `eqspeech://<hash>` from the wav cache).
 */
export type SpeechSayResult =
  | { ok: true; url: string }
  | { ok: false; reason: SpeechUnavailableReason }

/** Reply of `speech:install` — provisioning a downloadable engine tier. */
export type SpeechInstallResult =
  | { ok: true }
  | { ok: false; reason: SpeechUnavailableReason; message?: string }

/**
 * WHERE A RUNNING INSTALL IS (W3). `speech:install` resolves only when provisioning has
 * FINISHED — a ~120 MB download — so the panel that started it needs a second channel to say
 * anything meanwhile. These land on `speech:installProgress` (main → renderer, broadcast to
 * the main window) while that one invoke is outstanding.
 *
 * The phases are STATES the UI renders, not log lines:
 *  - 'checking'    → deciding what is already on disk (a re-run of a finished install spends
 *                    its whole life here and then reports 'done').
 *  - 'downloading' → bytes are moving; `received`/`total` are the WHOLE install, so a single
 *                    progress bar is correct across both assets.
 *  - 'verifying'   → the file is complete and its sha256 is being checked. Deliberately its
 *                    own phase: it takes a visible second on 92 MB and a bar that sat at 100%
 *                    in silence reads as a hang.
 *  - 'done' / 'failed' → terminal, and always sent exactly once (the same verdict the
 *                    `speech:install` reply carries — this channel never disagrees with it).
 */
export interface SpeechInstallProgress {
  engine: SpeechEngine
  /** `waiting` is a rate-limited backoff (JOS-420) — minutes long, and a bar that is waiting looks
   *  exactly like a bar that is stuck unless it says which it is. */
  phase: 'checking' | 'downloading' | 'verifying' | 'waiting' | 'done' | 'failed'
  /** File currently being worked on, when one is ('kokoro-v1.0.int8.onnx'). */
  asset?: string
  /** Bytes secured across the whole install so far. */
  received: number
  /** Total bytes the install will move (0 while unknown). */
  total: number
  /** Human-readable detail for a 'failed' or 'waiting' phase. Never shown for the others. */
  message?: string
}

/** A single alert definition (persisted, JSON-serializable). */
export interface AlertDef {
  id: string
  name: string
  enabled: boolean
  trigger: AlertTrigger
  sound: AlertSoundRef
  /** 0..1, multiplied by the global volume. Defaults to 1. */
  volume?: number
  /** Minimum ms between two fires of this alert. Defaults to 2000. */
  cooldownMs?: number
  /**
   * WHAT THE COOLDOWN IS MEASURED PER (owner incident, 2026-08-04).
   *
   *  - 'alert'  → one clock for the whole alert: a fire silences it everywhere for `cooldownMs`.
   *  - 'target' → one clock PER TARGET: the first matching event on a mob always fires, and
   *               only re-lands on THAT mob are quiet for `cooldownMs`.
   *
   * The distinction is not cosmetic. A rogue's slow re-lands on a mob that is already slowed
   * several times a pull, so the alert needs a rate limit — but under one global clock a
   * re-land on the mob you are already fighting SILENCES the first slow on the next mob you
   * pull, which is the only landing that actually tells you something. Measured in the owner's
   * log 2026-08-04: a slow on King Tranix at 22:31:16 muted the fire giant warrior's first
   * slow 27 s later, and the player died at 22:33:40.
   *
   * The key is the event's `target` field, case-folded. A family that carries no target (a
   * zone line, a level-up) has nothing to scope by and falls back to the alert-level clock —
   * 'target' on such an alert is a no-op, never an error.
   *
   * Absent ⇒ 'alert', which is what every def written before this existed already meant, so
   * this is additive and needs no store migration of its own (readers default; electron-store
   * round-trips the key untouched).
   */
  cooldownScope?: 'alert' | 'target'
  /** Freeform provenance note (e.g. "authored by agent from: alert me on charm breaks"). */
  note?: string
  /**
   * Which audio channel this alert uses (D5). Absent ⇒ 'sound' — the meaning every def
   * written before voice alerts already had, which is why this is additive and optional.
   */
  audio?: AlertAudio
  /** What to say when `audio` includes speech. Absent ⇒ `{ mode: 'alertName' }`. */
  speech?: AlertSpeech
  /**
   * OPT OUT of cross-alert audio coalescing (renderer/features/alerts/audioThrottle.ts).
   *
   * By default every alert's audio is throttled ACROSS alerts — three buffs fading at once is
   * one audio alert, not three — because a smear of simultaneous sounds carries less than one.
   * Since JOS-347 that window folds by what would be HEARD (the pack sound plus the spoken
   * words), so the three buffs are still one sound while four alerts carrying four different
   * voice lines are four things to hear, each heard once inside the window.
   * `true` marks an alert that must never be swallowed by that window (a charm break, a raid
   * call): it always plays, and it does not itself occupy the window. Absent ⇒ throttled,
   * which is the default the owner asked for and the meaning every def written before this
   * existed already had — so it needs no store migration (readers default; electron-store
   * round-trips the key untouched).
   */
  alwaysPlay?: boolean
  /**
   * THE EARLY WARNING OFFSET, IN SECONDS (JOS-216) — "warn me 10 seconds before the mez drops".
   *
   * It MOVES this alert's one fire; it does not add a second one. A def with an offset does not
   * sound when its trigger matches: the match ARMS a warning against the timer row that landing
   * produced, and the alert fires `earlyWarnSec` seconds before that row's estimated end. One
   * landing is one warning, and a debuff that ends early (a break line, the mob dying, a zone)
   * takes its pending warning with it — the row is gone, so there is nothing left to warn about.
   *
   * AND WHEN THE TRIGGER IS THE ENDING, THE OFFSET ARMS FROM THE ROW INSTEAD (JOS-235). For a
   * break-family def — the per-spell `breaks`/`charmBreaks` alerts, the "Mez / root broke" and
   * "Charm break" groups, a slow wearing off — the trigger and the end are the SAME line, so
   * arming on it resolved against a world that line had already emptied and the alert went
   * SILENT, both early and at the break. Such a def instead arms when a row it would announce the
   * break of LANDS, and it still fires on its own trigger: one landing yields one firing, the
   * warning when the hold survives to the deadline (the at-break firing for that landing is then
   * suppressed), the break itself when it ends sooner. An early break is never silent.
   *
   * IT CONSUMES THE EXISTING ESTIMATE AND TRACKS NOTHING ITSELF. The end it counts back from is
   * `shared/buffTimers.ts buildTimerRows`' countdown row — the same number the debuffs overlay
   * draws — so a landing the model can state no duration for arms nothing at all rather than
   * warning against an invented one (world-model law 1; the rule and its honest limits are in
   * shared/earlyWarning.ts, the evaluator is main/modules/alerts.ts).
   *
   * Bounded by MIN/MAX_EARLY_WARN_SEC. Absent ⇒ fire on the trigger, which is what every def
   * written before this existed already meant — so it is additive, needs no store migration, and
   * an ordinary alert still saves byte-identically (import dedupe hashes these fields).
   */
  earlyWarnSec?: number
  /**
   * DOES THIS ALERT PUT A LINE ON THE ALERT BANNER OVERLAY (JOS-378)?
   *
   * ABSENT MEANS TRUE, AND THAT IS WHY THERE IS NO STORE MIGRATION. Every def in every existing
   * install was written before this key existed, so an absent key has to mean the useful thing:
   * switching the overlay on shows you your alerts rather than an empty strip you then have to
   * tick eighty boxes to fill. `false` is the taming direction — the owner's ruling is that not
   * every alert should show, and this switch is how you say which. Readers go through
   * `alertShowsOnScreen` (shared/alertBanner.ts); the key is written only when it is false, so a
   * def that shows saves the bytes it always did and import dedupe keeps matching it.
   *
   * IT IS NOT THE WHOLE GATE. The overlay being ON is the other half, checked in main — so an
   * install that never turns the banner on has this field mean nothing at all.
   */
  showOnScreen?: boolean
  /**
   * WHAT THE BANNER PRINTS INSTEAD (JOS-378) — the optional "On-screen text" override.
   *
   * ABSENT OR EMPTY MEANS "print the alert's NAME" (JOS-380): `alertBannerText` falls back to
   * `name`, which is the short thing the user wrote and already reads in the list. This field
   * exists for the case where the name is not what you want on screen — a name written to be
   * filed under ("Charm break - pet") against a line written to be seen ("CHARM BROKE").
   */
  bannerText?: string
  /**
   * WHICH SWATCH the banner line is drawn in (JOS-378) — the 2026-08-06 report's "controllable
   * color". Absent ⇒ the overlay's default; the closed six-value union and its hexes live in
   * shared/alertBanner.ts, which is also where the argument against a free colour picker is.
   */
  bannerColor?: AlertBannerColor
}

/** Global sound preferences (main-owned, persisted). */
export interface AlertPrefs {
  /** 0..1 master volume applied on top of each alert's own volume. */
  globalVolume: number
  /** When true, no alert sounds play (the player still receives deltas). */
  muted: boolean
  /**
   * ALWAYS PLAY EVERY ALERT — the per-alert `AlertDef.alwaysPlay` opt-out, raised to a global
   * one (JOS-222, owner 2026-08-11: "a preference to always play for all alerts").
   *
   * It is the SAME bypass, applied to every def rather than to the ones the user ticked: the
   * cross-alert coalescing window (renderer/features/alerts/audioThrottle.ts) is skipped and
   * nothing occupies it, so four buffs fading together are four sounds — four copies of the SAME
   * sound, which the window would have folded into one whatever they were named (JOS-347). That
   * IS the smear the throttle exists to prevent — which is why it STARTS OFF and stays off
   * unless the user says otherwise. Someone who would rather hear everything twice than miss one thing gets to say
   * so in one place instead of ticking a box on every alert they ever add.
   *
   * Absent ⇒ false ⇒ today's behavior, which is why this is additive: the key is written only
   * when it is true, so a store where the throttle is on is byte-identical to one written
   * before this existed, and every def's own `alwaysPlay` still means exactly what it meant.
   */
  alwaysPlayAll?: boolean
}

/** One alert that fired, carried in the alerts module delta. */
export interface FiredAlert {
  alertId: string
  ts: number
  /** The text that matched (raw line for raw/event triggers), for debugging/UI. */
  matchedText: string
  /**
   * WHERE THIS FIRE CAME FROM, when it did not come from the log (JOS-380).
   *
   * `'app'` marks the ECHO of a renderer-evaluated signal: the player fired the alert itself
   * (`fireAppSignal`), told main so the recent-fires history stays the one source of truth, and
   * main queued that record onto the same delta the log fires ride. Absent on every main-side
   * fire, which is nearly all of them.
   *
   * IT EXISTS SO THE ECHO IS NOT A SECOND FIRING. The player skips playback — sound, speech AND
   * banner — for a marked record, while history and the event feed still see it. Without the mark
   * every app-signal alert plays twice; audio coalescing (same identity within 1.5 s) swallowed
   * the second one for the life of the feature, and the banner, which is outside that gate by
   * ruling, is what finally showed it: two lines for one raid target.
   */
  origin?: 'app'
  /**
   * SPELL CONTEXT for the speech modes (docs/plans/voice-alerts.md §1) — the triggering
   * spell's DISPLAY name with its rank suffix INTACT ("Mesmerization III"), exactly as the
   * log spelled it. Rank-stripping is the resolver's job (`speechTextFor`), not the
   * producer's: a consumer that wants the rank must still be able to see it.
   *
   * ABSENT whenever the matched event names no spell — most of the event families, every
   * 'raw' trigger that matched a spell-less line, and every renderer-evaluated 'app' signal
   * (bossDefeat / questComplete). Which families DO carry one is enumerated in
   * `SPELL_FIELD_BY_KIND` (main/modules/alerts.ts). Never synthesized, never guessed.
   */
  spell?: string
  /**
   * NAMED REGEX CAPTURES from the condition that matched (JOS-103) — the values a `custom`
   * phrase's `{token}`s resolve to, so a spoken alert can say "Puma on Fail".
   *
   * PLUS THE ONE AUTO TOKEN (JOS-353): `target`, the entity the matched event says the spell is
   * affecting, filled in with no capture group declared and no regex written. It is carried ONLY
   * when the def's own phrase writes `{target}`, and a group the pattern declared under that name
   * always wins. The closed table of which field of which event kind answers it, and the security
   * argument for the one exemption to "a token is a declaration", are in shared/alertTargets.ts.
   *
   * ATTACKER-INFLUENCED BY CONSTRUCTION, and already defanged. The keys come from the def's own
   * pattern (`(?<player>…)`) but the VALUES come out of a log line, which carries other players'
   * chosen names and, for the chat families, text a stranger typed. Everything here has been
   * through `sanitizeCapture` (shared/alertCaptures.ts): the shared sanitizers have removed ANSI
   * sequences, control characters and the BiDi/invisible class, and each value is capped at
   * MAX_CAPTURE_CHARS. Read shared/alertCaptures.ts's threat model before consuming this
   * anywhere new — it is the enforcement point, and it explains why a consumer still must not
   * treat these as trusted text.
   *
   * ABSENT whenever the matching condition declared no named group, or captured nothing that
   * survived sanitization — an absent key is the honest JSON encoding of "this pattern named
   * nothing", and it keeps the delta byte-identical for the alerts that capture nothing (which
   * is nearly all of them).
   */
  captures?: Record<string, string>
  /**
   * WHEN THE THING THIS FIRING WARNS ABOUT IS DUE (ms epoch) — the countdown half of JOS-378.
   *
   * Present ONLY on an EARLY-WARNING firing (`AlertDef.earlyWarnSec`, JOS-216/235), and it is the
   * deadline the scheduler counted back from rather than a number computed here: `nowMs + sec`
   * would be a guess, and the row's own estimated end is what the debuffs overlay is already
   * drawing. A consumer can therefore say "Celerity fades in 12s" without inventing anything.
   *
   * ABSENT on every ordinary firing, which is nearly all of them — and absent on an EARLY BREAK
   * too (JOS-235: the hold ended before its warning, so the alert fires on its own trigger and
   * there is no deadline left). That is the honest encoding of "there is nothing to count down",
   * and it keeps the delta byte-identical for every alert without an offset.
   */
  dueAt?: number
}

/** One recorded fire in an alert's recent-fires ring buffer (Task #22). */
export interface AlertFireRecord {
  ts: number
  /** The matched log line (event/raw) or the app-signal context (e.g. boss name). */
  matchedText: string
}

/**
 * alerts module snapshot. `defs` are the alert definitions; `history` is a
 * per-alert ring buffer of recent fires (last ~20, newest last) — the single
 * source of truth for the "recent fires" UI, fed by BOTH main-side event/raw
 * fires and renderer-routed app fires (alerts:appFired). Keyed by alert id.
 */
export interface AlertsSnap {
  defs: AlertDef[]
  history: Record<string, AlertFireRecord[]>
  /**
   * RANK-PRESERVING cast recency (spell levelling intelligence): spell DISPLAY name with its
   * roman-numeral rank intact ("Mesmerization III") → the newest ts you began casting it.
   *
   * The buffs model's per-spell `lastSeenMs` is keyed by `spellCanonKey`, which STRIPS the
   * rank, so it cannot say which rank you are on; `castBegin` is the only event family that
   * keeps the suffix. Populated during replay as well as live, so it is complete at hydration.
   * Optional — a snapshot from a build before this existed simply has no ranks to offer.
   */
  spellLastCast?: Record<string, number>
  /**
   * ROGUE SLOW POISONS OBSERVED (docs/plans/poison-slow-alerts.md §1.3) — what the
   * "alert when a mob gets slowed?" offer is built on.
   *
   * Recorded exactly as `spellLastCast` is: on REPLAY as well as live, so the offer is
   * complete the moment the renderer hydrates rather than waiting for the next proc, and it
   * rides the alerts snapshot/delta that already flow over useModule (zero new IPC).
   *
   * Absent when no `poisonProc { effect: 'slow' }` has ever been seen — which is the honest
   * encoding of "this character is not fighting beside a rogue", and the state in which no
   * offer is made.
   */
  poisonSlowSeen?: PoisonSlowRecency
}

/**
 * Recency of the rogue slow proc (`<mob>'s limbs move slower!` → `poisonProc`, effect 'slow').
 * A count and a last sighting, nothing derived: the offer says "N slows landed", never a rate.
 */
export interface PoisonSlowRecency {
  /** newest ts (ms) a slow landing was observed. */
  lastAt: number
  /** how many have been observed for this character (replay + live). */
  count: number
  /** RAW display name of the mob the newest one landed on (canonicalize with idKey). */
  lastTarget: string
}
/** One rank-preserving cast observed since the last flush. */
export interface SpellCastRecency {
  /** display name, rank suffix intact. */
  spell: string
  ts: number
}
export interface AlertsDelta {
  fired: FiredAlert[]
  /** cast-recency entries that advanced since the last flush; merge by `spell`. */
  cast?: SpellCastRecency[]
  /**
   * The slow-proc recency AS OF THIS FLUSH (absolute, not an increment) — present only when a
   * slow landed since the last one. Absolute because the record is a running total the module
   * already owns; merging a delta of counts would drift if a delta were ever dropped.
   */
  poisonSlow?: PoisonSlowRecency
}

/** A discovered sound within a pack manifest. */
export interface PackSound {
  /** relative file name inside the pack dir (e.g. "victory.wav") */
  file: string
  /** human label shown in the sound picker */
  label: string
}

/** A sound pack manifest ({ id, name, sounds }). */
export interface SoundPackManifest {
  id: string
  name: string
  sounds: Record<string, PackSound>
  /** SPDX-ish license string copied from the pack's source manifest, when declared. */
  license?: string
}

/** A pack as surfaced to the renderer (manifest + where it came from). */
export interface SoundPack extends SoundPackManifest {
  /** 'bundled' (shipped default) or 'user' (dropped into <userData>/soundpacks). */
  source: 'bundled' | 'user'
}

/** Reply of sounds:getData — audio bytes as base64 so the renderer builds a Blob URL. */
export interface SoundData {
  mime: string
  dataBase64: string
}

// ----- Sound-pack registry (openpeon.com integration, Task #29) -----
//
// The openpeon.com registry (https://peonping.github.io/registry/index.json) lists
// community sound packs. We surface it in-app: browse → install (download the pack's
// GitHub release tarball, convert its CESP openpeon.json into our manifest.json,
// write into <userData>/soundpacks/<name>/) → the pack appears in the sound pickers
// immediately. Bundled packs are never in this registry list.

/** One pack as listed in the registry index (subset of fields we use). */
export interface RegistryPack {
  /** stable pack name (also the install dir name + our manifest id). */
  name: string
  display_name: string
  /** "Owner/Repo" the release tarball is fetched from. */
  source_repo: string
  /** git tag of the release (e.g. "v1.0.1"). */
  source_ref: string
  /** subdir within the extracted archive that is the pack root ("." for repo root). */
  source_path: string
  categories: string[]
  sound_count: number
  total_size_bytes: number
  description?: string
  license?: string
  version?: string
}

/** A registry pack annotated with whether it's already installed locally. */
export interface RegistryPackView extends RegistryPack {
  installed: boolean
}

/** Reply of packs:registry — the reconciled list plus a soft error (offline, etc.). */
export interface RegistryListResult {
  packs: RegistryPackView[]
  /** present when the live index couldn't be fetched (cached/empty list returned). */
  error?: string
  /** true when the list came from the on-disk/in-memory cache, not a live fetch. */
  fromCache?: boolean
}

/** Progress push over `packs:progress` while a pack installs. */
export interface PackInstallProgress {
  name: string
  /** `waiting` is a retry's backoff (JOS-420) — a stopped bar and a bar waiting out a rate limit
   *  look identical, so the wait says so and names its own length in `message`. */
  phase: 'downloading' | 'extracting' | 'converting' | 'waiting' | 'done' | 'error'
  /** 0..100 during downloading, when a content-length is known. */
  percent?: number
  message?: string
  /** This is a "later", not a "broken" — the row reads it as ordinary text rather than an error
   *  (JOS-420: a rate limit is the host being busy, and the pack is fine). */
  retryable?: boolean
}

/** Reply of packs:install / packs:uninstall. */
export interface PackMutationResult {
  ok: boolean
  error?: string
  /** The install can simply be clicked again — set when a rate limit ended the run (JOS-420). */
  retryable?: boolean
}

// ----- Registry pack PREVIEW (Task #31) -----
//
// Before installing, the registry browser can preview a pack's sounds: fetch the
// pack's CESP openpeon.json off GitHub raw, list its sounds, and stream a single
// audio file's bytes on demand — all without writing anything to disk.

/** One previewable sound within an un-installed registry pack. */
export interface PackPreviewSound {
  /** stable id derived the same way an install would (category + basename). */
  soundId: string
  /** human label (category prefix + CESP label), matching the installed picker. */
  label: string
  /** the source-relative audio path (e.g. "sounds/ab_add_player_01.mp3"). */
  file: string
}

/** Reply of packs:previewList — a pack's sounds without installing it. */
export interface PackPreviewList {
  sounds: PackPreviewSound[]
  /** present when the manifest couldn't be fetched/parsed. */
  error?: string
}

// ----- The user's OWN sounds (JOS-68, shared/userSounds.ts) -----
//
// An imported wav/mp3/ogg is COPIED into the reserved `my-sounds` pack, so a file the user
// later moves, renames or deletes can never silently mute an alert. These are the two IPC
// replies; the identity, the formats and the size cap live in shared/userSounds.ts.

/** One sound the user imported: its minted id and the filename it was named after. */
export interface UserSound {
  soundId: string
  label: string
}

/** A file the import refused, and the one sentence saying why. */
export interface UserSoundRejection {
  /** the file's basename — never an absolute path (no path ever crosses this channel). */
  file: string
  reason: string
}

/** Reply of sounds:importUser — what landed, what didn't, and the pack's full list after. */
export interface UserSoundImportResult {
  /** true when the user dismissed the OS picker: nothing happened, say nothing. */
  canceled: boolean
  added: UserSound[]
  rejected: UserSoundRejection[]
  /** every sound in the pack after the import (the management list re-renders off this). */
  sounds: UserSound[]
}

/** Reply of sounds:removeUser — whether the entry went, plus the remaining list. */
export interface UserSoundRemoveResult {
  removed: boolean
  sounds: UserSound[]
}
