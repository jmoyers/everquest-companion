// quietSwitch.ts — "another character's log is active — switch?", and the reason it cannot nag.
//
// THE REPORT (JOS-432, report 01M0G79DKNG0VK2B74N5TRB126). The app pins itself to ONE character's
// log for a whole session: the tailer follows the PERSISTED `activeLogPath`, nothing subscribes to
// "this character left the world", and the manual re-point is a designed no-op while the tailed log
// still sits under the re-picked dir (session.ts). So a player who switches characters IN GAME is
// left attached to a file nobody is writing any more — and the "connected" dot, which means only
// "a module delta arrived since the last rebuild", goes dark and stays dark. To the reporter that
// read as a dead app, and cost them an update, a reboot and a manual re-point before they gave up.
//
// THE OWNER'S RULING (2026-08-21) was option (b) and ONLY option (b): NUDGE, never auto-follow.
// Two accounts on one PC must never get yanked between characters, so nothing in this file switches
// anything — it decides when it is worth ASKING, once, and the answer is always the user's.
//
// ── WHY THE NEVER-SPAM GUARANTEE IS STRUCTURAL, NOT A POLICY ────────────────────────────────────
// The owner's constraint was verbatim law: the nudge must be structurally incapable of nagging.
// It is, for one reason, and it is worth stating plainly because every weaker design fails on the
// SAME edge — `nudged` is written at FIRE time, not at dismiss time, and it is never cleared.
//
//   * ONE NUDGE PER CANDIDATE LOG PER APP SESSION. `observe()` records the candidate in `nudged`
//     in the very statement that returns the nudge, so there is no path — no dismissal handler, no
//     IPC round trip, no renderer state — through which "we already asked about this log" can fail
//     to be remembered. A dropped or ignored nudge is remembered exactly as firmly as a dismissed
//     one, because remembering never depended on the user answering.
//   * THE KEY IS THE CANDIDATE ALONE, never the (attached, candidate) pair. That is what bounds
//     two-account alternation: A quiet / B growing asks about B; after the switch, B quiet / A
//     growing asks about A; from then on both are spent and the pair can alternate forever in
//     silence. A pair key would have allowed N² asks, which is nagging with extra steps.
//   * NO TIMER RE-FIRES IT. The poll is the only clock in the mechanism and it produces at most one
//     `nudge` per candidate ever, so "re-show after N minutes" is not a feature that was left out —
//     it is unreachable from here. Nothing reads window focus, so there is no re-show on focus.
//   * A QUIET LOG ALONE SAYS NOTHING. Growth of a SIBLING is required, and growth means growth THIS
//     app observed between two of its own polls — not an mtime, not a size we found on the first
//     look. A game client that crashed (the reporter's own 11:57 zone-in was the last line ever
//     written) grows nothing, so it fires nothing. That case is the honest indicator's job, and the
//     owner did not rule on the indicator this pass.
//   * THE THRESHOLD IS GENEROUS ON PURPOSE. Ordinary AFK and zoning gaps must never reach it; the
//     characterization's own trap is that the reporter's log had minutes-long gaps during normal
//     play. Five minutes of total silence, and only then do we even look at the directory.
//
// No fs, no Electron, no clock: every instant arrives as an argument, so `tests/quietSwitch.test.mts`
// drives the whole decision directly. The binding that samples the Logs dir and sends the IPC is
// `src/main/switchNudge.ts`.

/** One character log as this poll found it: where it is, and how big it is right now. */
export interface SiblingSample {
  readonly path: string
  readonly size: number
}

/** Everything one decision needs. The caller owns the clock and the directory read. */
export interface QuietSwitchObservation {
  /** Wall clock at the moment of the poll. */
  readonly now: number
  /** The log the tailer is attached to. */
  readonly activeLogPath: string
  /** When the tail last delivered a line — the ONE measure of "this app is seeing something". */
  readonly lastLineAt: number
  /**
   * Every `eqlog_*.txt` in the Logs dir with its current size, the active one included (it is
   * filtered out here so the caller never has to remember to). Empty is a legitimate reading and
   * means "we did not look" — see `logIsQuiet`, which is why the caller may skip the readdir.
   */
  readonly logs: readonly SiblingSample[]
}

export type QuietSwitchOutcome =
  /** The attached log is still producing lines. Nothing to ask about; any baseline is dropped. */
  | { readonly kind: 'live' }
  /** Quiet, but no sibling has been seen to GROW between two polls yet. */
  | { readonly kind: 'watching' }
  /** Ask — once, ever, for this log. */
  | {
      readonly kind: 'nudge'
      readonly logPath: string
      /** Bytes the candidate gained between the previous poll and this one. */
      readonly grewBy: number
      /** How long the attached log had been silent when we asked. */
      readonly quietMs: number
    }

