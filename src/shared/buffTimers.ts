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

import type { ActiveBuff, BuffsSnap } from './buffTypes'
// Type-only: `shared/types.ts` is a value module (OVERLAY_KINDS) and this one is imported by the
// node tests as a pure module, so the reference is erased at compile time and nothing follows it.
import type { OverlayKind } from './types'

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
  /** Where `durationMs` came from: 'db' (the floor held) | 'observed' (a logged cycle beat it). */
  source?: 'db' | 'observed'
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
  /** The resolved spell name, or the candidate names joined when the sentence is shared. */
  name: string
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
 * subject. The discriminator is the row's own `kind`, which the model already carries:
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
 * Exhaustive over `BuffTimerRow['kind']` by construction — a new row kind has to choose a window.
 */
export function timerRowSurface(row: BuffTimerRow): TimerOverlayKind {
  return row.kind === 'buff' ? 'buffs' : 'debuffs'
}

/** The rows one timer surface shows. Order is `buildTimerRows`' order, filtered — never re-sorted. */
export function rowsForSurface(rows: readonly BuffTimerRow[], kind: TimerOverlayKind): BuffTimerRow[] {
  return rows.filter((r) => timerRowSurface(r) === kind)
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
 * The `kind:'buff'` rows that were there a moment ago and are not there now.
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
 */
export function timerDrops(
  prev: readonly BuffTimerRow[] | null,
  current: readonly BuffTimerRow[],
  opts: { rebuilt: boolean }
): TimerDrop[] {
  if (prev === null || opts.rebuilt) return []
  const live = new Set(current.filter((r) => r.kind === 'buff').map((r) => r.id))
  return prev
    .filter((r) => r.kind === 'buff' && !live.has(r.id))
    .map((r) => ({ id: r.id, name: timerDropLabel(r) }))
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
function nameKey(name: string): string {
  return name.trim().replace(RANK_TAIL_RE, '').trim().toLowerCase()
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
    id: `cc|${h.key}|${spell != null ? nameKey(spell) : h.candidates.map(nameKey).join('+')}`,
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
    id: `${b.self ? 'self' : 'target'}|${targetKey ?? 'self'}|${nameKey(b.spell)}`,
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
  const spell = nameKey(b.spell)
  return ends.some((e) => e.key === key && e.ts >= b.startedTs && (e.spell == null || nameKey(e.spell) === spell))
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
    timers.holds.filter((h) => h.spell != null).map((h) => `${h.key}|${nameKey(h.spell ?? '')}`)
  )
  const rows: BuffTimerRow[] = []
  for (const b of buffs.active) {
    if (endedByCc(b, timers.ends)) continue
    const row = buffRow(b)
    if (row.group === 'target' && heldBySpell.has(`${row.targetKey ?? ''}|${nameKey(row.name)}`)) continue
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
