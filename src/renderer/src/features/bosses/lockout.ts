// THE WEEKLY LOOT LOCKOUT — pure arithmetic over the kill record the app already keeps. No new
// parsing, no new state, nothing persisted: a boss is "locked this week" because a kill of it
// that the log PAID YOU FOR sits inside the current lockout window, and the window is a function
// of the clock alone.
//
// WHAT A LOCKOUT IS (researched 2026-08-06; the app never says any of this out loud — it is here
// so a future reader can check the rule against its sources rather than against this code):
//   • Official patch notes (everquestlegends.com, "EQL Update Notes 7/28/2026"): killing a raid
//     boss while ON loot lockout still awards one guaranteed drop from its unique tables. So a
//     lockout is a LOOT STATE, not a kill block — "locked" here means "you have taken this
//     week's full roll", never "you cannot go".
//   • Community wiki (everquestlegends-wiki.wiki, the instances-and-lockouts guide): the weekly
//     lockout is PER BOSS PER DIFFICULTY — FIVE of them per target, d0 through d4 — and each is
//     SHARED between the solo and the multiplayer instance of that difficulty. Hence the per-tier
//     derivation below: the kill record is already broken down per instance tier
//     (shared/kills.ts), which is exactly the grain the lockout has, and the solo/group split
//     never reaches the kill record because `zoneTier()` reads the `- Solo/Group N` suffix as
//     "instanced" and drops it from the name (AGENTS.md, log-format reference).
//   • Same guide: the DAILY bonus-drop refresh is 8:00 AM Pacific.
//
// THE TWO CONSTANTS, AND HOW SURE WE ARE OF EACH. The 8:00 AM Pacific hour is DOUBLE-SOURCED
// (the daily-refresh line above plus a secondary community source stating the weekly reset at
// the same clock time). The TUESDAY is SINGLE-SOURCED — that one secondary source and nothing
// else. VERIFY IN GAME: watch one boss's lockout drop and note the day. A correction is a
// ONE-CONSTANT edit here and nothing else in the tree changes, which is why the day and the hour
// are named constants instead of being folded into the arithmetic.

import type { KillTierRun } from '@shared/types'
// RELATIVE value imports: this module is unit-tested under node/tsx, which has no `@shared` alias
// and no bundler (the mobSearch.ts precedent - AGENTS.md, Toolchain gotchas). `formatDate` is a
// dependency-free date formatter, so it travels here without dragging the renderer in.
import { DIFFICULTY_TIERS, isDifficultyTier } from '../../../../shared/kills'
import { formatDate } from '../../lib/formatDate'

/**
 * The reset is a PACIFIC WALL-CLOCK event, so the zone is the fact and the offset is derived.
 * Never a fixed -7h/-8h: the same wall clock is 15:00 UTC under PDT and 16:00 UTC under PST, so
 * a hardcoded offset is wrong for half the year and wrong by an hour for every user.
 */
export const LOCKOUT_TIMEZONE = 'America/Los_Angeles'

/**
 * SINGLE-SOURCED (see the header): weekly reset day, as `Date`'s weekday index (0 = Sunday).
 * 2 = Tuesday. VERIFY IN GAME.
 */
export const LOCKOUT_RESET_WEEKDAY = 2

/** DOUBLE-SOURCED (see the header): the reset hour, on the Pacific wall clock. */
export const LOCKOUT_RESET_HOUR = 8

/** The Pacific wall clock, whatever zone the user's machine is in. */
const PACIFIC = new Intl.DateTimeFormat('en-US', {
  timeZone: LOCKOUT_TIMEZONE,
  hour12: false,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit'
})

interface PacificClock {
  y: number
  m: number
  d: number
  h: number
  mi: number
  s: number
}

