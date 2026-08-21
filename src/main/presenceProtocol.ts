// ============================================================================
// presenceProtocol.ts — the PURE half of "what is EverQuest doing right now?"
// ============================================================================
//
// The `src/main/security.ts` ↔ `src/main/windows.ts` split, applied to presence: everything
// here is a function of its arguments — the watcher's line protocol, the "is this window
// EverQuest" predicate, the alt-tab debounce, and the gating matrix that decides whether the
// overlays hide and whether the 8 ms cursor stream runs.
//
// No Electron, no thread, no `fs`, no store. That is what lets `tests/presence.test.mts` pin the
// performance contract ("nothing runs when nothing is on", "the stream stops when EQ is
// unfocused") as ordinary unit tests that never skip, instead of as claims somebody re-measures
// by hand. The impure half is now three files: `src/main/presence.ts` starts the watcher and
// folds what it says, `src/main/presenceWorker.ts` is the loop that says it, and
// `src/main/presenceNative.ts` is the Win32 surface that loop reads.

import type {
  CursorRingPrefs,
  OverlayAutoHidePrefs,
  PresenceState,
  ScreenRect
} from '../shared/presencePrefs'

// ---------------------------------------------------------------- the line protocol
//
// The watcher posts one record per line, and ONLY when something changed:
//
//   F|<pid>|<x>|<y>|<w>|<h>|<exePath>|<title>   foreground window changed
//   R|<0|1>                                      EQ process existence changed (5 s cadence)
//   C|<0|1>                                      system cursor visibility changed
//   H                                            heartbeat — "still looping" (5 s cadence)
//   X|<reason>                                   the LAST line: why the loop is about to stop
//
// THE TRANSPORT CHANGED AND THE PROTOCOL DID NOT (JOS-182). These lines used to arrive on a
// `powershell.exe` child's stdout; they now arrive as `postMessage` strings from a worker
// THREAD (`presenceWorker.ts`). Keeping the text codec across that move was deliberate: it is
// one tested decoder rather than two, a line is cheaper to structured-clone than an object, and
// a record that reaches a person — an error-log entry, a support paste — still reads as the
// single token it always did. The rule that matters is unchanged and is why the codec is worth
// keeping at all: a message from the other side of a boundary is INPUT, and a malformed one must
// decode to nothing rather than move the state.
//
// `title` is last because it is the only field that may contain anything (including `|`); a
// Windows path cannot contain `|`, so every field before it is unambiguous.
//
// THE HEARTBEAT IS THE ONE UNCONDITIONAL LINE, and it is why it exists. Every other record is
// printed ONLY on a change, so a healthy watcher's steady state is total silence on the pipe —
// which is exactly what a WEDGED watcher looks like from the parent. Without an explicit
// liveness signal there is no observation that separates "nothing has happened" from "nothing
// will ever happen again", and the second one FREEZES the presence state: `eqFocused:true`
// outlives the alt-tab that should have cleared it and the ring keeps drawing over whatever the
// user switched to. One 1-byte line per 5 s on an otherwise idle pipe buys that distinction.
//
// THE EXIT LINE IS THE WATCHER'S LAST WORD (JOS-164, and it earns its keep again in JOS-182). A
// watcher can end itself, and from the outside that is indistinguishable from every other way an
// execution context can stop existing: `'exit'`, code 0, no explanation. That mattered exactly
// once and then mattered a great deal, when a machine whose `Get-Process` could not see a LIVE
// parent made the old child reap itself a second after every spawn, forever, and the parent's
// only evidence was 245 identical "exited unexpectedly" lines.
//
// That particular loop is gone with the child (a worker thread cannot be orphaned, so there is no
// self-reap and no `parent-gone`), but the SHAPE came straight back in a new costume: on a machine
// where the native surface will not load, the worker starts, fails, and exits cleanly in a few
// milliseconds — and would do it forever on the restart backoff. So the reason line stays, the
// reasons are now about the surface (`native-unavailable`, `native-failing`), and the collapse
// fold at the foot of this file is what turns a permanent condition into ONE error-store entry.
// It is advisory by construction: a watcher that is terminated, crashes, or is starved says
// nothing, and the parent must still handle the exit.

/** One decoded watcher record. */
export type PresenceRecord =
  | { t: 'fg'; pid: number; rect: ScreenRect; exePath: string; title: string }
  | { t: 'run'; running: boolean }
  | { t: 'cursor'; visible: boolean }
  | { t: 'beat' }
  | { t: 'exit'; reason: string }

/** A finite integer from one protocol field, or null when the field is not one. */
function intField(s: string | undefined): number | null {
  if (s === undefined || s === '') return null
  const n = Number(s)
  return Number.isFinite(n) && Number.isInteger(n) ? n : null
}

/** The `<0|1>` payload `R` and `C` share, or null when the field is not one. */
function boolField(s: string | undefined): boolean | null {
  const v = intField(s)
  return v === null ? null : v !== 0
}

/** The one record with a payload: `F|<pid>|<x>|<y>|<w>|<h>|<exePath>|<title>`. */
function parseForeground(parts: string[]): PresenceRecord | null {
  if (parts.length < 7) return null
  const [pid, x, y, w, h] = [1, 2, 3, 4, 5].map((i) => intField(parts[i]))
  if (pid === null || x === null || y === null || w === null || h === null) return null
  return {
    t: 'fg',
    pid,
    rect: { x, y, width: w, height: h },
    exePath: parts[6] ?? '',
    // The title is whatever remains — it is user/game-supplied text and may contain `|`.
    title: parts.slice(7).join('|')
  }
}

/**
 * The shape of an exit REASON: a lowercase kebab token, capped.
 *
 * Narrow on purpose, and narrow enough that `X|1|2` is still junk rather than a reason of `1|2`
 * (the malformed-line suite has always asserted that line decodes to nothing, and it still must).
 * The watcher writes these strings itself so the field is not hostile input in the way a window
 * title is — but it lands in the parent's error log, which is a place text goes to be read by a
 * person, so it is bounded by SHAPE here rather than trusted by provenance. The two reasons the
 * watcher prints today are `native-unavailable` and `native-failing`.
 */
const EXIT_REASON_RE = /^[a-z][a-z0-9-]{0,62}$/

/**
 * Decode one line. Returns null for anything that is not a well-formed record, which is the only
 * correct answer for a channel that can also carry a stray blank line or a message from a build
 * that does not agree with this one about the protocol — a malformed line must never move the
 * state.
 */
