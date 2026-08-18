// ============================================================================
// TELEMETRY.md's EVENT TABLE — the prose half of the generated doc.
// ============================================================================
//
// Split out of `./telemetryDoc.ts` when JOS-100's `errorReport` row pushed that file past the
// repo's 400-code-line ceiling. The cut follows the file's own seam: what is HERE is the
// hand-written PROSE (what each event is for, what each field means), and what stays there is
// the RENDERING plus the bucket tables. `telemetryDoc.ts` re-exports `TELEMETRY_DOC_EVENTS`, so
// every importer — the generator, `tests/telemetryDoc.test.mts` — is unchanged.
//
// THE RULE THIS FILE OBEYS IS UNCHANGED AND IS THE WHOLE POINT: the enum members and funnel
// steps below are READ OUT OF `./telemetry.ts` at render time and are never retyped. Prose
// cannot drift from the schema because it makes no claim the schema could contradict — every
// claim that could is rendered from the tables.

import {
  MAX_BREADCRUMBS,
  MAX_COMPONENT_DEPTH_WIRE,
  MAX_ERROR_FRAMES_WIRE,
  MAX_EXTERNAL_FRAMES_WIRE,
  MAX_REDACTED_MESSAGE_WIRE,
  TELEMETRY_EQ_WINDOW_MODES,
  TELEMETRY_ERROR_MODES,
  TELEMETRY_FRAME_ORIGINS,
  TELEMETRY_GPU_COMPOSITING,
  TELEMETRY_GPU_VENDORS,
  TELEMETRY_ERROR_VIEWS,
  TELEMETRY_FAILURE_CLASSES,
  TELEMETRY_FEATURES,
  TELEMETRY_FUNNELS,
  TELEMETRY_OUTCOMES,
  TELEMETRY_OVERLAY_KINDS,
  TELEMETRY_UPDATE_CHANNELS,
  TELEMETRY_UPDATE_STEPS,
  TELEMETRY_VIEWS,
  TELEMETRY_VOICE_ENGINES,
  type TelemetryEventKind
} from './telemetry'
// JOS-367's three live-session groups — twenty more rows on the same two events, in their own
// file for the reason this file is its own file (the 400-code-line ceiling).
import { LIVE_RIDER_FIELDS, LIVE_RIDER_WHEN } from './telemetryDocRiders'

export interface DocField {
  name: string
  /** Rendered from the schema's own enums/edges — never a hand-typed list of values. */
  type: string
  note: string
}

export interface DocEvent {
  t: TelemetryEventKind
  when: string
  fields: DocField[]
}

/** Backtick-quoted, middot-joined — one spelling for every closed enum in the doc. */
function values(list: readonly string[]): string {
  return list.map((v) => `\`${v}\``).join(' · ')
}

const COUNT = 'whole number'
const BUCKET = 'bucket index'

/**
 * The one place the log-line counter is described, shared by both events that carry it — a
 * second copy of this sentence is a second thing to keep true.
 *
 * It says "how many, including re-reads" out loud because the number is bigger than a reader
 * would expect: the app re-reads your log's history each time it starts, and every one of those
 * lines is parsed again. The count is of PARSING WORK; nothing about a line survives it.
 */
const LINES_PARSED =
  'How many log lines were read since the last one of these. A count of lines only — no line, ' +
  'and no part of one, is ever sent. Starting the app re-reads your log history, so those ' +
  'lines are counted again each launch.'

/**
 * The startup-replay group, listed on BOTH events that can carry it — one array, spread twice, for
 * the same reason `LINES_PARSED` is one sentence: a second copy is a second thing to keep true.
 *
 * The rows are named `startup.x` because that is where they live in the payload the Preferences
 * viewer prints, and a reader comparing the two should find the same names.
 */
