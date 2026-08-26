// THE COMPAT SHIM'S DECISION AND ITS FALLBACK MATRIX (JOS-489; vocabulary corrected by JOS-501).
//
// `src/main/dataServer/readShim.ts` is the half of the shim that decides whether the engine answers
// a read and what happens when it cannot. Every interesting case is a failure — a client that is
// not there, a connection that is not ready, an engine on another log, an engine that never
// replies, an engine that refuses, an engine that answers with something that is not an answer —
// and not one of them can be staged reliably against a real engine on a real socket. So the file
// takes its connection, its clock and its log sink as dependencies and this suite drives the whole
// matrix with fakes: no Electron, no socket, no Rust binary.
//
// THE LAW UNDER TEST. This suite was written when the fallback was a SECOND WORLD — the app's own
// TypeScript fold, chosen per call by a flag — and its law was "the shim must never make the app
// worse than the flag-off world". JOS-499 deleted that fold and its flags, so the law is now the
// plainer one the deletion release rests on: A READ THAT CANNOT BE SERVED SAYS SO, AND NEVER
// INVENTS. Concretely, in every row below, (a) the caller gets the EMPTY SHAPE the channel owes it
// — `null` for a module snapshot, a `hydrating` meter, no search hits — (b) no engine failure is
// ever propagated as a throw, and (c) the reason is named in the dev log without a line per call.
//
// The `emptyShape` helper below is what used to be called `tsArm`. It is still a thunk and still
// the thing the shim calls when the engine cannot answer; what changed is that nothing behind it
// folds anything. The rename is the point of the JOS-501 residual: a fake named after a deleted
// world teaches every future reader that the world is still there.
//
// WHAT IS NOT HERE. `engineServeReadiness` — the four-question readiness that produces the first
// four reasons — lives in `engineClientHost.ts`, which owns a socket and imports the pipeline. What
// this suite pins is that each of its verdicts routes correctly.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  createReadShim,
  SERVABLE,
  type FallbackReason,
  type ReadShim,
  type Readiness
} from '../src/main/dataServer/readShim'
import type { ParamsFor, RequestOp, ResultFor } from '../src/shared/dataServer/ops'
import type { ModuleSnapshotResult } from '../src/shared/dataServer/protocol.generated'

// ---- the fakes ---------------------------------------------------------------------------------

/** The five shapes a client can be in, as the ticket names them. */
type FakeClient =
  /** ready, attached, live, and it answers */
  | { readonly kind: 'answering'; readonly result: ModuleSnapshotResult }
  /** ready and live, and every request comes back an error */
  | { readonly kind: 'erroring'; readonly error: unknown }
  /** ready and live, and no request is ever answered */
  | { readonly kind: 'idle' }
  /** there is no client at all — no binary on this checkout, or the engine died */
  | { readonly kind: 'disconnected'; readonly why: FallbackReason }

/** The op every row uses. `module.snapshot` because it is the one channel whose served answer has a
 *  field this app can check against the question it asked — see the echo test below. */
const OP = 'module.snapshot'

function snap(module: string, seq: number, state: unknown): ModuleSnapshotResult {
  return { module, seq, state }
}

interface Rig {
  readonly shim: ReadShim
  /** Every coalesced sentence the shim printed, in order. */
  readonly notes: string[]
  /** Every op that reached the wire. Empty is a claim: a readiness verdict must not send one. */
  readonly sent: RequestOp[]
  /** Move the fake clock. */
  tick: (ms: number) => void
}

/**
 * One shim, with a fake client behind it and a clock this suite owns.
 *
 * THE DEADLINE IS REAL BUT TINY (5 ms) and it runs on real timers, because that is the one
 * dependency a fake would change the meaning of: the whole claim about an idle engine is that the
 * promise the caller is holding RESOLVES ANYWAY, which is a statement about the event loop.
 * `noteEveryMs` rides the fake clock instead, so the coalescing rows never wait on anything.
 */
