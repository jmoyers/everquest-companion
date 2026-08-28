// ============================================================================
// engineClientHost.ts — THE APP BECOMES A CLIENT OF ITS OWN ENGINE (JOS-479, phase 3).
// ============================================================================
//
// Three things existed before this file and none of them had ever met. `supervisor.ts` spawns the
// engine and proves it healthy (JOS-467). `shared/dataServer/client.ts` is the app's side of the
// protocol — epoch law, typed requests, subscriptions (JOS-468). `engined` serves `module.snapshot`
// off a real twenty-module fold (JOS-478). This is the wiring that joins them INSIDE THE RUNNING
// PRODUCT, and it is the moment owner ruling 20 names: the first real client testing against the
// server.
//
// WHAT IT DOES, in five sentences. When the supervisor says READY it takes the port and the token
// that launch minted, opens one loopback connection, hellos, and attaches the engine to THE SAME
// LOG THIS PROCESS IS TAILING. When the character changes — or any time the TypeScript world is
// rebuilt — it attaches again, because that is the same funnel and last-pick-wins is the ENGINE's
// law now (`session.attach` preempts, never queues). When the engine dies and is respawned it does
// all of that over: a respawn is a launch, the token and port are new, resume is re-query. When
// both worlds have landed on the same log it runs THE PARITY PROBE and writes one line to the dev
// log. And that line is the entire user-visible surface of this ticket.
//
// ── WHAT IT DELIBERATELY DOES NOT DO ───────────────────────────────────────────────────────────
//
// No IPC, no `window.eq`, no renderer anything. No store write. No branch in the product reads
// anything the engine says. The TypeScript fold remains the app's only source of truth and will be
// until the cutover deletes it (plan, phase 3). The cost on a launch that asked for NO engine —
// `EQC_ENGINE=0`, which since JOS-495 is the only way to be in that state — is exactly one `if` in
// `engineHost.ts`: `installEngineClient` is never called, no observer is registered, and
// `pipeline.ts sendWorldRebuilt` finds a null.
//
// THAT IS STILL TRUE AFTER JOS-483, and it is worth saying because the engine now appears in the
// app's performance panel. This file grew two READS and one request (`lastParitySummary`,
// `enginePerfSnapshot`) and no channel: `src/main/perf.ts` calls them and pushes over the perf IPC
// that already existed, which is the same shape every other number in that panel has. Nothing here
// knows a window exists, and no PRODUCT branch reads the engine — a diagnostic is not a source of
// truth. The renderer still has no engine client; brokering one is JOS-484.
//
// ── WHY A FRESH CLIENT PER LAUNCH, RATHER THAN `client.attach` OVER A REPLACEMENT TRANSPORT ────
//
// `EngineClient` takes its token at construction and holds it for the life of the object, which is
// right: a token IS the identity of one connection to one launch. A respawn mints a NEW secret
// (contract rule 5), so a client that survived it would be an object holding credentials for a
// process that no longer exists. So a respawn builds a new client and closes the old one, and
// `client.attach` is used for what it is for — handing this client its transport, which is also the
// path a future reconnect-to-the-same-launch would take. Nothing is carried across, which is
// exactly the resume-is-requery law the client library already enforces on its own state.
//
// ── PREEMPTION, LOCALLY ────────────────────────────────────────────────────────────────────────
//
// Everything below is asynchronous — a connect, an attach round trip, a fold that takes as long as
// the log is big, five snapshot round trips — and all of it can be superseded mid-flight by a
// character switch or an engine respawn. `switchController.ts`'s answer is the one used here: a
// GENERATION counter, re-asked after every suspension point. A turn that has lost touches nothing
// and, in particular, WRITES NO LINE — a parity verdict from a world somebody has since replaced
// would be a measurement of nothing, printed with authority.

import { app } from 'electron'
import { logInfo } from '../errorLog'
import { setWorldRebuiltObserver } from '../worldRebuilt'
import { getActiveCharacter } from '../session'
import { createEngineClient, EngineError, type EngineClient } from '../../shared/dataServer/client'
import { createNdjsonTransport, type ByteChannel } from '../../shared/dataServer/ndjson'
import type {
  ClientMessage,
  EngineMessage,
  FireMessage,
  PerfBudgetsResult,
  PerfSnapshotResult,
  PerfTimelineResult
} from '../../shared/dataServer/protocol.generated'
// THE AUDIO CUTOVER (JOS-491). It owns its own flag and its own gate; this file simply offers it
// every fire and prints what it decided. A launch that turned it off (`EQC_ENGINE_ALERTS=0`, or
// `EQC_ENGINE_SERVE=0` above it) finds `armed` false and pays one boolean read per fire.
import { playEngineFire } from './alertsAudio'
// THE CON-CARD CUTOVER (JOS-496). Same shape as the audio one above and behind the serve flag
// rather than a fourth of its own; this file simply offers every card and prints what was decided.
import { conCardServeLine, noteConCardServe, openEngineConCard } from './conCardServe'
import { readDefine } from './appKnowledge'
import { DEFINE_OPS, setAppKnowledgePusher, setLogDirPusher, type DefineOp } from './definePush'
// WHERE THE CHARACTER LOGS LIVE (JOS-498, decision sheet 1a). THE APP NAMES THE DIRECTORY, so this
// file reads the app's own resolver and states it to the engine — the store stays persistence truth
// and the engine never reads a settings file (boundary verdict 3).
import { eqLogsDir } from '../log/config'
import { connectToEngine } from './socketChannel'
// THE DELTA ARM (JOS-493). It owns the serve flag's second half and the fan-out; this file supplies
// the only thing it cannot get for itself — the engine's own `moduleChanged` frames, and the two
// edges where the world that answers a read changes hands.
import { pushModuleChanged, pushWorldChanged } from './serveDeltas'
// THE MIRROR ARM (JOS-496). The census's other fourteen readers are SYNCHRONOUS and have nowhere to
// put an await, so they read a pushed cache instead of a promise. It hears the same two things the
// delta arm does — a cursor, and the world changing hands — and it holds no import of this file, so
// the requester is handed over rather than reached for.
import { installMirrors, noteMirrorChanged, primeMirrors, resetMirrors } from './serveMirrors'
// THE WIKI-MISS FETCH (JOS-499 item 1, boundary verdict 5). The engine has no network stack, so it
// announces a name it could not answer and this app looks it up on the queue it has always owned.
// The leaf is electron-free and takes its capabilities here — see its header.
import {
  asKnowledgeRecord,
  installKnowledgeMissFetch,
  onKnowledgeMiss
} from './knowledgeMissFetch'
import { lookupItem } from '../itemLookup'
import { noteEngineEdge } from '../telemetry/breadcrumbs'
import { lookupMob } from '../mobLookup'
import { attachStateDir, takeArtifactsBack } from './artifactOwner'
// THE LAUNCH BANNER'S THREE EDGES (JOS-503). This file is the only place that knows when a
// historical fold BEGINS (an accepted attach), how far it has got (the engine's progress frames)
// and when it LANDS (the go-live edge below) — so it feeds all three to the one state main pushes.
import { noteEngineFolding, noteEngineLive, noteFoldProgress } from './engineLaunchState'
// THE WAIT ITSELF (JOS-518). A leaf with its request, its turn, its sleep and its log sink handed
// in, so the shapes that matter — a fold past the old budget, a poll refused once and then answered,
// a connection that dies mid-wait — are drivable in a unit test. Its header carries the owner ruling
// that a folding engine is never given up on.
import { waitForFold, type FoldHealth } from './foldWait'
import { SERVABLE, type Readiness } from './readShim'
import type { ReadyEngine } from './supervisor'
import type { ParamsFor, RequestOp, ResultFor } from '../../shared/dataServer/ops'
import type { CharacterRef } from '../../shared/types'