export function parsePresenceLine(line: string): PresenceRecord | null {
  const trimmed = line.replace(/\r$/, '').trim()
  if (trimmed === '') return null
  const parts = trimmed.split('|')
  if (parts[0] === 'F') return parseForeground(parts)
  if (parts[0] === 'X') {
    const reason = parts[1] ?? ''
    return parts.length === 2 && EXIT_REASON_RE.test(reason) ? { t: 'exit', reason } : null
  }
  // The heartbeat carries no payload, so it is the whole line or it is not a heartbeat.
  if (trimmed === 'H') return { t: 'beat' }
  const flag = boolField(parts[1])
  if (parts[0] === 'R') return flag === null ? null : { t: 'run', running: flag }
  if (parts[0] === 'C') return flag === null ? null : { t: 'cursor', visible: flag }
  return null
}

// ------------------------------------------------------- physical pixels → DIP

/**
 * The conversion that turns a watcher rectangle into a rectangle main can use, injected.
 *
 * In the app this is `screen.screenToDipRect` (Electron, Windows); in a test it is a fake, which
 * is the only reason it is a parameter at all — this file is the half that runs with no Electron
 * in sight, and the seam that uses it (presence.ts `applyRecord`) cannot be imported without one.
 */
export type PhysicalToDip = (rect: ScreenRect) => ScreenRect

/**
 * THE WIRE IS PHYSICAL PIXELS AND EVERYTHING ELSE IS DIP — this is where that stops being true
 * (JOS-376).
 *
 * `GetWindowRect` answers in physical pixels because this process is per-monitor-DPI aware, and
 * the worker that calls it has no `screen` module to convert with, so the protocol carries what
 * the OS said. `BrowserWindow` bounds and `screen.getCursorScreenPoint()` are DIP. At 100% scale
 * on the primary monitor the two numbers are equal, which is why nothing converted for a year and
 * the ring was still right — and why the report that found it (01M037P83Z3KK4379WWET159B2) came
 * from a two-monitor desk: on a scaled or non-origin monitor the ring window was placed at the
 * wrong origin and oversized, spilled onto the neighbour, and drew its halo at an offset.
 *
 * The result is ROUNDED because it becomes `BrowserWindow` bounds (`setCursorRingBounds`), and a
 * scale factor that is not a whole ratio — 150% turns an odd physical coordinate into a half — has
 * no reason to hand a window manager a fractional rectangle.
 */
export function eqBoundsInDip(rect: ScreenRect, toDip: PhysicalToDip): ScreenRect {
  const dip = toDip(rect)
  return {
    x: Math.round(dip.x),
    y: Math.round(dip.y),
    width: Math.round(dip.width),
    height: Math.round(dip.height)
  }
}

// ------------------------------------------------------- is this window EverQuest?

/** `<root>\` — a separator-terminated prefix, so `…\EverQuest Legends2` never matches
 *  `…\EverQuest Legends`. Empty in, empty out (an unresolvable root disables path matching). */
export function eqRootPrefix(root: string): string {
  const trimmed = root.trim()
  if (!trimmed) return ''
  return trimmed.endsWith('\\') || trimmed.endsWith('/') ? trimmed : `${trimmed}\\`
}

/**
 * The image names the EverQuest CLIENT actually ships under. `eqgame.exe` has been the client
 * binary on every build from Titanium to Live, and it is the SAME name the watcher's own
 * "is the game running" scan keys on — one fact, one spelling. Exported for exactly that reason:
 * `presenceNative.ts`'s `eqRunning()` imports this set rather than respelling the name, so the
 * scan and the predicate below cannot drift apart.
 */
export const EQ_CLIENT_EXES = new Set(['eqgame.exe'])

/** The last path segment of a Windows image path, lowercased. */
function exeBaseName(exePath: string): string {
  const p = exePath.trim().toLowerCase()
  const cut = Math.max(p.lastIndexOf('\\'), p.lastIndexOf('/'))
  return cut === -1 ? p : p.slice(cut + 1)
}

/**
 * Does this title belong to the EverQuest CLIENT — as opposed to a window that merely mentions
 * the game? The client titles its window "EverQuest" (some builds append a server or character),
 * so the match is ANCHORED at the start and stops at a word boundary. `…includes('everquest')`
 * was the old test and it is the bug this predicate exists to not have: a browser tab reading
 * "EverQuest Wiki — Google Chrome" contains the substring in the middle, and so does a Discord
 * window sitting in an #everquest channel.
 */
function titleIsEqClient(title: string): boolean {
  return /^everquest\b/i.test(title.trim())
}

/**
 * Is the foreground window EverQuest?
 *
 * PRIMARY signal: the process image lives under the effective EQ install root
 * (`log/config.ts effectiveEqRoot()` — never a hardcoded Daybreak path). That is an identity,
 * not a guess, and it follows the user's Settings override for free.
 *
 * THE PATH, WHEN WE HAVE ONE, IS THE ANSWER — and this is the fix for a real, reported bug: the
 * cursor ring followed the pointer around the user's WEB BROWSER. The old predicate fell back to
 * "the title contains EverQuest" for EVERY window the root check declined, so any window of any
 * process — a browser on an EQ wiki, a chat client in an #everquest channel — was classified as
 * the game, took `eqFocused`, and handed the ring its own rectangle to draw in. A READABLE image
 * path is a positive answer to "whose window is this?", so once we have one the only thing that
 * can still make it EverQuest is the client's own image NAME. That keeps the case the fallback
 * was actually written for — a second install the app was never pointed at — while costing every
 * unrelated process its ability to impersonate the game by title.
 *
 * THE TITLE IS THE LAST RESORT, and only when the path is UNKNOWN (elevation, protected
 * processes: the watcher reports an empty path and there is nothing else to go on).
 *
 * (This app's own windows are titled "EQ Legends Companion" / "… Overlay" / "Cursor Ring" and
 * match none of it — and are classified by pid before they ever reach this predicate.)
 */
export function isEqWindow(w: { exePath: string; title: string }, eqRoot: string): boolean {
  const prefix = eqRootPrefix(eqRoot).toLowerCase()
  const exe = w.exePath.trim().toLowerCase()
  if (prefix && exe.startsWith(prefix)) return true
  if (exe) return EQ_CLIENT_EXES.has(exeBaseName(exe))
  return titleIsEqClient(w.title)
}