/** An instant read as Pacific wall-clock fields. */
function pacificClock(ms: number): PacificClock {
  const p: Partial<Record<Intl.DateTimeFormatPartTypes, string>> = {}
  for (const part of PACIFIC.formatToParts(ms)) p[part.type] = part.value
  return {
    y: Number(p.year),
    m: Number(p.month),
    d: Number(p.day),
    // Some ICU versions render midnight as hour 24 under hour12:false; fold it back to 0.
    h: Number(p.hour) % 24,
    mi: Number(p.minute),
    s: Number(p.second)
  }
}

/** Pacific's UTC offset (ms) AT AN INSTANT: -7h under PDT, -8h under PST. */
function pacificOffsetAt(ms: number): number {
  const p = pacificClock(ms)
  return Date.UTC(p.y, p.m - 1, p.d, p.h, p.mi, p.s) - Math.floor(ms / 1000) * 1000
}

/**
 * The epoch instant of a PACIFIC WALL CLOCK — the inverse of `pacificClock`, and the only place
 * this file converts in that direction.
 *
 * DST, EXPLICITLY. The offset is a function of the instant, and the instant is what we are
 * solving for, so it is solved by iteration: pass one reads the offset at the naive UTC instant
 * (wrong by at most one hour across a transition), pass two reads it at an instant already
 * within an hour of the answer, which is inside the same offset regime. Two passes are exact for
 * this input because 08:00 sits SIX HOURS clear of the 02:00 transition: the reset wall clock is
 * never a skipped hour (spring forward) nor a repeated one (fall back), so it names exactly one
 * instant and no tie-break policy is needed. What DST does change is the window's absolute
 * length — a week containing a transition is 167 or 169 hours, not 168 — which is correct and is
 * precisely what a fixed offset would get wrong.
 *
 * Out-of-range day numbers are intentional and load-bearing: `Date.UTC` normalizes them, so
 * "seven days before this Pacific date" is `d - 7` and month/year edges need no special case.
 */
function pacificWallClockToEpoch(y: number, m: number, d: number, hour: number): number {
  const naive = Date.UTC(y, m - 1, d, hour, 0, 0)
  return naive - pacificOffsetAt(naive - pacificOffsetAt(naive))
}

/** The lockout week containing `now`. */
export interface LockoutWindow {
  /** the most recent reset instant at or before `now` (ms) */
  start: number
  /** the instant this window was computed for (ms) */
  now: number
  /** the next reset instant after `now` (ms) — `start` plus one Pacific week */
  next: number
}

/**
 * The lockout week `now` falls in. Timezone-independent by construction: every field is read
 * through the Pacific formatter or through UTC arithmetic, and nothing here consults the local
 * zone — a player in Tokyo and a player in Denver get the same two instants.
 */
export function lockoutWindow(now: number): LockoutWindow {
  const p = pacificClock(now)
  // The weekday OF THE PACIFIC DATE. Building it as a UTC midnight is not a timezone claim, just
  // the cheapest way to ask "what day of the week is 2026-08-05".
  const weekday = new Date(Date.UTC(p.y, p.m - 1, p.d)).getUTCDay()
  let back = (weekday - LOCKOUT_RESET_WEEKDAY + 7) % 7
  // Reset day, but the hour has not come round yet: this week began a full seven days ago.
  if (back === 0 && p.h < LOCKOUT_RESET_HOUR) back = 7
  return {
    start: pacificWallClockToEpoch(p.y, p.m, p.d - back, LOCKOUT_RESET_HOUR),
    now,
    next: pacificWallClockToEpoch(p.y, p.m, p.d - back + 7, LOCKOUT_RESET_HOUR)
  }
}

/** One difficulty this target is locked at, and the credited kill that locked it. */
export interface TierLock {
  /** instance difficulty tier (0 = base … 4 = Refined) */
  tier: number
  /** when the credited kill landed (ms) */
  ts: number
}