const STARTUP_FIELDS: DocField[] = [
  {
    name: 'startup.replayMs',
    type: `${COUNT} (optional)`,
    note: 'How long the app took to read your log history when it started.'
  },
  {
    name: 'startup.eventsReplayed',
    type: COUNT,
    note: 'How many log lines that was. A count only — no line, and no part of one, is sent.'
  },
  {
    name: 'startup.dutyPct',
    type: COUNT,
    note: 'What share of that time was spent working rather than deliberately pausing, 0–100.'
  },
  {
    name: 'startup.maxBlockMs',
    type: COUNT,
    note: 'The longest single moment the app was unresponsive while reading.'
  },
  {
    name: 'startup.blocksOver50',
    type: COUNT,
    note: 'How many of those moments were longer than 50 ms.'
  },
  {
    name: 'startup.logSizeBucket',
    type: BUCKET,
    note: 'How big the log it read is — a RANGE (see below), never the size itself.'
  },
  {
    name: 'startup.newBytesBucket',
    type: `${BUCKET} (optional)`,
    note:
      'How much your log had grown since the app last closed normally — a RANGE (see below), ' +
      'never the amount itself. Sent only when the app knows where it had read to last time; ' +
      'after a first run or a crash it is simply not sent.'
  },
  {
    name: 'startup.stutter.p50Bucket',
    type: `${BUCKET} (optional)`,
    note:
      'While it was reading, the app checks a clock on a fixed beat and notes how late each beat ' +
      'was. This is the TYPICAL lateness, as a range — a reading about the computer, not about ' +
      'anything in the log.'
  },
  {
    name: 'startup.stutter.p95Bucket',
    type: `${BUCKET} (optional)`,
    note: 'The same measurement at its worse end: the lateness only one beat in twenty exceeded.'
  },
  {
    name: 'startup.stutter.latePct',
    type: `${COUNT} (optional)`,
    note: 'What share of those beats were late at all, 0–100.'
  },
  {
    name: 'startup.firstMbMs',
    type: `${COUNT} (optional)`,
    note:
      'How long the first megabyte of the read took to arrive — how quickly the machine could ' +
      'hand over the file, nothing about what was in it. Not sent for a log under a megabyte.'
  }
]

/** Why the group is optional and where it appears — said once, printed on both events. */
const STARTUP_WHEN =
  'Present on the first of these that follows startup, once per launch: how long reading your ' +
  'log history took, and how smoothly. Reading a log after switching character is deliberately ' +
  'not measured. Every number in the group is a count or a duration; several are ranges rather ' +
  'than exact figures, and which is which is stated field by field below.'

