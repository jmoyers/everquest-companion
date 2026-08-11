# AGENTS.md — EQ Legends Companion

Distilled operating manual. Per-task history lives in `git log` (messages are
detailed); this file holds only repeatable rules and load-bearing design.

## What this is

Electron (electron-vite) + TS + React + MUI desktop app that tails the
**EverQuest Legends** log in real time: an Overview landing tab (default
view — DPS w/ inline drill, live curve, current mob, zone, leveling rate +
next-level ETA, class loadout, recent drops/kills), Plane of Sky quest
tracking, loot, inventory reconcile, leveling/AA analytics (zone bands,
drag-select range stats), a Maps tab (Brewall/default rendering, POI
search, label declutter, floor slicing, pinned zone, typed-/loc marker),
class-combo inference with user
corrections, proc analytics (PPM + state attribution), raid targets, buffs
simulation, alerts with sounds + rank-upgrade intelligence, a Details-style
DPS meter with drill-down/timeline (drilled by default, pet nested), and
floating overlay meters, an EXALTATIONS tab (the Exaltation/BiS planner —
labelled Exaltations since JOS-42; the `planner` view id, route, store keys
and `planner-*` testids are unchanged, it was a label not a refactor —
multi-set socket planning over a class-filtered effect browser with layered era filtering —
docs/plans/exaltation-planner.md; era = zone provenance ∪ page dropsfrom,
page-top era banner resolves unknowns, shared/planner/*), celebration
toasts (docs/plans/celebration-toasts.md), and a TIMERS tab + overlay
(JOS-194: respawn clocks started by death messages, numbered from your own
kills — law 13 below). Committed knowledge DBs: mobs
(7.9k), items (11.2k incl. dropsfrom + eraTag), spells (1.9k), classes,
zones (era-annotated), wiki respawn floors (507 rows, 394 readable). First stable release v0.2.0 (2026-08-03); latest
release v0.8.0 (2026-08-07: maps N-S fix, Sky keyring counting, planner
21-cell board + slot-fact layer, alert sets round two, owner-tools gating,
engine fold ~2x — after v0.7.0 the same day: pet-question removal +
tell/leader binding + single-pet retirement, startup duty throttle + spell-DB
hash matching, replay overlay/mouse gate, character-switch delta silence,
custom-directory normalization, startup fleet telemetry, dev restart button). Layout: `src/main` (Node), `src/preload`, `src/renderer`,
`src/shared`, `tests/`, `scripts/`.

- Repo: `C:\Users\jmoye\everquest-companion` (public: github.com/jmoyers/everquest-companion).
- Game log: `C:\Users\Public\Daybreak Game Company\Installed Games\EverQuest
  Legends\Logs\eqlog_<Char>_<server>.txt` — but the path is auto-discovered +
  Settings-overridable now; NEVER hardcode, route through
  `config.ts effectiveEqRoot()/eqLogsDir()`.
- Active dev character: `Primitive@freeport`. The log is LIVE and growing.

## Operating model (how work happens here — this works, keep it)

- **Roles: Fable plans, Opus does — and that includes SUBAGENT dispatch
  (user rule, 2026-08-03).** The main session (Fable) is the integrator /
  designer / thinker: it diagnoses, designs, writes precise briefs,
  dispatches parallel Opus executor agents with DISJOINT file ownership,
  reviews their reports, runs the verification gauntlet, and commits per
  wave. Design/planning work — data models, API surfaces, plan review —
  is Fable's own job, never delegated to Opus planning agents; Opus
  subagents get concrete implementation briefs only (read-only
  research/fact-gathering subagents are fine). Executors do the work and report honestly — including
  when the brief is WRONG. An executor overturning the integrator's
  assumption with evidence is a feature, not insubordination (it has
  corrected real briefing errors: dispel attribution, venom stacking, the
  ratchet's item-category filter).
- **Work ships in WAVES.** 1–5 agents in parallel, then integrate → verify
  (typecheck + lint + full unit suite + e2e when main/renderer changed) →
  commit with a detailed message. Big projects (the lint campaign) are
  partitioned into disjoint waves with per-wave regression gates and run
  until done. The user gets a short "In flight / Settled" readout whenever
  a turn ends with agents still running.
- **THE BOARD IS IN LINEAR, AND THE OWNER STEERS IT (owner, 2026-08-05).**
  Canonical project management is the kanban in the owner's PERSONAL Linear
  workspace (Josh's Maker Space, team JOS — never the work workspace).
  `scripts/linear.mts` is the CLI (auth: `.triage/linear.env`, gitignored).
  The full loop is the `linear-board` skill (.claude/skills/linear-board) —
  the short form: SYNC fresh before every pick (the owner reorders,
  reprioritizes and cancels between reads; a Canceled ticket is a STOP order
  even mid-flight), the ticket IS the brief (`linear.mts show JOS-N`; bodies
  are self-contained build briefs), states are Todo → In Progress → Done
  only (no Backlog), tickets are END-TO-END improvements titled
  `Module / What the user gets`, and In Progress/Done moves carry
  wave-and-commit comments. Only owner-accepted work becomes a ticket.
- **BRANCH INTEGRATION RULES (owner, 2026-08-05 — one merge behavior, not a
  juggle).** Every worker commits on its OWN worktree branch, never on main.
  Before reporting done, the worker makes the branch MERGE-READY: full checks
  green at its tip (typecheck + lint + full unit suite + the e2e specs it
  touched), no stray diagnostics/junctions/tsbuildinfo noise in the tree, and
  — if main has moved under it — rebased onto current main (or explicitly
  reports the conflict it cannot resolve). The integrator then ALWAYS
  integrates by MERGING the worker branch (`git merge --no-ff`), one branch
  at a time, re-verifying on merged main before push, then deletes branch +
  worktree. Cherry-picking is reserved for salvage (a dead agent's WIP), not
  routine integration. Conflicts the merge surfaces are resolved by the
  integrator when small, bounced back to the worker when semantic. The
  destination is a PR model (workers push branches, review happens on the
  PR); these rules are that model minus the forge.
- **Planner/integrator diagnoses against the REAL log first** (grep/sed, or a
  throwaway `scripts/_*.mts` replay via `npx tsx` — delete after). Executors
  get verified findings, not hypotheses. Never write to the game log.
- **Golden-window tests are the law** (`npm test`, node:test + tsx). Any
  "world model looks wrong" report becomes a fixture FIRST: extract the real
  log span (`tests/fixtures/*.log` via `tests/extract-*.mjs`), hand-read it,
  write the expected state, fix until green. Priming fixtures warm learned
  state (classifier/overlay) the way a full replay would.
- **Fixtures are COMMITTED and SCRUBBED.** `tests/fixtures/*.log` is tracked
  (a `!tests/fixtures/*.log` negation under the blanket `*.log` in
  .gitignore), so CI's `npm test` runs the FULL suite; before this they were
  ignored and CI was red — most fixture-backed tests `readFixture()`
  unguarded and threw ENOENT, only the combat/healing windows had
  `skip: fixture not present` guards. The repo is PUBLIC, so every extractor
  MUST route through the shared scrub `tests/fixture-scrub.mjs`
  (`scrubKeep`) — never re-implement a drop list, never hand-copy a raw log
  span into `fixtures/`. Scrub = DROP the line; NEVER rewrite it with a
  placeholder (a rewritten line still parses into a fake event and would
  pollute the golden expectation). It drops third-party chat/social: all
  quoted speech (`, '` — a whole-log sweep proved the only non-chat lines
  carrying it are mob growls, so mob speech goes too and nothing parses it),
  `/who` output, group join/leave/invite/leader lines, and social emotes.
  It KEEPS combat, casts, buff landings/wear-offs, loot, turn-ins, zone
  lines, level-ups, AA, charm/pet lines and system messages.
  **CARVE-OUT: the pet-claim tell** `<Name> told you, '… Master.'` IS a tell
  but is spoken by an NPC pet and is the strongest binding signal for a
  summoned pet (law below), so it is kept verbatim — dropping it silently
  unbinds every pet in every combat fixture.
  **CARVE-OUT: the six pet-voiced SAYS** (JOS-47) — `Following you, Master.`,
  `Now regrouping, master.`, `Sorry, Master... calming down.`, `Now holding,
  Master.  I will not start new attacks until ordered.`, `As you wish, oh
  great one.`, `I beg forgiveness, Master.  That is not a legal target.` —
  matched as EXACT SENTENCES, never as a `/Master/` pattern (the sweep that
  enumerated them also found six kinds of mob flavor a loose pattern would
  leak: "None shall defile the realm of our master!" and friends). Same
  argument as the tell: an NPC's words under an NPC's name. They are the
  only public evidence an entity is somebody's pet — which is NOT evidence
  it is YOURS, and JOS-49 deleted the offer that used to pair them with a
  shared target (law below). The carve-out STAYS: every combat fixture in
  the tree is already cut through it, re-cutting them to drop six sentences
  buys nothing, the six still parse into `petSay` (the alerts editor lists
  the kind), and JOS-52 needed the family present to add the one say that
  does name an owner.
  **CARVE-OUT: the `/pet who leader` answer** (JOS-52) — `<Name> says, 'My
  leader is <You>.'`, EXACT shape, and the only pet carve-out that is
  SELF-GATED (`ScrubOpts.selfName`). The other two rest on "an NPC's words
  under an NPC's name, so nobody's privacy is at stake"; this is the first
  pet-voiced line to carry a PLAYER's name inside the quote, so it borrows
  the self-`/who` row's argument instead — your own name is yours to publish,
  a stranger's pet naming a stranger falls to the quoted-speech drop rule,
  and no `selfName` means no carve-out at all. `selfName` reaches an equality
  test and never a regex, so no crafted name can widen it.
  `p2-pet-arc-bound.log` was RE-CUT through it (measured: +1 line — the log's
  ONLY occurrence; p1 byte-identical; every golden number unchanged, because
  the line lands 68 s after that pet's own tell and `claim()` is idempotent).
  The user's OWN `/who` row (Primitive)
  is likewise exempt: it is the only line stating the class loadout and
  `extract-leveling-fixtures.mjs` needs it. Bystanders' NAMES survive in
  mechanical lines (kill credit, fizzle/interrupt, third-person buff-landing
  emotes) — those are load-bearing (own-cast gating, buff classification,
  entity retirement) and carry no one's words.
  **A REPORTER'S SLICE NEVER BECOMES A FIXTURE** (.gitignore `.triage/`: those
  slices are a user's own game log and never enter git). When a defect exists
  only in someone else's log, the window stays the OWNER's real bytes and the
  ONE sentence his log lacks is INJECTED as a parsed event in the test —
  quoted verbatim from the slice, cited by report id, with the mob's name
  swapped. petClaimWindows (the `… Master.'` tell) set the precedent;
  mobLifetapPlayer (JOS-48) is the case that needed it. Never hand-author a
  shape no real log has printed, and say in the header which line is injected.
- **Headless app test** (`npm run test:e2e`, playwright-core `_electron`): drives
  the REAL app end-to-end and asserts what the user SEES
  (`tests/e2e/combat-dashboard.e2e.mts`). Use it for anything a fixture replay
  can't see — layout, mount/empty states, hydration. `EQ_E2E=1` (src/main/e2e.ts)
  is the whole test mode: NO window is ever shown (main window is already
  `show:false`; overlays skip `showInactive`), the single-instance lock is
  skipped (runs beside the user's dev app), and the 'e2e' channel puts
  `userData` in a temp dir before electron-store loads (src/main/channel.ts) —
  so it's invisible while the user plays. Builds
  into `out-e2e/` (ABSOLUTE `--outDir`: a relative one resolves against each
  section's root and buries the renderer in `src/renderer/`) so it never races
  the dev watcher's `out/`. DOM + screenshot
  land in `tests/e2e/artifacts/` on failure (hidden-window screenshots are
  best-effort — an idle window may not composite).
- **THE E2E INPUT IS A COMMITTED FIXTURE, AND THE HARNESS PLAYS THE LIVE HALF**
  (JOS-29, wave E2 — docs/plans/e2e-parallel.md). It is no longer the owner's
  live log: `tests/e2e/logFixture.mts` stages a throwaway EQ install per launch
  (`<tmp>/Logs/eqlog_Primitive_freeport.txt`, a COPY of `tests/fixtures/e2e-*.log`)
  and hands it over with `EQ_INSTALL_DIR`, which `src/main/log/config.ts` already
  consults ahead of the registry and the drive sweep — the product knows nothing
  about it. Cut the fixtures with `npm run fixtures:e2e` (through the shared
  scrub, like every other extractor); each entry in
  `tests/extract-e2e-fixtures.mjs` states its span and what that span contains.
  Because the harness OWNS the copy, it can also PLAY: `appendAt()` writes whole
  EQ-stamped lines into the tailed file and they travel the real path
  (chokidar → Tailer → parser → engine → IPC → render). `tests/e2e/gameplay.mts`
  scripts a pull whose damage this repo STATES — ten hits, 442 points, four
  seconds — so the assertions are EXACT (`outTotal === 442`) where they used to
  be floors waiting up to 45 s for the owner to happen to be fighting. Map PACKS
  stay a game install: the maps spec junctions the real `maps/` dir in beside its
  fixture. Frozen numbers still rot for anything the fixture does not fix.
- **WAIT FOR THE CONDITION, NEVER FOR THE CLOCK** (wave E3). `tests/e2e/settle.mts`
  is the vocabulary: `settle(read, ok)`, `settleCount`, `settleGone`, and
  `settleStable` — which is how an ABSENCE is asserted (wait for the reading to
  stop changing, THEN assert nothing is there). Two raw sleeps survive in the
  whole suite and both are instruments rather than bets: the timeline samples
  geometry on a clock because change over time is its subject, and telemetry
  dwells past a second because `useViewDwell` ignores anything shorter. Two
  measured traps to remember: `requestAnimationFrame` can be throttled to
  nothing in a window that is never composited (a bare two-frame wait took two
  seconds — `nextFrames` races a timer), and `hoverAt` must clip an element's
  box against every CLIPPING ANCESTOR and verify with `elementFromPoint`, or a
  chart inside a scrolling column gets a drag delivered to whatever is really
  under that screen point (that was the leveling red, for weeks).
- **Frozen numbers rot**: the live log grows, so full-log assertions must be
  identities (`earned == allocated + unspent`), monotonic floors, or
  anchor-independent invariants — never `== <today's count>`.
- **Regression gates**: model refactors prove untouched dimensions
  byte-identical (taxonomy added categories; total damage stayed exact).
  Run baseline before changing, diff after.
- **Concurrent agents**: disjoint file ownership; re-read shared files
  (index.ts, ipc.ts, types.ts, preload, App.tsx) immediately before each
  surgical edit. errors.log noise from mid-edit HMR is normal — judge by
  final typecheck/tests and check timestamps before blaming current code.
- **PATH-SCOPED COMMITS (integrator law, learned the hard way 2026-08-03).**
  While waves overlap, the integrator stages EXPLICIT file lists from the
  finished agent's report — never `git add <dir>` and never `git add
  tests/fixtures`. Broad adds swept in-flight files three times in one day
  (another agent's fixtures; half of a preload edit, leaving HEAD unable to
  typecheck in isolation; a view importing untracked files, leaving HEAD
  unbuildable from a clean checkout). After any commit touching shared hot
  files, sanity-check that HEAD is self-consistent. A follow-up commit says
  "completes <sha>" when it repairs one of these.
- **Mid-flight course changes go BY MESSAGE to the owning agent** (owner
  amendments, hazards discovered by a sibling wave) — never by dispatching a
  second agent into owned files, and never by the integrator editing them.
  An agent that stops "to wait" for its own e2e run is STOPPED — a message
  resumes it; don't ping-pong twice, finish its integration yourself from
  `git status` + its interim report (wave T precedent, 2026-08-05).
- **Wave choreography, distilled 2026-08-05 (25-wave session):**
  - A file carrying TWO waves' hunks lands with the LATER wave's commit +
    a "completes <sha>" note (App.tsx with toasts+deep-links;
    windowControls with fightSelection+levelUp). Never `git add -p` a
    shared hot file into halves.
  - `git status --porcelain | grep '^[MADR] '` BEFORE every commit — the
    index is shared and a sibling's staged deletion WILL ride your commit
    (6db8790 swept one; its wave's later commit completed it).
  - **e2e runs PARALLEL and from a worktree** (wave E1,
    docs/plans/e2e-parallel.md). The isolation unit is ONE LAUNCH — a
    `mkdtempSync` userData dir per `launchApp()`, artifacts under
    `artifacts/<runId>/<spec>/` — so the old single-flight law is retired:
    concurrent runs no longer EPERM-destroy each other (that is what made
    5/13 and 6/13 tallies pure noise). The runner discovers `*.e2e.mts`,
    takes a name filter (`npm run test:e2e -- leveling`), caps each spec at
    5 min, prints per-spec times and writes `artifacts/<runId>/summary.json`;
    `--serial` remains for debugging. `node_modules` is resolved, not
    joined, so a worktree with no install runs the suite. MEASURED
    2026-08-05: two full suites racing from one worktree, 12/13 each at
    179.6 s and 179.4 s wall (solo 171.4 s; serial was ~28 min), zero EPERM,
    identical single red. E2/E3 then took the input off the live log and the
    sleeps out of the specs (JOS-29, above): MEASURED 2026-08-06, 13/13 twice
    consecutively from a worktree at 150.4 s and 148.2 s. The one long-standing
    red — leveling's chart-drag range panel — was the harness's own `hoverAt`
    and is fixed.
  - **The awaiting-sample law generalizes**: no file format, log
    annotation, or era claim ships from imagination — outputs kinds refuse
    typed until a real fixture graduates them; Double Bow Shot waits for a
    bow log; era waited for zones. "Structurally covered" ≠ verified —
    say which.
- **Feedback triage loop (proven 2026-08-05, three same-day turnarounds):**
  report → integrator diagnoses against the REAL log/slice FIRST (the
  Dragon Punch "feature" was a labeling gap; the onboarding "docs issue"
  was two real defects; the brief's diagnosis was WRONG twice and the
  executor's evidence overruled it) → wave → stamp `triaged` with an
  honest note via `triage-feedback set`. Reports with slices: the slice
  may prove more than the prose (the /log-on first line WAS the bug).
- **Product lens (owner, 2026-08-05): deepen existing surfaces by
  default; net-new surface area gets the suspicion test — fits the
  real-time companion vision? achievable live from the log? or
  performative? (Faction tracking parked by exactly this test; the
  outputs ENGINE shipped surface-free instead.)
- **During parallel waves, red is ambient; final reports are the truth.**
  Executors report other agents' failures SEPARATELY from their own (whose
  file, what error). eslint's cache lies after cross-agent deletes — errors
  at line numbers past a file's length mean `rm -rf
  node_modules/.cache/eslint`, not code. A throwaway `scripts/_*.mts` left
  behind breaks `typecheck:node` for everyone: delete before reporting.
- **Plans go stale while agents fly.** Line ranges, counts and tables in a
  design doc describe the log/tree at planning time — executors re-derive
  them fresh and treat every measured claim as re-checkable. The session's
  scoreboard: ~20 briefing errors overturned by executor measurement, zero
  overturned briefs that turned out right. Reward the overturn, then encode
  what it taught.
- **KEEP THE TREE BUILDABLE (user rule, 2026-08-03): the dev app must not
  stay down.** Transient seconds-long HMR breakage is fine; MINUTES is not.
  Concretely: create any file you import (even an empty stub) BEFORE writing
  the import — a scrape/codegen that produces a data file the code needs gets
  a stub first and overwrites it when done (this exact miss took the app down
  for the length of a mob-page crawl); sequence multi-file changes so
  `npm run dev` keeps compiling between edits; if you must break main's build,
  fix it in your very next edit, not at wave end.
- Commits: integrator commits per wave, detailed messages,
  `Co-Authored-By: Claude`. Keep `npm run dev` (watch) running — main edits
  auto-relaunch, renderer edits HMR.

## Toolchain gotchas

- Node/git/gh NOT on PATH in fresh shells: prepend `C:\Program Files\nodejs`,
  `C:\Program Files\git\bin`, `C:\Program Files\GitHub CLI`.
- NO RAW CONTROL BYTES IN SOURCE FILES — spell escapes out (`\u0000`, not a
  literal NUL). A NUL as a "collision-proof key separator" is a fine idea and
  has now been written as a raw byte twice (JOS-133, JOS-150); git classifies
  the file as binary, diffs/blame/grep go dark, and the integrator has to
  respell it. Same runtime value either way, so there is no reason to ever
  emit the byte.
- Backticked EQ names (`Innoruuk\`s Chosen`) break inline `node -e` — use
  temp script files.
- Errors harness: main+renderer errors append to `<userData>/errors.log` AND
  dev stdout, grep `[everquest-companion:error]` (source tags:
  `main:uncaughtException`, `renderer:ErrorBoundary`, …). `<userData>` is
  PER CHANNEL (below) — a dev-app error is in
  `%APPDATA%\everquest-companion-dev\errors.log`, the installed app's in
  `%APPDATA%\everquest-companion\errors.log`. Info logs use the
  `[everquest-companion]` prefix. ErrorBoundary prevents blank windows. Check
  it first when anything's weird.
- `npm run typecheck` (node+web) before done. Data JSONs (spells, overlay
  baseline) are ES-imported so electron-vite INLINES them — a path-relative
  readFile would miss in `out/main/`.
- TS: discriminated unions with union-typed tags need a single-guard
  narrowing (`if (ev.t !== 'dmg') return`); `@shared/*` value imports need
  the renderer `resolve.alias` in electron.vite.config.ts. Node-tested
  pure modules use RELATIVE value imports (type-only may keep the alias) —
  the mobSearch.ts precedent, now repo-wide.
- Vite 5 inlines JSON as PRETTY-PRINTED object literals unless
  `json: { stringify: true }` — measured 1.56× bundle bloat on items.json
  before the flag. Keep it set for the main bundle.
- Blink scrollbars: setting the STANDARD props (`scrollbar-width`/
  `scrollbar-color`) switches to native Fluent bars and SILENTLY IGNORES
  every `::-webkit-scrollbar-*` rule — the two are mutually exclusive.
  The themed inset scrollbar lives in theme.ts + overlay.html (values
  must move together; the overlay is MUI-free and can't import tokens).
- `flexWrap` converts content overflow into HEIGHT — a "compact bar"
  contract means `nowrap` + one shrinkable/ellipsizing group for
  world-supplied text (tooltips keep the facts); controls never shrink.
- Chromium `navigator.clipboard` needs a permission this app denies
  wholesale — clipboard writes route over IPC to main's clipboard API.
- **A dynamic `import()` is BUNDLED, not externalized** — "it's a devDep so
  production can't load it" is FALSE by default: the triage tab's first
  build shipped 917 kB of working AWS SDK into `out/main` with only a
  boolean guarding it. Dev-only main-process code must ALSO be listed in
  `externalizeDepsPlugin({ include })` so the emitted chunk carries bare
  unresolvable `require`s. Measure the built output; never trust the
  dependency graph's intuition.
- **Never reference a vite `define` bare.** Defines exist only from
  dev-server START — config edits never hot-apply, and a bare identifier
  in a stale server is a `ReferenceError` that blanks the whole app (it
  did, 2026-08-04). ONE guarded reader
  (`typeof __X__ !== 'undefined' && __X__`) per flag, everything imports
  it; a stale server degrades to feature-hidden. Config changes (defines,
  entries, externals) require the OWNER to restart `npm run dev` — say so
  in the report.
- **…and anchor a dev-only flag on `import.meta.env.DEV`, not on the
  `define`.** Feature-hidden is still a SILENT wrong answer — the Triage
  tab went missing with no error to grep (2026-08-03). Vite's builtin
  needs no config, is true on any dev server however old, and is a
  literal `false` in a build, so the strip guarantee is unchanged:
  `import.meta.env.DEV && (typeof __X__ === 'undefined' || __X__)` —
  absent define means STALE SERVER, degrade upward — and log the resolved
  value once at renderer boot behind the same `DEV` guard.
- **OWNER tooling needs `EQ_OWNER_TOOLS=1`; plain DEV is not enough** (JOS-72).
  The dev flag is now TWO tiers: tier 1 (dev restart, `UNRELEASED`, boot
  diagnostics — credential-free contributor conveniences) stays on plain
  `import.meta.env.DEV`; tier 2 (the Triage tab + every `triage:*` handler,
  which read the owner's DSQL/S3/CloudWatch) additionally requires the env var
  at BOTH ends — main refuses to register the IPC (`src/main/ownerTools.ts`)
  and the renderer hides the nav row (`OWNER_TOOLS` in devFlags.ts, the one
  guarded reader, fed by `window.eq.ownerTools` out of the preload). It exists
  because `app.isPackaged` is FALSE in a SELF-COMPILED build from this public
  repo, so a stranger's macOS recompile came up holding the owner's backlog
  tab. Tier 2 degrades **CLOSED** — the opposite of the tier-1 degrade-upward
  rule; policy in `src/shared/ownerTools.ts`. electron-vite has NO `.env` →
  `process.env` path (it only `define`s `*_VITE_*` into `import.meta.env`), so
  the owner sets it in the SHELL: once per machine with
  `setx EQ_OWNER_TOOLS 1` (new shells only, nothing committed), or per session
  with `$env:EQ_OWNER_TOOLS='1'; npm run dev`. Never commit it, and never put
  an AWS profile name in the gate.
- MediaWiki: anonymous `eilimit` caps at 500; >50 pageids per revisions
  batch returns HTTP 200 with ZERO pages and no warning — BATCH=50 is
  measured, not tunable.
- **`setTimeout(n)` IN THE MAIN PROCESS DOES NOT LAST n ms** (MEASURED
  2026-08-06, Electron 43.2.0 on Windows 11, 80 samples per row). Windows
  runs a 15.6 ms timer quantum and nothing in this process raises it, so a
  sleep ends at the next TICK EDGE after the time requested: idle,
  `setTimeout(2..15)` all deliver ~15.6 ms and `setTimeout(16)` delivers
  ~31; after a 12 ms burn, `setTimeout(4..16)` all deliver ~19.2 ms while
  `setTimeout(0..1)` deliver ~3.6 (the rest of the current tick).
  `setImmediate` returns in 0.01–0.06 ms and is not a pause at all. So a
  work/rest cycle SNAPS TO THE GRID and no fixed argument buys an arbitrary
  duty — anything pacing itself with a timer must MEASURE what it got and
  bookkeep the difference (`replaySlicer.ts`'s debt ledger is the pattern),
  never trust the nominal argument.
- **`setFocusable` IS NOT AN ATTRIBUTE WRITE ON WINDOWS — IT MOVES THE
  FOREGROUND WINDOW** (JOS-199). Electron's own doc note gives it away: "on
  macOS it does not remove the focus from the window", i.e. everywhere else it
  does. `setFocusable(false)` DEACTIVATES the window, and Chromium's deactivate
  walks the Z-ORDER and `SetForegroundWindow`s the first VISIBLE window below
  it — which, under an always-on-top overlay, is EverQuest. `setFocusable(true)`
  ACTIVATES. So the call is not idempotent and must never be "re-asserted": two
  reported bugs came from `setOverlaysHidden` re-stating the locked mode on
  five visible topmost windows, which yanked the user back into the game on
  every alt-tab. Focusability is a WINDOW STYLE (WS_EX_NOACTIVATE) and survives
  hide/show, so there is nothing to re-assert — set it in the CONSTRUCTOR
  (`focusable:`) and afterwards only when `isFocusable()` disagrees.
  `tests/overlayFocusPolicy.test.mts` pins the one call site.

## Linting (ESLint 9 flat config + the ratchet)

`npm run lint` gates CI in BOTH build.yml jobs, right after typecheck. Full
rationale lives in the header of `eslint.config.mjs` — read it before touching a
threshold. The short version:

- **Two layers.** Correctness: typescript-eslint `strictTypeChecked` +
  `stylisticTypeChecked`, type-aware through TS's project service (which resolves
  every file through the same two tsconfigs `npm run typecheck` builds — lint and
  typecheck can never see different file sets), plus react-hooks for the
  renderer. Factoring: `complexity 12`, `max-depth 3`, `max-lines 400`,
  `max-lines-per-function 100`, `max-params 4` (line counts skip blanks AND
  comments — this repo comments heavily on purpose; the metric is code mass).
- **Those five numbers were MEASURED, not guessed.** `npm run lint:measure` re-runs
  ESLint with the rules pinned to `max: 0` so every site reports its actual metric,
  and prints the distribution + a threshold sweep (raw output:
  `scripts/lint-measure.txt`). Each threshold sits between p95 and p99 of the real
  tree. Never change one without re-running it — including `max-depth`, which is 3
  rather than the obvious 4 *because* the data showed 4 would catch three sites in
  the whole repo.
- **THE RATCHET ONLY SHRINKS.** `eslint.ratchet.mjs` is a GENERATED per-file
  rule-off block listing exactly today's violations, so lint is green with zero
  source changes. It is a debt register, not a permission slip. A wave DELETES the
  entries it fixed and re-runs `npm run lint` to prove the deletion was earned.
  **Adding an entry is the integrator's call, never an executor's**, and
  regenerating wholesale (`npm run lint:ratchet`) to make a red build green
  silently widens it and defeats the whole design. `EQ_LINT_NO_RATCHET=1 npx
  eslint .` shows the true state.
- **Refactor-wave law.** `lint-worklist.md` (generated beside the ratchet)
  partitions the inventory into five disjoint waves — A `src/main/combat/**`,
  B `src/main/**` rest, C `src/renderer/src/features/combat/**`, D renderer rest +
  overlay, E `src/shared` + `src/preload` + `scripts` + `tests` — so agents can
  run in parallel on non-overlapping files. Every wave is
  **BEHAVIOR-PRESERVING ONLY**: no fixes, no feature changes, no "while I was in
  here". Full `npm run typecheck` + `npm test` after each wave, and the engine
  waves (A and C) additionally need the byte-identical regression gate — baseline
  the damage totals before, diff after, they must match exactly (World-model law
  8's tripwire). Keep the tree buildable throughout (see Operating model).

## Architecture

```
scan (live:false) + Tailer (live:true, byte-offset handoff — LOSSLESS seam)
   └► parseEvent (ONE pass, seq-numbered) ─► LogBus
        ├► derived events: bus.emitDerived queues, drains AFTER the primary
        │  event (no re-entrancy). Producers: buffs (buffExpired), epoch.
        ├► ModuleRegistry ─► EqModule { id, reset(), onEvent(ev, live),
        │    onTick?(now), snapshot()→{seq,state}, flushDelta()→delta|null }
        │  Live deltas push `module:delta` (throttled); replay is silent.
        │  A 1s wall-clock tick drives time-based logic while the log idles.
        │  A REPLAY IS A BRACKETED STATE (JOS-60), not just a per-event flag:
        │  `registry.beginReplay()/endReplay()` around the scan, every push
        │  path gated by it, and endReplay DISCARDS what the fold accumulated
        │  (modules append to `pending` whatever `live` says — the push is the
        │  registry's call). The heartbeat stops for the duration too.
        │  Modules incl. `progression` (columnar exp/kill/zone analytics,
        │  capped w/ windowStart honesty, recent-kills ring) and `combo`
        │  (registered FIRST; evidence → candidate-set slots → fuzzy
        │  intervals; corrections TIME-keyed in the store, v3 migration).
        └► CombatEngine (pull-snapshot variant: `combat:snapshot` IPC +
           throttled `combat:activity` nudge; per-encounter event ring for
           the timeline; cached finalized summaries; capped payloads;
           session state timeline + proc detection/PPM/attribution —
           procDetect/procWindows/procViews, all law-8 additive)
Maps: src/main/maps (pack discovery/per-layer cross-pack merge/LRU/search,
Electron-free w/ injected roots) over shared/maps types + shared/zones
(THE zone-knowledge table); renderer features/maps (canvas geometry, DOM
labels w/ collision declutter, floor slicing). Pure fns + goldens all over.
  **`mapFromLoc` IS THE ONE `/loc`→map SEAM** (`mapX=-ew, mapY=-ns`, y grows
  SOUTH — JOS-65). Wiki mob pins and the user's typed-/loc marker (JOS-98,
  `eq.maps.loc`, per zone) both go through it and then through `project`;
  a second copy of those negations is the bug this repo already shipped once.
Renderer: useModule(id, applyDelta) — hydrate, seq-dedupe deltas, re-hydrate
on `log:character`. Overlay = second renderer entry (overlay.html) with a
minimal `eqOverlay` bridge (transparent alwaysOnTop, click-through pin).
```

- **A WINDOW THAT FOLDS A MODULE NEEDS BOTH HALVES OF THE TRANSPORT — THE DELTAS
  AND THE REBUILD** (JOS-172). `module:delta` is an INCREMENT, and a historical
  fold emits none: `endReplay()` DISCARDS what it accumulated (JOS-60's rule, and
  it stays). So "hydrate once, then ride deltas" is only complete if something
  says *ask again* — which is `log:character`, and which the main window's
  `useModule` has always re-hydrated on. The OVERLAYS did not: they are created in
  the same `whenReady` turn that started the fold (index.ts restores open kinds
  right after `startTailing`), so an overlay that was ALREADY OPEN at launch
  hydrates at a random instant PART-WAY through months of log and then rides
  increments describing none of it. A charm or an Ensnare that genuinely survived
  a restart was in the model, on screen in the app, and absent from the floating
  window whose whole job is to show it — until some later live event happened to
  touch that module, which on an idle log is never. `sendWorldRebuilt`
  (pipeline.ts) is now the ONE answer to "who is told the world was rebuilt": the
  main window and `MODULE_READING_OVERLAYS`, and every `IPC.onCharacter` send goes
  through it. The fix is the DELIVERY, never the discard — exempting a module from
  `endReplay` would ship its whole history as an increment again, which is exactly
  the shape that made every celebration detector re-fire on a character switch.
  **And re-hydration is a SECOND reason a row can vanish**, so anything watching a
  row set for removals has to be told which kind of change it is looking at: the
  buffs overlay's drop flash takes a `rebuilt` flag (`timerDrops`,
  shared/buffTimers.ts) and says nothing across a re-fold, or it would greet the
  user by announcing four spells that dropped months ago. **Measuring this in e2e
  needs a SLOW fold**: a committed 1.6k-line fixture folds faster than a second
  BrowserWindow loads its bundle, so the first cut of the restart step passed with
  the bug still in the tree and said so (`hydrating:false` at the moment the
  overlay bridge came up). `tests/e2e/buffRestartSteps.mts` pads the log with 400k
  real lines (~4 s) and CHECKS that the fold was still running.
- **A MODULE WITH A SECOND INPUT MUST REPORT ITS OWN REVISION AS `seq`, NOT
  THE LAST EVENT'S** (JOS-87, measured in the running app). `useModule` dedupes
  with `if (d.seq <= knownSeq) return`, and `knownSeq` comes from the hydration
  snapshot — so "the last LogEvent seq folded in" only works as a revision
  counter for a module whose state moves ONLY when an event moves it. The combo
  module has a second input (a user correction, which re-labels every interval
  and advances no log seq at all), and a correction written while the log was
  idle produced a delta the renderer dropped as a duplicate: the store had it,
  the model had it, and the screen kept showing the wrong answer until the next
  log line happened to arrive. On an idle log — which is exactly when a user is
  in Preferences fixing something — that is forever. The fix is a private
  counter bumped by anything that can change the state (`ComboModule.markStale`,
  reported by BOTH `snapshot()` and `flushDelta()` so hydrate and delta share
  one clock); `seq`'s only consumer is that dedupe, which asks for nothing but
  "strictly increasing when the state changed". The other half is the PUSH:
  `invalidate()` alone waits for the 1 s heartbeat, so an out-of-band write
  calls `registry.flushNow()` (ipc/combo.ts `republish()`). Both are needed —
  flushing promptly is useless if the push is then dropped. A unit test cannot
  see either half; `tests/e2e/loadout-override.e2e.mts` is what caught it.
- **Character epochs**: character-scoped state (leveling/AA, loot, kills,
  turnins, buffs live-state) resets at the epoch boundary — anchored at
  OFFICIAL LAUNCH 2026-07-28 (`epochDetector.ts`; the user's beta character
  shared this log file pre-launch). Do NOT use level regression (loadout
  swaps legitimately change level). Game-knowledge (mined durations,
  message overlay) persists across epochs.
- **A LOGOUT PAUSES YOUR CHARACTER, NOT THE WORLD — SO BUFFS FREEZE AND
  DEBUFFS DO NOT** (JOS-134, owner's design 2026-08-09). EQ saves each buff's
  REMAINING duration across a camp and resumes it at login, so a surviving
  beneficial instance has its clock shifted forward by the absence
  (`BuffInstances.onOfflinePause`; the S5 fixture proves it to the second — a
  16-minute haste that wears off 13h58m of wall clock after it landed can only
  exist if the timer stopped). A debuff you left on a mob is a timer in the
  WORLD, which kept running, so its clock is never shifted and the ordinary
  hygiene pass retires it on schedule; `modules/buffTimers.ts` takes an
  EXPLICIT no-op on `offlineGap` so the asymmetry reads as design rather than
  omission. **The boundary is evidence, not a timeout**: a log hole
  (`SESSION_GAP_MS`) no longer decides anything by itself, because it is
  ALWAYS observed before the thing that explains it — every login prints a
  0-22 s reconnect preamble first, so the old on-sight wipe ran and the
  derived `offlineGap` arrived to pause an empty model. `modules/buffsSession.ts`
  holds the question open for `LOGIN_CONFIRM_MS` (deliberately the detector's
  own `RECONNECT_WINDOW_MS` — same question from opposite ends) and drops the
  pre-hole instances only if no login ever turns up. **And the learner refuses
  BOTH halves of a cycle that spans an absence** (`spannedGap`): a buff's span
  contains frozen time that is not duration, and a debuff's span is world time
  whose fade LINE could only print once you were back to see it — so it dates
  your return, not the expiry. Both err LONG, which is the direction law 5's
  recency-weighted MAX is most sensitive to, and `fromTs` is a documented lower
  bound, so subtracting the gap would leave residue pointing the same way.
  Censor, never correct. Zoning is not a logout; death still clears (JOS-88).
- **Spell DB**: `src/main/data/spells.json` (~1.9k spells from eqlwiki
  `Template:Spellpage`: durations, cast/wear-off messages, illusion flag,
  Beneficial/Detrimental) + `messageOverlay.baseline.json` + per-user
  learned overlay (VERIFIED / SHARED / CONTRADICTS-WIKI verdicts mined from
  the log; overlay wins over wiki). Injected via rulesets `ParserConfig`.
- **Alerts**: declarative JSON `AlertDef` in electron-store; triggers =
  primitives (event kind + `where` match, raw regex, app signal) or
  composites `{any|all}` (same-event semantics only). Module evaluates
  live-only with cooldowns; renderer plays sounds. Sound packs live in
  `resources/soundpacks` + userData; the ONE shipped default (Alan Rickman,
  `src/main/data/defaultPacks.ts`) is gitignored audio and SELF-PROVISIONS
  at startup from its pinned registry tag — seeded + suggested alert defs
  reference its derived soundIds. App signals (bossDefeat, questComplete)
  fire from single always-mounted detectors.
  **A `where.spell` MATCHER TESTS THE WHOLE CANDIDATE LIST, NEVER THE FIRST PICK**
  (JOS-84). EQ prints ONE landing/wears-off sentence per spell FAMILY, so
  `buffApply.spell` / `buffWearOff.spell` are a documented best-effort first
  candidate — alphabetical, and never the spell you cast — while `candidates`
  carries the truth. The suggestion wizard's `lands` template pinned
  `where:{spell:'<your spell>'}` to that pick and so could never fire: a v0.10.0
  enchanter's Shiftless Deeds alert was compared to the string "Forlorn Deeds", and
  Incapacitate's to "Disempower". Now `spellCandidateNames` widens the `spell` key
  (and ONLY that key, and only when the event carries candidates) to every name the
  line could be, and `matchedSpellName` reports the one that satisfied the def so a
  spoken alert says your spell rather than the coin flip's. The consequence is
  stated, not hidden: when one sentence is five spells, the alert is an alert on the
  FAMILY — which is also what keeps it alive across the level-up that replaces the
  spell. Nothing named `\] `-anchored or self-vs-third-person was ever the problem.
  **CAPTURE GROUPS SPEAK THE LOG, AND THE THREAT MODEL IS IN THE CODE** (JOS-103,
  `src/shared/alertCaptures.ts` — read its header before touching any of this). A
  trigger's regex may declare a NAMED group and the def's `custom` phrase may write
  `{player}`; the alert then says what that group captured ("Puma on Fail"). ALERT
  DEFS ARE SHAREABLE, so a capture is a channel with a third party at each end: a
  pattern the user did not write, selecting text a stranger did write, spoken aloud.
  Five controls, each enforced at BOTH ends (main harvests, the resolver re-checks):
  every value through the shared sanitizers (`sanitizeOneLine` — law 3 applied to a
  new inlet); `MAX_CAPTURE_CHARS` 48, a NAME's worth not a LINE's, well under
  MAX_SPEECH_CHARS; a value may come ONLY from the text the def's own condition just
  tested (a `raw` condition from `ev.raw`, a `/regex/` `where` matcher from that one
  field) — **there are no ambient tokens**, no `{C}`, no `{L}`; a token is a
  DECLARATION, so named-only and never GINA's positional `{S1}`; and ONE
  left-to-right pass with a FUNCTION replacer — no nesting, no recursion, no re-scan,
  and `$&` in a captured name is text rather than a `replace()` directive. Unknown
  tokens render LITERALLY. The divergences are argued against measured prior art: EQ
  Log Parser runs FIVE substitution passes that each re-scan what the last wrote,
  bounds nothing, and sanitizes only its TTS path. HONEST LIMITS, stated in the file:
  a loose `raw` pattern can still MATCH a chat line quoting its sentence (the controls
  bound what it can SAY, not whether it fires) — which is why `subjectCapturePattern`
  anchors `^\[[^\]]*\] ` (never a bare `\] `, which a stranger's typed `] ` can start a
  match inside) and captures a name-shaped class no EQ chat shape can reach; and ReDoS
  on a hostile pattern is pre-existing and unfixed.
  **A TEMPLATE FLAG IS A CLAIM THE ALERT CAN FIRE, AND THREE OF THEM WERE LYING**
  (JOS-103). Spirit of the Puma was invisible to the wizard because
  `suggestionTemplates` compared `spellType` to two string literals and its type is
  `Proc Buff` — a spell with no template is DROPPED from the catalog. Now an exhaustive
  table over the DB's 33 observed types. Measured while fixing it: `lands` was offered
  to 68 Detrimental spells whose cast-on-other message yields no `castOnOtherSuffix`,
  so no `buffApply` is ever emitted and the alert could not fire; and `wearsOff`
  (`buffExpired`) can never fire for a buff SOMEBODY ELSE cast on you, because the buffs
  module's own-cast gate never makes it an active instance — so it is now an `any`
  composite over `buffExpired` + `buffWearOff` (same ts, so the cooldown eats the
  duplicate). Puma's landing line has NO typed event at all (`Target growls…`, not
  `Someone growls…`), which is why the shipped capture suggestion is a `raw` trigger:
  not a shortcut, the only thing that exists for that family.
  **AND `suggestions.ts` IS NODE-TESTED NOW** — it imported a VALUE through
  `@shared/*`, so it could not load under tsx and no test had ever run a real
  suggested def end to end. That is a large part of why this shipped; the import is
  relative (repo law) and `tests/suggestedAlertsFire.test.mts` drives the real
  wizard path through the real parser into the real module.
  **A MEZ HAS NO `buffExpired`, SO IT GETS THE EVENT IT ACTUALLY HAS** (JOS-161).
  `wearsOff` is beneficial-only and rests on the DERIVED `buffExpired`, which the
  buffs module synthesizes only from an AUTHORITATIVE wear-off message. A hold on a
  mob has none — `Your <X> spell has worn off of <mob>.` is claimed by
  `classifyWornOff` and becomes `cc {refresh:true}`, and the hygiene cull that
  retires an unwitnessed hold is deliberately silent — so a bard reaching for
  "alert me when my mez expires" found no template that could fire and no trigger
  they could hand-write that would. The `breaks` template is the per-spell twin of
  the "Mez / root broke" GROUP: `{cc, where:{spell, refresh:'true'}}`, gated on the
  parser's own `ccSpell` roster (exported from rulesets.ts for exactly this
  reader), because a spell the roster misses parses to `buffFade` where the trigger
  never sees it. Same honest limit as the group: "it ended", never "it ended early".

- **THE CORRECTIONS OVERLAY CAN RENAME, AND A NAME IS A JOIN KEY** (JOS-161,
  `src/main/data/spellCorrectionsList.ts` — the evidence bar and the five drift
  classes live in that header; `spellCorrections.ts` is the mechanism beside it).
  The first four drift classes assume the wiki and the game agree about WHICH spell
  is described and differ only in the words it prints. The fifth is the name itself:
  the level-39 bard song is `Solon's Bravura` on the wiki page and
  `Solon's Bewitching Bravura` in every line the game has ever printed. That is not
  cosmetic — the name is what `SpellDb.byKey` folds a cast line to, what
  `SpellCatalogEntry.name/key` is, what `where.spell` is compared against, and what
  `spellClasses.ts`/`levelUnlocks.ts` index by; so the song anchored nothing, the
  wizard listed a spell no bard has, and no single string could satisfy both a
  landing alert and a break alert. TWO RULES come with it: a name correction writes
  EVERY row of that name (the scrape carries era/rank duplicates whose MESSAGES may
  legitimately differ — `Shock of Frost` is two rows saying two different things —
  but whose NAME cannot, and a half-rename puts a phantom line in the catalog), and
  it reports `unknownSpells` rather than `stale` when it rots, because a renamed row
  is not findable by the name the correction states. The audit test fails on either
  list. **And every index keyed by spell name must read the CORRECTED entries** —
  `spellClasses.ts` and `levelUnlocks.ts` now do; a raw-`spells.json` importer that
  looks a spell up BY NAME is a silent miss waiting to happen.

### Electron trust boundary (do not weaken)

- ONE `WEB_PREFERENCES()` in `src/main/windows.ts` (module-private, beside the only
  code that creates a BrowserWindow) builds the webPreferences for EVERY window
  (main + all five overlays) — never inline a second opinion. contextIsolation
  on; nodeIntegration (+InWorker/+InSubFrames), webviewTag,
  allowRunningInsecureContent, experimentalFeatures, enableBlinkFeatures,
  navigateOnDragDrop, spellcheck all off; webSecurity on. Stated explicitly even
  where they match Electron's default — the default is someone else's decision.
- `sandbox:false` is a PACKAGING blocker, not a choice: both preloads
  `require("./chunks/ipc-<hash>.js")` (rollup hoists the shared `shared/ipc.ts`
  out of the two-entry preload build), and a sandboxed preload's `require`
  resolves only `electron` + a tiny polyfill set. MEASURED: flipping it makes
  `npm run test:e2e` time out with `[main:preload-error] module not found:
  ./chunks/ipc-….js` and no `window.eq` at all. Nothing in the preloads needs
  Node, so `sandbox:true` (and `app.enableSandbox()`) unlocks the moment
  electron.vite.config.ts emits each preload as ONE self-contained file.
- Navigation/window-open/webview policy is installed ONCE from
  `app.on('web-contents-created')` (hardenWebContents), never per window: a
  window added later must not be able to miss it. `will-navigate` allows only the
  bundled renderer dir (or, in dev, the electron-vite server's ORIGIN — the
  server's own URL, so 5173/5174 both work); `setWindowOpenHandler` is
  deny-always and hands ONLY an allowlisted https host to `shell.openExternal`.
  **That allowlist is the boundary, not a formality**: link URLs are built from
  WIKI PAGE TITLES (`shared/wiki.ts`), and an unvalidated openExternal would let
  one ask the OS to run `file:///…exe`. Widen `EXTERNAL_LINK_ALLOWLIST`
  (security.ts) deliberately or not at all. All permissions are denied wholesale
  (this app needs none); pure policy lives in `src/main/security.ts` and is
  pinned by `tests/security.test.mts` (no Electron, never skips).
- Renderer-supplied strings that reach `join()` are validated AT THE IPC
  HANDLER (`sounds:getData`'s packId → `isSafePackId`), not trusted because
  today's only caller is the app's own UI.

## World-model laws (hard-won; do not relearn these)

1. **Messages over inference.** Applications, targets, expiry come from
   explicit chat lines (cast-on-you/other, wears-off, "Your illusion
   fades.", "slows down.", resists). Estimates are display-only countdowns.
   Anything inferred is LABELED inferred — never silently guess.
2. **Names are dirty; canonicalize at boundaries, display raw.**
   Case-insensitive keys (`idKey`) everywhere (lifecycle lines lowercase
   articles; damage lines capitalize). Strip spell rank suffixes (casts say
   `Swift Like the Wind I`, fades are rank-less) and item ` +N` variants at
   COUNTING boundaries only. Strip leading a/an/the for boss matching.
   OUR OWN labels are dirty too: `WorldModel.label()` appends a
   spawn-generation ` (N)` suffix ("the 14th capturer this session") that
   rides `currentTarget` into lookups — `mobKey` strips it; it is display
   flavor, never identity. The suffix appears in NO log line.
3. **Shared messages are the norm.** 123 wears-off families ("Your speed
   returns to normal." = 9 hastes), generic illusion landings ("You feel
   different."). Parser carries candidate lists; the MODEL resolves against
   the active set / session cast history.
4. **Entities, not names; disposition, not identity.** Buffs are
   (spell, entity) instances; "pet" is NOT a data-model class (self renders
   first, others second — presentation only). Charm break keeps the entity
   + buffs (re-charm same name w/o death/zone = same entity). Single-pet
   invariant: new claim/charm retires the prior pet — but it is enforced in
   TWO models with different reach, and the difference is measured, not an
   oversight (JOS-54). `modules/buffs.ts` (onCharm/onPetClaim) retires across
   BOTH kinds, at the buff-entity level. The combat `WorldModel` retires only
   BY KIND: `claim()` retires the prior SUMMONED pet (the game gives you one
   class pet and the recast despawns the old one printing NOTHING, so the
   successor's own claim is the only evidence there is — before this the
   owner's log finished a replay holding 23 live pets), while `charm()` retires
   nothing there. The crossover is deliberately left alone: 344 charm binds
   land with a summoned pet flagged live, but the log has ZERO cases of a
   proper-named class pet and a charmed pet demonstrably swinging together,
   so it is an unobserved shape and gets no invented rule (awaiting-sample
   law) — especially not one that deletes a live pet's damage. Succession
   costs nothing where it DOES fire: 23 firings whole-log, the retired pet
   lands zero further damage lines, ever. Retirement is not deletion — the
   old pet keeps every point already attributed to it (rows key by
   instanceId); it only stops being yours for FUTURE admission, which means
   the engine's `petNames` index must follow the world model out
   (`EngineState.syncPetNames`). **AND THE CLAIM IS WHAT TRIGGERS IT, NOT THE
   SUMMON** (JOS-188) — an UPGRADED pet has a new NAME, so before the pet-buff
   rung a player who never ordered the successor got no succession at all: the
   predecessor's row froze and the successor's damage went nowhere. Three lines
   produce that claim now (tell / leader say / your own pet-only buff landing);
   all three go through one `bindPetClaim`, on purpose. Zoning: self +
   summoned pet keep buffs; charmed pets/hostiles are left behind (censor).
   Deaths retire. **Unobservable fades censor, never pollute stats.**
   Own-cast gating: never track buffs we didn't cast (10s cast window or a
   Quick Buff burst).
   **A HEALER OF YOURS IS NOT NECESSARILY A PLAYER (JOS-48).** `<X> healed you
   for N hit points by <Spell>.` is also how YOUR OWN LIFETAP prints its
   recourse, naming the DRAINED MOB as the healer (`Lord of Loathing healed
   you for 509 hit points by Leech Touch I.`, seven times in one report slice,
   under `Your life force drains away.`). Filing that mob as a KNOWN PLAYER
   deleted every pet swing at it from that instant (measured: 41 hits / 768
   points in one golden window; 18 / 398 in the reporter's own pull). The
   refusal is `EngineState.everStruck` — **a name YOU have landed damage on is
   a mob**, the third absolute guard beside `everPet` and `everCharmed`, and
   it is BEHAVIOURAL: the mobs catalog is never consulted, so it holds for a
   proper-named guard the catalog has never heard of.
   **And the wider rule — "anything ever ENGAGED as a hostile" — is MEASURED
   WRONG**: a raid boss mind-controls your healer, so
   `Sonista slashes YOU for 5 points` lands 27 s before
   `Sonista healed you for 1219 hit points` in a real slice. Being hit is
   something that HAPPENS to you; hitting is something you DO, and only the
   second names a mob. One direction only, too: the refusal never RETIRES a
   filing the heal got in ahead of (a lifetap tick is downstream of the damage
   that produced it — measured lags of 632 s / 336 s, and zero heal-first
   cases in the owner's 1.4M lines).
5. **Aggregates lie; derive from identities.** AA earned = net allocation
   (latest purchase per ability+rank, cost-0 auto-grants excluded) +
   unspent (last authoritative "You now have" − later spends); sum-of-gains
   double-counts respec refunds. Durations: DB authoritative, else
   recency-weighted MAX (median biases low via censored samples).
6. **Say what the log cannot say** (documented non-distinguishables — never
   invent): main/off-hand; double/triple attack (SILENT extra swings —
   zero annotations in 1.35M lines; the rounds model (combat/rounds.ts,
   wave X 118f0c2) infers by (source, verb, TARGET, second) with
   cross-target fan-out collapse, per-event ONLY on reuse-timer verbs,
   aggregate-rate-with-inferred-chip on dual-wieldable weapon verbs, and
   the player's own Rampage swings are unannotated = outgoing rampage
   unknowable); ground pickups (NO line exists — the loot family is the
   only item-acquisition line); self-buff fades (only wears-off emotes);
   mob HP. Fight NAMING (Task #54): a LIVE fight is named after the CURRENT
   target (most recent outgoing target — the mob in front of you); on FINALIZE
   it switches to the LARGEST target ("most damage absorbed", a labeled proxy).
   Both keep the '+N' others suffix. `encounterName(e, live)`.
7. **Encounters close on evidence**: all engaged instances dead (+~5s
   linger); live CC (mez lines) holds fights open indefinitely; ~60s idle
   fallback for fled mobs. DPS = damage/(lastHit−firstHit); active-time
   DPS is the secondary stat. A zone change FINALIZES the live zone aggregate
   into a capped HISTORY (Task #54; last 20 sessions — frozen agg + timing +
   memoized summary, NO per-event rings, ~0.6MB full-log) instead of discarding
   it, so a past zone's overall meter stays selectable; the snapshot exposes
   `zoneSessions` (live first, id 'zone'; finalized 'zs<n>') and buildSelected
   accepts a session id. Selector rows (main + overlay) carry disambiguation
   timing: start clock (formatDate) · coarse live-updating age · duration.
8. **Miss/resist are first-class, damage-free** (Task #51 v2): a miss
   (avoided melee swing) and a resist (fully-resisted spell) attach to the
   fresh encounter + zone aggregate with the SAME attribution as damage
   (you/pet/incoming; hostile-mob-vs-mob resists dropped) but carry NO
   amount — so every damage total stays byte-identical (the tripwire, per
   source: `Σ category.total == source.total`). They enter the timeline
   ring as hollow/red ticks (miss -> "Melee" lane; resist -> the spell's own
   lane, so an always-resisted mez shows a 0-hit / N-resist lane). Rates:
   melee hit% = hits/(hits+misses) [hits counts ALL landed incl. spells —
   the per-category melee row isolates pure melee]; resist% =
   resists/(spell+dot casts + resists), surfaced at source / category /
   per-spell rows. A miss/resist NEVER opens or extends an encounter (only
   damage/CC does), so instants before the first hit go to the zone
   aggregate only. Ring cap 5k→8k (misses ~2× the density; sole marathon
   fight peaks 5259 instants — fits with zero drop-oldest; ≤60 rings
   retained, <1MB). Timeline zoom/pan is renderer-side view-window state
   (wheel = cursor-anchored zoom, shift-wheel/drag = pan, Fit = reset,
   starts fit); windowed by visible time range so the SVG stays cheap.
9. **One time base per chart.** A curve's vertices, markers, axis and hover
   inverse all read ONE `{t0, t1, bucketMs}`; samples anchor at bucket
   centres; live windows advance in whole buckets. Mixing an index-fraction
   vertex mapping with a time-fraction marker mapping stretched markers a
   full bucket at the right edge, and a wall-clock window length made them
   swim against a still curve every tick (fixed 5a9dbc2). Canvas is never
   the answer to arithmetic disagreement. Chart interaction seam: hover
   binds pointermove/pointerleave ONLY and bails when `ev.buttons !== 0`;
   drag interactions own pointerdown/up/cancel; a `suppressed` prop ties
   them without shared state.
10. **Revisable intervals JOIN AT READ; nothing stamps their ids.** Combo
   intervals (fuzzy, retroactively re-labeled by a later /who or a user
   correction) are queried by timestamp (`comboAt`/`groupByCombo`); an id
   stamped onto a boss kill goes stale with no reconciliation path.
   Persisted corrections key on TIME; interval ids are recompute-unstable
   and never leave the renderer.
11. **Exclusivity gates are RATE-AWARE.** "Never fired without X" requires
   the inactive exposure to PREDICT evidence (>= 3 expected firings at the
   lane's own active rate), never a flat swing floor — 289 swings deny
   Instrument of Nife what 225 earn Spellblade, and that asymmetry is the
   point. Direct observation beats the model (a lane that DID fire inactive
   is never "under-sampled"). States active for the same firings declare
   co-exclusivity — two rows never silently claim one body of evidence.
12. **Cross-source name RENAMES are knowledge, never fuzzy.** The log, the
   mob catalog and the map stems disagree by NAME (The Ruins of Old
   Paineel = The Hole), not spelling. `shared/zones.ts` is the ONE
   hand-authored, evidence-verified artifact (short names, aliases,
   `catalogZonesFor`); closest-match would conflate genuinely distinct
   zones, and an anti-fuzzy tripwire pins two near-name rosters disjoint.
   A new gap gets a VERIFIED row, never a matcher.
13. **A DEATH→DEATH GAP IS AN UPPER BOUND, NOT A MEASUREMENT** (JOS-194,
   `shared/respawn.ts`). Respawn clocks start on the death MESSAGE and are
   numbered from your own kills, because the owner ruled the wiki a bad primary
   source and the sweep proved him right: of 7,872 catalog pages **522** state
   a `|respawn_time` at all, **394** state something readable, and 113 answer
   "Triggered" / "?" / "Night" / "Ultra Rare" — and across the four dungeons the
   reports named (Befallen, Najena, Upper/Lower Guk) it is **28 of 184**. So the
   ladder is: your typed number, then your kills, then the wiki as a DEFAULT
   before you have kills and a FLOOR under them once you do. You cannot kill a
   mob before it spawns, so every observed gap is `respawn + your delay`: the
   tightest thing your kills can say is the SMALLEST gap, which converges
   downward where an average would sit permanently above. It prints as `≤` with
   the sample count, and a clock at zero says **due**, never "spawned" — the app
   has never seen a spawn (law 1, law 6). Two rules keep the bound honest and
   both are EVIDENCE: a gap counts only when both deaths fall inside ONE stated
   stay in the zone (a zone line ends the stay even when it names the same zone
   — you left and came back), and two deaths of one name inside 60 s are two
   mobs in one pull, because the shortest respawn the whole catalog states is
   **78 s** (p01 165 s, median 22 min). The floor's one job is that same failure:
   51 kills of `a teir\`dal ranger` give a 61 s minimum, and the wiki's 267 s
   lifts it while the label still says "your kills, floored by the wiki".
   The committed floor keeps each page's VERBATIM text beside the parsed
   seconds, so a grammar fix re-derives the file with NO network
   (`npm run scrape:respawns -- --reparse`) and the UI can quote what the wiki
   said instead of inventing a number.

## Log-format quick reference (all validated against the real log)

- Melee verbs CONJUGATE — match first person ("You slash") AND third
  ("slashes"); missing `smite`/`cleave` once hid 22% of all damage. Paren
  modifiers are COMPOUND: `(Riposte Slay Undead)`.
- **A VERB THAT NAMES A CLASS SKILL GETS ITS OWN LANE; A WEAPON VERB DOES
  NOT** (JOS-77, JOS-81). `meleeSkill()` (log/parseCombat.ts) splits Backstab
  (ROG), Bash (PAL/SHD/WAR), Kick (BST/MNK/RNG/WAR), Frenzy (BER), Flurry,
  **Cleave (WAR, level 5)** and **Smite (PAL, level 9 innate)**;
  slash/pierce/crush/hit/slice/claw/gore are what a
  weapon in a hand prints and share the generic "Melee" row (the Rounds panel
  splits those BY VERB instead). The table is HAND-AUTHORED against
  `data/classes.json`'s skill→class map — never a matcher over spelling, which
  would promote `slice`. Cleave's row is user report
  01KZCZ3BYRQRD4JQJ0PW7FQRG5, the Dragon Punch shape one lane over: the damage
  was always counted, the ROW could not exist (171 hits / 11,256 points hidden
  inside one "Melee" row in the reporter's slice). What proves it is a SKILL
  and not a damage tier of some weapon verb: the owner's 1.4M-line log has
  71,104 `You slash` hits reaching 2,100 damage and **ZERO** `You cleave`
  lines, while carrying 20,334 INCOMING ones — a verb that never prints for a
  player who lacks the skill is gated on the skill.
  **SMITE (JOS-81) NEEDED A DIFFERENT PROOF and the log gave a better one.**
  Cleave's argument is an absence; the owner IS a paladin and smites 13,984
  times, so it cannot borrow it. THE SKILL-UP STREAM decides: enumerating all
  56 `You have become better at X!` names, a weapon verb NEVER ticks under its
  own name (a slash ticks `1H Slashing` 365, a crush `1H Blunt` 248, a pierce
  `1H Piercing` 410, a punch `Hand to Hand` 282; `better at Slash!` does not
  exist), while `Smite` ticks 280 times beside Kick 296 / Bash 222 /
  Backstab 200 / Frenzy 196. Neither verb claims a special-attack lane (no
  `instead of Cleave`/`instead of Smite` line exists — Smite's three
  `You will now use Smite while auto attacking.` grants are bare, and a special
  earns a lane only when it prints NO verb of its own) nor a reuse-timer
  confidence tier.
  **THE SKILL LANE AND THE SPELL LANE SHARE A STEM AND MUST NEVER MERGE.**
  `Smiting Strike` (the PAL proc, 15,016 lines, `by <Spell>` path, `spell`
  category) is a different row and is byte-identical across JOS-81. But a spell
  literally named **`Smite`** also exists (20 self lines / 1,820 points
  whole-log; classes.json already flags the name clash — "never union them"),
  and a source's TOP-LEVEL lane list is keyed by skill NAME alone
  (`aggregate.ts bySkill`), so on 10 of 2,727 fights that one row now sums a
  melee skill and a spell. The per-CATEGORY drill separates them exactly and
  every category total is unaffected; `tests/combatSmiteLane.test.mts` W54
  pins the collision on real bytes rather than hiding it.
  **RANGED (JOS-92) NEEDED A THIRD ARGUMENT, BECAUSE IT FAILS BOTH OF THE ABOVE.**
  A ranger asked for the bow split out of Melee ("stance switching Ranger/Ranged
  stance uses bow in melee. currently that is lumped into the same bar"). Same
  shape as cleave/smite — `shoot` has been in MELEE_VERBS since the missing-verbs
  fix, so bow damage was always COUNTED and only the ROW was missing — but run
  JOS-81's skill-up test on it and it comes back a WEAPON verb: `better at Shoot!`
  does not exist, `shoot` ticks under **`Archery`**, and Archery sits in the
  weapon-type family beside 1H Slashing / 1H Blunt / Hand to Hand. Borrowing the
  smite argument would have been a lie. THE LANE RESTS ON THE CLAUSE JOS-77
  ALREADY WROTE AND NEVER USED: the generic row exists because those verbs "are
  what a weapon IN A HAND prints, and four of them are ONE auto-attack lane". A
  bow is not that lane — different slot, different skill, and none of the hand
  lane's multipliers reach it (Dual Wield 322 skill-ups, Double Attack 395,
  Triple Attack 100). So the rule gains a NARROW second clause: **a weapon verb
  fired from a different SLOT than the hands is not the hand lane**, and `shoot`
  is the only verb in MELEE_VERBS that qualifies. The label comes from the game's
  own word for the mode (`You assume a ranged stance.`), not from a skill table.
  NO THROWN LANE IS INVENTED BESIDE IT: `You throw` is ZERO whole-log, ` throws `
  ZERO, `Throwing` occurs only inside item names, no `better at Throwing!` tick —
  awaiting-sample law, so no branch. THE DISCRIMINATOR IS THE VERB AND NOTHING
  ELSE, which is what a stance-switcher needs (a class- or stance-keyed split
  would mis-assign both halves of his fight): all nine `shoots` damage lines in
  the log are shape-identical to melee (`<A> shoots <B> for N point(s) of
  damage.`) and `(Critical)` is the ONLY annotation the family has ever carried.
  THE OWNER HAS NEVER FIRED A BOW — `You shoot` ZERO in 1,438,942 lines, `better
  at Archery!` exactly ONCE, `You assume a ranged stance.` twice — so the lane is
  EMPTY in every committed fixture and the law-8 gate is absolute: all 103
  fixtures replayed before and after (per-segment out/in, per-source, per-category,
  per-lane, per-category-drill; 1,591 rows) came out BYTE-IDENTICAL, because
  there is no self `shoot` line in the tree to move a figure. What the log does
  carry is OTHER PEOPLE's archery — 9 landed, 8 avoided — which `w57-ranged-lane.log`
  (two hits + a dodged shot beside the owner's own Yarik fight) and
  `w58-ranged-critical.log` (the `(Critical)` arm) pin; both were cut for this
  ticket because ` shoots ` was ZERO across all 101 pre-existing fixtures. The
  self arm is INJECTED in `tests/combatRangedLane.test.mts` (the W52/petClaim
  precedent), conjugated from the attested third-person template with the owner's
  own real bow amounts, and it asserts the movement is exact: Ranged 76/3 appears,
  `you|Melee` does not budge, and the melee category grows by exactly 76.
  A stranger's bow is still IGNORED by the meter (routing.ts `classify`) — parsing
  a line into a new lane is not the same as admitting it, and W57 pins that too.
  **STRIKE (JOS-163) IS A FOURTH ARGUMENT AGAIN, AND IT IS THE ONLY LANE WHOSE
  NAME IS DELIBERATELY ANONYMOUS.** A monk on 0.16.0: strikes lumped into Melee
  while kicks show up fine. `strike` is not a class skill (fails JOS-77) and not
  a different equipment slot (fails JOS-92) — it is the GENERIC VERB every monk
  special prints as, and specialAttacks.ts already proved it EXCLUSIVE to that
  chain (the owner's first-ever `You strike` is 3 s after his Tiger Claw grant;
  unarmed autos print `hit`/`claw`/`punch`). So an unnamed strike is not a weapon
  swing that wandered in, it is a special whose NAME is unknown, and the row it
  earns is called **`Strike`** — the verb, never a name from the chain. THE BUG
  WAS THE PRE-STATE FLOOR, NOT THE RENAME: the `You will now use <X> …` line
  prints ONCE, at the level-up, so a log file that BEGINS after it (fresh
  install, rotation, `/log on` enabled later) never carries it and 100% of that
  player's strikes read "Melee" forever — v0.5.0 fixed only the case where the
  line exists. The loadout-swap re-announce burst does not include the strike
  lane (`w48-special-lane-reset.log`: six state lines, none a strike) and an
  epoch reset wipes the lane with nothing to re-seed from. THE TWO HALVES STAY
  SEPARATE: the verb earns the ROW (`meleeSkill`), the state line earns the NAME
  (`nameSpecialLane`/`missFold` consult `specials.laneSkill(verb)` FIRST), and
  **no lane is ever seeded from the chain's first entry** — specialAttacks.ts's
  stated law, and the reason an Iksar's unlaned strikes can never read "Dragon
  Punch". Person-agnostic like every other branch (a mob's `strikes` reads
  "Strike", as its `kicks` always read "Kick"); the stateful rename above it
  stays first-person-only. Law 8 holds by construction — a rename INSIDE the
  melee category, so no total can move. 21 of the 104 committed fixtures carry a
  strike line; the five with a pinned lane total each shed exactly its own
  hand-tallied strike arm out of "Melee" and nothing else (each figure tallied
  off the raw fixture text before the engine was asked): w46 102/10 beside
  Eagle Strike 89/7 after its state line, w47 77/6 beside Dragon Punch 128/6,
  `w52-cleave-lane.log` 340/16, `p2-pet-arc-bound.log` 795/12,
  `w58-ranged-critical.log` 257/4 — every category total unchanged, and the
  34-spec e2e suite (whose combat fixture carries 87 strikes) green.
- **A HEAL THE LOG ANNOUNCES BUT NEVER VALUES GETS A LANE THAT CARRIES A COUNT
  AND NO NUMBER** (JOS-86 — the monk's Mend). `You mend your wounds and heal
  some damage.` is the whole sentence: no amount, no target, no third-person
  twin. The user report ("Mend does not appear in the healing logs", v0.10.0)
  reads like the Cleave/Smite shape and is its INVERSE — those were always
  counted and merely lacked a row; Mend was never parsed at all, because every
  heal path in the model is built around a number. WHOLE-LOG PARTITION, and it
  is exact: of 1,178 case-insensitive `mend` lines, **876** are that sentence,
  200 are `You have become better at Mend! (N)`, 1 is the ability grant, 2 are a
  mob named `a Nisch Mas Mender`, and 99 are third-party chat. So FIRST PERSON
  ONLY, no failure shape, no refusal shape, no amount anywhere — do not invent
  an arm the game has never printed. THE FIX IS A KIND, NOT A FLAG: a `heal`
  with `amount: 0` would have been a lie with a long tail (the ledger files a
  tick that "landed on a full health bar", the row's `min` collapses to 0, and
  `foldHealAnalytics` enters a 0-damage "Mend proc"), so it is `healUnstated`
  with **no amount field at all** and a third `HealClassification`, `'unstated'`,
  whose 0 means "no measurement exists" and never "the measurement was zero".
  It enters NO sum — row total, view total, hps, overheal, `count` — and rides
  its own `HealSourceView.unstatedCount` so the crit and overheal rates beside
  it keep their VALUED denominator. Every string that would render that 0 as a
  figure is replaced by the reason there isn't one (`laneAmount`/`healerAmount`
  print an em dash, never `fmt(0)`); a genuinely 0-total *restored* lane still
  prints 0, because that one really did measure zero. This is the rune lane's
  treatment for the opposite reason — a rune is an amount attached to something
  that never touched a health bar, a Mend is a health bar with no amount — and
  the `magical skin absorbs` families' treatment for the identical one. THE
  GOLDEN IS THE OWNER'S OWN BYTES, nothing injected: he mended 876 times, so
  the reporter's slice never had to become a fixture (W55
  `w39-spellblade-switch.log`, the lane beside three valued lanes; W56
  `w47-special-dragon-punch.log`, a Mend alone SYNTHESIZING the self row the
  way an out-of-combat rune already did). LAW 8 GATE over every committed
  fixture, healing view diffed line-for-line: **every difference was an
  ADDITION** — not one total, count, min/max, overheal, pct, hps, enemy row or
  damage figure moved. A 0-total lane cannot move `rankLanes`' denominator
  (`Math.max(1, …totals)`), which is why the existing bar fills are identical
  too. One fixture (`e2e-combat.log`) shows no lane and that is correct: its
  Mend precedes two zone lines, so it lands in a FINALIZED zone session (law 7).
- **SPECIAL ATTACKS PRINT NO VERB OF THEIR OWN.** A Dragon Punch, an Eagle
  Strike and a Tiger Claw ALL land as `You strike …`; Round Kick and Flying
  Kick land as `You kick …`. The game names the live one exactly once, in
  two first-person-only shapes (21 lines whole-log, no third person exists):
  `You will now use <X> while auto attacking.` (a GRANT — also how a lane
  RESETS, e.g. the Aug 02 loadout burst putting the kick lane back to Kick)
  and `You will now use <X> instead of <Y> while attacking.` (an in-lane
  upgrade). So the lane label is STATE, not parsing: `combat/specialAttacks.ts`
  tracks the live special per VERB lane and ingest renames the skill. Two
  lanes are verified (`strike` → Tiger Claw/Eagle Strike/Dragon Punch — the
  player's first-ever strike is 3s after the Tiger Claw grant; `kick` →
  Kick/Round Kick/Flying Kick — skill-ups partition perfectly by era).
  **`Slam instead of Bash` is REFUSED**: Slam never prints `slam` (0 lines)
  but 185 `better at Bash!` ticks fire during Slam eras and `better at Slam!`
  does not exist — a documented non-distinguishable (law 6), not a guess.
  SKILL-UPS ARE NOT AN INPUT anywhere here: Tiger Claw keeps ticking 111
  times after it was replaced, on a drip with no swing beside it.
- Zone: `You have entered X.` — REJECT pseudo-zones ("an area where
  levitation…"). **The zone name is the ONLY thing that ever states a
  difficulty** (no kill line, lockout line or instance-creation notice
  carries one), so `zoneTier()` decides what every kill's difficulty was
  and it answers FOUR kinds of thing, not one number in five (JOS-166):
  a trailing `(Awakened|Adaptive|Fused|Refined)` = **d1–d4**; a
  `- Solo` / `- Group N` suffix with no adjective = **d0, the base
  INSTANCE, a real difficulty with a real weekly lockout**; a bare zone
  name = **open world** (`TIER_OPEN_WORLD`, no lockout of any kind); an
  empty zone or an adjective the table does not know = **unknown**
  (`TIER_UNKNOWN`). The name itself is stripped of all three markers.
  All four are kill-record keys (`src/shared/kills.ts`), and only the
  five difficulties can green a weekly ladder rung. Before JOS-166 the
  last three all decoded to 0, so an open-world kill and a base clear
  were the same fact — a raid target has FIVE lockouts a week and the
  base one was being spent by kills that never took it.
- Loot family (sole item-into-inventory lines): dashed
  `--You have looted X from Y's corpse.--`; currency (`…stored it in your
  currency`, NO period); sold (`…sold it for <money|free>.`). Dragon
  Hoard / depot / combine variants exist and are NOT yet parsed.
- AA: gains `…gained N ability point(s)! You now have M` (M = UNSPENT);
  spends in TWO formats (quoted rank-1 / `improved X <rank>`); cost-0 =
  auto-grants; respecs re-log purchases; no refund line exists.
  The quoted form is ALWAYS rank 1 and the improved form NEVER logs below
  rank 2, so a spend line states one rung of a per-ability LADDER —
  `shared/aaLedger.ts` regroups them (post-epoch: 125 lines ⇒ 50 abilities,
  27 multi-rung, deepest 10). Sweep, 2026-08-05, of the two families that
  look like AA and are NOT parsed, both deliberately:
  `You have completed achievement: 5 Alternate Advancement Points` is the
  log's ONLY self AA achievement line in 1.35M lines and restates a
  milestone the 208 gain lines already carry point-by-point (redundant, and
  a double-count risk). `You activate X.` (233×) is NOT an AA family: it is
  Quick Buff 111 + Skull Bash 86 + 36 poison applications, and only Quick
  Buff names a purchased AA — the line cannot distinguish an AA from a disc
  or a poison, so it stays a buffs/combat signal, never an AA-usage stat.
- Class SKILL grants share the AA verb: `You have gained the ability to use
  <Skill>.` (44×, Double Attack / Sneak / Riposte…) has NO cost clause and
  is not an AA purchase. `AA_ABILITY_RE` requires ` at a cost of`, which is
  the whole reason those lines never mint a spend.
- Resists (`resist` event, Task #51 v2): THREE shapes — `<target> resisted
  your <Spell>!` (caster=you), `<target> resisted <caster>'s <Spell>!`
  (caster=name; test YOUR form FIRST — 712 spell names contain `'s`, e.g.
  Denon's), `You resist[ed] <mob>'s <Spell>!` (incoming). Spell keeps rank
  suffix for display, rank-normalized (spellCanonKey) for keys. Full-log
  sweep: 5747 (you 1749 / pet 390-by-name but ~2019 once charmed mobs
  resolve / other-mob 1695 dropped / incoming 1913). Misses: `tries to … but
  misses!` family (miss/dodge/parry/riposte/block/absorb).
- Stances: two mutually exclusive groups — 9 stances (`You assume a/an X
  stance.` — the article conjugates: "an offensive stance") and 9
  invocations (`You begin reciting the X invocation`);
  "begin to change your …" lines are flavor, not state.
- Quick Buff AA: `You activate Quick Buff.` → burst of landing emotes, NO
  cast lines. Permanent Illusion AA (ownership learned from its purchase
  line): illusion self-buffs permanent; ONE illusion per entity;
  `Your illusion fades.` is the shared remover.
  **THE BURST IS ALSO THE ONLY LINE THAT ENUMERATES YOUR GROUP BY NAME**
  (JOS-85). One cast of it prints two or more
  `You healed <X> … by <Spell>.` lines in the SAME second — the only shape in
  this log where the game lists who your buffs reached. MEASURED: 83 such
  fan-out casts in the owner's 900,562-line log and **all 83** are within 15 s
  of a Quick Buff line, so it is a fact about the ABILITY, not about spell
  target types — spells.json calls `Skin Like Nature` / `Symbol of Pinzarn`
  "Single Friendly (or Self)" while the log lands each on three entities in one
  second, because the wiki describes a different server. It proves RECIPIENTS,
  not membership (a burst hits your own pets, and two of the owner's 67 bursts
  reached a player he was demonstrably not grouped with), so the roster admits
  a name only in conjunction with `You gain party experience!` earlier in the
  session — measured 2/2 correct, 0 false positives, identical at every backward
  window from 2 min to 6 h. It is the roster's SECOND recovery path and exists
  because the first (`<Name> tells the group, '…'`) needs somebody to talk: a
  reporter's 12,376-line session held two group-mates and ZERO group events.
  Weakest provenance rung (`buffed`); self / charmed / claimed-pet names refused.
  src/main/modules/buffFanOut.ts, docs/plans/group-model.md §1 G4.
- Summoned pets have random proper names (Vebarn, Garer…); bind via
  owner-only tells `<Name> told you, '… Master.'`; they persist across
  zones (charmed pets do not). A pet-claim tell from a name EVER seen
  charmed re-arms the charmed set, never the permanent one — one charmed
  mob's tell must not credit its kills to you forever (`everCharmed`).
  **THE TELL ONLY FIRES WHEN THE PET IS ORDERED** (JOS-47) — `/pet attack`
  produces "Attacking X Master.", `/pet back off` the wake-failure variant.
  A pet that engages on its own aggro emits nothing private at all, so a
  player who never types a pet command has a pet the log cannot bind (a
  user's 30-min slice: three successive pets, 476 hits, 13,555 points,
  ZERO tells; the owner's own log does it too — the enchanter animation pet
  Kober, 105 hits, never once ordered).
  **THE TELL IS THE WHOLE STORY, AND THE BLIND SPOT IS ACCEPTED** (owner,
  JOS-49): *"just cut out the 'is this my pet question' — if you just have
  to pet attack once, this is a lot of work we can get wrong."* JOS-47 had
  built two more rungs on top of the tell — a pet-voiced PUBLIC say paired
  with a shared target NOMINATED a candidate, and the meter asked
  "<Name> — your pet?" with Yes/No above the bars, the answer persisted per
  character and outranking everything. All of it is DELETED: the detector,
  the offer on both meter surfaces, the claim/deny IPC and its
  claim-triggered replay. **The answer to "the meter doesn't show my pet" is
  to order it once.** So an unordered pet is now a documented, accepted
  non-distinguishable (law 6) rather than a question: the app says nothing
  instead of guessing, and nothing instead of asking.
  The measurements that justified the rungs still stand and still say why
  they are gone. The SAY is broadcast — 113 in the whole log, 85 from names
  an earlier tell had already bound and 6 from names no tell ever bound — so
  it proves the speaker is somebody's pet and nothing whatever about whose;
  that is exactly the "work we can get wrong". The six sentences still parse
  (`shared/logScrub.ts PET_SAY_LINES`, kept in the scrub, listed in the
  alert-trigger vocabulary) and the engine now does nothing with them.
  **A TELL BINDS FORWARD, NOT BACKWARD** (measured, JOS-49, on
  `tests/fixtures/p2-pet-arc-bound.log`): `ingestPetClaim` binds from the
  line's own timestamp, and nothing reaches back over damage already filed
  as nobody's. The owner's Aug 06 animation Jaber landed 51 hits for 2,615
  points and was ordered after 43 of them, so its meter row is 8 hits / 599
  points and 2,016 points stay invisible; the same window with the pet
  ordered at the moment it was summoned shows all 51 / 2,615. The deleted
  user CLAIM was the one retroactive path (known before the replay started,
  so `route()` applied it to the pet's first line) — losing that is the real
  cost of the cut.
  **AND THE PET WILL TELL YOU WHOSE IT IS IF YOU ASK** (JOS-52):
  `<Name> says, 'My leader is <You>.'` — the `/pet who leader` answer, the
  ONE pet-voiced line that names its owner out loud, and therefore the
  second binding signal a summoned pet has. It parses to the SAME canonical
  event as the tell (`petClaim`, tagged `via: 'tell' | 'leader'`), so
  idempotence, the single-pet succession, the `everCharmed` PROMOTE path,
  the buff-entity succession and the progression ledger are shared code, not
  a second implementation — a separate kind would be a third retirement path
  for one of those models to forget (law 4 is a scar from exactly that). So
  the user-facing rule widens from "order it when you summon it" to **say
  ANYTHING to it, once, when you summon it** — either sentence at the moment
  of the cast recovers all 51 / 2,615 above.
  MEASURED (whole log, 1,404,458 lines, 2026-08-06): thirteen lines contain
  "leader" — seven `<Name> is now the leader of your group.`, five players
  chatting, and **exactly ONE** leader say (`Jaber says, 'My leader is
  Primitive.'`, Thu Aug 06 12:44:20, now carried verbatim in
  `tests/fixtures/p2-pet-arc-bound.log`). No follower / no-leader / charmed
  variant exists; a second shape ships only when a real line prints one.
  Hence an EXACT sentence, never a `/leader/` pattern (the six-says rule).
  **THE LEADER'S NAME IS THE WHOLE GUARD**, because the say is BROADCAST:
  the rule compares it to `ParserConfig.characterName` (session-injected,
  never a constant) and every other line parses to `unknown` — the
  self-`/who` rule's exact design, permissive regex and all, for the exact
  same reason. Stated rather than pretended away: a `says` is FORGEABLE
  (`/say My leader is <You>.` from someone in earshot), which the private
  tell is not and this cannot be, since the game gives the command no other
  answer; the cost is one bogus row in your own meter. Its scrub carve-out
  is the only pet one that is SELF-GATED (`ScrubOpts.selfName`) — the other
  two are an NPC's words under an NPC's name, while this one carries a
  PLAYER's name inside the quote, so it borrows the self-`/who` row's
  argument instead and a stranger's pet naming a stranger still drops.
  **AND YOUR OWN PET-ONLY BUFF NAMES IT WITHOUT ASKING** (JOS-188) — the
  THIRD binding signal, and the first that costs the player nothing. 40
  spells are `targetType: Pet` in spells.json
  (`charmModel.ts PET_TARGET_SPELLS` — Burnout, the necro Death line, Renew
  Elements, the beastlord spirits, Tiny Companion, Ward of Calliav); the
  game refuses one on anything but YOUR OWN pet, and `You begin casting
  <Spell>.` is printed for the player and nobody else. So an own cast of one
  ARMS the charm model (a third arm kind beside charm/cc, sharing its
  window, its one-cast-at-a-time disarm and its fizzle disarm) and the named
  `buffApply` landing that resolves it binds the pet — through the SAME
  `bindPetClaim` in ingest.ts the tell and the leader say go through, for
  law 4's reason.
  THE REPORTED SHAPE (01KZPFBMF1R26DSG0R2EGER7MV): an UPGRADED pet is a new
  NAME, so the JOS-54 succession never runs — it is not triggered by the
  summon, it is triggered by the successor's claim, and an unordered
  successor has none. The reporter's meter kept the predecessor's frozen row
  and dropped 89 hits / 3,385 points of the new pet; relogging emits no
  binding line either, which is why relogging never helped.
  MEASURED (whole log, 1,557,569 lines, 2026-08-10): 19 binds / 14 names,
  and **all 14 are names a `… Master.'` tell ALSO bound** — nothing is bound
  by this rung alone, nothing it binds is contradicted, and in all 14 it
  arrives FIRST by 81 s – 2,528 s, worth 1,865 hits / 27,088 points.
  **THE MESSAGE IS NOT THE GATE, THE ARMED OWN CAST IS**: `goes berserk.`
  resolves to Burnout / Fury / Rage / Voice of the Berserker and only one is
  a pet spell, so the landing's candidate list must contain the spell being
  cast; the arm is CONSUMED on a hit, so a Quick Buff burst (eleven landings
  in one second, zero cast lines) can never bind off one cast. Golden window
  `tests/fixtures/p3-pet-upgraded-buff-bound.log` + `tests/petBuffBind.test.mts`
  (which installs the spell DB — `buffApply` is DB-gated — while
  `petClaimWindows.test.mts` deliberately still runs without one).
  STILL NOT CLOSED, and named rather than implied: (a) a pet its owner neither
  buffs nor orders stays invisible (01KZN569YA6T751QCJW99P1ZCA is that half —
  its pet buffs are not `targetType: Pet`, so the rung fires zero times in
  its log); JOS-49's answer stands for them, order it once. (b) The rung is a
  transition INSIDE the combat engine, not a parser event, so
  `modules/buffs.ts`'s own entity-level succession still waits for the tell —
  unchanged from before, not yet improved. Closing that needs a derived-event
  seam the session feeds to both models, never a second arm in buffs.ts (that
  is the duplicated retirement path law 4 is a scar from).
- Exp: `You gain (party )?experience!( (N.NN%))?` — the percent is an
  INCREMENT of the current level bar (sums to ~100 between dings);
  unstated ⇒ at the cap, modeled `pct: undefined` never 0. The exp line
  PRECEDES its kill line, same second (4,887/4,909) — joins consume the
  pending exp line at the next credited kill, never search forward.
- Self `/who` row (keyed on the tailed character's name via
  `ParserConfig.characterName`, never a constant) states the loadout;
  skill-ups `You have become better at <Skill>! (n)`; Wiki skill names ≠
  client skill names (`1 Hand Slashing` vs `1H Slashing`) — classes.json
  carries the alias table measured from the log.
- **`Your <item> shimmers briefly.` / `feels alive with power.` IS A WORN
  FOCUS TALKING, NOT AN ITEM CASTING** (JOS-79, measured whole-log
  2026-08-06 — this entry previously said the opposite and it was wrong).
  All FIVE items that print it are focus items (Djarn's Amethyst Ring =
  Spell Haste II, Idol of the Underking = Improved Healing III, Polished
  Mithril Mask = Improved Damage II, Golden Efreeti Boots = Enhancement
  Haste II; Brell's Girdle, 6 lines, uncatalogued). A CLICKY CASTS ONE
  SPELL — Djarn's ring precedes 7,033 casts spanning the player's whole
  spellbook era by era — and the two heal/damage focuses precede a cast on
  only 2.0% of their firings because they fire when the spell LANDS. The
  combo module's rule that dropped a `castBegin` within 2.5 s of one was
  discarding 7,452 of 16,857 own casts (44.2%) and EVERY wizard observation
  in the log (0 whole-log, against 824 on Aug 06 alone), which is why a
  PAL/WIZ/DRU loadout was undetectable. The rule is gone; the event stays
  (it keeps 7,921 lines out of `unknown` and out of the emote miner) and
  says nothing about class in either direction. A self-announcing clicky
  needs its own observed sample before any rule acts on one.
- Feign death has NO failure line (1.14M lines: only the success emote).
  An alert cannot fire on the absence of a line — the group ships hidden.
- **A TELL'S TENSE SAYS WHETHER A PERSON SENT IT** (JOS-69, measured whole-log
  2026-08-06, 1,406,311 lines). `<Name> tells you, '…'` — 11 lines, EVERY one a
  real player. `<Name> told you, '…'` — 3537 lines, NOT ONE a person: 3050 are
  the pet-claim tell and the rest are a merchant NPC quoting prices (`Klok Sasz
  told you, 'I'll give you 3 platinum for the …'`). Present tense is a player,
  past tense is the game, and that is the whole discriminator. CAPITALIZATION IS
  NOT ONE: the log capitalizes a sentence-initial article, so a charmed pet reads
  `A gorgon told you, …` and looks exactly as proper-named as `Shiro tells you,
  …`. There is NO parsed tell event and there cannot usefully be a golden-tested
  one — the scrub drops all quoted speech, so no fixture can carry a tell — hence
  the `tells` alert group is a RAW trigger (`\] .+ tells you, '`) and its unit
  test constructs the sentence rather than committing a stranger's words.
- **SLOWS ARE A ROSTER, NOT A NAME** (JOS-69). A slow wearing off a mob is the
  ordinary named-target `buffFade` (`Your <Slow> spell has worn off of <mob>.`,
  52 lines: Shiftless Deeds 26, Languid Pace 23, Tepid Deeds 3) — the event kind
  cannot discriminate it, so the SPELL is the matcher, and it has to be the whole
  family because a slow is the spell you replace as you level. spells.json
  enumerates it by landing emote: `Someone slows down.` = the enchanter ladder
  (Languid Pace/Tepid/Shiftless/Forlorn Deeds), `Someone yawns.` = the shaman one
  (Drowsy, Walking Sleep, Tagar's/Togor's/Turgur's/Tigir's Insects); the NPC-only
  members (Rejuvenation, Energy Sap) are excluded because you cannot cast them.
  The ON-YOU side is two shared messages — `Your speed returns.` (21) and `You
  feel less drowsy.` (62) — that name no spell and resolve to all-slow candidate
  lists, so the alert reports the family and never which one. Its tripwire is one
  word away: `Your speed returns to normal.` is NINE HASTES (law 3).
- **CHARM AND MEZ ARE ROSTERS TOO — AND THE SPELL DB IS THE ORACLE** (JOS-84).
  `Your <spell> spell has worn off of <mob>.` is ONE sentence for three facts, and
  `rulesets.ts` decides which by matching the spell NAME: `charmSpell` ⇒ `uncharm`,
  `ccSpell` ⇒ `cc {refresh:true}`, neither ⇒ an ordinary `buffFade`. Both were
  hand-audited against an ENCHANTER's log, so `ccSpell` held exactly one bard song
  — Largo's Melodic Binding, level 20 — and nothing a bard casts after it. Every
  bard past the mid-twenties therefore held a crowd-control break the parser filed
  as a buff fade: no event, no alert, no way to tell ("Hey, for bard the charm
  break doesnt work? :D"). The completion is DB knowledge, not a guess:
  spells.json groups spells by LANDING MESSAGE, so "every castable spell sharing a
  message with a member the roster already classifies" is enumerable, and
  `tests/charmCcRoster.test.mts` RE-DERIVES both families from spells.json every
  run — a future scrape that adds a member fails the suite instead of going mute.
  Added: the bard holds (Kelin's Lucid Lullaby 15, Song of the Sirens 27,
  Crission's Pixie Strike 28, Solon's Bewitching Bravura 39, Sionachie's Dreams 40,
  Largo's **Assonant** Binding 51 — the direct upgrade of the one song that was
  covered, one word apart) and the Necromancer charm-undead tail (Thrall of Bones
  54, Enslave Death 60; the ladder's first three were covered by accident).
  **THE BARD'S BRAVURA IS A MEZ, NOT A CHARM**, measured on the reporter's slice:
  each own `You begin singing Solon's Bewitching Bravura IX.` is followed ~2 s
  later by `<mob>'s eyes glaze over.` (Bravura's own landing message), while every
  `<mob> has been charmed.` in that slice trails ANOTHER player's `begins casting
  Allure X.` by one second. So it fires "Mez / root broke", not charm break.
  **THE DB AND THE LOG DISAGREE ABOUT ITS NAME**: spells.json says `Solon's
  Bravura`, the log prints `Solon's Bewitching Bravura` (the scrape lost the middle
  word), so the stem answers to both — the oracle found that, not a reviewer.
- **THE FRIEND SYSTEM ANNOUNCES NOTHING** (JOS-69, same sweep). It prints exactly
  two things: `Friends currently on EverQuest Legends:` (43× — the `/friends`
  command's own output, a header + dashed rule + a /who-style roster row, printed
  only when you ask) and `<name> is now your friend.` (3× — the `/friend add`
  confirmation). No login line, no logout line. "A friend came online" is
  knowable only by polling `/friends` and diffing rosters, which is something the
  app would be DOING, not something the log says — so the group ships hidden
  beside feign-death and pet-death.
- Motes (the Item Upgrade System's currency) arrive ONLY inside ordinary loot
  lines, which already parse to `loot { item, source }`; every one the items
  catalog knows is `Mote of <tier> Potential` (10 tiers, 7 seen: Infinitesimal
  220, Minor 31, Lesser 16, Major 8, Potential 7, Greater 2, Superior 1). Nothing
  anywhere RANKS the tiers, so a per-tier loot filter would be an invented fact.
- `LogEvent.raw` INCLUDES the `[timestamp] ` prefix: a `^`-anchored raw
  alert regex silently never matches — anchor on `\] ` (tripwire test).
- WorldModel labels append a spawn-generation ` (N)` suffix that appears
  in NO log line (law 2) — `mobKey` strips it.

## Data sources

- **Scraper etiquette (LAW)**: every scraping script must run at a
  respectful rate limit (delay between requests), honor backoffs
  (429/5xx → exponential retry, obey Retry-After), and be re-runnable +
  idempotent (cache hits skip the network; partial runs resume, never
  duplicate output). Applies to scripts/scrape-*, itemLookup, and any
  future fetcher.

- eqlwiki.com MediaWiki API (helper: `scripts/sources/eqlegends.ts`).
  Scrapers (output committed): `scrape:posky` (quest-item cells: iterate
  `<li>` items — `<br>`-splitting once dropped trailing unhinted items),
  `scrape:bosses` (curated list incl. efreeti spawn-chain "Other:" bosses),
  `scrape:spells`, `gen:message-overlay`, `gen:icon`.
- Item knowledge: `itemLookup.ts` — local-first (posky) → wiki
  `{{Itempage}}` (`statsblock` flags / `relatedquests` / `notes`), userData
  cache with negative caching, live-loot background prefetch.
- **THE WIKI ART SHIPS IN THE BOX, AND THE FETCH IS THE FALLBACK** (JOS-198,
  `src/main/bundledImages.ts` + `resources/wiki-images/`). MEASURED: 780 files,
  3.75 MB — every DISTINCT `iconId` across the 11,341 items in items.json (751,
  1.21 MB, eqlwiki) and all 29 boss portraits in bosses.json (2.54 MB, p1999) —
  against a ~25 MB budget, so the whole set ships and there is no
  most-requested subset. They are COMMITTED, not fetched at build time: a
  build-time fetch would move the two volunteer wikis out of the startup path
  and into the RELEASE path and make `npm run dist` depend on someone else's
  uptime. `npm run fetch:images` (scripts/fetch-wiki-images.mts) regenerates
  them + `manifest.json`, which records the exact upstream URL, byte length and
  sha256 per file; `--seed <eqimg cache dir>` imports bytes already downloaded
  once (the politest request is the one never sent). Files are named by the
  cache's OWN `cacheFileName()`, so the bundle and `<userData>/image-cache` are
  ONE namespace with one naming function and cannot drift. The dir has three
  addresses over the app's life (project root in dev + e2e, inside `app.asar`,
  `app.asar.unpacked` after `asarUnpack`) and `bundledImageRoots` probes them in
  order — same problem and same answer as `sounds.ts`. electron-builder names
  `resources/wiki-images/**` EXPLICITLY, never `resources/**`: the gitignored
  soundpack dirs beside it would otherwise ship whatever a dev had downloaded.
  Null (a source build that skipped `fetch:images`) is a SUPPORTED state that
  falls back to the runtime cache. `tests/bundledImages.test.mts` holds the
  manifest against both data files and re-hashes all 780, so a re-scrape that
  adds a raid target or an icon id and forgets `fetch:images` goes RED instead
  of silently restoring a network dependency. The e2e proof is
  `bosses-week.e2e.mts`: under `EQ_E2E` a cache miss is a 1×1 blank, so
  `naturalWidth > 1` on a cold userData with no network can ONLY mean the bytes
  came from the bundle (measured 29/29 at 300×319 over `eqimg://`).
  CREDIT IS PART OF THE FEATURE, not decoration: Preferences → Thanks
  (`ThanksSetting.tsx`), a README Thanks section, and the 0.19.0 note all name
  both wikis — redistributing someone's art inside an installer without saying
  so is the thing this ticket refused to do.
- **Downloaded images are cached PERMANENTLY** (`src/main/imageCache.ts`):
  no image the app fetches may ever be fetched twice — and since JOS-198 above,
  a normal install fetches NONE, because the bundle is probed first. Item icons
  are served from `eqimg://item/<id>` — a `protocol.handle` on the DEFAULT session
  (registered in whenReady; `registerSchemesAsPrivileged` runs at index.ts
  module scope, before ready), backed by `<userData>/image-cache/item-<id>.png`.
  No window uses a custom `partition`, so the one handler covers the main
  window and every overlay. Disk hit ⇒ zero network; miss ⇒ ONE polite fetch
  (shared UA, in-flight dedupe so N windows can't double-request), written
  ATOMICALLY (temp file + rename — a torn PNG under a no-TTL cache would be
  permanent) and only if the bytes actually sniff as an image. NEGATIVES ARE
  NEVER CACHED **ON DISK** — a failure writes nothing, so nothing permanent can
  be wrong — but since JOS-198 a refusal IS remembered IN MEMORY for the
  session, and only when the HOST SPOKE: a status (404/415/500) or a body that
  is not an image. Nothing ever retried on a timer; the RENDERER re-asked, because
  an `<img>` that 404s is re-created on every scroll-back, tooltip reopen and
  overlay re-mount — each one a fresh 10 s fetch to a wiki that had already said
  no, plus a fresh errors.log line. A NETWORK failure (offline, DNS, TLS, our own
  timeout) is DELIBERATELY NOT remembered: it is the one failure plausibly on our
  side and plausibly gone a second later, and a just-woken laptop must not be
  locked out of every icon until restart — the same seam JOS-133 drew between the
  counter branch and the error branch. Bounded at 512, degrading past the cap to
  the old behaviour rather than evicting; session-scoped, so a wiki that fixes its
  500 is picked up next launch with no TTL or eviction policy to get wrong. On
  disk: no TTL, no eviction — wiki file ids are immutable. `itemIconUrl()` (ItemWindow.tsx) is the single renderer entry
  point; the upstream eqlwiki URL is spelled out only in imageCache.ts.
  A SECOND route on the same handler, `eqimg://url/<encodeURIComponent(url)>`,
  covers images the renderer holds as absolute URLs — today the 29 boss
  portraits in `bosses.json`. `bosses.json` keeps the REAL wiki URLs (scraped
  data stays diffable against the wiki); the wrapping is the app's concern and
  happens at render time via `cachedImageUrl()` (`renderer/src/lib/imageUrl.ts`,
  used by BossView). Its security boundary is a STRICT host allowlist —
  `wiki.project1999.com` + `eqlwiki.com`, matched by EXACT `new URL().hostname`
  equality after decoding, https only, no credentials, default port; anything
  else 404s having touched the network zero times (never substring/endsWith:
  `wiki.project1999.com.evil.com` must fail). Entry name = `url-<sha256[0:24] of
  the normalized URL>.<sniffed ext>` — hash because arbitrary URL text can't
  safely be a filename, sniffed extension because the URL lies (p1999 serves
  `.PNG` that is a png, `.jpg` that is a jpeg); a read probes the four known
  extensions (bounded constant, O(1), and the dir stays human-browsable).
  Normalization folds `:443` and drops the fragment, so one image is one entry.
  **`img-src` does NOT list `https:`** (index.html + overlay.html carry exactly
  `'self' data: eqimg:`): that is what makes "every downloaded image is cached"
  structurally true instead of a convention — a future raw `<img https://…>`
  fails visibly in dev instead of silently bypassing the cache. Widening the CSP
  back is never the fix; wrap the URL through the `url` route instead.
- Sound packs: og-packs registry (index: peonping.github.io/registry) —
  browse/install any of ~350 packs in-app. The single shipped default
  (`alan-rickman`, pinned tag) is GITIGNORED audio, self-provisioned via the
  same installPack path (one tarball GET, retried with backoff, additive:
  never removes or re-downloads an installed pack). The synthesized `default`
  chime pack is DELETED (generator + assets, Task #57) — it is not listed,
  generated, or shipped anywhere; peon/sc_marine are no longer provisioned but
  remain registry-installable. Alerts pointing at any retired pack are rewritten
  onto the analogous alan-rickman line by a ONE-TIME, version-stamped store
  migration (`migrateAlertSounds` in data/defaultPacks.ts, run from
  `getAlerts()`), so an upgrading user's alerts never go silently mute. Every
  picker pre-selects alan-rickman (`fallbackPack`), never `packs[0]`.
- **BRING YOUR OWN SOUND (JOS-68): `my-sounds` is a RESERVED pack with its own
  ROOT.** Three users asked for custom alert audio and one asked for the FF7
  fanfare, which copyright forecloses — import-your-own is the honest answer.
  The user's imports live in `<userData>/my-sounds/` (manifest + `sounds/`,
  the ordinary pack shape, so `readManifest`/`getSoundData`/every picker read
  it with the code they already had), NOT under `<userData>/soundpacks/`. That
  sibling root is what makes a registry collision UNREPRESENTABLE rather than
  unlikely: installs/uninstalls only ever join onto `userPacksRoot()`, `packDir()`
  resolves the reserved id to `userSoundsRoot()` FIRST, `installPack` refuses the
  name, and `installedIds()` never annotates a registry row with it. Identity +
  formats + the 25 MB cap + the id derivation are `shared/userSounds.ts`;
  `main/userSounds.ts` is the file work and takes its ROOT as an argument (the
  maps-library pattern) so tests/userSounds.test.mts drives real copies in a temp
  dir. **The file is COPIED, and the id BECOMES the filename** —
  `<soundId>.<ext>`, minted by `userSoundId()` (lowercase slug, capped at 64,
  de-duped with `-N`, always `/^[a-z0-9][a-z0-9-]*$/`) — so a moved original can
  never mute an alert and no byte of user-supplied path text reaches `join()`.
  The picker is `dialog.showOpenDialog` in MAIN (never a renderer file input), so
  NO absolute path crosses IPC in either direction; serving goes through the same
  `sounds:getData` + `isSafePackId` door as every other pack, never a second one.
  An EMPTY pack is not listed (a first dropdown entry whose second is blank).
  **A missing custom sound is NOT silence**: `getSoundData` answers the reserved
  pack alone with the shipped default's `buffWearsOff` line — the same choice
  `migrateAlertSoundRef` makes for an unrecognizable retired-pack id. Removal
  WARNS by naming the alerts that play it and then leaves their defs ALONE: the
  retired-pack migration rewrites refs into packs the APP withdrew, and this is
  the user's own removal (re-importing the file re-mints the same id). Managed
  from "My sounds…" in the alerts toolbar, deliberately NOT a section of the
  registry browser — one browses packs somebody published, the other manages the
  pack you made.

## UI conventions

- **NO EM DASHES IN USER-FACING COPY (owner, 2026-08-08 — JOS-106).** Every string
  a player can read uses a NORMAL dash with spaces (` - `), never U+2014 (—) or
  U+2013 (–) — renderer strings, overlay text, tooltips, preferences captions,
  empty states, alert/group copy, and `shared/releaseNotes.ts` (its HISTORICAL
  entries render in the What's-new panel exactly like the newest one, so they are
  copy too, not an archive). Where a dash reads badly, RESTRUCTURE instead of
  substituting: a parenthetical pair usually wants commas or parentheses, and a
  dash next to a signed number ("Your Location is 1414.20, -735.55") wants
  parentheses — locMarker.ts is that case. The GLYPH AS A DATA PLACEHOLDER (a
  meter cell with no value) is held to the same rule: `-`, or a short label where
  a bare mark reads as broken — which is what it did (`UNSTATED_AMOUNT`, below).
  This is about COPY, not about the tree: code comments keep their em dashes and
  this file's own prose does too. `tests/copyNoEmDash.test.mts` is the guard and
  its header states exactly what it covers and what it does not; it parses with
  the TS compiler and inspects only string/template/JSX-text nodes, because a
  whole-source grep would drown in comments. Two files are excluded on
  technical grounds (the Kokoro phoneme VOCABULARY, where U+2014 is a model token
  id; the TELEMETRY.md generator) and the exclusions are listed in the test.
  A third — an embedded PowerShell script's own `#` comments — went away with
  the script in JOS-182.
- **SAY WHAT THE LOG DID, NOT WHAT WE DID TO THE NUMBER (JOS-106).** A label
  describing our own bookkeeping reads as a defect to the person holding it: Monk
  Mend's healing lane was tagged `unvalued` / `amount not stated`, and a v0.12.0
  user filed the by-design label as a BUG inside a day (report
  01KZGFH4QDTVG7XNW4G24TZYR4). It is now `no amount` — one plain phrase, single-
  sourced from `UNSTATED_AMOUNT` (renderer/src/features/combat/healRows.ts) so
  the panel, the overlay and the hover title cannot drift, and said ONCE per row
  (the lane tag carries it; the stat run beside it is just the count, because
  repeating it is what made the row read like an error message). The long form
  stays where long forms belong — the hover title, never a caption.
- **State, never process**: no methodology captions, no script references,
  no how-it-works panels. Chips convey state (db/observed, permanent,
  inferred, casting…, ~ambiguous).
- **TOOLTIP AND CAVEAT DIET (owner, 2026-08-05).** The UI does the talking;
  player experience fills the rest. Tooltips are for enabling an action or
  naming a control — one clause, no caveats, never on an input the user types
  into. Do not footnote where a number came from or how it might be wrong;
  when stated-vs-inferred genuinely matters, one word ('est.', the existing
  chips) beats a sentence. TEACHING is welcome when it is collaborative —
  a dismissible explainer that helps someone use a feature successfully (the
  planner's exaltation card is the model) — never defensive source-caveating.
  When in doubt: delete the tooltip and let the label earn its keep.
- **BACK MEANS WHERE YOU CAME FROM, and there is ONE mechanism for it**
  (JOS-43). Every cross-view link funnels through the `useAppRouting` openers
  (and cross-window toasts reach the same ones via `applyDeepLink`), so the
  navigation-origin STACK lives at that seam — `navOrigin.ts` (pure, node-tested)
  plus `useNavSeam` in appRouting.ts. An ANCHORED link parks the tab it leaves; a
  BARE opener is a tab switch and clears; MANUAL navigation (`selectView` — nav
  drawer, title bar, Preferences sections) clears; a NATIVE drill (a row in the
  list you are standing in) clears. Receivers take the same `NavBack` object and
  keep their own fallback, because `back()` reports whether it navigated — a
  drill reached natively behaves exactly as it did before. NEVER add a per-view
  `cameFrom` prop: five of those are five opinions about what Back means. A back
  affordance NAMES ITS DESTINATION ("Back to Planner"), and a breadcrumb root
  keeps meaning the place it reads. Session-lifetime only, nothing persisted.
  **AND THE MOUSE'S BACK BUTTON PRESSES THE AFFORDANCE THAT IS ON SCREEN** (JOS-201).
  mouse4 is not a second navigation model: `backTargets.ts` (pure, node-tested) says
  the innermost REGISTERED affordance wins and the app-level `nav.back()` is the
  fallback slot behind it, and each drill registers *the same expression its own
  button runs* (`useBackTarget` in appBack.tsx) — never a parallel opinion. A target
  reports whether it handled the press, so an inert one falls through and a press with
  nowhere to go is a no-op. The provider sits ABOVE `App` in main.tsx because effects
  run children-first and "the last thing to try" must be a slot, not a race. THE INPUT
  IS WINDOW-SCOPED AND STAYS THAT WAY: a BrowserWindow `app-command` listener on the
  MAIN window only (`src/main/appBack.ts`), gated on `browser-backward` and on that
  window having focus — no `globalShortcut`, no low-level mouse hook, no polling, and
  nothing at all while EverQuest is foreground, where mouse4 keeps meaning whatever the
  player bound it to. `browser-forward` is deliberately unhandled (the origin stack is
  consumed by Back; there is no forward to walk). The combat meter's drill breadcrumb
  is deliberately NOT a target — an in-panel expansion is not a page. The e2e raises
  the app-command on the real window (`deep-link-back.e2e.mts`), which drives every
  link but the OS's: Chromium handles the physical X-button in the browser process, so
  it never reaches the renderer as a DOM mouse event on Windows — which is why this is
  an `app-command` handler and a DOM listener would not work.
- **A VIEW UNMOUNTS ON EVERY TAB SWITCH, so `useState` in one is a promise you
  cannot keep** (JOS-90, JOS-97, JOS-116 — the same bug three times).
  `App`'s `ViewContent` mounts exactly ONE feature view at a time, so anything a
  view is holding dies when the user glances at another tab. That is correct for
  ephemeral things (a popover, a hover); it is a DEFECT for anything the user set
  on purpose — a filter they ticked, a drill they opened, an ability they
  expanded. Those go in a renderer pref (`eq.<feature>.*` in localStorage, the
  `useCombatPrefs` idiom) or above the switch boundary. Two traps, both paid for:
  **an effect cannot tell a click from a mount** — `useEffect(() => reset(),
  [selection])` fires on mount, and again when an async value (the global fight
  id) lands a frame later, wiping exactly what was just hydrated, so the reset
  belongs on the CHANGE HANDLER (the overlay reached this first); and a stored
  value must DEGRADE rather than error — a drill naming a source that has since
  left the fight resolves to level 1 by itself (JOS-105). Prove it with a spec
  that actually navigates and asserts the view was GONE first (sky-filters is the
  template); a unit test of the read passes while the feature stays broken.
- Search: input echoes instantly; filter on `useDeferredValue`; lowercase
  `searchKey` computed once per data change; long fixed-height lists
  windowed via `lib/useWindowedRows`, variable-height cap+paginate. These
  surfaces are RENDER-bound (<1ms compute) — no workers/DBs.
- Formatting: rates `21.7k dps` / `2.3M dps` (word 'dps' after number, k/M
  scaling); totals keep k/M with NO unit word. ONE source: `lib/formatRate`
  (`formatRate`/`formatNum`) — every meter/overlay/drill-down/tooltip uses it,
  NO `/s` anywhere (Task #54 sweep). Dates/times through `lib/formatDate`
  (user-local; never UTC or epoch-day math). Tier chips via `lib/tierChip`
  (dark fg on tier bg, WCAG AA).
- **A growing list lives in a FIXED-height scroll box.** The combat log was
  `flex: 0 0 auto` + `minHeight`, so it sized to its 150-line content, couldn't
  shrink, and squeezed the whole dashboard to 0px (the tab read as "just a
  scrolling combat log"; the app's content area is `overflow:auto`, so
  `height:100%` clamps nothing). Any append-only panel gets an explicit height +
  its own `overflow:auto`; the panel that must survive gets `flexGrow:1` +
  `minHeight:0`. Verified by the headless e2e harness, which measures it.
- **Hydration is a state, and the UI must show it.** During the startup replay
  every snapshot describes the PAST (an hours-old fight is `current`).
  `CombatSnapshot.hydrating` (engine: true until `setLive()`) gates a quiet
  "Reading log…" placeholder in CombatView + the overlay meter — never a
  churning fake-live meter. Task #56.
- **Fight vs Overall is an explicit SCOPE, never an automatic switch.** A
  `Fight | Overall` toggle (sibling of Dashboard/Timeline, Outgoing/Incoming;
  persisted `eq.combat.scope`) drives one filter — `scopeOptions()` in
  dashboardData.ts, shared by the main view AND every overlay kind, so a fight
  meter can never show zone data. Fight scope keeps the LAST fight on screen
  between pulls (auto-swapping to the zone aggregate was rejected: it moved the
  ground under you mid-session) but LABELS it honestly — head row reads
  "Current fight (live)" only while a pull is open, else "Last fight — <name>",
  and a locked overlay (no selector) tags its header `· LAST`. The head row's
  VALUE stays the `__live__` sentinel so it re-resolves each tick. No fights at
  all ⇒ quiet empty state, never borrowed zone data. `liveFallback` is GONE.
- Celebrations (confetti/sound) fire EXACTLY ONCE PER LIVE TRANSITION;
  hydration seeds a silent baseline; manual actions never celebrate.
  **THE SILENT BASELINE ONLY HOLDS IF A SWITCH DELIVERS A SNAPSHOT AND NEVER A
  DELTA** (JOS-60). Every detector's guard is "reset the baseline on
  `log:character`, then compare" — so ONE delta arriving before that message,
  carrying the incoming character's history, is read as news and celebrates all
  of it. That is exactly what the mid-replay heartbeat flush did, and it is why
  the registry now discards a replay's accumulation instead of flushing it.
  Never fix this class of bug with a wall-clock suppression window: the cause is
  a delta that should not exist, and the cure is not sending it. "Once per
  transition", never "once ever": a REPEAT boss kill is a transition, so the
  bossDefeat sound fires on every kill (owner, 2026-08-04 — "every time is worth
  celebrating"; the first-kill-only `newDefeats` predicate was retired for it).
  Rate limiting belongs to the alert's own cooldown, not to the detector.
  And EVERY kill means every kill CREDITED TO YOU (owner, 2026-08-05 — a boss
  killed by a stranger in open world was celebrating): the credit test is the
  log's own exp line joined to the slain line (`KillTierRun.credited`, joined in
  main/modules/kills.ts on shared/kills.ts `KILL_EXP_JOIN_MS`), which includes a
  group-mate's blow (party exp is exp) and excludes a passer-by. TRACKING still
  counts every defeat — `bossKills` gates celebration alone.

- **TWO TEXT SIZES, AND THEY ARE DIFFERENT MECHANISMS ON PURPOSE (JOS-123).**
  The MAIN window scales with an Electron ZOOM FACTOR: `shared/uiScale.ts` holds
  the five-stop ladder (90/100/110/125/150 — Chromium's own zoom stops around
  100%) and the normalizer that SNAPS to it, so a stored value between two stops
  can never leave the Preferences buttons unlit. It is persisted as the top-level
  `uiScale` store key (additive + optional ⇒ no schema bump; absent reads as 1, so
  an upgrade resizes nobody) and applied at window CONSTRUCTION —
  `webPreferences.zoomFactor` in windows.ts — because the alternative is a window
  that visibly resizes its own contents on every launch. The IPC setter zooms the
  live window in the same call it stores, since a size control you must relaunch
  to evaluate cannot be evaluated. The floating OVERLAYS keep their own per-kind
  `textScale`, a CSS `zoom` on the CONTENT PANE only (chrome unscaled —
  overlayScale.tsx), and the two must not be merged: an overlay is a small
  always-on-top window whose header and footer have to keep laying out against the
  real window width. So the main window is never given a `textScale` and no
  overlay window is ever given a `zoomFactor`; `tests/uiScale.test.mts` pins both
  halves and `tests/e2e/text-size.e2e.mts` proves the size over TWO real launches.
  The accessors live in `src/main/uiScale.ts` rather than store.ts because
  store.ts is AT the 400-code-line ceiling and the answer is a split: it now
  exports the `settingsStore` handle for exactly that, which is a door for moving
  the read-through-a-normalizer pattern OUT, never a licence to skip a normalizer.

- **A COLOUR A USER PICKS IS A VALUE THAT REACHES A STYLE PROPERTY (JOS-125).**
  The cursor ring's colour is stored as `cursorRing.colorHex` — one more field on
  the EXISTING blob, so store.ts gained nothing, the 4→5 migration needed no bump
  (the same normalizer defaults it, and an absent key reads as white) and the
  live-push that already resizes a running ring recolours it for free. Two rules
  make the field safe and honest. FIRST, `normalizeRingColor` accepts `#rgb` /
  `#rrggbb` AND NOTHING ELSE, because the value ends up in
  `element.style.borderColor` in the ring window: `red`, `rgb()`, `var(--x)` and
  anything carrying a `;` are refused, which costs nothing because
  `<input type="color">` cannot produce them and buys the guarantee that a store
  file can never write a CSS declaration. SECOND, ONE function turns the hex into
  the drawn colour (`ringStrokeColor` = the hue at the fixed 0.9 stroke alpha),
  and all three drawings read it — the ring window, the live sample in
  Preferences, and cursor.html's pre-config rule, which is asserted against it by
  `tests/cursorRingColor.test.mts` so the two cannot drift. The alpha and the
  three shadows are NOT settings: they are what makes the ring readable over a
  snowfield, and a player asking for a colour is not asking for less contrast.
  The default is white exactly, so an upgrade recolours nobody.

## Shipping

- CI (`.github/workflows/build.yml`) runs `npm test` — the FULL golden-window
  suite, since `tests/fixtures/*.log` is now committed (see Operating model).
  Only the full-log tests still skip there (the real game log isn't in CI).
- CI: **publish on tags ONLY** (reworked 2026-08-03; the per-push `-main.<run>`
  prerelease spam is gone — it filled Releases with lexically-mis-sorted
  auto-builds). Push to main → typecheck/test/build, installer as CI artifact,
  nothing published. Tag `v*` → the one publish path: a full release whose
  version is STAMPED FROM THE TAG in CI (package.json is never committed with
  it, and can't drift from the tag — the old "bump after tagging" rule is
  dead). Release process: `git tag vX.Y.Z && git push origin vX.Y.Z`. Semver,
  increment per release; first stable is v0.1.0.
- **A TAG MAY NOT SHIP WITHOUT RELEASE NOTES** (JOS-73). `src/shared/releaseNotes.ts`
  is committed source (the bundler inlines it, like the spell DB), and the app's
  Preferences → What's new panel reads it — so a missing entry is not a crash, it
  is SILENCE: the fleet auto-updates and the panel has nothing to say about the
  build everyone is now running. The release (tag) job runs
  `node --import tsx scripts/check-release-notes.mjs $env:GITHUB_REF_NAME`, which
  refuses a tag with no entry and re-runs the same `releaseNotesProblems` shape
  check `tests/releaseNotes.test.mts` runs. Write the entry BEFORE tagging.
  **WHO WRITES IT: THE INTEGRATOR, AT RELEASE CUT (owner rule 2026-08-10).**
  Notes are a release-driven activity, not a work-driven one. Worker branches
  never touch `releaseNotes.ts` — the integrator drafts the whole entry from
  the release's merged tickets when the tag is cut. (Two workers in one wave
  independently appended bullets to an already-shipped version; per-worker
  notes also can't see the release's shape or apply the five-bullet cap.)
- **RELEASE CADENCE: tag only when the user asks, or at a clearly STABLE
  point** — features verified end-to-end, the gauntlet green, no waves in
  flight. Commits land on main continuously; a tag is a deliberate act,
  never an automatic one and never mid-wave. When in doubt, don't tag —
  the next stable point is never far.
- **main.yml BRIDGE (do not remove)**: every install to date polls the 'main'
  channel feed. A stable release natively writes only latest.yml, so the tag
  job uploads a copy as main.yml on the same release — semver puts `X.Y.Z`
  above `X.Y.Z-main.N`, so old main-channel installs step up to stables
  instead of stalling forever. Azure Trusted Signing wiring is inert
  until 6 `AZURE_*` repo secrets exist (account `jmoyers-eqtools` — an
  EXTERNAL Azure resource name, deliberately not renamed; endpoint
  `https://eus.codesigning.azure.net/`; identity validation pending).
- **`npm ci` DOES NOT INSTALL ELECTRON'S BINARY ANY MORE.** `.npmrc` sets
  `ignore-scripts=true` (no dependency's install hook executes — the npm
  compromise vector), so after any `npm ci` / `npm install` you MUST run
  `npm run deps:electron` or dev/dist fails on a missing Electron binary.
  It is the ONE package in the tree that needs its hook (esbuild's is
  redundant — its binary ships in `@esbuild/win32-x64`; everything else
  declares only `prepare`/`prepack`, which npm never runs for registry
  tarballs). Both CI jobs do it as an explicit step. Explicit `npm run <x>`
  is unaffected by the flag; only lifecycle hooks are.
- **build.yml is TWO JOBS and that is a security boundary**: `build` (non-tag
  refs, `contents: read`) and `release` (tag refs, `contents: write`). Token
  permissions are per-job and static, so one job covering both paths had to
  hold write on every push to main. Keep the two preludes in sync; never
  merge them back into one job. All `uses:` are pinned to commit SHAs (a
  `@v4` tag is mutable) — re-resolve with
  `gh api repos/<o>/<a>/git/ref/tags/<t> --jq .object.sha` when bumping.
  Tagged releases also publish `SHA256SUMS.txt` alongside the installer.
- **Unsigned build ⇒ the GitHub account IS the trust root.** electron-updater
  verifies the sha512 from the feed (so a tampered *download* fails), but with
  no Authenticode publisher it cannot verify *who* built the release. Anyone
  who can publish a release here can ship a silent, per-user, no-UAC update to
  every install. Azure signing closes this (`verifyUpdateCodeSignature` turns
  on for signed Windows builds); until then, tag/release access is the control.
  See `SECURITY.md`, which states this plainly to users.
### Installer architecture

- Build chain: `npm run dist` = `electron-vite build` → electron-builder
  NSIS (`electron-builder.yml`). **Per-user install is load-bearing**:
  `oneClick:true, perMachine:false` installs to `%LOCALAPPDATA%\Programs`
  with NO UAC ever — which is what lets electron-updater silently
  self-install and relaunch (the Discord model). Never flip perMachine.
- **Windows 10+ gate** (`customInit` in `build/installer.nsh`, JOS-32):
  `${IfNot} ${AtLeastWin10}` → one-sentence MessageBox + `Quit`. Electron
  dropped Win7/8/8.1 at v23, so the old behaviour was a successful install
  of an exe that dies on launch. `customInit`, NOT `preInit` — preInit sits
  above installer.nsi's `!ifdef BUILD_UNINSTALLER`, so it would also gate
  the build-machine uninstaller-writing pass and the uninstaller itself.
  **The version lie is the trap**: WinVer.nsh calls `GetVersionEx`, which
  reports 6.2 to an unmanifested process on Win10/11 — a naive gate blocks
  everyone. NSIS 3's `ManifestSupportedOS` defaults to Win7+8+8.1+10 and
  electron-builder never overrides it, so the truth comes through; that was
  VERIFIED by compiling a probe with the cached makensis (nsis-3.0.4.1,
  v3.04), dumping the four `<supportedOS>` GUIDs out of the stub, and
  running it on 10.0.22631. Re-run that probe if electron-builder ever
  starts setting ManifestSupportedOS. `/SD IDOK` so a `/S` run refuses
  without blocking on the dialog.
- **Add/Remove Programs**: the entry lives at
  `HKCU\Software\Microsoft\Windows\CurrentVersion\Uninstall\<UUIDv5(appId)>`
  (`d1172923-5a3d-5d6c-812f-04090617a582` today) — the key is named by GUID, not
  by product name, so grep by DisplayName. app-builder-lib's
  `registryAddInstallInfo` writes it UNCONDITIONALLY (right after file
  extraction in `installSection.nsh`); nothing in electron-builder.yml gates it,
  and a fresh install of a current build registers correctly (sandbox-verified).
  It writes InstallLocation only to `HKCU\Software\<guid>`, NOT to the uninstall
  key, so Settings showed a blank location — `build/installer.nsh`
  (`customInstall`, auto-included from buildResources) mirrors it. That file is
  included at the TOP of the generated .nsi, BEFORE multiUser.nsh defines
  `UNINSTALL_REGISTRY_KEY`; spell the path out from `UNINSTALL_APP_KEY` (a `-D`
  define, always present) — using the not-yet-defined one compiles fine but
  yields an installer that dies instantly with 0xC0000005.
- **An installed app with files but NO uninstall entry is a RACE, not a build
  bug.** The uninstaller does `RMDir /r $INSTDIR` first and `DeleteRegKey` LAST,
  and an NSIS uninstaller launched without `_?=` relaunches itself from %TEMP%
  and the process you waited on exits IMMEDIATELY. So tier-1's
  `Uninstall*.exe /S` + an immediate reinstall lets the detached tail delete the
  keys the reinstall just wrote. Never reinstall after an uninstall without
  POLLING for the install dir and the uninstall key to disappear.
- **Uninstall asks before discarding user data.** `deleteAppDataOnUninstall`
  stays `false`; the ONLY deletion path is `customUnInstall` in
  `build/installer.nsh`, which prompts "Keep your settings and history?"
  (Yes = default = keep) and only on No does `RMDir /r "$APPDATA\everquest-companion"`.
  A `/S` uninstall NEVER prompts and ALWAYS preserves — that is the contract the
  sandbox harness and every scripted uninstall rely on. It must never widen to
  `%APPDATA%\eq-tools` (the pre-rename backup the one-time seed reads) or
  `%APPDATA%\everquest-companion-dev` (the running dev app). Gotcha: `${Silent}`
  is USELESS for that test — oneClick's `un.onInit` calls `SetSilent silent`
  after its own confirm dialog, so the section always sees silent; detect the real
  `/S` from `${GetParameters}`/`${GetOptions}` instead.
- Exe branding: `signAndEditExecutable:true` needs the winCodeSign cache;
  its archive fails to extract on Windows without symlink privilege — run
  `scripts/seed-wincodesign.ps1` once per machine (extracts skipping two
  macOS dylib symlinks). Icon generated by `gen:icon` → `build/icon.ico`.
- Publish: `publish: github jmoyers/everquest-companion`; artifacts
  `everquest-companion-Setup-<version>.exe` + `.blockmap` (differential updates) +
  `latest*.yml` channel feeds under `release/<version>/`. Unsigned for now
  (SmartScreen "More info → Run anyway" in README); Azure signing turns on
  via repo secrets only — CI args are already conditional.
- Auto-update: electron-updater in `src/main/updater.ts` — channel from
  store ('main' default → allowPrerelease+channel main; 'stable' →
  latest); check at +10s then 30min; toast → quitAndInstall(silent,
  relaunch); dev-guarded on `app.isPackaged` EXCEPT channel IPC (settings
  UI needs it in dev). Single-instance lock makes the relaunch clean.
- First-run self-sufficiency: the default sound pack self-provisions from
  its pinned registry tag (gitignored, so installers ship without it); spell
  DB/overlay baseline are inlined in the main bundle; EQ dir resolves via
  env → registry → drive-sweep with the Settings-gear override; zero logs
  anywhere → quiet empty state, never an error.
- **DISCOVERY SPAWNS NOTHING, AND THAT IS AN AV DECISION AS MUCH AS A SPEED ONE
  (JOS-184).** `src/main/log/discovery.ts` used to answer its two Windows
  questions by shelling out: EIGHT `reg.exe query <hive> /s /f EverQuest
  /t REG_SZ` subprocesses whose stdout was regex-grepped, plus `wmic
  logicaldisk get DeviceID,DriveType` for the drive letters. Both now read
  in-process through `native-reg`. The old shape was ~150 ms of blocked main
  thread that SCALED with the user's Uninstall hive (the reason the JOS-112
  ceiling exists) — and, more to the point, "unsigned exe sweeps the uninstall
  registry and enumerates disks, seconds after install" is precisely the
  behavioural signature a heuristic engine scores, on the one app that cannot
  answer with an Authenticode publisher yet. Measured replacement: ~6 ms.
  Two invariants, both pinned by tests in `tests/eqDiscovery.test.mts`:
  * `eqInstallPathValue` reproduces the OLD command's contract exactly —
    an `InstallLocation`/`InstallPath`/`InstallDir` whose DATA contains
    "everquest". That was verified against the real `reg.exe`, not read off
    the docs: with `/t REG_SZ` present a KEY-NAME match prints NOTHING (so the
    old line regex could only ever fire on a data match), and a key-name match
    without `/t` prints the key line alone and none of its values.
  * `fixedDrives` reads `\DosDevices\<letter>:` out of
    `HKLM\SYSTEM\MountedDevices` (user-readable, verified non-elevated). A
    mapped NETWORK drive is never in that key, which is the property that
    replaces the DriveType-4 filter and the whole reason the offline-share hang
    stays fixed. Removable local volumes now ARE included (DriveType 3 excluded
    them) — a superset, costing instant `existsSync` calls on local devices.
  `native-reg` and not `registry-js` because `.npmrc`'s `ignore-scripts=true`
  is load-bearing: native-reg ships its N-API prebuild INSIDE the tarball
  (node-gyp-build resolves it at require time), registry-js DOWNLOADS one from
  an install script. It is `require`d LAZILY inside `discovery.ts` and its
  failure is swallowed — this module is on the startup path, and a bad `.node`
  must cost one of three ways to find the install, not the whole launch.

### Product identity + channel isolation (Task #58)

- ONE name everywhere: `everquest-companion` (package.json `name`, appId
  `com.jmoyers.everquest-companion`, installer
  `everquest-companion-Setup-<version>.exe`, install dir
  `%LOCALAPPDATA%\Programs\everquest-companion`, store file
  `everquest-companion-progress.json`, log prefixes
  `[everquest-companion]` / `[everquest-companion:error]`, scraper UAs).
  The DISPLAY name stays "EQ Legends Companion" (productName, shortcut,
  exe). `eq-tools` survives ONLY as the legacy-migration source in
  `channel.ts`/`store.ts` and in git history. NSIS install dir + the
  updater cache dir derive from package.json `name` (electron-builder
  `APP_PACKAGE_NAME` = `appInfo.name`), NOT productName — that's why the
  harness paths changed with the rename.
- Channels are decided in `src/main/channel.ts`, the FIRST import of
  index.ts (it must run before electron-store is constructed at module
  scope). Nothing else in the tree hardcodes a userData path — soundpacks,
  errors.log, item/registry caches and the learned overlay all resolve
  through `app.getPath('userData')`, so redirecting the root redirects
  everything:

  | channel | when | userData |
  |---|---|---|
  | prod | `app.isPackaged` | `%APPDATA%\everquest-companion` |
  | dev | not packaged | `%APPDATA%\everquest-companion-dev` |
  | e2e | `EQ_E2E=1` | temp dir (`EQ_E2E_USER_DATA` or `mkdtemp`) |

- Separate dirs ⇒ separate single-instance locks (Chromium keys
  ProcessSingleton off the user-data dir), so the installed app and the dev
  app genuinely run at the same time — verified with two Electron processes
  that both won `requestSingleInstanceLock()` on different dirs and where
  the second lost on a shared dir. Never "fix" a second instance quitting by
  weakening the lock; check the channel first.
- ONE-TIME SEED (prod + dev, never e2e): if the channel's dir does not exist
  and `%APPDATA%\eq-tools` does, an allowlist is COPIED
  (`eq-tools-progress.json` → `everquest-companion-progress.json`,
  `message-overlay.json`, `item-knowledge-cache.json`,
  `registry-cache.json`, `soundpacks/`) and a `migrated-from.json` stamp is
  written. Chromium caches / lockfile / errors.log are deliberately skipped.
  The old dir is never modified — it's the backup. Guard is "target dir
  absent", so it can't run twice; failures log and startup continues.
- **UPDATE CONTINUITY BREAK (conscious)**: changing appId + `name` means
  per-user NSIS sees a NEW app. An existing `eq-tools` install will NOT be
  upgraded in place and will NEVER chain-update to the renamed builds — it
  keeps polling its own feed and silently stays behind. Every existing user
  (this machine included) must uninstall the old app ONCE, then run the new
  installer; their state carries over via the seed above. Documented for
  users in README ("Already have an `eq-tools-Setup` build installed?").

### Settings migrations (persisted store schema)

- **LAW: any commit that changes a persisted shape ships a migration in the
  SAME commit.** Bump `CURRENT_SCHEMA_VERSION` in
  `src/main/storeMigrations.ts`, append a step to `MIGRATIONS`, add a fixture.
  That rule is the whole reason "an upgrade is clean, going back indefinitely"
  can be true: a store written by ANY past build must load in today's build,
  and auto-update means users jump many versions at once. `MIGRATIONS` is
  APPEND-ONLY — never renumber, edit a shipped step, or delete one.
- An explicit integer `schemaVersion` INSIDE the file, not app semver: CI
  stamps versions from tags and dev runs unstamped, so electron-store's
  semver-keyed `migrations` fire in surprising orders across channels. Absent
  ⇒ 1 (every pre-framework store), and the chain runs 1→2→…→CURRENT.
- Runs ONCE at startup from store.ts module scope, BEFORE `new Store()`, so no
  reader ever sees a pre-migration shape — and after channel.ts's one-time
  `eq-tools` seed (store.ts imports channel.ts first). Ad-hoc fixups in read
  paths are the anti-pattern it replaces: the flat `overlay` →
  `overlays.fight` fold moved out of `getOverlayConfig()` into migration 1→2.
  (`alertSoundMigration` predates the framework and keeps its own stamp — its
  "respect a user who re-points an alert" semantics aren't schema-shaped.)
- Migration 1→2 is REAL work, not a dormant no-op: it also recovers the
  top-level `progress` blob that commit 41831cc orphaned when it re-keyed
  progress by character (salvaged under the reserved id
  `legacy:pre-character` only when no real character exists — never guess an
  owner) and drops the dead `liveLoot` map.
- **Startup never dies here.** Unreadable ⇒ untouched, unstamped. Unparseable
  ⇒ QUARANTINED to `<name>.corrupt.json` and start fresh (conf leaves
  `clearInvalidConfig` false, so one truncated write otherwise throws on every
  read forever). A step that throws ⇒ keep what succeeded, stamp the last
  version that fully landed, retry next launch. Before the first write the
  original bytes are copied to `<name>.v<from>.backup.json`, once per source
  version (a later run never overwrites the pristine copy).
- **Downgrade (file newer than the build)**: log, back up, and leave the file
  ALONE — no down-migration, no reset, no stamping backwards. The old build
  runs best-effort, which is safe because every reader defaults on a missing
  key and electron-store rewrites the whole parsed object, so future keys
  survive round-trips. Verified by `tests/storeMigrations.test.mts`, which
  drives the pure runner + the file half with authored fixtures of the real
  historical shapes (no Electron, never skips).

### Installer testing strategy (three tiers)

1. **Local self-test** (any dev machine, no elevation): run the Setup exe
   `/S` → assert files under `%LOCALAPPDATA%\Programs\everquest-companion`, Start-menu
   shortcut, branded exe metadata; launch (since Task #58 the installed app
   has its OWN userData + lock, so it opens its own window BESIDE a running
   dev app — that's the PASS; it no longer just focuses dev);
   `Uninstall*.exe /S` → assert cleanup, appData preserved. Cheap smoke for
   every dist build.
2. **Windows Sandbox** — the REAL clean-machine test: disposable pristine VM,
   maps `release/` read-only + a results folder; LogonCommand silently
   installs, verifies files/shortcut/**Add-Remove-Programs registration**/
   process-start, AND asserts the fresh-machine experience (no EQ installed →
   app still boots to the zero-logs empty state), uninstalls, asserts files
   AND the uninstall key are gone, then writes PASS/FAIL to the mapped results
   dir. 19 checks; `arp-*` names each ARP field individually so a failure says
   exactly what was missing.
   **Invoke via `scripts/sandbox/run-installer-test.ps1`** (never the raw
   .wsb): it force-closes a stale VM (only ONE sandbox instance is allowed
   machine-wide — a leftover makes the next launch fail), refuses to boot
   without a CURRENT `everquest-companion-Setup-*.exe`, parks the VM window on
   the first NON-PRIMARY monitor at z-order bottom without stealing focus
   (`-Minimize` / single-monitor → minimized), force-kills the client when the
   results land (an in-guest shutdown pops a modal on the host desktop), and
   exits 0/1. The user games on the primary monitor — keep it clear.
   Harness invariants: it is ASCII-only (the guest's PS 5.1 reads a BOM-less
   .ps1 as ANSI), always writes a verdict from a `finally` (a silent exit is
   indistinguishable from a hung VM), and POLLS after uninstall instead of
   trusting `Start-Process -Wait`. Requires the `Containers-DisposableClientVM`
   Windows feature (one elevated enable + reboot; on this machine the first
   enable half-applied — if `WindowsSandbox.exe` is missing while DISM says
   Enabled, disable+re-enable elevated and reboot again).
3. **Docker servercore** (`scripts/docker/`) — headless file-level
   fallback: silent install + file/ARP-registry verification only (no GUI
   launch test); throws on the first failure. Use when Sandbox isn't
   available.

Always test the CURRENT `npm run dist` output, not a stale release/ exe —
a clean-machine pass on an old build proves nothing about today's
first-run provisioning.

### Post-release feedback smoke test (`npm run smoke:release`)

ON-DEMAND ONLY — not in CI, not in `npm test`, not in `test:e2e`. Run it once
after a release is published. It boots a sandbox that DOWNLOADS the published
installer (verified against the release's `SHA256SUMS.txt`), plants a mocked
EQ log at the discovery path, launches the installed app with
`EQ_SMOKE_FEEDBACK=<nonce>`, and lets `src/main/smokeFeedback.ts` file ONE real
bug report through the ordinary `submitFeedback` path — every normal layer,
NO endpoint override, refused outright under `EQ_E2E`. The HOST half then reads
the LIVE backlog through `src/main/triage/store.ts` (profile `eqc`) and asserts
the row + env, the slice upgrading to `present`, and — the point of the whole
thing — that the downloaded slice CONTAINS the run's nonce and does NOT contain
`CHAT_MARKER`. The mocked log puts the nonce only on keep-class combat lines and
the marker only on drop-class chat lines, so those two facts ARE the scrub proof,
measured on the bytes that made the round trip. A pass cleans up after itself
(`forget` + `wipe --install`); a failure leaves the row and object as evidence.
A `closed` answer is its OWN verdict (kill switch on, plumbing proven), not a
failure. Reuses the tier-2 lifecycle via `scripts/sandbox/sandbox-lifecycle.ps1`.
- Overlay: Electron suffices for windowed/borderless EQ; exclusive
  fullscreen cannot be overlaid by anything (native-helper escape hatch:
  feed it the same snapshot IPC). Two spawnable KINDS (Task #54) — 'fight'
  (current-fight meter + FIGHT selector) and 'overall' (zone meter + ZONE-
  session selector) — one overlay.html bundle, kind read from `?kind=` on the
  URL; each has its own persisted config (`store overlays.<kind>`) and can run
  simultaneously. All overlay IPC channels take the kind as their first arg;
  `onOverlayState` payload is `{kind, open}`. Interactive mode adds a dense
  selector + a mini drill-down (bar→flat skill list, back-chevron); locked mode
  stays fully click-through but RENDERS the persisted drill read-only. The
  drill persists per kind in `overlays.<kind>.drill` (config IS the drill
  state — no renderer mirror; stale ids render level 1 without clearing).
  EIGHT kinds now: fight/overall (damage), heal-fight/heal-overall, events,
  buffs + debuffs (JOS-89, split by JOS-119 — see below),
  and toast (celebration cards — docs/plans/celebration-toasts.md: transient
  top-center, hover pins, queue reducer in overlay/toastQueue.ts; producers in
  App.tsx, payloads resolved in main/toast.ts). The toast is the ONE kind that
  defaults OPEN (owner, 2026-08-05 — it is invisible and click-through except
  for the seconds a card shows; schema v9 corrects stores written at the old
  default) and it has NO SOUND of its own: the seeded boss/quest ALERTS speak
  on the same events, so the picker, `overlays.toast.sound|volume` and the
  `toast:sound` channel are all gone.
- **SCROLLING AND CLICK-THROUGH CANNOT BOTH BE TRUE OF THE SAME PIXEL (JOS-138).**
  A 0.14.0 report: pin an overlay and its scrollbar stops working. That was true
  by construction. Pinned is `setIgnoreMouseEvents(true, {forward:true})`, and
  `forward` forwards mouse MOVES and nothing else (Electron posts WM_MOUSEMOVE
  from its WH_MOUSE_LL hook — there is no wheel in it); a wheel notch goes to
  whatever the OS hit test finds under the cursor, which for a click-through
  window is the game. So the wheel cannot arrive unless the window stops ignoring
  the mouse for as long as it takes, and the owner's disposition (2026-08-09,
  "we should allow scroll") is paid for in pixels: the **SCROLL GRIP**
  (`SCROLL_GRIP_W`, overlay/overlayScale.tsx) is a 22px strip along the right
  edge of a content pane — where the scrollbar is already drawn, so the
  affordance is the bar the user is reaching for anyway. While the window is
  LOCKED *and* the rows genuinely overflow, a forwarded move inside that strip
  raises the P3 named-reason sensor (`capture('scroll', …)`, the fourth
  CaptureReason) and the window takes the mouse for exactly the time the pointer
  spends there. BOTH interactions come with it — the wheel, and DRAGGING THE BAR
  — because the grip hands the real scrollbar real events instead of
  re-implementing scrolling. NO new IPC and NO new mouse hook: it rides the
  forwarding the meters already pay for. The rest of the body is untouched and
  stays genuinely click-through, which is the whole point of pinning and is
  asserted beside the scroll in `tests/e2e/overlayScrollSteps.mts` (the pointer
  parked mid-pane must leave the grip idle and reveal no chrome). Honest limits,
  stated: a pointer arriving at the bar from OUTSIDE the window's right border
  can miss the strip, because the sensor is made of mouse-moves; and Windows
  routes a wheel to the hovered window only while "scroll inactive windows when I
  hover over them" is on (its default) — a pinned overlay is deliberately
  non-focusable, so that setting is what carries the notch. The event log and the
  buffs/debuffs windows need no grip: they hold capture over their WHOLE window
  while hovered, which already carries the wheel and is the same trade taken at
  the other extreme.
- **THE BUFF/TIMER OVERLAY'S BAR IS A CLAIM, AND ITS ABSENCE IS THE HONEST HALF**
  (JOS-89, docs/plans/buff-timer-overlay.md — ten user reports, the loudest demand
  in the product's history; ships DEFAULT OFF for internal validation first). ONE
  law decides every row: **a duration `spells.json` STATES becomes a receding
  countdown; a duration nobody states becomes ELAPSED time counting UP; there is
  no third case.** So a row draws a bar only when a duration was stated — a bar is
  a promise about when something ends — and an unknown-duration row has NO BAR at
  all and a `+` before its time. The corollary that costs something: the buffs
  model's MINED `observed` estimate (recency-weighted MAX of your own land→fade
  samples) is NOT a stated duration, so this surface counts UP where the Buffs TAB
  counts down. `durationSource === 'db'` is the whole discriminator.
  MEASURED: spells.json states a duration for 878 of 1,926 entries (45.6%), and a
  stated one is the MAX component of a level formula (the scraper collapses
  `1 ticks @L1 to 2 minutes @L40`) with focus effects absent from the data — so it
  over-states for a low-level caster and can under-state with focus. Recorded, not
  modelled.
  **THE MEZ WAS INVISIBLE BECAUSE OF CASCADE ORDER**: `classifyCcApply` sits ABOVE
  `classifyDbBuff`, so `<mob> has been mesmerized.` never became a `buffApply` and
  `cc` reached its consumers naming a mob and nothing else. The parser now carries
  the DB candidate list on the application shape (same suffix table, DB-gated,
  byte-identical without one) and `modules/buffTimers.ts` owns per-target holds
  keyed by mob — one AE mez on four enemies is four rows with four clocks.
  Everything else the overlay draws is read off `BuffsSnap.active`; a second fold
  of the same events is the two-models scar law 4 is made of.
  Candidates narrow by YOUR OWN CAST HISTORY (law 3), never by taking the first:
  `has been mesmerized.` is four spells at 96s/24s/24s/none, `has been ensnared.`
  is 660s/180s, while enthralled/entranced are one each — so a blanket "a mez
  counts up" would throw away the two statable families. A broadcast with no own
  cast behind it opens NO hold (the ruling `ingestCc` already makes).
  **A KNOWN GAP, DELIBERATELY NOT FIXED HERE**: a CC-roster spell wearing off a mob
  routes to `cc {refresh:true}` rather than `buffFade`, so `onBuffFade` never runs
  and such an instance is never cleared from the buffs model (it lingers to the
  90-min hygiene cap). Fixing it in `recordFade` would also mint a land→fade
  DURATION SAMPLE and move mined statistics across the whole golden suite — the
  buff-system rework the owner paused — so the overlay corrects it in its own
  projection (`endedByCc`), one rule wide, and the model change stays separate.
  Each kind's selector is SCOPE-FILTERED (`scopeOptions`) and never crosses
  over. Selectors are the custom `OverlaySelect` (no native `<select>`: its
  OS popup ignores the theme) — the overlay bundle stays MUI-free by law.
  Default geometry is one uniform size for every kind, docked bottom-right
  and stacking upward with column wrap (`overlayLayout.ts`); PERSISTED bounds
  always win.
- **A HIDDEN WINDOW CANNOT PAINT, SO `hide()` IS NEVER HOW YOU CLEAR ONE
  (JOS-120).** The owner reported the cursor ring twitching on every click —
  a halo that jumped and then snapped back onto the pointer. The cause is a
  general Electron fact worth knowing before the next window learns it the
  hard way: **a hidden `BrowserWindow` produces no frames, and `show()`
  re-presents its last composited surface.** So an IPC message that tells a
  renderer to clear itself, sent after `hide()`, is recorded and never drawn —
  MEASURED (Electron 43.2.0, a probe driving the shipping `cursorRing.ts`
  logic): the pending `requestAnimationFrame` did not run for the whole 600 ms
  the window was hidden and fired 1 ms AFTER `showInactive()`, one frame too
  late. Everything the window is re-shown carrying is therefore whatever it
  held when it went away. Two rules fall out. **(a) Clear BEFORE you hide**,
  never after (`suspendCursorStream`). **(b) Better, do not hide for a state
  you will leave in a few hundred ms**: `ringDisposition` (replayGate.ts)
  splits the ring's inactive state into `idle` (the game no longer owns the
  screen ⇒ the window really must come off it) and `parked` (the game owns the
  screen, there is just no pointer to ring ⇒ empty the halo and LEAVE THE
  WINDOW VISIBLE, where the park composites on the next frame). Hiding is
  about which application owns the screen; parking is about whether there is
  anything to draw. **The second half of the same bug was a CADENCE RATIO**:
  `cursorVisible` gates an 8 ms consumer but was read on the same 150 ms tick
  as the watcher's expensive foreground scan, so a whole mouse click could
  pass unobserved and the ring tracked a pointer EverQuest had already hidden
  for up to nineteen samples. The child's loop is now SPLIT — one
  `GetCursorInfo` every tick at the platform floor (~16 ms measured; Windows'
  15.6 ms quantum), the foreground/running/heartbeat block every tenth tick
  (~160 ms, the cadence alt-tab always had). Measured price 0.06–0.16 % of one
  core → 0.19–0.31 %. **Whenever a poll GATES a faster consumer, the number
  that matters is the ratio, not either period**
  (`unguardedSamplesPerHiddenCursor`). The synthetic repro
  (`tests/cursorRingClick.test.mts`) models all four clocks — watcher tick,
  8 ms sampler, animation frame, last-surface-wins — and asserts on what was
  on the SCREEN; it reproduces the twitch on the old path first, so the fixed
  assertion means something.
- **…AND THE LOOP THAT DROVE ALL OF IT NO LONGER SPAWNS ANYTHING (JOS-182).**
  The presence watcher was a hidden `powershell.exe` (`-ExecutionPolicy Bypass
  -EncodedCommand <base64>`) compiling a C# P/Invoke surface at runtime with
  `Add-Type`, enumerating every process and reading window titles. To a
  behavioural AV engine that is an infostealer — it was the app's largest
  heuristic trigger — and it also just **never ran** on 578 installs' worth of
  machines (`spawn powershell.exe ENOENT`), where auto-hide and the ring were
  dead every session and fail-open meant nobody could tell. It is now a
  **worker thread** calling user32/kernel32/psapi through **koffi**. Three
  rules fall out, all of them general:
  - **A NATIVE DEPENDENCY HERE MUST SHIP PREBUILT N-API BINARIES IN ITS NPM
    TARBALL.** `.npmrc` ignores install scripts and `npmRebuild` is false, so
    anything needing node-gyp needs both reconsidered. That rule, not taste,
    is why koffi beat hand-writing an addon: a CI-only compile exists in a
    release build and **nowhere else** — not in `npm run dev`, not in
    `npm test`, not in a local `dist` — so the feature would be degraded
    everywhere it is developed and live only where nobody can debug it. (Pin
    to koffi **2.x**: 3.x dropped the in-tarball prebuilds and downloads them
    in its install hook.)
  - **NEVER `worker.terminate()` A THREAD THAT CALLS NATIVE CODE.** MEASURED:
    terminating a worker while it is inside a koffi call aborts the whole
    process — `FATAL ERROR: Error::ThrowAsJavaScriptException`, no catch
    anywhere. Idle worker: 40/40 rounds survived. On the app's real 5 s scan
    cadence: crashed within two. Ask it to stop over the port instead; a
    `'message'` handler can only run BETWEEN ticks, never inside a call. This
    would have been a rare, unattributable crash **at quit**, which every
    session reaches.
  - **MOVING WORK OFF A PROCESS IS NOT THE SAME AS MOVING IT ONTO MAIN.** The
    obvious shape after deleting a child is a `setInterval` on the main
    thread; the running scan is **8.4 ms** (`EnumProcesses` alone 4.1–4.5 ms
    over 325 processes), and main tails the log, folds combat, answers IPC and
    runs the 8 ms cursor sampler. The child's one virtue was being somewhere
    else — keep that, drop the process. (Same argument as `speechWorker`;
    these are the tree's two worker_threads, both separate rollup inputs in
    `electron.vite.config.ts` because `new Worker(path)` loads a FILE.)
- **…AND IT IS TWO WINDOWS, OVER ONE MODEL (JOS-119).** The owner asked for
  buffs and debuffs to be windows he can enable and place separately, so the
  one 'buffs' kind became 'buffs' + 'debuffs' — two configs, two windows, two
  toggles in the title-bar Overlay menu. **THE SPLIT IS A FILTER, NOT A
  FORK**: `buildTimerRows` still folds the `buffs` + `buffTimers` modules
  exactly once and `shared/buffTimers.ts timerRowSurface` routes each row by
  its own `kind` — `buff` to the buffs window, `debuff`/`cc` to the debuffs
  one (the owner rules mez and slow ARE debuffs). `group` is deliberately NOT
  the discriminator: a Symbol on your pet is `group:'target'` and is still a
  BUFF, so routing by target would file your own group buffs under debuffs.
  ONE component (`BuffsOverlay.tsx` + a `kind` prop; everything that differs
  is one `SURFACE` data table) — a copy would be the defect. NO MIGRATION and
  that is the design: `overlays.buffs` keeps its key so an existing install's
  bounds/open/alpha carry over, `overlays.debuffs` was never written by any
  build so it reads the default and arrives OFF, schema stays at 11.
  **THE SEVENTH METER SLOT BROKE THE FIXED SIZE, exactly as the old note in
  shared/types.ts predicted**: seven 380×320 slots do not fit a 1366×728 work
  area under ANY arrangement (three columns, two rows = six). So the uniform
  first-open size is a FUNCTION OF THE DISPLAY now — a fixed shrink ladder,
  largest rung whose grid seats every kind wins, all kinds shrinking together
  — rather than clamping a column onto its neighbour. 1080p and larger are
  untouched at 380×320; the laptop opens everything at 323×272.
  Two measured gotchas from its e2e: a programmatic `setBounds` from MAIN does
  NOT raise Electron's `moved`/`resized`, so `saveOverlayBounds` never fires
  and a spec proving persistence must write through `overlay:setConfig` (the
  IPC a real drag lands on); and `overlayWindow()` matched `?kind=` by
  SUBSTRING, which `kind=debuffs` containing `kind=buffs` quietly broke — it
  parses the query now.
- **GRAPHICS COMPATIBILITY IS TWO SWITCHES, AND NEITHER IS INSTANT (JOS-40).**
  A player on an RTX 5080 reported the overlays black-screen artifacting; it
  cannot be reproduced here and they left no contact, so the app ships
  self-serve mitigations rather than a guess. `shared/graphicsPrefs.ts` is the
  pure half (store `graphics`, schema v11, both default 'auto' — a
  compatibility mode shipped ON is a downgrade for every machine that never
  needed one, and `auto` resolves to OFF wherever nothing is detected).
  (a) SAFE MODE — `app.disableHardwareAcceleration()`, called from index.ts
  MODULE SCOPE (`src/main/graphics.ts`), because Electron accepts it only
  before `ready`; that is why the label says "next launch" and why moving the
  call into `whenReady` would silently do nothing. `EQ_DISABLE_GPU=1` forces
  it for one launch WITHOUT the UI — the door for a user whose window is black,
  and it still outranks everything else.
  (b) OPAQUE OVERLAYS — overlay windows built `transparent:false` on
  `OPAQUE_OVERLAY_BG` (#0e1115, deliberately the same RGB the pages paint, so
  it is the bgAlpha look minus the alpha, never a second palette). A window's
  transparency is fixed at construction ⇒ applies on the next overlay OPEN.
  The TOAST is the one kind that changes behavior: opaque, an empty strip
  would be a solid rectangle over the game, so it is shown only while it has a
  card — driven off the `overlay:setIgnoreMouse` signal its queue already
  sends, never a second timer. The cursor ring is NEVER opaque (it is sized to
  the whole EQ window). Neither switch is in the shared settings profile: they
  describe one machine's driver. Proven end-to-end in
  `tests/e2e/overlay-sync.e2e.mts` (both modes open/lock/persist; a third
  launch asserts `--disable-gpu` really reached Chromium).
- **…AND UNDER WINE THE APP TAKES THAT PATH BY ITSELF (JOS-31).** A Wine user
  reported the celebration toast becoming a STUCK BLACK BOX after a level-up
  (01KZGQZJ2HMZGRY28A7CVRG4QT, v0.7.0) — the JOS-40 family arriving through
  Wine's compositor rather than a driver — beside the long-standing blank-window
  reports. A switch nobody can find is no fix when the symptom is a window you
  cannot see, so the switches went THREE-STATE (`'auto' | 'on' | 'off'`, store
  v11) and `shared/wineDetect.ts` decides what `auto` means.
  **PRECEDENCE, one function, three rungs**: `EQ_DISABLE_GPU` > an explicit
  user `'on'`/`'off'` > detection > off. `resolveGraphics` (graphicsPrefs.ts) is
  the ONLY place that folds them, read by safe mode, by the overlay factory and
  by the Preferences card, so a window cannot be built one way and labelled
  another. `'off'` HAD to become sayable: without it, detection would be a
  one-way door on a whole platform.
  **DETECTION IS CONSERVATIVE OR IT IS NOTHING** — a false negative costs one
  user a convenience, a false positive costs EVERY Windows user their GPU and
  their see-through overlays. Two signals, either sufficient, both impossible on
  real Windows: (1) Wine's own tools in `%SystemRoot%\system32` — wine.inf's
  `[FakeDlls] 11,,*` WriteFile()s every builtin as a REAL PE, and Windows ships
  no system32 exe starting with "wine" (`winevt` is a DIRECTORY, which is why
  the check is exact filenames and never a `wine*` pattern); (2) the env vars
  **Wine's own ntdll injects** (`add_dynamic_environment` runs for every hosted
  process: WINEHOMEDIR/WINECONFIGDIR/WINELOADER/WINEDLLDIR0/WINEUSERNAME, plus
  the renamed WINE_HOST_PATH).
  **THE VARIABLE EVERYBODY REACHES FOR IS THE WRONG ONE**: `WINEPREFIX`
  (and WINEDEBUG/WINEARCH/WINEDLLOVERRIDES) is set by the LAUNCHER, so it is
  absent under bare `wine app.exe` AND present on the real-Windows box of anyone
  cross-building for Wine — a false positive we may not have. `WINELOADERNOEXEC`
  is impossible, not merely unreliable: `__wine_main` `unsetenv`s it before the
  Win32 env is built. `winhlp32.exe` is likewise refused — a real XP/Vista/7
  binary. Gated on `platform === 'win32'` — a native Linux build is not an
  emulated Windows one. REJECTED: `wine_get_version` (needs FFI/a native addon),
  the registry (real — `HKCU\Software\Wine\Debug` is in every stock prefix — and
  its ORIGINAL objection, a `reg.exe` spawn on every launch's startup path to
  answer 'no' for ~everyone, EXPIRED WITH JOS-184: `native-reg` is in the tree
  and reads a key in-process in well under a millisecond, so this is now a live
  next-rung option, not an impossible one; the `Wine\Wine\Config` key every blog
  names died in 0.9), and the
  `"Wine builtin DLL"` DOS-stub magic at offset 0x40 (definitive, and the NEXT
  RUNG if a prefix ever defeats both signals above). `src/main/wine.ts` caches
  the answer once per launch and logs the signals when it fires.
  **SAFE MODE UNDER WINE IS NOT A GUESS**: WineHQ bug 48618 names Electron apps
  showing a black client area with `--disable-gpu` as the workaround, because
  Electron renders GL from its separate GPU PROCESS into the browser process's
  HWND and winex11.drv has no cross-process GL. The opaque-overlay half has no
  such bug on file — the user report is its evidence. The 10→11 migration reads a stored `false` as
  'auto' and a `true` as 'on' — `graphics` was written on EVERY launch that ran
  the 9→10 step, so `false` was overwhelmingly a default rather than a refusal,
  while `true` could only ever be a choice.
  **NOTHING HERE WAS VERIFIED UNDER WINE** — CI and this machine are Windows,
  so the tests pin the NEGATIVE exhaustively (incl. a live probe of the real
  filesystem, and an e2e assertion that this box detects nothing) and the
  positive rests on Wine's documented layout. The reporter is the verification
  path.

