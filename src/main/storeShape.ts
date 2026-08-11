// storeShape.ts — the PERSISTED SHAPE of the settings file, as one type.
//
// Split out of store.ts (JOS-140), which is at the 400-code-line factoring ceiling. Nothing moved
// but the declaration: store.ts still opens the file, migrates it and owns every accessor, and
// this is the contract those accessors are written against. Each field keeps the note saying when
// it arrived and what an ABSENT value means, because that is what a migration has to reason about.

import type { AlertDef, AlertPrefs, OverlayConfig, OverlayKind, ProgressState, UpdateChannel, VoicePrefs } from '../shared/types'
import type { CursorRingPrefs, OverlayAutoHidePrefs } from '../shared/presencePrefs'
import type { TelemetryPrefs } from '../shared/telemetry'
import type { PerfHudPrefs } from '../shared/perf'
import type { GraphicsPrefs } from '../shared/graphicsPrefs'
import type { BuffTrustPrefs } from '../shared/buffTrust'
import type { RespawnPrefs } from '../shared/respawn'
import type { WindowBounds } from './store'

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
   * Which mobs get a respawn clock, and the numbers the user typed for them (JOS-194;
   * shared/respawn.ts). ABSENT MEANS THE SHIPPED DEFAULT — auto-watch anything the committed wiki
   * floor states a duration for, with no explicit watches — so it is another additive optional key
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
