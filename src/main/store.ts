import Store from 'electron-store'
import { join } from 'path'
import { STORE_NAME, USER_DATA } from './channel'
import { logError, logInfo } from './errorLog'
import { CURRENT_SCHEMA_VERSION } from './storeMigrations'
import { migrateStoreFile } from './storeFile'
import type {
  AlertDef,
  AlertPrefs,
  HeldCounts,
  OverlayConfig,
  OverlayKind,
  ProgressState,
  RosterEdit,
  UpdateChannel,
  VoicePrefs
} from '../shared/types'
import { clampBgAlpha, clampTextScale } from '../shared/types'
import type { InventorySource } from '../shared/outputs/baseline'
// The turn-in ledger's write rule (JOS-131). Shared with the renderer so "what a stored turn-in
// list may contain" has ONE definition on both sides of the IPC.
import { applyTurnIns } from '../shared/questTurnIns'
import { normalizeVoicePrefs } from '../shared/speechText'
import {
  normalizeCursorRing,
  normalizeOverlayAutoHide,
  type CursorRingPrefs,
  type OverlayAutoHidePrefs
} from '../shared/presencePrefs'
import { normalizeTelemetryPrefs, type TelemetryPrefs } from '../shared/telemetry'
import { DEFAULT_TOAST_CONFIG, normalizeToastConfig } from '../shared/toast'
import { DEFAULT_ALERT_BANNER_CONFIG, normalizeAlertBannerConfig } from '../shared/alertBanner'
import { DEFAULT_CON_CARD_CONFIG, applyConCardKnob } from '../shared/conCard'
import { normalizePerfHudPrefs, type PerfHudPrefs } from '../shared/perf'
import { normalizeGraphicsPrefs, type GraphicsPrefs } from '../shared/graphicsPrefs'
import { normalizeBuffTrustPrefs, type BuffTrustPrefs } from '../shared/buffTrust'
import { applyTimerOverlayKnobs } from '../shared/buffTimers'
// The XP overlay's two persisted knobs (JOS-195) — each validated by the module that owns its
// meaning, never by a predicate written here. It was four until JOS-332 moved the denominator and
// the tier membership out of the store entirely (`applyXpOverlayKnobs` says where they went), which
// is why the two normalizers that validated them are no longer imported.
import { normalizeXpRows } from '../shared/xpOverlay'
import { isSliceId } from '../shared/timeslice'
import type { ComboCorrection } from '../shared/classCombo'
import {
  ALERT_SOUND_MIGRATION_VERSION,
  DEFAULT_ALERT_PACK_ID,
  DEFAULT_ALERT_SOUNDS,
  alertSoundMigrationPending,
  migrateAlertSounds
} from './data/defaultPacks'
import { ALERT_TRIGGER_MIGRATION_VERSION, migrateAlertTriggers } from './data/alertDefMigrations'
// The seeds are written through the DEFAULT-PACK PREFERENCE now (JOS-273). The rule lives in
// ./alertSeeds.ts and takes the stored value as an argument — the preference's own accessors are
// in ./storeSoundPacks.ts, which imports `settingsStore` from HERE, so an import in that
// direction would make the settings store an import cycle.
import { seedAlertsWith } from './alertSeeds'
// The persisted SHAPE lives in ./storeShape.ts (this file is at its factoring ceiling). Nothing
// moved but the declaration; every accessor below is still written against it.
import type { StoreShape } from './storeShape'
// The main window's remembered size, position and maximized state (JOS-248). The type and its
// normalizer live next door because the module is PURE — see windowState.ts. Re-exported here so
// every existing importer (storeShape.ts, windows.ts) keeps the door it already used.
import { normalizeWindowState, type WindowBounds } from './windowState'

export type { WindowBounds }

const emptyProgress: ProgressState = {
  inventory: {},
  completedQuests: [],
  inventorySource: undefined
}


/**
 * SCHEMA MIGRATION, before anything reads the store — and before electron-store is even
 * constructed, so no reader can observe a pre-migration shape. Order of the world at this
 * point: channel.ts already chose `userData` and ran its one-time `eq-tools` seed (it is
 * store.ts's own first import), so whatever file we find here is the one this build will
 * use, whichever build wrote it. Never throws; the failure policy — including the SALVAGE that
 * stands between a torn write and a defaults boot (JOS-272) — is in storeFile.ts's header.
 *
 * ITS `error` HOOK IS THE ONE FLEET INSTRUMENT FOR A SETTINGS RESET, and it fires from HERE, at
 * module scope, minutes before `startTelemetry` exists. That is why `telemetry/errorReports.ts`
 * keeps what it holds across the first session boundary rather than clearing it: until JOS-272 this
 * line was recorded and then thrown away, every launch, on every install in the fleet.
 */
const schemaMigration = migrateStoreFile(join(USER_DATA, `${STORE_NAME}.json`), {
  info: (message) => logInfo(`[everquest-companion] ${message}`),
  error: (message) => logError('main:storeSchema', message)
})

const store = new Store<StoreShape>({
  // File name follows the product (Task #58): `<userData>/everquest-companion-progress.json`.
  // The pre-rename `eq-tools-progress.json` is copied+renamed into this channel's userData
  // on its first launch — see channel.ts `seedFromLegacy`.
  name: STORE_NAME,
  defaults: { byCharacter: {}, activeLogPath: undefined, windowBounds: undefined }
})

// Stamp a store that the migrator could not stamp itself: a fresh install (no file existed,
// so electron-store just created one from `defaults`) or a quarantined corrupt file. Gated on
// `to === CURRENT`, which is FALSE for a partial migration (a failed step must run again next
// launch) and for a store from a newer build (never version a downgrade backwards), and on
// there being no read error (a file we could not read is a file we must not describe).
if (schemaMigration.to === CURRENT_SCHEMA_VERSION && !schemaMigration.readError) {
  try {
    if (store.get('schemaVersion') !== CURRENT_SCHEMA_VERSION) {
      store.set('schemaVersion', CURRENT_SCHEMA_VERSION)
    }
  } catch (err) {
    logError('main:storeSchema', err)
  }
}

