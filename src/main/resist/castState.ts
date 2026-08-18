// WHAT THE TAILED CHARACTER WAS DOING WHEN A CAST WENT OFF (JOS-387).
//
// Two Legends mechanics move a cast's resist adjust, and neither is a property of the spell: the
// upgrade RANK the log prints on the cast line, and the INVOCATION the character is currently
// reciting. `ResistFold` records both on every row it files, and this is the small state machine it
// asks — split out of the fold because it is one subject with its own argument and because the fold
// was over the repo's 400-code-line ceiling (the rule there is split, never ratchet).
//
// ── THE INVOCATION IS A STATE, AND IT IS NEVER ASSUMED ───────────────────────────────────────────
//
// EQ Legends has nine mutually-exclusive invocations and prints one line when you commit to one:
// `You begin reciting the <name> invocation.` The state holds until another is recited. So:
//
//   null   NOTHING HAS STATED IT. Before the log's first invocation line there is no honest answer,
//          and a character who logged in already overchannelling prints nothing at all — so an app
//          that guessed `false` would model a -150 offset as absent on every cast of the session.
//          The estimator counts those observations and refuses to weigh them.
//   true   the last one recited was overchannel.
//   false  it was one of the other eight.
//
// A RELOG CARRIES IT AND WE CANNOT SEE THAT, which is why nothing resets this on a zone line or a
// session boundary: the character keeps the invocation across a camp, and forgetting it would throw
// away a fact the log did state in favour of one it never will. Only starting a new SOURCE resets
// it, because that is a different log being folded from its own beginning.
//
// ── AND A PROC IS NOT A CAST SPELL ──────────────────────────────────────────────────────────────
//
// The wiki's -150 is on CAST spells, and the log has no field that says "this was a proc". What it
// has is the CAST LINE: a proc prints none. MEASURED on the owner's log — 19,874 Smiting Strike
// hits against 0 `You begin casting Smiting Strike`, and the same for Condemnation of Nife, the
// resistable adjust-0 proc that carries most of the informative evidence on some mobs. So joining
// an armed cast IS the test for "a cast spell", and an observation that joins none answers `false`.

import { spellCanonKey } from '../log/parseCommon'
import { casterClassCount } from '../../shared/resistFormula'
import type { ResistCasterKind } from '../../shared/resistTypes'

/** The invocation name (lowercased by the parser) that carries the -150 resist adjust. */
export const OVERCHANNEL_INVOCATION = 'overchannel'

/**
 * How long after a `You begin casting` a landing sentence may still be claimed by it. The JOS-382
 * brief says `castMs + 2.5 s`, which needs the client table; this is the repo's own measured
 * substitute — `buffAnchors.ts OWN_CAST_WINDOW_MS`, the constant the buffs model already uses for
 * exactly this join, and comfortably above the longest cast plus its slack.
 */
export const CAST_JOIN_MS = 10_000

/** How many casts can be in flight at once before the oldest stop being reachable. */
const MAX_ARMED = 16

/** ONE CAST IN FLIGHT, and everything an outcome line may read off it. */
export interface Armed {
  spellKey: string
  display: string
  ts: number
  kind: ResistCasterKind
  level: number | null
  /** The upgrade rank the cast line printed, 0 when it printed none (JOS-387). */
  rank: number
  /** The invocation state AT THE MOMENT OF THE CAST, which is the moment that decides the roll. */
  overchannel: boolean | null
  /**
   * Mobs this cast has already printed a DAMAGE line for. One cast is ONE roll, and a spell that
   * both damages and emotes prints both for it — so the emote must not also be counted.
   *
   * MEASURED, and the reason this is a set on the cast rather than a cancel on the emote: the game
   * prints the damage FIRST. "You hit a kodiak for 30 points of magic damage by Chaotic Feedback."
   * then "A kodiak's brain begins to smolder.", in that order, every time. A cancel-forward rule
   * (an emote's landing, withdrawn when damage follows) therefore never fires and doubles the count
   * of every nuke in the ledger — which is exactly what tests/fixtures/r1-kodiak-fight.log caught:
   * seven casts, seven damage lines, seven spurious landings on top. Both directions are covered
   * now, because a DoT's first tick can land either side of its emote.
   */
  damaged: Set<string>
}

