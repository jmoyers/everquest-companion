// alertsEarlyWarning.ts — the SCHEDULER behind an alert's early-warning offset (JOS-216).
//
// The offset itself, its bounds and the rule that picks which timer row a landing is tracked by are
// in `shared/earlyWarning.ts`; the user-facing meaning is on `AlertDef.earlyWarnSec`. THIS file is
// the state machine in between: it holds the warnings that are armed, advances them on the
// registry's 1-second heartbeat, and hands back the ones that have come due.
//
// ─────────────────────────────────────────────────────────────────────────────
// WHY AN ARM IS RESOLVED ON THE NEXT TICK AND NOT AT THE MATCH.
//
// The alerts module is registered BEFORE buffs and buffTimers (modules/wiring.ts), so at the
// instant a mez landing matches an alert, the row that landing produces DOES NOT EXIST YET — the
// two modules that build it have not folded the event. Looking the row up in `onEvent` would find
// the PREVIOUS state of the world every single time. So a match files an ARM REQUEST carrying what
// the landing was about, and the next heartbeat — by which point every module has folded the same
// event — resolves it against the projection. A resolution delay of up to a second is invisible on
// a warning measured in tens of seconds, and it is the only ordering in which the answer is right.
//
// A request that finds no row within {@link ARM_RESOLVE_WINDOW_MS} is DROPPED, silently and on
// purpose: it means the model states no countdown for that landing (an unresolved spell family, a
// duration nobody states, a debuff somebody else cast), and there is no honest end to count back
// from. Silence is world-model law 1 applied to a schedule.
//
// ─────────────────────────────────────────────────────────────────────────────
// AND WHY CANCELLATION IS "THE ROW IS GONE", RATHER THAN A LIST OF ENDINGS.
//
// A pending warning must not fire when the debuff already broke — the mob died, a nuke woke it, you
// zoned, someone dispelled it. Enumerating those endings here would be a second opinion about a
// question the timer model already answers, and it would drift from it (that is the two-models scar
// world-model law 4 is made of). Every one of them removes the row from `buildTimerRows`, so the
// cancellation rule is exactly one sentence: no row, no warning. It is also self-correcting for
// endings nobody has thought of yet.
//
// The deadline is RE-READ from the row on every tick for the same reason. The learner can raise an
// estimate mid-hold (a sample that beats the DB floor re-states every live bar), and a re-land moves
// the landing — a warning that had fixed its own deadline would be describing a countdown the app
// had already corrected.
//
// ─────────────────────────────────────────────────────────────────────────────
// AND WHY A BREAK-FAMILY DEF ARMS FROM THE ROW INSTEAD (JOS-235).
//
// Everything above describes a LANDING-triggered def, and it silences a break-triggered one
// outright: the arming event and the ending are the same line, so the arm resolves against a world
// the same event has already emptied and is dropped at ARM_RESOLVE_WINDOW_MS without a sound. The
// full argument, the kinds that count as a break and the shape of the hypothetical event a def's
// matcher is offered are in shared/earlyWarning.ts. What lives HERE is the second state machine it
// needs: `breaks`, filed per (def, row) from the rows themselves, fired at the row's estimated end
// minus the offset, kept after firing just long enough for `breakSpoken` to swallow the at-break
// firing it pre-empted, and retired by the same one-sentence cancellation as everything else —
// no row, no warning.

import { idKey } from '../log/parseCommon'
import {
  breakIdentityKeys,
  earlyWarnFireAt,
  earlyWarnRowFor,
  rowBreakIdentity,
  type EarlyWarnSubject
} from '../../shared/earlyWarning'
import type { BuffTimerRow } from '../../shared/buffTimers'
import type { LogEvent } from '../../shared/logEvents'
import type { FiredAlert } from '../../shared/types'

/**
 * How long an unresolved arm request keeps looking for its row.
 *
 * Generous by design and still short: the row it is waiting for is created by the SAME event that
 * armed it, so on the ordinary path it is already there on the first tick. Five seconds is the
 * slack for a heartbeat that was busy, not a window in which a row might still turn up.
 */
export const ARM_RESOLVE_WINDOW_MS = 5_000

/**
 * The most warnings held at once, across every alert.
 *
 * A BOUND, not a policy. One warning per landing per alert, and an AE mez plus a chain of adds can
 * legitimately arm a dozen; anything past this is a def matching something far broader than its
 * author meant. Oldest-armed is dropped first (insertion order), because it is the one closest to
 * having resolved or expired anyway.
 */
export const MAX_ARMED_WARNINGS = 200

/**
 * The separator in an armed warning's key — a NUL, which can appear in no alert id and in no row
 * id, so an alert can never collide with another alert's row.
 *
 * BUILT rather than written, because AGENTS.md's rule is that a NUL is never a raw byte in a source
 * file (git calls the file binary and diffs/blame/grep go dark). `cooldownKey` in modules/alerts.ts
 * spells the same character as an escape inside a template literal; this is the same value.
 */
