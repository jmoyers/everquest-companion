// RESPAWN CLOCKS — the fold (JOS-194). Death lines in, live countdowns out.
//
// The vocabulary, the estimate ladder and the argument for all of it live in `shared/respawn.ts`;
// the wiki floor and the measurement of how thin it is live in `shared/respawnWiki.ts`. This file
// is the state machine between them and owns three things the pure code cannot:
//
//   1. THE ZONE STAY. A death→death gap is only a respawn sample when you never left the zone
//      between the two deaths, and only the fold knows where you have been. `zoneSince` is the
//      timestamp of the `You have entered` line that started the current stay; a gap qualifies
//      when the EARLIER death also falls inside it.
//   2. THE LRU. A months-long replay walks past thousands of distinct mob names and every one of
//      them is a potential watch candidate, so the history is capped and evicted by last-death.
//   3. ITS OWN REVISION NUMBER. This module has a SECOND INPUT — the user's watch list, edited
//      over IPC while the log sits idle — so reporting the last event's `seq` would let
//      `useModule`'s `d.seq <= knownSeq` dedupe silently swallow the push that carries a watch the
//      user just added. That is JOS-87's scar exactly (a combo correction written during an idle
//      log never reached the screen), so `rev` is a private counter bumped by anything that can
//      change the state, reported by BOTH `snapshot()` and `flushDelta()`, and the IPC setter
//      calls `registry.flushNow()` rather than waiting for the heartbeat. Both halves are needed.

import type { EqModule } from './types'
import { isCountedKill } from '../log/reducers'
import { idKey } from '../log/parser'
import type { LogEvent } from '../../shared/logEvents'
import respawnsJson from '../data/respawns.json'
import type { WikiRespawn, WikiRespawnData } from '../../shared/respawnWiki'
import {
  DEFAULT_RESPAWN_PREFS,
  RESPAWN_MAX_RECENT,
  RESPAWN_MAX_ROWS,
  RESPAWN_SHAPE_VERSION,
  orderRespawnRows,
  resolveRespawn,
  respawnRowExpired,
  type RespawnCandidate,
  type RespawnDelta,
  type RespawnPrefs,
  type RespawnRow,
  type RespawnSnap
} from '../../shared/respawn'

/**
 * The shortest death→death gap this module will read as a spawn cycle.
 *
 * MEASURED, not chosen: across all 394 respawns the committed wiki floor states a duration for,
 * the SHORTEST is 78 seconds (`Groi Gutblade`), the 1st percentile is 165 s and the median is
 * 22 minutes. Nothing in the game's own documented spread comes close to a minute. So two deaths
 * of one name inside 60 seconds are two mobs standing together — a placeholder pair, a trash
 * spawn group — dying in one pull, and reading that as a respawn would drive the estimate to a
 * number the mob can never honour. This refuses the sample outright rather than recording it and
 * hoping the wiki floor lifts it back, because 85% of the mobs in the dungeons this ticket targets
 * have no wiki floor to lift it with.
 */
const MIN_GAP_MS = 60_000

/** Distinct (zone, mob) pairs the history keeps before evicting the least recently killed. */
const MAX_HISTORY = 800

/** What the fold knows about one mob in one zone. */
interface MobHistory {
  key: string
  display: string
  zone: string
  /** The most recent death, ms. */
  lastTs: number
  /** The SMALLEST qualifying gap seen — an upper bound on the respawn (shared/respawn.ts). */
  minGapMs?: number
  /** How many qualifying gaps back `minGapMs`. */
  samples: number
  /** Deaths counted, qualifying or not. */
  kills: number
}

/**
 * The committed floor, indexed once at module load.
 *
 * `respawnsJson` types itself structurally off the JSON, which is assignable to `WikiRespawnData`
 * already — the annotation is here to say WHICH declared shape this file is reading, not to widen
 * anything, so it is a variable annotation rather than a cast.
 */
const FLOOR: WikiRespawnData = respawnsJson
const WIKI = new Map<string, WikiRespawn>(FLOOR.rows.map((r) => [r.key, r]))

