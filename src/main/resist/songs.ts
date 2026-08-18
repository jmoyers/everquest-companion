// BARD SONGS: reconstructing the denominator, conservatively (JOS-382, owner ruling 2026-08-16 —
// verbatim: "make sure you can verify the song is running").
//
// Pure: a state machine over timestamps, with one callback out. No Electron, no parser types.
// `tests/resistSongs.test.mts` drives it directly.
//
// ── THE PROBLEM ─────────────────────────────────────────────────────────────────────────────────
//
// A cast rolls resistance once and the log prints the outcome either way: a resist line, or a
// landing. A SONG re-rolls on every pulse, and the log prints only the RESISTS. So the naive
// denominator — "resists / (resists + landings)" — reads a song that landed forty times and
// resisted twice as 100% resisted, because thirty-eight of those pulses printed nothing at all.
// Songs would then dominate every bard's resist profile with a number that is pure artifact.
//
// The fix is to reconstruct the pulses that printed nothing, and the owner's constraint on the
// reconstruction is the important half: only count a pulse you can VERIFY happened.
//
// ── THE MEASUREMENT THE RULES REST ON ───────────────────────────────────────────────────────────
//
// Gaps between consecutive resists of one song on one mob in the owner's log are 6, 12, 18 and 24
// seconds — never 7, never 9. THE PULSE INTERVAL IS 6 SECONDS. That is what makes interpolation
// possible at all: between two things the log DID print six seconds apart, exactly zero pulses are
// missing; twelve seconds apart, exactly one is.
//
// And what makes it necessary: "still singing" cannot be read off the cast lines. `Your song
// ends.` and `A missed note brings X's <song> to a close!` exist but are rare, and starting
// another song does NOT end the previous one — bards TWIST, running four songs in rotation. A
// `You begin singing` line therefore says a song started and says nothing about any other song
// stopping.
//
// ── THE FOUR RULES ──────────────────────────────────────────────────────────────────────────────
//
//   1. WITNESSED. A pulse of song S at time t is witnessed iff the log printed, at t (+-1 s), a
//      resist line, a landing emote, or a DoT tick for S on ANY target. Something happened;
//      therefore the song was running.
//   2. INTERPOLATED. Pulses at t+6k strictly between two witnessed pulses no more than 30 s apart
//      are counted as having happened — the song demonstrably ran across the gap. NOTHING is
//      extrapolated before the first or after the last witness of a run: the edges are exactly
//      where "it might have stopped" lives. A `You begin singing S` inside the gap RE-ANCHORS and
//      the interior pulses before it are dropped, because that line proves a restart and a restart
//      means the interval between it and the previous witness was not a continuous run.
//   3. IN RANGE. A pulse counts as an attempt against mob M only if M was alive and in MELEE
//      CONTACT with you inside the previous 6 seconds — M hit or missed you, or you melee-hit M.
//      Bard songs are point-blank area effects and the log states no radius, so melee proximity is
//      the proxy. (This file owns rules 1 and 2; the fold owns rule 3, which needs the world.)
//   4. SEPARABLE. Songs are their own evidence family in the ledger and their own line in the UI,
//      so if the numbers ever look wrong they can be excluded from R in exactly one place.
//
// ── WHICH WAY EACH RULE IS WRONG, stated because it is the whole argument ────────────────────────
//
// Rule 2 can OVER-count only if a song stopped and restarted inside a <=30 s window without
// printing `You begin singing` — and the log shows no mechanism that does that. Rule 3 UNDER-counts
// attempts on rooted or ranged mobs you are not meleeing, which biases R upward, toward "more
// resistant": the safe direction, since the cost of that error is being told to use a different
// spell rather than being told a resistant mob is easy.

/** MEASURED, not chosen: consecutive song resists on one mob are 6, 12, 18, 24 s apart. */
export const SONG_PULSE_MS = 6_000
/** Two witnesses further apart than this are two runs, and nothing is interpolated between them. */
export const SONG_RUN_GAP_MS = 30_000
/** Everything the log prints for one pulse lands inside this window of it. */
export const SONG_WITNESS_JOIN_MS = 1_000
/** Rule 3's window: melee contact inside the last pulse interval is "in range". */
export const SONG_CONTACT_MS = SONG_PULSE_MS

/** One reconstructed pulse. `witnessed` false means rule 2 put it there. */
export interface SongPulse {
  spellKey: string
  ts: number
  witnessed: boolean
  /** Mobs the log named as resisting this pulse. Empty for an interpolated pulse, always. */
  resisted: ReadonlySet<string>
}

/** How many aura heartbeat instants to remember. A run is 30 s, so five pulses is plenty. */
const HEARTBEAT_MEMORY = 32

interface Run {
  /** The last witnessed pulse's instant, or null when no run is open. */
  lastWitness: number | null
  /** A `You begin singing` inside the current gap, which re-anchors interpolation. */
  reanchor: number | null
}

interface Open {
  ts: number
  resisted: Set<string>
}

/**
 * Reconstructs song pulses from what the log printed. Feed it witnesses in timestamp order; it
 * calls back with every pulse it can justify, in order, once it is sure of them.
 */