/**
 * WHICH SIDE OF "ARE YOU IN EVERQUEST?" THE FOREGROUND WINDOW FALLS ON — four answers, because
 * for one of them the pid is not enough (JOS-199).
 *
 * The OWN-WINDOWS rule used to be a single bit: `pid === process.pid` ⇒ EQ side, on the reasoning
 * that every window this app creates is owned by the main process, so one comparison covers the
 * overlays, the ring and the app at once and "clicking your own overlay must not hide it" is true
 * by construction. That is still exactly right for the ACCESSORY windows and it is why they are
 * still classified by pid alone.
 *
 * It was wrong for the COMPANION WINDOW ITSELF, and a player said so: "the overlays cover a lot of
 * the Companion unnecessarily when trying to navigate through the app" (report
 * 01KZPVWXZACDHVRNKTFGDW3E4M, v0.18.0). Bringing the app to the front is the ONE case where the
 * user has said, with a click, that they are looking at something other than the game — and it is
 * the case where a floating always-on-top meter is directly in the way of what they switched to.
 * "Hide when you're not in EverQuest" that makes an exception for the biggest window the app owns
 * is not the setting the label describes.
 *
 * So the app's own windows split in two, and the split is a QUESTION ELECTRON ANSWERS rather than
 * anything the watcher can see: every one of our windows reports the same pid and the same image
 * path, and the only field left is a title, which is page-supplied text and no basis for a policy.
 * `self.appWindowFocused` is `windows.ts mainWindowFocused()` — the main process asking its own
 * main window whether it is the active one, at the moment the record arrives.
 *
 * Pure, so the whole matrix is a unit test rather than an alt-tab somebody performs by hand.
 */
export type ForegroundSide = 'eq' | 'own-accessory' | 'own-app' | 'other'

export function foregroundSide(
  w: { pid: number; exePath: string; title: string },
  self: { pid: number; appWindowFocused: boolean },
  eqRoot: string
): ForegroundSide {
  if (w.pid === self.pid) return self.appWindowFocused ? 'own-app' : 'own-accessory'
  return isEqWindow(w, eqRoot) ? 'eq' : 'other'
}

/**
 * Does this side count as "you are in EverQuest" for `PresenceState.eqFocused`?
 *
 * The game itself, and the app's ACCESSORY windows — an unlocked overlay the user is dragging, the
 * cursor ring. Never anybody else's window.
 *
 * THE COMPANION WINDOW HAS TWO ANSWERS SINCE JOS-427, and `ownRaise` is which one applies. A user
 * who alt-tabs or clicks INTO the app has said they are looking at something other than the game —
 * `false`, the JOS-199 reading, unchanged. But a raise the app performed FOR an overlay click (the
 * con card, a toast — `windowControls.ts focusView`) is the overlays' own feature working, and the
 * owner's ruling is verbatim: "the overlays are effectively everquest still being the focus
 * spiritually." Parking them as punishment for using them was the oscillation the narration caught
 * (raise → park → click back → unpark → next card click → raise …). `presence.ts` owns the flag's
 * lifetime: set by the raise, cleared by the first foreground record that is not the app window.
 */
export function focusCountsAsEq(side: ForegroundSide, ownRaise = false): boolean {
  if (side === 'own-app') return ownRaise
  return side === 'eq' || side === 'own-accessory'
}

// ------------------------------------------------- no focus debounce, by ruling (JOS-427)
//
// THERE USED TO BE A DEBOUNCE HERE, and it grew three times (300 ms symmetric; JOS-424 asymmetric
// 200/1200 ms; JOS-425 born-true) while the flicker it was blamed for kept happening. The
// narration those tickets added finally produced a clean test: four alt-tab round trips, every
// committed flip a single truthful edge - and the owner still SAW the flicker. The visible strobe
// was never in this signal; it was the hide()/show() presentation flash (windows.ts parkOverlays
// is the fix, and the JOS-120 ring lesson was the precedent all along). OWNER RULING 2026-08-19:
// remove the debounce machinery outright - eqFocused IS the latest observed foreground, both
// directions, no timers.
//
// WHAT REPLACES TIME IS EVIDENCE, two rules, neither of them a clock:
//   * A NO-WINDOW SAMPLE IS NOT A DEPARTURE. During window transitions Windows briefly reports no
//     foreground window at all (pid 0 - presenceWorker.ts NO_WINDOW). Nothing gained focus, so
//     nothing was left: presence.ts applyRecord keeps the previous answer rather than folding a
//     moment of nobody into "you are not in EverQuest".
//   * AN OVERLAY-INITIATED RAISE IS STILL EVERQUEST (owner ruling 2026-08-19: "the overlays are
//     effectively everquest still being the focus spiritually"). Clicking a con card raises the
//     Companion window on purpose; that raise must not park the overlays the click came from.
//     focusCountsAsEq takes the flag; presence.ts owns its lifetime (set by the focusView raise,
//     cleared by the next non-own-app foreground record).
//
// The alt-tab task-switcher case the original debounce was built for is accepted as-is: the
// switcher is a real foreground window, the overlays park instantly under it and return instantly
// after - parking is an opacity flip now, so there is no strobe left for a transition to cause.


// ------------------------------------------------- what a committed flip says out loud (JOS-424)
//
// THE LOGGING EARNED ITS KEEP: it is what proved (JOS-427) that the visible flicker had no
// committed flip behind it, which retired the debounce and pointed at the presentation layer.
// It stays for the next mystery. A blink with a flip line names the window that drove it; a blink
// with NO edge line at all is a z-order or paint question, not a focus one.
//
// IT IS A LOG LINE, NOT TELEMETRY, AND THAT IS ENFORCED BY THE SINK. `presence.ts` emits this
// through `logInfo` — `console.log` and nothing else. It never reaches `errors.log`, never reaches
// the error store, and therefore never leaves the machine. That matters here specifically because
// the record carries a WINDOW TITLE, which is arbitrary third-party text (a document name, a
// browser tab) that nobody consented to have collected. Locally it is the single most useful field
// for "what took the foreground"; remotely it would be a bright-line violation, so it is only ever
// printed. It is flattened and capped on the way out for the same reason a title is never trusted
// anywhere else in this file: a multi-line title must not be able to forge extra lines in dev.log.

/** The foreground record that drove a committed flip, as much of it as a log line wants. */
export interface FocusTransitionDriver {
  readonly pid: number
  readonly exePath: string
  readonly title: string
  readonly side: ForegroundSide
}

