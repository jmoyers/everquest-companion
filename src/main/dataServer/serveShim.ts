// ============================================================================
// serveShim.ts — THE COMPAT SHIM, WIRED (JOS-489, phase 1 of the cutover).
// ============================================================================
//
// `readShim.ts` is the decision with no world attached; this is the world. It hands the shim a real
// connection and a real log sink, and states what each channel's served answer must look like to
// count as an answer. `src/main/ipc/world.ts` takes three of them; `ipc/resist.ts` and
// `ipc/knowledge.ts` take one each.
//
// ── ONE WORLD (JOS-499, the deletion release) ────────────────────────────
//
// THIS FILE USED TO OWN A FLAG. `EQC_ENGINE_SERVE` decided, per call, whether the ENGINE or this
// process's own fold answered a read, and the header that stood here argued at length about why
// that deserved a switch of its own. There is no second fold and no switch: every read below is
// served or is honestly unanswerable, and `readShim.ts`'s `own()` thunk — which used to be the
// TypeScript arm — now carries the EMPTY SHAPE each channel owes its caller.
//
// WHAT THE ONE LAW BECAME. It used to read: the shim must never make the app worse than the
// flag-off world. There is no flag-off world to be no worse than, so the law is now the plainer
// one the deletion release rests on — A READ THAT CANNOT BE SERVED SAYS SO, and never invents.
// Each channel's unserved answer is the shape its surface already draws before there is anything
// to draw: `null` for a module snapshot, a `hydrating` meter, no search hits, no `dropsSeen`. And
// every one of them is still COUNTED AND NAMED in the dev log with its reason, so a blank surface
// always has an explanation a developer can read.

// ── THE THREE PROJECTIONS, AND THE TWO GUESS TESTS ─────────────────────────────────────────────
//
// A reply that passed the protocol's own result guard can still not be an ANSWER (readShim.ts's
// header). Two of the three channels can say so cheaply and do:
//
//   * `module.snapshot` echoes the module it answered for. An echo that is not the id we asked for
//     is a bookkeeping failure somewhere between here and the fold, and the honest response is the
//     app's own state rather than another module's under this module's name.
//   * `combat.snapshot` states the instant it was taken at, and the schema is explicit that the
//     engine uses the FOLD's clock — the log's own timestamps, weeks or months old — at every
//     moment before its tail goes live. A snapshot stamped with the log's clock is a real prefix
//     state and a false present: every `active` flag and every elapsed time in it is measured
//     against a moment that is not now. The readiness gate already refuses a non-live engine, so
//     this is the belt to that pair of braces, and it is worth its two lines because the failure it
//     catches is invisible — the payload looks perfect.
//   * `combat.searchFights` has no such test and is not given a fake one. It is a ranked answer to
//     a question; there is no field in it that could be checked against anything this process knows
//     without re-running the search, which is the thing the shim exists to avoid.
//
// ── THE TWO CASTS, NAMED RATHER THAN HIDDEN ────────────────────────────────────────────────────
//
// `CombatState` and the protocol's `FightSearchHit` are the schema's deliberate holes: the schema
// says an OBJECT and nothing about its shape, because `src/shared/combat.ts CombatSnapshot` is the
// app's own contract with its renderer and a meter growing a column must not be a protocol change
// (protocol.generated.ts says exactly this on both types). So the shim asserts what the schema
// declined to state. THAT ASSERTION IS THE THING THE E2E EXISTS TO CHECK — the parity seam below
// compares the two worlds' answers field by field with `firstDiff`, which is the only honest way to
// hold a cast like this one accountable.

import { logInfo } from '../errorLog'
import { engineLogMtimeMs, engineRequest, engineServeReadiness } from './engineClientHost'
import { createReadShim, type ReadShim } from './readShim'
import type { CombatSnapshot, FightSearchResult, SnapshotOpts } from '../../shared/combat'
import type { MobLevelFact } from '../resist/world'
import type { MobSeenDrop } from '../../shared/mobTypes'
import type {
  CombatSnapshotOpts,
  ModuleSnapshotResult
} from '../../shared/dataServer/protocol.generated'