export const TELEMETRY_DOC_EVENTS: readonly DocEvent[] = [
  {
    t: 'sessionStart',
    when: 'Once, when the app finishes starting up.',
    fields: [
      { name: 'coldStartMsBucket', type: BUCKET, note: 'How long the app took to become usable.' }
    ]
  },
  {
    t: 'sessionHeartbeat',
    when:
      'Every 10 minutes while the app is open — the "is anyone using it right now" signal. ' +
      // JOS-395. The cadence is unchanged and this says so in the same breath as the change: what
      // moves is only WHERE in the ten minutes a given copy of the app sits, and it is worth one
      // sentence here because a reader watching their own network would otherwise see the timing
      // wander and have nowhere to read why.
      'Which moment in those ten minutes it falls on is picked fresh each time the app starts, ' +
      'and every one is nudged a few seconds either way, so that many copies of this app started ' +
      'at the same time do not all call home in the same second — the ten minutes itself never ' +
      'changes. ' +
      `${STARTUP_WHEN} ${LIVE_RIDER_WHEN}`,
    fields: [
      { name: 'uptimeMs', type: COUNT, note: 'How long this session has been running.' },
      { name: 'linesParsed', type: `${COUNT} (optional)`, note: LINES_PARSED },
      ...STARTUP_FIELDS,
      ...LIVE_RIDER_FIELDS
    ]
  },
  {
    t: 'sessionEnd',
    when: `Once, when the app closes. ${STARTUP_WHEN} ${LIVE_RIDER_WHEN}`,
    fields: [
      { name: 'durationMs', type: COUNT, note: 'How long the session lasted.' },
      { name: 'viewsVisited', type: COUNT, note: 'How many different tabs were opened.' },
      { name: 'linesParsed', type: `${COUNT} (optional)`, note: LINES_PARSED },
      ...STARTUP_FIELDS,
      ...LIVE_RIDER_FIELDS
    ]
  },
  {
    t: 'viewDwell',
    when: 'When you switch away from a tab.',
    fields: [
      { name: 'view', type: values(TELEMETRY_VIEWS), note: 'Which tab. A fixed list of tab names.' },
      { name: 'ms', type: COUNT, note: 'How long it was on screen.' }
    ]
  },
  {
    t: 'overlayToggle',
    when: 'When you open or close a floating meter.',
    fields: [
      { name: 'kind', type: values(TELEMETRY_OVERLAY_KINDS), note: 'Which overlay.' },
      { name: 'open', type: 'true / false', note: 'Opened or closed.' }
    ]
  },
  {
    t: 'featureUse',
    when: 'When you use one of the listed features.',
    fields: [
      { name: 'feature', type: values(TELEMETRY_FEATURES), note: 'Which one. A fixed list.' },
      { name: 'count', type: COUNT, note: 'How many times, since the last batch.' }
    ]
  },
  {
    t: 'alertFired',
    when: 'A rollup of how many alerts fired — never which alert, and never its text.',
    fields: [
      { name: 'count', type: COUNT, note: 'Alerts fired.' },
      { name: 'spokenCount', type: COUNT, note: 'How many of those were spoken aloud.' }
    ]
  },
  {
    t: 'setupSnapshot',
    when: 'Once per session: what a typical install looks like.',
    fields: [
      { name: 'charCountBucket', type: BUCKET, note: 'How many character logs the app can see.' },
      { name: 'logSizeBucket', type: BUCKET, note: 'How big the log it reads is.' },
      { name: 'alertCountBucket', type: BUCKET, note: 'How many alerts you keep.' },
      {
        name: 'overlaysEnabled',
        type: `list of ${values(TELEMETRY_OVERLAY_KINDS)}`,
        note: 'Which floating meters are open.'
      },
      { name: 'cursorRing', type: 'true / false', note: 'Is the cursor ring on.' },
      { name: 'autoHide', type: 'true / false', note: 'Is overlay auto-hide on.' },
      {
        name: 'voiceEngine',
        type: values(TELEMETRY_VOICE_ENGINES),
        note: 'Which speech tier your spoken alerts use — off when no alert is set to speak.'
      },
      { name: 'soundPackCount', type: COUNT, note: 'How many sound packs are installed.' },
      { name: 'updateChannel', type: values(TELEMETRY_UPDATE_CHANNELS), note: 'Update channel.' },
      {
        name: 'cpuCountBucket',
        type: BUCKET,
        note: 'How many processor cores the machine has — a range, never the number.'
      },
      {
        name: 'totalMemBucket',
        type: BUCKET,
        note: 'How much memory the machine has — a range, never the number.'
      },
      {
        name: 'gpuVendor',
        type: values(TELEMETRY_GPU_VENDORS),
        note: 'Who made the graphics chip. Never the model, never a driver version.'
      },
      {
        name: 'gpuCompositing',
        type: values(TELEMETRY_GPU_COMPOSITING),
        note: 'Whether the app is drawing with the graphics chip or on the processor.'
      },
      { name: 'safeMode', type: 'true / false', note: 'Is graphics safe mode on for this launch.' },
      { name: 'displayCountBucket', type: BUCKET, note: 'How many monitors are attached.' },
      {
        name: 'primaryScaleBucket',
        type: BUCKET,
        note: 'The main monitor’s display scaling (100%, 125%, …).'
      },
      {
        name: 'eqWindowMode',
        type: values(TELEMETRY_EQ_WINDOW_MODES),
        note:
          'Whether EverQuest is set to fullscreen or windowed — one true/false read out of ' +
          '`eqclient.ini`. Nothing else in that file is read, and nothing from your log. ' +
          '`fullscreen` means the game’s own Fullscreen setting is on, which on the current ' +
          'client is a borderless fullscreen window and not an exclusive display mode.'
      }
    ]
  },
  {
    t: 'funnelStep',
    when: 'When you reach a step of one of the three flows listed below.',
    fields: [
      { name: 'funnel', type: values(TELEMETRY_FUNNELS), note: 'Which flow.' },
      { name: 'step', type: 'a step of that flow (below)', note: 'Which step it reached.' },
      { name: 'outcome', type: `${values(TELEMETRY_OUTCOMES)} (optional)`, note: 'How it ended.' },
      {
        name: 'failureClass',
        type: `${values(TELEMETRY_FAILURE_CLASSES)} (optional)`,
        note: 'A coarse category when it failed. Never an error message.'
      }
    ]
  },
  {
    t: 'healthCounters',
    // The cadence is stated exactly, because it is what a reader would otherwise get wrong: this
    // rides the session reports (every 10 minutes, and again at close) rather than arriving once,
    // and it is sent even when every count is zero. A report with nothing in it is how we know a
    // build is reporting at all — without it, a version that is running fine and a version too old
    // to have this code would look identical.
    when: 'With each session report (every few minutes, and at close): counts of things that went wrong since the last one. Sent even when they are all zero. Counts only, never messages.',
    fields: [
      { name: 'rendererCrashes', type: COUNT, note: 'Window crashes. The main window only.' },
      // ERRORS ONLY, said out loud (JOS-99): warnings printed by a window reach the developer
      // console but are never written to the file, so they are not counted here either.
      {
        name: 'mainErrorLogLines',
        type: COUNT,
        note: 'Lines written to the local error log. Errors only — warnings are not counted.'
      },
      // SAID OUT LOUD rather than left as an implied zero: nothing in the app detects a stall, so
      // this field reports 0 from every client and means "not measured". A note claiming it counts
      // stalls would be a promise the code does not keep.
      { name: 'parserStalls', type: COUNT, note: 'Times log reading stalled. Not currently measured — always 0.' },
      { name: 'presenceRestarts', type: COUNT, note: 'Times the game-window watcher restarted.' },
      { name: 'speechFailures', type: COUNT, note: 'Times an utterance failed to speak. Downloaded voices only.' },
      // JOS-133. SAID AS A CONDITION, NOT AS A FAULT, because that is what it is: the picture is
      // simply not shown and the app carries on. The note names the wiki rather than the app so a
      // reader is not left thinking their install is broken.
      {
        name: 'imageFetchFailures',
        type: `${COUNT} (optional)`,
        note: 'Times an item icon or portrait could not be downloaded, usually because the wiki was unreachable. The picture is hidden and the app carries on. Never which picture.'
      },
      {
        name: 'suppressedErrorLines',
        type: `${COUNT} (optional)`,
        note: 'The same error line repeating: after the first few, further copies are counted here instead of being written to the local error log again. A count only.'
      },
      // JOS-266. SAID AS SOMETHING THAT FIXED ITSELF, because that is what it is: the picture the
      // app had saved would not open, so it downloads it again and shows it. The note names the
      // outcome the user got rather than the machinery, and promises a count and nothing else.
      {
        name: 'imageCacheReadFailures',
        type: `${COUNT} (optional)`,
        note: 'Times a picture the app had already saved could not be read back, so it was downloaded again. The picture is still shown. Never which picture, and never where it was kept.'
      },
      // JOS-364. NAMED AS THE THING A USER WOULD HAVE NOTICED — a flicker, a black frame — rather
      // than as a process type, because "the GPU process exited" is not a sentence about their
      // machine that they can check against what they saw.
      {
        name: 'gpuProcessGone',
        type: `${COUNT} (optional)`,
        note: 'Times the graphics helper the app draws with died and was restarted — usually seen as a flicker. A count, plus the reason code in the error log.'
      },
      {
        name: 'utilityProcessGone',
        type: `${COUNT} (optional)`,
        note: 'The same for a background helper (sound, network, storage). These come and go normally, so this is a count only and is not treated as an error.'
      }
    ]
  },
  {
    t: 'updateOutcome',
    when: 'When an app update is checked for, downloaded, or applied.',
    fields: [
      { name: 'step', type: values(TELEMETRY_UPDATE_STEPS), note: 'Which step.' },
      { name: 'ok', type: 'true / false', note: 'Did it succeed.' },
      {
        name: 'failureClass',
        type: `${values(TELEMETRY_FAILURE_CLASSES)} (optional)`,
        note: 'A coarse category when it failed.'
      }
    ]
  },
  {
    t: 'errorReport',
    // THE ONE EVENT THAT CARRIES TEXT, and the row says so plainly rather than letting a reader
    // discover it in the field table. The promise it keeps is the one at the top of the page:
    // never your log, never your chat, never a name from the game.
    when:
      'When the app hits an error: the technical details of the failure, so it can be fixed. ' +
      'Never your log contents, never your chat, and never a name from the game. The same ' +
      'error happening again in one session adds to a count instead of sending a second copy.',
    fields: [
      { name: 'errorName', type: 'e.g. `TypeError`', note: 'What kind of error it was.' },
      {
        name: 'code',
        type: 'e.g. `ENOENT` (optional)',
        note: 'The short machine-readable code, when the error has one.'
      },
      {
        name: 'redactedMessage',
        type: `redacted text, at most ${String(MAX_REDACTED_MESSAGE_WIRE)} characters`,
        note:
          'The error message with the revealing parts replaced before it is stored: any file ' +
          'path becomes `<path>`, anything in quotes becomes `<str>`, and any long number ' +
          'becomes `<n>`. The replacement runs on your machine AND again on arrival, and a ' +
          'message that is not already redacted is thrown away rather than cleaned up.'
      },
      {
        name: 'frames',
        type: `at most ${String(MAX_ERROR_FRAMES_WIRE)} × (file, line, column, function)`,
        note:
          'Where in the app it happened. Files are named relative to the app’s own program ' +
          'files (they always begin `out/`) — the folder the app is installed in, and therefore ' +
          'your account name, is cut off before the value exists.'
      },
      {
        name: 'frameOrigin',
        type: values(TELEMETRY_FRAME_ORIGINS),
        note:
          'Whether the places listed above are where the error was thrown, or where the app ' +
          'noticed it. Some failures arrive with no trace of their own, and the app records ' +
          'its own position instead so two different failures do not look like one.'
      },
      {
        name: 'externalFrames',
        type: `at most ${String(MAX_EXTERNAL_FRAMES_WIRE)} × (module, line, column, function)`,
        note:
          'The same thing for code that is not ours: the name of the Node built-in, the Electron ' +
          'script, or the open-source package involved — `node:fs`, `node_modules/chokidar`. ' +
          'The name only, cut at the package: the folder it is installed in never survives.'
      },
      {
        name: 'componentPath',
        type: `at most ${String(MAX_COMPONENT_DEPTH_WIRE)} names joined with >`,
        note:
          'For an error in the app’s own interface, which of the app’s screen components it ' +
          'came through — the names in this app’s source code, and nothing from the game.'
      },
      { name: 'fingerprint', type: '16 hex characters', note: 'A hash used to group identical errors together.' },
      {
        name: 'breadcrumbs',
        type: `at most ${String(MAX_BREADCRUMBS)} × (kind, offset)`,
        note:
          'What KINDS of log line the app had just read — `damage`, `loot`, `zone` and so on, ' +
          'from a fixed list — and how long before the error each was. The kind only: not the ' +
          'line, not who or what was in it.'
      },
      { name: 'view', type: values(TELEMETRY_ERROR_VIEWS), note: 'Which tab was open. A fixed list.' },
      { name: 'sessionAgeBucket', type: BUCKET, note: 'How long the app had been running.' },
      { name: 'mode', type: values(TELEMETRY_ERROR_MODES), note: 'Was it reading your log history, or following it live.' },
      { name: 'count', type: COUNT, note: 'How many times this same error happened since the last report. It stops at a hundred per error per run of the app: something that goes wrong over and over reports itself a hundred times and then goes quiet, so one repeating fault cannot bury everything else.' }
    ]
  },
  {
    t: 'optOut',
    // THE ONE EVENT THAT IS SENT AFTER YOU SAID STOP, and the row says so in its first clause
    // rather than leaving a reader to infer it from the "Turning it off" section below. The
    // empty field list is not an omission — `telemetryDoc.ts` prints a sentence for it — and it
    // is the strongest form of the promise: there is no slot on this event for anything to ride.
    when:
      'Once, when you turn usage analytics off. It is the last thing this app ever sends, and it ' +
      'exists so opt-outs can be counted rather than guessed at. Everything else waiting to be ' +
      'sent is thrown away rather than sent with it, it is never retried if you are offline, and ' +
      'nothing further is ever sent.',
    fields: []
  },
  {
    t: 'optIn',
    when:
      'Once, when you turn usage analytics back on. The counterpart to the notice above, under ' +
      'the new random id. It carries nothing either.',
    fields: []
  }
]

