import { contextBridge, ipcRenderer } from 'electron'
import { IPC } from '../shared/ipc'
import type { CombatSnapshot, SnapshotOpts } from '../shared/combat'
import type {
  AppFocus,
  CharacterRef,
  ItemKnowledge,
  MobKnowledge,
  ModuleDelta,
  ModuleSnapshot,
  OverlayConfig,
  OverlayDrill,
  OverlayKind
} from '../shared/types'
import { OVERLAY_KINDS } from '../shared/types'
import type { ScopeSelection } from '../shared/scopeSelection'
import type { ToastPayload } from '../shared/toast'
import type { AlertBannerPayload } from '../shared/alertBanner'

export type { CombatSnapshot, SnapshotOpts, OverlayConfig, OverlayDrill, OverlayKind, MobKnowledge }

/**
 * Minimal preload for a floating overlay DPS-meter window (Task #52; per-kind in Task #54).
 *
 * Deliberately NOT the full `window.eq` bridge — an overlay only needs to READ the combat
 * snapshot (reusing the same `combat:snapshot` transport the main app uses) and drive its own
 * window (click-through, close, config persistence). A lean surface keeps the overlay window's
 * blast radius small. Exposed as `window.eqOverlay`.
 *
 * KIND: each overlay window is launched with a `?kind=<OverlayKind>` query so one overlay.html
 * bundle serves every window. The preload reads it here and threads it into every kind-scoped
 * IPC call so the renderer never has to; `window.eqOverlay.kind` is also exposed for the UI.
 * Validated against OVERLAY_KINDS so an unknown/absent query can only ever fall back to 'fight'
 * (never leak a bogus kind into the store's per-kind config).
 */
function readKind(): OverlayKind {
  try {
    const k = new URLSearchParams(window.location.search).get('kind')
    if (k && (OVERLAY_KINDS as string[]).includes(k)) return k as OverlayKind
    return 'fight'
  } catch {
    return 'fight'
  }
}
const KIND: OverlayKind = readKind()

