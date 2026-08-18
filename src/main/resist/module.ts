// The resist module: an EqModule wrapper around `ResistFold` (JOS-382).
//
// A PULL, NOT A PUSH — the documented variant, and the same call the combat engine makes. The
// generic `module:delta` transport exists so a renderer can mirror a module's state incrementally;
// this module's state is a ~700 kB ledger whose only consumer wants ONE mob out of it at a time, on
// a page the user has to navigate to. So `flushDelta()` returns null, `snapshot()` carries counts
// for diagnostics, and the mob page asks `resist:profile` for exactly what it is about to draw.
// Stated rather than left implicit, because the one-transport rule deserves an explicit exception
// rather than a silent one.
//
// NOTHING IN THIS FILE IMPORTS ELECTRON, AND THAT IS LOAD-BEARING. `createModules()` is
// constructed by the replay bench and by `tests/foldDeterminism.test.mts`, both of which run under
// plain node — one `import { app } from 'electron'` anywhere in a module's transitive graph takes
// the whole suite down with `Cannot read properties of undefined (reading 'isPackaged')`, which is
// exactly how this arrangement was found. So the ledger arrives as a SEAM: `pipeline.ts`, which is
// Electron-aware anyway, injects the real userData-backed store, and a caller that injects nothing
// gets a private in-memory one that folds identically and writes nothing anywhere.
//
// IT DOES NOT RESET AT AN EPOCH BOUNDARY, and that is deliberate. Character-scoped state (loot,
// kills, leveling) belongs to a character and dies with one; what a mob resists is GAME KNOWLEDGE,
// like the mined message overlay and the mined respawn durations, and a rebirth does not unlearn
// it. The per-character BUCKET still exists, so a re-fold of that character's log replaces its own
// contribution and nothing else.
//
// THE PERSIST IS ON THE HEARTBEAT, not on a timer of its own: the registry already ticks once a
// second while the live tail runs, so a counter on that tick is a snapshot every minute for the
// price of an increment. Nothing is written during a replay — the registry does not tick then —
// which is exactly right, because a replay is re-deriving what is already on disk.

import type { EqModule } from '../modules/types'
import type { LogEvent } from '../../shared/logEvents'
import type { SpellDb } from '../data/spellDb'
import { ResistFold } from './fold'
import { ResistLedgerStore, type ResistBucket } from './ledger'
import type { MobLevelFact } from './world'

/** Ticks between ledger snapshots. One a minute, on the registry's own 1 s heartbeat. */
const PERSIST_EVERY_TICKS = 60

/** The ledger, as this module is allowed to see it. See the header for why it is a seam. */
export interface ResistLedgerSeam {
  /** Discard this source's bucket (JOS-231) and hand back the fresh one to fold into. */
  beginSource: (key: string) => ResistBucket
  /** Snapshot the user's half of the ledger. Best-effort; a no-op for an in-memory store. */
  persist: () => void
  counts: () => { rows: number; mobs: number }
}

/** The default seam: everything in memory, nothing on disk. What the bench and the tests get. */
function memorySeam(): ResistLedgerSeam {
  const store = new ResistLedgerStore()
  return {
    beginSource: (key) => store.beginSource(key),
    persist: () => undefined,
    counts: () => {
      let rows = 0
      for (const src of store.toLedger().sources) rows += src.rows.length
      return { rows, mobs: store.mobKeys().size }
    },
  }
}

/** Diagnostics only: what the module has folded. The renderer pulls profiles, not this. */
export interface ResistSnap {
  rows: number
  mobs: number
}

export interface ResistModuleDeps {
  /** The WIKI spell catalog, for recognising a resist debuff by its verbatim effect line. */
  spellDb?: SpellDb
  ledger?: ResistLedgerSeam
}

export class ResistModule implements EqModule<ResistSnap, never> {
  readonly id = 'resist'
  private readonly ledger: ResistLedgerSeam
  private fold: ResistFold
  private seq = 0
  private ticks = 0
  private sourceKey = 'log'

  constructor(private readonly deps: ResistModuleDeps = {}) {
    this.ledger = deps.ledger ?? memorySeam()
    this.fold = new ResistFold({ spellDb: deps.spellDb })
  }

  reset(): void {
    this.seq = 0
    this.fold = new ResistFold({ spellDb: this.deps.spellDb })
    this.fold.beginSource(this.ledger.beginSource(this.sourceKey))
  }

  /**
   * Name the character whose log is about to be folded. DISCARDS that character's bucket first
   * (JOS-231), so re-reading the same log every launch replaces its contribution instead of
   * doubling it.
   */
  beginSource(key: string): void {
    this.sourceKey = key
    this.fold.beginSource(this.ledger.beginSource(key))
  }

  onEvent(ev: LogEvent): void {
    this.seq = ev.seq
    this.fold.onEvent(ev)
  }

  onTick(nowMs: number): void {
    // SETTLE, never finish: a landing that has waited out its cancel window is decided, and a song
    // pulse that can gain no more witnesses is closed — but a bard mid-rotation still has an open
    // run, and ending it here would forfeit the interpolation the next gap is entitled to.
    this.fold.settle(nowMs)
    if (++this.ticks < PERSIST_EVERY_TICKS) return
    this.ticks = 0
    this.ledger.persist()
  }

  /** The mob's level as the fold knows it: a `/con` this session beats the committed catalog. */
  levelOf(key: string, display: string): MobLevelFact | null {
    return this.fold.levelOf(key, display)
  }

  snapshot(): { seq: number; state: ResistSnap } {
    return { seq: this.seq, state: this.ledger.counts() }
  }

  /** See the header: this module is read by pulling, so it never pushes an increment. */
  flushDelta(): null {
    return null
  }
}