function rig(client: FakeClient, opts: { noteEveryMs?: number } = {}): Rig {
  const notes: string[] = []
  const sent: RequestOp[] = []
  let at = 1_000_000

  const readiness = (): Readiness =>
    client.kind === 'disconnected' ? { ok: false, why: client.why } : SERVABLE

  const request = <O extends RequestOp>(op: O, _params: ParamsFor<O>): Promise<ResultFor<O>> => {
    sent.push(op)
    if (client.kind === 'idle') return new Promise<ResultFor<O>>(() => undefined)
    if (client.kind === 'erroring') return Promise.reject(client.error)
    return Promise.resolve(client.result as ResultFor<O>)
  }

  const shim = createReadShim({
    readiness,
    request,
    note: (line) => notes.push(line),
    now: () => at,
    timeoutMs: 5,
    noteEveryMs: opts.noteEveryMs ?? 5_000,
    delay: (ms) => new Promise<void>((resolve) => setTimeout(resolve, ms))
  })

  return {
    shim,
    notes,
    sent,
    tick: (ms: number): void => {
      at += ms
    }
  }
}

/** THE EMPTY SHAPE this channel owes a caller it cannot serve, as a thunk the shim may or may not
 *  call. Named `tsArm` until JOS-501; nothing behind it folds anything. */
function emptyShape(calls: { n: number }, answer: { seq: number; state: unknown } | null) {
  return (): { seq: number; state: unknown } | null => {
    calls.n += 1
    return answer
  }
}

/** The projection `serveShim.ts` uses for this channel: the echoed module must be the one asked
 *  for, or the reply is not an answer to this question. */
function project(module: string) {
  return (r: ModuleSnapshotResult): { seq: number; state: unknown } | null =>
    r.module === module ? { seq: r.seq, state: r.state } : null
}

const EMPTY_ANSWER = { seq: 7, state: { from: 'the empty shape' } }
const ENGINE_STATE = { from: 'the engine' }

// ---- the served row ----------------------------------------------------------------------------

test('CONNECTED AND ANSWERING: the engine answers and the empty shape is never built', async () => {
  const r = rig({ kind: 'answering', result: snap('loot', 9, ENGINE_STATE) })
  const calls = { n: 0 }

  const got = await r.shim.serve(OP, { module: 'loot' }, project('loot'), emptyShape(calls, EMPTY_ANSWER))

  assert.deepEqual(got, { seq: 9, state: ENGINE_STATE }, 'the caller got the ENGINE’s answer')
  assert.equal(calls.n, 0, 'the empty shape is a thunk, so a served call does not pay to build it at all')
  assert.deepEqual(r.sent, [OP])
  assert.deepEqual(r.notes, [], 'nothing fell back, so there is nothing to narrate')
})

// ---- the four readiness rows -------------------------------------------------------------------
//
// Each is `engineServeReadiness`'s verdict, and the claim is the same three things every time: the
// empty shape answers, nothing reaches the wire, and the note names THAT reason rather than a
// generic failure. Nothing is sent because a request put on a wire that is not there would come
// back saying the wrong thing about why.

const NOT_READY: readonly { readonly why: FallbackReason; readonly phrase: string }[] = [
  { why: 'noClient', phrase: 'no engine client on this launch' },
  { why: 'notConnected', phrase: 'the connection is not ready' },
  { why: 'notAttached', phrase: 'the engine is on another log' },
  { why: 'notLive', phrase: 'the engine is still folding' }
]

