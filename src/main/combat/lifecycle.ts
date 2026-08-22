// ENCOUNTER + ZONE-SESSION LIFECYCLE — opening, closing, freezing, and the summary
// projections those produce. Extracted verbatim from engine.ts.
//
// This is the segmentation half of AGENTS.md world-model law 7/8: what opens a fight, what
// closes one (and on what evidence), what a finalized fight/zone session freezes into. The
// routing modules decide WHERE a line lands; this decides WHEN a segment begins and ends.

import { sumHeal, sumMap } from './aggregate'
import { Agg } from './aggregate'
import { SEC_LIFECYCLE } from './foldProbe'
import {
  ACTIVE_MS,
  FALLBACK_IDLE_MS,
  LINGER_MS,
  PRESENCE_GONE_MS,
  SLOW_SAMPLE_CAP,
  TIMELINE_HISTORY_CAP,
  ZONE_HISTORY_CAP,
  encounterName,
  type Encounter,
  type StanceRaw,
  type ZoneSession,
  type ZoneSessionClose
} from './encounter'
import type { EngineState } from './state'
import { isSlowCapable } from '../../shared/poisons'
import type { SegmentSummary, ZoneSessionSummary } from '../../shared/combat'

export function ensureEncounter(st: EngineState, ts: number): Encounter {
  // Closure is decided by evalClosure() (death-linger / CC-hold / fallback), which
  // ingestEvent runs before routing. Here we only lazily open a new encounter.
  const cur = st.current
  if (cur) return cur
  const p = st.probe
  if (!p) return openEncounter(st, ts)
  p.enter(SEC_LIFECYCLE)
  const enc = openEncounter(st, ts)
  p.leave()
  return enc
}

/** Open a fresh encounter — the cold half of `ensureEncounter`, split out so the bench's
 *  lifecycle bracket can be one straight-line call (foldProbe.ts). */
function openEncounter(st: EngineState, ts: number): Encounter {
  const spans: StanceRaw[] = []
  // Seed the timeline's pinned rows with whatever stance/invocation is already active
  // at the moment the fight opens (so a fight inherits the standing modifiers).
  if (st.stance) spans.push({ group: 'stance', name: st.stance.name, start: ts })
  if (st.invocation) spans.push({ group: 'invocation', name: st.invocation.name, start: ts })
  const enc: Encounter = {
    id: `e${++st.seq}`, zone: st.zone, startTs: ts, lastTs: ts,
    agg: new Agg(), engaged: new Set(), engagedSeen: new Map(), activeMs: 0,
    ccActiveUntil: new Map(), events: [], eventsTotal: 0, stanceSpans: spans,
    markers: [],
    // Task #64: freeze the coats as they stand AT ENGAGE. "Could this pull have been
    // slowed?" is a question about this instant — reading today's coat when the fight is
    // later rendered would silently re-label every past fight after a poison swap.
    coatAtEngage: st.coatUtility ? { ...st.coatUtility } : undefined,
    combatAtEngage: st.coatCombat.map((c) => ({ ...c }))
  }
  st.current = enc
  return enc
}

/**
 * Is every engaged HOSTILE instance gone? Two different standards, because the
 * evidence is different (Task #55 — this split is the multi-mob-pull fix):
 *   RETIRED (dead/zoned) → gone immediately. The death line IS the evidence; the
 *     sinceDamage >= LINGER_MS check in evalClosure still covers its trailing damage.
 *   LIVE → gone only after PRESENCE_GONE_MS with no presence evidence at all (see
 *     engagedSeen: damage, misses, resists, CC, heals). The old rule reused
 *     LINGER_MS here and counted only DAMAGE as evidence, so a second mob that was
 *     merely missing (or casting, or being out-damaged by its friend) looked dead
 *     after 5s — and the moment its friend actually died, the whole pull finalized
 *     and the survivor's remaining fight became a bogus second encounter.
 * A live charmed pet is never a mob we're killing, so it's excluded — otherwise the
 * pet (which never dies) would pin every charm-grind encounter open forever. CC'd
 * instances had their unexpired hold checked by the caller.
 */
function hostilePresence(st: EngineState, enc: Encounter, now: number): { hostiles: number; allGone: boolean } {
  let hostiles = 0
  let allGone = true
  for (const id of enc.engaged) {
    if (st.world.isLivePet(id)) continue
    hostiles++
    const seen = enc.engagedSeen.get(id) ?? enc.lastTs
    const gone = st.world.isRetired(id) || now - seen >= PRESENCE_GONE_MS
    if (!gone) {
      allGone = false
      break
    }
  }
  return { hostiles, allGone }
}

