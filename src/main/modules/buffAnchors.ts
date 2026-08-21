// buffAnchors.ts — CAST-ANCHORED ATTRIBUTION, as one object both halves of the model share
// (JOS-140 ruling 2/3). Pure apart from the times it is told about; no events, no clock.
//
// THE RULE IT ENFORCES, in the owner's words: no bar without a cast line. EQ prints every landing
// sentence as a BROADCAST — `<mob> has been mesmerized.` and `<ally> is resistant to magic.` name
// no caster, and the mez sentence alone is four spells in the committed DB — so in a crowded zone
// the only thing separating your work from a stranger's is that you have a cast line and they do
// not. Three reports are what that costs when it is missing: phantom Focus Death bars on pets from
// a sentence six spells share and none of them cast by the player; another enchanter's mez filling
// the debuff window; a friendly buff filed as a debuff.
//
// WHY IT IS ONE OBJECT AND NOT TWO. Before this ticket the cast history existed TWICE — once in
// `modules/buffs.ts` (key → ts) and once in `modules/buffTimers.ts` (key → ts) — folded from the
// same events, cleared on different rules, and used to answer the same question. Two copies of an
// attribution rule is how the two systems this ticket unifies drifted apart; there is now one.
//
// THE THREE ANCHOR FORMS are documented on {@link CastAnchor}. What matters here is that the
// Quick Buff form names no spell, so it can only ever say "a cast of YOURS landed in this window"
// — never which one. A landing it admits whose sentence is shared by several spells therefore
// stays a FAMILY: the row names every candidate, the ~ chip says so, and a duration is stated only
// when the candidates agree on one. That is the owner's amendment folded in without weakening
// anything: the anchor is evidence the player cast, in whatever form the log states it, and it is
// still never a guess at WHICH spell.

import type { BuffTrustPrefs } from '../../shared/buffTrust'
import { casterKey, casterTrusted, DEFAULT_BUFF_TRUST_PREFS, SELF_CASTER } from '../../shared/buffTrust'
import { OWN_CAST_WINDOW_MS, QUICK_BUFF_WINDOW_MS, spellKey, type CastAnchor } from './buffsShapes'

/** What admitted a landing, and by whom — the caller needs the caster to key the learner. */
export interface Attribution {
  caster: string
  /** The RANKED display name from the cast line, when the anchor named a spell. */
  display?: string
  /**
   * WHEN THE LINE THAT ADMITTED THIS LANDING WAS PRINTED — the cast's own ts, or the Quick Buff
   * activation's for an `unnamed` one (JOS-410).
   *
   * It is here rather than re-derived from {@link CastAnchors.lastCastTs} because that map is the
   * WEAKER, SELF-ONLY signal (see `everCast`): it is never written for an allowlisted external, so
   * a reader that ranked anchors by it would silently rank every external cast last. This is the
   * ts of the anchor the gate actually admitted, whoever cast it.
   */
  ts: number
  /** True when the anchor cannot say which rank landed (two ranks inside one window). */
  rankChanged: boolean
  /** True when the anchor named no spell at all (a Quick Buff burst) — so it cannot narrow. */
  unnamed: boolean
}

/**
 * TWO RANKS IN ONE WINDOW is a real ambiguity, not paranoia: the landing sentence carries no rank,
 * so a `Mesmerization III` and a `Mesmerization VII` both in flight leaves nothing that can say
 * which one landed. The flag rides forward so the SAMPLE is refused (ruling 5); the ROW is still
 * drawn, because which rank it is does not change that the mob is held.
 */
function isRankChange(prev: CastAnchor | undefined, display: string, ts: number, caster: string): boolean {
  if (!prev) return false
  return prev.caster === caster && prev.display !== display && ts - prev.ts <= OWN_CAST_WINDOW_MS
}

export class CastAnchors {
  /** Newest anchor per rank-STRIPPED line key. Cleared by a fizzle/interrupt. */
  private byLine = new Map<string, CastAnchor>()
  /**
   * Newest ts this line was ever cast, whatever became of the cast — the WEAKER signal, and a
   * different question from the anchor above.
   *
   * An anchor says "a cast of yours is close enough to this landing to own it", so a fizzle
   * retracts it: the cast did not land, and nothing it might have resolved is ours. Knowing the
   * spell is in your book is not retracted by fizzling it, and that is a real narrowing for a
   * Quick Buff burst, whose activation line names no spell: `A cool breeze slips through your
   * mind.` is Clarity plus siblings, and the one you have ever cast is the one you own. (The
   * golden windows PRIME exactly for this. Merging the two maps made a single interrupted cast
   * three seconds before a burst erase the knowledge that the burst then needed — measured on
   * tests/fixtures/w17-priming.log.)
   */
  private everCast = new Map<string, number>()
  /** ts of the last `You activate Quick Buff.` — the spell-less self anchor. */
  private quickBuffTs = 0
  /** Who may anchor at all. Default: you and nobody else. */
  private trust: BuffTrustPrefs = DEFAULT_BUFF_TRUST_PREFS

