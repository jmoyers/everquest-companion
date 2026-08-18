// The chat event's SHAPE and its module ROW, in one place both the parser and the renderer import.
// It is out here rather than in logEvents.ts (the event) / types.ts (the module transport) because
// BOTH of those files are at their 400-code-line ceiling — the `kills.ts` / `classUnlocks.ts`
// precedent. logEvents.ts re-exports `ChatChannel` + `ChatEvent`, types.ts re-exports `ChatLine` /
// `ChatSnap` / `ChatDelta`, so every existing import site reads each name from the file it always
// did.
//
// PRIVACY — the load-bearing invariant. `ChatEvent.text` / `ChatLine.text` is a person's words, so
// it must never reach a path that leaves the machine. It doesn't: the bus's only off-machine tap is
// `noteEventKind(ev.kind, ev.ts)` (telemetry breadcrumbs — the STRING 'chat' and a timestamp, no
// payload, and the error-report path even drops the uncurated 'chat' kind), and the feedback slice
// + public fixtures work on RAW log lines through `scrubLines()`, which drops every one of these
// shapes. A ChatEvent is consumed by exactly two LOCAL sinks — the `chat` module (the in-app
// viewer) and `chatArchive.ts` (the on-disk save) — and a ChatLine crosses the main↔web boundary
// only over `module:delta` to the user's own window. Neither serializes anywhere but userData. Do
// NOT add a consumer that forwards `text` off the machine.

import type { LogEventBase } from './logEvents'

/**
 * A player CHAT line's channel. All player-only, because that is the whole trick: 'tell' (private,
 * either direction), 'group' (/g + /p), 'guild' (/gu), 'raid' (/rs — unverified in the reference
 * log, standard EQ wording, synthetic-tested), 'ooc', 'auction', 'shout' (also unverified /
 * synthetic-tested), 'say', and 'channel' (a custom channel with a slot, e.g. General:1).
 *
 * 'say' IS FIRST-PERSON ONLY. A whole-log sweep of eqlog_Jibblits_rivervale (176,296 lines) found
 * 65 third-party `<Name> says, '…'` lines against ~300 mob-speech `says` lines of the SAME shape
 * (`A rock golem says`), and single-proper-name NPCs (`Setikan says`) are indistinguishable from
 * players by shape alone — so third-party say is DROPPED and only `You say, '…'` (unambiguously the
 * tailed character) is captured. This is the line `shared/logScrub.ts` draws too, from the other
 * side. See src/main/log/parseChat.ts for the measured per-channel counts and the pet carve-out.
 */
export type ChatChannel = 'tell' | 'group' | 'guild' | 'raid' | 'ooc' | 'auction' | 'shout' | 'say' | 'channel'

/**
 * The ONE event whose payload is a person's WORDS — every other kind reads structure and throws the
 * words away. It exists so the app can do the two things logScrub was built to stop chat doing to a
 * PUBLIC artifact, but here on the LOCAL machine where the log already sits: SHOW it live and SAVE
 * it to a file that survives the game rotating its log.
 *
 * IT IS NOT PRODUCED BY THE SINGLE-EVENT PARSE CASCADE, and could not be: `<Name> tells the group,
 * '…'` is ALREADY a `group` event (parseGroup.ts consumes it as the roster's recovery signal), and
 * the cascade returns one event per line. Chat is cross-cutting, so it is matched by its own pass
 * (parseChat.ts) and emitted onto the same bus as an ADDITIONAL event claiming its own seq. Every
 * existing consumer switches on `ev.kind` and returns for kinds it does not know, so this is inert
 * to all of them.
 */
export interface ChatEvent extends LogEventBase {
  kind: 'chat'
  channel: ChatChannel
  /** The speaker, spelled as the log spelled it (world-model law 2). `'You'` when `self`. */
  from: string
  /** True when the tailed character SENT the line (`You tell …` / `You told …` / `You say …`). */
  self: boolean
  /** For a private tell the tailed character SENT: who they told. Undefined otherwise. */
  to?: string
  /** For `channel`: the channel's name-and-slot exactly as printed, e.g. `'General:1'`. */
  chan?: string
  /** The message. A person's WORDS — LOCAL-ONLY (see the header). */
  text: string
}

/**
 * One captured chat line, as the viewer and the on-disk archive both read it: a `ChatEvent` with
 * the two fields the viewer does not need dropped — `seq` (useModule tracks it on the delta
 * envelope) and `raw` (the whole log line; the viewer renders the parsed fields). Same append-only
 * shape as loot: a delta carries `appended`, a snapshot is the concatenation.
 */
export interface ChatLine {
  /** Epoch millis from the bracketed timestamp. */
  ts: number
  channel: ChatChannel
  /** The speaker as the log spelled it; `'You'` when `self`. */
  from: string
  /** True when the tailed character sent it. */
  self: boolean
  /** Private-tell target, when the tailed character sent the tell. */
  to?: string
  /** The custom channel's name-and-slot, e.g. `'General:1'`, for `channel:'channel'`. */
  chan?: string
  /** The message. LOCAL-ONLY. */
  text: string
}

/** Full history, oldest first. */
export type ChatSnap = ChatLine[]

/** Everything since the last flush; the renderer concats onto the snapshot. */
export interface ChatDelta {
  appended: ChatLine[]
}
