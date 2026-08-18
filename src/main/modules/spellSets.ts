// WHAT IS IN YOUR GEMS, AND WHICH NAMED SET HOLDS IT (JOS-391) — the fold.
//
// `shared/spellSets.ts` carries the shape and the two rules that make this model honest (presence
// only; a set is its LATEST definition). This file is the state machine over the three events
// `classifySpellGems` emits, and it exists for one row on the Leveling tab: when a new spell
// replaces something you already own, say whether the thing being replaced is in your bar right
// now and which of your saved sets would put it back.
//
// ── A SAVE IS AN INSTANT, A LOAD IS A BURST ────────────────────────────────────────────────────
//
// The two spell-set lines mean structurally different things, and reading them the same way is
// how this module would be wrong the first time the owner used it.
//
// `Spell set primary saved.` is a photograph. The bar is already what the player wants, and the
// line records it. So the set's definition becomes the memorized state AT THAT INSTANT, replacing
// whatever it was — which is exactly the "swap one gem and save over" the owner named: the newest
// save IS the set, and the older definition is not kept anywhere.
//
// `Spell set dam loaded.` is a starting pistol. MEASURED in the owner's log (2026-07-19 21:46:20):
// the load line is followed IN THE SAME SECOND by ten `You forget` lines, and then the memorizes
// trickle in over the next ten seconds as each gem finishes. Reading the memorized state at the
// load line would record a bar that has been emptied and not yet refilled — a set of nothing. So a
// load opens a PENDING window and the definition is taken when the burst SETTLES.
//
// SETTLE = 10 s with no memorize/forget line, OR the next spell-set line, whichever comes first.
// Both halves are needed and the same log span shows why: at 21:46:20 the load's own burst runs to
// 21:46:30, and then the player KEEPS SWAPPING by hand — forget at :31, memorize at :40, forget at
// :43, memorize at :46, forget at :49, memorize at :53 — never leaving a ten-second gap, until
// `Spell set dam saved.` at :57 closes it. Without the second half the window would extend for as
// long as somebody kept fiddling; without the first, a load nobody follows up would never close.
// The begin lines count as activity too, which is why `classifySpellGems` emits them: a memorize
// that takes three seconds keeps the window open through its own casting time.
//
// THE CLOCK IS THE LOG'S. Every event advances it, not just gem events — a chat line at
// `load + 11s` is proof that eleven seconds passed with no gem activity. `onTick` does the same
// job from the wall clock for the case a live log falls silent entirely.
//
// UNTIL IT SETTLES, THE SET IS STILL ITS PREVIOUS DEFINITION. Nothing is cleared on the load line,
// so a reader mid-burst sees the set it saw a second ago rather than an empty one. That is the
// only reading that never states something false.
//
// PERSISTS NOTHING. Epoch-cleared like every module here: gems belong to a character, and a
// rebirth behind the same name is a different bar.

import type { EqModule } from './types'
import type { LogEvent } from '../../shared/logEvents'
import {
  SPELL_SETS_SHAPE_VERSION,
  memoKey,
  type SpellSetDef,
  type SpellSetsDelta,
  type SpellSetsSnap
} from '../../shared/spellSets'

/** No memorize or forget line for this long and a load's burst is over. Measured; see the header. */
export const SETTLE_MS = 10_000

/** A `loaded` line whose burst has not finished yet. */
interface PendingLoad {
  set: string
  /** The last memorize/forget/begin line seen since the load — the settle clock's anchor. */
  lastActivityTs: number
}

export class SpellSetsModule implements EqModule<SpellSetsSnap, SpellSetsDelta> {
  readonly id = 'spellSets'
  /** Insertion-ordered so a set's spell list reads in the order the gems were observed. */
  private memorized = new Map<string, string>()
  private sets = new Map<string, SpellSetDef>()
  private pending: PendingLoad | null = null
  private seq = 0
  private dirty = false