/** How much window title one line carries. Long enough to identify a window, short enough that
 *  the interesting fields (the commit, the pid, the image name) are never scrolled off. */
export const TRANSITION_TITLE_MAX = 60

/**
 * One line's worth of a window title: no control characters, no newlines, no quotes, bounded.
 *
 * A CODE-POINT SCAN RATHER THAN A REGEX, and not only to keep `no-control-regex` happy: the rule is
 * pointing at something real. A character class spelling a control range is the one place a raw
 * control BYTE ends up in a source file by accident (the repo already has a law about that), and it
 * silently means something else when it does. A comparison cannot be mistyped invisibly.
 */
function logSafeTitle(title: string): string {
  let out = ''
  for (const ch of title) {
    const code = ch.codePointAt(0) ?? 0
    // A double quote goes too, so the `"…"` this line is wrapped in cannot be closed early.
    out += code < 0x20 || code === 0x7f || ch === '"' ? ' ' : ch
  }
  const flat = out.replace(/\s+/g, ' ').trim()
  if (flat.length <= TRANSITION_TITLE_MAX) return flat
  return `${flat.slice(0, TRANSITION_TITLE_MAX)}…`
}

/**
 * ONE committed `eqFocused` flip, as a sentence — the raw driving record and when it landed.
 *
 * Pure and closed over its argument: everything on the line comes from the transition and the
 * foreground record, so there is no path by which a game event, a log line or any part of the world
 * model can reach it. `tests/presence.test.mts` pins the exact shape.
 */
export function describeFocusTransition(t: {
  readonly committed: boolean
  readonly at: number
  readonly driver: FocusTransitionDriver | null
}): string {
  const when = new Date(t.at).toISOString()
  const head = `presence: eqFocused -> ${String(t.committed)} at ${when}`
  if (t.driver === null) return `${head}; no foreground record yet`
  const exe = exeBaseName(t.driver.exePath)
  const image = exe === '' ? '(no image path)' : exe
  const title = logSafeTitle(t.driver.title)
  const said = title === '' ? '(untitled)' : `"${title}"`
  return `${head}; foreground pid ${String(t.driver.pid)} ${image} [${t.driver.side}] ${said}`
}

/**
 * The other half of the evidence: an EDGE of real window visibility (`windows.ts
 * setOverlaysHidden`) — since JOS-427 that is the replay gate and session teardown only, because
 * presence PARKS instead of hiding. A "hidden" line in dev.log therefore always means the gate.
 */
export function describeOverlayVisibility(hidden: boolean, at: number): string {
  return `presence: overlays ${hidden ? 'hidden' : 'shown'} at ${new Date(at).toISOString()}`
}

/**
 * An EDGE of the presence PARK (`windows.ts parkOverlays`, JOS-427) — its own word, so dev.log
 * tells a park (opacity, presence-driven) from a gate hide (real `hide()`) at a glance.
 */
export function describeOverlayPark(parked: boolean, at: number): string {
  return `presence: overlays ${parked ? 'parked' : 'unparked'} at ${new Date(at).toISOString()}`
}

// ------------------------------------------------------------------- the gating matrix

/**
 * Should the floating overlays be hidden right now? The two settings are independent and either
 * one can hide on its own — that is what "two toggles" means, and it is why this is not a
 * three-valued mode.
 *
 * With BOTH off this is always false: a user who wants none of it gets the pre-feature behavior
 * exactly, and (via `presenceNeeded`) never even starts the watcher.
 *
 * NEVER HIDE ON A GUESS — AND `observed` IS ONLY HALF OF THAT PROMISE (JOS-425). The flag below
 * covers the gap before the watcher's very first line and the gap after one dies, and it is a
 * strict fail-OPEN. What it does NOT cover is the instant it flips: `presence.ts applyRecord`
 * raises `observed` on the first record of ANY kind, and the watcher's first tick sends its
 * records one at a time, so for one message-pump turn one lane is measured and the others are
 * still their birth values. That is where the reported startup blink came from and it is why both
 * `eqRunning` and `eqFocused` are now BORN TRUE (shared/presencePrefs.ts `INITIAL_PRESENCE`).
 * Every line here therefore hides only on something the watcher SAID — which is the property this
 * function is supposed to have. (There is no debounce anymore — JOS-427's ruling at the section
 * above; hiding acts on the latest observed foreground directly.)
 */
export function overlaysShouldHide(p: PresenceState, prefs: OverlayAutoHidePrefs): boolean {
  // Before the watcher's first line nothing here is a fact — it has three system libraries to open
  // before it can say otherwise. Acting on that would blink every overlay off at launch and back
  // on a second later on a machine where the game was running the whole time. Fail OPEN, always:
  // the same rule covers a watcher that died, which is why presence.ts resets this flag on exit.
  if (!p.observed) return false
  if (prefs.hideWhenNotRunning && !p.eqRunning) return true
  if (prefs.hideWhenUnfocused && !p.eqFocused) return true
  return false
}

/**
 * Should the cursor ring be on screen — and, identically, should main be streaming cursor
 * samples to it? ONE predicate for both, because "visible but not tracking" is a lagging ghost
 * ring and "tracking but not visible" is exactly the poll the performance contract exists to
 * avoid. Requires known bounds: the ring is sized and positioned to the EQ window, and there is
 * nowhere to put it until that window has been seen.
 *
 * A HIDDEN CURSOR IS NOT A CURSOR. EverQuest hides the pointer for the duration of mouselook and
 * re-centers it every frame, so `getCursorScreenPoint()` oscillates around a pointer that is not
 * on screen — the ring danced by itself. `cursorVisible` defaults true, so this narrows the
 * predicate only once the watcher has actually measured a hidden cursor.
 */
export function cursorRingActive(p: PresenceState, ring: CursorRingPrefs): boolean {
  return ring.enabled && p.eqFocused && p.cursorVisible && p.eqBounds !== null
}