/**
 * Evaluate deferred closure of the current encounter as of `now`. Encounters can
 * now close purely from time passing (no more events), so this is called at the
 * top of each damage/CC ingest AND from snapshot(now) — whichever comes first.
 * Finalization always stamps the encounter's lastTs (a damage timestamp), never
 * `now`, so startTs/lastTs/duration reflect the real fight, not the eval moment.
 *
 * Rules:
 *  - CC-hold: if any engaged HOSTILE instance is still CC-held (ccActiveUntil > now), veto the
 *    DEATH-CLOSE (a mez'd mob is alive, and the mez-and-wait gap is not the end of a pull).
 *  - Death-close: once every engaged hostile instance is GONE — retired (dead/zoned),
 *    or alive but unseen for PRESENCE_GONE_MS — and LINGER_MS has passed since the last
 *    attributed DAMAGE, finalize.
 *  - Fallback: if no attributed damage AND no CC for FALLBACK_IDLE_MS (fled/deagro,
 *    no death logged), finalize — and this path is NOT vetoed by a hold (see below).
 *
 * THE HOLD IS A VETO ON ONE PATH, NOT ON CLOSURE (Task #65). CC_HOLD_MS (120s) deliberately
 * exceeds FALLBACK_IDLE_MS (60s), and the hold used to short-circuit this whole function — so
 * ONE stale hold defeated EVERY closure path and pinned the fight open for two full minutes of
 * silence. The semantics shipped instead: a hold vetoes only the death-close, because that is
 * the judgement it actually informs ("is this engaged instance still alive?"). The fallback is
 * a different question — "has anything at all happened?" — and a CC application or refresh
 * stamps `lastActivityTs`, so an ACTIVELY refreshed mez still holds the fight open exactly as
 * before (its own refreshes keep `sinceActivity` small). What can no longer happen is a single
 * unrefreshed hold outliving a minute of total silence.
 *
 * AND THE HOLD ONLY EVER SPEAKS FOR AN ENGAGED HOSTILE (JOS-176). It answers exactly one
 * question — "is this engaged instance still alive and still in the fight?" — so the two
 * entities that can never be an answer to it are excluded, both for reasons this file already
 * states about `hostilePresence`:
 *   RETIRED — the hold is unredeemable the instant the world model retires the instance, because
 *     a later sighting of that name mints a fresh `nameKey#gen` and can never re-enter this
 *     stamp. Handled at the RETIREMENT SITE (`WorldModel.onRetire`, wired in EngineState) rather
 *     than by a check here, so the stamp is simply gone and every retirement path agrees. It used
 *     to be a delete inside ingestDeath, which meant a mob aged out by STALENESS went on vetoing
 *     for the rest of its 120 seconds (measured: 614 such retirements in the owner's whole log).
 *   A LIVE PET — never something we are killing, so a hold on one must not pin a fight open any
 *     more than its presence may. This is the case the owner actually hit: in the Plane of Hate
 *     his charmed pet and the mobs he is killing share ONE name, so when the last hostile twin
 *     died, `Your Dazzle spell has worn off of <name>` (a CC refresh, JOS-161) resolved to the
 *     only instance of that name still live — the pet — and stamped a 120s hold on it. The
 *     skirmish could not close, and the Grandmaster R`tal pull 78 seconds later joined it
 *     (tests/combatCcHoldWindows.test.mts replays that window).
 */
export function evalClosure(st: EngineState, now: number): void {
  if (!st.current) return
  const p = st.probe
  if (!p) {
    evalClosureInner(st, now)
    return
  }
  p.enter(SEC_LIFECYCLE)
  evalClosureInner(st, now)
  p.leave()
}

function evalClosureInner(st: EngineState, now: number): void {
  const enc = st.current
  if (!enc) return

  const sinceDamage = now - enc.lastTs
  const sinceActivity = now - st.lastActivityTs

  // Fallback: no damage and no CC for the idle window (mob fled / deaggroed). Evaluated
  // FIRST, so it is reachable regardless of any outstanding hold.
  if (sinceActivity >= FALLBACK_IDLE_MS) {
    finalizeCurrent(st)
    return
  }

  // CC-hold: any engaged instance still under an unexpired CC hold vetoes the death-close —
  // EXCEPT one of your own live pets, for the reason hostilePresence() states three lines up
  // about the very same judgement (JOS-176).
  for (const [id, until] of enc.ccActiveUntil) {
    if (until > now && !st.world.isLivePet(id)) return
  }

  const { hostiles, allGone } = hostilePresence(st, enc, now)

  // Death-close: every engaged hostile is dead/gone and the linger has elapsed.
  if (allGone && hostiles > 0 && sinceDamage >= LINGER_MS) {
    finalizeCurrent(st)
  }
}

