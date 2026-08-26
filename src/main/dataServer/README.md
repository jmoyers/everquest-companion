# `src/main/dataServer` — main's half of the data server

Electron main's whole relationship with the Rust engine (`engine/crates/engined`, JOS-459). The
design and the owner's twenty rulings live in `docs/plans/data-server.md`; the engine's own side is
`engine/crates/engined/README.md`. Every file here carries its argument in its header — this page is
the map, plus the one thing no single file can state: **how the pieces connect at run time**.

**Everything in this directory is ON by default (JOS-495, the owner's cutover ruling).** The three
flags are escape hatches, not opt-ins:

| Set this | and you get |
| --- | --- |
| *(nothing — every ordinary launch)* | an engine, answering the app's reads, playing its alerts |
| `EQC_ENGINE=0` | no engine at all: the app is exactly the app it was before any of this existed |
| `EQC_ENGINE_SERVE=0` | an engine that folds and is compared, but answers no read (and makes no sound) |
| `EQC_ENGINE_ALERTS=0` | an engine that answers the reads, while this process's evaluator plays alerts |

`EQC_ENGINE` is read in exactly one place (`engineHost.ts engineEnabled`) and the other two are
SUBORDINATE rather than parallel: `serveShim.ts` gates on `engineEnabled()` rather than on a second
reading of the environment, and `alertsAudio.ts` is only ever reached from inside that guard — so a
granular flag alone is off, not half-on. All five readers of these variables (the three above plus
`serveDeltas.ts` and `src/preload/engine.ts`) share ONE comparison,
`src/shared/dataServer/engineFlags.ts engineFlagOn`, so an inverted default cannot be inverted in
four places and left in a fifth. `=1` still means on; it is simply not `'0'`.

**A checkout with no binary is unchanged by all of that.** `cargo build` is what puts an engine on
disk in a dev tree; without one the supervisor probes, logs what it looked for, and stops, and the
app runs TypeScript-only exactly as before. A PACKAGED build always has the binary (JOS-473 ships
`resources/engine/engined.exe`), so default-on there means the engine actually runs. Since
JOS-484 there is one channel registered in every build — `engine:connect`, beside `registerDevIpc` —
and it is not an exception to that rule: the handler holds no flag, is never told about a launch
without one, and therefore refuses. A registered door with nothing behind it, so the refusal is a
decision a test can watch being made rather than an absence nobody can observe.

## The files

| File | What it owns |
| --- | --- |
| `engineProtocol.ts` | The pure facts both halves share: the announce line's grammar, the binary's candidate paths, backoff, the exit-trail fold, `redactToken`. No I/O. |
| `token.ts` | Minting the per-launch secret. (`src/shared/dataServer/token.ts` holds the shape rules; loopback is not a permission boundary — the token is.) |
| `supervisor.ts` | The lifecycle STATE MACHINE: spawn, watch, respawn, kill. Electron-free and dependency-injected, so every failure path is a unit test with no app and no Rust. |
| `engineHost.ts` | The composition root's half: which binary, which spawn, which socket, which clock, where a line goes. The only file anyone would rewrite to run the engine some other way. |
| `socketChannel.ts` | The only file in the feature that knows a socket exists. |
| `engineHealth.ts` | "Is it actually serving?", asked as `hello` + `session.health` over the product's own door. |
| `engineClientHost.ts` | **The app as a CLIENT** (JOS-479): connect, attach, re-attach, and run the parity probe. Since JOS-483 it also answers two READS for the performance panel — `enginePerfSnapshot()` and `lastParitySummary()` — and since JOS-489 it exposes the main-side request bridge, `engineServeReadiness()` + `engineRequest(op, params)`. It still owns no channel, and no client handle escapes it. |
| `parityProbe.ts` | The probe's pure half — two snapshots in, one verdict out, one line. |
| `readShim.ts` | **The compat shim's pure half** (JOS-489): which world answers a read, and what happens when the engine cannot. Readiness, a bounded round trip, a projection that says whether a reply was an ANSWER, and the coalesced fallback tally. No app imports, so the whole matrix is a unit test. |
| `serveShim.ts` | The shim, wired: the `EQC_ENGINE_SERVE` gate, the three channels' projections, the `SnapshotOpts` translation, and the `EQ_E2E`-only parity seam. |
| `byteRelay.ts` | **The pump** (JOS-484): chunks between a socket and a MessagePort. Electron-free, so every teardown path is a unit test. |
| `rendererBroker.ts` | **The brokerage** (JOS-484): the `engine:connect` handler, the port handover, and the live-connection lifecycle. |

The engine's row in the app's performance panel is assembled **outside this directory**, in
`src/main/enginePerfWatch.ts`: it joins `enginePerfSnapshot()` with a native per-pid read
(`src/main/processSample.ts` — `app.getAppMetrics()` is Chromium's own process list and the engine
is not in it) and pushes one object over the perf IPC family. **It polls only while the panel is
open** — see "The polling discipline" in `engine/crates/engined/README.md` for the rule and why it
exists. The renderer never speaks to the engine; brokering a client into a window is a later ticket.

## The connect flow (JOS-479, phase 3)

```
 startEngineSupervisor()          [engineHost.ts, unless EQC_ENGINE=0]
   ├─ installEngineClient()       registers the world-rebuilt observer on pipeline.ts
   └─ supervisor.start()
        spawn engined.exe ─── token down stdin ──►  engine
        ◄── "EQC-ENGINE PORT=… PROTOCOL=…" on stdout
        hello + session.health over the port ──────────► a proven ROUND TRIP
        │
        └─ onReady({ port, token, pid, epoch, engineVersion })
             │                    [supervisor.ts, beside onPid]
             ▼
           engineClientHost.onEngineReady
             ├─ createEngineClient({ token })      one client per LAUNCH — see below
             ├─ connectToEngine(port) → NDJSON transport → client.attach(transport)
             └─ session.attach({ logPath })        the log THIS PROCESS IS TAILING
                  │
                  ▼
                (both worlds folding the same file)
                  │
   sendWorldRebuilt(character) ───┘   [pipeline.ts — the app's fold landed]
     ├─ re-attach IF THE LOG CHANGED (a character switch — all switch paths reach this one funnel)
     └─ THE PARITY PROBE
```

An attach is a whole re-fold, so it is sent only when the FILE changes. The flow above reaches
`attachAndProbe` twice on an ordinary launch — once at READY and once when this process's fold lands
— and a second attach there would make the engine read the log twice for nothing. It is not a
freshness risk: the engine folded the same file from byte zero and has been tailing it since, which
is the same lossless seam as the app's own scan→tail handoff.

**Where the log path comes from.** `session.ts` already exports `getActiveCharacter()`, and
`sendWorldRebuilt` already carries the `CharacterRef`. Those two are the whole hook: *no line of
`session.ts` changed for this feature.* The rebuild funnel is preferred (it names the log whose fold
has LANDED here) with the tailing character as the fallback, which is what lets an engine that
becomes ready mid-fold start reading immediately instead of idling until the next switch.

**Why a fresh client per launch.** A respawn mints a new token and binds a new port (spawn contract
rule 5), so a client that survived one would be holding credentials for a process that no longer
exists. The old client is closed and a new one is built; `client.attach` is what hands it its
transport. Nothing is carried across — which is the same resume-is-re-query law the client library
already enforces on its own window state.

**Preemption.** Every step here is asynchronous and every one of them can be superseded by a
character switch or an engine respawn. `switchController.ts`'s answer is used verbatim: a GENERATION
counter, re-asked after each suspension point. A turn that has lost touches nothing and — crucially
— writes no line, because a verdict about a world somebody has since replaced is a measurement of
nothing printed with authority.

## The renderer brokerage (JOS-484, ruling 7)

Owner ruling 7, verbatim: *"one connection per renderer, brokered by main"*. Everything above is
main talking to the engine for its own reasons; this is main getting out of the way so a **renderer**
can talk to it.

```
 renderer                         MAIN                                  engine
  window.eq.engineConnect()
      │ invoke engine:connect(nonce) ──────►  rendererBroker.onConnect
      │                                         ├─ connectToEngine(port)  ──── TCP ────►  accept
      │                                         ├─ new MessageChannelMain()
      │                                         ├─ relayBytes(socketChannel, port1)
      │  ◄── postMessage(engine:port,           └─ sender.postMessage(…, [port2])
      │        {nonce, token}, [port])
      │
   preload wraps the port           ┌──────────────────────────────────────────┐
   messagePortChannel(port)         │  socket chunk  →  port.postMessage(chunk) │  byteRelay.ts
      │                             │  port message  →  socket.write(chunk)     │  (no parsing,
   createNdjsonTransport            └──────────────────────────────────────────┘   no protocol
      │                                                                             types at all)
   createEngineClient({token}).attach(…) ── hello ─────────────────────────────►  hello reply
```

### Why BYTES and not frames

The obvious brokerage is a proxy: main runs an `EngineClient`, renderers ask over IPC, main
serializes an answer per window. **That is exactly the cost the engine exists to delete** — JOS-458
measured the per-window serialization of fold state, and a broker that re-created it would have moved
the fold and kept the bill.

So main relays raw chunks and never parses one. `byteRelay.ts` imports no protocol type, no codec and
no Electron; the only thing it can do to a chunk is move it, and its one type check exists because a
renderer's message reaches a socket (`socket.write` would coerce an object to `[object Object]` and
hand the engine a frame nobody sent). The renderer runs the real `EngineClient` over
`shared/dataServer/messagePortChannel.ts` and is a **first-class peer of the engine**: its
subscriptions, its diffs, its epoch, its window state. Main's cost per view is zero, because there is
nothing in the path to cost anything.