/** How long the client's own loopback connect may take. The supervisor's probe just completed a
 *  round trip on this port, so this is a bound on the pathological case and not a budget. */
const CONNECT_TIMEOUT_MS = 2_000

// `FOLD_WAIT_BUDGET_MS` LIVED HERE AND IS GONE (JOS-518). It was 120 seconds, and it was a survivor
// of the deleted parity probe — where a bound on patience only ever cost a verdict. Post-cutover
// this loop arms the whole read path, so an expiry stranded the session permanently on any fold
// slower than two minutes. `foldWait.ts` carries the owner's ruling and the whole argument; what
// remains here is the wiring and the go-live edge, which is the part only this file knows.

/** One live engine and the client talking to it. */
interface LiveEngine {
  readonly engine: ReadyEngine
  readonly client: EngineClient
  /** The log this client last successfully attached the engine to. */
  attachedTo: string | null
}

let live: LiveEngine | null = null

/**
 * The log the TYPESCRIPT world last finished folding, or null when nothing is attached.
 *
 * It is the probe's readiness half. `sendWorldRebuilt` is the app's own "the fold landed and every
 * consumer should re-hydrate" moment, so it is precisely when this process's module snapshots stop
 * being a mid-scan prefix — and comparing a mid-scan prefix against the engine would report a race.
 */
let tsWorldPath: string | null = null

/** THE TURN. Bumped by every event that replaces the world: a new engine, a character switch, a
 *  rebuild. Read after every `await` — see the header. */
let gen = 0

/**
 * THE LOG THE ENGINE HAS BEEN OBSERVED LIVE ON, in THIS turn — null until a `session.health` in
 * this generation came back `live` (JOS-489).
 *
 * It is the compat shim's readiness half and it is a MEASUREMENT rather than a belief: nothing
 * infers it from having sent an attach. `waitForFold` is already polling health on every attach and
 * every rebuild, so the shim rides a round trip the probe was making anyway and no read path ever
 * has to ask the engine how it is feeling.
 *
 * IT DIES WITH THE TURN. A respawn, a character switch and a rebuild all replace the world, and an
 * engine that was live on the world somebody has since replaced is not live on this one — so
 * `bumpGen` clears it and the shim falls back to the app's own fold until health says `live` again.
 * That is a handful of TS-arm answers during a re-fold, which is exactly what those moments are.
 */
let engineLiveOn: string | null = null

/**
 * THE LOG FILE'S mtime AS THE ENGINE STATS IT (owner ruling 21's served fact), taken off the same
 * `session.health` round trip `engineLiveOn` is — null until the engine has said `live` in this
 * turn, and null again the moment the turn is replaced.
 *
 * IT IS KEPT HERE RATHER THAN RE-STATTED BY ITS READER, and that is the whole of ruling 21: this
 * process could `statSync` the log in one line (`main/log/config.ts` does), and doing so would prove
 * nothing about who owns the fact. The compat shim grafts THIS number onto the served `character`
 * snapshot (`serveShim.ts`), so what a picker under serve reads is the engine's answer about the
 * file, quoted rather than re-derived.
 *
 * IT DIES WITH THE TURN for `engineLiveOn`'s reason exactly: an mtime measured on the world somebody
 * has since replaced is a fact about a different file.
 */
let engineLogMtime: number | null = null

/**
 * HOW BIG THE ENGINE LAST SAID THIS LOG WAS — the newest `logSize` off a progress frame, or null
 * before one has arrived (JOS-518).
 *
 * IT EXISTS FOR ONE SENTENCE, and it is the sentence a person waiting out a nine-gigabyte fold most
 * needs: `still folding — 3.2 GB of 9.1 GB`. A percentage cannot say that and neither can an offset
 * with no denominator, and `session.health` — the round trip the wait is already making — carries a
 * mark but no size. So the number is taken from the frames the engine is already sending rather
 * than by this process `statSync`ing a file the engine owns (owner ruling 21).
 *
 * IT DIES WITH THE TURN, for `engineLiveOn`'s reason exactly: a denominator measured on the world
 * somebody has since replaced is a fact about a different fold, and quoting it under the new one
 * would print a bar's worth of arithmetic about the wrong file.
 */
let lastFoldLogSize: number | null = null

/** THE ONE PLACE THE TURN ADVANCES, so nothing that must die with it can be forgotten. */
function bumpGen(): number {
  gen += 1
  engineLiveOn = null
  engineLogMtime = null
  lastFoldLogSize = null
  // THE MIRRORS DIE WITH THE TURN, for `engineLiveOn`'s reason exactly: a served `character` state
  // measured on the world somebody has since replaced is a fact about a different log, and a
  // synchronous reader holding it would answer with authority about a character the app has left.
  resetMirrors()
  return gen
}

/** What the engine last said this log's mtime was, or null when it has not said. `serveShim.ts` is
 *  the only caller — see `engineLogMtime`. */
export function engineLogMtimeMs(): number | null {
  return engineLogMtime
}

function debug(line: string): void {
  logInfo(`[everquest-companion] ${line}`)
}

/** A promise that resolves later without ever being the reason this process stays alive —
 *  `engineHost.ts`'s timer rule, restated for the one place here that waits on a clock. */
