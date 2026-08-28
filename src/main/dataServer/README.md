# `src/main/dataServer` — main's half of the data server

Electron main's whole relationship with the Rust engine (`engine/crates/engined`, JOS-459). The
design and the owner's twenty rulings live in `docs/plans/data-server.md`; the engine's own side is
`engine/crates/engined/README.md`. Every file here carries its argument in its header — this page is
the map, plus the one thing no single file can state: **how the pieces connect at run time**.

**THERE ARE NO FLAGS ANY MORE (JOS-499, the deletion release).** `EQC_ENGINE`,
`EQC_ENGINE_SERVE` and `EQC_ENGINE_ALERTS` are deleted, and so is the world they used to select:
owner ruling 12 moved the app fully to the engine and the TypeScript fold is gone. A flag that
can only answer one way is a gate every future reader has to prove is dead, so each was removed
rather than defaulted to true. `src/shared/dataServer/engineFlags.ts` survives with no reader in
this directory.

What used to be `EQC_ENGINE=0` is not a supported configuration; it is simply **an app that
cannot answer**, and that state is now honest rather than silently substituted:

| The engine is | and a read gets |
| --- | --- |
| connected, attached to this log, live | the engine's answer |
| absent / still folding / on another log | `null` for a module snapshot, an empty meter, no search hits |

Nothing falls back, because there is nothing to fall back to. Every unserved read is still
COUNTED AND NAMED in the dev log by `readShim.ts` (`the engine is still folding x12`), so a blank
surface always has a reason a developer can read. `tests/e2e/engine-absent.e2e.mts` is the
contract: the app boots, says what it looked for, invents nothing, and does not crash.