const KEY_SEP = String.fromCharCode(0)

/** One armed warning as the caller files it: the firing it will make, and what to track it by. */
export interface EarlyWarnArm {
  /** The offset in seconds, already normalized (shared/earlyWarning.ts). */
  sec: number
  /** The cooldown clock this firing belongs to — computed from the ARMING event, spent at the fire. */
  cooldownKey: string
  /** Which landing this is, so the row can be found once the world has folded it. */
  subject: EarlyWarnSubject
  /** Event ts (ms) of the landing — the clock the resolve window is measured on. */
  ts: number
  /** The firing this warning will make, built at match time so it says what the LANDING matched. */
  fired: FiredAlert
}

/** A warning that has come due: the firing to make, and the clock to spend for it. */
export interface EarlyWarnDue {
  cooldownKey: string
  fired: FiredAlert
  /**
   * THE DEADLINE THIS WARNING IS EARLY OF (ms epoch) — the row's own estimated end, carried out
   * so a consumer can count down to it (JOS-378 banner cards).
   *
   * It is `fireAt + sec`, i.e. the projection this scheduler already resolved, and NOT
   * `now + sec`: the two differ whenever a deadline was already in the past when it was noticed
   * (the documented degradation for an offset longer than the debuff), and a countdown built on
   * the wrong one would print a number the world does not agree with.
   */
  dueAt: number
}

/** An arm that has found its row. `rowId` is the whole identity — its absence is the cancellation. */
interface Armed extends EarlyWarnArm {
  rowId: string
}

/**
 * WHAT A LANDING WAS ABOUT, from the event that carried it.
 *
 * The entity is read dynamically from `mob` (the CC/charm families) then `target` (the buff
 * families) — the same arbitrary-field access a `where` matcher has always done, because these are
 * fields of some LogEvent shapes and not others. `buffApply` spells a self-landing as the literal
 * string 'self', which is the model's own word for "the player" and is why it maps to no entity key
 * rather than to a mob called self.
 *
 * `spellNames` is handed in rather than derived here: the caller has already resolved which names
 * this event can answer to (JOS-84's candidate widening, modules/alerts.ts), and re-deriving them
 * would be a second copy of that rule.
 */
export function earlyWarnSubject(ev: LogEvent, spellNames: readonly string[]): EarlyWarnSubject {
  const r = ev as unknown as Record<string, unknown>
  let entity: string | undefined
  for (const field of ['mob', 'target']) {
    const v = r[field]
    if (typeof v !== 'string' || v.trim() === '') continue
    entity = v.trim().toLowerCase() === 'self' ? undefined : idKey(v)
    break
  }
  return { ...(entity ? { targetKey: entity } : {}), spellNames: [...spellNames] }
}

/**
 * WHAT A BREAK-FAMILY DEF IS WATCHING FOR (JOS-235) — one per enabled def with an offset whose
 * trigger is an ENDING (shared/earlyWarning.ts `breakTriggerKinds` decides which those are).
 *
 * `probe` is the def's own matcher, closed over by modules/alerts.ts: it is handed a live row and
 * answers with the firing this def would make for that row's break, or null. It lives on the
 * caller's side of this seam because matching an alert is the alerts module's job and there must
 * be exactly one implementation of it — see the fabrication note on `breakProbes`.
 */
export interface BreakWatcher {
  alertId: string
  /** The offset in seconds, already normalized. */
  sec: number
  probe: (row: BuffTimerRow) => { fired: FiredAlert; cooldownKey: string } | null
}

/** One landing being watched: which row, which landing of it, and whether the warning has spoken. */
interface BreakWatch {
  alertId: string
  rowId: string
  /** The row's `startedTs` when this watch was filed — a LATER one is a new landing, and re-arms. */
  landedTs: number
  sec: number
  cooldownKey: string
  fired: FiredAlert
  /** `<entity>|<spell family>` for every name this row answers to (shared/earlyWarning.ts). */
  identity: string[]
  /** True once the early warning has fired for this landing — the at-break firing is then spent. */
  spoken: boolean
}

/**
 * THE IDENTITY A BREAK EVENT CARRIES — the other half of `rowBreakIdentity`.
 *
 * The entity is read the same dynamic way `earlyWarnSubject` reads it (`mob` for the CC/charm
 * families, `target` for the buff ones), and 'self' is kept as the literal key rather than mapped
 * away, because a row on the player is exactly what it has to match.
 *
 * THE EVENT'S OWN `spell` IS READ HERE rather than taken from the caller's list, because the
 * caller's list is the SPEECH one (`firingSpell`'s per-kind table) and that table deliberately
 * claims only the kinds a spoken alert names a spell for — `uncharm` is not one of them, so a
 * charm break arrived with no name at all and no warning of it could ever have been matched to
 * its own break line. This question is not "what should the alert say", it is "which hold ended",
 * and every break sentence in the three families names it.
 */
