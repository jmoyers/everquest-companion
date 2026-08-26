# Gear progression planner — a level route with exp zones and gear targets

Design doc. Library-first: one learned con-band table in `src/shared`, one pure plan fold in
`src/shared/planner`, one new renderer surface in the gear area, and one seeding door into the
wish list that already exists. Status: **DONE — shipped on this branch** (implementation-time
addenda are marked inline; see §0.3, §2.1, §5).

Grounded in a read-only sweep of the real log on this machine
(`…\EverQuest Legends\Logs\eqlog_Drywrought_oggok.txt`, 134,695 lines, 2026-08-15) and the
current source. Directed by the fork user (kaltinril); the ask, near-verbatim: *when finding the
best gear for me I need a progression tree — Crushbone for the first N levels, Mistmoore,
Splitpaw… based on the 3 classes someone wants and the target (dps, tank, healer) — and when to
grind +0 for exp vs +4 areas for gear, because +4 is harder so we need the creatures to be blue
and white solo.*

---

## 0. What is actually stated, measured before designing

Four findings that shape everything below.

**0.1 The log's consider lines carry the game's OWN difficulty verdict beside the mob's stated
level.** 102 lines matching `(Lvl: N)` in this log, every one shaped
`<mob> - … - <faction phrase> -- <difficulty phrase> (Lvl: N)`. The difficulty phrase census:

| phrase (stem) | count |
|---|---|
| what would you like your tombstone to say? | 23 |
| You could probably win this fight. | 23 |
| looks kind of dangerous. | 17 |
| looks like quite a gamble. | 15 |
| it/she/he appears to be quite formidable. | 14 |
| You would probably win this fight… it's not certain though. | 5 |
| looks like it/she would wipe the floor with you! | 4 |
| looks kind of risky… you might win. | 1 |

The parser already keeps these (`consider` module; `ConsiderRow.level` is the stated `Lvl: N`),
and `shared/considerFaction.ts` already splits phrase from faction. **Nothing anywhere maps
(my level, mob level) → difficulty** — `considerFaction.ts` says so in as many words. So the con
model this feature needs is LEARNABLE from pairs the log states, and must be learned rather than
imported: classic-EQ con tables are lore about a different game, and this server's bands are
whatever its own consider lines say they are.

**0.2 The mob catalog states mob levels as strings and knows NOTHING about +N.** 7,872
`MobEntry` rows; `level` is the wiki's own string (`"52"`, `"9-12"`, `"2 - 4"`, `"~53"`, ~90
shapes — `mobZone.ts sortLevel` documents the parse rule: first digit run is the low end). Zero
entries whose name carries `+N`. The plus world exists only in the ITEM PAGES' `|dropsfrom`
witnesses (`GearRow.wikiSources`), where zone spellings like `Timorous Deep +4` and mob
spellings like `Ixiblat Fer +5` appear — names, not levels.

**0.3 This log has considered zero +N mobs and entered zero +N zones** — *as the WIKI spells
them.* `\+\d+ \(Lvl:` → 0 matches; `You have entered .*\+\d` → 0 matches. **CORRECTED at
implementation time (2026-08-15): the game spells the tier differently.** The log HAS entered
tiered zones — `You have entered Temple of Cazic-Thule 4 (Refined).`, `The Ruins of Old Guk 3
(Fused)`, `Kerra Isle 4 (Refined)`, `Toxxulia Forest 1 (Awakened)` — i.e. `<base> <N>
(<TierWord>)`, where the wiki writes `<base> +N`. Tier words measured so far: 1 = Awakened,
3 = Fused, 4 = Refined; tier 2's word is unstated, so `plusSuffix` matches the parenthesized
form generically, never a closed tier-word list. And the 26 considers made INSIDE those zones
fit the same measured diff table as the base-zone considers (§0.1 addendum below) — the consider
verdict tracks the mob's STATED level even in a tiered zone. What remains unmeasured is
unchanged: the CATALOG states no level for any +N mob, so a +N gear target still has no stated
level to con (§3 stands).