// ------------------------------------------------------------------- the cadences
//
// THREE CLOCKS, AND THE ONLY ONE THAT MATTERS IS THE RATIO BETWEEN TWO OF THEM (JOS-120).
//
// `cursorVisible` is a GATE on an 8 ms consumer. The ring stops drawing when Windows stops
// drawing a pointer — and EverQuest stops drawing one the instant a mouse button goes down in
// the world view, while it re-centers the pointer every frame underneath. So the interesting
// number is not "how fast does the watcher poll", it is HOW MANY SAMPLES THE RING CAN PAINT
// FROM A POINTER THAT IS ALREADY GONE, and that is `gate latency / sampler period`.
//
// It used to be ~19. The whole loop — five user32 calls, a `Get-Process`, a string build and a
// compare — ran on ONE 150 ms tick, and the cursor check rode along with it, so a 100 ms click
// could pass without the gate ever looking. That is the reported twitch: for up to 150 ms the
// ring faithfully tracked a cursor nobody could see.
//
// The fix is not a faster loop, it is a SPLIT one. `cursorShowing()` is a single `GetCursorInfo`
// and costs essentially nothing, so it runs every tick at the platform's floor; the expensive
// foreground work keeps the cadence it has always had by running every Nth tick.
//
// MEASURED on this machine (20-25 s windows, `Get-Process.TotalProcessorTime`): the shipped
// single-cadence loop cost 0.06-0.16 % of one core; the split loop costs 0.19-0.31 %. That is
// the entire price — about 1.3 ms of CPU per second — and it buys a gate that closes inside one
// display frame instead of nine.
//
// THE SPLIT IS ALSO WHY THE WATCHER IS A THREAD AND NOT A TIMER ON MAIN (JOS-182). Once the
// PowerShell child was gone, the obvious shape was a `setInterval` in the main process — and it
// is the wrong one, for a reason that is a measurement rather than a preference. Per call, on
// this machine: `GetCursorInfo` 0.43 us, the whole foreground block 5.7 us (23.5 us including a
// cold image-path lookup), and THE RUNNING SCAN 8.4 ms — of which `EnumProcesses` alone is
// 4.1-4.5 ms, because it walks the machine's whole process table and this desktop has 325 of
// them. On main that is an 8 ms stall of the thread that tails the log, folds combat, answers
// IPC and runs the 8 ms cursor sampler, every 5 seconds, forever. The old child paid that cost
// too — it simply paid it somewhere else, which is precisely the property worth keeping. A
// worker thread keeps it, costs no process, and spawns nothing.

/**
 * The tick the watcher ASKS for, in ms. One, i.e. "the platform's floor" — the same request the
 * cursor sampler makes for the same reason.
 *
 * MEASURED TWICE, AND THE NUMBER SURVIVED THE MOVE OFF POWERSHELL (JOS-182). A
 * `Start-Sleep -Milliseconds 1` loop in the old child turned every ~16 ms (avg 15.96, max 31.65
 * over 25 s); a `setInterval(1)` in the worker thread that replaced it turns 69.3 times a second,
 * i.e. every ~14.4 ms (208 ticks in 3.003 s, this machine). Both are the same 15.6 ms Windows
 * timer quantum, which is what the constant below has always really been about. Asking for 1 is
 * a request for whatever the platform will give, not a claim that it gives 1.
 */
export const WATCHER_TICK_MS = 1

/** What that request MEASURES at. Worst case is ~2x this — one missed quantum. */
export const WATCHER_TICK_FLOOR_MS = 16

/**
 * How many ticks between foreground/running/heartbeat scans. Ten ticks x ~16 ms ~= 160 ms, which
 * is the ~150 ms cadence this loop has always had: fine enough that alt-tab feels instant,
 * coarse enough that the expensive half of the loop is still effectively asleep.
 */
export const FOREGROUND_EVERY_TICKS = 10

/**
 * The cursor sampler's period (presenceEffects.ts's `setInterval`). It lives HERE, next to the
 * watcher's cadence, because neither number means anything without the other — see
 * `unguardedSamplesPerHiddenCursor`.
 *
 * Ask for 8 ms, i.e. "as fast as the platform will give us". MEASURED (Electron, 3x 30 s windows
 * on this machine): a `setInterval(8)` in Electron's main process actually fires ~64 times a
 * second, not 125 — the same 15.6 ms quantum, and Chromium does not raise the system timer
 * resolution for a main-process timer. The number stays 8: it is a request for the platform's
 * floor, and the renderer already coalesces to `requestAnimationFrame` and drops the surplus.
 */
export const CURSOR_POLL_MS = 8

/** Worst-case latency of the cursor-visibility gate: one tick that overran its quantum. */
export const CURSOR_GATE_LATENCY_MS = WATCHER_TICK_FLOOR_MS * 2

/**
 * THE DEFECT, AS A NUMBER. How many cursor samples the ring can still paint from a pointer the
 * game has already hidden and started re-centering — the gate's observation latency over the
 * sampler's period. Pure so `tests/presence.test.mts` can pin it instead of anyone re-deriving
 * it from two constants in two files.
 */
export function unguardedSamplesPerHiddenCursor(
  gateLatencyMs: number,
  samplerMs: number = CURSOR_POLL_MS
): number {
  if (samplerMs <= 0) return 0
  return Math.ceil(gateLatencyMs / samplerMs)
}

// ------------------------------------------------------------------- watcher health
//
// THE STATE IS ONLY AS GOOD AS THE STREAM THAT FEEDS IT. `PresenceState` is a CACHE of the last
// thing the watcher said, and every consumer treats it as current fact — so a stream that stops
// does not make the app cautious, it makes the app confidently wrong. The reported failure is
// the ring: `cursorRingActive` needs `eqFocused && cursorVisible && eqBounds`, all three of
// which SURVIVE a dead pipe, so a watcher that stops mid-game leaves a halo chasing the pointer
// across whatever the user alt-tabs to.
//
// Two things can stop the stream, and they need different answers:
//
//   * the watcher EXITS — observable directly (`'exit'`), handled in presence.ts.
//   * the watcher WEDGES — still there, loop not advancing. Only the HEARTBEAT's absence reveals
//     it, which is what these two functions decide.
//
// BOTH STILL HAPPEN NOW THAT THE WATCHER IS A THREAD (JOS-182), which is why none of this was
// deleted with the child process. A worker thread exits (an uncaught throw, a `terminate()`, a
// native surface that will not load) and a worker thread wedges — a blocked syscall inside an FFI
// call does not yield, and a thread stuck in `EnumProcesses` against a hung filter driver is
// exactly the wedge this watchdog was written for. What DID go away is the third case, the one
// unique to a child: a process orphaned by a parent that died without tearing it down.
//
// Both are decided here, purely, so `tests/presence.test.mts` can pin them with an injected
// clock instead of a real 30-second wait.

