// graphics.ts — GRAPHICS SAFE MODE, decided at the only moment Electron will accept it (JOS-40).
//
// `app.disableHardwareAcceleration()` is a BEFORE-READY call: Electron reads it while assembling
// the GPU process and ignores it afterwards. So this module is invoked from the composition
// root's module scope — earlier than `whenReady`, earlier than the first window, and (by the
// import order index.ts documents) after channel.ts has chosen `userData` and store.ts has
// migrated and opened the settings file. That ordering is the whole reason a persisted switch can
// decide a flag that must be set before the app exists.
//
// TWO WAYS IN, ONE MECHANISM:
//
//   EQ_DISABLE_GPU=1  — one launch, no UI required. This is the door for the user whose window is
//                       black: they cannot open Preferences in an app they cannot see, and a
//                       support reply ("start it once with this set") has to work on the first
//                       try. It NEVER writes the setting — a diagnostic must not silently become
//                       a configuration.
//   the stored switch — Preferences → Graphics, from the next launch onward.
//
// A THIRD WAY IN ARRIVED WITH JOS-31, and it is the one nobody has to be told about: `wine.ts`
// looks at the machine, and a switch left on 'auto' follows what it finds. The env door stays the
// override of last resort and still wins over everything. What did NOT change is the sentence
// above it — this file still does not know what a Wine prefix is. It asks `graphicsAuto()` for two
// booleans, exactly as `resolveGraphics` does, and the knowledge lives in one module that can be
// tested without an Electron app.
//
// AND IT IS THE ONE PLACE THE THREE INPUTS MEET. Safe mode, opaque overlays and the Preferences
// card all resolve through `resolvedGraphics()` below, so "who wins — the user, the detection or
// the default" is answered once. A second opinion here would be a window built one way and a
// label describing another.
//
// FAILING TO READ THE SETTING IS NOT A REASON NOT TO BOOT. Every path is wrapped: a store that
// throws, or a filesystem that refuses the detection probe, leaves the app on hardware
// acceleration and see-through overlays (the defaults everyone else gets) with a line in
// errors.log — never a process that died deciding how to draw.

import { app } from 'electron'
import { logError, logInfo } from './errorLog'
import { getGraphicsPrefs } from './store'
import { graphicsAuto } from './wine'
import {
  DEFAULT_GRAPHICS_PREFS,
  GPU_ENV_VAR,
  NO_GRAPHICS_AUTO,
  envDisablesGpu,
  resolveGraphics,
  type ResolvedGraphics
} from '../shared/graphicsPrefs'

/**
 * The stored switches folded together with what this machine recommends — the ONE answer every
 * consumer reads (this file for safe mode, windows.ts for overlay transparency, ipc/graphics.ts
 * for the Preferences card).
 *
 * Total, and never throws: a store or a probe that fails degrades to "an ordinary machine with
 * nothing set", which is the state the overwhelming majority of installs are in anyway.
 */
export function resolvedGraphics(): ResolvedGraphics {
  try {
    return resolveGraphics(getGraphicsPrefs(), graphicsAuto())
  } catch (err) {
    logError('main:graphics', err)
    return resolveGraphics(DEFAULT_GRAPHICS_PREFS, NO_GRAPHICS_AUTO)
  }
}

/** Why safe mode is on for this launch — or null when it is not on. */
export type SafeModeSource = 'env' | 'user' | 'auto'

/**
 * Decide, from an environment, the stored switch and the detected machine, whether this launch
 * draws in software.
 *
 * The ENV WINS and is checked first, because it is the override of last resort: a user who has
 * been told to set it is a user for whom the stored value is either wrong or unreachable. Below
 * it, `resolvedGraphics()` applies the ordinary precedence — an explicit preference, then the
 * detection, then off.
 */
export function safeModeSource(env: NodeJS.ProcessEnv = process.env): SafeModeSource | null {
  if (envDisablesGpu(env)) return 'env'
  const { on, source } = resolvedGraphics().safeMode
  // `source` is never 'default' when `on` — a default that turned something on would not be one.
  return on ? (source === 'user' ? 'user' : 'auto') : null
}

/** Whether this process actually disabled hardware acceleration. Read by nothing but the log
 *  line below today; exported so a future diagnostic can state the launch's real mode rather
 *  than re-deriving it from a setting that may have been changed since. */
let safeModeActive: SafeModeSource | null = null

export function activeSafeMode(): SafeModeSource | null {
  return safeModeActive
}

/**
 * Apply graphics safe mode if this launch asked for it. Call ONCE, from module scope in the
 * composition root — after `ready` it is a no-op that Electron silently ignores, which is the
 * failure mode this file's placement exists to prevent.
 */
const SAFE_MODE_REASON: Record<SafeModeSource, string> = {
  env: `${GPU_ENV_VAR} is set`,
  user: 'Preferences → Graphics',
  // The one a support reply needs to be able to read back off a user's errors.log without asking
  // them what they clicked: nobody clicked anything.
  auto: 'detected automatically - see the wine: line above'
}

export function applyGraphicsSafeMode(): void {
  const source = safeModeSource()
  if (!source) return
  try {
    app.disableHardwareAcceleration()
    safeModeActive = source
    logInfo(
      `[everquest-companion] Graphics safe mode is ON for this launch (${SAFE_MODE_REASON[source]}): drawing without hardware acceleration.`
    )
  } catch (err) {
    logError('main:graphics', err)
  }
}
