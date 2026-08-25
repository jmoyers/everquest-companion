// ============================================================================
// TELEMETRY.md's LIVE-SESSION RIDERS — the prose for JOS-367's three groups.
// ============================================================================
//
// Split out of `./telemetryDocEvents.ts` for the reason that file was split out of
// `./telemetryDoc.ts`: twenty field rows do not fit inside the repo's 400-code-line ceiling, and
// the answer here has been a split every time. The cut follows the same seam — what is HERE is
// hand-written prose about ONE subject (what a running session reports about itself), spread onto
// both events that can carry it so a second copy never has to be kept true.
//
// THE VOICE IS THE USER'S, not the schema's. Every row on this page is read by someone deciding
// whether to leave a switch on, so each one says what the number is FOR and — where it could be
// misread as watching them — what it is not. "How late our own clock ran" is a fact about a
// computer; nothing here is a fact about a character, a zone or a line of a log, and the rows say
// so in words rather than making the reader infer it from a type.

// TYPE-ONLY, and that is what keeps this a split rather than a cycle: `telemetryDocEvents.ts`
// imports the arrays below as values, this file imports nothing of its but a shape, and a
// type-only import is erased before anything runs.
import type { DocField } from './telemetryDocEvents'

const COUNT = 'whole number'
const BUCKET = 'bucket index'
const OPT_COUNT = `${COUNT} (optional)`
const OPT_BUCKET = `${BUCKET} (optional)`

/**
 * The stall group. `coincident` gets the longest note on the page, and it earns it: it is the one
 * field here that exists to say the problem is NOT this app, and a reader should be able to see
 * that from the doc rather than take it on trust.
 */
const LIVE_FIELDS: DocField[] = [
  {
    name: 'live.samples',
    type: OPT_COUNT,
    note: 'How many times the app checked its own clock since the last one of these.'
  },
  {
    name: 'live.p95Bucket',
    type: OPT_BUCKET,
    note:
      'The app sets a timer for a quarter second, over and over, and notes how late each one ' +
      'actually arrived. This is the lateness only one check in twenty exceeded, as a RANGE ' +
      '(see below) - a reading about the computer, never about anything you did.'
  },
  {
    name: 'live.maxBucket',
    type: OPT_BUCKET,
    note: 'The worst single one of those, as a range - the moment you would have felt.'
  },
  {
    name: 'live.over100',
    type: OPT_COUNT,
    note: 'How many of those checks were more than a tenth of a second late.'
  },
  { name: 'live.over500', type: OPT_COUNT, note: 'How many were more than half a second late.' },
  {
    name: 'live.coincident',
    type: OPT_COUNT,
    note:
      'The app runs the same clock check on a second thread that does nothing else. This counts ' +
      'the moments BOTH went late at once - which means the whole computer paused (memory, a ' +
      'driver, a disk), not this app. It is how a freeze can be blamed correctly instead of ' +
      'guessed at. Not sent when that second check was not running.'
  }
]

/** The tail group — the app's own file reads, and the only place a LOG is mentioned at all, which
 *  is exactly why every row says "how long" and "how much", never "what". */
const TAIL_FIELDS: DocField[] = [
  {
    name: 'tail.reads',
    type: OPT_COUNT,
    note: 'How many times the app read new lines from your log since the last one of these.'
  },
  {
    name: 'tail.reopens',
    type: OPT_COUNT,
    note: 'How many of those had to re-open the file (normally none).'
  },
  {
    name: 'tail.p95Bucket',
    type: OPT_BUCKET,
    note:
      'How long those reads took, at their worse end - the same ranges as the clock check above, ' +
      'so the two can be compared. The game writes to that same file, so this is how much of its ' +
      'time the app could be taking.'
  },
  { name: 'tail.maxBucket', type: OPT_BUCKET, note: 'The slowest single read, as a range.' },
  { name: 'tail.over100', type: OPT_COUNT, note: 'Reads that took more than a tenth of a second.' },
  { name: 'tail.over500', type: OPT_COUNT, note: 'Reads that took more than half a second.' },
  {
    name: 'tail.deltaBytesBucket',
    type: OPT_BUCKET,
    note:
      'The biggest single chunk of new log read at once - a RANGE (see below), never the amount ' +
      'itself, and never any part of what was in it.'
  },
  {
    name: 'tail.logSizeBucket',
    type: OPT_BUCKET,
    note: 'How big that log is now - a range, never the size itself.'
  }
]