## Cloud (feedback backend + future web) — state as of 2026-08-04

- **AWS**: dedicated sub-account `eqcompanion` **001634075447** (org
  management = the `jmoyers` account 383185690517), region **us-east-1**.
  CLI: profile `eqc` in `~/.aws/config` assumes
  `OrganizationAccountAccessRole` via source profile `windows-desktop-eqc`
  (an IAM user whose key the OWNER manages; a least-privilege inline
  policy limiting it to that one AssumeRole was recommended and handed to
  the owner). Terraform + AWS CLI are installed (winget; terraform.exe
  under `%LOCALAPPDATA%\Microsoft\WinGet\Packages\Hashicorp.Terraform_*`).
- **Terraform**: root `infra/`, state in s3 bucket
  `eqcompanion-tf-state-dae027bf` (versioned, BPA) + lock table
  `eqcompanion-tf-lock`. Deploys run from this machine with
  `AWS_PROFILE=eqc`; CI only fmt/validate/bundle. **Standing authorization
  (owner, 2026-08-05): NON-DESTRUCTIVE applies and migrations — additive
  DDL, copy-first backfills with count verification, Lambda updates — may
  be run by the agent directly. Anything that drops, overwrites, or loses
  data (including "empty" shells until counts are VERIFIED) still gets
  explicit owner approval first.** The 30-resource stack applied 2026-08-04.
