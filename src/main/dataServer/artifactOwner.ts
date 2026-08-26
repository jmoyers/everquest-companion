// ============================================================================
// artifactOwner.ts — WHO OWNS THE FOLD'S PERSISTED FILES, RIGHT NOW (JOS-497 item 2).
// ============================================================================
//
// Boundary verdict 4 says the fold-owned persisted artifacts move INTO the engine with their IO:
// `<userData>/resist-ledger.json` and `<userData>/message-overlay.json`. JOS-496 built the engine
// half — it reads and writes both, at the app's existing paths, in the app's byte-verbatim formats
// — and DELIBERATELY DID NOT THROW THE SWITCH, for a reason worth restating because it is the
// reason this file has the shape it has:
//
//   > Sending `stateDir` while `src/main/resist/store.ts` and `src/main/data/overlayPersistence.ts`
//   > still persist would put two processes on one file with two cadences.
//
// So the switch is not a flag. It is an OWNERSHIP LATCH with exactly two states, and the whole
// design goal is that there is never an instant at which both processes believe they own a file.
//
// ── THE HANDOVER IS BOOT-ORDERED, AND THE ORDER IS STRUCTURAL RATHER THAN A CONVENTION ─────────
//
// The engine cannot write either file until it is told WHERE they are, and the only thing that
// tells it is `stateDir` on `session.attach` (the schema says why it rides the attach rather than
// being a `*.define`: the seed must be in place before the first byte is folded). That is the
// lever, and [`attachStateDir`] is the only way to pull it.
//
// THE FUNCTION FLIPS THE LATCH BEFORE IT RETURNS THE PATH. A caller cannot obtain the string to put
// on the wire without this process having ALREADY stopped persisting — not because a call site
// remembered to do them in the right order, but because there is no order in which they can be done
// wrongly. That is what "the app stops BEFORE the engine starts, a boot-ordered handover rather
// than a flag race" means when it is written as code instead of as a comment.
//
// The gap between the two is therefore not "one round trip"; it is the rest of `sendAttach`'s
// synchronous body plus a socket write plus a fold. The engine's first write is sixty LIVE beats
// after that.
//
// ── AND THE PREDICATE IS A FACT ABOUT A LIVE ENGINE, NEVER A FLAG ──────────────────────────────
//
// JOS-496's other finding, and it cost a shipped silence elsewhere in this program: `shimServing()`
// is two default-on environment flags and says NOTHING about a binary existing. A checkout that has
// never run `cargo build` answers it `true`, has no engine, and would — under a flag-shaped switch
// — stop persisting with nothing at all writing in its place. Every mob this user ever fought,
// silently no longer accreting.
//
// So `serving` is one of two inputs here and the other is the one that carries the weight: this
// function is reached only from inside `sendAttach`, which runs only when there is a CONNECTED
// client to send an attach ON. A connected client is a fact about a process that exists, answered
// a hello, and is about to be handed a log to fold. The flag decides whether the engine is in the
// read path at all; the connection decides whether there is anybody to hand the files to.
//
// ── HANDING BACK, AND WHY IT IS NOT SYMMETRIC ──────────────────────────────────────────────────
//
// [`takeArtifactsBack`] is called when the engine's launch ENDS while this app carries on — a
// crash, a failed health probe, a respawn. The alternative (one-way for the launch) was considered
// and refused: an engine that dies at minute two of a six-hour session would leave nothing writing
// these files for the rest of the evening, and the resist ledger's whole value is that it accretes.
// A dead process is not an owner, so handing back keeps the invariant rather than bending it.
//
// The respawn then takes them again through the same door, because a fresh launch sends a fresh
// attach. Ownership therefore alternates in strict sequence and is never shared.
//
// THE NAMED RESIDUAL, because it is real and small rather than absent. The supervisor reports a
// launch as over on paths where the child may still be alive for the moment it takes to be killed
// (a failed health probe escalating to `kill`). In that window this process resumes ownership while
// a doomed one has not yet exited. What it costs is bounded by construction: both writers are
// temp + fsync + rename, so no reader can ever see a torn file, and both coalesce on a content
// fingerprint at a sixty-second cadence — so the worst case is that one of two VALID and
// parity-equal documents wins. It is a content race with no corrupt outcome, not a shared file.
//
// ── NO IMPORTS, FOR `serveMirrors.ts`'s REASON ─────────────────────────────────────────────────
//
// The two writers this gates (`resist/store.ts`, `data/overlayPersistence.ts`) are leaves that
// Electron-free fold code reaches; the caller that flips the latch owns a socket. A module both can
// import has to import neither, so the `userData` path and the log sink both arrive as arguments.
// It also makes the whole state machine a `node:test` unit, which is the only way the ordering
// claim above can be PROVEN rather than asserted in prose.