/** What `registry.snapshot(id)` answers with, and therefore what `module:getSnapshot` returns. */
export interface ModuleSnap {
  readonly seq: number
  readonly state: unknown
  /**
   * THE ENGINE ANSWERED THIS ONE (JOS-493). Absent on the app's own arm — including every launch
   * with the flag off — which is what keeps the flag-off reply the shape it has always been.
   *
   * It is a fact about the ANSWER, not about the launch, and the folders need it to be: `seq` above
   * is a cursor in whichever world produced it, so a renderer must know which channel of the two
   * carries its increments (`shared/types.ts ModuleSnapshot.served`, `serveDeltas.ts`).
   */
  readonly served?: true
}

// `TsArms` LIVED HERE AND IS GONE (JOS-499). It was the app's own fold, handed in by `world.ts` so
// the TS arm stayed visible at the call site "the cutover will one day delete". This is that
// cutover, and the interface had exactly three readers — the fallback, the parity probe's second
// arm, and the flag-off answer — all of which were the same fold and all of which are deleted.

/**
 * How long the engine arm may take. A BOUND ON THE PATHOLOGICAL CASE, not a budget — a loopback
 * round trip to a process that has already folded the log is sub-millisecond, and the deadline
 * exists for the engine that accepted a request and will never answer it. Two seconds is the same
 * number `engineHost.ts` and `engineClientHost.ts` already use for a loopback connect, for the same
 * reason: loopback either answers immediately or is not going to.
 */
const SERVE_TIMEOUT_MS = 2_000

/** How often the coalesced fallback sentence may be printed. Five seconds is long enough that a
 *  disconnected engine costs one line per five seconds rather than one per poll, and short enough
 *  that a developer flipping the flag sees the answer before they alt-tab away. */
const NOTE_EVERY_MS = 5_000

/**
 * HOW FAR THE ENGINE'S `now` MAY BE FROM THIS PROCESS'S before its combat snapshot is treated as a
 * guess. Both processes are on the same machine and the same wall clock, so a LIVE engine's stamp
 * and `Date.now()` differ by the round trip. Anything approaching a minute is not clock skew, it is
 * the fold's own clock — which is the schema's stated behaviour before the tail goes live and is
 * exactly the state this test is for.
 */
const NOW_SKEW_MS = 60_000

// `SERVING` AND `shimServing()` ARE GONE (JOS-499 item 9). The flag answered "does the ENGINE
// answer this app's reads, or does its own fold?" — a question with one arm left. Every call site
// branched between two worlds and there is one, so the branch is deleted rather than defaulted to
// true: a gate that can only answer one way is a gate a reader has to prove is dead, and this
// release is where the proof stops being necessary.
//
// `engineEnabled()` IS NOT REPLACED BY ANYTHING EITHER, and that is the same argument one level up.
// `EQC_ENGINE=0` used to mean "run the app on its own fold"; there is no such app. What used to be
// a supported configuration is now simply an app that cannot answer, which is the engine-absent
// state this release makes honest rather than a mode anybody selects.

/** A promise that resolves later without ever being the reason this process stays alive —
 *  `engineClientHost.ts`'s timer rule, restated for the deadline. */
function delay(ms: number): Promise<void> {
  return new Promise<void>((resolve) => {
    const handle = setTimeout(resolve, ms)
    handle.unref()
  })
}

/** Built on first use, so a launch with the flag off allocates nothing at all. */
let shim: ReadShim | null = null