export class SongPulses {
  private runs = new Map<string, Run>()
  private open = new Map<string, Open>()
  /**
   * Instants the SYMPHONIC AURA stated outright, from the self-landing sentences it prints once
   * per pulse. Interior pulses snap to these when the gap contains any: a real instant the log
   * printed beats six-second arithmetic from the last witness, which drifts as soon as the server
   * tick does.
   */
  private beats: number[] = []

  constructor(private readonly emit: (pulse: SongPulse) => void) {}

  reset(): void {
    this.runs = new Map()
    this.open = new Map()
    this.beats = []
  }

  /** The aura printed one of its own landing sentences: a pulse happened at `ts`. */
  noteHeartbeat(ts: number): void {
    const last = this.beats[this.beats.length - 1]
    if (last !== undefined && ts - last < SONG_WITNESS_JOIN_MS) return
    this.beats.push(ts)
    if (this.beats.length > HEARTBEAT_MEMORY) this.beats.splice(0, this.beats.length - HEARTBEAT_MEMORY)
  }

  /** `You begin singing S` — a restart, which drops interpolation across the gap it sits in. */
  noteSing(spellKey: string, ts: number): void {
    this.closeOpen(spellKey, ts)
    const run = this.run(spellKey)
    run.reanchor = ts
  }

  /**
   * The log printed something for song S at `ts`: a resist naming `mobKey`, or a landing/tick
   * naming nobody in particular (`mobKey` null). Everything inside `SONG_WITNESS_JOIN_MS` of the
   * first such line is ONE pulse.
   */
  witness(spellKey: string, ts: number, mobKey: string | null): void {
    const open = this.open.get(spellKey)
    if (open && ts - open.ts <= SONG_WITNESS_JOIN_MS) {
      if (mobKey) open.resisted.add(mobKey)
      return
    }
    this.closeOpen(spellKey, ts)
    const fresh: Open = { ts, resisted: new Set<string>() }
    if (mobKey) fresh.resisted.add(mobKey)
    this.open.set(spellKey, fresh)
  }

  /**
   * Close any pulse that can no longer gain witnesses, WITHOUT ending the runs they belong to.
   * This is what the live tail calls on its heartbeat: a bard mid-rotation has an open pulse and
   * an open run, and ending the run would forfeit every interpolated pulse across the next gap.
   */
  settle(now: number): void {
    for (const key of [...this.open.keys()]) this.closeOpen(key, now)
  }

  /**
   * End everything: close the buffered pulses AND end every run, so nothing is interpolated
   * across the boundary. A zone change and the end of a fold are both real discontinuities — the
   * song may well have stopped, and rule 2 extrapolates past nothing.
   */
  flush(): void {
    this.settle(Number.POSITIVE_INFINITY)
    this.runs = new Map()
  }

  private run(spellKey: string): Run {
    let run = this.runs.get(spellKey)
    if (!run) {
      run = { lastWitness: null, reanchor: null }
      this.runs.set(spellKey, run)
    }
    return run
  }

  /**
   * Close the buffered pulse: interpolate back to the previous witness if the gap allows, then
   * emit the witnessed pulse itself. `now` is only used to decide whether the buffer is stale.
   */
  private closeOpen(spellKey: string, now: number): void {
    const open = this.open.get(spellKey)
    if (!open) return
    if (now - open.ts <= SONG_WITNESS_JOIN_MS) return
    this.open.delete(spellKey)
    const run = this.run(spellKey)
    this.interpolate(spellKey, run, open.ts)
    this.emit({ spellKey, ts: open.ts, witnessed: true, resisted: open.resisted })
    run.lastWitness = open.ts
    run.reanchor = null
  }

  /** Rule 2, in full: the interior pulses of one gap, minus anything before a restart. */
  private interpolate(spellKey: string, run: Run, ts: number): void {
    const prev = run.lastWitness
    if (prev === null) return
    if (ts - prev > SONG_RUN_GAP_MS) return
    const floor = run.reanchor ?? prev
    for (const at of this.interiorPulses(prev, ts)) {
      if (at <= floor) continue
      this.emit({ spellKey, ts: at, witnessed: false, resisted: EMPTY })
    }
  }

  /**
   * The instants strictly inside a gap. THE AURA'S OWN HEARTBEAT WINS where it has anything to
   * say: those are instants the log printed rather than arithmetic, so they cannot drift against
   * the server's tick. Six-second stepping is the fallback for a run with no heartbeat in it.
   */
  private interiorPulses(prev: number, ts: number): number[] {
    const beats = this.beats.filter((b) => b > prev + SONG_WITNESS_JOIN_MS && b < ts - SONG_WITNESS_JOIN_MS)
    if (beats.length > 0) return beats
    const out: number[] = []
    for (let at = prev + SONG_PULSE_MS; at < ts - SONG_WITNESS_JOIN_MS; at += SONG_PULSE_MS) out.push(at)
    return out
  }
}

const EMPTY: ReadonlySet<string> = new Set<string>()