/** Heartbeat cadence inside the watcher. Rides the existing 5 s process-existence poll. */
export const WATCHER_HEARTBEAT_MS = 5_000

/**
 * How long a silent pipe is tolerated before the watcher is declared wedged.
 *
 * SIX missed heartbeats. Deliberately generous: the cost of being wrong in one direction is a
 * needless restart (a worker thread and three `LoadLibrary` calls nobody sees), and in the other
 * it is the ring drawing over the user's browser until they quit the app. It still has to be a
 * multiple, not a margin — a machine that is swapping, or a game that just grabbed every core for
 * a zone load, can starve a 150 ms loop for several seconds without anything being wrong with it.
 */
export const WATCHER_STALE_MS = 30_000

/**
 * Has the watcher gone quiet long enough to be presumed wedged? `lastSignalAt` is the timestamp
 * of the last thing the watcher said OR of its start — one that has never spoken is given exactly
 * the same window as one that has stopped, which is correct: a thread that is still loading three
 * system libraries has not failed at anything, and silence forever is not the same fact as
 * silence for a moment.
 */
export function watcherIsStale(
  lastSignalAt: number,
  now: number,
  staleMs: number = WATCHER_STALE_MS
): boolean {
  return now - lastSignalAt >= staleMs
}

/**
 * The restart schedule, in ms, indexed by how many times in a row we have had to do it.
 *
 * CAPPED, and capped low enough to still be a recovery. A watcher can fail for a reason that is
 * never going to clear on this machine — a native surface that will not load, an EDR product that
 * refuses process enumeration outright — and an uncapped retry against that is a restart storm.
 * It can also fail for a reason that clears on its own in a second, which is why the first retry
 * is fast. The counter resets the moment a watcher produces a record, so an app that runs for
 * eight hours with one hiccup at hour three retries at 1 s, not at 30.
 */
export const WATCHER_RESTART_BACKOFF_MS: readonly number[] = [1_000, 2_000, 5_000, 15_000, 30_000]

/** The delay before restart attempt number `consecutiveFailures` (1-based); the last entry is
 *  the ceiling and every later failure sits on it. */
export function watcherRestartDelayMs(consecutiveFailures: number): number {
  const last = WATCHER_RESTART_BACKOFF_MS.length - 1
  const i = Number.isFinite(consecutiveFailures) ? Math.floor(consecutiveFailures) - 1 : 0
  return WATCHER_RESTART_BACKOFF_MS[Math.min(Math.max(i, 0), last)]
}

// ------------------------------------------------------- why a watcher is being replaced (JOS-310)
//
// A RESTART IS NOT AN ERROR, AND SAYING IT WAS DROWNED THE ONES THAT WERE.
//
// The went-silent path — the staleness watchdog deciding the loop has wedged, retiring the thread
// and starting another — is the SELF-HEALING one. It is what this watchdog exists to do, and it is
// the shape the design chose on purpose: `WATCHER_STALE_MS` is six missed heartbeats, deliberately
// generous, because the cost of a needless restart is a thread and three `LoadLibrary` calls
// nobody sees. Reporting each one as an error made the fleet's error store read as though the
// feature were broken on every install: the went-silent and restart families were the TOP LINE on
// every version through 0.26.0 (fingerprints 511c479e x7, 611d2bc2, 65e667c4, 9c670b6b), all of
// them saying the same true, unactionable thing.
//
// So the owner's ruling (2026-08-13, triage item A4) is DEMOTE, and this section is the other half
// of it: what a restart carries so the demotion costs nothing diagnostically. Every restart — the
// demoted one AND the two that stay errors — is described by ONE structured cause, so an error
// store row is now "the watcher exited 900 ms in, having last said `exit`, after 12 ms of silence,
// on attempt 3" rather than a 246th copy of a sentence.
//
// THE COUNT ALREADY HAS AN HONEST HOME, which is what makes the demotion legitimate rather than a
// silencing (the `noteImageFetchFailure` argument in telemetry/health.ts, arrived at again):
// `notePresenceRestart` counts EVERY restart at the one funnel all three causes reach, so a fleet
// where this starts happening still shows it — as `presenceRestarts`, a health counter, which is
// what a handled self-healing condition is measured by.
//
// WHAT STAYS AN ERROR, stated here so the line is not re-litigated at each call site: a watcher
// that EXITED (the surface will not load, the loop threw), a watcher that could not be STARTED,
// the collapsed exit LOOP below, and the surrender at `LOST_WATCHER_LIMIT` in presence.ts — three
// threads wedged and unrecoverable is the genuinely fatal shape and is the one place this feature
// gives up for the session.

/**
 * Which path ended the watcher. `went-silent` is the EXPECTED, self-healing one and the only one
 * that is not an error; the other two are.
 */
export type WatcherRestartTrigger = 'went-silent' | 'exited' | 'start-failed'

/**
 * Everything known about ONE restart, in the order a reader asks for it.
 *
 * The three fields the ticket named are `lastRecord`, `silentMs` and `code`, and each answers a
 * question the old wall of identical lines could not:
 *
 *   * `lastRecord` — WHAT THE WATCHER LAST REPORTED, as a protocol record kind. A watcher that
 *     went quiet after a `beat` was healthy right up to the moment it wedged; one that has said
 *     NOTHING (`null`) never got out of `loadPresenceNative()`, which is a different machine and a
 *     different fix. Those two were indistinguishable before.
 *   * `silentMs` — HOW LONG IT WAS QUIET. On the watchdog's path this is at least
 *     `WATCHER_STALE_MS` by construction, and how far past it says whether the watchdog fired on
 *     its first look or its fifth. On an exit it is usually milliseconds, and a large value there
 *     means the thread was already wedged before it died.
 *   * `code` — THE EXIT CODE WHEN THERE IS ONE. Null on both the watchdog's path (the thread is
 *     still there) and on a start that threw (there never was one), which is itself the fact.
 */
export interface WatcherRestartCause {
  readonly trigger: WatcherRestartTrigger
  /** The kind of the last well-formed record this watcher sent, or null when it never spoke. */
  readonly lastRecord: PresenceRecord['t'] | null
  /** ms since that record - or since the watcher started, when there was none. */
  readonly silentMs: number
  /** How long the watcher lived. The number that turns "it exited" into "it exited immediately". */
  readonly lifetimeMs: number
  /** The thread's exit code, where an exit is what happened. */
  readonly code: number | null
  /** The watcher's own last word (`X|native-unavailable`), when it managed one. */
  readonly reason: string | null
  /** Consecutive failures INCLUDING this one - i.e. which restart of the current run this is. */
  readonly attempt: number
}

