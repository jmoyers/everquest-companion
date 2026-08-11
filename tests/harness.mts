// Golden-window test harness (Task #33). Replays a fixture log excerpt through the REAL
// parser + BuffsModule and returns the module's snapshot, so tests assert a plausible
// world model against hand-verified time spans of the user's actual log.
//
// The fixtures under tests/fixtures/*.log are trimmed excerpts of the real
// eqlog_Primitive_freeport.txt (third-party chat/social dropped by the shared scrub
// tests/fixture-scrub.mjs; every buff/entity-relevant line kept). They are COMMITTED — the
// repo is public, so regenerate them only through tests/extract-*.mjs, which all route
// through that scrub. Each golden test documents the raw line range it was cut from and the sequence
// it hand-verifies. This is the methodology the user mandated: never trust the model —
// pin it to real log windows a human read line-by-line.

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { parseEvent } from '../src/main/log/parser'
import { installSpellDb } from '../src/main/log/rulesets'
import { loadSpellDb } from '../src/main/data/spellDb'
import { BuffsModule } from '../src/main/modules/buffs'
import { BuffTimersModule } from '../src/main/modules/buffTimers'
import type { SpellStats } from '../src/main/modules/buffsStats'
import { buildTimerRows } from '../src/shared/buffTimers'
import type { BuffTimerRow, BuffTimersSnap } from '../src/shared/buffTimers'
import type { BuffsSnap } from '../src/shared/types'

const HERE = dirname(fileURLToPath(import.meta.url))
export const FIXTURES = join(HERE, 'fixtures')

export function readFixture(name: string): string[] {
  return readFileSync(join(FIXTURES, name), 'utf8').split(/\r?\n/).filter((l) => l.length > 0)
}

/**
 * Replay raw log lines through the real parser + BuffsModule and return the final
 * snapshot state. `finalTickMs`, when given, fires one `onTick(finalTickMs)` after the
 * fold — modeling the wall-clock heartbeat the live app runs (so a cast in the last 15s
 * confirms, and overdue actives get swept) at a chosen observation instant.
 *
 * `opts.prime` is an EARLIER real log excerpt replayed through the SAME module first, to
 * establish learned state (everFaded / spell class / recognized landing emotes) before
 * the window — exactly as the full-log replay does ahead of the live tail in production.
 * The long inter-day gap between a priming excerpt and its window naturally trips the
 * ≥30-min session-gap clear, which wipes stale ACTIVES/entities but PRESERVES the learned
 * maps (that's the point of priming): the window starts from a clean active set with a
 * warm classifier.
 *
 * THE SPELL DB IS INSTALLED, because production installs it (JOS-118). This replay used to
 * clear it deliberately — "the W1–W6 windows assert the pre-DB cast-timing/emote path" — which
 * modelled a configuration the app has not run since Task #34: `installSpellDb` fires at main
 * startup, so the live parser ALWAYS has the DB and always emits the message-driven
 * `buffApply`/`buffWearOff` events. With the DB cleared, no landing line parses at all, and the
 * only thing that could ever open an instance was the cast-timing INFERENCE — the optimistic
 * provisional JOS-118 deletes, and the source of the resisted-debuff bar the owner reported.
 * So these windows were pinning the fallback rather than the behaviour. They keep their real
 * bytes and their assertions; what changed is that they now run the configuration the user has.
 */
export function replayBuffs(lines: string[], finalTickMs?: number, opts?: { prime?: string[] }): BuffsSnap {
  const db = loadSpellDb()
  installSpellDb(db)
  const mod = new BuffsModule(db)
  mod.reset()
  let seq = 0
  for (const raw of opts?.prime ?? []) {
    const ev = parseEvent(raw, seq++)
    if (ev) mod.onEvent(ev)
  }
  for (const raw of lines) {
    const ev = parseEvent(raw, seq++)
    if (ev) mod.onEvent(ev)
  }
  if (finalTickMs != null) mod.onTick(finalTickMs)
  return mod.snapshot().state
}

/**
 * DB-ENABLED replay (Task #34): install the real scraped spell DB into the parser config
 * AND give it to the BuffsModule, then replay — exactly what production does. This
 * exercises the message-driven path (buffApply/buffWearOff from exact chat messages,
 * self-heal-by-buff applies, Permanent Illusion). Used by the W7–W9 golden windows.
 *
 * Since JOS-118 this is behaviourally identical to `replayBuffs` above (which no longer clears
 * the DB) and the two are kept apart only so each window still says which path it was written
 * to exercise. There is no longer a DB-off replay to interleave with, so the ordering caveat
 * this comment used to carry is gone.
 */
