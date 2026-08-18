// ============================================================================
// parseChat.ts — the chat pass. NOT part of the single-event cascade (parser.ts).
// ============================================================================
//
// The cascade returns ONE event per line, and several chat lines are ALREADY something else to it:
// `<Name> tells the group, '…'` is a `group` event (parseGroup.ts's roster-recovery signal). Chat
// is cross-cutting — the SAME line is both a membership fact and a message — so it cannot ride the
// cascade, which is why this is a separate pass the feeders call alongside `parseEvent`, emitting
// an ADDITIONAL `chat` event onto the same bus. See the ChatEvent header in shared/logEvents.ts.
//
// WHAT THIS CAPTURES, and why exactly this set. Every directed/social channel whose speaker is
// UNAMBIGUOUSLY a player — the families `shared/logScrub.ts` enumerates — MINUS the one it cannot
// tell from a mob. A mob cannot /tell, /guildsay, /gsay, /rsay, /ooc, /auction or /shout, and its
// name is multi-word (`a rock golem`) so it fails the single-token NAME anyway; but a mob DOES
// `<Name> says, '…'`, and single-proper-name NPCs (`Setikan says`) are indistinguishable from
// players by shape. So third-party `say` is DROPPED and only the first-person `You say, '…'` is
// kept (unambiguously the tailed character). This is the same line logScrub draws, for the same
// reason, from the other side: it drops all of this to keep it out of a public artifact; we keep
// the player half to show and save it locally.
//
// MEASURED — whole-log sweep of eqlog_Jibblits_rivervale, 176,296 lines (the shapes below are the
// ones this log actually printed; `raid`/`shout` did not occur and are written from EQ's own
// wording of the channels present, tested from synthetic lines and LABELED, per the awaiting-sample
// law in AGENTS.md):
//
//   <Name> tells <Chan>:<n>, '…'      3468 + 2456   → channel  (General1:1, General:1)
//   <Name> tells the guild, '…'         270         → guild
//   <Name> tells the group, '…'          88         → group
//   You say to your guild, '…'           68         → guild  (self)
//   You tell your party, '…'             58         → group  (self)
//   You say, '…'                         31         → say    (self)
//   <Name> told <name>, '…'              29         → tell   (self, outbound; target may be typed lowercase)
//   <Name> tells you, '…'                26         → tell   (inbound)
//   You tell <Chan>:<n>, '…'              7         → channel (self)
//   <Name> says out of character, '…'     3         → ooc
//   <Name> auctions, '…'                  2         → auction
//
// THE PET FAMILIES ARE NOT AT RISK. logScrub carves out three NPC-pet shapes it must keep in a
// fixture (`<Pet> told you, 'Attacking … Master.'`, the six pet says, `<Pet> says, 'My leader is
// …'`). None can reach us: our inbound tell matches the PRESENT tense `tells you` (a player tell),
// never the pet-claim's `told you`; and we capture no third-party `says` at all, which is every
// other pet line. So no NPC line is ever saved as a person's chat, with no carve-out needed here.
//
// PERF. The whole pass is gated by ONE substring probe — a line with no `, '` is not chat and not
// anything else with quoted speech — so the 96% of lines that are combat/heal/loot pay a single
// `includes` and never reach a regex. This mirrors the cascade's own hot-path discipline.

import type { ChatChannel, ChatEvent } from '../../shared/logEvents'
import { parseLine } from './parser'

/** A player name subject: one token, with the backtick/apostrophe/hyphen EQ allows. Single-token
 *  on purpose (as in parseGroup.ts): a player's name never has a space, and the anchor keeps a mob
 *  name (`a rock golem`) or a quoted sentence from satisfying it. Case is not constrained — an
 *  outbound tell's target is printed however it was typed (`You told ahrima, …`). */
const NAME = "[A-Za-z][A-Za-z`'-]*"

/** A custom chat channel with a slot: a name then `:<digits>`, e.g. `General:1`, `General1:1`. The
 *  digit slot is what tells a channel apart from `tells you` / `tells the guild` — those can never
 *  match this, so channel order in the table is free. */
const CHAN = '[A-Za-z][A-Za-z0-9]*:[0-9]+'

/** The message runs to the LAST `'` on the line: EQ does not escape an apostrophe inside a
 *  message, so `'(.*)'$` greedily takes `don't` and leaves the true closing quote for the anchor. */
interface Shape {
  re: RegExp
  channel: ChatChannel
  self: boolean
  /** Pull `{ from, to, chan, text }` out of the match for this shape. */
  build: (m: RegExpMatchArray) => { from: string; to?: string; chan?: string; text: string }
}

