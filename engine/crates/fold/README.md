# fold — the module fold, in Rust (JOS-459 phase 2)

`eqlog` turns bytes into the canonical event stream. This crate consumes it: the `EqModule`
contract, a registry that preserves wiring order, and one ported module per file under
`src/modules/`. `src/lib.rs`'s header carries the design; this file is the **procedure** — how to
add a module and how to prove it.

## Where the clusters stand

`fold::WIRING_ORDER` is all twenty modules of `src/main/modules/wiring.ts`, in delivery order. What
this crate has registered is what `registered()` builds — which is now ALL TWENTY. Anything a build
does not register is still named by `Registry::missing()` and printed as SKIP on every parity run,
green ones included, because the report is about what was COMPARED and never about what exists.

| cluster | ticket | modules |
| --- | --- | --- |
| 2a | JOS-471 ✅ | `loot` `turnins` `classUnlocks` `kills` `leveling` `outputFiles` `spellSets` `itemTiers` `observedSpellRanks` |
| 2b | JOS-475 ✅ | `respawn` `progression` `character` `roster` `combo` |
| 2c | JOS-476 ✅ | `alerts` `buffs` `buffTimers` `consider` `resist` `eventFeed` |
| — | JOS-477 ✅ | **the combat engine** (`src/combat/`, whole) |

**PHASE 2 IS COMPLETE.** The DEFAULT `npm run oracle:rust-fold` is green: twenty modules plus the two
COMBAT sections, on all six slices, with no SKIP line anywhere.

THE TABLE WAS RE-CUT between JOS-471 and JOS-476: what the scaffold called 2c and 2d became one
ticket of six, because the three modules 2d held turned out to be the two cheapest in the whole
registry (`eventFeed` admits nothing historical; `consider` is a fifty-row ring) and the one —
`resist` — whose two published integers need the entire fold to be exact. Splitting the hard one
away from the hard one bought nothing.

The combat engine is not in `WIRING_ORDER` — it is not a module. It is the bus subscriber that sits
AFTER all twenty of them (`pipeline.ts:311,326`), and `Fold` carries it in its own `combat` field
for exactly that reason; `src/combat/mod.rs`'s header carries the submodule-vs-crate argument. Its
port is now WHOLE for everything the snapshot publishes, and its header lists what is absent — the
classification ring, the session mark and fight search — each of which is UNREACHABLE under the
construction the recorder makes rather than a piece left undone. The PET NUDGE left that list in
JOS-488 and is real code (`combat/petnudge.rs`): the snapshot-time sweeps landed with `set_live()`,
so the model can now be armed by a live tail, and its absence from every golden is caused by the
gate — `!hydrating` — rather than by the model not existing.