The temptation on this wire is to post one protocol message per `postMessage` and delete the codec on
the renderer's side — a MessagePort is message-oriented, after all. That would be a **second framing,
in a second place**, disagreeing with the first the day either changed (owner ruling 15). The port
carries the socket's own chunks, unaligned, and `LineDecoder` reassembles them exactly once.
`tests/dataServerBroker.test.mts` feeds a real conversation **one character at a time** to keep that
honest.

### The token handoff

Loopback is not a permission boundary — the token is (`token.ts`) — so a renderer holding a socket has
to present one. It rides the **same `postMessage` that carries the port**: one delivery, so there is
no window in which a renderer holds a wire it cannot use or a secret with nothing to use it on.

Where it lives: the preload's closure, and the `EngineClient` that preload's channel serves. Not the
store, not a URL, not the DOM, not `localStorage`. **The MessagePort itself never crosses the context
bridge at all** — `src/preload/engine.ts` wraps it and hands the renderer four plain functions
(`write`/`onData`/`onClose`/`close`), because a preload that gives out a port it cannot take back is a
preload that cannot enforce a lifetime. A respawn mints a new secret regardless (spawn contract
rule 5), which is why every launch invalidates every port below.

### Lifecycle, all five directions

| What happened | What closes | How |
| --- | --- | --- |
| The renderer lets go | the socket | the channel posts the end sentinel; the relay destroys the socket |
| The window is destroyed | the socket | `webContents 'destroyed'` → `dropRelay` |
| The window's port is collected | the socket | `MessagePortMain 'close'` → the same settle |
| The engine dies | the port | the socket ends; the relay posts the sentinel and closes the port; the renderer's transport reports a failed connection |
| The engine respawns | **every** relay | `noteEngineLaunch` — the port and token a renderer holds name a process that no longer exists |

