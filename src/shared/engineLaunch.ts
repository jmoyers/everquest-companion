// ============================================================================
// engineLaunch.ts — WHAT THE SHELL IS TOLD ABOUT THE ENGINE'S LAUNCH (JOS-503).
// ============================================================================
//
// THE TWO STATES THE CUTOVER CREATED, and this file is the vocabulary for both of them.
//
//   1. THE CATCH-UP. Post-cutover every panel in the product reads a fold that lives in another
//      process, so the minute after a launch or a character switch is a minute of empty surfaces.
//      Until this ticket the app's answer was a loading state with no sense of how long, which is
//      the difference between waiting and wondering whether it is broken.
//   2. THE FAILURE. If the engine cannot start there is no TypeScript fold to degrade to any more —
//      `src/main/dataServer/README.md` states it plainly, "an app that cannot answer" — and the
//      reason lived only in `errors.log`. A permanently empty window with a silent cause is the one
//      shape a shipped app must not have.
//
// ── WHY BOTH LIVE ON ONE SHAPE ────────────────────────────────────────────────────────────────
//
// They are the same question asked at two moments: *can this app answer me yet, and if not, why
// not?* A launch is either on its way to serving or it is not, and a renderer that had to reconcile
// a progress channel against a separate health channel would be deriving the answer the main
// process already knows. So `EngineLaunchSay` is ONE object with a phase, pushed on change — and
// the shell mounts ONE component that draws whichever of the two states is current.
//
// ── WHY THE ETA IS COMPUTED HERE AND NOT IN THE ENGINE ────────────────────────────────────────
//
// An estimate is a claim about the FUTURE of a machine, and the engine deliberately reads no clock
// it was not given (`views::Timeline`'s rule, and cache law 1 behind it: determinism is
// cacheability). What the engine states is what it measured — the mark, the denominator, the event
// count — and every one of those is a fact about bytes. The extrapolation is a display decision
// taken against the HOST's wall clock, which is exactly the kind of thing that must not be inside a
// fold. It is also why `FoldSay.at` exists: the sample is stamped where the clock is honest.
//
// ── WHY THE WORDS ARE HERE TOO ────────────────────────────────────────────────────────────────
//
// `failureWords` is the failure card's prose, as a pure function of the fault. Two reasons it is
// not inline in the component: a unit test can pin the sentence a user reads for every class at
// once (and fail when a new class arrives with no words), and the e2e asserts the same strings from
// the DOM, so the spec and the product cannot drift into agreeing about different sentences.
//
// NOTHING HERE READS A CLOCK, TOUCHES A DOM, OR IMPORTS ANYTHING. It is arithmetic and prose, which
// is what lets `tests/engineLaunch.test.mts` drive the whole matrix.

// ── the pushed shape ───────────────────────────────────────────────────────────────────────────

/**
 * Where a launch is. Five members, and only two of them draw anything.
 *
 * `starting` and `live` are deliberately silent states: a banner that appeared for the two hundred
 * milliseconds between spawn and attach on every launch would be noise, and a banner that stayed up
 * once the engine is answering would be a lie about a healthy app. What the shell draws is `folding`
 * (the bar) and the two terminal ones (the card).
 */
export type EngineLaunchPhase =
  /** The supervisor is spawning, handshaking, or waiting out a backoff. Nothing is drawn. */
  | 'starting'
  /** A historical fold is running — a launch, a character switch, or a respawn's re-fold. */
  | 'folding'
  /** The fold landed; the engine is answering this app's reads. Nothing is drawn. */
  | 'live'
  /** No engine binary was found anywhere the resolver looks. TERMINAL until somebody retries. */
  | 'absent'
  /** Launches kept failing until the crash-loop trail collapsed. TERMINAL for this launch. */
  | 'failed'