**THE REGISTRY IS PLUGGED IN** (JOS-478). `engined` builds it on its ingest thread — one
`ClusterDeps` assembled from the parser's own catalog and clock, in `engine/crates/engined/src/
foldsink.rs` — and serves one module's `{seq, state}` over the wire as `module.snapshot`, answered
through `Registry::snapshot_of`. Two consequences for anyone editing this crate:

* **A module's published state is now a wire shape**, and the protocol deliberately says nothing
  about it (`ModuleState` is "any JSON"). Both shapes this registry publishes are load-bearing —
  `kills` publishes an object, `loot`/`consider`/`eventFeed` publish arrays — and the app side reads
  them unchanged.
* **The spell catalog is `eqlog::spelldb::shared()`**, one `Arc` per process. `modules/resist/
  catalog.rs` used to `load()` a second whole database behind its lazy table; it reads the shared
  handle now. The tables it builds are unchanged and the six-slice gate proves it.

The constructor takes a `ClusterDeps` struct (JOS-475). Add a FIELD to it and a `register` line at
your module's `WIRING_ORDER` position; do not re-thread the call sites. The function itself has been
renamed twice — `cluster_2a`, then `cluster_2a_2b`, now `registered` — for the same reason each
time: a registry named after the tickets IN it is a registry a reader has to date.

## Adding a module (the recipe every cluster followed)

1. **Read the TS module's whole header first.** Every one of them carries an argument — a measured
   log span, an owner ruling, a quirk that looks like a bug and is not. Port the argument into the
   Rust file's header, in your own words, so a reader of this crate never has to open the other tree
   to know whether something is deliberate. Do not write "see `foo.ts`".
2. **`src/modules/<snake_name>.rs`**, one file per TS module. Implement `EqModule`:
   - `id()` returns the TS module's `id` **exactly** — it is the golden's join key.
   - `on_event` opens with `self.seq = ev.seq();`, like every TS `onEvent` does, and then matches on
     `ev.kind()`.
   - `snapshot()` returns `json!({ "seq": …, "state": … })`.
   - `flush_delta` stays defaulted. Deltas are phase 3; do not build the transport here.
3. **Register it in `registered()`** at its `WIRING_ORDER` position, and add whatever it needs from
   outside the log as a FIELD on `ClusterDeps`. The `registration_follows_the_wiring_order…` test
   fails if you slot it wrong, and the SKIP line shrinks by exactly the name you added.
4. **Reach for the existing ports before writing a helper.** `src/jsfn.rs` holds the shared TS
   functions (`zoneTier`, the item-name pair, `memoKey`, `baseName`, `parseSpellRank`),
   `eqlog::names` holds `idKey`/`spellCanonKey`, and `eqlog::jsstr` holds the JS-vs-Rust divergence
   catalogue — `JS_S` for `\s`, `JS_DOT` for `.`, `(?-u:\b)` for `\b`, `[0-9]` for `\d`,
   `js_trim` for `.trim()`. Never re-derive one of those; a second spelling is a second answer.
5. **Unit-test the module's own laws** in `src/lib.rs`'s `tests` module, driving hand-written NDJSON
   through `Fold`. `fold_lines` and `state_of` are there for it. A test per law the header states,
   named after the law.
6. **Prove it against the goldens** (below). Green is not "my tests pass"; green is the comparator
   over all six slices.

### The traps the two landed clusters actually hit

- **An absent field is ABSENT, never `null`.** The goldens were recorded through `JSON.stringify`,
  which drops a key whose value is `undefined`. Use `Option<T>` plus
  `#[serde(skip_serializing_if = "Option::is_none")]`. `eqlog` writes its own optional fields the
  same way (`s_opt`/`i_opt`), so `Event::str`/`Event::int` answering `None` is exactly the TS's
  `undefined` — the two ends already agree.
- **A JS `Map`'s iteration order is published wherever a snapshot turns it into an array.** Use
  `JsMap` (`src/jsmap.rs`), never a `HashMap`, when `values()` feeds a `Vec`. Object KEY order is
  free (the bar is deep equality); ARRAY order is not.
- **`camelCase`.** `#[serde(rename_all = "camelCase")]` on every published struct.
- **Derived events are not in the phase-1 goldens and you DO need them.** All three exist now:
  `epoch` (`src/epoch.rs`, 2a) because nine modules reset on it; `offlineGap` (`src/session.rs`,
  ported by 2b and 2c independently) because `progression` publishes every gap's instants verbatim
  in three columns, `roster` marks members stale across one, and `buffs` folds it to PAUSE every
  beneficial buff by the length of the absence; and `buffExpired` (2c), which `buffs` synthesizes
  WHILE FOLDING and hands back through `EqModule::take_derived`. All three stamp themselves with the
  current primary event's `seq`/`ts`, are queued into `Fold::derived`, and are drained through the
  same dispatch loop after the primary event — which is `LogBus.emit` exactly.
  **CHECK THE GOLDENS BEFORE BELIEVING A CLUSTER DOES NOT NEED ONE.** This bullet said "2c owes the
  other two" until JOS-475, which was true of cluster 2a and false of 2b — the argument for omitting
  a derived event (it stamps itself with the current primary event's `seq`/`ts`, so it can only move
  the `seq` every module carries over unchanged) only holds for modules that do not READ the event.
  Grep the TS module for the kind, then read the golden's own numbers: the six slices carry
  4 / 7 / 6 / 0 / 3 / 2 offline intervals and they are right there in `progression.offlineStart`.