function delay(ms: number): Promise<void> {
  return new Promise<void>((resolve) => {
    const handle = setTimeout(resolve, ms)
    handle.unref()
  })
}

function describeErr(err: unknown): string {
  if (err instanceof EngineError) return `${err.code}: ${err.message}`
  return err instanceof Error ? err.message : String(err)
}

/**
 * Where the engine should be pointed right now.
 *
 * TWO SOURCES, AND THE ORDER MATTERS. `tsWorldPath` is the log whose fold has LANDED here, which is
 * what the probe compares against; `getActiveCharacter()` is the log this process is tailing, which
 * during a historical fold is already the new character. Preferring the former means a re-attach
 * caused by a rebuild names the log that rebuild was about; falling back to the latter is what lets
 * an engine that became ready DURING the first fold attach immediately instead of sitting idle
 * until something else happens.
 */
function attachTarget(): string | null {
  return tsWorldPath ?? getActiveCharacter()?.logPath ?? null
}

// ── the connection ─────────────────────────────────────────────────────────────────────────────

/**
 * THE SUPERVISOR'S READY EDGE. `null` means the launch that was ready is over.
 *
 * Synchronous by signature because the supervisor's callback is, and every asynchronous thing it
 * starts is voided deliberately: a supervisor must never be made to wait on a client.
 */
export function onEngineReady(info: ReadyEngine | null): void {
  // WAS THE OUTGOING ENGINE ANSWERING READS? Asked BEFORE `bumpGen` clears the answer, because the
  // windows that were being served have to be told the world changed hands — they are ignoring
  // `module:delta` precisely because they were served, so nothing else would ever move them again
  // (serveDeltas.ts `pushWorldChanged`). A launch whose engine was never live has served nobody and
  // says nothing.
  const wasServing = engineLiveOn !== null
  const mine = bumpGen()
  live?.client.close()
  live = null
  if (wasServing) pushWorldChanged()
  // THE LAST VERDICT DIES WITH THE ENGINE THAT EARNED IT. A respawn is a launch and a fresh world
  // has proven nothing yet; leaving the counts standing would let the panel report "5 agree" about
  // a process that no longer exists.
  // THE PERSISTED ARTIFACTS COME BACK (JOS-497 item 2, boundary verdict 4), and on BOTH arms rather
  // than only on the gone one. A dead process is not an owner, and the resist ledger's whole value
  // is that it accretes — an engine that died at minute two of a six-hour session must not leave
  // both files unwritten for the rest of it.
  //
  // THE RESPAWN ARM IS THE ONE WORTH READING TWICE. Ownership is taken by `sendAttach` and by
  // nothing else, and a fresh connection does not always reach one — an app with no character
  // attached leaves the engine idle by design. Handing back HERE rather than only on the null makes
  // "the engine owns these files" mean "THIS engine was told where they are", so a launch that
  // never attached cannot inherit the last one's claim and leave nobody writing. The new engine
  // takes them at its own attach, so ownership alternates in strict sequence and is never shared.
  //
  // NOT IN `bumpGen`, deliberately, even though that is where everything else that must die with
  // the turn lives: a WORLD REBUILD bumps the turn and does NOT re-attach when the log is unchanged
  // (`attachAndProbe`), so a hand-back there would fire one second into every launch and never be
  // undone. This is the connection edge, which is the edge that actually replaces an owner.
  takeArtifactsBack(debug)
  if (info === null) {
    debug('data-server client: the engine is gone; the connection is closed')
    return
  }
  const client = createEngineClient({
    token: info.token,
    debug: (note) => {
      debug(`data-server client: ${note}`)
    }
  })
  live = { engine: info, client, attachedTo: null }
  void openConnection(mine, info, client)
}

