// buffsStats.ts — THE ONE OBSERVED-DURATION LEARNER (JOS-140), and the per-line game knowledge
// beside it: the mined duration samples, the recency map, and the authoritative spell DB.
//
// This is GAME knowledge, not character state — a spell's duration and its cast messages are
// identical across a character rebirth — which is why the module's rebirth/session-gap clears
// deliberately leave everything here intact (see BuffsModule.onEvent).
//
// ─────────────────────────────────────────────────────────────────────────────
// ONE LEARNER, TWO HALVES OF THE MODEL (JOS-140 ruling 1). Before this ticket there were two
// systems: buffs and debuffs had `estimateFor` and crowd control had NOTHING — the CC half was
// DB-STATED by design and said so in its own header, so a Mesmerization VII that really runs 44 s
// counted down from the base rank's 24 s and no number of casts could ever teach it (JOS-126's
// measured root cause: not a broken learner, a missing one). The CC holds now mint into THIS store
// through the same `pushSample`, and read back through the same `estimateFor`.
//
// KEYED ON (LINE, CASTER) — ruling 4, and both halves of the key are the owner's:
//   * the LINE is the rank-stripped key, so `Mesmerization III` and `Mesmerization VII` pool. This
//     OVERRULES the investigation's A2 (which wanted per-rank keys) for a measured reason: the
//     committed spells.json has 121 rank-suffixed names and ZERO rows at rank VI or above, so a
//     per-rank key would start every upgrade back at the DB floor and re-learn from nothing on
//     every level. Pooling errs toward the longer observation, which is the direction the MAX
//     estimator is built for.
//   * the CASTER is 'self' or an allowlisted external (shared/buffTrust.ts). A duration is a fact
//     about a caster's AAs, focus items and rank; a grouped enchanter's 31-second mez and your own
//     44-second one are two answers to two questions, and pooling them gives a bar wrong for both.
//
// THE ESTIMATOR ITSELF is JOS-117's, confirmed by the owner (ruling 6):
//   estimate = max( DB baseline , max-over-recent-window of CLEAN observed samples )
// The DB base is a FLOOR and the recent observed max is an EXTENSION over it. See `estimateFor`.
//
// JOS-212 (owner ruling 2026-08-12) ADDED THE ONE WAY THE FLOOR CAN LOSE, and it is still the same
// one estimator: a below-floor observation overrules the DB base when the log CORROBORATES it —
// three clean cycles in the recency window whose top three agree within 10% (`corroboratedMax` in
// buffsShapes.ts, where the measurement behind both numbers lives). It exists because the floor's
// assumption (AA/focus only extend, so nothing is ever shorter than its base) is a claim about
// classic EQ, and this game re-tiered spells the committed scrape still describes the old way. The
// estimate then reports source 'cluster' rather than 'observed', because the two make opposite
// claims about the DB row and the UI must not tell the user "longer than the baseline" about a
// number that is shorter.
//
// WHAT JOS-180 CHANGED IS THE WINDOW, NOT THE ESTIMATOR. A sample now records whether the log
// NAMED a cause for the cycle ending (`<mob> has been awakened by <name>.`), and the recency window
// is applied once per evidence class instead of once over the pooled list — so a run of broken
// mezzes can never retire the one full-length cycle the log finally produced. The exact rule, the
// measurement behind it and the property it must not cost are on `observedWindowMaxFor`.
//
// AND WHAT JOS-379 ADDED IS A THIRD KIND OF EVIDENCE, for the case where no cycle can ever be
// witnessed at all (owner ruling 2026-08-15). A DEBUFFED MOB'S DEATH WITH NO WEAR-OFF SINCE THE
// LANDING IS A LOWER BOUND: the spell lasted at least landing→corpse. On raid mobs that is the
// whole of the available evidence — they die first, and this server prints no wear-off for your
// slow when somebody else lands the kill — so before this the estimator had nothing to lift a
// classic-era DB floor with, and an early-warning alert spoke "slow off a dracoliche" over a slow
// that was visibly still on the mob. A bound folds into the MAX exactly like any other sample and
// reports source 'deathBound' when it wins, because it is a bound and not an answer. It is refused
// the JOS-212 cluster (`cleanWindowFor`) and the n/median columns (`statFor`): a bound is not a
// cycle. The evidence rails — the witnessed wear-off channel, the same-name identity guard and the
// caps — live at the seam that mints it, `modules/buffsInstanceRules.ts deathBoundSpan`.