- **Store is Aurora DSQL** (owner: "I hate dynamodb"), not DynamoDB:
  schema in `infra/schema.sql`, applied by `triage-feedback migrate`
  (never yet run against a live cluster — it stops on and prints a bad
  statement). Ingest connects as a DB role holding **INSERT ON report and
  nothing else**; IAM tokens, zero passwords. DSQL laws: no FKs/triggers/
  PLpgSQL, fixed Repeatable Read + OCC (retry only SQLSTATE 40001),
  3,000-row txn cap (bounds every sweep), one DDL per txn,
  `CREATE INDEX ASYNC`, jsonb young + unindexable (we use text).
- **F2: DEPLOYED AND LIVE (2026-08-04).** Applied (29+1 resources; Lambda
  runs UNRESERVED concurrency — the fresh sub-account's limit of 10 made
  reserving 5 illegal ("below minimum unreserved"); request a quota bump
  then restore `-var lambda_reserved_concurrency=5`). Schema migrated
  (14+3), kill switch OPEN, the three constants filled in net.ts
  (api pcy0z3xjp9…/v1/feedback · bucket eqcompanion-logs-6c58f5cc ·
  us-east-1). LIVE-VERIFIED: submit 201 + ULID, idempotent replay 200
  same id, oversize 413. Two DSQL live findings now encoded: grants on
  the system-owned `public` schema are unsupported (table-level grants
  suffice; schema.sql fixed) and `statement_timeout` cannot be SET
  (node-postgres sends it when configured — use client-side
  query_timeout only; db.ts fixed). REMAINING: 429/503/403/expired-
  presign negatives + a real log-upload round trip + the owner clicking
  the SNS confirmation email. Telemetry A2 rides the next apply.