A respawn is answered by the renderers asking again: a fresh connect, a fresh token, a fresh reset.
That is **resume-is-re-query** (diff-protocol rule 3), which the client library already enforces on its
own window state, so there is nothing to carry across and nothing to resume. `EngineProvider`'s retry
is a flat 4 s timer rather than a backoff — the whole feature is behind a developer's environment
variable and the cost of being wrong is one refused IPC call.

**One connection per renderer is enforced, not trusted**: the relays are keyed by `webContents.id`, so
a second `engine:connect` from a window that already holds one closes the first. A renderer that
reloads replaces its connection instead of leaking one per reload.

**There is no second gate.** `rendererBroker.ts` reads no environment variable: `engineHost.ts` owns
the one flag and simply never calls `noteEngineLaunch`, so the handler finds no launch and answers
`{ok:false}`. The IPC channel is registered in every build, exactly like `registerDevIpc` beside it —
the refusal is a decision a test can watch being made.

### The first surface, and what it proved

`src/renderer/src/features/loot/EngineLootLedger.tsx` is the first product surface on `useView`: the
loot ledger drawn from `loot.ledger`, behind a dev-only toggle that is gated on a **live connection**
rather than on a flag. `tests/e2e/engine-loot-view.e2e.mts` opens the flat ledger, reads every
rendered row, flips the toggle, reads them again and asserts they are identical cell for cell — the
DOM as the oracle, one layer above what `engine-parity` can see.

