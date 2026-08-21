// buffTimers.ts — THE HONESTY LAW OF THE BUFFS/TIMER OVERLAY (JOS-89), as a pure function.
//
// docs/plans/buff-timer-overlay.md is the design record. The one rule that decides every pixel
// on that surface:
//
//   A duration spells.json STATES becomes a receding countdown.
//   A duration nobody states becomes ELAPSED time counting UP.
//   There is no third case, and an invented "remaining" is never displayed.
//
// It lives here — no Electron, no React, and no clock of its own (`nowMs` is an argument) —
// so a test can drive real fixture bytes through the real parser and the real modules and
// assert the rows a user would actually see.
//
// THE ESTIMATOR (JOS-117) — one definition, this surface AND the Buffs tab. This surface counts
// down from `overlayDurationMs`, which the buffs model fills (buffsView.ts `overlayDurationOf`)
// from the SAME estimator the tab's estimate column uses (buffsStats.ts `estimateFor`):
//   overlayDurationMs = max( DB baseline , max-over-recent-window of clean observed samples )
//   (permanent → null, and no-floor-no-sample → null → count UP.)
// The DB base is a FLOOR: a beneficial buff's true duration is never below it (AA/focus only
// EXTEND), so a below-base observation is an early termination (click-off / dispel / overwrite) and
// the max discards it — the floor holds (Invisibility: DB 20m, observed max 4m ⇒ 20m). A sample
// ABOVE the base is a real extension and WINS (Swift Like the Wind: DB 16m, observed 36m ⇒ 36m).
// This REPLACES JOS-114's most-recent-sample overlay rule, which trusted whatever cast faded last:
// a buff clicked off early minted a short "worn off" sample INDISTINGUISHABLE from a natural expiry
// and became the overlay's number (the owner saw Swift at ~28m for a 33:36 buff). The max over the
// window ignores the click-off; the window (not all-time) lets a removed focus age out so a genuine
// decrease recovers. Trusting a sample is SAFE because of the CLEAN-SAMPLE rule: one is minted ONLY
// from a genuine wear-off (buffsInstances.recordFade → addSample); a zone, death, offline gap,
// entity retirement or hygiene sweep clears the instance WITHOUT minting, an offline-spanned span is
// dropped, and a re-land RESETS the open cast's landedTs so a refresh mints one clean full cycle,
// never an inflated land→fade span. `estimatedMs`/`durationSource` are the tab's own copies of the
// same numbers; this surface reads `overlayDurationMs`/`overlaySource`.
//
// JOS-212 RELAXED THE FLOOR IN EXACTLY ONE PLACE, and this surface inherits it: a below-floor
// observation overrules the DB base when the log corroborates it (three clean cycles in the window
// whose top three agree within 10% — buffsStats.ts `estimateFor`). The bar then counts down from
// what the player's own casts measured and `source` reads 'cluster'. Invisibility, the floor's own
// counterexample, scatters and keeps its 20m.
//
// JOS-379 ADDED A SOURCE THIS SURFACE INHERITS AND DOES NOT PRINT, which is worth stating so the
// absence reads as a ruling. A DEATH BOUND — a debuffed mob that died with no wear-off ever printed
// — lifts the estimator to a proven FLOOR under the real duration and reports source 'deathBound'.
// The bar counts down from it exactly as from any other number, which is the honest behaviour: it
// is the best claim the log supports, and it is the one that stopped the early-warning alert from
// announcing a slow that was still on the mob. The "at least" QUALIFIER is not on this surface,
// because JOS-358 removed row hovers from the timer windows by owner ruling — a bar over a game is
// a glance, and the sentence lives where a reader can act on it (the Buffs tab's estimate cell and
// the active-buff row, which prefix the figure with `≥`). `BuffTimerRow` carries no `source` field
// at all today; adding one to spell a qualifier no pixel would show would be the wrong half of it.
//
// JOS-118 EXTENDS THAT RULE IN TWO PLACES, both for the same reason — only OUR OWN cast under OUR
// OWN modifiers is a duration we are entitled to learn from. (1) An instance now opens only from a
// LANDING line, so a cast that was resisted (or simply never confirmed) mints nothing, where the
// old optimistic cast-timing path could open one on a target it had merely inferred. (2) A sample
// requires an EXACT (spell, entity) chain: `recordFade` no longer falls back to the oldest open
// cast of the same spell on a DIFFERENT entity, which used to measure a slow on mob B against the
// older landing on mob A and hand the MAX estimator a span that is too long.
//
// JOS-140 FINISHED THE JOB: THE MEZ HOLDS TAKE THIS PATH TOO. Until then the per-target mez/root
// holds (main/modules/buffTimers.ts, projected by `ccRow` below) stayed DB-STATED, on the argument
// that their end line — `Your <mez> spell has worn off of <mob>.` — prints identically whether the
// mez ran its course or a nuke broke it early (tests/fixtures/w10-cazic-slow.log: 2 s and 18 s
// break lines under one 24 s cast), so no sample could be trusted. That argument was right about
// the censoring and wrong about the conclusion: the MAX estimator is chosen precisely because
// early terminations read SHORT and never lift it. What was actually missing was a rule for
// deciding WHICH landing a wear-off closed, and the count-and-close rule (main/modules/
// buffRounds.ts) is it. So the CC holds now mint into the same learner and read the same
// estimator, keyed on (spell line, caster) — which is what took a reporter's Mesmerization VII bar
// from the base rank's 24 s to the 44 s their own log proves.

