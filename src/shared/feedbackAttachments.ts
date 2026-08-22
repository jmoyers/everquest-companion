// ============================================================================
// shared/feedbackAttachments.ts — WHAT AN ATTACHED `/outputfile` DUMP IS, on the wire and in the
// dialog.
// ============================================================================
//
// SPLIT OUT OF feedback.ts FOR FILE MASS, NOT FOR SCOPE — the storePlans.ts rule, and the same
// answer: feedback.ts sits at the measured 400-code-line ceiling, and JOS-441's third attachment
// needed types that file had no room for. Nothing about the contract moved with them. feedback.ts
// still holds the request, the response, the limits and every validator, still re-exports all of
// this so no import path anywhere changed, and is still the ONE file renderer, main and the ingest
// Lambda read the contract from.
//
// WHAT IS IN HERE IS ONE SUBJECT: the metadata a dump attachment declares, the named ways there can
// be none of it, what the dialog previews, and the row caps. Two dump kinds share every one of
// those shapes — the differences between an inventory export and an achievements export are facts
// about the FILES (src/main/feedback/*.ts) and about the SENTENCES the dialog says, not about what
// an attachment is.

// NOTHING IS IMPORTED FROM feedback.ts, deliberately: that file re-exports this one, so a value
// import in this direction would be a runtime cycle. The byte cap both row caps below sit beside
// (`MAX_UPLOAD_BYTES`) stays where the other limits are and is named in prose here instead.

/**
 * Metadata about an attached `/outputfile inventory` dump (JOS-296). The BYTES go to S3 on their
 * own presign, exactly like the slice; this is the part that travels in the JSON body.
 *
 * WHAT IS DELIBERATELY NOT HERE: the file's NAME or PATH. EQ names the dump
 * `<Character>_<server>-Inventory.txt`, so the filename is the one place the character's identity
 * appears at all (the dump's CONTENTS carry none — see the format sweep in
 * src/main/feedback/inventory.ts). The dialog shows the user their own filename because it is
 * their own screen; the wire does not need it to diagnose an export-shaped bug, so it does not
 * get it.
 */
export interface InventoryDumpMeta {
  bytes: number // gzipped size the client is about to upload
  lines: number // rows in the dump, as read (nothing is removed — see below)
  /** The DUMP's mtime, epoch ms — when the PLAYER last typed `/outputfile inventory`, never when
   *  we read it. This is the JOS-253 freshness truth, and it is the single most diagnostic field
   *  here: a three-week-old export explains most "the app has the wrong items" reports outright. */
  updatedAt: number
  sha256: string // hex digest of the gz bytes — integrity, and a free dedupe key
}

/**
 * Metadata about an attached `/outputfile achievements` dump (JOS-441) — the THIRD attachment, and
 * the same four fields for the same four reasons as the second.
 *
 * WHY IT EXISTS. Three v1.7.0 reports landed within hours of the achievements import shipping, all
 * saying Sky quests they had never run read as turned in. Every one of them carried a log slice and
 * an inventory export, and NEITHER could answer the question: the log holds only the `Outputfile
 * Complete:` receipt, and the bug is entirely inside a file nothing sent. One of those reports would
 * have been diagnosable at a glance with this attachment — and the half of JOS-441's fix that is
 * still an ASSUMPTION (whether a Primary Class Unlock Token flips its pseudo-row) is waiting on
 * precisely one token-user's export to settle. This is how that export arrives.
 *
 * SAME OMISSION AS ITS TWIN: no name, no path. EQ names the dump `<Character>_<server>-
 * Achievements.txt`, and the format sweep in src/main/feedback/achievements.ts found the character
 * name nowhere in the CONTENTS.
 */
export interface AchievementsDumpMeta {
  bytes: number // gzipped size the client is about to upload
  lines: number // rows in the dump, as read (nothing is removed)
  /** The DUMP's mtime, epoch ms — when the PLAYER last typed `/outputfile achievements`. As
   *  diagnostic here as on the inventory: an export taken before the player used their token
   *  describes a different character than the one reporting. */
  updatedAt: number
  sha256: string // hex digest of the gz bytes — integrity, and a free dedupe key
}

