// Shared vocabulary of the buffs model (see buffs.ts for the model itself): the tuning
// constants every part of it is calibrated against, the instance/cast record shapes, and
// the pure helpers (key canonicalization, percentile, landing-message shape test). Nothing
// here holds state, so it is safe to import from any of the buffs modules.

import { spellCanonKey } from '../log/parser'
import { RECONNECT_WINDOW_MS } from '../log/sessionDetector'
import type { EntityDisposition } from '../combat/entityRules'
import type { HoldGroup } from './buffRounds'

/** Land a pending cast this many ms after castBegin if nothing cleared it first. */
export const LAND_TIMEOUT_MS = 15_000

/**
 * Sanity ceiling on a mined duration sample. No EQ Legends buff lasts anywhere near this
 * long. A land→fade gap beyond this is DEFINITIONALLY a missed censor and is DROPPED.
 */
export const MAX_SAMPLE_MS = 3 * 60 * 60_000 // 3 hours

/**
 * LOG-HOLE boundary (Task #33, finding #5; re-read by JOS-134). An event-time gap ≥ this means
 * the character stopped producing log lines for half an hour, which is a claim about the LOG and
 * not yet a claim about the world.
 *
 * It used to be read as "logout/AFK past any buff duration" and wiped every live instance on the
 * spot. That is what made the ticket's defect: a hole is followed, 0-22 s later, by the reconnect
 * preamble and then `Welcome to EverQuest Legends!`, so the wipe always ran BEFORE the derived
 * `offlineGap` that explains it — and the buff EQ had frozen with your character was gone by the
 * time anything could pause it. So the hole now only OPENS a question (`BuffsModule` holds the
 * pre-hole buffs, unswept, and stops there); {@link LOGIN_CONFIRM_MS} is how long it waits for the
 * answer.
 */
export const SESSION_GAP_MS = 30 * 60_000 // 30 minutes

/**
 * How long a log hole waits to be explained by a login before it is ruled UNEXPLAINED and the
 * pre-hole buffs are dropped after all (JOS-134).
 *
 * It is deliberately the detector's OWN {@link RECONNECT_WINDOW_MS} rather than a second number:
 * that window is the measured span of the reconnect preamble (longest observed 22 s over all 19
 * logins in the real log — see sessionDetector.ts), and the two constants are answering the same
 * question from opposite ends. The detector looks BACK from the Welcome to find the last instant
 * the character was in the world; this looks FORWARD from the hole for the Welcome. Sharing the
 * constant is what makes it impossible for them to disagree about how long a preamble can be.
 */
export const LOGIN_CONFIRM_MS = RECONNECT_WINDOW_MS

/**
 * THE UNWITNESSED-EXPIRY TIMEOUT — ONE RULE FOR EVERY ROW THAT IS NOT YOURS.
 * (JOS-140 → JOS-149 → JOS-156, owner ruling 2026-08-09 from live testing.)
 *
 * THE CASE, in the three forms the owner has now hit it in: you slow a boss and then die; a pet
 * despawns wearing a buff you cast on it; you cast Tashania on a mob and are killed eleven
 * seconds later. In every one the wear-off line is printed to somebody who is not there to
 * receive it — the same shape as zoning out, or the mob wandering off — so it never arrives and
 * the bar sits at 0s. Before any of this the only thing that would ever remove it was the
 * 90-minute hygiene cap.
 *
 * THE TIMEOUT COMES FROM THE ESTIMATE'S QUALITY, and from nothing else:
 *
 *   'observed' ⇒ 15 s. The number came from this caster's own clean cycles, so the only thing
 *                left to be late is the LINE.
 *   'db'       ⇒ 60 s. A minute past a stated end is long enough for a line that is merely late
 *                and short enough that a stale row is never a fixture of the window.
 *
 * IT USED TO BE TWO RULES, AND THE SECOND ONE DIED HERE (JOS-156). Debuff and CC rows had their
 * own DB branch that waited THE DURATION AGAIN (floored at 60 s), on the argument that the DB row
 * is the base rank's and the real duration routinely runs past it, so a learner that has never
 * seen a clean cycle needed to keep its one chance at a late correction. JOS-149 already refused
 * that reasoning for non-self BUFFS — an hour of 0s on a pet buff was the reported defect — and
 * left the debuff branch standing. The owner's 2026-08-09 session settled the rest of it: he cast
 * Tashania at 15:41:44 and died at 15:41:55, and Tashania's DB row is ELEVEN MINUTES, so a
 * duration-again grace parks that bar at 0s until 15:53. The row he is looking at is the defect;
 * the correction it was being preserved for is one the log has already ruled out delivering.
 *
 * THE ACCEPTED COST, on the record and unchanged from JOS-149's: a spell whose real duration runs
 * more than a minute past the DB's stated one is culled before its wear-off arrives, and that
 * cycle teaches the learner nothing. An unwitnessably-late wear-off teaches nothing ANYWAY — the
 * cases this fires on are the ones where the line is not coming at all — so what is given up is
 * the subset where the line WAS coming, merely very late, and the owner has ruled the squatting
 * row the worse of the two defects.
 *
 * A row with no number at all is counting UP, has nothing to be overdue against, and is governed
 * by the unknown-duration cap instead. SELF buffs are exempt altogether (see `unwitnessedCullCap`):
 * their wear-offs print to you, and their clocks are the ones the offline pause rewinds.
 *
 * It is deliberately NOT instant-at-zero (the owner's word was "eventually"): a visibly overdue
 * row for a beat is information — it says the app is waiting for a line, rather than pretending
 * it arrived. And a cull is NOT EVIDENCE: it mints no duration sample and counts as no break,
 * because nothing was observed. That is the whole difference between it and a wear-off.
 */
