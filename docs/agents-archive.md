# AGENTS.md archive — long-form histories moved out by the JOS-252 distillation

Nothing in this file is dead: every block below was MOVED here VERBATIM from
AGENTS.md when it was distilled to essential learnings (JOS-252, 2026-08-12).
The distilled AGENTS.md keeps every rule verbatim plus a one-line story and
the Linear ticket id; this file keeps the full war story, measurements and
argument. A cut that proves load-bearing is reversible in one paste — each
entry records the original location it came from. Linear holds the full
per-ticket history beyond even this.

Do not edit these blocks; they are a record. New long-form history goes into
a new entry here (with a pointer from AGENTS.md), or into the Linear ticket.

## Preamble at the cut

<!-- Moved verbatim from AGENTS.md (lines 3-4 at the JOS-252 cut). -->

Distilled operating manual. Per-task history lives in `git log` (messages are
detailed); this file holds only repeatable rules and load-bearing design.

## What this is, at full length (feature catalog + release history)

<!-- Moved verbatim from AGENTS.md (lines 8-38 at the JOS-252 cut). -->

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
kills, opt-in per mob, scoped to the zone you are in, and flipped to UP when the
log names the mob — law 13 below).
Committed knowledge DBs: mobs
(7.9k), items (11.2k incl. dropsfrom + eraTag), spells (1.9k), classes,
zones (era-annotated), wiki respawn floors (507 rows, 394 readable). First stable release v0.2.0 (2026-08-03); latest
release v0.8.0 (2026-08-07: maps N-S fix, Sky keyring counting, planner
21-cell board + slot-fact layer, alert sets round two, owner-tools gating,
engine fold ~2x — after v0.7.0 the same day: pet-question removal +
tell/leader binding + single-pet retirement, startup duty throttle + spell-DB
hash matching, replay overlay/mouse gate, character-switch delta silence,
custom-directory normalization, startup fleet telemetry, dev restart button). Layout: `src/main` (Node), `src/preload`, `src/renderer`,
`src/shared`, `tests/`, `scripts/`.

## Roles: Fable plans, Opus does (full statement with the overturn examples)

<!-- Moved verbatim from AGENTS.md (lines 49-61 at the JOS-252 cut). -->

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

## Fixtures committed + scrubbed: full drop/keep rationale

<!-- Moved verbatim from AGENTS.md (lines 134-153 at the JOS-252 cut). -->

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

## Scrub carve-out: the six pet-voiced says (JOS-47)

<!-- Moved verbatim from AGENTS.md (lines 154-168 at the JOS-252 cut). -->

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

## Scrub carve-out: the pet-leader say + the self /who row (JOS-52)

<!-- Moved verbatim from AGENTS.md (lines 169-186 at the JOS-252 cut). -->

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

## The e2e harness, fixture input and settle vocabulary at full length

<!-- Moved verbatim from AGENTS.md (lines 195-238 at the JOS-252 cut). -->

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

## A ratio rots too: the kill/exp join at the level cap (JOS-234)

<!-- Moved verbatim from AGENTS.md (lines 242-256 at the JOS-252 cut). -->

  **AND A RATIO ROTS TOO, IF ITS DENOMINATOR IS THE OWNER'S PLAY** (JOS-234). A
  floor looks safe and is not when the quantity underneath it is a fact about
  what the owner was killing rather than about the code: the kill/exp join's
  `joined / credited kills > 0.9` measured 95.8% when written, went
  deterministically red at 85.8% with no diff behind it, and fell every evening
  — because the character hit the level cap and a grey kill prints no
  experience line for anything to join (measured: 97-99% joined per day through
  2026-08-09, 4% on 2026-08-10/11; 550 slain lines against 91 lines containing
  the word "experience" on one of them). Before freezing a rate, ask which side
  of it the code controls, and CONDITION the denominator on the code's
  precondition — here, kills that HAD an experience line to claim, which is
  99.7% and stays there. Then say the same thing again over the most RECENT
  slice, or thousands of correct old rows will dilute a regression that only
  breaks new ones. tests/progressionKillJoin.test.mts carries the worked
  example.

## Path-scoped commits and mid-flight messaging (war stories)

<!-- Moved verbatim from AGENTS.md (lines 264-278 at the JOS-252 cut). -->

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

## e2e parallel: the wave E1 measurements

<!-- Moved verbatim from AGENTS.md (lines 287-303 at the JOS-252 cut). -->

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

## The feedback triage loop, proven (2026-08-05)

<!-- Moved verbatim from AGENTS.md (lines 309-315 at the JOS-252 cut). -->

- **Feedback triage loop (proven 2026-08-05, three same-day turnarounds):**
  report → integrator diagnoses against the REAL log/slice FIRST (the
  Dragon Punch "feature" was a labeling gap; the onboarding "docs issue"
  was two real defects; the brief's diagnosis was WRONG twice and the
  executor's evidence overruled it) → wave → stamp `triaged` with an
  honest note via `triage-feedback set`. Reports with slices: the slice
  may prove more than the prose (the /log-on first line WAS the bug).

## Ambient red + plans-go-stale (session scoreboard)

<!-- Moved verbatim from AGENTS.md (lines 321-332 at the JOS-252 cut). -->

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

## Vite define rules: the stale-server blank app (2026-08-04)

<!-- Moved verbatim from AGENTS.md (lines 393-408 at the JOS-252 cut). -->

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

## Owner tooling gate: the two-tier dev flag (JOS-72)

<!-- Moved verbatim from AGENTS.md (lines 409-425 at the JOS-252 cut). -->

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

## The Windows timer quantum measurements (setTimeout law)

<!-- Moved verbatim from AGENTS.md (lines 429-440 at the JOS-252 cut). -->

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

## setFocusable moves the foreground window (JOS-199)

<!-- Moved verbatim from AGENTS.md (lines 441-453 at the JOS-252 cut). -->

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

## lint:measure threshold methodology

<!-- Moved verbatim from AGENTS.md (lines 468-474 at the JOS-252 cut). -->

- **Those five numbers were MEASURED, not guessed.** `npm run lint:measure` re-runs
  ESLint with the rules pinned to `max: 0` so every site reports its actual metric,
  and prints the distribution + a threshold sweep (raw output:
  `scripts/lint-measure.txt`). Each threshold sits between p95 and p99 of the real
  tree. Never change one without re-running it — including `max-depth`, which is 3
  rather than the obvious 4 *because* the data showed 4 would catch three sites in
  the whole repo.

## The lint refactor-wave law (campaign detail)

<!-- Moved verbatim from AGENTS.md (lines 483-493 at the JOS-252 cut). -->

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


## Overlay hydration needs both transport halves (JOS-172)

<!-- Moved verbatim from AGENTS.md (lines 532-559 at the JOS-252 cut). -->

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

## A second input needs its own revision counter (JOS-87)

<!-- Moved verbatim from AGENTS.md (lines 560-578 at the JOS-252 cut). -->

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

## Buffs freeze across a logout, debuffs do not (JOS-134)

<!-- Moved verbatim from AGENTS.md (lines 585-609 at the JOS-252 cut). -->

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

## The spell DB and the JOS-251 effects overlay (full detail)

<!-- Moved verbatim from AGENTS.md (lines 610-632 at the JOS-252 cut). -->

- **Spell DB**: `src/main/data/spells.json` (~1.9k spells from eqlwiki
  `Template:Spellpage`: durations, cast/wear-off messages, illusion flag,
  Beneficial/Detrimental) + `messageOverlay.baseline.json` + per-user
  learned overlay (VERIFIED / SHARED / CONTRADICTS-WIKI verdicts mined from
  the log; overlay wins over wiki). Injected via rulesets `ParserConfig`.
  The learned counts are filed PER SOURCE and a re-fold replaces its own
  bucket — JOS-231's law in the checkpoint tombstone below; read it before
  touching the miner's seed or `<userData>/message-overlay.json`.
  **AND SINCE JOS-251 IT CARRIES WHAT A SPELL DOES** — `SpellEntry.effects` is
  the wiki page's numbered effect list VERBATIM (`"Charm (up to L37)"`,
  `"Decrease Attack Speed by 30%"`) plus `instrumentEnhanced` for bard songs, and
  `src/main/data/spellEffectClass.ts` is the separable OVERLAY that reads them.
  Rules are anchored at the HEAD of the effect sentence, which is the whole
  difference from the name stems it replaces: a stem matched a substring of a
  NAME (`charm` found `Naki's Charm of Pernicity`, `boltran` found a PET SUMMON),
  these match a sentence the wiki wrote to describe a mechanic. The derived charm
  roster equals JOS-250's hand audit on all 23 rows and IS `ParserConfig.charmSpell`
  now (`installSpellDb` builds it; `CHARM_STEMS` is the fallback for a name the
  catalog lacks). `ccSpell` is still stems ON PURPOSE — the derived hold roster
  disagrees with it on 19 spells, including `Ensnare`, which this tree treats as
  a trackable hold in three places while JOS-225 ruled a snare is not a hold for
  ALERTS; reconciling those is an owner ruling, and the derivation's answer is
  pinned in `tests/spellEffectClass.test.mts` waiting for it.

## The spell scrape: revision-keyed batching detail (JOS-251)

<!-- Moved verbatim from AGENTS.md (lines 633-640 at the JOS-252 cut). -->

  **THE SCRAPE IS REVISION-KEYED AND BATCHED** (`scripts/sources/cache/spells/index.json`
  records the revid behind each cached page): a cold pass over 1,962 pages is ~84
  requests / 73 s, a re-run is 44 requests and ZERO fetches, and `scrapedAt` is
  KEPT when the spell list is unchanged so a re-run is a byte-identical no-op
  rather than a one-line diff that fires every time. Re-scraping is cheap now —
  but it is a DATA CHANGE, not a refresh: the run that added the effect lists
  also picked up 160 pages the wiki had edited under us (46 pet summons retyped,
  87 durations filled, one page edited WRONG). Diff it, do not skim it.

## The where.spell candidate-list widening (JOS-84)

<!-- Moved verbatim from AGENTS.md (lines 650-663 at the JOS-252 cut). -->

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

## Alert capture groups: the threat model (JOS-103)

<!-- Moved verbatim from AGENTS.md (lines 664-686 at the JOS-252 cut). -->

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

## Suggestion templates: three lying flags (JOS-103)

<!-- Moved verbatim from AGENTS.md (lines 687-704 at the JOS-252 cut). -->

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

## The mez-break template rests on cc, not buffExpired (JOS-161)

<!-- Moved verbatim from AGENTS.md (lines 705-716 at the JOS-252 cut). -->

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

## The corrections overlay can rename, and a name is a join key (JOS-161)

<!-- Moved verbatim from AGENTS.md (lines 718-737 at the JOS-252 cut). -->

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

## sandbox:false measurement (packaging blocker)

<!-- Moved verbatim from AGENTS.md (lines 748-755 at the JOS-252 cut). -->

- `sandbox:false` is a PACKAGING blocker, not a choice: both preloads
  `require("./chunks/ipc-<hash>.js")` (rollup hoists the shared `shared/ipc.ts`
  out of the two-entry preload build), and a sandboxed preload's `require`
  resolves only `electron` + a tiny polyfill set. MEASURED: flipping it makes
  `npm run test:e2e` time out with `[main:preload-error] module not found:
  ./chunks/ipc-….js` and no `window.eq` at all. Nothing in the preloads needs
  Node, so `sandbox:true` (and `app.enableSandbox()`) unlocks the moment
  electron.vite.config.ts emits each preload as ONE self-contained file.

## Law 4 measurements (single-pet succession, the lifetap healer)

<!-- Moved verbatim from AGENTS.md (lines 791-842 at the JOS-252 cut). -->

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

## Respawn timers, rounds 1-9: the full owner iteration history (JOS-194)

