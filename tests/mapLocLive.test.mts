// AUTO-`/loc` (JOS-98 wave 2) — the log DOES carry your position, and the marker moves itself.
//
// Wave 1's whole premise was that `Your Location is …` is never written to the log; that was a
// measurement of a character who never ran /loc while logging, not a client limitation. The sibling
// `eqlog_Arcc_freeport.txt` carries the line verbatim:
//
//   [Thu Aug 20 02:02:10 2026] Your Location is 1467.76, 1141.96, 164.72
//
// So this suite pins the two halves that make the marker follow you: the PARSER claims the line as a
// `loc` event (and refuses to claim a chat line quoting it), and the CHARACTER MODULE carries the
// last LIVE reading — cleared the instant you zone, and never set from the historical replay.
//
// Pure node: the real parser, the real module, no Electron and no DOM — so it never skips. The
// renderer half (silent placement, the drawn-zone guard) is the map-loc e2e's job.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseEvent } from '../src/main/log/parser'
import { CharacterModule } from '../src/main/modules/character'
import type { LogEvent, LocEvent } from '../src/shared/logEvents'

/** A real log line with the game's bracketed stamp, as the tailer hands it over. */
const LINE = '[Thu Aug 20 02:02:10 2026] Your Location is 1467.76, 1141.96, 164.72'

// ---- the parser claims the line, in the game's own order ----------------------------------

test('parseEvent reads a /loc line into a loc event — NORTH/SOUTH first, then west/east', () => {
  const ev = parseEvent(LINE, 7)
  assert.ok(ev, 'the line parses')
  assert.equal(ev.kind, 'loc')
  const loc = (ev as LocEvent).loc
  assert.deepEqual(loc, { ns: 1467.76, ew: 1141.96, z: 164.72 })
  // seq is stamped by the feeder, ts off the bracket.
  assert.equal(ev.seq, 7)
})

test('parseEvent takes the negative and no-decimal shapes the game prints', () => {
  const neg = parseEvent('[Thu Aug 20 02:02:29 2026] Your Location is 1151.08, -2382.86, 280.01', 0)
  assert.deepEqual((neg as LocEvent).loc, { ns: 1151.08, ew: -2382.86, z: 280.01 })
  const whole = parseEvent('[Thu Aug 20 02:02:29 2026] Your Location is 155, -411, 15', 0)
  assert.deepEqual((whole as LocEvent).loc, { ns: 155, ew: -411, z: 15 })
})

test('a chat line QUOTING the sentence is not a loc — the stamp is stripped, the name is not', () => {
  // The classifier sees the message with `[timestamp] ` gone; a say/tell begins with the speaker's
  // name, so it can never look like the anchored `Your Location is …`.
  const chat = parseEvent(`[Thu Aug 20 02:02:29 2026] Bob says, 'Your Location is 1, 2, 3'`, 0)
  assert.notEqual(chat?.kind, 'loc')
  // Prose after the numbers is refused too — three numbers is the whole shape, not a prefix of one.
  const trailing = parseEvent('[Thu Aug 20 02:02:29 2026] Your Location is 1, 2, 3 near the ruins', 0)
  assert.notEqual(trailing?.kind, 'loc')
})

// ---- the character module carries the last LIVE reading -------------------------------------

const loc = (ns: number, ew: number, z: number, seq: number): LogEvent =>
  ({ kind: 'loc', seq, ts: seq * 1000, raw: '', loc: { ns, ew, z } })
const zone = (name: string, seq: number): LogEvent =>
  ({ kind: 'zone', seq, ts: seq * 1000, raw: '', zone: name })

test('a LIVE /loc lands in the snapshot and is pushed as a delta', () => {
  const mod = new CharacterModule()
  mod.reset()
  mod.onEvent(zone('East Freeport', 1), true)
  mod.flushDelta()
  mod.onEvent(loc(1467.76, 1141.96, 164.72, 2), true)
  const d = mod.flushDelta()
  assert.ok(d, 'the reading is news')
  assert.deepEqual(d.delta.loc, { ns: 1467.76, ew: 1141.96, z: 164.72 })
  assert.deepEqual(mod.snapshot().state.loc, { ns: 1467.76, ew: 1141.96, z: 164.72 })
})

test('a REPLAYED /loc (live:false) is ignored — a days-old reading must not place a marker on launch', () => {
  const mod = new CharacterModule()
  mod.reset()
  mod.onEvent(zone('East Freeport', 1)) // replay: live defaults false
  mod.onEvent(loc(1, 2, 3, 2)) // replay
  // The zone still folds (modules accumulate during replay — the registry gates the PUSH, not the
  // fold). What must NOT fold from history is the position: the marker is a live-only effect.
  assert.equal(mod.snapshot().state.loc, undefined, 'no loc folded from history')
  const d = mod.flushDelta()
  assert.equal(d?.delta.loc, undefined, 'and no loc reaches a delta')
  assert.ok(d == null || !('loc' in d.delta), 'the loc key never appears from a replayed reading')
})

test('zoning RETIRES the reading — the loc you took in one zone cannot land on the next', () => {
  const mod = new CharacterModule()
  mod.reset()
  mod.onEvent(zone('East Freeport', 1), true)
  mod.onEvent(loc(613, 51, 0, 2), true)
  mod.flushDelta()
  mod.onEvent(zone('West Commonlands', 3), true)
  const d = mod.flushDelta()
  assert.ok(d, 'the zone change is a delta')
  assert.equal(d.delta.zone, 'West Commonlands')
  // The clear is `loc: undefined` in the delta — "nothing to place now", not "erase the marker".
  assert.ok('loc' in d.delta, 'the delta explicitly clears the transient loc')
  assert.equal(d.delta.loc, undefined)
  assert.equal(mod.snapshot().state.loc, undefined)
})

test('reset and epoch both drop the reading', () => {
  const mod = new CharacterModule()
  mod.reset()
  mod.onEvent(zone('East Freeport', 1), true)
  mod.onEvent(loc(1, 2, 3, 2), true)
  mod.onEvent({ kind: 'epoch', seq: 3, ts: 3000, raw: '', reason: 'launch' }, true)
  assert.equal(mod.snapshot().state.loc, undefined, 'epoch (rebirth) clears it')

  mod.onEvent(loc(4, 5, 6, 4), true)
  assert.deepEqual(mod.snapshot().state.loc, { ns: 4, ew: 5, z: 6 })
  mod.reset()
  assert.equal(mod.snapshot().state.loc, undefined, 'reset clears it')
})
