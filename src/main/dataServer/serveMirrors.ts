// ============================================================================
// serveMirrors.ts — THE SYNCHRONOUS READERS' HALF OF THE CUTOVER (JOS-496).
// ============================================================================
//
// The census found eighteen synchronous main-side readers of the fold, and said the important thing
// about them: ONLY THREE ARE GENUINE QUERIES. `serveShim.ts` shimmed those three, because a query
// can be made to wait — its callers are `ipcMain.handle` handlers, which already return promises.
//
// THE REST ARE MIRRORS, and a mirror cannot wait. `viewerLevel()` is read on every draw of a resist
// card from inside a synchronous profile builder; `inventoryWrittenAt(file)` is handed to the
// inventory parser AS A FUNCTION and called mid-parse. Neither has an `await` to spend, and giving
// them one would mean rewriting the two bodies of code they are read from — which is a great deal
// of churn to pay for a fact that changes a handful of times an hour.
//
// So this file is the third shape the cutover needs, beside the query shim and the delta push: a
// SMALL, PUSHED CACHE of the engine's answer for a named module, refreshed when the engine says the
// module moved, and read synchronously by whoever needs it. It is the "moduleChanged-driven mirror"
// the ticket names.
//
// ── WHY THIS IS NOT THE CACHE RULING 5 FORBIDS ─────────────────────────────────────────────────
//
// It is worth saying plainly, because the word is the same. Ruling 5 forbids caching FOLD RESULTS
// so that the app can avoid asking — a second source of truth, aging on its own, that the engine
// cannot invalidate. This is the opposite construction: the ENGINE decides when it is stale (the
// `moduleChanged` cursor is the engine's own publication edge, not a timer of ours), the app never
// extends its life, and the world edges below drop it entirely. It holds exactly one round trip's
// worth of lag behind an authority that pushes.
//
// It also does not survive anything. A world change, an engine death, a character switch — every one
// of them empties it, and an empty mirror is not a guess, it is `null`, which every reader below
// turns into the app's own fold exactly as the shim's fallback does.
//
// ── STALE BY AT MOST ONE ROUND TRIP, AND THAT IS THE HONEST PRICE ──────────────────────────────
//
// The refresh is asynchronous, so between the engine publishing a cursor and this file holding the
// state it names there is one loopback round trip — sub-millisecond to a process that has already
// folded, and the frames themselves are coalesced by the engine at its serve beat (~10 Hz). What a
// reader sees in that window is the PREVIOUS served value, never a torn one and never a value from
// the other world.
//
// The two facts mirrored today were both chosen with that price in mind. `character` moves on a ding
// or a zone; the resist card's contract is that a ding moves the tag "on the next draw with no
// re-fold" (`ipc/resist.ts`), and a draw is a user action milliseconds later. `outputFiles` moves
// when the player types `/outputfile`, and the file it names is read seconds afterwards by a watcher.
// A fact that mattered at sub-round-trip resolution would not belong here at all — it would belong
// on a query.
//
// ── NO IMPORTS AT ALL, AND THAT IS `readShim.ts`'s SPLIT RESTATED ─────────────────────────────
//
// Two things follow from it, and the second is the one that earns it.
//
// THERE IS NO CYCLE. `engineClientHost.ts` owns the connection and the turn, and it is what tells
// this file both that a cursor moved and that the world changed. So it imports THIS, and this
// imports nothing of it: the requester arrives through `installMirrors`, the same one-slot shape
// `definePush.ts` uses for the preference-write edge — a leaf that reached back into the composition
// root would be a cycle between two files that boot each other.
//
// AND THE WHOLE MATRIX IS A `node:test` UNIT. The awkward cases here are all timing — a reply that
// lands after a world change, a burst of cursors during one in-flight refresh, a cursor that arrives
// out of order, a refusal — and every one of them is impossible to stage against a real engine and
// trivial against a fake requester. That is why even the LOG SINK is injected rather than imported:
// one `logInfo` would drag `electron` in through `errorLog.ts` and there would be no unit at all.
// The same reasoning `readShim.ts` gives for taking its clock, its sink and its bounds as deps.

/**
 * WHICH MODULES ARE MIRRORED. A closed list, and it is closed on purpose: every member costs a
 * round trip per publication beat in which it moved, so a module joins this list only when a
 * synchronous main-side reader exists for it and has nowhere to put an `await`.
 *
 *   * `character` — `ipc/resist.ts resistProfileDeps().viewerLevel`, read on every draw of a resist
 *     card and of every `/con` chip.
 *   * `outputFiles` — `session.ts inventoryWrittenAt`, handed to the inventory parser as a function
 *     and called from inside a synchronous parse.
 *
 * A MODULE NOT ON THIS LIST IS NOT MIRRORED RATHER THAN LAZILY MIRRORED, which is what keeps the
 * cost of this file a thing a reader can count rather than a thing that grows.
 */
export const MIRRORED_MODULES: readonly string[] = ['character', 'outputFiles']

/** One module's mirrored state, and what it is a mirror OF. */
interface Mirror {
  /** The engine's published state for this module, or null when nothing has been taken yet. */
  state: unknown
  /** The cursor the held state was taken at. Compared against an incoming frame's so a refresh that
   *  lands out of order cannot move the mirror backwards — the engine's `seq` is monotonic within a
   *  world, and the world edges reset both halves together. */
  seq: number
  /** A refresh is in flight. One at a time per module: a burst of cursors during a busy tail must
   *  not become a burst of round trips, and the one in flight will be superseded by the next
   *  cursor anyway. */
  inFlight: boolean
}

const mirrors = new Map<string, Mirror>()