/**
 * When the settings store finished opening, in ms since PROCESS START — the `storeLoaded`
 * startup phase (docs/plans/perf-profiling.md P4).
 *
 * It is a plain exported number rather than a `markStartupPhase()` call ON PURPOSE: this module
 * runs from module scope, and importing main's perf module (which reaches windows.ts, which
 * reaches this file) would make a cycle out of a measurement. The composition root imports both
 * and does the marking — everything below this line in this file is function declarations, so
 * this really is the last thing the store's initialization does.
 */
export const STORE_READY_MS = performance.now()

/**
 * THE OPEN, MIGRATED STORE — for the accessor modules SPLIT OUT of this file (JOS-123).
 *
 * This file reached the repo's 400-code-line factoring ceiling, and the answer to that is a
 * split rather than a widened threshold (windows.ts → windowErrors.ts is the precedent). A
 * settings accessor is four lines of read-through-a-normalizer, so what a split one needs from
 * here is exactly this handle and nothing else: `StoreShape` still types every key, the schema
 * migration above has still already run (it runs from module scope, before `new Store()`, so a
 * module that imports this cannot observe a pre-migration shape), and `src/main/uiScale.ts` is
 * the first module taking that door.
 *
 * IT IS NOT A LICENCE TO BYPASS THE NORMALIZERS. The discipline every accessor below follows —
 * read through the normalizer, write through the SAME normalizer — is the whole reason a
 * hand-edited file, an old renderer and a migration cannot end up with three ideas of what a
 * setting is, and a split-out accessor owes it exactly as much as one written here. Reach for
 * this only to move that pattern out of a full file; never to read a raw key from a feature.
 */
export const settingsStore = store

/**
 * The main window's remembered state, or `undefined` when there is none to remember (JOS-248).
 *
 * Read through the normalizer and written through the SAME one, like every other setting in this
 * file: a store hand-edited to `width: "big"` answers `undefined` here, which the caller already
 * has an answer for (the default size), rather than reaching a BrowserWindow constructor.
 */
export function getWindowBounds(): WindowBounds | undefined {
  return normalizeWindowState(store.get('windowBounds'))
}

export function setWindowBounds(b: WindowBounds): void {
  const next = normalizeWindowState(b)
  // A state that does not normalize is not written. There is no sensible partial write here — the
  // rectangle is the value — and clobbering a good remembered position with a bad one would be the
  // one failure mode the user cannot undo without finding the JSON.
  if (next) store.set('windowBounds', next)
}

function allProgress(): Record<string, ProgressState> {
  return store.get('byCharacter', {})
}

export function getProgress(charId: string): ProgressState {
  return allProgress()[charId] ?? emptyProgress
}

/**
 * Write one character's whole progress record. EXPORTED since JOS-286 for exactly one reader —
 * `storePlans.ts`, which holds the two planner documents' accessors now that this file has reached
 * the measured 400-code-line ceiling (the roster.ts/windows.ts/perf.ts rule: SPLIT, never ratchet).
 * It remains the only write path into `byCharacter`; the split moved code rather than widening it.
 */
export function setProgress(charId: string, next: ProgressState): ProgressState {
  const all = allProgress()
  all[charId] = next
  store.set('byCharacter', all)
  return next
}

export function setInventory(
  charId: string,
  counts: HeldCounts,
  source: InventorySource
): ProgressState {
  return setProgress(charId, { ...getProgress(charId), inventory: counts, inventorySource: source })
}

// The achievements dump's write pair (JOS-429) is `./storeAchievements.ts` — a split-out accessor,
// for the reason that file's header gives: this one is at the factoring ceiling.

/**
 * Record what we know about ONE quest's turn-ins (JOS-131): the epoch-ms instants it was handed
 * in, which is a COUNT and not a flag because a Sky quest can be run again.
 *
 * The renderer states the whole list (the `setQuestComplete` shape this replaces did the same),
 * so the list is sanitized and the downgrade mirror is written — both in `applyTurnIns`, shared
 * with the renderer so the rule has one definition on either side of the IPC.
 */
export function setQuestTurnIns(charId: string, questKey: string, instants: number[]): ProgressState {
  const p = getProgress(charId)
  return setProgress(charId, { ...p, ...applyTurnIns(p, questKey, instants) })
}

// ----- Class-combo user corrections (docs/plans/class-combo-inference.md § 7) -----
//
// The ONLY durable combo state. Intervals are re-derived from the log on every replay; a
// correction is the one thing the log can never tell us again.
//
// KEYED BY TIME, NEVER BY INTERVAL ID. A correction recomputes every interval from scratch
// (a `/who` row typed later re-labels the past), so ids are recompute-unstable by design and
// an id-keyed correction would detach from the span it corrected on the very next fold.

/** This character's corrections, oldest first. Defaults on a missing key (downgrade-safe). */
export function getComboCorrections(charId: string): ComboCorrection[] {
  const list = getProgress(charId).combo?.corrections
  return Array.isArray(list) ? [...list] : []
}

/** Replace the whole correction list for a character. Returns what was stored. */
function saveComboCorrections(charId: string, corrections: ComboCorrection[]): ComboCorrection[] {
  const next = [...corrections].sort((a, b) => a.startTs - b.startTs || a.setAt - b.setAt)
  setProgress(charId, { ...getProgress(charId), combo: { corrections: next } })
  return next
}

/**
 * Record a correction, REPLACING any existing one with the same span. Same-span replace (rather
 * than append) is what makes "correct it, then correct it again" behave the way the user means:
 * two statements about one interval are one statement, the later one.
 */
export function setComboCorrection(charId: string, correction: ComboCorrection): ComboCorrection[] {
  const same = (c: ComboCorrection): boolean =>
    c.startTs === correction.startTs && c.endTs === correction.endTs
  return saveComboCorrections(charId, [...getComboCorrections(charId).filter((c) => !same(c)), correction])
}

/**
 * Drop every correction OVERLAPPING [startTs, endTs] — the "Reset to detected" action.
 * Overlap, not exact match, because the interval the user is looking at may have been split or
 * merged since the correction was written (that is the whole reason corrections are time-keyed).
 */
export function clearComboCorrections(
  charId: string,
  startTs: number,
  endTs: number | null
): ComboCorrection[] {
  const hi = endTs ?? Infinity
  return saveComboCorrections(
    charId,
    getComboCorrections(charId).filter((c) => (c.endTs ?? Infinity) < startTs || c.startTs > hi)
  )
}