/**
 * Why there is no dump to attach. Exactly one of these or a built dump, never both.
 *
 * ONE TYPE FOR BOTH KINDS (JOS-441 kept it that way rather than cloning a second identical union):
 * the four states are properties of "a file we tried to package", not of what is in the file, and
 * the four sentences the dialog says about them differ only in the command they name — which the
 * dialog already has to know. A second union would be four more members that must never drift.
 */
export type InventoryUnavailable =
  /** the command has never been run (or the file is gone) */
  | 'no-dump'
  /** the file exists and could not be read — permissions, a vanished drive */
  | 'unreadable'
  /** the file is there and holds nothing */
  | 'empty'
  /** over MAX_UPLOAD_BYTES gzipped. REFUSED, never trimmed — see the row caps below */
  | 'too-large'

/**
 * What crosses IPC for the DUMP preview (JOS-296) — the slice preview's twin, with one
 * difference that is the whole design: exactly one of `meta` and `unavailable` is set.
 *
 * The slice can answer "nothing to attach" with a bare `null` because every way of getting
 * there reads the same to a user ("no log lines in this window"). A dump cannot: "you have never
 * run the command" and "your dump is too big to send" call for different sentences, and
 * collapsing `too-large` into "no dump" would be the dialog telling a user their export does not
 * exist while they are looking at it.
 */
export interface FeedbackInventoryPreview {
  meta: InventoryDumpMeta | null
  unavailable: InventoryUnavailable | null
  previewLines: string[]
  truncatedPreview: boolean
  /** The dump's FILE NAME (never its path, never the wire's business — see InventoryDumpMeta).
   *  Shown so the dialog can name the exact file it will send. Null when there is none. */
  fileName: string | null
}

/** The achievements dump's preview (JOS-441) — the same five fields, over its own meta type. */
export interface FeedbackAchievementsPreview {
  meta: AchievementsDumpMeta | null
  unavailable: InventoryUnavailable | null
  previewLines: string[]
  truncatedPreview: boolean
  fileName: string | null
}

/**
 * Rows in an attached inventory dump (JOS-296). The measured dev dump is 295 lines; a hoarder
 * with every bank slot, both shared banks, the depot and a full keyring is still four figures.
 * 50,000 is not a budget, it is the "this is not an inventory dump" line — the same job
 * MAX_SLICE_LINES does for the log, which is why it is the same number.
 *
 * THE BYTE CAP IS `MAX_UPLOAD_BYTES`, SHARED WITH THE SLICE, AND IT IS ENFORCED BY REFUSAL.
 * A slice that will not fit is TRIMMED FROM THE FRONT, because fewer log lines is simply less
 * context. A dump cannot be treated that way: it is a complete statement of what a character
 * owns, and a trimmed one is a well-formed file that silently claims the missing items do not
 * exist — the exact failure mode `/outputfile inventory` already has when the Bank window is
 * shut (shared/outputs/kinds.ts `steps`), and the one this attachment exists to diagnose. So an
 * oversize dump is `unavailable: 'too-large'` and the dialog says so.
 */
export const MAX_INVENTORY_LINES = 50_000

/**
 * Rows in an attached achievements dump (JOS-441). The measured dev dump is 1,884 lines and the
 * file is a complete enumeration of the game's achievement tree, so it does not grow with play the
 * way an inventory does — it grows when the GAME adds achievements. Same number as its two
 * siblings, doing the same job: not a budget, the "this is not an achievements dump" line.
 *
 * REFUSAL, NOT TRIMMING, for the reason the inventory constant argues and one more of its own: the
 * class-unlock discrimination this attachment exists to diagnose is decided by two boilerplate rows
 * at the BOTTOM of each class's block (shared/outputs/achievements.ts), so a dump trimmed from
 * either end can drop exactly the evidence that was worth sending.
 */
export const MAX_ACHIEVEMENTS_LINES = 50_000