import type { ActiveBuff, BuffsSnap, EstimatorSource } from './buffTypes'
// THE ALLOW-LIST (JOS-168). A value import, and relative like every other value import in this
// file's neighbourhood, so the node tests can drive `filterAllowedRows` under tsx. The preference's
// own vocabulary — the tri-state, the mode, and what an unset line means — lives THERE; what lives
// here is only the mapping from a ROW to the line key it is about, which is a fact about rows.
import { buffAllowAllowed, buffAllowIsDefault, type BuffAllowPrefs } from './buffAllow'
// Type-only: `shared/types.ts` is a value module (OVERLAY_KINDS) and this one is imported by the
// node tests as a pure module, so the reference is erased at compile time and nothing follows it.
import type { OverlayConfig, OverlayKind } from './types'

// ----- the two TIMER SURFACES (JOS-119) -----

/**
 * The two overlay kinds this projection feeds. Their vocabulary lives HERE rather than in
 * `shared/types.ts` (which is at its factoring ceiling) so that the rule deciding which window a
 * row belongs to sits beside the function that builds the rows — one file, one answer.
 */
export type TimerOverlayKind = Extract<OverlayKind, 'buffs' | 'debuffs'>

/** True for the two timer-bar kinds: they read the same modules and render the same component. */
export function isTimerOverlayKind(kind: OverlayKind): kind is TimerOverlayKind {
  return kind === 'buffs' || kind === 'debuffs'
}

/**
 * HOW A TIMER WINDOW ARRANGES ITS ROWS (JOS-140, owner amendment 2026-08-09 from live testing).
 *
 *   'none'   — ONE FLAT LIST, soonest to expire at the top, across every target. This is what a
 *              player watching a chain-mez actually reads: the next thing to break is the next
 *              thing they must act on, and which mob it is on is a detail on the row.
 *   'target' — self rows first, then one contiguous block per target (world-model law 4's
 *              presentation order). What both windows did before this.
 *
 * The DEFAULT differs per window and is deliberate: the DEBUFFS window opens flat, because it is
 * a queue of things running out; the BUFFS window keeps its blocks, because "what is on me" and
 * "what is on my pet" are separate questions read at separate moments and the owner did not ask
 * for that to change. Either window can be set to either, per kind, in its own footer.
 */
export type TimerGrouping = 'none' | 'target'

/** A stored/patched grouping, or null when it is absent and the surface's own default applies. */
export function normalizeTimerGrouping(raw: unknown): TimerGrouping | null {
  return raw === 'none' || raw === 'target' ? raw : null
}

/**
 * THE KNOBS ONLY THE TWO TIMER WINDOWS CARRY, rebuilt in place on the way into the store — the row
 * arrangement (JOS-140) and the permanent-buff switch (JOS-215).
 *
 * It lives HERE rather than in `main/store.ts` for the same reason `isTimerOverlayKind` does: which
 * kinds carry a timer knob is a fact about this surface, not about persistence, and store.ts's own
 * rule is that each knob is validated by the module that owns its meaning. (store.ts is also at its
 * complexity and line ceilings, which is what made the question worth asking.)
 *
 * BOTH ARE REBUILT RATHER THAN TRUSTED — the argument store.ts makes about the drill: a renderer
 * patch must not be able to widen what is persisted. And for both, an ABSENT value is a real
 * answer: "the window's own default" for the arrangement (which differs between buffs and debuffs
 * — see {@link TimerGrouping}), and "hidden" for the permanent rows (which does not).
 *
 * The permanent switch is stored ONLY when TRUE, so an absent key and a stored `false` are not two
 * spellings of one answer. `=== true` rather than a cast, so a hand-edited `"true"` or `1` is off.
 */
export function applyTimerOverlayKnobs(kind: OverlayKind, cfg: OverlayConfig): void {
  const timer = isTimerOverlayKind(kind)
  const grouping = normalizeTimerGrouping(cfg.grouping)
  if (grouping && timer) cfg.grouping = grouping
  else delete cfg.grouping
  if (cfg.showPermanent === true && timer) cfg.showPermanent = true
  else delete cfg.showPermanent
}

// ----- the CC half's state (owned by main/modules/buffTimers.ts, rendered by the overlay) -----

/**
 * A crowd-control HOLD on one mob: the per-target mez/root entry the chain-mez reports asked
 * for. Keyed by mob, so casting one AE mez that lands on four enemies produces four of these.
 */
export interface CcHold {
  /** Canonical mob key (idKey) — the entity half of the identity. */
  key: string
  /** The mob's display name, raw from the log (world-model law 2: canonicalize at boundaries). */
  target: string
  /**
   * Event ts (ms) of the OLDEST landing in this hold — the one the next anonymous wear-off will
   * close, and therefore the honest clock for a row that stands for `count` of them. NOT a wall
   * clock — see the note on BuffTimerRow.startedTs.
   */
  startedTs: number
  /**
   * The spell — the RANKED name from the cast line (`Mesmerization VII`) — when the anchors
   * narrowed the landing sentence's candidates to exactly ONE. Absent when they did not, in which
   * case `candidates` is the honest answer and this row is a family, not a name (JOS-84).
   */
  spell?: string
  /**
   * Every spell the landing sentence could be, display casing, sorted for stability. Empty only
   * when no spell DB was installed. Carried even when `spell` resolved, so a consumer can say
   * what was ruled out.
   */
  candidates: string[]
  /**
   * The duration in ms the bar draws, or null when none can be stated.
   *
   * SINCE JOS-140 THIS IS THE SHARED ESTIMATOR, not a DB row: max(DB floor, this caster's recent
   * observed max) — the same number the buff rows have counted down from since JOS-117. A
   * resolved hold reads it under (spell line, caster); an unresolved FAMILY still states a number
   * only when every candidate agrees on one, because there is no line to look a learned value up
   * under. `source` says which won.
   */
  durationMs: number | null
  /** Where `durationMs` came from — see {@link EstimatorSource}. */
  source?: EstimatorSource
  /**
   * HOW MANY MOBS OF THAT NAME are holding this spell (ruling 7). Absent for the ordinary one.
   * EQ prints no instance identifier and stamps to the second, so an AE round landing on five
   * mobs called `a wan ghoul knight` is five byte-identical lines: the model keeps a landing each
   * and draws ONE row with a chip, rather than five rows with five identical clocks.
   */
  count?: number
  /** The allowlisted external who cast it; absent for your own (shared/buffTrust.ts). */
  caster?: string
}