/**
 * WHY A LAUNCH IS NOT GOING TO WORK — the supervisor's own failure vocabulary, plus the absence.
 *
 * `no-binary` is not one of the supervisor's `EngineFailure` members and could not be: an absence is
 * a CONDITION rather than a failed launch (it mints no error-store entry and schedules no retry —
 * `supervisor.ts beginLaunch` argues it at length). It is a fault to a PERSON all the same, and this
 * is the type a person's card is drawn from.
 *
 * `shutdown-exit` is deliberately absent from this union. That failure only happens on the quit path,
 * where there is no window left to tell and nothing anybody could do about it.
 */
export type EngineFaultKind =
  | 'no-binary'
  | 'spawn-failed'
  | 'announce-timeout'
  | 'bad-announce'
  | 'unhealthy'
  | 'exited'

/** Why the engine is not going to start, as much of it as can be said safely. */
export interface EngineFaultSay {
  readonly kind: EngineFaultKind
  /** How many launches in a row got here. 0 for an absence — nothing was attempted. */
  readonly attempts: number
  /**
   * Every path the resolver probed, in order. Only ever populated for `no-binary`, because it is the
   * only fault where WHERE WE LOOKED is the actionable half of the diagnosis.
   *
   * IT IS SHOWN AND NEVER SENT. These strings contain the user's own home directory, so they draw
   * behind a disclosure in the card and are deliberately not part of the report prefill — see
   * `reportPrefill` below.
   */
  readonly lookedIn: readonly string[]
  /** The engine's own last word, already bounded and token-redacted by `engineProtocol.ts`. */
  readonly detail: string | null
}

/**
 * One measurement of a running fold, as the engine reported it plus the instant we heard it.
 *
 * THE TWO BYTE FIELDS CARRY THE WIRE'S OWN NAMES, and the wire carries the schema's existing ones:
 * `offset` is the coordinate `HealthMark.offset` already reports (cache law 3 — state is addressed
 * by log identity and byte offset), and `logSize` is how big the fold currently believes the file
 * to be. They are not called `bytes`/`totalBytes` because `bytes` is a name the protocol schema
 * REFUSES: `tests/protocolSchema.test.mts` forbids the framing vocabulary outright so the wire
 * method stays swappable (owner ruling 15), and a domain measurement wearing a transport word is
 * exactly the confusion that guard exists to prevent. One vocabulary, end to end.
 */
export interface FoldSay {
  /** 0–100, fractional, engine-measured (owner ruling 17). */
  readonly pct: number
  /** The mark: the end of the last complete line folded, in bytes from the start of the log. */
  readonly offset: number
  /** What `pct` was divided by. It can GROW between samples — EverQuest is still appending. */
  readonly logSize: number
  /** Events folded so far. */
  readonly events: number
  /** THE HOST's wall clock when this sample was received. The ETA's only clock — see the header. */
  readonly at: number
}

/** The whole of what main pushes to the shell. Every unknown is `null`, never `0`. */
export interface EngineLaunchSay {
  readonly phase: EngineLaunchPhase
  /** The newest fold measurement, while one is running. Null in every other phase. */
  readonly fold: FoldSay | null
  /** Why it will not start. Null unless the phase is `absent` or `failed`. */
  readonly fault: EngineFaultSay | null
}

/** What a window is told before anything has happened: a launch on its way, nothing to draw. */
export const ENGINE_LAUNCH_STARTING: EngineLaunchSay = { phase: 'starting', fold: null, fault: null }