export function finalizeCurrent(st: EngineState): void {
  if (!st.current) return
  const enc = st.current
  st.current = null
  // Close any open stance/invocation spans at the fight's end (Task #51).
  for (const s of enc.stanceSpans) s.end ??= enc.lastTs
  // Drop empty encounters: a CC application (or a lone miss) can open an encounter
  // that never accrues any attributed damage — e.g. a mez lands and the mob is
  // then killed by someone else. Don't pollute history/zone with a 0-damage shell.
  if (enc.agg.out.size === 0 && enc.agg.inc.size === 0) return
  // ROLLING TIME-TO-SLOW (Task #64). A pull only qualifies when a SLOW-CAPABLE utility coat
  // was already on at engage — otherwise "how long to slow" is a question nobody asked, and
  // including it would deflate the denominator with pulls that could never land one. A
  // qualifying pull that never slowed is pushed as `null`: counted as a miss, never averaged
  // in as a zero (law 5).
  if (enc.coatAtEngage && isSlowCapable(enc.coatAtEngage.poison)) {
    const first = enc.agg.procs.firstSlowTs
    st.slowSamples.push(first > 0 ? Math.max(0, first - enc.startTs) : null)
    if (st.slowSamples.length > SLOW_SAMPLE_CAP) st.slowSamples.shift()
  }
  st.zoneFinalizedMs += Math.max(0, enc.lastTs - enc.startTs)
  st.zoneActiveMs += enc.activeMs
  // Compute the immutable summary once, now that the encounter is frozen. A
  // finalized fight's summary never uses `now` (its `active` is always false),
  // so 0 is a safe sentinel. Reused on every snapshot() thereafter.
  enc.summary = encSummary(enc, 'fight', 0)
  st.history.push(enc)
  // Timeline memory bound (Task #51): keep the event ring only for the most recent
  // TIMELINE_HISTORY_CAP finalized encounters; drop older rings so the whole-session
  // RSS delta stays flat on a full-log replay (thousands of fights). The aggregate
  // summary/agg is untouched — only the raw per-event ring is released.
  const dropIdx = st.history.length - 1 - TIMELINE_HISTORY_CAP
  if (dropIdx >= 0) {
    const old = st.history[dropIdx]
    if (old.events.length) old.events = []
  }
}

/**
 * Freeze the LIVE zone aggregate into the capped history (Task #54), called on a zone change
 * (and epoch) before the aggregate is reset. Drops a zone session that saw no attributed damage
 * (nothing to select). The aggregate is immutable once pushed, so we compute + memoize its
 * summary here (mirroring finalizeCurrent's cached-summary pattern) — snapshot() never rebuilds
 * it. Also finalizes any still-open current encounter's duration into the session totals via the
 * caller ordering (finalizeCurrent runs first in the zone handler).
 */
export function finalizeZoneSession(st: EngineState, closedBy: ZoneSessionClose = 'zone'): void {
  if (st.zoneAgg.out.size === 0 && st.zoneAgg.inc.size === 0) return
  const id = `zs${++st.zoneSeq}`
  const zone = st.zone ?? 'Session'
  const total = sumMap(st.zoneAgg.out)
  const durSec = Math.max(1, st.zoneFinalizedMs / 1000)
  const session: ZoneSession = {
    id,
    zone,
    agg: st.zoneAgg,
    closedBy,
    startTs: st.zoneStartTs,
    lastTs: st.zoneLastTs,
    finalizedMs: st.zoneFinalizedMs,
    activeMs: st.zoneActiveMs,
    summary: {
      id,
      zone,
      closedBy,
      startTs: st.zoneStartTs,
      endTs: st.zoneLastTs,
      total,
      dps: total / durSec,
      live: false
    }
  }
  st.zoneHistory.push(session)
  if (st.zoneHistory.length > ZONE_HISTORY_CAP) st.zoneHistory.shift()
}

