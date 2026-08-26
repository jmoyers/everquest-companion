// ============================================================================
// logsRows.ts — WHEN A SERVED CHARACTER LIST IS AN ANSWER, AND WHAT IT BECOMES (JOS-498).
// ============================================================================
//
// `serveLogs.ts` is the wiring — the shim, the connection, the log sink. This is the DECISION it
// makes about a reply, split out on `readShim.ts`'s terms exactly and for its reason: the awkward
// cases are the point, and a file that imported `engineClientHost` (which imports the supervisor,
// which imports Electron) could not be driven by a `node:test` unit. Everything here is a pure
// function of one reply plus the directory the caller asked about, so the whole matrix —
// stale echo, three verdicts, an absent mtime — is pinned with no socket and no Rust binary
// (`tests/dataServerLogsRows.test.mts`).
//
// IT IMPORTS TYPES AND NOTHING ELSE, deliberately. The moment it imports a value it stops being
// testable and the decision goes back to being untestable wiring.

import type { LogsListResult } from '../../shared/dataServer/protocol.generated'
import type { CharacterRef } from '../../shared/types'

/**
 * ONE `logs.list` REPLY, AS THIS APP'S CHARACTER LIST — or `null` to say the reply was not an
 * ANSWER, which is `readShim.ts`'s signal to let the app's own read answer instead.
 *
 * ── THE DIRECTORY ECHO ─────────────────────────────────────────────────────────────────────────
 *
 * `logs.setDir` is pushed on connect and again whenever the setting moves, and both are
 * asynchronous — so there is a window in which the engine is still enumerating the folder the app
 * has just been pointed AWAY from, and its answer would be a picker full of another install's
 * characters. The reply echoes the directory it is about; one string compare closes the window. Same
 * test `module.snapshot`'s echoed `module` gets, same failure caught: a bookkeeping mismatch between
 * two processes wearing the right answer's clothes.
 *
 * COMPARED EXACTLY, never case-folded or normalized. The schema promises the echo is the pushed
 * string verbatim, and both ends of this comparison come from the same `eqLogsDir()` call in the
 * same process — so any difference at all is a difference that matters, and a tolerant compare would
 * be this function deciding two paths are the same install without being able to know it.
 *
 * ── `unreadable` IS NOT AN ANSWER; THE OTHER TWO ARE ───────────────────────────────────────────
 *
 * `missing` is real: there is no such folder, so there are no characters, and the app's own read
 * would say the identical thing one syscall later — falling back would cost a readdir to be told
 * what we were just told. `ok` with no rows is real too, and is the install where nobody has typed
 * `/log on`: the empty picker there is the correct picker, and it is what the empty state's advice
 * is attached to. But `unreadable` is the engine reporting that the directory refused IT — a
 * permission, a share violation, a disconnected mount — and none of those is necessarily true of
 * this process a moment later. So that one arm looks for itself rather than drawing an empty picker
 * over a folder that may be perfectly readable from here.
 *
 * ── THE ROWS ARE COPIED FIELD BY FIELD, NOT CAST ───────────────────────────────────────────────
 *
 * `LogCharacter` and `CharacterRef` carry the same four fields, so a cast would compile and work —
 * right up to the day one of them grows a field, at which point the mismatch would be silent. That
 * is `serveShim.ts engineOpts`'s argument read in the other direction, and the copy is what makes
 * the day it happens a compile error instead.
 *
 * ABSENT `lastPlayed` STAYS ABSENT. The schema omits it when the engine could not stat the file and
 * `CharacterRef` makes it optional for the identical reason: a zero would draw "last played 1970"
 * beside a real character name (`serveShim.ts graftLastPlayed` states the same rule for the attached
 * log's own mtime). Writing `lastPlayed: undefined` would be worse than either — the key would be
 * present, and `'lastPlayed' in ref` is a question a later reader may reasonably ask.
 */
export function projectCharacterList(
  askedAbout: string,
  reply: LogsListResult
): CharacterRef[] | null {
  if (reply.dir !== askedAbout) return null
  if (reply.readable === 'unreadable') return null
  return reply.characters.map((c) => ({
    name: c.name,
    server: c.server,
    logPath: c.logPath,
    ...(c.lastPlayed === undefined ? {} : { lastPlayed: c.lastPlayed })
  }))
}
