// storeShape.ts — the PERSISTED SHAPE of the settings file, as one type.
//
// Split out of store.ts (JOS-140), which is at the 400-code-line factoring ceiling. Nothing moved
// but the declaration: store.ts still opens the file, migrates it and owns every accessor, and
// this is the contract those accessors are written against. Each field keeps the note saying when
// it arrived and what an ABSENT value means, because that is what a migration has to reason about.

import type { AlertDef, AlertPrefs, OverlayConfig, OverlayKind, ProgressState, UpdateChannel, VoicePrefs } from '../shared/types'
import type { CursorRingPrefs, OverlayAutoHidePrefs } from '../shared/presencePrefs'
import type { OverlaySnapPrefs } from '../shared/overlaySnap'
import type { OverlayTextSizePrefs } from '../shared/overlayTextScale'
import type { OverlayBgAlphaPrefs } from '../shared/overlayBgAlpha'
import type { CloseToTrayPrefs } from '../shared/closeToTray'
import type { TelemetryPrefs } from '../shared/telemetry'
import type { PerfHudPrefs } from '../shared/perf'
import type { ProcessPriorityPrefs } from '../shared/processPriority'
import type { ResistPrefs } from '../shared/resistPrefs'
import type { GraphicsPrefs } from '../shared/graphicsPrefs'
import type { BuffTrustPrefs } from '../shared/buffTrust'
import type { BuffAllowPrefs } from '../shared/buffAllow'
import type { RespawnPrefs } from '../shared/respawn'
import type { SoundPackPrefs } from '../shared/soundPacks'
import type { WindowBounds } from './store'

/**
 * One character's tail position at the last clean shutdown (JOS-57 scope addition). `at` is a wall
 * clock and exists for the reader rather than for the measurement — it is what lets a support
 * answer say "that mark is from three weeks ago"; nothing derived from it is ever transmitted.
 */
export interface LogTailMark {
  /** Byte offset the live tailer had consumed to. */
  offset: number
  /** When it was written, epoch ms. */
  at: number
}

