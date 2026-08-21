// prefsSnapshot.ts — WHAT THE PREFERENCES PANE KNOWS, AND HOW IT LEARNS IT (JOS-340).
//
// The DOM-free half of the pane's hydration. ./prefsHydration.tsx is the React half — the gate,
// the context and the seed hook — and it re-exports everything here, so a card imports one module
// and never has to care which side of the line a symbol lives on. The split is combatPrefs.ts /
// useCombatPrefs.ts's exactly: the vocabulary goes somewhere a node test can reach it, and the
// storage half keeps the browser.
//
// WHAT THE CACHE IS FOR. The gate makes the pane wait for one batched read. That would be a wait
// on EVERY mount — and the section rail is a switcher, so a user pays it on every rail click — if
// the answer were not kept. It is kept for the renderer's life, so the gate is cold exactly once
// and every later mount seeds synchronously from memory. Read ./prefsHydration.tsx's header for
// why this is a gate at all rather than a synchronous preload snapshot.
//
// AND IT IS KEPT CURRENT BY THE WRITES, WHICH IS THE HALF A PRELOAD SNAPSHOT COULD NOT DO. Every
// card takes main's REPLY as authoritative (the handlers re-clamp through the shared normalizers)
// and hands that same value to `recordPref`. So the cache holds what is on disk, and a remount
// after a change seeds from the change rather than from what the pane loaded minutes ago.

// The one value import here is deliberately RELATIVE, not `@shared/*` — repo law for a module
// that has to load under a plain node test (the mobSearch.ts precedent). Type-only imports may
// keep the alias, and do.
import { normalizeUiScale } from '../../../../shared/uiScale'
import { normalizeAlertBannerConfig } from '../../../../shared/alertBanner'
import { normalizeConCardConfig } from '../../../../shared/conCard'
import type { AlertBannerOverlayConfig } from '@shared/alertBanner'
import type { ConCardOverlayConfig } from '@shared/conCard'
import type { BuffTrustPrefs } from '@shared/buffTrust'
import type { GraphicsPrefs } from '@shared/graphicsPrefs'
import type { GraphicsEnvironment } from '@shared/wineDetect'
import type { CursorRingPrefs, OverlayAutoHidePrefs } from '@shared/presencePrefs'
import type { OverlaySnapPrefs } from '@shared/overlaySnap'
import type { CloseToTrayPrefs } from '@shared/closeToTray'
import type { PerfHudPrefs, StartupProfile } from '@shared/perf'
import type { ProcessPriorityPrefs } from '@shared/processPriority'
import type { ResistPrefs } from '@shared/resistPrefs'
import type { TelemetryPayloadView } from '@shared/telemetry'
import type { AlertDef, EqConfig, OverlayConfig, OverlayKind, UpdateStatus, VoicePrefs } from '@shared/types'

/** The toast overlay's two facts, which come from two different reads and are one control pair. */
export interface ToastSeed {
  open: boolean
  locked: boolean
}

/**
 * The alert banner's three facts (JOS-378): open-state and lock, exactly the toast's pair, plus the
 * knobs blob (hold, lines). Read together for the reason the toast's are: the card is one control
 * group and a frame where the switch was right and the hold was still the default is the same
 * defect on a smaller control.
 */
export interface AlertBannerSeed {
  open: boolean
  locked: boolean
  cfg: AlertBannerOverlayConfig
}

/**
 * The con card's three facts (JOS-383), the same shape one kind over. It matters MORE here than it
 * does for the banner: this kind ships ON, so a card that mounted on a shipped default would paint
 * the switch correctly for a fresh install and wrongly for the only people who have ever touched it
 * — the ones who turned it off.
 */
export interface ConCardSeed {
  open: boolean
  locked: boolean
  cfg: ConCardOverlayConfig
}

/**
 * EVERYTHING THE PREFERENCES PANE PAINTS FROM MAIN, in one object.
 *
 * The membership rule is deliberately wider than "things with a Switch on them": a caption that
 * states a count ("Export ... 12 alerts"), a version number, and the startup breakdown's "nothing
 * recorded yet" are all sentences that would be WRONG for a frame under the old shape, and a
 * sentence that is wrong for a frame is the same defect wearing different clothes. What is left
 * out is only what does not come from main at all — the Combat section's two cards read
 * localStorage, which is synchronous and never had this bug.
 */