Two things that comparison found, both worth keeping written down:

1. **The plan's example descriptor draws a different ledger.** `sort: [["at","desc"]]` is not the flat
   ledger's order. Every sort ends in the source's tiebreak and `loot.ledger`'s is `seq` ASC, so the
   one-term form orders each same-second group backwards — and EQ stamps to the second, so a corpse
   yielding three items is exactly such a group. The descriptor names `["at","desc"], ["seq","desc"]`.
2. **The two modes do not mount the same number of rows, and should not.** Both virtualize over the
   same row height, but the app-fed ledger carries a slice bar, a toolbar, a caption, a strip and its
   notices above the scroll box while the served one carries a toggle and a caption — so the served
   box is taller and shows more of the same list (29 vs 35). The e2e asserts the served window
   *covers* the app's and agrees with it over the whole of it, rather than pretending the counts match.

**The ledger virtualizes; it does not page.** There is no page control, no offset state and no next
button on that tab, so there is no paging to wire the descriptor's window to; it is a fixed newest-50
and the caption says so against the view's own `total`. Moving `offset` into state and re-subscribing
per page is the upgrade when a surface wants one — cheap, because `useView` already treats a changed
descriptor as a new query — and it is deliberately not built speculatively.

## The parity probe

Once the engine's ingest is `live` and this process's fold has landed on the same log, the probe
asks the engine for `module.snapshot` on five modules (`loot`, `kills`, `leveling`, `character`,
`buffs`), asks `registry.snapshot(id)` for the same five here, deep-compares each pair, and writes
**one line** to the dev log:

```
data-server parity: 3 agree, 2 diverge, 0 skipped of 5 [epoch 2, engine live, 1599 events, mark 129297 of …\eqlog_Primitive_freeport.txt]
  — loot AGREE(seq 1598) · kills AGREE(seq 1598) · leveling AGREE(seq 1598)
  · character DIVERGE(seq 3) at .character.lastPlayed: engine (absent) vs app 1787649515839.0056
  · buffs DIVERGE(seq 1598) at .active.length: engine 12 vs app 3
```

(That is a real run, wrapped for this page; it is one line on the wire.)

The coordinate in the bracket is **the engine's own `session.health` mark**, quoted rather than
assumed: the comparison only means anything if both worlds folded the same file, and the app cannot
establish that by remembering what it asked for. An echo is evidence; a variable is a belief. When
the two disagree the clause becomes `LOG MISMATCH: app … but engine …`, which is deliberately the
loudest phrasing in the sentence — it is the one failure that would make every other number in the
line a lie.

**It is LOG ONLY.** No IPC, no renderer, no store write, no branch in the product reads a verdict.
The TypeScript fold remains the app's only source of truth until the cutover deletes it.

**Matched marks, or no comparison.** The two worlds fold the same bytes at different speeds and the
file may be growing while they do. So every module is compared only when the two `seq` values agree
— a module's OWN published seq, which for sixteen of them is the last event folded and for four
(combo, character, respawn, buffTimers) is a private revision counter (JOS-87). Unequal is DRIFT,
reported as SKIPPED with both numbers, and counted separately from agreement: a probe that silently
compared nothing and reported "0 divergences" would read like proof.

**One field is dropped, from both sides:** `overlay.updatedAt`, which the message-overlay miner
stamps with the wall clock when a snapshot is TAKEN. The golden oracle drops exactly this and
nothing else. The app's state is also round-tripped through `JSON` first, so a serializer's opinion
(an `undefined` value that exists in an object and vanishes on the wire) cannot be reported as a
fold divergence.

**What it is FOR, given the oracle already exists.** `npm run oracle:rust-fold` proves all twenty
modules equivalent over 1.28M events of the owner's real log — offline, at a bench, with both worlds
built to order. This probe asks a different question: does the SHIPPING pipeline agree — the engine
the supervisor spawned, folding the log the app is tailing, against the registry in this process, as
constructed by the real composition root? It found two things the oracle structurally cannot see.

### The two known asymmetries (measured 2026-08-25, JOS-479)

Both are pinned by `tests/e2e/engine-parity.e2e.mts` **with their exact paths**, so the day either
closes the spec goes red and somebody deletes the exemption. Neither is a fold defect.

