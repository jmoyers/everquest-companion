// ============================================================================
// closeToTray — what the X on the main window means, and where the card that explains it goes
// (JOS-139).
// ============================================================================
//
// THE ASK, AND WHY IT IS A DEFAULT RATHER THAN AN OPTION. Five players across four releases asked
// for the same thing in four different vocabularies ("minimize to the notification icon area",
// "minimize to system tray so it doesn't show up in alt-tab", "minimize to taskbar would be nice",
// and the original report from somebody who hit X by reflex and lost a session's timers). The
// companion is a thing you run BESIDE the game for hours; the window is the part of it you only
// occasionally need. So closing the window keeps the process, and the preference exists for the
// person who means "quit" when they press X.
//
// PURE ON PURPOSE, and shared on purpose. Nothing here imports Electron or the store, so the whole
// decision — hide or close, show the card or not, where the card goes — is describable in a node
// test (tests/closeToTray.test.mts). The Electron halves are src/main/tray.ts (the icon, the menu,
// the popover) and the one guard inside `createMainWindow` (src/main/windows.ts); the persisted
// half is src/main/storeCloseToTray.ts. It is in `shared/` rather than `main/` because the
// PREFERENCE type is read by the renderer's Preferences card as well.
//
// THREE THINGS DECIDE A CLOSE, and all three are inputs rather than ambient reads:
//
//   * the PREFERENCE. Off means the X quits, exactly as it did before this shipped.
//   * QUITTING. Every real quit path (the tray's own Quit, the popover's two buttons, the
//     auto-updater's `quitAndInstall`, an OS logoff, `app.quit()` from anywhere) closes the window
//     for real, because main latches `before-quit` first. Without that latch a hide would swallow
//     the quit and leave a process nobody can see or stop.
//   * A TRAY THAT EXISTS. Hiding a window with no way to bring it back is not a feature, it is a
//     lost app - so the intent is 'close' whenever there is no tray icon (the E2E harness, or a
//     platform/session where the Tray could not be created).
//
// THE CLOSE IS NEVER BLOCKED. `closeIntent` answers 'hide' or 'close' and there is no third value:
// the window either goes away or stops being visible, and in both cases the gesture the user made
// is honoured immediately. The popover that explains the hide is a card that appears NEXT TO THE
// TRAY, never a dialog in the way.

/**
 * The stored preference. TWO fields, and the second is not a setting: it is the memory of whether
 * this install has been TOLD what the X now does.
 */
export interface CloseToTrayPrefs {
  /** Does closing the main window keep the companion running? Default OFF (owner, 2026-08-16). */
  enabled: boolean
  /**
   * Has the user acknowledged the "still running in the tray" card?
   *
   * Not a preference anybody sets in Preferences — it is the one-time notice's own state, kept
   * beside the switch because it is meaningless without it. `Got it` and `Always quit instead`
   * set it; a card that timed out, was dismissed by a click elsewhere, or ended in `Quit now`
   * does NOT, so somebody who never read it sees it again on their next close.
   */
  noticeAcknowledged: boolean
}

/**
 * OFF: the X quits, exactly as every build before this one did, until somebody asks otherwise.
 *
 * The first cut shipped this ON (the owner's 2026-08-16 design), and the owner reversed it the same
 * day after hands-on: "default it to off. it should close by default. then if somebody checks that
 * preference, it goes to this new experience." So an ABSENT key, a hand-edited file and an upgrade
 * from a build that predates this all mean what they always meant - closing the window ends the
 * app - and the tray, the popover and the whole hide path are OPT-IN through any of the three
 * mirrors (Preferences → Window, the title bar's overlay menu, the tray icon's own checkbox). The
 * popover still explains itself on the first close that hides, which is now always a close made
 * by somebody who chose it.
 */
export const DEFAULT_CLOSE_TO_TRAY: CloseToTrayPrefs = { enabled: false, noticeAcknowledged: false }

/**
 * The prefs, defaulted field by field.
 *
 * The repo's store discipline (read through the normalizer, write through the SAME one), so a
 * store file, a renderer patch and a future migration cannot end up with three ideas of what this
 * setting is. `fallback` is what makes ONE function serve both callers: reading the store passes
 * the shipped default, applying a PATCH passes what is currently stored, so a patch that names no
 * field keeps every field.
 */
export function mergeCloseToTray(
  value: unknown,
  fallback: CloseToTrayPrefs = DEFAULT_CLOSE_TO_TRAY
): CloseToTrayPrefs {
  const v =
    typeof value === 'object' && value !== null && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : {}
  return {
    enabled: typeof v.enabled === 'boolean' ? v.enabled : fallback.enabled,
    noticeAcknowledged:
      typeof v.noticeAcknowledged === 'boolean' ? v.noticeAcknowledged : fallback.noticeAcknowledged
  }
}

