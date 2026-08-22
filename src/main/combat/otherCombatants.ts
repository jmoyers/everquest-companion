// WHO ELSE IS IN THIS FIGHT — the evidence-accreting classifier behind the record-everything
// meter (JOS-430; the design record is JOS-243's characterization + market survey).
//
// THE RULING IT IMPLEMENTS (owner, 2026-08-20): "Everyone" means ANY fight the log can see shows
// up — participation not required. Until now ADMISSION GATED RECORDING: `classify()`'s last rule
// was "attacker not you/pet, target not you → ignore", so with an empty roster snapshot nobody but
// you and your pet was ever recorded, and Everyone could not show what nothing had recorded. This
// module is the widening: a combatant the log names, that none of the app's stronger models claims,
// gets its own recorded row, and SCOPE filters at display time.
//
// IT IS A REFUSAL LADDER, NOT AN INFERENCE. Nothing here decides that a name is a PERSON — the log
// cannot say that (see THE HONEST LIMIT below). What it decides is far narrower: whether any model
// with better evidence has already claimed the name. Every rung is something the log STATED:
//
//   * it is one of YOUR pets, or ever was          — petNames / everPet (state.ts notePet)
//   * a charm broadcast has ever named it          — CharmModel.everCharmed
//   * it said one of the six pet sentences, or named someone its leader — the pet-voiced says
//     (AGENTS.md's PET_SAY_LINES carve-out) prove the speaker is SOMEBODY's pet, which is exactly
//     the fact this ladder needs even though JOS-49 established it does not prove it is YOURS
//   * YOU have landed damage on it                 — everStruck (world-model law 4, JOS-48)
//   * it has landed damage on YOU                  — `hostiles` below, and read its comment: this
//     is the one rung that is NOT simply borrowed from an existing guard, and it is measured
//   * it is bound as somebody else's charm pet     — AllyCharms already gives it a row of its own
//
// …and only then does the NAME SHAPE (shared/playerShape.ts) get asked. Shape is the weakest thing
// in the ladder and it is deliberately last: it refuses every article-led mob name EQ prints, which
// is what makes the ladder cheap, but on its own it would admit a single-word proper-named mob.
//
// THE HONEST LIMIT, stated here rather than discovered in a bug report: an UNBOUND stranger's
// SUMMONED PET is indistinguishable from a player by name alone. EQ generates pet names from the
// same one-word proper-name grammar it gives players (Vasektik, Jenantik, Kobanab), and the lines
// that would settle it — `/pet who leader`, a pet-voiced say — only print when somebody orders that
// pet. Measured on the owner's 2,192,988-line log: of 608 distinct names this ladder records, a
// visible minority are other people's pets. That is why nothing here is called a "player": a
// recorded row says the LOG NAMED THIS COMBATANT DEALING THIS DAMAGE, which is true of a person and
// of their pet alike, and `SourceKind 'other'` says exactly that and no more. The classic-EQ
// incumbents have the same hole (JOS-243's market survey: "session-fragile pet links needing
// /pet who leader per raid"), and they close it with hand-maintained blocklists — which this file
// will not grow. When a stronger model DOES claim the name, it takes the row back (`notePet`).
//
// MEMORY. Three sets and one cache, all keyed by canonical name and all session-scoped: bounded by
// the number of distinct names a session sees, one short string each. Measured on the owner's whole
// log: 1,342 shape verdicts cached, 608 recorded names, and — the number that actually bounds the
// aggregates — at most 45 distinct recorded combatants inside ONE zone stay (Befallen).

import { isPlayerShapedName } from '../../shared/playerShape'

