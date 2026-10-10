// planner/planHorizon.ts — HOW FAR THE ROUTE RUNS, AND WHERE ITS BRACKETS FALL.
//
// Split out of `progressionPlan.ts` when the level cap took that file past this tree's 400-line
// ceiling. The seam is the one the cap drew: that file decides what goes IN a bracket, and this one
// decides which brackets there are. Pure, no imports.

/** A bracket's bounds, before it has any content. */
export interface Bracket {
  from: number
  to: number
  /** the bracket that reaches the level cap - see `LAST_BRACKET_ROOM` */
  last?: boolean
}

/** Plan §8: "a first guess", and the fold takes it as an input so tuning it is a constant. */
const DEFAULT_BRACKET_SIZE = 6
/**
 * THE LEVEL CAP, and the route ends at it (owner, 2026-09-26, reading a level-37 route that ran to
 * 73-78: *"why the heck is the gear recommended tab showing things above level 50???"*).
 *
 * The route used to have no cap, on the argument that the server's is in no data this repo holds.
 * That is true and it was still the wrong call, twice over. A bracket past the cap is advice for a
 * level nobody can be, and its difficulty is judged AT that level: Plane of Sky read `safe` in a
 * 67-72 bracket. The number is the owner's statement, and `resistFormula.ts` already states the
 * same one. It is an input with this default, so the day the server raises it is a one-line change.
 */
export const LEVEL_CAP = 50
/**
 * THE LAST BRACKET HOLDS FOUR BRACKETS' WORTH. What a display cap cut used to surface in a later
 * bracket (`progressionPlan.ts bracketOf`); at the cap there is no later bracket, and the cap is where a character
 * spends the rest of the game, so that is where the longest list belongs.
 */
export const LAST_BRACKET_ROOM = 4
/** How many consecutive silent brackets end the route. Two, so one gap does not truncate a plan. */
export const QUIET_BRACKETS = 2

/** What `bracketsFrom` reads off the plan's inputs. */
export interface HorizonInputs {
  level: number
  bracketSize?: number
  levelCap?: number
}

/**
 * EVERY BRACKET THE ROUTE MAY OPEN, in order: `bracketSize` levels each from the character's
 * CURRENT level, none opening past the cap and the last ending on it. The caller stops early when
 * the corpus goes quiet (`QUIET_BRACKETS`); this is only the furthest it may go. The cap is also
 * what keeps a corpus that never goes quiet from looping: the old 36-level backstop that did that
 * job before the cap existed stopped a level 1-8 character short of 50, in a bracket not `last`.
 */
export function bracketsFrom(inputs: HorizonInputs): Bracket[] {
  const size = Math.max(1, Math.floor(inputs.bracketSize ?? DEFAULT_BRACKET_SIZE))
  const start = Math.max(1, Math.floor(inputs.level))
  // A character already past the stated cap is their own cap: one bracket, at their level.
  const cap = Math.max(start, Math.floor(inputs.levelCap ?? LEVEL_CAP))
  const out: Bracket[] = []
  for (let from = start; from <= cap; from += size) {
    const to = Math.min(from + size - 1, cap)
    out.push({ from, to, last: to === cap })
  }
  return out
}
