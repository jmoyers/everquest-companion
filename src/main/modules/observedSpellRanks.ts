// observedSpellRanks module (JOS-446) — WHICH RANK OF EACH SPELL THIS CHARACTER ACTUALLY HAS.
//
// WHY IT EXISTS. EQ Legends re-tiers the classic spells as roman-numeral RANKS of one base name,
// and the committed catalog knows nothing about that: it carries a single unsuffixed row for
// ~1,800 of its ~1,900 spells (shared/spellLines.ts states the measurement). So every surface
// that names a spell has been naming the BASE — the unlock list offers you `Clarity` when the
// scroll in your bags says `Clarity III` — and the app had no way to say which rung you are on.
// The log says it twice a session and both statements were discarded.
//
// WHAT COUNTS AS EVIDENCE (law 1: messages over inference; unknown is never rank 1). Two
// families, and the ASYMMETRY between them is the design:
//
//   1. THE MERGE LINE proves the MOMENT OF LEVELLING. `You have successfully merged two items
//      together to create a new item: Shiftless Deeds III` is the same sentence an item upgrade
//      prints — modules/itemTiers.ts folds the ` +N` half of it and deliberately counts the
//      rank-suffixed half as a merge with no tier. That half is this module's. It is dated: you
//      held rank II and now hold rank III.
//   2. A CAST AT A RANK proves POSSESSION. `You begin casting Shiftless Deeds IV.` and
//      `<mob> resisted your Shiftless Deeds IV!` are the two families that keep the numeral (the
//      fizzle / interrupt / wear-off lines all drop it — AGENTS.md's rank-blindness law is about
//      exactly that). They are undated as acquisitions and are the ONLY witness for a rank you
//      levelled before you started logging: `Lay on Hands IX` is cast all over the owner's log
//      and merged nowhere in it.
//
// UNION, HIGHEST WINS. `rank` is the max over both families; `mergedRank` and `castRank` keep the
// two halves separately so a reader can still tell "you levelled this here" from "you were seen
// using it". A LOWER later observation never lowers anything — ranks do not downgrade (AGENTS.md
// carries the owner's ruling verbatim), and in any case several copies of a scroll climb in
// parallel exactly the way item tiers do.
//
// THE MERGE LANE NEEDS THE CATALOG; THE CAST LANE DOES NOT. A merge line names an ITEM, and an
// item whose name happens to end in a roman numeral is not a spell — so a merge is admitted only
// when its base name joins the spell catalog (`knownSpell`, the injected `spellDb.byKey` probe).
// A cast line names a spell BY CONSTRUCTION, so it is admitted whatever the catalog knows: the
// measured case is `Lay on Hands`, which the wiki scrape carries no page for and which the owner
// casts at rank IX.
//
// UNSUFFIXED NAMES ARE NOT EVIDENCE. `You begin casting Clarity.` is what an un-upgraded spell
// prints and is also what most of the game prints; folding it would mint a rank-1 row for every
// spell ever cast, and rank 1 is the default state rather than an observation. Only a name
// carrying a numeral makes or advances a row.
//
// CHARACTER-SCOPED, EPOCH-AWARE — the same rule loot / kills / itemTiers live by. The user's
// wiped beta character merged `Instrument of Nife II` and cast `Lay on Hands IV` in the same log
// file; none of it is the current character's. On the derived `epoch` event the whole map drops.
//
// WHAT IT DOES NOT DO YET, AND THE HONEST CONSEQUENCE. Nothing here changes a single METRIC. The
// figures the unlock rows and the spell card print (`shared/spellMetrics.ts`) are read off the
// wiki's effect list for the BASE spell, so for a spell you hold at rank IV they UNDERSTATE what
// it does — a ranked spell's damage, heal and duration all climb with the rank and no committed
// source in this repo states by how much. The rank chip is the honest statement that the numbers
// beside it are the line's, not yours; the engine that re-reads them per rank is JOS-447. This is
// said HERE and not on screen on purpose (AGENTS.md's caveat diet).

import type { EqModule } from './types'
import type { LogEvent } from '../../shared/logEvents'
import type {
  ObservedSpellRankRow,
  ObservedSpellRanksDelta,
  ObservedSpellRanksSnap
} from '../../shared/spellRanks'
import { OBSERVED_SPELL_RANKS_MODULE_ID } from '../../shared/spellRanks'
// THE repo's rank fold, imported rather than re-spelled: `spellCanonKey` is what every other
// index keyed by a spell name uses, so a row this module writes is reachable by every existing
// caller's key. `parseSpellRank` is the shared mirror that KEEPS what that fold strips — the
// numeral and the base name with its own casing — and tests/spellLines.test.mts pins the two
// tails equal, which is what makes reading the name twice safe.
import { spellCanonKey } from '../log/parseCommon'
import { parseSpellRank } from '../../shared/spellLines'