export function breakEventIdentity(ev: LogEvent, spellNames: readonly string[]): string[] {
  const r = ev as unknown as Record<string, unknown>
  let entity = 'self'
  for (const field of ['mob', 'target']) {
    const v = r[field]
    if (typeof v !== 'string' || v.trim() === '') continue
    entity = v.trim().toLowerCase() === 'self' ? 'self' : idKey(v)
    break
  }
  const named = typeof r.spell === 'string' && r.spell.trim() !== '' ? [r.spell] : []
  return breakIdentityKeys(entity, [...named, ...spellNames])
}

/** The armed early warnings, advanced by the alerts module's heartbeat. */
export class EarlyWarnings {
  /** The timer projection, injected by the wiring. Empty until something hands over the real one. */
  private rows: () => readonly BuffTimerRow[] = () => []
  /** Arms still looking for their row (see the header on why this is not resolved at match time). */
  private pending: EarlyWarnArm[] = []
  /** Warnings tracking a live row, keyed by `<alertId>\0<rowId>` — one per alert per row. */
  private armed = new Map<string, Armed>()
  /**
   * BREAK-FAMILY watches (JOS-235), keyed the same way. Filed from the ROW APPEARING rather than
   * from an event, and kept after the warning speaks so the break line it pre-empted can be
   * suppressed — see `breakSpoken`.
   */
  private breaks = new Map<string, BreakWatch>()

  /** Where the timer rows come from (modules/wiring.ts hands over the real projection). */
  setRowSource(rows: () => readonly BuffTimerRow[]): void {
    this.rows = rows
  }

  reset(): void {
    this.pending = []
    this.armed = new Map()
    this.breaks = new Map()
  }

  /** True when nothing is waiting — the caller skips reading the projection entirely. */
  get idle(): boolean {
    return this.pending.length === 0 && this.armed.size === 0 && this.breaks.size === 0
  }

  /** File a warning for a landing that just matched an alert with an offset. */
  arm(req: EarlyWarnArm): void {
    this.pending.push(req)
    if (this.pending.length > MAX_ARMED_WARNINGS) this.pending.shift()
  }

  /**
   * Advance to `nowMs`: resolve what can be resolved, cancel what has ended, and hand back the
   * warnings that have come due. Reads the projection at most ONCE, and not at all when there is
   * nothing to do — which for the break family means "no def is watching", since those arm from
   * the rows themselves rather than from an event.
   */
  tick(nowMs: number, watchers: readonly BreakWatcher[] = []): EarlyWarnDue[] {
    if (this.idle && watchers.length === 0) return []
    const rows = this.rows()
    this.resolve(rows, nowMs)
    this.watchBreaks(rows, watchers, nowMs)
    return [...this.advance(rows, nowMs), ...this.advanceBreaks(rows, nowMs)]
  }

  /**
   * THE AT-BREAK FIRING FOR A LANDING THIS ALERT ALREADY WARNED ABOUT — true when it is spent.
   *
   * Called by the alerts module before a break-family def with an offset fires on its own trigger.
   * A watch is consumed by the break it pre-empted (one landing, one firing), so a RE-LAND on the
   * same mob arms and can warn again; and a break with no matching spoken watch — the mob broke
   * early, the def never armed, the app restarted — is not suppressed by anything, which is the
   * ticket's whole point: an early break is never silent.
   */
  breakSpoken(alertId: string, identity: readonly string[]): boolean {
    for (const [key, w] of this.breaks) {
      if (!w.spoken || w.alertId !== alertId) continue
      if (!w.identity.some((k) => identity.includes(k))) continue
      this.breaks.delete(key)
      return true
    }
    return false
  }

  /**
   * File a watch for every (def, live row) pair the def would announce the break of.
   *
   * A row is watched ONCE PER LANDING: `landedTs` is the row's own clock, so a re-mez (which moves
   * `startedTs` on the same row id) is a new landing and re-arms, while an unchanged row is left
   * exactly as it is — including after its warning has spoken, which is what stops a fired watch
   * from immediately re-arming and speaking again a second later.
   *
   * AND A DEADLINE ALREADY IN THE PAST NEVER ARMS. This is the one place the break family reads
   * differently from JOS-216's landing path, where an overlong offset fires at once (the landing is
   * a live event, so "as early as the spell allows" is the honest degradation). Here the arming is
   * the row's mere EXISTENCE: rows are rebuilt from history on every character load, so an
   * already-overdue row would announce a hold that ended months ago the instant the app started.
   * A warning whose moment has passed simply does not happen, and the break line still fires.
   */
  private watchBreaks(rows: readonly BuffTimerRow[], watchers: readonly BreakWatcher[], nowMs: number): void {
    const live = new Set(rows.map((r) => r.id))
    const watching = new Set(watchers.map((w) => w.alertId))
    // Drop what is no longer watchable: the row is gone (the hold ended, however it ended), or the
    // alert was deleted, disabled, or had its offset removed while a warning was pending.
    for (const [key, w] of this.breaks) {
      if (!live.has(w.rowId) || !watching.has(w.alertId)) this.breaks.delete(key)
    }
    for (const row of rows) {
      for (const w of watchers) this.watchRow(row, w, nowMs)
    }
  }