import type { SpellDb } from '../data/spellDb'
import { spellCalmsTarget, spellNature } from '../data/spellDb'
import type { BuffClass, BuffStat } from '../../shared/types'
import { learnKey, SELF_CASTER } from '../../shared/buffTrust'
import { parseSpellRank } from '../../shared/spellLines'
import type { EstimatorSource } from '../../shared/buffTypes'
import {
  corroboratedMax,
  isLowerBound,
  percentile,
  RECENT_SAMPLE_WINDOW,
  type DurationSample,
  type SpellSamples
} from './buffsShapes'

/** The winning candidate of the estimator's window: the longest span, and whether it is a bound. */
interface WindowMax {
  ms: number
  bound: boolean
}

/**
 * Fold one sample into the running window max (JOS-379) — separated from the walk so the two
 * questions stay apart: WHICH samples are in view (the per-class windows) and WHICH of them wins.
 *
 * A TIE GOES TO THE MEASURED CYCLE. Two samples agreeing on a number, one of them a real observed
 * ending, is an observation — the bound adds nothing to it and must not weaken the label the log
 * already earned.
 */
function foldWindowMax(best: WindowMax | null, s: DurationSample): WindowMax {
  const bound = s.deathBound === true
  if (best == null || s.ms > best.ms) return { ms: s.ms, bound }
  if (s.ms === best.ms && !bound) return { ms: best.ms, bound: false }
  return best
}

/**
 * WHICH SPELLING OF A LINE THE BUFFS TAB SHOULD SHOW (JOS-411) — the rank question, and the one
 * place it is answered.
 *
 * THE REPORT (C3QVVN, v1.5.0): *I now have the Mesmerization spell levelled up to X (+10). The
 * buffs section of EQLC, under Debuffs, lists 'Mesmerization VI'.* The record's display name was
 * written when the (line, caster) row was first minted and never again, so the tab showed the rank
 * that happened to be equipped the first time a cycle closed — forever, across every upgrade.
 * The live overlay never had the defect: a hold takes its name from the anchored cast on every
 * landing (`modules/buffTimers.ts apply`). Only the tab's stats record was frozen.
 *
 * HIGHEST RANK WINS — the owner's option A ("update to the highest/most recent level seen") read
 * the way the rest of the repo reads ranks. LAST-WRITE-WINS was the alternative and is REFUSED for
 * two reasons that are facts about this store rather than preferences:
 *   • THE STORE POOLS ACROSS CHARACTERS. Everything on this class is GAME knowledge and the
 *     rebirth/session-gap clears deliberately leave it standing (see this file's header), so a
 *     second enchanter on the same log — an alt, a rebirth, a loadout swap — would drag the name
 *     back down to their rank under last-write. Highest-rank is the only rule that survives the
 *     pooling the samples already do.
 *   • IT IS THE DOMAIN LAW ALREADY WRITTEN DOWN (JOS-259, owner ruling 2026-08-12, verbatim: *once
 *     you upgrade a spell it never downgrades, even on a loadout swap*). A name that walks
 *     backwards would contradict the rule the alert system is built on.
 * The two agree in the ordinary case — you upgrade and never cast the old rank again — so this
 * costs nothing where last-write would have been right.
 *
 * A TIE KEEPS THE EXISTING SPELLING, so a re-cast of the same rank never churns the row, and
 * neither does the DB's casing losing a race with the log's.
 *
 * A DIFFERENT BASE IS NOT A RANK COMPARISON, so the newest name simply wins. Two names can share a
 * line key and still not share a base spelling: a hold that never resolved falls back to its first
 * candidate or to the bare line key (`buffTimers.ts closeOne`), and the corrections overlay can
 * RENAME a line outright (JOS-161). Comparing ordinals across those would be arithmetic on
 * unrelated words.
 *
 * THE RANK LADDER STOPS AT X, which is a limit of `parseSpellRank`'s shared RANK_TAIL_RE and not of
 * this rule. A hypothetical `Mesmerization XI` parses as an UNSUFFIXED name (base
 * `Mesmerization XI`, rank 1), so it lands in the different-base branch and is taken as the newest
 * name — the right answer by luck, but a later rank-X cast would then take it back. Extending the
 * ladder is one shared regex away (`shared/spellLines.ts`, mirrored in `log/parseCommon.ts` and
 * three more places) and is deliberately NOT done here: the ceiling is the parser's, the fold that
 * pairs a ranked cast with its rank-less landing line depends on it, and moving it is a change to
 * the whole rank fold rather than to this display rule.
 */
export function preferredDisplayName(prev: string, next: string): string {
  const candidate = next.trim()
  if (candidate === '' || candidate === prev.trim()) return prev
  const before = parseSpellRank(prev)
  const after = parseSpellRank(candidate)
  if (before.base.toLowerCase() !== after.base.toLowerCase()) return candidate
  return after.rank > before.rank ? candidate : prev
}