1. **`character` at `.character.lastPlayed`.** The app's `CharacterRef` carries
   `statSync(logPath).mtimeMs` (`log/config.ts`), pushed in by `session.ts resetWorldFor`. It is a
   FILESYSTEM fact, not a fold fact. The engine derives its ref from the log's file NAME and never
   stats anything, so the field is honestly absent there. The oracle cannot see it because its TS
   world is built from a three-field ref (measured: a bench fold of the same fixture publishes
   `{name, server, logPath}` and no `lastPlayed`). An mtime could not live inside a deterministic
   fold anyway — ruling 18 law 1 — so the open question is whether the app should be publishing one
   through a fold module at all, or whether it becomes pushed app knowledge like the other impure
   inputs (boundary verdict 3). **Owner call, not a worker's.**

2. **`buffs` at `.active.length` — engine 12, app 3.** MEASURED on a bench fold of the same bytes:
   the TypeScript fold publishes **12** actives before any tick and **3** after a single
   `registry.tick(Date.now())`. So the two folds agree exactly; what differs is that the app runs a
   wall-clock heartbeat over its modules (`session.ts startHeartbeat`, one tick before the interval)
   and the engine's `Fold` never calls `on_tick` — deliberately, because no module in that crate may
   read a wall clock (ruling 18 law 1: determinism IS cacheability). The method exists on the Rust
   trait and is documented as "the live tail's". **Where the heartbeat lives once the fold is
   engine-side is a phase-3 design question**, and it is the first thing this program has met that
   the equivalence oracle cannot decide, because the oracle never ticks either side.

## The compat shim (JOS-489, phase 1 of the cutover)

Three of the app's own read IPCs are answered by the engine — by DEFAULT since JOS-495, and
`EQC_ENGINE_SERVE=0` is what hands them back:

| IPC channel | op | what the shim hands back |
| --- | --- | --- |
| `module:getSnapshot` | `module.snapshot` | `{ seq, state }`, when the echoed module is the one asked for |
| `combat:snapshot` | `combat.snapshot` | `result.snapshot`, when `result.now` is this process's wall clock and not the fold's |
| `combat:searchFights` | `combat.searchFights` | `{ hits, corpus }` |

Both arms live side by side in `src/main/ipc/world.ts` and the flag decides **per call**. With the
flag off, each handler's expression is exactly the one it has always been with one boolean read in
front of it — no promise where there was a value, and `serveShim.ts` allocates nothing.

**The one law is that the shim must never make the app worse than the flag-off world**, and every
other rule follows from it. Seven ways the engine can fail to answer — no client, a connection that
is not ready, an engine on another log, an engine still folding, a refusal, a silence, and a reply
that is not an answer — all resolve to the very call the old path would have made, so a caller of
these three channels can never see an error the TypeScript arm would not have thrown. **Silence is
the one the promise-shaped arm adds** that a synchronous handler never had, which is why the engine
arm carries a 2 s deadline: an engine that accepted a request and never replied would otherwise hang
a renderer's `invoke` forever.

Readiness is four questions asked fresh per call (`engineClientHost.ts engineServeReadiness`): is
there a client, is its connection `ready`, is the engine attached to the log **this process folded**,
and has its fold on that log gone `live`. The last is taken off the `session.health` round trip the
parity probe is already making, and it dies with the turn — a respawn, a character switch and a
rebuild all clear it, so the shim falls back to the app's own fold until health says `live` again.

The fallback note is **coalesced**, because the failure mode is a burst: these channels are polled,
so a disconnected engine would otherwise print hundreds of lines a second and bury the narration a
developer flipped the flag to read. One sentence per five-second window, naming every reason with
its count, and the first fallback of a launch prints immediately.

### The asymmetries (measured 2026-08-25, JOS-489) — and there are none left

All three surfaces are **fully deep-equal**, at every path, and `KNOWN_ASYMMETRY` in
`tests/e2e/engine-shim.e2e.mts` is empty **by fix rather than by omission**.

