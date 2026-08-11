// appBack — the mouse's Back button, and the ONE place the OS is allowed to say "go back" (JOS-201).
//
// THE ASK: a user reading an item description that a Plane of Sky page opened wants the browser-
// style Back button on their mouse (mouse4 / XButton1) to return them to that page, the way it
// would in any browser.
//
// THE SCOPE, which is the whole design and is deliberately narrower than "listen for mouse4":
//
//   * WINDOW-SCOPED, NEVER A GLOBAL HOOK. This is a BrowserWindow `app-command` listener, so the
//     press has to arrive as a WM_APPCOMMAND aimed at OUR window. Nothing is installed at the OS
//     level: no `globalShortcut`, no low-level mouse hook, no polling. An app that tails a game
//     log has no business intercepting a button the rest of the desktop is using — and a global
//     hook on a mouse button is also the shape anti-cheat heuristics are entitled to dislike.
//   * NOTHING WHILE EVERQUEST IS FOREGROUND. Window-scoped already implies it (a press inside the
//     game is the game's message, not ours), but Windows will deliver a mouse WM_APPCOMMAND to the
//     window under the CURSOR, which need not be the focused one — so the guard is stated rather
//     than inferred: unless this window has focus, the press was not for us and we drop it. In
//     EverQuest, mouse4 keeps meaning whatever the player bound it to, and this app is silent.
//   * NO FORWARD. `browser-forward` is not handled, because the app has no forward stack to walk:
//     the navigation model is an origin STACK that Back CONSUMES (navOrigin.ts). A button that
//     did nothing would be worse than a button that is not wired.
//
// The main process deliberately does not decide what "back" MEANS. It knows a button was pressed
// in its window; the renderer owns the answer (src/renderer/src/appBack.tsx), because the thing to
// back out of is a drill-down and a parked navigation origin, neither of which exists here.

import { IPC } from '../shared/ipc'
import { E2E } from './e2e'

// TYPE-ONLY, so this module stays loadable under `node --test` for the predicate below — the same
// reason security.ts is shaped the way it is. Nothing here calls into Electron at import time.
import type { BrowserWindow } from 'electron'

/**
 * The `app-command` names that mean "go back". A closed list, not a substring test: `app-command`
 * carries dozens of shell/media verbs (`media-play-pause`, `browser-home`, `volume-up`…) and this
 * app answers exactly one of them.
 *
 * `browser-backward` is what a mouse's back button and Alt+Left both raise on Windows.
 */
const BACK_COMMANDS = new Set(['browser-backward'])

/** Is this app-command the Back button? Pure, so `tests/appBackCommand.test.mts` can pin the list. */
export function isBackCommand(command: string): boolean {
  return BACK_COMMANDS.has(command)
}

/**
 * Wire one window's Back button to its renderer. Called once, from `createMainWindow` — the
 * overlays are deliberately NOT wired: they are accessory heads-up displays with no navigation of
 * their own, and a press over one must not steer the tab the user is reading behind it.
 *
 * `app-command` is Windows-only (macOS/Linux emit nothing), which is honest for a Windows game's
 * companion: on any other platform this installs a listener that never fires and changes nothing.
 *
 * E2E never shows — and therefore never focuses — a window (src/main/e2e.ts is the whole test
 * mode), so the focus guard is skipped there, exactly as the deep-link handler skips its raise.
 * The command still has to be `browser-backward` and still has to arrive on this window.
 */
export function installBackButton(win: BrowserWindow): void {
  win.on('app-command', (_event, command) => {
    if (!isBackCommand(command)) return
    // DESTROYED FIRST: every other question here is a method call on the window, and calling one
    // on a destroyed BrowserWindow throws — which in the main process is an uncaught exception,
    // not a missed keystroke. The listener outlives nothing here today, but this is the same
    // guard every `getMainWindow()` caller in windows.ts already keeps.
    if (win.isDestroyed()) return
    if (!E2E && !win.isFocused()) return
    win.webContents.send(IPC.onAppBack)
  })
}
