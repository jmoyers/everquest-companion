// ============================================================================
// serveLogs.ts — WHICH CHARACTERS THIS INSTALL HAS, ASKED OF THE ENGINE (JOS-498).
// ============================================================================
//
// Owner ruling 21: the server owns log-file facts, and log DISCOVERY migrates server-side —
// launch-time character choice becomes a served answer. Decision sheet 1a settles the half the
// ruling left open: THE APP NAMES THE DIRECTORY. So the app pushes `logs.setDir` (engineClientHost)
// and asks `logs.list` here, and the two ends read the SAME setting by construction — the push
// carries `eqLogsDir()` and the echo test below compares the answer against `eqLogsDir()` again.
//
// ── WHY THIS IS A FILE AND NOT TWO MORE FUNCTIONS IN `serveShim.ts` ────────────────────────────
//
// Two reasons, and the second is the load-bearing one.
//
//   * THE READINESS IS A DIFFERENT QUESTION. `serveShim.ts` is built on `engineServeReadiness`,
//     which asks four things because every channel over there reads a FOLD: is there a client, is
//     the connection up, are the two processes on the SAME LOG, and has that log's fold gone live.
//     `logs.list` names no log. It enumerates a folder, and the launch it matters most on is the one
//     where NOTHING is attached — a fresh install has characters to choose between before there is
//     anything to fold. Asking the four-part question here would refuse every answer this channel
//     exists to give, for reasons that have nothing to do with it. So this file takes
//     `engineConnectedReadiness` and says why, once, rather than adding a per-call exception to a
//     file whose header promises there is only one readiness.
//   * `serveShim.ts` IS AT THE MEASURED CEILING. It is a 400-line file against a 400-line rule
//     (eslint.config.mjs, thresholds measured rather than guessed), and the repo's law when a file
//     reaches one is SPLIT, never ratchet.
//
// ── THE DEGRADE IS THE DELETION RELEASE'S, AND IT IS A REAL ARM HERE ───────────────────────────
//
// Every other served channel degrades to an EMPTY SHAPE, because the app-side fold it used to fall
// back to is deleted. This one degrades to a REAL ANSWER: `listCharacters()` survived JOS-499 on
// purpose — launch-time character choice has to work before any engine exists — so a launch with no
// engine, a connection still opening, or an engine that has not been told the directory yet all get
// the app's own readdir. That is not a compatibility shim, it is the honest arm of a question the
// app can always answer for itself, and it is why the boot order below is fine.
//
// ── WHICH CALLERS ASK, AND WHICH DELIBERATELY DO NOT ───────────────────────────────────────────
//
// ASK: `character:list` (the picker's rows) and `session.ts`'s launch-time / dir-change resolution.
// Those are "who could the user be playing", which is the question ruling 21 moved.
//
// DO NOT ASK, each for its own reason:
//   * `character:set`'s `listCharacters().find(...)` — a path→ref lookup on the SWITCH hot path,
//     already guarded by a `parseLogName` fallback. A round trip there would put the socket between
//     a dropdown click and the attach for a row the caller is holding the path of.
//   * `switchNudge.ts sampleLogs()` — a poll that runs on a timer and asks whether a SIBLING file is
//     growing. It is a question about bytes, not about a picker, and one round trip per tick buys
//     nothing.
//   * `telemetry/setupSnapshot.ts` — a count in a diagnostic, taken inside `safely()`. A snapshot
//     that could block on a socket is a snapshot that can fail to be taken.
//
// AND ON A COLD LAUNCH THE FIRST RESOLUTION DEGRADES BY CONSTRUCTION. `index.ts` calls
// `startTailing()` before `startEngineSupervisor()`, and the supervisor is asynchronous end to end
// (spawn, announce, health probe, connect) — so the very first character choice of a launch is
// answered by the app's own read, every time. That is exactly the arm the deletion release kept
// `listCharacters` for, stated here so nobody reads the fallback tally at boot as a defect. Every
// LATER resolution — the picker's rows on mount, a re-list after a settings change, the idle rescan
// that follows `/log on` — happens with the engine connected and is served.

import { logInfo } from '../errorLog'
import { engineConnectedReadiness, engineRequest } from './engineClientHost'
import { eqLogsDir } from '../log/config'
import { projectCharacterList } from './logsRows'
import { createReadShim, type ReadShim } from './readShim'
import type { CharacterRef } from '../../shared/types'

/**
 * How long the engine arm may take. The same two seconds every other loopback bound in this program
 * uses, and for the same reason: a round trip to a process on this machine either answers
 * immediately or is not going to. It is a bound on the pathological case, never a budget — the work
 * behind it is one readdir and a stat per file.
 */
const SERVE_TIMEOUT_MS = 2_000

/** How often the coalesced fallback sentence may be printed. `serveShim.ts`'s number, for its
 *  reasons: long enough that a disconnected engine costs one line per five seconds, short enough
 *  that a developer sees the answer before alt-tabbing away. */
const NOTE_EVERY_MS = 5_000

/** A promise that resolves later without ever being the reason this process stays alive —
 *  `engineClientHost.ts`'s timer rule, restated for the deadline. */
function delay(ms: number): Promise<void> {
  return new Promise<void>((resolve) => {
    const handle = setTimeout(resolve, ms)
    handle.unref()
  })
}

/** Built on first use. A SECOND shim instance rather than a second method on the first one, because
 *  a shim IS its readiness and its tally — see the header. The two tallies are a feature: "the
 *  engine could not answer a fold read" and "the engine could not answer a folder question" are
 *  different sentences and are counted apart. */
let shim: ReadShim | null = null

function logsShim(): ReadShim {
  shim ??= createReadShim({
    readiness: engineConnectedReadiness,
    request: engineRequest,
    note: (line) => {
      logInfo(`[everquest-companion] ${line}`)
    },
    now: () => Date.now(),
    timeoutMs: SERVE_TIMEOUT_MS,
    noteEveryMs: NOTE_EVERY_MS,
    delay
  })
  return shim
}

/**
 * THE CHARACTERS IN THE EQ LOGS FOLDER, SERVED — `listCharacters()` moved to the process that owns
 * log files, with the app's own read as the arm that answers when it cannot.
 *
 * WHAT MAKES A REPLY AN ANSWER is `logsRows.ts projectCharacterList`, which is the whole of the
 * decision and is pure so it can be pinned: the directory echo that catches an engine still
 * enumerating the folder the app has been pointed away from, the one verdict that is not an answer,
 * and the field-by-field copy onto `CharacterRef`. Its header carries each argument.
 */
export function serveCharacterList(own: () => CharacterRef[]): Promise<CharacterRef[]> {
  // TAKEN ONCE, BEFORE THE ROUND TRIP, so the comparison is against the directory this app believed
  // in when it asked. Re-reading it after the await would compare the answer against a setting that
  // may have moved WHILE the request was in flight — which is the very race the echo test is for,
  // and it would resolve it the wrong way round.
  const asked = eqLogsDir()
  return logsShim().serve('logs.list', {}, (r) => projectCharacterList(asked, r), own)
}
