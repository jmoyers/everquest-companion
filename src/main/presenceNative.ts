// ============================================================================
// presenceNative.ts — the Win32 surface the presence watcher reads, IN PROCESS.
// ============================================================================
//
// This file replaces the whole of `presenceWatcherScript.ts` (JOS-182): a `powershell.exe`
// child, launched with `-ExecutionPolicy Bypass -EncodedCommand <base64>`, that compiled a C#
// P/Invoke surface at runtime with `Add-Type` and then polled it. Every question it answered is
// answered here instead, by calling the same exported symbols directly from this process.
//
// ---------------------------------------------------------------------------------------------
// WHY THE CHILD HAD TO GO. Two independent failures, one shape.
// ---------------------------------------------------------------------------------------------
//   * IT LOOKED LIKE MALWARE, because to a behavioural engine it was indistinguishable from it.
//     A hidden `powershell.exe` with a base64 command line and an execution-policy bypass, which
//     compiles code at runtime, enumerates every process on the machine and reads foreground
//     window titles, is the textbook infostealer profile (the IDP.HELU family). Avast was
//     reported flagging this app every ten seconds. Nothing about the intent was visible to the
//     scanner; only the shape was, and the shape was wrong.
//   * IT DID NOT ALWAYS RUN AT ALL. 578 `spawn powershell.exe ENOENT` errors across two cohorts:
//     machines where PowerShell is removed, renamed, blocked by policy, or simply not on PATH for
//     the app's environment. Those installs had no overlay auto-hide and no cursor ring for every
//     session, forever, and (fail-open being what it is) nobody noticed enough to report it.
//     A Wine prefix is the same story by default — see the Wine note at the foot of this file.
//
// Both are properties of SPAWNING A PROCESS TO ASK A QUESTION. So the process is gone: these are
// ordinary calls into user32/kernel32/psapi from the app's own address space, which is what every
// Windows program that has ever asked "which window is in front" does.
//
// ---------------------------------------------------------------------------------------------
// WHY koffi AND NOT AN N-API ADDON OF OUR OWN.
// ---------------------------------------------------------------------------------------------
// The alternative was ~250 lines of C++ behind a `binding.gyp`, compiled in CI. It was rejected
// on this tree's own established rules, not on taste:
//
//   * `.npmrc` sets `ignore-scripts=true` and `electron-builder.yml` sets `npmRebuild: false`,
//     and the note beside that flag states the rule this project actually operates by: a native
//     dependency is acceptable when it ships PREBUILT N-API binaries inside its npm tarball, and
//     needs the flags flipped when it ships node-gyp sources. koffi 2.x ships prebuilts for
//     eighteen platforms in the tarball itself and needs no install script, no node-gyp, no
//     Python and no MSVC (VERIFIED: extracted with scripts ignored, loaded, called). An in-tree
//     addon would ship sources and need all four.
//   * A CI-only compile means the addon does not exist in `npm run dev`, in `npm test`, or in a
//     local `npm run dist`. Presence would be permanently degraded everywhere except a release
//     build — which is to say, degraded everywhere it is developed and tested, and live only
//     where nobody can attach a debugger to it. That is a worse deal than the one being fixed.
//   * N-API means koffi's binary is ABI-stable across Electron upgrades, so it never needs the
//     `@electron/rebuild` step that `npmRebuild: false` exists to keep out of this build.
//
// The cost of the choice, stated plainly: koffi is a general FFI engine, so the app now carries
// the ability to call any exported C function rather than only the ten below. That is a real
// widening and it is why every call in this file is declared once, here, with its own comment —
// this module is the entire Win32 surface of the application, and a reviewer can read all of it.
// (koffi's own runtime-codegen path is for JS CALLBACKS called from C; nothing here registers
// one, so no executable memory is ever allocated on our behalf.)
//
// ---------------------------------------------------------------------------------------------
// WHAT SURVIVED THE MOVE, family by family.
// ---------------------------------------------------------------------------------------------
// The C# had five. Four are here verbatim, because they were already the right calls — JOS-164
// had rewritten them to ask the KERNEL about a handle rather than .NET about its process table,
// and that rewrite is exactly what ports:
//
//   1. FOREGROUND WINDOW — GetForegroundWindow + GetWindowThreadProcessId + GetWindowRect +
//      GetWindowTextW.
//   2. CURSOR VISIBILITY — GetCursorInfo. The one call that runs every tick (JOS-120).
//   3. IMAGE PATHS — OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION) + QueryFullProcessImageNameW.
//   4. THE RUNNING SCAN — EnumProcesses, then (3) over the result.
//
// The fifth is GONE, and could not survive: PARENT LIVENESS — OpenProcess(SYNCHRONIZE) +
// WaitForSingleObject — existed only so an ORPHANED CHILD could reap itself, because Windows does
// not kill children when their parent dies. The watcher is now a worker thread, and a thread
// cannot outlive its process. The self-reap, the `X|parent-gone` line, and the entire JOS-164
// loop it caused are all deleted rather than ported.
//
// ---------------------------------------------------------------------------------------------
// FAILURE DIRECTION IS ALWAYS "KEEP GOING", exactly as it was in the C#.
// ---------------------------------------------------------------------------------------------
// `cursorShowing()` answers true when the call fails (the ring is a display aid; a watcher that
// cannot see the cursor must not be the reason it disappears). `imagePath()` answers `''` when
// the kernel will not say. `eqRunning()` answers -1 when the enumeration itself failed, which the
// caller reads as "hold the last known value" rather than "the game vanished". Only
// `loadPresenceNative()` throws, once, at startup — and the worker turns that into one protocol
// line and one error-log entry rather than a retry storm.
//
// ---------------------------------------------------------------------------------------------
// WINE (JOS-31).
// ---------------------------------------------------------------------------------------------
// This is a strict improvement there and it is worth saying why. A Wine prefix normally has NO
// `powershell.exe` at all, so the old watcher's every spawn was an ENOENT — one of the sources of
// the 578 — and the feature was dead in a prefix by construction. koffi's `win32_x64` build is an
// ordinary PE, loaded in-process like any other module, and all ten symbols below are core
// user32/kernel32/psapi entry points that Wine implements. `EnumProcesses` reports Wine's own
// process list and window calls see the prefix's own desktop, which is the same horizon the
// PowerShell child had. NOT VERIFIED ON A REAL PREFIX — no Wine machine was available to this
// change — so the claim here is only that the failure mode is bounded: any missing symbol makes
// `koffi.load`/`func` throw at load, which is the ONE failure this module has, and it degrades to
// exactly the fail-open posture (`observed:false`: overlays visible, ring parked) that a prefix
// already had.