/**
 * A hold that ENDED, and how. Kept briefly so the projection can also retire a matching
 * `ActiveBuff` the buffs model does not clear (see §1.5/§3.3 of the plan) and so the overlay can
 * flash a drop.
 */
export interface CcEnd {
  key: string
  /** The spell named by the break line, when it named one. */
  spell?: string
  ts: number
}

/** The `buffTimers` module's whole state — small, so it ships entire on every flush. */
export interface BuffTimersSnap {
  holds: CcHold[]
  ends: CcEnd[]
}
export type BuffTimersDelta = BuffTimersSnap

// ----- the rows -----

/**
 * How a row's time is read.
 *   'countdown'  — spells.json STATES a duration: a receding bar, `durationMs` present.
 *   'elapsed'    — nobody states one: time counts UP from the landing, `durationMs` absent.
 *   'permanent'  — a self-cast illusion under the Permanent Illusion AA: no timer at all.
 */
export type TimerMode = 'countdown' | 'elapsed' | 'permanent'

export interface BuffTimerRow {
  /** Stable across ticks so React keys and e2e selectors do not churn. */
  id: string
  kind: 'buff' | 'debuff' | 'cc'
  /**
   * The resolved spell name, or the candidate names joined when the sentence is shared.
   *
   * For a buff/debuff row this is `ActiveBuff.spell` — the DB's own name since JOS-238, where it
   * used to be whatever the cast line spelled. A CC hold's is still the ranked name off its cast
   * line, and the difference is deliberate rather than an oversight: nothing downstream of a hold
   * matches on the string (it emits no `buffExpired`), and JOS-126 asked for the rank to be
   * visible on exactly those rows.
   */
  name: string
  /**
   * DISPLAY ONLY: the ranked text the cast line spelled, when a buff row's identity came from a
   * cast anchor and the two differ (JOS-238, `ActiveBuff.castName`). Never an identity — `name`
   * is, and `id` is built from `name` alone.
   */
  castName?: string
  /** Present only when the row is a FAMILY: every spell the line could be (JOS-84). */
  candidates?: string[]
  /** True when `name` is a family rather than a spell — drives the `~` chip. */
  ambiguous?: true
  /** Self buffs render first, then one group per target (world-model law 4: presentation only). */
  group: 'self' | 'target'
  target?: string
  targetKey?: string
  /** True when `target` is the model's INFERENCE, never a name a sentence stated. */
  inferredTarget?: true
  /**
   * The event ts the instance landed. NOT A WALL CLOCK: `BuffInstances.onOfflinePause` shifts a
   * BUFF's forward by an absence (EQ pauses buff timers while you are camped — measured), so
   * elapsed and remaining are the only honest readings and this must never be printed as a time
   * of day. A DEBUFF's is never shifted (the world keeps running while you are out of it —
   * JOS-134), which means the two kinds of row do not share one clock and a reading that
   * compares them to each other rather than to `Date.now()` would be comparing two of them.
   */
  startedTs: number
  /**
   * True when the spell CALMS its target — the calm/lull line (JOS-213). Carried straight from
   * `ActiveBuff.calmsTarget`, which main fills from the DB roster, and it is the ONE reason a
   * `kind: 'buff'` row belongs to the debuffs window. See `timerRowSurface`.
   *
   * Present only on the rows projected from an `ActiveBuff`. A CC hold needs none — a hold is
   * already a mob-state timer and routes by kind alone.
   */
  calmsTarget?: true
  mode: TimerMode
  /** ONLY on 'countdown', and ONLY a number the shared estimator stated (JOS-117/JOS-140). */
  durationMs?: number
  /**
   * How many entities of this row's display name are holding it (JOS-140 ruling 7). Absent for
   * the ordinary one; 2+ draws the count chip. `startedTs` is then the OLDEST of them.
   */
  count?: number
  /** The allowlisted external who cast it; absent for your own (shared/buffTrust.ts). */
  caster?: string
}

