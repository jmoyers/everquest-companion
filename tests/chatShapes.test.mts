// CHAT PARSING — the player-chat pass beside the cascade (src/main/log/parseChat.ts).
//
// THE FIXTURES ARE SYNTHETIC, and that is a privacy requirement, not a shortcut. Every other
// parse test replays hand-cut windows of the real log; a chat fixture cannot, because a committed
// fixture goes to a PUBLIC repo and `shared/logScrub.ts` exists precisely to keep a person's words
// out of one. So the lines below are invented — real SHAPES, fake words and names — which is also
// why raid/shout (absent from the reference log) can be pinned here at all.
//
// The one test that touches the real log is guarded on it existing (CI has no game log) and
// asserts FLOORS, never today's counts — the log grows by append. It is the guard that proves the
// two things the header of parseChat.ts promises: enough real player chat is caught, and NO mob
// `says` line is ever caught as a person's chat.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { parseChat } from '../src/main/log/parseChat'
import type { ChatChannel, ChatEvent } from '../src/shared/logEvents'

/** A plausible EQ Legends timestamp — the shape parseLine strips. The exact instant is irrelevant. */
const STAMP = '[Wed Aug 13 21:00:00 2025]'
const line = (body: string): string => `${STAMP} ${body}`

/** parseChat with a throwaway seq — the tests care about the payload, not the number. */
const chat = (body: string): ChatEvent | null => parseChat(line(body), 1)

test('inbound channels name the speaker and carry the message', () => {
  const cases: [string, Partial<ChatEvent> & { channel: ChatChannel }][] = [
    ["Frikniller tells you, 'hey there'", { channel: 'tell', from: 'Frikniller', self: false, text: 'hey there' }],
    ["Grimtooth tells the guild, 'inc named'", { channel: 'guild', from: 'Grimtooth', self: false, text: 'inc named' }],
    ["Bortho tells the group, 'pull left'", { channel: 'group', from: 'Bortho', self: false, text: 'pull left' }],
    ["Ander says out of character, 'lol'", { channel: 'ooc', from: 'Ander', self: false, text: 'lol' }],
    ["Cidwin auctions, 'wts fine steel'", { channel: 'auction', from: 'Cidwin', self: false, text: 'wts fine steel' }],
    // UNVERIFIED shapes (absent from the reference log) — pinned from EQ's own wording.
    ["Xandor tells the raid, 'assist me'", { channel: 'raid', from: 'Xandor', self: false, text: 'assist me' }],
    ["Xandor shouts, 'zone is up'", { channel: 'shout', from: 'Xandor', self: false, text: 'zone is up' }]
  ]
  for (const [body, want] of cases) {
    const ev = chat(body)
    assert.ok(ev, `expected chat for: ${body}`)
    for (const [k, v] of Object.entries(want)) assert.equal((ev as never)[k], v, `${body} → ${k}`)
    assert.equal(ev.to, undefined)
    assert.equal(ev.chan, undefined)
  }
})

test('custom channels capture the name-and-slot in chan', () => {
  for (const name of ['General:1', 'General1:1']) {
    const ev = chat(`Zeek tells ${name}, 'wtb spell'`)
    assert.ok(ev)
    assert.equal(ev.channel, 'channel')
    assert.equal(ev.from, 'Zeek')
    assert.equal(ev.self, false)
    assert.equal(ev.chan, name)
    assert.equal(ev.text, 'wtb spell')
  }
})

test('outbound lines are first-person and carry the tell target', () => {
  const tell = chat("You told Frikniller, 'hi back'")
  assert.deepEqual(
    tell && { c: tell.channel, self: tell.self, to: tell.to, text: tell.text },
    { c: 'tell', self: true, to: 'Frikniller', text: 'hi back' }
  )
  // A tell target is printed however it was typed — lowercase included.
  assert.equal(chat("You told ahrima, 'yo'")?.to, 'ahrima')

  const outbound: [string, ChatChannel][] = [
    ["You say to your guild, 'omw'", 'guild'],
    ["You tell your party, 'oom'", 'group'],
    ["You tell General:1, 'anyone selling?'", 'channel'],
    ["You say out of character, 'gg'", 'ooc'],
    ["You auction, 'wts loot'", 'auction'],
    ["You tell your raid, 'incoming'", 'raid'],
    ["You shout, 'help in zone'", 'shout'],
    ["You say, 'hello zone'", 'say']
  ]
  for (const [body, channel] of outbound) {
    const ev = chat(body)
    assert.ok(ev, `expected chat for: ${body}`)
    assert.equal(ev.channel, channel, body)
    assert.equal(ev.self, true, body)
    assert.equal(ev.from, 'You', body)
  }
})