- **A published `seq` is not always `ev.seq`.** FOUR modules publish a private REVISION counter
  (JOS-87): `combo`, `character` and `respawn`, each of which has a second input that advances no log
  seq, and `buffTimers`, whose `onTick` expires holds on an idle log. The goldens catch the last one
  outright — 0 on three of the six slices, and 6 / 106 / 145 on the others. Read the TS's
  `snapshot()` before assuming.
- **A JS `Map`'s iteration order can be published without appearing in the snapshot at all.** The
  buffs model's `active` map is sorted by `startedTs` before publication — but its ITERATION order
  decides which duration samples are pushed in which order and which `buffExpired` events leave the
  module, and both of those reach the golden by another route.

### The COMBAT engine (2d) — what it is, and the four traps its port actually hit

The engine is not a module and does not follow the recipe above — it is `src/combat/`, one file per
`src/main/combat/*.ts`, subscribed behind the registry. What it owed was stated by measurement
rather than by opinion: `--ledger` over all six slices, and the classes it printed WERE the worklist.
That worklist is now empty, and the ledger reads 100% on both sections of every slice. The regression
surface a later shift must not break is therefore the WHOLE of `combat` and `scopes`.

The order was argued at the outset and it held: `world.ts` (instance identity) → the attribution
ladder → the encounter lifecycle → the aggregate's accumulators → the view builders. Each stage
unblocked the next, and the last one landed everything that reads a counter without writing one:
`segmentViews` / `sourceViews` / `defenseViews` / `roundViews` / `healing` / `procViews`, plus the
four ingest-side ledgers they read (`rounds.rs`, `healing.rs`, `procdetect.rs`, `procwindows.rs`),
the active-state timeline, the blade coats and the per-fight timeline.

**THE FOUR TRAPS, because each one cost a debugging pass and each will recur:**

1. **A "PURE READ" THAT MUTATES.** `st.defenderLabel(...)` looks like serialization — its result goes
   to the timeline instant and the processing line — but it resolves through the world model, and
   `resolve()` retires stale instances and ADOPTS the sighting's casing as the instance display.
   `bumpTarget` freezes the label it is handed (first write wins), so skipping the call left
   25/71/2/1/53 FIGHT NAMES per slice sentence-capitalized. Before deciding a call is view-only,
   check what it MUTATES on the way to its return.
2. **AN `onRetire` CLOSURE RUST WILL NOT TAKE.** Retirement is ANNOUNCED on a queue that
   `EngineState` drains at every call site that can retire. Add a world call and you must drain after
   it, or a mez'd mob aged out by staleness goes on vetoing the death-close.
3. **TWO EVENTS THAT SPELL ONE FIELD DIFFERENTLY.** `buffApply.candidates` is an array of OBJECTS
   (the buffs module needs the duration); `buffWearOff.candidates` is an array of STRINGS. Reading
   the wrong accessor answers an EMPTY LIST rather than failing, so the wear-off gate simply never
   fired — and every tracked buff span stayed open to be superseded or censored later instead of
   ending `observed` where the game printed an end. It surfaced 234 span-edge divergences away, in
   `procs.states[].endTs`. When a curated gate produces nothing, check the SHAPE of what you handed
   it before you doubt the gate.