/**
 * WHICH WINDOW A ROW BELONGS TO (JOS-119) — the whole split, as one pure function.
 *
 * The owner asked for two windows he can enable and place separately, NOT for two models: one
 * source (`buildTimerRows` above) is folded once and each surface keeps the rows that are its
 * subject. The first discriminator is the row's own `kind`, which the model already carries:
 *
 *   'buff'            → the BUFFS window. A beneficial spell you have running. `group` is NOT the
 *                       discriminator here: a Symbol on your pet and a Valor on the cleric you
 *                       buffed are `group: 'target'` and are still BUFFS — routing them by target
 *                       would file your own group buffs under "debuffs", which is a lie about what
 *                       they are.
 *   'debuff' | 'cc'   → the DEBUFFS window. What you have put ON something else: a slow, a snare,
 *                       a mez hold. The owner rules mez and slow ARE debuffs, so the CC holds live
 *                       here beside them rather than in a third place.
 *
 * …AND A BENEFICIAL SPELL WHOSE EFFECT IS ON AN ENEMY IS A MOB TIMER (JOS-213, report
 * 01KZSDPV3NV8NWK2GF01MCQMK3: `You begin casting Pacify IV.` / `an icy terror looks less
 * aggressive.`). The calm line — Pacify, Soothe, Calm, Lull and the rest of the family — is
 * `Beneficial` in the committed spells.json, so `cls` is 'buff' and `kind` is 'buff', and the
 * aggro clock the player is watching landed in the window that shows their own Clarity. Every
 * other mob-state timer lives on the debuffs surface, which is where a player looks to see how
 * long that giant stays calm. `calmsTarget` is the one exception to the kind, and it is a fact
 * about the SPELL: main fills it from a roster spells.json's landing messages DERIVE
 * (`data/spellDb.ts spellCalmsTarget`, which carries the family and the audit).
 *
 * IT IS NOT A TARGET TEST, AND THAT IS THE WHOLE LESSON OF THE FIRST CUT. "Route it when the
 * target is a mob" is the obvious reading of the report and it is the mistake JOS-136/JOS-140
 * ruling 8 already outlawed one level down: an ally is a named target and so is a mob, the game
 * does not distinguish them in a landing sentence, and `disposition: 'hostile'` means only "not
 * you and not a pet I am currently holding". Two committed goldens went red under a disposition
 * test and both are real users' shapes — a `Resist Disease` from a Quick Buff burst on a spider
 * the model was not holding as a pet, and the owner's own `Valor` on a charmed fire giant warrior
 * whose charm line falls outside the window. A friendly buff on somebody the model has lost track
 * of must never become a debuff. Nothing here reads `group`, `target` or `disposition`.
 *
 * …AND SINCE JOS-413 THE CALM LINE REACHES THIS WINDOW ON ITS KIND, NOT ON THE EXCEPTION. Report
 * 6BM6Y5 named the inconsistency the JOS-213 split left behind: this function called a Pacify a
 * debuffs row while the Buffs SECTION, which groups on `cls`, still listed it under Buffs. The owner
 * ruled (2026-08-19) that a lull IS a debuff, so `spellCorrectionsPolarity.ts` overrules the wiki's
 * type column in the registry and `kind` is 'debuff' for the whole family — the first branch below
 * now answers these rows before the exception is consulted.
 *
 * THE EXCEPTION STAYS, and deleting it would be the mistake. It is derived from the landing
 * sentences and audited every run (`tests/calmLineTimers.test.mts`), it is the guard that caught the
 * first cut of JOS-213 sending a real `Valor` and a real `Resist Disease` here, and it is still the
 * right answer for a calm-line spell the polarity ruling has no row for. What changed is that it is
 * no longer carrying the routing alone.
 *
 * Exhaustive over `BuffTimerRow['kind']` by construction — a new row kind has to choose a window.
 */
export function timerRowSurface(row: BuffTimerRow): TimerOverlayKind {
  return row.kind === 'buff' && row.calmsTarget !== true ? 'buffs' : 'debuffs'
}

/** The rows one timer surface shows. Order is `buildTimerRows`' order, filtered — never re-sorted. */
export function rowsForSurface(rows: readonly BuffTimerRow[], kind: TimerOverlayKind): BuffTimerRow[] {
  return rows.filter((r) => timerRowSurface(r) === kind)
}

/**
 * THE PERMANENT ROWS, HIDDEN BY DEFAULT (JOS-215, owner ruling) — a DISPLAY filter, and the only
 * thing in this file that removes a row for a reason the model does not believe.
 *
 * WHY IT IS HIDDEN. A permanent buff has no clock (`timerModeOf` gives it `mode: 'permanent'` and
 * no duration at all), so it can never be the thing a timer window is watched for, and
 * `compareRows` already ranks it last for exactly that reason. Admitting 62 spells' worth of them
 * — a cleric's Yaulp and Divine Purpose and Instrument of Nife all at once — would push the
 * countdowns that matter off the top of a small floating window. So the window opens on the timers
 * and the roster is one press away.
 *
 * WHY IT IS IN THE RENDERER AND NOT THE MODEL, which is the half a future reader is most likely to
 * be tempted by. The model has to keep these rows whatever the window draws: the hygiene sweep
 * exempts them, a wears-off line clears them, a death strips them, and `BuffsSnap.active` is what
 * the Buffs TAB, the alerts module and any later surface read. A preference that reached into
 * `buffs.active` would be a window's opinion deleting evidence from everybody else's model — the
 * mistake JOS-203 states at length about dismissals. Same rule here: there is no channel for the
 * model to hear about it.
 *
 * It is applied BEFORE ordering and dismissal so everything downstream — the header count, the
 * groups, the drop flash — is talking about what is actually on screen.
 */
export function filterPermanentRows(rows: readonly BuffTimerRow[], showPermanent: boolean): BuffTimerRow[] {
  return showPermanent ? [...rows] : rows.filter((r) => r.mode !== 'permanent')
}

/**
 * THE SPELL LINES ONE ROW IS ABOUT (JOS-168) — usually one, and more only when the row is a FAMILY.
 *
 * A row whose landing sentence was shared carries `candidates` and its `name` is those names joined
 * with ` / ` (see `ccRow`), which is not a spell line and would key nothing. So a family asks about
 * every spell it could be. Everything else asks about its own name, folded the same way its `id`
 * already is.
 */
