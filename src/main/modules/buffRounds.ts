// buffRounds.ts — ONE ANSWER TO "HOW MANY OF THAT NAME ARE HELD, AND WHICH ONE JUST ENDED"
// (JOS-140, rulings 5 and 7). Pure: no events, no clock of its own, no Electron.
//
// THE PROBLEM, MEASURED. EQ stamps are second-resolution and print no instance identifier, so one
// AE mez landing on five mobs that share a name is FIVE BYTE-IDENTICAL LINES in one second. The
// reporter's slice (01KZJHXJVAA7FNRDW83CTAYSF8) does exactly that nine times over three minutes:
// nine casts, fifty landings, twenty-one wear-offs, across four distinct names. The old CC half
// kept one hold per NAME and overwrote its clock on every line, so a round of nine landings became
// four rows and the first wear-off deleted a row that four more wear-offs then failed to find.
//
// THE MODEL. One group per (spell line, entity NAME). A group holds a LIST of landings, oldest
// first — one per mob of that name we believe is held — and the UI draws ONE ROW with a COUNT CHIP
// (ruling 7), because five identical rows with five identical clocks is noise, not information.
//
// A ROUND is every landing sharing one log second. Its rule is the only interesting thing here:
//
//   a round of N landings on a group already holding M refreshes min(N, M) of them, NEWEST FIRST,
//   and appends the remaining max(0, N - M).
//
// Both halves of that are the owner's ruling and both are load-bearing. REFRESHING rather than
// appending is what keeps a re-mez of five mobs at a count of five instead of ten — the count is
// what is held, not what has ever landed. NEWEST-first refresh, paired with OLDEST-first closing
// below, is what makes the row's clock a prediction of the next wear-off line rather than an
// average of several.
//
// CLOSING IS OLDEST-FIRST, for the same reason and with the same honesty: `Your <S> spell has worn
// off of <mob>.` names the mob but not WHICH mob of that name, so under a fixed duration the
// oldest landing is the maximum-likelihood one to have just ended. Nothing else in the log
// separates them (world-model law 6's non-distinguishables).
//
// CLEAN CYCLES (ruling 5) are the whole reason the bookkeeping is this careful. A duration sample
// may be minted ONLY from a landing that was alone in its round, on a group that was empty when
// the round opened, and that nothing touched before its wear-off. Everything else — a same-second
// sibling, a refresh, a wear-off with no hold behind it, a zone/death/gap clear — CONTAMINATES,
// and a contaminated landing mints nothing. Measured against the reporter's slice this admits
// exactly two of fifty-eight cycles (43 s and 44 s), which is the correct yield for a fifteen
// minute AE-mez grind: they are the two rounds whose mob name happened to be unique.

/** One landing: a mob of this name we believe is still held, and whether it is still measurable. */
export interface Hold {
  /** Event ts (ms) the landing (or its most recent refresh) happened. Never a wall clock. */
  startedTs: number
  /**
   * True while this landing is still a candidate for a duration SAMPLE. Set false the moment
   * anything ambiguous touches it; never set back to true — contamination is one-way, because the
   * doubt it records does not go away when the next clean-looking line arrives.
   */
  clean: boolean
}

/** What `closeOldest` did, so the caller can decide whether a sample was earned. */
export interface Closed {
  hold: Hold
  /** The span in ms, or null when the hold was contaminated (ruling 5: no sample). */
  sampleMs: number | null
}

/**
 * The landings of ONE (spell line, entity name) pair. Mutable by design — one of these lives
 * inside each live instance, and the module that owns it is the only writer.
 */
export class HoldGroup {
  /** Oldest first. `length` is the row's count chip. */
  readonly holds: Hold[] = []

  /**
   * A SINGLETON group is one the model holds an IDENTITY for, not just a name — you, your
   * summoned pet, your charmed pet (world-model law 4: entities, not names). There can only ever
   * be one of it, so a later landing is unambiguously a REFRESH of the same thing: the clock
   * resets and the cycle stays CLEAN, which is what lets a re-cast Swift Like the Wind still mint
   * one honest full cycle instead of an inflated land-to-fade span.
   *
   * A non-singleton group is keyed by a NAME the world can duplicate — a hostile mob, and every
   * crowd-control hold. There, a later landing is either the same mob re-hit or a second mob of
   * that name newly hit, no line separates them, and the ambiguity is exactly what ruling 5
   * refuses to learn from.
   */
  constructor(private readonly singleton = false) {}

  /** The log second the current round belongs to, or -1 before the first landing. */
  private roundTs = -1
  /** How many landings of the current round have been consumed (refreshes first, then appends). */
  private roundUsed = 0
  /** How many landings the group held when the current round OPENED — the min(N, M) of the rule. */
  private roundStartCount = 0

  get count(): number {
    return this.holds.length
  }

  get empty(): boolean {
    return this.holds.length === 0
  }

  /** The clock the ROW draws: the oldest landing, i.e. the one the next wear-off will close. */
  get oldestTs(): number {
    return this.holds.length > 0 ? this.holds[0].startedTs : 0
  }