import * as koffi from 'koffi'
// The client's image name, imported rather than respelled: the running scan and the
// "is this window EverQuest" predicate must never disagree about what the game is called.
import { EQ_CLIENT_EXES } from './presenceProtocol'

/**
 * What the watcher can ask Windows. Deliberately four methods and no state: this module is a
 * translation layer, and every decision made from these answers lives in `presenceProtocol.ts`.
 */
export interface PresenceNative {
  /** Is the system cursor being drawn? A failed call answers TRUE — see the failure note above. */
  cursorShowing(): boolean
  /** The foreground window, or null when there is none (a locked session has no foreground). */
  foreground(): ForegroundWindow | null
  /** A process's full image path, or '' when the kernel will not say. */
  imagePath(pid: number): string
  /** 1 = an EverQuest client is running, 0 = none is, -1 = the enumeration itself failed. */
  eqRunning(rootWithSep: string): number
}

/** One reading of the foreground window. `exePath` is filled in by the caller's memo, not here. */
export interface ForegroundWindow {
  readonly pid: number
  readonly x: number
  readonly y: number
  readonly width: number
  readonly height: number
  readonly title: string
}

// ------------------------------------------------------------------ the typed FFI boundary
//
// koffi's `func()` hands back a signature of `(...args: any) => any`, which is honest — it cannot
// know what a string prototype means — and which would spray `no-unsafe-call` /
// `no-unsafe-assignment` across every line below. So it is narrowed ONCE, here, into a signature
// that says what is actually true at an FFI boundary: unknown in, unknown out. The three coercers
// underneath are what turn that back into a fact, and they are the only place in the application
// where a Win32 return value is interpreted.