export class RespawnModule implements EqModule<RespawnSnap, RespawnDelta> {
  readonly id = 'respawn'
  private history = new Map<string, MobHistory>()
  private zone = ''
  /** When the current continuous stay in `zone` began. Zero before any zone line. */
  private zoneSince = 0
  private prefs: RespawnPrefs = DEFAULT_RESPAWN_PREFS
  /** THE MODULE'S OWN REVISION — see the header. Never a LogEvent seq. */
  private rev = 0
  private dirty = false
  /** The last wall-clock tick, so `snapshot()` prunes against the same clock `onTick` does. */
  private nowMs = Date.now()

  constructor(prefs?: RespawnPrefs) {
    if (prefs) this.prefs = prefs
  }

  reset(): void {
    this.history = new Map()
    this.zone = ''
    this.zoneSince = 0
    // Re-read the wall clock: a reset opens a fresh fold, and the expiry sweep in `build` has to
    // judge it against now rather than against whenever this module was constructed.
    this.nowMs = Date.now()
    this.rev++
    this.dirty = true
  }

  /**
   * The user edited the watch list. Bumps the revision so the push is not deduped, and marks the
   * state dirty so the next flush carries it; the IPC handler additionally calls `flushNow()`.
   */
  setPrefs(prefs: RespawnPrefs): void {
    this.prefs = prefs
    this.rev++
    this.dirty = true
  }

  getPrefs(): RespawnPrefs {
    return this.prefs
  }

  onEvent(ev: LogEvent): void {
    if (ev.kind === 'epoch') {
      // A character rebirth invalidates the LIVE clocks (they were another character's evening),
      // and takes the learned gaps with them for one reason only: the gaps are recomputed by the
      // very same fold that is replaying past this line, so nothing is lost that the log still
      // states. Game knowledge that persists across epochs is knowledge the log CANNOT restate.
      this.history = new Map()
      this.rev++
      this.dirty = true
      return
    }
    if (ev.kind === 'zone') {
      // A zone line ENDS the current stay and starts a new one, even when it names the same zone:
      // you left and came back, and the interval in between is not time you spent watching a
      // spawn point. Same-name re-entry is the case this would get wrong if it compared names.
      this.zone = ev.zone
      this.zoneSince = ev.ts
      this.dirty = true
      return
    }
    if (ev.kind !== 'death') return
    if (!isCountedKill(ev)) return
    this.recordDeath(idKey(ev.name), ev.name, ev.ts)
  }

  private recordDeath(key: string, display: string, ts: number): void {
    const id = `${idKey(this.zone)}::${key}`
    const prior = this.history.get(id)
    const h: MobHistory = prior ?? { key, display, zone: this.zone, lastTs: 0, samples: 0, kills: 0 }
    if (prior) {
      // Re-insert so the Map's iteration order is the LRU order (oldest first).
      this.history.delete(id)
      // The gap qualifies only when the EARLIER death is inside the current stay. `zoneSince` is
      // zero before the scan has seen any zone line, and a zero start would qualify everything,
      // so a stay that never began qualifies nothing.
      const gap = ts - h.lastTs
      if (this.zoneSince > 0 && h.lastTs >= this.zoneSince && gap >= MIN_GAP_MS) {
        h.minGapMs = h.minGapMs === undefined ? gap : Math.min(h.minGapMs, gap)
        h.samples++
      }
    }
    h.lastTs = ts
    h.kills++
    h.display = display
    this.history.set(id, h)
    while (this.history.size > MAX_HISTORY) {
      const oldest = this.history.keys().next()
      if (oldest.done) break
      this.history.delete(oldest.value)
    }
    this.rev++
    this.dirty = true
  }

  /** Prune the rows whose clocks ran out long ago. Live tail only; the registry never ticks a replay. */
  onTick(nowMs: number): void {
    this.nowMs = nowMs
    // The rows are DERIVED, so there is nothing to prune in the history — but the derived set
    // shrinks as clocks expire, and the renderer has to be told. Only publish when the visible
    // set actually changed, or this would push a snapshot every second forever.
    if (this.visibleCount(nowMs) !== this.lastVisible) this.dirty = true
  }