/** The casts currently in flight. Bounded: only the last handful can still be in window. */
export class ArmedCasts {
  private casts: Armed[] = []

  reset(): void {
    this.casts = []
  }

  arm(cast: Armed): void {
    this.casts.push(cast)
    if (this.casts.length > MAX_ARMED) this.casts.splice(0, this.casts.length - MAX_ARMED)
  }

  /** A fizzle or an interrupt: a cast that never happened is not a resist. */
  disarm(spellKey: string): void {
    this.casts = this.casts.filter((a) => a.spellKey !== spellKey)
  }

  /** The most recent armed cast this line can belong to, WITHOUT consuming it. */
  peek(spellKey: string, ts: number): Armed | null {
    for (let i = this.casts.length - 1; i >= 0; i--) {
      const cast = this.casts[i]
      if (cast.spellKey !== spellKey) continue
      if (ts < cast.ts || ts - cast.ts > CAST_JOIN_MS) continue
      return cast
    }
    return null
  }

  /**
   * The armed cast an outcome may read its rank and invocation off — THIS CASTER's, never another's.
   * `peek` matches on the spell alone (its own reader only wants to mark a mob as damaged), and a
   * charmed pet throwing the same spell as you must not inherit your rank.
   */
  ownedBy(kind: ResistCasterKind, spellKey: string, ts: number): Armed | null {
    const cast = this.peek(spellKey, ts)
    return cast?.kind === kind ? cast : null
  }

  /** The most recent armed cast this landing sentence can belong to, consumed. */
  take(ts: number, candidates: string[] | undefined): Armed | null {
    const keys = candidates ? new Set(candidates.map(spellCanonKey)) : null
    for (let i = this.casts.length - 1; i >= 0; i--) {
      const cast = this.casts[i]
      if (ts < cast.ts || ts - cast.ts > CAST_JOIN_MS) continue
      if (keys && !keys.has(cast.spellKey)) continue
      this.casts.splice(i, 1)
      return cast
    }
    return null
  }
}

export class CastState {
  private overchannelOn: boolean | null = null
  private classes = 0
  /**
   * SONG SPELL KEY -> the last upgrade rank seen for it. Songs are the one family whose observations
   * do not come through an armed cast (under the Symphonic Aura there is no cast line at all), so a
   * pulse's rank has to be remembered from whichever line last printed one for that song.
   */
  private songRanks = new Map<string, number>()

  reset(): void {
    this.overchannelOn = null
    this.classes = 0
    this.songRanks = new Map()
  }

  /** `You begin reciting the <name> invocation.` The nine are mutually exclusive. */
  noteInvocation(invocation: string): void {
    this.overchannelOn = invocation === OVERCHANNEL_INVOCATION
  }

  /** The character's own `/who` row: the only line in the game that states the loadout. */
  noteClasses(classes: readonly string[]): void {
    this.classes = casterClassCount(classes)
  }

  noteSongRank(spellKey: string, rank: number): void {
    if (rank > 0) this.songRanks.set(spellKey, rank)
  }

  songRank(spellKey: string): number {
    return this.songRanks.get(spellKey) ?? 0
  }

  /** The state to arm a fresh cast of your own with — the moment that decides the roll. */
  get overchannel(): boolean | null {
    return this.overchannelOn
  }

  /**
   * How many non-hybrid caster classes the character runs: the -15-each half of the overchannel
   * adjust. Zero until a `/who` row is seen, which is the honest floor — the -150 is certain and
   * the rest is not, and the surfaces say so.
   */
  get casterClasses(): number {
    return this.classes
  }

  /**
   * THE INVOCATION AS ONE OBSERVATION SAW IT. `armed` is the cast it joined, or null when it joined
   * none. See the header for both rules: another caster's invocation is unknowable, and an
   * observation with no cast behind it is a proc.
   */
  invocationFor(kind: ResistCasterKind, armed: { overchannel: boolean | null } | null): boolean | null {
    if (kind !== 'self') return null
    return armed ? armed.overchannel : false
  }
}