export interface PrefsSnapshot {
  /** Game — the resolved EQ install folder, how it resolved, and the character-log count. */
  eqConfig: EqConfig
  /** Text size — the stored stop, already snapped to the ladder. */
  uiScale: number
  /** Graphics — the three-state prefs and the machine they are resolved against. */
  graphics: GraphicsPrefs
  graphicsEnv: GraphicsEnvironment
  /** Overlays — the two auto-hide switches. */
  overlayAutoHide: OverlayAutoHidePrefs
  /** Overlays — the opt-in drag magnetism (JOS-217). */
  overlaySnap: OverlaySnapPrefs
  /** Window — what the X does (JOS-139). OFF by default (owner reversal, 2026-08-16), and it has
   *  TWO other controls (the tray menu's checkbox and the title bar's overlay-menu row), so this
   *  entry is kept current by main's pushes as well as by the card's own writes — see App.tsx. */
  closeToTray: CloseToTrayPrefs
  /** Overlays — the celebration toast's open-state and its lock. */
  toast: ToastSeed
  /** Overlays — the alert banner's open-state, lock and knobs. It ships OFF, which is exactly the
   *  argument its card once used for mounting on defaults — and exactly wrong for anyone who has
   *  turned it on: their switch was born OFF and rose (owner, hands-on, 2026-08-16). */
  alertBanner: AlertBannerSeed
  /** Overlays — the con card's open-state, lock and auto-hide. It ships ON, which is why it is
   *  here rather than mounting on a default: the only stored answer that differs from the shipped
   *  one is somebody having switched it OFF, and that is the one the switch must not get wrong. */
  conCard: ConCardSeed
  /** Buff trust — the external-caster allowlist. */
  buffTrust: BuffTrustPrefs
  /** Cursor ring — the switch, the two sliders and the colour. */
  cursorRing: CursorRingPrefs
  /** Voice — engine, voice, speed, volume. */
  voice: VoicePrefs
  /** Usage analytics — the switch, the id, and the payload viewer, all in one read. */
  telemetry: TelemetryPayloadView
  /** Performance — the HUD switch and this launch's startup breakdown. */
  perfHud: PerfHudPrefs
  startup: StartupProfile
  /** Performance — "yield CPU to the game" (JOS-366). ON by default, which is exactly why it has
   *  to come through the gate: a switch whose default is `true` flashing OFF is the JOS-340
   *  defect wearing its loudest clothes. */
  processPriority: ProcessPriorityPrefs
  /** Combat — which casters teach the resist profiles (JOS-385). ON by default, so it is here for
   *  the `processPriority` reason: a switch whose default is `true` flashing OFF is this gate's
   *  own defect. */
  resists: ResistPrefs
  /** Updates — the version row and the status chip's starting value (pushes follow). */
  version: string
  updateStatus: UpdateStatus
  /** Profiles — how many alerts an export would carry. */
  alertCount: number
}

/**
 * The slice of the `window.eq` bridge this module reads.
 *
 * Spelled out as an interface rather than taken as `typeof window.eq` so the module never touches
 * a browser global: the React half passes the real bridge in, and a test passes a stub. It is a
 * READ-ONLY surface on purpose — nothing in here may write, which is also what keeps this change
 * clear of the store-file hazards in AGENTS.md.
 */
export interface PrefsReader {
  getEqConfig: () => Promise<EqConfig>
  getUiScale: () => Promise<number>
  getGraphicsPrefs: () => Promise<GraphicsPrefs>
  getGraphicsEnvironment: () => Promise<GraphicsEnvironment>
  getOverlayAutoHide: () => Promise<OverlayAutoHidePrefs>
  getOverlaySnap: () => Promise<OverlaySnapPrefs>
  getCloseToTray: () => Promise<CloseToTrayPrefs>
  getOverlayState: () => Promise<Record<OverlayKind, boolean>>
  getToastConfig: () => Promise<OverlayConfig>
  getAlertBannerConfig: () => Promise<OverlayConfig>
  getConCardConfig: () => Promise<OverlayConfig>
  getBuffTrust: () => Promise<BuffTrustPrefs>
  getCursorRing: () => Promise<CursorRingPrefs>
  getVoicePrefs: () => Promise<VoicePrefs>
  getTelemetryPayload: () => Promise<TelemetryPayloadView>
  getPerfPrefs: () => Promise<PerfHudPrefs>
  getStartupProfile: () => Promise<StartupProfile>
  getProcessPriority: () => Promise<ProcessPriorityPrefs>
  getResistPrefs: () => Promise<ResistPrefs>
  getAppVersion: () => Promise<string>
  getUpdateStatus: () => Promise<UpdateStatus>
  listAlerts: () => Promise<AlertDef[]>
}