function rowAllowKeys(row: BuffTimerRow): string[] {
  return row.candidates && row.candidates.length > 0
    ? row.candidates.map(timerNameKey)
    : [timerNameKey(row.name)]
}

/**
 * THE ALLOW-LIST, AS A DISPLAY FILTER OVER THE TWO TIMER WINDOWS (JOS-168, owner ask 2026-08-16) —
 * the second thing in this file that removes a row for a reason the model does not believe, and it
 * sits beside `filterPermanentRows` because it is the same KIND of thing and obeys the same law.
 *
 * WHAT DECIDES: `shared/buffAllow.ts`, one function (`buffAllowAllowed`) over one tri-state and one
 * mode. What decides HERE is only which key a row is about — see `rowAllowKeys`.
 *
 * A FAMILY IS KEPT WHEN ANY OF ITS CANDIDATES MAY DRAW, and that is the honest reading rather than
 * a lenient one: the row stands for a sentence the log printed that could be any of four spells
 * (JOS-84), so denying one member of the family has not denied the thing on screen. The user who
 * wants it gone denies the ones it could be, or turns opt-in on and checks nothing.
 *
 * WHY IT IS IN THE RENDERER AND NOT THE MODEL — verbatim the argument `filterPermanentRows` makes
 * one function up, and it is the half a future reader is most likely to be tempted by. The model
 * keeps these instances whatever a window draws: the Buffs TAB lists them (that is where the
 * checkboxes are, so a filtered tab would hide the control that unfilters it), the alerts module
 * reads them, the learner mints durations off them, and the tab's header chip reports what the
 * model believes. A preference that reached into `buffs.active` would be one window's opinion
 * deleting evidence from everybody else's model.
 *
 * Applied BEFORE ordering and dismissal, like the permanent filter, so everything downstream — the
 * header count, the groups, the drop flash — is talking about what is actually on screen.
 */
export function filterAllowedRows(rows: readonly BuffTimerRow[], prefs: BuffAllowPrefs): BuffTimerRow[] {
  // NOTHING SAID, SHIPPED MODE ⇒ EVERY ROW, and not merely as an optimization: it is the statement
  // that this feature is invisible until somebody uses it.
  if (buffAllowIsDefault(prefs)) return [...rows]
  return rows.filter((r) => rowAllowKeys(r).some((k) => buffAllowAllowed(prefs, k)))
}

/** One "… dropped" notice: the row that left, and the words the overlay says about it. */
export interface TimerDrop {
  id: string
  name: string
}

/**
 * WHAT A DROP NOTICE IS ALLOWED TO SAY — the buffs window's flash, as a pure function.
 *
 * THE LABEL CARRIES THE TARGET, and that is not decoration: the SAME buff can be up on you and on
 * your pet at once, so a notice that printed only the spell would show two identical lines for two
 * genuinely different drops.
 */
export function timerDropLabel(row: BuffTimerRow): string {
  return row.group === 'self' ? row.name : `${row.name} · ${row.target ?? '?'}`
}

/**
 * The BUFFS-WINDOW rows that were there a moment ago and are not there now.
 *
 * The claim is deliberately the weakest one available: a drop is a removal the MODEL already
 * believed (a wears-off message, a death, a zone), so this can never announce a drop the log did
 * not state. `prev === null` is the first reading and reports nothing — otherwise an empty
 * hydrate would announce itself as N drops.
 *
 * `rebuilt` IS THE OTHER HALF OF THAT, AND IT IS WHY THIS IS A FUNCTION (JOS-172). Since the
 * rebuilt-world signal reaches the overlay windows, a row set can now change for a reason that is
 * not a drop at all: main re-folded this character's whole history and the window re-hydrated. On
 * a COLD START with the overlay already open, the first hydrate happens PART-WAY through the fold
 * and the second one lands after it, so rows legitimately disappear between them — a buff that was
 * up in the middle of the log and had worn off by its end. Announcing those would be the window
 * shouting about spells that dropped months ago, the first time the user ever sees it. A rebuild
 * adopts the new set as the baseline and says nothing; the very next real removal still flashes.
 *
 * THE SUBJECT IS THE BUFFS SURFACE, NOT THE 'buff' KIND (JOS-213). The two were the same set until
 * a Pacify became a `kind: 'buff'` row on the DEBUFFS window. Reading the kind would hand the
 * debuffs window a "positive spell dropped" flash it has never had and nobody asked for — the ask
 * this answers was always "flash when a positive spell drops", a buffs-window feature — so it
 * routes through `timerRowSurface` instead, which is a no-op for every row that existed before.
 */
export function timerDrops(
  prev: readonly BuffTimerRow[] | null,
  current: readonly BuffTimerRow[],
  opts: { rebuilt: boolean }
): TimerDrop[] {
  if (prev === null || opts.rebuilt) return []
  const onBuffs = (r: BuffTimerRow): boolean => timerRowSurface(r) === 'buffs'
  const live = new Set(current.filter(onBuffs).map((r) => r.id))
  return prev.filter((r) => onBuffs(r) && !live.has(r.id)).map((r) => ({ id: r.id, name: timerDropLabel(r) }))
}

// ----- DISMISSAL: a display verdict, and structurally nothing else (JOS-203) -----

