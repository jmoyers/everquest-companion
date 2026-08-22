// feedback/achievements.ts — package the current `/outputfile achievements` dump as a report
// attachment (JOS-441).
//
// ============================ THE ONE RULE ============================
// THE DUMP IS OPENED READ-ONLY AND IS NEVER WRITTEN TO. `readFile(path)` and `stat(path)`, and
// that is the entire filesystem surface of this module. The file belongs to the game and to the
// player; the app is a guest in it, exactly as it is in the log and in the inventory dump.
// ======================================================================
//
// ---------------------------------------------------------------------------------------------
// WHY THERE IS A THIRD ATTACHMENT AT ALL
// ---------------------------------------------------------------------------------------------
// v1.7.0 shipped the achievements import (JOS-429) and three reports arrived within hours, from at
// least two users, all saying the same thing: Sky quests they had never run came back "Turned in"
// after `/outputfile achievements`. Every one of those reports carried a log slice and an inventory
// export, and NEITHER could answer the question — the log holds one line about the command (the
// `Outputfile Complete:` receipt) and nothing about its contents, and the inventory says what is in
// a bag, not what the server thinks was earned. The whole defect lived inside a file nothing sent.
//
// JOS-441's fix reads two boilerplate pseudo-rows to tell a granted class unlock from an earned
// one, and HALF OF THAT IS STILL AN ASSUMPTION: the confirm row is measured on the owner's own
// dump, the token row has never been observed complete because no token-user's export exists to
// read. This attachment is how one arrives. That is the honest statement of what it is for — not
// "more data is nice", but one specific unanswered question and the one file that answers it.
//
// ---------------------------------------------------------------------------------------------
// THE SCRUB QUESTION, ANSWERED BY READING THE FORMAT — the JOS-296 sweep, re-run for this kind
// ---------------------------------------------------------------------------------------------
// `inventory.ts`'s header ends by naming its own precondition: a FUTURE DUMP KIND must re-do the
// sweep rather than inherit the finding. So it was re-done, end to end, over the committed
// `tests/fixtures/Primitive_freeport-Achievements.txt` (64,539 bytes, 1,884 lines) and its
// synthesized sibling. What is in the file:
//
//   * a one-field CATEGORY header (`Untapped Potential: Classes`, `EverQuest: Raids`, …), 26 of
//     them, then TAB-indented rows beneath it;
//   * a two-field ACHIEVEMENT row — a one-letter status (`C`/`I`) and the achievement's name;
//   * three- and four-field COMPONENT rows — the status, an ALWAYS-EMPTY indent column, the
//     requirement text, and (only under the three `Slayer:` categories) an `<n>/<m>` counter.
//
// The shape is exactly that and nothing else: 26 / 501 / 1,251 / 106 rows of those four shapes,
// every indent column empty, longest line 112 characters.
//
// AND WHAT THE SWEEP LOOKED FOR AND DID NOT FIND: no chat of any kind (no tells, says, shouts,
// auctions), no timestamps, no `/who` rows, no zone lines, no coordinates, no filesystem paths, no
// URLs, no e-mail-shaped text, and not one byte outside printable ASCII + TAB/CR/LF. Checked
// explicitly and separately: THE CHARACTER NAME APPEARS NOWHERE IN THE CONTENTS. It is in the
// FILENAME only (`Primitive_freeport-Achievements.txt`), which is why `AchievementsDumpMeta`
// deliberately does not carry it.
//
// THE TWO THINGS THE SWEEP DID TURN UP, AND WHY NEITHER IS A FINDING:
//   * two quoted strings — `Complete the 'Aid the Kerrans of Kerra Isle' Task.` and `Complete the
//     'Renouncing Your Faith' task for a mysterious Emissary.` — both TASK TITLES the game wrote
//     inside its own requirement sentence, not speech somebody typed. Apostrophes elsewhere are
//     possessives in item and NPC names (`Ton Po's Eye Patch`), the same class of hit the
//     inventory sweep recorded and dismissed for the same reason. The test asserts the exact
//     pair, so a THIRD one is news that has to be read before this paragraph survives it.
//   * the word `Freeport`, which is the CITY in achievement names (`Race Unlock - Human
//     (Freeport)`, `East Freeport Traveler`) and not the server. The dev character's server
//     happens to share the name, which is precisely why this was checked rather than assumed: the
//     hit is on the game's own place names and would be there on any server.
//
// SO THE SLICE SCRUBBER IS NOT RUN HERE EITHER, on this file's own evidence rather than on its
// sibling's. `tests/feedbackAchievements.test.mts` re-derives the whole sweep as an executable
// test, so a client patch that starts writing free text into this dump fails a build instead of
// quietly shipping it. The OWNER side still sanitizes control characters out of the copy it keeps
// (`src/main/triage/rows.ts sanitizeAchievements`) — the same third leg both other attachments have.
//
// ---------------------------------------------------------------------------------------------
// Electron-free and path-parameterized, like `inventory.ts` and `slice.ts`: the test drives the
// whole pipeline against temp files, and the resolution of WHICH dump belongs to the active
// character stays in `submit.ts`, where the registry and the store live.