export class SpellStats {
  /** The scraped spell database (Task #34), optional — the authoritative prior. */
  readonly db?: SpellDb
  /**
   * Mined samples per (LINE, CASTER) — `buffTrust.learnKey`. Ranks pool within a caster; casters
   * never pool with each other (ruling 4).
   */
  samples = new Map<string, SpellSamples>()
  /** Spell keys ever seen fading / applied — the buff discriminator. */
  everFaded = new Set<string>()
  /**
   * SPELL LINES THIS LOG HAS EVER PRINTED A TARGET-NAMED WEAR-OFF FOR (JOS-379) — the
   * "wear-off channel witnessed" flag, learned at runtime and from nothing else.
   *
   * WHAT IT IS FOR. The death lower bound (`buffsInstanceRules.ts deathBoundSpan`) reads an
   * ABSENCE: no `Your <X> spell has worn off of <mob>.` between the landing and the corpse. An
   * absence is only evidence about a spell that PRINTS the line in the first place, which is the
   * awaiting-sample law applied to a bound — so a line whose channel this log has never
   * demonstrated teaches nothing from silence, however many mobs die under it.
   *
   * IT IS THE TARGET-NAMED SENTENCE AND NOT THE SELF ONE. `Your speed returns to normal.` proves
   * a buff on YOU ends audibly; it says nothing about whether a debuff on a MOB does, and the
   * question here is only ever about a mob. `modules/buffs.ts onBuffFade` is the one writer and
   * gates on the fade naming its target.
   *
   * RELEARNED EVERY LAUNCH, like every other map on this class: nothing here is persisted, the
   * app re-folds the whole log at startup, and a full fold witnesses the channel long before it
   * reaches today's raid. The rebirth/session-gap clears deliberately leave it standing — which
   * spells print which sentence is game knowledge, not character state.
   */
  wearOffWitnessed = new Set<string>()
  /**
   * Per-spell LAST-SEEN event ts (Task #45): the newest castBegin / apply / fade involving
   * the spell — the cheapest consistent recency signal. Feeds the suggested-alerts wizard's
   * recency sort (recent spells sort to the top over merely-frequent ones). Keyed by
   * canonical spell key; survives session gaps like the other learned maps.
   */
  lastSeen = new Map<string, number>()

  constructor(db?: SpellDb) {
    this.db = db
  }

  reset(): void {
    this.samples = new Map()
    this.everFaded = new Set()
    this.wearOffWitnessed = new Set()
    this.lastSeen = new Map()
  }

  /**
   * A `Your <X> spell has worn off of <target>.` line was seen for this LINE — the channel is
   * witnessed from here on. See {@link wearOffWitnessed} for what an absence is then allowed to
   * mean, and what it is not.
   */
  witnessWearOffChannel(key: string): void {
    this.wearOffWitnessed.add(key)
  }

  /** True when this LINE has ever printed a target-named wear-off in this log (JOS-379). */
  hasWearOffChannel(key: string): boolean {
    return this.wearOffWitnessed.has(key)
  }

  /** Record the newest ts a spell was seen (cast/apply/fade) — the recency signal (Task #45). */
  touchLastSeen(key: string, ts: number): void {
    const prev = this.lastSeen.get(key)
    if (prev == null || ts > prev) this.lastSeen.set(key, ts)
  }

  /** Authoritative DB duration (ms) for a spell key, or null when unknown. */
  dbDurationFor(key: string): number | null {
    const s = this.db?.byKey.get(key)
    return s?.durationMs ?? null
  }

  /** True when a spell KEY is illusion-flagged in the DB (Task #36). */
  isIllusion(key: string): boolean {
    return this.db?.byKey.get(key)?.illusion ?? false
  }