/**
 * WHAT A DISMISSAL IS — AND WHAT IT STRUCTURALLY CANNOT BE (JOS-203, owner law).
 *
 * The report that opened the ticket (01KZQ6QAWKX8W6VNTKFRP69NZ5) asks for "some method to manually
 * clear buffs/debuffs", and names the case: a debuff on a mob you kill OUT OF LOG RANGE prints no
 * death line, so nothing in the world ever states that it ended and the row serves its whole stated
 * duration plus grace — up to twelve minutes of a bar sorting above the ones that are real.
 *
 * THE ANSWER IS A DISPLAY VERDICT AND NEVER A MODEL EVENT. Dismissing a row censors no instance,
 * closes no landing, mints and refuses no duration sample, and retires no learning record. IT
 * CANNOT: a dismissal is renderer state held by the overlay window that drew the bar, and no part
 * of it is ever sent to main. The learner does not ignore it — the learner has no way to hear about
 * it, because there is no path for it to travel. A player who clears a slow bar at 0s and then
 * walks back into range still teaches the model everything that slow's wear-off has to teach
 * (`BuffInstances.recordFade` pairs against the OPEN record, which the display never touches, and
 * which now retires on the learning-record schedule — main/modules/buffsShapes.ts
 * `learningRecordCapMs`).
 *
 * A VERDICT NAMES ONE READING OF ONE ROW, NOT THE ROW FOREVER. It carries the row's `id`, its
 * `startedTs` and its `count`, and it suppresses only a row that is still that reading or older.
 * That is what makes "a bar you dismiss stays dismissed" survive every delta and every re-hydrate
 * (both replace the whole row set, and the verdict is re-applied to the new one) while a FRESH
 * LANDING draws again: a new landing moves the clock, and another mob of that name joining the
 * group moves the count. New evidence is not the bar you dismissed.
 */
export interface TimerDismissal {
  /** The `startedTs` the row was showing when it was dismissed. */
  startedTs: number
  /** The count chip it was showing (1 when it had none). */
  count: number
}

/** The verdicts one timer window is currently holding, keyed by row id. */
export type TimerDismissals = ReadonlyMap<string, TimerDismissal>

/** The verdict a row would be dismissed under right now. */
export function timerDismissalOf(row: BuffTimerRow): TimerDismissal {
  return { startedTs: row.startedTs, count: row.count ?? 1 }
}

/** True when this row is the reading that was dismissed, or an older one. */
export function isTimerDismissed(row: BuffTimerRow, dismissals: TimerDismissals): boolean {
  const d = dismissals.get(row.id)
  return d != null && row.startedTs <= d.startedTs && (row.count ?? 1) <= d.count
}

/** The rows a window draws once its dismissals are applied. Order is the caller's, never re-sorted. */
export function dismissTimerRows(
  rows: readonly BuffTimerRow[],
  dismissals: TimerDismissals
): BuffTimerRow[] {
  if (dismissals.size === 0) return [...rows]
  return rows.filter((r) => !isTimerDismissed(r, dismissals))
}

/**
 * How many verdicts a window remembers. A BOUND, not a policy: a verdict costs two numbers and
 * expires by being outlived (a later landing is not the reading it names), so nothing here needs a
 * clock — but a set that only ever grows is the unbounded map this ticket is also about.
 */
export const MAX_TIMER_DISMISSALS = 50

/** Record one dismissal, most-recent last, evicting the oldest past {@link MAX_TIMER_DISMISSALS}. */
export function withTimerDismissal(prev: TimerDismissals, row: BuffTimerRow): Map<string, TimerDismissal> {
  const next = new Map(prev)
  // Delete first so a re-dismissal moves to the END of the insertion order — the eviction below is
  // oldest-first, and a row the user just cleared twice is the last one they want forgotten.
  next.delete(row.id)
  next.set(row.id, timerDismissalOf(row))
  for (const k of next.keys()) {
    if (next.size <= MAX_TIMER_DISMISSALS) break
    next.delete(k)
  }
  return next
}

/** What a row reads RIGHT NOW. `fraction` is 1 at the landing and 0 at/after the stated end. */
export interface TimerReading {
  elapsedMs: number
  /** Present only for a countdown; clamped at 0 — a countdown never renders a negative. */
  remainingMs?: number
  /** Bar fill in [0,1]: remaining share for a countdown, 0 for elapsed/permanent (no bar). */
  fraction: number
  /** True when a countdown has run past its stated end and the log has not yet cleared it. */
  overdue: boolean
}

export function timerReading(row: BuffTimerRow, nowMs: number): TimerReading {
  const elapsedMs = Math.max(0, nowMs - row.startedTs)
  if (row.mode !== 'countdown' || row.durationMs == null || row.durationMs <= 0) {
    return { elapsedMs, fraction: 0, overdue: false }
  }
  const left = row.durationMs - elapsedMs
  const remainingMs = left > 0 ? left : 0
  return {
    elapsedMs,
    remainingMs,
    fraction: Math.min(1, Math.max(0, left / row.durationMs)),
    overdue: left <= 0
  }
}

// ----- building the rows -----

/** Rank tail (mirrors parser.spellCanonKey — kept local so `shared/` never reaches into main;
 *  the same trick `data/spellDb.ts canonKey` already uses for the same reason). */
const RANK_TAIL_RE = / (?:I|II|III|IV|V|VI|VII|VIII|IX|X)$/i

/**
 * A row's spell name folded to its FAMILY: rank suffix stripped, case-folded.
 *
 * EXPORTED for `shared/earlyWarning.ts` (JOS-216), which has to compare a row's name against the
 * names an arming log line could have been — and those two come from different lines of the log
 * (the row's from the ranked CAST line, the event's from a landing sentence that carries no rank),
 * so the comparison is only meaningful under this fold. It is the same key this file's own row ids
 * are built from, which is the point of sharing it rather than writing a third copy.
 */