async function openConnection(mine: number, info: ReadyEngine, client: EngineClient): Promise<void> {
  let channel: ByteChannel
  try {
    channel = await connectToEngine(info.port, CONNECT_TIMEOUT_MS)
  } catch (err) {
    debug(`data-server client: could not reach the engine on port ${String(info.port)} (${describeErr(err)})`)
    return
  }
  if (gen !== mine) {
    channel.close()
    return
  }
  // The hello rides this call — the client sends it the moment it has a transport, and queues
  // everything else behind the answer, so there is no handshake to sequence here.
  client.attach(createNdjsonTransport<ClientMessage, EngineMessage>(channel))
  // THE FIRES — logged and counted always, PLAYED when the cutover armed. See `noteFire`.
  client.onFire((fire) => {
    noteFire(fire)
  })
  // THE FOLD'S OWN MEASUREMENT (JOS-503), for the launch banner. The identity guard is the
  // CONNECTION one and not the turn one, for the reason spelled out on `onConCard` below: `gen`
  // advances on every world rebuild, so `gen !== mine` here would silence the bar one second into
  // every launch — which is precisely the bug that cost the cursor listener a whole e2e round.
  //
  // THE HOST CLOCK IS READ HERE AND NOWHERE DEEPER. `Date.now()` is the estimate's only clock, and
  // it is taken at the one instant it is honest: when the frame arrived. Passing it down means the
  // arithmetic in `shared/engineLaunch.ts` reads no clock at all and is pure integer maths in a
  // test. A live-tail frame is dropped by `noteFoldProgress` itself — see its header.
  client.onProgress((progress) => {
    if (live?.client !== client) return
    // THE DENOMINATOR, KEPT (JOS-518) — see `lastFoldLogSize`. Taken from every frame including a
    // live-tail one, because what it states is how big the engine believes the FILE to be, which is
    // true of the log whichever loop measured it; the banner's own live-frame refusal is a separate
    // question and `noteFoldProgress` owns it.
    lastFoldLogSize = progress.logSize
    noteFoldProgress(progress, Date.now())
  })
  // THE CON CARDS (JOS-496, boundary verdict 2) — `onFire`'s shape exactly, and for its reasons: a
  // thing that HAPPENED, connection-wide, nothing to reconcile. This file offers the frame and
  // prints what was decided; `conCardServe.ts` owns the gate and `conCard.ts` owns the window.
  //
  // THE IDENTITY GUARD IS THE `moduleChanged` ONE AND NOT THE TURN ONE, for the reason stated
  // below at length: a subscription is CONNECTION-scoped, and `gen` advances on every world
  // rebuild — asking `gen !== mine` here would silence the cards one second into every launch,
  // which is exactly the bug that cost the cursor listener a whole e2e round.
  client.onConCard((card) => {
    if (live?.client !== client) return
    // THE DRAW IS ASYNCHRONOUS SINCE JOS-497 item 1 — the card's chips need the creature's LEVEL,
    // and that is a served answer now rather than a synchronous read of this process's fold. So
    // this listener stays synchronous (the client's frame dispatch is), starts the draw, and
    // narrates when it settles.
    //
    // IT IS VOIDED AND IT NEVER THROWS, which is the same rule `noteMirrorChanged` and
    // `playEngineFire` learned: this runs inside the client's frame dispatch, where a throw
    // surfaces as a TRANSPORT FAULT — a con card would take the connection down. `openEngineConCard`
    // already answers `false` for every ordinary refusal, so the catch is for the unexpected, and
    // what it does with it is print a line.
    void openEngineConCard(card)
      .then((drew) => {
        noteConCardServe(conCardServeLine(card, drew))
      })
      .catch((err: unknown) => {
        debug(`data-server conCard: ${card.name} could not be drawn (${describeErr(err)})`)
      })
  })
  // THE CURSORS (JOS-493) — the engine saying a module's published state moved, forwarded to every
  // window that folds one. Two guards, and each answers a different question:
  //
  //   * IS THIS STILL THE CONNECTION THIS APP IS USING. A subscription is CONNECTION-scoped, not
  //     turn-scoped, and that distinction cost a whole e2e round to learn: the first draft asked
  //     `gen !== mine` — the rule every `await` in this file is followed by — and `gen` advances on
  //     every WORLD REBUILD (`onWorldRebuilt`), which happens the moment this process's own fold
  //     lands. So the listener went permanently silent one second into every launch and the live
  //     fold stopped reaching every renderer. MEASURED: a loot line played into the log never
  //     reached the ledger, and a watched respawn never drew a clock. Identity is the right
  //     question, and `live` is where the answer is.
  //   * `engineServeReadiness().ok` — the READ path is not taking this engine's answers right now
  //     (still folding, on another log, connection not ready). A window's held snapshot therefore
  //     came from THIS PROCESS's fold, and handing it a cursor from the other world is the very
  //     mixing this ticket exists to end. That is the question a turn number was reaching for, and
  //     it is asked here of the one function that owns it.
  client.onModuleChanged((changed) => {
    if (live?.client !== client) return
    if (!engineServeReadiness().ok) return
    pushModuleChanged(changed.module, changed.seq)
    // …and main's own synchronous readers, which ride the same cursor for the same reason the
    // renderers do: a mirror refreshed on anything but the engine's own publication edge would be a
    // cache with a timer, which is the thing ruling 5 forbids.
    noteMirrorChanged(changed.module, changed.seq)
  })
  // THE WIKI MISSES (JOS-499 item 1, boundary verdict 5) — the engine saying it could not answer a
  // name, answered by the app's own lookup and pushed back as `knowledge.define`.
  //
  // THE GUARD IS THE CONNECTION ONE, NOT THE TURN ONE, and it is the `onConCard`/`onModuleChanged`
  // reasoning verbatim: a subscription is CONNECTION-scoped while `gen` advances on every world
  // rebuild, so asking `gen !== mine` here would silence the fetcher one second into every launch —
  // the exact bug that cost the cursor listener a whole e2e round. It is written out again rather
  // than cross-referenced because getting it wrong is silent: the corpus would simply stop learning
  // and nothing would ever say so.
  //
  // AND THERE IS NO READINESS GATE HERE, unlike the cursor listener above. `engineServeReadiness()`
  // asks whether the engine's answers may be THIS APP'S answers — a question about which world a
  // read is served from. A miss is not a read: it names a page the wiki has and the corpus lacks,
  // which is true of every world at once and stays true across a character switch. Gating it would
  // drop exactly the misses raised during a fold, which is when a log full of unfamiliar mobs
  // raises nearly all of them.
  client.onKnowledgeMiss((miss) => {
    if (live?.client !== client) return
    onKnowledgeMiss(miss)
  })
  debug(`data-server client: connected to the engine on port ${String(info.port)}`)
  // WHERE THE LOGS LIVE GOES FIRST, and above all BEFORE `attachAndProbe` — which returns early on
  // a launch with no character, which is the launch a served character list is most needed on. See
  // `pushLogDirNow`.
  await pushLogDirNow(mine)
  if (gen !== mine) return
  await attachAndProbe(mine)
}

// ── app knowledge, pushed (JOS-482, boundary verdict 3) ────────────────────────────────────────

/**
 * PUSH ONE FAMILY. The store is read HERE rather than by the setter that changed it, so what the
 * engine is handed is what was persisted — see `appKnowledge.ts`.
 *
 * IT IS VOIDED AND IT NEVER THROWS. A define is fire-and-forget from a preference write's point of
 * view: the user's click is answered by the app's own state, and an engine that refused the push is
 * a dev-log line rather than a failed save. Nothing in the product reads the answer.
 */
async function pushDefine(mine: number, op: DefineOp): Promise<void> {
  const l = live
  if (l === null || gen !== mine) return
  try {
    const ack = await l.client.request(op, readDefine(op))
    if (gen !== mine) return
    const count = ack.count === undefined ? '' : ` (${String(ack.count)})`
    debug(`data-server define: ${op}${count}`)
  } catch (err) {
    debug(`data-server client: ${op} was refused (${describeErr(err)})`)
  }
}

/**
 * ALL FIVE, IN ONE BREATH — what the app says the moment it has a connection, and again whenever
 * the world is rebuilt.
 *
 * BEFORE THE ATTACH, ALWAYS. A define pushed at a world with no fold is HELD and applied at the
 * next attach's construction, which is the only timing that makes the engine's fold reproducible:
 * alert defs, buff trust, respawn watches, combo corrections and roster edits all change what a
 * fold produces, and a world that took them afterwards would have folded the log under a different
 * set of rules than it then serves.
 *
 * ALL FIVE ON EVERY REBUILD, not just the two that are character-scoped. It costs five small round
 * trips at a moment that already costs a whole re-fold, and it is the shape a full-set replace
 * asks for: the app states what it knows, rather than reasoning about what the engine might be
 * remembering.
 */
async function pushAllDefines(mine: number): Promise<void> {
  for (const op of DEFINE_OPS) {
    await pushDefine(mine, op)
    if (gen !== mine) return
  }
}

// ── where the logs live, pushed (JOS-498, owner ruling 21 / decision sheet 1a) ──────────────────