/**
 * The difficulties a target is locked at this week, lowest tier first.
 *
 * CREDITED, NOT MERELY OBSERVED. `lastCreditedTs` is the input, never `lastTs`: a boss a stranger
 * killed across an open-world zone is recorded by the tracker and pays you nothing, so it cannot
 * put you on lockout (the same seam the celebration predicate draws — bossStatus.bossKills).
 *
 * A DIFFICULTY, NOT MERELY A KILL (JOS-166). The kill record's tier keys include two that are not
 * difficulties — the open world and the unstated zone (shared/kills.ts) — and a lockout is a fact
 * about an INSTANCE at a difficulty. An open-world kill of a raid boss is a real kill you were
 * really paid for and it takes nothing off your week: there is no instance to be locked out of.
 * An unstated one claims nothing either way. Both are skipped here, which is the one place that
 * decision is made, so no rung anywhere can be greened by a kill that took no lockout.
 *
 * The test is the half-open Pacific week `[start, next)`. That is the same set as the brief's
 * `[start, now]` for every kill that has actually happened — a kill cannot be in the future —
 * and it does not go momentarily wrong when the caller's `now` is a state value a minute stale.
 */
export function tierLocks(tiers: Record<number, KillTierRun>, w: LockoutWindow): TierLock[] {
  const out: TierLock[] = []
  for (const [key, run] of Object.entries(tiers)) {
    const tier = Number(key)
    if (!isDifficultyTier(tier)) continue
    const ts = run.lastCreditedTs
    // 0 = no kill of this run was ever yours.
    if (!ts || ts < w.start || ts >= w.next) continue
    out.push({ tier, ts })
  }
  out.sort((a, b) => a.tier - b.tier)
  return out
}

// ─────────────────────────────────────────────────────────────────────────────
// THE DIFFICULTY LADDER (JOS-152)
// ─────────────────────────────────────────────────────────────────────────────
//
// THE ASK, from a raid-coordinating reporter (01KZM0WD1DWQAXBB6EA0BZHE4A, corroborated by tail
// B4V1Z0): a rung per difficulty on each boss, grey by default and green for the ones this reset
// week has already taken, so a guild can read what is LEFT off the card. `tierLocks` above
// already answers "which difficulties am I locked at"; the ladder is that same answer with the
// OPEN rungs drawn as well, which is the entire value of it — an absent chip states nothing, and
// what a coordinator needs is the difficulties still available, not the ones spent.
//
// WHERE A DIFFICULTY COMES FROM, MEASURED IN THE OWNER'S LOG (2026-08-09). Exactly ONE line
// family states it, and it is not a kill line:
//
//   You have entered Najena 4 (Refined).
//   You have entered Nagafen's Lair - Solo 3 (Fused).
//   You have entered The Ruins of Old Guk 2 (Adaptive).
//   You have entered The Plane of Hate - Solo.                ← the BASE instance, d0
//
// The kill lines themselves carry nothing: `You have slain <mob>!` (4,809 of them in that log)
// and `<Mob> has been slain by <Name>!` name a mob and a killer and no difficulty whatsoever, so
// the tier on a kill is the tier of the ZONE YOU WERE STANDING IN when it died — stamped at fold
// time by the kills module and never re-derivable afterwards. The instance-creation notice
// (`Player Primitive creating instance The Plane of Hate 2113.`) carries an instance ID, not a
// difficulty. And there is no lockout line of ANY kind: every occurrence of the word in that
// 1.4M-line log sits inside quoted player chat, which the fixture scrub drops and no parser reads.
//
// ALL FIVE RUNGS ARE STATED, INCLUDING THE BASE ONE (JOS-166; this reverses what this comment
// used to argue). d1..d4 are each named by an adjective. d0 is the absence of an adjective — but
// NOT the absence of a statement, because the line still says whether you are in an instance:
//
//   You have entered Nagafen's Lair - Solo.   ← the base-difficulty instance: a d0 clear
//   You have entered Nagafen's Lair.          ← the open world, which has no lockout at all
//
// Both used to decode to tier 0, which is why the base rung was drawn as an unfilled outline: the
// model could not tell a real d0 clear from an open-world kill or from a kill folded before any
// zone line. `zoneTier` now separates all three (parseWorld.ts) and the kill record keys them
// apart (shared/kills.ts: TIER_OPEN_WORLD, TIER_UNKNOWN), so `tierLocks` above simply never sees
// the two that are not difficulties. The base rung fills exactly like the other four, and an
// open-world kill greens nothing anywhere.
//
// WHAT THE LADDER STILL DOES NOT KNOW: which difficulties a given boss OFFERS. The game's set is
// five and the ladder draws five for every target, because no line in the log enumerates the
// instances a boss has. A grey rung means "this app has no credited kill of yours here this
// week", never "this difficulty exists and you may go".