4. **`localeCompare` IS NOT ONE COMPARATOR.** `modules::buff_landing::compare_names` ignores spaces
   and punctuation, which is right for the spell names it ranks and WRONG for mob names: CLDR root
   is `alternate = non-ignorable`, so a SPACE outranks a letter and `a willowisp` sorts before
   `Asaka L`Rei`. `combat::collate` is the second spelling, and its header carries the measurement
   and the argument for why the first one was not changed instead.

**AND ONE ABSENCE THAT IS A PROOF, NOT A GAP.** Three TS files are deliberately unported — the
classification ring, the session mark (`mergeSessions.ts`) and `fightSearch.ts` — and each is
UNREACHABLE under the construction `foldArm.mts` makes rather than a piece left undone.
`combat/mod.rs`'s header states each one with the golden field that agrees.

**A PROOF IS ABOUT A CONSTRUCTION, SO IT EXPIRES WHEN THE CONSTRUCTION GAINS A CALLER**, and JOS-488
is the worked example: `set_live()` had none, which is what made "the pet nudge can never arm" a
proof and "the sweep block is never entered" a fact about every path. The engine's go-live beat gave
it one. The nudge became code, the sweeps became reachable, and the classification ring — the same
argument, one flag over — turned from a proof into a NAMED GAP for a live engine while staying a
proof for the oracle. When you retire an absence, say which of the two it was.

### Two rules that are not style

- **No module reads a wall clock, ever** (cache transparency, ruling 18). A time-based rule advances
  off log timestamps during a fold; the wall clock is HANDED in through exactly one door, `Fold::tick`,
  which a LIVE tail drives ~1×/sec (owner ruling 22, JOS-481) and which `fold_bytes` — the historical
  path, and the only one the oracle records through — never calls. So the equivalence law is
  untouched, and `oracle:rust-fold` staying green at its default is the proof of that. The
  `respawn` module (2b) seeds an ordering clock from `Date.now()` at `reset()`, and the golden was
  recorded under a PINNED construction clock (`WorldOpts.constructionNowMs`, taken from the last
  timestamped LINE of the slice). Whoever ports it must take that instant as a parameter, from the
  same place, or the golden will not re-check tomorrow.
- **Never fix a golden.** If a divergence class looks like a TS-side bug, STOP and report it. The
  goldens are the definition of the bar, not a suggestion.

## Proving it

```
npm run oracle:rust-fold -- [slice...] [--snapshots=<module,module>] [--ledger] [--no-build]
                            [--keep-going] [--slices=<dir>] [--goldens=<dir>] [--tz=<zone>]
```

`--snapshots=<list>` accepts the two COMBAT sections by name as well — `--snapshots=combat,scopes`
narrows a run to the engine, and `--snapshots=kills` narrows it away from one.

`--ledger` swaps the first-divergence report for a full walk that buckets every disagreement by
class (`.combat.segments[].total`, indices erased), prints the count per class with one worked
example, and states the agreement rate. It exists because the combat engine will be red for several
shifts and "it diverged at `.combat.selected`" is equally true on the first shift and the fifth.
**It is not a second bar and it cannot turn a red run green** — the exit code is still decided by
whether anything diverged at all (`tests/bench/parityLedger.mts` carries the argument).

The slices and goldens are gitignored and machine-local, so a **worktree** run needs the two
directory flags pointing at the main checkout, plus `--tz` matching the zone the goldens were
recorded in (`goldens/manifest.json` records it):

```
npm run oracle:rust-fold -- --keep-going \
  --slices=C:\Users\jmoye\everquest-companion\tests\bench\fixtures\slices \
  --goldens=C:\Users\jmoye\everquest-companion\tests\bench\fixtures\goldens \
  --tz=America/Los_Angeles