  /**
   * DOES THE SPELL DATABASE SAY THIS SPELL NEVER EXPIRES (JOS-215) — the self/permanent-buff
   * discriminator, read at the same seam as `dbDurationFor` and `isIllusion` and from the same row.
   *
   * THE REPORT (01KZS7FZEAC0Q0T76ZJRS32DSR, v0.21.0): the buff window omits self buffs. The cause is
   * one line in `BuffInstances.applyMessageBuff`, which refused a landing with no duration and no
   * illusion flag — and a permanent buff HAS no duration, by definition. Yaulp, the Shielding line,
   * Instrument of Nife, the rogue blade coats and 57 others therefore landed, printed their sentence,
   * and opened nothing at all.
   *
   * THE DISCRIMINATOR IS `durationText === 'Permanent'`, AND `durationMs == null` ALONE IS NOT IT.
   * Measured over the committed spells.json (1,926 rows): 62 rows state `Permanent`, every one of
   * them `targetType: Self` and beneficial (58 `Beneficial`, 3 `Statistic Buff`, 1 `Damage Shield`),
   * and every one of them carries `durationMs: null` because `parseDurationMs` deliberately refuses
   * the word. But 453 Self rows carry a null `durationMs`, and the rest of them are `Instant` nukes,
   * `Unlimited`, and a handful of clock forms an older scrape could not read — admitting on the null
   * would open a permanent instance for every instant self-cast in the game. The wiki's own WORD is
   * the fact; the null is an artefact of reading it.
   *
   * IT IS THE WIKI'S WORD AND NOT A CURATED LIST, which is the same rule `spellCalmsTarget` and the
   * `ccSpell` roster already follow: a re-scrape that marks another spell Permanent gets it for free,
   * and nothing here has to be hand-maintained. `durationText` is compared verbatim — the scrape
   * writes the template field unchanged and all 62 rows spell it exactly this way.
   *
   * HONEST LIMIT, STATED HERE BECAUSE THIS IS WHERE A READER WILL ASK. The model learns a permanent
   * buff is up only from its CAST: there is no login roster in the log and a permanent buff prints
   * no periodic reminder, so one raised before logging began is invisible until the next recast.
   * Nothing can fix that from the log alone, and the failure is in the safe direction — the window
   * under-reports rather than inventing a buff. Death is the one event that heals it: it strips your
   * self buffs, so the model and the game agree again from the next cast onward.
   */
  isPermanent(key: string): boolean {
    return this.db?.byKey.get(key)?.durationText === 'Permanent'
  }

  /**
   * Append a mined duration sample for one caster (the caller re-stats the live instances).
   *
   * The sample arrives as a RECORD rather than a bare span since JOS-180, because a span alone is
   * no longer the whole of one: `ts` (the event ts of the line that ended the cycle) is the only
   * handle a later line has on this sample — see {@link censorSampleAt} — and every call site
   * already holds it. It is COPIED in, so nobody keeps a mutable handle on the store's contents.
   *
   * THE DISPLAY NAME IS RE-READ ON EVERY SAMPLE, not written once at mint (JOS-411) — see
   * {@link preferredDisplayName} for which spelling wins and why.
   */
  pushSample(key: string, caster: string, spell: string, sample: DurationSample): void {
    this.row(key, caster, spell).samples.push({ ...sample })
  }

  /**
   * A LANDING SAID WHAT THIS LINE IS CALLED (JOS-411) — the same display-name write as
   * {@link pushSample}, without a sample behind it.
   *
   * It exists because a mint is not the only moment the log states a rank, and on the crowd-control
   * path it is the RARER one: the cast line is the only line in a mez's family that carries the
   * roman numeral (`modules/buffTimers.ts apply`), while a sample is minted only from a CLEAN cycle
   * — a mez the player's own nuke broke teaches the tab nothing. Waiting for one would leave the
   * upgraded rank invisible for as long as the holds keep breaking early, which is precisely the
   * population this file's censoring rules exist for. The rank the tab shows now follows the cast
   * that was actually anchored, at the same seam that already records `everFaded`/`lastSeen`.
   *
   * A ROW WITH NO SAMPLES IS A LEGAL ROW and always was: `statFor` returns null for one and
   * `buildStats` falls back to exactly this name (through {@link sampleSpellName}), which is the
   * path a DB-only line already takes.
   */
  noteDisplayName(key: string, caster: string, spell: string): void {
    this.row(key, caster, spell)
  }

  /** The (line, caster) row, minted if new, with its display name brought up to date. */
  private row(key: string, caster: string, spell: string): SpellSamples {
    const lk = learnKey(key, caster)
    const s = this.samples.get(lk)
    if (!s) {
      const fresh: SpellSamples = { spell, samples: [] }
      this.samples.set(lk, fresh)
      return fresh
    }
    s.spell = preferredDisplayName(s.spell, spell)
    return s
  }