// ----- Group-roster user edits (docs/plans/group-model.md §3) -----
//
// The ONLY durable roster state. Membership is re-derived from the log on every replay; an edit
// is the one thing the log can never tell us again — the member whose join line predates the
// file, or the ex-member the game never printed a leave line for.
//
// ONE EDIT PER NAME. "Add Rykkerr" then "remove Rykkerr" is one statement about one person, the
// later one — the same same-key-replace rule combo corrections use for a span, and the reason
// the popover's add and remove read as inverses rather than as an accumulating log.
//
// ADDITIVE + OPTIONAL: no schema bump, no migration. Every reader defaults on a missing key and
// electron-store rewrites the whole parsed object, so a store written by an older build loads
// unchanged and one written here still opens in a build that predates the roster.

/** Everything stored is re-validated on the way out: a hand-edited file must never be able to
 *  hand the module a shape it will render, and the renderer cannot write one either. */
function sanitizeRosterEdits(raw: unknown): RosterEdit[] {
  if (!Array.isArray(raw)) return []
  const out: RosterEdit[] = []
  for (const e of raw as Partial<RosterEdit>[]) {
    if (typeof e?.key !== 'string' || e.key === '') continue
    if (typeof e.name !== 'string' || e.name === '') continue
    if (e.action !== 'add' && e.action !== 'remove') continue
    if (typeof e.setAt !== 'number' || !Number.isFinite(e.setAt)) continue
    out.push({ key: e.key, name: e.name, action: e.action, setAt: e.setAt })
  }
  return out
}

/** This character's roster edits ([] when it has none, or when the stored value is unusable). */
export function getRosterEdits(charId: string): RosterEdit[] {
  return sanitizeRosterEdits(getProgress(charId).rosterEdits)
}

/** Record one edit, REPLACING any existing statement about the same name. */
export function setRosterEdit(charId: string, edit: RosterEdit): RosterEdit[] {
  const next = sanitizeRosterEdits([...getRosterEdits(charId).filter((e) => e.key !== edit.key), edit])
  setProgress(charId, { ...getProgress(charId), rosterEdits: next })
  return next
}

/** Forget the hand-made statement about one name — "let the log decide again". */
export function clearRosterEdit(charId: string, key: string): RosterEdit[] {
  const next = getRosterEdits(charId).filter((e) => e.key !== key)
  setProgress(charId, { ...getProgress(charId), rosterEdits: next })
  return next
}

// PET CLAIMS ARE NO LONGER READ OR WRITTEN (JOS-49). The three accessors that used to live here
// are gone with the question they answered — the owner cut the feature: "if you just have to pet
// attack once, this is a lot of work we can get wrong."
//
// THE STORED DATA IS DELIBERATELY LEFT ALONE. `ProgressState.petClaims` still exists on the type
// and any answers a user gave in v0.4.x are still in their store file, untouched, unread and
// unmigrated. Deleting them would be destroying a user's own statements to tidy up our types, and
// a migration that dropped the key would make going back to a build that reads them lossy —
// neither is worth anything to anybody. electron-store rewrites the whole parsed object, so the
// key round-trips for free.

export function getActiveLogPath(): string | undefined {
  return store.get('activeLogPath')
}

export function setActiveLogPath(logPath: string): void {
  store.set('activeLogPath', logPath)
}

// ----- EQ install-dir override (auto-discovery override) -----

/**
 * The manual EQ install-dir override, or undefined when unset (⇒ auto-detect).
 * An empty/whitespace string is treated as unset so "clear the field" reverts to
 * auto-discovery. Consumed by src/main/log/config.ts `resolveEqDir`.
 */
export function getEqInstallDir(): string | undefined {
  const v = store.get('eqInstallDir')
  return v?.trim() ? v : undefined
}

/** Set (or clear, with undefined/'') the manual EQ install-dir override. */
export function setEqInstallDir(dir: string | undefined): void {
  if (dir?.trim()) store.set('eqInstallDir', dir)
  else store.delete('eqInstallDir')
}

/**
 * The install root a previous launch's auto-discovery persisted (JOS-112), or undefined if none.
 * An empty/whitespace value is treated as unset. Consumed by config.ts `discoverOnce` to skip the
 * sweep on later launches; NEVER a substitute for the manual override, which still wins.
 */
export function getEqDiscoveredRoot(): string | undefined {
  const v = store.get('eqDiscoveredRoot')
  return v?.trim() ? v : undefined
}

/** Persist a POSITIVE auto-discovery result so the next launch can skip the sweep (JOS-112). */
export function setEqDiscoveredRoot(root: string): void {
  if (root.trim()) store.set('eqDiscoveredRoot', root)
}

/** Forget the persisted discovered root — self-heal, or a manual-override change invalidated it. */
export function clearEqDiscoveredRoot(): void {
  store.delete('eqDiscoveredRoot')
}

// ----- Floating overlay DPS meter (Task #52; per-kind in Task #54) -----

/** Per-kind defaults. Sizes/positions live in overlayLayout.ts; `bounds` stays undefined here so
 *  a first open is placed by that layout and every later open uses what the user left. */