```

It prints PASS per module per slice, the first divergence (dotted path, both values, truncated) for
each failure, and a SKIP line naming every module not compared — on green runs too, because "fifteen
of twenty agreed" and "the fold agrees" are different sentences. **On a DEFAULT run there is no SKIP
line at all now**, which is the sentence phase 2 was for: twenty-two sections compared, nothing
excused.

**Check the harness still bites** after changing it. Two one-line faults are enough: bump
`KILLS_SHAPE_VERSION` and change `SETTLE_MS`, rebuild, run one slice, and confirm you get
`FAIL kills at .state.v` and a `FAIL spellSets at .state.sets.<name>.observedAt`. Then revert.

**AND INJECT ONE INTO EACH MODULE YOU ADDED, ON A SLICE THAT EXERCISES IT.** A fault that does not
bite proves nothing about the comparator and everything about the slice you picked: `patch-week`
carries no `group` line and no `level` line, so a roster fault and a character fault both PASS there
while biting on `current` and `hate-pets`. The 2b run that was accepted: `.state.v` (respawn),
`.state.recentKills.length` (progression), `.state.intervals[0].slots[0].confidence` (combo),
`.state.lastSignalTs` (roster) and `.state.level.source` (character), across three slices.

**Aim it at the number your module actually publishes**, and check that it MOVED. JOS-476 ran four
injections and only two bit: `RECENT_SAMPLE_WINDOW` 5→4 (`FAIL buffs at
.state.stats.<line>.estimateMs`) and an extra `rev += 1` in `buffTimers`' `end()` (`FAIL buffTimers
at .seq`). The other two — `WAKE_CENSOR_MS` 1 s→2 s and `CC_END_MEMORY_MS` 60 s→30 s — are INERT on
all six slices, because nothing in this corpus exercises either constant in a way that reaches a
published field. An inert injection is a fact about the CORPUS, not a pass, and it is worth writing
down rather than mistaking for one.

**THE JOS-477 RUN, one per file the final stage added, all on `mid-grind` unless named otherwise:**

| injection | what moved |
| --- | --- |
| `rounds.rs` multi-round threshold 2 → 3 | `.roundStats.lanes[].multiRounds` / `multiPct` |
| `aggregate.rs` `tally_modifiers` count += 2 | `.roundStats.modifiers[].count`, `ripostesGiven`, `incomingHealers[].count` |
| `views.rs` `SKILL_CAP` 12 → 11 | `.entities[].skills.length` |
| `healing.rs` `SPELL_CAP` 14 → 1 | `.healing.healers[].spells.length` (267 scopes) |
| `procdetect.rs` cast window 12 s → 11 s | `.procs.lanes[].count`, `.procs.overall.count` and every rate |
| `procwindows.rs` `MIN_ARM_WINDOWS` 20 → 21 | `.procs.attribution.effects[].note` |
| `statetimeline.rs` `STATE_SPAN_CAP` 2000 → 40 | `.procs.states.length` / `startTs` / `endTs` |
| `procrouting.rs` stance switch += 2 | `.procs.stanceSwitches` |
| `procviews.rs` `strikeCount` = lane count | `.procs.strikeCount` |
| `encounter.rs` `TIMELINE_BUDGET` 2000 → 10 | `.timeline.events.length` / `downsampled` (all six) |

`collate.rs` needs no injection: the `hate-pets` golden is what FORCED it, and reverting it turns
that slice red on `.healing.enemyHealers[].id`. `poisons.rs` is the same — it is what closed the
`.poison.slow.*` class on `mid-grind`.

**TWO INERT INJECTIONS, reported as facts about the corpus rather than counted as passes.**
`SPELL_CAP` 14 → **13** does not bite: no healer on `mid-grind` carries more than thirteen heal
lanes, so the cap never engages and the run is GREEN. `TIMELINE_BUDGET` 2000 → **1000** does not bite
either: the selected fight on every slice holds fewer than a thousand instants, so the stride stays 1.
Both only bit once pushed past what the corpus actually contains (1 and 10).

House rules for the whole crate: `cargo fmt --all`, `cargo clippy --workspace --all-targets -- -D
warnings`, `cargo test -p fold`, and the Node side's `npm run typecheck && npm run lint && npm test`.
Heavy runs go at BelowNormal — the harness sets it on itself and the Rust child inherits it.
