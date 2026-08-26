# The Rust Data Server ("the engine")

Status: **design ratified by the owner 2026-08-24; ready to build.** This document is the
handoff for the Fable agent running the build program. The Linear ticket is **JOS-459**; its
comments carry the ruling history, and the rendered design one-pager (diagram, worked diff
examples) lives at https://claude.ai/code/artifact/dbb6689f-6d0b-4d5b-ac4f-27ccb6a8dc0c
(readable via WebFetch). Project memory carries the standing laws; this file is the
self-contained technical spec.

## Why (one paragraph)

Every launch/relog/switch replays the whole game log on Electron main, throttled to 60% of one
core; field telemetry (two reports, `coincident: 0`) measured 250–1186 ms main-thread stalls in
the post-replay minute, and the bench reproduced the class locally (585 ms stall 12 s after
replayDone, fold's own worst block 8 ms). The owner's verdict: the architecture makes politeness
fragile — the fix is a boundary, not another throttle. The fold moves into one Rust process that
parses, aggregates, compresses, and serves; the UI becomes a query/subscribe client.

## Owner rulings (all dated 2026-08-24, binding)

1. **Rust from the get-go.** No TypeScript staging phase for the engine itself.
2. **A data server, not just a worker**: it owns parse → aggregate → compress → serve.
3. **Performance goals are enforced in this process, at the parse boundary** — self-measured,
   CI-gated, reported as telemetry. Never promised.
4. **The renderer never munges domain data.** No list filter/sort/aggregation client-side;
   views arrive filtered, sorted, windowed, render-ready. Enforce by protocol shape, payload
   budgets, and a lint rule failing builds on `.sort()`/`.filter()` over domain collections in
   renderer code.
5. **No caching** — except, later and only maybe, INSIDE the engine behind a store seam so
   transparent even the engine's own API layer cannot tell cached from computed. Design the
   state stores behind that seam from day one; build no cache now.
6. **Combat history is sacred**: lossless compression only (finalized per-second buckets → derived
   histograms is fine; caps are forbidden), no functionality loss ever.
7. **Transport: a local socket** (most cross-platform). Loopback TCP on 127.0.0.1 with a
   per-launch token; one connection per renderer, brokered by main.
8. **Encoding: JSON** for the API contract.
9. **Speech/audio stays app-side**; the engine emits alert fires only.
10. **Crash without a cache is acceptable** ("same as an app crash today — it would just take the
    UI down"). A respawn is a launch. The engine **dies with the app**.
11. **Migration order is immaterial — all of it is required.** Phasing below is for risk, not scope.
12. **Equivalence fixtures are slices of the owner's real log, never committed**; prove
    byte-identical semantics, then cut over fully — before/after dual-running is a proof phase,
    not a permanent shadow. The TS fold is deleted in the cutover release.
13. Adjacent standing laws that shape this program: the app is **never in the machine's mouse
    path** (JOS-370); no wiki scrapes or committed-data regeneration while the perf/equivalence
    baseline holds (owner freeze, lift is the owner's call).
14. *(2026-08-24, JOS-464 gate)* **Protocol source of truth is a neutral JSON Schema** in its
    own `protocol/` folder; TypeScript and Rust types are both generated from it, committed,
    and pinned by a staleness test (the telemetry-doc/data-weight house pattern). Neither
    language is privileged.
15. *(2026-08-24, JOS-464 gate)* **Framing is one JSON message per line — behind a swappable
    transport adapter.** The owner's constraint verbatim: "make sure the way this works we
    could change the wire method at a later date and need to just swap an artifact. im
    thinking over the open internet via websockets etc." Nothing above the adapter may know
    the framing or the socket; a future WebSocket transport is a new adapter on each side,
    with the schema artifact and everything above it unchanged.
16. *(2026-08-24, correction)* **PowerShell was the AV trigger, not child processes** —
    JOS-182/184 removed `powershell.exe`/`reg.exe`/`wmic` launches because *those binaries*
    trip heuristics. A shipped Rust engine child process is acceptable; it must simply never
    shell out to PowerShell, and it joins the code-signing set like any shipped executable.
17. *(2026-08-24, JOS-464 shape ratification)* The wire shapes as built: uniform
    `{id, op, params}` request envelope; everything the engine sends carries one `kind`
    discriminant; rows are `{key, cells}` (identity outside the data); epoch messages are
    connection-wide and carry no request id; **`pct` is a float** (the owner overturned the
    worker's integer call — examples use fractional values so fixtures stay byte-verbatim
    across languages). The committed `protocol/fixtures/` are the verbatim truth over any prose.
18. *(2026-08-24, strengthens ruling 5)* **The parse-once cache is a stated later goal, not a
    maybe.** The owner's words: "our goal later is to build a cache underneath the datastore
    that requires us to parse up to a message only once… i want to think about cache semantics
    so that even within the rust apis/process, the caller doesn't need to think about it much."
    Build no cache now — but every interface is designed so a cache can appear underneath it
    TRANSPARENTLY, including to the engine's own internal callers. See "Cache transparency"
    below.
19. *(2026-08-24)* **The app's performance surface includes the engine's own numbers in the end
    state.** Owner verbatim: "the performance chip should incl perf of the server in end state."
    Surface 8 (`perf.budgets`/`perf.timeline`) is not just CI plumbing: the in-app performance
    panel and bug reports carry engine-side metrics (fold rate, serve latency, budget status)
    exactly as they carry main/renderer stalls today. Lands with phase 3; the JOS-458 instrument
    family becomes engine-native and stays user-visible.
20. *(2026-08-24)* **The owner is informed explicitly when the real client first tests against
    the server** — the moment a renderer surface reads the live engine (start of the phase-3
    cutover), not after. Standing notification obligation on the integrator.
21. *(2026-08-25, answering the lastPlayed sheet item)* **The server owns log-file facts.** Owner:
    "the server should be the one reading the log file, rather than the app reaching in… reported
    so the app can use it to display and choose the correct character on launch." The engine stats
    the file it owns and REPORTS the fact (health/attach surface, later a `logs.list` discovery
    surface); `lastPlayed` leaves the app's fold path at cutover; an mtime never enters fold
    state (it stays a served process fact, ruling 18 intact). Direction: log DISCOVERY itself
    migrates server-side — launch-time character choice becomes a served answer.
22. *(2026-08-25, answering the heartbeat sheet item)* **Thin client, ratified harder.** Owner:
    "it seems more and more like most of that business logic should live in the rust server and
    that the client should be relatively thin." The engine ticks its own modules while LIVE with
    its own clock (historical replay stays clockless — the equivalence law is untouched); alerts
    evaluate engine-side and FIRE over the stream; buff/timer/expiry logic lives engine-side and
    renderers subscribe to served views; the app keeps only OS surfaces (audio/speech playback,
    overlay windows, tray, presence, updater) per ruling 9. The app-side alert system reduces to
    "receive fire → make sound/show window".
23. *(2026-08-25, decision sheet 1a)* **The APP names the log directory.** `logs.list` discovery:
    the app pushes the directory path to the engine from its own settings (the store stays
    persistence truth per verdict 3; the engine never reads a settings file, and a fresh install
    has a list before any attach exists). The engine scans it and serves the list; launch-time
    character choice becomes a served answer (ruling 21's direction, now concrete).
24. *(2026-08-25, decision sheet 2a)* **The alert-arming window stays as shipped** — audio hands
    over on the supervisor's READY edge; the bounded catch-up gap is accepted. Owner verbatim:
    "we wont-be switching engines mid stride at all. i'm not releasing until this is done and
    tested." The residual dissolves at the deletion release (no TS evaluator to arm from), and
    go-live arming's mid-session ownership swap is rejected with it.
25. *(2026-08-25, decision sheet 3a)* **Render-cell locale is fixed en-US.** Cutover-ledger item 9
    closes. A pushed OS locale, if ever wanted, is a later additive attach field and a versioned
    impure input per cache law 4 — not built now.
26. *(2026-08-25, decision sheet 4a)* **The goldens outlive the TS fold as a one-release safety
    net.** On the commit before the deletion lands, `oracle:record` re-baselines the six slices'
    goldens (gitignored, machine-local); the slimmed engine-vs-goldens harness
    (`oracle:rust-fold`, no TS arm) gates the deletion release and phase-4 stabilization, then
    retires when CI budgets land. No Rust-side recorder is built unless the net is later made
    permanent.

## The shape

```
EverQuest client ──appends(sync, game thread)──> log file
                                                    │ reads bytes
        ┌───────────────────────────────────────────▼────────────────────────────┐
        │  DATA SERVER — one Rust process, below-normal priority                 │
        │  Tailer/Scanner → Parser → Fold (20 modules + combat engine)           │
        │        → Projections/Views (filtered, sorted, windowed)                │
        │  Knowledge corpus (items/spells/mobs/quests) lives here                │
        │  Budgets enforced here; [future cache behind the store seam — dashed]  │
        │  API server: query · subscribe · command  (JSON over local socket)     │
        └───────▲──────────────────────────────────────────────▲─────────────────┘
                │ supervises (spawn/respawn/token)             │ direct channels: views + diffs
        Electron main (window mgmt, OS: overlays,       Renderers (React): query/subscribe
        presence, tray, updater, audio out — no         hooks, loading/error/reconnecting
        game data, ever)                                states; never munges domain data
```

## The eight API surfaces

1. **Session & Control** (command): `session.attach(logPath)` — begins tail+fold, PREEMPTS any
   in-flight attach (last pick wins, never queued — JOS-457's generation ownership becomes
   protocol law); `session.progress → stream` (drives loading UI); `session.health`.
2. **Views** (query+subscribe): the heart. `view.query({source, filter, sort, window})` and
   `view.subscribe({...}) → stream`. Every list in the product becomes a view descriptor.
3. **Live World** (subscribe): character, zone, buff/debuff timer rows, roster. Silent during
   folds *by protocol*.
4. **Combat & Analytics** (query+subscribe): `combat.live → stream` (meter rows), historical
   `combat.encounters`, `combat.drilldown(id)`, `progress.levels` / `progress.xpRate(window)`.
5. **Knowledge** (query): `knowledge.item/spell/mob(name)`, `knowledge.search({...})` — the
   committed corpora move engine-side, indexed once, queried on demand (deletes ~12 MB from
   main's heap and eventually the renderer bundle's copies too).
6. **Alerts & Rules** (command+stream): `alerts.define(rules[])` evaluated at fold time,
   live-only by boundary law; `alerts.fires → stream`; app plays audio.
7. **Ingest** (command): `ingest.watch(kind, path)` for `/outputfile` dumps; `ingest.status`.
8. **Observability** (query+stream): `perf.budgets`, `perf.timeline` — the JOS-458 instrument
   family becomes engine-native; bug reports attach it, CI gates on it.

## The subscription diff protocol

Rules: **(1)** reset-then-diffs — every subscription opens with a full `reset` of the window;
**(2)** newest-wins coalescing per batch (~10 Hz live); an `update` op carries only changed
cells; **(3)** every message carries `epoch` — the world's generation; a character switch or
engine restart bumps it; the client drops state and takes the fresh reset; **resume is always
re-query** (reconnect-after-crash ≡ character switch); **(4)** rows are render-ready.

```jsonc
// subscribe — every request is {id, op, params}; the reply restates nothing (the op of the
// request whose id it names decides the result shape)
→ {"id":7,"op":"view.subscribe","params":{"source":"loot.ledger",
   "sort":[["at","desc"],["seq","desc"]],"window":{"offset":0,"limit":50}}}
← {"kind":"reply","id":7,"ok":true,"result":{"subscription":7,"subscribed":true}}
← {"kind":"reset","id":7,"epoch":3,"total":1834,"rows":[{"key":"loot:9412","cells":{...}}, ...]}
// live diff (a kill drops loot into a newest-first 50-row window). Rows are {key, cells}: the
// identity lives OUTSIDE the data so a reset row and an update apply the same way.
← {"kind":"diff","id":7,"epoch":3,"total":1835,"ops":[
   {"op":"insert","before":"loot:9412","row":{"key":"loot:9413","cells":{...}}},
   {"op":"drop","key":"loot:8790"}]}
// meter tick (10 Hz, changed cells only)
← {"kind":"diff","id":12,"epoch":3,"ops":[
   {"op":"update","key":"ally:Primitive","cells":{"damage":184220,"dps":412.6,"share":0.38}},
   {"op":"insert","after":"ally:Rowel","row":{"key":"pet:Vibartik","cells":{...}}}]}
// character switch / engine restart — epoch messages are CONNECTION-WIDE (the one stream message
// with no id); progress pct is a float (owner ruling 5b), fractional in examples so the fixture
// round-trips byte-verbatim through both languages
← {"kind":"epoch","epoch":4,"reason":"attach","progress":{"pct":62.4,"events":1571003}}
← {"kind":"reset","id":7,"epoch":4,"total":0,"rows":[]}   // per subscription, when the fold lands
```

These four moments are committed as `protocol/fixtures/01-04` and round-tripped by both languages'
suites — the fixtures, not this prose, are the verbatim truth (owner ratification 2026-08-24:
uniform `params` envelope; one `kind` discriminant on everything the engine sends; `{key, cells}`
rows; connection-wide epoch messages; float `pct`).

## Cache transparency — the parse-once goal (ruling 18)

The destination: an engine that parses any given log byte **once, ever**, with a cache under the
store seam so transparent that even the engine's own internal callers cannot tell cached from
computed. Nothing is built now; these are the interface laws that keep the door open, and every
phase-1/2 ticket inherits them:

1. **Determinism IS cacheability.** A checkpoint of fold state at byte offset N is only sound if
   the fold is a pure function of the bytes — which is exactly what the golden oracle already
   enforces (no wall clock, no host locale, no slicer dependence). Every determinism pin is also
   a cache-correctness proof; treat any new nondeterminism as a cache bug, not a style issue.
2. **Reads go through one door.** Internal Rust callers ask a store/world handle for state —
   never reach into a module's fields, never hold state derived from raw events across calls.
   The handle answering from a memoized checkpoint instead of a fresh fold must be unobservable.
3. **State is addressed by (log identity, byte offset).** The tail mark, the slice manifest, and
   any future checkpoint all speak the same coordinates: byte offsets on line boundaries. Keep
   it that way — an interface that addresses state any other way (wall time, "current") is
   hiding the coordinate a cache would key on. ("Current" = "as of the tail offset", and APIs
   should mean that explicitly.)
4. **Impure inputs are versioned inputs.** Anything pushed into the engine that changes parse or
   fold output (spell-db overlays, `*.define` commands, corrections) is part of the cache key.
   Keep such inputs few, explicit, and hash-friendly (full-set replace semantics — see command
   idempotency below), and never let a new impure input sneak into the parse path silently.
5. **A cache invalidates by version, never by patching.** Engine build + schema version + input
   hashes make the key; a mismatch is a full re-fold (which is exactly a launch). No incremental
   repair of stale state, ever — the crash-respawn story and the cache-miss story are the same
   story.

## Program feedback loop — ergonomics reviews after every worker

Standing practice (owner directive 2026-08-24): after each worker reports, mine the report for
protocol/doc changes — worker friction is design signal — and check it against how modern
sync-engine projects (Linear's sync engine, Replicache/Zero, Figma's LiveGraph) think about the
same problems. Gleanings land here; shape changes go through the owner.

From the first two workers (JOS-464/465), now law for later phases:

- **Codegen house rules (typify/json-schema-to-typescript friction, learned the hard way):** no
  cross-file `$ref` (bundle before generating); tag properties are single-member `enum`s, never
  `const` (typify lowers `const` to `serde_json::Value` and variants collapse); a multi-type
  scalar becomes `f64` in Rust — any type where integer identity matters gets a hand-written
  replacement à la `Cell`; generation ends in rustfmt, so the toolchain pin is load-bearing.
- **Test doubles must be as rude as the OS.** A `Cursor` over a complete buffer quietly grants
  the one property a real socket never provides (whole-message reads). `OneByteAtATime` in
  `engine/crates/protocol/tests/transport.rs` is the required harness for any framing work; the
  slicer-arm sweep is its fold-side sibling.
- **Commands are idempotent full-set replaces** (`alerts.define` carries the whole rule set, not
  a delta). This is the Replicache-family lesson: replayable, order-collapsing commands make
  crash-respawn trivial (replay the latest definitions) and make command inputs hash-friendly
  for ruling 18's cache key.
- **Resume-is-requery is the honest v1** of what Linear ships as "delta catch-up since
  lastSyncId, rebootstrap when too stale" — we ship only the rebootstrap arm, by ruling. If
  phase 3 measures reconnect cost worth optimizing, the upgrade path is a per-subscription
  monotonic sequence number on diffs; that is a schema version bump designed to be additive,
  not a rethink. Do not build it speculatively.
- **The UI is a cache of server truth** (the Figma/Linear framing) — we are stricter: the
  renderer never even re-derives (no munging, ruling 4). Any future "make the client smarter"
  proposal should be read against that ruling first.

From the phase-0/1 wave (JOS-466/467/468/469), added to the ledger:

- **An untagged union with `deny_unknown_fields` cannot answer `unknownOp`.** A request naming an
  op the build lacks fails to deserialize as a whole message and takes its `id` with it — and an
  error that cannot name a request id is a client that hangs. The receiving side keeps the raw
  frame alongside the typed parse and reads exactly `id`+`op` from it after the typed parse fails
  (engined's `ops::classify`). Known-op lists come from the generated tag enums, never literals.
- **Schema gap noted for phase 3:** `session.progress` acks with `SubscribeAck` (semantically
  exact — progress IS a subscription to the connection-wide channel); if the views work wants a
  dedicated ack arm, add it then.
- **Redact child streams at the door.** A child process can echo its own stdin — the first real
  boot proved it, putting the launch token one report away from `errors.log` and the fleet. Every
  line off a supervised child's stdout/stderr passes `redactToken` before anything reads it.
- **The JS↔Rust semantic divergence catalogue** (eqlog's `jsstr.rs`, each measured): JS `.`
  excludes FOUR line terminators (the regex crate's excludes one — embedded bare CRs in chat
  lines parse to nothing in TS and must in Rust too); JS `trim`/`\s` is the ECMA set, not
  Unicode `White_Space` (disagrees in both directions: U+FEFF, U+0085); `JSON.stringify` escapes
  only `"`, `\` and C0. And **key order is a code-path property, not a type property** — TS
  object literals serialize in per-branch insertion order, so byte-identical Rust serializes
  key-by-key at the branch, never via a derive.
- **`app.getAppPath()` is not the checkout on every dev launch** — against a built
  `out/main/index.js` it is that directory. Resource probes take `appPath` + `cwd` +
  `resourcesPath` (the `bundledImageRoots` trio).
- **A rejected token arrives as silence-then-FIN** — a clean close the transport rightly does not
  report as an error. Anything probing "is it up" must watch the close itself or the commonest
  refusal becomes the slowest timeout.

From the connect-and-serve wave (JOS-478/479/480):

- **An unknown filter/sort field is `badParams`, never accept-and-ignore** — serving every row
  while the client believes it filtered is the one answer that cannot be debugged. Consequence:
  the subscribe example below carried a `filter` the loot source doesn't serve; corrected to the
  descriptor a real client sends. A QUERY FIELD is not a RENDER CELL (`at` sorts as an instant,
  renders as prose) — every new source must declare both sets, and the split deserves a schema
  home eventually.
- **Every sort ends in the source's tiebreak** so order is total — EQ stamps to the second, and a
  shuffled window is diff churn. COROLLARY (JOS-484, caught by the DOM oracle's first run): a
  descriptor that wants newest-first must say so in BOTH terms — `[["at","desc"],["seq","desc"]]` —
  because the source tiebreak is ASC and a one-term `at desc` orders each same-second corpse
  group backwards. The worked example above is corrected.
- **Live-mode facts the equivalence oracle cannot see**: the app's wall-clock heartbeat and the
  mtime-in-fold (`lastPlayed`) surfaced only when the REAL client compared worlds — the two folds
  agree exactly; the machinery around them differed. Owner sheet items; the probe stays a neutral
  instrument with exemptions dated and path-pinned in the spec, never in the probe.
- **Queue time is named as queue time** in serve measurements — a coalescing cadence must never
  read as compute (ruling 19 discipline, first light: 29 µs fold-to-frame for a 3-row window off
  a 139,864-event fold).

From the JOS-497 wave (worker friction, all verified):

- **A relative `CARGO_TARGET_DIR` plus `--manifest-path` multiplies directories.** The combination
  resolves against the cwd and created an UN-IGNORED `engine/engine/target-verify` — the
  5,118-artifact hazard again. In a WORKTREE the precaution is unnecessary anyway: the worktree's
  own `engine/target/` is not the owner's locked directory. Brief law: workers in worktrees use
  the default target dir; only main-checkout cargo needs `target-verify`, and then as an ABSOLUTE
  path.
- **`tests/bench/rustParity.mts` hardcodes `engine/target/release/parity.exe`** and ignores
  `CARGO_TARGET_DIR`; a redirected build makes the oracle fail as `parity --snapshots exited
  null` — a spawn failure wearing a divergence's clothes.
- **The oracle needs BOTH fixture dirs** (`slices/` and `goldens/`), and junctioned fixtures fail
  on `character.logPath`: the golden encodes the recording checkout's ABSOLUTE log path. Worktree
  runs pass `--slices=`/`--goldens=` at the real dirs instead. The absolute path inside a golden
  is a recorded wart — the deletion release's golden work normalizes it or documents it.
- **Worktrees containing junctions must never be `rm -rf`'d** — unlink with `rmdir` first and
  verify the targets survived.

## Boundary verdicts (each resolves a census finding)

1. `combat.snapshot(now, opts)` — the only wall-clock-parameterized read: the now-evaluation
   moves server-side; fight/scope selection become subscription parameters, not app state.
   **SETTLED (JOS-485).** The op takes NO instant and the reply states the one the engine used:
   the process's own wall clock while the tail is live, `fold.last_ts()` at every moment before
   that. The discriminator is structural rather than a status copy — `EventSink::tick` is
   unreachable from the historical scan, so "has this sink been ticked" IS "is this world live" —
   which leaves the replay path a pure function of its bytes and the oracle untouched. Selection
   is an OP parameter (`opts.selectedId`) today; making it a SUBSCRIPTION parameter is the
   `combat.live` follow-up, whose source serves the default selection and nothing else so far.
2. The conCard hook (fold synchronously calls INTO Electron today): inverts to a server-emitted
   `world.conCard` stream event carrying the fully resolved card (resist profile joined
   engine-side); main only opens the overlay window.
3. Store-owned prefs the fold reads (alert defs, buff trust, respawn prefs, combo corrections,
   roster edits): store stays app-side as persistence truth; each is pushed into the engine as a
   `*.define` command on change. The engine never reads a settings file.
4. Fold-owned persisted artifacts move INTO the engine with their IO: resist ledger,
   message-overlay register, and the log tail mark (the engine owns the tail).
5. Item/mob knowledge caches + the ownLoot index: engine-owned (the mutual dependency dissolves
   in-process). The wiki FETCH stays app-side in v1 — app fetches on an engine miss-event and
   pushes the result in — so the engine ships without a network stack. Scrape throttles preserved.
6. `sessionMark` is a command with an accepted/refused reply; marks stay ephemeral (replay
   determinism).
7. The client spell table (`spells_us.txt`) parse is engine-owned.
8. Renderer-bundled corpora (mobs/quests JSON) move behind Knowledge queries during phase 3.

## The census (what moves, what stays)

Full inventory posted on JOS-459 (comment "THE BOUNDARY CENSUS"); regenerate any time with a
read-only sweep. Headlines: 20 registry modules + spellDb + CombatEngine (28 files) move; 18
synchronous main-side readers of fold state (only three are genuine queries; the rest mirror);
148 handle + 21 on IPC channels of which the fold-derived domains are world/knowledge/resist/
respawn/combo/roster/alerts/buffTrust/sessionMarks/conCard — the other ~120 are app-side and
stay; 9 construction-time + 14 post-construction impure injections; 21 persisted artifacts
classified fold-owned vs app-owned. The whole fold already runs Electron-free under plain node
(`tests/bench/foldArm.mts` constructs it with stubs) — the seam exists. `ModuleRegistry.list()`
is dead code from the canceled checkpoint (JOS-208) and can go.

## The equivalence oracle

Six uncommitted slices of the owner's real log, cut byte-exact on day boundaries, live in
`tests/bench/fixtures/slices/` with `manifest.json` (early-leveling 12.6 MB, mid-grind 29.0 MB,
sky-era 22.9 MB, patch-week 5.2 MB, hate-pets 8.2 MB, current 21.9 MB — chosen for mechanic
diversity: leveling, dense grind, Sky turn-ins, the Aug-18 patch shapes, charm pets +
auto-sell, current-era). The slicer script is reproducible (session scratchpad; trivially
re-derivable: byte-exact line-boundary cuts at first-line-of-day offsets). The bar:

- **Phase 1**: the Rust parser's serialized event stream is byte-identical to the TS parser's
  over all six slices.
- **Phase 2**: each module cluster's published snapshots deep-equal the TS modules' over all six
  slices, including adversarial split points (the JOS-208 differential-harness pattern, reborn
  language-neutral).
- Once green across the board: **full cutover; the TS fold is deleted in the same release.**

## Phasing (each independently shippable; TS pipeline stays the oracle until phase 3 completes)

- **Phase 0 — the seam**: protocol schema as a checked artifact both sides generate from; Rust
  process skeleton (health + echo); main-process supervisor (spawn/respawn/token); TS client lib
  with subscribe hook + loading states; e2e harness boots both. No game logic. **The first build
  ticket is the protocol schema.**
- **Phase 1 — the parser, proven** (tail + scan + parse; oracle above). Highest fidelity risk,
  smallest surface, proven standalone.
- **Phase 2 — the fold, proven in clusters**: (2a) simple appenders — loot, kills, leveling,
  turnIns, classUnlocks, outputFiles, spellSets, itemTiers, observedSpellRanks; (2b) character,
  roster, combo, respawn, progression; (2c) the hard five — buffs, buffTimers, consider, resist,
  alerts + eventFeed; (2d) the combat engine.
- **Phase 3 — serve layer and cutover**: views/subscriptions/epochs; renderers move to RPC hooks
  surface-by-surface behind one dev flag; alerts fire from the engine; both laws land (engine
  budgets + renderer no-munging lint); ends with the TS fold deleted.
- **Phase 4 — post-cutover**: budgets in CI against the pinned fixture (fold < 20 s at full
  speed on the 200 MB fixture with main p95 < 50 ms concurrently); JOS-461's burst class
  dissolves; the GC-wave items (JOS-226 lossless combat compression, JOS-462 item-corpus heap)
  become engine-internal where they are cheap.

## The cutover ledger (2026-08-25 — what remains to build, and what dies in the cutover release)

State at writing: phases 0–2 COMPLETE (ingest, all 20 modules + combat proven, serve layer first
light, app connected with the parity probe, packaging signed). Remaining to build, in rough order:

1. ~~Engine live tick + file facts~~ **DONE** (JOS-481) — except the `logs.list` discovery
   surface, still open (and carrying an owner question: who names the directory).
2. ~~`*.define` commands~~ **DONE** (JOS-482) — all five families push on connect and on change;
   fires stream live (logged, not played). TWO NAMED GAPS for the audio-cutover ticket:
   `earlyWarnSec` defs are compiled out of the engine evaluator (needs the timer-row projection),
   and Rust's regex refuses lookaround/backreferences V8 accepts — measure against the owner's
   real def set before cutover.
3. **The remaining view sources** — every list in the product. ~~`combat.live`~~ **DONE** (JOS-485)
   and it is where update-op coverage arrived: the meter's rows edit rather than append, so the
   diff protocol's third op is proven over a socket at last. The two combat OPS landed with it —
   `combat.snapshot` (verdict 1) and `combat.searchFights`. ~~ONE NAMED GAP: `hydrating` is `true`
   in every answer this build gives~~ **CLOSED** (JOS-488): the snapshot-time sweep block — charm
   sweep, ally expiry, pet nudge, deferred encounter closure — is ported, `set_live()` is wired to
   the go-live beat, and a live meter now closes a fight the log stopped talking about. The oracle
   stayed green without special-casing because the parity path has no tail to hand over to and so
   cannot enter the block. THE SMALLER GAP THAT REPLACES IT: the classification ring is still
   unported, so `recent` is `[]` in a live answer where the app publishes classified lines.
   ~~the Knowledge surface~~ **KNOWLEDGE DONE ENGINE-SIDE** (JOS-486): items/mobs/quests/posky
   `include_str`'d into a `knowledge` crate, indexed on first use, served as
   `knowledge.item/mob/spell/search`, with `consider`/`eventFeed` folding against the real lookups
   in the PRODUCTION construction only (the parity construction cannot reach a corpus — the crate
   depends on `fold`, never the reverse). Remaining of this item: the ~12 MB still ALSO lives in
   main's heap and the renderer bundle until the app's surfaces cut over; `knowledge.spell` carries
   a named gap (no effect classes/rank lineage/metrics — boundary verdict 7's client table +
   joins). ~~encounters/drilldown, the INCOMING meter, buff+timer rows, respawn, progression,
   kills~~ **THE REMAINING SOURCES AND STREAMS DONE** (JOS-487): buffs.active, timers.rows,
   respawn.watches, kills.recent, progression.recent, eventFeed.recent served; conCard,
   sessionMarks.add, moduleChanged live; the timer projection lands in fold where the alerts
   evaluator is its second caller. Still open in this item: encounters/drilldown and the INCOMING
   meter as dedicated views (the combat.snapshot op already carries both).
4. **Streams**: `alerts.fires` DONE as a stream (JOS-482; the AUDIO cutover — app plays from the
   frame and the TS evaluator dies — is its own ticket, owning the two named gaps above);
   `world.conCard` fully resolved engine-side still open.
5. **Renderer brokering DONE** (JOS-484: byte relay through MessagePorts, main never parses a
   frame; loot.ledger proven by DOM equality behind the dev toggle) — remaining surfaces cut over
   one-by-one, `useModule` → `useView`.
6. **Main's 18 sync readers rewired** (3 genuine queries → ops; mirrors → pushed streams);
   fold-owned persisted artifacts (resist ledger, message-overlay register) move their IO into
   the engine; `sessionMarks` as a command; `spells_us.txt` parse engine-side. **Wiki-miss events
   DONE engine-side** (JOS-486): the `knowledgeMiss` stream frame (connection-wide, no id, no epoch,
   each name announced at most once per process) and the `knowledge.define` push-back into the
   engine's runtime overlay both exist and are proven end to end. **THE APP-SIDE FETCH HANDLER IS
   NOT BUILT** — the half that hears the frame, runs `itemLookup`/`mobLookup`'s existing serialized
   queue with its 150 ms spacing and its `Retry-After` cooldown, and pushes the answer back. It is
   deliberately left to the surface-cutover ticket, because that is where the app stops asking its
   own lookups anything and the queue has one caller instead of two.
7. **Ruling 19 surface**: the in-app performance panel section is DONE (JOS-483: engine
   CPU/memory row, `perf.snapshot`, serve table, parity summary); `perf.budgets`/`perf.timeline`
   ops, CI budgets, and bug-report attachment still open.
8. **The no-munging lint** (ruling 4) failing builds on renderer sort/filter over domain data.
9. ~~Open owner item: the render-cell LOCALE (dates/numbers) as pushed app knowledge vs fixed
   en-US~~ **SETTLED** (ruling 25): fixed en-US.

**DELETED IN THE CUTOVER RELEASE** (ruling 12: once proven, move fully — one release):
`src/main/modules/**` (registry, wiring, all twenty), `src/main/combat/**`, the TS parse path
(`parser.ts`, `parse*.ts`, `scanHistory.ts`, `Tailer.ts`, `replaySlicer.ts`, `bus.ts`,
`rulesets.ts`, epoch/session detectors), main's spellDb load, `pipeline.ts` fold construction,
`session.ts` replay orchestration + heartbeat (attach forwarding remains), the replay gate, the
`module:*`/`combat:*` IPC and per-window snapshot fan-out, the fold-derived IPC families, renderer
`useModule` + client-side munging paths, renderer-bundled corpora. THE ORACLES RETIRE WITH THE TS
FOLD — goldenOracle/rustParity exist to compare two implementations and the cutover leaves one;
their successor is the engine's own budgets in CI against the pinned fixture (phase 4: G3 < 20 s
for 128 MB, main p95 < 50 ms concurrently), plus the tail/scan invariance suites which are
self-contained. App-side keeps: store/prefs, speech/sounds playback, overlay/window management,
presence, tray, updater, planner, maps, feedback/telemetry, triage.

## Related tickets & instruments

- JOS-459 — this program's ticket (rulings + census + phasing in comments).
- JOS-461 (post-replay burst, QUEUED) — dissolves in phase 3; a tactical fix before then is
  optional and must not fight this architecture.
- JOS-226 / JOS-462 / JOS-463 — GC-wave, owner-sequenced LAST.
- JOS-457/458/370/371 (all shipped in v1.10.0) — the preemption ownership model, the stall
  instruments (`shared/perfSeams.ts`, `main/perfAttribution.ts`), the mouse-path law, and the
  off-main disk discipline this engine inherits.
- Bench: `npm run bench:replay` (ledger `.bench/replay.jsonl`); pinned 209 MB fixture at
  `tests/bench/fixtures/Logs/` (gitignored); data-weight ledger `npm run gen:data-weight`.
