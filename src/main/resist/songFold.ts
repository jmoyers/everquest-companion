// EVERYTHING THE FOLD DOES ABOUT SONGS, in one place (JOS-382, round 2).
//
// Split out of `fold.ts` when that file crossed the repo's 400-code-line factoring ceiling. The
// seam is not arbitrary: songs are the one evidence family whose observations are earned
// differently from every other line the fold reads, and keeping the difference in one file is what
// lets `songs are excluded from R in ONE place` (owner ruling) stay literally true.
//
// ── HOW A SONG'S ATTEMPTS ARE COUNTED, and why there are two ways ───────────────────────────────
//
// EQ Legends bards run their songs under the SYMPHONIC AURA, which re-pulses every six seconds and
// prints NO cast line at all. So there is never anything to arm and never anything to join a
// landing emote to. What the log does print, per pulse, is one line per creature in range:
//
//     [16:29:32] Your feet move faster.                                   <- the aura's heartbeat
//     [16:29:32] Soldier of V`Zher resisted your Largo's Melodic Binding!  <- a pulse that missed
//     [16:29:32] Baron Telyx V`Zher is bound by strands of solid music.    <- a pulse that landed
//
//   1. THE SENTENCE IS KNOWN (the ordinary case). Every pulse that lands prints the song's
//      cast-on-other sentence and every pulse that misses prints a resist, so attempts are
//      lands + resists per (song, mob) EXACTLY. Nothing is reconstructed, and the pulse rules in
//      songs.ts are deliberately NOT applied on top: they would count the same pulses twice.
//   2. THE SENTENCE IS NOT KNOWN. Only then does the reconstruction run, on the witnesses there
//      are — resist lines, DoT ticks, and the aura's own heartbeat.
//
// ── AND ANOTHER BARD'S SONGS ARE NOT OURS TO READ ───────────────────────────────────────────────
//
// A stranger's pulses print a landing sentence that names no caster, so their songs have no
// denominator we could ever see. Filing the resist half alone is exactly the defect this round
// fixes; refusing the whole spell is the honest half.

import { spellCanonKey } from '../../shared/spellKey'
import type { SpellDb } from '../data/spellDb'
import type { ResistCasterKind } from '../../shared/resistTypes'
import { SONG_CONTACT_MS, SongPulses, type SongPulse } from './songs'
import { isSongSpell, resolveSongEmote, songLandingObservable } from './songIdentity'

/** What the song half needs from the fold that owns it. */
export interface SongSink {
  /** File one landed pulse against this mob. */
  land: (mobDisplay: string, songKey: string, ts: number) => void
  /** File one resisted pulse against this mob. */
  resist: (mobDisplay: string, songKey: string, ts: number) => void
  keyOf: (display: string) => string
  /** The display name last seen for a key, for a pulse the reconstruction files by key alone. */
  displayFor: (key: string) => string
  /** Mobs in melee contact within the window ending at `ts` — song rule 3. */
  contactsAt: (ts: number, windowMs: number) => string[]
  /** The tailed character's level, or null until a `/who` has stated one — see `resolveSongEmote`. */
  casterLevel: () => number | null
}

export class SongFold {
  private readonly pulses: SongPulses
  /** Songs the log has NAMED in a resist line, newest first. Resolves an ambiguous sentence. */
  private named: string[] = []
  /** Per mob: the songs a resist line named there. The better half of the same resolution. */
  private namedByMob = new Map<string, string[]>()
  /** Songs a `You begin singing` line announced. Additive only; identity is the real answer. */
  private sung = new Set<string>()

  constructor(
    private readonly db: SpellDb | undefined,
    private readonly sink: SongSink
  ) {
    this.pulses = new SongPulses((pulse) => {
      this.filePulse(pulse)
    })
  }

  reset(): void {
    this.pulses.reset()
    this.named = []
    this.namedByMob = new Map()
    this.sung = new Set()
  }

  settle(now: number): void {
    this.pulses.settle(now)
  }

  flush(): void {
    this.pulses.flush()
  }

  /** True once any song has been seen; the fold uses it to skip melee-contact bookkeeping. */
  get active(): boolean {
    return this.named.length > 0 || this.sung.size > 0
  }