export { DIFFICULTY_TIERS }

/** One difficulty of one boss, in the current lockout week. */
export interface LadderRung {
  /** instance difficulty tier (0 = base … 4 = Refined) */
  tier: number
  /** a credited kill at this difficulty landed inside the current week */
  cleared: boolean
  /** when that kill landed (ms), or 0 when this rung is open */
  ts: number
}

/**
 * The five rungs, lowest difficulty first, for one card's kills in one week.
 *
 * Takes the LOCKS rather than the raw tier runs so there is exactly one place that decides what
 * "cleared this week" means (`tierLocks` — credited, a difficulty, half-open Pacific week) and
 * the ladder is pure presentation arithmetic over its answer. A lock at a tier outside the known
 * five cannot reach here (`tierLocks` drops it), and the `byTier` lookup ignores one anyway
 * rather than inventing a sixth rung.
 */
export function tierLadder(locks: TierLock[]): LadderRung[] {
  const byTier = new Map(locks.map((l) => [l.tier, l.ts]))
  return DIFFICULTY_TIERS.map((tier) => {
    const ts = byTier.get(tier)
    return { tier, cleared: ts !== undefined, ts: ts ?? 0 }
  })
}

/** Inside a seven-day window the weekday is the referent; the year is noise. */
const RUNG_DAY: Intl.DateTimeFormatOptions = { weekday: 'short', month: 'numeric', day: 'numeric' }

/**
 * What one rung says when you rest on it: THE DAY THAT DIFFICULTY'S LAST CREDITED KILL LANDED,
 * and nothing else at all (JOS-171, owner ruling 2026-08-09 — the same ruling that took the
 * tooltip off the tier chip in JOS-169). The rung is the only thing left under a week card now:
 * the `Locked · <date>` / `open` caption line that used to sit beneath the ladder is gone, so the
 * five chips carry the whole per-difficulty story and the hover is where the date lives.
 *
 * It says the DATE ALONE because everything else it could say is already on the screen and one
 * pixel away. The rung's own label IS the difficulty ("D3"), and its colour IS whether the week
 * has taken it — so a sentence naming either would be the card reading itself back to you.
 *
 * AN OPEN RUNG SAYS NOTHING — `undefined`, never `''`. A grey rung is already a complete
 * statement, and this app has no fact to add to it: "open this week" would only restate the
 * colour, and (see the ladder's closing note below) it cannot even promise the difficulty EXISTS
 * for this boss. `undefined` makes the component omit the `title` attribute outright; an empty
 * string is an attribute that is PRESENT and empty, which suppresses tooltips inherited from
 * ancestors — and the card above has one.
 *
 * It lives HERE, beside the derivation it describes, rather than in the component that draws it:
 * putting it in a `.tsx` that imports MUI would leave the one string worth pinning unreachable
 * from a node test.
 */
export function rungTitle(rung: LadderRung): string | undefined {
  return rung.cleared ? formatDate(rung.ts, RUNG_DAY) : undefined
}

/** Coarse time remaining in the window: "3d 4h" / "4h 12m" / "12m". */
export function untilReset(w: LockoutWindow): string {
  const mins = Math.floor(Math.max(0, w.next - w.now) / 60_000)
  const days = Math.floor(mins / 1440)
  const hours = Math.floor((mins % 1440) / 60)
  if (days > 0) return `${days}d ${hours}h`
  if (hours > 0) return `${hours}h ${mins % 60}m`
  return `${mins}m`
}