/**
 * DOES THIS PROGRESS FRAME BELONG ON THE BANNER? (JOS-518.)
 *
 * TWO REASONS TO REFUSE ONE, AND THEY ARE DEFENCE IN DEPTH RATHER THAN A BELT AND BRACES:
 *
 *   1. THE FLAG. The engine's LIVE TAIL emits the same shape as its historical scan and has done
 *      since the beginning (`ingest.rs`: "a live progress frame is the only wire evidence a live
 *      line landed"), so a session where somebody is playing produces these forever. `live` is the
 *      engine saying which loop it was in, and that is the STRUCTURAL refusal: it does not depend on
 *      this process having got any other piece of state right.
 *   2. THE PHASE. The bar is only on screen while a historical catch-up is running, so a frame
 *      arriving in any other phase has no reader.
 *
 * WHY BOTH, when either would do on a correct app. The 1.11.0 reports are what this is made of: the
 * fold wait expired, nothing ever moved the phase off `folding`, and the tail's own frames then kept
 * the bar alive at 100% with the count climbing for the rest of the session. The phase test alone
 * was the whole defence and it failed the moment ONE unrelated thing went wrong. A frame that says
 * it came from the tail is refused whatever this process believes about itself.
 *
 * `live !== true` RATHER THAN `!live`, because the field is absent on a scan frame and absent is the
 * common case — the two spellings agree today and only one of them keeps agreeing if the wire ever
 * carries an explicit `false`.
 */
export function foldFrameCounts(phase: EngineLaunchPhase, live: boolean | undefined): boolean {
  return live !== true && phase === 'folding'
}

// ── the sample ring, and the rate it exists to measure ────────────────────────────────────────

/**
 * How many samples the rate is taken over. Twelve, and the number is a trade rather than a taste:
 * the engine paces progress at ~4 Hz, so this is a three-second window — long enough that one
 * slow read does not make the estimate jump, short enough that the estimate reacts when the machine
 * genuinely changes speed (an antivirus scan starting, the game writing a burst).
 */
export const FOLD_RATE_SAMPLES = 12

/**
 * The shortest span a rate may be taken over. Below this the denominator is mostly measurement
 * noise, and a rate computed over 40 ms produces an ETA that swings by minutes between frames.
 */
const FOLD_RATE_MIN_SPAN_MS = 600

/** Beyond this an estimate is not information, so none is offered. */
const FOLD_ETA_MAX_MS = 24 * 60 * 60 * 1000

/**
 * The samples a readout is computed from. OPAQUE ON PURPOSE: the renderer holds one of these and
 * passes it back, and never reaches inside it — which is also what keeps every array operation in
 * this file rather than in `src/renderer`, where the no-munging rule reads element types.
 */
export interface FoldRing {
  readonly samples: readonly FoldSay[]
}

export const NEW_FOLD_RING: FoldRing = { samples: [] }

/**
 * Take one sample.
 *
 * A MARK THAT WENT BACKWARDS STARTS A NEW RING, and that is the whole of how a character switch is
 * handled here: a fresh attach re-folds from byte zero, so the first sample of the new fold is
 * smaller than the last of the old one. Averaging across that boundary would produce a negative
 * rate and an ETA in the past. The alternative — telling this function about epochs — would put
 * protocol knowledge in an arithmetic helper for a fact the numbers already state.
 */
export function pushFold(ring: FoldRing, sample: FoldSay): FoldRing {
  const previous = ring.samples[ring.samples.length - 1]
  if (previous !== undefined && sample.offset < previous.offset) return { samples: [sample] }
  const grown = [...ring.samples, sample]
  return { samples: grown.slice(Math.max(0, grown.length - FOLD_RATE_SAMPLES)) }
}

/**
 * Bytes per millisecond over the ring, or null when no honest rate can be taken.
 *
 * FIRST AND LAST RATHER THAN A FIT. The samples are evenly paced by the engine's own cadence and
 * the quantity is monotone, so the endpoints ARE the average rate over the window; a least-squares
 * line would cost more and say the same thing about a straight-line quantity.
 */
export function foldRate(ring: FoldRing): number | null {
  const first = ring.samples[0]
  const last = ring.samples[ring.samples.length - 1]
  if (first === undefined || last === undefined || first === last) return null
  const span = last.at - first.at
  const moved = last.offset - first.offset
  if (span < FOLD_RATE_MIN_SPAN_MS || moved <= 0) return null
  return moved / span
}