The measurement is worth keeping. Against the engine as it stood before JOS-488, the combat snapshot
diverged at exactly three paths — `.hydrating` (engine `true`, app `false`), `.currentTarget` (engine
still holding the last mob, app absent) and `.segments[0].kind` (engine `"current"`, app `"fight"`).
They were **one gap, not three**: the snapshot-time sweep block the cutover ledger names (charm
sweep, ally expiry, pet nudge, deferred encounter closure), unported. In the app's own implementation
`hydrating` is literally the flag that gates it — `if (!this.st.hydrating) { … evalClosure(…) }` in
`combat/engine.ts snapshot` — so an engine that could not honestly say `hydrating: false` was exactly
an engine that had not ported it, and the other two paths were what the block does. JOS-488 ported
it, this spec went red on all three rows demanding they be deleted, and they were: **the pin contract
cuts both ways**, which is what makes an empty table a claim rather than a silence.

The shim never rewrote a served field to reach that state, and it should not: a shim that
manufactured agreement would hide the gap being tracked.

## The client spell table: NO BULK FRAME, EVER (JOS-496, integrator ruling 2026-08-25)

Boundary verdict 8 says the engine parses the client's `spells_us.txt`, and the cutover ledger's item
6 says "the app-side worker retires under serve". The obvious reading of those two sentences together
— the engine parses the table and SERVES IT to the app, which stops parsing — is **ruled out**, and
the measurement that ruled it out is worth keeping because it will keep looking tempting:

