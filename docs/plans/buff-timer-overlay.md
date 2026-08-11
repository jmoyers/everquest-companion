# Buffs / Timer overlay (JOS-89; split into two windows by JOS-119)

**Status**: built, default OFF, for internal validation before promotion.
**Amended (JOS-119, 2026-08-08)**: what shipped as ONE window is now TWO — `'buffs'` and
`'debuffs'` — each with its own open/locked/bounds config, its own window and its own chrome, so
they can be enabled and positioned separately. Everything below still describes the model, the
honesty law and the projection unchanged: the split is a FILTER over the rows §2.3 builds, not a
second model. See §2.4a for what the second window changed and what it deliberately did not.
**Owner direction (2026-08-08)**: build it now, ship it off, use it internally first to
validate correctness. The buff-system rework the owner paused earlier is *not* reopened by
this ticket — this overlay is built strictly on what the tracking can honestly claim today.

Ten user reports converge here; it is the loudest demand in the product's history. What they
asked for, in their words and in aggregate:

- per-target debuff timers on the current target
- CC/mez tracking across MULTIPLE targets — chain-mez four or five enemies and see a named
  countdown per enemy
- self-buff bars with receding timers
- a flash/alert when a positive spell drops
- mez tracking during an encounter

---

## 0. THE HONESTY LAW IS THE DESIGN

One rule decides every pixel on this surface:

> **A duration `spells.json` STATES becomes a receding countdown. A duration nobody states
> becomes ELAPSED time counting UP. There is no third case, and an invented "remaining" is
> never displayed.**

The corollaries, each of which is a real branch in the code:

1. **A mined estimate is not a stated duration.** The buffs model already computes an
   `estimatedMs` for spells the DB does not know, from the recency-weighted MAX of the
   player's own observed land→fade samples (`buffsStats.ts estimateFor`, tagged
   `durationSource: 'observed'`). The Buffs *tab* renders that as a countdown. **This overlay
   does not.** A sample can be censored by a zone, an offline gap, a death, or a fade the log
   never printed; the model itself calls it an estimate. Counting down from an estimate is
   exactly the "invented remaining" this ticket forbids. `durationSource === 'db'` ⇒
   countdown. Anything else ⇒ count up. That divergence from the Buffs tab is deliberate and
   is the ticket's whole point.
2. **A shared landing sentence names a FAMILY, not a spell** (JOS-84). When the sentence
   could be several spells and nothing narrowed it, the row prints the candidate list and is
   flagged ambiguous; when the candidates disagree about duration, there is no duration to
   state, so it counts up.
3. **Fades observed in the log clear the entry.** A break line clears its target's entry the
   instant it prints. Nothing is removed on a guess.
4. **A countdown that runs out is not a removal.** It renders at zero and stays until the log
   says otherwise, because "the DB's number elapsed" is not evidence the buff is gone.

---

## 1. What the tracking KNOWS today

### 1.1 The events (all from `src/main/log/parseCasts.ts`, cascade order in `parser.ts`)

| line shape | event | carries |
|---|---|---|
| `You begin casting <S>.` / `You begin singing <S>.` | `castBegin` | `spell` |
| `Your <S> spell fizzles!` / `is interrupted.` | `castFizzle` / `castInterrupted` | `spell` |
| a DB `msg_cast_on_you` match | `buffApply` | `target:'self'`, `spell` (first candidate), `durationMs`, `illusion`, **`candidates[]`** |
| a DB `msg_cast_on_other` SUFFIX match | `buffApply` | `target` = the named entity, same fields |
| a DB `msg_wears_off` match | `buffWearOff` | `target:'self'`, `spell` (first candidate), **`candidates[]`** |
| `Your <S> spell has worn off.` / `Your pet's <S> spell has worn off.` | `buffFade` | `spell`, `target?:'pet'` |
| `Your <S> spell has worn off of <mob>.` | routed by SPELL NAME in `rulesets.ts` | `charmSpell` ⇒ `uncharm{mob}`; `ccSpell` ⇒ `cc{mob, spell, refresh:true}`; neither ⇒ `buffFade{spell, target:mob}` |
| `<mob> has been mesmerized\|enthralled\|entranced\|ensnared.` | `cc` | **`mob` and nothing else** — no spell, no caster |
| `<mob> has been charmed.` | `charm` | `mob` |
| `You have been slain by <k>!` / `You died.` | `playerDeath` | `killer?` |
| `<mob> has been slain by <k>!` / `You have slain <mob>!` | `death` | `name`, `bySelf`, `killer?` |
| `You activate <X>.` | `aaActivate` | `name` (Quick Buff is the one that matters) |
| `Your illusion fades.` | `illusionFade` | the shared remover for all 27 illusions |