  /**
   * Mark the sample closed at `closedTs` CENSORED — the log named something that ended that cycle
   * early, so its span is a lower bound on the duration and not the duration (JOS-180).
   *
   * IT IS RETROACTIVE BECAUSE THE LOG IS. `<mob> has been awakened by <name>.` is printed AFTER the
   * wear-off sentence it explains — measured over the owner's whole log, 1,472 of 1,472 paired
   * wakes follow their wear-off, in the same second, 1,462 of them on the very next line — so the
   * sample is always already minted by the time the cause arrives. Marking it afterwards costs
   * nothing that matters: the estimate is a MAX over both windows and the value itself does not
   * move, so no bar jumps at the moment of censoring. What changes is only what this sample may
   * EVICT later.
   *
   * Returns true when it found one, so the caller knows whether to re-stat.
   */
  censorSampleAt(key: string, caster: string, closedTs: number): boolean {
    const s = this.samples.get(learnKey(key, caster))
    if (!s) return false
    // Newest first: a re-used ts can only mean the same second, and the newest is the one the
    // caller just minted.
    for (let i = s.samples.length - 1; i >= 0; i--) {
      const sample = s.samples[i]
      if (sample.ts !== closedTs) continue
      if (sample.censored === true) return false
      sample.censored = true
      return true
    }
    return false
  }

  /** The display name last minted for a (line, caster), for a row that has lost its own. */
  sampleSpellName(key: string, caster: string = SELF_CASTER): string | undefined {
    return this.samples.get(learnKey(key, caster))?.spell
  }

  statFor(key: string, caster: string = SELF_CASTER): BuffStat | null {
    const s = this.samples.get(learnKey(key, caster))
    if (!s || s.samples.length === 0) return null
    // The DISTRIBUTION columns describe every cycle the model measured, censored or not: the Buffs
    // tab's n/median/min/max are a report on what was OBSERVED, and hiding the broken cycles there
    // would misdescribe the log. Only the ESTIMATE reads the censoring (observedWindowMaxFor).
    //
    // A DEATH BOUND IS NOT A CYCLE AND IS NOT COUNTED HERE (JOS-379). `n` is documented as the
    // number of land→fade PAIRS and a bound has no fade in it — nothing ended, the mob simply
    // stopped existing. Counting one would inflate the confidence hint and drag the median toward
    // a number nobody measured, and the wizard's `usageCount` reads the same field. The bound is
    // visible where it belongs: in the ESTIMATE, wearing its own source.
    const sorted = s.samples
      .filter((x) => x.deathBound !== true)
      .map((x) => x.ms)
      .sort((a, b) => a - b)
    const n = sorted.length
    const est = this.estimateFor(key, caster)
    return {
      spell: s.spell,
      cls: this.classOf(key),
      n,
      medianMs: n > 0 ? percentile(sorted, 0.5) : null,
      p25: n > 0 ? percentile(sorted, 0.25) : null,
      p75: n > 0 ? percentile(sorted, 0.75) : null,
      minMs: n > 0 ? sorted[0] : null,
      maxMs: n > 0 ? sorted[n - 1] : null,
      dbDurationMs: this.dbDurationFor(key),
      estimateMs: est.ms,
      estimatorSource: est.source,
      lastSeenMs: this.lastSeen.get(key) ?? null
    }
  }