export function unwitnessedTimeoutMs(source: 'db' | 'observed' | undefined): number {
  return source === 'observed' ? 15_000 : 60_000
}

/** Active-buff HYGIENE cap (Task #33, finding #6). An active past this auto-retires. */
const HYGIENE_ABSOLUTE_MS = 90 * 60_000 // 90 minutes when no/low stats
export function hygieneCapMs(p75: number | null, n: number): number {
  const stat = p75 != null && n >= 2 ? 2 * p75 : 0
  return Math.max(stat, HYGIENE_ABSOLUTE_MS)
}

/** Window after a castBegin within which a landing emote is attributed to that cast. */
export const EMOTE_WINDOW_MS = 5_000
/** How many times an emote TEXT must appear adjacent to a cast before it's TRUSTED. */
export const EMOTE_MIN_OBSERVATIONS = 2

/**
 * Recency-weighted MAX window (Task #34): estimate = MAX over the most recent K samples.
 *
 * SINCE JOS-180 IT IS APPLIED TWICE — once over the samples the log gave a cause for and once over
 * the samples it did not — so a run of break-shortened cycles can never push a full-length one out
 * of view. The rule and the reasoning live on {@link SpellStats.observedWindowMaxFor}; the number
 * itself is unchanged and is still the only knob.
 */
export const RECENT_SAMPLE_WINDOW = 5

/** The activated-AA name whose burst of self-buff landing messages is trusted confident. */
export const QUICK_BUFF = 'quick buff'
/** How long after a Quick Buff activation its burst applies are attributed to it. */
export const QUICK_BUFF_WINDOW_MS = 5_000

/**
 * OWN-CAST landing window (Task #45). A message-driven apply (buffApply) is attributed to the
 * player only when their OWN castBegin of that spell landed within this window before the
 * emote — mirrors the emote-mining window. Cast times run up to ~8s (Swift is 8s) plus the
 * short travel to the landing line, so a slightly generous window avoids dropping real
 * self/pet casts while still rejecting a stranger's buff (no own castBegin at all).
 */
export const OWN_CAST_WINDOW_MS = 10_000

/** The AA that makes self-cast illusion buffs PERMANENT (Task #34). */
export const PERMANENT_ILLUSION = 'permanent illusion'

/** The sentinel entity key for a buff on the PLAYER. */
export const SELF_KEY = 'self'
/** Instance-key separator  a NUL, which can never appear in a spell/entity name. */
const SEP = String.fromCharCode(0)

/** The instance key for a (spell, entity) pair — the buff-instance identity (Task #35). */
export function instanceKey(spellKeyOf: string, entityKey: string): string {
  return spellKeyOf + SEP + entityKey
}

/** Extract the entity key from an instance key. */
export function instanceEntityKey(iKey: string): string {
  const i = iKey.indexOf(SEP)
  return i >= 0 ? iKey.slice(i + 1) : SELF_KEY
}

/**
 * Extract the SPELL LINE key from an instance key — the identity, as opposed to the display name.
 *
 * These two are no longer the same string (JOS-140). A landing a Quick Buff burst admits but
 * cannot narrow is a FAMILY, and its row NAME is the joined candidate list
 * (`Group Resist Magic / Resist Magic`), which `spellCanonKey` would fold into gibberish. The
 * instance is keyed on one candidate's real line — the family agrees on nature and duration, which
 * is the only reason it was admitted at all — so anything asking "which spell is this row" must
 * ask the KEY and never re-derive it from what the row says.
 */
