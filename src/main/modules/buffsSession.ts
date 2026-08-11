// The buffs model's SESSION FRAME (see buffs.ts for the model this belongs to): the last instant
// the character was seen in the log, and the LOG-HOLE state machine built on it.
//
// It is the fourth collaborator beside buffsInstances / buffsStats / buffsEntities, and it holds
// exactly one question: a break in the event stream arrived — did the character LEAVE, or did we
// lose the thread? The two answers are not close together. A logout freezes every buff with the
// character and hands it back at login (BuffInstances.onOfflinePause has the measurement); a lost
// thread means whatever we believed was standing is stale and belongs in the bin.
//
// ─────────────────────────────────────────────────────────────────────────────
// WHY IT WAITS (JOS-134). A hole of SESSION_GAP_MS or more used to be read as a logout on the
// spot and every live instance was cleared. The trouble is one of ORDER: the hole is always
// observed before the thing that explains it. Every login prints a reconnect preamble first —
// 0-22 s of channel/adventure lines over all 19 logins in the real log (sessionDetector.ts) — so
// the first post-absence event tripped the hole, the wipe ran, and the derived `offlineGap` that
// measured the absence arrived moments later to pause a model with nothing left in it. The buff
// EQ had frozen with your character read as expired the instant you logged back in, which is the
// user-visible defect the ticket names.
//
// So a hole now OPENS A QUESTION and waits LOGIN_CONFIRM_MS of event time for the answer:
//
//   • `closeHole()` — a login explained it. The gap handler pauses the buffs by the absence the
//     detector measured, and nothing here has an opinion about that number. One authority beats
//     two constants that agree until they don't.
//   • the window elapses — UNEXPLAINED. `observe`/`tick` hand back the last-known-online instant
//     so the caller can drop what predates it, exactly as the old blanket clear did.
//
// The whole cost of waiting is that a stale row can sit there for up to half a minute on a
// surface that is about to be corrected either way. What it buys is a pause decided by evidence
// rather than by which line happened to arrive first.

import type { LogEvent } from '../../shared/logEvents'
import { LOGIN_CONFIRM_MS, SESSION_GAP_MS } from './buffsShapes'

export class SessionFrame {
  /** ts of the newest primary event folded so far (0 before the first). */
  private lastEventTs = 0
  /** Last instant seen before an OPEN hole, and the first event after it. Both 0 when none. */
  private fromTs = 0
  private atTs = 0

  reset(): void {
    this.lastEventTs = 0
    this.closeHole()
  }

  /**
   * The last-known-online instant of an OPEN hole, or 0. A BUFF older than this is exempt from
   * the hygiene sweep for as long as the hole is unexplained: if it turns out to be a logout,
   * that buff's clock is about to be rewound by the absence, and judging it against a `now` from
   * the far side would retire — a beat before the pause lands — the very buff the pause protects.
   */
  get heldBeforeTs(): number {
    return this.fromTs
  }

  /** A login (or a character rebirth) settled the question: close the hole with no casualties. */
  closeHole(): void {
    this.fromTs = 0
    this.atTs = 0
  }

  /**
   * Fold one primary event. Returns the last-known-online instant of a hole that has JUST been
   * ruled unexplained — the caller drops what predates it — or null.
   */
  observe(ev: LogEvent): number | null {
    if (this.lastEventTs > 0 && ev.ts - this.lastEventTs >= SESSION_GAP_MS) {
      this.fromTs = this.lastEventTs
      this.atTs = ev.ts
    }
    this.lastEventTs = ev.ts
    return this.expire(ev.ts)
  }

  /**
   * The wall-clock heartbeat, which is what runs out an open hole's clock on a log that goes
   * quiet right after one. `nowMs` is wall time and `atTs` is event time — the same clock for a
   * LIVE tail, and the heartbeat is stopped for the length of a replay, so a historical hole is
   * never ruled on by today's date.
   */
  tick(nowMs: number): number | null {
    return this.expire(nowMs)
  }

  private expire(now: number): number | null {
    if (this.atTs === 0 || now - this.atTs <= LOGIN_CONFIRM_MS) return null
    const from = this.fromTs
    this.closeHole()
    return from
  }
}