const DEFAULT_OVERLAY_CONFIG: Record<OverlayKind, OverlayConfig> = {
  fight: { open: false, locked: false, bgAlpha: 0.72, bounds: undefined, drill: null },
  overall: { open: false, locked: false, bgAlpha: 0.72, bounds: undefined, drill: null },
  events: { open: false, locked: false, bgAlpha: 0.72, bounds: undefined, drill: null },
  // The HEALING pair (Task #59). Same knobs as the damage meters.
  'heal-fight': { open: false, locked: false, bgAlpha: 0.72, bounds: undefined, drill: null },
  'heal-overall': { open: false, locked: false, bgAlpha: 0.72, bounds: undefined, drill: null },
  // The CELEBRATION TOAST (docs/plans/celebration-toasts.md). `locked: true` is the resting
  // state that makes it a notifier rather than a window: locked = click-through, and the
  // overlay flips capture on only while a card is actually on screen. Unlocking is how you
  // reposition it (Preferences → Overlays), exactly as with the meters.
  //
  // THE ONE KIND THAT DEFAULTS ON (owner, 2026-08-05: "it should be on by default"). Every
  // meter is a window you go and get when you want numbers; this one is a card that appears for
  // a few seconds when something worth cheering happens and is INVISIBLE and click-through the
  // rest of the time — so an install that never mentions it is better with it than without.
  // Stores written by the first toast build carry `open: false` from that default and are
  // corrected once, by migration 8→9 (storeMigrations.ts).
  toast: {
    open: true,
    locked: true,
    bgAlpha: 0.72,
    bounds: undefined,
    drill: null,
    toast: { ...DEFAULT_TOAST_CONFIG }
  },
  // The BUFF/TIMER bars (JOS-89, docs/plans/buff-timer-overlay.md).
  //
  // DEFAULT OFF, AND IT SHIPS WITH NO MIGRATION — that combination is the design, not an
  // omission. The owner's direction is to build it now and validate correctness internally
  // before promoting it, and a default only ever supplies the value for an ABSENT key:
  // `overlays.buffs` has never been written by any build, so every existing store reads
  // `open: false` here and every upgrading user gets it off for free. Adding a migration is
  // precisely the thing that would turn it ON — see migrateToV9, the one time this repo did
  // flip a stored default, whose comment says it is a one-time correction and never a policy
  // that the app may re-enable things.
  buffs: { open: false, locked: false, bgAlpha: 0.72, bounds: undefined, drill: null },
  // The DEBUFF/TIMER bars — the second half of the JOS-119 split.
  //
  // THE SPLIT NEEDS NO MIGRATION, AND THAT IS THE POINT. `overlays.buffs` KEEPS ITS KEY, so an
  // existing install's stored buffs window — its bounds, its open flag, its alpha, its text scale
  // — carries over byte for byte and lands on the window that still draws that user's buffs.
  // `overlays.debuffs` has never been written by any build, so every upgrading store reads the
  // default below and gets the new window OFF for free. A migration is precisely the thing that
  // could turn something on (see migrateToV9, the one time this repo flipped a stored default, and
  // its comment saying that was a one-time correction and never a policy), so there is none: the
  // schema version is untouched at 11 and a store written by this build round-trips through the
  // previous one unchanged.
  //
  // Its content moved rather than appeared: before this split the buffs window drew debuffs and
  // mez holds too. Nobody LOSES a row — the rows are in a window that ships off, which is the same
  // internal-validation stance JOS-89 shipped under and the owner's direction for this one.
  debuffs: { open: false, locked: false, bgAlpha: 0.72, bounds: undefined, drill: null },
  // The XP / PROGRESS read (JOS-195).
  //
  // DEFAULT OFF, NO MIGRATION — the third time this file has said it, and for the third time it is
  // the design rather than an omission. `overlays.xp` has never been written by any build, so every
  // existing store reads this default and every upgrading user gets the window off for free; a
  // migration is precisely the thing that could turn something on (migrateToV9 is the one time this
  // repo flipped a stored default, and its comment says that was a one-time correction and never a
  // policy). The schema version is untouched and a store written by this build round-trips through
  // the previous one unchanged.
  //
  // `xpRows`, `xpSlice` and `xpBasis` are ABSENT here on purpose rather than spelled out: absent is
  // what each one's default MEANS (every row; the current zone this session — JOS-288 moved that
  // from `session`; the elapsed hour), those meanings live beside the code that reads them, and
  // writing them here would be a second copy of all three.
  xp: { open: false, locked: false, bgAlpha: 0.72, bounds: undefined, drill: null },
  // RESPAWN CLOCKS (JOS-194). Default off, no migration — the fourth restatement of the same
  // policy, and the argument above holds verbatim: `overlays.respawn` has never been written by
  // any build, so every existing store reads this default and gets the window off for free.
  respawn: { open: false, locked: false, bgAlpha: 0.72, bounds: undefined, drill: null },
  // THE ALERT BANNER (JOS-378). `locked: true` is the resting state that makes it a notifier
  // rather than a window — the celebration toast's arrangement, and for the same reason: locked
  // is click-through, and the overlay flips capture on only while a line is actually on screen.
  //
  // DEFAULT OFF, NO MIGRATION — the fifth restatement of the policy above, and this time it is an
  // explicit owner ruling (2026-08-15) rather than an inference: the overlay does not ship
  // enabled, it lives in Preferences → Overlays beside the other kinds, and the user turns it on.
  // `overlays.alertBanner` has never been written by any build, so every existing store reads this
  // default and gets the window off for free. A migration is precisely the thing that could turn
  // something on (migrateToV9 is the one time this repo flipped a stored default, and its comment
  // says that was a one-time correction and never a policy), so there is none.
  // prettier-ignore
  alertBanner: { open: false, locked: true, bgAlpha: 0.72, bounds: undefined, drill: null, alertBanner: { ...DEFAULT_ALERT_BANNER_CONFIG } },
  // THE CON CARD (JOS-383). `locked: true` for the banner's reason: locked is click-through, and
  // the overlay flips capture on only while a card is actually on screen.
  //
  // DEFAULT **ON**, AND STILL NO MIGRATION — which is why this entry breaks the run of five above
  // rather than continuing it. The policy those restatements defend is "a migration never turns
  // something on"; a DEFAULT decides the value of an ABSENT key, and `overlays.conCard` has never
  // been written by any build, so every store on earth reads this line and gets the card. Nothing
  // is rewritten, nothing stored is reinterpreted, and a user who switches it off writes a `false`
  // no future step is allowed to overrule (the 8 -> 9 step's promise, kept). The owner's ruling
  // (2026-08-16) is that this one ships on: it answers a question the player just asked by typing
  // `/con`, which is exactly what the alert banner's "text over the game nobody asked for" is not.
  // prettier-ignore
  conCard: { open: true, locked: true, bgAlpha: 0.72, bounds: undefined, drill: null, conCard: { ...DEFAULT_CON_CARD_CONFIG } }
}

/** Read a kind's overlay config, filling missing fields with the kind's defaults.
 *  The pre-Task-#54 flat `overlay` key used to be folded into `overlays.fight` HERE, on every
 *  read; that fold is now schema migration 1→2 (storeMigrations.ts), which runs once at
 *  startup — an ad-hoc fixup in a hot read path is exactly what the chain replaces. */