import { createHash } from 'node:crypto'
import { readFile, stat } from 'node:fs/promises'
import { gzipSync } from 'node:zlib'
import {
  MAX_ACHIEVEMENTS_LINES,
  MAX_UPLOAD_BYTES,
  type AchievementsDumpMeta,
  type InventoryUnavailable
} from '../../shared/feedback'
import { dumpLines, previewOfDump, MAX_DUMP_READ_BYTES } from './inventory'

/** A packaged dump: the metadata for the JSON body, the gz for S3, the text, and the preview. */
export interface AchievementsAttachment extends AchievementsDumpMeta {
  readonly ok: true
  /** The bytes the presigned POST uploads. */
  readonly gz: Buffer
  /** The complete dump text — exactly what `gz` is the gzip of. */
  readonly text: string
  readonly previewLines: string[]
  readonly truncatedPreview: boolean
  /** The dump's file name (never its directory). Shown in the dialog; never sent. */
  readonly fileName: string
}

/** Either a packaged dump or the NAMED reason there is none. */
export type AchievementsResult =
  | AchievementsAttachment
  | { readonly ok: false; readonly reason: InventoryUnavailable }

const refuse = (reason: InventoryUnavailable): AchievementsResult => ({ ok: false, reason })

/**
 * Package the dump at `path` for upload. Never throws — every failure is a named reason, because
 * the dialog has to SAY which nothing it is looking at.
 *
 * THE ORDER AND THE HELPERS ARE THE INVENTORY'S, IMPORTED RATHER THAN RETYPED. `dumpLines` and
 * `previewOfDump` are decisions about "a tabular export we are about to show somebody", not about
 * items: interior blank lines are kept (this file has none, and a filter that would have dropped
 * them is still the wrong filter), and the preview is head-only because a tree read from the top
 * gives its useful rows first. The ROW CAP is this kind's own, and the byte cap is shared.
 */
export async function buildAchievementsAttachment(
  path: string,
  fileName: string
): Promise<AchievementsResult> {
  let updatedAt: number
  let rawBytes: number
  try {
    const st = await stat(path)
    // A regular file or nothing — a directory stats fine and reports size 0 on Windows, so the
    // isFile check has to come before the size one (inventory.ts argues it at length).
    if (!st.isFile()) return refuse('unreadable')
    updatedAt = Math.floor(st.mtimeMs)
    rawBytes = st.size
  } catch {
    return refuse('no-dump')
  }
  if (rawBytes <= 0) return refuse('empty')
  if (rawBytes > MAX_DUMP_READ_BYTES) return refuse('too-large')

  let text: string
  try {
    text = await readFile(path, 'utf8')
  } catch {
    return refuse('unreadable')
  }

  const lines = dumpLines(text)
  if (lines.length === 0) return refuse('empty')
  if (lines.length > MAX_ACHIEVEMENTS_LINES) return refuse('too-large')

  const gz = gzipSync(Buffer.from(text, 'utf8'), { level: 9 })
  if (gz.length > MAX_UPLOAD_BYTES) return refuse('too-large')

  return {
    ok: true,
    bytes: gz.length,
    lines: lines.length,
    updatedAt,
    sha256: createHash('sha256').update(gz).digest('hex'),
    gz,
    text,
    fileName,
    ...previewOfDump(lines)
  }
}

/** The metadata half of a packaged dump — what travels in the JSON body. */
export function achievementsMeta(dump: AchievementsAttachment): AchievementsDumpMeta {
  const { bytes, lines, updatedAt, sha256 } = dump
  return { bytes, lines, updatedAt, sha256 }
}