/**
 * The cause as one sentence, for the log line that carries it.
 *
 * It is a function rather than a template at each call site because the demoted path and the two
 * error paths must describe the same facts the same way - a reader grepping errors.log and a
 * reader watching dev stdout are reading about one mechanism, and the whole point of the demotion
 * is that moving a line between sinks does not change what it says.
 */
export function describeRestartCause(cause: WatcherRestartCause): string {
  const said = cause.lastRecord === null ? 'never said anything' : `last said \`${cause.lastRecord}\``
  const code = cause.code === null ? '' : `, exit code ${String(cause.code)}`
  const reason = cause.reason === null ? '' : `, reason \`${cause.reason}\``
  return (
    `presence watcher restart (${cause.trigger}): ${said}, silent for ` +
    `${String(cause.silentMs)} ms, alive for ${String(cause.lifetimeMs)} ms${code}${reason}; ` +
    `attempt ${String(cause.attempt)}`
  )
}

// ---------------------------------------------- the immediate-exit loop (JOS-164, JOS-182)
//
// A LOOP IS ONE FACT, AND IT WAS BEING REPORTED AS N FACTS. The error store's evidence for JOS-164
// was 245+ copies of `presence watcher exited unexpectedly` from ONE install over two days,
// still climbing — one every ~32 s, forever, because the child was reaping itself about a second
// after each spawn and the backoff was sitting on its 30 s ceiling. Every one of those entries said
// the same thing, none of them said the interesting thing, and the interesting thing is only
// visible from the SHAPE of the sequence: a clean exit (code 0) that keeps happening far inside the
// staleness window is not a watcher that keeps failing, it is a watcher that keeps DECIDING to
// stop.
//
// THIS FOLD OUTLIVED THE BUG THAT PRODUCED IT (JOS-182), and it was kept for a specific successor
// rather than out of sentiment. The self-reap is gone with the child process, but the machine that
// cannot run the watcher has not gone anywhere — it has only changed its excuse. Where PowerShell
// used to be missing, the native surface can be: a `koffi.load` that fails, an export Wine does
// not implement, an EDR product that refuses `EnumProcesses`. The worker's answer to all of those
// is to say why and exit cleanly in a few milliseconds, on every restart, forever. That is the
// same sequence with a different first cause, and it deserves the same one entry.
//
// So the parent recognizes the pattern and says it once. The first `WATCHER_QUICK_EXIT_STREAK - 1`
// exits are reported as they always were — a single fast clean exit really can be a one-off, and
// silencing it would trade this bug for a quieter one. The exit that completes the streak carries a
// DIFFERENT error name, which is what makes it a distinct fingerprint in the error store
// (`errorFingerprint` hashes the name and the frames, never the message), and every later exit in
// the same run is not logged at all until something breaks the pattern.
//
// Pure, and folded rather than counted in place, so `tests/presenceHealth.test.mts` drives the
// whole sequence — including the part that must NOT fire — without a watcher anywhere.

/**
 * How many consecutive clean, sub-staleness-window exits it takes to call it a loop.
 *
 * THREE. It has to be more than one (a single fast exit is a one-off — a machine mid-suspend, a
 * library that lost a race with an antivirus scan — and reporting it is right) and more than two
 * (two in a row is a bad minute; the backoff's own first two steps are 1 s and 2 s, so two failures
 * can be inside three seconds of one hiccup). Three consecutive is the first count that can only be
 * produced by a condition that is not clearing, and it costs the store two ordinary entries before
 * the diagnosis instead of one — cheap, and those two are the exemplars a reader wants anyway. It
 * is deliberately NOT tuned against the observed 245: any N in this range collapses that to one.
 */
export const WATCHER_QUICK_EXIT_STREAK = 3

/**
 * The `name` the collapsed entry carries, and the whole reason it is a separate row in the error
 * store rather than a 246th copy of the old one. `shared/errorReport.ts errorFingerprint` hashes
 * the error NAME plus the top frames — never the message — so a distinct diagnosis needs a distinct
 * name, and `errorNameOf` accepts exactly this shape (identifier, ≤64 chars).
 *
 * It is a NEW name rather than JOS-164's `PresenceSelfReapLoop`, deliberately: the old rows in the
 * error store describe a child process that no longer exists, and folding a different diagnosis
 * into their fingerprint would make the two indistinguishable in the one view where telling them
 * apart is the entire point.
 */
export const WATCHER_EXIT_LOOP_ERROR_NAME = 'PresenceWatcherExitLoop'

/** What the watcher's exit trail knows: how long the current streak of immediate clean exits is,
 *  and whether the one collapsed diagnosis has already been written for it. */
export interface WatcherExitTrail {
  readonly streak: number
  readonly collapsed: boolean
}

export const NEW_WATCHER_EXIT_TRAIL: WatcherExitTrail = { streak: 0, collapsed: false }

/**
 * The payload `presence.ts` hands to `logError`, or null when this exit is inside a run that has
 * already been diagnosed. Every field is here because a reader of errors.log asked for it.
 *
 * IT IS THE CAUSE PLUS A SENTENCE (JOS-310). The fold used to build its own three-field record
 * (`code`, `lifetimeMs`, `reason`) out of a `WatcherExitFacts` that carried exactly those three;
 * the cause above is a superset of it, so the fold now takes and re-emits the whole thing. That is
 * what puts `lastRecord`, `silentMs` and `attempt` into the error store's exemplar for an exit —
 * the store's residual presence rows are the ones that survive the demotion, so they are the rows
 * that have to be diagnosable on their own.
 */
export interface WatcherExitLog extends WatcherRestartCause {
  readonly message: string
  /** Set only on the collapsed entry — see `WATCHER_EXIT_LOOP_ERROR_NAME`. */
  readonly name?: string
  /** Set only on the collapsed entry: how many exits in a row got us here. */
  readonly exits?: number
}

export interface WatcherExitStep {
  readonly trail: WatcherExitTrail
  readonly log: WatcherExitLog | null
}