// Inbound shapes NAME the speaker (capture 1). Outbound shapes are first-person (`from: 'You'`).
// Order is not load-bearing — every regex is anchored at both ends and the channel token's digit
// slot disjoins the one overlap — but the table reads inbound-then-outbound, grouped by channel.
const SHAPES: readonly Shape[] = [
  // ---- inbound (someone else) ----
  {
    re: new RegExp(`^(${NAME}) tells you, '(.*)'$`),
    channel: 'tell',
    self: false,
    build: (m) => ({ from: m[1], text: m[2] })
  },
  {
    re: new RegExp(`^(${NAME}) tells the guild, '(.*)'$`),
    channel: 'guild',
    self: false,
    build: (m) => ({ from: m[1], text: m[2] })
  },
  {
    re: new RegExp(`^(${NAME}) tells the group, '(.*)'$`),
    channel: 'group',
    self: false,
    build: (m) => ({ from: m[1], text: m[2] })
  },
  {
    // UNVERIFIED — absent from this log; standard EQ raid wording (see the header).
    re: new RegExp(`^(${NAME}) tells the raid, '(.*)'$`),
    channel: 'raid',
    self: false,
    build: (m) => ({ from: m[1], text: m[2] })
  },
  {
    re: new RegExp(`^(${NAME}) says out of character, '(.*)'$`),
    channel: 'ooc',
    self: false,
    build: (m) => ({ from: m[1], text: m[2] })
  },
  {
    re: new RegExp(`^(${NAME}) auctions, '(.*)'$`),
    channel: 'auction',
    self: false,
    build: (m) => ({ from: m[1], text: m[2] })
  },
  {
    // UNVERIFIED — absent from this log; standard EQ /shout wording.
    re: new RegExp(`^(${NAME}) shouts, '(.*)'$`),
    channel: 'shout',
    self: false,
    build: (m) => ({ from: m[1], text: m[2] })
  },
  {
    re: new RegExp(`^(${NAME}) tells (${CHAN}), '(.*)'$`),
    channel: 'channel',
    self: false,
    build: (m) => ({ from: m[1], chan: m[2], text: m[3] })
  },
  // ---- outbound (the tailed character) ----
  {
    re: new RegExp(`^You told (${NAME}), '(.*)'$`),
    channel: 'tell',
    self: true,
    build: (m) => ({ from: 'You', to: m[1], text: m[2] })
  },
  {
    re: /^You say to your guild, '(.*)'$/,
    channel: 'guild',
    self: true,
    build: (m) => ({ from: 'You', text: m[1] })
  },
  {
    re: /^You tell your party, '(.*)'$/,
    channel: 'group',
    self: true,
    build: (m) => ({ from: 'You', text: m[1] })
  },
  {
    // UNVERIFIED — standard EQ raid wording (see the header).
    re: /^You tell your raid, '(.*)'$/,
    channel: 'raid',
    self: true,
    build: (m) => ({ from: 'You', text: m[1] })
  },
  {
    re: /^You say out of character, '(.*)'$/,
    channel: 'ooc',
    self: true,
    build: (m) => ({ from: 'You', text: m[1] })
  },
  {
    re: /^You auction, '(.*)'$/,
    channel: 'auction',
    self: true,
    build: (m) => ({ from: 'You', text: m[1] })
  },
  {
    // UNVERIFIED — standard EQ /shout wording.
    re: /^You shout, '(.*)'$/,
    channel: 'shout',
    self: true,
    build: (m) => ({ from: 'You', text: m[1] })
  },
  {
    re: new RegExp(`^You tell (${CHAN}), '(.*)'$`),
    channel: 'channel',
    self: true,
    build: (m) => ({ from: 'You', chan: m[1], text: m[2] })
  },
  {
    // FIRST-PERSON SAY ONLY. Third-party `<Name> says, '…'` is deliberately absent — mob-ambiguous
    // (see the header). Anchored `^You say, '` so `You say to your guild,` / `You say out of
    // character,` (both begin `You say `) can never fall here.
    re: /^You say, '(.*)'$/,
    channel: 'say',
    self: true,
    build: (m) => ({ from: 'You', text: m[1] })
  }
]

/**
 * One line → a `chat` event, or null when the line is not player chat.
 *
 * `seq` is the bus sequence this additional event claims (the feeder increments its shared counter
 * for it exactly as it does for a primary event). Returns null cheaply for the overwhelming
 * majority of lines via the `, '` probe before `parseLine` (which reads the timestamp) runs.
 */
export function parseChat(raw: string, seq: number): ChatEvent | null {
  if (!raw.includes(", '")) return null
  const line = parseLine(raw)
  if (!line) return null
  const { ts, text } = line
  for (const s of SHAPES) {
    const m = s.re.exec(text)
    if (!m) continue
    const parts = s.build(m)
    return { kind: 'chat', channel: s.channel, self: s.self, ts, seq, raw, ...parts }
  }
  return null
}