- **ANALYTICS COHORT SPLIT — LIVE (2026-08-05, waves R+S, executed by the
  agent under the standing authorization).** The owner's usage (dev channel
  auto; the installed copy by hand-marked analyticsId) splits out of every
  read path by default ('owner' vs 'user' cohort, IN the counter tables'
  primary keys). The migration ran COPY-FIRST per owner ruling — staging
  tables, per-day derived cohort, row-count AND sum(n) verification, swap
  via DSQL's documented `RENAME TO` (verified live: 102+4 rows, both
  numbers matched exactly; nothing dropped until its verified copy
  existed). Runbook preserved in infra/README.md "THE COHORT MIGRATION"
  for any future re-shape. Owner installs marked: prod 388834cf… + dev ids
  auto-tag; **a ROTATED analyticsId arrives unmarked — re-run
  `analytics owner-add`**.
- **ANALYTICS OPERATIONS (how usage questions get answered — distilled
  2026-08-05):**
  - Daily/adoption truth: `triage-feedback analytics digest --days N
    --profile eqc` (user cohort by default; `--cohort all` prints both,
    NEVER summed). `--json` for the per-day `pulse.activeSeries` /
    `sessionSeries`. Series history STARTS 2026-08-04 (telemetry lit) —
    there is no earlier data and never will be.
  - Live concurrency: CloudWatch `EQCompanion/Telemetry` metric
    `Heartbeats`, dimension `Channel=prod`, Sum over 300s periods — ONE
    heartbeat per open session per 5 min, so a bucket's Sum ≈ concurrent
    sessions. Deliberately channel-split, not cohort-split (EMF dimension
    identity would orphan every dashboard widget).
  - Install count truth is `analytics_install` (the digest's "installs
    all-time"). GitHub release `download_count` is NOT installs — the
    auto-updater's fetches dominate it (v0.5.0: 61 downloads in hours ≈
    the fleet updating itself). DAU can slightly exceed installs across
    UTC day boundaries — artifact, not phantom users.
  - The telemetry kill switch is cached in warm Lambdas for 60s
    (`CONFIG_CACHE_MS`) — a 503 right after `analytics open` is the cache,
    not a failure; wait a minute before diagnosing.
  - **THE PULSE'S LIVE HALF IS A CLOUDWATCH READ, NOT A COUNTER** (JOS-39).
    `usage_daily` is keyed on a DAY and cannot answer "right now", so
    `src/main/triage/liveSessions.ts` reads the `Heartbeats` EMF metric
    directly (`@aws-sdk/client-cloudwatch`, a devDependency) and is merged at
    the two presentation edges beside `ghDownloads` — never inside
    `buildAnalytics`, which stays pure over the three tables. Active-now is the
    last COMPLETE 300s bucket. The average AGE is an estimate and is labelled
    `est.`: it is a running-minimum survival sum over 12h of buckets (a session
    is continuous, so it cannot predate a bucket in which nobody was alive), it
    can only under-claim, it prints `≥` when the lookback is fully occupied,
    and it is NULL — never 0 — when nobody is alive.
  - **`upgrades` IS DERIVED SERVER-SIDE**, from a PK read of the stored
    `app_version` taken BEFORE the install UPSERT overwrites it (a CTE would be
    tidier and is not worth betting a live endpoint on against DSQL's postgres
    subset). Counted once per version change; a downgrade counts too; disjoint
    from `newInstalls`.
  - Pre-marking counter rows carry no id and stay in the user cohort
    forever (e.g. historical `triage` dwell is the owner) — read old
    days with that in mind.