  /**
   * The observed candidate that competes with the DB floor: the MAX over the most recent window of
   * clean samples for this (line, caster), or null when there are none. Two deliberate choices
   * (JOS-117, re-confirmed as ruling 6):
   *   • MAX, not median/p75. Samples are dominated by early terminations that read SHORT — a buff
   *     clicked off, a mez a nuke broke — and those never lift the max, so the max recovers a
   *     focus/AA-extended true duration that a central statistic stays dragged below (Swift Like
   *     the Wind: p75 17m50 << the 36m20 that is the real timer). It is the ONLY estimator that
   *     survives the censoring, and the censoring is severe: EQ prints the same wear-off sentence
   *     whether a mez ran its course or a nuke broke it at 2 s.
   *   • a WINDOW (the last RECENT_SAMPLE_WINDOW), not all-time. A focus effect that is later
   *     REMOVED genuinely shortens the duration; bounding the max to recent samples lets an old
   *     long observation age out so a real decrease recovers.
   *
   * Safe to trust because of the CLEAN-CYCLE rule (ruling 5, buffRounds.ts): a sample is minted
   * only from a landing that was alone in its round, on a name nothing else was holding, that
   * nothing touched before its wear-off. Every censoring boundary — zone, death, offline gap,
   * entity retirement, hygiene, a wear-off with no hold behind it — contaminates instead of
   * minting, and a re-land RESETS the clock so a refresh mints one clean cycle rather than an
   * inflated land-to-fade span.
   *
   * ─────────────────────────────────────────────────────────────────────────────────────────
   * THE RULE JOS-180 ADDED, EXACTLY: **the window is applied ONCE PER EVIDENCE CLASS.** The most
   * recent {@link RECENT_SAMPLE_WINDOW} UNCENSORED samples are one window, the most recent
   * {@link RECENT_SAMPLE_WINDOW} CENSORED ones are a second window, and the estimate's observed
   * candidate is the MAX over both. A censored sample can therefore never push an uncensored one
   * out of view, and vice versa.
   *
   * WHY A CENSORED SAMPLE STILL COUNTS TOWARD THE MAX. It is a real observation, just a truncated
   * one: `<mob> has been awakened by <name>.` proves the mez was still holding one instant before
   * that line, so the span is a LOWER BOUND on the duration. Discarding it outright would hand the
   * DB floor back to exactly the spells JOS-126 was filed about — a Mesmerization VII whose rank is
   * absent from the scrape and which the player always breaks early would count down from the base
   * rank's 24 s forever, which is the bar-sits-at-zero defect. A lower bound is worth more than a
   * wrong number, and MAX is the one estimator that can accept one safely.
   *
   * WHY IT MUST NOT EVICT. The window exists for ONE purpose (above): to let an old long
   * observation age out when a duration genuinely DECREASES — a focus effect removed. A broken
   * cycle is not evidence of a decrease. It is evidence of a nuke. Under a single shared window a
   * run of them retires the only full-length observation the log ever produced, and JOS-180 is what
   * that costs, measured on the owner's own bytes: five early breaks of Dazzle IV (44 s, 115 s,
   * 14 s, 23 s, 79 s, then 100 s) drove the estimate to 100 s and evicted the 115 s reading; the
   * 15 s grace an 'observed' estimate gets then culled every hold at 115 s; the real duration is
   * 136 s, so no full cycle could ever be witnessed again and the number was frozen below the truth
   * permanently. Splitting the windows is what makes the recovery STICK once the first honest
   * 136 s cycle is minted (`modules/buffTimers.ts`'s late-join memory is what lets it be minted at
   * all): five more breaks afterwards roll the censored window and leave the 136 s standing.
   *
   * A REAL DECREASE STILL RECOVERS, which is the property the split must not cost. It takes five
   * UNCENSORED shorter cycles, exactly as it always did — censoring changes which window a sample
   * lives in, never whether it ages out of one.
   *
   * ─────────────────────────────────────────────────────────────────────────────────────────
   * JOS-379 PUT A SECOND KIND OF SAMPLE IN THE BOUND WINDOW and changed nothing else. A DEATH
   * BOUND (a mob died still carrying the debuff, no wear-off ever printed) is the same shape of
   * evidence as a censored cycle — the spell was still running at the instant the line names —
   * so it rides the same window, under the same "may never evict a full cycle" rule, through the
   * one predicate {@link isLowerBound}. What it also does is make the ANSWER weaker when it wins,
   * which is why the return value now says whether the winning sample was a bound: the estimate
   * reports source 'deathBound' rather than 'observed', and the surfaces say "at least".
   */
  observedWindowMaxFor(key: string, caster: string = SELF_CASTER): WindowMax | null {
    const s = this.samples.get(learnKey(key, caster))
    if (!s) return null
    let best: WindowMax | null = null
    let clean = 0
    let broken = 0
    for (let i = s.samples.length - 1; i >= 0; i--) {
      const sample = s.samples[i]
      if (isLowerBound(sample)) {
        if (broken >= RECENT_SAMPLE_WINDOW) continue
        broken += 1
      } else {
        if (clean >= RECENT_SAMPLE_WINDOW) continue
        clean += 1
      }
      best = foldWindowMax(best, sample)
      if (clean >= RECENT_SAMPLE_WINDOW && broken >= RECENT_SAMPLE_WINDOW) break
    }
    return best
  }

  /**
   * The most recent {@link RECENT_SAMPLE_WINDOW} CLEAN samples for this (line, caster), newest
   * first — the same window {@link observedWindowMaxFor} maxes over on the uncensored side, handed
   * out as a list because the below-floor overrule (JOS-212) asks a question a max cannot answer:
   * do the observations AGREE?
   *
   * LOWER BOUNDS ARE ABSENT BY CONSTRUCTION — a censored cycle (JOS-180) and a death bound
   * (JOS-379) alike. They are lower bounds on a duration, not measurements of one, so they may
   * neither corroborate a cluster nor break one — the same reasoning that gives them their own
   * window in the max. A bound is emphatically not a CYCLE, and this rule is a question about
   * whether the cycles AGREE.
   */
  cleanWindowFor(key: string, caster: string = SELF_CASTER): number[] {
    const s = this.samples.get(learnKey(key, caster))
    if (!s) return []
    const out: number[] = []
    for (let i = s.samples.length - 1; i >= 0 && out.length < RECENT_SAMPLE_WINDOW; i--) {
      const sample = s.samples[i]
      if (!isLowerBound(sample)) out.push(sample.ms)
    }
    return out
  }