/** Everything the fold needs from outside itself. */
export interface ObservedSpellRanksDeps {
  /**
   * True when `key` (a `spellCanonKey`) names a line the committed catalog carries. It gates the
   * MERGE lane only — see the header. Absent ⇒ no merge is ever admitted, which is the safe
   * default for a caller with no DB: it withholds a claim rather than inventing spells out of
   * item names.
   */
  knownSpell?: (key: string) => boolean
}

/** Which witness an observation came from. The two are kept apart on the row. */
type Witness = 'merge' | 'cast'

export class ObservedSpellRanksModule
  implements EqModule<ObservedSpellRanksSnap, ObservedSpellRanksDelta>
{
  readonly id = OBSERVED_SPELL_RANKS_MODULE_ID
  private rows: ObservedSpellRanksSnap = {}
  private seq = 0
  private dirty = new Set<string>()
  private readonly knownSpell: (key: string) => boolean

  constructor(deps: ObservedSpellRanksDeps = {}) {
    this.knownSpell = deps.knownSpell ?? ((): boolean => false)
  }

  reset(): void {
    this.rows = {}
    this.seq = 0
    this.dirty.clear()
  }

  onEvent(ev: LogEvent): void {
    this.seq = ev.seq
    if (ev.kind === 'epoch') {
      // Character rebirth: every rank before the boundary belongs to the dead beta character.
      this.rows = {}
      this.dirty.clear()
      return
    }
    if (ev.kind === 'itemMerge') {
      // A ` +N` result is an item level (itemTiers.ts owns it) and carries no numeral, so it
      // falls out of `observe` on the rank test without needing a second check here.
      this.observe(ev.item, ev.ts, 'merge')
      return
    }
    if (ev.kind === 'castBegin') {
      this.observe(ev.spell, ev.ts, 'cast')
      return
    }
    // `<target> resisted your <Spell> <rank>!` — YOUR cast, named with its numeral. The other two
    // resist shapes are somebody else's spell (a pet, a mob, or one you resisted), and a stranger
    // casting rank VI says nothing about what you own.
    if (ev.kind === 'resist' && !ev.incoming && ev.caster === 'you') {
      this.observe(ev.spell, ev.ts, 'cast')
    }
  }

  /**
   * Fold one observation of `raw` (a display name that may carry a roman numeral) at `ts`.
   *
   * An UNSUFFIXED name is not evidence and returns immediately, so this is also the cheap exit
   * for the overwhelming majority of casts and for every ` +N` item merge.
   */
  private observe(raw: string, ts: number, how: Witness): void {
    const { base, rank, suffixed } = parseSpellRank(raw)
    if (!suffixed || !base) return
    const key = spellCanonKey(raw)
    if (!key) return
    if (how === 'merge' && !this.knownSpell(key)) return
    const prev = this.rows[key]
    // `base` keeps the raw casing and punctuation the LOG used ("Togor's Insects") while the key is
    // the lowercased fold — law 2's canonicalize-at-the-boundary split, the same one itemTiers makes
    // between `key` and `name`. The FIRST spelling seen wins and is never rewritten: the log outranks
    // the wiki on names (the JOS-440 ruling), so there is nothing a later sighting could improve.
    const next: ObservedSpellRankRow = prev
      ? { ...prev, lastAt: ts }
      : { key, name: base, rank: 0, merges: 0, firstAt: ts, lastAt: ts }
    if (how === 'merge') {
      next.merges += 1
      next.mergedRank = Math.max(prev?.mergedRank ?? 0, rank)
    } else {
      next.castRank = Math.max(prev?.castRank ?? 0, rank)
    }
    next.rank = Math.max(next.rank, rank)
    this.rows[key] = next
    this.dirty.add(key)
  }

  snapshot(): { seq: number; state: ObservedSpellRanksSnap } {
    return { seq: this.seq, state: this.rows }
  }

  flushDelta(): { seq: number; delta: ObservedSpellRanksDelta } | null {
    if (this.dirty.size === 0) return null
    const changed: ObservedSpellRanksSnap = {}
    for (const key of this.dirty) changed[key] = this.rows[key]
    this.dirty.clear()
    return { seq: this.seq, delta: { changed } }
  }
}