/** The state group. Flags about this app's own windows and switches, sent so a slow moment can be
 *  read against what was turned on when it happened. */
const STATE_FIELDS: DocField[] = [
  { name: 'state.overlaysOpen', type: OPT_COUNT, note: 'How many floating meters were open.' },
  {
    name: 'state.overlaysLocked',
    type: OPT_COUNT,
    note:
      'How many of those were locked (click-through). Locking makes Windows route mouse events ' +
      'through this app, so it is the setting most likely to explain a stutter.'
  },
  {
    name: 'state.presenceOn',
    type: 'true / false (optional)',
    note: 'Whether the app was watching for the game window (needed by auto-hide and the ring).'
  },
  { name: 'state.ringOn', type: 'true / false (optional)', note: 'Whether the cursor ring was on.' },
  {
    name: 'state.freeMemBucket',
    type: OPT_BUCKET,
    note:
      'How much free memory the computer had, as a RANGE - a machine with none left pauses ' +
      'everything, including the game.'
  },
  {
    name: 'state.workingSetBucket',
    type: OPT_BUCKET,
    note: 'How much memory THIS APP was using, as a range. The honesty half of the row above.'
  }
]

/**
 * The GC group (JOS-458). "Garbage collection" is jargon, so every row here says what it MEANS to
 * the person reading — the app pausing to tidy its own memory — rather than naming the mechanism
 * and leaving them to look it up.
 */
const GC_FIELDS: DocField[] = [
  {
    name: 'gc.pauses',
    type: OPT_COUNT,
    note:
      'How many times the app stopped briefly to tidy up its own memory. This is normal and ' +
      'constant in every program; it is counted because a long one is a leading suspect for a ' +
      'freeze you would notice.'
  },
  {
    name: 'gc.majorPauses',
    type: OPT_COUNT,
    note: 'How many of those were the big kind - the ones long enough to be worth suspecting.'
  },
  {
    name: 'gc.maxBucket',
    type: OPT_BUCKET,
    note:
      'The longest single one of those pauses, as a RANGE (see below) - the same ranges the clock ' +
      'check above uses, so the two can be laid against each other and one can explain the other.'
  },
  {
    name: 'gc.totalBucket',
    type: OPT_BUCKET,
    note: 'How long all of them added up to, as a range.'
  },
  {
    name: 'gc.over100',
    type: OPT_COUNT,
    note: 'How many were longer than a tenth of a second.'
  }
]

/**
 * The seam group. It is the one group whose KEYS carry meaning, so the page says out loud what
 * those keys can be — a fixed list of six of the app's own internal steps, and nothing else. A
 * reader who wonders whether a name from their game could appear here should be able to answer it
 * from this row.
 */
const SEAM_FIELDS: DocField[] = [
  {
    name: 'seams.<step>.calls',
    type: OPT_COUNT,
    note:
      'The app times six of its own internal steps - handing a window its data, handing over the ' +
      'combat model, pushing pending updates, reading your inventory dump, reading your ' +
      'achievements dump, and telling its windows to reload. This is how many times one of them ' +
      'ran. The six names are fixed and built into the app: nothing from your game, your files ' +
      'or your log can ever appear as one.'
  },
  {
    name: 'seams.<step>.maxBucket',
    type: OPT_BUCKET,
    note:
      'The longest single run of that step, as a RANGE - so a slow moment can be blamed on the ' +
      'step that actually caused it instead of guessed at.'
  },
  {
    name: 'seams.<step>.over100',
    type: OPT_COUNT,
    note: 'How many runs of that step took more than a tenth of a second.'
  }
]

/** All five groups, in reading order, spread onto both session reports. */
export const LIVE_RIDER_FIELDS: readonly DocField[] = [
  ...LIVE_FIELDS,
  ...TAIL_FIELDS,
  ...STATE_FIELDS,
  ...GC_FIELDS,
  ...SEAM_FIELDS
]

/** Why the groups are there and when they appear — said once, printed on both events. */
export const LIVE_RIDER_WHEN =
  'It also carries how smoothly the app itself was running since the previous one: how late its ' +
  'own timers arrived, how long its reads of your log took, which of its windows and switches ' +
  'were on, how long it spent tidying its own memory, and how long six of its own named internal ' +
  'steps took. All of it is counts and ranges about this computer - no line of your log, and no ' +
  'part of one, is ever sent. Each group is left out entirely when there is nothing to say (no ' +
  'character attached, or the check was not running).'
