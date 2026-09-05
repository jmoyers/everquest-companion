# `engined` — the engine process

JOS-459. A binary that can be spawned, handed a secret, talked to over loopback TCP, and killed
(phase 0, JOS-466); one that INGESTS (JOS-474): `session.attach` opens the named log, scans it at
full speed and follows it live; one that SERVES (JOS-478) — the twenty-module fold runs on the ingest
thread and `module.snapshot` answers a client with a module's published state; and, since
**JOS-480**, one that serves VIEWS: `view.subscribe` answers a descriptor with rows that are
filtered, sorted, windowed and render-ready, and follows them with coalesced diffs. It measures its
own serve path while it does it. Since **JOS-481** it also owns two things it used to leave to the
app: its own CLOCK — a live world ticks its modules ~1×/sec from this process's wall clock, while a
historical fold still never does — and the log's FILE FACTS, which it stats and serves rather than
letting the app reach in for. Since **JOS-485** the COMBAT ENGINE is folding here too: the damage
meter's whole snapshot (`combat.snapshot`), a ranked search of the session's fight history
(`combat.searchFights`), and the meter's rows as a live view source (`combat.live`) — the first
source whose rows change rather than merely arrive.

**The game logic is not in this crate.** `eqlog` owns what an event is (JOS-469, proven
byte-identical to the TS parser) and what a line is (JOS-472, proven scan-equivalent); the fold that
turns events into state lives in `fold` (JOS-471/475/476, all twenty modules proven against the TS
snapshots on six slices) and reaches this crate through **one trait** (`ingest::EventSink`, joined
in `src/foldsink.rs` — see "The fold seam"). This crate owns the process, the protocol, and the
question of *who is folding*.

## The spawn contract

Binding, and shared verbatim with the supervisor ticket (JOS-467):

1. The supervisor spawns `engined.exe` with **no secrets in argv or env**. The **first line on
   stdin** is the token, LF-terminated.
2. The engine binds `127.0.0.1:0` and prints **exactly one line** to stdout, flushed:
   `EQC-ENGINE PORT=<port> PROTOCOL=<protocolVersion>`. Nothing else ever goes to stdout;
   diagnostics go to stderr, tagged `[eqc-engine]`.
3. The engine **exits 0 promptly when stdin reaches EOF** — the dies-with-the-app law (owner ruling
   10). No orphan mode, no PID files, no heartbeat.
4. Every TCP connection opens with a valid `hello` (token + `protocolVersion`) or is closed. A
   failed handshake gets one `HelloReply { ok: false }` as a courtesy, then the socket closes.
5. A respawn is a launch: fresh token, fresh epoch, fresh world. Resume is always re-query.

Exit codes: `0` is the contract's own ending. `1` is a refusal to start — no token on stdin, a
first line that cannot be a token, or a loopback socket that would not bind. Everything else this
process can meet is a connection-level failure, and a connection-level failure closes a connection,
never the process.

## Ops