  /** The newest landing — what a "when did I last refresh this" reading wants. */
  get newestTs(): number {
    return this.holds.length > 0 ? this.holds[this.holds.length - 1].startedTs : 0
  }

  /** True when at least one landing is still a clean sample candidate. */
  get anyClean(): boolean {
    return this.holds.some((h) => h.clean)
  }

  /**
   * A landing at `ts`. See the round rule in this file's header; `contaminated` lets the caller add
   * reasons of its own (a family that never narrowed to one spell, two ranks in the cast window,
   * an unresolvable caster) without this module having to know what any of them are.
   */
  land(ts: number, contaminated = false): void {
    if (this.singleton) {
      // One identity, one landing. A re-cast RESETS the clock so the next wear-off measures the
      // fresh cast rather than the sum of the leftover and the new duration (the refresh-inflation
      // defence JOS-117 pinned), and it stays measurable because there is nothing to confuse it
      // with.
      const hold = this.holds[0]
      if (hold) {
        hold.startedTs = ts
        hold.clean = !contaminated
      } else {
        this.holds.push({ startedTs: ts, clean: !contaminated })
      }
      return
    }
    if (ts !== this.roundTs) {
      this.roundTs = ts
      this.roundUsed = 0
      this.roundStartCount = this.holds.length
    }
    // A landing is CLEAN only if it opened a group that was EMPTY and is alone in its round so
    // far. The second half is provisional: a sibling later in the same round retroactively dirties
    // it, which `contaminateRound` below does.
    const clean = !contaminated && this.roundStartCount === 0 && this.roundUsed === 0
    if (this.roundUsed < this.roundStartCount) {
      // REFRESH, NEWEST FIRST. A re-landing is either the same mob re-hit or a different mob of
      // that name newly hit, and no line separates them, so we take the bounded reading: the row
      // never grows a ghost, and the landing stops being measurable. Newest-first keeps the list
      // sorted (the newest already carried the largest ts) while leaving the oldest clock — the
      // one the next wear-off will close — where it was.
      const hold = this.holds[this.roundStartCount - 1 - this.roundUsed]
      hold.startedTs = ts
      hold.clean = false
    } else {
      if (this.roundUsed > 0) this.contaminateRound()
      this.holds.push({ startedTs: ts, clean })
    }
    this.roundUsed += 1
  }

  /** Every landing of the current round loses its clean flag — a round of two is two mobs. */
  private contaminateRound(): void {
    for (const h of this.holds) {
      if (h.startedTs === this.roundTs) h.clean = false
    }
  }

  /**
   * A line said one of these ended. Closes the OLDEST (see the header) and reports whether it was
   * clean enough to mint. A close with nothing to close returns null AND contaminates the group:
   * a wear-off with no hold behind it is proof the model under-counted, which is exactly the state
   * in which a later span would be measured against the wrong landing.
   */
  closeOldest(ts: number): Closed | null {
    const hold = this.holds.shift()
    if (!hold) {
      this.contaminateAll()
      return null
    }
    const span = ts - hold.startedTs
    return { hold, sampleMs: hold.clean && span > 0 ? span : null }
  }

  /** Every landing stops being measurable (a zone, a death, a gap, a rule the caller enforces). */
  contaminateAll(): void {
    for (const h of this.holds) h.clean = false
  }

  /**
   * Drop every landing older than `cutoffTs` — the hygiene sweep's half of the bookkeeping — and
   * hand the dropped landings BACK, oldest first.
   *
   * IT STILL MINTS NOTHING, AND THE RETURN VALUE DOES NOT CHANGE THAT (JOS-180). A cull is not an
   * observation: nobody saw the hold end, so there is no span to learn from and this method has no
   * business inventing one. What the caller gets back is the landing itself — a START time and its
   * `clean` flag — so a break line that arrives AFTER the cull can still be matched to the landing
   * it belongs to and measured through the ordinary rules. The difference is the whole of JOS-180:
   * the cull throwing the landing on the floor is what made a wear-off arriving one grace-period
   * late teach the learner nothing, forever. Retiring the ROW is unchanged and stays law
   * (JOS-149/156); only the memory of what was on it survives, and only in the module above.
   */
  dropExpired(cutoffTs: number): Hold[] {
    let n = 0
    while (n < this.holds.length && this.holds[n].startedTs <= cutoffTs) n += 1
    return this.holds.splice(0, n)
  }

  /**
   * Shift the clocks of every landing at or before `onlyBefore` forward by `offsetMs` — the
   * offline PAUSE (JOS-134), and the only place a live clock moves at all. Re-sorts afterwards
   * because a shifted older landing can legitimately overtake an un-shifted newer one, and the
   * oldest-first ordering is what `closeOldest` means.
   */
  shiftBy(offsetMs: number, onlyBefore: number): boolean {
    let changed = false
    for (const h of this.holds) {
      if (h.startedTs > onlyBefore) continue
      h.startedTs += offsetMs
      changed = true
    }
    if (changed) this.holds.sort((a, b) => a.startedTs - b.startedTs)
    return changed
  }
}