- **Local dev story**: `scripts/dev-feedback-server.mts` (wave in flight
  at write time) — same contract, same shared validator, failure knobs;
  the app reaches it via `EQ_FEEDBACK_URL`, honored ONLY behind
  `!app.isPackaged` (the lawful exception to the no-override rule —
  packaged builds must prove the env var does nothing).
- **Usage analytics**: opt-OUT (owner decision over the integrator's
  opt-in recommendation) but NOTHING transmits before the first-run
  notice renders; allowlist schema; separate rotatable analyticsId;
  payload viewer + TELEMETRY.md. Plan: docs/plans/usage-analytics.md.
  A1/A2/A3 are ALL LIVE (applied 2026-08-04/05): a second Lambda
  (`eqcompanion-telemetry-ingest`, its own IAM + database role
  `telemetry_ingest`) behind `POST /v1/telemetry`, aggregating on arrival
  into `usage_daily` / `usage_funnel_daily` / `analytics_install` — NO
  raw-event store (T6) — plus EMF metrics, a CloudWatch dashboard,
  `triage-feedback analytics digest|wipe|open|close`, and the Triage →
  Analytics tab reading all three tables.
  **The endpoint is LIT (2026-08-04)**: `TELEMETRY_API_URL` names the live
  `/v1/telemetry` route as a compiled-in constant; tests/telemetryNet.test.mts
  pins the exact URL, the single fetch site, and the consent gates (nothing
  before the notice; opt-out destroys buffer + id). The same commit rewrote
  SECURITY.md / README / TELEMETRY.md — the forcing function worked as built.
  **THE ADDITIVE-FIELD RULE (JOS-39, and it is a deploy-skew law).** The app
  auto-updates itself; the ingest Lambda is deployed by hand — so a shipped
  client is regularly talking to an OLDER copy of the shared contract. A NEW
  EVENT KIND is fatal under that skew: the shared validator fails the whole
  batch, the endpoint answers 400, and `telemetryPermanentRefusal` (net.ts)
  classes 400 as "these bytes will never be accepted" and DROPS the batch — so
  the client throws away every counter it is carrying, on every flush, until
  the deploy lands. A NEW OPTIONAL FIELD on an existing kind is free: the
  validators CONSTRUCT their result field by field, so an older server simply
  does not copy it across and accepts the batch. Add measurements as fields
  (`linesParsed` rides on `sessionHeartbeat`/`sessionEnd`), and the client half
  is then safe to ship BEFORE the additive apply.
  **USER/OWNER SPLIT (2026-08-05, owner-directed, LIVE).** Every counter
  row carries a `cohort` ('user'|'owner'); it is IN the
  PRIMARY KEY of `usage_daily`/`usage_funnel_daily` (DSQL cannot alter a PK —
  the live tables were rebuilt via the copy-first staging migration) and
  a nullable ALTER-able column on `analytics_install`. Dev builds tag themselves
  SERVER-SIDE from `env.channel` (already in the envelope — **no client change,
  no TELEMETRY.md change**); the installed copy is marked by hand with
  `analytics owner-add <analyticsId>`. Every read defaults to the user cohort;
  `--cohort all` and the tab's "Include mine (split)" render both SIDE BY SIDE
  and nothing ever sums them. From-marking-onward: counters carry no id, so rows
  aggregated before a marking keep their cohort and the digest says so.