**A checkout with no binary is the ordinary dev state and is what that spec arranges.**
`cargo build` is what puts an engine on disk in a dev tree; without one the supervisor probes,
logs what it looked for, and stops. A PACKAGED build always has the binary (JOS-473 ships
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
| `supervisorChild.ts` | What a CHILD PROCESS looks like from here: the three structural shapes a real `ChildProcess` and a test's fake both satisfy, plus the line reader. Split out of `supervisor.ts` at its line ceiling (JOS-503) along a section header that file already had; it imports the shared line codec and nothing else, so the state machine's Electron-freedom is unchanged. |
| `engineLaunchState.ts` | **What the SHELL is told about the launch** (JOS-503): one `EngineLaunchSay`, pushed on change — the historical fold's progress while one is running, and the reason the engine will not start when it will not. See "The launch, as a window sees it" below. |
| `engineHost.ts` | The composition root's half: which binary, which spawn, which socket, which clock, where a line goes. The only file anyone would rewrite to run the engine some other way. |
| `socketChannel.ts` | The only file in the feature that knows a socket exists. |
| `engineHealth.ts` | "Is it actually serving?", asked as `hello` + `session.health` over the product's own door. |
| `engineClientHost.ts` | **The app as a CLIENT** (JOS-479): connect, attach, re-attach, and subscribe to the four connection-wide streams (fires, con cards, cursors, knowledge misses). It answers `enginePerfSnapshot()` for the performance panel and exposes the main-side request bridge, `engineServeReadiness()` + `engineRequest(op, params)`. The parity probe left with the second world (JOS-499). It still owns no channel, and no client handle escapes it. |
| `readShim.ts` | **The compat shim's pure half** (JOS-489): whether the engine can answer a read, and what the caller gets when it cannot — the EMPTY SHAPE, never a second opinion. Readiness, a bounded round trip, a projection that says whether a reply was an ANSWER, and the coalesced unserved tally. No app imports, so the whole matrix is a unit test. |
| `serveShim.ts` | The shim, wired: the channels' projections, the `SnapshotOpts` translation, the `lastPlayed` graft and the served mob-level op. Its gate and its parity seam left with the second world (JOS-499). |
| `serveLogs.ts` | **Log discovery, served** (JOS-498, ruling 21 / sheet 1a): `logs.list`, on a SECOND shim instance with a weaker readiness — see "Two readinesses" below. Also the list of callers that deliberately keep the local read, each with its reason. |
| `logsRows.ts` | What makes a `logs.list` reply an ANSWER: the directory echo, the one verdict that falls back, the field-by-field copy onto `CharacterRef`. Types-only imports, so the matrix is a unit test (`readShim.ts`'s split, applied to one channel). |
| `knowledgeMissFetch.ts` | **The app-side half of a wiki miss** (JOS-499, boundary verdict 5): the engine has no network, so it announces a name it could not answer and this leaf runs `lookupItem`/`lookupMob` on the queue the app has always owned and pushes the record back as `knowledge.define`. Electron-free; its capabilities are injected. |
| `byteRelay.ts` | **The pump** (JOS-484): chunks between a socket and a MessagePort. Electron-free, so every teardown path is a unit test. |
| `rendererBroker.ts` | **The brokerage** (JOS-484): the `engine:connect` handler, the port handover, and the live-connection lifecycle. |

The engine's row in the app's performance panel is assembled **outside this directory**, in
`src/main/enginePerfWatch.ts`: it joins `enginePerfSnapshot()` and `enginePerfBudgets()` with a
native per-pid read (`src/main/processSample.ts` — `app.getAppMetrics()` is Chromium's own process
list and the engine is not in it) and pushes one object over the perf IPC family. **It polls only
while the panel is open** — see "The polling discipline" in `engine/crates/engined/README.md` for the
rule and why it exists. The renderer never speaks to the engine; brokering a client into a window is
a later ticket.

**Three diagnostic accessors live in `engineClientHost.ts` and all three SWALLOW TO NULL** —
`enginePerfSnapshot`, `enginePerfBudgets`, `enginePerfTimeline` (JOS-483, JOS-502). That is the
opposite posture from `engineRequest`, which rejects, and the line between them is stated at the
call site: a READ whose answer a user sees owes its caller a reason, while a DIAGNOSTIC that cannot
be taken has nothing to say. None of the three waits for a connection or opens one — a perf panel
must never be the reason a socket exists.

**A bug report carries the same three answers** (ruling 19's other half). `src/main/feedback/perf.ts`
asks them at report time rather than reading the panel's last sample: the watch runs only while the
panel is open, so its newest reading is usually minutes old or absent, and a report is composed at
exactly the moment a stale one would be worst. `src/shared/feedbackPerfEngine.ts` turns them into
the block and carries the bright-line argument — every value on that shape is a whole number or a
closed-enum member, which is how the engine's own absolute log path and the log's clock are kept off
a report by SHAPE rather than by a scrub.

## The connect flow (JOS-479, phase 3)

```
 startEngineSupervisor()          [engineHost.ts — unconditional since JOS-499]
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
             ├─ logs.setDir({ dir: eqLogsDir() })  BEFORE attachAndProbe — see below
             └─ session.attach({ logPath })        the log THIS PROCESS IS TAILING
                  │
                  ▼
                (the engine folding the attached file)
                  │
   sendWorldRebuilt(character) ───┘   [the character this process is tailing changed]
     └─ re-attach IF THE LOG CHANGED (a character switch — all switch paths reach this one funnel)
```

An attach is a whole re-fold, so it is sent only when the FILE changes. The flow above reaches the
attach path twice on an ordinary launch — once at READY and once when the world is rebuilt — and a
second attach there would make the engine read the log twice for nothing. It is not a freshness
risk: the engine folded the same file from byte zero and has been tailing it since.

**AND THE GO-LIVE EDGE IS THE ONE THAT MATTERS TO EVERYTHING ELSE.** When `session.health` first
answers `live`, `engineClientHost.ts` pushes the world-changed beat, primes the mirrors, prints the
serving sentence, and (JOS-501) drops an `engine:live` breadcrumb. That instant is when
`engineServeReadiness()` starts answering yes and every read in the product changes hands.

**Why `logs.setDir` sits above the attach rather than beside the defines** (JOS-498). The five
`*.define` pushes are made from `attachAndProbe`, which RETURNS EARLY when this app has no character
attached — "the engine is left idle". That early return is exactly the launch a served character list
matters most on: a fresh install has nothing to attach to and a picker that has to draw one anyway.
So the directory is pushed from `openConnection`, before anything can decide there is nothing to do.
It is also the one push that is not a fold input — the five change what folding a log produces and
must precede a fold; a directory changes no fold at all, so its placement buys reachability rather
than correctness.

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
DOM as the oracle, one layer above anything a unit can see.

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

## The parity probe — GONE, and what it settled before it went

The probe compared this process's own fold against the engine's, module by module at matched marks,
and wrote one verdict line to the dev log. **It left with the second world in JOS-499**: there is
nothing to compare an engine against any more, and a comparison with one arm is not a probe.
`tests/e2e/engine-parity.e2e.mts` and `tests/dataServerParity.test.mts` went with it.

Two things it found are kept here, because both were REAL and only one of them closed:

1. **`character.lastPlayed` was a FILESYSTEM fact inside a fold.** The app's `CharacterRef` carried
   `statSync(logPath).mtimeMs`; the engine derives its ref from the log's file NAME and stats
   nothing, so the field was honestly absent there. An mtime cannot live inside a deterministic fold
   (ruling 18 law 1), and the owner settled the direction in ruling 21: **the server owns log-file
   facts** and reports them. It is a served process fact now — `serveShim.ts`'s `lastPlayed` graft —
   and never fold state.

2. **`buffs.active` differed 12 vs 3, and neither fold was wrong.** MEASURED on a bench fold of the
   same bytes: the TypeScript fold published 12 actives before any tick and 3 after a single
   `registry.tick(Date.now())`. The app ran a wall-clock heartbeat over its modules; the engine's
   `Fold` never calls `on_tick`, deliberately, because no module in that crate may read a wall
   clock. That question — where the heartbeat lives once the fold is engine-side — was the first
   thing the program met that the equivalence oracle could not decide, and the owner answered it in
   ruling 22: **the engine ticks its own modules while LIVE with its own clock, and historical
   replay stays clockless.** Built in JOS-481.

The one instrument worth remembering from it: the probe quoted **the engine's own `session.health`
mark** rather than assuming both sides were on the same file. An echo is evidence; a variable is a
belief. Anything that compares two processes should do the same.

## The compat shim (JOS-489, phase 1 of the cutover)

Three of the app's own read IPCs are answered by the engine, and since JOS-499 by NOTHING ELSE —
there is no arm to hand them back to. What the table calls "hands back" is the served answer;
the row below it is what a caller gets when the engine cannot be asked:

| IPC channel | op | what the shim hands back |
| --- | --- | --- |
| `module:getSnapshot` | `module.snapshot` | `{ seq, state }`, when the echoed module is the one asked for |
| `combat:snapshot` | `combat.snapshot` | `result.snapshot`, when `result.now` is this process's wall clock and not the fold's |
| `combat:searchFights` | `combat.searchFights` | `{ hits, corpus }` |

**THERE IS NO SECOND ARM AND NO FLAG.** The handlers live in `src/main/ipc/world.ts` and ask the
engine unconditionally. What `readShim.ts`'s `own()` thunk carries is the EMPTY SHAPE each channel
owes a caller it cannot answer — `null` for a module snapshot, a `hydrating` meter, no search hits,
no `dropsSeen` — never a second opinion about the world.

**The law is the plain one the deletion release rests on: A READ THAT CANNOT BE SERVED SAYS SO, AND
NEVER INVENTS.** Seven ways the engine can fail to answer — no client, a connection that is not
ready, an engine on another log, an engine still folding, a refusal, a silence, and a reply that is
not an answer — all resolve to the empty shape rather than to an error, so a caller of these three
channels sees a blank surface instead of a crash. **Silence is the one the promise-shaped path
adds** that a synchronous handler never had, which is why it carries a 2 s deadline: an engine that
accepted a request and never replied would otherwise hang a renderer's `invoke` forever.

The dev-log note names what happened without flattering it (corrected in JOS-501): it reads
`data-server shim: N unserved reads answered with the empty shape — <reasons>`. It used to say
"answered by the app's own fold", which was true until that fold was deleted and then sent every
reader hunting for a second world that disagreed.

Readiness is four questions asked fresh per call (`engineClientHost.ts engineServeReadiness`): is
there a client, is its connection `ready`, is the engine attached to the log **this process folded**,
and has its fold on that log gone `live`. The last is taken off the `session.health` round trip the
parity probe is already making, and it dies with the turn — a respawn, a character switch and a
rebuild all clear it, so the shim falls back to the app's own fold until health says `live` again.

The fallback note is **coalesced**, because the failure mode is a burst: these channels are polled,
so a disconnected engine would otherwise print hundreds of lines a second and bury the narration a
developer opened the dev log to read. One sentence per five-second window, naming every reason with
its count, and the first fallback of a launch prints immediately.

### The asymmetries (measured 2026-08-25, JOS-489) — and there were none left when the arm died

The spec that held this table (`tests/e2e/engine-shim.e2e.mts`) compared BOTH arms of three channels
at a matched mark, and it left with the second world in JOS-499 — there is no app arm to compare a
served answer against. Its final state is worth recording: all three surfaces were **fully deep-equal
at every path**, and its `KNOWN_ASYMMETRY` table was empty **by fix rather than by omission**.

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

## Two readinesses, and which question each answers (JOS-498)

`engineServeReadiness()` asks FOUR things — is there a client, is the connection ready, are the two
processes on the SAME LOG, has that log's fold gone live — because every channel it guards reads a
FOLD. The last two are questions about a log, and a read that skipped them would draw one character's
rows under another's name.

`engineConnectedReadiness()` asks only the first two, and the weakness is the point rather than a
shortcut. `logs.list` NAMES NO LOG: it enumerates the directory the app pushed, it is answerable by a
world that has attached to nothing whatsoever, and the launch it matters most on is precisely the one
where nothing is attached — a fresh install has characters to choose between before there is anything
to fold. Asking the four-part question there would refuse every answer the op exists to give, on
grounds unrelated to it.

No new `FallbackReason` was invented for this: the set is the same and the second function simply
stops asking after two, because a reason nobody can act on differently is not worth a member. The two
shims keep SEPARATE tallies on purpose — "the engine could not answer a fold read" and "the engine
could not answer a folder question" are different sentences to a developer reading the dev log.

**And the character list has a real degrade arm, unlike every other served read.** Since JOS-499 an
unserved channel answers with an EMPTY SHAPE, because the app-side fold it used to fall back to is
deleted. `listCharacters()` was not: launch-time character choice has to work before any engine
exists, and on a cold launch it always does — `index.ts` calls `startTailing()` before
`startEngineSupervisor()`, and the supervisor is asynchronous end to end, so the FIRST character
choice of every launch is answered locally by construction. That is stated at the call site too, so
nobody reads the first fallback of a launch as a defect. Every later resolution (the picker's rows on
mount, a re-list after a settings change, the idle rescan that follows `/log on`) is served.

Three callers deliberately keep the local read and `serveLogs.ts` names each with its reason:
`character:set`'s path→ref lookup (the switch hot path, already guarded by `parseLogName`),
`switchNudge.ts`'s poll (a question about whether a sibling file is GROWING, not about a picker), and
the telemetry setup snapshot (a diagnostic inside `safely()` that must not be able to block on a
socket).

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

## The launch, as a window sees it (JOS-503)

The table at the top of this page — "the engine is absent / still folding / on another log" ⇒ "the
read gets an empty shape" — is the whole truth about a READ, and for a whole release it was also the
whole truth a USER got. Two of those rows are states somebody is sitting in front of:

| While | The shell draws | Because |
| --- | --- | --- |
| the engine folds history (launch, character switch, respawn re-fold) | a progress band: percent, bytes of total in human units, an event count, and an estimate when the samples can carry one | every panel is empty and "loading" with no sense of how long is the difference between waiting and wondering whether it is broken |
| the supervisor lands in a terminal state (no binary; or a crash-loop trail that COLLAPSED) | a card: plain words per failure class, the consequence stated without softening, and RETRY / REPORT / where-it-looked | post-cutover there is no TypeScript fold to degrade to, so this is a permanently empty window and the reason used to live only in `errors.log` |

**ONE OBJECT, ONE CHANNEL, ONE COMPONENT.** They are the same question at two moments — *can this app
answer me yet, and if not, why not* — so `engineLaunchState.ts` holds one `EngineLaunchSay` and
pushes it on `engine:launch`; `src/renderer/src/components/EngineLaunchBanner.tsx` draws whichever
state is current and renders nothing in the three phases that have nothing to say.

**WHY MAIN PUSHES THE PROGRESS HALF, WHICH THE RENDERER COULD READ ITSELF.** A renderer is a
first-class peer of the engine (the brokerage above) and `client.onProgress` exists. But the FAILURE
half has no socket to arrive on — the renderer's evidence would be an absence, and an absence cannot
be told from "not yet". Only the supervisor knows the difference. Splitting one question across two
transports would make the shell reconcile what main already knows.

**THE THREE EDGES, AND WHO OWNS EACH.** `supervisor.ts onFault` (a diagnosis that has stopped
changing, at most twice a session; `null` on READY — never on a launch merely ending, or a crash loop
would flicker the card); `engineClientHost.ts` for the fold's beginning (an ACCEPTED
`session.attach`, the earliest instant it is true), its measurements (`client.onProgress`) and its
landing (beside the go-live edge, `sawHealth`). The host clock is read exactly once, where a
progress frame arrives, and passed down — so the estimate's arithmetic (`src/shared/engineLaunch.ts`)
reads no clock and is integer maths in a unit test.

**LIVE PROGRESS FRAMES ARE DROPPED, BY THE FLAG AND BY THE PHASE (JOS-518).** The engine reports
progress from its TAIL as well as its scan, and the two shapes are identical — a caught-up tail sits
at `pct` 100 with the event count climbing, which is what a scan that has just finished looks like.
`FoldProgress.live` is the engine saying which loop it was in, and `noteFoldProgress` refuses a
flagged frame first and then still asks the phase. Both, because the phase test alone WAS the whole
defence and it failed: with the fold wait expired (below) nothing ever moved the phase off `folding`,
and the tail's own frames then held a bar at 100% with the count rising for the rest of the session —
the shape of two 1.11.0 reports. `foldFrameCounts` in `src/shared/engineLaunch.ts` is the decision.

**THE FOLD WAIT HAS NO DEADLINE, AND THAT IS AN OWNER RULING (JOS-518).** `foldWait.ts` polls
`session.health` after every accepted attach until the engine goes live, and that loop is what arms
the entire read path (`engineLiveOn` → `engineServeReadiness`). It used to give up at 120 seconds — a
number inherited from the deleted parity probe, where a bound on patience only cost a verdict — and
post-cutover that stranded the session permanently: no panel ever filled and nothing ever asked
again. The ruling, verbatim: *"it should only give up if the engine isn't doing anything or not
present due to AV - in all cases but the most pathological, if its already parsing, why are we having
a timeout?"* Every exit is a real event now: `live`, a superseded turn, or three refused polls in a
row. Timeouts exist per REQUEST instead (`shared/dataServer/deadline.ts`, 15 s, above the engine's
own 5 s `SNAPSHOT_PATIENCE`), which is what catches the wedged-alive pathology without ever giving up
on a fold that is running. A long fold narrates itself into the dev log about once every 30 seconds,
counted in polls — nothing in this path reads a wall clock.

**THE CANDIDATE PATHS ARE SHOWN AND NEVER SENT.** "Where it looked" is the actionable half of an
absence — it is how somebody finds the file their antivirus took — so it draws behind a disclosure on
the card. It is deliberately NOT in the report prefill: those strings carry the user's own home
directory, and the prefill carries the failure class alone (`engine-fault: <kind>`), which is all
triage needs to grep.

**THE SCHEMA GREW TWO FIELDS AND THEY ARE NOT CALLED `bytes`** (a third, `live`, arrived with
JOS-518 above). `FoldProgress` carries `offset` and
`logSize` beside `pct`, because a percentage cannot be turned back into "148.8 MB of 238.4 MB" and
the second sentence is the one that tells a person whether to wait. `bytes` is a name
`tests/protocolSchema.test.mts` REFUSES outright — the framing vocabulary is banned so the wire
method stays swappable (owner ruling 15) — and the schema already had its own word for this
coordinate in `HealthMark.offset`. One vocabulary, end to end.

## THE ENGINE THAT KEEPS DYING AFTER IT SERVED (JOS-519 — instrumentation only)

A 1.11.0 user reported that the log "keeps catching up even while in-game", and the engine
diagnostic his report carried at that same moment said no engine answered. One shape fits both
facts: the engine reaches READY, folds, dies minutes later, and is respawned — and a respawn is a
launch, so each one re-folds the whole log behind a fresh progress band.

**IT WAS INVISIBLE BY CONSTRUCTION.** `supervisor.ts` resets the exit trail on every READY edge,
which is right for a launch-time crash loop and means an engine that dies every ten minutes but
always comes back never collapses a trail, never raises a fault, and mints no error-store entry at
all. So the store's zero engine families could not be read either way.

**THREE THINGS, AND NOTHING ELSE CHANGED** — no card, no respawn or backoff behaviour. (1) A
SESSION-scoped counter of launches that had reached READY and then ended, incremented below the
`stopping` return in `endLaunch` so a deliberate stop and the quit path are structurally excluded.
Nothing resets it: reaching READY is what feeds it, not what forgives it. (2) At three, ONE entry
(`EngineServedCycling`, `engineProtocol.ts engineServedCycleStep` — a pure fold shaped exactly like
`engineExitStep`) naming the count and the last exit's own bounded, token-redacted detail. One per
session, not one per death. (3) A breadcrumb per death (`engine:cycled`, beside the `engine:gone`
`onPid` already writes), so a crash report's ring shows the cycling as a sequence.

**ADDING A BREADCRUMB KIND IS A DEPLOY ORDER.** `telemetryValidateError.ts` REFUSES a whole report
carrying a kind `TELEMETRY_BREADCRUMB_KINDS` does not hold, and the ingest lambda runs that same
shared file — so the server takes the new member before a client that emits it ships.

## WHICH ENGINE: RELEASE BY DEFAULT, DEBUG BY OPT-IN (JOS-520)

**The incident.** `cargo test` writes `engine/target/debug/engined.exe` as a side effect of running
the engine's own unit tests. The resolver probed `target/debug` BEFORE `target/release` on purpose
— "a developer with a fresh `cargo build` means to run THAT binary" — so the first time anybody ran
`cargo test` in the owner's checkout, his dev app silently switched engines on the next restart:
spell DB **4050 ms instead of 469 ms**, parse ~10× slower, catch-up in minutes on a log that folds
in seconds. The only tell in the product was one dev-log line. The old comment had predicted it.

**The ruling** (owner, verbatim): *it should not do that unless we are opting into performance
testing and then afterwards it should swap back. or it should be a separate build path so they
don't interact.*

**What it is now.** The dev tree contributes its **release** candidate only. `target/debug` is a
candidate only when a launch names it: `EQC_ENGINE_PROFILE=debug`, read once per resolution in
`engineHost.ts` and handed to `engineBinaryCandidates` as data (`EngineBinaryEnv.profile`), where an
opt-in puts debug FIRST. Nothing writes the choice down, so **"afterwards it should swap back" needs
no mechanism** — the next launch without the variable is on the release engine. A value that is
neither `debug` nor `release` is refused out loud and resolves release as usual.

**And a non-release engine is never quiet again.** `engineProfileNotice` (pure) composes one
`logWarn` line whenever the binary that won is not a release build — the profile, the opt-in that
selected it, the measured cost, and how to undo it. It is silent for the ordinary launch and for
every packaged one.

**This is not the gate rule below.** That rule is about a flag deciding *who does a job*; this
selects *which binary does the same job*, and absence still resolves an engine.

**Untouched:** the packaged candidates (`resources/engine/engined.exe` first — `tests/
enginePackaging.test.mts`), and the e2e override, which still outranks everything under `EQ_E2E=1`.

## A FLAG IS NOT "AN ENGINE EXISTS" (JOS-496 — read this before adding a gate)

The flags are gone (JOS-499) and this section stays, because the MISTAKE outlives them and the
next gate somebody adds can make it again with a different predicate.

`shimServing()` was `EQC_ENGINE` AND `EQC_ENGINE_SERVE`, both default-on. It was therefore
**true on every checkout that had never run `cargo build`**, where there is no binary, no client,
and no frame will ever arrive. It answered "did anybody ask for the engine to be gone", which is
a different question from "is there an engine" — and that gap is what shipped three silences:

| Where | What went silent | Fixed by |
| --- | --- | --- |
| `alertsAudio` armed from `startEngineSupervisor()` | **all alert audio**, until quit, on any build with no engine | arming on the supervisor's READY edge (and disarming on its loss edge) |
| `registerConCardIpc(shimServing())` skipped the TS hook | the con card, permanently | asking `engineServeReadiness().ok` per `/con` |
| the post-replay boot summary | one dev-log line | the gate withdrawn; the line names its subject instead |

**The rule:** a gate that decides *who does a job* must ask `engineServeReadiness()` (or a
launch-shaped edge like `onReady`) — a MEASUREMENT that a client exists, its connection is ready,
both sides are on the same log and the fold has gone live. Never a configuration value.

JOS-499 left exactly one compound gate standing and deleted the weaker half of it:
`registerConCardIpc()` now asks `engineServeReadiness().ok` alone. Everything else that used to
be flag-gated is either unconditional (there is one world) or gated on the frame itself — a con
card exists only because a real connected engine sent one, which is the fact the flag was a poor
proxy for.

## Tests

| | |
| --- | --- |
| `tests/dataServerSupervisor.test.mts` | Every lifecycle failure path, plus the READY handover. No app, no Rust. Its harness is `dataServerSupervisorHarness.mts`, shared with the row below. |
| `tests/dataServerSupervisorFault.test.mts` | The PERSON's edge (JOS-503): no fault while a fast failure could still be a hiccup, exactly one at the collapse, none after it, cleared by READY — and the retry, which forgives the trail, re-probes the disk on an absence, and leaves a live launch alone. |
| `tests/dataServerSupervisorCycling.test.mts` | The INSTRUMENT (JOS-519): three READY→exit cycles are exactly one entry naming the count and the last exit's own detail, two are none, a deliberate stop cannot be the third, a launch that never served is the other bug — and the exit trail next door still files three ordinary exemplars, which is why this counter had to exist. |
| `tests/engineLaunch.test.mts` | The banner's arithmetic and its prose: every case in which the ETA is REFUSED rather than guessed, the bounded ring, and the words for every failure class. |
| `tests/dataServerBroker.test.mts` | Both ends of the brokered wire: splits cross unchanged, four teardown paths, and a real conversation delivered one character at a time. |
| `tests/e2e/engine-loot-view.e2e.mts` | The row-parity oracle — the app-fed and served ledgers, compared as DOM. |
| `tests/dataServerMirrors.test.mts` | The pushed cache the fourteen synchronous readers use: cursor ordering, the echo test, and the one coalesced refusal sentence. |
| `tests/dataServerShim.test.mts` | The compat shim's decision and its whole fallback matrix, driven by fake clients — connected, disconnected, idle, answering, erroring — plus the coalescing rule and the one throw it must NOT swallow (the caller's own). |
| `tests/e2e/engine-alert-fires.e2e.mts` | One live line to exactly one sound, over the real fire stream. |
| `tests/dataServerEngineChild.test.mts` | The real child, pipe and socket against a Node fake engine. |
| `tests/e2e/engine-boots.e2e.mts` | The real binary under the real app: spawn, ready, respawn, wrong token, quit, absence. |
| `tests/enginePerf.test.mts` | The performance panel's engine row above the FFI boundary: the per-pid CPU arithmetic over a fake pid, the formatters' absent cases, and `useEnginePerf` run for real (arming, disarming, the null push). |
| `tests/e2e/engine-loot-view.e2e.mts` | ALSO hosts `enginePerfSteps.mts` — the ENGINE section of the in-app performance panel, whose verbatim text the run prints, budget verdicts included (JOS-502). It rides that spec because the only expensive thing it needs is an engine that has folded and served, which the ledger comparison has just spent a scan and a subscription reaching. **This row named `perf.e2e.mts` until JOS-502 and was wrong**: the module's own header named a third spec, `engine-parity.e2e.mts`, which went with the parity probe in JOS-499 — so for a whole release nothing imported it, no runner ran it, and it had rotted (it still demanded a parity verdict that stopped being possible the day there stopped being two folds). Dead test code documented in two places as live is worth one sentence here. |
| `tests/e2e/engine-absent.e2e.mts` | A checkout with no binary: the app boots, says what it looked for, invents nothing, does not crash — and, since JOS-503, SAYS SO ON SCREEN with a retry, a report path and where it looked. That fifth claim is the one this spec's header used to say it was deliberately not making. |
| `npm run budget:ci` | **The oracle's successor** (JOS-501): the engine measures its own fold rate and serve latency through `perf.snapshot`, against a committed ceiling, over a deterministic generated corpus. Gates every push. |
| `npm run budget:g3` | The same instrument on the owner's 209 MB fixture, at the release cut. Prints; never asserts. |