/** What the bar draws. Every field is already a string, formatted for the pixel it lands on. */
export interface FoldReadout {
  /** 0–100, clamped, for the bar's own width. Not text — the bar is a number, not a sentence. */
  readonly pct: number
  /** `62%` */
  readonly pctText: string
  /** `148.8 MB of 238.4 MB` */
  readonly bytesText: string
  /** `about 40s left`, or null when no honest estimate exists yet. */
  readonly etaText: string | null
  /** `1,571,003 events` */
  readonly eventsText: string
}

/**
 * The whole readout, or null when the ring holds nothing.
 *
 * THE ETA IS OMITTED RATHER THAN GUESSED. Three conditions produce no estimate — too few samples,
 * too short a span, a rate that has not moved — and one more suppresses a silly one (an estimate
 * past a day). In every case the bar still shows the percentage and the bytes, which are
 * MEASUREMENTS rather than predictions and are always honest. A progress surface that invented a
 * countdown from one sample would be the fabrication this repo's world-model law 1 forbids, one
 * layer up.
 */
export function foldReadout(ring: FoldRing): FoldReadout | null {
  const last = ring.samples[ring.samples.length - 1]
  if (last === undefined) return null
  const pct = Math.min(100, Math.max(0, last.pct))
  return {
    pct,
    pctText: `${String(Math.floor(pct))}%`,
    bytesText: `${humanBytes(last.offset)} of ${humanBytes(Math.max(last.offset, last.logSize))}`,
    etaText: etaText(ring, last),
    eventsText: `${last.events.toLocaleString('en-US')} events`
  }
}

function etaText(ring: FoldRing, last: FoldSay): string | null {
  const rate = foldRate(ring)
  if (rate === null) return null
  const remaining = last.logSize - last.offset
  if (remaining <= 0) return null
  const ms = remaining / rate
  if (!Number.isFinite(ms) || ms > FOLD_ETA_MAX_MS) return null
  return `about ${humanDuration(ms)} left`
}

// ── formatting, en-US and fixed (owner ruling 25) ──────────────────────────────────────────────

const KB = 1024
const UNITS = ['KB', 'MB', 'GB', 'TB'] as const

/**
 * Bytes as a person reads them. Base 1024, because the number beside it is a FILE SIZE and that is
 * what every file manager on this platform shows.
 *
 * Whole bytes below a kilobyte, one decimal above it — a log measured to three decimals of a
 * megabyte is precision nobody asked for on a number that changes four times a second.
 */
export function humanBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '0 B'
  if (bytes < KB) return `${String(Math.round(bytes))} B`
  let value = bytes / KB
  let unit = 0
  while (value >= KB && unit < UNITS.length - 1) {
    value /= KB
    unit += 1
  }
  return `${value.toFixed(1)} ${UNITS[unit]}`
}

/**
 * A duration as a person says it. Coarse ON PURPOSE: this is an estimate, and printing `2m 43s`
 * claims a precision the extrapolation does not have. Seconds under a minute, minutes under an
 * hour, hours and minutes above it.
 */
export function humanDuration(ms: number): string {
  const seconds = Math.max(1, Math.round(ms / 1000))
  if (seconds < 60) return `${String(seconds)}s`
  const minutes = Math.round(seconds / 60)
  if (minutes < 60) return `${String(minutes)}m`
  const hours = Math.floor(minutes / 60)
  return `${String(hours)}h ${String(minutes % 60)}m`
}

// ── the failure card's words ───────────────────────────────────────────────────────────────────

/** One card's prose. Three parts, because they answer three different questions. */
export interface FailureWords {
  /** What happened, in the fewest words that are still true. */
  readonly headline: string
  /** Why, in a sentence a person who has never heard the word "engine" can act on. */
  readonly body: string
  /** What to try. Null when there is nothing honest to suggest beyond the retry button. */
  readonly remedy: string | null
}