  /** One (def, row) pair — split out to keep `watchBreaks` under the depth ceiling. */
  private watchRow(row: BuffTimerRow, w: BreakWatcher, nowMs: number): void {
    const key = w.alertId + KEY_SEP + row.id
    const held = this.breaks.get(key)
    if (held && held.landedTs >= row.startedTs && held.sec === w.sec) return
    const at = earlyWarnFireAt(row, w.sec)
    if (at === undefined || at <= nowMs) return
    const hit = w.probe(row)
    if (!hit) return
    this.breaks.set(key, {
      alertId: w.alertId,
      rowId: row.id,
      landedTs: row.startedTs,
      sec: w.sec,
      cooldownKey: hit.cooldownKey,
      fired: hit.fired,
      identity: rowBreakIdentity(row),
      spoken: false
    })
    if (this.breaks.size > MAX_ARMED_WARNINGS) {
      const oldest = this.breaks.keys().next()
      if (!oldest.done) this.breaks.delete(oldest.value)
    }
  }

  /**
   * The break warnings that have come due. A watch is NOT deleted when it fires — it stays, marked
   * `spoken`, so the break line arriving at the end of that same hold can be suppressed against it.
   * `watchBreaks` retires it the moment the row goes.
   */
  private advanceBreaks(rows: readonly BuffTimerRow[], nowMs: number): EarlyWarnDue[] {
    const byId = new Map(rows.map((r) => [r.id, r]))
    const due: EarlyWarnDue[] = []
    for (const w of this.breaks.values()) {
      if (w.spoken) continue
      const row = byId.get(w.rowId)
      const at = row ? earlyWarnFireAt(row, w.sec) : undefined
      if (at === undefined || nowMs < at) continue
      w.spoken = true
      due.push({ cooldownKey: w.cooldownKey, fired: w.fired, dueAt: at + w.sec * 1000 })
    }
    return due
  }

  /** Turn arm requests into armed warnings, discarding the ones the model states no end for. */
  private resolve(rows: readonly BuffTimerRow[], nowMs: number): void {
    if (this.pending.length === 0) return
    const keep: EarlyWarnArm[] = []
    for (const p of this.pending) {
      const row = earlyWarnRowFor(rows, p.subject)
      if (!row) {
        if (nowMs - p.ts <= ARM_RESOLVE_WINDOW_MS) keep.push(p)
        continue
      }
      // Re-arming the same (alert, row) REPLACES: a fresh landing on a row already being watched is
      // the same warning moved, never a second one.
      // The separator is a NUL, SPELLED AS AN ESCAPE and never written as a raw byte (AGENTS.md):
      // a row id carries mob and spell names, so nothing printable is safe to split on. Same
      // reasoning — and the same character — as `cooldownKey` in modules/alerts.ts.
      this.armed.set(p.fired.alertId + KEY_SEP + row.id, { ...p, rowId: row.id })
      if (this.armed.size > MAX_ARMED_WARNINGS) {
        const oldest = this.armed.keys().next()
        if (!oldest.done) this.armed.delete(oldest.value)
      }
    }
    this.pending = keep
  }

  /**
   * Cancel the warnings whose row has gone, and collect the ones that are due.
   *
   * A deadline ALREADY IN THE PAST fires on this very tick, which is the honest degradation for an
   * offset longer than the debuff (warn 30 s early on a 24 s mez): the warning is as early as the
   * spell allows, rather than silently never arriving.
   */
  private advance(rows: readonly BuffTimerRow[], nowMs: number): EarlyWarnDue[] {
    const byId = new Map(rows.map((r) => [r.id, r]))
    const due: EarlyWarnDue[] = []
    for (const [key, a] of [...this.armed]) {
      const row = byId.get(a.rowId)
      // No row: the hold ended — a break line, a death, a zone, a cull. Nothing left to warn about.
      const at = row ? earlyWarnFireAt(row, a.sec) : undefined
      if (at === undefined) {
        this.armed.delete(key)
        continue
      }
      if (nowMs < at) continue
      this.armed.delete(key)
      due.push({ cooldownKey: a.cooldownKey, fired: a.fired, dueAt: at + a.sec * 1000 })
    }
    return due
  }
}