function readShim(): ReadShim {
  shim ??= createReadShim({
    readiness: engineServeReadiness,
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

// ── the options, translated once ───────────────────────────────────────────────────────────────

/**
 * `SnapshotOpts` → the schema's `CombatSnapshotOpts`, field by field.
 *
 * NOT A SPREAD, AND NOT A CAST. The two shapes agree today and the schema's own comment says an
 * unlisted key is IGNORED rather than refused, so a spread would compile and work — right up to the
 * day the app grows an option, at which point it would travel to an engine that silently does not
 * do it and nobody would find out from the code. Writing the four out makes `OPTS_ARE_STATED`
 * below a compile-time tripwire on exactly that day.
 *
 * ABSENT STAYS ABSENT. Every field is absent-means-the-engine's-default (schema), so a `false` or a
 * `0` the caller did not write must not be invented here.
 */
function engineOpts(o: SnapshotOpts): CombatSnapshotOpts {
  const out: CombatSnapshotOpts = {}
  if (o.selectedId !== undefined) out.selectedId = o.selectedId
  if (o.showUnparsed !== undefined) out.showUnparsed = o.showUnparsed
  if (o.maxSegments !== undefined) out.maxSegments = o.maxSegments
  if (o.timeline !== undefined) out.timeline = o.timeline
  return out
}

/** THE TRIPWIRE. A new member of `SnapshotOpts` is a compile error here until `engineOpts` carries
 *  it — or until somebody writes it down as deliberately app-side, which is a decision that should
 *  cost a line rather than happening by omission. */
export const OPTS_ARE_STATED: Record<keyof SnapshotOpts, true> = {
  selectedId: true,
  showUnparsed: true,
  maxSegments: true,
  timeline: true
}

// ── the three channels ─────────────────────────────────────────────────────────────────────────

// ── the module projection, and the one fact it grafts ──────────────────────────────────────────

/** The module whose published state carries a fact no fold can produce — see `graftLastPlayed`. */
const CHARACTER_MODULE = 'character'

/**
 * THE `lastPlayed` GRAFT (JOS-493, owner ruling 21's served fact).
 *
 * WHAT WAS LEAKING. `CharacterSnap.character` is a `CharacterRef`, and the app's own fold publishes
 * it with `lastPlayed = statSync(logPath).mtimeMs` — pushed in by `session.ts`, never folded from a
 * line (`main/log/config.ts`). The ENGINE's `character` module cannot carry it and must not: it
 * derives its ref from the log's file NAME, and ruling 18 says a served PROCESS fact is not
 * addressed by (log identity, byte offset) and has no business inside fold state. So under
 * `EQC_ENGINE_SERVE=1` the served snapshot reached the product with the field simply gone, and the
 * character picker — whose whole sort key is `lastPlayed` (`TitleBar.tsx`) — silently lost it.
 * JOS-490 caught it as an unpinned fold divergence in the product path.
 *
 * WHY A GRAFT AND NOT A FOLD CHANGE. Ruling 21 already settled where the fact lives: the ENGINE
 * SERVES it, on `session.health` as `logMtimeMs`, because the engine is the process that owns the
 * file. This puts the served answer where the app's contract expects to find it, and it is the
 * SHIM's job by construction — the shim is the compatibility layer, and the alternative (teaching
 * the Rust fold to stat a file) is the thing the ruling forbids. It is temporary in exactly the way
 * the shim is: the graft goes when the picker reads `session.health` for itself, which is the
 * character-picker cutover.
 *
 * IT IS NOT MANUFACTURED AGREEMENT. `engine-shim.e2e.mts` states the honest residual: the protocol
 * carries an INTEGER millisecond and Node reports the NTFS stamp as a float, so what is grafted is
 * `Math.floor` of what the app's own fold publishes, and the spec pins it at that precision rather
 * than pretending the two are bit-identical. Nothing else about the served state is touched — a
 * shim that rewrote a served field would hide the very gaps the ledger is tracking (this file's
 * header, and `engine-shim.e2e.mts KNOWN_ASYMMETRY`).
 *
 * ABSENT STAYS ABSENT. No mtime from the engine means no graft, never a zero: a `lastPlayed` of 0
 * is a card that says 1970, which is worse than a card that says nothing.
 */
function graftLastPlayed(state: unknown): unknown {
  const mtime = engineLogMtimeMs()
  if (mtime === null) return state
  if (state === null || typeof state !== 'object') return state
  const snap = state as { character?: unknown }
  const ref = snap.character
  // A null ref is the honest "no character attached", and inventing an mtime for nobody would be a
  // guess in exactly the sense `readShim.ts` means it.
  if (ref === null || typeof ref !== 'object') return state
  return { ...snap, character: { ...(ref as Record<string, unknown>), lastPlayed: mtime } }
}

/**
 * One `module.snapshot` reply, as this app's own reply.
 *
 * ONE FUNCTION FOR BOTH THE PRODUCT AND THE PROBE, and that is the point of pulling it out of the
 * two call sites: the harness seam's engine arm must be what the SHIM would serve, or a spec
 * comparing the two arms would be pinning a projection nothing ships. The echo test (see the
 * header) and the graft above are both part of "what this app answers", so both live here.
 */
function projectModule(moduleId: string, r: ModuleSnapshotResult): ModuleSnap | null {
  if (r.module !== moduleId) return null
  const state = moduleId === CHARACTER_MODULE ? graftLastPlayed(r.state) : r.state
  return { seq: r.seq, state, served: true }
}

/**
 * `module:getSnapshot`, served — see the header for the echo test, `projectModule` for the graft.
 *
 * `null` IS THE HONEST ANSWER when the engine cannot serve (JOS-499). There is no app-side fold to
 * fall back to, and the renderer's `useModule` already reads null as "no state yet" — so a view
 * draws its loading/unavailable state rather than being handed invented emptiness. The REASON is
 * still counted and narrated by `readShim.ts`, so the silence is legible in the dev log.
 */
export function serveModuleSnapshot(moduleId: string): Promise<ModuleSnap | null> {
  return readShim().serve('module.snapshot', { module: moduleId }, (r) =>
    projectModule(moduleId, r)
  , () => null)
}

/** `combat:snapshot`, served — see the header for the clock test and for the cast. */
export function serveCombatSnapshot(
  opts: SnapshotOpts,
  own: () => CombatSnapshot
): Promise<CombatSnapshot> {
  return readShim().serve(
    'combat.snapshot',
    { opts: engineOpts(opts) },
    (r) =>
      Math.abs(r.now - Date.now()) > NOW_SKEW_MS ? null : (r.snapshot as unknown as CombatSnapshot),
    own
  )
}

/** `combat:searchFights`, served. The clamp stays in `world.ts`: the schema mirrors this app's own
 *  clamping rule, so sending a pre-clamped number means both worlds search the same corpus slice
 *  rather than each applying its own bound to a different input. */
export function serveSearchFights(
  text: string,
  limit: number | undefined,
  own: () => FightSearchResult
): Promise<FightSearchResult> {
  return readShim().serve(
    'combat.searchFights',
    limit === undefined ? { query: text } : { query: text, limit },
    (r) => ({ hits: r.hits, corpus: r.corpus }) as unknown as FightSearchResult,
    own
  )
}

// ── the fourth channel: how old is this creature (JOS-497 item 1) ──────────────────────────────

/**
 * ONE CREATURE'S LEVEL, SERVED — `resist/module.ts levelOf`, which was the LAST fact main read out
 * of its own fold synchronously (JOS-496 named it in place: "the single remaining synchronous fold
 * read on the resist path").
 *
 * ── WHY IT IS A CHANNEL HERE RATHER THAN A MIRROR ──────────────────────────────────────────────
 *
 * `serveMirrors.ts` exists for readers with nowhere to put an `await`, and `viewerLevel()` is one.
 * THIS one is not, and the difference is the shape of the answer rather than the shape of the
 * caller: a mirror holds a module's WHOLE published state, the resist module publishes two integers
 * (`{rows, mobs}`), and this fact is in neither of them. It could not be mirrored even in
 * principle — the answer is keyed by creature name, so a mirror of it would be an unbounded map of
 * every mob anybody ever cons, growing forever, which is precisely the cache ruling 5 forbids.
 *
 * So the fold read had to become a QUERY, and the two callers were made to be able to wait for it.
 * `ipc/resist.ts`'s handlers already could (they are `ipcMain.handle` bodies). The con card could
 * not and now can: under serve its trigger is already a frame off a socket, so one more loopback
 * round trip before the window opens is measured in the same microseconds the card already spends.
 *
 * ── THE ANSWER IS WRAPPED, AND THAT IS NOT CEREMONY ────────────────────────────────────────────
 *
 * `null` is reserved by `readShim.ts` for "the reply was not an ANSWER" — the guess test's verdict,
 * which falls back to the app's own fold. But `null` is ALSO the honest served answer here: a
 * creature nobody has conned and the committed catalog has never heard of has no level, and
 * `levelOf` says so with a null. Two different `null`s on one channel is exactly the ambiguity the
 * shim's header warns about, so the projection hands back a box: a box is an answer, and no box is
 * a fallback.
 *
 * ── AND THE ECHO TEST IS `module.snapshot`'s ──────────────────────────────────────────────────
 *
 * The engine echoes the name as it was ASKED — never the folded key — so a row whose `mob` is not
 * the string this app sent is a bookkeeping failure somewhere between here and the fold, and the
 * honest response is this process's own answer rather than another creature's level under this
 * creature's name. It costs one comparison and it is the same test `projectModule` makes.
 */
export function serveMobLevel(
  mob: string,
  own: () => MobLevelFact | null
): Promise<MobLevelFact | null> {
  return readShim()
    .serve(
      'resist.levels',
      { mobs: [mob] },
      (r) => {
        // ONE NAME WENT OUT, so at most one row may come back — anything else is the engine
        // answering a question this app did not ask, which is the echo test's whole subject.
        if (r.levels.length > 1) return null
        const [row] = r.levels
        // NO ROW IS AN ANSWER, AND IT IS THE COMMON ONE: the op omits a creature it can state
        // nothing about, which is the null `levelOf` has always returned.
        if (row === undefined) return { fact: null }
        if (row.mob !== mob) return null
        return { fact: { level: row.level, lo: row.lo, hi: row.hi, from: row.from } }
      },
      () => ({ fact: own() })
    )
    .then((boxed) => boxed.fact)
}

// ── the fifth channel: what YOU have seen this creature drop (JOS-499, owner ruling 6a) ────────

/**
 * ONE CREATURE'S `dropsSeen`, SERVED — the app's own-loot index, which is the engine's now.
 *
 * ── WHY THIS HAD TO LAND IN THE DELETION RELEASE ───────────────────────────────────────────────
 *
 * `mobLookup.ownLoot` is a `MobLootIndex` that the FOLD filled: every loot event recorded what came
 * off which corpse, and `mergeLocalKnowledge` joined it onto the wiki drop table so a mob card could
 * say "you have pulled three of these off it". Boundary verdict 5 moved that index engine-side with
 * the corpora, and the fold that fed the app's copy is deleted — so the app-side index is now
 * permanently empty and every card silently lost its "seen it drop" section. The owner ruled it
 * wired now rather than deferred to the knowledge-ops cutover.
 *
 * ── THE ANSWER IS BOXED, for `serveMobLevel`'s reason exactly ──────────────────────────────────
 *
 * `readShim.ts` reserves `null` for "the reply was not an ANSWER", and absent `dropsSeen` is ALSO a
 * perfectly good served answer — a creature you have never looted has none, and the engine omits
 * the key rather than sending an empty array. Two different absences on one channel is the
 * ambiguity the shim's header warns about, so the projection hands back a box: a box is an answer,
 * and no box means nobody could be asked.
 *
 * ── AND THE THREE OUTCOMES ARE THREE, NOT TWO ──────────────────────────────────────────────────
 *
 * Served WITH drops replaces the field; served WITHOUT drops DELETES it (the engine saying you have
 * looted nothing here is a fact, and leaving a stale array would be the card claiming otherwise);
 * unserved leaves the record exactly as `lookupMob` built it — which today carries no `dropsSeen`
 * at all, so an engine that cannot answer degrades to the honest silence rather than to a lie.
 *
 * THE ECHO TEST IS `projectModule`'s, and the name is compared as ASKED. The engine folds the mob
 * key itself (`consider::mob_key`) precisely so a pre-folded key never crosses the wire, so what
 * comes back is echoed in the spelling this app sent.
 */
export function serveMobDropsSeen(name: string): Promise<{ seen?: MobSeenDrop[] } | null> {
  return readShim().serve(
    'knowledge.mob',
    { name },
    (r) => {
      if (r.name !== name) return null
      const seen = (r.record as { dropsSeen?: unknown }).dropsSeen
      if (seen === undefined) return { box: {} }
      if (!Array.isArray(seen)) return null
      return { box: { seen: seen as MobSeenDrop[] } }
    },
    () => null
  ).then((boxed) => (boxed === null ? null : boxed.box))
}

// NO TEARDOWN FLUSH, AND THAT IS A DECISION. The tally prints its FIRST fallback immediately
// (`readShim.ts NoteTally`), so the state a developer actually needs to see — the engine never
// served anything — is on screen within the second; what a trailing flush would add is the last
// few counts of a window that was already being printed every five seconds. Wiring it would mean
// `engineHost.ts` importing this file, which imports `engineHost.ts` for its gate, and a cycle
// between the composition root and a leaf is not worth a partial line at quit.