| Op | Answer | Behaviour |
| --- | --- | --- |
| `hello` | `HelloReply` | Token compared in constant time, then `protocolVersion`. A mismatch is fatal — version skew is a build error. |
| `echo` | `EchoResult` | Returns the text it was given. |
| `session.health` | `HealthResult` | The **ingest's** status — `idle` / `starting` / `attaching` / `folding` / `live` — plus the epoch, the process uptime, and, once a log is attached, **the mark** (`{log, offset}`), the folded event count, the log's own last timestamp and **the log file's mtime** (`logMtimeMs`, JOS-481). Those four are OPTIONAL and absent before the first attach: a zero would be a measurement nobody took. See "The file facts". |
| `module.snapshot` | `ModuleSnapshotResult` | **The first data-bearing op.** One module's published `{seq, state}`, straight off the fold on the ingest thread. `notFound` for a name the registry does not carry; `unavailable` when nothing is attached. See "The fold seam". |
| `perf.snapshot` | `PerfSnapshotResult` | **What the engine costs** (owner ruling 19, JOS-483). The five facts `session.health` gives, plus `ingest` (spell-db time, scan time, scan bytes) and `serve` — one row per view source, cumulative for the generation, off the `views::meter` counters. **Answered through the same one door** as `module.snapshot`, and the meter is PEEKED rather than drained. **Do not poll it idly** — see "The polling discipline". |
| `session.attach` | `AttachResult` | Bumps the epoch, broadcasts an `EpochMessage { reason: "attach" }` to every connection, replies `accepted: true`, and **starts an ingest** over `logPath`. Preempts any in-flight attach. |
| `session.progress` | `SubscribeAck` | Acknowledges the connection-wide progress channel. Its frames are `EpochMessage { reason: "progress", progress: { pct, events } }` — the schema says progress is not a fourth stream kind, it is this. Connection-wide, so an attach on *another* connection is heard here too. |
| `view.subscribe` | `SubscribeAck`, then a `reset`, then diffs | **The heart of the protocol** (JOS-480). The descriptor is validated against the SOURCE REGISTRY — an unknown source is `notFound`, a term over a field the source does not carry is `badParams` — then acknowledged, then opened with a reset. The opening reset is EMPTY even over a live fold, because the rows live on the ingest thread; the fold answers with the full window at its next boundary. See "Views". |
| `view.unsubscribe` | `SubscribeAck { subscribed: false }` | `notFound` for a subscription this connection does not hold. Subscriptions are keyed by (connection, id), so one client can never close another's stream. |
| `combat.snapshot` | `CombatSnapshotResult` | **THE METER, ASKED** (JOS-485). The whole of what `combat:snapshot` serves over IPC today, from the fold that is running, through the same one door. Not a `module.snapshot` — the combat engine is the post-registry subscriber, not a module. The reply carries the INSTANT it was taken at, because the engine chooses it: the process's wall clock once the tail is live, the fold's own `lastTs` before that. See "Which clock a combat answer is taken by". |
| `combat.searchFights` | `CombatSearchFightsResult` | **THE SEARCH BOX** (Task #61, moved server-side). Ranked over the fold's UNCAPPED encounter history plus the open fight; `corpus` says how much was looked through, so a UI can say `2 of 1,428` honestly. An empty query answers no hits and a real corpus. A `limit` is CLAMPED rather than refused, which is `src/main/ipc/world.ts`'s own rule. |
| `alerts.define` · `buffTrust.define` · `respawn.define` · `combo.define` · `roster.define` | `DefineAck` | **APP KNOWLEDGE IN** (JOS-482, boundary verdict 3). Each is an idempotent FULL-SET REPLACE of one family. The world records the push and hands it to the live fold, so `applied: true` means the RUNNING fold has the set — not that a queue took it. A push made before any attach is HELD and applied at the next attach's construction. `count` is the entries taken for a list payload and absent for the two families that push one object. See "Defines and fires". |
| `knowledge.item` · `knowledge.mob` · `knowledge.spell` | `KnowledgeResult` | **THE COMMITTED CORPORA, ENGINE-SIDE** (JOS-486, design surface 5). `items.json` (8.75 MB), `mobs.json` (3.2 MB), `quests.json` and `posky.json` are `include_str`'d into the `knowledge` crate and indexed **on first use**, so an attach pays for nothing a client has not asked for. **None of the three can fail**: a name no corpus holds is `found: false` beside a record carrying every LOCAL association the engine could still gather, because a missing wiki page does not unmake a posky quest use. There is no `unavailable` arm either — a corpus question names nothing that could be absent, so a mob card is a real card before the first attach. `knowledge.mob` is the one that touches the fold, and only for the own-loot half of its join. See "The knowledge surface". |
| `knowledge.search` | `KnowledgeSearchResult` | Name search across all four corpora. **The ENGINE ranks** (exact, then prefix, then contains; then by length, then alphabetically) because the renderer never munges domain data. A type-ahead, not a page: `limit` is capped, and `total` states how many matched. |
| `knowledge.define` | `DefineAck` | **THE ANSWER TO A MISS, PUSHED BACK** (boundary verdict 5). The engine has no network stack; the app owns the wiki fetch and the etiquette that goes with it. **Not a full-set replace**, and the schema argues it: the other five defines carry user preferences a store can restate whole, this one carries the WIKI. It keeps the half of the command law the law is for — idempotent and order-independent per key. `domain` is `item` or `mob` only, refused by SHAPE. |
| anything else | `ErrorReply { unknownOp }` | The connection survives — a refused request is not a broken conversation. |

And one message the engine sends that answers no request at all:

| Frame | When | Notes |
| --- | --- | --- |
| `FireMessage` | an alert matched a LIVE event | **ALERT FIRES OUT** (owner ruling 22). Connection-wide, so it carries no `id` — the epoch-message precedent. It carries no `epoch` either, and that is the difference from an epoch message rather than an oversight: every other stream frame describes WINDOW STATE a client reconciles across a generation, while a fire is a thing that happened once. Fully resolved server-side: `sound` is the `<packId>/<soundId>` key the app plays. |
| `KnowledgeMissMessage` | a lookup found no page for a name | **A REQUEST FOR WORK** (JOS-486, boundary verdict 5) — the one frame that asks the app for something rather than telling it something. No `id` (the fire's precedent) and no `epoch`, for the fire's reason plus one: a miss describes the PROCESS's corpus, which is committed data plus an overlay that survives an attach, so there is no generation it could belong to. **Each name is announced at most once per process** — a stacked loot burst probes one name many times, and asking the app to fetch each of those would be the engine breaking the etiquette law on the app's behalf. The answer comes back as `knowledge.define`. |

A known op with unreadable params is `badParams`. A frame that is not a message at all, or one with
no `id` to correlate a refusal with, **closes the connection** — the schema's own rule is that a
failure with no request behind it has nowhere to put an error.

On the attaching connection the epoch announcement arrives **before** the reply, because the bump
and its broadcast happen in one critical section. That ordering is pinned by test: a client can
never see a reply naming a generation it has not been told about.

### The polling discipline (`perf.snapshot`)

**A perf surface must not become a perf cost.** `perf.snapshot` is cheap but it is not free: it posts
an ask through the one door and waits for the ingest thread to answer at a boundary it already
reaches (one nap of the tail while live, one megabyte of the scan mid-fold), and the app pairs it
with a native per-pid read of the engine's CPU and working set. That is nothing at a two-second
cadence for the seconds a panel is open, and it is a permanent wasted tax if it runs for the hours
an app is up.

So **the app polls it only while the performance panel is open**, and the arming signal comes from
the renderer:

* `PerfChip`'s popover mounts `useEnginePerf(open)` (`src/renderer/src/lib/enginePerfHud.ts`), which
  sends `perf:engineWatch true` on mount and `false` on unmount.
* `src/main/enginePerfWatch.ts` creates **no timer at all** until it is armed, emits one sample
  immediately so the section is populated rather than blank, and pushes a single `null` when it
  stops — the same "hide entirely, never freeze on stale numbers" contract the HUD's own sampler has.
* A build with **no engine** (the flag is off, or no binary was found) arms nothing: the first emit
  answers `null` and returns without a timer.
* Two polls never overlap. A request during a historical fold can outlast its own interval, and
  stacking those would put several asks on one connection for a panel that can only draw the last.

A session that never opens the popover therefore pays **zero timers, zero round trips and zero
bytes of native code mapped**. If you add another reader of this op, keep the same rule.

Two properties of the answer are worth knowing before you read one:

* **The meter is peeked, never drained.** `Meter::peek` takes `&self`. Two panels open at once see
  the same session, and a poll cannot steal the interval the engine's own stderr report was about to
  print.
* **Absent is never zero.** `scanMs`/`scanBytes` are missing until the scan finishes; a source whose
  every frame was an owed reset (no fold instant behind it) reports **no** `foldToFrameUs*` at all
  rather than `0`. Queue time is never counted as compute.

## What an attach does

One thread per attach (`src/ingest.rs`), and five states a client can watch:

| status | what is happening |
| --- | --- |
| `idle` | Nothing is folding: a fresh process, or one whose ingest ended. |
| `starting` | An attach was accepted. Set inside the epoch's critical section, before the ingest exists. |
| `attaching` | Opening the log and building what a fold depends on — the spell DB, the character name (off the FILE NAME: `eqlog_<Name>_<server>.txt`, or the oracle corpus's `…_<server>.<slice>.txt`), and the twenty-module registry. |
| `folding` | The historical scan, at full speed. No yield, no throttle: that is the whole point of the process boundary. |
| `live` | The scan's end offset was handed to the tail (`TailStart::At`) — the lossless seam — and the tail owns the file. |

**The generation law.** An attach PREEMPTS any in-flight attach: last pick wins, never queued.
This is `src/main/switchController.ts`'s `owns()` moved engine-side. The in-flight scan polls the
generation at its read boundaries and abandons **silently** when superseded, and every statement an
ingest makes goes through a `report_*` method that re-asks ownership *inside* the world's lock — so
a turn that has lost can write nothing, ever, however long it takes to notice. No event can
interleave structurally: each attach builds its own sink and its own parser.

**Progress** is bounded to ~4/s and never per line, `pct` is a float measured in bytes
(`mark / bytes × 100`), and the final frame of a scan is forced — a loading bar must not lose the
one frame that states the whole fold to a fold that finished inside one cadence interval. Frames
continue while live whenever the count advances; that is the only wire evidence a live line landed
until views arrive in phase 3.

**The mark.** The engine owns `checkpoint_offset` (boundary verdict 4): the end of the last
*complete* line folded, which is the same definition as `ScanResult.endOffset`. A half-written line
is not an event and the mark waits with it.

**And once it is `live`, the world has its own clock** — see "The live tick" below. The historical
scan does not, and cannot: the tick loop lives past the `TailStart::At` handoff and there is no path
to it from the scan.

## The live tick

`src/ingest.rs`'s `Ticking`, `EventSink::tick`, `fold::Fold::tick`. Owner ruling 22 (2026-08-25):
*"it seems more and more like most of that business logic should live in the rust server and that
the client should be relatively thin."* The engine ticks its own modules while LIVE, with its own
clock.

**What it is.** `session.ts startHeartbeat` moved into the process that owns the fold: one
`registry.tick(now)` at go-live, then ~1×/sec while the tail runs. The interval is the app's own
(1 s); the tail polls every 400 ms, so a beat lands on roughly every third turn of the loop. The
cadence is a CEILING, not a schedule — a turn that ran late beats once, not twice, because "age the
model to now" is idempotent in `now`, and three missed beats are one beat with a later number.

**The go-live beat is ordered before `report_fold_landed`, and that ordering is the point.** That
call is what publishes `status: "live"`, the landing reset and the mark, and `live` is the edge every
client waits on — the app's parity probe polls `session.health` for exactly it. A beat taken
afterwards would leave a window, however short, in which the engine served a world the app had
already swept. It is also precisely the order over there: one tick, *then* the interval, and both
before `flushNow()` and `sendWorldRebuilt` publish anything (JOS-149).

**A HISTORICAL FOLD NEVER TICKS, and that is the equivalence law.** `fold::Fold::fold_bytes` does
not call `tick`, the six-slice oracle records its goldens through `fold_bytes` and nothing else, so
the fold of a given log is still a pure function of its bytes — which is ruling 18 law 1, and also
what makes a future parse-once cache sound. `npm run oracle:rust-fold` staying green at its default
IS the proof; if it reddens, the law was broken.

**Which modules have a heartbeat, and which deliberately do not.** Every `on_tick` was read against
its TypeScript twin:

| Module | On a beat |
| --- | --- |
| `buffs` | The big one. Drops a cast nothing confirmed inside the landing window, then runs the hygiene sweep — which is what retires an active past its per-spell cap. This is the JOS-479 divergence: the engine served 12 actives for a fixture whose buffs were long expired by wall time while the app served 3, the two folds agreeing exactly on everything the log had said. |
| `buffTimers` | Sweeps its holds. A mez runs out while the log is idle, which is exactly when somebody is watching it. |
| `spellSets` | The wall-clock half of the settle rule: a player who loads a set and stops playing leaves a burst open forever otherwise. |
| `respawn` | Records the ordering clock `snapshot()` reads. Publishes nothing and moves no revision — the set of rows changes only when a death, a watch edit, a zone line or a sighting changes it. |
| `resist` | Settles: a deferred landing past its cancel window is filed, a song pulse that can gain no more witnesses is closed. It does NOT *finish* — a bard mid-rotation keeps the run the next gap is entitled to. The TS also persists its ledger every sixtieth beat; that is disk IO the engine does not own yet (boundary verdict 4). |
| `alerts` | **Nothing, by argument.** The early-warning queue a beat would sweep is empty by construction: `arm` is reachable only from the matcher, the matcher runs only over `compiled`, and `compiled` comes from a def list the engine has no way to receive. The `alerts.define` command turns both halves on together. |
| `consider` | **Nothing, by argument.** `onTick` over there does one thing — call `probe` for the newest rows the replay left in the ring — and `probe` is the wiki lookup this crate cannot have while the FETCH stays app-side (boundary verdict 5). |
| the combat engine | **Nothing, because there is nothing to port.** The heartbeat over there is `registry.tick` and nothing else: `CombatEngine` declares no `onTick`, and `pipeline.ts` subscribes it to the bus and to no clock. An engine ticked here would be doing something its oracle never did. |

**A beat's derived events are QUEUED, not delivered.** No module's `on_tick` emits one today — the
buffs sweep retires and culls rows, and neither path synthesizes a `buffExpired` (only a resolved
wear-off and the illusion clear do, both event-driven) — but `Registry::tick` collects them through
the same `take_derived` door `dispatch` uses, because a contract with a door and one caller that
silently drops what comes through it is a defect waiting for its first user. Queued is what the TS
does: `bus.emitDerived` pushes onto a queue only `emit` drains, so anything a heartbeat synthesized
reaches the other modules with the next primary event.

## The file facts

Owner ruling 21 (2026-08-25): *"the server should be the one reading the log file, rather than the
app reaching in… reported so the app can use it to display and choose the correct character on
launch."* `session.health` carries `logMtimeMs` — the log file's last-modified time, in epoch
millis, truncated so it equals `Math.floor(statSync(log).mtimeMs)`.

Three properties of it are deliberate, and each answers a ruling:

* **Re-stated per answer, never remembered** (ruling 5). A remembered mtime is a cache of something
  the filesystem already holds, and it would be wrong the moment the game appended a line.
* **Never in fold state** (ruling 18 law 3). It is a fact about a FILE, not about the events in it,
  and state here is addressed by (log identity, byte offset) and by nothing else. A module that
  folded an mtime would be a module whose output depended on when it ran — which is why the app's
  own `character.lastPlayed` divergence is *not* closed by this: the engine SERVES the fact and
  still does not FOLD it (`tests/e2e/engine-parity.e2e.mts` carries the dated exemption).
* **Statted with the world's lock released.** A filesystem call is unbounded — a stalled network
  drive, a file mid-rotation — and that lock is on the path of every `report_*` the ingest makes.
  `World::health` copies the state out, then stats against the copy.

Every failure is `None`: a missing file, a permission refusal, a filesystem with no modification
time, a stamp before the epoch. `0` would claim 1970, which a client would draw as a real date beside
a real character name.

**DIRECTION — `logs.list` comes later, and it is where this is going.** Ruling 21's second half is
that log DISCOVERY itself migrates server-side: launch-time character choice becomes a served answer
rather than the app globbing an EverQuest `Logs` directory and statting what it finds. The shape that
implies is a query op — `logs.list` — answering a row per log the engine found under a directory the
app named, each carrying the identity the file name states (`{name, server, logPath}`, the same
derivation `character_of`/`server_of` already make for an attach) beside the file facts a picker
draws: mtime, and size. Nothing of it is built here and nothing should be built speculatively; what
this ticket establishes is that the FACT is the server's to state, so the surface that lists them has
somewhere honest to come from. Note the one thing that op would add which nothing here has: a
directory read the app did not name a single file in — the engine has never discovered a path of its
own (`SessionAttachParams`'s doc is emphatic about it), so `logs.list` is the ticket that has to
decide whether the app hands over a directory or the engine learns where EverQuest lives.

**Both integrator notes phase 2 left here are closed** (JOS-478). The mark, the folded event count
and the log's last timestamp are on the wire now, optional, in `HealthResult` — the schema gap is
gone. And the spell DB is built **once per process**: `eqlog::Parser` holds an `Arc<SpellDb>` and
`eqlog::spelldb::shared()` is the one copy, so the 386 ms rebuild that used to happen on every attach
happens once — and the fold's own resist catalog, which was quietly doing a *second* full load behind
its lazy table, reads that same handle. The ingest still prints its measurement, so a slow attach
still says why.

## The fold seam

Ingest terminates in one trait, and `src/foldsink.rs` is the whole of what joins it to `fold` — the
ingest loops, the generation law, the progress cadence and the mark did not move to let it in.

```rust
pub struct Event<'a> { pub json: &'a str, pub seq: i64, pub live: bool }

pub trait EventSink {
    fn event(&mut self, event: &Event<'_>);
    fn report(&self) -> SinkReport { SinkReport::default() }              // defaulted
    fn snapshot(&self, _module: &str) -> Option<ModuleSnapshot> { None }  // defaulted
}

pub struct SinkInputs<'a> {
    pub log: &'a Path,
    pub character: Option<&'a str>,
    pub db: Option<&'a spelldb::SpellDb>,   // the PARSER's own catalog, never a second load
    pub clock: &'a Clock,                   // the PARSER's own clock, so the launch anchor agrees
    pub attached_at_ms: i64,                // the construction clock: WHEN this world was built
}
```

**The trait is not `Send`, and the factory takes the parse's inputs.** Those are one edit, and it is
the edit that made the fold constructible at all. A sink used to be built on the *connection* thread
and moved into the ingest thread; it is built on the ingest thread now, after the parser and the
catalog exist — so `fold::ClusterDeps` can see the spell DB's key set and its class index, which is
the knot phase 2 wrote down here and could not untie. Two things fall out of it: tens of
milliseconds of index projection no longer sit in front of the `accepted` reply, and the sink never
crosses a thread boundary, so `Send` would now FORBID the fold (`fold::Fold` holds the
buffs/buffTimers shared core in an `Rc<RefCell<…>>` — exactly right for state that lives on one
thread, and exactly what `Send` refuses). The single-threadedness is stated by the type rather than
promised by a comment.

`src/foldsink.rs`'s header argues every `ClusterDeps` field. Five are committed data read off the
catalog; the rest are **app knowledge, and empty AT CONSTRUCTION** — and since JOS-482 that is a
timing rather than a gap: the `*.define` commands land immediately after this factory returns, from
the world's held set, before the first byte is folded (see "Defines and fires"). So a world the app
has spoken to differs from the bench world by exactly those five pushes and by nothing else, which
is what keeps the six-slice oracle looking at the world it recorded its goldens under. `self_name`
is the one that has NOT moved: `roster.setSelfName` is `session.ts`'s line and is not one of the
five families the cutover ledger names, so it stays `None` here exactly as the bench leaves it. The
`character` ref is not app knowledge at all — `{name, server, logPath}` comes off the log's own file
name, the same fact the parser derives its character from.

**The construction clock is the attach instant, and that is production-faithful.** `respawn` seeds
an ordering clock from `WorldOpts.constructionNowMs`; the golden recorder pins it to the slice's last
timestamped line so a golden re-checks tomorrow, but production TypeScript has always used
`Date.now()` at construction. A live world is built when the attach happens, so that is the instant —
and it is the only wall clock any of this reaches (ruling 18 law 1).

**Answering `module.snapshot` is a channel, not a lock.** The fold lives on the ingest thread; a
request arrives on a connection thread. A `Mutex<Fold>` would make the fold's hot loop take a lock
per event for a reader that asks twice a minute, and would put a second owner on state whose whole
design is one door. A snapshot copy published after every event is a cache, which ruling 5 forbids.
So the reader posts an ask and waits, and the ingest answers it at a boundary it *already reaches* —
between two reads of the scan, or between two naps of the tail. The fold is never shared, never
locked and never interrupted mid-event, which is what makes a mid-scan answer a **real prefix
state**: every event up to `seq` and no part of another. `World::module_snapshot` owns the
five-second deadline that turns a wedged ingest into an `unavailable` reply rather than a connection
that never answers, and it holds no lock across the wait. `ingest.rs`'s `SnapshotAsk` header carries
the full argument, including the two shapes that were rejected.

**The combat engine IS subscribed now (JOS-485), and it took exactly what JOS-478 said it would** —
one builder call (`Fold::with_combat`) plus a source, and nothing else in `foldsink.rs` moved. It is
still not a module: `WIRING_ORDER` does not name it, `Registry::snapshot_of` cannot answer for it,
and `module.snapshot` refuses the name `combat` on purpose. It reaches clients through three
surfaces of its own instead — the ops `combat.snapshot` and `combat.searchFights`, and the view
source `combat.live`. The coupling is one-way and checked (`Fold::observe` hands the engine the
registry's roster and no module reads the engine), so every other answer this process gives is
unchanged by its presence; what it costs is that every event now also folds through it, which is the
same work `parity` measures and the same work the app has always done on its own thread.

## Views

`src/views/` is the second data-bearing surface and the one every list in the product eventually
becomes. A subscription names a SOURCE, a filter, a sort and a window; the engine answers with rows
that are filtered, sorted, windowed and **render-ready** (owner ruling 4), and then with coalesced
diffs as the fold moves.

| Source | Reads | Default order | Cells |
| --- | --- | --- | --- |
| `loot.ledger` | the `loot` module's rows | `at` desc, then `seq` desc — newest first, which is what the flat ledger draws | `at`, `item`, `count`, `from`, `zone`, `disposition`, `created` |
| `timers.rows` | `buffs.active` + `buffTimers.holds`/`.ends`, through `fold::modules::buff_timer_rows` | `order` asc — the projection's own: self rows, then one block per target | `name`, `rank`, `kind`, `surface`, `group`, `mode`, `ambiguous`, `calmsTarget`, `inferredTarget`, `startedTs`, `durationMs`, `endsAt`, `target`, `targetKey`, `count`, `caster`, `order`, `flat` |
| `buffs.active` | the `buffs` module's live instances | `startedTs` asc — the order the module publishes and the tab lists | `spell`, `castName`, `cls`, `self`, `disposition`, `target`, `inferredTarget`, `startedTs`, `estimatedMs`, `p25`, `p75`, `n`, `durationSource`, `permanent`, `permanentSource`, `messageDriven`, `ambiguous`, `count`, `caster`, `calmsTarget` |
| `respawn.watches` | the `respawn` module's rows | `order` asc — the module's own, which is a function of `now` | `display`, `key`, `zone`, `baseTs`, `basis`, `source`, `overridden`, `samples`, `kills`, `seenTs`, `seenVia`, `estimateMs`, `observedMs`, `customMs`, `wikiText`, `wikiMs`, `wikiPage`, `order` |
| `kills.recent` | the `progression` module's recent-kill ring | `at` desc, then `seq` desc | `at`, `name`, `zone`, `pet`, `expLine`, `expStated`, `expParty`, `expPct` |
| `progression.recent` | the `progression` module's level and AA columns | `at` desc, then `seq` desc | `at`, `kind`, `value`, `label` |
| `eventFeed.recent` | the `eventFeed` module's ring | `at` desc, then `seq` desc | `at`, `kind`, `title`, `detail`, `page`, `rewardItem`, `rewardPage`, `rewardStats`, `conFaction`, `conDifficulty`, `conLevel`, `conRare` |
| `combat.live` | the combat engine's selected segment | `total` desc — the meter's own ranking, which is what every surface draws | `rank`, `name`, `kind`, `tag`, `pct`, `total`, `dps`, `crit`, `hit`, `resist`, `ambiguous` |

**THEY ARE TWO DIFFERENT KINDS OF SOURCE, and that is why `combat.live` mattered.** `loot.ledger`,
`kills.recent`, `progression.recent` and `eventFeed.recent` APPEND — a row, once written, never
changes — so a live window over one produces inserts and drops and never an `update`.
`combat.live`, `timers.rows`, `buffs.active` and `respawn.watches` EDIT: the same handful of keys sit
in the window while their numbers move. That is the shape the diff protocol's third op exists for,
and until JOS-485 it had exhaustive unit tests and no integration coverage at all. `tests/combat.rs`
is where it gets some.

**`kills.recent` reads the PROGRESSION module and the name says the SURFACE.** Every other source
here is named for the module it reads, and this one is the exception with a reason: the `kills`
module is a lifetime tally keyed by mob that the boss and mob pages look things up in, and it has no
recent list at all — the recent-kills FEED is a fifty-entry ring `progression` keeps, because a kill
and the experience line that follows it are one fact joined at fold time and only that module sees
both. A client asking for recent kills gets recent kills.

**`eventFeed.recent` was unregistered for two reasons and TWO TICKETS TOOK THEM AWAY SEPARATELY.**
The reason was: the ring admits nothing that did not arrive live through an injected item probe, an
injected consider table, or an out-of-band alert or quest push, so it could only ever be empty — and
therefore "no test could tell a working one from a broken one". JOS-487 answered the second clause by
pointing the test somewhere else: the projection is a pure function of a ring, `views/event_feed.rs`
pins every cell against a hand-built one, and a broken cell fails a test whether or not any fold can
produce the entry it mangled. JOS-486 took the FIRST clause away in the same wave — the loot source's
item probe is a real in-process lookup now, so a live loot line puts a row in that ring. A renderer
subscribing during the cutover is told **nothing here yet** rather than **no such surface**, which
were always different things to be told.

**Two orders that no column sort can express are published as integer FIELDS.** `timers.rows` carries
`order` (self rows, then per-target blocks, blocks ordered by their soonest row) and `flat`
(`compareRows` over everything: countdowns ahead of count-ups ahead of permanents, then by end
instant); `respawn.watches` carries `order` (seen-recently first, then unstale, then by remaining —
a subtraction against `now`). Each is the row's index in that order, computed once per serve pass by
the projection that owns the rule, so the client names the order it wants and never re-sorts. That is
ruling 4 kept rather than bent: the decision stayed engine-side and what crossed the wire is its
answer. Both are unique, so either makes the sort total on its own.

**`respawn.watches` is ordered against the MODULE's clock, never a fresh read.** The respawn module
is advanced by the log while folding and by the live tick once a tail owns the file; reading a second
clock in the serve path would order the rows against an instant the model has never seen, and would
put a wall-clock read where ruling 18 law 1 forbids one.

**A query FIELD is not a CELL, and the whole layer turns on that.** A sort term names `at`; a cell is
also called `at`; they are different values. The cell is `"Aug 19, 04:14 PM"` because that is what the
ledger draws — sorting a column of those strings would put August before April, which is exactly the
failure ruling 4 exists to prevent, one level below the renderer. So every source declares the
comparable FIELDS a descriptor may name beside the CELLS it renders, and a field with no cell (`seq`,
the row's position in the ledger) is not an oversight. **Every sort ends in the source's tiebreak**,
because EQ stamps to the second and a corpse yielding three items writes three rows at one instant:
an order that is not total is a window that shuffles, and a shuffled window is diff churn for a list
nobody touched.

**Two judgment calls in `loot.ledger`'s cells, both argued in `src/views/loot.rs`'s header.** The
stack size is its own number beside the item name rather than composed into `"2 × Bone Chips"` — the
composed string is what the pixel says, but it is lossy for every other reader of the row, and a
client splitting it back apart would be doing the munging the ruling forbids. And an absent value is
`null` rather than the `-` the renderer draws: a cell of `"-"` cannot be told from an item genuinely
called `-`, and it would take the diff protocol's explicit-null clear away from this source entirely.
The timestamp is a **fixed en-US pattern**, not a locale call — a host locale in the serve path makes
the engine's answer a property of the machine, and determinism is cacheability (ruling 18 law 1). The
ZONE is honoured: the instant resolves through the parser's own clock, so the string says the wall
clock the player's machine would show.

**The diffs are computed where the fold lives.** A serve pass takes a short lock to learn which
sources are subscribed, builds them OUTSIDE the lock on the ingest thread, and cuts, diffs and pushes
under it — so the reset stamp and the epoch stay one critical section (a reset can only ever name the
generation it was cut in) while a connection asking `session.health` is never queued behind a loot
ledger. Ownership is re-asked inside the lock like every other `report_*`, so a preempted turn that
built a window publishes nothing. A subscription is re-cut only when its source's REVISION moved — a
counter the `loot` module bumps on every push and every clear, read through the same kind of pull seam
`as_roster` is — so an idle session costs one comparison per cadence tick and nothing else. The rate
is a ceiling (~10 Hz, `views::SERVE_EVERY`), not a heartbeat: nothing is sent when nothing moved.

**WHERE RULING 4 STOPS: numbers, not sentences.** `loot.ledger` renders its instant as
`"Aug 19, 04:21 PM"` because that is what the pixel says, and six sources later that is still the
rule — with two named exceptions, both of which are the APP's own decision rather than a relaxation
of the owner's. A value read against NOW is served as the INSTANT: a timer bar's remaining time
changes every frame, so serving it as text would mean a diff per visible row per serve beat and it
would still be stale between two frames. What crosses is `startedTs`, `durationMs` and `mode` — the
three numbers `timerReading` is a pure function of, which is what the overlay already ticks against
at 1 Hz — plus `endsAt`, the one derived instant that is a fact about the ROW rather than about now.
And a value whose wording is a SHARED derivation is served as its numbers: the buff row's
`~4m 30s`, the resist chip's `R 126 (110-144)`, the respawn row's provenance line are each built by
one function the tab, the overlay and the hover card all read, so a wire carrying finished strings
would be a second copy of a vocabulary that must not drift — which is the call `shared/conCard.ts`
already made for a payload that fetches nothing ("IT CARRIES NUMBERS, NOT SENTENCES"). Everything
else is rendered here: a date, a name, a count, a decomposed bitfield (`kills.recent`'s three
experience flags, so no renderer runs `flag & 2`), a routing answer (`timers.rows`' `surface`), a
comparison already made (`respawn.watches`' `overridden`). **AND A CELL IS A SCALAR** — a list or an
object is not one, so a row's candidate spells become its joined `name` plus an `ambiguous` flag and
a feed entry's `reward` block becomes prefixed cells. Nothing is stringified into a cell for a client
to parse back out; that would be the munging the ruling forbids, wearing a scalar's clothes.

**Three of the seven change signals are COARSE, and the coarseness is stated at the module.** `loot`,
`respawn` and `buffTimers` keep real revision counters that move only when their state could have;
`buffs`, `progression` and `eventFeed` do not, so they report the fold's own `seq`, which moves on
every event. That never misses a change — the property correctness needs — and it over-reports, which
costs one re-cut per serve beat on a busy tail over row sets of tens. The honest fix is the counters,
not a cache (ruling 5). `timers.rows` takes the MAX of its two inputs, because either moving could
move the window.

**`src/views/diff.rs` is the engine half of `src/shared/dataServer/viewWindow.ts`, and that file is
its specification.** The client refuses rather than guesses — an anchor it does not hold, a key it
does not hold, a key it already holds — so every op this engine emits must be one the client can
apply as sent. Drops go first, so every anchor a later insert names is a row the client still holds;
anchors are computed against a working copy that advances with the batch, because "the row before it"
means after the earlier ops applied; an update carries changed cells only, with an explicit null for a
cell that went away. The client's applier is ported beside it as the test oracle, and the one
assertion every case makes is that it refuses nothing.

**The engine measures its own serve path** (owner ruling 19, foundations). `src/views/meter.rs` counts
fold-to-frame latency per source — from the instant the ingest folded the event to the instant the
frame reached the outbox — and diff sizes per subscription, in ops and in the frame's own serialized
bytes. A stderr line at a 10 s cadence, forced once when the fold lands.

**And since JOS-502 it serves them, judged** — surface 8 complete. `src/budgets.rs` holds the two
ceilings `tests/budget.rs` asserts in CI and renders a verdict against the generation that is actually
running, so the in-app panel and a bug report state what THIS machine did rather than what a runner
did. The rows are render-ready (ruling 4 applied to a diagnostic): the comparison is arithmetic, the
two budgets are in different units, and the caveat that keeps each number from being misread is prose —
all three on this side of the wire, which also means a third budget ships without a renderer change.
**The unmet G3 goal is stated in the fold-rate row itself**, because a pass sits on a floor an eighth
below the measured rate and a row that let that read as the goal reached would be lying by omission.

**`views::Timeline` is the history behind the totals.** A fixed-capacity ring — `TIMELINE_CAPACITY`
moments at `TIMELINE_CADENCE`, five minutes — sampled off the serve beat, where every figure is an
INTERVAL rather than a running total: `perf.snapshot` already answers the cumulative question, and a
list of ever-growing totals makes a reader subtract against a baseline he cannot see. Three properties
are load-bearing and each has its own unit test: **the bound** (an engine up for a week costs what one
up for a minute costs, and the oldest moment is DROPPED rather than summarised into a subtler
accumulator); **a quiet window is recorded as quiet** (a ring that dropped its silent samples would
compress a lull into no space and make the busy moments either side look adjacent); and **it reads a
clock it is given** (process uptime, passed in — no wall clock near a performance answer, no timestamp
that says when a person played, and every ring test is arithmetic with nothing sleeping in it).

Frames and bytes are cumulative counters the ring subtracts against its own last reading, so the serve
path pays nothing for them. A MAXIMUM is not invertible — a cumulative worst of 56 ms says nothing
about which window set it — so the windowed extreme is the one field accumulated beside the counters
and drained by `Meter::take_window`. The three drains in `views/meter.rs` are independent by design: a
timeline sample can never steal the interval a stderr line was about to print.

## Which clock a combat answer is taken by

Owner ruling 22's direction, applied to the surface that is hardest to move: `src/main/ipc/world.ts`
calls `combat.snapshot(Date.now(), opts)` and `goldenOracle.mts` calls it with the slice's LAST EVENT
TS, and both are right about different worlds. **A REPLAY IS NOT A MOMENT IN TIME.** Encounters close
purely from elapsed time, `inCombat` is a freshness test, and a summary's `active` flag is the same
question per row — so a snapshot of a months-old log stamped with the host clock finalizes whatever
fight was open and hands the rest of it to a fresh encounter. That was MEASURED app-side, on the
restart-compare the moment the engine joined the container: one 53,577-damage fight in
`e2e-combat.log` split into 43,504 + 10,073 under load.

So `combat.snapshot` takes no instant at all and the reply states the one it used:

* **while the tail is LIVE** — the process's own wall clock, read fresh per answer, which is exactly
  what `Date.now()` does at that IPC handler;
* **at every moment before that** — `fold.last_ts()`, the highest timestamp any event carried, which
  is the number the golden recorder passes.

**The discriminator is structural rather than a copy of the world's status.** `EventSink::tick` is
called only while live — the historical scan does not call it, cannot reach it, and must not — so
"has this sink ever been ticked" IS "is this world live", stated by the one call that could set it
(`foldsink.rs`'s `live` field). Two consequences fall out. The historical path is untouched, so a
mid-fold answer is a pure function of the bytes folded so far and re-asking it at the same `seq`
gives the same answer — ruling 18 law 1, for this surface. And the wall clock enters exactly where it
already entered: a live world, which the six-slice oracle has never described and cannot.

**`hydrating` CLEARS AT THE GO-LIVE BEAT, AND THE FOUR SWEEPS ARE WHAT EARNED IT** (JOS-488).
JOS-485 answered `true` here in every state, deliberately: the snapshot-time sweep block was unported,
and clearing the flag without it would have promised a liveness the fold did not have. Both halves
landed together. `EventSink::tick` calls `CombatEngine::set_live()` on its FIRST beat and only there
— the same place `session.ts` puts `combat.setLive()`, before `startHeartbeat`'s single
`registry.tick(Date.now())` — and from then on every combat answer runs the charm sweep, the ally-bind
expiry, the pet nudge and the deferred encounter closure at the instant it was taken at. **So a live
meter closes a fight the log stopped talking about**, on the log's own numbers and stamped at the
fight's own clock, exactly as the app's does.

**ONE FLAG DECIDES BOTH QUESTIONS, and that is the point**: a world entitled to a wall clock is
exactly a world entitled to age itself against one. The historical path reaches neither — the scan
cannot call `tick`, so it cannot leave hydration, so it cannot enter the sweep block — which is what
keeps a mid-fold answer a pure function of its bytes and keeps the six-slice oracle green without a
line of special-casing. Two smaller consequences are stated rather than inherited: a live combat
answer MUTATES the fold (see `answer_asks`, and `CombatEngine`'s `st` field for why the mutation
stays inside the engine), and the CLASSIFICATION RING is still unported — so `recent` is `[]` in a
live answer where the app publishes classified lines. That is now this engine's named combat gap, and
it is a much smaller one: nothing on the meter's rows reads it.

## Defines and fires

The two directions JOS-482 opens, and they are the same boundary read twice. **App knowledge flows
in**: the five preferences the fold used to read out of the settings store — alert definitions, the
buff-trust allowlist, the respawn watch list, class-combo corrections and group-roster edits — are
pushed as `*.define` commands, and the engine never reads a settings file (boundary verdict 3; the
store stays persistence truth app-side). **Alert fires flow out**: the engine evaluates those
definitions against LIVE events and says so on the stream (owner ruling 22), which reduces the
app-side alert system to receive-fire-make-sound.

**A DEFINE IS AN IDEMPOTENT FULL-SET REPLACE.** The payload is the whole of what that family knows,
never a delta, and the world keeps ONE entry per family — so pushing A and then B leaves exactly
what pushing B alone would have left, an order of arrival cannot matter, a crash-respawn is a replay
of the latest push, and the input stays hash-friendly for ruling 18's eventual cache key.

**THE HELD SET IS APPLIED AT CONSTRUCTION, and that timing is the whole of why it is held.** The app
pushes all five the moment it connects and attaches afterwards, so the common case is a define made
at a world with no fold at all. `World::define` records it under the lock; `ingest::run` reads
`World::held_defines()` and applies every one to the freshly built sink BEFORE the first byte is
folded. All five change what a fold PRODUCES, so a world that took them after the historical scan
would have folded the log under one set of rules and served it under another — and `respawn`'s watch
list is the sharpest case, because it is the ONLY admission rule that puts a mob on a clock.

**A DEFINE ARRIVING MID-FOLD IS ANSWERED MID-FOLD**, through a channel serviced at the boundaries
the ingest already reaches (`ingest::DefineAsk`, the shape `SnapshotAsk` is with one direction
reversed). The writer posts and WAITS, which is what makes `applied: true` a statement that the live
fold has the set rather than a receipt for a queue: a client can push a rule and immediately reason
about the world it made. The wait is bounded by the same patience a snapshot has, and the world's own
record is already written by then — so a timeout costs the current generation's copy and nothing
more, because the next attach still applies it.

**THE MODULES ANSWER THROUGH ONE SEAM.** `fold::Defines` is one trait with one method, reached
through one defaulted `EqModule` method — exactly the shape `as_roster` and `as_loot` are, with the
mutability a define is. Five families, five implementations, and the family a module claims is the
op's own prefix so the wire name and the claim are one string. What each does with the push is its
TS twin's setter, argued at the implementation: `alerts.setDefs`, `buffs.setTrust` (which lands on
the SHARED cast anchors, so the buff bar and the crowd-control bar cannot end up with two ideas of
whose spell landed), `respawn.setPrefs` (which bumps the revision that IS its published seq — JOS-87,
because a watch advances no log seq), `combo.setCorrection` and `roster.setEdit`.

**FIRES GO OUT IMMEDIATELY, NOT AT THE VIEW CADENCE.** Everything else the tail loop publishes is
STATE, which coalesces by definition — the newest window is the whole answer. A fire is not state:
two charm breaks are two sounds, and folding them would silence one. So every fire a drain produced
is broadcast in the order the fold made them, and the ~10 Hz cadence never touches them.

**WHAT THE EVALUATOR PORTS, AND WHAT IT DELIBERATELY DOES NOT.** `fold::modules::alerts_rules`
carries the half that decides whether a line makes a sound: `event` triggers with their `where`
matchers, `raw` triggers, the `any`/`all` composites, the `enabled` flag, the per-alert and
per-TARGET cooldown clocks, the JOS-259/276 rank fold on every key that names a spell, and the
JOS-84 candidate widening. It does NOT carry the JOS-216 early-warning offset — a def with one is
compiled OUT rather than fired at the wrong instant, because a missing sound is a gap somebody can
read in a comment and a sound made a minute early is a wrong answer wearing a right answer's
clothes — nor `app` triggers (renderer-evaluated over there too), nor capture groups and the
`{target}` token, which decide what a firing SAYS and arrive when speech has a home on the wire.
One honest divergence is written down in that file's header: an alert's `/regex/` was authored
against JavaScript's engine, and a pattern Rust's cannot compile degrades exactly as the TS handles
a pattern V8 cannot — but the set of patterns that fall into it is bigger on this side.

**THE APP LOGS FIRES AND DOES NOT PLAY THEM YET**, and that is this ticket's decision rather than an
oversight: the app's own `AlertsModule` is still firing, and a second sound would not merely annoy —
it would corrupt the owner's hands-on regression evidence, which is what this program is being judged
on. `engineClientHost.ts noteFire` writes one dev-log line per fire and counts them. The audio
cutover is the alerts-surface ticket, which deletes the app-side evaluator in the same change that
gives that line a speaker, so the two can never both be live.

## The live surfaces — the con card, the session mark, the module dirty bit

Three things JOS-487 adds beside the views, and all three are about the same boundary: what a LIVE
engine says without being asked, and the one command it is allowed to refuse.

**`world.conCard` — the fold stops calling into Electron** (boundary verdict 2). The census found
`considerModule.setConCardHook` running `main/conCard.ts noteConsider` INSIDE the fold's own delivery
— a knowledge lookup, a resist profile and an overlay send, on the thread parsing the log. The
verdict inverts it: the consider module buffers its live cons (`take_cons`, the shape `take_fires`
already is), the ingest drains them beside the fires, and `crate::concard` resolves the whole card.
It is connection-wide with no `id` and no `epoch`, on the `FireMessage` precedent, and LIVE ONLY
structurally — a startup replay of a month of logs draws nothing, because a historical event cannot
reach the push at all.

**The chips are the EMPTY five and `spellData` is false, and that is not a stub.** It is the branch
`mobResistProfile` itself takes app-side when the client's `spells_us.txt` has not been read — five
empty axes and the flag down, exactly what the card draws today on the first `/con` of a session.
The engine cannot take the other branch yet: **the spell-table parse is boundary verdict 7 and the
cutover ledger's item 6, still open**, and without it there is no axis for a spell, no resist adjust,
and therefore no estimate to fit — nor has the estimator behind it moved (`shared/resistModel.ts`,
`resistFit.ts`, `resistFormula.ts`). **So the con-card CUTOVER is blocked on the spell table and this
frame is not**: the shape is final, the header is real, and the chips fill in with no protocol change
the day the table lands. That is why `ConCardChip` is typed on the wire in full rather than left
open.

**Two of the app's three refusals stay app-side, with reasons.** The re-open suppression ("never
twice inside a minute of a close") is a fact about the PERSON measured on the wall clock they live on
— EQ stamps to the second, and a log-clock comparison put the card straight back up in the app's own
e2e — and its only input is a window event the fold never sees. The PLAYER refusal is
`isPlayerShapedName(name) && !knownMob(name)`, and this engine has the first half and not the second:
the committed mob catalog moves with the KNOWLEDGE surface. Applying the name-shape test alone would
refuse a card for every proper-named NPC the app draws one for today — Innoruuk, Blugurg, Sheldon —
which is a regression wearing a port's clothes. So neither half is applied here, and until the
catalog is engine-side the app's own `looksLikePlayer` still stands in front of the overlay window.

**`sessionMarks.add` — a command that can be refused** (boundary verdict 6). One press splits
everything, so the APP stamps the clock once and hands that same number in; an engine that stamped
its own would put everything looted between the two reads on the wrong side of one of the two
boundaries. THE ENGINE STORES NOTHING — a mark is ephemeral on both sides, which is half of why a
relaunch replays the log into the records the log alone describes. The other half is the refusal:
`accepted: false` unless the world is LIVE, which is the honest engine-side spelling of
`combat/engine.ts sessionMark`'s `if (st.hydrating) return false`. A refusal is NOT an error — the
frame deserialized, the op exists, the instant is well formed, and the answer is *not now* — so it is
a reply a client branches on rather than something in every error log the app collects. The ack
carries the STATUS it decided under, in the same critical section as the decision, because a client
asking `session.health` afterwards would be racing a fold that may have gone live in between.

**What an accepted mark DOES to the world today is nothing, and that is a named gap.** The mark's
effect is a COMBAT-ENGINE act — close the open fight, freeze the running stay into history tagged
`closedBy: 'mark'`, mint fresh accumulators — and this crate's sink does not register the combat
engine at all (`Fold::with_combat` is the combat surface's own ticket). What exists now is the
command, the law and the reply: the half that decides WHETHER, without the half that DOES.

**`moduleChanged` — the dirty bit, and the end of the poll.** Every module answers
`EqModule::published_seq`, read WITHOUT building the state — because the serve loop asks all twenty
once per beat, and asking through `snapshot()` would serialize twenty modules' whole state ten times
a second to compare twenty integers. The frame
carries a name and a cursor and no state at all, so a client not showing that module pays one small
frame and ignores it, and a client that is re-fetches through `module.snapshot` — the op that already
exists and the only place a module's shape is stated. A frame that carried the state would be
`module.snapshot` pushed at a cadence nobody asked for, which is the per-window snapshot fan-out this
boundary exists to delete.

**It is coalesced to one frame per module per beat**, not one per event: the ingest holds the last
cursor it announced per module (`Serving::announced_seqs`, beside the meter and for the meter's
reasons — it belongs to this generation and it costs no lock) and hands the world only what moved.
Nothing is sent for a module that did not move, so an idle session pays twenty integer comparisons at
10 Hz and nothing else. It is NOT an epoch and does not replace one: a bump still means
drop-everything-and-take-the-reset, and a `moduleChanged` inside one generation means only *there is
something newer to fetch*. The app-side `useModule` → refetch shim is a later ticket; this is the
seam it rides.

**AND SINCE JOS-509 THE CURSOR IS HONEST — the coalescing had nothing to coalesce.** The transcript
below was recorded before that ticket and shows the defect in one screenful: sixteen of the twenty
modules report the SAME number (`139862`) because for each of them `published_seq` was
`self.seq = ev.seq()`, stamped at the top of `on_event` before the match on kind. That is a global
log-line counter wearing twenty per-module names, so `changed_modules` found twenty numbers that had
all changed on every beat and every subscribed renderer re-fetched a whole snapshot ten times a
second. Measured on the owner's machine: identical push counts for `roster`, `loot` and `turnins`
during a live tail, 11.9 renderer commits per beat out of ONE log line, at 271–288 ms a push on his
real tree. Those sixteen now carry a `fold::announce::Announce` bumped only from the arms that
mutate published state — a melee round leaves fourteen of them silent
(`tests/live_surfaces.rs a_melee_round_leaves_the_modules_it_has_nothing_to_do_with_silent`).

**The invariant a reader must not "tidy": the announce cursor is no longer EQUAL to the `seq` inside
that module's snapshot, and it is not meant to be.** The goldens pin every migrated snapshot's `seq`
byte-for-byte, so the two numbers had to come apart; what is preserved is the only property the
clients need. `useModule.ts`, `useOverlayModule.ts`, `BuffsOverlay.tsx` and main's `serveMirrors.ts`
all take `knownSeq` off a held SNAPSHOT and drop any frame at or below it — so the cursor stays in
the snapshot's own number space and lands strictly ABOVE the fold position each change happened at
(`max(cursor, seq) + 1`). It is therefore above any snapshot a client could hold from before the
change, and below only one taken after it, which already carries the change and is right to drop the
frame. A cursor restarting at 1 would have sat permanently below the log-line seq and frozen every
one of those panels after its first hydrate. `fold::announce`'s header is the full argument.
## The knowledge surface

**The corpora move into the engine (JOS-486, design surface 5).** `items.json` (8.75 MB, 11,288 item
pages), `mobs.json` (3.2 MB, 7,866 mob pages), `quests.json` and `posky.json` are `include_str`'d
into a new `knowledge` crate — the `spells.json` precedent, one copy of each file in the tree, so a
re-scrape reaches every reader at once. That is ~12 MB leaving main's heap, and the renderer's own
bundled copies follow when its surfaces cut over.

The crate is `main/itemLookup.ts` + `main/mobLookup.ts` and the six pure files they are built out of
(`itemsDb`, `questItemIndex`, `mobLookupLocal`, `mobAliases`, `mobDropEra`, and the own-loot half of
`mobLookupParse`), ported, **with the network removed**.

### Three steps, and the third one inverted

Over there the resolution is committed DB → userData cache → politely-throttled wiki call. Here it is
committed corpus → **runtime overlay** → **a miss**:

1. **The committed corpus** answers the overwhelming majority and short-circuits everything after it.
2. **The runtime overlay** is what the userData cache was — answers the app has already fetched and
   pushed back with `knowledge.define`.
3. **A miss** is recorded, drained at whatever boundary notices it (the ingest's fold boundary for
   the fold's own probes, the op itself for a client's question), and announced connection-wide as a
   `knowledgeMiss` frame. The app fetches, keeping its own serialized queue, its own 150 ms spacing
   and its own `Retry-After` cooldown — **scraper etiquette is a LAW and it stays where the socket
   is** — and pushes the answer in.

**Each name is announced at most once per process.** A stacked loot burst probes one name many times
and a `/con` ring re-cons the same mob three times in five seconds; asking the app to fetch each of
those would be the engine breaking the etiquette law on the app's behalf. A `knowledge.define` for
the name makes every later lookup a hit, so nothing has to un-remember anything.

### Every index is built on first use

`include_str!` puts the bytes in the binary; nothing is PARSED until something asks. `itemLookup.ts`
made the same call and measured it (JOS-371: 41.8 ms of parse for a ~20.4 MB retained graph, plus
three derived indexes being charged to `DATA_READY_MS` for a service nothing had asked anything of
yet). Here it matters with the same shape for a different reason: **an attach must not pay for a
corpus no client has queried**, because an attach is on the path of the one thing this whole program
exists to make fast.

### The fold gets the real lookups — in the PRODUCTION construction only

`consider` and `eventFeed` are the two modules whose TypeScript twins take an injected lookup
(`deps.lookupMob`, `deps.lookupItem`) and do nothing at all without one. `tests/bench/foldArm.mts`
injects neither, which is why every recorded golden carries `knowledge` **absent** from every
consider row and an **empty** event feed — and why the parity construction must keep injecting
neither, forever.

**The dependency direction is what makes that structural rather than conventional.** The `knowledge`
crate depends on `fold`; `fold` cannot name `knowledge`. So `fold::registered()` — the construction
the parity runner, the bench arm and every fold test use — has no way to reach a corpus even by
accident, and the `parity` binary does not carry 12 MB of committed JSON in its text section.
`Registry::install_knowledge` is called by `foldsink::registry_for` and by nothing else in this repo.

**And a production fold differs from that world only on the LIVE TAIL.** Both probes sit behind the
`live` gate: the feed admits nothing historical at all, and `consider` enriches live cons plus a
bounded backfill on the first **wall-clock tick**, which `fold_bytes` never calls. A historical fold
with a corpus installed is the same fold as one without — which is the property the oracle checks,
and the DEFAULT `oracle:rust-fold` is green across all six slices with the lookups in the build.

**The probe is synchronous, and that is the boundary dissolving.** Over there both lookups are
promises, because main's answer may be a wiki round trip: the row is appended immediately and
`knowledge` lands later as its own delta. Here the corpus is an in-memory index in the same process,
so a live con enriches inside the same fold and the row is published complete. There is therefore
**no out-of-band seq bump** — the TS bumps `seq` on the async landing so `useModule`'s gap check
accepts a delta with no event behind it, and a bump here would put the module's published seq ahead
of the event it folded for no reader's benefit.

### The one part a corpus cannot answer

`knowledge.mob` joins four sources and one of them is yours: **what you have actually looted off that
creature**. That index lives inside the `consider` module on the ingest thread, is character-scoped
and epoch-scoped, and is read through the same one door everything else is (`Ask::Loot`). The order
is the design — the corpus resolves the roster's alias identity FIRST, so what crosses the thread
boundary is a handful of rows rather than a handle on somebody's state — and an engine with no fold
answers with an empty history, which is the same value a creature nothing has been looted from gets.

### The named gap: `knowledge.spell`

It answers off `eqlog`'s **effective** catalog (the committed scrape with removals, derived durations
and corrections applied — one load, never a second) and states exactly the fields that DB carries. It
does **not** carry the join half of `main/data/spellDetail.ts`: no derived effect classes, no rank
lineage, and none of the metrics `spellMetricsAt` reads at a gain level, at a mote rank or with worn
focus. Those need three inputs this engine does not have yet — the parsed `spells_us.txt` client
table (boundary verdict 7, unbuilt), the observed-rank module's join, and the planner's worn-focus
reading — and half a card is a wrong answer wearing a right one's clothes. It answers `found: false`
for a rank-suffixed name the DB has no row for rather than handing back the LINE's numbers with no
note that they are the line's. Named here and in the schema beside the op, the way `earlyWarnSec` is
named in the alert evaluator.

## Watching the corpora answer, by hand

A **real session** against a release build, and **with no log and no attach at all** — which is the
point of the session rather than a shortcut: a corpus question names nothing a fold owns, so the
engine answers all of it before it has read a byte of anybody's log.

```js
// scratch/drive486.mjs — node scratch/drive486.mjs <repo root>
// (spawn and frame printing are drive.mjs's, verbatim; there is no log to stage)
send({ op: 'hello', token: TOKEN, protocolVersion: 1 })
send({ id: 1, op: 'knowledge.item', params: { name: 'Cloak of Flames' } })   // a hit
send({ id: 2, op: 'knowledge.mob',  params: { name: 'a sand giant' } })      // four sources, joined
send({ id: 3, op: 'knowledge.item', params: { name: 'Shard of Nothing' } })  // a MISS
// …then, 400 ms later, the app "fetches" and pushes the answer back:
send({ id: 4, op: 'knowledge.define', params: { domain: 'item', name: 'Shard of Nothing',
       entry: { page: 'Shard of Nothing', lore: true, summary: 'Fetched by the app, not by the engine.' } } })
send({ id: 5, op: 'knowledge.item', params: { name: 'Shard of Nothing' } })  // …and now a hit
send({ id: 6, op: 'knowledge.search', params: { query: 'cloak of flames', domain: 'item', limit: 3 } })
```

The transcript, verbatim except where a record is elided — the two hits below are the committed
corpus's real records and the mob one runs to 6 KB of drop table:

```console
$ cargo build --release -p engined
$ node scratch/drive486.mjs .
EQC-ENGINE PORT=62213 PROTOCOL=1
<- {"engineVersion":"0.1.0","kind":"hello","ok":true,"protocolVersion":1}

<- {"id":1,"kind":"reply","ok":true,"result":{"domain":"item","found":true,"name":"Cloak of Flames",
    "record":{"cached":true,"dropsFrom":[{"mob":"Lord Nagafen","zone":"Nagafen's Lair"}],
    "eraTag":"Classic","iconId":658,"lore":false,"name":"Cloak of Flames","page":"Cloak of Flames",
    "quest":false,"questUses":[],"stats":{"ac":10,"classes":["ALL"],"slot":"BACK",
    "stats":[{"key":"DEX","value":"+9"},{"key":"AGI","value":"+9"},{"key":"HP","value":"+50"},
    {"key":"HASTE","value":"+36%"}], …},"statsBlock":"MAGIC ITEM\n\nSlot: BACK\n\nAC: 10\n\n…"}}}

<- {"id":2,"kind":"reply","ok":true,"result":{"domain":"mob","found":true,"name":"a sand giant",
    "record":{"cached":true,"levelText":"33-37","page":"A Sand Giant",
    "zone":"Southern Desert of Ro, Oasis of Marr, Northern Desert of Ro",
    "dropsWiki":[{"item":"Sand of Ro","eraTag":"Temple","eraZones":["Oasis of Marr", …]},
                 {"item":"Essence of Sunlight","eraTag":"Classic","eraZones":[…]}, … 16 in all],
    "quests":[{"quest":"Armor of Ro Quests","page":"Armor of Ro Quests","giver":"Lord Searfire",
               "zone":"Temple of Solusek Ro"},
              {"quest":"Princess Lenya (Quest)","page":"Princess Lenya (Quest)","giver":"Tynkale",
               "zone":"Northern Felwithe"}]}}}

<- {"domain":"item","kind":"knowledgeMiss","name":"Shard of Nothing"}
<- {"id":3,"kind":"reply","ok":true,"result":{"domain":"item","found":false,"name":"Shard of Nothing",
    "record":{"lore":false,"name":"Shard of Nothing","offline":true,"quest":false,"questUses":[]}}}

-> {"id":4,"op":"knowledge.define","params":{"domain":"item","name":"Shard of Nothing", …}}
<- {"id":4,"kind":"reply","ok":true,"result":{"applied":true}}
<- {"id":5,"kind":"reply","ok":true,"result":{"domain":"item","found":true,"name":"Shard of Nothing",
    "record":{"cached":true,"lore":true,"name":"Shard of Nothing","page":"Shard of Nothing",
    "quest":false,"questUses":[],"summary":"Fetched by the app, not by the engine."}}}

<- {"id":6,"kind":"reply","ok":true,"result":{"query":"cloak of flames","total":1,
    "hits":[{"domain":"item","name":"Cloak of Flames","page":"Cloak of Flames"}]}}
```

Five things in that transcript are worth naming, because each of them is a decision rather than an
outcome:

* **The era evidence on the mob's drop list is joined engine-side** (JOS-377's defect, which is why
  it exists): the mob catalog states names only, so each drop's `eraTag` and `eraZones` come from the
  ITEM page, in the 8.75 MB corpus that only this process now holds. It attaches EVIDENCE and reaches
  **no verdict** — there is exactly one era rule in this app and a second opinion computed here would
  be the beginning of a third.
* **The miss frame arrives BEFORE the reply it belongs to.** Both go out on the connection's one
  outbox and the broadcast happens inside the dispatch, before the outcome is written. Nothing
  depends on the order — the frame carries no id and the reply is correlated by one — and it is
  stated here so a reader of a real capture does not go looking for a bug.
* **The miss still ANSWERS.** `found: false` beside a card with the player's own name in it, and
  `offline: true` rather than `notFound: true`: over there `notFound` means "the wiki lookup RAN and
  found no page", and this engine has no network stack, so it cannot make that claim. `offline` is
  the app's own word for "the wiki could not be consulted — local sources may still have answered",
  which is exactly true, and it is the state the renderer already treats as retryable. The retry is
  the frame.
* **`knowledge.define` needs no attach and survives one.** The overlay is what the APP has told this
  process about committed data, not what a generation folded — the same sentence `World::defines`
  makes about the other five families.
* **`total: 1` on the search** is the match count, not the hit count. It is the one number a caller
  cannot compute from what it was handed, which is what lets a type-ahead print `1-20 of 143` without
  ever holding 143.

## Watching app knowledge land, and an alert fire, by hand

A **real session**, same shape as the ones below: a release build, twenty copies of the committed
fixture, plus a zone line and — deliberately — **a loot line IN HISTORY that the pushed rule
matches**. That last one is the point: a fold that fired on replay would say so before the tail ever
ran, so the silence through the scan is an assertion rather than an absence nobody arranged.

```js
// scratch/drive482.mjs — node scratch/drive482.mjs <repo root> [repeats]
// (staging, spawn and frame printing are drive.mjs's, verbatim; the tail and `talk` differ)
fs.appendFileSync(log, [
  "[Wed Aug 19 16:00:00 2026] You have entered Nagafen's Lair.",
  '[Wed Aug 19 16:14:07 2026] You have looted a Cloak of Flames from a fire giant warlord corpse.',
  ''
].join('\n'))

// THE DEF, exactly as the settings store holds one — extras and all.
const DEF = {
  id: 'a1',
  name: 'Cloak of Flames',
  enabled: true,
  sound: { packId: 'classic', soundId: 'bell' },
  trigger: { type: 'event', kind: 'loot', where: { item: 'Cloak of Flames' } },
  volume: 0.8,
  audio: 'sound',
  note: 'authored by hand for the JOS-482 transcript'
}

function talk(port) {
  const s = net.connect({ host: '127.0.0.1', port })
  let buf = ''
  let appended = false
  const send = (o) => { console.log('-> ' + JSON.stringify(o)); s.write(JSON.stringify(o) + '\n') }
  s.on('connect', () => {
    send({ op: 'hello', token: TOKEN, protocolVersion: 1 })
    // ALL FIVE, BEFORE THE ATTACH — which is what engineClientHost does on connect.
    send({ id: 1, op: 'alerts.define', params: { defs: [DEF] } })
    send({ id: 2, op: 'buffTrust.define', params: { trust: { externals: ['Dranix'] } } })
    send({ id: 3, op: 'respawn.define', params: { prefs: { watches: [{ key: 'a fire giant warlord', display: 'a fire giant warlord', customSec: 1080 }] } } })
    send({ id: 4, op: 'combo.define', params: { corrections: [{ startTs: 1787180400000, endTs: null, classes: ['ENC', 'ROG'], setAt: 1787181000000 }] } })
    send({ id: 5, op: 'roster.define', params: { edits: [{ key: 'rowel', name: 'Rowel', action: 'add', setAt: 1787181000000 }] } })
    send({ id: 6, op: 'session.attach', params: { logPath: log } })
  })
  s.on('data', (d) => {
    buf += d.toString()
    const parts = buf.split('\n'); buf = parts.pop()
    for (const line of parts.filter(Boolean)) {
      console.log('<- ' + (line.length > 260 ? line.slice(0, 260) + ' …' : line))
      const msg = JSON.parse(line)
      if (!appended && msg.kind === 'epoch' && msg.reason === 'progress' && msg.progress.pct === 100) {
        appended = true
        setTimeout(() => {
          send({ id: 7, op: 'module.snapshot', params: { module: 'alerts' } })
          console.log('# the game writes a line the rule matches')
          fs.appendFileSync(log, '[Wed Aug 19 16:16:44 2026] You have looted a Cloak of Flames from a fire giant warlord corpse.\n')
        }, 300)
      }
      if (msg.kind === 'fire') {
        setTimeout(() => {
          send({ id: 8, op: 'module.snapshot', params: { module: 'respawn' } })
          setTimeout(() => { s.end(); engine.stdin.end(); fs.rmSync(dir, { recursive: true }) }, 400)
        }, 200)
      }
    }
  })
}
```

**The only edit to the frames below is the `…`**: the `alerts` snapshot is cut at column 260,
because a module's state is as long as the module says it is and this is a README. Every other byte
is what came off the socket.

```console
$ cargo build --release -p engined
$ node scratch/drive482.mjs C:/Users/jmoye/everquest-companion 20
# staged C:\Users\…\Temp\engined-482-E3FlHx\eqlog_Primitive_freeport.txt (9185395 bytes)
EQC-ENGINE PORT=64051 PROTOCOL=1
-> {"op":"hello","token":"0f7d…7089","protocolVersion":1}
-> {"id":1,"op":"alerts.define","params":{"defs":[{"id":"a1","name":"Cloak of Flames","enabled":true,"sound":{"packId":"classic","soundId":"bell"},"trigger":{"type":"event","kind":"loot","where":{"item":"Cloak of Flames"}},"volume":0.8,"audio":"sound","note":"authored by hand for the JOS-482 transcript"}]}}
-> {"id":2,"op":"buffTrust.define","params":{"trust":{"externals":["Dranix"]}}}
-> {"id":3,"op":"respawn.define","params":{"prefs":{"watches":[{"key":"a fire giant warlord","display":"a fire giant warlord","customSec":1080}]}}}
-> {"id":4,"op":"combo.define","params":{"corrections":[{"startTs":1787180400000,"endTs":null,"classes":["ENC","ROG"],"setAt":1787181000000}]}}
-> {"id":5,"op":"roster.define","params":{"edits":[{"key":"rowel","name":"Rowel","action":"add","setAt":1787181000000}]}}
-> {"id":6,"op":"session.attach","params":{"logPath":"C:\\Users\\…\\eqlog_Primitive_freeport.txt"}}
<- {"engineVersion":"0.1.0","kind":"hello","ok":true,"protocolVersion":1}
<- {"id":1,"kind":"reply","ok":true,"result":{"applied":true,"count":1}}
<- {"id":2,"kind":"reply","ok":true,"result":{"applied":true}}
<- {"id":3,"kind":"reply","ok":true,"result":{"applied":true}}
<- {"id":4,"kind":"reply","ok":true,"result":{"applied":true,"count":1}}
<- {"id":5,"kind":"reply","ok":true,"result":{"applied":true,"count":1}}
<- {"epoch":2,"kind":"epoch","reason":"attach"}
<- {"id":6,"kind":"reply","ok":true,"result":{"accepted":true,"epoch":2}}
[eqc-engine] ingest: spell db ready in 398 ms
<- {"epoch":2,"kind":"epoch","progress":{"events":15932,"pct":11.415208600174516},"reason":"progress"}
<- {"epoch":2,"kind":"epoch","progress":{"events":79788,"pct":57.078296578426944},"reason":"progress"}
[eqc-engine] fold landed: 139862 events, mark 9185395 of C:\Users\…\eqlog_Primitive_freeport.txt, now live
<- {"epoch":2,"kind":"epoch","progress":{"events":139862,"pct":100.0},"reason":"progress"}
<- {"epoch":2,"kind":"epoch","progress":{"events":139862,"pct":100.0},"reason":"progress"}
-> {"id":7,"op":"module.snapshot","params":{"module":"alerts"}}
# the game writes a line the rule matches
<- {"id":7,"kind":"reply","ok":true,"result":{"module":"alerts","seq":139861,"state":{"defs":[{"audio":"sound","enabled":true,"id":"a1","name":"Cloak of Flames","note":"authored by hand for the JOS-482 transcript","sound":{"packId":"classic","soundId":"bell"},"tr …
<- {"epoch":2,"kind":"epoch","progress":{"events":139863,"pct":100.0},"reason":"progress"}
<- {"at":1787181404000,"kind":"fire","message":"[Wed Aug 19 16:16:44 2026] You have looted a Cloak of Flames from a fire giant warlord corpse.","rule":"Cloak of Flames","sound":"classic/bell"}
-> {"id":8,"op":"module.snapshot","params":{"module":"respawn"}}
<- {"id":8,"kind":"reply","ok":true,"result":{"module":"respawn","seq":4,"state":{"prefs":{"watches":[{"customSec":1080,"display":"a fire giant warlord","key":"a fire giant warlord"}]},"recent":[],"rows":[],"v":4,"zone":"Nagafen's Lair"}}}
```

Seven things in that transcript are this ticket:

1. **Five pushes, five acks, before a byte is folded.** The world had no ingest when any of them
   arrived; every one is HELD and applied when the attach builds its fold.
2. **`count` is present exactly where there is something to count.** `alerts`, `combo` and `roster`
   push lists and answer `1`; `buffTrust` and `respawn` push one object each and answer without it —
   absent because the payload is not a list, never because nothing was taken.
3. **The definition came back with its extras intact.** `audio`, `note` and `volume` are fields no
   evaluator reads, and they are in the module's published `defs` because that list is the STORE's
   contract. A typed wire shape would have dropped them and rewritten the user's alert in transit.
4. **The historical scan matched the rule and said NOTHING.** The staged log carries the very same
   loot line at 16:14:07; 139,862 events folded past it in silence, because firing is live-only by
   the boundary law — "replay must never make a sound", enforced where the TypeScript enforces it.
5. **The appended line fired once, immediately.** No cadence, no coalescing: the frame is on the
   wire in the same turn of the tail loop that folded the event.
6. **The fire is fully resolved.** `"sound":"classic/bell"` is the key the renderer's sound cache is
   already keyed by, `"rule"` is the label the user gave the alert, `"at"` is the LOG's clock
   (16:16:44 in the log's own zone), and `"message"` is the line that matched. Nothing in it is a
   reference the app would have to look a definition back up for — and it carries neither an `id`
   nor an `epoch`, because it belongs to no subscription and there is no state to reconcile.
7. **The respawn watch is on the wire too**, as that module's own published `prefs` — which is the
   app-visible proof a push reached a module that had no other way to say so, and `seq: 4` is the
   revision it bumped rather than a log seq (JOS-87).

## Watching a view serve, by hand

A third **real session**, same shape as the two above: a release build, twenty copies of the same
committed fixture — which carries no loot at all, so four real loot lines are written after it, and
those four are the ledger. The driver subscribes to `loot.ledger` with a **three-row** window before
the attach, subscribes to a source this build does not serve, attaches, and appends one line when the
fold lands.

```js
// scratch/drive480.mjs — node scratch/drive480.mjs <repo root> [repeats]
// (spawn and frame printing are drive.mjs's, verbatim; the log's TAIL and `talk` differ)
fs.appendFileSync(log, [
  "[Wed Aug 19 16:00:00 2026] You have entered Nagafen's Lair.",
  '[Wed Aug 19 16:11:19 2026] You have looted 2 Giant Warlord Bracer from a fire giant warlord corpse.',
  '[Wed Aug 19 16:13:52 2026] You have looted a Flowing Black Silk Sash from a fire giant warlord corpse.',
  '[Wed Aug 19 16:14:07 2026] You have looted a Cloak of Flames from a fire giant warlord corpse.',
  ''
].join('\n'))

function talk(port) {
  const s = net.connect({ host: '127.0.0.1', port })
  let buf = ''
  let appended = false
  const send = (o) => { console.log('-> ' + JSON.stringify(o)); s.write(JSON.stringify(o) + '\n') }
  s.on('connect', () => {
    send({ op: 'hello', token: TOKEN, protocolVersion: 1 })
    send({ id: 7, op: 'view.subscribe', params: { source: 'loot.ledger', sort: [['at', 'desc']], window: { offset: 0, limit: 3 } } })
    send({ id: 8, op: 'view.subscribe', params: { source: 'combat.live' } })   // not served here
    send({ id: 3, op: 'session.attach', params: { logPath: log } })
  })
  s.on('data', (d) => {
    buf += d.toString()
    const parts = buf.split('\n'); buf = parts.pop()
    for (const line of parts.filter(Boolean)) {
      console.log('<- ' + line)
      const msg = JSON.parse(line)
      if (!appended && msg.kind === 'reset' && msg.epoch === 2) {     // the fold landed
        appended = true
        setTimeout(() => {
          console.log('# the game writes a line')
          fs.appendFileSync(log, '[Wed Aug 19 16:16:44 2026] You have looted a Golden Efreeti Boots from Efreeti Lord Djarn corpse.\n')
        }, 200)
      }
      if (msg.kind === 'diff') {
        // Long enough for the meter's own 10 s cadence to say what the DIFF cost too.
        console.log('# waiting out the meter cadence')
        setTimeout(() => { s.end(); engine.stdin.end(); fs.rmSync(dir, { recursive: true }) }, 11000)
      }
    }
  })
}
```

**Every byte below is what came off the socket** — nothing is elided, including the reset's rows.

```console
$ cargo build --release -p engined
$ node scratch/drive480.mjs C:/Users/jmoye/everquest-companion 20
# staged C:\Users\…\Temp\engined-480-fJUtbz\eqlog_Primitive_freeport.txt (9185598 bytes)
EQC-ENGINE PORT=50834 PROTOCOL=1
-> {"op":"hello","token":"0f7d…7089","protocolVersion":1}
-> {"id":7,"op":"view.subscribe","params":{"source":"loot.ledger","sort":[["at","desc"]],"window":{"offset":0,"limit":3}}}
-> {"id":8,"op":"view.subscribe","params":{"source":"combat.live"}}
-> {"id":3,"op":"session.attach","params":{"logPath":"C:\\Users\\…\\eqlog_Primitive_freeport.txt"}}
<- {"engineVersion":"0.1.0","kind":"hello","ok":true,"protocolVersion":1}
<- {"id":7,"kind":"reply","ok":true,"result":{"subscribed":true,"subscription":7}}
<- {"epoch":1,"id":7,"kind":"reset","rows":[],"total":0}
<- {"error":{"code":"notFound","message":"this engine serves no view source named \"combat.live\"; it serves loot.ledger"},"id":8,"kind":"error","ok":false}
<- {"epoch":2,"kind":"epoch","reason":"attach"}
<- {"id":3,"kind":"reply","ok":true,"result":{"accepted":true,"epoch":2}}
[eqc-engine] ingest: spell db ready in 383 ms
<- {"epoch":2,"kind":"epoch","progress":{"events":15932,"pct":11.414956326196727},"reason":"progress"}
<- {"epoch":2,"kind":"epoch","progress":{"events":79788,"pct":57.077035158734354},"reason":"progress"}
[eqc-engine] fold landed: 139864 events, mark 9185598 of C:\Users\…\eqlog_Primitive_freeport.txt, now live
[eqc-engine] views: loot.ledger 1 frames (1 reset / 0 diff), 3 rows, 0 ops, 593 B (widest 593 B); fold->frame mean 29 us max 29 us over 1
<- {"epoch":2,"kind":"epoch","progress":{"events":139864,"pct":100.0},"reason":"progress"}
<- {"epoch":2,"kind":"epoch","progress":{"events":139864,"pct":100.0},"reason":"progress"}
<- {"epoch":2,"id":7,"kind":"reset","rows":[{"cells":{"at":"Aug 19, 04:14 PM","count":null,"created":null,"disposition":null,"from":"a fire giant warlord","item":"Cloak of Flames","zone":"Nagafen's Lair"},"key":"loot:2"},{"cells":{"at":"Aug 19, 04:13 PM","count":null,"created":null,"disposition":null,"from":"a fire giant warlord","item":"Flowing Black Silk Sash","zone":"Nagafen's Lair"},"key":"loot:1"},{"cells":{"at":"Aug 19, 04:11 PM","count":2,"created":null,"disposition":null,"from":"a fire giant warlord","item":"Giant Warlord Bracer","zone":"Nagafen's Lair"},"key":"loot:0"}],"total":3}
# the game writes a line
<- {"epoch":2,"kind":"epoch","progress":{"events":139865,"pct":100.0},"reason":"progress"}
<- {"epoch":2,"id":7,"kind":"diff","ops":[{"key":"loot:0","op":"drop"},{"before":"loot:2","op":"insert","row":{"cells":{"at":"Aug 19, 04:16 PM","count":null,"created":null,"disposition":null,"from":"Efreeti Lord Djarn","item":"Golden Efreeti Boots","zone":"Nagafen's Lair"},"key":"loot:3"}}],"total":4}
# waiting out the meter cadence
[eqc-engine] views: loot.ledger 2 frames (1 reset / 1 diff), 3 rows, 2 ops, 892 B (widest 593 B); fold->frame mean 50.3 ms max 100.6 ms over 2
```

Eight things in that transcript are this ticket:

1. **The registry answers.** `combat.live` is `notFound`, and the refusal names what IS served rather
   than leaving a client to guess whether it typed the source wrong or met an older build. That is
   phase 0's accept-everything gone: there is a list to be absent from now.
2. **The opening reset is empty and the fold's is not.** `{"epoch":1,…,"rows":[],"total":0}` arrives
   on the connection thread the instant the subscription exists; the full window arrives at generation
   2, when the fold has landed. A client cannot tell the two apart — which is precisely why
   reset-then-diffs has to hold for an empty window.
3. **The rows are render-ready.** `"at":"Aug 19, 04:14 PM"` is the string the flat ledger draws, in
   the log's own zone. `"count":2` is a number because the ledger's stack size is a magnitude, and
   `"count":null` on the other three is an absence rather than a dash — the renderer's `-` is a
   display decision about nothing.
4. **The window is honoured and `total` is not the window.** Three rows for `limit: 3`, and
   `"total":3` because that is all the ledger holds — then `"total":4` on the diff, when it does not.
5. **Newest first, by the sort the client asked for.** `loot:2`, `loot:1`, `loot:0` — the ledger,
   reversed, with the tiebreak under `at` deciding rows that share an instant.
6. **The live diff is one frame with two ops, in an order the client can apply.** The drop goes first
   so `before: "loot:2"` names a row the window still holds; the new loot enters at the head; the
   oldest of three falls out, and `total` says it is still in the VIEW. That is fixture moment 02,
   against a real fold.
7. **The engine says what its own serve path cost.** Cutting a three-row window off a 139,864-event
   fold and putting it on the wire took **29 µs**. The diff's 100.6 ms is not compute — it is the
   COALESCING CADENCE, the ~10 Hz ceiling the frame waited out — and reading that number off the
   engine rather than guessing at it is the whole point of ruling 19's foundations.
8. **593 bytes for a three-row window.** The payload budget ruling 4 asks for is only a discipline if
   somebody is weighing it; this is the scale that weighs it.

Three things worth knowing about the seam:

* **The event is its serialized JSON.** There is no struct per kind to hand over — `eqlog` writes a
  struct per *branch*, because the phase-1 bar is byte identity with `JSON.stringify(ev)` and
  insertion order is a property of the code path. A fold that wants fields parses the line it is
  given, exactly as `session.ts` hands `Tailer`'s line to the parser today.
* **`event.json` is borrowed** and valid for exactly that call; it lives in the parser's reused
  buffer. A sink that keeps it copies it, which makes the copy the sink's decision.
* **`event()` runs on the ingest thread and on no other**, one call per event, in emission order —
  and a *new* sink is built for every attach, so a registry never sees two folds. There is no reset
  to implement: a preempted fold's sink is dropped with its thread. `snapshot()` runs there too, and
  takes `&self`: reading a module's state is a read, and a snapshot that could advance the fold
  would make the answer depend on who asked.

A sink that panics costs the fold and nothing else: the panic is caught, logged to stderr, and the
world goes `idle` with its epoch untouched.

## Watching the meter serve, by hand

A **real session**, same shape as the ones above, and with one thing none of them needed: **the log's
tail is stamped with THIS MACHINE'S CLOCK**. The committed fixture ends weeks ago, and a damage meter
cut off a fight that old would have divided every rate by a fortnight — so the driver appends a zone
line and one real fight dated *now*, which is what a live tail actually reads. Everything before it
is twenty copies of the fixture, so the scan is long enough to be caught mid-flight.

```js
// scratch/drive485.mjs — node scratch/drive485.mjs <repo root> [repeats]
// (staging, spawn and frame printing are drive.mjs's, verbatim; the tail and `talk` differ)
const started = Date.now() - 60_000
const line = (afterSec, text) => { /* an EQ stamp for `started + afterSec`, built off Date */ }
const MOB = 'a fire giant warlord'
fs.appendFileSync(log, [
  line(0, "You have entered Nagafen's Lair."),
  line(2, `You slash ${MOB} for 155 points of damage.`),
  line(4, `You slash ${MOB} for 240 points of damage.`),
  line(5, `Rowel slashes ${MOB} for 60 points of damage.`),
  line(6, `You slash ${MOB} for 105 points of damage.`)
].join(''))

function talk(port) {
  const s = net.connect({ host: '127.0.0.1', port })
  let buf = ''
  let midfold = false
  let landed = false
  const send = (o) => { console.log('-> ' + JSON.stringify(o)); s.write(JSON.stringify(o) + '\n') }
  s.on('connect', () => {
    send({ op: 'hello', token: TOKEN, protocolVersion: 1 })
    send({ id: 1, op: 'combat.snapshot', params: {} })                       // nothing attached
    send({ id: 7, op: 'view.subscribe', params: { source: 'combat.live' } }) // before the attach
    send({ id: 2, op: 'session.attach', params: { logPath: log } })
    // MID-FOLD. The door opens before the first byte is folded, so the first few asks are refused
    // while the ingest builds the spell catalog; the first ANSWER is the mid-scan one.
    const probe = setInterval(() => {
      if (midfold || landed) { clearInterval(probe); return }
      send({ id: 3, op: 'combat.snapshot', params: {} })
    }, 150)
  })
  s.on('data', (d) => {
    buf += d.toString()
    const parts = buf.split('\n'); buf = parts.pop()
    for (const raw of parts.filter(Boolean)) {
      console.log('<- ' + (raw.length > 800 ? raw.slice(0, 800) + ' …' : raw))
      const msg = JSON.parse(raw)
      if (msg.id === 3 && msg.kind === 'reply') midfold = msg.result.now
      if (!landed && msg.kind === 'reset' && msg.epoch === 2) {
        landed = true
        setTimeout(() => {
          send({ id: 4, op: 'combat.snapshot', params: { opts: { maxSegments: 1 } } })
          send({ id: 5, op: 'combat.searchFights', params: { query: 'fire giatn', limit: 2 } })
          send({ id: 6, op: 'combat.searchFights', params: { query: '' } })
          console.log('# the game writes another hit into the open fight')
          fs.appendFileSync(log, line(8, `You slash ${MOB} for 500 points of damage.`))
        }, 300)
      }
      if (msg.kind === 'diff') {
        setTimeout(() => {
          console.log(`# mid-fold now was ${midfold} — ${Math.round((Date.now() - midfold) / 86400000)} days behind this machine's clock`)
          s.end(); engine.stdin.end(); fs.rmSync(dir, { recursive: true })
        }, 300)
      }
    }
  })
}
```

**The only edit to the frames below is the `…`**: the two `combat.snapshot` answers are cut at column
800, because a combat snapshot is as long as the meter says it is and this is a README. The
`combat.live` reset and the diff are **whole** — they are the point.

```console
$ cargo build --release -p engined
$ node scratch/drive485.mjs C:/Users/jmoye/everquest-companion 20
# staged C:\Users\…\Temp\engined-485-w75M8Y\eqlog_Primitive_freeport.txt (9185639 bytes)
EQC-ENGINE PORT=64808 PROTOCOL=1
-> {"op":"hello","token":"0f7d…7089","protocolVersion":1}
-> {"id":1,"op":"combat.snapshot","params":{}}
-> {"id":7,"op":"view.subscribe","params":{"source":"combat.live"}}
-> {"id":2,"op":"session.attach","params":{"logPath":"C:\\Users\\…\\eqlog_Primitive_freeport.txt"}}
<- {"engineVersion":"0.1.0","kind":"hello","ok":true,"protocolVersion":1}
<- {"error":{"code":"unavailable","message":"no log is attached, so there is no fold to ask"},"id":1,"kind":"error","ok":false}
<- {"id":7,"kind":"reply","ok":true,"result":{"subscribed":true,"subscription":7}}
<- {"epoch":1,"id":7,"kind":"reset","rows":[],"total":0}
<- {"epoch":2,"kind":"epoch","reason":"attach"}
<- {"id":2,"kind":"reply","ok":true,"result":{"accepted":true,"epoch":2}}
-> {"id":3,"op":"combat.snapshot","params":{}}
<- {"error":{"code":"unavailable","message":"no log is attached, so there is no fold to ask"},"id":3,"kind":"error","ok":false}
-> {"id":3,"op":"combat.snapshot","params":{}}
<- {"error":{"code":"unavailable","message":"no log is attached, so there is no fold to ask"},"id":3,"kind":"error","ok":false}
[eqc-engine] ingest: spell db ready in 400 ms
-> {"id":3,"op":"combat.snapshot","params":{}}
<- {"epoch":2,"kind":"epoch","progress":{"events":15932,"pct":11.414905375663032},"reason":"progress"}
<- {"id":3,"kind":"reply","ok":true,"result":{"now":1785795360000,"snapshot":{"hydrating":true,"inCombat":false,"poison":{"coat":{"combat":[{"poison":"Asp Venom","sinceTs":1785744310000},{"poison":"Blood Siphon Venom","sinceTs":1785744313000},{"poison":"Stunning Venom","sinceTs":1785744336000}],"utility":{"poison":"Neurotoxic Poison","sinceTs":1785794384000}},"slow":{"landed":0,"noLand":0,"pulls":0,"window":25}},"recent":[],"roster":{"lastSignalTs":0,"members":[],"seen":false},"segments":[{"active":false,"activeDps":0.0,"activeSec":0.0,"dps":0.0,"durationSec":1.0,"enemyHealTotal":0,"id":"zone","kind":"zone","name":"Session - overall","startTs":0,"total":0}],"selected":null,"selectedId":"","stance":{"invocation":"overchannel","invocationTs":1785570478000,"stance":"defensive","stanceTs":1785570 …
<- {"epoch":2,"kind":"epoch","progress":{"events":63844,"pct":45.6613089192815},"reason":"progress"}
<- {"epoch":2,"kind":"epoch","progress":{"events":111763,"pct":79.9072116811906},"reason":"progress"}
<- {"epoch":2,"kind":"epoch","progress":{"events":139865,"pct":100.0},"reason":"progress"}
[eqc-engine] fold landed: 139865 events, mark 9185639 of C:\Users\…\eqlog_Primitive_freeport.txt, now live
[eqc-engine] views: combat.live 1 frames (1 reset / 0 diff), 2 rows, 0 ops, 397 B (widest 397 B); fold->frame mean 179 us max 179 us over 1
<- {"epoch":2,"id":7,"kind":"reset","rows":[{"cells":{"ambiguous":null,"crit":null,"dps":"125 dps","hit":null,"kind":"you","name":"You","pct":100.0,"rank":1,"resist":null,"tag":null,"total":"500"},"key":"you"},{"cells":{"ambiguous":null,"crit":null,"dps":"15 dps","hit":null,"kind":"other","name":"Rowel","pct":12.0,"rank":2,"resist":null,"tag":"other","total":"60"},"key":"member:rowel"}],"total":2}
-> {"id":4,"op":"combat.snapshot","params":{"opts":{"maxSegments":1}}}
-> {"id":5,"op":"combat.searchFights","params":{"query":"fire giatn","limit":2}}
-> {"id":6,"op":"combat.searchFights","params":{"query":""}}
# the game writes another hit into the open fight
<- {"id":4,"kind":"reply","ok":true,"result":{"now":1787688580109,"snapshot":{"currentTarget":{"lastTs":1787688524000,"name":"a fire giant warlord","others":0},"hydrating":true,"inCombat":false,"poison":{"coat":{"combat":[{"poison":"Asp Venom","sinceTs":1785744310000},{"poison":"Blood Siphon Venom","sinceTs":1785744313000},{"poison":"Stunning Venom","sinceTs":1785744336000}],"utility":{"poison":"Neurotoxic Poison","sinceTs":1785794384000}},"slow":{"landed":0,"noLand":0,"pulls":0,"window":25}},"recent":[],"roster":{"lastSignalTs":0,"members":[],"seen":false},"segments":[{"active":false,"activeDps":140.0,"activeSec":4.0,"dps":140.0,"durationSec":4.0,"enemyHealTotal":0,"id":"e1","kind":"current","name":"a fire giant warlord","startTs":1787688520000,"total":560,"zone":"Nagafen's Lair"},{"active": …
<- {"id":5,"kind":"reply","ok":true,"result":{"corpus":1,"hits":[{"score":0.74,"summary":{"active":false,"activeDps":140.0,"activeSec":4.0,"dps":140.0,"durationSec":4.0,"enemyHealTotal":0,"id":"e1","kind":"current","name":"a fire giant warlord","startTs":1787688520000,"total":560,"zone":"Nagafen's Lair"}}]}}
<- {"id":6,"kind":"reply","ok":true,"result":{"corpus":1,"hits":[]}}
<- {"epoch":2,"kind":"epoch","progress":{"events":139866,"pct":100.0},"reason":"progress"}
<- {"epoch":2,"id":7,"kind":"diff","ops":[{"cells":{"dps":"167 dps","total":"1.0k"},"key":"you","op":"update"},{"cells":{"dps":"10 dps","pct":6.0},"key":"member:rowel","op":"update"}]}
# mid-fold now was 1785795360000 — 22 days behind this machine's clock
```

Eight things in that transcript are this ticket:

1. **The two clocks, on the wire, twenty-two days apart.** The mid-fold answer is stamped
   `1785795360000` — which is exactly the `lastEventTs` the JOS-478 transcript reports for the same
   fixture, the log's own last stamp — and the live one is `1787688580109`, this machine's clock.
   Nobody asked for either: the request carries no instant at all, and the engine says which it used.
2. **A world with no fold has no meter, and says so the same way twice.** `id:1` before the attach
   and the first two `id:3` probes during it are all `unavailable`, because the ingest is still
   opening the log and building the parse's inputs. There is no `notFound` on this op at all — the
   request names nothing that could be misspelled.
3. **The door opens before the first byte is folded.** The third `id:3` lands *before* the 11% progress
   frame and comes back with a real snapshot: `hydrating: true`, `selected: null`, `selectedId: ""`,
   and the zone segment reading `Session - overall` because no zone line has been folded yet. That is
   a prefix state of a scan that is still running.
4. **The meter's rows are what a bar prints.** `"total":"500"` and `"dps":"125 dps"` are the app's own
   `formatNum`/`formatRate` spellings; `"pct":100.0` is a number because the bar's fill is a CSS
   length; `rank` is the meter's own ranking; and the four badges are `null` because their gates are
   shut — no crits, no avoided swings, no resists, no ambiguity.
5. **`kind` and `tag` are different strings, which is why both are cells.** Rowel's row is
   `"kind":"other"` (which decides the bar's colour) and `"tag":"other"` (the word printed after the
   name). Note the KEY disagrees with both: `member:rowel` is the identity the world model minted,
   and the moment the roster learns the name the same row becomes `member` — so a client deriving the
   word from the key would have printed `group` today.
6. **THE UPDATE OP, AGAINST A REAL FOLD, WITH CHANGED CELLS ONLY.** One hit landed, and the frame
   says exactly what moved about each row and nothing else. `you` sends `dps` and `total` — 500 + 500
   is `1.0k` — and NOT `pct`, because you were already the top bar at 100% and the pixel did not
   move. `member:rowel` sends `dps` and `pct` and NOT `total`, because nobody hit anything on their
   behalf; their 60 is simply a smaller share of a bigger bar now (12% → 6%). Neither resends `name`,
   `kind`, `tag` or `rank`. That is rule 2 of the diff protocol, and it is the first time this repo
   has watched it happen over a socket — `loot.ledger` is append-only and cannot make one.
7. **The search finds a fight through a transposition, and an empty box finds nothing.**
   `fire giatn` scores 0.74 against `a fire giant warlord` (a prefix on `fire`, one edit on `giant`)
   and comes back as `kind: "current"` — the mob you are presently swinging at is in the corpus. The
   empty query answers `hits: []` beside `corpus: 1`: an empty box means *show the browse list*, not
   *search nothing*, and a `corpus: 0` would have told a UI there was nothing to search.
8. **The engine says what the meter cost it.** Cutting a two-row window off a 139,865-event fold and
   putting it on the wire took **179 µs** for **397 bytes** — the same ruling-19 measurement
   `loot.ledger` reports, on the source whose rows are the expensive ones to build.

> `corpus: 1` is correct and worth a sentence: the fixture's own fights are weeks old, the appended
> lines are stamped today, and the first event past the launch anchor fires the character-rebirth
> boundary — which clears the world. So the only fight in the history is the one the driver wrote,
> which is also why `selectedId` is empty in the mid-fold answer.

**RECORDED UNDER JOS-485, AND TWO OF ITS FRAMES WOULD READ DIFFERENTLY TODAY.** It is kept as it was
run rather than edited to match, because a transcript is a record; here is exactly what JOS-488 moved
and why. The LIVE answer (`id:4`) would say `hydrating: false` now, and — because the driver stamped
its fight **56 seconds** before the instant that answer was taken — the snapshot-time sweeps would
finalize it: `kind: "fight"` instead of `"current"`, no `currentTarget`, and the hit appended
afterwards would open a fresh encounter rather than joining that one, so frame 6's two updates would
be a drop and an update instead. **That is the engine being right, and it is an artifact of the
staging rather than of the meter**: a real live session writes its lines at the instant they happen,
so its open fight is seconds old and stays open — which is precisely what `tests/combat.rs` stages
now, and what `Staged::stale` stages deliberately to watch a fight close on the clock alone. The
MID-FOLD answer (`id:3`) is unchanged in every field, including `hydrating: true`: the scan cannot
reach the flag, so a replay is still not a moment in time.

## Running it by hand

Three lines, and the transcript below is a real session (`cargo run` writes its build output to
stderr, so stdout stays clean):

```console
$ TOKEN=0f7d2c9a4b1e6538aa03d7c5e9124f86b0d3a7c1e2f4085967ab3cd12e4f7089
$ cd engine
$ { printf '%s\n' "$TOKEN"; sleep 20; } | cargo run -q -p engined
EQC-ENGINE PORT=60869 PROTOCOL=1
```

The `sleep` is the whole trick: it holds stdin open. Pipe the token in on its own and the engine
sees EOF immediately and exits 0, exactly as the contract says it should.

From a second shell, one echo round trip (Node, because the supervisor is written in it and this is
the cheapest proof the two languages agree):

```console
$ node -e "$(cat <<'JS'
const net=require('net');const s=net.connect({host:'127.0.0.1',port:60869});
s.on('data',d=>process.stdout.write('<- '+d));
s.on('connect',()=>{
  s.write(JSON.stringify({op:'hello',token:process.env.TOKEN,protocolVersion:1})+'\n');
  s.write(JSON.stringify({id:1,op:'echo',params:{text:'hello from the app side'}})+'\n');
  setTimeout(()=>s.end(),400);
});
JS
)"
<- {"engineVersion":"0.1.0","kind":"hello","ok":true,"protocolVersion":1}
<- {"id":1,"kind":"reply","ok":true,"result":{"text":"hello from the app side"}}
```

Closing the first shell's pipe (or letting the `sleep` finish) ends the process with status 0.

## Watching a real fold, by hand

Everything below is a **real session**, run against a release build over a copy of a committed
fixture. The driver is one script because the interesting part is the timing — a fold, then an
append — and two shells cannot hold still for it. It stages the log, spawns the engine, attaches,
prints every frame both ways, appends one line when the fold lands, and leaves.

```js
// scratch/drive.mjs — node scratch/drive.mjs <repo root> [repeats]
import { spawn } from 'node:child_process'
import net from 'node:net'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const ROOT = process.argv[2]
const REPEATS = Number(process.argv[3] ?? 20)   // 20 copies of a 459 KB fixture ≈ 9 MB
const TOKEN = '0f7d2c9a4b1e6538aa03d7c5e9124f86b0d3a7c1e2f4085967ab3cd12e4f7089'

// THE LOG IS A COPY, NAMED THE WAY THE PRODUCT NAMES ONE — that is where the character comes from.
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'engined-manual-'))
const log = path.join(dir, 'eqlog_Primitive_freeport.txt')
const fixture = fs.readFileSync(path.join(ROOT, 'tests/fixtures/cw2-loadout-swap-aug2.log'))
for (let i = 0; i < REPEATS; i++) fs.appendFileSync(log, fixture)
console.log(`# staged ${log} (${fs.statSync(log).size} bytes)`)

const engine = spawn(path.join(ROOT, 'engine/target/release/engined.exe'), {
  stdio: ['pipe', 'pipe', 'inherit'],           // stderr inherited: the engine's diagnostics show
})
engine.stdin.write(TOKEN + '\n')                // the token, and the pipe stays open

let announced = ''
engine.stdout.on('data', (d) => {
  announced += d.toString()
  if (!announced.includes('\n')) return
  console.log(announced.trim())
  talk(Number(/PORT=(\d+)/.exec(announced)[1]))
})

function talk(port) {
  const s = net.connect({ host: '127.0.0.1', port })
  let buf = ''
  let appended = false
  const send = (o) => { console.log('-> ' + JSON.stringify(o)); s.write(JSON.stringify(o) + '\n') }
  s.on('connect', () => {
    send({ op: 'hello', token: TOKEN, protocolVersion: 1 })
    send({ id: 5, op: 'session.progress', params: {} })
    send({ id: 7, op: 'view.subscribe', params: { source: 'loot.ledger' } })
    send({ id: 3, op: 'session.attach', params: { logPath: log } })
  })
  s.on('data', (d) => {
    buf += d.toString()
    const parts = buf.split('\n'); buf = parts.pop()
    for (const line of parts.filter(Boolean)) {
      console.log('<- ' + line)
      const msg = JSON.parse(line)
      if (!appended && msg.kind === 'reset' && msg.epoch === 2) {   // the fold landed
        appended = true
        setTimeout(() => {
          console.log('# the game writes a line')
          fs.appendFileSync(log, '[Wed Aug 19 16:21:54 2026] You gain experience! (3.288%)\n')
          send({ id: 9, op: 'session.health', params: {} })
        }, 300)
      }
      if (appended && msg.kind === 'epoch' && msg.reason === 'progress') {
        setTimeout(() => { s.end(); engine.stdin.end(); fs.rmSync(dir, { recursive: true }) }, 200)
      }
    }
  })
}
```

```console
$ cargo build --release -p engined
$ node scratch/drive.mjs C:/Users/jmoye/everquest-companion 20
# staged C:\Users\…\Temp\engined-manual-MWaZP7\eqlog_Primitive_freeport.txt (9185240 bytes)
EQC-ENGINE PORT=61699 PROTOCOL=1
-> {"op":"hello","token":"0f7d…7089","protocolVersion":1}
-> {"id":5,"op":"session.progress","params":{}}
-> {"id":7,"op":"view.subscribe","params":{"source":"loot.ledger"}}
-> {"id":3,"op":"session.attach","params":{"logPath":"C:\\Users\\…\\eqlog_Primitive_freeport.txt"}}
<- {"engineVersion":"0.1.0","kind":"hello","ok":true,"protocolVersion":1}
<- {"id":5,"kind":"reply","ok":true,"result":{"subscribed":true,"subscription":5}}
<- {"id":7,"kind":"reply","ok":true,"result":{"subscribed":true,"subscription":7}}
<- {"epoch":1,"id":7,"kind":"reset","rows":[],"total":0}
<- {"epoch":2,"kind":"epoch","reason":"attach"}
<- {"id":3,"kind":"reply","ok":true,"result":{"accepted":true,"epoch":2}}
[eqc-engine] ingest: spell db built in 386 ms
<- {"epoch":2,"kind":"epoch","progress":{"events":15932,"pct":11.415401230670074},"reason":"progress"}
[eqc-engine] fold landed: 139860 events, mark 9185240 of C:\Users\…\eqlog_Primitive_freeport.txt, now live
<- {"epoch":2,"kind":"epoch","progress":{"events":139860,"pct":100.0},"reason":"progress"}
<- {"epoch":2,"id":7,"kind":"reset","rows":[],"total":0}
# the game writes a line
-> {"id":9,"op":"session.health","params":{}}
<- {"id":9,"kind":"reply","ok":true,"result":{"epoch":2,"status":"live","uptimeMs":925}}
<- {"epoch":2,"kind":"epoch","progress":{"events":139861,"pct":100.0},"reason":"progress"}
```

Six things in that transcript are the whole ticket:

1. **The announcement precedes the reply.** `{"epoch":2,…,"reason":"attach"}` arrives before the
   `accepted` reply, and it carries **no** `progress` — at the bump the fold has not opened the file
   and a percentage would be an invented measurement.
2. **Progress is a cadence, not a stream.** 9.19 MB and 139,860 events produced *two* frames: one at
   11.4% and the forced final one. `pct` is a float (owner ruling 17).
3. **The final frame states the whole fold** — 139,860, which is exactly what `eqlog`'s proven scan
   finds in those bytes, and what `tests/ingest.rs` asserts against rather than against a number
   anybody typed.
4. **The fold lands as a reset**, per open subscription, naming generation 2. `total: 0` and empty
   rows until the fold registry arrives.
5. **`live` means the tail owns the file** — and the mark, `9185240`, is the file's last byte,
   because this fixture ends on a newline.
6. **The appended line arrives**: `events` goes to 139,861 with `pct` still at its ceiling. That
   round trip — file → poll → parser → sink → wire — took one tail poll.

The `uptimeMs: 925` is the measurement worth keeping: a cold process, a 404 ms spell-DB build and a
9.19 MB fold, all inside a second. (Debug builds are ~10× slower on both halves; the ingest prints
its own spell-DB number so a slow run says why.)

> That transcript is from JOS-474, when the sink was a counter and the fold's own numbers reached
> nobody. It is kept because every claim in it still holds — with one line's wording moved: the
> diagnostic now reads `spell db ready in …`, because a second attach in the same process no longer
> BUILDS one. The next section is the same session with the fold turned on.

## Watching the fold serve, by hand

Another **real session**, same shape as above — a release build, a copy of the same committed
fixture staged twenty times over. The driver is a sibling of the one above with the interesting
lines swapped: it asks `session.health` and `module.snapshot` BEFORE the attach, twice DURING the
scan, and once after the tail takes over.

```js
// scratch/drive478.mjs — node scratch/drive478.mjs <repo root> [repeats]
// (staging, spawn and frame printing are drive.mjs's, verbatim; only `talk` differs)
function talk(port) {
  const s = net.connect({ host: '127.0.0.1', port })
  let buf = ''
  let landed = false
  const send = (o) => { console.log('-> ' + JSON.stringify(o)); s.write(JSON.stringify(o) + '\n') }
  s.on('connect', () => {
    send({ op: 'hello', token: TOKEN, protocolVersion: 1 })
    send({ id: 1, op: 'session.health', params: {} })     // no attach: no coordinate at all
    send({ id: 2, op: 'module.snapshot', params: { module: 'leveling' } })   // no fold to ask
    send({ id: 3, op: 'session.attach', params: { logPath: log } })
    setTimeout(() => send({ id: 4, op: 'module.snapshot', params: { module: 'leveling' } }), 600)
    setTimeout(() => send({ id: 5, op: 'module.snapshot', params: { module: 'leveling' } }), 900)
  })
  s.on('data', (d) => {
    buf += d.toString()
    const parts = buf.split('\n'); buf = parts.pop()
    for (const line of parts.filter(Boolean)) {
      console.log('<- ' + (line.length > 250 ? line.slice(0, 250) + ' …' : line))
      const msg = JSON.parse(line)
      if (!landed && msg.kind === 'epoch' && msg.reason === 'progress' && msg.progress.pct === 100) {
        landed = true
        setTimeout(() => {
          send({ id: 6, op: 'module.snapshot', params: { module: 'leveling' } })
          send({ id: 7, op: 'module.snapshot', params: { module: 'character' } })
          send({ id: 8, op: 'module.snapshot', params: { module: 'loot.ledger' } })
          send({ id: 9, op: 'session.health', params: {} })
          setTimeout(() => { s.end(); engine.stdin.end(); fs.rmSync(dir, { recursive: true }) }, 400)
        }, 150)
      }
    }
  })
}
```

**The only edit to the frames below is the `…`**: four `leveling`/`character` lines are cut at
column 250, because a module's state is as long as the module says it is and this is a README. Every
other byte is what came off the socket.

```console
$ cargo build --release -p engined
$ node scratch/drive478.mjs C:/Users/jmoye/everquest-companion 20
# staged C:\t478\engined-478-6ikaTi\eqlog_Primitive_freeport.txt (9185240 bytes)
EQC-ENGINE PORT=64299 PROTOCOL=1
-> {"op":"hello","token":"0f7d…7089","protocolVersion":1}
-> {"id":1,"op":"session.health","params":{}}
-> {"id":2,"op":"module.snapshot","params":{"module":"leveling"}}
-> {"id":3,"op":"session.attach","params":{"logPath":"C:\\t478\\engined-478-6ikaTi\\eqlog_Primitive_freeport.txt"}}
<- {"engineVersion":"0.1.0","kind":"hello","ok":true,"protocolVersion":1}
<- {"id":1,"kind":"reply","ok":true,"result":{"epoch":1,"status":"idle","uptimeMs":1}}
<- {"error":{"code":"unavailable","message":"no log is attached, so there is no fold to ask"},"id":2,"kind":"error","ok":false}
<- {"epoch":2,"kind":"epoch","reason":"attach"}
<- {"id":3,"kind":"reply","ok":true,"result":{"accepted":true,"epoch":2}}
[eqc-engine] ingest: spell db ready in 403 ms
<- {"epoch":2,"kind":"epoch","progress":{"events":15932,"pct":11.415401230670074},"reason":"progress"}
-> {"id":4,"op":"module.snapshot","params":{"module":"leveling"}}
<- {"id":4,"kind":"reply","ok":true,"result":{"module":"leveling","seq":47889,"state":{"aaGains":[],"aaPotions":[],"aaSpends":[],"levels":[{"level":50,"ts":1785539944000},{"level":11,"ts":1785662014000},{"level":12,"ts":1785662400000},{"level":13,"ts":1 …
<- {"epoch":2,"kind":"epoch","progress":{"events":79788,"pct":57.07925976893363},"reason":"progress"}
-> {"id":5,"op":"module.snapshot","params":{"module":"leveling"}}
<- {"id":5,"kind":"reply","ok":true,"result":{"module":"leveling","seq":111762,"state":{"aaGains":[],"aaPotions":[],"aaSpends":[],"levels":[{"level":50,"ts":1785539944000},{"level":11,"ts":1785662014000},{"level":12,"ts":1785662400000},{"level":13,"ts": …
[eqc-engine] fold landed: 139860 events, mark 9185240 of C:\t478\engined-478-6ikaTi\eqlog_Primitive_freeport.txt, now live
<- {"epoch":2,"kind":"epoch","progress":{"events":139860,"pct":100.0},"reason":"progress"}
-> {"id":6,"op":"module.snapshot","params":{"module":"leveling"}}
-> {"id":7,"op":"module.snapshot","params":{"module":"character"}}
-> {"id":8,"op":"module.snapshot","params":{"module":"loot.ledger"}}
-> {"id":9,"op":"session.health","params":{}}
<- {"id":6,"kind":"reply","ok":true,"result":{"module":"leveling","seq":139859,"state":{"aaGains":[],"aaPotions":[],"aaSpends":[],"levels":[{"level":50,"ts":1785539944000},{"level":11,"ts":1785662014000},{"level":12,"ts":1785662400000},{"level":13,"ts": …
<- {"id":7,"kind":"reply","ok":true,"result":{"module":"character","seq":37,"state":{"character":{"logPath":"C:\\t478\\engined-478-6ikaTi\\eqlog_Primitive_freeport.txt","name":"Primitive","server":"freeport"},"level":{"level":42,"source":"ding","ts":178 …
<- {"error":{"code":"notFound","message":"this engine folds no module named \"loot.ledger\""},"id":8,"kind":"error","ok":false}
<- {"id":9,"kind":"reply","ok":true,"result":{"epoch":2,"events":139860,"lastEventTs":1785795360000,"mark":{"log":"C:\\t478\\engined-478-6ikaTi\\eqlog_Primitive_freeport.txt","offset":9185240},"status":"live","uptimeMs":1304}}
```

Seven things in that transcript are this ticket:

1. **A world with no fold says so, and says it differently from a world with no such module.** `id:2`
   is `unavailable` — nothing is attached, and the request was fine. `id:8`, after the fold is live,
   is `notFound`: `loot.ledger` is a VIEW source name, and a client that confused the two has to be
   told rather than handed an empty state.
2. **Health before the attach carries `status`, `epoch`, `uptimeMs` and nothing else.** No `mark`, no
   `events`, no `lastEventTs` — absent, not zero, because a fresh process has no coordinate and
   `offset: 0` would be a measurement nobody took.
3. **The scan is answerable while it runs.** `id:4` comes back at `seq: 47889` and `id:5` at
   `111762`, both of them mid-fold — the door opens before the first byte is folded, and each answer
   is served at a read boundary the scan was going to reach anyway.
4. **Those two answers are PREFIX STATES, not previews.** `levels` grows between them and neither is
   torn: `tests/module_snapshot.rs` catches a mid-scan answer, folds the same bytes stopped at the
   `seq` it named, and deep-equals the two.
5. **A module's `seq` is its own.** `leveling` lands on `139859` — the last event of 139,860,
   counting from zero — while `character` answers `37`, because it is one of the four modules that
   publish a private REVISION counter (JOS-87). The protocol says `seq` is a hydration cursor and not
   the fold's event count, and this is the line that shows why the two had to be different fields.
6. **The state's shape is the module's.** `leveling` publishes an object of four arrays; `character`
   publishes the CharacterRef the engine DERIVED from the log's file name — `{name, server, logPath}`
   — beside a level the log stated. The protocol names neither shape.
7. **Health carries the mark.** `9185240`, which is the file's last byte because this fixture ends on
   a newline; `events: 139860`, the count `eqlog`'s proven scan finds in the same bytes; and
   `lastEventTs`, the LOG's clock rather than the host's. That is ruling 18 law 3 on the wire: state
   addressed by (log identity, byte offset), and never by "current".

That transcript predates JOS-481, so its health answers carry no `logMtimeMs`; a build at tip adds it
beside `lastEventTs`, and the two are different kinds of thing on purpose — one is the clock inside
the log, the other the clock the filesystem stamped the file with, and a line half-written after the
last complete one moves the second without moving the first. See "The file facts". The transcript is
not re-run for a field, for the same reason the JOS-474 one above was kept: every claim it makes
still holds, and a session nobody actually ran is not evidence.

The `spell db ready in 403 ms` line is a first attach. A second attach in the same process reads ~0:
the catalog is `Arc`-shared per process now, and the fold's resist catalog reads that same one rather
than loading a second.

## Watching the live surfaces, by hand

A **real session** covering all three at once, on the same twenty-copy fixture the sections above
use. Two things about the staging are load-bearing rather than convenient. The tail lines are stamped
from the HOST's clock, not dated in 2026: a live engine ticks its own modules on the wall clock
(ruling 22), so a 24-second mez recorded a week ago is swept the instant the fold goes live — which
is exactly the divergence JOS-479's parity probe measured. And the first `sessionMarks.add` goes out
WITH the attach, so the world is still starting when it lands.

```js
// scratch/drive487.mjs — node scratch/drive487.mjs <repo root> [repeats]
// (staging, spawn and frame printing are drive.mjs's, verbatim; the tail lines and `talk` differ)
const MONTHS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec']
const stamp = (agoSec) => {
  const d = new Date(Date.now() - agoSec * 1000)
  const p = (n) => String(n).padStart(2, '0')
  return `[Mon ${MONTHS[d.getMonth()]} ${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())} ${d.getFullYear()}]`
}
fs.appendFileSync(log, [
  `${stamp(90)} You have entered Nagafen's Lair.`,
  `${stamp(32)} You begin casting Mesmerization.`,     // the anchor: a landing with no cast is nobody's
  `${stamp(30)} a lava guardian has been mesmerized.`,
  ''
].join('\n'))

function talk(port) {
  const s = net.connect({ host: '127.0.0.1', port })
  let buf = ''
  let live = false
  const send = (o) => { console.log('-> ' + JSON.stringify(o)); s.write(JSON.stringify(o) + '\n') }
  s.on('connect', () => {
    send({ op: 'hello', token: TOKEN, protocolVersion: 1 })
    send({ id: 3, op: 'session.attach', params: { logPath: log } })
    send({ id: 4, op: 'sessionMarks.add', params: { at: Date.now() } })   // mid-fold, deliberately
    send({ id: 7, op: 'view.subscribe', params: { source: 'timers.rows', filter: { surface: 'debuffs' } } })
  })
  s.on('data', (d) => {
    buf += d.toString()
    const parts = buf.split('\n'); buf = parts.pop()
    for (const lineText of parts.filter(Boolean)) {
      console.log('<- ' + lineText)
      const msg = JSON.parse(lineText)
      if (!live && msg.kind === 'moduleChanged') {      // the first beat past the landing
        live = true
        setTimeout(() => {
          send({ id: 8, op: 'sessionMarks.add', params: { at: Date.now() } })
          console.log('# the game writes a /con and a loot line')
          fs.appendFileSync(log, [
            `${stamp(1)} A fire giant warlord glares at you threateningly -- looks like quite a gamble. (Lvl: 52)`,
            `${stamp(0)} You have looted a Cloak of Flames from a fire giant warlord corpse.`,
            ''
          ].join('\n'))
          setTimeout(() => { s.end(); engine.stdin.end(); fs.rmSync(dir, { recursive: true }) }, 3500)
        }, 500)
      }
    }
  })
}
```

**Every byte below is what came off the socket**, nothing elided — including all twenty dirty bits.

```console
$ cargo build --release -p engined
$ node scratch/drive487.mjs C:/Users/jmoye/everquest-companion 20
# staged C:\Users\…\Temp\engined-487-2VZKHE\eqlog_Primitive_freeport.txt (9185424 bytes)
EQC-ENGINE PORT=61565 PROTOCOL=1
-> {"op":"hello","token":"0f7d…7089","protocolVersion":1}
-> {"id":3,"op":"session.attach","params":{"logPath":"C:\\Users\\…\\eqlog_Primitive_freeport.txt"}}
-> {"id":4,"op":"sessionMarks.add","params":{"at":1787692441556}}
-> {"id":7,"op":"view.subscribe","params":{"source":"timers.rows","filter":{"surface":"debuffs"}}}
<- {"engineVersion":"0.1.0","kind":"hello","ok":true,"protocolVersion":1}
<- {"epoch":2,"kind":"epoch","reason":"attach"}
<- {"id":3,"kind":"reply","ok":true,"result":{"accepted":true,"epoch":2}}
<- {"id":4,"kind":"reply","ok":true,"result":{"accepted":false,"status":"attaching"}}
<- {"id":7,"kind":"reply","ok":true,"result":{"subscribed":true,"subscription":7}}
<- {"epoch":2,"id":7,"kind":"reset","rows":[],"total":0}
[eqc-engine] ingest: spell db ready in 392 ms
<- {"epoch":2,"kind":"epoch","progress":{"events":15932,"pct":11.415172560352142},"reason":"progress"}
<- {"epoch":2,"kind":"epoch","progress":{"events":63844,"pct":45.6623776975347},"reason":"progress"}
<- {"epoch":2,"kind":"epoch","progress":{"events":111763,"pct":79.90908204128628},"reason":"progress"}
<- {"epoch":2,"kind":"epoch","progress":{"events":139863,"pct":100.0},"reason":"progress"}
[eqc-engine] fold landed: 139863 events, mark 9185424 of C:\Users\…\eqlog_Primitive_freeport.txt, now live
[eqc-engine] views: timers.rows 1 frames (1 reset / 0 diff), 1 rows, 0 ops, 440 B (widest 440 B); fold->frame mean 8.8 ms max 8.8 ms over 1
<- {"epoch":2,"id":7,"kind":"reset","rows":[{"cells":{"ambiguous":false,"calmsTarget":false,"caster":null,"count":null,"durationMs":24000,"endsAt":1787692435000,"flat":0,"group":"target","inferredTarget":false,"kind":"cc","mode":"countdown","name":"Mesmerization","order":0,"rank":null,"startedTs":1787692411000,"surface":"debuffs","target":"a lava guardian","targetKey":"a lava guardian"},"key":"cc|a lava guardian|mesmerization"}],"total":1}
<- {"kind":"moduleChanged","module":"combo","seq":139343}
<- {"kind":"moduleChanged","module":"roster","seq":139862}
<- {"kind":"moduleChanged","module":"loot","seq":139862}
<- {"kind":"moduleChanged","module":"turnins","seq":139862}
<- {"kind":"moduleChanged","module":"classUnlocks","seq":139862}
<- {"kind":"moduleChanged","module":"kills","seq":139862}
<- {"kind":"moduleChanged","module":"respawn","seq":3}
<- {"kind":"moduleChanged","module":"progression","seq":139862}
<- {"kind":"moduleChanged","module":"leveling","seq":139862}
<- {"kind":"moduleChanged","module":"character","seq":38}
<- {"kind":"moduleChanged","module":"outputFiles","seq":139862}
<- {"kind":"moduleChanged","module":"spellSets","seq":139862}
<- {"kind":"moduleChanged","module":"itemTiers","seq":139862}
<- {"kind":"moduleChanged","module":"observedSpellRanks","seq":139862}
<- {"kind":"moduleChanged","module":"alerts","seq":139862}
<- {"kind":"moduleChanged","module":"buffs","seq":139862}
<- {"kind":"moduleChanged","module":"buffTimers","seq":1}
<- {"kind":"moduleChanged","module":"consider","seq":139862}
<- {"kind":"moduleChanged","module":"resist","seq":139862}
<- {"kind":"moduleChanged","module":"eventFeed","seq":139862}
-> {"id":8,"op":"sessionMarks.add","params":{"at":1787692443380}}
# the game writes a /con and a loot line
<- {"id":8,"kind":"reply","ok":true,"result":{"accepted":true,"status":"live"}}
<- {"epoch":2,"kind":"epoch","progress":{"events":139865,"pct":100.0},"reason":"progress"}
<- {"at":1787692442000,"chips":[{"axis":"magic","empirical":{"resisted":0,"total":0},"n":0,"nTotal":0,"npcOnly":false,"pinned":false},{"axis":"fire","empirical":{"resisted":0,"total":0},"n":0,"nTotal":0,"npcOnly":false,"pinned":false},{"axis":"cold","empirical":{"resisted":0,"total":0},"n":0,"nTotal":0,"npcOnly":false,"pinned":false},{"axis":"poison","empirical":{"resisted":0,"total":0},"n":0,"nTotal":0,"npcOnly":false,"pinned":false},{"axis":"disease","empirical":{"resisted":0,"total":0},"n":0,"nTotal":0,"npcOnly":false,"pinned":false}],"id":"a fire giant warlord","kind":"conCard","level":52,"name":"A fire giant warlord","spellData":false,"zone":"Nagafen's Lair"}
<- {"domain":"mob","kind":"knowledgeMiss","name":"A fire giant warlord"}
<- {"kind":"moduleChanged","module":"roster","seq":139864}
<- {"kind":"moduleChanged","module":"loot","seq":139864}
<- {"kind":"moduleChanged","module":"turnins","seq":139864}
<- {"kind":"moduleChanged","module":"classUnlocks","seq":139864}
<- {"kind":"moduleChanged","module":"kills","seq":139864}
<- {"kind":"moduleChanged","module":"progression","seq":139864}
<- {"kind":"moduleChanged","module":"leveling","seq":139864}
<- {"kind":"moduleChanged","module":"outputFiles","seq":139864}
<- {"kind":"moduleChanged","module":"spellSets","seq":139864}
<- {"kind":"moduleChanged","module":"itemTiers","seq":139864}
<- {"kind":"moduleChanged","module":"observedSpellRanks","seq":139864}
<- {"kind":"moduleChanged","module":"alerts","seq":139864}
<- {"kind":"moduleChanged","module":"buffs","seq":139864}
<- {"kind":"moduleChanged","module":"consider","seq":139864}
<- {"kind":"moduleChanged","module":"resist","seq":139864}
<- {"kind":"moduleChanged","module":"eventFeed","seq":139864}
```

Nine things in that transcript are this ticket:

1. **The same press, refused and then taken.** `{"accepted":false,"status":"attaching"}` at request 4
   and `{"accepted":true,"status":"live"}` at request 8. Neither is an error; the status is what
   makes the first one readable without a follow-up question that would race the fold — and *which*
   not-live state it names is itself a race the ack settles honestly, because the same press against
   the same script has answered `starting` on other runs. Any of the four is a refusal; the ack says
   which one it was, in the same critical section as the decision.
2. **A timer row, cut off a 139,863-event fold in 8.8 ms.** One hold, in the debuffs window, because
   the descriptor said `{"surface":"debuffs"}` — the routing decision made engine-side and served as
   a cell, so the two floating windows are one model filtered rather than two.
3. **The row carries the three numbers a countdown is read from and none of the reading.**
   `"startedTs":1787692411000`, `"durationMs":24000`, `"mode":"countdown"` — and `"endsAt"`, which is
   `startedTs + durationMs` and is the number the early-warning offset is computed from. There is no
   `remaining`, and there is not going to be one.
4. **Both presentation orders are on the row.** `"order":0` and `"flat":0`: the grouped order and the
   soonest-first order, each an index the client sorts by and never re-derives.
5. **`"caster":null`, `"rank":null`, `"count":null`.** Absence has a spelling here for
   `loot.ledger`'s reason: a diff needs a cell to be able to become null, and a display decision
   about nothing is the renderer's.
6. **Twenty dirty bits at the landing, sixteen at the next beat.** The first beat announces every
   module, because a client that just took a fresh world holds nothing. The second announces only
   what a `/con` and a loot line moved — and `respawn`, `character`, `combo` and `buffTimers` are
   ABSENT from it, which is the four modules with real revision counters staying quiet while the
   sixteen that report the fold's `seq` all move. The coarseness this README names is visible on the
   wire.
7. **One frame per module per beat.** Two log lines moved `loot` and fifteen others once each, not
   once per event: the ingest holds the last cursor it announced and hands over only the difference.
8. **The con card, fully resolved and honestly empty where it must be.** `"name":"A fire giant
   warlord"` capped and collapsed, `"id":"a fire giant warlord"` the queue identity, `"level":52`
   off the line, `"zone"` off the module — and five chips at `n: 0` beside `"spellData":false`,
   which is the app's own no-spell-table branch rather than a stub. `"rare"` is ABSENT rather than
   false, which is the payload's own shape. The historical `/con`s in nine megabytes of fixture drew
   nothing at all.
9. **And the frame right after it belongs to somebody else, which is the point.**
   `{"domain":"mob","kind":"knowledgeMiss","name":"A fire giant warlord"}` is JOS-486's: the same con
   that produced the card also asked the corpus about that creature and did not get an answer. Two
   connection-wide frames, from two tickets, one live line — they interleave on the stream without
   either knowing about the other, which is what "connection-wide, no id, no epoch" buys and why
   `broadcasts.ts` routes all four of them in one place.

## Tests

```console
$ cd engine
$ cargo test -p engined
```

**`cargo test` LEAVES A DEBUG BINARY BEHIND, AND THE APP NO LONGER PICKS IT UP** (JOS-520). It used
to: the Electron resolver probed `engine/target/debug/` before `engine/target/release/`, so the
first `cargo test` in a checkout silently switched that machine's dev app to the unoptimized engine
on its next restart — spell DB 4050 ms instead of 469 ms, parse ~10× slower. The dev app now
resolves `target/release` and probes `target/debug` **only** when a launch opts in:

```console
$ EQC_ENGINE_PROFILE=debug npm run dev     # this launch, and no other, runs the debug engine
```

The opt-in is read per launch and never written down, so the next ordinary `npm run dev` is back on
release; and whenever a non-release binary wins, the dev log carries one unmissable warning naming
the profile and the opt-in that selected it. Full argument: `src/main/dataServer/README.md`.

The integration suites spawn the built binary (`CARGO_BIN_EXE_engined`) and drive the whole contract
through a real socket: the announce line, every op, a wrong token, a skewed `protocolVersion`, an
unknown op, a malformed frame, four concurrent connections, a request delivered **one byte at a
time**, and stdin EOF. `tests/harness/mod.rs` is the shared client; its stderr goes to `null`
because the suite refuses a great many connections on purpose — when a diagnostic matters, run the
binary by hand as above.

**The knowledge surface is proven in three places, and each proves something the others cannot.**
`cargo test -p knowledge` drives the indexes against the **committed bytes** — the real `items.json`
keys, the mob catalog's two spellings, the roster's alias statement, the era join, the overlay and
the at-most-once miss ledger — because a fixture would prove nothing about the corpus the product
ships. `ops::tests` drives the op table over its own isolated corpus (the shared one is a process
singleton, and a define in one test would be a hit in another). And `fold`'s `consider` and
`event_feed` tests prove the half that matters to the oracle: **with no lookup installed, `knowledge`
is absent from every row and the feed is empty** — the goldens' own claim, pinned against the one
change that could have broken it.

**The ingest is proven twice, and the two halves are different claims.**

* `src/ingest.rs`'s own tests drive it **in-process**, where a sink can be held still at a gate.
  That is what makes the awkward claims deterministic rather than timed: the health states walk
  `starting → attaching → folding → live` with the scan frozen at its first event; a second attach
  preempts a fold that is *provably* still running; each sink's stream is contiguous, so an
  interleaving would be visible rather than inferred.
* `tests/ingest.rs` drives it **over the socket**, against the real binary, and owns what a client
  can see: the frames arrive in the promised order, bounded and monotonic, and an appended line
  shows up as a live frame.

**And the fold is proven against a second fold** (`tests/module_snapshot.rs`). It attaches a staged
fixture to the real binary and, for **every module in `WIRING_ORDER`**, deep-equals the answer with
what a `fold::Fold` of the same bytes publishes — built beside it, in the test process, from the
same eight `ClusterDeps` fields. `respawn` is the one exception and is named rather than dropped: it
seeds an ordering clock from the construction instant, which is the attach engine-side and the
test's own `now` here, so it is compared for shape.

That is a SELF-CONSISTENCY claim and it is deliberately not a semantics one: it proves the path a
request travels — socket, op table, channel, ingest thread, registry — hands back what the fold in
that thread actually holds. `npm run oracle:rust-fold` proves the fold's semantics against the
recorded TypeScript snapshots on six slices of the owner's real log, and re-litigating that here
over a 900 KB fixture would be a weaker copy of a stronger test.

The other three claims in that file: a snapshot caught MID-SCAN deep-equals a fold of the same bytes
stopped at the `seq` it named (the prefix claim, which is the whole reason the design is a channel
rather than a lock); four non-module names are refused, `loot.ledger` among them; and health carries
the mark, the count, the log's clock and THE FILE'S OWN STAMP once live, and none of the four before
an attach — the last of those checked against a `std::fs::metadata` this suite takes itself, and
watched moving when the file does.

**The module comparison states its own precondition since JOS-481.** The engine ticks at go-live and
the oracle does not, so before comparing anything the suite ticks a SECOND oracle and asserts that
for these bytes the two publish identically. If a fixture ever ends with a buff standing or a
spell-set burst open, that assertion fires and names the reason instead of leaving a mystery
divergence in the loop below it.

**And the tick is proven where it can be held still** (`src/ingest.rs`'s own tests). A scan gated at
its first event, left standing through a whole tick interval, is never beaten; a world that has
reached `live` has PROVABLY already been beaten, and every beat it recorded carries the full scan's
event count; an idle live world keeps beating, monotonically, no faster than the cadence, off a clock
this machine agrees with.

All of them stage a copy of a committed fixture (`tests/fixtures/cw2-loadout-swap-aug2.log`) into a scratch
directory under the product's own file-name shape. **Every count is settled against
`eqlog::scan::scan_bytes` over the same bytes** — never against a number typed into the test, which
would stop meaning anything the first time the parser learned a line shape. Nothing here touches a
real game log.

**And the views are proven end to end** (`tests/views.rs`). That suite writes its OWN log rather than
staging a fixture, and that is the one place this crate does: the committed fixtures carry no loot at
all, and a claim about an ORDER needs a ledger whose every row is known. Four real loot lines, dated
after the launch anchor so the rebirth boundary fires on the zone line before there is anything to
lose, with the instants and the item names deliberately in DIFFERENT orders so that an assertion
about a sort by `at` is not silently an assertion about a sort by `item`. Over a real socket, against
the real binary: an unknown source is `notFound` and the connection survives it; a descriptor naming a
field the source does not carry is `badParams`; the fold's landing reset carries the rows, newest
first, with the cells the flat ledger draws; offset and limit are honoured while `total` ignores them;
a stated sort is the one the window arrives in; an appended line is an insert at the head; a FULL
window drops its oldest row in the same batch; three lines written in one breath are one frame; two
subscriptions over one source hold their own windows and one append reaches them differently; the
committed moments 01 and 02 are held against the engine's own frames by their field sets; and the
engine's serve-path measurement reaches stderr.

`update` ops are the one shape that suite cannot make, and it says so: `loot.ledger` is append-only,
so a live window over it produces inserts and drops. The op is proven exhaustively in
`views::diff`'s unit tests — changed cells only, an explicit null for a cell that went away,
newest-wins within a batch — against the ported client applier, with every case asserting that the
client would refuse nothing. **`tests/combat.rs` is where it is finally proven over a socket too**,
which is the coverage that source exists to give (see below).

**And the combat surface is proven end to end** (`tests/combat.rs`), all three of it. That suite
writes its own log like `tests/views.rs` does and goes one step further: **its timestamps are this
machine's clock**, because two of its claims are about the difference between a replay's instant and
a live world's, and a fight dated in a committed fixture is weeks stale by wall time — a meter cut
off one would have divided every rate by a fortnight. Over a real socket, against the real binary:

* a world with nothing attached has no meter and no history, and says `unavailable` to both;
* a LIVE snapshot is stamped with this machine's clock and **deep-equals a second fold built beside
  it and asked at that same instant** — the self-consistency claim `tests/module_snapshot.rs` makes
  for the registry, made here for the engine;
* a MID-FOLD snapshot (caught against eight copies of the committed fixture, failing outright if the
  scan finished first) is stamped with the LOG's clock — asserted as more than a day behind the host
  clock, a margin wide enough that the suite does not depend on when the fixture was recorded;
* a fight is findable by its mob and by its zone, through a transposition and through a deletion, and
  the coverage rule excludes a fight whose second query token matched nothing;
* an empty, a whitespace and a punctuation-only query each answer no hits beside a REAL corpus count;
* every limit — five million, zero, minus one, one, absent — is an ANSWER, because `world.ts` clamps;
* **a live window over `combat.live` produces `update` ops carrying changed cells only**, and the
  assertion is the sharp one: two rows move in one frame with DIFFERENT cell sets (your row sends
  `dps`+`total` and not `pct`; the other sends `dps`+`pct` and not `total`), and neither resends the
  four cells that say who it is;
* and a combatant the fight had never seen enters as an `insert` naming exactly one anchor, at the
  position its damage earns.

**And the defines are proven over the socket** (`tests/defines.rs`), against a real fold: a push made
BEFORE any attach is held and the fold is built holding it; a full-set replace forgets the previous
set completely and the empty set is a set (the ack counts zero, which is how a user who deleted their
last alert can tell it worked); a push made while the tail is LIVE reaches the fold that is running,
so the very next matching line sounds; and a def whose match is already in the staged log's HISTORY
fires nothing through the scan and fires exactly once when the line is appended — with `rule`,
`sound`, `message` and the log's own `at` asserted on the frame.

**The per-family effects are proven where the event can be handed over exactly** (`fold`'s own
suite, one worked example per family). Two of the five are read off module state a socket can also
see — `alerts`' published `defs` and `respawn`'s `prefs` — and the other three are behavioural:
a combo correction locks the span it names and labels it `user`; a roster edit adds a name the log
never named at the top provenance rung and removes one it did; and buff trust admits an external
caster's anchor, with the SAME two lines opening nothing under the shipped default. That last one is
the reason the split exists: proving it over a socket would rest the claim on which spells share an
emote in the committed catalog, which is a fact about the corpus rather than about the push.

**And the live surfaces are proven over the socket** (`tests/live_surfaces.rs`), which is the half no
unit test can reach — all three are about the boundary between the ingest thread and a connection
thread while a tail is actually watching a file. A HISTORICAL `/con` draws nothing and the same shape
appended live draws a card, header and all; a mark is refused with `status: idle` before any attach
and taken with `status: live` once the tail owns the file, twice, because a mark is stored nowhere
for a second press to collide with; one live loot line produces exactly ONE `moduleChanged` for
`loot` (the coalescing, asserted rather than assumed) carrying a name, a cursor and nothing else; and
a timer subscription over two live mezzes serves two rows in the debuffs window, with the buffs
window's own filter answering zero for the same fold. That last test writes its log lines from the
HOST's clock, and the reason is in its own header: a running timer is by definition recent, and a
fixture dated last week is swept by the live tick before anybody can subscribe to it.

## Reading order

* `src/main.rs` — the spawn contract, stated in full, and the accept loop.
* `src/spawn.rs` — the token, the announce line, the stdin watch. The announce line is a pure
  function because it is a cross-language contract.
* `src/wire.rs` — why one socket becomes two transports, and why no byte of framing lives here.
* `src/world.rs` — **the one door.** Read this before adding any state anywhere: it carries the
  cache-transparency laws (owner ruling 18) that every later phase inherits, and the critical
  section the epoch, the generation and the subscription resets all share.
* `src/ingest.rs` — **what an attach does**, the generation law engine-side, the sink seam, and
  `SnapshotAsk`: why a reader talks to the fold through a channel instead of a lock.
* `src/foldsink.rs` — **the join.** One `impl EventSink`, and the only place either crate's
  construction is spelled: what an attach builds, which `ClusterDeps` fields are app knowledge, how
  the combat engine is constructed, and — the one thing this file decides on its own — which clock a
  combat answer is stamped with.
* `src/views/mod.rs` — **the query.** The source registry, descriptor validation, and why a query
  FIELD is not a CELL. `views/diff.rs` is the engine half of the client's `applyDiff` and is written
  against it; `views/loot.rs` argues every cell of the first product source against the renderer that
  draws it; `views/meter.rs` is ruling 19's measurement. The other six sources each argue their own
  cells in their own header; `views/timers.rs` is the one to read second, because it carries the two
  arguments the rest inherit — why a clock-dependent value is served as its numbers, and why an order
  no column sort can express is published as a FIELD.
* `fold::modules::buff_timer_rows` — **the timer-row projection**, `src/shared/buffTimers.ts`'s model
  half. It lives in `fold` rather than in the view layer because two callers need it: the
  `timers.rows` source and, later, the alerts evaluator's `earlyWarnSec` (which is `timer_ends_at`
  minus the user's offset — the half JOS-482 was missing when it compiled those defs out).
* `src/concard.rs` — **the con card, resolved.** Boundary verdict 2 landing: what the engine can
  state today, why the chips are the empty five and what has to move before they are not, and which
  of the app's three refusals stay app-side and why.
  draws it; `views/combat.rs` does the same for the damage meter, against BOTH surfaces that draw
  one, and is the source whose rows edit; `views/meter.rs` is ruling 19's measurement.
* `src/search.rs` — the fuzzy scorer behind `combat.searchFights`, ported from `shared/fuzzy.ts` and
  `main/combat/fightSearch.ts`, with its header arguing why it lives in this crate rather than in
  `fold`.
* `src/foldsink.rs`'s `define`/`take_fires` and `fold`'s `Defines` trait — **app knowledge in,
  alert fires out.** The seam is one trait method each way; the alert matcher itself is
  `fold::modules::alerts_rules`, whose header names what it ports and what it deliberately does not.
* `src/ops.rs` — the op table, and the argument for why the inbound type is `serde_json::Value`
  rather than `ClientMessage`.
* `src/conn.rs` — one connection from hello to close, and the two-thread/one-outbox shape.