**0.4 Everything else the feature needs already stands.** Current level:
`shared/currentLevel.ts` + `useStatedLevel` (who/ding statements, staleness against the log
clock). Class trio: `useGearClasses` (detection + pin). Era: `plannerData.eraHides` /
`shared/planner/era.ts zoneEra`. Zone identity: `shared/zones.ts` (names, aliases, era — no
level ranges, and it says so). Gear worth: `gearBisValue`/`gearEffectiveDamage` with
`GearDerivedOpts` (haste knob, class gate) — **on the `gear-tab-improvements` branch (PR #31),
not yet on main**. Route rendering and seeding: `plannerFarm.groupNeeds` + `useWishlist.add`.

---

## 1. What the surface answers

One question, per level bracket, for a class trio and a role: **"where should I be, and what am
I there FOR?"** Rendered as an ordered route:

> **12–18 · Crushbone** — exp (most camp mobs read even/easy through this bracket)
> worth grabbing here: *Dwarven Ringmail Tunic* (a hill giant, Lvl 16, even) · +2 more
> **18–24 · Unrest** — exp · **Mistmoore** — gear runs: *Cloak of the Ancients* (…)
> [Add this bracket's targets to the wish list]

It is a PLANNER, not an optimizer: no drop rates exist to optimize over (the census's standing
caveat), so the route ranks zones by what their mobs' stated levels read at the bracket, and
items by the role-weighted worth score. Both derivations are labeled.

---

## 2. Data model

### 2.1 `src/shared/conBands.ts` — the learned difficulty bands (NEW, pure)

The mapping from level difference to the game's verdict, LEARNED from this machine's own
consider history and shipped with a measured seed.

```ts
export type ConBand = 'trivial' | 'safe' | 'even' | 'risky' | 'deadly'
/** phrase stem → band, the game's own words folded to five bands (census in the header) */
export function bandOfPhrase(difficulty: string): ConBand | null
/** (myLevel, mobLevel) → band, from the SEED_BANDS diff table */
export function conBand(myLevel: number, mobLevel: number): ConBand
/** the seed: [minDiff, maxDiff] per band, derived at plan time from the 102 pairs below */
export const SEED_BANDS: readonly { band: ConBand; minDiff: number; maxDiff: number }[]
```

Wave 1's FIRST task is the derivation the seed ships from: replay this log's consider lines
through the existing parser (the consider fixtures' extractor pattern), pair each phrase with
`mobLevel − myLevelAtThatTs` (my level from the ding/who series the character module already
folds), and pin the resulting diff table in a unit test against the extracted fixture. The 102
samples cluster on a level-38 avatar considered at several own-levels, so the executor must
REPORT the diff spread it actually finds — if the pairs are too clustered to bound five bands,
ship fewer bands honestly (`even` / `risky` / `deadly` may be all this log supports) and leave
the finer bounds as awaiting-sample entries, exactly like the weapon-type census does.

“Blue and white solo” in the ask maps to `safe`/`even`. A GROUP loosens the gate one band —
an option, not a guess (§8).

**Addendum (2026-08-15, the derivation ran):** 103 consider lines; 3 dings (42→44) anchor 53
pairable considers; the 50 before the first level statement feed the phrase census only. The
per-phrase (mobLevel − myLevel) table came out MONOTONIC once English intuition was dropped —
"looks kind of dangerous" (−11..−6) is MILDER than "quite formidable" (−5..−2); "quite a
gamble" sits at exactly 0; "wipe the floor" at +1..+2; "tombstone" at +7 and up; the two
"probably win" stems below −13. One censored outlier: "looks kind of risky... you might win"
measured once at −33 (a guard stated Lvl 10 vs own 43) — contradicts every neighbor, so
`bandOfPhrase` returns null for it until a second sample. The five ConBands land as:
trivial = "could probably win", safe = "would probably win" + "dangerous",
even = "formidable" + "gamble", risky = "wipe the floor", deadly = "tombstone".

### 2.2 Zone level profile — derived, per zone, from stated mob levels (NEW, pure)

```ts
/** in shared/planner or renderer lib beside mobZone.ts, whichever the executor finds cheaper */
export interface ZoneLevels { zone: string; low: number; median: number; sampled: number }
export function zoneLevelProfile(catalog: readonly MobEntry[]): Map<string, ZoneLevels>
```

Low end of each mob's level string (the `sortLevel` rule, promoted out of its private corner),
folded per catalog zone. `sampled` is carried so the UI can say “from N stated mob levels” —
this is a DERIVED profile and every surface labels it so (`shared/zones.ts` refused to invent
zone ranges; this does not invent them either, it folds stated ones).

### 2.3 Role weights — a third knob on the derived scores

```ts
// as shipped (shared/planner/roleWeights.ts) — the four of the first design, the six the owner asked
// for on 2026-08-15 and 2026-08-22
export type GearRole =
  | 'balanced' | 'tank' | 'healer' | 'dps'
  | 'dps1h' | 'dps2h' | 'dualwield' | 'range'
  | 'dd' | 'dot'
export interface RoleContext { ownedHaste?: number; classes?: readonly ClassAbbr[] }
export function roleValue(stats: GearStats, role: GearRole, ctx?: RoleContext): number
```

The first design put `role` on `gearBisValue`'s `GearDerivedOpts` (tank: AC/EHP up, EFF-DMG down;
dps: inverse; healer: mana/WIS/regen up) and depended on PR #31's `gearScale.ts` — see §5 for why
the standalone `roleValue` is what shipped. Same one-place weights table, same heuristic honesty
clause.

**Haste is an afterthought (owner ruling, 2026-08-22).** Worn haste does not stack, so
`roleValue` credits an item's haste only ABOVE `ctx.ownedHaste`. With nothing owned the full
percentage counts — the first haste item is a real upgrade; beside a 36% sword a 9% glove scores its
haste at 0. A stated haste PENALTY scores as one — only the positive margin is clamped.
**And the number is per slot, on both sides of the gap test (corrected 2026-08-25).**
`PlanCorpora.ownedHaste` is the list of owned haste SOURCES with the slots each fits
(`OwnedHaste[]`, folded from the EQUIPPED set in `planOwned.ts` — owner, 2026-08-25: *"haste should only
be EQUIPPED items"*; a haste blade in the bank is not haste you have), and the fold reads it through
`ownedHasteOutside(sources, slot)` — the best haste you would still own with that slot swapped out.
The haste weapon's own bar therefore keeps full credit for its haste and so does anything offered
for that slot, which is what lets a strictly better haste weapon clear the bar while a hasteless one
with a slightly better ratio does not. Rule 12 in `progressionPlan.ts`; pinned in
`tests/progressionPlanRuns.test.mts` §2b-2c and `tests/planOwned.test.mts`.

**The score is focus × class (owner rulings, 2026-08-22 — "stats need to be weighted based on the
type of focus" and "build a grid").** `roleWeights.ts` is two layers. LAYER 1, the focus
(`ROLE_WEIGHTS`): what a stat is worth to somebody playing this way, one column per `GearRole`,
with an abstract `manaStat` row in place of INT/WIS (no row may name either — pinned). LAYER 2,
the class (`CLASS_FACTS`): which attribute is a class's mana (INT / WIS / none), and whether CHA,
BACKSTAB and endurance do anything for it. `roleValue(stats, role, { ownedHaste, classes })`
credits a gated stat only when some picked class can use it; an empty trio gates nothing (law 1).
The melee focuses share one profile except the two-hander's damage bonus (4 vs 3, it scales with
delay) and backstab (absent on `dps2h`). Rule 13 in `progressionPlan.ts`; pinned in
`tests/roleWeightsClassGate.test.mts`.

**Ranged (owner, 2026-08-22 — "bows and rock and stuff").** A tenth role, `range`: DEX 2 (the
archery/throwing accuracy stat), STR 0.8, haste 2, otherwise the melee profile; its weapon policy
takes only bows and throwing weapons in the RANGE slot (`weapon-ranged`, off `weaponType.ts`'s
RANGED category) and leaves both hands open. Pinned in `tests/planRolePolicy.test.mts`.

### 2.4 `src/shared/planner/progressionPlan.ts` — the fold (NEW, pure)

```ts
// as shipped
export interface PlanInputs {
  level: number
  classes: readonly ClassAbbr[]
  role: GearRole
  reach: 'solo' | 'group'           // the con CEILING: solo = up to even, group = up to risky
  eraOnly: boolean
  bracketSize?: number              // default 6
}
export interface GearTarget {
  key: string; name: string; iconId?: number
  zone: string; plus: number | null          // the BASE zone and the tier the witness named
  mob: string; mobPage?: string              // the base mob spelling, and the page as linked
  mobLevel: number | null; band: ConBand | null
  score: number; wished: boolean
}
export interface GearRun { zone: string; plus: number | null; band: ConBand | null; targets: GearTarget[] }
export interface PlanBracket { from: number; to: number; expZones: ZonePick[]; runs: GearRun[]; targets: GearTarget[] }
export function buildProgressionPlan(inputs: PlanInputs, corpora: PlanCorpora): PlanBracket[]
// …and the two halves it composes, so the renderer can memoize the scoring apart from the wish list:
export function candidatePool(scope: PlanScope, corpora: PlanCorpora): PlanCandidate[]
export function routeFromPool(inputs: PlanInputs, corpora: PlanCorpora, pool: readonly PlanCandidate[], wished: ReadonlySet<string>): PlanBracket[]
```

Brackets of 6 levels from the current level until the corpus runs out (a data-driven horizon, with
a seven-bracket backstop — rule 4). Per bracket: exp zones = zones whose profile median reads
`safe` or `even` at the bracket midpoint (`trivial` pays no exp; a positive `out-of-era` is
dropped), ranked by how close the median sits to the midpoint; targets = role-scored era-legal
items the trio can wear that beat the owned bar somewhere they fit, whose drop mob's stated level
cons at or under the reach ceiling anywhere in the bracket — excluded when owned, FLAGGED when
wished (rule 9) — grouped zone-first into `runs` (rule 7) with the flat `targets` kept as the pool
assertion. `PlanCorpora` is handed in (gear rows, catalog profiles, a mob-level lookup, the con
function, the owned set and bars, the owned haste sources) so the fold stays node-testable with
synthetic corpora.

---

## 3. The +N (Refined) zones — stated vs unknown

What is STATED: an item page can name `<zone> +N` / `<mob> +N` as a drop source, and the base
zone resolves era and profile by stripping the suffix (one exported `plusSuffix(name)` helper —
the spelling rule in one place). What is NOT stated anywhere yet: what level a `+N` mob
effectively is. **v1 therefore shows +N targets with `band: null`, rendered as “difficulty
unstated”, gated only by the base zone's era** — a plan that printed “blue at 19” for a +4 mob
would be a fabricated number. The measurement door: the day this (or any) log considers a `+N`
mob, its line carries `(Lvl: N)` like every other, `conBands`' extractor picks it up, and the
offset rule becomes a measured fact with a fixture. §0.3 is the awaiting-sample row.

---

## 4. Renderer — the `Recommended` tab in the gear area

Fifth tab beside Gear / Exaltations / Character / Wish list (the ask is gear planning; the
Leveling tab is observed history and should stay that). Designed as "Plan"; LABELLED
**Recommended** by the owner on 2026-08-22 — the view id `plan`, the `eq.plan.*` keys and every
`plan-*` testid are unchanged (`appViews.ts VIEW_LABELS`). One view:

- header controls: role picker (persisted, `eq.plan.role`), reach toggle (solo/group,
  `eq.plan.reach`), era chip (the shared `useEraOnly`), and the detected class trio with the
  same pin gesture the Gear tab uses; under them one paragraph saying what the pick looks for
  (`planBlurb.ts`, owner ask 2026-08-22);
- the level comes from `useStatedLevel` with its cue/title (stale level shows its age, never a
  silent guess);
- bracket cards down the page, each with exp zones and its RUNS as a responsive grid of tiles
  (`PlanRunTile.tsx`; zone-first, rule 7), each target with icon, name → loot drill-down and the
  Gear tab's hover comparison, mob + level + band chip, and the Gear row's own `WishToggle`; plus
  one `Add N to wish list` button per bracket → `useWishlist.add(wishFromGear(...))` per target,
  deduped by the document itself;
- NOT windowed, measured rather than assumed: the fold caps a bracket at 4 exp chips and 6 runs of
  3, and the route at seven brackets, so the page is bounded by construction and lives in its own
  scroller. The page never scrolls sideways.

---

## 5. Dependencies and branch base

`role` extends `GearDerivedOpts`, which exists only on `gear-tab-improvements` (PR #31). The
implementation branch therefore bases on that branch (or on main after #31 merges) — **this plan
doc rides its own branch off main** so the design can be reviewed independently. If #31 is
rejected, §2.3 falls back to a standalone `roleValue(stats, role)` in the new plan fold and
nothing else here changes.

**Decision (2026-08-15): the fallback IS the implementation.** The user directed the feature
onto its own branch off main, so `roleValue(stats, role)` lives in `progressionPlan.ts` and
`gearScale.ts` is untouched. If #31 merges later, folding `role` into `GearDerivedOpts` is a
contained refactor. A second decoupling taken at the same time: `buildProgressionPlan` takes the
con function INJECTED via `PlanCorpora` (`con: (my, mob) => ConBand`) rather than importing
`conBand` — production wires the real one, tests hand in a synthetic table.

## 6. Fixtures and tests

- `tests/extract-consider-pairs.mjs` (the extract-* pattern): real log → golden window of
  (phrase, mobLvl, myLvl) pairs; `tests/conBands.test.mts` pins the derived diff table and the
  phrase fold, and goes red the day a new phrase spelling appears (awaiting-sample law).
- `tests/progressionPlan.test.mts`: synthetic corpora — bracket cutting, the con gate both ways
  (solo excludes `risky`, group admits it), era exclusion, +N `band: null`, ownership exclusion,
  role re-ranking (a tank plan and a dps plan order two synthetic items oppositely), the horizon.
  `tests/progressionPlanRuns.test.mts`: the gap test, the wish flag, the haste rule, runs.
  `tests/planRolePolicy.test.mts` and `tests/roleWeightsClassGate.test.mts`: the weapon policy and
  the class gate. `tests/planOwned.test.mts`: the owned side (two sets, one haste rule).
- `tests/zoneLevelProfile.test.mts`: the level-string fold over real catalog rows, `sampled`
  counts, the null-level row.
- e2e: its own spec, `tests/e2e/plan.e2e.mts` (no `planSteps.mts` — the gear e2e host was not
  extended): tab mounts, the unstated-level empty state, a ding written into the tailed log opens
  the first bracket at that level, runs render zone-first, the bracket button lands rows on the
  Wish list tab and they stay flagged, a row's own wish control toggles, the hover comparison
  pair opens, the loot deep link and its Back.

## 7. Wave plan

- **Wave 1 — shared model + extraction (no renderer).** `conBands.ts` + extractor + fixture,
  `zoneLevelProfile`, `plusSuffix`, `progressionPlan.ts`, all unit tests. Gate: typecheck +
  lint + new suites green; executor REPORTS the measured diff table before the seed is pinned.
- **Wave 2 — role weights.** `GearRole` into `gearScale.ts`/`derivedOpts` (on the PR #31 base),
  weight profiles + tests beside `gearDerivedScores.test.mts`. Small; may ride with Wave 1 if
  the base question (§5) is settled first.
- **Wave 3 — renderer.** The Plan tab, prefs, wishlist seeding, e2e step. Gate: full unit suite
  no worse than base, gear + plan e2e green.

Waves own disjoint files; measured numbers here (102 lines, 7,872 mobs, phrase counts) are
planning-time facts executors re-derive fresh (AGENTS.md: plans go stale while agents fly).

## 8. Open questions / deliberate non-goals

- **Reach default** — solo (the ask's own words) with the group toggle beside it; flag for the
  user if they mostly duo.
- **Bracket width 6** — a first guess; the fold takes it as an input so tuning is a constant.
- **Non-goals:** no drop-rate claims (none exist), no camp timers, no gold/plat costing, no
  multi-character plans, no promise about +N difficulty until a log states one (§3), and no
  second wish-list-like document — the plan SEEDS the wish list, it does not replace it.