export function getOverlayConfig(kind: OverlayKind): OverlayConfig {
  const all = store.get('overlays') ?? {}
  const cfg: OverlayConfig = { ...DEFAULT_OVERLAY_CONFIG[kind], ...(all[kind] ?? {}) }
  // The spread above is SHALLOW, so a stored `toast` blob written by an older build (or by
  // hand) replaces the defaults wholesale. Normalizing it here means every reader — including
  // the one that decides what sound to play — sees a complete, clamped blob.
  if (kind === 'toast') cfg.toast = normalizeToastConfig({ ...DEFAULT_TOAST_CONFIG, ...cfg.toast })
  // The banner blob gets the SAME treatment for the same reason (JOS-378): the spread above is
  // shallow, so a stored blob replaces the defaults wholesale, and every reader — including main's
  // relay, which fills a payload's hold from it — must see a complete, clamped one.
  // prettier-ignore
  if (kind === 'alertBanner') cfg.alertBanner = normalizeAlertBannerConfig({ ...DEFAULT_ALERT_BANNER_CONFIG, ...cfg.alertBanner })
  // The con card's one knob, on the same terms (JOS-383) — in its own file, beside the kind's own
  // vocabulary, because this one is at the 400-code-line ceiling (`applyTimerOverlayKnobs`' rule).
  applyConCardKnob(kind, cfg)
  // Text scale postdates every other field, so it is ABSENT in most stores and out of range in a
  // hand-edited one — both answered here rather than repeated six times above, because the
  // default (1) does not differ per kind. Clamped on the way out as well as in: see
  // `clampTextScale`.
  cfg.textScale = clampTextScale(cfg.textScale)
  // The retired row budget (`topN`, 5 or 10 — owner feedback 2026-08-05: every row renders and
  // the pane scrolls). Every store written before that carries it; dropping it HERE means it
  // never rides a merge-patch back out, which retires the key without a schema migration — one
  // dead scalar is not worth a version bump, and a store that still has it is not broken.
  delete (cfg as OverlayConfig & { topN?: number }).topN
  return cfg
}

/**
 * THE XP WINDOW'S TWO REMAINING KNOBS (JOS-195 rows + slice), REBUILT RATHER THAN TRUSTED — the
 * same argument as the drill and the toast blob beside them: a renderer patch must not be able to
 * widen what is persisted, and ABSENT is a real answer for both (every row; the current zone this
 * session).
 *
 * IT USED TO BE FOUR. The denominator (`xpBasis`, JOS-288) and the tier membership (`xpZoneScope`,
 * JOS-291) were retired from the store by JOS-332: they are the same two controls the Leveling tab
 * draws, so keeping a per-window copy meant two states behind one label — see the note where they
 * used to be declared in `shared/types.ts`. They are now one EPHEMERAL app-wide selection in
 * `src/main/scopeSelection.ts`, rebuilt at ITS handler by the same not-trusted rule. Both keys are
 * simply no longer preserved here, so an older store sheds them on its first patch, exactly the way
 * `getOverlayConfig` sheds `topN`.
 *
 * Its own function for `applyTimerOverlayKnobs`' reason, one file over: extra knobs are extra
 * branches, and `setOverlayConfig` is at the measured complexity ceiling. Both are deleted on every
 * other kind, so a malformed patch cannot grow an xp knob on a damage meter.
 */
function applyXpOverlayKnobs(kind: OverlayKind, next: OverlayConfig): void {
  // `normalizeXpRows` drops unknown row ids, so a hand-edited store cannot switch on a row this
  // build does not have.
  const xpRows = normalizeXpRows(next.xpRows)
  if (xpRows && kind === 'xp') next.xpRows = xpRows
  else delete next.xpRows
  // The retired pair, dropped WHATEVER the kind — a store written by an older build carries them
  // and nothing reads them any more, so preserving them would leave a dead choice on disk that
  // silently disagrees with the live one.
  const retired = next as OverlayConfig & { xpBasis?: unknown; xpZoneScope?: unknown }
  delete retired.xpBasis
  delete retired.xpZoneScope
  // The slice id is checked against the closed union, never against what the log can currently
  // define: `resolveSliceId` in the renderer already degrades a pick this record cannot answer, and
  // a store that forgot the user's choice because they happened to relaunch mid-session would be
  // the same bug from the other direction.
  const xpSlice = next.xpSlice
  if (kind === 'xp' && isSliceId(xpSlice)) next.xpSlice = xpSlice
  else delete next.xpSlice
}

/** Merge-patch a kind's overlay config (only the provided keys change). Returns the merged value. */
export function setOverlayConfig(kind: OverlayKind, patch: Partial<OverlayConfig>): OverlayConfig {
  const next: OverlayConfig = { ...getOverlayConfig(kind), ...patch }
  // Clamp the numeric fields defensively (the slider / the text stepper come from the renderer).
  // The alpha's clamp moved OUT of this file with the slider's own numbers (JOS-407,
  // shared/overlayBgAlpha.ts), and its floor rose from 0 to the slider's own 0.1: the old range
  // let a hand-edited store (or a share import's `clamp01`) hold a 0 that no control could get
  // back off the floor.
  next.bgAlpha = clampBgAlpha(next.bgAlpha)
  next.textScale = clampTextScale(next.textScale)
  // The drill is remembered UI state from the overlay renderer — normalize anything malformed
  // (and `undefined`) down to level 1 so the stored shape stays exactly `{entityId} | null`.
  //
  // It is rebuilt field by field on purpose, so a renderer patch can never widen what is
  // persisted. THAT IS ALSO THE DEGRADE PATH (JOS-113): JOS-105 briefly persisted an optional
  // `category` (a third drill level); rebuilding to `{entityId}` here DROPS it, so a store written
  // by that build degrades to the flat ability list — the drill's two-level shape now — with no
  // migration, exactly as a stale `entityId` degrades to the source list in `petRows.meterPanel`.
  const drilled = next.drill && typeof next.drill.entityId === 'string' ? next.drill : null
  next.drill = drilled ? { entityId: drilled.entityId } : null
  // The toast blob is renderer-writable too (the Preferences sound picker), so it is clamped
  // by its own normalizer rather than trusted — same rule as bgAlpha/textScale above. Only the
  // toast kind carries one; the meters must not grow a stray blob from a malformed patch.
  if (kind === 'toast') next.toast = normalizeToastConfig({ ...DEFAULT_TOAST_CONFIG, ...next.toast })
  else delete next.toast
  // The banner blob is renderer-writable too (Preferences owns its hold and its line budget), so
  // it is clamped by its own normalizer rather than trusted — the toast blob's rule, one kind over.
  // prettier-ignore
  if (kind === 'alertBanner') next.alertBanner = normalizeAlertBannerConfig({ ...DEFAULT_ALERT_BANNER_CONFIG, ...next.alertBanner })
  else delete next.alertBanner
  // The con card's knob is renderer-writable too (Preferences owns the auto-hide), so it is clamped
  // by its own normalizer rather than trusted — the two blobs above, through one shared applier.
  applyConCardKnob(kind, next)
  // THE TWO TIMER WINDOWS' OWN KNOBS — the row arrangement (JOS-140) and the permanent-buff switch
  // (JOS-215). Both are rebuilt rather than trusted, on the same argument as the drill above; the
  // rule lives beside `isTimerOverlayKind` in shared/buffTimers.ts, which is what "which kinds
  // carry this knob" is a fact about.
  applyTimerOverlayKnobs(kind, next)
  applyXpOverlayKnobs(kind, next)
  const all = store.get('overlays') ?? {}
  all[kind] = next
  store.set('overlays', all)
  return next
}

