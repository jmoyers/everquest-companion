# Boss lockout: the credit join misses EQL's XP lines, and a manual base-rung clear

Design doc + implementation plan. Two changes, one small (engine regex) and one medium
(renderer store + ladder wiring). Grounded in a read of the current source and a targeted
sweep of a real raid log:

`C:\Users\Public\Daybreak Game Company\Installed Games\EverQuest Legends\Logs\eqlog_Drammin_qeynos.txt`
(295,433 lines, 24 MB, Sun Sep 06 2026 11:53; contains real raid nights in Nagafen's Lair,
The Permafrost Caverns, The Plane of Hate, The Ruins of Old Paineel).

---

## 0. The reported symptom

A raid coordinator reports that the Bosses tab's **This week** ladder never greens a rung,
even after clearing raid targets on lockout-bearing difficulties. The boss-defeat
celebration (confetti / snackbar / sound) also never fires for those kills.

Both surfaces are gated on the same fact: `KillTierRun.credited` / `lastCreditedTs`, set
only when an experience line joined the slain line at fold time
([`engine/crates/fold/src/modules/kills.rs:246`](../../engine/crates/fold/src/modules/kills.rs#L246),
`take_exp`). The renderer consumers:

- `tierLocks` skips any run whose `lastCreditedTs` is 0 or out-of-window
  ([`lockout.ts:171-183`](../../src/renderer/src/features/bosses/lockout.ts#L171-L183))
- `bossKills` fires only when `s.credited > prevCredited`
  ([`bossStatus.ts:160-172`](../../src/renderer/src/features/bosses/bossStatus.ts#L160-L172))

## 1. Headline finding: EQ Legends prints `(with a bonus)` and the regex doesn't match it

The exp classifier is one regex, in one place — the Rust parser is the only parser now
(`src/main/log/parseWorld.ts` and its siblings are gone):

[`engine/crates/eqlog/src/parse/world.rs:95`](../../engine/crates/eqlog/src/parse/world.rs#L95)

```rust
exp: Regex::new(r"^You gain (party )?experience!(?: \(([0-9.]+)%\))?$").unwrap(),
```

Every `experience` line shape in the raid log (timestamp stripped, percent normalised):

| count | line |
|---|---|
| 790 | `You gain experience (with a bonus)! (N%)` |
| 99  | `You gain party experience (with a bonus)! (N%)` |
| 9   | `You gain experience! (N%)` |
| 18  | `You receive no experience for defeating this creature as you are in a raid.` |

**889 of 898 real XP lines (99%) carry a ` (with a bonus)` infix** between `experience`
and `!`, and the regex's `experience!` requires them adjacent. Those 889 lines currently
classify as `{kind:'unknown'}` and never become an `expGain` event.

Every raid-boss kill in the log printed the bonus form immediately before the slain line
(same second or one before — the join reaches 2500 ms backward). E.g. the first
Lord Nagafen kill:

```
[Sat Sep 05 18:49:53 2026] Your task 'Potential of the Void - Lord Nagafen - Weekly' has been updated.
[Sat Sep 05 18:49:53 2026] You gain party experience (with a bonus)! (0.092%)     <- dropped by the regex
[Sat Sep 05 18:49:53 2026] You receive 20 platinum, 8 gold, 3 silver and 8 copper from the corpse.
[Sat Sep 05 18:49:53 2026] Lord Nagafen has been slain by Tevik!
```

Confirmed the same shape on King Tranix (×2), Warlord Skarlon (×2), Lord Nagafen (×2),
Lady Vox, Master Yael, Lord of Ire. So: **zero credited kills → no rungs, no celebration**,
regardless of tier. It is not "raid experience!", not a `!!` double-bang, not a missing
line — the trash-only `You receive no experience … as you are in a raid.` (18×) fires only
for pets and non-target adds and never for a named/boss kill.

### 1a. The fix

```rust
exp: Regex::new(
    r"^You gain (party )?experience(?: \(with a bonus\))?!(?: \(([0-9.]+)%\))?$"
).unwrap(),
```

`(?: \(with a bonus\))?` is **non-capturing**, so capture group 1 stays `(party )` and
group 2 stays the percent — `classify_exp`
([`world.rs:416-430`](../../engine/crates/eqlog/src/parse/world.rs#L416-L430)) and the
`ExpGainEvent` shape are untouched. No `bonus` flag is added (owner ruling: the stated
percent already reflects the boost).

**Side effects, both wanted:**
- 889 XP lines per raid log stop falling through to `unknown` and start feeding the
  leveling analytics (`levelCurve.ts`, `shared/progressionStats.ts`) — the same recovery
  the earlier `You gain experience!` widening made (`shared/logEvents.ts:126-131`).
- The boss-defeat celebration seam ([`bossStatus.ts:169`](../../src/renderer/src/features/bosses/bossStatus.ts#L169))
  reads `credited` too — it starts firing for raid kills with no other change.

For this log specifically, once credited: the raid ran `Nagafen's Lair - Group 3 (Fused)`
and `- Group 4 (Refined)` (both suffixed → `zone_tier` returns 3 and 4), so the D3 and D4
Nagafen rungs green automatically.

## 2. Second finding: base-difficulty instances print a bare zone name, and only the creator sees why

Confirmed the mechanism the original bug report described, though it does **not** reproduce
for the raid kills in this log:

- **d1–d4 instances** print an adjective: `The Estate of Unrest 1 (Awakened)`,
  `Nagafen's Lair - Group 3 (Fused)`, `The Permafrost Caverns - Group 4 (Refined)`,
  `The Plane of Hate - Group 1 (Awakened)`. `zone_tier`
  ([`jsfn.rs:61`](../../engine/crates/fold/src/jsfn.rs#L61)) decodes all of them.
- **d0 (base) instances** print a bare name, byte-identical to the open world:
  ```
  [Sat Sep 05 11:59:59 2026] Player Drammin creating instance The Estate of Unrest 975.
  [Sat Sep 05 11:59:59 2026] The Estate of Unrest is now available to you.
  [Sat Sep 05 12:00:29 2026] You have entered The Estate of Unrest.        <- no suffix, no adjective
  ```
- The **only** rescue is `Player <name> creating instance <zone> <id>.`
  ([`world.rs:234`](../../engine/crates/eqlog/src/parse/world.rs#L234)), remembered by the
  kills fold ([`kills.rs:107-112`, `kills.rs:253`](../../engine/crates/fold/src/modules/kills.rs#L253)).
  That line prints **only for the player who created the instance** — 12/12 occurrences in
  this log are Drammin's own, each paired with `<zone> is now available to you.`
- `<zone> is now available to you.` is also creator-only (same 12 pairings), so it is not a
  usable signal for a raider who zoned into a leader-made instance.
- The `You have been assigned the task 'Potential of the Void - <Boss> - Weekly'.` /
  `Your task '…' has been updated.` lines DO reach every raider and fire at the kill's
  timestamp — but they carry **no difficulty**, so they cannot tier a kill.

**Net:** a raider who kills a boss in someone else's **base-difficulty** raid instance gets
a credited kill that folds as `TIER_OPEN_WORLD` (bare name) — and `tierLocks` correctly
refuses to green a d0 rung from an open-world kill
([`lockout.ts:160-165`](../../src/renderer/src/features/bosses/lockout.ts#L160-L165): "an
open-world kill of a raid boss takes nothing off your week"). There is no log line that
disambiguates this case. It did not occur in the provided log (that raid used d1/d3/d4
suffixed instances; the bare-name d0 instances were all group content Drammin created
himself, where the existing rescue works).

### 2a. The fix: a manual "mark cleared this week" on the base rung

Since the log cannot supply the missing bit, the coordinator supplies it. Owner rulings:

1. **Base (d0) rung only.** d1–d4 always print an adjective, so a missing d1–d4 rung is a
   real "you weren't there" and must stay underivable-by-hand.
2. **Rendered identically** to a log-proven cleared rung — no dashed/hatched treatment, no
   distinct tooltip. A `manual` boolean rides on the rung for tests only; `DifficultyLadder`
   draws it green like any other and `rungTitle` shows the mark's date exactly as it shows
   a kill date.
3. **Gated.** The affordance appears on the d0 rung only when there is a **credited
   open-world (`-1`) or unknown-tier (`-2`) kill run for that boss inside the current
   lockout week** — real evidence the boss died to you this week; the mark only adds "it was
   the instance". A boss with no such kill shows no affordance.
4. **Auto-expires at reset**, per character, no server sync. Stored as one timestamp per
   boss in `localStorage`; it counts as a live clear only while
   `lockoutWindow(markedTs).start === currentWeek.start` — the same checked-at-use pattern
   the instance-notice TTL uses, so nothing sweeps.

---

## 3. File structure

**Bug 1 (engine):**
- `engine/crates/eqlog/src/parse/world.rs` — modify the one regex (line 95)
- `engine/crates/eqlog/src/lib.rs` — extend the exp test (~line 230)
- `tests/bench/rustParity.mts` — header comment only, *if* the frozen goldens red

**Bug 2 (renderer, all under `src/renderer/src/features/bosses/`):**
- `weekClears.ts` — **new.** The storage vocabulary: shape, parse/serialise/toggle, key.
  No React, no MUI, RELATIVE value imports (`combatPrefs.ts` rule — node-tested).
- `lockout.ts` — modify. Add `manualClearIsLiveThisWeek`, `hasCreditedAmbiguousKill`, and
  a `manualBaseTs?` argument to `tierLadder`; `LadderRung` gains `manual?: boolean`.
- `useWeekClears.ts` — **new.** The React + `localStorage` + `onCharacter` half
  (`useQuestFlags.ts` store shape + `useWishlist.ts` `watch()` for character switches).
- `DifficultyLadder.tsx` — modify. The d0 rung gets an optional click handler and a
  `data-can-mark` / `data-manual` attribute pair.
- `BossSections.tsx` — modify. Thread `manualBaseTs` into `tierLadder` and a
  `canMarkBase` / `onToggleBase` pair down to the ladder.
- `BossView.tsx` — modify. Call `useWeekClears`, compute the gate per card, pass handlers.

**Tests:**
- `tests/bossWeekClears.test.mts` — **new.** Covers `weekClears.ts` + the three new pure
  `lockout.ts` functions under plain node.
- `tests/e2e/bosses-week.e2e.mts` — modify. One resilient step + a restart assertion.

---

## Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use subagent-driven-development (recommended) or executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Credit raid-boss kills whose XP line carries EQ Legends' ` (with a bonus)` infix, and let a coordinator manually mark a base-difficulty rung cleared for the current lockout week.

**Architecture:** Bug 1 is a one-line non-capturing widening of the sole experience regex in the Rust parser, plus its unit test and a parity-oracle check. Bug 2 adds a `localStorage`-backed per-character store of one timestamp per boss; a pure predicate turns that timestamp into a live d0 clear for the current week, `tierLadder` merges it as a normal green rung, and the Bosses "This week" view exposes a click affordance on the d0 rung gated on there being a credited open-world/unknown kill of that boss this week.

**Tech Stack:** Rust (`regex` crate) for the parser; TypeScript + React (`useSyncExternalStore`) + MUI for the renderer; `node:test` via `npm test`; Playwright-on-Electron for e2e.

**Spec:** this document, sections 0–3.

## Global Constraints

- **The Rust parser is the only parser.** There is no TS mirror of the exp regex to keep in sync (`src/main/log/parseWorld.ts` and `reducers.ts` were deleted).
- **`lockout.ts` and `weekClears.ts` must stay React-free, MUI-free, and use RELATIVE value imports** (`../../../../shared/kills`, not `@shared/kills`). They are unit-tested under `tsx`/node, which resolves no `@shared` alias for values. Type-only imports may use `@shared`.
- **The parity goldens (`tests/bench/rustParity.mts`) are frozen.** An intended parser divergence is *documented* in that file's header comment following the `JOS-521` precedent — never "fixed" by editing a golden.
- **TDD:** the failing test is written and run (and seen to fail) before the implementation.
- **Commit trailer:** end every commit message with
  `Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>`
- **Gates before every commit:** the task's own tests pass; for renderer tasks also `npm run typecheck` and `npm run lint`.

---

### Task 1: Widen the experience regex to accept ` (with a bonus)`

**Files:**
- Modify: `engine/crates/eqlog/src/parse/world.rs:95`
- Test: `engine/crates/eqlog/src/lib.rs:230-247`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: `expGain` events for the four line shapes
  `You gain [party ]experience[ (with a bonus)]![ (N%)]`. The serialized event is unchanged
  from today: `{"kind":"expGain",…,"party":<bool>[,"pct":<number>]}`.

- [ ] **Step 1: Write the failing test**

In `engine/crates/eqlog/src/lib.rs`, replace the body of
`the_experience_percentage_is_the_one_float_in_the_stream` (currently ~lines 230-247) with:

```rust
    #[test]
    fn the_experience_percentage_is_the_one_float_in_the_stream() {
        let p = bare();
        let out = parse_one(
            &p,
            "[Wed Aug 19 16:21:54 2026] You gain experience! (3.288%)",
        );
        assert!(out.ends_with(r#""party":false,"pct":3.288}"#), "{out}");
        // …and an integral one prints as JS prints it: no fraction.
        let out = parse_one(
            &p,
            "[Wed Aug 19 16:21:54 2026] You gain party experience! (3%)",
        );
        assert!(out.ends_with(r#""party":true,"pct":3}"#), "{out}");
        // …and a line that states none omits the key rather than saying zero.
        let out = parse_one(&p, "[Wed Aug 19 16:21:54 2026] You gain experience!");
        assert!(out.ends_with(r#""party":false}"#), "{out}");

        // EQ Legends prints a ` (with a bonus)` infix on ~99% of real XP lines (raid log
        // sweep 2026-09-06). It sits between `experience` and `!`; the percent, when stated,
        // still trails. All four combinations are the same event as their plain twin.
        let out = parse_one(
            &p,
            "[Wed Aug 19 16:21:54 2026] You gain experience (with a bonus)! (0.092%)",
        );
        assert!(out.starts_with(r#"{"kind":"expGain","#), "{out}");
        assert!(out.ends_with(r#""party":false,"pct":0.092}"#), "{out}");
        let out = parse_one(
            &p,
            "[Wed Aug 19 16:21:54 2026] You gain party experience (with a bonus)! (1%)",
        );
        assert!(out.ends_with(r#""party":true,"pct":1}"#), "{out}");
        let out = parse_one(
            &p,
            "[Wed Aug 19 16:21:54 2026] You gain experience (with a bonus)!",
        );
        assert!(out.ends_with(r#""party":false}"#), "{out}");
    }
```

- [ ] **Step 2: Run the test and watch it fail**

```
cargo test --manifest-path engine/Cargo.toml -p eqlog the_experience_percentage_is_the_one_float_in_the_stream
```

Expected: FAIL — the `(with a bonus)` lines classify as `unknown`, so `out` does not start
with `{"kind":"expGain"`.

- [ ] **Step 3: Widen the regex**

In `engine/crates/eqlog/src/parse/world.rs`, line 95:

```rust
            exp: Regex::new(r"^You gain (party )?experience(?: \(with a bonus\))?!(?: \(([0-9.]+)%\))?$").unwrap(),
```

(The insert is `(?: \(with a bonus\))?` immediately before `!`. It is non-capturing, so
`m.get(1)` is still `(party )` and `m.get(2)` is still the percent in `classify_exp`.)

- [ ] **Step 4: Run the test and watch it pass**

```
cargo test --manifest-path engine/Cargo.toml -p eqlog the_experience_percentage_is_the_one_float_in_the_stream
```

Expected: PASS.

- [ ] **Step 5: Run the whole eqlog crate**

```
cargo test --manifest-path engine/Cargo.toml -p eqlog
```

Expected: PASS — no other test asserts an exp line shape.

- [ ] **Step 6: Commit**

```
git add engine/crates/eqlog/src/parse/world.rs engine/crates/eqlog/src/lib.rs
git commit -m "$(cat <<'EOF'
fix(parser): accept EQ Legends' "(with a bonus)" experience lines

The sole exp regex required `experience!` adjacent, so the ` (with a bonus)`
infix EQ Legends prints on ~99% of XP lines (real raid-log sweep) fell through
to `unknown`. Every raid-boss kill's party-XP line was among them, so no kill
was credited -> no weekly-lockout rung, no boss-defeat celebration.

Non-capturing insert; the ExpGainEvent shape and classify_exp are unchanged.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 2: Verify the parity oracles, document any intended divergence

**Files:**
- Possibly modify: `tests/bench/rustParity.mts` (header comment block only)

**Interfaces:**
- Consumes: Task 1's regex.
- Produces: nothing code-facing. A green oracle, or a documented divergence.

- [ ] **Step 1: Run the parser parity oracle**

```
npm run oracle:rust-parser
```

- [ ] **Step 2: Run the fold parity oracle**

```
npm run oracle:rust-fold
```

- [ ] **Step 3: Classify the result**

- **Both green** → nothing to do; go to Step 5. (Expected: the six frozen slices come from
  an older `eqlog_Primitive_freeport.txt` that predates the `(with a bonus)` wording, so
  they likely contain no such line.)
- **Red, and every red line is either** (a) phase 1: a `You gain … experience (with a
  bonus)!…` line now emitting `expGain` where the golden says `unknown`, or (b) phase 2:
  `kills` / `progression` snapshot deltas confined to those same kills gaining `credited` /
  `lastCreditedTs` and to `expGain` counts rising — this is the fix working. Go to Step 4.
- **Any other red** → STOP. This is unrelated drift; investigate before continuing.

- [ ] **Step 4: Document the divergence**

In `tests/bench/rustParity.mts`, in the header's
"THE GOLDENS ARE A SNAPSHOT OF A DEAD PIPELINE" section, add a dated paragraph in the same
shape as the `JOS-521` one:

```
 *   <ticket/date> — the exp regex now accepts EQ Legends' ` (with a bonus)` infix, which
 *   the frozen TS parser dropped as `unknown`. Phase 1: the byte-identity bar reds on
 *   `You gain [party ]experience (with a bonus)![ (N%)]` lines — `expGain` where the golden
 *   says `unknown` (<N> lines across the corpus). Phase 2: the `kills` and `progression`
 *   modules red where exactly those kills gain `credited` / `lastCreditedTs` and `expGain`
 *   counts rise, and on nothing else. A red confined to those shapes is the fix working.
```

(Fill `<N>` from the oracle output.)

- [ ] **Step 5: Commit (only if the doc changed)**

```
git add tests/bench/rustParity.mts
git commit -m "$(cat <<'EOF'
docs(parity): record the "(with a bonus)" exp-regex divergence

Intended parser change; the frozen goldens cannot be re-recorded. Same shape
as the JOS-521 note.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 3: The pure week-clear layer — `weekClears.ts` + three `lockout.ts` functions

**Files:**
- Create: `src/renderer/src/features/bosses/weekClears.ts`
- Modify: `src/renderer/src/features/bosses/lockout.ts`
- Create: `tests/bossWeekClears.test.mts`

**Interfaces:**
- Consumes: `LockoutWindow` and `lockoutWindow` from `lockout.ts`; `KillTierRun`,
  `TIER_OPEN_WORLD`, `TIER_UNKNOWN` from the shared kills module.
- Produces, from `weekClears.ts`:
  - `type WeekClears = Record<string, number>` — boss key (lowercased) → the `Date.now()`
    at which its d0 rung was last marked.
  - `bossClearKey(targetName: string): string` — `targetName.trim().toLowerCase()`.
  - `weekClearsStorageKey(character: string | null): string` —
    `` `eq.bosses.weekClears.${character ?? 'unknown'}` ``.
  - `parseWeekClears(raw: string | null): WeekClears` — `{}` on null / malformed / any
    non-number value.
  - `serializeWeekClears(w: WeekClears): string`.
  - `toggleWeekClear(w: WeekClears, key: string, nowMs: number): WeekClears` — returns a new
    object with `key` set to `nowMs` if absent, or deleted if present.
- Produces, from `lockout.ts`:
  - `manualClearIsLiveThisWeek(markedTs: number | undefined, w: LockoutWindow): boolean` —
    `markedTs !== undefined && lockoutWindow(markedTs).start === w.start`.
  - `hasCreditedAmbiguousKill(tiers: Record<number, KillTierRun>, w: LockoutWindow): boolean`
    — true iff the `-1` or `-2` tier run's `lastCreditedTs` is in `[w.start, w.next)`.
  - `tierLadder(locks: TierLock[], manualBaseTs?: number): LadderRung[]` — unchanged for the
    no-second-arg call; with `manualBaseTs` and no real tier-0 lock, rung 0 becomes
    `{ tier: 0, cleared: true, ts: manualBaseTs, manual: true }`.
  - `LadderRung` gains `manual?: boolean`.

- [ ] **Step 1: Write the failing test**

Create `tests/bossWeekClears.test.mts`:

```typescript
// The PURE half of the manual base-rung clear (see docs/plans/boss-lockout-credit-and-manual-clear.md
// section 2a). No DOM, no localStorage object — every function here takes plain values, which is
// what makes it a node test. The storage/React half is useWeekClears.ts, proven in
// tests/e2e/bosses-week.e2e.mts.
//
// Run: `npm test`.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  bossClearKey,
  parseWeekClears,
  serializeWeekClears,
  toggleWeekClear,
  weekClearsStorageKey
} from '../src/renderer/src/features/bosses/weekClears'
import {
  hasCreditedAmbiguousKill,
  lockoutWindow,
  manualClearIsLiveThisWeek,
  tierLadder,
  type TierLock
} from '../src/renderer/src/features/bosses/lockout'
import type { KillTierRun } from '../src/shared/types'

// A Wednesday, comfortably inside one Pacific lockout week (reset is Tue 08:00 America/Los_Angeles).
const WED = Date.UTC(2026, 8, 2, 20, 0, 0)
const week = lockoutWindow(WED)

function run(over: Partial<KillTierRun>): KillTierRun {
  return { count: 1, firstTs: 0, lastTs: 0, credited: 0, lastCreditedTs: 0, ...over }
}

test('bossClearKey is trim + lowercase', () => {
  assert.equal(bossClearKey('  Lord Nagafen '), 'lord nagafen')
})

test('weekClearsStorageKey namespaces by character and degrades to "unknown"', () => {
  assert.equal(weekClearsStorageKey('Drammin_qeynos'), 'eq.bosses.weekClears.Drammin_qeynos')
  assert.equal(weekClearsStorageKey(null), 'eq.bosses.weekClears.unknown')
})

test('parseWeekClears degrades anything that is not a {string: number} map to {}', () => {
  assert.deepEqual(parseWeekClears(null), {})
  assert.deepEqual(parseWeekClears('not json'), {})
  assert.deepEqual(parseWeekClears('[1,2,3]'), {})
  assert.deepEqual(parseWeekClears('{"lord nagafen":"soon"}'), {})
  assert.deepEqual(parseWeekClears('{"lord nagafen":123}'), { 'lord nagafen': 123 })
})

test('serializeWeekClears round-trips', () => {
  const w = { 'lord nagafen': 111, 'lady vox': 222 }
  assert.deepEqual(parseWeekClears(serializeWeekClears(w)), w)
})

test('toggleWeekClear sets an absent key to nowMs and deletes a present one', () => {
  const set = toggleWeekClear({}, 'lord nagafen', 999)
  assert.deepEqual(set, { 'lord nagafen': 999 })
  assert.deepEqual(toggleWeekClear(set, 'lord nagafen', 1000), {})
})

test('toggleWeekClear does not mutate its input', () => {
  const before = { a: 1 }
  toggleWeekClear(before, 'b', 2)
  assert.deepEqual(before, { a: 1 })
})

test('manualClearIsLiveThisWeek is true only for a mark made in the current lockout week', () => {
  assert.equal(manualClearIsLiveThisWeek(WED, week), true)
  assert.equal(manualClearIsLiveThisWeek(undefined, week), false)
  // one week earlier — a stale mark
  assert.equal(manualClearIsLiveThisWeek(WED - 7 * 24 * 3600_000, week), false)
})

test('hasCreditedAmbiguousKill sees a credited open-world or unknown run in-window and nothing else', () => {
  const inWin = week.start + 3600_000
  assert.equal(
    hasCreditedAmbiguousKill({ [-1]: run({ lastCreditedTs: inWin }) }, week),
    true
  )
  assert.equal(
    hasCreditedAmbiguousKill({ [-2]: run({ lastCreditedTs: inWin }) }, week),
    true
  )
  // a real difficulty tier does not count — that path is not ambiguous
  assert.equal(
    hasCreditedAmbiguousKill({ 0: run({ lastCreditedTs: inWin }) }, week),
    false
  )
  // an uncredited open-world run (a stranger's kill) does not count
  assert.equal(
    hasCreditedAmbiguousKill({ [-1]: run({ lastCreditedTs: 0 }) }, week),
    false
  )
  // last week's credited kill does not count
  assert.equal(
    hasCreditedAmbiguousKill({ [-1]: run({ lastCreditedTs: week.start - 1 }) }, week),
    false
  )
})

test('tierLadder without a manual arg is unchanged — five rungs, base first', () => {
  const rungs = tierLadder([])
  assert.deepEqual(
    rungs.map((r) => [r.tier, r.cleared]),
    [[0, false], [1, false], [2, false], [3, false], [4, false]]
  )
})

test('tierLadder merges a live manual base clear as a normal green rung', () => {
  const rungs = tierLadder([], WED)
  assert.deepEqual(rungs[0], { tier: 0, cleared: true, ts: WED, manual: true })
  // the other four are untouched
  assert.equal(rungs[1].cleared, false)
})

test('a real tier-0 lock wins over a manual mark (no double, no manual flag)', () => {
  const lock: TierLock = { tier: 0, ts: 12345 }
  const rungs = tierLadder([lock], WED)
  assert.deepEqual(rungs[0], { tier: 0, cleared: true, ts: 12345 })
})
```

- [ ] **Step 2: Run the test and watch it fail**

```
npm test -- --test-name-pattern='bossClearKey|weekClears|manualClearIsLiveThisWeek|hasCreditedAmbiguousKill|tierLadder'
```

(or run the file directly: `node --import tsx --test tests/bossWeekClears.test.mts`)

Expected: FAIL — `weekClears` module does not exist; `lockout` has no
`manualClearIsLiveThisWeek` / `hasCreditedAmbiguousKill`; `tierLadder` takes one arg.

- [ ] **Step 3: Create `weekClears.ts`**

`src/renderer/src/features/bosses/weekClears.ts`:

```typescript
// WEEK-CLEAR STORAGE VOCABULARY — the manual "this rung is cleared this week" mark, minus the DOM.
//
// `useWeekClears.ts` is the storage half (localStorage + the onCharacter re-key); this half decides
// what a stored string MEANS and owns the one pure edit. Splitting them is what makes the rules
// testable under plain node — the combatPrefs.ts precedent, for the same reason: no `@shared` alias
// resolves for values here, so the one shared import below is RELATIVE.
//
// See docs/plans/boss-lockout-credit-and-manual-clear.md section 2a. The mark is BASE-RUNG ONLY and
// per character; a stored value is the Date.now() of the click, and lockout.ts decides from that
// timestamp whether the mark is still live for the current lockout week (it expires at reset with
// no sweep — the instance-notice TTL pattern).

/** boss key (lowercased target name) -> the `Date.now()` its d0 rung was last marked. */
export type WeekClears = Record<string, number>

const KEY_PREFIX = 'eq.bosses.weekClears'

/** The per-character localStorage key. An absent character degrades to one shared bucket. */
export function weekClearsStorageKey(character: string | null): string {
  return `${KEY_PREFIX}.${character ?? 'unknown'}`
}

/** The roster's identity for a target — matches how bossStatus.ts compares names. */
export function bossClearKey(targetName: string): string {
  return targetName.trim().toLowerCase()
}

/** Parse a raw localStorage string. Anything that is not a `{ string: number }` map degrades to {}. */
export function parseWeekClears(raw: string | null): WeekClears {
  if (raw == null) return {}
  try {
    const parsed: unknown = JSON.parse(raw)
    if (parsed == null || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
    const out: WeekClears = {}
    for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof v === 'number' && Number.isFinite(v)) out[k] = v
    }
    return out
  } catch {
    return {}
  }
}

export function serializeWeekClears(w: WeekClears): string {
  return JSON.stringify(w)
}

/**
 * Toggle one boss's base-rung mark. Absent -> set to `nowMs`; present -> removed. Returns a NEW
 * object; never mutates the input (useSyncExternalStore compares snapshots by identity).
 */
export function toggleWeekClear(w: WeekClears, key: string, nowMs: number): WeekClears {
  const next = { ...w }
  if (key in next) delete next[key]
  else next[key] = nowMs
  return next
}
```

- [ ] **Step 4: Add the three functions to `lockout.ts`**

In `src/renderer/src/features/bosses/lockout.ts`:

1. Extend the shared-kills import (line 32) to pull the two tier constants:

```typescript
import { DIFFICULTY_TIERS, TIER_OPEN_WORLD, TIER_UNKNOWN, isDifficultyTier } from '../../../../shared/kills'
```

2. Add `manual` to `LadderRung` (the interface at ~line 234):

```typescript
export interface LadderRung {
  /** instance difficulty tier (0 = base … 4 = Refined) */
  tier: number
  /** a credited kill at this difficulty landed inside the current week (or a live manual mark) */
  cleared: boolean
  /** when that kill landed (ms), or the manual mark's timestamp, or 0 when this rung is open */
  ts: number
  /** the d0 rung was marked cleared by hand rather than derived from a kill (test-visible; the
      draw is identical — see docs/plans/boss-lockout-credit-and-manual-clear.md section 2a) */
  manual?: boolean
}
```

3. Replace `tierLadder` (~line 252):

```typescript
export function tierLadder(locks: TierLock[], manualBaseTs?: number): LadderRung[] {
  const byTier = new Map(locks.map((l) => [l.tier, l.ts]))
  return DIFFICULTY_TIERS.map((tier) => {
    const lockTs = byTier.get(tier)
    if (lockTs !== undefined) return { tier, cleared: true, ts: lockTs }
    if (tier === 0 && manualBaseTs !== undefined) {
      return { tier, cleared: true, ts: manualBaseTs, manual: true }
    }
    return { tier, cleared: false, ts: 0 }
  })
}
```

4. Add, just after `tierLlocks` (~line 183):

```typescript
/**
 * Is there a credited kill of this target this week that the log could NOT tier — an open-world
 * (`TIER_OPEN_WORLD`) or unstated-zone (`TIER_UNKNOWN`) run whose most recent credited kill is
 * inside the current window? That is the evidence a manual base-rung mark is allowed to stand on:
 * you demonstrably killed this boss this week; the mark only adds "it was the base instance"
 * (section 2a). A real difficulty run is not ambiguous, and a stranger's uncredited open-world
 * kill is not yours.
 */
export function hasCreditedAmbiguousKill(
  tiers: Record<number, KillTierRun>,
  w: LockoutWindow
): boolean {
  for (const tier of [TIER_OPEN_WORLD, TIER_UNKNOWN]) {
    const run = tiers[tier]
    if (run && run.lastCreditedTs >= w.start && run.lastCreditedTs < w.next) return true
  }
  return false
}

/**
 * A manual base-rung mark counts only while it was made inside the CURRENT lockout week — the same
 * half-open Pacific week the rest of this file uses. It expires at reset with nothing to sweep:
 * the stored value is a timestamp, and `lockoutWindow` of it either names this week or it does not.
 */
export function manualClearIsLiveThisWeek(
  markedTs: number | undefined,
  w: LockoutWindow
): boolean {
  return markedTs !== undefined && lockoutWindow(markedTs).start === w.start
}
```

- [ ] **Step 5: Run the test and watch it pass**

```
node --import tsx --test tests/bossWeekClears.test.mts
```

Expected: PASS (all 12 tests).

- [ ] **Step 6: Typecheck and lint**

```
npm run typecheck && npm run lint
```

Expected: clean. (`tierLadder`'s existing one-arg call site in `BossSections.tsx` still
compiles — the second parameter is optional.)

- [ ] **Step 7: Commit**

```
git add src/renderer/src/features/bosses/weekClears.ts src/renderer/src/features/bosses/lockout.ts tests/bossWeekClears.test.mts
git commit -m "$(cat <<'EOF'
feat(bosses): the pure layer for a manual base-rung week clear

weekClears.ts owns the stored shape (one Date.now() per boss, per character)
and the one pure edit. lockout.ts gains: manualClearIsLiveThisWeek (a mark is
live only in the week it was made — expires at reset, no sweep),
hasCreditedAmbiguousKill (the gate: a credited open-world/unknown kill of this
boss this week), and a manualBaseTs arg to tierLadder that merges the mark as
an ordinary green d0 rung.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 4: The `useWeekClears` store — localStorage + character switch

**Files:**
- Create: `src/renderer/src/features/bosses/useWeekClears.ts`

**Interfaces:**
- Consumes: `weekClears.ts` (all exports); `LockoutWindow` + `manualClearIsLiveThisWeek`
  from `lockout.ts`; `window.eq.onCharacter` (`CharacterRef | null`).
- Produces:
  - `interface WeekClearsApi { liveBaseTs(bossKey: string, w: LockoutWindow): number | undefined; canToggle: boolean; toggle(bossKey: string): void }`
  - `function useWeekClears(): WeekClearsApi`
  - `liveBaseTs` returns the stored mark **only if** `manualClearIsLiveThisWeek` — i.e. it is
    exactly the value to hand `tierLadder` as `manualBaseTs`.
  - `canToggle` is false until the first `onCharacter` has named a character (a toggle before
    then would write to the `unknown` bucket).

- [ ] **Step 1: Create the store**

`src/renderer/src/features/bosses/useWeekClears.ts`:

```typescript
// useWeekClears — the manual base-rung clear as ONE module-scope store the whole Bosses view reads
// (the useFavorites.ts / useQuestFlags.ts shape: one store, useSyncExternalStore hands out one
// snapshot, a toggle re-emits). The pure half — the stored shape, the one edit, and "is this mark
// still live this week" — is weekClears.ts + lockout.ts; this file is only the localStorage plumbing
// and the character switch.
//
// A DIFFERENT CHARACTER IS A DIFFERENT LOCKOUT. Lockouts are per character, so the storage key is
// namespaced by `<name>_<server>` and the store re-reads on window.eq.onCharacter — the
// useWishlist.ts `watch()` pattern, subscribed once for the life of the window. Until the first
// onCharacter names a character, `canToggle` is false: a write before then would land in the
// `unknown` bucket and be invisible once the real character arrives.

import { useMemo, useSyncExternalStore } from 'react'
import type { LockoutWindow } from './lockout'
import { manualClearIsLiveThisWeek } from './lockout'
import {
  parseWeekClears,
  serializeWeekClears,
  toggleWeekClear,
  weekClearsStorageKey,
  type WeekClears
} from './weekClears'

export interface WeekClearsApi {
  /** the value to pass tierLadder as `manualBaseTs`: the mark, iff it is live for `w`. */
  liveBaseTs: (bossKey: string, w: LockoutWindow) => number | undefined
  /** false until a character is known — the affordance stays disabled. */
  canToggle: boolean
  /** flip this boss's d0 mark (stamps Date.now()). No-op while `canToggle` is false. */
  toggle: (bossKey: string) => void
}

interface Snapshot {
  clears: WeekClears
  character: string | null
}

let snapshot: Snapshot = { clears: {}, character: null }
const listeners = new Set<() => void>()
let watching = false

function read(character: string | null): WeekClears {
  try {
    return parseWeekClears(localStorage.getItem(weekClearsStorageKey(character)))
  } catch {
    return {}
  }
}

function emit(next: Snapshot): void {
  snapshot = next
  for (const l of [...listeners]) l()
}

function watch(): void {
  if (watching) return
  watching = true
  window.eq.onCharacter((c) => {
    const character = c ? `${c.name}_${c.server}` : null
    emit({ character, clears: read(character) })
  })
}

function subscribe(listener: () => void): () => void {
  watch()
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

function getSnapshot(): Snapshot {
  return snapshot
}

function write(next: WeekClears): void {
  snapshot = { ...snapshot, clears: next }
  try {
    localStorage.setItem(weekClearsStorageKey(snapshot.character), serializeWeekClears(next))
  } catch {
    /* a storage that won't take the write still updates the screen for this session */
  }
  for (const l of [...listeners]) l()
}

export function useWeekClears(): WeekClearsApi {
  const snap = useSyncExternalStore(subscribe, getSnapshot)
  return useMemo<WeekClearsApi>(
    () => ({
      canToggle: snap.character !== null,
      liveBaseTs: (bossKey, w) => {
        const ts = snap.clears[bossKey]
        return manualClearIsLiveThisWeek(ts, w) ? ts : undefined
      },
      toggle: (bossKey) => {
        if (snap.character === null) return
        write(toggleWeekClear(snap.clears, bossKey, Date.now()))
      }
    }),
    [snap]
  )
}
```

- [ ] **Step 2: Typecheck and lint**

```
npm run typecheck && npm run lint
```

Expected: clean. (No unit test — the storage half is covered by the e2e in Task 6, as
`useCombatPrefs.ts` is.)

- [ ] **Step 3: Commit**

```
git add src/renderer/src/features/bosses/useWeekClears.ts
git commit -m "$(cat <<'EOF'
feat(bosses): useWeekClears — the localStorage + character-switch store

The useFavorites/useQuestFlags module-store shape over weekClears.ts, keyed by
<name>_<server> and re-read on window.eq.onCharacter. `liveBaseTs` returns the
value tierLadder wants; `canToggle` gates the affordance until a character is
known.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 5: Wire the affordance into the ladder and the week view

**Files:**
- Modify: `src/renderer/src/features/bosses/DifficultyLadder.tsx`
- Modify: `src/renderer/src/features/bosses/BossSections.tsx`
- Modify: `src/renderer/src/features/bosses/BossView.tsx`

**Interfaces:**
- Consumes: `useWeekClears` (Task 4); `hasCreditedAmbiguousKill` (Task 3); `tierLadder`'s
  `manualBaseTs` arg (Task 3).
- Produces: the d0 rung renders a `data-can-mark="1"` attribute and toggles its mark on
  click when eligible; a manually-cleared rung carries `data-manual="1"`. The `week` view
  passes the per-card gate + toggle down; the `overall` view is untouched (no ladder).

- [ ] **Step 1: `DifficultyLadder.tsx` — the rung click + attributes**

Replace `Rung` and `DifficultyLadder` in
`src/renderer/src/features/bosses/DifficultyLadder.tsx` (keep the file header comment; add a
short paragraph to it noting the d0 rung is now clickable in the week view — see section 2a):

```typescript
import type { JSX, MouseEvent } from 'react'
import { Box, Stack } from '@mui/material'
import { rungTitle, type LadderRung } from './lockout'
import { tierStyle } from '../../lib/tierChip'

function Rung({
  rung,
  size,
  canMark,
  onMark
}: {
  rung: LadderRung
  size: number
  /** the base (d0) rung only, in the week view, when a credited open-world/unknown kill of this
      target landed this week (BossView computes it). */
  canMark?: boolean
  onMark?: () => void
}): JSX.Element {
  const label = tierStyle(rung.tier).label
  const clickable = canMark === true && onMark !== undefined
  return (
    <Box
      data-testid={`boss-rung-d${String(rung.tier)}`}
      data-cleared={rung.cleared ? '1' : '0'}
      data-manual={rung.manual ? '1' : undefined}
      data-can-mark={clickable ? '1' : undefined}
      title={
        rungTitle(rung) ??
        (clickable ? 'Click to mark this difficulty cleared this week' : undefined)
      }
      onClick={
        clickable
          ? (e: MouseEvent) => {
              // the card under it opens the mob page; a rung toggle must not.
              e.stopPropagation()
              onMark()
            }
          : undefined
      }
      sx={{
        flex: '1 1 0',
        minWidth: 0,
        height: size,
        lineHeight: `${String(size - 2)}px`,
        borderRadius: 0.5,
        border: '1px solid',
        borderColor: rung.cleared ? 'success.main' : 'divider',
        bgcolor: rung.cleared ? 'success.main' : 'transparent',
        color: rung.cleared ? 'background.default' : 'text.disabled',
        fontWeight: 700,
        fontSize: size > 15 ? 10 : 9,
        textAlign: 'center',
        letterSpacing: '-0.02em',
        userSelect: 'none',
        cursor: clickable ? 'pointer' : 'inherit',
        ...(clickable && !rung.cleared
          ? { borderStyle: 'dashed', '&:hover': { borderColor: 'success.main' } }
          : {})
      }}
    >
      {label}
    </Box>
  )
}

export default function DifficultyLadder({
  rungs,
  compact,
  canMarkBase,
  onToggleBase
}: {
  rungs: LadderRung[]
  compact: boolean
  /** week view only: the d0 rung may be hand-marked (BossView's gate). */
  canMarkBase?: boolean
  onToggleBase?: () => void
}): JSX.Element {
  return (
    <Stack
      data-testid="boss-difficulty-ladder"
      direction="row"
      spacing={0.25}
      sx={{ mt: 0.25, mb: 0.25 }}
    >
      {rungs.map((rung) => (
        <Rung
          key={rung.tier}
          rung={rung}
          size={compact ? 14 : 18}
          canMark={rung.tier === 0 ? canMarkBase : undefined}
          onMark={rung.tier === 0 ? onToggleBase : undefined}
        />
      ))}
    </Stack>
  )
}
```

Note: a cleared manual rung is a solid green rung (`rung.cleared` true) — the dashed border
only shows on an *open* clickable d0 rung, as an affordance hint, not as a "this is manual"
tell. Owner ruling 2: a cleared manual rung is drawn identically to a cleared derived one.

- [ ] **Step 2: `BossSections.tsx` — thread the two props through `Section` → `TargetCard`**

In `src/renderer/src/features/bosses/BossSections.tsx`:

1. `GridProps` (~line 353) gains an optional per-card manual-clear bundle:

```typescript
interface GridProps {
  compact: boolean
  minCol: number
  flashing: Set<string>
  onOpenMob: (t: MobTarget) => void
  lockOf?: (s: TargetStatus) => TierLock[]
  /**
   * WEEK VIEW ONLY. `baseTs(s)` is the live manual d0-clear timestamp for this target (or
   * undefined) — it goes straight into `tierLadder`. `canMarkBase(s)` is the gate (a credited
   * open-world/unknown kill this week). `onToggleBase(s)` flips the mark. Absent on OVERALL.
   */
  manualClear?: {
    baseTs: (s: TargetStatus) => number | undefined
    canMarkBase: (s: TargetStatus) => boolean
    onToggleBase: (s: TargetStatus) => void
  }
}
```

2. In `Section`'s `rows.map` (~line 398), pass them into `TargetCard`:

```typescript
        {rows.map((row) => (
          <TargetCard
            key={row.s.target.name}
            s={row.s}
            compact={compact}
            flash={flashing.has(row.s.target.name)}
            lock={lockOf?.(row.s)}
            ladder={
              lockOf &&
              tierLadder(lockOf(row.whole), manualClear?.baseTs(row.whole))
            }
            canMarkBase={manualClear?.canMarkBase(row.whole) ?? false}
            onToggleBase={manualClear ? () => manualClear.onToggleBase(row.whole) : undefined}
            onOpen={() => onOpenMob(mobTargetForStatus(row.whole))}
          />
        ))}
```

3. `TargetCard` (~line 298) accepts and forwards them:

```typescript
function TargetCard({
  s,
  compact,
  flash,
  lock,
  ladder,
  canMarkBase,
  onToggleBase,
  onOpen
}: {
  s: TargetStatus
  compact: boolean
  flash?: boolean
  lock?: TierLock[]
  ladder?: LadderRung[]
  canMarkBase?: boolean
  onToggleBase?: () => void
  onOpen: () => void
}): JSX.Element {
```

and pass to the caption:

```typescript
      <TargetCardCaption
        s={s}
        compact={compact}
        ladder={ladder}
        canMarkBase={canMarkBase}
        onToggleBase={onToggleBase}
      />
```

4. `TargetCardCaption` (~line 239) forwards to `DifficultyLadder`:

```typescript
function TargetCardCaption({
  s,
  compact,
  ladder,
  canMarkBase,
  onToggleBase
}: {
  s: TargetStatus
  compact: boolean
  ladder?: LadderRung[]
  canMarkBase?: boolean
  onToggleBase?: () => void
}): JSX.Element {
```

```typescript
      {ladder ? (
        <DifficultyLadder
          rungs={ladder}
          compact={compact}
          canMarkBase={canMarkBase}
          onToggleBase={onToggleBase}
        />
      ) : s.killed ? (
```

- [ ] **Step 3: `BossView.tsx` — build the `manualClear` bundle**

In `src/renderer/src/features/bosses/BossView.tsx`:

1. Imports:

```typescript
import { untilReset, hasCreditedAmbiguousKill } from './lockout'
import { useWeekClears } from './useWeekClears'
import { bossClearKey } from './weekClears'
```

2. After `const { week, lockOf } = useLockoutWeek(mode === 'week')` (~line 209):

```typescript
  const weekClears = useWeekClears()
  const manualClear = useMemo(
    () =>
      mode === 'week'
        ? {
            baseTs: (s: TargetStatus) => weekClears.liveBaseTs(bossClearKey(s.target.name), week),
            canMarkBase: (s: TargetStatus) =>
              weekClears.canToggle && hasCreditedAmbiguousKill(s.tiers, week),
            onToggleBase: (s: TargetStatus) => weekClears.toggle(bossClearKey(s.target.name))
          }
        : undefined,
    [mode, week, weekClears]
  )
```

3. Fold it into the `section` object (~line 246):

```typescript
  const section = {
    compact,
    minCol: compact ? 116 : 180,
    flashing,
    onOpenMob,
    ...(mode === 'week' ? { lockOf, manualClear } : {})
  }
```

- [ ] **Step 4: Typecheck and lint**

```
npm run typecheck && npm run lint
```

Expected: clean.

- [ ] **Step 5: Run the pure test again (nothing there should have moved)**

```
node --import tsx --test tests/bossWeekClears.test.mts
```

Expected: PASS.

- [ ] **Step 6: Commit**

```
git add src/renderer/src/features/bosses/DifficultyLadder.tsx src/renderer/src/features/bosses/BossSections.tsx src/renderer/src/features/bosses/BossView.tsx
git commit -m "$(cat <<'EOF'
feat(bosses): click the base rung to mark it cleared this week

Week view only. The d0 rung shows a dashed affordance when there is a credited
open-world/unknown kill of that target this week; clicking it toggles a manual
mark (useWeekClears). A marked rung draws as an ordinary green rung. The click
stops propagation so it does not open the mob page.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 6: e2e — the mark survives a restart

**Files:**
- Modify: `tests/e2e/bosses-week.e2e.mts`

**Interfaces:**
- Consumes: everything from Tasks 3–5. The `[data-testid="boss-rung-d0"]` element now
  carries `data-can-mark` / `data-manual` / `data-cleared`.
- Produces: coverage that a real click writes `localStorage` and that launch 2 (same
  userData dir, new process) still shows the rung green.

- [ ] **Step 1: Add the step**

In `tests/e2e/bosses-week.e2e.mts`, add near the other selectors (~line 126):

```typescript
const RUNG_D0 = '[data-testid="boss-rung-d0"]'
```

Add this function (after `stepLoadoutSectionsAreHonest`, before `stepArmRestart`):

```typescript
/**
 * THE MANUAL BASE-RUNG CLEAR (docs/plans/boss-lockout-credit-and-manual-clear.md section 2a).
 * The affordance is gated on a credited open-world/unknown kill of that target THIS week, which
 * — like every green rung in this spec — depends on the real clock over a fixed fixture, so the
 * step SKIPS cleanly when the owner's log has no eligible target this reset week rather than
 * asserting one exists. When it does fire, it proves the click writes through to localStorage;
 * `stepSurvivesRestart` then proves the write crossed a process boundary.
 */
async function stepManualClearPersists(page: Page): Promise<void> {
  const markable = page.locator(`${RUNG_D0}[data-can-mark="1"]`).first()
  if ((await markable.count()) === 0) {
    console.log('  (no target has a credited open-world kill this week — manual-clear step skipped)')
    return
  }
  await markable.click()
  const cleared = await settle(
    () => markable.getAttribute('data-cleared'),
    (v) => v === '1',
    { timeoutMs: 5_000 }
  )
  check('clicking an eligible d0 rung marks it cleared', cleared === '1', String(cleared))
  check('…and the rung reports it was a manual mark', (await markable.getAttribute('data-manual')) === '1')

  const keys = await page.evaluate(() =>
    Object.keys(localStorage).filter((k) => k.startsWith('eq.bosses.weekClears.'))
  )
  check('…and it wrote a per-character weekClears key', keys.length === 1, JSON.stringify(keys))
}
```

Call it in `main()`'s launch-1 block, between `stepLoadoutSectionsAreHonest(page)` and
`stepArmRestart(page)`:

```typescript
      await stepLoadoutSectionsAreHonest(page)
      await stepManualClearPersists(page)
      await stepArmRestart(page)
```

Extend `stepSurvivesRestart` with a tail check:

```typescript
  const ladders = await settle(() => countOf(page, LADDER), (n) => n > 0, { timeoutMs: 30_000 })
  check('…and the difficulty ladders are drawn on the tab it opened on', ladders > 0, String(ladders))

  // If launch 1 marked a rung, the write must have crossed the process boundary.
  const persistedKeys = await page.evaluate(() =>
    Object.keys(localStorage).filter((k) => k.startsWith('eq.bosses.weekClears.'))
  )
  if (persistedKeys.length > 0) {
    const stillMarked = await page.locator(`${RUNG_D0}[data-manual="1"]`).count()
    check('A MANUAL BASE-RUNG CLEAR SURVIVES A FULL RESTART', stillMarked > 0, String(stillMarked))
  }
```

- [ ] **Step 2: Run the e2e**

```
npm run test:e2e -- bosses-week
```

(This launches the real install and folds the owner's whole log twice — allow several
minutes. `EQ_E2E=1` shows no window.)

Expected: PASS. The new step either exercises a real click or logs the skip line; the
restart check is conditional on launch 1 having marked something.

- [ ] **Step 3: Run the full unit suite once**

```
npm test
```

Expected: PASS — no existing suite asserts the `DifficultyLadder` rung's attribute set or
the `tierLadder` arity in a way this changes.

- [ ] **Step 4: Commit**

```
git add tests/e2e/bosses-week.e2e.mts
git commit -m "$(cat <<'EOF'
test(e2e): a manual base-rung clear persists across a restart

Resilient: the affordance is clock-gated like every green rung in this spec, so
the step skips when the owner's log has no eligible target this week. When it
fires it proves the click writes a per-character weekClears key, and launch 2
proves the write crossed the process boundary.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

## Self-review

**Spec coverage:**
- §1 (regex misses `(with a bonus)`) → Task 1. §1a side effects need no code. → covered.
- §1 parity goldens are frozen → Task 2. → covered.
- §2a ruling 1 (d0 only) → Task 3 `tierLadder` (only `tier === 0` merges `manualBaseTs`);
  Task 5 `DifficultyLadder` (`canMark` only on `rung.tier === 0`). → covered.
- §2a ruling 2 (rendered identically) → Task 5 Step 1 note; a cleared manual rung hits the
  same `rung.cleared` branch; `rungTitle` unchanged so the tooltip is the same date shape. → covered.
- §2a ruling 3 (gated on a credited OW/unknown kill this week) → Task 3
  `hasCreditedAmbiguousKill` + Task 5 `BossView.canMarkBase`. → covered.
- §2a ruling 4 (per character, auto-expire at reset, no sync) → Task 3
  `manualClearIsLiveThisWeek` (week-scoped by timestamp), Task 4 `weekClearsStorageKey`
  (`<name>_<server>`) + `onCharacter` re-read. → covered.
- Persistence across restart → Task 6. → covered.

**Placeholder scan:** no TBD / "handle edge cases" / undefined references. Every code block
is complete. The `tsx` direct-run command and the `npm test` name-pattern are both given.

**Type consistency:**
- `WeekClears = Record<string, number>` — used consistently in `weekClears.ts`,
  `useWeekClears.ts`, and the test.
- `tierLadder(locks, manualBaseTs?)` — the new signature; both call sites
  (`BossSections.tsx`, the test) pass `number | undefined`; `LadderRung.manual?: boolean`
  is read in `DifficultyLadder.tsx` (`data-manual`) and asserted in the test.
- `hasCreditedAmbiguousKill(tiers, w)` / `manualClearIsLiveThisWeek(markedTs, w)` — same
  names in `lockout.ts`, `useWeekClears.ts`, `BossView.tsx`, and the test.
- `useWeekClears()` → `{ liveBaseTs, canToggle, toggle }` — `BossView.tsx` uses exactly
  those three.
- `bossClearKey` — defined in `weekClears.ts`, used in `BossView.tsx` and the test.
- `manualClear` bundle keys (`baseTs`, `canMarkBase`, `onToggleBase`) — identical in
  `GridProps`, `Section`, and `BossView`.