  private lastVisible = -1

  private visibleCount(nowMs: number): number {
    let n = 0
    for (const h of this.history.values()) if (this.rowFor(h, nowMs) !== null) n++
    return n
  }

  /**
   * Is this mob watched, and did the user ask for it by name? Returns null when it is not watched
   * at all. The auto rule admits exactly the mobs the committed floor states a DURATION for —
   * never the 113 whose field says "Triggered" or "?", which would put a permanent estimate-less
   * row on screen for every skeleton in the zone.
   */
  private watchOf(key: string): { pinned: boolean; customMs?: number } | null {
    const explicit = this.prefs.watches.find((w) => w.key === key)
    if (explicit) {
      const out: { pinned: boolean; customMs?: number } = { pinned: true }
      if (explicit.customSec !== undefined) out.customMs = explicit.customSec * 1000
      return out
    }
    if (this.prefs.autoWiki && WIKI.get(key)?.seconds !== undefined) return { pinned: false }
    return null
  }

  private rowFor(h: MobHistory, nowMs: number): RespawnRow | null {
    const watch = this.watchOf(h.key)
    if (!watch) return null
    const wiki = WIKI.get(h.key)
    const wikiMs = wiki?.seconds !== undefined ? wiki.seconds * 1000 : undefined
    const est = resolveRespawn({
      customMs: watch.customMs,
      observedMs: h.minGapMs,
      samples: h.samples,
      wikiMs
    })
    const row: RespawnRow = {
      id: `${idKey(h.zone)}::${h.key}`,
      key: h.key,
      display: h.display,
      zone: h.zone,
      diedTs: h.lastTs,
      source: est.source,
      samples: h.samples,
      kills: h.kills,
      pinned: watch.pinned
    }
    if (est.estimateMs !== undefined) row.estimateMs = est.estimateMs
    if (h.minGapMs !== undefined) row.observedMs = h.minGapMs
    if (wiki) row.wikiText = wiki.text
    if (wikiMs !== undefined) row.wikiMs = wikiMs
    return respawnRowExpired(row, nowMs) ? null : row
  }

  private build(nowMs: number): RespawnSnap {
    const rows: RespawnRow[] = []
    const recent: RespawnCandidate[] = []
    // The Map iterates oldest-first (the LRU order), so walk it backwards for "most recent".
    const entries = [...this.history.values()].sort((a, b) => b.lastTs - a.lastTs)
    for (const h of entries) {
      const row = this.rowFor(h, nowMs)
      if (row && rows.length < RESPAWN_MAX_ROWS) rows.push(row)
      if (recent.length < RESPAWN_MAX_RECENT) {
        const wiki = WIKI.get(h.key)
        const cand: RespawnCandidate = {
          key: h.key,
          display: h.display,
          zone: h.zone,
          lastTs: h.lastTs,
          kills: h.kills,
          watched: this.watchOf(h.key) !== null
        }
        if (wiki) cand.wikiText = wiki.text
        if (wiki?.seconds !== undefined) cand.wikiMs = wiki.seconds * 1000
        recent.push(cand)
      }
    }
    this.lastVisible = rows.length
    return {
      v: RESPAWN_SHAPE_VERSION,
      zone: this.zone,
      rows: orderRespawnRows(rows, nowMs),
      recent,
      prefs: this.prefs
    }
  }

  snapshot(): { seq: number; state: RespawnSnap } {
    return { seq: this.rev, state: this.build(this.nowMs) }
  }

  flushDelta(): { seq: number; delta: RespawnDelta } | null {
    if (!this.dirty) return null
    this.dirty = false
    return { seq: this.rev, delta: this.build(this.nowMs) }
  }
}

/**
 * What the committed floor says about a mob, for the IPC layer's benefit (the watch editor shows
 * the wiki's verbatim text beside a mob you are about to add). Exported rather than re-indexed:
 * one Map, one answer.
 */
export function wikiRespawnFor(key: string): WikiRespawn | undefined {
  return WIKI.get(key)
}