// ----- Auto-update channel (Task #27) -----

/**
 * Default channel: 'main' — the bleeding-edge stream CI publishes on every push.
 *
 * Task #55 removed channel SELECTION from the UI (there is no setter and no IPC any
 * more); this read stays so an install that picked 'stable' before keeps its feed.
 */
export function getUpdateChannel(): UpdateChannel {
  const c = store.get('updateChannel')
  return c === 'stable' ? 'stable' : 'main'
}

/**
 * Last completed update check (epoch millis), or undefined if we have never
 * completed one. Read once at updater init so "checked …" survives a relaunch —
 * including the relaunch our OWN apply-on-quit performs (Task #60).
 */
export function getUpdateLastCheckedAt(): number | undefined {
  const ts = store.get('updateLastCheckedAt')
  return typeof ts === 'number' && ts > 0 ? ts : undefined
}

/** Stamp a completed check. Called on every available/not-available/error verdict. */
export function setUpdateLastCheckedAt(ts: number): void {
  store.set('updateLastCheckedAt', ts)
}

// ----- Alerts extension (Task #18) -----

const DEFAULT_ALERT_PREFS: AlertPrefs = { globalVolume: 0.7, muted: false }

/**
 * Alerts seeded once, the first time the alerts store is empty. Kept minimal and
 * self-documenting: a charm-break warning (live 'uncharm' event) and a boss-defeat
 * fanfare (renderer app signal). A future agent adds more via saveAlert().
 */
const SEED_ALERTS: AlertDef[] = [
  {
    id: 'charm-break',
    name: 'Charm break',
    enabled: true,
    trigger: { type: 'event', kind: 'uncharm' },
    // "I find myself... requiring your attention." — the calm-but-pointed read lands
    // better than a joke sting for suddenly losing your charmed pet (Task #21).
    sound: { packId: DEFAULT_ALERT_PACK_ID, soundId: DEFAULT_ALERT_SOUNDS.charmBreak },
    note: 'Seeded default - fires when a charm spell wears off (you lose your pet).'
  },
  {
    id: 'boss-defeat',
    name: 'Raid target defeated',
    enabled: true,
    trigger: { type: 'app', signal: 'bossDefeat' },
    // "The matter is settled."
    sound: { packId: DEFAULT_ALERT_PACK_ID, soundId: DEFAULT_ALERT_SOUNDS.bossDefeat },
    note: 'Seeded default - fires the same moment boss confetti does.'
  },
  {
    id: 'quest-complete',
    name: 'Sky quest complete',
    enabled: true,
    // Fires the same instant a Plane of Sky quest auto-completes from a detected
    // turn-in (giver received every required item) — the renderer's questComplete
    // app signal, fired exactly where the quest-complete confetti + snackbar do
    // (Task #46). Never fires on load/hydration or manual checkbox completion.
    trigger: { type: 'app', signal: 'questComplete' },
    // "It is done."
    sound: { packId: DEFAULT_ALERT_PACK_ID, soundId: DEFAULT_ALERT_SOUNDS.questComplete },
    note: 'Seeded default - fires the same moment a Sky quest turn-in celebration does.'
  }
]

/**
 * One-time migration (Task #57): alerts authored against a retired pack — the deleted
 * synthesized `default` pack, or the `peon`/`sc_marine`/`bastion` packs the app used to
 * provision — are re-pointed at the analogous Alan Rickman line (mapping +
 * rationale: src/main/data/defaultPacks.ts). Without it an upgrading user's alerts go
 * silently mute once those pack dirs are gone.
 *
 * Version-stamped and idempotent: it runs on the FIRST alert read after upgrading and
 * never again, so a user who reinstalls `peon` from the registry and re-points an alert
 * at it keeps that choice. Returns the (possibly rewritten) list.
 */
function migrateStoredAlertSounds(alerts: AlertDef[]): AlertDef[] {
  // The gate is a pure predicate in data/defaultPacks.ts (JOS-272) so the "already stamped ⇒ never
  // again" rule can be driven from a node test. Its header says what a bump costs.
  if (!alertSoundMigrationPending(store.get('alertSoundMigration'))) return alerts
  const { alerts: next, changed } = migrateAlertSounds(alerts)
  if (changed > 0) store.set('alerts', next)
  store.set('alertSoundMigration', ALERT_SOUND_MIGRATION_VERSION)
  return next
}

/**
 * One-time migration of SHIPPED alert def TRIGGERS (2026-08-04): the rogue-slow def rate-limits
 * per mob instead of once for the whole alert. Rationale, the incident it comes from, and the
 * step that widened the trigger before the owner sent it back: src/main/data/alertDefMigrations.ts.
 *
 * Same contract as migrateStoredAlertSounds above and for the same reason — it rewrites only a
 * def still identical to one the app authored, so a user who re-shaped it keeps their version,
 * and the stamp means the rewrite can never undo that choice later.
 *
 * The STAMP IS AN INPUT, not just a gate: the chain is append-only, so a store runs the steps
 * newer than its own stamp and no others. A store at 1 must not re-run step 1.
 */