/** Which process is responsible for writing the fold's persisted artifacts. */
export type ArtifactOwner = 'app' | 'engine'

/**
 * The latch. `'app'` on every launch, because that is what this app has always been and what a
 * launch with no engine — the cargo-less checkout, the packaged build whose engine failed to spawn,
 * `EQC_ENGINE=0` — stays for its whole life.
 */
let owner: ArtifactOwner = 'app'

/** Who owns them right now. Exported for the dev log and for the tests; the product asks the two
 *  predicates below, which say what a caller actually wants to know. */
export function artifactOwner(): ArtifactOwner {
  return owner
}

/**
 * MAY THIS PROCESS WRITE THE FOLD'S PERSISTED ARTIFACTS?
 *
 * Asked by `persistResistLedger()` and by both of the overlay register's savers — INSIDE the
 * writers rather than at their call sites, so a future call site cannot escape the latch by
 * forgetting about it. That is the same argument `windows.ts` makes for one `WEB_PREFERENCES()`.
 */
export function appOwnsArtifacts(): boolean {
  return owner === 'app'
}

/** Whether the engine has been handed them. The inverse, spelled out for readers that are asking
 *  the positive question. */
export function engineOwnsArtifacts(): boolean {
  return owner === 'engine'
}

/** Everything `attachStateDir` cannot get for itself — see the header for why nothing is imported. */
export interface HandoverDeps {
  /**
   * MAY THE ENGINE BE GIVEN THESE FILES ON THIS LAUNCH. It carried `serveShim.ts shimServing()`
   * until JOS-499 deleted that flag, and `engineClientHost.ts` now passes `true`: an attach is only
   * ever sent by a connected client, and this process folds nothing left to persist.
   *
   * THE PARAMETER STAYS rather than being inlined, and the reason is the one this whole file is
   * about: the ordering it enforces (stop persisting, THEN produce the directory) is what makes the
   * handover safe, and a caller that could not say no would be a seam with nothing to test. The
   * `false` branch is the unit suite's, and it is how the two-processes-on-one-file hazard stays
   * provably closed.
   */
  readonly serving: boolean
  /** Electron's `app.getPath('userData')` — the directory both artifacts live in. */
  readonly userData: () => string
  /** Where the one narration goes. */
  readonly note: (line: string) => void
}

/**
 * THE HANDOVER, AND THE ONLY WAY TO GET THE PATH THAT PERFORMS IT.
 *
 * Returns what `session.attach` should carry as `stateDir`, or `undefined` for "say nothing" —
 * which the schema defines as NO PERSISTENCE AT ALL engine-side, i.e. exactly the file-free attach
 * every non-app client (the parity runner, every test) gets today.
 *
 * READ THE ORDER OF THE TWO STATEMENTS AT THE BOTTOM. The latch moves, and only then is the path
 * produced. There is no arrangement of the call site that can send the path first, which is the
 * whole point of resolving `stateDir` here instead of at the request builder.
 *
 * IT IS IDEMPOTENT. A second attach on the same connection (a character switch) finds the latch
 * already moved, narrates nothing, and hands back the same directory — the ledger is filed per
 * character bucket inside one file, so a switch changes which bucket is discarded and not where
 * anything lives.
 */
export function attachStateDir(deps: HandoverDeps): string | undefined {
  if (!deps.serving) return undefined
  const dir = deps.userData()
  if (owner === 'engine') return dir
  // THE APP STOPS HERE. Every writer's guard reads this variable, and every one of them is
  // synchronous, so from the next statement onward this process persists neither artifact.
  owner = 'engine'
  deps.note(
    'data-server artifacts: the engine now owns resist-ledger.json and message-overlay.json ' +
      `(${dir}); this process has stopped persisting them`
  )
  // …and only now does the caller get something it could put on a socket.
  return dir
}

/**
 * THE ENGINE'S LAUNCH IS OVER AND THIS APP IS STILL RUNNING. Returns whether ownership actually
 * moved, so the caller narrates once rather than on every teardown of a launch that never had them.
 *
 * See the header for why this exists at all rather than the latch being one-way, and for the one
 * residual it carries.
 */
export function takeArtifactsBack(note: (line: string) => void): boolean {
  if (owner === 'app') return false
  owner = 'app'
  note(
    'data-server artifacts: the engine is gone, so this process owns resist-ledger.json and ' +
      'message-overlay.json again'
  )
  return true
}

/** Test seam: back to the state every launch starts in. */
export function resetArtifactOwnerForTests(): void {
  owner = 'app'
}
