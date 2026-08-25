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
// subscribe
→ {"id":7,"op":"view.subscribe","view":{"source":"loot.ledger","filter":{"session":"current"},
   "sort":[["at","desc"]],"window":{"offset":0,"limit":50}}}
← {"id":7,"kind":"reset","epoch":3,"total":1834,"rows":[{"key":"loot:9412", ...}, ...]}
// live diff (a kill drops loot into a newest-first 50-row window)
← {"id":7,"kind":"diff","epoch":3,"total":1835,"ops":[
   {"op":"insert","before":"loot:9412","row":{"key":"loot:9413", ...}},
   {"op":"drop","key":"loot:8790"}]}
// meter tick (10 Hz, changed cells only)
← {"id":12,"kind":"diff","epoch":3,"ops":[
   {"op":"update","key":"ally:Primitive","cells":{"damage":184220,"dps":412.6,"share":0.38}},
   {"op":"insert","after":"ally:Rowel","row":{"key":"pet:Vibartik", ...}}]}
// character switch / engine restart
← {"kind":"epoch","epoch":4,"reason":"attach","progress":{"pct":62,"events":1571003}}
← {"id":7,"kind":"reset","epoch":4,"total":0,"rows":[]}   // per subscription, when the fold lands
```

## Boundary verdicts (each resolves a census finding)

1. `combat.snapshot(now, opts)` — the only wall-clock-parameterized read: the now-evaluation
   moves server-side; fight/scope selection become subscription parameters, not app state.
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
