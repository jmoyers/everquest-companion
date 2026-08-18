# Resist mining: per-mob resist profiles from the log

Status: research + API proposal (2026-08-16). Nothing implemented yet.

## 1. How resists work (what the engine has to model)

Source of truth for the Live formula is Torven's data analysis + Prathun's leaked pseudocode,
reproduced in EQEmu's `Mob::ResistSpell` (see the EQEmu forum thread "EverQuest Spell Resist
Data Analysis"). Legends runs the Live client/server, so this is the model until the log
contradicts it.

For a PC casting on an NPC:

```
levelMod   = sign(d) * d^2 / 2         d = mobLevel - casterLevel, clamped to >= -9
                                        (mob 21+ levels above the caster: immune, levelMod = 1000)
rc         = mobResist[axis] + levelMod + spell.resistAdj  (+ CHA term for charm/mez/lull lines)
roll       = 1..200
```

- All-or-nothing spells (mez, root, snare, slow, charm, DoTs, debuffs): lands iff `roll > rc`.
  So **P(resist) = rc / 200** for 0 <= rc <= 200; rc >= 200 is functional immunity.
- Direct damage: `roll > rc` -> full damage. Otherwise `partial = 150 * (rc - roll) / rc` percent
  resisted; `partial >= 100` (i.e. `roll <= rc/3`) prints the *resist message*, anything in
  between lands for reduced damage with NO message. So for a DD:
  **P(full damage) = (200 - rc)/200, P("resisted" message) = rc/600**, the rest are partials.
  200 <= rc < 600 is the partial-only band; rc >= 600 immune (why lures carry -300/-1000 adj).
- `resistAdj` is per spell and matters enormously: procs in this log run -150..-250 (Divine
  Might Strike -150, Lifetap Strike -200, Smiting Strike -250 -> 18,599 hits, 0 resists),
  Theft of Thought -1000, most nukes 0.
- Tash/Malo lines subtract from `mobResist[axis]` for their duration (Tashani -23 MR,
  Tashania -33 MR, Malaise -20 all four, Malaisement -40, Malosi -60, Malo -45; the effect slot
  is `50` = magic, `46/47/48/49` = fire/cold/poison/disease, `111` = all).
- Typical NPC baselines (Torven): ~25 MR/FR/CR under L25, ~35 at L25+, DR/PR ~15; specific
  mobs are tuned far above that (this log: imp protector FR ~ "70% resist", dracoliche DR 100%).
- Some spells carry a hard level cap (Mesmerization "up to L55", Charm "up to L37"): above the
  cap the target always resists, independent of rc. Those resists must NOT be filed as evidence
  of a high resist stat.

## 2. What the game log gives us (Legends, 2019+ Live message format)