  /**
   * THE ONE ESTIMATOR (JOS-117, ruling 6) — used by the Buffs TAB estimate column, the buff/debuff
   * overlay countdown (buffsView.ts `overlayDurationOf`) AND, since JOS-140, the crowd-control
   * holds. The DB baseline is a FLOOR, the recent observed max is an EXTENSION over it:
   *
   *   estimate = max( DB baseline , max-over-recent-window of clean observed samples )
   *
   * The distribution the owner measured is why:
   *   • A beneficial buff's true duration is NEVER below its DB base — AA/focus only EXTEND — so a
   *     BELOW-base observation is an early termination (click-off / break / overwrite) and the max
   *     discards it; the floor holds. Invisibility: DB 20m, observed max only 4m24 (always broken
   *     early) ⇒ 20m, source 'db' — the estimate must NOT collapse to 4m.
   *   • An ABOVE-base observation is a real extension and WINS. Swift Like the Wind: DB 16m,
   *     observed 36m20 in the window ⇒ 36m, source 'observed'. Mesmerization: DB 24m (the base
   *     rank's, the only row that exists), observed 44 s at rank VII ⇒ 44 s.
   * With no DB base the observed max stands alone; with neither, null.
   *
   * ─────────────────────────────────────────────────────────────────────────────────────────
   * WHAT JOS-212 CHANGED — THE FLOOR IS NO LONGER UNFALSIFIABLE (owner ruling 2026-08-12, and the
   * only sanctioned change to ruling 6's estimator since it was written).
   *
   * The floor rests on ONE assumption, stated above and stated here again because it is the whole
   * of the argument: *a beneficial buff's true duration is never below its DB base, because AA and
   * focus only EXTEND.* That is a claim about the game the wiki describes. The committed
   * spells.json is a CLASSIC-ERA scrape and EverQuest Legends re-tiered spells, so for a real
   * population of rows the base is not a floor at all — it is a wrong number, and because the
   * estimator is a max, no amount of evidence could ever move it. Twenty rows on the owner's log
   * sit below their floor; a reporter's Shield of Fire drew 15:00 for a spell his own log measured
   * at 6:48 twice.
   *
   * So a below-floor observation may now overrule the floor, but ONLY when it is CORROBORATED:
   *
   *   estimate = observed max, source 'cluster'
   *      when  observed max < DB base
   *      and   `corroboratedMax(cleanWindowFor(...)) != null`
   *            — i.e. ≥ {@link BELOW_FLOOR_MIN_SAMPLES} clean samples in the recency window whose
   *              top three agree within {@link BELOW_FLOOR_MAX_SPREAD}.
   *
   * buffsShapes.ts carries the measurement the two constants come from: the clustered spells
   * (Celerity 0.3% … Tashina 8.6%) and the click-off spells (Quickness 12.2% … Invisibility 161%)
   * separate cleanly, and the threshold sits in the gap. INVISIBILITY STILL KEEPS ITS FLOOR — the
   * floor law's own worked counterexample survives the change that relaxes it, which is the test
   * that the relaxation is honest.
   *
   * TWO SMALL EXACTNESSES. (1) The number the overrule returns is the whole window's max, not the
   * clean cluster's — if a CENSORED sample in the window is longer, the log proved the spell was
   * still running at that instant and the estimate may never be drawn below a proven lower bound.
   * It errs long, which is the direction everything in this file errs. (2) The comparison is
   * strict, so an observation that merely EQUALS the floor changes nothing and stays 'db'.
   *
   * `source` names which won — 'observed' when a sample beat the floor, 'cluster' when a
   * corroborated below-floor cluster removed it, 'db' when the floor held.
   *
   * ─────────────────────────────────────────────────────────────────────────────────────────
   * WHAT JOS-379 CHANGED IS THE LABEL, NOT THE ARITHMETIC (owner ruling 2026-08-15). A DEATH
   * BOUND — a debuffed mob that died with no wear-off ever printed for it — enters the same max
   * as every other sample, because a lower bound is exactly what a max estimator can accept
   * safely: it lifts the floor TOWARD the truth and never past it. What it may not do is claim to
   * be a measurement, so when the winning sample is one, the source reads 'deathBound' and every
   * surface that draws the number says "at least". On raid mobs this is the ONLY evidence there
   * is: they die before any slow of yours runs out, and this server prints no wear-off for a
   * debuff on a mob somebody else kills.
   *
   * A BOUND NEVER REACHES THE BELOW-FLOOR OVERRULE. It cannot: the overrule requires the max to
   * be UNDER the floor, and a bound is only ever pushed when it is over the current estimate,
   * which is at or above the floor. It is refused a second time anyway, at
   * {@link cleanWindowFor} — one refusal is the rule, the other is arithmetic, and neither is
   * relied on alone.
   */
  estimateFor(key: string, caster: string = SELF_CASTER): { ms: number | null; source: EstimatorSource | undefined } {
    const dbMs = this.dbDurationFor(key)
    const observed = this.observedWindowMaxFor(key, caster)
    const learned: EstimatorSource = observed?.bound === true ? 'deathBound' : 'observed'
    if (dbMs != null) {
      if (observed != null && observed.ms > dbMs) return { ms: observed.ms, source: learned }
      if (observed != null && observed.ms < dbMs && corroboratedMax(this.cleanWindowFor(key, caster)) != null) {
        return { ms: observed.ms, source: 'cluster' }
      }
      return { ms: dbMs, source: 'db' }
    }
    if (observed != null) return { ms: observed.ms, source: learned }
    return { ms: null, source: undefined }
  }