<!-- Moved verbatim from AGENTS.md (lines 919-1043 at the JOS-252 cut). -->

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
   **TRACKING IS OPT-IN PER MOB, AND THE DISPLAY IS ZONE-SCOPED** (owner, after
   using the prototype, 2026-08-10). The first cut also auto-watched the 394
   mobs the floor gives a duration for; the owner threw that out, because EQ
   names are massively DUPLICATED across zones and spawn points, so a clock
   nobody asked for is a clock about a mob the app cannot identify. The
   Recently-killed panel is the discovery surface (seeing a death costs nothing
   and claims nothing); a clock exists only once the player clicks Watch or
   types a number. The wiki keeps the two jobs above and loses the power to
   ADMIT a row. Separately, the fold keeps every zone it has walked through but
   the SURFACES show only the zone you are in — the overlay always, the Timers
   tab by default with an explicit all-zones view — filtered by the module's
   OWN zone-stay state (`RespawnSnap.zone`, the same field that decides whether
   a gap counts) through one shared helper. Two edges are decided: the empty
   zone is its own BUCKET rather than a wildcard, and `due` never widens the
   filter. **And that made the zone part of what the screen shows, which
   promoted it to a revision-bearing change** — the module now bumps `rev` on a
   zone line, or `useModule`'s seq dedupe swallows the one push that says you
   left (JOS-87's rule, re-learned in the real app).
   **AND A CLOCK MUST YIELD TO THE LOG NAMING THE MOB** (owner, after using the
   prototype again, 2026-08-10). The report is the sharpest this feature has had:
   a watched mob spawned on time, the owner arrived late, the mob was ACTIVELY
   HITTING HIM, and the row still read "due 4m ago". The countdown was not wrong
   about its estimate, it was answering a question the world had already settled.
   So a row carries `seenTs` — the last instant a TYPED event named that mob
   while the fold stood in that row's zone — and a reading whose `seenTs` is
   newer than the clock's base reads **UP** and sorts above every countdown.
   The UP claim itself expires after `RESPAWN_LINGER_MS` (round 8: the STATE
   ages out, never the row). Coverage is off EVENTS, never a raw-text scan (the parser is the
   only thing here that reads sentences): damage/miss/heal, consider, cc/ccWake/
   charm/uncharm, resist/otherCastBegin/buffApply/poisonProc. It is honest about
   what it cannot see — **a mob standing there prints nothing**, mob speech is
   dropped by the scrub, a corpse (`loot.source`, `death.name`) is deliberately
   NOT a sighting or every kill would flip its own row up, `spellEmote` is out
   because it is a permissive flavor stream, and a duplicate NAME still lights
   the wrong row exactly as the clock itself already mis-identifies it.
   **AND A SIGHTING NEVER AUTO-ADJUSTS THE SCHEDULE** — it proves the mob is UP,
   not when it spawned, so re-basing is an explicit affordance (`Start clock
   here`, on the seen row in the Timers tab AND in an INTERACTIVE overlay; a
   locked overlay is click-through and has no clicks to give) landing on
   `respawn:confirmSighting`. It sets `basis:'sighting'`, which every surface
   states out loud, and the base is `max(death, confirmation)` so the next death
   resumes the death-driven cycle with nothing to undo. The confirmation is
   session state and is never persisted: the fold is rebuilt from a log that has
   never heard of it, so a stored copy would outlive the spawn it was about.
   The revision rule generalizes with the third input — watch list, zone line,
   confirmed sighting, and a sighting itself all bump `rev`.
   **AND UNWATCH LIVES ON THE MOB, WHEREVER YOU MEET IT** (owner, prototype round
   4). Watching was already per-mob; STOPPING was a trip to the global watch list
   at the bottom of the tab — so the half you reach for while a wrong clock is in
   front of you (over the game, mid-camp, on one of EQ's duplicated names) was the
   half that made you go looking. Every surface that names a watched mob now
   carries its own way out: the clock row in the Timers tab, the row in an
   INTERACTIVE floating window (same click-through law as the confirm control),
   and the Recently-killed entry, where Watch and Unwatch are ONE control in one
   slot — same size, same casing, opposite words (MUI upper-cases button text by
   default, and "WATCH" next to "Unwatch" reads as two controls). All of them land
   on ONE channel, `respawn:unwatch`, which takes the canonical mob KEY rather than
   a rewritten list: a row and a candidate each know one mob, and handing either
   the whole watch list to rewrite would put a second author on entries the user
   never touched. It removes the NAME, so it stops that name's clocks in zones the
   surface is not showing, and it throws away nothing else: kills, gaps and the
   LRU history are the fold's, re-derived from the log, so watching again restores
   the identical clock. Those two properties are pinned on the WRITE
   (`respawnWithoutWatch`, `tests/respawnUnwatch.test.mts`) — the control itself
   carries no tooltip (owner, round 7 addendum: it speaks for itself).

   ROUND 7 (owner, 2026-08-10): the tab is titled Timers; the Your-watches
   section is gone — the seconds box (rung 1) and Unwatch live on the mob's
   Running entry, which also states the measured gap history
   (`RespawnRow.gapsMs`, newest-first, bounded; `observedMs` stays the minimum
   over all gaps; `customMs` published for the box). Recently killed is
   searchable via a pure single-pass filter with JOS-206 row memoization. The
   mob hover card opens from clock rows AND Recently-killed entries — IN-APP
   ONLY: the floating overlay carries no card (owner: it takes the overlay over
   too completely); over the game it is plain rows and a native title, and a
   locked window gets neither.

   ROUND 9 (owner spec, 2026-08-11): the duration and its source label are ONE
   bordered unit; a small edit icon on it opens the modal
   (`RespawnEditDialog.tsx`) carrying the mob card, all observed gaps, the
   wiki's verbatim words, and a real wiki link (`RespawnRow.wikiPage`, shape
   v4; system browser only). The input parses a WHITELIST grammar
   (`parseRespawnDuration`: bare number = seconds; strictly-descending d/h/m/s
   terms like `44m 30s`; colons refused as ambiguous; the whole string must
   parse) and answers ok/empty/unreadable/range so the dialog never guesses.
   `respawnOverridden` = the ladder saying `source === 'custom'`, never the
   mere presence of `customMs`; overridden rows carry `data-respawn-overridden`
   and a distinct tint on both surfaces; clear/revert re-runs the ladder minus
   rung 1 and states the number before you press it. The round-7 bare seconds
   box is gone; the OVERLAY shows the state and carries none of the editing.

   ROUND 8 (owner defect, 2026-08-11): **a watched row NEVER vanishes while
   watched.** The old expiry sweep retired any row whose estimate elapsed 30+
   min ago — so Watch clicked hours after the only death produced a row born
   already swept, a flipped button, and an empty Running list. The sweep is
   gone: a long-elapsed estimate reads "due long ago" (grey, no bar,
   `stale=true`), a watched mob with no death yet reads "awaiting next death",
   the next death starts the normal cycle, and stale rows sort under every live
   clock. What ages out is the SEEN state (UP is the one label that claims
   presence); unwatch remains the only way a row leaves.

## The fold checkpoint post-mortem + the overlay double-count (JOS-208/230/231)

<!-- Moved verbatim from AGENTS.md (lines 1045-1124 at the JOS-252 cut). -->

## The fold checkpoint, and why there isn't one (JOS-208, removed by JOS-230)

Between 2026-08-10 and 2026-08-12 this app could RESTORE its whole world model
from a binary checkpoint and replay only the log's tail. It was four phases,
~5,000 lines, twenty checkpointed units, a schema grammar, a differential
harness over six fixtures at eight kinds of split point, golden fingerprints, a
consumer census, an e2e restart-compare and a fleet shadow verifier. It worked.
The owner removed it on 2026-08-12 anyway, and the reasons are worth keeping:

- **The hypothesis did not survive its own instrumentation.** It was built
  against a cold-read/AV stall. JOS-57's fleet numbers (585 launches) put
  time-to-first-MB at p50 <10 ms / p95 10-25 ms, and stutter drift at
  p50 = p95 = 10-25 ms. Nothing was stalling. The real p95 cost is fold CPU
  under the slicer's fixed 0.6 duty — a cheaper lever, and one nobody had tried.
- **It had zero field evidence, structurally.** It shipped OFF, gated on "turn
  it on once the fleet's divergence count has held at zero", and the fleet's
  CHECK count was zero on every build. A gate whose denominator cannot move
  cannot open.
- **It taxed every fold change.** A three-method persistence seam plus a
  data-declaration in every registry module, both derived-event producers and
  the combat engine; and a per-change ceremony of schema edit, semantics bump,
  goldens re-record, census row, differential run.

WHAT SURVIVED IT, because all three are the app's and not the feature's:

- `tests/foldDeterminism.test.mts` — **a historical replay reads no wall
  clock.** Written as the checkpoint's first audit, kept because the property is
  the app's: a fixture-backed golden is only reproducible if the fold is a pure
  function of the bytes. It traps `Date.now`/`performance.now` around a real
  fold of a real fixture and carries its own tripwire.
- The combat engine's `st.hydrating` gate (`combat/engine.ts`) — a mid-replay
  `combat:snapshot` poll used to evaluate deferred encounter closure against the
  wall clock and SPLIT a finalized fight (measured: 53,577 damage becoming
  43,504 + 10,073). `tests/combatReplayClock.test.mts`.
- `MessageOverlayMiner.lastObservedTs` (`data/messageOverlay.ts`) — the
  overlay's `updatedAt` is the LOG's clock, not `new Date()`. A wall-clock read
  inside a published snapshot is a statement about the reader, not about the
  observations.

Both product fixes were found by folding the same bytes twice and diffing —
which is the technique to reach for again, harness or no harness.

AND ONE DEFECT IT WAS MASKING, re-exposed by the rip-out and FIXED in JOS-231:
the message overlay DOUBLE-COUNTED on every cold launch. Its counts were seeded
from `<userData>/message-overlay.json` — what the last session persisted — and
the fold then re-mined the whole log on top. MEASURED: 22 -> 44 -> 88 across
three cold launches. A restored launch mined only the tail and so didn't show
it. The rule it left behind is below.

**A FOLD MUST NEVER BE SEEDED WITH WHAT IT IS ABOUT TO RE-DERIVE, AND THE ONLY
HONEST WAY TO KNOW IS TO FILE EVERY COUNT UNDER ITS SOURCE** (JOS-231). The
message overlay is a fold: it re-mines the whole log every launch and its counts
are a pure function of the bytes. Its persisted file was the SERVED VIEW — one
flat pile of baseline + everything learned so far — so re-seeding from it fed the
fold its own previous output, and each launch added the log's observations to a
snapshot that already held them. Verdicts ride those counts (`n >= 2` is what
makes a message VERIFIED), so the registry was drifting from "what the log says"
toward "how many times the app has started". `MessageOverlayMiner` now keeps ONE
BUCKET PER SOURCE (the character id whose log produced the counts;
`BASELINE_SOURCE` for the committed baseline), `beginSource(key)` DISCARDS that
bucket before its log is folded again — `session.resetWorldFor` calls it, before
the scan — and `build()` sums the buckets. A re-fold REPLACES a source's
contribution; idempotence is structural rather than a check somebody remembers to
run. The persisted file is version 2 and is a REGISTER (`sources: [{key,
messages}]`, no verdicts — a stored verdict is a second opinion waiting to
disagree with the derived one); v1 files are ignored, which retires the inflation
in the field. TWO THINGS THE FIX DELIBERATELY IS NOT. It does not drop the
persisted seed: a bucket for a character you are not folding is knowledge nothing
can re-derive, and the seed is the ONLY channel by which a user's own mined
messages become parser corrections (`effectiveSpellDb` derives them from the seed,
BEFORE the fold, and nothing recomputes them after). And it does not dedupe by log
position: an identity per observation would persist thousands of offsets to answer
a question the source key already answers.
`tests/messageOverlayIdempotence.test.mts` folds three simulated cold launches and
demands byte-identical overlays, proves a second character's bucket survives
untouched, and carries a TRIPWIRE that re-creates the old shape and watches the
counts double.

If a startup-cost ticket ever comes back: measure first, and read
`git log 5038f6f0..1c3e584f` before rebuilding any of this.

## Log-format reference: section header note

<!-- Moved verbatim from AGENTS.md (lines 1126-1126 at the JOS-252 cut). -->

## Log-format quick reference (all validated against the real log)

## The four skill-lane arguments (Cleave, Smite, Ranged, Strike)

<!-- Moved verbatim from AGENTS.md (lines 1131-1239 at the JOS-252 cut). -->

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

## Mend: the unstated-heal lane (JOS-86)

<!-- Moved verbatim from AGENTS.md (lines 1240-1276 at the JOS-252 cut). -->

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

## Special attacks: the lane label is state (Slam refused)

<!-- Moved verbatim from AGENTS.md (lines 1277-1293 at the JOS-252 cut). -->

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

## Zone tier decoding (JOS-166 history)

<!-- Moved verbatim from AGENTS.md (lines 1294-1309 at the JOS-252 cut). -->

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

## AA lines: formats, ladder and the two non-parsed families

<!-- Moved verbatim from AGENTS.md (lines 1314-1328 at the JOS-252 cut). -->

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

## Quick Buff and the group fan-out roster rung (JOS-85)

<!-- Moved verbatim from AGENTS.md (lines 1345-1366 at the JOS-252 cut). -->

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

## The pet-binding saga (JOS-47/49/52/54/188)

<!-- Moved verbatim from AGENTS.md (lines 1367-1477 at the JOS-252 cut). -->

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

## The focus-item shimmer misread (JOS-79)

<!-- Moved verbatim from AGENTS.md (lines 1488-1504 at the JOS-252 cut). -->

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

## A tell's tense (JOS-69)

<!-- Moved verbatim from AGENTS.md (lines 1507-1518 at the JOS-252 cut). -->

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

## Slows are a roster with two sides (JOS-69, JOS-233)

<!-- Moved verbatim from AGENTS.md (lines 1519-1546 at the JOS-252 cut). -->

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
  **AND THE ROSTER HAS TWO SIDES NOW, BECAUSE ONE MEMBER CANNOT SAFELY BE ON BOTH**
  (JOS-233, owner ruling 2026-08-12). The bard's binding pair — Largo's Melodic
  Binding 20 and its direct upgrade Largo's Assonant Binding 51 — joined the slow
  roster on the MOB side, the first members that do not come from the two landing
  emotes (each prints its own one-member sentence, so the oracle says nothing about
  them either way; the ruling is that the binding slows a mob's swings as well as
  its feet, and JOS-225 had left its wear-off silent after taking it out of
  `ccSpell`). They are NOT on the on-you side: `The strands fade away.` is shared
  VERBATIM with `Lyssa's Solidarity of Vision`, a Bard 34 BENEFICIAL buff, and a
  `where.spell` matcher tests the whole candidate list (JOS-84) — one shared roster
  would announce a slow every time that buff lapsed. Same tripwire as the haste
  twin except the sentences are identical rather than a word apart, so anchoring
  cannot fix it and only the split roster can. The wider binding line (Selo's
  Consonant Chain 23, Chords of Cessation 48, Assonant Strain 54) is EXPLICITLY
  UNRULED and stays silent; the table that says so is in tests/charmCcRoster.test.mts.

## Charm and mez rosters, and the oracle's two reversals (JOS-84/200/225)

<!-- Moved verbatim from AGENTS.md (lines 1547-1591 at the JOS-252 cut). -->

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
  54, Enslave Death 60; the ladder's first three were covered by accident). Two of
  those bard entries have since been withdrawn — Bravura to `charmSpell` (JOS-200)
  and both Largo's out of the rosters altogether (JOS-225); see the effect-family
  law below.
  **THE DB AND THE LOG DISAGREE ABOUT ITS NAME**: spells.json says `Solon's
  Bravura`, the log prints `Solon's Bewitching Bravura` (the scrape lost the middle
  word), so the stem answers to both — the oracle found that, not a reviewer.
  **AND A MESSAGE FAMILY IS NOT AN EFFECT FAMILY — THE ORACLE HAS BEEN WRONG IN
  BOTH DIRECTIONS.** JOS-84 read `Solon's Bewitching Bravura` as a mez off the
  landing family it shares with three real mezzes; JOS-200 reversed that (it is the
  bard's level-39 CHARM, and it fires charm break) because spells.json has no
  effect column. JOS-225 is the same error the other way: BOTH `Largo's` binding
  songs left `ccSpell` entirely — they are movement debuffs whose wear-off was
  firing "Mez / root broke" at a bard, they were never checked for effect (the
  level-20 one was in the original hand-audited stems, the level-51 one arrived
  with JOS-84's family walk), and the log settles it — the target trades melee
  blows through the song, and `<mob> has been awakened by <name>.` accompanies 0 of
  81 Largo's wear-offs against 67-86% for every genuine mez in the roster. Both
  reversals live as EVIDENCE-CARRYING TABLES in tests/charmCcRoster.test.mts
  (`FAMILY_EXCEPTIONS`, `NOT_A_HOLD`) rather than as quiet regex edits, precisely
  so the next scrape cannot sweep them back in. Adding a row is a claim about what
  the game DOES, backed by log lines — never a way to quiet a noisy alert.
  **AND "NOT A HOLD" IS NOT "NOT AN ALERT"** (JOS-233): the parser rosters still
  refuse both Largo's and their break is still a `buffFade`, but the owner ruled
  them attack-speed debuffs, so the SLOW group's mob-side roster claims them by
  name and the wear-off that used to say "Mez / root broke" now says "Slow wore off
  a mob". `NOT_A_HOLD` carries a `fires` column for exactly that reason — a row
  states which group it ends up in, so it cannot drift silently between the two.

## The calm-line roster and ruling 8 (JOS-213)

<!-- Moved verbatim from AGENTS.md (lines 1592-1612 at the JOS-252 cut). -->

- **THE CALM LINE IS A ROSTER TOO — AND ROUTING OBEYS RULING 8 (JOS-213).** Pacify,
  Soothe, Calm, Lull and the rest are `spellType: Beneficial`, so `cls` is `buff`
  and the timer landed in the player's BUFF overlay beside their own Clarity — while
  the thing they are watching is how long that giant stays calm, which is a mob-state
  timer. The fix is a SECOND, orthogonal fact about the SPELL
  (`ActiveBuff.calmsTarget`, `data/spellDb.ts spellCalmsTarget`), derived from the
  three landing sentences spells.json groups the family by (`Someone looks less
  aggressive.` 6 members, `Someone calms down.` 1, `Someone looks friendly.` 3) and
  re-derived by an oracle every run, exactly like `ccSpell`/`charmSpell`. `cls` does
  NOT change: a calm is a good thing you cast at something you are afraid of.
  **THE CUT THAT FAILED IS THE LESSON**: routing on "the TARGET is a mob" is the
  obvious reading of the report and reruns the error JOS-136/JOS-140 ruling 8 already
  outlawed — `disposition: 'hostile'` means only "not you and not a pet I am currently
  holding", so a friendly buff on somebody the model lost track of tallies hostile.
  Two committed goldens rejected it on the spot (a `Resist Disease` from a Quick Buff
  burst on a spider, and the owner's own `Valor` on a charmed fire giant warrior whose
  charm line is outside the window). Nature — and now surface — comes from the spell,
  never from the shape of the target. Fixtures: `w64-pacify-mob.log` /
  `w65-pacify-mob-death.log` (`npm run fixtures:calm`), pinned in
  `tests/calmLineTimers.test.mts`. A pacified mob CAN be killed, so it takes the
  ordinary decrement-one death censor and never JOS-228's mez refusal.

## The friend system announces nothing (JOS-69)

<!-- Moved verbatim from AGENTS.md (lines 1613-1620 at the JOS-252 cut). -->

- **THE FRIEND SYSTEM ANNOUNCES NOTHING** (JOS-69, same sweep). It prints exactly
  two things: `Friends currently on EverQuest Legends:` (43× — the `/friends`
  command's own output, a header + dashed rule + a /who-style roster row, printed
  only when you ask) and `<name> is now your friend.` (3× — the `/friend add`
  confirmation). No login line, no logout line. "A friend came online" is
  knowable only by polling `/friends` and diffing rosters, which is something the
  app would be DOING, not something the log says — so the group ships hidden
  beside feign-death and pet-death.

## The bundled wiki art (JOS-198)

<!-- Moved verbatim from AGENTS.md (lines 1648-1678 at the JOS-252 cut). -->

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

## The permanent image cache and its allowlist

<!-- Moved verbatim from AGENTS.md (lines 1679-1724 at the JOS-252 cut). -->

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

## Sound packs and the retired-pack migration

<!-- Moved verbatim from AGENTS.md (lines 1725-1736 at the JOS-252 cut). -->

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

## Bring your own sound (JOS-68)

<!-- Moved verbatim from AGENTS.md (lines 1737-1766 at the JOS-252 cut). -->

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

## The em-dash copy rule at full length (JOS-106)

<!-- Moved verbatim from AGENTS.md (lines 1770-1789 at the JOS-252 cut). -->

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

## Say what the log did, not what we did to the number (JOS-106)

<!-- Moved verbatim from AGENTS.md (lines 1790-1799 at the JOS-252 cut). -->

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

## Back navigation: the one mechanism + mouse4 (JOS-43, JOS-201)

<!-- Moved verbatim from AGENTS.md (lines 1812-1843 at the JOS-252 cut). -->

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

## A view unmounts on every tab switch (JOS-90/97/116)

<!-- Moved verbatim from AGENTS.md (lines 1844-1859 at the JOS-252 cut). -->

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

## Celebrations: once per live transition, credited kills

<!-- Moved verbatim from AGENTS.md (lines 1893-1912 at the JOS-252 cut). -->

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

## Two text sizes, two mechanisms (JOS-123)

<!-- Moved verbatim from AGENTS.md (lines 1914-1934 at the JOS-252 cut). -->

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

## A user-picked colour reaches a style property (JOS-125)

<!-- Moved verbatim from AGENTS.md (lines 1936-1953 at the JOS-252 cut). -->

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

## CI publish-on-tags rework history

<!-- Moved verbatim from AGENTS.md (lines 1957-1967 at the JOS-252 cut). -->

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

## Release notes gate (JOS-73) at full length

<!-- Moved verbatim from AGENTS.md (lines 1968-1981 at the JOS-252 cut). -->

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

## main.yml bridge + Azure signing wiring

<!-- Moved verbatim from AGENTS.md (lines 1987-1994 at the JOS-252 cut). -->

- **main.yml BRIDGE (do not remove)**: every install to date polls the 'main'
  channel feed. A stable release natively writes only latest.yml, so the tag
  job uploads a copy as main.yml on the same release — semver puts `X.Y.Z`
  above `X.Y.Z-main.N`, so old main-channel installs step up to stables
  instead of stalling forever. Azure Trusted Signing wiring is inert
  until 6 `AZURE_*` repo secrets exist (account `jmoyers-eqtools` — an
  EXTERNAL Azure resource name, deliberately not renamed; endpoint
  `https://eus.codesigning.azure.net/`; identity validation pending).

## npm ci and the electron binary hook

<!-- Moved verbatim from AGENTS.md (lines 1995-2003 at the JOS-252 cut). -->

- **`npm ci` DOES NOT INSTALL ELECTRON'S BINARY ANY MORE.** `.npmrc` sets
  `ignore-scripts=true` (no dependency's install hook executes — the npm
  compromise vector), so after any `npm ci` / `npm install` you MUST run
  `npm run deps:electron` or dev/dist fails on a missing Electron binary.
  It is the ONE package in the tree that needs its hook (esbuild's is
  redundant — its binary ships in `@esbuild/win32-x64`; everything else
  declares only `prepare`/`prepack`, which npm never runs for registry
  tarballs). Both CI jobs do it as an explicit step. Explicit `npm run <x>`
  is unaffected by the flag; only lifecycle hooks are.

## The Windows 10 installer gate and the version lie (JOS-32)

<!-- Moved verbatim from AGENTS.md (lines 2026-2040 at the JOS-252 cut). -->

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

## Add/Remove Programs registration detail

<!-- Moved verbatim from AGENTS.md (lines 2041-2054 at the JOS-252 cut). -->

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

## Branding, publish artifacts, auto-update, first-run

<!-- Moved verbatim from AGENTS.md (lines 2073-2091 at the JOS-252 cut). -->

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

## Discovery spawns nothing: the native-reg move (JOS-184)

<!-- Moved verbatim from AGENTS.md (lines 2092-2121 at the JOS-252 cut). -->

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

## One-name identity detail

<!-- Moved verbatim from AGENTS.md (lines 2125-2136 at the JOS-252 cut). -->

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

## The one-time eq-tools seed and the update-continuity break

<!-- Moved verbatim from AGENTS.md (lines 2156-2170 at the JOS-252 cut). -->

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

## Installer test tier 1 detail

<!-- Moved verbatim from AGENTS.md (lines 2214-2221 at the JOS-252 cut). -->

1. **Local self-test** (any dev machine, no elevation): run the Setup exe
   `/S` → assert files under `%LOCALAPPDATA%\Programs\everquest-companion`, Start-menu
   shortcut, branded exe metadata; launch (since Task #58 the installed app
   has its OWN userData + lock, so it opens its own window BESIDE a running
   dev app — that's the PASS; it no longer just focuses dev);
   `Uninstall*.exe /S` → assert cleanup, appData preserved. Cheap smoke for
   every dist build.
2. **Windows Sandbox** — the REAL clean-machine test: disposable pristine VM,

## Sandbox harness invocation detail

<!-- Moved verbatim from AGENTS.md (lines 2229-2243 at the JOS-252 cut). -->

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

## Docker tier + test-current rule

<!-- Moved verbatim from AGENTS.md (lines 2244-2251 at the JOS-252 cut). -->

3. **Docker servercore** (`scripts/docker/`) — headless file-level
   fallback: silent install + file/ARP-registry verification only (no GUI
   launch test); throws on the first failure. Use when Sandbox isn't
   available.

Always test the CURRENT `npm run dist` output, not a stale release/ exe —
a clean-machine pass on an old build proves nothing about today's
first-run provisioning.

## Post-release smoke test detail

<!-- Moved verbatim from AGENTS.md (lines 2255-2270 at the JOS-252 cut). -->

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

## Overlay kinds catalog

<!-- Moved verbatim from AGENTS.md (lines 2271-2292 at the JOS-252 cut). -->

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

## The scroll grip (JOS-138)

<!-- Moved verbatim from AGENTS.md (lines 2293-2322 at the JOS-252 cut). -->

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

## The buff/timer overlay's bar law (JOS-89)

<!-- Moved verbatim from AGENTS.md (lines 2323-2364 at the JOS-252 cut). -->

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

## A hidden window cannot paint (JOS-120)

<!-- Moved verbatim from AGENTS.md (lines 2365-2398 at the JOS-252 cut). -->

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

## The presence watcher: powershell to koffi worker (JOS-182)

<!-- Moved verbatim from AGENTS.md (lines 2399-2433 at the JOS-252 cut). -->

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

## Buffs/debuffs: two windows over one model (JOS-119)

<!-- Moved verbatim from AGENTS.md (lines 2434-2461 at the JOS-252 cut). -->

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

## Graphics compatibility: two switches (JOS-40)

<!-- Moved verbatim from AGENTS.md (lines 2462-2486 at the JOS-252 cut). -->

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

## Wine detection signals (JOS-31)

<!-- Moved verbatim from AGENTS.md (lines 2487-2539 at the JOS-252 cut). -->

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

## AWS account and CLI profile detail

<!-- Moved verbatim from AGENTS.md (lines 2543-2550 at the JOS-252 cut). -->

- **AWS**: dedicated sub-account `eqcompanion` **001634075447** (org
  management = the `jmoyers` account 383185690517), region **us-east-1**.
  CLI: profile `eqc` in `~/.aws/config` assumes
  `OrganizationAccountAccessRole` via source profile `windows-desktop-eqc`
  (an IAM user whose key the OWNER manages; a least-privilege inline
  policy limiting it to that one AssumeRole was recommended and handed to
  the owner). Terraform + AWS CLI are installed (winget; terraform.exe
  under `%LOCALAPPDATA%\Microsoft\WinGet\Packages\Hashicorp.Terraform_*`).

## F2 deployment detail

<!-- Moved verbatim from AGENTS.md (lines 2568-2581 at the JOS-252 cut). -->

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

## The cohort-split migration detail

<!-- Moved verbatim from AGENTS.md (lines 2582-2593 at the JOS-252 cut). -->

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

## Analytics operations detail

<!-- Moved verbatim from AGENTS.md (lines 2594-2632 at the JOS-252 cut). -->

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

## Usage analytics: consent model and the lit endpoint

<!-- Moved verbatim from AGENTS.md (lines 2638-2653 at the JOS-252 cut). -->

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

## The user/owner split detail

<!-- Moved verbatim from AGENTS.md (lines 2666-2677 at the JOS-252 cut). -->

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


## Toolchain wave landed (history)

<!-- Moved verbatim from AGENTS.md (lines 2680-2693 at the JOS-252 cut). -->

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

## Feedback loop plan pointer (superseded by F1/F2 shipping)

<!-- Moved verbatim from AGENTS.md (lines 2695-2700 at the JOS-252 cut). -->

- **Feedback loop (the next big feature)**: fully planned + reviewed in
  `docs/plans/feedback-triage.md` — in-app reports, scrubbed log-window
  uploads, **Terraform** infra (owner decision: HCL, us-east-1, dedicated
  AWS sub-account, alarms to jmoyers+eqc@gmail.com), agentic triage CLI.
  Wave F1 ships dark (no endpoint) and needs no cloud; F2 (deploy) needs
  the owner to create the sub-account. Targeted at the v0.3.0 cycle.

## Design-docs note + tail-first startup idea

<!-- Moved verbatim from AGENTS.md (lines 2705-2713 at the JOS-252 cut). -->

- Design docs for every shipped 2026-08-03 feature live in `docs/plans/`
  — historical intent; the code + this file are the current truth, and
  several plan numbers were overturned by executor measurement (each
  overturn is recorded in the relevant commit message).
- Startup could be TAIL-FIRST: attach the live tail immediately, then backfill
  history BACKWARDS into the model, so the meter is live in ~0s and deepens as
  the replay lands (today: ~6s of `hydrating` on this log, then live). Needs
  order-independent folding in every module — a real architecture change, not
  yet attempted. The `hydrating` flag makes today's replay honest meanwhile.

## Open chips (2026-08-05) with the combo swap-back brief

<!-- Moved verbatim from AGENTS.md (lines 2716-2726 at the JOS-252 cut). -->

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

## Release arc summary (v0.4.0-v0.6.0)

<!-- Moved verbatim from AGENTS.md (lines 2738-2741 at the JOS-252 cut). -->

- Releases this arc: v0.4.0 (planner + toasts + parity + credited kills),
  v0.5.0 (monk lanes, outputs engine, AA ladder), v0.6.0 (Rounds panel,
  log-attach fix, Wine installer) — all sandbox-gated + smoke-verified;
  ~55 installs / ~58 peak concurrent as of v0.6.0 day.

## The rank-agnostic alerts sweep, at full length (JOS-276)

<!-- Moved verbatim from AGENTS.md (the JOS-276 append, 2026-08-13; trimmed by the integrator the same day when the word ceiling tripped). -->

JOS-259 deliberately left `damage.skill` for an owner call, and this is it. The damage lane
folds now, for the two dtypes whose `skill` IS a spell name: `foldsRank`
(main/modules/alerts.ts) admits `spell` on any kind plus `skill` on a `damage`
trigger, and `foldReaches` gates the second per EVENT on `dtype 'spell'|'dot'`. The
defect was the same one, one lane over: the owner's log prints
`… damage by Harm Touch.` 488 times and `… damage by Harm Touch III|IV|VI|IX.` 23
times, plus `Chords of Dissonance` at five spellings off four bards in the dot lane,
so a damage alert on a base name heard most of its own lines and not the rest. The
other two dtypes stay out: `melee` cannot carry a rank because its `skill` is not log
text at all but one of ten constants from `meleeSkill(verb)` (the JOS-259 worker's
inertness measurement, re-verified and now pinned), and `ds` is inert TODAY (the whole
log spells flames/thorns/frost) but is free text off the line, so the gate is written
on the dtype rather than trusted to the measurement. THE SWEEP FOUND TWO MORE, both
outside the matcher: the curated slow rosters in shared/alertGroups.ts are
APP-authored `/^(…)$/` regexes, so JOS-259's "a regex is user intent" exemption never
covered them — the `$` anchor is ours, and they now carry an optional rank tail (a
wear-off CAN print one: `Your Rune IV spell has worn off of a gust of wind.`, the
3,383rd of 3,383); and the wizard's rank chips deduped by RANK, so a levelled user was
offered a second alert firing on lines the first already covered
(`suggestionCoverageId`, an id fold with nothing migrated). Left rank-SENSITIVE on
purpose, each with the reason written where it lives: `spellLastCast` (the map that
answers "which rank am I using"), `detectRankUpgrades` (the offer strip, now a
convenience) and `matcherAccepts` in shared/earlyWarning.ts (key-blind, and its one
caller asks about `refresh`). Rank-blind by construction and re-checked: the cooldown
key (alert id + mob, no spell), and the whole early-warning identity path
(`timerNameKey`/`timerNameBase` fold on both sides, and the probes hand a def the
RANK-LESS spelling the break line prints). Pinned in the D-series of
tests/rankBlindSpellAlerts.test.mts.

## The overlay floor measurement, at full length (JOS-278)

<!-- Moved verbatim from AGENTS.md (the JOS-278 append, 2026-08-13; trimmed by the integrator the same day when the word ceiling tripped). -->

`OVERLAY_MIN_SIZE` (140x90, was 200x90) came DOWN because a player magnifying the
screen with Lossless Scaling gets it back multiplied. Lowering it was only possible
because the chrome learned to give way: the footer WRAPS (`FOOTER_ROW`,
overlay/overlayScale.tsx — its items still never shrink) and the header's drag gutter
and kind tag shrink before the lock/close pair does. Measuring it found that the OLD
200 floor already had A− / A+ off the right edge on buffs, debuffs and XP.
`tests/e2e/overlayMinSizeSteps.mts` drags each window past the floor through main's
own clamp and asks every button and slider whether its rectangle is still inside the
window; height 90 is 2px over the measured 88 the buffs footer needs at 140 wide, not
a round number.

## Flake ledger — the sky-filters remount row, resolved, full sighting history

<!-- Moved verbatim from AGENTS.md (lines 101-109 at the 2026-08-13 collapse). -->

  - `sky-filters.e2e` · expanded-quest step vs live-log viewKey remount ·
    6 sightings (2026-08-10/11 x3, 2026-08-12 six-spec sweep during JOS-253,
    2026-08-12 six-spec sky sweep during JOS-268, 2026-08-13 v0.26.0 release
    sweep — green standalone immediately after, every time;
    multi-spec-sweep only) · documented in-file
    by the JOS-206 worker;
    **RESOLVED 9816cd34 (JOS-279)** — order-hardening was a BET;
    `tests/e2e/viewRemount.mts` HOLDS the precondition instead (mark the keyed
    subtree, read before you `check`, discard an attempt that lost its mount).

## Flake ledger — the respawn-timers row, resolved, full history

<!-- Moved verbatim from AGENTS.md (lines 127-136 at the 2026-08-13 collapse). -->

  - `respawn-timers.e2e` · the learned gap reads 3m 01s where four assertions
    spell `3m 00s` · 1 sighting (2026-08-13 sweep, JOS-279; green standalone
    after) · DIAGNOSED: `stepWatchFromRecentKills` stamps its two deaths off
    two instants, so a second of wall clock makes the gap 181 s. Stamp both
    off ONE instant; never widen the assertions. ·
    **RESOLVED 0572c77f** — the diagnosis held exactly: `Date.now()` for the
    first death and a bare `append()` (which is `appendAt(new Date())`) for the
    second were two clock reads, and EQ stamps are second-granular. Both deaths
    now stamp off one captured `now`, so the gap is 180 s by construction; the
    assertions were left alone. Green standalone and in a five-spec sweep.

## Flake ledger — the perf.e2e heartbeat row, resolved, full history

<!-- Moved verbatim from AGENTS.md (lines 146-159 at the 2026-08-13 collapse). -->

  - `perf.e2e` heartbeat boundary · "a replay shorter than one heartbeat states
    NO drift figures" fails when the replay lands JUST under the beat and a tick
    still gets counted (118 vs 125 ms twice, 123 vs 125 once) · 5 sightings
    (2026-08-11 phase-4 worker, 2026-08-12 JOS-230 worker, 2026-08-12 JOS-238
    worker, 2026-08-12 v0.23.0 release sweep at 115 vs 125 ms, 2026-08-13
    v0.25.0 release sweep — full-sweep only, green standalone every time; the
    prior row said 3 while listing four events, count corrected) · the JOS-229
    worker sharpened it to "the probe banks a tick inside the window — a
    tick-phase coin flip, not load", which was right about the tick and wrong
    about why ·
    **RESOLVED 0523dd90 (JOS-279)** — asked about the WRONG window: both probes
    run `appReady`→`replayDone`, wider than the fold it gated on (138 vs
    103 ms). Now `probeWindowMs`, plus a three-valued verdict so the naive
    fix's mirror flake cannot appear.

## The /pet who leader scrub carve-out — gate history (JOS-52, JOS-270)

<!-- Moved verbatim from AGENTS.md (lines 184-195 at the 2026-08-13 collapse). -->

  **CARVE-OUT: the `/pet who leader` answer** (JOS-52) — `<Name> says, 'My
  leader is <anyone>.'`, EXACT shape, never a `/leader/` pattern. It was
  SELF-GATED until **JOS-270** (owner ruling 2026-08-13): it is the first
  pet-voiced line carrying a PLAYER's name inside the quote, so it borrowed
  the self-`/who` row's argument. THE GATE IS GONE — the line is kept whatever
  name it carries, on the 2026-08-05 group-membership reasoning (a structural
  fact about the fight, and both names already appear uncensored in every
  combat line of the same slice). The gate's measured cost was that the LIVE
  app binds a group-mate's pet off this line while no feedback slice could
  ever CONTAIN one, which made report 01KZVYMCAD72XFC36D73D8J2E8
  structurally un-triageable. NO COMMITTED FIXTURE MOVED (one occurrence in
  1.4M lines, in `extract-pet-claim`'s p2 window, and it names Primitive).

## The vite define law — full story (2026-08-04)

<!-- Moved verbatim from AGENTS.md (lines 378-388 at the 2026-08-13 collapse). -->

- **Never reference a vite `define` bare**, and **anchor a dev-only flag on
  `import.meta.env.DEV`, not on the `define`.** Defines exist only from
  dev-server START, so a bare identifier under a stale server is a
  `ReferenceError` that blanks the whole app (it did, 2026-08-04) — and
  feature-hidden is still a SILENT wrong answer (the Triage tab vanished with
  nothing to grep). ONE guarded reader per flag:
  `import.meta.env.DEV && (typeof __X__ === 'undefined' || __X__)` — absent
  define means STALE SERVER, degrade upward — and log the resolved value once
  at boot. Config changes (defines, entries, externals) require the OWNER to
  restart `npm run dev`; say so in the report. Full story:
  docs/agents-archive.md.

## Owner tooling gate, at full length (JOS-72)

<!-- Moved verbatim from AGENTS.md (lines 389-401 at the 2026-08-13 collapse). -->

- **OWNER tooling needs `EQ_OWNER_TOOLS=1`; plain DEV is not enough** (JOS-72).
  Tier 1 (dev restart, `UNRELEASED`, boot diagnostics) stays on plain
  `import.meta.env.DEV`; tier 2 (the Triage tab + every `triage:*` handler,
  which read the owner's DSQL/S3/CloudWatch) additionally requires the env
  var at BOTH ends — main refuses to register the IPC
  (`src/main/ownerTools.ts`) and the renderer hides the nav row (devFlags.ts,
  fed by `window.eq.ownerTools`). It exists because `app.isPackaged` is FALSE
  in a self-compiled build of this public repo. Tier 2 degrades **CLOSED** —
  the opposite of tier 1's degrade-upward; policy in
  `src/shared/ownerTools.ts`. The owner sets it in the SHELL
  (`setx EQ_OWNER_TOOLS 1`; electron-vite has no `.env` → `process.env`
  path). Never commit it, never put an AWS profile name in the gate. Full
  story: docs/agents-archive.md.

## A logout pauses your character, at full length (JOS-134, JOS-262)

<!-- Moved verbatim from AGENTS.md (lines 525-550 at the 2026-08-13 collapse). -->

- **A LOGOUT PAUSES YOUR CHARACTER, NOT THE WORLD — SO BUFFS FREEZE AND
  DEBUFFS DO NOT** (JOS-134, owner's design 2026-08-09). EQ resumes a
  beneficial buff's REMAINING duration at login
  (`BuffInstances.onOfflinePause`; the S5 fixture proves it to the second); a
  debuff you left on a mob is a timer in the WORLD and is never shifted
  (`modules/buffTimers.ts` takes an EXPLICIT no-op on `offlineGap`). **The
  boundary is evidence, not a timeout — AND SINCE JOS-262 THERE IS NO TIMEOUT
  LEFT ANYWHERE IN IT.** Every login prints a reconnect preamble, whose LENGTH
  is a client-side duration; while the anchor was a 30s window and the hole's
  answer a 30s timer, a slow-loading machine got no pause at all (measured:
  31s of preamble = no `offlineGap` emitted; the heartbeat wiping the previous
  session's buffs seconds before the `Welcome`). Both constants are gone. ONE
  shared predicate decides both halves: `sessionDetector.ts inWorldEvidence` —
  a line that could ONLY have been printed for THIS character. It anchors
  `fromTs`, and `modules/buffsSession.ts` rules a hole unexplained only when
  such a line arrives with no intervening login. **"Typed" is NOT the test and
  the log says so**: other players' combat lands in the preamble (two `death`
  events 2s before the Aug 07 Welcome), so a stranger's kill proves the CLIENT
  is connected and nothing about you. The priced cost: `fromTs` stays a LOWER
  bound, so a gap never under-states an absence and runs long by the trailing
  run of lines that name nobody — 24s across an ordinary camp (the countdown
  ticks are `unknown`), 56 min in the worst AFK park measured over 45 logins.
  **And the learner refuses BOTH halves of a cycle that spans an absence**
  (`spannedGap`) — both err LONG, the direction law 5's recency-weighted MAX
  is most sensitive to. Censor, never correct. Zoning is not a logout; death
  still clears (JOS-88). Full story: docs/agents-archive.md.

## The spell scrape's revision cache — full note (JOS-251)

<!-- Moved verbatim from AGENTS.md (lines 569-574 at the 2026-08-13 collapse). -->

  **THE SCRAPE IS REVISION-KEYED AND BATCHED**
  (`scripts/sources/cache/spells/index.json` records the revid per cached
  page); a re-run with an unchanged spell list is a byte-identical no-op.
  Re-scraping is cheap — but it is a DATA CHANGE, not a refresh (the JOS-251
  run also picked up 160 wiki edits, one of them wrong). Diff it, do not
  skim it.

## The default sound pack preference, at full length (JOS-273)

<!-- Moved verbatim from AGENTS.md (lines 584-610 at the 2026-08-13 collapse). -->

  **PRESENCE IS NOT PRECEDENCE: THE DEFAULT PACK IS A PREFERENCE, AND A DELETION IS A
  STATEMENT** (JOS-273, owner ruling 2026-08-13 — verbatim: *if someone deletes alan
  rickman, they should be able to set a default and it should persist*). The shipped
  pack used to be HARDCODED as the pack every picker pre-selected and every authored
  alert pointed at, and startup provisioning re-installed it whenever it was missing
  with no memory of a deletion — so deleting it held until the next launch, which
  users experienced as "it re-enables itself with every update". Three parts, all in
  `src/shared/soundPacks.ts` (the pure core) + `storeSoundPacks.ts` (accessors):
  (1) the PREFERENCE `soundPacks.defaultPackId`, honoured by the picker pre-selection
  (`SoundPicker.fallbackPack`, `alertForm` hydration, the row's `AudioPicker`), the
  suggestion builder (every template/rank/illusion chip, the ready-made sets, the
  observed slow offer) and the SEEDS (`alertSeeds.ts`); set from the pack browser's
  star, beside the Uninstall the reporter was already reaching for. (2) the TOMBSTONE
  `soundPacks.removedPackIds` — uninstalling a SHIPPED pack records it,
  `packsToProvision` skips it, installing it again clears it; additive is not the same
  as unconditional. (3) RESOLUTION, not silence: a ref whose pack (or sound) is gone
  resolves through the preference keeping its CESP category (`resolveSoundRef` — the
  live, pack-agnostic form of `migrateAlertSoundRef`'s intent mapping), and where
  nothing can answer the alert ROW says so (`soundNotice`). `getSoundDataIn` used to
  answer null for every pack but the reserved one; that rule was true right up until
  deleting the shipped pack became a supported thing to do. FRESH INSTALLS ARE
  UNCHANGED end to end — absent preference ⇒ every one of those is the identity
  function, and the additive optional key needs no schema bump. The renderer's
  `DEFAULT_PACK_ID` mirror (suggestions.ts) STAYS and keeps its mirror-sync law: it is
  a compile-time fact about what the app SHIPS, and the preference arrives beside it
  as runtime state. Pinned by tests/defaultPackPreference.test.mts +
  tests/e2e/default-sound-pack.e2e.mts (two launches over one userData dir).

## Rank-blind literal matchers, at full length (JOS-259)

<!-- Moved verbatim from AGENTS.md (lines 621-636 at the 2026-08-13 collapse). -->

  **A LITERAL `where.spell` MATCHER IS RANK-BLIND — ALL RANKS, FULL STOP**
  (JOS-259, owner ruling 2026-08-12; domain law, verbatim: once you upgrade a
  spell it never downgrades, even on a loadout swap). Only SOME of a spell's
  lines carry the roman numeral — `castBegin`/`resist` keep it, the wear-off
  family prints the bare name — so whole-string equality let one def satisfy
  half its own spell's lines: a wizard's resisted alert for Elemental
  Maelstrom went silent on the day they unlocked rank II while their fade
  alert kept working. A literal spec now compiles with `spellLineKey(spec)`
  beside it and `accepts` (main/modules/alerts.ts) compares the folded keys
  when the exact compare misses — a pure WIDENING, so a def pinned to a rank
  still fires on it. Untouched, on purpose: `/regex/` specs (user intent, not
  a spelling), every non-`spell` key, and `damage.skill` (a spell name for
  dtype spell/dot and a melee verb otherwise — an owner call of its own). NO
  upgrade-offer compensation: `detectRankUpgrades` still only sees suffixed
  defs, and that is now a convenience rather than the thing between a user
  and a sound. Pinned in tests/rankBlindSpellAlerts.test.mts.

## Template flags that lied, at full length (JOS-103)

<!-- Moved verbatim from AGENTS.md (lines 659-670 at the 2026-08-13 collapse). -->

  **A TEMPLATE FLAG IS A CLAIM THE ALERT CAN FIRE, AND THREE OF THEM WERE LYING**
  (JOS-103). `suggestionTemplates` is now an exhaustive table over the DB's
  33 observed `spellType`s — a spell with no template is DROPPED from the
  catalog (Spirit of the Puma was invisible). `lands` is not offered where no
  `buffApply` can ever be emitted; `wearsOff` is an `any` composite over
  `buffExpired` + `buffWearOff` (a buff somebody else cast never becomes an
  active instance). Puma's landing line has NO typed event at all, so its
  shipped capture suggestion is a `raw` trigger — the only thing that exists
  for that family. **AND `suggestions.ts` IS NODE-TESTED NOW** (imports
  relative, repo law): `tests/suggestedAlertsFire.test.mts` drives a real
  suggested def through the real parser into the real module. Full story:
  docs/agents-archive.md.

## The external-link allowlist widening, at full length (JOS-254, JOS-263)

<!-- Moved verbatim from AGENTS.md (lines 714-729 at the 2026-08-13 collapse). -->

  **That allowlist is the boundary, not a formality**: link URLs are built from
  WIKI PAGE TITLES (`shared/wiki.ts`), and an unvalidated openExternal would let
  one ask the OS to run `file:///…exe`. Widen `EXTERNAL_LINK_ALLOWLIST`
  (security.ts) deliberately or not at all, **and an entry is a HOST PLUS AN
  OPTIONAL PATH SCOPE — write the narrowest one that serves the link** (owner
  ruling, JOS-263). It has been widened ONCE, for `github.com` (JOS-254, the
  What's new panel's link to the releases page), and that entry is
  REPO-SCOPED: only `https://github.com/jmoyers/everquest-companion/…` opens,
  never github.com's root or anyone else's repo. The three wiki entries stay
  host-wide because a wiki link's PATH is the page title this app cannot
  predict; github.com is not one site the way a wiki is. The justification is
  written where it lives: the URL is a constant in the renderer bundle rather
  than scraped text, and that repo is where every build of this app comes from.
  The path prefix is matched SEGMENT-AWARE (`…-companion-evil` is not inside
  `…-companion`) against the WHATWG-normalized pathname, so `..` — and its
  `%2e%2e` spelling — is already resolved away before the check.

## Respawn rounds 7-9 — the distilled block as it stood

<!-- Moved verbatim from AGENTS.md (lines 903-910 at the 2026-08-13 collapse). -->

   Rounds 7-9, distilled: the tab is Timers; the duration + source label are
   ONE bordered unit whose edit icon opens `RespawnEditDialog.tsx`
   (whitelist grammar `parseRespawnDuration`; `respawnOverridden` = the
   ladder saying `source === 'custom'`); the OVERLAY carries no editing;
   **a watched row NEVER vanishes while watched** (round 8 — the expiry
   sweep is gone; stale rows read "due long ago"; what ages out is the SEEN
   state; unwatch is the only way a row leaves); the mob hover card is
   IN-APP ONLY. Full rounds history: docs/agents-archive.md.

## The fold checkpoint post-mortem paragraph, as it stood (JOS-208, JOS-230)

<!-- Moved verbatim from AGENTS.md (lines 914-928 at the 2026-08-13 collapse). -->

For two days the app could restore its world model from a binary checkpoint
and replay only the log's tail (~5,000 lines of machinery). It worked; the
owner removed it anyway: the cold-read stall it targeted did not survive its
own instrumentation (fleet p95 time-to-first-MB 10-25 ms — the real cost is
fold CPU under the slicer's fixed duty), it shipped OFF behind a gate whose
denominator could never move, and it taxed every fold change with
schema/goldens/census ceremony. WHAT SURVIVED, because it is the app's and
not the feature's: `tests/foldDeterminism.test.mts` (**a historical replay
reads no wall clock**), the engine's `st.hydrating` gate
(`tests/combatReplayClock.test.mts`), and
`MessageOverlayMiner.lastObservedTs` (a published snapshot's `updatedAt` is
the LOG's clock). Both product fixes were found by folding the same bytes
twice and diffing — reach for that again, harness or no harness. If a
startup-cost ticket comes back: measure first, and read
`git log 5038f6f0..1c3e584f`. Full post-mortem: docs/agents-archive.md.

## The class-skill melee lanes and their per-lane proofs, at full length (JOS-77, JOS-81, JOS-92, JOS-163)

<!-- Moved verbatim from AGENTS.md (lines 957-987 at the 2026-08-13 collapse). -->

- **A VERB THAT NAMES A CLASS SKILL GETS ITS OWN LANE; A WEAPON VERB DOES
  NOT** (JOS-77, JOS-81). `meleeSkill()` (log/parseCombat.ts) splits
  Backstab, Bash, Kick, Frenzy, Flurry, Cleave (WAR) and Smite (PAL);
  slash/pierce/crush/hit/slice/claw/gore are what a weapon in a hand prints
  and share the generic "Melee" row (the Rounds panel splits those BY VERB).
  The table is HAND-AUTHORED against `data/classes.json`'s skill→class map —
  never a matcher over spelling. The proofs differ per lane; know them
  before adding one:
  - Cleave (JOS-77): an ABSENCE — the owner slashes 71,104 times, cleaves
    ZERO, receives 20,334 incoming cleaves; a verb that never prints for a
    player who lacks the skill is gated on the skill.
  - Smite (JOS-81): THE SKILL-UP STREAM — a weapon verb never ticks under
    its own name (`better at Slash!` does not exist) while `Smite` ticks
    beside Kick/Bash/Backstab. **THE SKILL LANE AND THE SPELL LANE SHARE A
    STEM AND MUST NEVER MERGE** — a spell literally named `Smite` exists;
    `tests/combatSmiteLane.test.mts` pins the collision on real bytes.
  - Ranged (JOS-92): **a weapon verb fired from a different SLOT than the
    hands is not the hand lane** — `shoot` ticks under `Archery`. THE
    DISCRIMINATOR IS THE VERB AND NOTHING ELSE (a stance- or class-keyed
    split would mis-assign a stance-switcher's fight); no thrown lane is
    invented beside it (awaiting-sample law); the self arm is INJECTED in
    `tests/combatRangedLane.test.mts` — the owner has never fired a bow.
  - Strike (JOS-163): the GENERIC VERB every monk special prints as — not a
    class skill, not a slot — so an unnamed strike earns a row called
    **`Strike`**, the verb, never a name from the chain. The bug was the
    PRE-STATE FLOOR (the `You will now use <X> …` line prints once, at
    level-up, so a log that begins after it read "Melee" forever): the verb
    earns the ROW, the state line earns the NAME, and **no lane is ever
    seeded from the chain's first entry** (specialAttacks.ts's stated law).
  Law 8 held byte-identical across all four changes; full counts, fixtures
  and hand tallies: docs/agents-archive.md.

## Mend, at full length (JOS-86)

<!-- Moved verbatim from AGENTS.md (lines 988-999 at the 2026-08-13 collapse). -->

- **A HEAL THE LOG ANNOUNCES BUT NEVER VALUES GETS A LANE THAT CARRIES A COUNT
  AND NO NUMBER** (JOS-86 — the monk's Mend). `You mend your wounds and heal
  some damage.` is the whole sentence: no amount, no target, no third-person
  twin (whole-log partition: 876 of 1,178 `mend` lines are that sentence, the
  rest skill-ups and chat). THE FIX IS A KIND, NOT A FLAG: `healUnstated`,
  with **no amount field at all** and a third `HealClassification`
  `'unstated'` — a `heal` with `amount: 0` would be a lie with a long tail.
  It enters NO sum and rides its own `HealSourceView.unstatedCount` so the
  crit and overheal rates beside it keep their VALUED denominator; every
  string that would render that 0 prints the reason there isn't one. FIRST
  PERSON ONLY, no invented arms (awaiting-sample law). Law 8 gate: every
  fixture diff was an ADDITION. Full story: docs/agents-archive.md.

## Special attacks print no verb, at full length (JOS-163 context)

<!-- Moved verbatim from AGENTS.md (lines 1000-1011 at the 2026-08-13 collapse). -->

- **SPECIAL ATTACKS PRINT NO VERB OF THEIR OWN.** Dragon Punch, Eagle Strike
  and Tiger Claw ALL land as `You strike …`; Round Kick and Flying Kick as
  `You kick …`. The game names the live one exactly once, in two
  first-person-only shapes (`You will now use <X> while auto attacking.` — a
  GRANT, also how a lane RESETS — and `… instead of <Y> …`, an in-lane
  upgrade), so the lane label is STATE, not parsing:
  `combat/specialAttacks.ts` tracks the live special per VERB lane and ingest
  renames the skill. **`Slam instead of Bash` is REFUSED**: Slam never prints
  `slam` and `better at Slam!` does not exist — a documented
  non-distinguishable (law 6), not a guess. SKILL-UPS ARE NOT AN INPUT
  anywhere here (Tiger Claw keeps ticking after it was replaced). Full
  evidence: docs/agents-archive.md.

## Resist shapes and the full-log sweep counts

<!-- Moved verbatim from AGENTS.md (lines 1041-1048 at the 2026-08-13 collapse). -->

- Resists (`resist` event, Task #51 v2): THREE shapes — `<target> resisted
  your <Spell>!` (caster=you), `<target> resisted <caster>'s <Spell>!`
  (caster=name; test YOUR form FIRST — 712 spell names contain `'s`, e.g.
  Denon's), `You resist[ed] <mob>'s <Spell>!` (incoming). Spell keeps rank
  suffix for display, rank-normalized (spellCanonKey) for keys. Full-log
  sweep: 5747 (you 1749 / pet 390-by-name but ~2019 once charmed mobs
  resolve / other-mob 1695 dropped / incoming 1913). Misses: `tries to … but
  misses!` family (miss/dodge/parry/riposte/block/absorb).

## The pet-summon nudge, at full length (JOS-258)

<!-- Moved verbatim from AGENTS.md (lines 1095-1117 at the 2026-08-13 collapse). -->

  **AND THE APP NOW SAYS SO, ONCE, AND THEN STOPS** (JOS-258, owner ruling
  2026-08-12 — option (a), explicitly NOT a reopening of JOS-49). The blind
  spot is still accepted; what changed is that the meter no longer stays
  silent about it. `combat/petNudge.ts` arms on the player's own pet-summon
  cast (`spellEffectClass.ts`'s derived `summonPet` class — 104 effect rows
  against the 83 `spellType: Pet` files, the gap being the magician's
  Vocarates and the necro's three differently-spelled pets; `Call Pet` is
  excluded, it moves a pet rather than making one) and the overlay meter
  draws ONE sentence on its content background: *Pet summoned - order it
  once or type /pet who leader so the meter can see it.* **STALENESS AND
  REPETITION ARE THE FAILURE MODES, so the whole feature is a timeout**:
  a 10s GRACE (the p2 fixture measures the summon→tell fast path at SIX
  seconds — a nudge drawn and yanked teaches nobody anything), a 45s SHOW,
  and a 5m QUIET after one is ignored. ONE SLOT, so chain-summoning cannot
  stack nudges; cleared by any `bindPetClaim` (all three routes, one seam),
  by a fizzle/interrupt, or by its own clock — swept from the event stream
  AND from `snapshot(now)`, the `sweepCharm` pattern. Armed only when
  `hydrating` is false. **IT COACHES, IT NEVER ADOPTS** — the unbound pet's
  damage is still dropped at routing while the sentence is up, and
  `tests/petSummonNudge.test.mts` asserts exactly that beside the timings.
  The renderer holds NO dismiss state: the snapshot's `petNudge` is absent
  in every state but the one, which is what makes "no persistent banner"
  structural rather than a promise.

## A /who row is ground truth — the JOS-287 worked example

<!-- Moved verbatim from AGENTS.md (lines 1136-1148 at the 2026-08-13 collapse). -->

  **A `/who` ROW IS GROUND TRUTH AT ITS TIMESTAMP, AND INFERENCE NEVER
  OUTRANKS IT** (JOS-192, JOS-287; the two live-log tripwires in
  comboWindows/comboWhoBoundary are this law): an interval may not
  contradict a row it covers, nor be extended or created BACKWARD over
  evidence that contradicts it. Two rows are two statements, never one
  event — so `mergeBoundaries` may narrow, move or absorb an INFERRED
  boundary but never a `/who` cut (`resolveGroup`), and an inferred window
  that covers a row cut is that swap dated better by the game (absorbed,
  recorded in `startAlso`). JOS-287 was a six-day level-drop window
  (50 → 11 re-roll) overlapping four row cuts: one boundary came out where
  there were four and a row typed on Aug 10 was stated over the Aug 09
  morning and the wizard era behind it. Frozen shape: fixture
  `cw7-who-swap-boundary-aug12.log` + tests/comboSwapBoundary.test.mts.

## The worn-focus shimmer reversal, at full length (JOS-79)

<!-- Moved verbatim from AGENTS.md (lines 1149-1157 at the 2026-08-13 collapse). -->

- **`Your <item> shimmers briefly.` / `feels alive with power.` IS A WORN
  FOCUS TALKING, NOT AN ITEM CASTING** (JOS-79, measured whole-log — this
  entry previously said the opposite and it was wrong). All five items that
  print it are focus items; the combo rule that dropped a `castBegin` within
  2.5 s of one was discarding 44.2% of own casts and EVERY wizard observation
  in the log. The rule is gone; the event stays (it keeps 7,921 lines out of
  `unknown`) and says nothing about class in either direction. A
  self-announcing clicky needs its own observed sample before any rule acts
  on one. Measurements: docs/agents-archive.md.

## Slows are a roster, at full length (JOS-69, JOS-233)

<!-- Moved verbatim from AGENTS.md (lines 1168-1185 at the 2026-08-13 collapse). -->

- **SLOWS ARE A ROSTER, NOT A NAME** (JOS-69). A slow wearing off a mob is
  the ordinary named-target `buffFade`, so the SPELL is the matcher and it
  has to be the whole family — a slow is the spell you replace as you level.
  spells.json enumerates it by landing emote (`Someone slows down.` = the
  enchanter ladder, `Someone yawns.` = the shaman one; NPC-only members
  excluded). The ON-YOU side is two shared messages that resolve to all-slow
  candidate lists, so the alert reports the family, never which one. Its
  tripwire is one word away: `Your speed returns to normal.` is NINE HASTES
  (law 3).
  **AND THE ROSTER HAS TWO SIDES NOW, BECAUSE ONE MEMBER CANNOT SAFELY BE ON BOTH**
  (JOS-233, owner ruling 2026-08-12): the bard binding pair (Largo's
  Melodic/Assonant Binding) joined the MOB side only — `The strands fade
  away.` is shared VERBATIM with a beneficial buff, and a `where.spell`
  matcher tests the whole candidate list (JOS-84), so one shared roster would
  announce a slow every time that buff lapsed; anchoring cannot fix identical
  sentences, only the split roster can. The wider binding line is EXPLICITLY
  UNRULED and stays silent; the table is in tests/charmCcRoster.test.mts.
  Full story: docs/agents-archive.md.

## Charm and mez rosters and the oracle's reversals, at full length (JOS-84, JOS-200, JOS-225, JOS-233)

<!-- Moved verbatim from AGENTS.md (lines 1186-1207 at the 2026-08-13 collapse). -->

- **CHARM AND MEZ ARE ROSTERS TOO — AND THE SPELL DB IS THE ORACLE** (JOS-84).
  `Your <spell> spell has worn off of <mob>.` is ONE sentence for three
  facts; `rulesets.ts` matches the spell NAME: `charmSpell` ⇒ `uncharm`,
  `ccSpell` ⇒ `cc {refresh:true}`, neither ⇒ an ordinary `buffFade`. The
  rosters are enumerable from spells.json's landing-message families, and
  `tests/charmCcRoster.test.mts` RE-DERIVES both families every run — a
  future scrape that adds a member fails the suite instead of going mute.
  **A MESSAGE FAMILY IS NOT AN EFFECT FAMILY — THE ORACLE HAS BEEN WRONG IN
  BOTH DIRECTIONS**: Solon's Bewitching Bravura read as a mez off its shared
  landing family and is really the bard's level-39 CHARM (JOS-200); both
  Largo's binding songs left `ccSpell` entirely (JOS-225) — movement debuffs
  whose wear-off was firing "Mez / root broke" at a bard, settled by the log
  (the target trades melee blows through the song; `awakened` accompanies 0
  of 81 Largo's wear-offs against 67-86% for every genuine mez). Both
  reversals live as EVIDENCE-CARRYING TABLES in tests/charmCcRoster.test.mts
  (`FAMILY_EXCEPTIONS`, `NOT_A_HOLD`) precisely so the next scrape cannot
  sweep them back in; adding a row is a claim about what the game DOES,
  backed by log lines — never a way to quiet a noisy alert.
  **AND "NOT A HOLD" IS NOT "NOT AN ALERT"** (JOS-233): the SLOW group's
  mob-side roster claims both Largo's by name, and `NOT_A_HOLD` carries a
  `fires` column so a row states which group it ends up in and cannot drift
  silently between the two. Full story: docs/agents-archive.md.

## The bundled wiki art, at full length (JOS-198)

<!-- Moved verbatim from AGENTS.md (lines 1255-1271 at the 2026-08-13 collapse). -->

- **THE WIKI ART SHIPS IN THE BOX, AND THE FETCH IS THE FALLBACK** (JOS-198,
  `src/main/bundledImages.ts` + `resources/wiki-images/`): every distinct
  item iconId + all 29 boss portraits (780 files, 3.75 MB), COMMITTED — a
  build-time fetch would make `npm run dist` depend on two volunteer wikis'
  uptime. `npm run fetch:images` regenerates them + `manifest.json` (upstream
  URL, byte length, sha256 per file). Files are named by the cache's OWN
  `cacheFileName()`, so the bundle and `<userData>/image-cache` are ONE
  namespace that cannot drift; `bundledImageRoots` probes the dir's three
  addresses (dev/e2e, `app.asar`, `app.asar.unpacked`) in order.
  electron-builder names `resources/wiki-images/**` EXPLICITLY, never
  `resources/**` (gitignored soundpacks sit beside it). A source build
  without images is a SUPPORTED state that falls back to the runtime cache.
  `tests/bundledImages.test.mts` holds the manifest against both data files
  and re-hashes all 780; the e2e proof is `bosses-week.e2e.mts` on a cold
  userData with no network. CREDIT IS PART OF THE FEATURE: Preferences →
  Thanks, README and the 0.19.0 note name both wikis. Full story:
  docs/agents-archive.md.

## Discovery spawns nothing, at full length (JOS-184)

<!-- Moved verbatim from AGENTS.md (lines 1556-1570 at the 2026-08-13 collapse). -->

- **DISCOVERY SPAWNS NOTHING, AND THAT IS AN AV DECISION AS MUCH AS A SPEED ONE
  (JOS-184).** `src/main/log/discovery.ts` used to shell out (eight `reg.exe`
  queries + `wmic`); both reads now go in-process through `native-reg`
  (~150 ms of blocked main thread → ~6 ms, and no "unsigned exe sweeps the
  uninstall registry seconds after install" heuristic signature). Two
  invariants pinned by `tests/eqDiscovery.test.mts`: `eqInstallPathValue`
  reproduces the OLD command's contract exactly (a DATA match, verified
  against real reg.exe behaviour, not the docs), and `fixedDrives` reads
  `HKLM\SYSTEM\MountedDevices` (mapped NETWORK drives are never there — the
  property that keeps the offline-share hang fixed; removable local volumes
  are a harmless superset). `native-reg` over registry-js because it ships
  its N-API prebuild INSIDE the tarball (`.npmrc`'s `ignore-scripts=true` is
  load-bearing); it is `require`d LAZILY and its failure swallowed — a bad
  `.node` must cost one of three discovery paths, not the launch. Full
  story: docs/agents-archive.md.

## The scroll grip, at full length (JOS-138)

<!-- Moved verbatim from AGENTS.md (lines 1714-1730 at the 2026-08-13 collapse). -->

- **SCROLLING AND CLICK-THROUGH CANNOT BOTH BE TRUE OF THE SAME PIXEL (JOS-138).**
  Pinned is `setIgnoreMouseEvents(true, {forward:true})`, and `forward`
  forwards mouse MOVES and nothing else — a wheel notch goes to the game.
  The owner's disposition ("we should allow scroll") is paid for in pixels:
  the **SCROLL GRIP** (`SCROLL_GRIP_W`, overlay/overlayScale.tsx) is a 22px
  strip over the drawn scrollbar; while LOCKED *and* the rows genuinely
  overflow, a forwarded move inside it raises the named-reason sensor
  (`capture('scroll', …)`) and the window takes the mouse for exactly the
  time the pointer spends there — the wheel AND dragging the bar, because
  the grip hands the real scrollbar real events instead of re-implementing
  scrolling. NO new IPC, NO new mouse hook; the rest of the body stays
  genuinely click-through (asserted in `tests/e2e/overlayScrollSteps.mts`).
  Honest limits, stated: entry from outside the right border can miss the
  strip, and Windows' hover-scroll setting is what carries the notch. The
  event log and buffs/debuffs windows need no grip — they hold capture over
  their WHOLE window while hovered, the same trade at the other extreme.
  Full story: docs/agents-archive.md.

## The buff/timer overlay bar law, at full length (JOS-89)

<!-- Moved verbatim from AGENTS.md (lines 1738-1756 at the 2026-08-13 collapse). -->

- **THE BUFF/TIMER OVERLAY'S BAR IS A CLAIM, AND ITS ABSENCE IS THE HONEST HALF**
  (JOS-89, docs/plans/buff-timer-overlay.md). ONE law decides every row: **a
  duration `spells.json` STATES becomes a receding countdown; a duration
  nobody states becomes ELAPSED time counting UP; there is no third case.**
  A bar is a promise about when something ends, so an unknown-duration row
  has NO BAR and a `+` before its time; the mined `observed` estimate is NOT
  a stated duration (`durationSource === 'db'` is the whole discriminator).
  The mez was invisible because of CASCADE ORDER (`classifyCcApply` above
  `classifyDbBuff`); the parser now carries the DB candidate list on the
  application shape and `modules/buffTimers.ts` owns per-target holds keyed
  by mob. Everything else reads off `BuffsSnap.active` — a second fold is
  the two-models scar law 4 is made of; candidates narrow by YOUR OWN CAST
  HISTORY (law 3), and a broadcast with no own cast opens NO hold. A KNOWN
  GAP, deliberately not fixed here: a CC-roster wear-off never reaches
  `onBuffFade`, so the overlay corrects it in its own projection
  (`endedByCc`) — fixing `recordFade` would mint duration samples and move
  mined statistics suite-wide. Selectors are scope-filtered custom
  `OverlaySelect` (the overlay bundle stays MUI-free by law); PERSISTED
  bounds always win. Full story: docs/agents-archive.md.

## A hidden window cannot paint, at full length (JOS-120)

<!-- Moved verbatim from AGENTS.md (lines 1757-1773 at the 2026-08-13 collapse). -->

- **A HIDDEN WINDOW CANNOT PAINT, SO `hide()` IS NEVER HOW YOU CLEAR ONE
  (JOS-120).** A hidden `BrowserWindow` produces no frames and `show()`
  re-presents its last composited surface — an IPC "clear" sent after
  `hide()` is recorded and never drawn (MEASURED: the pending rAF fired 1 ms
  after `showInactive()`, one frame too late). Two rules: **(a) Clear BEFORE
  you hide** (`suspendCursorStream`); **(b) better, do not hide for a state
  you will leave in a few hundred ms** — `ringDisposition` (replayGate.ts)
  splits `idle` (the game no longer owns the screen ⇒ really come off it)
  from `parked` (empty the halo and LEAVE THE WINDOW VISIBLE). The second
  half of the same bug was a CADENCE RATIO: `cursorVisible` gated an 8 ms
  consumer but was read on the 150 ms watcher tick, so the child's loop is
  SPLIT (`GetCursorInfo` every ~16 ms tick, the expensive foreground block
  every tenth). **Whenever a poll GATES a faster consumer, the number that
  matters is the ratio, not either period**
  (`unguardedSamplesPerHiddenCursor`). `tests/cursorRingClick.test.mts`
  models all four clocks and reproduces the twitch on the old path first, so
  the fixed assertion means something. Full story: docs/agents-archive.md.

## The presence watcher rebuild, at full length (JOS-182)

<!-- Moved verbatim from AGENTS.md (lines 1774-1794 at the 2026-08-13 collapse). -->

- **…AND THE LOOP THAT DROVE ALL OF IT NO LONGER SPAWNS ANYTHING (JOS-182).**
  The presence watcher was a hidden `powershell.exe` with runtime `Add-Type`
  — an infostealer signature to a behavioural AV engine, and it never ran at
  all on 578 installs' machines (`spawn ENOENT`, fail-open, nobody could
  tell). It is now a **worker thread** calling user32/kernel32/psapi through
  **koffi**. Three rules, all general:
  - **A NATIVE DEPENDENCY HERE MUST SHIP PREBUILT N-API BINARIES IN ITS NPM
    TARBALL** (`.npmrc` ignores install scripts, `npmRebuild` is false); a
    CI-only compile exists only where nobody can debug it. Pin koffi
    **2.x** — 3.x downloads prebuilds in its install hook.
  - **NEVER `worker.terminate()` A THREAD THAT CALLS NATIVE CODE** —
    MEASURED: terminating inside a koffi call aborts the whole process, no
    catch anywhere. Ask it to stop over the port; a `'message'` handler runs
    only BETWEEN ticks. This would have been a rare, unattributable crash at
    quit, which every session reaches.
  - **MOVING WORK OFF A PROCESS IS NOT THE SAME AS MOVING IT ONTO MAIN** —
    the running scan is 8.4 ms and main is busy; the child's one virtue was
    being somewhere else. Keep that, drop the process. (Same argument as
    `speechWorker`; both are separate rollup inputs because
    `new Worker(path)` loads a FILE.)
  Full story: docs/agents-archive.md.

## Two windows over one model, at full length (JOS-119)

<!-- Moved verbatim from AGENTS.md (lines 1795-1810 at the 2026-08-13 collapse). -->

- **…AND IT IS TWO WINDOWS, OVER ONE MODEL (JOS-119).** The one 'buffs' kind
  became 'buffs' + 'debuffs' — two configs, two windows, two toggles. **THE
  SPLIT IS A FILTER, NOT A FORK**: `buildTimerRows` still folds the models
  exactly once and `shared/buffTimers.ts timerRowSurface` routes each row by
  its own `kind` (`group` is deliberately NOT the discriminator — a Symbol
  on your pet is `group:'target'` and still a BUFF). ONE component
  (`BuffsOverlay.tsx` + a `kind` prop; a copy would be the defect). NO
  MIGRATION by design: `overlays.buffs` keeps its key so bounds carry over;
  `overlays.debuffs` reads the default and arrives OFF. The seventh meter
  slot broke the fixed first-open size, so the uniform size is a FUNCTION OF
  THE DISPLAY (a fixed shrink ladder — largest rung whose grid seats every
  kind; 1080p+ untouched). Two measured e2e gotchas: a programmatic
  `setBounds` from MAIN does not raise `moved`/`resized` (a persistence spec
  must write through `overlay:setConfig`), and `overlayWindow()` matched
  `?kind=` by SUBSTRING (`kind=debuffs` contains `kind=buffs`) — it parses
  the query now. Full story: docs/agents-archive.md.

## Wine detection, at full length (JOS-31)

<!-- Moved verbatim from AGENTS.md (lines 1826-1842 at the 2026-08-13 collapse). -->

- **…AND UNDER WINE THE APP TAKES THAT PATH BY ITSELF (JOS-31).** The
  switches are THREE-STATE (`'auto' | 'on' | 'off'`, store v11) and
  `shared/wineDetect.ts` decides what `auto` means. **PRECEDENCE, one
  function, three rungs**: `EQ_DISABLE_GPU` > an explicit user choice >
  detection > off; `resolveGraphics` is the ONLY place that folds them, read
  by all three consumers so a window cannot be built one way and labelled
  another. **DETECTION IS CONSERVATIVE OR IT IS NOTHING** — a false positive
  costs EVERY Windows user their GPU. Two signals, either sufficient, both
  impossible on real Windows: Wine's own tools in `system32` (exact
  filenames, never a `wine*` pattern), and the env vars Wine's own ntdll
  injects into every hosted process (WINEHOMEDIR et al — NOT `WINEPREFIX`,
  which is launcher-set and a false positive we may not have). Gated on
  `platform === 'win32'`. Safe mode under Wine is WineHQ bug 48618, not a
  guess. The 10→11 migration reads a stored `false` as 'auto' and `true` as
  'on'. **NOTHING HERE WAS VERIFIED UNDER WINE** — the tests pin the
  NEGATIVE exhaustively and the reporter is the verification path. Rejected
  signals and why: docs/agents-archive.md.

## F2 deployment note, at full length

<!-- Moved verbatim from AGENTS.md (lines 1868-1875 at the 2026-08-13 collapse). -->

- **F2: DEPLOYED AND LIVE (2026-08-04).** Live-verified: submit 201 + ULID,
  idempotent replay 200 same id, oversize 413; kill switch OPEN; the three
  constants filled in net.ts (api pcy0z3xjp9… · bucket
  eqcompanion-logs-6c58f5cc · us-east-1). Two DSQL live findings encoded:
  grants on the system-owned `public` schema are unsupported (table-level
  grants suffice), and `statement_timeout` cannot be SET (client-side
  query_timeout only; db.ts fixed). Remaining negatives + the SNS
  confirmation: docs/agents-archive.md.

## The cohort-split migration bullet, as it stood

<!-- Moved verbatim from AGENTS.md (lines 1876-1883 at the 2026-08-13 collapse). -->

- **ANALYTICS COHORT SPLIT — LIVE (2026-08-05, waves R+S, run under the
  standing authorization).** Owner vs user cohort lives IN the counter
  tables' primary keys; the migration ran COPY-FIRST per owner ruling
  (staging tables, row-count AND sum(n) verification, swap via DSQL's
  documented `RENAME TO`; nothing dropped until its verified copy existed).
  Runbook preserved in infra/README.md "THE COHORT MIGRATION". Owner
  installs marked; **a ROTATED analyticsId arrives unmarked — re-run
  `analytics owner-add`**.

## The toolchain wave note, as it stood (JOS-63)

<!-- Moved verbatim from AGENTS.md (lines 1965-1971 at the 2026-08-13 collapse). -->

- **TOOLCHAIN WAVE — LANDED** (verified 2026-08-06, JOS-63): electron
  43.2.0, vite 7.3.6, electron-vite 5.0.0 are what the tree runs. Still open
  from the same flag: the installer ships ~150MB of other-platform onnx
  binaries (trim via asarUnpack filters; koffi's excluded other-platform
  prebuilds are the worked example beside it). The .npmrc / npmRebuild
  comments were rewritten by JOS-182 and state the prebuilt-N-API rule.
  History: docs/agents-archive.md.

## Open chips of 2026-08-05, as they stood

<!-- Moved verbatim from AGENTS.md (lines 1987-1992 at the 2026-08-13 collapse). -->

- **Open chips (2026-08-05, each with a full brief in its chip):** the combo
  swap-back blind spot — the hardest inference fix in the repo, do not rush
  it; **PARTLY CLOSED by JOS-79** (`reinstatedDrops`; a swap between capped
  classes still dings for nothing and remains evidence-only); the e2e
  per-checkout lockfile; copyText still serializing the melee-rounds footer
  the Rounds panel replaced. Full briefs: docs/agents-archive.md.

## Awaiting real samples — the Double Bow Shot note, at full length (JOS-92)

<!-- Moved verbatim from AGENTS.md (lines 1993-2003 at the 2026-08-13 collapse). -->

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

## The feature-surface intro, as it stood before the 2026-08-13 collapse

<!-- Moved verbatim from AGENTS.md (lines 14-32 at the 2026-08-13 collapse). -->

**EverQuest Legends** log in real time. Surfaces: an Overview landing tab
(default view — DPS w/ inline drill, live curve, current mob, zone, leveling
rate + next-level ETA, class loadout, recent drops/kills), Plane of Sky quest
tracking, loot, inventory reconcile, leveling/AA analytics, a Maps tab
(Brewall/default rendering, POI search, label declutter, floor slicing,
typed-/loc marker), class-combo inference with user corrections, proc
analytics (PPM + state attribution), raid targets, buffs simulation, alerts
with sounds + rank-upgrade intelligence, a Details-style DPS meter with
drill-down/timeline (drilled by default, pet nested), floating overlay
meters, an EXALTATIONS tab (the Exaltation/BiS planner — labelled Exaltations
since JOS-42; the `planner` view id, route, store keys and `planner-*`
testids are unchanged — docs/plans/exaltation-planner.md), celebration toasts
(docs/plans/celebration-toasts.md), and a TIMERS tab + overlay (JOS-194 —
law 13 below). Committed knowledge DBs: mobs (7.9k), items (11.2k incl.
dropsfrom + eraTag), spells (1.9k), classes, zones (era-annotated), wiki
respawn floors (507 rows, 394 readable). First stable release v0.2.0
(2026-08-03); per-release history lives in `shared/releaseNotes.ts` and the
archive. Layout: `src/main` (Node), `src/preload`, `src/renderer`,
`src/shared`, `tests/`, `scripts/`.

## The six pet-voiced SAYS carve-out, at full length (JOS-47)

<!-- Moved verbatim from AGENTS.md (lines 155-162 at the 2026-08-13 collapse). -->

  **CARVE-OUT: the six pet-voiced SAYS** (JOS-47) — the six exact sentences
  in `shared/logScrub.ts PET_SAY_LINES`, matched as EXACT SENTENCES, never as
  a `/Master/` pattern (the enumerating sweep found six kinds of mob flavor a
  loose pattern would leak). Same argument as the tell: an NPC's words under
  an NPC's name. They prove the speaker is somebody's pet — NOT that it is
  YOURS (JOS-49 deleted the offer that paired them with a shared target). The
  carve-out STAYS: every combat fixture is already cut through it and the six
  still parse into `petSay`. Full argument: docs/agents-archive.md.

## The feedback triage loop bullet, as it stood

<!-- Moved verbatim from AGENTS.md (lines 268-272 at the 2026-08-13 collapse). -->

- **Feedback triage loop** (proven 2026-08-05, three same-day turnarounds):
  report → integrator diagnoses against the REAL log/slice FIRST (the brief's
  diagnosis was WRONG twice; the executor's evidence overruled it; a slice
  may prove more than the prose) → wave → stamp `triaged` with an honest note
  via `triage-feedback set`. Stories: docs/agents-archive.md.

## The delta-and-rebuild transport, at full length (JOS-172)

<!-- Moved verbatim from AGENTS.md (lines 466-480 at the 2026-08-13 collapse). -->

- **A WINDOW THAT FOLDS A MODULE NEEDS BOTH HALVES OF THE TRANSPORT — THE DELTAS
  AND THE REBUILD** (JOS-172). `module:delta` is an INCREMENT and a
  historical fold emits none (`endReplay()` DISCARDS — JOS-60's rule, and it
  stays), so "hydrate once, then ride deltas" is only complete if something
  says *ask again*. An overlay already open at launch hydrated mid-fold and
  then rode increments describing none of it. `sendWorldRebuilt`
  (pipeline.ts) is the ONE answer to "who is told the world was rebuilt" —
  the main window and `MODULE_READING_OVERLAYS`; every `IPC.onCharacter` send
  goes through it. The fix is the DELIVERY, never the discard. **And
  re-hydration is a SECOND reason a row can vanish**: anything watching a row
  set for removals is told which kind of change it sees (`timerDrops` takes a
  `rebuilt` flag and says nothing across a re-fold). Measuring this in e2e
  needs a SLOW fold — `tests/e2e/buffRestartSteps.mts` pads the log with 400k
  real lines and CHECKS the fold was still running. Full story:
  docs/agents-archive.md.

## Never seed a fold with its own output, at full length (JOS-231)

<!-- Moved verbatim from AGENTS.md (lines 873-889 at the 2026-08-13 collapse). -->

**A FOLD MUST NEVER BE SEEDED WITH WHAT IT IS ABOUT TO RE-DERIVE, AND THE ONLY
HONEST WAY TO KNOW IS TO FILE EVERY COUNT UNDER ITS SOURCE** (JOS-231). The
message overlay re-mines the whole log every launch; seeding it from its own
persisted served view double-counted every cold launch (22 → 44 → 88,
measured — verdicts drifting toward "how many times the app has started").
`MessageOverlayMiner` keeps ONE BUCKET PER SOURCE (`BASELINE_SOURCE` for the
committed baseline), `beginSource(key)` DISCARDS a bucket before its log is
folded again, `build()` sums the buckets — a re-fold REPLACES its source's
contribution; idempotence is structural. The persisted file is v2, a
REGISTER with no verdicts (a stored verdict is a second opinion waiting to
disagree with the derived one); v1 files are ignored, retiring the inflation
in the field. The fix deliberately KEEPS the persisted seed (a bucket for a
character you are not folding is knowledge nothing can re-derive, and
`effectiveSpellDb` derives parser corrections from the seed BEFORE the fold)
and does not dedupe by log position.
`tests/messageOverlayIdempotence.test.mts` pins it all, with a tripwire that
re-creates the old shape and watches the counts double.

## The pet tell binding bullet, at full length (JOS-47, JOS-49)

<!-- Moved verbatim from AGENTS.md (lines 1002-1011 at the 2026-08-13 collapse). -->

  - The owner-only tell `<Name> told you, '… Master.'` — **THE TELL ONLY
    FIRES WHEN THE PET IS ORDERED** (JOS-47); a pet engaging on its own
    aggro emits nothing private at all. **THE TELL IS THE WHOLE STORY, AND
    THE BLIND SPOT IS ACCEPTED** (owner, JOS-49): the ask-the-user offer and
    the pet-say nomination rung are DELETED — the answer to "the meter
    doesn't show my pet" is to order it once; an unordered pet is a
    documented, accepted non-distinguishable (law 6). **A TELL BINDS
    FORWARD, NOT BACKWARD** — nothing reaches back over damage already filed
    as nobody's; losing the deleted claim's retroactive path is the real
    cost of the cut.

## The permanent image cache, at full length

<!-- Moved verbatim from AGENTS.md (lines 1186-1204 at the 2026-08-13 collapse). -->

- **Downloaded images are cached PERMANENTLY** (`src/main/imageCache.ts`): no
  image the app fetches may ever be fetched twice — and since JOS-198 a
  normal install fetches NONE. Item icons serve from `eqimg://item/<id>` (a
  `protocol.handle` on the DEFAULT session — one handler covers every
  window); a miss is ONE polite fetch (shared UA, in-flight dedupe), written
  ATOMICALLY and only if the bytes sniff as an image. NEGATIVES ARE NEVER
  CACHED **ON DISK** — but a refusal IS remembered IN MEMORY for the
  session, and only when the HOST SPOKE; a NETWORK failure is DELIBERATELY
  NOT remembered (a just-woken laptop must not be locked out of every icon).
  On disk: no TTL, no eviction — wiki file ids are immutable. A second
  route, `eqimg://url/<encoded>`, covers absolute URLs (the boss portraits;
  wrapping happens at render via `cachedImageUrl()`); its boundary is a
  STRICT host allowlist — exact `new URL().hostname` equality, https only;
  never substring/endsWith (`wiki.project1999.com.evil.com` must fail).
  Entry name = `url-<sha256[0:24]>.<sniffed ext>` (the URL lies about
  extensions). **`img-src` does NOT list `https:`** (exactly
  `'self' data: eqimg:`): that is what makes "every downloaded image is
  cached" structurally true — widening the CSP is never the fix; wrap the
  URL through the `url` route. Full story: docs/agents-archive.md.

## The growing-list layout bug, at full length

<!-- Moved verbatim from AGENTS.md (lines 1298-1304 at the 2026-08-13 collapse). -->

- **A growing list lives in a FIXED-height scroll box.** The combat log was
  `flex: 0 0 auto` + `minHeight`, so it sized to its 150-line content, couldn't
  shrink, and squeezed the whole dashboard to 0px (the tab read as "just a
  scrolling combat log"; the app's content area is `overflow:auto`, so
  `height:100%` clamps nothing). Any append-only panel gets an explicit height +
  its own `overflow:auto`; the panel that must survive gets `flexGrow:1` +
  `minHeight:0`. Verified by the headless e2e harness, which measures it.

## Migration 1-to-2's salvage detail, at full length

<!-- Moved verbatim from AGENTS.md (lines 1539-1543 at the 2026-08-13 collapse). -->

- Migration 1→2 is REAL work, not a dormant no-op: it also recovers the
  top-level `progress` blob that commit 41831cc orphaned when it re-keyed
  progress by character (salvaged under the reserved id
  `legacy:pre-character` only when no real character exists — never guess an
  owner) and drops the dead `liveLoot` map.

## Windows Sandbox tier 2, at full length

<!-- Moved verbatim from AGENTS.md (lines 1566-1584 at the 2026-08-13 collapse). -->

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
   machine-wide), refuses to boot without a CURRENT Setup exe, parks the VM
   window off the primary monitor without stealing focus (the user games on
   the primary — keep it clear), force-kills the client when the results
   land, and exits 0/1. Harness invariants: ASCII-only (the guest's PS 5.1
   reads a BOM-less .ps1 as ANSI), always writes a verdict from a `finally`,
   and POLLS after uninstall instead of trusting `Start-Process -Wait`.
   Requires the `Containers-DisposableClientVM` feature (if
   `WindowsSandbox.exe` is missing while DISM says Enabled, disable +
   re-enable elevated and reboot). Full detail: docs/agents-archive.md.

## The post-release smoke test, at full length

<!-- Moved verbatim from AGENTS.md (lines 1593-1607 at the 2026-08-13 collapse). -->

### Post-release feedback smoke test (`npm run smoke:release`)

ON-DEMAND ONLY — not in CI, not in `npm test`, not in `test:e2e`. Run once
after a release publishes: a sandbox DOWNLOADS the published installer
(verified against the release's `SHA256SUMS.txt`), plants a mocked EQ log,
launches the installed app with `EQ_SMOKE_FEEDBACK=<nonce>`, and
`src/main/smokeFeedback.ts` files ONE real bug report through the ordinary
`submitFeedback` path (every normal layer, NO endpoint override, refused
under `EQ_E2E`). The host half reads the LIVE backlog (`triage/store.ts`,
profile `eqc`) and asserts the row, the slice upgrading to `present`, and —
the point — that the slice CONTAINS the run's nonce and does NOT contain
`CHAT_MARKER`: the scrub proof, measured on the bytes that made the round
trip. A pass cleans up; a failure leaves evidence; a `closed` answer is its
OWN verdict (kill switch on, plumbing proven). Reuses the tier-2 lifecycle
via `scripts/sandbox/sandbox-lifecycle.ps1`.

## The overlay catalog bullet, at full length

<!-- Moved verbatim from AGENTS.md (lines 1608-1624 at the 2026-08-13 collapse). -->

- Overlay: Electron suffices for windowed/borderless EQ; exclusive
  fullscreen cannot be overlaid by anything (native-helper escape hatch:
  feed it the same snapshot IPC). ONE overlay.html bundle, kind read from
  `?kind=`; each kind has its own persisted config (`store overlays.<kind>`)
  and can run simultaneously; all overlay IPC channels take the kind as
  first arg (`onOverlayState` payload is `{kind, open}`). Interactive mode
  adds a dense selector + a mini drill-down; locked mode stays fully
  click-through but RENDERS the persisted drill read-only
  (`overlays.<kind>.drill` — config IS the drill state, no renderer mirror;
  stale ids render level 1 without clearing). EIGHT kinds: fight/overall
  (damage), heal-fight/heal-overall, events, buffs + debuffs (JOS-89, split
  by JOS-119 — below), and toast (celebration cards —
  docs/plans/celebration-toasts.md; queue reducer in overlay/toastQueue.ts,
  producers in App.tsx, payloads resolved in main/toast.ts). The toast is
  the ONE kind that defaults OPEN (owner, 2026-08-05; schema v9 corrects
  stores written at the old default) and has NO SOUND of its own — the
  seeded boss/quest ALERTS speak on the same events.

## Analytics operations, at full length

<!-- Moved verbatim from AGENTS.md (lines 1772-1798 at the 2026-08-13 collapse). -->

- **ANALYTICS OPERATIONS (how usage questions get answered):**
  - Daily/adoption truth: `triage-feedback analytics digest --days N
    --profile eqc` (user cohort by default; `--cohort all` prints both,
    NEVER summed). Series history STARTS 2026-08-04 — there is no earlier
    data and never will be.
  - Live concurrency: CloudWatch `EQCompanion/Telemetry` `Heartbeats`,
    `Channel=prod`, **Sum over 600s** ≈ concurrent sessions (channel-split,
    not cohort-split — EMF dimension identity would orphan every widget).
    **THE PERIOD IS THE CLIENT'S HEARTBEAT CADENCE, NOT A CHOICE** (JOS-269
    took it 5 min → 10 min, so 300s was right until 2026-08-12 and halves the
    answer now). `liveSessions.ts BUCKET_MS` is the same number and the two
    move together or the readout silently lies.
  - Install truth is `analytics_install`; GitHub `download_count` is NOT
    installs (the auto-updater dominates it). DAU can slightly exceed
    installs across UTC day boundaries — artifact, not phantom users.
  - The kill switch is cached in warm Lambdas for 60s — a 503 right after
    `analytics open` is the cache, not a failure.
  - **THE PULSE'S LIVE HALF IS A CLOUDWATCH READ, NOT A COUNTER** (JOS-39):
    `liveSessions.ts` reads `Heartbeats` directly, merged at the two
    presentation edges — never inside `buildAnalytics`, which stays pure.
    The average age is labelled `est.`, can only under-claim, and is NULL —
    never 0 — when nobody is alive.
  - **`upgrades` IS DERIVED SERVER-SIDE**, from the stored `app_version`
    read BEFORE the install UPSERT; once per version change; downgrades
    count; disjoint from `newInstalls`.
  - Pre-marking counter rows carry no id and stay in the user cohort
    forever — read old days with that in mind.

## The local dev feedback server bullet, as it stood

<!-- Moved verbatim from AGENTS.md (lines 1799-1803 at the 2026-08-13 collapse). -->

- **Local dev story**: `scripts/dev-feedback-server.mts` (wave in flight
  at write time) — same contract, same shared validator, failure knobs;
  the app reaches it via `EQ_FEEDBACK_URL`, honored ONLY behind
  `!app.isPackaged` (the lawful exception to the no-override rule —
  packaged builds must prove the env var does nothing).

## The telemetry cadence dial, at full length (JOS-269)

<!-- Moved verbatim from AGENTS.md (lines 1816-1829 at the 2026-08-13 collapse). -->

  **THE CADENCE IS A COST DIAL, THE CONTENT IS NOT (JOS-269, owner ruling
  2026-08-12).** `FLUSH_INTERVAL_MS` 5 min and `HEARTBEAT_INTERVAL_MS` 10 min
  (flush.ts) — was 60 s / 5 min, and the plan's T5 still says the old numbers
  because plans are historical intent. Every event is a counter delta that
  sums server-side, so batching harder loses NOTHING; every flush is one
  request through API Gateway + Lambda + DSQL, which is the whole bill. What it
  does cost is stated where it happens: a KILLED session's duration is only
  known to its last heartbeat, so the tail of that histogram coarsens from
  5 min to 10. **THREE NUMBERS ARE DERIVED FROM THESE AND MUST MOVE WITH
  THEM**: `liveSessions.ts BUCKET_MS` (= the heartbeat, or Live now halves),
  the "sessions in the last 10 min" tile note, and the sandbox smoke's
  `$telemetryDwellSec` (must exceed ONE flush tick — nothing leaves the machine
  except on one; `stopTelemetry` writes the ring, it does not POST). Changing
  WHAT is collected is a different decision and remains owner law.

## The e2e committed-fixture harness bullet, at full length (JOS-29)

<!-- Moved verbatim from AGENTS.md (lines 190-201 at the 2026-08-13 collapse). -->

- **THE E2E INPUT IS A COMMITTED FIXTURE, AND THE HARNESS PLAYS THE LIVE HALF**
  (JOS-29, wave E2 — docs/plans/e2e-parallel.md). `tests/e2e/logFixture.mts`
  stages a throwaway EQ install per launch and hands it over with
  `EQ_INSTALL_DIR` — the product knows nothing about it. Cut fixtures with
  `npm run fixtures:e2e` (through the shared scrub, like every extractor).
  Because the harness OWNS the copy it can PLAY: `appendAt()` writes
  EQ-stamped lines into the tailed file and they travel the real path
  (chokidar → Tailer → parser → engine → IPC → render);
  `tests/e2e/gameplay.mts` scripts a pull whose damage this repo STATES, so
  assertions are EXACT (`outTotal === 442`). Map PACKS stay a game install
  (junctioned in). Frozen numbers still rot for anything the fixture does not
  fix.

## The parallel e2e runner sub-bullet, at full length (wave E1)

<!-- Moved verbatim from AGENTS.md (lines 249-258 at the 2026-08-13 collapse). -->

  - **e2e runs PARALLEL and from a worktree** (wave E1,
    docs/plans/e2e-parallel.md). The isolation unit is ONE LAUNCH — a
    `mkdtempSync` userData dir per `launchApp()`, artifacts under
    `artifacts/<runId>/<spec>/` — so the old single-flight law is retired.
    The runner discovers `*.e2e.mts`, takes a name filter
    (`npm run test:e2e -- leveling`), caps each spec at 5 min, writes
    `artifacts/<runId>/summary.json`; `--serial` remains for debugging.
    `node_modules` is resolved, not joined, so a worktree with no install
    runs the suite. Measured runs (13/13 twice at ~150 s; serial was
    ~28 min) + the `hoverAt` fix: docs/agents-archive.md.

## Keep the tree buildable, at full length

<!-- Moved verbatim from AGENTS.md (lines 284-291 at the 2026-08-13 collapse). -->

- **KEEP THE TREE BUILDABLE (user rule, 2026-08-03): the dev app must not
  stay down.** Transient seconds-long HMR breakage is fine; MINUTES is not.
  Concretely: create any file you import (even an empty stub) BEFORE writing
  the import — a scrape/codegen that produces a data file the code needs gets
  a stub first and overwrites it when done (this exact miss took the app down
  for the length of a mob-page crawl); sequence multi-file changes so
  `npm run dev` keeps compiling between edits; if you must break main's build,
  fix it in your very next edit, not at wave end.

## The lint layers and measured thresholds, at full length

<!-- Moved verbatim from AGENTS.md (lines 396-407 at the 2026-08-13 collapse). -->

- **Two layers.** Correctness: typescript-eslint `strictTypeChecked` +
  `stylisticTypeChecked`, type-aware through TS's project service (which resolves
  every file through the same two tsconfigs `npm run typecheck` builds — lint and
  typecheck can never see different file sets), plus react-hooks for the
  renderer. Factoring: `complexity 12`, `max-depth 3`, `max-lines 400`,
  `max-lines-per-function 100`, `max-params 4` (line counts skip blanks AND
  comments — this repo comments heavily on purpose; the metric is code mass).
- **Those five numbers were MEASURED, not guessed.** `npm run lint:measure`
  re-runs ESLint with the rules pinned to `max: 0` and prints the
  distribution + a threshold sweep; each threshold sits between p95 and p99
  of the real tree. Never change one without re-running it — including
  `max-depth 3`, which the data chose over the obvious 4.

## The calm-line roster, at full length (JOS-213)

<!-- Moved verbatim from AGENTS.md (lines 1111-1125 at the 2026-08-13 collapse). -->

- **THE CALM LINE IS A ROSTER TOO — AND ROUTING OBEYS RULING 8 (JOS-213).**
  Calm spells are Beneficial, so their timer landed in the player's BUFF
  overlay — while the thing they watch is a mob-state timer. The fix is a
  SECOND, orthogonal fact about the SPELL (`ActiveBuff.calmsTarget`,
  `spellCalmsTarget`, derived from the three landing families and re-derived
  by an oracle every run, exactly like `ccSpell`); `cls` does NOT change.
  **THE CUT THAT FAILED IS THE LESSON**: routing on "the TARGET is a mob"
  reruns the error JOS-136/JOS-140 ruling 8 outlawed
  (`disposition: 'hostile'` means only "not you and not a pet I am currently
  holding") — two committed goldens rejected it on the spot. Nature — and now
  surface — comes from the spell, never from the shape of the target.
  Fixtures `w64`/`w65` (`npm run fixtures:calm`), pinned in
  `tests/calmLineTimers.test.mts`; a pacified mob CAN be killed and takes the
  ordinary decrement-one death censor, never JOS-228's mez refusal. Full
  story: docs/agents-archive.md.

## The sound-pack registry bullet, as it stood before JOS-273 superseded its pre-selection rule

<!-- Moved verbatim from AGENTS.md (lines 1187-1195 at the 2026-08-13 collapse). -->

- Sound packs: og-packs registry (peonping.github.io/registry) —
  browse/install ~350 packs in-app. The single shipped default
  (`alan-rickman`, pinned tag) is GITIGNORED audio, self-provisioned via the
  same installPack path (additive, retried with backoff). The synthesized
  `default` chime pack is DELETED; alerts pointing at any retired pack are
  rewritten onto the analogous alan-rickman line by a ONE-TIME,
  version-stamped store migration (`migrateAlertSounds`), so an upgrading
  user's alerts never go silently mute. Every picker pre-selects
  alan-rickman (`fallbackPack`), never `packs[0]`.

## The brief-sizing law's measured incident, at full length (JOS-343)

<!-- Moved verbatim from AGENTS.md (2026-08-27 distillation). -->

MEASURED, and why this is a law: the owner asked to swap a heart icon for a
labeled toggle (JOS-343) and the integrator's brief tripled it (both
surfaces, semantics change, six e2e claims revised, two full spec suites
re-run repeatedly) — 55 minutes and 225k tokens for what the owner correctly
called a pretty cosmetic change. The diagnosis found no stuck loop: every
token was "legitimate" under the brief as written, which is exactly the
problem — uniform maximal verification makes small changes cost like
features, and the e2e wall-clock (3-6 minutes per spec, run 2-4 times)
dominates everything on a small ticket. The one counterweight, stated so it
is not forgotten: that oversized verification did catch a real
wrong-direction-click bug (an ungated toggle on an unready store). The law is
calibration, not laxity — a targeted step would have caught the same bug on
the surface that had it.

## The dispatch-comment incidents, at full length (2026-08-13)

<!-- Moved verbatim from AGENTS.md (2026-08-27 distillation). -->

A dispatch comment written first turns into a standing lie the moment the
launch is skipped (it happened three times on 2026-08-13: JOS-287 and
JOS-297 caught in-session, JOS-296 caught by the OWNER after status reports
repeated "building" off nothing but the comment).

## The deleted audio-diagnostics tooling, at full length (JOS-442/JOS-443)

<!-- Moved verbatim from AGENTS.md (2026-08-27 distillation). -->

JOS-442 shipped one — `audioSessionNative.ts` reading the app's own WASAPI
session over a hand-walked COM vtable, an `audio:session` IPC channel, and a
Preferences Sound check card that printed the verdict. All of it is DELETED,
together with the shared verdict/readout module and the e2e spec that drove
it. The mechanism stays written down because it is how the owner will
recognise the failure himself; the app's answer to it is the Windows volume
mixer, not a card. The e2e-mute half, reported live: runs were audibly
playing alert tones on the owner's desktop; `--mute-audio` is a harness
argument rather than an `EQ_E2E` branch on purpose — the test mode must keep
changing as little about the product as possible.

## The pet-buff derived-claim seam's buying incident, at full length (JOS-454)

<!-- Moved verbatim from AGENTS.md (2026-08-27 distillation). -->

It was a state transition inside the engine — the arm is per-stream, so
`parseEvent` cannot emit it — and the AGENTS.md entry used to name the two
ways out and rule for the first: a derived-event seam feeding both models,
never a second arm. WHAT BOUGHT IT: the owner's summoned necro pet Vibartik,
bound in the engine at 13:42:43 by `Augment Death` and not by the
progression fold until his first tell at 14:37:53, whose four kills in that
gap read as `4 kills by others seen` on a Leveling panel sitting under a
meter that had him.

## The F2 live-verification detail, at full length (2026-08-04)

<!-- Moved verbatim from AGENTS.md (2026-08-27 distillation). -->

Live-verified: submit 201 + ULID, idempotent replay 200 same id, oversize
413; kill switch OPEN; the three constants filled in net.ts (api
pcy0z3xjp9… · bucket eqcompanion-logs-6c58f5cc · us-east-1).

## Wave-choreography commit specifics, at full length (2026-08-05)

<!-- Moved verbatim from AGENTS.md (2026-08-27 distillation). -->

A file carrying TWO waves' hunks lands with the LATER wave's commit + a
"completes <sha>" note (App.tsx with toasts+deep-links; windowControls with
fightSelection+levelUp). `git status --porcelain | grep '^[MADR] '` BEFORE
every commit — the index is shared and a sibling's staged deletion WILL ride
your commit (6db8790 swept one; its wave's later commit completed it).