/**
 * Is this exit SHAPED like a watcher that decided to stop? Clean (code 0) and gone well inside the
 * window a healthy watcher is expected to be talking for. A non-zero code is something THROWING,
 * which is a different story and gets the ordinary report; an exit after a long healthy run is a
 * watcher that was running fine until it wasn't.
 */
function quickCleanExit(cause: WatcherRestartCause, staleMs: number): boolean {
  return cause.code === 0 && cause.lifetimeMs >= 0 && cause.lifetimeMs < staleMs
}

/**
 * Fold one dead watcher into the trail and say what to log.
 *
 * ANY exit that is not quick-and-clean RESETS the trail — including a healthy watcher that finally
 * outlived the window — so a machine that hiccups once an hour never accumulates its way into the
 * collapsed state, and a machine that is fixed starts reporting normally again from the next
 * failure.
 */
export function watcherExitStep(
  trail: WatcherExitTrail,
  cause: WatcherRestartCause,
  streakToCollapse: number = WATCHER_QUICK_EXIT_STREAK,
  staleMs: number = WATCHER_STALE_MS
): WatcherExitStep {
  if (!quickCleanExit(cause, staleMs)) {
    return {
      trail: NEW_WATCHER_EXIT_TRAIL,
      log: { message: 'presence watcher exited unexpectedly', ...cause }
    }
  }
  // Already diagnosed: the pattern is unchanged, so there is nothing new to say. The streak is
  // held (not incremented) so the number can never run away on a session that lasts all day.
  if (trail.collapsed) return { trail, log: null }
  const streak = trail.streak + 1
  if (streak < streakToCollapse) {
    return {
      trail: { streak, collapsed: false },
      log: { message: 'presence watcher exited unexpectedly', ...cause }
    }
  }
  return {
    trail: { streak, collapsed: true },
    log: {
      name: WATCHER_EXIT_LOOP_ERROR_NAME,
      message:
        `presence watcher exit loop: ${String(streak)} consecutive clean exits inside the ` +
        `${String(staleMs)} ms staleness window. The watcher keeps starting and stopping itself ` +
        '(see `reason`); overlay auto-hide and the cursor ring are dead for this session. ' +
        'Further identical exits are counted by the restart backoff, not logged.',
      exits: streak,
      ...cause
    }
  }
}

// ------------------------------------------------------------------ the worker's own settings
//
// What main bakes into the watcher at start. It used to be interpolated into a PowerShell script
// (JOS-164's `watcherScript(root, cadence, parentPid)`); it is now `workerData` on a thread, which
// is the same three facts with none of the quoting rules. The parent pid is not among them: a
// worker thread cannot be orphaned, so there is nobody to watch.

/**
 * THE ONLY SAFE WAY TO END A LIVE WATCHER, and the reason it is a protocol message rather than a
 * `worker.terminate()` call is a REPRODUCED CRASH, not a preference.
 *
 * MEASURED (JOS-182, this machine, plain Node with no Electron and no test harness in the way):
 * terminating a worker thread WHILE IT IS INSIDE A koffi CALL takes the whole process down —
 * `FATAL ERROR: Error::ThrowAsJavaScriptException napi_throw`, an abort, no catch anywhere. V8's
 * termination lands while the addon is mid-call, and the exception it then tries to raise has
 * nowhere to go. Terminating an IDLE worker is fine: 40/40 rounds survived. Terminating one
 * running the app's real 5 s scan cadence crashed within two.
 *
 * The watcher is inside a native call for a small fraction of its life (~8.4 ms of every 5 s, plus
 * microseconds per tick), so this would have been a rare, unattributable crash AT QUIT — the worst
 * possible shape of bug, and one the app quits into on every single session.
 *
 * So main asks instead. A `'message'` handler on the worker's port can only run BETWEEN ticks, by
 * construction — the loop is synchronous inside a timer callback, so the event loop is never in a
 * position to deliver a message while a call is in flight. The worker clears its interval, closes
 * its port, and the thread ends on its own with code 0.
 */
export const WATCHER_STOP_MESSAGE = 'stop'

export interface PresenceWorkerInit {
  /** `<eq install root>\` — a separator-terminated prefix, or '' to disable path matching. */
  readonly eqRootWithSep: string
  /** ms between process-existence scans (and therefore between heartbeats). */
  readonly runningPollMs: number
  /** ms the loop asks to sleep between ticks. */
  readonly tickMs: number
  /** how many ticks between the expensive foreground/running block. */
  readonly foregroundEveryTicks: number
  /**
   * May this watcher call `GetCursorInfo` AT ALL? (JOS-193.)
   *
   * FALSE MEANS NEVER, not "poll it more slowly": the worker's cursor block is skipped entirely,
   * so no `C` line is ever emitted and the one Win32 cursor call in the application is never
   * reached. It is baked in at start rather than sent as a message because a `false` that arrives
   * one tick late is still a tick in which the app touched a cursor it had been told to leave
   * alone — `presence.ts` replaces the thread when the setting changes instead.
   */
  readonly watchCursor: boolean
}

/**
 * The two clock settings, DERIVED from whether the cursor is being watched (JOS-193).
 *
 * The fast tick exists for ONE call. Everything above is the split-cadence argument: `cursorShowing`
 * is 0.43 us and gates an 8 ms consumer, so it runs at the platform's floor while the expensive
 * foreground/running block rides every tenth tick. Take the cursor call away and the fast tick is
 * a timer that fires 69 times a second to decrement a counter — the loop has nothing to do 9 ticks
 * out of 10, and the tenth is work that was always on a ~160 ms clock.
 *
 * So a cursor-free watcher asks for the coarse cadence DIRECTLY: one tick per foreground block, at
 * the period ten floor-ticks measured at anyway. That is the single-cadence loop this file records
 * at 0.06-0.16 % of one core, against 0.19-0.31 % for the split one — i.e. the default install
 * (auto-hide on, ring off) gets the cheaper loop back, and the split cadence is paid for only by
 * the feature that asked for it.
 *
 * Pure, so `tests/presence.test.mts` pins it rather than anyone re-deriving it from three constants.
 */
export function watcherCadence(watchCursor: boolean): {
  tickMs: number
  foregroundEveryTicks: number
} {
  if (watchCursor) {
    return { tickMs: WATCHER_TICK_MS, foregroundEveryTicks: FOREGROUND_EVERY_TICKS }
  }
  return { tickMs: WATCHER_TICK_FLOOR_MS * FOREGROUND_EVERY_TICKS, foregroundEveryTicks: 1 }
}