function migrateStoredAlertTriggers(alerts: AlertDef[]): AlertDef[] {
  const from = store.get('alertTriggerMigration') ?? 0
  if (from >= ALERT_TRIGGER_MIGRATION_VERSION) return alerts
  const { alerts: next, changed } = migrateAlertTriggers(alerts, from)
  if (changed > 0) store.set('alerts', next)
  store.set('alertTriggerMigration', ALERT_TRIGGER_MIGRATION_VERSION)
  return next
}

/**
 * Return the stored alert list, seeding the defaults exactly once (when the key is
 * absent — an empty [] the user emptied intentionally is respected). Existing lists
 * pass through the retired-pack sound migration and the shipped-def trigger migration on
 * their first read after an upgrade.
 */
export function getAlerts(): AlertDef[] {
  const existing = store.get('alerts')
  if (existing === undefined) {
    const seeded = seedAlertsWith(SEED_ALERTS, store.get('soundPacks'))
    store.set('alerts', seeded)
    // Seeds already reference the default pack and carry no group def; stamp both so neither
    // migration ever re-runs against a store that was born current.
    store.set('alertSoundMigration', ALERT_SOUND_MIGRATION_VERSION)
    store.set('alertTriggerMigration', ALERT_TRIGGER_MIGRATION_VERSION)
    return seeded
  }
  return migrateStoredAlertTriggers(migrateStoredAlertSounds(existing))
}

/**
 * Replace the whole alert list. Used by the ADDITIVE share-import path (src/main/share.ts),
 * which computes the merged list — existing entries untouched at the head, imports appended
 * — and writes it in one shot rather than N saveAlert() round-trips. Returns the list.
 */
export function saveAlerts(list: AlertDef[]): AlertDef[] {
  store.set('alerts', list)
  return list
}

/** Upsert an alert by id (insert if new, replace in place otherwise). Returns the list. */
export function saveAlert(def: AlertDef): AlertDef[] {
  const list = getAlerts()
  const idx = list.findIndex((a) => a.id === def.id)
  const next = idx >= 0 ? list.map((a) => (a.id === def.id ? def : a)) : [...list, def]
  store.set('alerts', next)
  return next
}

/** Delete an alert by id. Returns the remaining list. */
export function deleteAlert(id: string): AlertDef[] {
  const next = getAlerts().filter((a) => a.id !== id)
  store.set('alerts', next)
  return next
}

/** Restore the seeded built-in alert set, discarding any user edits (Task #22). */
export function resetAlerts(): AlertDef[] {
  const next = seedAlertsWith(SEED_ALERTS, store.get('soundPacks'))
  store.set('alerts', next)
  return next
}

export function getAlertPrefs(): AlertPrefs {
  return { ...DEFAULT_ALERT_PREFS, ...(store.get('alertPrefs') ?? {}) }
}

/**
 * Persist the global alert prefs, re-clamped. `alwaysPlayAll` is written ONLY when true (JOS-222)
 * so a store with the audio throttle on stays byte-identical to one written before the preference
 * existed — `getAlertPrefs` defaults the absent key, so off and absent are the same answer.
 */
export function setAlertPrefs(prefs: AlertPrefs): AlertPrefs {
  const next: AlertPrefs = {
    globalVolume: Math.max(0, Math.min(1, prefs.globalVolume)),
    muted: prefs.muted,
    ...(prefs.alwaysPlayAll === true ? { alwaysPlayAll: true } : {})
  }
  store.set('alertPrefs', next)
  return next
}

// ----- Voice alerts / TTS preferences (docs/plans/voice-alerts.md §2) -----
//
// Speech obeys the alert master switches ABOVE, not instead of them: a muted alerts module
// speaks nothing. This blob answers ONLY "with what voice, how fast, how loud" — it holds no
// switch of its own. WHETHER an alert speaks is the def's `audio` field and nothing else
// (owner, 2026-08-04; the retired `voice.enabled` is dropped by schema migration v8).

/**
 * The stored voice prefs, defaulted + clamped field by field. `normalizeVoicePrefs` takes
 * `unknown` on purpose: this key can hold anything a hand edit, a downgrade or a future build
 * left behind, and every reader in this file defaults rather than trusts (the downgrade
 * contract in storeMigrations.ts).
 */
export function getVoicePrefs(): VoicePrefs {
  return normalizeVoicePrefs(store.get('voice'))
}

/** Persist voice prefs. Re-clamped through the SAME normalizer the read uses — a renderer
 *  string is a renderer string, and the two can never disagree about what is valid. */
export function setVoicePrefs(prefs: VoicePrefs): VoicePrefs {
  const next = normalizeVoicePrefs(prefs)
  store.set('voice', next)
  return next
}

// ----- Cursor ring + overlay auto-hide (schema v5; shared/presencePrefs.ts) -----
//
// Both blobs follow the voice-prefs shape exactly: read through the normalizer (so a hand edit,
// a downgrade or a share import can never hand a caller an out-of-range value), write through
// the SAME normalizer (so the reply is always what was actually stored), and PATCH rather than
// replace — the two Preferences panels each own one field of a blob and must not clobber the
// others by round-tripping a stale copy.

/** The cursor-ring prefs, defaulted + clamped. Never throws, never returns a partial. */
export function getCursorRing(): CursorRingPrefs {
  return normalizeCursorRing(store.get('cursorRing'))
}

/** Merge-patch the cursor-ring prefs; returns the stored (re-normalized) value. */
export function setCursorRing(patch: Partial<CursorRingPrefs>): CursorRingPrefs {
  const next = normalizeCursorRing({ ...getCursorRing(), ...patch })
  store.set('cursorRing', next)
  return next
}

/** The overlay auto-hide prefs, defaulted. Never throws, never returns a partial. */
export function getOverlayAutoHide(): OverlayAutoHidePrefs {
  return normalizeOverlayAutoHide(store.get('overlayAutoHide'))
}

/** Merge-patch the overlay auto-hide prefs; returns the stored (re-normalized) value. */
export function setOverlayAutoHide(patch: Partial<OverlayAutoHidePrefs>): OverlayAutoHidePrefs {
  const next = normalizeOverlayAutoHide({ ...getOverlayAutoHide(), ...patch })
  store.set('overlayAutoHide', next)
  return next
}