  /**
   * A song, by identity. The catalog's class column is the answer; a `You begin singing` line is a
   * corroborating signal for the rare song a bard starts by hand, and can only ever ADD to the set.
   */
  isSong(spellKey: string): boolean {
    return this.sung.has(spellKey) || isSongSpell(this.db, spellKey)
  }

  /** `You begin singing X.` — rare under the aura, and still worth believing when it appears. */
  noteSung(spellKey: string, ts: number): void {
    this.sung.add(spellKey)
    this.pulses.noteSing(spellKey, ts)
  }

  /**
   * A landing sentence on YOURSELF. When it belongs to a song it is the aura's HEARTBEAT:
   * `Your feet move faster.` prints 6,966 times in the owner's log, once per pulse, whether or not
   * anything was in range. It is the only line that states a pulse instant directly.
   */
  onSelfLanding(ts: number, candidates: readonly string[]): void {
    for (const name of candidates) {
      if (!this.isSong(spellCanonKey(name))) continue
      this.pulses.noteHeartbeat(ts)
      return
    }
  }

  /** A resist line naming a song. Returns false when it was not a song at all. */
  onResist(mobDisplay: string, spellKey: string, kind: ResistCasterKind, ts: number): boolean {
    if (!this.isSong(spellKey)) return false
    if (kind !== 'self') return true
    // A resist line SPELLS THE SONG OUT, so the key it carries is the answer — there is no family
    // table between the log's word and the ledger's row (JOS-384).
    const mob = this.sink.keyOf(mobDisplay)
    this.noteNamed(mob, spellKey)
    if (songLandingObservable(this.db, spellKey)) this.sink.resist(mobDisplay, spellKey, ts)
    else this.pulses.witness(spellKey, ts, mob)
    return true
  }

  /**
   * A landing sentence naming a mob. Returns true when it belonged to a song — handled OR refused,
   * because either way no armed cast may claim it afterwards.
   */
  onEmote(mobDisplay: string, ts: number, candidates: readonly string[] | undefined): boolean {
    if (!candidates || candidates.length === 0) return false
    const mob = this.sink.keyOf(mobDisplay)
    const songKey = resolveSongEmote(this.db, candidates, this.namedFor(mob), this.sink.casterLevel())
    if (songKey === null) {
      // Either not a song, or two songs share the sentence and nothing separates them. Pooling two
      // songs would smear their resist adjusts together, so an ambiguous pulse is refused.
      return candidates.some((c) => this.isSong(spellCanonKey(c)))
    }
    if (songLandingObservable(this.db, songKey)) this.sink.land(mobDisplay, songKey, ts)
    else this.pulses.witness(songKey, ts, null)
    return true
  }

  /**
   * A song's own damage line. Where the landing sentence is known, the SENTENCE is the observation
   * and the tick is the same pulse printing twice (Denon's Disruptive Discord emits both). Where it
   * is not, the tick is one of the few witnesses there are.
   */
  onDamage(spellKey: string, kind: ResistCasterKind, ts: number): boolean {
    if (!this.isSong(spellKey)) return false
    if (kind !== 'self') return true
    if (!songLandingObservable(this.db, spellKey)) this.pulses.witness(spellKey, ts, null)
    return true
  }

  private noteNamed(mobKey: string, songKey: string): void {
    this.named = [songKey, ...this.named.filter((k) => k !== songKey)].slice(0, 8)
    const here = this.namedByMob.get(mobKey) ?? []
    this.namedByMob.set(mobKey, [songKey, ...here.filter((k) => k !== songKey)].slice(0, 4))
  }

  private namedFor(mobKey: string): string[] {
    return [...(this.namedByMob.get(mobKey) ?? []), ...this.named]
  }

  /**
   * Rule 3: one reconstructed pulse becomes one attempt against every mob that was alive and in
   * melee contact inside the last pulse interval — plus every mob the log NAMED as resisting it,
   * which is proof of range no proximity heuristic can improve on.
   */
  private filePulse(pulse: SongPulse): void {
    const targets = new Set(this.sink.contactsAt(pulse.ts, SONG_CONTACT_MS))
    for (const key of pulse.resisted) targets.add(key)
    for (const key of targets) {
      const display = this.sink.displayFor(key)
      if (pulse.resisted.has(key)) this.sink.resist(display, pulse.spellKey, pulse.ts)
      else this.sink.land(display, pulse.spellKey, pulse.ts)
    }
  }
}