> The owner's own parsed table, as this app caches it today
> (`<userData>/spell-resist-cache.json`): **48,252 entries, 6,422,572 bytes of JSON — 6.13 MiB**.
> The NDJSON frame ceiling is **8 MiB** (`shared/dataServer/ndjson.ts MAX_LINE_CHARS`, matched by the
> Rust codec's `MAX_LINE_BYTES`). One reply would be **76.6% of the ceiling**, on one machine, today,
> against a table that grows with every client patch.

A single frame that already sits three quarters of the way to a hard limit is not a design with
headroom, it is a design with a date on it — and the failure when it arrives is a refused frame at
the transport, not a graceful degradation.

**THE DIRECTION, ruled:**

1. **The engine parses `spells_us.txt` INTERNALLY, for its own joins.** The path derives from the
   attach log's install directory (`…/Logs/..`), so it needs no new schema field. The parse exists to
   serve the engine's own resolution — first and foremost the con card's resist chips, which
   `engined/src/concard.rs` currently sends empty and says so at length.
2. **App consumers move to PER-SPELL QUERIES**, not to a bulk transfer. `knowledge.spell` already
   exists and already carries a named gap (no effect classes, no rank lineage, no metrics); that op
   is where the client table's facts belong. A card, a hover, a catalog row — every real consumer
   asks about a handful of spells at a time, so the query shape matches the demand shape, and the
   payload is bounded by the question rather than by the corpus.
3. **The bulk shape is not to be built as an interim step.** It would work on the owner's machine
   this month, which is exactly what makes it dangerous.

**Consequences, stated so nobody re-derives them:**

* Item 4 was **not built** in JOS-496 — only measured and ruled. **JOS-497 item 3 built the engine
  half of it**: `fold::spells_us` is the parser (the app's field map and, more importantly, the app's
  JavaScript arithmetic — `Number()`, `Number(x) || 0`, and the `f.length < 172` row filter that is
  172 and not 173), `engined::spells` is the file (path derived from the attach's log grandparent,
  read lazily on a connection thread, exactly once per install), and `resist.spell` is the per-spell
  op. No bulk shape exists and none can be added without deleting the argument above.
* The app-side worker (`main/resist/spellTable.ts`) **still does not retire**, and this is the named
  honest partial of JOS-497 rather than an omission. The blocker is not the engine's answer, it is
  the SHAPE of every app-side consumer: `estimate()` takes the whole `SpellResistTable` as a value,
  `buildLevelUnlocks` scans ~2,000 catalog spells against it, and `clientHpFor` is called from inside
  synchronous builders. Retiring the worker means converting those call sites to per-spell awaits —
  which is the surface-cutover work, not this ticket's, and doing it halfway would mean the app
  holding two tables at once.
* The con card's five resist chips are therefore **still joined app-side** (`main/conCard.ts
  noteEngineConCard`), off the app's own ledger and table, even though the engine resolves the whole
  header. That is deliberate: the engine's honest answer today is five EMPTY chips with
  `spellData: false`, and carrying those through would make every card under serve read "nothing seen
  yet" forever while the app holds a ledger that can answer.

## The two fold-owned artifacts, engine-side but NOT YET SWITCHED ON (JOS-496, boundary verdict 4)

The engine can now read and write `resist-ledger.json` and `message-overlay.json` itself, in the
app's existing paths and byte-verbatim formats, seeded at attach and written on its own 60-beat
cadence with temp+fsync+rename. `SessionAttachParams.stateDir` is the one (optional, additive) schema
field that carries Electron's `userData` directory in, because the engine cannot derive it.

**The app does not send that field, on purpose.** Sending it while `main/resist/store.ts` and
`main/data/overlayPersistence.ts` still persist would put **two processes on one file with two
cadences**, which is a corruption risk rather than a cutover. And the app's writers cannot simply be
retired "under serve", because `shimServing()` does not mean an engine exists (see below) — a
cargo-less checkout would stop persisting and have nothing writing in its place.

So the honest state is: **the engine half is built and proven; the switch is one line and is
deliberately not thrown.** Throwing it is a follow-up whose whole content is the app-side retirement
and the predicate that guards it — and that predicate has to be a fact about a live engine, not a
flag.

## `shimServing()` IS NOT "AN ENGINE EXISTS" (JOS-496 — read this before adding a gate)

`shimServing()` is `EQC_ENGINE` AND `EQC_ENGINE_SERVE`. Both default **on** since JOS-495. It is
therefore **true on every checkout that has never run `cargo build`**, where there is no binary, no
client, and no frame will ever arrive. It answers "did anybody ask for the engine to be gone", which
is a different question from "is there an engine".

For the READ shim this is harmless by construction — `readShim.ts`'s `noClient` outcome answers every
call from the app's own fold. For anything that **hands a duty over**, it is fatal and silent. Three
instances have existed:

| Where | What went silent | Fixed by |
| --- | --- | --- |
| `alertsAudio` armed from `startEngineSupervisor()` | **all alert audio**, until quit, on any build with no engine | arming on the supervisor's READY edge (and disarming on its loss edge) |
| `registerConCardIpc(shimServing())` skipped the TS hook | the con card, permanently | asking `shimServing() && engineServeReadiness().ok` per `/con` |
| the post-replay boot summary | one dev-log line | the gate withdrawn; the line names its subject instead |

**The rule:** a gate that decides *who does a job* must ask `engineServeReadiness()` (or a
launch-shaped edge like `onReady`), never a flag. And it should **fail towards the app doing the
job** — a duplicated card or sound is cosmetic, a missing one is not.

## Tests

| | |
| --- | --- |
| `tests/dataServerSupervisor.test.mts` | Every lifecycle failure path, plus the READY handover. No app, no Rust. |
| `tests/dataServerBroker.test.mts` | Both ends of the brokered wire: splits cross unchanged, four teardown paths, and a real conversation delivered one character at a time. |
| `tests/e2e/engine-loot-view.e2e.mts` | The row-parity oracle — the app-fed and served ledgers, compared as DOM. |
| `tests/dataServerParity.test.mts` | The probe's judgement: agreement, divergence, drift-is-a-skip, the two refusal sentences, the line's shape. |
| `tests/dataServerShim.test.mts` | The compat shim's arm selection and its whole fallback matrix, driven by fake clients — connected, disconnected, idle, answering, erroring — plus the coalescing rule and the one throw it must NOT swallow (the app's own). |
| `tests/e2e/engine-shim.e2e.mts` | The shim in the running product: both arms of three channels compared at a matched mark in ONE launch, `window.eq` checked against the served answer, and a staged refusal proving the renderer still gets the flag-off answer. |
| `tests/dataServerEngineChild.test.mts` | The real child, pipe and socket against a Node fake engine. |
| `tests/e2e/engine-boots.e2e.mts` | The real binary under the real app: spawn, ready, respawn, wrong token, quit, absence. |
| `tests/enginePerf.test.mts` | The performance panel's engine row above the FFI boundary: the per-pid CPU arithmetic over a fake pid, the formatters' absent cases, and `useEnginePerf` run for real (arming, disarming, the null push). |
| `tests/e2e/engine-parity.e2e.mts` | The connect flow and the probe end to end on a staged fixture — **and** (`enginePerfSteps.mts`) the ENGINE section of the in-app performance panel, whose verbatim text the run prints. |
| `npm run oracle:rust-fold` | The semantics bar: twenty modules, six slices of the owner's real log. |