  reset(): void {
    this.memorized = new Map()
    this.sets = new Map()
    this.pending = null
    this.seq = 0
    this.dirty = false
  }

  onEvent(ev: LogEvent): void {
    this.seq = ev.seq
    if (ev.kind === 'epoch') {
      // A rebirth behind the same name is a different character's bar (the standing module rule).
      this.reset()
      return
    }
    // EVERY event advances the settle clock, because the passage of time is what settles a burst
    // and any timestamped line is evidence of it.
    this.settleIfIdle(ev.ts)
    if (ev.kind === 'spellMemorize') this.onMemorize(ev.ts, ev.spell, ev.done)
    else if (ev.kind === 'spellForget') this.onForget(ev.ts, ev.spell)
    else if (ev.kind === 'spellSet') this.onSpellSet(ev.ts, ev.set, ev.action)
  }

  /**
   * The wall-clock half of the settle rule (the registry calls this ~1x/sec on a live tail).
   *
   * A player who loads a set and then stops playing leaves a burst open forever otherwise: log
   * timestamps only advance when the log prints, and an idle client prints nothing.
   */
  onTick(nowMs: number): void {
    this.settleIfIdle(nowMs)
  }

  /** A finished memorize loads the gem; a begin line only proves the player is still working. */
  private onMemorize(ts: number, spell: string, done: boolean): void {
    this.noteActivity(ts)
    if (!done) return
    this.memorized.set(memoKey(spell), spell.trim())
    this.dirty = true
  }

  private onForget(ts: number, spell: string): void {
    this.noteActivity(ts)
    if (this.memorized.delete(memoKey(spell))) this.dirty = true
  }

  /** Gem activity keeps an open load window open. */
  private noteActivity(ts: number): void {
    if (this.pending) this.pending.lastActivityTs = ts
  }

  /**
   * A spell-set line. It CLOSES any open load first (the "whichever comes first" half of the
   * settle rule) and then does its own work.
   */
  private onSpellSet(ts: number, set: string, action: 'saved' | 'loaded' | 'deleted'): void {
    this.settleNow(ts)
    if (action === 'saved') {
      this.define(set, ts, 'saved')
      return
    }
    if (action === 'deleted') {
      if (this.sets.delete(set)) this.dirty = true
      return
    }
    // `loaded`: the bar is about to be rewritten. Nothing changes until the burst settles.
    this.pending = { set, lastActivityTs: ts }
  }

  /** Replace a set's definition with the memorized state right now. */
  private define(set: string, ts: number, source: SpellSetDef['source']): void {
    this.sets.set(set, { spells: [...this.memorized.values()], observedAt: ts, source })
    this.dirty = true
  }

  /** Close an open load window if the log has been quiet long enough. */
  private settleIfIdle(ts: number): void {
    if (this.pending && ts - this.pending.lastActivityTs >= SETTLE_MS) this.settleNow(ts)
  }

  /**
   * Close an open load window NOW, recording the bar as it stands.
   *
   * `observedAt` is the settle time rather than the load line's: the definition describes the bar
   * at the moment it was read, and stamping it with the load would date a photograph by when the
   * shutter was pressed rather than when it opened.
   */
  private settleNow(ts: number): void {
    const open = this.pending
    if (!open) return
    this.pending = null
    this.define(open.set, ts, 'loaded')
  }

  private state(): SpellSetsSnap {
    return {
      v: SPELL_SETS_SHAPE_VERSION,
      memorized: [...this.memorized.values()],
      sets: Object.fromEntries([...this.sets].map(([name, def]) => [name, { ...def, spells: [...def.spells] }]))
    }
  }

  snapshot(): { seq: number; state: SpellSetsSnap } {
    return { seq: this.seq, state: this.state() }
  }

  /** The whole state, for the reason shared/spellSets.ts states: it is a few hundred bytes. */
  flushDelta(): { seq: number; delta: SpellSetsDelta } | null {
    if (!this.dirty) return null
    this.dirty = false
    return { seq: this.seq, delta: this.state() }
  }
}