### 1.2 What the buffs MODEL does with them (`src/main/modules/buffs.ts` + friends)

- A buff is an INSTANCE keyed `(spellKey, entityKey)` — world-model law 4. `ActiveBuff` carries
  `spell, cls, self, target?, inferredTarget?, startedTs, estimatedMs, durationSource?, permanent?,
  provisional?, messageDriven?, n, p25, p75`.
- **Own-cast gating is absolute.** `onBuffApply` drops any apply it cannot attribute to the
  player's own `castBegin` within 10 s or to a Quick Buff burst within 5 s. A stranger's buff
  landing on a mob near you is never tracked. The overlay inherits this for free, and applies
  the same gate to CC (§2.2).
- **Ambiguity resolves by evidence or not at all.** `resolveCandidate` picks the candidate the
  player most recently cast; failing that, one that is already active; failing that it returns
  `null` and the apply is DROPPED. So no `ActiveBuff` row is ever a coin flip — which is why
  the buff half of this overlay does not need to re-do JOS-84's work.
- `playerDeath` ⇒ `BuffInstances.onPlayerDeath()` deletes every SELF active and censors open
  self casts (JOS-88, `tests/deathClearsBuffs.test.mts`). Pet/mob instances survive, correctly.
- Mob `death`, `zone`, a 30-minute `SESSION_GAP_MS`, a character `epoch`, charm/pet succession
  and a 90-minute hygiene cap all censor instances by the rules law 4 sets out.
- `onOfflineGap` SHIFTS `startedTs` forward by the absence (EQ pauses buff timers while you are
  camped — measured). **`startedTs` is therefore not a wall clock and must never be printed as
  one.** Elapsed and remaining are the only honest readings.

### 1.3 What `spells.json` states about durations (measured, 2026-08-08)

`src/main/data/spells.json`, 1,926 entries scraped from eqlwiki `Template:Spellpage`, bundled
into the main chunk (never read from disk).

- **`durationMs` is non-null for 878 of 1,926 — 45.6%.** Beneficial: 452 of 1,079. Detrimental:
  355 of 713.
- `durationText` is present for 1,923; 1,045 of those do not parse to a number, across 23
  distinct texts — `Instant`, `Permanent`, `Unlimited`, `Instant (until zoning/recast)`, and a
  batch of clock forms the scraper's grammar misses (`2:24:00 (3:36:00)`, `0:30`, `18s`,
  `1m 36s`, `2h 24m`).
- **LEVEL DEPENDENCE IS COLLAPSED, NOT MODELLED.** `durationText` frequently states a formula
  (`1 ticks @L1 to 2 minutes @L40`, `4.4 minutes @L44 to 6.0 minutes @L60`). `scripts/scrape-spells.ts
  parseDurationMs` takes the MAX component per an earlier owner directive. So a stated
  `durationMs` is the duration **at the top of the level band**, and for a low-level caster it
  over-states. This is the single largest known inaccuracy in the countdown and it is recorded
  here rather than papered over.
