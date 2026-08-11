// ============================================================================
// telemetry/optOut.ts — the switch flip, as a countable fact (JOS-109).
// ============================================================================
//
// THE PROBLEM THIS SOLVES, AND THE ONE IT CANNOT. The owner's question is "how many installs turn
// usage analytics off". Every other counter in this feature is written by a client that is ON, so
// the one action nobody could see was somebody leaving. A fully-dark install — opted out before
// its first batch ever left — is still invisible, and STRUCTURALLY so (`shared/telemetry.ts`
// argues that where the two events are declared). What this file makes exact is the other
// population: an install that ever reported, and then flipped the switch.
//
// THREE DECISIONS LIVE HERE, and each of them is a departure from how everything else in this
// directory works, so each is argued rather than asserted:
//
//   1. THE NOTICE DOES NOT GO THROUGH THE RING, and therefore not through `recordEvent`.
//      `recordEvent` is the ONE gate — "refuses when off" — and it stays untouched (its own
//      header now names this file as the single carve-out). The reason the notice cannot use it
//      is mechanical rather than stylistic: turning the switch off DROPS the ring and DISCARDS
//      the analyticsId in the same synchronous call (`collector.ts setTelemetryEnabled`), so an
//      event buffered a microsecond earlier would be deleted before any flush could carry it,
//      and a flush a microsecond later would have no envelope to put it in. So the notice is
//      built as its own COMPLETE single-event batch, from the prefs as they stand at the flip,
//      and handed to the transport directly.
//
//   2. IT IS SENT AFTER THE SWITCH IS ALREADY OFF, which is the carve-out that needs disclosing
//      rather than the one that needs defending. `telemetryFlushEnabled` requires `prefs.enabled`;
//      this send cannot, because the whole content of the message is that `enabled` just became
//      false. EVERY OTHER TERM OF THAT GATE STILL APPLIES — not under e2e, not without a compiled-
//      in endpoint, and NOT BEFORE THE FIRST-RUN NOTICE HAS RENDERED. That last one matters most:
//      it is what keeps "opt-out never means sent before you were told" true even for this event.
//      A user who declines at the first-run notice has SEEN the notice (`answerNotice` marks it
//      shown before it applies the switch), so their decline is countable; a user whose app
//      somehow flipped the switch before the notice ever rendered sends nothing at all.
//      TELEMETRY.md discloses the send in its "Turning it off" section, in words, before a user
//      could be surprised by it.
//
//   3. ONE SHOT, NO RETRY, NO PERSISTENCE. Every other send in this feature keeps its buffer for
//      the next tick when the network says "not now". This one cannot: retrying would mean
//      holding something to send after the user said stop, which is precisely what the switch is
//      for. So a flip made offline is LOST, `optOuts` is a FLOOR rather than a count, and the
//      panel labels it as one. Losing the measurement is strictly better than keeping the state.
//
// PURE, AND DELIBERATELY SO. No Electron, no store, no fetch — this module decides WHAT to send
// and WHETHER it may be sent, and `flush.ts` does the sending. That is what makes the whole
// mechanism pinnable by `tests/telemetryOptOut.test.mts` under plain tsx, including the property
// the acceptance criteria are actually about: exactly one notice per flip, and silence after.

import {
  TELEMETRY_API_VERSION,
  type TelemetryBatch,
  type TelemetryEnvelope,
  type TelemetryFlipKind,
  type TelemetryPrefs
} from '../../shared/telemetry'

/**
 * WHICH NOTICE, IF ANY, THIS CALL OF THE SWITCH OWES — and this function IS the "exactly once per
 * flip" property, which is why it is a named predicate rather than an `if` inside the caller.
 *
 * A FLIP IS AN EDGE, NOT A STATE. Setting the switch to the value it already holds is not a flip
 * and emits nothing: the Preferences toggle, the first-run notice and any future caller all funnel
 * through `applyTelemetryEnabled`, and more than one of them can legitimately apply `true` to an
 * install that is already on (answering the notice with "keep it" is exactly that). Counting those
 * would turn "how many people left" into "how many times the switch was written".
 *
 * FLIP-FLAP IS COUNTED HONESTLY, not de-duplicated. Off, on, off again is two `optOut`s and one
 * `optIn`, because that is what the user did. Collapsing it would be a guess at intent.
 */
export function flipNoticeKind(was: boolean, now: boolean): TelemetryFlipKind | null {
  if (was === now) return null
  return now ? 'optIn' : 'optOut'
}

/**
 * The complete batch one flip produces: ONE record, carrying ONE fieldless event.
 *
 * `env` is passed in rather than read, because WHEN it is read is the entire correctness argument
 * and the caller is the only place that knows the ordering. For `optOut` it must be the envelope
 * as it stood BEFORE the switch was applied (the id is about to be destroyed); for `optIn` it must
 * be the one AFTER (the id is minted by the switch). A function that read the prefs itself would
 * be right exactly half the time.
 */
export function flipNoticeBatch(
  kind: TelemetryFlipKind,
  env: TelemetryEnvelope,
  nowMs: number
): TelemetryBatch {
  return { v: TELEMETRY_API_VERSION, env, events: [{ ts: nowMs, ev: { t: kind } }] }
}

/**
 * May the flip notice be sent? `telemetryFlushEnabled` MINUS the `enabled` term, and nothing else
 * — decision 2 in the header says why that one term has to go and why the other three stay.
 *
 * It is written as its own predicate rather than as `telemetryFlushEnabled(...) || isOptOut` for
 * the reason net.ts gives for keeping the gates pure and separate: a network gate expressed twice
 * is a network gate that drifts. Both are pinned side by side in `tests/telemetryNet.test.mts`.
 */
export function telemetryFlipNoticeEnabled(
  e2e: boolean,
  endpoint: string,
  prefs: TelemetryPrefs
): boolean {
  return !e2e && endpoint.length > 0 && prefs.noticeShown
}