/**
 * WHAT AN APP WITH NO ENGINE HAS TO SAY ABOUT ITSELF, and it is the same sentence for every class.
 *
 * The card must never lie about degraded function. Post-cutover there is no second fold: with no
 * engine there is no data at all, and a card that said "some features are unavailable" would be
 * describing a product that does not exist. This is the sentence that says so.
 */
export const NO_ENGINE_CONSEQUENCE =
  'Until it starts, EQ Companion cannot read your log at all - every panel will stay empty. ' +
  'Your log file and your settings are untouched.'

/**
 * THE ANTIVIRUS SENTENCE, and it is on exactly the two classes where it is the likeliest cause.
 *
 * A missing file and a refused launch are what quarantine looks like from inside the app: the
 * scanner either takes the executable away or stops it starting, and neither leaves an error a user
 * would connect to their antivirus. The other classes get their own words rather than this one —
 * an engine that started and then went quiet was not quarantined, and suggesting it would send
 * somebody hunting through a quarantine list that has nothing in it.
 */
const QUARANTINE_REMEDY =
  'Antivirus quarantine is the most common cause. Check your antivirus quarantine list and restore ' +
  'EQ Companion, add it to your exclusions, then reinstall if it is still missing.'

/**
 * The card's prose for one fault. Exhaustive over `EngineFaultKind` by the TYPE, so a new class
 * cannot ship without words — `tests/engineLaunch.test.mts` reads this table and fails on a member
 * with an empty sentence.
 */
export function failureWords(fault: EngineFaultSay): FailureWords {
  const tries = fault.attempts > 1 ? ` It has tried ${String(fault.attempts)} times.` : ''
  const words: Readonly<Record<EngineFaultKind, FailureWords>> = {
    'no-binary': {
      headline: 'EQ Companion cannot find its data engine',
      body:
        'The program that reads your log file is missing from this installation. It was not at any ' +
        'of the places EQ Companion knows to look.',
      remedy: QUARANTINE_REMEDY
    },
    'spawn-failed': {
      headline: 'EQ Companion could not start its data engine',
      body: `Windows refused to launch the program that reads your log file.${tries}`,
      remedy: QUARANTINE_REMEDY
    },
    'announce-timeout': {
      headline: 'The data engine started but never answered',
      body:
        `The program that reads your log file starts and then never reports itself ready.${tries} ` +
        'A security product holding it at launch will do this.',
      remedy: QUARANTINE_REMEDY
    },
    'bad-announce': {
      headline: 'The data engine is not the one this version expects',
      body:
        'The program that reads your log file answered with something EQ Companion does not ' +
        'recognise, which usually means a partial or damaged installation.',
      remedy: 'Reinstalling EQ Companion replaces it.'
    },
    unhealthy: {
      headline: 'The data engine stopped responding',
      body: `It starts, and then stops answering.${tries}`,
      remedy: null
    },
    exited: {
      headline: 'The data engine keeps shutting down',
      body: `It starts and then exits immediately.${tries}`,
      remedy: null
    }
  }
  return words[fault.kind]
}

/**
 * What the report button seeds the feedback form with.
 *
 * PRE-TAGGED SO TRIAGE CAN FIND THEM. The feedback contract carries exactly one categorisation —
 * `type: 'feature' | 'bug'` — so the failure class rides in the description as a literal marker
 * rather than as a field that does not exist. `engine-fault: unhealthy` is greppable across the
 * report store, which is the whole requirement.
 *
 * THE CANDIDATE PATHS ARE NOT IN IT, DELIBERATELY. They contain the user's own home directory, and
 * the telemetry bright line is that gameplay and machine detail never leave a client without the
 * user putting it there. They are drawn on the card, where the user can read them and type anything
 * they choose; what is seeded is the one word triage needs.
 */
export function reportPrefill(fault: EngineFaultSay): string {
  return `engine-fault: ${fault.kind}\n\nWhat happened just before this appeared:\n`
}