const overlayApi = {
  /** This overlay window's kind ('fight' | 'overall' | 'events'). */
  kind: KIND,
  /** Fetch a fresh combat snapshot (same engine + IPC the main app polls). */
  getCombatSnapshot: (opts: SnapshotOpts): Promise<CombatSnapshot> =>
    ipcRenderer.invoke(IPC.getCombatSnapshot, opts),
  /** Subscribe to the throttled combat-activity nudge for sub-second updates. */
  onCombatActivity: (cb: () => void): (() => void) => {
    const listener = (): void => cb()
    ipcRenderer.on(IPC.onCombatActivity, listener)
    return () => ipcRenderer.removeListener(IPC.onCombatActivity, listener)
  },

  // ---- module transport (Task #59: the 'events' overlay reads the eventFeed module) ----
  // The SAME hydrate-then-ride-deltas transport the main app uses, exposed here so an overlay
  // window can consume a module directly instead of inventing a second channel.
  /** Hydrate a module's full state (`module:getSnapshot`). Null when the id is unknown. */
  getModuleSnapshot: <S>(id: string): Promise<ModuleSnapshot<S> | null> =>
    ipcRenderer.invoke(IPC.getModuleSnapshot, id),
  /** Subscribe to `module:delta` pushes (all modules; the caller filters by moduleId). */
  onModuleDelta: <D>(cb: (d: ModuleDelta<D>) => void): (() => void) => {
    const listener = (_e: unknown, d: ModuleDelta<D>): void => cb(d)
    ipcRenderer.on(IPC.onModuleDelta, listener)
    return () => ipcRenderer.removeListener(IPC.onModuleDelta, listener)
  },
  /**
   * THE OTHER HALF OF THAT TRANSPORT (JOS-172): "the world for this character was rebuilt in
   * main — everything you hold is stale, ask again."
   *
   * The SAME member, under the SAME name and on the SAME channel as the main app's bridge
   * (preload/index.ts), for the reason the fight-selection trio below is duplicated: an overlay
   * that folds a module has exactly the main window's problem, and a second name for one signal
   * is how the two windows end up disagreeing about what the world is. Deltas alone cannot carry
   * a REBUILD — the registry discards what a historical fold accumulated (main/modules/registry.ts),
   * so a window that hydrated mid-fold rides increments that describe none of it.
   */
  onCharacter: (cb: (c: CharacterRef | null) => void): (() => void) => {
    const listener = (_e: unknown, c: CharacterRef | null): void => cb(c)
    ipcRenderer.on(IPC.onCharacter, listener)
    return () => ipcRenderer.removeListener(IPC.onCharacter, listener)
  },
  /** Item knowledge for the feed's hover card — cache-first in main, never rejects. */
  lookupItem: (name: string): Promise<ItemKnowledge> => ipcRenderer.invoke(IPC.itemsLookup, name),
  /** Mob knowledge for a CONSIDER row's hover card (Task #63) — same cache-first door. */
  lookupMob: (name: string): Promise<MobKnowledge> => ipcRenderer.invoke(IPC.mobsLookup, name),

  /**
   * Read this kind's persisted overlay config (locked / bgAlpha / text scale / bounds / drill).
   * The overlay hydrates from this on mount — including the mini drill-down, so a meter that
   * was left drilled into an entity comes back drilled after a restart.
   */
  getConfig: (): Promise<OverlayConfig> => ipcRenderer.invoke(IPC.overlayGetConfig, KIND),
  /**
   * Persist a partial config for this kind; returns the merged value. Same path for every
   * remembered field: alpha/text scale/lock from the footer controls, bounds from main, and the
   * drill-down (rare, so written immediately rather than debounced).
   */
  setConfig: (patch: Partial<OverlayConfig>): Promise<OverlayConfig> =>
    ipcRenderer.invoke(IPC.overlaySetConfig, KIND, patch),
  /** Subscribe to config changes pushed from main; ignores pushes for the other kind. */
  onConfig: (cb: (c: OverlayConfig) => void): (() => void) => {
    const listener = (_e: unknown, payload: { kind: OverlayKind; config: OverlayConfig }): void => {
      if (payload?.kind === KIND) cb(payload.config)
    }
    ipcRenderer.on(IPC.onOverlayConfig, listener)
    return () => ipcRenderer.removeListener(IPC.onOverlayConfig, listener)
  },

  // ---- global fight selection (docs/plans/combat-overlay-parity.md P4) ----
  // THE SAME THREE MEMBERS, UNDER THE SAME NAMES, as the main app's bridge (preload/windows.ts).
  // That is not a coincidence to be tidied away later: it is what lets ONE renderer hook
  // (`useGlobalFight`) drive the Combat tab's picker and both fight overlays' selectors from one
  // implementation, the way `petRows.meterPanel` is one row builder for both meters. The identity
  // is pinned by tests/fightSelection.test.mts.
  //
  // NOT for a zone-session selector: the 'overall' / 'heal-overall' kinds keep their own
  // per-overlay selection and must never call these (the ruling's explicit carve-out).
  /** The currently selected fight ('__live__' or an 'e<n>' encounter id). */
  getFightSelection: (): Promise<string> => ipcRenderer.invoke(IPC.fightSelectionGet),
  /** "The user picked this fight." Fire-and-forget; main validates and fans out. */
  setFightSelection: (id: string): void => ipcRenderer.send(IPC.fightSelectionSet, id),
  /** Subscribe to selection changes made anywhere in the app. Payload {fightId}. */
  onFightSelection: (cb: (s: { fightId: string }) => void): (() => void) => {
    const listener = (_e: unknown, s: { fightId: string }): void => cb(s)
    ipcRenderer.on(IPC.onFightSelection, listener)
    return () => ipcRenderer.removeListener(IPC.onFightSelection, listener)
  },

  // ---- the app-wide SCOPE selection (JOS-332) ----
  // THE SAME THREE MEMBERS, UNDER THE SAME NAMES, as the main app's bridge (preload/windows.ts) —
  // the fight-selection trio's arrangement, applied to the second cross-window fact. That
  // structural identity is what lets ONE renderer hook (`useScopeSelection`) drive the Leveling
  // tab's tier/basis row and this window's footer buttons, and it is what the owner's report was
  // about: `elapsed 27m` on the tab under a *this tier* the tab had never been told about.
  //
  // NOT the slice: `xpSlice` stays this window's own persisted business (shared/types.ts).
  /** The membership + denominator in force everywhere. */
  getScopeSelection: (): Promise<ScopeSelection> => ipcRenderer.invoke(IPC.scopeSelectionGet),
  /** "The user moved one of these knobs." A PARTIAL — the half you do not mention does not move. */
  setScopeSelection: (patch: Partial<ScopeSelection>): void => ipcRenderer.send(IPC.scopeSelectionSet, patch),
  /** Subscribe to scope changes made in ANY window. Payload is the whole selection. */
  onScopeSelection: (cb: (s: ScopeSelection) => void): (() => void) => {
    const listener = (_e: unknown, s: ScopeSelection): void => cb(s)
    ipcRenderer.on(IPC.onScopeSelection, listener)
    return () => ipcRenderer.removeListener(IPC.onScopeSelection, listener)
  },

  /** Set locked (click-through) vs interactive for this kind. Persisted + applied to the window. */
  setLocked: (locked: boolean): void => ipcRenderer.send(IPC.overlaySetLocked, KIND, locked),
  /**
   * Fine-grained pass-through toggle used by the hover sensor while locked:
   * `ignore:true` lets clicks fall through to the game, `false` captures them so a
   * hovered control (the pin button) is clickable. Fire-and-forget.
   */
  setIgnoreMouse: (ignore: boolean): void => ipcRenderer.send(IPC.overlaySetIgnoreMouse, KIND, ignore),
  /**
   * DEEP LINK (Task #64): "take me to this mob in the app". Main raises + focuses the main
   * window and forwards the request to its renderer, which switches to the Mobs tab and opens
   * the mob's page. Fire-and-forget — an overlay never waits on the app it just raised.
   *
   * Interactive mode only, by the caller's construction: a LOCKED overlay is click-through by
   * law, so it has no clicks to give.
   */
  focusMob: (mob: string): void => ipcRenderer.send(IPC.focusView, { view: 'mobs', mob }),
  /**
   * The same deep link, aimed at a payload-chosen destination — the celebration toast's card
   * click (T6). The payload comes from MAIN (it built the toast), not from page text, and the
   * handler re-validates `view` against the closed AppFocusView union regardless.
   */
  focusApp: (focus: AppFocus): void => ipcRenderer.send(IPC.focusView, focus),

  /**
   * TOAST (docs/plans/celebration-toasts.md): one finished card to render, pushed by main.
   * Self-contained by law — the overlay times and dismisses it locally and fetches nothing.
   */
  onToast: (cb: (t: ToastPayload) => void): (() => void) => {
    const listener = (_e: unknown, t: ToastPayload): void => cb(t)
    ipcRenderer.on(IPC.onToast, listener)
    return () => ipcRenderer.removeListener(IPC.onToast, listener)
  },

  /**
   * ALERT BANNER (JOS-378): one validated line to render, pushed by main. Self-contained by the
   * same law the toast keeps — the overlay times and dismisses it locally and fetches nothing.
   * The two are separate members rather than one because they are separate WINDOWS: a banner
   * window must never be handed a celebration, and vice versa.
   */
  onAlertBanner: (cb: (b: AlertBannerPayload) => void): (() => void) => {
    const listener = (_e: unknown, b: AlertBannerPayload): void => cb(b)
    ipcRenderer.on(IPC.onAlertBanner, listener)
    return () => ipcRenderer.removeListener(IPC.onAlertBanner, listener)
  },

  /**
   * "That sighting was the spawn — start this row's clock from it" (JOS-194, round 3).
   *
   * THE SAME MEMBER, UNDER THE SAME NAME, as the main app's bridge (preload/respawn.ts), for the
   * reason the fight-selection trio above is duplicated: one fact, one name, two windows. The
   * respawn overlay is where this feature is actually USED — a timer you have to alt-tab to read
   * is a timer you do not read — so making the confirmation tab-only would put the affordance in
   * the window the user is not looking at while the mob is hitting them.
   *
   * Interactive mode only, by the caller's construction (the `focusMob` rule): a LOCKED overlay is
   * click-through by law, so it has no clicks to give. Main re-validates the id regardless.
   */
  confirmRespawnSighting: (rowId: string): Promise<boolean> =>
    ipcRenderer.invoke(IPC.respawnConfirmSighting, rowId),

  /**
   * "Stop watching this mob" (JOS-194, round 4) — again THE SAME MEMBER UNDER THE SAME NAME as the
   * main app's bridge, and here for the reason the ruling exists: the moment you want a clock gone
   * is the moment you are looking at it over the game, and making the only way out a list at the
   * bottom of a tab means alt-tabbing away from the fight to get rid of a row about the wrong mob.
   *
   * Interactive mode only by the caller's construction (a LOCKED overlay is click-through by law
   * and has no clicks to give), and main re-validates the key regardless.
   */
  unwatchRespawn: (key: string): Promise<boolean> => ipcRenderer.invoke(IPC.respawnUnwatch, key),

  /** Close this overlay from its own close button (interactive mode only). */
  close: (): void => ipcRenderer.send(IPC.overlayClose, KIND)
}

export type EqOverlayApi = typeof overlayApi

contextBridge.exposeInMainWorld('eqOverlay', overlayApi)
