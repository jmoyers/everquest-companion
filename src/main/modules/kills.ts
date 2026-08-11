// kills module — the KillMap (per-mob count / best instance tier / first+last
// seen). Reuses the pure isCountedKill filter + recordKill fold from reducers.ts
// so the count semantics stay identical to the legacy tracker. Delta = only the
// per-mob entries that changed since the last flush; the renderer merges them in.
//
// THE CREDIT JOIN (2026-08-05, owner-reported: "it looks like it's celebrating even when I'm not
// the killer of the boss — I'm in open world and somebody killed [it]"). Every kill this module
// counts is a kill of that mob — a world fact, and the roster's defeated state is right to record
// it. But a kill is YOURS only when the log paid you for it, and the log says so in exactly one
// way: an experience line immediately BEFORE the slain line, same second (the sweep in
// progression.ts). That covers the group case for free — a group-mate's killing blow pays party
// experience, which is still an exp line in YOUR log — and excludes the stranger across the zone,
// whose kill pays you nothing and prints nothing.
//
// So the join runs here too, with progression.ts's exact semantics (claim BACKWARD inside
// KILL_EXP_JOIN_MS; a claim CONSUMES the line so it can never credit two kills; every death line
// consumes, including ones this module does not count). What it produces is one number per tier
// run, `credited`, that ONLY the celebration predicate reads. Nothing about tracking moved.

import type { EqModule } from './types'
import { isCountedKill, recordKill } from '../log/reducers'
import { zoneTier, idKey } from '../log/parser'
import type { LogEvent } from '../../shared/logEvents'
import {
  KILLS_SHAPE_VERSION,
  KILL_EXP_JOIN_MS,
  type KillMap,
  type KillsDelta,
  type KillsSnap
} from '../../shared/kills'

export class KillsModule implements EqModule<KillsSnap, KillsDelta> {
  readonly id = 'kills'
  private kills: KillMap = {}
  private zone: string | undefined
  private seq = 0
  /** mob names touched since the last flush (deltas carry only these entries). */
  private dirty = new Set<string>()
  /** The experience line the next kill line may claim — the timestamp is all this module needs. */
  private pendingExpTs: number | null = null

  reset(): void {
    this.kills = {}
    this.zone = undefined
    this.seq = 0
    this.dirty = new Set()
    this.pendingExpTs = null
  }

  /**
   * The experience line this kill line claims, if any. Claiming CONSUMES it, so one line can
   * never credit two kills; an UNCLAIMED older line is simply replaced when a newer one arrives
   * (two exp lines with no kill between them means the first one's kill never printed, and
   * handing a stale line to a later kill would be a fabricated attribution).
   */
  private takeExp(ts: number): boolean {
    const at = this.pendingExpTs
    this.pendingExpTs = null
    return at !== null && ts >= at && ts - at <= KILL_EXP_JOIN_MS
  }

  onEvent(ev: LogEvent): void {
    this.seq = ev.seq
    if (ev.kind === 'epoch') {
      // Character rebirth (Task #49): kills before the boundary are a dead same-name
      // character's. Clear the KillMap. (The delta is a per-mob merge, not a full replace, so
      // a LIVE wipe relies on the re-hydration index.ts triggers via onCharacter; during a
      // rescan the reset happens mid-replay and no deltas push.)
      this.kills = {}
      this.dirty = new Set()
      this.pendingExpTs = null
      return
    }
    if (ev.kind === 'zone') {
      this.zone = ev.zone
      return
    }
    if (ev.kind === 'expGain') {
      this.pendingExpTs = ev.ts
      return
    }
    if (ev.kind !== 'death') return
    // Consumed BEFORE the counted filter, exactly as progression.ts does it: the line belongs to
    // the kill it precedes whoever landed the blow, and letting a dropped `slain by You` twin
    // leave it pending would hand your experience to the next mob that dies near you.
    const credited = this.takeExp(ev.ts)
    if (!isCountedKill(ev)) return
    // THE TIER IS THE ZONE YOU WERE STANDING IN, and `zoneTier` now answers with four kinds of
    // thing, not one number in five (JOS-166): a difficulty d0..d4 for an instance, TIER_OPEN_WORLD
    // for a bare zone name, TIER_UNKNOWN for an instance it cannot decode — and TIER_UNKNOWN for
    // the empty string, which is this module's state before the scan has reached ANY zone line.
    // That last case is why the `?? ''` is a real answer rather than a fallback: a kill folded
    // before the first `You have entered` states nothing about where it happened, and it is not
    // permitted to state d0.
    const tier = zoneTier(this.zone ?? '').tier
    // Key by the canonical lowercase name so the two casings EQ emits for the same
    // mob (sentence-start "A …" on slain-by lines, mid-sentence "a …" on
    // You-have-slain lines) fold into one entry; keep the raw name for display.
    const key = idKey(ev.name)
    recordKill(this.kills, { key, display: ev.name, tier, ts: ev.ts, credited })
    this.dirty.add(key)
  }

  snapshot(): { seq: number; state: KillsSnap } {
    return { seq: this.seq, state: { v: KILLS_SHAPE_VERSION, mobs: this.kills } }
  }

  /**
   * Only the mobs touched since the last flush, each carrying its WHOLE entry (tiers map
   * included) — the renderer replaces that mob wholesale rather than merging fields, so a
   * mob's per-tier breakdown is always exactly the one folded here. The version stamp lets a
   * renderer holding an older-shaped baseline detect it and re-hydrate instead of merging
   * across shapes (shared/kills.ts, KILLS_SHAPE_VERSION).
   */
  flushDelta(): { seq: number; delta: KillsDelta } | null {
    if (this.dirty.size === 0) return null
    const changed: KillMap = {}
    for (const mob of this.dirty) changed[mob] = this.kills[mob]
    this.dirty = new Set()
    return { seq: this.seq, delta: { v: KILLS_SHAPE_VERSION, changed } }
  }
}