type Win32Fn = (...args: unknown[]) => unknown

function bind(lib: koffi.IKoffiLib, prototype: string): Win32Fn {
  return lib.func(prototype)
}

/** A Win32 BOOL. Anything that is not literally `true` is a failure. */
function asBool(v: unknown): boolean {
  return v === true
}

/** A Win32 integer return. A non-number is a failure and reads as 0. */
function asInt(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) ? Math.trunc(v) : 0
}

/** A HANDLE. koffi hands back an opaque external for a non-null pointer and `null` for NULL. */
function isHandle(v: unknown): boolean {
  return v !== null && v !== undefined && v !== 0
}

// ---------------------------------------------------------------------------- struct layouts
//
// Every out-parameter below is a plain Buffer with hand-read offsets rather than a
// `koffi.struct`. That is a MEASURED choice, not an aesthetic one: `GetCursorInfo` through a
// declared struct costs 2.10 us per call because koffi builds a JS object for it every time,
// and through a Buffer it costs 0.43 us (50k calls each, this machine). That call runs on every
// tick — ~69 times a second — so it is the one place in this file where the difference is worth
// having, and doing it the same way everywhere keeps one idiom instead of two.

/** RECT: left, top, right, bottom — four int32. */
const RECT_BYTES = 16
/** CURSORINFO on x64: cbSize(4) flags(4) hCursor(8, aligned) ptScreenPos(8) = 24. */
const CURSORINFO_BYTES = 24
/** CURSORINFO.flags is a BIT FIELD; CURSOR_SHOWING is bit 0. The test is `& 1`, never `!= 0` —
 *  CURSOR_SUPPRESSED (0x2) is set on touch-input machines with the pointer still drawn. */
const CURSOR_SHOWING = 0x1

/** Window titles: 512 UTF-16 code units, which is what the C# StringBuilder asked for. */
const TITLE_CHARS = 512
/** Image paths: 1024 UTF-16 code units. Longer than MAX_PATH on purpose (\\?\ paths exist). */
const PATH_CHARS = 1024

const PROCESS_QUERY_LIMITED_INFORMATION = 0x1000
/** EnumProcesses' pid buffer. 4096 processes is far past any real desktop; the call reports how
 *  much it wanted, and a truncated answer is clamped rather than trusted. */
const MAX_PIDS = 4096

// -------------------------------------------------------------------------------- the loader

/**
 * Open the three system libraries and declare the ten calls. THROWS if any of it fails, which is
 * the whole error path of this module: a missing DLL, a missing export, or a koffi binary that
 * will not load on this machine (or in this Wine prefix) all land here, once, at startup.
 *
 * Called from the presence WORKER only — main never loads koffi, so a failure cannot take the
 * app's own thread with it.
 */