  reset(): void {
    this.byLine = new Map()
    this.everCast = new Map()
    this.quickBuffTs = 0
  }

  /** The externals allowlist (Preferences). Replacing it never retro-admits an old landing. */
  setTrust(prefs: BuffTrustPrefs): void {
    this.trust = prefs
  }

  trustPrefs(): BuffTrustPrefs {
    return this.trust
  }

  /**
   * `You begin casting <S>.` / `You begin singing <S>.` — the self anchor, and the only line in
   * the family that carries a RANK.
   */
  noteSelfCast(spell: string, ts: number): void {
    this.note(spell, ts, SELF_CASTER)
  }

  /**
   * `<Name> begins casting <S>.` — the third-person cast line. It is recorded ONLY for a caster on
   * the externals allowlist: an anchor from anybody else is exactly the stranger's-buff case the
   * gate exists to refuse, and keeping it would make the refusal a matter of who asked later.
   */
  noteOtherCast(caster: string, spell: string, ts: number): boolean {
    if (!casterTrusted(this.trust, caster)) return false
    this.note(spell, ts, casterKey(caster))
    return true
  }

  private note(spell: string, ts: number, caster: string): void {
    const key = spellKey(spell)
    const prev = this.byLine.get(key)
    const display = spell.trim()
    this.byLine.set(key, { display, ts, caster, rankChanged: isRankChange(prev, display, ts, caster) })
    // SELF ONLY. An external's cast tells you nothing about what is in YOUR spellbook, and this
    // map's only job is narrowing a burst of yours.
    if (caster === SELF_CASTER) {
      const prevEver = this.everCast.get(key)
      if (prevEver == null || ts > prevEver) this.everCast.set(key, ts)
    }
  }

  /** `You activate Quick Buff.` — a self anchor that names a WINDOW rather than a spell. */
  noteQuickBuff(ts: number): void {
    this.quickBuffTs = ts
  }

  /** A fizzle/interrupt: the cast did not land, so nothing it might have resolved is ours. */
  clearCast(spell: string): void {
    this.byLine.delete(spellKey(spell))
  }

  /** True when a Quick Buff burst is in flight at `ts`. */
  private inQuickBuffBurst(ts: number): boolean {
    return this.quickBuffTs > 0 && ts >= this.quickBuffTs && ts - this.quickBuffTs <= QUICK_BUFF_WINDOW_MS
  }

  /**
   * THE GATE. What (if anything) admits a landing of `spell` at `ts`?
   *
   * A NAMED anchor wins: it says who cast it, which rank, and therefore which learner key the
   * sample belongs to. Failing that, a Quick Buff burst admits the landing as YOURS but `unnamed`,
   * because the activation line names no spell — the caller must not treat that as narrowing.
   * Nothing else admits anything (ruling 3: an unanchored landing produces nothing).
   */
  attribute(spell: string, ts: number): Attribution | null {
    const a = this.byLine.get(spellKey(spell))
    if (a != null && ts >= a.ts && ts - a.ts <= OWN_CAST_WINDOW_MS && casterTrusted(this.trust, a.caster)) {
      return { caster: a.caster, display: a.display, ts: a.ts, rankChanged: a.rankChanged, unnamed: false }
    }
    if (this.inQuickBuffBurst(ts)) {
      return { caster: SELF_CASTER, ts: this.quickBuffTs, rankChanged: false, unnamed: true }
    }
    return null
  }

  /** True when this exact spell has a NAMED anchor in window — the candidate-narrowing test. */
  namedAnchorFor(spell: string, ts: number): Attribution | null {
    const at = this.attribute(spell, ts)
    return at && !at.unnamed ? at : null
  }

  /** The newest ts YOU ever cast this line — the ambiguous-apply recency tiebreak. */
  lastCastTs(spell: string): number | undefined {
    return this.everCast.get(spellKey(spell))
  }
}