/**
 * MINT FRESH ZONE ACCUMULATORS — the second half of every stay boundary, extracted (JOS-322)
 * because there are now TWO callers and one of them must not be allowed to drift: the zone line
 * (ingest.ts) and the SESSION MARK (engine.sessionMark).
 *
 * THE MARK IS THIS AND NOTHING ELSE. Everything the zone case does BESIDES this pair — retiring
 * the world's mobs, breaking charm, zoning the ally model, stamping the ring — is a statement
 * about the ROOM changing, and the mark makes no such statement: you did not leave, so your pet
 * survives, the mez holds, the coats stay on the blades and the session-level state timeline runs
 * straight through the boundary (segment views clip spans to the record's own span at read time,
 * so a stance running across a mark reads correctly in BOTH records).
 */
export function resetZoneAccumulators(st: EngineState): void {
  st.zoneAgg = new Agg()
  st.zoneFinalizedMs = 0
  st.zoneActiveMs = 0
  st.zoneStartTs = 0
  st.zoneLastTs = 0
}

/**
 * THE ONE WORD A ZONE SESSION IS CALLED BY (JOS-322). A stay the WORLD ended is that zone's
 * `overall`; a stay the USER ended with the app-wide "New session" mark is that zone's `session`,
 * which is the word loot and leveling already print for the very same click. One concept, one
 * vocabulary, decided from the record so the picker, the overlay header and the panel crumb can
 * never disagree about it.
 */
export function zoneSessionWord(closedBy: ZoneSessionClose | undefined): string {
  return closedBy === 'mark' ? 'session' : 'overall'
}

/**
 * The zone-session list for the snapshot (Task #54): the LIVE session first (id 'zone'), then the
 * finalized history newest-first. The live entry's timing/total is computed fresh; the finalized
 * ones reuse their memoized summaries.
 */
export function zoneSessionSummaries(st: EngineState): ZoneSessionSummary[] {
  const liveTotal = sumMap(st.zoneAgg.out)
  const liveDur = zoneDurationSec(st)
  const live: ZoneSessionSummary = {
    id: 'zone',
    zone: st.zone ?? 'Session',
    startTs: st.zoneStartTs,
    endTs: 0,
    total: liveTotal,
    dps: liveTotal / liveDur,
    live: true
  }
  const finalized = [...st.zoneHistory].reverse().map((s) => s.summary)
  return [live, ...finalized]
}

export function encSummary(e: Encounter, kind: 'fight' | 'current', now: number): SegmentSummary {
  const total = sumMap(e.agg.out)
  const dur = Math.max(1, (e.lastTs - e.startTs) / 1000)
  const activeSec = Math.min(dur, e.activeMs / 1000)
  return {
    id: e.id,
    kind,
    name: encounterName(e, kind === 'current'),
    // ZONE on the summary (Task #61) — the search haystack is name + zone, so a fight has
    // to carry where it happened. `Encounter.zone` is stamped at ensureEncounter() from
    // `this.zone`, the SAME field finalizeZoneSession() names a zone session from, so the
    // two can never disagree. finalizeCurrent() memoizes this summary, which freezes the
    // zone with it. NOTE on backfill: encounters already finalized in memory before this
    // code existed keep `zone: undefined` and are deliberately NOT backfilled — the engine
    // no longer knows which zone a past fight belonged to, and guessing today's zone would
    // be an invented fact (law 1). A restart replays the whole log through this path and
    // rebuilds every summary WITH its zone, so the gap closes on its own.
    zone: e.zone,
    durationSec: dur,
    total,
    dps: total / dur,
    activeSec,
    activeDps: total / Math.max(1, activeSec),
    startTs: e.startTs,
    active: kind === 'current' && now - e.lastTs < ACTIVE_MS,
    enemyHealTotal: sumHeal(e.agg.enemyHeal)
  }
}

export function zoneSummary(st: EngineState): SegmentSummary {
  const total = sumMap(st.zoneAgg.out)
  const dur = zoneDurationSec(st)
  const activeSec = Math.min(dur, zoneActiveSec(st))
  return {
    id: 'zone',
    kind: 'zone',
    name: `${st.zone ?? 'Session'} - overall`,
    zone: st.zone,
    durationSec: dur,
    total,
    dps: total / dur,
    activeSec,
    activeDps: total / Math.max(1, activeSec),
    startTs: 0,
    active: false,
    enemyHealTotal: sumHeal(st.zoneAgg.enemyHeal)
  }
}

export function zoneActiveSec(st: EngineState): number {
  const cur = st.current ? st.current.activeMs : 0
  return (st.zoneActiveMs + cur) / 1000
}

export function zoneDurationSec(st: EngineState): number {
  const cur = st.current ? st.current.lastTs - st.current.startTs : 0
  return Math.max(1, (st.zoneFinalizedMs + cur) / 1000)
}
