// ============================================================================
// conCardServe.ts — THE CON CARD OPENS ON THE ENGINE'S FRAMES (JOS-496, boundary verdict 2).
// ============================================================================
//
// THE CENSUS FINDING THIS ENDS. `pipeline.ts` installed `considerModule.setConCardHook`, and every
// live `/con` therefore ran `main/conCard.ts noteConsider` INSIDE THE FOLD'S OWN DELIVERY — a
// catalog lookup, a resist profile over the whole ledger, and an overlay send, on the thread that
// was parsing the log. Verdict 2 inverts it: the engine emits a resolved `world.conCard` stream
// event and main only opens the window.
//
// This file is the "only opens the window" half's wiring, and it is deliberately the same shape
// `alertsAudio.ts` is for the other connection-wide frame the app acts on:
//
//   * `engineClientHost.ts` offers every frame and knows nothing about what happens to it;
//   * this file owns the GATE and the vocabulary translation;
//   * `main/conCard.ts` owns the WINDOW — the Preferences switch, the re-open suppression, the
//     card-on-screen bookkeeping and the second pass — and is what both worlds call.
//
// ── ONE PUBLISHER, AND THE SWAP IS STRUCTURAL RATHER THAN A RUNTIME BRANCH ─────────────────────
//
// Exactly one thing may draw a con card, and which one is decided ONCE, at registration:
// `registerConCardIpc` installs the TS hook only when the app is not being served, and this
// listener is only ever offered frames by a connection that exists because the engine is running.
// So there is no window in which both draw and none in which neither does — the same guarantee
// `alertsAudio.ts` makes for a sound, and it matters here for the same reason it does there: two
// cards for one `/con` is not a cosmetic bug, it is the feature visibly broken in the two seconds
// it exists for.
//
// ── THE GATE IS `shimServing()`, AND THERE IS NO FLAG OF ITS OWN ──────────────────────────────
//
// A sound got a third flag because a sound is not a read (`alertsAudio.ts`'s argument, unchanged).
// A CON CARD IS A READ — it is a window drawing state, and a wrong one is a wrong number on a panel
// somebody is looking at rather than a missed raid call — so it rides the flag that already means
// "the engine answers this app's reads". `EQC_ENGINE_SERVE=0` gives the card back to the TS hook and
// changes nothing else, which is exactly the bisection a developer wants from that variable.
//
// ── WHAT IS NOT CHECKED HERE, AND WHY THAT IS NOT LAXITY ──────────────────────────────────────
//
// No readiness test, no epoch, no turn number. A `conCard` frame is a thing that HAPPENED — the
// broadcast family's defining property (`shared/dataServer/broadcasts.ts`) — and there is nothing to
// reconcile and nothing to re-request. It is also, structurally, only ever produced by a LIVE fold
// (the engine's `ConsiderModule` pushes nothing during a historical scan), so a card cannot arrive
// out of a replay of a month of logs. The one identity question worth asking — is this still the
// connection this app is using — is asked by `engineClientHost.ts` for every broadcast it forwards.

import { logInfo } from '../errorLog'
import { noteEngineConCard, type ServedConCard } from '../conCard'
import type { ConCardMessage } from '../../shared/dataServer/protocol.generated'

/** Cards this launch has heard from the engine, and how many of them actually drew. Both are
 *  reported on the line, so a card that did not appear carries a number beside it rather than an
 *  absence — the shape `alertsAudio.ts` uses for a dropped fire. */
let heard = 0
let drawn = 0

/**
 * ONE CON CARD FROM THE ENGINE. Answers whether the overlay drew it, so the caller's log line can
 * say what happened.
 *
 * IT IS NEVER THE REASON A CONNECTION BREAKS. This runs inside the client's frame dispatch, where a
 * throw surfaces as a transport fault; every refusal below is a `false` and a line.
 *
 * `false` IS THE ORDINARY ANSWER, not an error, and it has three honest causes — the overlay is
 * turned off in Preferences, the card was closed inside the last minute, or (the double gate) the
 * name reads as a person. Only the count is kept for them; the dev log would otherwise narrate every
 * `/con` a player types with the overlay switched off.
 */
export async function openEngineConCard(card: ConCardMessage): Promise<boolean> {
  // NO SERVE GATE (JOS-499 item 9). It read two default-on env flags and answered a question the
  // FRAME already answers better: a con card exists only because a real connected engine sent one,
  // which is the thing `shimServing()` was a poor proxy for (see conCard.ts, where that exact
  // misreading shipped a silent card once).
  heard += 1
  // THE VOCABULARY TRANSLATION, WRITTEN OUT FIELD BY FIELD RATHER THAN SPREAD. The two shapes agree
  // today and a spread would compile — right up to the day the schema grows a field that means
  // something here and nobody finds out from the code. `serveShim.ts engineOpts` makes the same
  // choice for the same reason. The engine's `chips` and `spellData` are DELIBERATELY NOT CARRIED:
  // see `conCard.ts noteEngineConCard` for why the join is still app-side, and what has to land
  // before it is not.
  const served: ServedConCard = {
    id: card.id,
    at: card.at,
    name: card.name,
    ...(card.level === undefined ? {} : { level: card.level }),
    ...(card.zone === undefined ? {} : { zone: card.zone }),
    ...(card.rare === true ? { rare: true as const } : {})
  }
  // AWAITED SINCE JOS-497 item 1, and the await is one round trip for the creature's LEVEL. The
  // card used to read that out of this process's fold synchronously — the census's last such
  // reader — and now asks whichever world answers this app's reads. Nothing about the ordering
  // guarantees moves: `conCard.ts` still decides in one place whether the window opens, and the
  // queue identity is still `mobKey`, so a card that arrives while an older one is on screen
  // replaces it exactly as before.
  const ok = await noteEngineConCard(served)
  if (ok) drawn += 1
  return ok
}

/** One line for the dev log, written by the caller that offered the frame. Kept here so the counts
 *  and the sentence that quotes them cannot drift apart. */
export function conCardServeLine(card: ConCardMessage, drew: boolean): string {
  const level = card.level === undefined ? '' : ` (level ${String(card.level)})`
  return (
    `data-server conCard: ${card.name}${level} at ${String(card.at)} — ` +
    `${drew ? 'the overlay drew it' : 'not drawn (overlay closed, suppressed, or refused)'} ` +
    `(cards this launch: ${String(drawn)}/${String(heard)})`
  )
}

// NO `cardsDrawn()` ACCESSOR, and its absence is deliberate. The two counters exist to make the dev
// log's sentence self-explaining — a card that did not appear carries a number beside it rather than
// an absence — and nothing else asks. An exported reader with no caller is a surface somebody would
// eventually wire a panel to, and a con-card count is not a diagnostic anybody has asked for.

/** The dev log's voice for this file, matching every other `data-server` line. */
export function noteConCardServe(line: string): void {
  logInfo(`[everquest-companion] ${line}`)
}