| evidence | line | who it covers |
|---|---|---|
| your resist | `A zol ghoul knight resisted your Mesmerization!` | you -> mob |
| others' resist | `Gorgalosk resisted a thunder spirit's Choking!` / `Bazzt Zzzt resisted Bzzazzt's Deadly Poison!` | any caster (PC, pet, NPC) -> mob |
| incoming resist | `You resist Fright's Ghoul Root!` | mob -> you (YOUR resists, separate concern) |
| DD land + amount + axis | `You hit a lava guardian for 178 points of magic damage by Chaos Flux.` / `Dranix hit Lord Nagafen for 392 points of magic damage by Smiting Strike.` | any caster -> mob, damage type is printed |
| DoT ticks | `A revenant has taken 52 damage from your Discordant Mind.` | first tick after cast = landed |
| all-or-nothing land | cast-on-other emote (`Guard Hezlan glances nervously about.`, `X has been mesmerized.`, `X slows down.`) joined to `You begin casting X.` | you -> mob (others' emotes are also printed but not attributable to a caster) |
| mob level | `/con` prints `(Lvl: 39)`; catalog `mobs.json` has level or range | |
| caster level | `You have gained a level! Welcome to level 50!`, `/who` lines | you; groupmates via /who |
| debuff windows | `You begin casting Tashani.` + `<mob> glances nervously about.`, `<X> begins casting Malaisement.` | amount from spell data, duration 11 min or mob death |

Gotchas found in the log:
- Resist lines capitalise the article (`A zol ghoul knight resisted ...`) while damage lines
  don't (`You hit a zol ghoul knight ...`). Fold names case-insensitively on the article.
- Same-name mobs appear with `(7)`/`(8)` instance suffixes; `world.ts` already resolves those.
- Bard songs re-check per pulse, so one song = many resist checks; a resist per pulse is
  correct evidence but the land side has no per-pulse line, so songs need "pulses = ticks
  while target alive" as the denominator or should be modelled from resists only.
- The wiki-scraped `spells.json` has NO resist type / resist adjust. **The install ships
  `spells_us.txt`** (`<EQ root>/spells_us.txt`, ^-delimited, 173 fields, 73,963 rows incl.
  the Legends-only 74xxx ids like Smiting Strike / Scorching Arrow): field 29 = resist type
  (0 none, 1 magic, 2 fire, 3 cold, 4 poison, 5 disease, 6 chromatic, 7 prismatic, 8 physical,
  9 corruption), field 78 = resist adjust, field 8 cast ms, field 30 target type, fields 36-51
  class levels (WAR..BER), field 172 = effect slots `slot|effectId|base|limit|max|calc$...`.
  Ranked names (`Scorching Arrow IV`) fold to the base row via `spellCanonKey`.

## 3. Analysis of the owner's log (eqlog_Primitive_freeport.txt, Jul 19 - Aug 16, 2.0M lines)

Volume: 13,686 resist lines (3,253 `resisted your`), 25k own cast-begins, 45k others'
cast-begins, 61k spell-damage lines with a printed damage type. After joining, **~50k
attributable outcome observations** across **865 (mob, axis) cells** from one character in
four weeks. That is plenty of signal for a per-mob profile, and it is one player.

Raw resist rate by damage type (all casters, DDs only, n in parens) shows exactly the
structure you'd expect - it is not noise:

| mob | magic | fire | cold | poison | disease |
|---|---|---|---|---|---|
| an imp protector | 0% (1083) | **70%** (281) | 5% (275) | 9% (90) | 0% (30) |
| a lava guardian | 0% (376) | **75%** (106) | 8% (95) | 8% (24) | |
| Efreeti Lord Djarn | 0% (232) | **75%** (57) | 9% (46) | | |
| Lord Nagafen | 2% (730) | **52%** (50) | 20% (35) | 5% (108) | 36% (14) |
| a dracoliche | 1% (201) | 7% (30) | | | **100%** (75) |
| a loathling lich | 1% (342) | 2% (46) | 4% (24) | 16% (37) | **51%** (116) |
| Maestro of Rancor | 7% (486) | 13% (54) | **82%** (17) | 0% (18) | |
| Cazic-Thule | 0% (228) | 27% (26) | **67%** (21) | 0% (27) | 35% (81) |
| Gorgalosk (Sky) | **72%** (395) | 0% (21) | | **100%** (19) | |
| a soul harvester (Sky) | 51% (308) | 53% (15) | | 78% (59) | |
| a zol ghoul knight | 2% (1354) | 6% (227) | 5% (159) | 2% (153) | 8% (37) |

Caveat on the raw table: "magic 0%" is dominated by -250 procs; per-spell the same mob shows
Discordant Mind II ~50% resisted on Gorgalosk. Raw rate is spell-dependent - which is the whole
argument for modelling `resistAdj` out.

Model-based pass (own casts only, caster level tracked, mob level from the catalog, tash/malo
windows tracked, fixed-damage DDs use full/partial/resist, variable-damage procs use
resist-or-not, all-or-nothing use emote-land vs resist): the two independent evidence
families agree where both are well-populated, which is the validation that the Live formula
is the right model for Legends:

| mob (level) | R_magic from fixed DDs | R_magic from all-or-nothing | n |
|---|---|---|---|
| a zol ghoul knight (36-40) | 18 [14,26] | 8 [4,12] | 1679 |
| a dar ghoul knight (39-43) | 14 [2,20] | 6 [2,10] | 1379 |
| a rock golem (48-54) | 8 [-4,26] | -4 [-12,6] | 1247 |
| Lord Nagafen (55) | 140 [92,206] | 126 [110,144] | 600 |
| Cleric of Innoruuk (49) | 120 [108,138] | 66 [50,86] | 466 |
| a spite golem (51) | 248 [220,270] | 128 [110,152] | 269 |

Where they disagree (Baron Telyx 34 vs 118, Coercer T`vala 304 vs 232) the usual suspects are
mob level ranges, debuffs cast by groupmates that the demo did not track, mez level caps, and
the "Solo 4 (Refined)" instance variants possibly changing mob level. All are addressable in
the real engine; none of them break the approach. Demo scripts live in the session scratchpad
(`resist-analyze.mjs`, `resist-model.mjs`), not in the repo.

## 4. Engine design

Three layers, mirroring the message-overlay pattern already in the repo (frozen baseline +
per-source accreting overlay, verdicts derived never stored):

```
observations  (per log, per source bucket)   ->  cells (mob, axis) with sufficient stats
      ^                                          ->  estimate R[axis] + CI (derived, on demand)
      |                                          ->  predict P(land) for (spell, casterLevel, mob)
 fold from log events (existing parser)
```

### 4.1 Observation extraction (main, in the fold)

Reuse existing events; add one reconciler:

- `ResistEvent` (already parsed, target already captured) -> `outcome: 'resist'`.
- `DamageEvent` with `dclass` + spell (SPELL_RE) -> `outcome: 'full' | 'partial'` when the
  spell is fixed-damage at that caster level, else `'land'`. Fixed vs variable comes from
  spells_us effect slot 1 (`effectId 0`, calc 100/103 -> fixed; procs/Strikes -> variable)
  with an empirical fallback (mode share of the max value at that level >= 40%).
- New `CastReconciler`: `castBegin` (self) + within `castMs + 2.5s` either a resist line, an
  emote from `msgCastOnOther` (`buffLanding.ts` already knows which emotes entitle a landing
  claim), a DoT tick, or a damage line -> one observation per target. Fizzle/interrupt = no
  observation. Songs: resist per pulse; land = pulses while target alive (v2).
- Debuff windows: `castBegin`/`OTHER_CAST_BEGIN` of a resist-debuff + emote on target ->
  `debuff[mob][axis] = amount until +duration or death`. Amount from spells_us effect (with
  calc 101/102 level scaling), not from wiki text.
- Caster level: self from session state; groupmates from `/who` (parseWho) when known, else
  the observation is filed `casterLevel: null` and used only in raw counts.
- Mob level: `/con` `(Lvl: N)` when we have it for that mob (consider.ts), else catalog
  `mobs.json` level (range -> mid + width), else null (raw counts only).
- Caster kind: `self | pc | pet | npc` (catalog + article heuristic; NPC-vs-NPC is stored but
  excluded from the shipped baseline by default).

Observation shape (what gets counted; individual observations are NOT stored, only
sufficient statistics per cell - see 4.2):

```ts
type ResistAxis = 'magic' | 'fire' | 'cold' | 'poison' | 'disease' | 'chromatic' | 'prismatic' | 'corruption'
type Outcome = 'resist' | 'full' | 'partial' | 'land'
interface ResistObservation {
  ts: number
  mobKey: string          // article-folded, instance-stripped, lowercased
  zone?: string
  axis: ResistAxis
  spellKey: string        // spellCanonKey
  resistAdj: number       // from spells_us
  casterKind: 'self' | 'pc' | 'pet' | 'npc'
  casterLevel: number | null
  mobLevel: number | null // /con beats catalog beats null
  debuff: number          // active tash/malo amount on that axis at ts
  outcome: Outcome
  dmgFrac?: number        // partial: dmg / fullAtThisLevel
  levelCapped?: boolean   // spell has a level cap and mob is above it -> excluded from R
}
```

### 4.2 Storage: cells with sufficient statistics, per source bucket

The estimator only needs, per (mobKey, axis), a histogram over the *offset* the observation
was made under, because `rc = R + offset` where `offset = levelMod + resistAdj - debuff`.
Bucket offsets to 10 and store counts:

```ts
interface ResistCell {
  mobKey: string
  axis: ResistAxis
  // offsetBucket -> counts by evidence family
  aon:  Record<string, { land: number; resist: number }>
  ddFix: Record<string, { full: number; partial: number; resist: number; partialFracSum: number }>
  ddVar: Record<string, { land: number; resist: number }>
  spells: Record<string, number>          // spellKey -> n, for the UI ("evidence from ...")
  firstTs: number; lastTs: number
  zones: string[]
}
interface ResistLedger {
  schema: 1
  sources: Array<{ key: string /* character id or 'baseline' */; cells: ResistCell[] }>
}
```

Per-source buckets are what let a re-fold *replace* a log's contribution instead of
double-counting (the JOS-231 lesson from the message overlay). Cells are tiny (a few hundred
bytes) so a whole ledger is ~1 MB for the owner's log.

### 4.3 Estimation (pure, shared, on demand)

`estimateCell(cell) -> { R, lo, hi, n, immune?: boolean, families: {...} }`: grid MLE over R in
[-150, 600] with the three likelihoods from section 1 (aon: land iff roll > rc; ddFix: full /
partial / resist; ddVar: resist iff roll <= rc/3), profile-likelihood CI at delta-logL 1.92.
Beta-binomial shrinkage toward the Torven baseline prior for that mob level (25/35 MR/FR/CR,
15 DR/PR) so a 3-observation cell does not scream "immune". Merging baseline + overlay = sum
the histograms, estimate once - no per-source estimates to reconcile.

`predict({ R, casterLevel, mobLevel, spell, debuff }) -> { pLand, pFull, pResistMsg,
expectedDmgFrac }` inverts the same model - this is what the overlay/UI shows next to each
of the user's spells against the current target.

### 4.4 Freeze, ship, overlay

- **Freeze**: `scripts/gen-resist-baseline.ts` folds one or more logs (owner's + any
  contributed ledgers) into `src/main/data/resistBaseline.json` filed under
  `BASELINE_SOURCE`, gated to `casterKind in {self, pc}` and `n >= 5` per cell, imported
  (never `readFileSync`) so electron-vite inlines it. Same law as spells.json: the frozen
  file records observations only; conclusions (R, CI, "immune") are derived at load.
- **Ship**: bundled baseline + `spellResist.json` (resistType/resistAdj/castMs/effect slot 1
  for the ~2k Legends spells we care about, generated from spells_us.txt by
  `scripts/gen-spell-resist.ts`; do not read the 38 MB file at runtime).
- **Overlay**: `<userData>/resist-ledger.json` accretes the user's own logs per character
  bucket; the baseline is never written back. Cell view = baseline + user's buckets merged.
- **Contribute (later, opt-in)**: "export my resist ledger" writes the per-source cells file
  (mob names, spell names, counts - no chat, no character name beyond a hash) that the owner
  can fold into the next baseline. Consistent with the telemetry bright line: gameplay data
  never leaves a client automatically.

## 5. Proposed API

Main-side module `src/main/resist/` (fold + store), shared pure math in
`src/shared/resistModel.ts`, IPC under `resist:*`, renderer feature `features/resists/`.

```ts
// src/shared/resistModel.ts  (pure, tested against synthetic rolls)
export function levelMod(casterLevel: number, mobLevel: number): number
export function estimateCell(cell: ResistCell, prior?: ResistPrior): ResistEstimate
export function mergeCells(a: ResistCell, b: ResistCell): ResistCell
export function predict(input: {
  R: number; casterLevel: number; mobLevel: number; resistAdj: number; debuff?: number; kind: 'aon' | 'dd'
}): { pLand: number; pFull?: number; pResistMsg: number; expectedDmgFrac?: number }

// src/main/resist/spellResist.ts  (from generated spellResist.json)
export function spellResistInfo(spellKey: string): { axis: ResistAxis | 'none'; resistAdj: number; kind: 'aon' | 'ddFix' | 'ddVar'; levelCap?: number } | undefined

// src/main/resist/ledger.ts
export function foldObservation(ledger: ResistLedger, sourceKey: string, obs: ResistObservation): void
export function loadLedger(): ResistLedger            // userData overlay
export function saveLedger(l: ResistLedger): void      // debounced, atomic write, no BOM
export function baselineLedger(): ResistLedger         // bundled, read-only

// IPC (src/main/ipc/resist.ts) -> renderer
'resist:profile'   (mobKey)             -> MobResistProfile     // per axis: estimate + evidence + top spells
'resist:predict'   (mobKey, spellKeys[]) -> Array<{ spellKey; pLand; pFull; note }>  // uses current level + debuffs on that mob
'resist:search'    (query)               -> Array<{ mobKey; zones; axesSummary }>
'resist:cell'      (mobKey, axis)        -> ResistCell + estimate (evidence drilldown)
'resist:export'    ()                    -> path of the written per-source ledger
'resist:import'    (path)                -> { cellsAdded, sourcesReplaced }
'resist:reset'     (sourceKey)           -> void

interface MobResistProfile {
  mobKey: string; displayName: string; level?: { lo: number; hi: number; from: 'con' | 'catalog' }
  axes: Record<ResistAxis, { R: number; lo: number; hi: number; n: number; immune: boolean;
                             confidence: 'none' | 'thin' | 'ok' | 'solid'; fromBaseline: number; fromYou: number }>
  debuffsActive: Array<{ axis: ResistAxis; amount: number; spell: string; until: number }>
  bestAxis: ResistAxis | null       // lowest R with confidence >= 'ok'
}
```

Surfaces (depth-over-surface: hang these on existing places, no new top-level tab first):
1. Mob page (`features/mobs/MobPage.tsx`): a "Resists" card - per-axis bar with CI and n,
   evidence list ("Chaos Flux 155 casts, 17 resisted, 61 partial").
2. Combat/target context: for the current target, per-spell predicted land % for the spells
   in the user's loadout (this is the "should I nuke fire or cold" answer, and where
   tash/malo state visibly changes the number).
3. Zone view: heat table of mobs x axes for the current zone.

## 6. Decisions

- NPC-vs-NPC (charmed pet / NPC caster) evidence: ignored entirely (owner, 2026-08-16). Only
  `self` and `pc` casters are observed.
- CHA term: intentionally ignored (owner, 2026-08-16). Charm/mez/lull observations are filed
  like any other all-or-nothing spell; the bias (up to ~9 points of land chance either way)
  is accepted and documented, not modelled.
- Bard songs: reconstruct the denominator, conservatively (owner, 2026-08-16 - "make sure you
  can verify the song is running"). Rules, grounded in the log (pulse gaps between consecutive
  Largo's resists on one mob are 6, 12, 18, 24 s -> **pulse interval is 6 s**; `Your song
  ends.` and `A missed note brings X's <song> to a close!` exist but are rare, and starting
  another song does NOT end the previous one because bards twist, so "still singing" cannot
  be inferred from cast lines alone):
  1. A pulse of song S at time t is *witnessed* iff the log prints, at t (+-1 s), a resist
     line, a land emote, or a DoT tick for S on ANY target.
  2. Interior pulses at t+6k strictly between two witnessed pulses of S no more than 30 s
     apart are counted as having happened (the song demonstrably ran across the gap). Nothing
     is extrapolated before the first or after the last witness of a run; a `You begin
     singing S` inside the gap re-anchors and interior pulses before it are dropped.
  3. A pulse counts as an attempt against mob M only if M was alive and in melee contact with
     you inside the previous 6 s (M hit/missed you, or you melee-hit M) - melee proximity is the
     proxy for point-blank-AE range. Outcome = resist if the resist line names M at that pulse,
     otherwise land.
  4. Songs are their own evidence family (`song`) with their own counts in the ledger and the
     UI, so they can be excluded from `R` in one place if the numbers look wrong.
  Bias direction: rule 2 can over-count pulses only when the song stopped and restarted
  inside a <=30 s window without a `You begin singing` line, which the log shows no mechanism
  for; rule 3 under-counts attempts on ranged/rooted mobs (biases R up, i.e. toward "more
  resistant" - the safe direction).
- Confidence: simple count-based, no minimums at all for DISPLAY (owner, 2026-08-16, twice):
  always show the result - tag, R, interval, n - from n >= 1, with a quieter secondary caveat
  `low samples` under n = 10 (`LOW_SAMPLE_BELOW`); only n = 0 says `no data`. Never print "not
  enough data" in place of the answer. Why it is not merely a smaller threshold: the estimator
  is a likelihood over a prior, so it has an answer from n = 1, and what a thin cell produces
  is a WIDE INTERVAL - which is the honest display of thin evidence rather than a reason to
  hide it. The shipped baseline still drops rows under 5 observations at freeze
  (`scripts/gen-resist-baseline.ts`); that is a file-size rule, not a display rule. No
  CI-gated "advice" layer for v1. Landed in JOS-383, on both surfaces at once.
- NPC-on-NPC evidence (owner, 2026-08-16, revised): a switchable family, ON to start; the
  shipped default is decided by the measured player-vs-pet comparison on the owner's log
  (JOS-385). Worry to test: players' fire resisted where pets' fire is not, from pet tuning.
  **MEASURED, and the default is ON** (JOS-385, `npm run gen:resist-baseline -- --compare`):
  48 (mob, axis) cells where both populations put 20+ observations into the fit, 28 of them
  with disjoint 95% intervals, and **5 of the 28 (17.9%)** show the worry — fire/cold/poison/
  disease with R_npc at least 30 below R_pc. The decision rule the ticket set was "over a
  third ⇒ ship OFF". The worry case is real and rare (a fire giant warrior's fire reads 410
  from players against 110 from NPC casters) and is outnumbered four to one by the opposite
  direction: on 23 of the 28 flagged cells NPC casters are resisted the SAME or MORE (an
  azarack magic 56 vs 100, Lord Nagafen 106 vs 214, a thunder spirit 18 vs 56), which is the
  safe direction for a number a player acts on. The switch stays because the answer is the
  kind a patch can move, and it is read at ESTIMATE time so flipping it never costs a re-fold
  (`shared/resistPrefs.ts`, store key `resists.includeNpcCasters`, schema v14).
- A resist row's TARGET has to be a creature (JOS-385, discovered while adding the above): R is
  a statement about a creature, and nothing checked that the thing being cast ON was one. The
  first shipped baseline carried rows keyed `you` (Cannibalization damages its own caster), a
  groupmate's Superior Healing landing, and Jonthan's Provocation pulsing on five people —
  ~2,700 observations under 56 keys that are players, in a public file. `isMobTarget`
  (main/resist/world.ts) is the app's standing "is this a person" pair applied to every arm of
  the fold; the residual it accepts is the con card's, verbatim.
- Wiki overrides are app-wide (owner, 2026-08-16): a catalog correction (Largo's Melodic
  Binding prints "bound BY strands" on Legends) lives in `spellCorrectionsList*.ts`, never in a
  feature module (JOS-384).
- Own log beats the frozen baseline (owner, 2026-08-16, patch resilience): the baseline carries
  `frozenAt` + the spells_us.txt mtime it was mined against; per cell, baseline observations
  weigh `K/(K+nUser)` with K = 20, at `nUser >= 50` the user's data stands alone and the
  baseline is only a faded reference marker, and two well-populated (n >= 30 each) estimates
  with disjoint intervals raise a "differs from shipped data" note - the patch detector.
- Con card display (owner, 2026-08-16, after seeing it): the card sits at the TOP of the screen
  in the celebration band (it was covering the character), its window fits the card (no empty
  apron in either overlay mode), and it shows ONLY what the mob resists - axes tagged
  resistant / very resistant / nearly immune (R >= 45); weak, normal and no-data axes are not
  chips. One quiet "no notable resists" line when nothing qualifies. The mob page keeps the
  full five-row table (JOS-386).
- The tag is a benchmark, not an R band (owner, 2026-08-16 - SHIPPED in JOS-387). Two Legends
  mechanics entered the model with it: spell upgrade ranks are -15 resist adjust per rank (the
  Roman numeral in the log name; `Scorching Arrow IV` = -60) and the Overchannel invocation is
  -150 plus -15 per non-hybrid caster class on CAST spells (Legends wiki, Stances & Invocations,
  cached in the repo). Both ride the ROW, with the caster's class count, so a shipped observation
  is read at the offset it was MADE under. Then, per viewer level L: `rc0 = R + levelMod(L, mob)`,
  `pPlain = (200 - rc0)/200`, `pOver` the same at rc0 - 150.
  **THREE BANDS, READ TWO WAYS** (owner's final wording, same day): the scannable WORD stays
  weak / normal / resistant / very resistant and a GUIDANCE SENTENCE sits under it - `should land`
  (pPlain >= 60%), `needs overchannel`, `may not land even with overchannel` (pOver < 60%). Both
  percentages print under the sentence on every row and every chip, because the band answers the
  common case and the numbers let a reader answer theirs (a rank-10 spell is another -150, and
  tash, malo or the necromancer Scent line another 20 to 60). The player cap is 50 and Sky runs to
  70, so THE LEVEL TERM ALONE can put a creature in the top band; that is correct and intended.
  The con card keeps `resistant` + `very resistant`.
- The estimate is a POSTERIOR MEDIAN and the interval its central 95% (owner review, 2026-08-16 -
  JOS-387), because `P(resist) = rc/200` saturates and the old argmax reported the weakest edge of
  the resulting plateau (a dracoliche's disease read `R 60 (46-600) resistant` off thirty
  observations that were all resists). The prior became a broad Gaussian on R at the same time: the
  old pseudo-observation prior charges 22 log units to say "this mob resists everything", which was
  survivable while it only picked a point and is not now that it decides the interval too.
  Three guards sit on top of the model, and every threshold is measured against the shipped
  baseline rather than chosen: a HARD DATA RULE (10+ informative observations, 90%+ resisted =>
  the top band whatever the fit says); a PINNED-FIT GUARD (grid edge, or a residual that is both
  big - 15 points of resist rate - and certain - 4 sigma, or a whole credible interval below zero
  on a creature that demonstrably resists) which prints `does not fit the model: 62 of 118
  resisted` instead of a number and falls back to the raw rate on the con card; and a
  `from pets and other creatures only` caveat. Result: 3 of 598 non-empty cells refuse to print.
- **A DoT AND A PROC ARE ALL-OR-NOTHING** (JOS-387, found by the pinned-fit guard rather than by
  reasoning). Of 207 (spell, caster level) histograms with 20+ hits, 50 carry essentially no
  partials, and they are exactly the DoTs and the procs; the 157 that do run 14% to 20% partial.
  So a partial-free histogram means the spell lands or is refused and its damage lines are
  LANDINGS. Reading one as direct damage asks the fitter to explain 262 resists beside 86 hits and
  zero partials (a thunder spirit princess's Choking), which no rc can do.
- The full-damage reference is the BASE OF THE UPPER CLUSTER (owner, 2026-08-16 - JOS-387, refining
  JOS-385's mode): the largest value whose focus band `[v, 1.35v]` holds 60% of the (spell, level)
  histogram AND is the most common value inside that band. The mode rule gave up exactly where the
  owner plays - at level 50 his damage focus leaves Discordant Mind's base 394 at 6% of the
  histogram - and "the largest v covering 60%" alone answers 458, a number the game never computes.
  Measured: 394 at levels 43-50, Scorching Arrow 214 / 233 / 239 at 46 / 47 / 48-up. Informative n
  (spells with adjust > -100) still drives the low-samples caveat (JOS-385).
- **What `n` counts** (owner, 2026-08-16, off a live thunder spirit princess reading
  `R 58 (36-102) n=83 resistant` with no caveat): an observation only counts as evidence if the
  spell could have been resisted at all. `rc = R + levelMod + resistAdj`, so a -150/-200/-250 proc
  or a -300/-1000 lure is out of reach of any roll and its casts say only "R is not enormous".
  Those rows still enter the likelihood; they no longer inflate the count, no longer suppress the
  low-samples caveat, and no longer head the evidence list. The row prints both
  (`n=8 informative · 83 total`), the con card chip prints the informative one, the caveat keys off
  it, and an uninformative line says `cannot be resisted at this level: -250 adjust`. The threshold
  is `INFORMATIVE_RESIST_ADJ = -100` (shared/resistFormula.ts) and it is drawn where this log's own
  spells fall: procs at -150 and below, everything else at 0.
- **The full-damage reference is the MODE, never the max** (owner, same review): Live spell-damage
  focus effects roll a random bonus per cast, so the largest value a spell ever printed is a
  focused roll and every ordinary full hit sits below it — read as a partial, which invents
  resistance out of an item the player is wearing. The reference is the mode of the (spell,
  casterLevel) histogram pooled over EVERY mob in the ledger, a hit at or above 0.97 x mode is
  full, and a (spell, level) whose top value holds under 40% of the histogram is treated as
  variable damage for that level (shared/resistDamage.ts). MEASURED: Discordant Mind is 394 at
  levels 43-49 (78-93% of each level's hits) and unreadable at 50, where the owner's focus item
  spreads the same spell across 449-528 and leaves the base at 6%; Scorching Arrow reads 214 / 233
  / 239 at levels 46 / 47 / 48-up, which are the game's own tiers. Cost of the fix, on the shipped
  baseline: a zol ghoul knight's cold falls from R 60 [40,84] to R 26 [10,50] as 23 partials become
  5, and the "provably cold-resistant" claim that stood on them is withdrawn.
- **Recent evidence weighs more** (owner, 2026-08-16 - SHIPPED in JOS-397; its second half removed
  the same day by JOS-400, see the end of this bullet).

  THE WEIGHT. Rows carry the ISO WEEK they were observed in, in the pooling key (schema 3; a
  schema-2 row pooled its counts across weeks and nothing can un-pool them, so the bump is a
  re-fold, which this app does from the log every launch). Each term then weighs
  `w = max(0.15, 0.5 ^ (ageDays / 21))`, aged in whole weeks from the NEWEST OBSERVATION THE
  LEDGER HOLDS rather than from the wall clock - a paused log must not decay itself, or a player
  who stops for three months returns to doubled intervals having learned nothing new. Half-life
  21 days because patches land weeks apart; floor 0.15 because history fades and does not vanish,
  and because a weight decaying to zero would silently delete the whole shipped baseline after a
  month of play, which is not the same statement as "your own log outweighs it". It MULTIPLIES
  JOS-382's `K/(K + nUser)` rather than replacing it: a shipped observation that is both
  out-voted and old pays for both. Counts are untouched - `n`, the low-samples caveat and the
  hard data rule still speak in observations a player could count themselves. Cost, measured on
  the owner's 2.08M-line log: the resist module goes 0.94 -> 0.99 us/event (10.6% -> 10.8% of the
  fold), of which most of the week key's own share is recovered by a one-entry memo.

  THE SHIPPED BASELINE IS AGED FROM `frozenAt`, and its rows do not carry a week at all. The file
  is a snapshot rather than a diary (its timestamps have been stripped since JOS-382), so the
  freeze RE-POOLS the fold's week buckets onto that one week and the store fills the value back in
  from the stamp as the file is read. MEASURED, and it is why the re-pool is not optional: pooled,
  4,016 rows carrying 59,987 observations clear the five-observation floor; left split by their
  real weeks, 4,164 rows carrying 58,368 do - a bigger file that knows less. Omitting the field
  saves 80 kB of one repeated string.

  THE DECAY ABOVE IS ALL OF IT, AND IT STAYS AS DESCRIBED: recent evidence weighs more inside the
  one formula, with every modifier - rank, overchannel, debuffs - still applied.

  THE RUN DETECTOR THAT SHIPPED BESIDE IT WAS REMOVED THE SAME DAY (owner ruling, JOS-400). It
  tracked orthogonal outcomes without the modifiers and printed a second verdict - a `lately` line
  and a `lately resistant` word - next to the real one, which is a verdict outside the formula. The
  ring, the `lately` fields on the profile and the con-card wire, and the third route onto the card
  all went with it; a card says one thing about a creature.
- Presentation: **no acronyms**. Every axis is shown as its word (magic, fire, cold, poison,
  disease) with a stable colour per axis; the colour and the word always appear together.

## 7. Roadmap (owner, 2026-08-16)

1. Answer the open questions, then build the library (sections 4-5): spellResist.json from
   spells_us.txt, fold + ledger + estimator + predict, baseline freeze script, IPC.
2. First surface: the mob listing / mob page inside the app (Resists card, per-axis, scannable).
3. Then the con tooltip: on `/con` of a creature, show an alerts-overlay-style card at top
   centre of the screen, tooltip-shaped, semi-transparent, closable, ON by default, toggle in
   preferences. Content: resists (visually scannable at a glance - per-axis chips/bars, colour
   for weak/neutral/resistant/unknown), drops, other useful mob facts (level from con,
   respawn, zone). Reuses the alerts overlay plumbing (`consider.ts` already parses con lines).