/**
 * HOW LONG THE ATTACHED LOG MUST BE SILENT BEFORE THIS MECHANISM EXISTS AT ALL.
 *
 * Five minutes, chosen against the false-positive side because that is the side that annoys: a
 * character switch noticed five minutes late still saves the reporter's whole afternoon, while a
 * nudge during a bio break would be exactly the nagging the owner ruled out. Nothing shortens it in
 * production — the e2e override (switchNudge.ts) is gated on `EQ_E2E`.
 */
export const QUIET_MS = 5 * 60_000

/**
 * How often the binding polls once it has something to poll for. It is NOT a re-fire interval —
 * see the header: a candidate can only ever produce one nudge, so this only decides how quickly the
 * first one arrives (and, before that, how often a directory nobody is writing gets read).
 */
export const POLL_MS = 15_000

/**
 * The one definition of "the attached log has gone quiet", read by the core below AND by the
 * binding — which uses it to decide whether to pay for a `readdir` at all, so an app tailing a live
 * log touches the disk for this feature exactly never. If the two ever disagreed the core wins: it
 * re-derives the verdict from the same constant and a `live` outcome simply drops the baseline.
 */
export function logIsQuiet(lastLineAt: number, now: number, quietMs: number = QUIET_MS): boolean {
  return now - lastLineAt >= quietMs
}

/** Windows paths are case-insensitive; the memory of "we asked about this log" must be too. */
function key(path: string): string {
  return path.toLowerCase()
}

/**
 * The candidate with the most growth since the previous poll, skipping the active log and every log
 * this session has already asked about.
 *
 * A file with NO previous observation is never a candidate on the poll it first appears in — we
 * would be claiming growth we did not see. It joins the baseline and can win the next poll.
 */
function pickGrowing(
  logs: readonly SiblingSample[],
  active: string,
  before: ReadonlyMap<string, number>,
  spent: ReadonlySet<string>
): { path: string; grewBy: number } | null {
  let best: { path: string; grewBy: number } | null = null
  for (const log of logs) {
    const k = key(log.path)
    const was = before.get(k)
    if (k === active || spent.has(k) || was === undefined) continue
    const grewBy = log.size - was
    if (grewBy > 0 && (best === null || grewBy > best.grewBy)) best = { path: log.path, grewBy }
  }
  return best
}

/**
 * The decision, and the session-long memory that makes it un-spammable.
 *
 * One instance per app session (switchNudge.ts holds it). It deliberately OUTLIVES a character
 * switch — that is the whole point of the alternation bound in the header — and is reset by nothing
 * short of a relaunch.
 */
export class QuietSwitchWatcher {
  private readonly quietMs: number
  /** Candidate logs already asked about. WRITE-ONLY: nothing in this class ever removes a key. */
  private readonly spent = new Set<string>()
  private active: string | null = null
  /** Sizes as of the PREVIOUS poll of the current quiet stretch; null = no baseline yet. */
  private baseline: ReadonlyMap<string, number> | null = null

  constructor(quietMs: number = QUIET_MS) {
    this.quietMs = quietMs
  }

  /** Whether this session has already asked about a log (the e2e and the tests read it). */
  asked(logPath: string): boolean {
    return this.spent.has(key(logPath))
  }

  /**
   * Fold one poll into the decision.
   *
   * The baseline is per QUIET STRETCH and per attached log: a line arriving on the attached log
   * drops it, and so does a character switch. Growth therefore always means "this sibling gained
   * bytes between two consecutive polls while we were attached to a silent log" — which is the
   * narrowest true reading of "another character's log is active".
   */
  observe(o: QuietSwitchObservation): QuietSwitchOutcome {
    const active = key(o.activeLogPath)
    if (this.active !== active) {
      this.active = active
      this.baseline = null
    }
    if (!logIsQuiet(o.lastLineAt, o.now, this.quietMs)) {
      this.baseline = null
      return { kind: 'live' }
    }
    const before = this.baseline
    const sizes = new Map<string, number>()
    for (const log of o.logs) sizes.set(key(log.path), log.size)
    this.baseline = sizes
    if (before === null) return { kind: 'watching' }
    const grown = pickGrowing(o.logs, active, before, this.spent)
    if (grown === null) return { kind: 'watching' }
    // THE ONE STATEMENT THE WHOLE GUARANTEE RESTS ON: the memory is written HERE, beside the
    // return, so no later step — a dismissal, an IPC send, a renderer that never mounted — can be
    // the thing that was supposed to remember and didn't.
    this.spent.add(key(grown.path))
    return { kind: 'nudge', logPath: grown.path, grewBy: grown.grewBy, quietMs: o.now - o.lastLineAt }
  }
}