/**
 * TELL THE ENGINE WHERE THE CHARACTER LOGS ARE.
 *
 * ON CONNECT, AND NOT WITH THE DEFINES. `pushAllDefines` is called from `attachAndProbe`, which
 * RETURNS EARLY when this app has no character attached — "the engine is left idle" — and that early
 * return is exactly the launch this push matters most on: a fresh install has no character to attach
 * to and a picker that has to draw one anyway. So it is sent from `openConnection`, before anything
 * can decide there is nothing to do.
 *
 * `eqLogsDir()` RATHER THAN A VALUE PASSED IN, for `appKnowledge.ts`'s reason exactly: what the
 * engine is handed must be what this app has RESOLVED, not what some caller believed at the moment
 * it noticed a change. The resolver is memoized (`config.ts`) and a settings change invalidates it
 * before this is ever called, so re-reading here is a field read on the common path.
 *
 * IT IS VOIDED AND IT NEVER THROWS, exactly as a define is: a directory the engine refused is a
 * dev-log line, and the app's own read answers every question in the meantime.
 */
async function pushLogDirNow(mine: number): Promise<void> {
  const l = live
  if (l === null || gen !== mine) return
  const dir = eqLogsDir()
  try {
    await l.client.request('logs.setDir', { dir })
    if (gen !== mine) return
    debug(`data-server logs: the engine was told to enumerate ${dir}`)
  } catch (err) {
    debug(`data-server client: logs.setDir was refused (${describeErr(err)})`)
  }
}

// ── the fires (owner ruling 22) ────────────────────────────────────────────────────────────────

/** How many fires this launch has heard from the engine. Reported beside each one. */
let firesHeard = 0

/**
 * ONE ALERT FIRE FROM THE ENGINE — LOGGED AND COUNTED, AND PLAYED ONLY WHEN THE CUTOVER IS ARMED.
 *
 * WITH THE CUTOVER TURNED OFF (`EQC_ENGINE_ALERTS=0`) this is exactly what JOS-482 shipped: a line,
 * and no sound. The app's own `AlertsModule` is still firing and is still the only noise, because
 * playing this one too would double every alert the owner hears — and the owner is the regression
 * test for this whole program, so a duplicated sound would not be a cosmetic bug, it would corrupt
 * the evidence the cutover is being judged on.
 *
 * WITH THE FLAG (JOS-491) the two swap in one place rather than both being live: `alertsAudio.ts`
 * silenced this process's evaluator at arm time, so `playEngineFire` is the only thing publishing
 * a firing and the sound is engine-attributed by construction. The line stays either way, and says
 * which world it was in.
 *
 * WHAT THE LINE PROVES, even unplayed, is everything a sound would: the def reached the engine, the
 * engine evaluated it against a LIVE event, and the frame it sent back is fully resolved — the pack
 * key is right there, so the app needs nothing else to play it.
 */
function noteFire(fire: FireMessage): void {
  firesHeard += 1
  const outcome = playEngineFire(fire) ? 'PLAYED from the engine' : 'logged, not played'
  debug(
    `data-server fire: ${fire.rule} [${fire.sound}] at ${String(fire.at)} — ` +
      `${fire.message} (fires this launch: ${String(firesHeard)}; ${outcome})`
  )
}

// ── the attach ─────────────────────────────────────────────────────────────────────────────────

/**
 * Point the engine at the app's log, then — if the app's own fold has landed on it — compare.
 *
 * THE ATTACH HAPPENS EVEN WHEN THE PROBE CANNOT. An engine that becomes ready mid-fold should start
 * reading the log immediately; the comparison waits for the other world, and the two are separate
 * questions.
 */
async function attachAndProbe(mine: number): Promise<void> {
  const target = attachTarget()
  const l = live
  if (l === null || gen !== mine) return
  if (target === null) {
    debug('data-server client: no character is attached here, so the engine is left idle')
    return
  }
  // WHAT THE APP KNOWS GOES FIRST, before any attach can be sent — see `pushAllDefines`.
  await pushAllDefines(mine)
  if (gen !== mine) return
  // AN ATTACH IS A WHOLE RE-FOLD, so it is sent only when the FILE changes. This runs twice on an
  // ordinary launch — once when the engine becomes ready (pointed at the log this process is
  // already tailing) and once when this process's own fold lands on that same log — and issuing a
  // second attach there would make the engine read the whole log twice for nothing. It is not a
  // freshness risk: the engine folded the same file from byte zero and has been tailing it since,
  // which is the same lossless seam the app's own scan→tail handoff is. A character switch changes
  // the path and does attach, which is the case the re-attach exists for.
  if (l.attachedTo !== target && (await sendAttach(mine, l, target)) === null) return
  if (gen !== mine) return
  // THE FOLD IS WAITED FOR, AND NOTHING IS COMPARED (JOS-499). The wait is what records
  // `engineLiveOn`, which is what `engineServeReadiness()` reads on every served IPC — so this
  // call is the arming of the read path, not the preamble to a probe. It has no deadline (JOS-518):
  // a folding engine is never given up on, so this `await` runs for as long as the log is big.
  await waitForFoldHere(mine, l)
}

/**
 * `session.attach`, and what it answered. Null when it was refused or superseded.
 *
 * THE ARTIFACT HANDOVER RIDES THIS CALL (JOS-497 item 2, boundary verdict 4), and it does so
 * BEFORE the request object exists rather than beside it. `attachStateDir` stops this process
 * persisting the resist ledger and the message-overlay register and only THEN produces the
 * directory to send — so there is no arrangement of these lines in which the engine learns where
 * the files are while this process is still writing them. `artifactOwner.ts` carries the argument
 * for why the ordering is enforced by that function's body instead of by this call site's care.
 *
 * `undefined` IS THE ORDINARY ANSWER when the engine is not in this app's read path
 * (`EQC_ENGINE_SERVE=0`), and the schema defines an absent `stateDir` as no engine-side persistence
 * at all — so a flag-off launch sends the byte-identical attach it always has and keeps writing its
 * own files.
 */