/**
 * The prefs as anything outside the store may read them.
 *
 * Identical to the merge today, and a separate name anyway: `overlaySnap` is the precedent both
 * ways round — the pair exists there because a release hold sits between them, and every reader in
 * this app is written against the NORMALIZED spelling so that such a clamp has somewhere to live
 * without touching thirteen call sites.
 */
export function normalizeCloseToTray(
  value: unknown,
  fallback: CloseToTrayPrefs = DEFAULT_CLOSE_TO_TRAY
): CloseToTrayPrefs {
  return mergeCloseToTray(value, fallback)
}

/** What a close of the main window does. There is no third value, and no 'block'. */
export type CloseIntent = 'hide' | 'close'

/** The three facts a close is decided from. An OBJECT rather than three booleans, so no call site
 *  can get the order wrong — and so the reason a given close closed is readable in a test. */
export interface CloseInputs {
  /** The preference: is the companion supposed to survive the X? */
  enabled: boolean
  /** Is this process already on its way out (main's `before-quit` latch)? */
  quitting: boolean
  /** Is there a tray icon on screen to bring the window back with? */
  trayAvailable: boolean
}

/**
 * Hide, or close?
 *
 * Written as the three refusals first, so that every way of ending up with a real close is stated
 * rather than implied: the app is quitting, the user asked for the X to quit, or there is nothing
 * on screen that could bring a hidden window back.
 */
export function closeIntent({ enabled, quitting, trayAvailable }: CloseInputs): CloseIntent {
  if (quitting) return 'close'
  if (!enabled) return 'close'
  if (!trayAvailable) return 'close'
  return 'hide'
}

/**
 * Does this hide get the card?
 *
 * Once per install until acknowledged, which is deliberately weaker than "once ever": the card is
 * a 380px explanation that vanishes after fifteen seconds, and a player who alt-tabbed away while
 * it was up has not been told anything.
 */
export function shouldShowTrayNotice({ acknowledged }: { acknowledged: boolean }): boolean {
  return !acknowledged
}

/**
 * How long the card stays up, in ms.
 *
 * Fifteen seconds is long enough to read two sentences and press a button, and short enough that a
 * card nobody looked at is gone before it becomes furniture. It is quoted by nothing the user
 * reads, so it is a constant rather than copy.
 */
export const TRAY_NOTICE_MS = 15_000

/** The card's window size in DIP. Fixed: the copy is fixed, and a notice that resizes itself is a
 *  window the user has to think about. */
export const TRAY_NOTICE_SIZE = { width: 380, height: 170 } as const

/** A screen-coordinate rectangle - what `Tray.getBounds()` and `Display.workArea` share. */
export interface NoticeRect {
  x: number
  y: number
  width: number
  height: number
}

/**
 * WHERE THE CARD GOES: just above the tray icon, and always inside the work area.
 *
 * The tray icon's rectangle is the only anchor that means anything here — the notification area
 * can be at the bottom (the usual place), at the top, or down either side, and a card hard-coded
 * to "bottom right" would point at nothing on three of those four desktops. So the card is placed
 * relative to the ICON: centred on it horizontally, and above it if there is room, below it if
 * there is not.
 *
 * THEN CLAMPED, unconditionally, which is what makes the placement safe rather than clever: a
 * scaled display, a taskbar on the left, an icon in the overflow flyout whose bounds are its
 * container's - every one of those ends with a rectangle that is still wholly on the work area.
 * `GAP` is the one aesthetic number: enough that the card reads as a separate thing from the
 * taskbar, small enough to still be pointing at the icon.
 *
 * A tray with no bounds (an empty rectangle, which is what some platforms answer) lands in the
 * work area's bottom-right corner - the same place the notification area is on a default Windows
 * desktop, and the honest fallback for "the icon would not say where it is".
 */
export function trayNoticeBounds(
  tray: NoticeRect,
  workArea: NoticeRect,
  size: { width: number; height: number } = TRAY_NOTICE_SIZE
): NoticeRect {
  const GAP = 8
  const anchored = tray.width > 0 || tray.height > 0
  const above = tray.y - size.height - GAP
  const below = tray.y + tray.height + GAP
  const x = anchored
    ? Math.round(tray.x + tray.width / 2 - size.width / 2)
    : workArea.x + workArea.width - size.width - GAP
  const y = anchored
    ? above >= workArea.y
      ? above
      : below
    : workArea.y + workArea.height - size.height - GAP
  return {
    width: size.width,
    height: size.height,
    x: clamp(x, workArea.x, workArea.x + workArea.width - size.width),
    y: clamp(y, workArea.y, workArea.y + workArea.height - size.height)
  }
}

/** Keep `v` inside [lo, hi]. `lo` wins when the work area is somehow narrower than the card, so
 *  the card's top-left stays on screen rather than its bottom-right. */
function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v))
}