for (const row of NOT_READY) {
  test(`DISCONNECTED (${row.why}): the empty shape answers, and nothing is put on the wire`, async () => {
    const r = rig({ kind: 'disconnected', why: row.why })
    const calls = { n: 0 }

    const got = await r.shim.serve(OP, { module: 'loot' }, project('loot'), emptyShape(calls, EMPTY_ANSWER))

    assert.deepEqual(got, EMPTY_ANSWER, 'the empty shape, unchanged')
    assert.equal(calls.n, 1)
    assert.deepEqual(r.sent, [], 'readiness is asked BEFORE a request is built')
    assert.equal(r.notes.length, 1, 'the first fallback of a launch is printed immediately')
    assert.match(r.notes[0], new RegExp(row.phrase.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
  })
}

// ---- the three answered-but-not-answered rows --------------------------------------------------

test('ERRORING: a refusal is swallowed — the caller sees the app’s answer, never a throw', async () => {
  const r = rig({ kind: 'erroring', error: Object.assign(new Error('no such module'), { code: 'notFound' }) })
  const calls = { n: 0 }

  const got = await r.shim.serve(OP, { module: 'loot' }, project('loot'), emptyShape(calls, EMPTY_ANSWER))

  assert.deepEqual(got, EMPTY_ANSWER)
  assert.equal(calls.n, 1)
  assert.deepEqual(r.sent, [OP], 'this one really was asked')
  assert.match(r.notes[0], /the engine refused/)
})

test('ERRORING with a non-Error rejection: still swallowed, and the note still names something', async () => {
  const r = rig({ kind: 'erroring', error: { code: 'internal' } })
  const calls = { n: 0 }

  const got = await r.shim.serve(OP, { module: 'loot' }, project('loot'), emptyShape(calls, EMPTY_ANSWER))

  assert.deepEqual(got, EMPTY_ANSWER)
  const detail = await r.shim.ask(OP, { module: 'loot' }, project('loot'))
  assert.equal(detail.served, false)
  assert.ok(!detail.served && detail.detail.includes('internal'), detail.served ? '' : detail.detail)
})

test('IDLE: an engine that never answers does not hang the caller — the deadline hands it back', async () => {
  const r = rig({ kind: 'idle' })
  const calls = { n: 0 }

  const got = await r.shim.serve(OP, { module: 'loot' }, project('loot'), emptyShape(calls, EMPTY_ANSWER))

  assert.deepEqual(got, EMPTY_ANSWER, 'the promise resolved, which is the whole claim')
  assert.equal(calls.n, 1)
  assert.match(r.notes[0], /did not answer in time/)
})

test('A GUESS: the reply is well-formed, is not an answer to the question asked, and falls back', async () => {
  // The engine answered about `kills` when this call asked about `loot`. The payload is perfect and
  // it is about the wrong thing, which is exactly the failure a result guard cannot see.
  const r = rig({ kind: 'answering', result: snap('kills', 9, ENGINE_STATE) })
  const calls = { n: 0 }

  const got = await r.shim.serve(OP, { module: 'loot' }, project('loot'), emptyShape(calls, EMPTY_ANSWER))

  assert.deepEqual(got, EMPTY_ANSWER)
  assert.equal(calls.n, 1)
  assert.match(r.notes[0], /would have been a guess/)
})

test('A NULL empty shape is still an answer: `null` out of the thunk is not a second failure', async () => {
  // `registry.snapshot` answers null for an id this build does not carry, and the shim must hand
  // that through unchanged rather than treating it as another thing that went wrong.
  const r = rig({ kind: 'disconnected', why: 'noClient' })
  const calls = { n: 0 }

  const got = await r.shim.serve(OP, { module: 'nope' }, project('nope'), emptyShape(calls, null))

  assert.equal(got, null)
  assert.equal(calls.n, 1)
  assert.equal(r.notes.length, 1, 'one fallback, one note — the null did not add a second')
})

// ---- what the shim refuses to hide -------------------------------------------------------------

test('THE CALLER’S OWN THROW IS THE CALLER’S OWN THROW: the shim swallows the engine, never the app', async () => {
  const r = rig({ kind: 'erroring', error: new Error('engine says no') })
  const boom = new Error('building the empty shape threw')

  await assert.rejects(
    () =>
      r.shim.serve(OP, { module: 'loot' }, project('loot'), () => {
        throw boom
      }),
    (err: unknown) => err === boom,
    'the engine’s failures are absorbed; the app’s own are not the shim’s to hide'
  )
})

// ---- the coalesced note ------------------------------------------------------------------------

test('THE NOTE IS COALESCED: a burst of fallbacks costs one sentence, and the sentence counts them', async () => {
  const r = rig({ kind: 'disconnected', why: 'notConnected' }, { noteEveryMs: 5_000 })
  const calls = { n: 0 }
  const ask = async (): Promise<unknown> =>
    r.shim.serve(OP, { module: 'loot' }, project('loot'), emptyShape(calls, EMPTY_ANSWER))

  await ask()
  assert.equal(r.notes.length, 1, 'the first one is printed at once — a dev looking at a blank surface')
  // THE SENTENCE NAMES THE EMPTY SHAPE, NOT A FOLD (JOS-501). It used to read "answered by the
  // app's own fold", which stopped being true the day JOS-499 deleted that fold: what answers now
  // is the empty shape each channel owes a caller it cannot serve. Both arms of the singular/plural
  // ternary are pinned here, because a coalesced note that miscounts is worse than no note.
  assert.match(r.notes[0], /1 unserved read answered with the empty shape/)

  for (let i = 0; i < 40; i++) await ask()
  assert.equal(r.notes.length, 1, '40 more polls inside the window print nothing')
  assert.equal(calls.n, 41, '…but every one of them was answered')

  r.tick(5_000)
  await ask()
  assert.equal(r.notes.length, 2)
  assert.match(
    r.notes[1],
    /41 unserved reads answered with the empty shape/,
    'nothing was dropped from the count'
  )
})

test('THE NOTE NAMES EVERY REASON IT SAW, with a count each', async () => {
  // Two different failures inside one window: a refusal and a guess. A note that reported only the
  // last would send a developer after the wrong one.
  const notes: string[] = []
  const at = 0
  let mode: 'error' | 'wrong' = 'error'
  const shim = createReadShim({
    readiness: () => SERVABLE,
    request: <O extends RequestOp>(): Promise<ResultFor<O>> =>
      mode === 'error'
        ? Promise.reject(new Error('nope'))
        : Promise.resolve(snap('kills', 1, {}) as ResultFor<O>),
    note: (line) => notes.push(line),
    now: () => at,
    timeoutMs: 5,
    noteEveryMs: 5_000,
    delay: (ms) => new Promise<void>((resolve) => setTimeout(resolve, ms))
  })
  const calls = { n: 0 }
  const ask = async (): Promise<unknown> =>
    shim.serve(OP, { module: 'loot' }, project('loot'), emptyShape(calls, EMPTY_ANSWER))

  await ask() // refused — printed at once, from a clock that reads zero (see `NoteTally.lastAt`)
  assert.equal(notes.length, 1)
  await ask() // refused again, coalesced
  mode = 'wrong'
  await ask() // a guess, coalesced
  assert.equal(notes.length, 1)

  shim.flushNotes()
  assert.equal(notes.length, 2)
  assert.match(notes[1], /the engine refused ×1/)
  assert.match(notes[1], /would have been a guess ×1/)
  assert.match(notes[1], /^data-server shim: 2 unserved reads/)
})

test('flushNotes on an empty tally says nothing at all — silence is the served state', async () => {
  const r = rig({ kind: 'answering', result: snap('loot', 3, ENGINE_STATE) })
  await r.shim.serve(OP, { module: 'loot' }, project('loot'), emptyShape({ n: 0 }, EMPTY_ANSWER))
  r.shim.flushNotes()
  assert.deepEqual(r.notes, [])
})

// ---- `ask`, the seam the e2e reads -------------------------------------------------------------

test('`ask` reports the engine arm alone: no fallback, no note, and the reason is legible', async () => {
  const r = rig({ kind: 'disconnected', why: 'notAttached' })

  const outcome = await r.shim.ask(OP, { module: 'loot' }, project('loot'))

  assert.equal(outcome.served, false)
  assert.equal(outcome.served ? null : outcome.why, 'notAttached')
  assert.deepEqual(r.notes, [], 'the probe must not pollute the narration it is there to observe')
})

test('`ask` hands back the served value untouched when the engine did answer', async () => {
  const r = rig({ kind: 'answering', result: snap('loot', 12, ENGINE_STATE) })

  const outcome = await r.shim.ask(OP, { module: 'loot' }, project('loot'))

  assert.equal(outcome.served, true)
  assert.deepEqual(outcome.served ? outcome.value : null, { seq: 12, state: ENGINE_STATE })
})