- **FOCUS EFFECTS ARE NOT IN THE DATA AT ALL.** Extended-duration focus items lengthen real
  buffs and nothing in `spells.json` knows about them, so a stated countdown can also
  UNDER-state. Again: recorded, not modelled.
- `targetType` is wiki text describing a different server and is not trusted for anything
  (AGENTS.md already records `Symbol of Pinzarn` landing on three entities while the DB calls
  it "Single Friendly (or Self)").
- Ranks: only 42 of 1,926 spells form a multi-rank family and there are no per-rank duration
  rows. The log casts `Mesmerization III` where the DB has `Mesmerization`; `spellCanonKey`
  strips the rank at every key boundary (world-model law 2).

### 1.4 What is UNKNOWABLE

- **Whether a mez broke early.** `alertGroups.ts` already states it: the game prints the same
  `Your <S> spell has worn off of <mob>.` whether the mez ran its full course or a nuke broke
  it two seconds in. Measured in the fixture: `Mesmerization` on `a scareling` printed its
  worn-off line **2 seconds** after landing, and on `a turmoil toad` **18 seconds** after — the
  same sentence, from the same 24 s-stated cast. So: "it ended", never "it broke early".
- **A mez broken with no line at all.** If the mob dies or the break prints nothing, the entry
  sits at zero until a death/zone/hygiene bound removes it.
- **Who cast a `cc` broadcast.** `<mob> has been mesmerized.` names no caster. The engine
  already solved this once (`combat/charmModel.ts ccBroadcast`) by requiring the broadcast to
  resolve one of the owner's own CC casts; this overlay takes the same position (§2.2).
- **Self-buff fades other than the wears-off emote** (world-model law 6). There is no
  "buff X removed" line.
- **Remaining time for the 54% of spells the DB has no duration for.** Hence count-up.

### 1.5 The gap this ticket found and did NOT fix in the buffs model

`BuffsModule.dispatchEntity` handles `cc` by recording the mob as the current hostile target
and nothing else. So when `Your Mesmerization spell has worn off of a scareling.` routes to
`cc {refresh:true}` instead of `buffFade`, **`onBuffFade` never runs and any active instance of
a CC-roster spell on that mob is never cleared** — it lingers until the 90-minute hygiene cap.
Today this is nearly invisible because the four `has been …` landing sentences are claimed by
`classifyCcApply` before the DB matcher ever sees them, so most mezzes never become
`ActiveBuff`s at all; but a `Screaming Terror` (landing sentence `Someone begins to scream.`)
or a `Solon's Bravura` (`Someone 's eyes glaze over.`) does become one, and does linger.

Fixing that inside `buffsInstances.recordFade` would also mint a land→fade **duration sample**
and move mined statistics across the whole golden suite — i.e. exactly the buff-system rework
the owner paused. So this overlay corrects it in **its own projection** (§3.3) and the model
change is left as a separate, measurable piece of work.

---

## 2. The design

Four pieces, each small, in dependency order.

### 2.1 The parser carries the CC candidate list (additive)

`CcEvent` gains an optional `candidates?: { name: string; durationMs: number | null }[]`,
filled by `classifyCcApply` from the same `cfg.spellDb` cast-on-other suffix table
`classifyDbBuff` uses. This is line-level DB knowledge with no state, DB-gated exactly like
`classifyDbBuff` — with no DB installed the field is absent and the event is byte-identical to
what it was.

It goes in the PARSER and not in a module for the reason `DamageEventE.verb`'s comment already
gives: the parser is the only place that ever sees the sentence, and a second suffix matcher
downstream is a second opinion that can drift.

Measured, the four sentences `classifyCcApply` claims map to these candidate sets:

| sentence | candidates | stated durations |
|---|---|---|
| `has been mesmerized.` | Dazzle, Mesmerization, Mesmerize, Sathir's Mesmerization | 96 s / 24 s / 24 s / **none** |
| `has been ensnared.` | Ensnare, Snare | 660 s / 180 s |
| `has been enthralled.` | Enthrall | 48 s |
| `has been entranced.` | Entrance | 72 s |