  /**
   * THE BUFF/DEBUFF CLASS OF A SPELL — from the spell's NATURE, and from nothing else (JOS-140
   * ruling 8). `spellNature` folds the DB's whole 33-value `spellType` vocabulary into beneficial
   * / detrimental / unknown; that table is exhaustive over the committed DB and audited by a test.
   *
   * WHAT WAS REMOVED, AND WHY IT WAS A DEFECT. This used to fall back, for any spellType the two
   * string literals 'Beneficial' and 'Detrimental' did not name, to a TALLY OF THE ENTITY
   * DISPOSITIONS the spell's fades had landed on — hostile majority ⇒ debuff. That is
   * classification by the shape of the TARGET, and JOS-136 is what it costs: `Resist Magic` is
   * spellType `Resist Buff`, matched neither literal, and a friendly resist buff landing on
   * somebody the model was not currently holding as a pet tallied 'hostile' and walked onto the
   * DEBUFFS overlay. An ally is a named target and so is a mob; the game does not distinguish them
   * in a landing sentence, and the SPELL always did.
   *
   * A spell whose nature nobody states is NOT a debuff by assumption: it reads 'buff', which is
   * where the count of such spells actually is (the seven rows with no spellType at all are bard
   * resonances and Fury of the Chosen, none of which state a duration, so none of them can open an
   * instance in the first place). It is never resolved by looking at who it landed on.
   */
  classOf(key: string): BuffClass {
    return spellNature(this.db?.byKey.get(key)?.spellType) === 'detrimental' ? 'debuff' : 'buff'
  }

  /**
   * DOES THIS SPELL CALM ITS TARGET (JOS-213) — the second, orthogonal question about a spell's
   * effect, asked at the same seam and answered from the same place.
   *
   * `classOf` says whether the spell is a good thing or a bad thing; this says whether the thing
   * it does happens to an ENEMY. The calm line — Pacify, Soothe, Calm, Lull and the rest of the
   * family spells.json groups by landing message — is beneficial AND on a mob, which is why one
   * flag could never carry both and why the timer overlay was showing an aggro clock beside the
   * player's own buffs. `data/spellDb.ts spellCalmsTarget` holds the roster and the argument;
   * everything true of `classOf` is true here too, including that it is never resolved by looking
   * at who the spell landed on.
   */
  calmsTarget(key: string): boolean {
    return spellCalmsTarget(this.db?.byKey.get(key))
  }

  /**
   * The snapshot's per-line stats record: every spell ever faded, with or without samples.
   *
   * It reports the SELF caster's numbers. The Buffs tab is a page about your own spells, and an
   * allowlisted external's samples live under their own learner key precisely so they cannot be
   * mistaken for yours — the overlay row for their buff counts down from their estimate, which is
   * read per-row (buffsView.ts) rather than from this table.
   */
  buildStats(): Record<string, BuffStat> {
    const stats: Record<string, BuffStat> = {}
    for (const key of this.everFaded) {
      const st = this.statFor(key)
      if (st) {
        stats[key] = st
      } else {
        const disp = this.sampleSpellName(key)
        const dbMs = this.dbDurationFor(key)
        const dbSpell = this.db?.byKey.get(key)?.name
        stats[key] = {
          spell: disp ?? dbSpell ?? key,
          cls: this.classOf(key),
          n: 0,
          medianMs: null,
          p25: null,
          p75: null,
          minMs: null,
          maxMs: null,
          dbDurationMs: dbMs,
          estimateMs: dbMs,
          estimatorSource: dbMs != null ? 'db' : undefined,
          lastSeenMs: this.lastSeen.get(key) ?? null
        }
      }
    }
    return stats
  }
}