## Known open items

- **TOOLCHAIN WAVE — LANDED** (was: security, owner-flagged 2026-08-04;
  verified installed/declared 2026-08-06 during JOS-63): electron **43.2.0**,
  vite **7.3.6**, electron-vite **5.0.0** are what the tree runs today —
  the 33→43 / 5→7 / 2→5 upgrades this item tracked are done. Still open
  from the same flag: the installer shipping ~150MB of other-platform onnx
  binaries (trim via asarUnpack filters). The two COMMENTS this item also
  tracked are settled: .npmrc's audited-hooks list and electron-builder.yml's
  npmRebuild note were both rewritten by JOS-182, which added the tree's
  SECOND native module (koffi) and states the rule they now encode — a native
  dependency is acceptable here when it ships prebuilt N-API binaries inside
  its npm tarball, and needs `ignore-scripts`/`npmRebuild` reconsidered when
  it ships node-gyp sources. koffi's eighteen other-platform prebuilds are
  excluded from the installer the same way onnx's are, so that trim now has a
  worked example next to it.

- **Feedback loop (the next big feature)**: fully planned + reviewed in
  `docs/plans/feedback-triage.md` — in-app reports, scrubbed log-window
  uploads, **Terraform** infra (owner decision: HCL, us-east-1, dedicated
  AWS sub-account, alarms to jmoyers+eqc@gmail.com), agentic triage CLI.
  Wave F1 ships dark (no endpoint) and needs no cloud; F2 (deploy) needs
  the owner to create the sub-account. Targeted at the v0.3.0 cycle.