async function sendAttach(mine: number, l: LiveEngine, logPath: string): Promise<number | null> {
  const stateDir = attachStateDir({
    // ALWAYS (JOS-499 item 9). The `serving` argument used to carry `shimServing()`, so a
    // flag-off launch kept persisting its own artifacts. There is no such launch: an attach is
    // sent only by a connected client, and this process folds nothing to persist.
    serving: true,
    userData: () => app.getPath('userData'),
    note: debug
  })
  try {
    const result = await l.client.request(
      'session.attach',
      stateDir === undefined ? { logPath } : { logPath, stateDir }
    )
    if (gen !== mine) return null
    l.attachedTo = logPath
    debug(
      `data-server engine attached: ${logPath} (epoch ${String(result.epoch)}, ` +
        `accepted ${String(result.accepted)})`
    )
    // A HISTORICAL FOLD HAS JUST STARTED (JOS-503) — the earliest instant that is true, and the
    // only place in the product that knows it. Gated on `accepted`, because `false` means this
    // attach LOST to a later one: the engine is folding somebody else's log and the caller has no
    // business claiming the banner for a fold it does not own (the winner's own attach already did).
    if (result.accepted) noteEngineFolding()
    return result.epoch
  } catch (err) {
    debug(`data-server client: session.attach was refused (${describeErr(err)})`)
    return null
  }
}

/**
 * THE CHARACTER-SWITCH FUNNEL, and the app-side half of the probe's readiness.
 *
 * Registered on `pipeline.ts sendWorldRebuilt`, which is the ONE place this process says "the world
 * for this character was rebuilt" — the same signal every window that folds a module already rides.
 * A switch reaches it, the idle rescan reaches it, an EQ-dir change reaches it, and a live epoch
 * boundary reaches it, so hooking it is how this feature inherits every one of those without a
 * second call site to keep in step.
 *
 * A REBUILD OF THE SAME LOG IS NOT A RE-ATTACH — see `attachAndProbe`. It is still a fresh TURN and
 * a fresh probe, because this process's snapshots have just been rebuilt and are worth re-checking.
 */
function onWorldRebuilt(character: CharacterRef | null): void {
  tsWorldPath = character?.logPath ?? null
  const mine = bumpGen()
  const l = live
  if (l === null) return
  if (tsWorldPath === null) {
    // The app stopped tailing (an EQ dir with no logs). There is no `session.detach` in the
    // protocol and inventing one here would be a schema change; the engine keeps folding a file
    // nobody is asking about until the next attach replaces it, which costs a tail poll. Forgetting
    // what it is attached to is how that next attach is guaranteed to be sent — even if the log the
    // app comes back to is the one the engine still has open, which after an interlude of not
    // watching is the safe direction.
    l.attachedTo = null
    debug('data-server client: the app has no character; the engine keeps its last attach')
    return
  }
  void attachAndProbe(mine)
}

// ── THE PROBE IS GONE (JOS-499) ────────────────────────────────────────────────────────────────
//
// `runParityProbe` and `askOne` asked five modules of BOTH worlds and wrote one line saying
// whether they agreed. There is one world. A parity verdict is not a thing that can be computed,
// let alone reported, and keeping a probe that compares the engine against itself would be an
// instrument that can only ever say yes.
//
// WHAT IT PROVED IS NOT LOST, it is just finished: the six-slice golden oracle
// (`npm run oracle:rust-fold`) is what established the equivalence this probe watched for drift
// against, and owner ruling 26 keeps it running against the RECORDED goldens for one more
// release. The fold WAIT survives it, because polling `session.health` until the engine goes live
// is what arms the serve path (see `engineLiveOn`) — the loop itself now lives in `foldWait.ts`,
// and what is left here is the one thing that file cannot know: what going live MEANS to this app.

// `EngineHealthSay` LIVED HERE AND IS `FoldHealth` IN `foldWait.ts` NOW (JOS-518) — the loop that
// reads it moved, and the shape belongs beside its reader.

/**
 * THE GO-LIVE SENTENCE, built out of line so `sawHealth` keeps its own shape.
 *
 * The optional clauses are appended rather than interpolated because both are genuinely absent on a
 * fresh attach — an engine that has folded nothing has no event count and no byte mark — and an
 * empty interpolation would print a dangling comma rather than saying nothing.
 */
function servingLine(logPath: string | null, health: FoldHealth): string {
  const parts = [`epoch ${String(health.epoch)}`]
  if (health.events !== undefined) parts.push(`${String(health.events)} events`)
  if (health.mark?.offset !== undefined) parts.push(`at byte ${String(health.mark.offset)}`)
  return (
    `data-server serving: ${logPath ?? '(none)'} — the engine's fold is live and is now ` +
    `answering this app's reads (${parts.join(', ')})`
  )
}

/**
 * ONE HEALTH ANSWER, ON THE WAY PAST — and everything this app does about the engine going live.
 *
 * THE SHIM'S READINESS, TAKEN OFF A ROUND TRIP THE WAIT WAS MAKING ANYWAY (JOS-489). It is recorded
 * here rather than by the loop's caller because this is the only place in this process that has
 * heard the engine say `live`, and it is recorded only on `live`: a folding answer written down as
 * live would be the shim serving a mid-scan prefix to a hydrating window.
 */
function sawHealth(l: LiveEngine, health: FoldHealth): void {
  if (health.status !== 'live') return
  // THE GO-LIVE EDGE (JOS-493), taken exactly once per turn: the shim starts serving on this
  // assignment, so the windows that hydrated during the fold are holding this process's own
  // state and are about to be handed the other world's cursors. `pushWorldChanged` tells them
  // to take the served world now rather than at whatever unrelated moment re-hydrates them
  // next — and it is inside the `first` test because this loop can run many times per turn.
  const first = engineLiveOn === null
  engineLiveOn = l.attachedTo
  // THE SERVED FILE FACT, on the way past (owner ruling 21). Absent means absent — never zero,
  // which would graft a `lastPlayed` of 1970 onto a character card.
  engineLogMtime = health.logMtimeMs ?? null
  if (first) {
    pushWorldChanged()
    // THE MIRRORS ARE PRIMED ON THE SAME EDGE, and it has to be this one rather than the first
    // read: the engine publishes a cursor when a module MOVES, and a module that has finished
    // folding and gone quiet will not move again for minutes. A mirror waiting for a cursor that
    // is not coming would fall back on every draw of a card the engine could answer perfectly.
    primeMirrors()
    // THE GO-LIVE SENTENCE (JOS-499), and it replaces a line rather than adding one.
    //
    // The PARITY line used to be printed at exactly this moment — it was the app's own
    // statement that both folds had landed on the same log and the engine's ingest was live —
    // and two e2e specs used it as their READINESS PRECONDITION rather than for its verdict.
    // The verdict is gone with the second world; the readiness it also carried is a real fact
    // about this launch and is still the one moment worth naming, because it is precisely when
    // `engineServeReadiness()` starts answering yes and every read in the product changes hands.
    //
    // IT REPORTS WHAT IT CAN VOUCH FOR: the log both sides agree on, the engine's own event
    // count and byte mark. Those come off the health round trip this loop was making anyway, so
    // the line costs nothing and is evidence rather than an announcement.
    debug(servingLine(l.attachedTo, health))
    // …AND A BREADCRUMB FOR THE SAME EDGE (JOS-501). It is the last of the four the ring gets
    // from the engine's lifecycle, and the most diagnostic of them: it is the moment every
    // read in the product changes hands, so a crash report whose ring stops at `engine:ready`
    // says the fold never landed, which is a completely different investigation from one whose
    // ring shows `engine:live` followed by module cursors.
    noteEngineEdge('engine:live')
  }
  // THE BANNER RESOLVES HERE (JOS-503), and OUTSIDE the `first` test on purpose. `first` is
  // about this app's own read path changing hands, which happens once; this is about a window
  // being told the catch-up is over, and a second turn that finds the engine already live
  // (a world rebuild on an unchanged log) must still take a stale bar down rather than leave
  // one up because the interesting edge belonged to an earlier turn. `set` is a no-op when
  // nothing changed, so saying it every poll costs a comparison.
  noteEngineLive()
}