export function replayBuffsWithDb(
  lines: string[],
  finalTickMs?: number,
  opts?: { prime?: string[] }
): BuffsSnap {
  const db = loadSpellDb()
  installSpellDb(db)
  const mod = new BuffsModule(db)
  mod.reset()
  let seq = 0
  for (const raw of opts?.prime ?? []) {
    const ev = parseEvent(raw, seq++)
    if (ev) mod.onEvent(ev)
  }
  for (const raw of lines) {
    const ev = parseEvent(raw, seq++)
    if (ev) mod.onEvent(ev)
  }
  if (finalTickMs != null) mod.onTick(finalTickMs)
  return mod.snapshot().state
}

/**
 * THE BUFFS/TIMER OVERLAY's replay (JOS-89). Folds the SAME event stream through the real
 * parser, the real BuffsModule AND the real BuffTimersModule, then runs the real projection —
 * so a test asserts the rows a user would actually see on the overlay, not an intermediate.
 *
 * `until` stops the fold at an instant (inclusive), which is how a per-target mez is observed
 * BEFORE and AFTER its break line without cutting a second fixture. `tickMs` fires the wall-clock
 * heartbeat both modules take, modelling an idle log at a chosen observation instant.
 *
 * `ticks` fires the heartbeat MID-FOLD, at each listed instant, just before the first event at or
 * after it — which is the only way to model what production actually does between two log lines
 * (JOS-180 needed it: a hold has to be culled by the 1 s heartbeat BEFORE its wear-off arrives, or
 * the test proves the cull and the late join in one event and never shows they are two).
 *
 * `spellStats` comes back beside the snapshots because the LEARNER is the subject of some of these
 * tests and the snapshot only reports the SELF caster's rounded columns.
 */
export function replayBuffTimers(
  lines: string[],
  opts?: { until?: number; tickMs?: number; prime?: string[]; ticks?: number[] }
): { buffs: BuffsSnap; timers: BuffTimersSnap; rows: BuffTimerRow[]; spellStats: SpellStats } {
  const db = loadSpellDb()
  installSpellDb(db)
  const buffs = new BuffsModule(db)
  // ONE MODEL, TWO MODULES (JOS-140): the CC half folds through the buffs module's own cast
  // anchors and mints into its own learner, exactly as `modules/wiring.ts` wires it in production.
  // Constructing it bare would give it a private (and permanently empty) cast history, so no
  // landing would ever be anchored and every hold in this harness would silently vanish.
  const timers = new BuffTimersModule(buffs.castAnchors(), buffs.spellStats())
  buffs.reset()
  timers.reset()
  let seq = 0
  const pending = [...(opts?.ticks ?? [])].sort((a, b) => a - b)
  const feed = (raw: string): void => {
    const ev = parseEvent(raw, seq++)
    if (!ev) return
    if (opts?.until != null && ev.ts > opts.until) return
    while (pending.length > 0 && pending[0] <= ev.ts) {
      const at = pending.shift() as number
      buffs.onTick(at)
      timers.onTick(at)
    }
    buffs.onEvent(ev)
    timers.onEvent(ev)
  }
  for (const raw of opts?.prime ?? []) feed(raw)
  for (const raw of lines) feed(raw)
  if (opts?.tickMs != null) {
    buffs.onTick(opts.tickMs)
    timers.onTick(opts.tickMs)
  }
  const b = buffs.snapshot().state
  const t = timers.snapshot().state
  return { buffs: b, timers: t, rows: buildTimerRows(b, t), spellStats: buffs.spellStats() }
}

/** Parse an EQ timestamp out of a raw fixture line (ms epoch), or 0. */
export function tsOf(raw: string): number {
  const ev = parseEvent(raw, 0)
  return ev ? ev.ts : 0
}

/** The ts of the last parseable line in a fixture — a natural "observe now" instant. */
export function lastTs(lines: string[]): number {
  for (let i = lines.length - 1; i >= 0; i--) {
    const t = tsOf(lines[i])
    if (t > 0) return t
  }
  return 0
}

/** Find an active buff by (case-insensitive, rank-insensitive) spell name. */
export function findActive(snap: BuffsSnap, spellContains: string): BuffsSnap['active'][number] | undefined {
  const needle = spellContains.toLowerCase()
  return snap.active.find((a) => a.spell.toLowerCase().includes(needle))
}

/** All active spell names, lowercased — for "must NOT contain" assertions. */
export function activeNames(snap: BuffsSnap): string[] {
  return snap.active.map((a) => a.spell.toLowerCase())
}