- Azure signing: waiting on Microsoft identity validation → cert profile +
  app registration + repo secrets.
- Windows Sandbox: WORKING (last run 2026-08-03, PASS, gating v0.2.0) —
  `run-installer-test.ps1` is the standard pre-ship clean-machine gate.
- Design docs for every shipped 2026-08-03 feature live in `docs/plans/`
  — historical intent; the code + this file are the current truth, and
  several plan numbers were overturned by executor measurement (each
  overturn is recorded in the relevant commit message).
- Startup could be TAIL-FIRST: attach the live tail immediately, then backfill
  history BACKWARDS into the model, so the meter is live in ~0s and deepens as
  the replay lands (today: ~6s of `hydrating` on this log, then live). Needs
  order-independent folding in every module — a real architecture change, not
  yet attempted. The `hydrating` flag makes today's replay honest meanwhile.
- Not yet parsed: Dragon Hoard / tradeskill depot / combine loot lines.
  Group-member combat tracking: future scope.
- **Open chips (2026-08-05, each with a full brief in its chip):** the
  combo swap-back blind spot (capped-class swaps invisible; the model's
  CURRENT answer is wrong and tail evidence rewrote a settled span — the
  hardest inference fix in the repo, do not rush it; overDetermined test
  guard + time-keyed corrections are the mitigations) — **PARTLY CLOSED by
  JOS-79**: a swap the log DID ding for can no longer be swallowed by an
  earlier silent one (`reinstatedDrops`), and the loadout converges within
  one clock-hour rollover (measured 28.6 min on the Aug 06 wizard swap).
  A swap between capped classes still dings for nothing and remains
  evidence-only; the e2e per-checkout lockfile; copyText still serializing
  the melee-rounds footer the Rounds panel replaced.
- **Awaiting real samples** (the outputs registry refuses them typed until
  a committed fixture graduates each): /outputfile guild, raid, spellbook,
  factions, achievements, alternateadv — one in-game `/outputfile <kind>`
  from anyone provides it. Same law for the **Double Bow Shot annotation**,
  still unobserved after JOS-92's whole-log sweep: `(Critical)` is the only
  annotation any of the nine `shoots` lines carries, and the file's one
  `bow shot` hit is a player bragging in General chat. The rest of that note
  is now SUPERSEDED — archery does appear, just never the owner's: 9 landed
  and 8 avoided bow lines from other players, all third-person, and the Ranged
  lane (above) is built on them. `You shoot` remains ZERO, so the FIRST-PERSON
  arm is the shape still awaiting a sample.
- Releases this arc: v0.4.0 (planner + toasts + parity + credited kills),
  v0.5.0 (monk lanes, outputs engine, AA ladder), v0.6.0 (Rounds panel,
  log-attach fix, Wine installer) — all sandbox-gated + smoke-verified;
  ~55 installs / ~58 peak concurrent as of v0.6.0 day.