export interface StoreShape {
  /**
   * Schema version of THIS file (src/main/storeMigrations.ts). Absent ⇒ pre-framework ⇒ 1.
   * Every persisted-shape change bumps CURRENT_SCHEMA_VERSION and ships a migration in the
   * same commit — that is the whole contract behind "upgrades are clean, indefinitely".
   */
  schemaVersion?: number
  /** progress keyed by character id (name_server) */
  byCharacter: Record<string, ProgressState>
  /** last selected character's log path */
  activeLogPath?: string
  /**
   * Manual EQ install-dir override (Settings gear). When set + non-empty it wins
   * over auto-discovery; cleared/undefined ⇒ the app auto-detects the install.
   * See src/main/log/config.ts `resolveEqDir`.
   */
  eqInstallDir?: string
  /**
   * The install root a PREVIOUS launch's auto-discovery resolved (JOS-112), cached so subsequent
   * launches skip the ~150 ms (and config-dependently much longer) registry + drive sweep. It is
   * DISTINCT from `eqInstallDir`: the latter is the user's authoritative manual override, this is
   * only a remembered auto-detection. Precedence in config.ts `resolveEqDir`/`discoverOnce`:
   * override → this (if it still passes `rootHasLogs`) → run the sweep.
   *
   * ONLY a POSITIVE discovery is ever written here — a "not found" is never persisted, so a fresh
   * user who has not run `/log on` keeps getting the cheap idle rescan rather than a sticky
   * negative. A value that fails revalidation is dropped and re-discovered (self-heal), and it is
   * cleared outright when the manual override changes (`invalidateEqDiscovery`).
   *
   * ADDITIVE + OPTIONAL ⇒ no schema bump, no migration — the `lastSeenNotesVersion` precedent
   * above. Every reader defaults on a missing key, so an older build loads a store that has it
   * unchanged and vice versa.
   */
  eqDiscoveredRoot?: string
  /**
   * WHERE THE TAIL HAD READ TO WHEN THIS APP LAST SHUT DOWN CLEANLY, per character (JOS-57 scope
   * addition). The next launch subtracts it from the log's size to learn how many bytes it had to
   * read COLD — the discriminator the fleet's startup reading was missing, because every other
   * number it carries scales with the whole log rather than with the part nobody has read yet.
   *
   * ONLY A CLEAN SHUTDOWN WRITES ONE (`stopSession`), which is the honest half of the design: a
   * crash leaves the previous launch's mark, so the delta it produces is "since we last got out
   * cleanly" rather than "since last launch", and the reading is dropped altogether when the log
   * has shrunk under the mark (a rotation) rather than reported as a smaller number.
   *
   * ADDITIVE + OPTIONAL ⇒ no schema bump, no migration — the `eqDiscoveredRoot` precedent above.
   * It is also DISPOSABLE: every reader treats an absent or stale entry as "unknown", so the key
   * can be deleted by hand at any time and the only consequence is one unmeasured launch.
   */
  logTailMarks?: Record<string, LogTailMark>
  /** last window position + size */
  windowBounds?: WindowBounds
  /** alerts extension: the user's alert definitions (Task #18) */
  alerts?: AlertDef[]
  /** alerts extension: global sound preferences */
  alertPrefs?: AlertPrefs
  /**
   * Version stamp of the retired-pack → shipped-pack alert sound migration
   * (Task #57). Absent ⇒ never migrated; see migrateStoredAlertSounds().
   */
  alertSoundMigration?: number
  /**
   * Version stamp of the shipped-alert-def TRIGGER migration (src/main/data/
   * alertDefMigrations.ts) — today, the rogue-slow def gaining the second slow effect and a
   * per-mob cooldown. Absent ⇒ never migrated; see migrateStoredAlertTriggers().
   */
  alertTriggerMigration?: number
  /**
   * WHICH SOUND PACK IS YOURS, AND WHICH SHIPPED ONES YOU THREW AWAY (JOS-273;
   * shared/soundPacks.ts). Two keys, both absent for almost everybody: the default-pack
   * PREFERENCE every picker pre-selects and every authored alert points at, and the TOMBSTONES
   * that stop startup provisioning putting a deleted shipped pack back.
   *
   * ABSENT MEANS THE SHIPPED BEHAVIOUR — the app's own default pack, and provisioning as it has
   * always worked — so it is another additive optional key on the carve-out above: no schema
   * bump, no migration, `normalizeSoundPackPrefs` defaults every field, and a fresh install is
   * unaffected by the whole feature (which is exactly what the owner's ruling asked for).
   */
  soundPacks?: SoundPackPrefs
  /** auto-update release channel (Task #27): 'main' (bleeding edge) | 'stable' */
  updateChannel?: UpdateChannel
  /**
   * Epoch millis of the last COMPLETED update check (Task #60). Persisted so the
   * left-nav "checked 2h ago" line is TRUTHFUL after a relaunch instead of
   * resetting to "never" — with a 4h cadence, an in-memory-only stamp would read
   * "never" for the first minute of every single launch.
   */
  updateLastCheckedAt?: number
  /**
   * RETIRED flat overlay config (Task #52). Task #54 made the overlay per-kind; schema
   * migration 1→2 folds this into `overlays.fight` and deletes it. Declared, never read —
   * the name stays reserved so nothing reuses it with different meaning.
   */
  overlay?: OverlayConfig
  /** per-kind floating overlay configs (Task #54): 'fight' + 'overall' windows. */
  overlays?: Partial<Record<OverlayKind, OverlayConfig>>
  /**
   * Voice alerts / TTS preferences (docs/plans/voice-alerts.md §2). Written by schema
   * migration 3→4, so a v4 store always has it; the reader still defaults, because a
   * downgrade-then-upgrade can leave any key in any state.
   */
  voice?: VoicePrefs
  /**
   * The opt-in cursor ring (schema migration 4→5). Off by default — see shared/presencePrefs.ts.
   */
  cursorRing?: CursorRingPrefs
  /**
   * Overlay auto-hide (schema migration 4→5): hide the floating overlays when EverQuest is not
   * running / not focused. Two independent switches, defaults {true, false}.
   */
  overlayAutoHide?: OverlayAutoHidePrefs
  /**
   * OVERLAY SNAPPING (JOS-217; shared/overlaySnap.ts) — magnetize an overlay drag to the other
   * windows and the screen edges. ABSENT MEANS OFF, which is exactly how every build before this
   * one dragged, so it is another additive optional key on the carve-out above: no schema bump, no
   * migration, `normalizeOverlaySnap` defaults every field. The accessors live in
   * `storeOverlaySnap.ts` because store.ts is at the 400-code-line ceiling.
   */
  overlaySnap?: OverlaySnapPrefs
  /**
   * THE OVERLAYS' TEXT SIZE, as a preference rather than twelve copies of one number (JOS-405;
   * shared/overlayTextScale.ts). `{ shared, independent }`, defaulting to `{ 1, false }`.
   *
   * ABSENT DOES NOT MEAN THE DEFAULT HERE, and it is the one key on this list of which that is
   * true: `storeOverlayTextSize.ts` DERIVES the shared size from the twelve equal
   * `overlays.<kind>.textScale` values every install through 1.4.0 holds, and writes it back on
   * the first read. That is a migration in everything but the schema number — it needs no bump
   * because it reads and writes only additive optional keys, and because a build that predates it
   * opens a store it wrote without noticing (the per-kind fields it still reads are all there,
   * untouched). The accessors live in their own file because store.ts is at the 400-code-line
   * ceiling.
   */
  overlayTextSize?: OverlayTextSizePrefs
  /**
   * THE OVERLAYS' BACKGROUND TRANSPARENCY, as a preference rather than twelve unrelated numbers
   * (JOS-407; shared/overlayBgAlpha.ts). `{ shared, independent }`, defaulting to `{ 0.72, false }`.
   *
   * ABSENT DOES NOT MEAN THE DEFAULT HERE either — `storeOverlayBgAlpha.ts` DERIVES both halves
   * from the twelve `overlays.<kind>.bgAlpha` values the store already holds and writes the answer
   * back on the first read. Where the text size's derivation could assume twelve EQUAL values (its
   * setter fanned every press out), this field never had a fan-out, so the derivation decides the
   * MODE as well: all equal ⇒ synced at that value, any different ⇒ independent, and either way
   * nothing on screen moves. It needs no schema bump for its twin's reason: it reads and writes
   * only additive optional keys, and a build that predates it opens a store it wrote without
   * noticing. The accessors live in their own file because store.ts is at the 400-code-line ceiling.
   */
  overlayBgAlpha?: OverlayBgAlphaPrefs
  /**
   * WHAT THE X ON THE MAIN WINDOW DOES, and whether this install has been told (JOS-139;
   * shared/closeToTray.ts). `{ enabled, noticeAcknowledged }`, defaulting to `{ false, false }` (OFF since the owner's same-day reversal, 2026-08-16).
   *
   * ABSENT MEANS THE SHIPPED BEHAVIOUR OF THE FEATURE — the X hides to the tray, and the one-time
   * card has not been acknowledged — so it is another additive optional key on the carve-out
   * above: no schema bump, no migration, `normalizeCloseToTray` defaults every field. It is the
   * one key on that list whose default is ON rather than off; `storeCloseToTray.ts`'s header says
   * why that does not make it `processPriority` (which took a migration for exactly the reason
   * this key does not need one: nothing here ever has to tell a stored default from an inherited
   * one). The accessors live in `storeCloseToTray.ts` because store.ts is at the 400-code-line
   * ceiling.
   */
  closeToTray?: CloseToTrayPrefs
  // `eqExclusiveNoticeDismissedVersion` (JOS-368) LIVED HERE and was removed by JOS-375 with the
  // note it remembered — the game's Fullscreen setting is a borderless window on this client, so
  // the advice could never be true. Migration 12 → 13 deletes the key from any store that has it.
  /**
   * Usage-analytics prefs (schema migration 5→6; docs/plans/usage-analytics.md). Opt-OUT
   * (`enabled:true`) but `noticeShown:false` — the network gate requires BOTH — and no
   * `analyticsId` until the collector mints one on its first start.
   */
  telemetry?: TelemetryPrefs
  /**
   * The performance HUD switch (schema migration 6→7; docs/plans/perf-profiling.md). OFF by
   * default — an enabled HUD is the only thing that creates the metrics poll and the lag probe.
   */
  perfHud?: PerfHudPrefs
  /**
   * "Yield CPU to the game" (schema migration 11→12; JOS-366, shared/processPriority.ts). ON by
   * default, and a MIGRATION rather than the additive-optional carve-out precisely because the
   * default is on: every reader defaults to `true` anyway, but a v12 store is a promise that the
   * key is present and complete, which is what lets a future step reason about whether a stored
   * `false` was a person's decision or yesterday's default written down (the 8→9 / 10→11 lesson).
   */
  processPriority?: ProcessPriorityPrefs
  /**
   * WHICH CASTERS TEACH THE RESIST PROFILES (schema migration 13→14; JOS-385,
   * shared/resistPrefs.ts). `{ includeNpcCasters: true }` — charmed pets and NPC casters count as
   * evidence about the creature they were cast on, and the switch is read when a card is drawn
   * rather than when a log is folded, so flipping it never costs a re-fold.
   *
   * A MIGRATION rather than the additive-optional carve-out, for the `processPriority` reason
   * exactly: the default is ON, so "absent" and "stored false" are opposite answers and a v14
   * store says which one it holds.
   */
  resists?: ResistPrefs
  /**
   * Graphics compatibility (schema migrations 9→10 and 10→11; JOS-40, JOS-31). Both switches
   * default to 'auto' — see shared/graphicsPrefs.ts for why a compatibility switch that ships ON
   * is not one, and why `auto` is nevertheless not the same thing as `off`.
   */
  graphics?: GraphicsPrefs
  /**
   * WHOSE casts, besides your own, may anchor a buff or debuff bar (JOS-140;
   * shared/buffTrust.ts). ABSENT MEANS THE SHIPPED BEHAVIOUR — you and nobody else — so it is an
   * additive optional key with NO schema bump and NO migration, on the `lastSeenNotesVersion`
   * carve-out this file already documents: every reader defaults on a missing key, so a store
   * written by an older build loads here unchanged and one written here still opens in a build
   * that predates the feature.
   */
  buffTrust?: BuffTrustPrefs
  /**
   * WHICH buffs and debuffs the two timer overlay windows may draw (JOS-168;
   * shared/buffAllow.ts): the opt-in mode switch, and the per-spell-line tri-state behind it.
   *
   * ABSENT MEANS THE SHIPPED BEHAVIOUR — default mode, no verdicts, every spell drawn — so it is
   * another additive optional key on the `buffTrust` carve-out directly above: no schema bump and
   * no migration, because `normalizeBuffAllowPrefs` reads a missing key as exactly the behaviour
   * every build before this one had. A store written here still opens in a build that predates the
   * feature (electron-store rewrites the whole parsed object, so the key round-trips untouched).
   */
  buffAllow?: BuffAllowPrefs
  /**
   * Which mobs get a respawn clock, and the numbers the user typed for them (JOS-194;
   * shared/respawn.ts). ABSENT MEANS THE SHIPPED DEFAULT — no watches at all, because tracking is
   * opt-in per mob and nothing clocks a mob you did not ask for — so it is another additive key
   * on the carve-out above: no schema bump, no migration, and `normalizeRespawnPrefs` defaults
   * every field, so an older build reading a store written here is unaffected and vice versa.
   */
  respawn?: RespawnPrefs
  /**
   * The newest release whose notes this install has been SHOWN (JOS-73; shared/releaseNotes.ts).
   *
   * ABSENT MEANS FRESH INSTALL, and that is the whole reason it is an optional key rather than a
   * defaulted one: a person who installed twenty minutes ago has no news, so the teaser strip
   * stays away and nothing is marked new. Everything above this value is "new" — which is what
   * makes a 0.6.3 → 0.8.0 jump mark TWO releases without anybody bookkeeping per release.
   *
   * ADDITIVE + OPTIONAL ⇒ no schema bump, no migration — the `exaltPlans` / `rosterEdits`
   * precedent above. Every reader defaults on a missing key and electron-store rewrites the
   * whole parsed object, so a store written by an older build loads unchanged and one written
   * here still opens in a build that predates the feature.
   */
  lastSeenNotesVersion?: string
  /**
   * The MAIN window's zoom factor (JOS-123; shared/uiScale.ts) — the "text size" control in
   * Preferences. A factor, not a percentage: 1.25 is what the card labels "125%".
   *
   * ONE NUMBER RATHER THAN A PREFS BLOB, unlike the four objects above it, because the feature
   * genuinely has one field and a blob would be inventing a shape to match a convention. The
   * normalizer beside it (`normalizeUiScale`) is what the blobs' normalizers are for.
   *
   * ADDITIVE + OPTIONAL ⇒ no schema bump, no migration — the `lastSeenNotesVersion` /
   * `eqDiscoveredRoot` precedent. Absent reads as 1, which is the size every store written
   * before this key existed was already being drawn at, so an upgrade changes nothing for
   * anybody who has not asked it to.
   *
   * NOT part of the shared settings profile (src/main/share.ts), for the same reason `graphics`
   * is not: it describes the screen someone is sitting in front of and the eyes reading it, and
   * importing a friend's answer to that is not a setting anyone wanted.
   */
  uiScale?: number
}