/**
 * WAIT OUT THE CATCH-UP — the loop's argument is in `foldWait.ts`; this is its wiring.
 *
 * THE TURN IS ASKED FOR RATHER THAN CAPTURED. `mine` closes over the number this turn was given and
 * compares it against the module's live `gen` on every ask, which is the same rule every `await` in
 * this file is followed by — and moving the loop out is precisely why it has to be a callback: the
 * generation is this file's state and a leaf must never hold a copy of it.
 */
async function waitForFoldHere(mine: number, l: LiveEngine): Promise<FoldHealth | null> {
  return waitForFold({
    ask: () => l.client.request('session.health', {}),
    mine: () => gen === mine,
    rest: delay,
    saw: (health) => {
      sawHealth(l, health)
    },
    note: debug,
    logSize: () => lastFoldLogSize
  })
}

// ── what the performance panel can ask this file (JOS-483) ─────────────────────────────────────
//
// TWO READS AND ONE REQUEST, and every one of them is main-side. The renderer never reaches the
// engine — brokering a client into a window is JOS-484's job — so the panel's data arrives the way
// every other number in that panel arrives: main measures, main pushes, over the perf channels that
// already exist.

// `ParitySummary` / `lastParitySummary()` LIVED HERE AND ARE GONE (JOS-499), with the probe that
// produced them. The performance panel drew "5 agree, 0 diverge"; with one world there is nothing
// to agree with. `enginePerfWatch.ts` sends `parity: null` and the panel already draws that as
// "no verdict", which is now permanent rather than "no probe has run yet".

/**
 * Ask the engine what it costs. `null` when there is no connected engine to ask.
 *
 * IT DOES NOT WAIT FOR A CONNECTION and it does not open one: the client is the supervisor's to
 * make, and a perf panel must never be the reason a socket exists. A rejection resolves to `null`
 * rather than throwing, for the reason this whole file exists — a diagnostic that can break the
 * thing it measures is worse than no diagnostic. The refusal is still logged, once, at debug.
 */
export async function enginePerfSnapshot(): Promise<PerfSnapshotResult | null> {
  const l = live
  if (l === null) return null
  try {
    return await l.client.request('perf.snapshot', {})
  } catch (err) {
    debug(`data-server client: perf.snapshot was refused (${describeErr(err)})`)
    return null
  }
}

/**
 * Ask the engine how it is doing against its own budgets (JOS-502). `null` on the same terms.
 *
 * THE SWALLOW-TO-NULL POSTURE IS COPIED DELIBERATELY, not inherited by accident. `engineRequest`
 * below rejects rather than answering `null`, and the line between them is stated there: a READ
 * whose answer a user sees owes its caller a reason, while a DIAGNOSTIC that cannot be taken has
 * nothing to say. These two are diagnostics — the panel draws an absent section rather than an
 * error, and a bug report omits a block rather than failing to send.
 */
export async function enginePerfBudgets(): Promise<PerfBudgetsResult | null> {
  const l = live
  if (l === null) return null
  try {
    return await l.client.request('perf.budgets', {})
  } catch (err) {
    debug(`data-server client: perf.budgets was refused (${describeErr(err)})`)
    return null
  }
}

/** Ask the engine for its bounded recent history (JOS-502). `null` on the same terms. */
export async function enginePerfTimeline(): Promise<PerfTimelineResult | null> {
  const l = live
  if (l === null) return null
  try {
    return await l.client.request('perf.timeline', {})
  } catch (err) {
    debug(`data-server client: perf.timeline was refused (${describeErr(err)})`)
    return null
  }
}

// ── the typed request bridge, for main-side callers (JOS-489) ──────────────────────────────────
//
// `enginePerfSnapshot` above was the first main-side caller of this connection and it is a
// DIAGNOSTIC: it asks one op, swallows every failure into `null`, and nothing branches on the
// answer. The compat shim is the first caller whose answer a USER sees, so it needs two things that
// one did not — any op rather than one, and a statement about whether asking is worth doing at all.
// Those are the two exports below, and they are still the whole of what this file lets anybody do
// with the socket: no client handle escapes, so a caller cannot subscribe, cannot re-attach, and
// cannot outlive the launch it is talking to.

/**
 * IS THE ENGINE IN A STATE WHERE ITS ANSWERS MAY BE THIS APP'S ANSWERS?
 *
 * FOUR QUESTIONS, IN THE ORDER THAT MAKES EACH ONE MEANINGFUL. Is there a client at all; is its
 * connection up; are the two worlds on the SAME FILE; and has the engine's fold on that file gone
 * live. The third is the one the parity probe taught (`parityProbe.ts whereBoth`, "two folds of
 * different files is the one failure that would make every other number a lie") — and it is asked
 * against `tsWorldPath` rather than against the active character, because `tsWorldPath` is the log
 * THIS PROCESS has finished folding and therefore the only one whose answers the shim is choosing
 * between. During a historical scan of a newly-picked character the two differ, and falling back
 * there is right: this app's own fold is mid-scan too.
 *
 * IT IS CHEAP ON PURPOSE — four field reads, no allocation, no round trip — because it is asked on
 * every read IPC, which is a channel a hydrating window opens a dozen of at once.
 */
export function engineServeReadiness(): Readiness {
  const l = live
  if (l === null) return { ok: false, why: 'noClient' }
  if (l.client.state !== 'ready') return { ok: false, why: 'notConnected' }
  const ours = tsWorldPath
  if (ours === null || l.attachedTo !== ours) return { ok: false, why: 'notAttached' }
  if (engineLiveOn !== ours) return { ok: false, why: 'notLive' }
  return SERVABLE
}