/** One `module.snapshot`, as this file needs it: the echo, the cursor, the state. */
export interface MirrorReply {
  readonly module: string
  readonly seq: number
  readonly state: unknown
}

/** Everything this file cannot get for itself. See the header for why even the sink is injected. */
export interface MirrorDeps {
  /** How the mirror asks the engine. Rejects when the engine refused or is not there. */
  request: (module: string) => Promise<MirrorReply>
  /** Where the one narration goes. */
  note: (line: string) => void
}

/** Filled by `engineClientHost.ts` at install, null otherwise — which is what makes a launch with no
 *  engine pay one null comparison per cursor and nothing else. */
let deps: MirrorDeps | null = null

/**
 * Install (or remove) the way this file talks to the engine and to the dev log. `null` drops every
 * mirror on the way out: a synchronous reader must never be left holding a served fact after the
 * connection that served it is gone.
 */
export function installMirrors(next: MirrorDeps | null): void {
  deps = next
  noted = false
  if (next === null) resetMirrors()
}

/**
 * THE SYNCHRONOUS READ. `null` means "the engine has not answered for this module in this world" —
 * no client, not serving, not yet primed, or the world just changed — and every caller turns that
 * into its own fold's answer, which is the same fallback rule `readShim.ts` states for a query.
 *
 * NULL IS NEVER A VALUE HERE. None of the mirrored modules publishes a null state, so a caller can
 * read `null` as "ask your own fold" without ambiguity — the same reservation `serveShim.ts` makes
 * of `null` in its projections.
 */
export function mirroredModuleState(moduleId: string): unknown {
  return mirrors.get(moduleId)?.state ?? null
}

/**
 * THE ENGINE SAYS A MODULE MOVED. Called for every `moduleChanged` frame this app accepts — the
 * mirror only reacts to the modules it holds, so an unmirrored module costs one map lookup.
 *
 * IT IS VOIDED AND IT NEVER THROWS. This runs inside the client's frame dispatch, where a throw
 * surfaces as a transport fault (`alertsAudio.ts playEngineFire` learned the same rule): a mirror
 * that could break the connection would be a diagnostic convenience taking the product down.
 */
export function noteMirrorChanged(moduleId: string, seq: number): void {
  if (!MIRRORED_MODULES.includes(moduleId)) return
  const m = mirrors.get(moduleId) ?? { state: null, seq: -1, inFlight: false }
  mirrors.set(moduleId, m)
  if (seq <= m.seq || m.inFlight) return
  void refresh(moduleId, m)
}

/**
 * PRIME EVERY MIRROR. Called on the go-live edge, which is the moment the shim starts serving and
 * therefore the moment a mirror's `null` stops meaning "not serving" and starts meaning "not yet
 * asked". Without it the first draw after a fold would fall back for no reason: the engine has
 * published nothing since going live, so no cursor is coming.
 */
export function primeMirrors(): void {
  for (const moduleId of MIRRORED_MODULES) {
    const m = mirrors.get(moduleId) ?? { state: null, seq: -1, inFlight: false }
    mirrors.set(moduleId, m)
    if (!m.inFlight) void refresh(moduleId, m)
  }
}

/**
 * THE WORLD CHANGED HANDS. Every mirror is dropped, and dropping is the whole of it: a served
 * `character` state from the world somebody has since replaced is a fact about a different log, and
 * a mirror that kept it would answer with authority about a character the app is no longer on.
 *
 * The same edge `serveDeltas.pushWorldChanged` reports to the renderers, for the same reason.
 */
export function resetMirrors(): void {
  mirrors.clear()
}

async function refresh(moduleId: string, m: Mirror): Promise<void> {
  const d = deps
  if (d === null) return
  m.inFlight = true
  try {
    const reply = await d.request(moduleId)
    // STILL THE MIRROR THIS TURN OWNS? `resetMirrors` replaces the map wholesale, so a reply that
    // lands after a world change belongs to an object no longer in it — and writing to it would be
    // writing to nobody, which is right, but re-inserting it would resurrect the old world.
    if (mirrors.get(moduleId) !== m) return
    // THE ECHO TEST, `serveShim.ts projectModule`'s exactly: an answer for a module we did not ask
    // about is a bookkeeping failure somewhere between here and the fold, and holding another
    // module's state under this module's name is the one outcome that cannot be debugged.
    if (reply.module !== moduleId) return
    if (reply.seq < m.seq) return
    m.state = reply.state
    m.seq = reply.seq
  } catch (err) {
    // A REFUSAL IS NOT AN ERROR HERE, it is the fallback path. The mirror keeps whatever it had —
    // which for a fresh one is `null`, i.e. nothing to report yet — and says so once, at debug, on
    // the same coalescing principle `readShim.ts` argues at length: these are pushed at a cadence,
    // and a line per failure would bury the dev log.
    //
    // THE SENTENCE NAMES THE STALENESS, NOT A SECOND WORLD (JOS-501). It used to say "the app's own
    // fold answers until the engine does", which was true until JOS-499 deleted that fold; what a
    // reader of this mirror actually gets meanwhile is the LAST SERVED VALUE, or nothing at all if
    // none has arrived on this launch.
    if (!noted) {
      noted = true
      d.note(
        `data-server mirror: ${moduleId} could not be refreshed ` +
          `(${err instanceof Error ? err.message : String(err)}); readers keep the last served ` +
          'value until the engine answers again. Further mirror refusals on this launch are silent.'
      )
    }
  } finally {
    m.inFlight = false
  }
}

/** Whether a refusal has already been narrated on this launch — see `refresh`'s catch. */
let noted = false