test('an apostrophe inside the message is kept (greedy to the true closing quote)', () => {
  assert.equal(chat("Ander says out of character, 'don't go'")?.text, "don't go")
  assert.equal(chat("You say, 'that's mine'")?.text, "that's mine")
})

test('an empty message parses to empty text, not to null', () => {
  const ev = chat("Bortho tells the group, ''")
  assert.ok(ev)
  assert.equal(ev.text, '')
})

test('a group tell is chat even though the cascade also reads it as a roster signal', () => {
  // The whole reason chat rides its own pass: parseGroup consumes this same line as `group`. Here
  // it must ALSO yield a chat event — that is what makes group chat saveable.
  const ev = chat("Bortho tells the group, 'oom, need a sec'")
  assert.equal(ev?.channel, 'group')
  assert.equal(ev?.text, 'oom, need a sec')
})

test('non-player speech and non-chat lines are refused', () => {
  const refused = [
    "A rock golem says, 'Die, intruder!'", // mob say (multi-word name)
    "Setikan says, 'greetings'", // third-party /say — mob-ambiguous, deliberately dropped
    "Bortho says, 'anyone home'", // ditto, even a clean single-word name
    "Vebarn told you, 'Attacking a rat Master.'", // pet-claim tell (told you, not tells you)
    "Jaber says, 'My leader is Primitive.'", // pet-leader say (a third-party says)
    'You have entered the Plane of Sky.', // no quoted speech at all
    'Frikniller hits a rat for 12 points of damage.' // combat, not chat
  ]
  for (const body of refused) assert.equal(chat(body), null, `should refuse: ${body}`)
})

// ---------------------------------------------------------------------------
// The real-log guard. Only runs where the reference log exists (never CI). Floors, not counts.
// ---------------------------------------------------------------------------
const REF_LOG =
  'C:/Users/Public/Daybreak Game Company/Installed Games/EverQuest Legends/Logs/eqlog_Jibblits_rivervale.txt'

test('over the real log: enough player chat, and no mob speech, is captured', { skip: !existsSync(REF_LOG) }, () => {
  // Split on CRLF too: the feeders hand parseChat a `\r`-stripped line (see LogEventBase.raw), so
  // the test must strip it as well, or the `'$` anchor never sees the closing quote as last.
  const lines = readFileSync(REF_LOG, 'utf8').split(/\r?\n/)
  const byChannel = new Map<ChatChannel, number>()
  let seq = 0
  for (const raw of lines) {
    const ev = parseChat(raw, seq++)
    if (!ev) continue
    byChannel.set(ev.channel, (byChannel.get(ev.channel) ?? 0) + 1)
    // NO third-party `say` is ever captured (the mob-ambiguity rule): every `say` is the player's.
    if (ev.channel === 'say') assert.equal(ev.self, true, `third-party say leaked: ${ev.raw}`)
    // NO captured speaker is a multi-word mob name (`a rock golem`): a player's name is one token.
    if (!ev.self) assert.ok(!/\s/.test(ev.from), `multi-word speaker leaked: ${ev.raw}`)
  }
  // Floors from the measured sweep (channel 5924, guild 338, group 146, tell 55, say 31); halved-ish
  // so an appended log only ever pushes them up.
  const floor: [ChatChannel, number][] = [
    ['channel', 5000],
    ['guild', 250],
    ['group', 120],
    ['tell', 40],
    ['say', 20]
  ]
  for (const [c, n] of floor) {
    assert.ok((byChannel.get(c) ?? 0) >= n, `channel ${c}: ${byChannel.get(c) ?? 0} < floor ${n}`)
  }
})