/**
 * IS THERE AN ENGINE ON THE OTHER END OF THIS SOCKET AT ALL?
 *
 * THE WEAKER OF THIS FILE'S TWO READINESS QUESTIONS, and the weakness is the whole point rather than
 * a shortcut. `engineServeReadiness` above asks four things because it guards reads of a FOLD: two
 * of its four — are the worlds on the same file, has that file's fold gone live — are questions
 * about a log, and a caller that skipped them would draw one character's rows under another's name.
 *
 * `logs.list` NAMES NO LOG. It enumerates the directory the app pushed, which is a question about a
 * FOLDER and is answerable by a world that has attached to nothing whatsoever — and the launch it
 * matters most on is precisely the one where nothing is attached, because a fresh install has
 * characters to choose between before there is anything to fold. Asking the four-part question there
 * would refuse every answer this op exists to give, on grounds that have nothing to do with it.
 *
 * SO THE SET OF REASONS IS THE SAME AND ONLY THE FIRST TWO ARE ASKED (`readShim.ts FallbackReason`):
 * is there a client, and is its connection up. No third arm was invented — a fallback reason nobody
 * can act on differently is a reason not worth a member.
 */
export function engineConnectedReadiness(): Readiness {
  const l = live
  if (l === null) return { ok: false, why: 'noClient' }
  if (l.client.state !== 'ready') return { ok: false, why: 'notConnected' }
  return SERVABLE
}

/**
 * ONE TYPED REQUEST TO THE ENGINE, for a main-side caller.
 *
 * IT REJECTS RATHER THAN ANSWERING `null`, which is the difference from `enginePerfSnapshot` and is
 * deliberate: a diagnostic that cannot be taken has nothing to say, but a READ that could not be
 * served has to tell its caller WHY so the fallback can be counted and named. `readShim.ts` is that
 * caller and it catches everything; the rejection never reaches a renderer.
 *
 * NO READINESS CHECK HERE. The shim asks `engineServeReadiness` first and would rather have a
 * refusal describe the request than have this function guess at which of two states it was in —
 * one authority per question.
 */
export async function engineRequest<O extends RequestOp>(
  op: O,
  params: ParamsFor<O>
): Promise<ResultFor<O>> {
  const l = live
  if (l === null) throw new EngineError('unavailable', 'there is no engine on this launch')
  return l.client.request(op, params)
}

// ── the composition root's two verbs ────────────────────────────────────────────────────────────

/**
 * Arm the client. Called by `engineHost.ts` from inside its own `EQC_ENGINE` guard, so this file
 * never reads the flag and there is one gate rather than two.
 */
export function installEngineClient(): void {
  setWorldRebuiltObserver(onWorldRebuilt)
  // THE PREFERENCE-WRITE EDGE (JOS-482). One slot, filled here and nowhere else, so an ipc setter
  // can say "this family moved" without importing the engine client — and so that a launch with
  // `EQC_ENGINE=0` finds a null and pays one comparison per preference write.
  setAppKnowledgePusher((op) => {
    const mine = gen
    void pushDefine(mine, op)
  })
  // THE EQ-DIRECTORY EDGE (JOS-498), by the same one-slot rule and for the same reason: `session.ts`
  // must be able to say "the directory moved" without importing this file, which imports `session.ts`
  // — that is a cycle, and the slot is what inverts it.
  setLogDirPusher(() => {
    const mine = gen
    void pushLogDirNow(mine)
  })
  // THE MIRROR'S REQUESTER (JOS-496), by the same one-slot rule and for the same reason: the mirror
  // is a leaf that main's synchronous readers import, and a leaf that imported this file back would
  // be a cycle between two modules that boot each other. It gets exactly one op and no client
  // handle, which is the whole of what this file lets anybody do with the socket.
  installMirrors({
    request: async (module) => {
      const r = await engineRequest('module.snapshot', { module })
      return { module: r.module, seq: r.seq, state: r.state }
    },
    note: debug
  })
  // THE WIKI-MISS FETCHER'S CAPABILITIES (JOS-499 item 1), by the same one-slot rule. The two
  // lookups are handed over rather than imported by the leaf because both of them load `electron`
  // at module scope and the decision the leaf holds is worth pinning under plain node; the record
  // widening happens HERE, where the concrete `ItemKnowledge`/`MobKnowledge` types are in scope and
  // the protocol's open-map declaration is being honoured deliberately.
  installKnowledgeMissFetch({
    lookupItem: async (name) => asKnowledgeRecord(await lookupItem(name)),
    lookupMob: async (name) => asKnowledgeRecord(await lookupMob(name)),
    define: async (params) => {
      await engineRequest('knowledge.define', params)
    },
    note: debug
  })
}

/** Let go: no observer, no connection, no pusher. Idempotent, and safe on a process that never
 *  armed one. */
export function stopEngineClient(): void {
  // The same edge `onEngineReady(null)` reports, for the path that lets go deliberately.
  const wasServing = engineLiveOn !== null
  bumpGen()
  if (wasServing) pushWorldChanged()
  setWorldRebuiltObserver(null)
  setAppKnowledgePusher(null)
  setLogDirPusher(null)
  // …and the mirrors, which clear themselves on the null (see `installMirrors`): a synchronous
  // reader must never be left holding a served fact after the connection that served it is gone.
  installMirrors(null)
  // …and the wiki-miss fetcher, for the mirrors' reason exactly: a fetch that lands after the
  // connection it was answering is gone has nowhere to push its record, and a leaf still holding a
  // requester for a dead client would be pushing into a closed socket.
  installKnowledgeMissFetch(null)
  // THE PERSISTED ARTIFACTS ARE DELIBERATELY NOT HANDED BACK HERE (JOS-497 item 2), and the
  // asymmetry with `onEngineReady` is the point. This is the TEARDOWN path and its only caller is
  // `stopEngineSupervisor`, which both quit events reach: what follows it is `main:saveOverlay`,
  // the app's synchronous quit-final. Resuming ownership on the way out would let this process
  // publish its own register over the one the engine has been maintaining, at the one moment
  // nothing is left to correct it — the app getting the LAST word about a file it does not own.
  // What that costs instead is the residual JOS-496 already named and priced: at most sixty
  // seconds of the folding character's accretion, whose bucket the next attach re-derives from the
  // log anyway.
  live?.client.close()
  live = null
}