export function loadPresenceNative(): PresenceNative {
  const user32 = koffi.load('user32.dll')
  const kernel32 = koffi.load('kernel32.dll')
  const psapi = koffi.load('psapi.dll')

  // ---- (1) the foreground window ----
  const GetForegroundWindow = bind(user32, 'void *__stdcall GetForegroundWindow()')
  const GetWindowThreadProcessId = bind(
    user32,
    'uint32 __stdcall GetWindowThreadProcessId(void *hWnd, _Out_ uint32 *pid)'
  )
  const GetWindowRect = bind(user32, 'bool __stdcall GetWindowRect(void *hWnd, _Out_ void *rect)')
  const GetWindowTextW = bind(
    user32,
    'int __stdcall GetWindowTextW(void *hWnd, _Out_ void *buf, int max)'
  )

  // ---- (2) cursor visibility ----
  const GetCursorInfo = bind(user32, 'bool __stdcall GetCursorInfo(_Inout_ void *pci)')

  // ---- (3) image paths, by handle rather than by .NET's process table (JOS-164) ----
  const OpenProcess = bind(
    kernel32,
    'void *__stdcall OpenProcess(uint32 access, bool inherit, uint32 pid)'
  )
  const CloseHandle = bind(kernel32, 'bool __stdcall CloseHandle(void *h)')
  const QueryFullProcessImageNameW = bind(
    kernel32,
    'bool __stdcall QueryFullProcessImageNameW(void *h, uint32 flags, _Out_ void *buf, _Inout_ uint32 *size)'
  )

  // ---- (4) the running scan ----
  const EnumProcesses = bind(
    psapi,
    'bool __stdcall EnumProcesses(_Out_ void *ids, uint32 cb, _Out_ uint32 *needed)'
  )

  // Scratch buffers, allocated ONCE. The tick loop must not allocate: it runs ~69 times a second
  // for the life of the app, and a per-tick Buffer is 69 garbage objects a second for nothing.
  const rectBuf = Buffer.alloc(RECT_BYTES)
  const cursorBuf = Buffer.alloc(CURSORINFO_BYTES)
  const titleBuf = Buffer.alloc(TITLE_CHARS * 2)
  const pathBuf = Buffer.alloc(PATH_CHARS * 2)
  const pidBuf = new Uint32Array(MAX_PIDS)
  const pidOut = [0]
  const sizeInOut = [0]

  function cursorShowing(): boolean {
    // cbSize is rewritten every call: GetCursorInfo reads it, and a stale or zero value makes the
    // call fail. It is four bytes.
    cursorBuf.writeUInt32LE(CURSORINFO_BYTES, 0)
    if (!asBool(GetCursorInfo(cursorBuf))) return true
    return (cursorBuf.readUInt32LE(4) & CURSOR_SHOWING) !== 0
  }

  function foreground(): ForegroundWindow | null {
    const hWnd = GetForegroundWindow()
    if (!isHandle(hWnd)) return null
    pidOut[0] = 0
    GetWindowThreadProcessId(hWnd, pidOut)
    rectBuf.fill(0)
    GetWindowRect(hWnd, rectBuf)
    const left = rectBuf.readInt32LE(0)
    const top = rectBuf.readInt32LE(4)
    const right = rectBuf.readInt32LE(8)
    const bottom = rectBuf.readInt32LE(12)
    // The return is the character count written, so the decode never scans for a terminator.
    const chars = asInt(GetWindowTextW(hWnd, titleBuf, TITLE_CHARS))
    const clamped = Math.min(Math.max(chars, 0), TITLE_CHARS)
    return {
      pid: pidOut[0],
      x: left,
      y: top,
      width: right - left,
      height: bottom - top,
      title: titleBuf.toString('utf16le', 0, clamped * 2)
    }
  }

  function imagePath(pid: number): string {
    // PROCESS_QUERY_LIMITED_INFORMATION is the modern replacement for opening a process just to
    // read `.MainModule.FileName`: it is granted for nearly everything, so this answers MORE
    // often than the .NET path ever did and costs less (JOS-164).
    const h = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid)
    if (!isHandle(h)) return ''
    try {
      sizeInOut[0] = PATH_CHARS
      if (!asBool(QueryFullProcessImageNameW(h, 0, pathBuf, sizeInOut))) return ''
      const chars = Math.min(Math.max(sizeInOut[0], 0), PATH_CHARS)
      return pathBuf.toString('utf16le', 0, chars * 2)
    } finally {
      CloseHandle(h)
    }
  }

  function eqRunning(rootWithSep: string): number {
    const needed = [0]
    if (!asBool(EnumProcesses(pidBuf, MAX_PIDS * 4, needed))) return -1
    const count = Math.min(Math.floor(needed[0] / 4), MAX_PIDS)
    const root = rootWithSep.toLowerCase()
    for (let i = 0; i < count; i++) {
      const pid = pidBuf[i]
      if (pid === 0) continue
      const path = imagePath(pid).toLowerCase()
      if (path.length === 0) continue
      const cut = path.lastIndexOf('\\')
      if (EQ_CLIENT_EXES.has(cut < 0 ? path : path.slice(cut + 1))) return 1
      if (root.length > 0 && path.startsWith(root)) return 1
    }
    return 0
  }

  return { cursorShowing, foreground, imagePath, eqRunning }
}