export class OtherCombatants {
  /**
   * Name key → is it shaped like a player? Cached because the SHAPE of a name cannot change and
   * the question is asked on every mob-vs-mob line a busy raid log carries; the two regexes run
   * once per distinct name instead of once per line.
   */
  private shapes = new Map<string, boolean>()
  /**
   * Names a STRONGER MODEL has claimed as a pet — yours (petClaim / charm), somebody else's
   * (`My leader is …`), or self-declared (one of the six pet-voiced says). Absolute and permanent
   * for the session: the pet models are authoritative for pet attribution (JOS-430's brief), so
   * once one of them speaks, this ladder never books the name again and the row it already booked
   * is RETRACTED (state.ts `retractOther`).
   */
  private pets = new Set<string>()
  /**
   * Names that have LANDED DAMAGE ON YOU while shaped like a player.
   *
   * THE ONE RUNG THAT IS NEW, AND THE ONE THAT NEEDED MEASURING, because world-model law 4 says
   * the WIDER version of it is wrong: "being hit is something that HAPPENS to you, hitting is
   * something you DO". That law is about `notePlayer`, where a bad refusal DELETES real damage;
   * here a bad refusal only HIDES a row, so the trade is different — but it was measured anyway,
   * and twice:
   *
   *   * "it hit YOU" — 24 names on the owner's 2.19M-line log, and every one of them is a real
   *     single-word-named mob (Najena, Drelzna, Lockjaw, Gorgalosk, Phoboplasm, Bzzazzt, Terror,
   *     Fright, Dread, Xicotl, …). ZERO players. That is this rung.
   *   * "it hit anything of OURS" (your pets included) — MEASURED WRONG on the same log: it marked
   *     59 real players as mobs, because other people in the zone attack the mob YOU have charmed.
   *     Not shipped, recorded here so it is not re-derived.
   *
   * AND IT YIELDS TO THE HEAL STREAM (`clearHostile`). Law 4's own counterexample is a raid boss
   * mind-controlling your healer — `Sonista slashes YOU` 27 seconds before `Sonista healed you`.
   * A heal landing on you cannot come from a mob, so it outranks a swing at you and un-marks the
   * name; `notePlayer` already refuses anything you have struck or charmed, so the override can
   * never resurrect something you have been killing.
   */
  private hostiles = new Set<string>()
  /** Recorded name keys → the log's own spelling (world-model law 2: canonical key, raw display). */
  private seen = new Map<string, string>()

  reset(): void {
    this.shapes.clear()
    this.pets.clear()
    this.hostiles.clear()
    this.seen.clear()
  }

  /** Is `name` shaped the way EQ spells a one-word proper name? Cached per key. */
  shaped(name: string, key: string): boolean {
    const hit = this.shapes.get(key)
    if (hit !== undefined) return hit
    const v = isPlayerShapedName(name)
    this.shapes.set(key, v)
    return v
  }

  /** A stronger model claimed this name as a pet. Returns true the FIRST time, so the caller
   *  knows whether there is a row to retract. */
  notePet(key: string): boolean {
    if (key === '' || this.pets.has(key)) return false
    this.pets.add(key)
    return true
  }

  isPet(key: string): boolean {
    return this.pets.has(key)
  }

  /** It landed damage on you (see `hostiles`). */
  noteHostile(key: string): void {
    if (key !== '') this.hostiles.add(key)
  }

  /** The heal stream named it a player, which outranks a swing at you (see `hostiles`). */
  clearHostile(key: string): void {
    this.hostiles.delete(key)
  }

  isHostile(key: string): boolean {
    return this.hostiles.has(key)
  }

  /** Remember that this name has a recorded row, and how the log spells it. */
  note(key: string, display: string): void {
    if (!this.seen.has(key)) this.seen.set(key, display)
  }

  /** True once this name has booked at least one recorded row. */
  isRecorded(key: string): boolean {
    return this.seen.has(key)
  }

  /** The log's spelling for a recorded name — the meter row's label when the roster has none. */
  nameOf(key: string): string | undefined {
    return this.seen.get(key)
  }

  /** Every name currently carrying a recorded row. Diagnostics and tests only. */
  names(): string[] {
    return [...this.seen.values()]
  }

  /** A recorded row was retracted — the name stops being one of ours to display. */
  forget(key: string): void {
    this.seen.delete(key)
  }
}