// ----- Usage analytics (schema v6; shared/telemetry.ts) -----
//
// Same shape as the two blobs above: read through the normalizer, write through the SAME
// normalizer, and PATCH rather than replace — the toggle, the notice modal and the rotate
// button each own one field and must not clobber the others by round-tripping a stale copy.
//
// These prefs are the ONLY part of this feature that is not disposable. The buffered events
// live in `<userData>/telemetry.json` (src/main/telemetry/ring.ts) precisely because they can
// be thrown away; forgetting that a user turned analytics OFF could not be.

/** The telemetry prefs, defaulted field by field. Never throws, never returns a partial. */
export function getTelemetryPrefs(): TelemetryPrefs {
  return normalizeTelemetryPrefs(store.get('telemetry'))
}

/** Merge-patch the telemetry prefs; returns the stored (re-normalized) value. */
export function setTelemetryPrefs(patch: Partial<TelemetryPrefs>): TelemetryPrefs {
  const next = normalizeTelemetryPrefs({ ...getTelemetryPrefs(), ...patch })
  store.set('telemetry', next)
  return next
}

// ----- Performance HUD (schema v7; shared/perf.ts) -----
//
// The same read-through-the-normalizer / write-through-the-same-normalizer shape as every prefs
// blob above. It holds ONE switch, and it is the only persisted state the whole performance
// feature has: the live samples are a two-minute ring in renderer memory and the startup profile
// is a single disposable file (`<userData>/perf-startup.json`), neither of which belongs in a
// settings store that must load cleanly in every future build.

/** The performance-HUD prefs, defaulted. Never throws, never returns a partial. */
export function getPerfHudPrefs(): PerfHudPrefs {
  return normalizePerfHudPrefs(store.get('perfHud'))
}

/** Merge-patch the performance-HUD prefs; returns the stored (re-normalized) value. */
export function setPerfHudPrefs(patch: Partial<PerfHudPrefs>): PerfHudPrefs {
  const next = normalizePerfHudPrefs({ ...getPerfHudPrefs(), ...patch })
  store.set('perfHud', next)
  return next
}

// ----- Graphics compatibility (schema v11; shared/graphicsPrefs.ts) -----
//
// The same read-through-the-normalizer / write-through-the-same-normalizer shape as every prefs
// blob above, and it is read from an unusual place: `getGraphicsPrefs()` is called from the
// composition root's MODULE SCOPE, before Electron's `ready`, because `disableHardwareAcceleration`
// is only accepted there (src/main/graphics.ts). That is safe precisely because this file has
// already opened and migrated the store by the time any other module body runs — the same
// property `STORE_READY_MS` above is measuring.
//
// NOT part of the shared settings profile (src/main/share.ts), deliberately: these two switches
// describe THIS MACHINE's graphics driver, and importing a friend's workaround for a card you do
// not own is how a working install acquires someone else's bug.

/** The graphics prefs, defaulted. Never throws, never returns a partial. */
export function getGraphicsPrefs(): GraphicsPrefs {
  return normalizeGraphicsPrefs(store.get('graphics'))
}

/** Merge-patch the graphics prefs; returns the stored (re-normalized) value. */
export function setGraphicsPrefs(patch: Partial<GraphicsPrefs>): GraphicsPrefs {
  const next = normalizeGraphicsPrefs({ ...getGraphicsPrefs(), ...patch })
  store.set('graphics', next)
  return next
}

// ----- the buff externals allowlist (JOS-140; shared/buffTrust.ts) -----
//
// WHOSE casts may anchor a landing on your bars. Empty by default and empty for almost everybody:
// it exists so a player who duos with the same enchanter every night can see that enchanter's mez
// timers, and for nothing else. NO MIGRATION — an absent key normalizes to the empty list, which
// is exactly the shipped behaviour.
//
// It IS part of what a shared settings profile would carry, unlike the graphics switches: a
// friend's allowlist describes people, not a graphics driver, so importing one is at worst a list
// of names you then edit. (Nothing imports it today; stated so the next reader does not have to
// re-derive the argument.)

/** The buff-trust prefs, defaulted. Never throws, never returns a partial. */
export function getBuffTrustPrefs(): BuffTrustPrefs {
  return normalizeBuffTrustPrefs(store.get('buffTrust'))
}

/** Replace the allowlist; returns the stored (re-normalized) value. */
export function setBuffTrustPrefs(next: unknown): BuffTrustPrefs {
  const clean = normalizeBuffTrustPrefs(next)
  store.set('buffTrust', clean)
  return clean
}

// The RESPAWN watch list (JOS-194) is NOT here: it is `src/main/storeRespawn.ts`, the second
// module through the `settingsStore` door above (uiScale.ts was the first). This file was one
// addition away from the 400-code-line ceiling when that feature landed, and the ceiling's stated
// answer is a split rather than a widened threshold. The split module owes the same discipline
// every accessor here follows and pays it — read through `normalizeRespawnPrefs`, write back
// through the same one.

// ----- What's new (JOS-73; shared/releaseNotes.ts) -----
//
// ONE STRING, and it is the only durable state the whole feature has: which releases are marked,
// whether the teaser strip appears and what it names are all DERIVED from it by a pure function
// over the committed notes list (`whatsNewState`). Nothing here is a preferences blob, so there
// is no normalizer beside it — the shape is a version, and the setter is where that is enforced.

/** The newest release this install has been shown notes for, or null when it never has
 *  (a fresh install — see StoreShape.lastSeenNotesVersion for what that means). */
export function getLastSeenNotesVersion(): string | null {
  const v = store.get('lastSeenNotesVersion')
  return typeof v === 'string' && v.trim() !== '' ? v : null
}

/**
 * Stamp it, or CLEAR it with null — and clearing is not a tidy-up, it is the "pretend fresh
 * install" state the DEV variant control drives (JOS-73). Returns what is now stored, so no
 * caller has to assume its write landed.
 *
 * VALIDATED HERE because the renderer supplies the string (the `sounds:getData` rule): a plain
 * MAJOR.MINOR.PATCH, or nothing at all. A junk value would not be dangerous — `parseVersion`
 * reads anything unparseable as 0.0.0, so every release would simply look new — but a file this
 * app writes should only ever hold shapes this app can read.
 */
export function setLastSeenNotesVersion(version: string | null): string | null {
  if (version !== null && /^\d+\.\d+\.\d+$/.test(version)) store.set('lastSeenNotesVersion', version)
  else store.delete('lastSeenNotesVersion')
  return getLastSeenNotesVersion()
}