export function instanceSpellKey(iKey: string): string {
  const i = iKey.indexOf(SEP)
  return i >= 0 ? iKey.slice(0, i) : iKey
}

/**
 * A landed instance awaiting its next fade — the record behind one row.
 *
 * IT IS A MULTISET NOW (JOS-140 ruling 7). `group` is the {@link HoldGroup} of landings for this
 * (spell line, entity NAME): one per mob of that name we believe is holding this spell, oldest
 * first. Two mobs called `a wan ghoul knight` slowed in one round are two landings in one group
 * and ONE row with a count chip, not one row whose clock the second landing silently overwrote.
 * The clean-cycle bookkeeping that decides whether a span may be learned from lives there too.
 */
export interface OpenCast {
  spell: string
  /** rank-stripped spell key — the LINE, and half of the learner's key. */
  spellKey: string
  /** the entity this instance is on ('self' or a canonical name key). */
  entityKey: string
  /** The landings, oldest first (JOS-140). `group.oldestTs` is the row's clock. */
  group: HoldGroup
  /** WHOSE cast this is: 'self' or an allowlisted external (shared/buffTrust.ts). */
  caster: string
  /** The entity disposition this cast is bound to (for censoring on zone/death). */
  disp: EntityDisposition
  /**
   * True once an `offlineGap` has passed over this open cast — set for a BUFF and a DEBUFF
   * alike, which is the whole of JOS-134's learner rule. The instance itself survives; what is
   * refused is the SAMPLE, because neither half of the pair is a clean observation of a
   * duration once an absence sits inside it:
   *
   *   • A BUFF's clock was PAUSED (EQ freezes buffs with your character and resumes them at
   *     login — measured, see BuffInstances.onOfflinePause). Its land→fade span therefore
   *     contains frozen time that is not duration at all.
   *   • A DEBUFF's clock was NOT paused (the world kept running), so arithmetically its span
   *     IS world time. It is still refused, for a different reason stated separately because
   *     it is a different reason: the wear-off LINE only exists while you are logged in, so a
   *     fade that prints after an absence dates the moment you were there to SEE it, not the
   *     moment the spell ended. It is an upper bound on the expiry, not the expiry.
   *
   * Both errors point the same way — too LONG — and world-model law 5's estimator is a
   * recency-weighted MAX, chosen precisely because it is sensitive to over-long samples. And
   * neither is correctable: `offlineGap.fromTs` is documented as a LOWER bound on the absence
   * (up to 30 s of real in-world time is discarded with the reconnect preamble), so subtracting
   * the gap exactly is not something we are in a position to do — the subtraction would leave a
   * residue of up to 30 s in the same upward direction. CENSOR, never correct.
   */
  spannedGap?: boolean
}

/**
 * A cast in flight (You begin casting …) not yet confirmed landed or cleared.
 *
 * It DISPLAYS NOTHING (JOS-118 — see BuffInstances.beginCast). It is the cast-in-flight
 * bookkeeping the landing side consumes, and it is dropped by a fizzle, an interrupt, a fade of
 * the same spell, or the landing window elapsing with no confirmation.
 */
export interface Pending {
  spell: string
  key: string
  beganTs: number
  /** The landing emote's subject key ('self' or a name key), once its text is recognized. */
  emoteSubjectKey?: string
}

/**
 * ONE MINED DURATION — a land→end span, the instant the line that ended it arrived, and whether
 * the log NAMED something that ended it early (JOS-180).
 *
 * It used to be a bare number. The `ts` is what lets a line arriving AFTER the mint reach back and
 * annotate the sample it belongs to — which is the only order the game ever prints the pair in
 * (`CcWakeEvent` carries the measurement). `censored` is what {@link SpellStats.observedWindowMaxFor}
 * reads; the rule and its reasoning are written there.
 */
export interface DurationSample {
  /** The measured span in ms. */
  ms: number
  /** Event ts (ms) of the line that closed the cycle — the join key for a later annotation. */
  ts: number
  /**
   * True when the log stated a CAUSE for the ending, so the span is a LOWER BOUND on the duration
   * rather than the duration. One-way, like `Hold.clean`: evidence of doubt does not expire.
   */
  censored?: boolean
}

/** Per-(line, caster) accumulated duration samples + display name. */
export interface SpellSamples {
  spell: string
  samples: DurationSample[]
}