export function timerNameKey(name: string): string {
  return timerNameBase(name).toLowerCase()
}

/**
 * The same fold WITHOUT the case-fold — a row's spell name as the WEAR-OFF LINE will print it.
 *
 * EXPORTED for `shared/earlyWarning.ts` (JOS-235), which builds the break sentence a def would
 * match against out of a row that is still running. A row's name comes from the ranked CAST line
 * (`Mesmerization VII`) and every `Your <X> spell has worn off of <mob>.` line is rank-LESS —
 * measured over the owner's whole log for JOS-200, 3,382 of 3,383 — so the name to compare a
 * break-family def against is this one, and it has to keep its display casing because the firing
 * SPEAKS it.
 */
export function timerNameBase(name: string): string {
  return name.trim().replace(RANK_TAIL_RE, '').trim()
}

/**
 * THE RANK A ROW MAY PRINT — the numeral off the cast line, or nothing (JOS-238).
 *
 * `castName` is the ranked text one cast line spelled and `name` is the spell's identity, so the
 * only honest thing to show beside the name is the DIFFERENCE between them: the rank tail. Two
 * refusals are deliberate. The two strings must fold to the SAME line under `timerNameKey`, or the
 * chip would be a rank belonging to some other spell; and a `castName` with no rank tail yields
 * nothing, because "the cast line spelled it differently" is not by itself a rank.
 *
 * Pure and shared so the floating window and the Buffs tab cannot disagree about what a row says.
 */
export function rowRankLabel(name: string, castName: string | undefined): string | undefined {
  if (castName == null || timerNameKey(castName) !== timerNameKey(name)) return undefined
  const m = RANK_TAIL_RE.exec(castName.trim())
  return m ? m[0].trim().toUpperCase() : undefined
}

/** Canonical entity key (mirrors parseCommon.idKey for the same reason as above). */
function entityKeyOf(name: string): string {
  return name.trim().toLowerCase()
}

/**
 * The single stated duration a candidate set can honestly claim, or null.
 *
 * One candidate ⇒ its own duration. Several ⇒ a duration ONLY if every one of them states the
 * SAME number, because then the ambiguity never reaches the clock. Measured, this is not a
 * theoretical branch: `has been enthralled.` is one spell (48 s, statable) while
 * `has been mesmerized.` is four spells at 96 s / 24 s / 24 s / no-duration-at-all (not
 * statable), so a blanket "a mez counts up" would have thrown away two of the four families
 * and a blanket "take the first" would have been the coin flip JOS-84 exists to forbid.
 */
export function statedDuration(candidates: readonly { durationMs: number | null }[]): number | null {
  if (candidates.length === 0) return null
  const first = candidates[0].durationMs
  if (first == null) return null
  return candidates.every((c) => c.durationMs === first) ? first : null
}

/** The row a CC hold projects to. */
function ccRow(h: CcHold): BuffTimerRow {
  const spell = h.spell
  const family = h.candidates.length > 0 ? h.candidates.join(' / ') : 'Crowd control'
  return {
    id: `cc|${h.key}|${spell != null ? timerNameKey(spell) : h.candidates.map(timerNameKey).join('+')}`,
    kind: 'cc',
    name: spell ?? family,
    group: 'target',
    target: h.target,
    targetKey: h.key,
    startedTs: h.startedTs,
    ...(spell != null ? {} : { candidates: [...h.candidates], ambiguous: true as const }),
    ...(h.count != null && h.count > 1 ? { count: h.count } : {}),
    ...(h.caster != null ? { caster: h.caster } : {}),
    ...(h.durationMs != null
      ? { mode: 'countdown' as const, durationMs: h.durationMs }
      : { mode: 'elapsed' as const })
  }
}

/**
 * THE LAW, as one decision: the estimator's duration — max(DB floor, recent observed max) — earns a
 * receding countdown; nothing else does (JOS-117).
 *
 * `overlayDurationMs` is the whole discriminator, filled by buffsView.ts from the shared estimator
 * (see this file's header). A permanent buff never counts down. A buff the model can put no honest
 * number on (no sample, no DB floor) counts UP instead — and carries no duration at all, so nothing
 * downstream can draw a bar from it. `estimatedMs`/`durationSource` are the tab's copies of the same
 * estimator and are read there, not here.
 */
function timerModeOf(b: ActiveBuff): { mode: TimerMode; durationMs?: number } {
  if (b.permanent === true) return { mode: 'permanent' }
  if (b.overlayDurationMs != null && b.overlayDurationMs > 0) {
    return { mode: 'countdown', durationMs: b.overlayDurationMs }
  }
  return { mode: 'elapsed' }
}

/**
 * The fields a row carries only when it has something to say — see `ActiveBuff.count` / `.caster`
 * / `.candidates`. Split out so `buffRow` stays under the factoring ceiling.
 */
function buffRowExtras(b: ActiveBuff): Partial<BuffTimerRow> {
  return {
    ...(b.castName != null && b.castName !== b.spell ? { castName: b.castName } : {}),
    ...(b.calmsTarget === true ? { calmsTarget: true as const } : {}),
    ...(b.inferredTarget === true ? { inferredTarget: true as const } : {}),
    ...(b.count != null && b.count > 1 ? { count: b.count } : {}),
    ...(b.caster != null ? { caster: b.caster } : {}),
    ...(b.candidates ? { candidates: [...b.candidates], ambiguous: true as const } : {})
  }
}