/**
 * Read the whole pane's worth of main-side state in ONE parallel batch.
 *
 * `Promise.all` rather than a sequence of awaits: these are independent store reads and the gate's
 * cost is the SLOWEST of them, not their sum. It is also the shape that attaches a rejection
 * handler to every promise immediately, so a single failing handler cannot surface as an unhandled
 * rejection while the batch waits on its siblings.
 */
export async function readPrefsSnapshot(eq: PrefsReader): Promise<PrefsSnapshot> {
  const [
    eqConfig,
    uiScale,
    graphics,
    graphicsEnv,
    overlayAutoHide,
    overlaySnap,
    closeToTray,
    overlayState,
    toastConfig,
    bannerConfig,
    conCardConfig,
    buffTrust,
    cursorRing,
    voice,
    telemetry,
    perfHud,
    startup,
    processPriority,
    resists,
    version,
    updateStatus,
    alerts
  ] = await Promise.all([
    eq.getEqConfig(),
    eq.getUiScale(),
    eq.getGraphicsPrefs(),
    eq.getGraphicsEnvironment(),
    eq.getOverlayAutoHide(),
    eq.getOverlaySnap(),
    eq.getCloseToTray(),
    eq.getOverlayState(),
    eq.getToastConfig(),
    eq.getAlertBannerConfig(),
    eq.getConCardConfig(),
    eq.getBuffTrust(),
    eq.getCursorRing(),
    eq.getVoicePrefs(),
    eq.getTelemetryPayload(),
    eq.getPerfPrefs(),
    eq.getStartupProfile(),
    eq.getProcessPriority(),
    eq.getResistPrefs(),
    eq.getAppVersion(),
    eq.getUpdateStatus(),
    eq.listAlerts()
  ])
  return {
    eqConfig,
    // Snapped here rather than in the card, so the cache can never hold an off-ladder number.
    uiScale: normalizeUiScale(uiScale),
    graphics,
    graphicsEnv,
    overlayAutoHide,
    overlaySnap,
    closeToTray,
    toast: { open: overlayState.toast, locked: toastConfig.locked },
    // The knobs go through the same normalizer main's store reads with, so the cache can never
    // hold an out-of-range hold or line count (the `uiScale` argument, on a different blob).
    alertBanner: {
      open: overlayState.alertBanner,
      locked: bannerConfig.locked,
      cfg: normalizeAlertBannerConfig(bannerConfig.alertBanner)
    },
    conCard: {
      open: overlayState.conCard,
      locked: conCardConfig.locked,
      cfg: normalizeConCardConfig(conCardConfig.conCard)
    },
    buffTrust,
    cursorRing,
    voice,
    telemetry,
    perfHud,
    startup,
    processPriority,
    resists,
    version,
    updateStatus,
    alertCount: alerts.length
  }
}

// ---------------------------------------------------------------- the module-level cache

/** The warm copy. `null` only before the first successful read of this renderer's life. */
let cache: PrefsSnapshot | null = null

/** The read in flight, so two mounts in one frame cannot fire two batches. */
let inflight: Promise<PrefsSnapshot> | null = null

/** The snapshot if this renderer already has one — the whole reason a rail click is instant. */
export function peekPrefsSnapshot(): PrefsSnapshot | null {
  return cache
}

/**
 * Load it once.
 *
 * Concurrent callers share the one batch. A FAILURE CLEARS THE FLIGHT rather than caching the
 * rejection: a settled failed promise kept here would make one bad moment permanent for the whole
 * session, and the honest behaviour is that the next mount gets to try again.
 */
export function loadPrefsSnapshot(eq: PrefsReader): Promise<PrefsSnapshot> {
  if (cache !== null) return Promise.resolve(cache)
  inflight ??= readPrefsSnapshot(eq).then(
    (snap) => {
      cache = snap
      inflight = null
      return snap
    },
    (err: unknown) => {
      inflight = null
      throw err
    }
  )
  return inflight
}

/**
 * Adopt what main said it actually stored.
 *
 * A no-op before the first load, because there is nothing yet to keep current — and because a
 * partial cache assembled out of write replies would be a snapshot that had never been read,
 * which is the one thing the gate must not be handed.
 */
export function recordPref<K extends keyof PrefsSnapshot>(key: K, value: PrefsSnapshot[K]): void {
  if (cache === null) return
  const next: PrefsSnapshot = { ...cache }
  next[key] = value
  cache = next
}

/** TEST SEAM ONLY: forget the warm copy, so a test can watch the cold path more than once. */
export function resetPrefsSnapshotForTests(): void {
  cache = null
  inflight = null
}