/**
 * ONE CAST LINE, remembered — the ANCHOR that admits a landing sentence (JOS-140 ruling 2).
 *
 * Shared by both halves of the model so they cannot disagree about what an anchor is. Three log
 * shapes produce one:
 *   `You begin casting <S>.` / `You begin singing <S>.`  — self, and it NAMES the spell.
 *   `<Name> begins casting <S>.`                          — an allowlisted external, same shape.
 *   `You activate Quick Buff.`                            — self, and it names NO spell at all.
 *
 * `display` is the RANKED name exactly as the log spelled it (`Mesmerization VII`) — the only line
 * in the whole family that carries a rank, which is why the row can print one at all. The map is
 * keyed by the rank-STRIPPED line, so a rank upgrade replaces its predecessor rather than
 * accumulating beside it, and `rankChanged` records that two different ranks of one line were cast
 * inside the same window — a landing under that condition cannot say which rank it is and is
 * refused as a sample (ruling 5).
 */
export interface CastAnchor {
  display: string
  ts: number
  caster: string
  /** True when a DIFFERENT rank of this line was anchored within the landing window before it. */
  rankChanged: boolean
}

/** Canonical spell key (case-stable, RANK-STRIPPED). */
export function spellKey(s: string): string {
  return spellCanonKey(s)
}

/**
 * True when an un-catalogued line is SHAPED like a spell-landing flavor message (Task #36):
 * a short-ish sentence ending in a period, not a numeric/combat/system line. Used to feed
 * candidate landing messages the DB missed (e.g. Symbol of Pinzarn's real landing line,
 * whose wiki msg_cast_on_you is wrong) into the overlay miner. Deliberately permissive — the
 * miner's unambiguous-anchor + repeat-count rules reject coincidental pairings, so a
 * false candidate never earns a VERIFIED verdict.
 */
// Casting-system / UI feedback lines that are SELF-directed ("you"/"your") in shape but are
// never a spell-landing emote (they recur across every spell → pure noise). Rejected so a
// coincidental burst pairing can't verify them.
const CASTING_SYSTEM_RE =
  /can't use that command|regain your concentration|change your invocation|begin reciting|cannot see your target|Auto attack|mend your wounds|shimmers briefly|feels alive with power|begins casting|begin singing|You must|Insufficient|You do not|not ready yet|too far|out of range|You have entered|received any tells|cannot reply|mostly successful|has been overwritten|You forget |memoriz|You can(not| ?'?t)|Your target|Your spell|Your .* spell|You have finished|Beginning to|You are (?:no longer|now)|not enough|you cannot reply/i

/** The chat/combat/system markers that disqualify an otherwise landing-SHAPED line. */
function hasNonLandingMarker(text: string): boolean {
  if (text.includes("' told you") || text.includes(' tells ') || text.includes(' says')) return true
  if (text.includes(' by ') || text.includes(' from ')) return true
  if (text.includes(' spell ') || text.includes('attention')) return true // combat cast spam
  return CASTING_SYSTEM_RE.test(text)
}

/**
 * True when an un-catalogued line is plausibly a SELF spell-landing flavor message the DB
 * missed (Task #36) — the ONLY unknown-line class worth mining. It must be about the CASTER
 * (contain "you"/"your" or start with "You"/"Your"), a short sentence ending in a period,
 * with no numbers (damage/heal), no chat/tell/"by"/"from" markers, and not a casting-system
 * / UI line. This deliberately EXCLUDES third-person mob-subject lines ("a revenant
 * staggers.", "…spell is interrupted.") — those are combat spam that would poison the
 * overlay with coincidental burst pairings. Symbol of Pinzarn's real "The symbol of Pinzarn
 * flashes before your eyes." passes (it names "your eyes"); a mob effect line does not.
 */
export function looksLandingMessage(text: string): boolean {
  if (text.length < 6 || text.length > 90) return false
  if (!text.endsWith('.')) return false
  if (/\d/.test(text)) return false // damage/heal/point lines carry numbers
  // Must reference the caster — a genuine cast-on-YOU line is about the player.
  if (!/\byou\b|\byour\b/i.test(text)) return false
  return !hasNonLandingMarker(text)
}

export function percentile(sortedAsc: number[], p: number): number {
  if (sortedAsc.length === 0) return 0
  if (sortedAsc.length === 1) return sortedAsc[0]
  const idx = (sortedAsc.length - 1) * p
  const lo = Math.floor(idx)
  const hi = Math.ceil(idx)
  if (lo === hi) return sortedAsc[lo]
  const frac = idx - lo
  return sortedAsc[lo] * (1 - frac) + sortedAsc[hi] * frac
}
