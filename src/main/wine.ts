// main/wine.ts — the ten lines that hand `shared/wineDetect.ts` a real machine (JOS-31).
//
// The detection itself is pure and lives in shared/ with an injected probe, so it can be tested
// from an env fixture on a Windows box that is not the thing it describes. This file supplies
// `process` and `fs` and does one other job: it ANSWERS ONCE.
//
// WHY IT IS CACHED. The answer cannot change while the process runs — you do not move a running
// process into a Wine prefix — and it is asked from three places with very different timing: the
// composition root's MODULE SCOPE (before Electron is ready, deciding hardware acceleration), the
// window factory (every time an overlay is opened), and an IPC handler (whenever Preferences is
// shown). Re-probing the filesystem on every overlay open would be a syscall for a constant.
//
// AND IT NEVER THROWS. `existsSync` does not throw for a missing file, but it can for a path the
// OS refuses outright, and this runs before the app has a window to complain in. A probe that
// fails is read as "not Wine" — the answer that changes nothing about how the app draws — with a
// line in errors.log naming what happened.

import { existsSync } from 'fs'
import { logError, logInfo } from './errorLog'
import {
  detectWine,
  graphicsEnvironmentOf,
  type GraphicsEnvironment,
  type WineDetection
} from '../shared/wineDetect'
import type { GraphicsAuto } from '../shared/graphicsPrefs'

let cached: WineDetection | null = null

/** A single `existsSync` that cannot take the launch down with it. */
function fileExists(path: string): boolean {
  try {
    return existsSync(path)
  } catch (err) {
    logError('main:wine', err)
    return false
  }
}

/**
 * Is this process running inside a Wine prefix, and on what evidence? Computed once per launch.
 *
 * The log line is deliberately unconditional-on-detection rather than unconditional: an ordinary
 * Windows launch says nothing (that is 99% of launches and the answer is the boring one), and a
 * detected prefix states the signals — so a support reply can read the reason out of the user's
 * errors.log rather than asking them to describe their setup.
 */
export function wineDetection(): WineDetection {
  if (cached) return cached
  try {
    cached = detectWine({ platform: process.platform, env: process.env, fileExists })
  } catch (err) {
    logError('main:wine', err)
    cached = { wine: false, signals: [] }
  }
  if (cached.wine) {
    logInfo(
      `[everquest-companion] wine: running under Wine (${cached.signals.join(', ')}) - graphics ` +
        'switches left on auto take the compatibility path.'
    )
  }
  return cached
}

/** What this machine recommends for a switch left on 'auto' — the two booleans
 *  `resolveGraphics` folds against the stored prefs. */
export function graphicsAuto(): GraphicsAuto {
  return graphicsEnvironmentOf(wineDetection()).auto
}

/** The detection plus its recommendation, for the Preferences card (ipc/graphics.ts). */
export function graphicsEnvironment(): GraphicsEnvironment {
  return graphicsEnvironmentOf(wineDetection())
}