/** The row an ActiveBuff projects to. */
function buffRow(b: ActiveBuff): BuffTimerRow {
  const targetKey = b.self ? undefined : b.target != null ? entityKeyOf(b.target) : 'unknown'
  return {
    id: `${b.self ? 'self' : 'target'}|${targetKey ?? 'self'}|${timerNameKey(b.spell)}`,
    kind: b.cls,
    name: b.spell,
    group: b.self ? 'self' : 'target',
    ...(b.self ? {} : { target: b.target ?? 'unknown target', targetKey }),
    startedTs: b.startedTs,
    ...buffRowExtras(b),
    ...timerModeOf(b)
  }
}

/**
 * True when the CC ledger has recorded an END for this active instance at or after it landed —
 * the §3.3 correction. `Your <mez> spell has worn off of <mob>.` routes to `cc {refresh:true}`
 * rather than `buffFade`, so `BuffsModule.onBuffFade` never runs for a CC-roster spell and the
 * instance is never cleared from the buffs model (it lingers to the 90-minute hygiene cap).
 * Correcting it in `buffsInstances.recordFade` would also mint a land→fade DURATION SAMPLE and
 * move mined statistics across the whole golden suite — the buff-system rework the owner paused
 * — so the correction lives in the projection and is exactly one rule wide.
 */
function endedByCc(b: ActiveBuff, ends: readonly CcEnd[]): boolean {
  if (b.self || b.target == null) return false
  const key = entityKeyOf(b.target)
  const spell = timerNameKey(b.spell)
  return ends.some((e) => e.key === key && e.ts >= b.startedTs && (e.spell == null || timerNameKey(e.spell) === spell))
}

/**
 * Soonest-to-expire first; countdowns ahead of count-ups; then oldest first, then by name.
 *
 * THE RANK IS THE ANSWER TO "where do the rows with no number go" (JOS-140): AFTER the timed
 * ones. A row that states no duration is counting UP and cannot be placed on a
 * soonest-to-expire axis at all, so putting it above a bar that is about to break would be
 * sorting by a number it does not have. Permanent rows come last for the same reason, one step
 * further: they are never going to expire.
 */
function compareRows(a: BuffTimerRow, b: BuffTimerRow): number {
  const rank = (r: BuffTimerRow): number => (r.mode === 'countdown' ? 0 : r.mode === 'elapsed' ? 1 : 2)
  if (rank(a) !== rank(b)) return rank(a) - rank(b)
  if (a.mode === 'countdown' && b.mode === 'countdown') {
    const ea = a.startedTs + (a.durationMs ?? 0)
    const eb = b.startedTs + (b.durationMs ?? 0)
    if (ea !== eb) return ea - eb
  } else if (a.startedTs !== b.startedTs) {
    return a.startedTs - b.startedTs
  }
  return a.name.localeCompare(b.name)
}

/**
 * THE PROJECTION. Self rows first (law 4's presentation order), then one block per target with
 * that target's rows together, targets ordered by their soonest row.
 *
 * There is no clock argument on purpose: every row carries its own `startedTs` and its own mode,
 * so the renderer ticks without another round trip and this function stays a pure fold over two
 * snapshots. Reading a row against a clock is `timerReading`.
 */
export function buildTimerRows(buffs: BuffsSnap, timers: BuffTimersSnap): BuffTimerRow[] {
  // A CC hold and an ActiveBuff can describe the SAME mez: a spell whose landing sentence the DB
  // matcher DID see (Screaming Terror's "begins to scream.") becomes an ActiveBuff, and its
  // `<mob> has been …` siblings become holds. Where both exist for one (mob, spell), the HOLD
  // wins — it is the half that knows about break lines.
  const heldBySpell = new Set(
    timers.holds.filter((h) => h.spell != null).map((h) => `${h.key}|${timerNameKey(h.spell ?? '')}`)
  )
  const rows: BuffTimerRow[] = []
  for (const b of buffs.active) {
    if (endedByCc(b, timers.ends)) continue
    const row = buffRow(b)
    if (row.group === 'target' && heldBySpell.has(`${row.targetKey ?? ''}|${timerNameKey(row.name)}`)) continue
    rows.push(row)
  }
  for (const h of timers.holds) rows.push(ccRow(h))

  const self = rows.filter((r) => r.group === 'self').sort(compareRows)
  const targeted = rows.filter((r) => r.group === 'target')
  const byTarget = new Map<string, BuffTimerRow[]>()
  for (const r of targeted) {
    const k = r.targetKey ?? 'unknown'
    const list = byTarget.get(k)
    if (list) list.push(r)
    else byTarget.set(k, [r])
  }
  const groups = [...byTarget.values()].map((g) => g.sort(compareRows))
  groups.sort((a, b) => compareRows(a[0], b[0]))
  return [...self, ...groups.flat()]
}

/**
 * THE ROW ORDER ONE WINDOW DRAWS (JOS-140). `buildTimerRows` is the MODEL's order — self first,
 * then per-target blocks — and stays exactly that, because both windows are folded from it and
 * every fixture test reads it. This is the presentation choice on top, and it is per window.
 *
 * 'target' hands back the projection untouched. 'none' re-sorts the same rows into ONE flat list,
 * soonest to expire first, which is what the debuffs window opens on: a player chain-mezzing
 * reads the next thing to break, not the roster of mobs. Nothing is added, removed or renamed by
 * either — it is a sort, and `rowsForSurface` has already decided membership.
 */
export function orderTimerRows(rows: readonly BuffTimerRow[], grouping: TimerGrouping): BuffTimerRow[] {
  return grouping === 'target' ? [...rows] : [...rows].sort(compareRows)
}