Two of the four are genuinely ambiguous and two are not — which is precisely why the rule has
to be evidence-driven rather than a blanket "mez = count up".

### 2.2 A new module owns the CC holds — `src/main/modules/buffTimers.ts`, id `buffTimers`

It folds only what the buffs model demonstrably does not:

- `castBegin` / `castFizzle` / `castInterrupted` → an own-cast ledger (spell key → ts), the same
  10 s `OWN_CAST_WINDOW_MS` shape `buffs.ts` uses, imported from `buffsShapes.ts` rather than
  restated.
- `cc` **without** `refresh` → a HOLD on `mob`, if and only if it can be attributed to the
  player's own cast. Resolution, in order:
  1. narrow `candidates` to those the player cast within the window ⇒ exactly one ⇒ **resolved**:
     that spell's name and that spell's stated duration;
  2. more than one survives, or none did but *some* own CC cast is in the window ⇒ **ambiguous**:
     keep the whole candidate list; state a duration only if every candidate agrees on one;
  3. no own CC cast in the window at all ⇒ **no entry**. A stranger's mez is an observation about
     the room, not our world model — the identical ruling `combat/ingest.ts ingestCc` makes.
- `cc` **with** `refresh` (`Your <S> spell has worn off of <mob>.`) → the hold on `mob` ENDS.
  Recorded as an END with its spell + ts so the projection can also retire a matching
  `ActiveBuff` (§3.3).
- `uncharm {mob}` → ends any hold on that mob (charm and CC are the same sentence family).
- `death {name}` → ends every hold on that mob.
- `zone` → ends every hold (you left them behind).
- an event-time gap ≥ `SESSION_GAP_MS` (30 min) and `epoch` → clear everything.

Snapshot is `{ holds: CcHold[]; ends: CcEnd[] }` — a small, whole-state payload each flush,
the same contract `BuffsDelta` uses. It reports **its own revision counter** as `seq`, not the
last event's, per JOS-87: it has a second input (the 1 Hz tick expires holds on an idle log)
and `useModule`'s dedupe would otherwise drop the delta that removes a stale row.

A hold with a stated duration is dropped `duration + 30 s` after it landed (30 s of slack
because log stamps are second-resolution and a refresh can print late). A hold with **no**
stated duration is dropped after `CC_UNKNOWN_CAP_MS`, derived from the DB as the **longest
stated CC duration in the roster — 660 s, Ensnare** — rather than picked. Past that bound the
absence of a break line is evidence we lost the thread, not evidence the mob is still held.

### 2.3 The honesty law is a pure function — `src/shared/buffTimers.ts`

`buildTimerRows(buffs: BuffsSnap, timers: BuffTimersSnap, nowMs): BuffTimerRow[]`

No Electron, no React, no clock of its own — `nowMs` is passed in. This is where the ticket's
law lives, so a unit test can drive real fixture bytes through the real parser, the real
`BuffsModule` and the real `BuffTimersModule` and assert the rows a user would see.

```ts
type TimerMode = 'countdown' | 'elapsed' | 'permanent'

interface BuffTimerRow {
  id: string                    // `${group}|${targetKey}|${spellKey}` — stable across ticks
  kind: 'buff' | 'debuff' | 'cc'
  name: string                  // the resolved spell, or the candidates joined for a family
  candidates?: string[]         // present only when ambiguous (JOS-84)
  ambiguous?: true              // drives the `~` chip
  group: 'self' | 'target'
  target?: string               // the entity; absent for self
  targetKey?: string
  inferredTarget?: true         // `target` is an inference, never presented as fact
  startedTs: number
  mode: TimerMode
  durationMs?: number           // ONLY on 'countdown', and ONLY a DB-stated number
  provisional?: true
}
```

Mode selection, in full:

| row source | condition | mode |
|---|---|---|
| `ActiveBuff` | `permanent` (self-cast illusion + Permanent Illusion AA) | `permanent` |
| `ActiveBuff` | `durationSource === 'db'` and `estimatedMs != null` | `countdown` |
| `ActiveBuff` | anything else — `'observed'`, or no estimate at all | `elapsed` |
| `CcHold` | `durationMs != null` (resolved, or every candidate agrees) | `countdown` |
| `CcHold` | `durationMs == null` | `elapsed` |

Ordering is the priority the reports asked for and the one law 4 already states for the tab:
**self first**, then one group per target, each group's rows by soonest-to-expire, count-up rows
after countdowns within a group.

### 2.4 The overlay — kind `'buffs'`

A sixth meter kind, following every JOS-83 convention:

- `OverlayKind` union + `OVERLAY_KINDS` **appended at the end** (`overlayLayout.test.mts` pins
  the exact bounds of slots 0–2; a 6th meter kind takes slot 5, which places cleanly on the
  1366×728 "small laptop" work area — verified. A **seventh** would wrap into a third column and
  overlap, so that test's guard is doing real work and the next kind must revisit the wrap).
- Default geometry is the uniform `380×320` every meter kind shares — 12.2 % of the smallest
  work area, comfortably inside the ≤25 % invariant `overlayLayout.test.mts` enforces over
  `OVERLAY_KINDS`.
- Labeled chrome (`<OverlayHeader tag="BUFFS">`), the header row as the drag handle, the lock
  pin and the `✕` close affordance from `HeaderControls`, click-through when locked with
  `overlayForwardsMouse` returning true (it is a hover surface, not inert), the bg-alpha
  slider + `<TextScaleStepper>` footer, rows inside `<OverlayContent textScale={…}>` so text
  scale applies exactly where `overlayTextScale.test.mts` requires and nowhere else.
  MUI-free, no `vw`/`vh`, no `zoom:` outside `overlayScale.tsx`.
- **DEFAULT OFF.** `DEFAULT_OVERLAY_CONFIG.buffs = { open: false, … }` and **no migration**. A
  default only supplies a value for an absent key, and `overlays.buffs` is absent in every store
  ever written — so every existing user gets `open: false` for free. Adding a migration is the
  thing that would turn it on. (`migrateToV9`, which flipped the toast default, is the
  counter-example and its comment says so: a one-time correction of a default, never a policy
  that the app may re-enable things.)
- The `flash when a positive spell drops` the reports asked for is **renderer state**: the
  surface diffs the previous row set and, when a `kind: 'buff'` row disappears, shows a brief
  "dropped" line for it. No protocol change, and it can only ever fire on a removal the model
  already believed.

### 2.4a TWO WINDOWS OVER ONE MODEL (JOS-119)

The owner asked for the two halves of this surface to be windows he can enable and place
separately: what is running on *you* and what you are holding on *them* are read at different
moments and belong in different corners of the screen.

**The split is a filter, and the row's own `kind` is the whole discriminator.**
`buildTimerRows` is unchanged and still folds the two modules exactly once;
`shared/buffTimers.ts timerRowSurface` routes each row and `rowsForSurface` is the split:

| row kind | window | why |
| --- | --- | --- |
| `buff` | `'buffs'` | a beneficial spell you have running |
| `debuff` | `'debuffs'` | something you put on something else |
| `cc` | `'debuffs'` | the owner rules mez and slow ARE debuffs, so the holds sit beside them |

`group` is deliberately **not** the discriminator. A Symbol on your pet and a Valor on the
cleric you buffed are `group: 'target'` and are still buffs; routing by target would file your
own group buffs under "debuffs", which is a lie about what they are. `tests/buffTimers.test.mts`
pins that both ways, plus the partition property (every row lands on exactly one surface) over
every committed fixture.

**One component.** `BuffsOverlay.tsx` takes a `kind` prop and everything that differs is one
data table (`SURFACE`): tag, title, accent, empty sentence, the heading a self row sits under,
and whether the drop flash renders. A copy of that file would be the defect (the JOS-105 rule).
The drop flash stays on the buffs surface only: it answers "flash when a positive spell drops",
and a debuff or a mez ending is not a loss to shout about — the row simply leaves.

**No migration, and that is the design.** `overlays.buffs` keeps its key, so an existing
install's stored window (bounds, open flag, alpha, text scale) carries over to the window that
still draws that user's buffs. `overlays.debuffs` has never been written by any build, so it
reads the default and arrives OFF. Schema version untouched at 11. Content **moved** rather than
appeared — nobody loses a row, they are in a window that ships off, the same internal-validation
stance this ticket shipped under.

**The seventh meter slot, and the warning in §2.4 coming true.** That section said a seventh
stacked kind would wrap into a third column and overlap on the 1366×728 laptop, and it was
right: seven 380×320 slots do not fit that work area under *any* arrangement (three columns fit,
two rows fit — six slots). The fix is in `overlayLayout.ts`: the uniform first-open size is now a
function of the work area and shrinks all kinds **together** (a fixed ladder, largest rung that
fits wins) rather than letting two windows open on the same spot. Anything 1080p or larger is
untouched at 380×320; the laptop opens every overlay at 323×272. Uniformity and the no-overlap
guarantee both survive, and `overlayLayout.test.mts` states them per work area now.

**Telemetry.** `TelemetryOverlayKind` gains `'debuffs'` and `TELEMETRY.md` is regenerated. The
enum is CLOSED and the ingest Lambda validates it through the same shared validator, which fails
the WHOLE batch on one unknown value (the endpoint answers 400, which the client classes as a
permanent refusal and drops) — **so the Lambda ships before any client that can emit it.**

### 2.5 The one piece of plumbing that is missing today

`pipeline.ts` pushes `module:delta` to the main window and then forwards it to the `'events'`
overlay **and only that one**, by an explicit `getOverlayWindow('events')`. A new overlay kind
receives nothing until it is added there. The fan-out stays explicit and per-kind rather than
becoming a broadcast: an overlay that does not read modules should not be woken 10×/second.

---

## 3. Consequences, stated

### 3.1 What this overlay will NOT show

- A stranger's buff, a stranger's mez, a group-mate's slow. Own-cast gating, unchanged.
- A remaining time for the 54 % of spells `spells.json` has no duration for — those count up.
- A remaining time for a buff whose only duration evidence is the player's own mined samples.
- "It broke early." The log cannot say it.

### 3.2 What it will show that is approximate, and how it says so

- A DB-stated duration is the top of the spell's level band and ignores focus effects (§1.3).
  The row prints the countdown the DB states; it does not editorialize on it, per the
  tooltip/caveat diet. The one visible honesty marker is the `~` ambiguity chip on a
  candidate-list row, which is an existing chip convention.
- An `inferredTarget` debuff (a target the model inferred rather than read from a sentence)
  keeps its existing "inferred" presentation. It is never presented as a named fact.

### 3.3 The CC/ActiveBuff correction, and why it lives here

`buildTimerRows` drops any `ActiveBuff` whose `(spellKey, targetKey)` the CC ledger has recorded
an END for at or after that instance's `startedTs`. That is the §1.5 gap, corrected in the
projection only. It is a second model with a narrower reach than the buffs model — the exact
shape world-model law 4 warns about — so it is written down here: the difference is deliberate,
it is one rule wide, and the correct fix is in `buffsInstances`, gated behind a duration-sample
regression run that this ticket is not the place for.

---

## 4. Verification

- `tests/buffTimers.test.mts` — the entry model over REAL fixture bytes, through the real
  parser + real modules:
  - **`w10-cazic-slow.log`** is the chain-mez the reports describe, in the owner's own log:
    `You begin casting Mesmerization III.` at 20:50:33 lands on `a turmoil toad` and
    `a scareling` in the same second (one AE cast, two broadcasts), then
    `Your Mesmerization spell has worn off of a scareling.` at 20:50:36 and
    `…of a turmoil toad.` at 20:50:52. Asserts: two named per-target rows from one cast; each
    resolved to `Mesmerization` (own cast narrows 4 candidates to 1) and therefore counting
    DOWN from the stated 24 s; the scareling's row gone after its break line while the toad's
    survives; the toad's gone after its own. Later in the same fixture a single cast lands on
    three mobs at once.
  - unknown-duration rows count UP and carry no `durationMs`, ever (asserted as an invariant
    over every row every fixture produces, not just one case).
  - **`w7-quick-buff.log`** — a Quick Buff burst of self buffs followed by
    `You have been slain by …!`: self rows exist, then death clears them (JOS-88) while
    non-self rows survive.
  - `w16-shared-wearsoff-speed.log` — the shared-message family, to pin that a row's name is
    never a coin flip.
- `tests/overlayLayout.test.mts`, `tests/replayGate.test.mts`, `tests/telemetryContract.test.mts`
  cover the new kind automatically by iterating `OVERLAY_KINDS`; `tests/overlayTextScale.test.mts`
  needs the new surface added to its `SURFACES` list.
- `tests/e2e/buffs-overlay.e2e.mts` — the real app: default OFF (a fresh install's
  `getOverlayState()` says so), toggle open, the surface renders its labeled chrome, the
  first-open window is `< 25 %` of the work area read from MAIN via `browserWindow.getBounds()`,
  and the close affordance actually closes it. Modelled on `toast.e2e.mts`.

---

## 5. Log of changes

- **2026-08-08** — first draft, written before any code, from a study of `parseCasts.ts`,
  `rulesets.ts`, `buffs.ts`/`buffsInstances.ts`/`buffsStats.ts`/`buffsView.ts`, `spells.json`
  (measured), the JOS-83 overlay conventions and the JOS-84/JOS-87/JOS-88 rulings.
- **2026-08-08, built** — phases 1 (model) and 2 (surface) landed. Corrections the build made to
  the draft above, each one measured rather than assumed:
  - **`buildTimerRows` takes NO clock.** The draft gave it `nowMs`; nothing used it, because the
    decision "is this row still worth showing" belongs to the module's own expiry sweep and the
    reading against a clock is `timerReading`. Dropping it keeps the projection a pure fold over
    two snapshots.
  - **The mined-estimate branch is structurally covered, NOT observed** (the awaiting-sample law's
    "say which"). A sweep of all 103 committed `tests/fixtures/*.log` through the DB-enabled
    replay produced **zero** actives with `durationSource === 'observed'` — with the real
    spells.json installed, every buff that survives own-cast gating is a spell the DB knows. So
    that assertion is made on the projection over a typed `ActiveBuff`, and the test says so.
  - **`CC_UNKNOWN_CAP_MS` is re-derived by a test, not computed at runtime.** Runtime derivation
    would have needed the CC roster regex out of `rulesets.ts` and the DB inside the module; the
    `charmCcRoster.test.mts` pattern (re-derive from `spells.json` against the parser's own
    `ccSpell` on every run) gets the same guarantee with the constant staying a constant.
  - **A death line for a mob we were never holding records no END.** The draft had `death` always
    write one; that would have churned the snapshot on every kill in the zone AND been a second
    opinion about a fact `retireEntity(key, {hostileOnly:true})` already settles.
  - **The `module:delta` fan-out is a per-kind list, not a broadcast.** `pipeline.ts` forwarded
    only to `'events'`, by name; it is now `MODULE_READING_OVERLAYS`. An overlay that reads no
    module should not be woken ~10×/second.
  - **`src/shared/types.ts` was at its 400-code-line ceiling**, so `OVERLAY_KINDS` stays on one
    line. Noted here because the next kind added will hit it again.

### What the e2e actually proved in the running app

`tests/e2e/buffs-overlay.e2e.mts`, 18 checks, green:

- a fresh install has it **OFF** and spawns no window for it;
- toggling it open gives labelled `BUFFS` chrome, a close control and a lock control;
- the first-open window is **3.4 %** of a 2560×1392 work area (invariant: < 25 %), on-screen;
- opening mid-session **hydrates from the replay** — the fixture's own buffs render, with the
  debuffs filed under the enemies they are on (`Your buffs` / `Lord Nagafen` /
  `a fire giant warrior`), which is the per-target half of the reports' ask, unscripted.
  **THAT SENTENCE COVERED ONLY THE WINDOW YOU OPEN AFTER LAUNCH, AND FOR MONTHS IT READ AS IF IT
  COVERED BOTH (JOS-172).** Opening the window mid-session hydrates from a FINISHED fold; a window
  that was ALREADY OPEN when the app started hydrates part-way THROUGH one, and `endReplay()`
  discards what that fold accumulated, so nothing ever described the rest of it. A charm or an
  Ensnare that survived a restart was in the model, in the app, and missing here. The fix is the
  rebuilt-world signal (`log:character`) reaching the module-reading overlays as well as the main
  window — `sendWorldRebuilt` in pipeline.ts — and the restart is now a step of its own
  (`tests/e2e/buffRestartSteps.mts`), with its fold deliberately PADDED so the window really does
  hydrate mid-fold: measured, the unpadded fixture folds faster than a second BrowserWindow loads,
  and the first cut of that step passed with the bug still in the tree;
- **the chain-mez**: one `You begin casting Mesmerization III.` appended to the LIVE log, followed
  by two `has been mesmerized.` broadcasts, produces **two rows, both named `Mesmerization`, both
  counting down from 24 s, grouped under `a turmoil toad` and `a scareling`** — the whole real
  path, chokidar → Tailer → parser → module → IPC → React;
- one break line clears **only** its target and the other enemy keeps counting;
- **the self-buff bar and the drop flash**: a `You begin casting Valor.` + `You feel valorous.`
  raises a self row counting down from `54m 00s` (the duration spells.json states), and
  `Your valor fades.` clears it and flashes `Valor dropped`;
- the ✕ closes the window and main records it closed.

Two things the e2e taught that the draft did not anticipate, both now encoded:

1. **The first appended line trips the session-gap clear.** The fixture's last event is ~30 min of
   event time before "now", so `SESSION_GAP_MS` fires and correctly wipes every replayed active —
   which is why the drop-flash step casts its own buff instead of borrowing one from the replay.
2. **The drop notice has to carry the target.** The fixture has `Valor` up on the player AND on
   `a fire giant warrior`, so the first cut printed two identical `Valor dropped` lines for two
   genuinely different drops. The label is now `Valor · a fire giant warrior` for a non-self row,
   and the spec asserts no two notices are indistinguishable.

### Verification, final

Rebased onto current main (10 commits had landed under it — JOS-31 Wine, JOS-101, JOS-102,
JOS-104; the rebase was clean) and re-verified at that tip:

`npm run typecheck` (node+web) green · `npm run lint` green (**no ratchet entries added**) ·
`npm test` **2521 pass / 0 fail / 2 skipped** (the two full-log tests, which need the real game
log) · `npm run test:e2e` **23/23 green**.

Two reds seen along the way, neither this branch's:

- `feedback.e2e.mts` fails its "owner-tools opt-in reads FALSE with nothing set" check on THIS
  MACHINE, because the owner has `EQ_OWNER_TOOLS=1` set user-wide (`setx`, exactly as AGENTS.md
  describes) and the spec's deliberately-bare launch inherits it. With the variable cleared it
  passes every check. Nothing in JOS-89 goes near owner tools.
- `leveling.e2e.mts` failed once under full-suite parallelism and passed solo and in three of
  four full runs. Flake, and nothing in this branch touches the leveling path.
