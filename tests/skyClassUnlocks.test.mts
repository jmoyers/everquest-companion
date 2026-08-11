// SKY CLASS UNLOCKS (JOS-148) — the line, the ledger, and the rows the Sky tab draws from them.
//
// NOT to be confused with `tests/classUnlocks.test.mts`, which is about SKILL and DISCIPLINE
// unlock LEVELS out of classes.json. Different subject, hence the longer name: this file is about
// which CLASSES this character may run as a primary.
//
// One file for three layers because they are one subject: the parser rule that observes an
// unlock, the module that remembers it, and the pure derivation that composes it with the
// JOS-131 turn-in counts. No fixture and no DOM, so nothing here skips.
//
// EVERY LINE BELOW IS QUOTED VERBATIM from the owner's real log (the awaiting-sample law: no
// shape ships from imagination). The whole 1,461,881-line sweep found exactly ONE first-person
// unlock line and three third-person ones, and the reasoning those measurements support is in
// shared/logEvents.ts ClassUnlockEvent and features/posky/classUnlocks.ts. The short version, and
// the reason this feature is not just a turn-in counter:
//
//   * a 26-turn-in Sky circuit printed NOTHING about unlocking, and
//   * the one unlock line fired at level 11, in a dungeon, with zero Sky turn-ins behind it.
//
// So OBSERVED beats DERIVED, and the tests below pin that ordering in both directions.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { parseEvent } from '../src/main/log/parser'
import type { ClassUnlockEvent, LogEvent } from '../src/shared/logEvents'
import type { ClassUnlockRecord } from '../src/shared/types'
import { ClassUnlocksModule } from '../src/main/modules/classUnlocks'
import {
  classUnlockRows,
  orderClassUnlockRows,
  type ClassUnlockRow
} from '../src/renderer/src/features/posky/classUnlocks'

const LOG =
  'C:/Users/Public/Daybreak Game Company/Installed Games/EverQuest Legends/Logs/eqlog_Primitive_freeport.txt'

/** The owner's own unlock, verbatim (real line 198310). */
const SELF_UNLOCK =
  '[Tue Jul 28 15:51:40 2026] You have completed achievement: Primary Class Unlock - Paladin'
/** A stranger's, verbatim (real line 1350190) — the shape that must stay unknown. */
const OTHER_UNLOCK =
  '[Wed Aug 05 00:07:20 2026] Szzeth has completed achievement: Primary Class Unlock - Monk'

function parseOne(raw: string): LogEvent {
  const ev = parseEvent(raw, 0)
  assert.ok(ev, `line did not parse at all: ${raw}`)
  return ev
}

// ---------------------------------------------------------------------------
// THE LINE
// ---------------------------------------------------------------------------

test('the unlock achievement parses, carrying the class verbatim', () => {
  const ev = parseOne(SELF_UNLOCK)
  assert.equal(ev.kind, 'classUnlock')
  assert.equal((ev as ClassUnlockEvent).className, 'Paladin')
})

test('a stranger unlocking a class is not a fact about this character', () => {
  // Third person, same achievement, same grammar. It stays unknown DELIBERATELY: the only
  // consumer asks what THIS character may run, and the anchor at the start of the message is
  // what makes that refusal structural rather than a name check.
  assert.equal(parseOne(OTHER_UNLOCK).kind, 'unknown')
})

test('a chat line quoting the sentence can never reach the rule', () => {
  // The classifier sees the message with the timestamp prefix stripped, so anything a stranger
  // typed begins with the stranger's name. Shaped after the real chat lines about unlocks in the
  // owner's log (Vireki tells NewPlayers1:1, ... class unlock ...).
  const quoted =
    "[Wed Aug 05 00:07:20 2026] Vireki tells NewPlayers1:1, 'You have completed achievement: Primary Class Unlock - Monk'"
  assert.equal(parseOne(quoted).kind, 'unknown')
})

test('the other achievements are left alone rather than given an invented kind', () => {
  // Verbatim siblings from the same log. Nothing consumes them, so they stay unknown — a kind
  // with no consumer is a shape nobody has had to be right about.
  for (const raw of [
    '[Tue Jul 28 15:51:40 2026] You have completed achievement: Deity Unlock - Mithaniel Marr',
    '[Tue Jul 28 16:00:30 2026] You have successfully been granted your reward for: Race Unlock',
    '[Tue Jul 28 15:51:40 2026] You have completed achievement: Level 30'
  ]) {
    assert.equal(parseOne(raw).kind, 'unknown', raw)
  }
})

test('an unlock naming nothing unlocks nothing', () => {
  const blank = '[Tue Jul 28 15:51:40 2026] You have completed achievement: Primary Class Unlock - '
  assert.equal(parseOne(blank).kind, 'unknown')
})

// ---------------------------------------------------------------------------
// THE LEDGER
// ---------------------------------------------------------------------------

function fold(lines: string[]): ClassUnlocksModule {
  const mod = new ClassUnlocksModule()
  let seq = 0
  for (const raw of lines) {
    const ev = parseEvent(raw, seq++)
    if (ev) mod.onEvent(ev)
  }
  return mod
}

test('the module keeps the unlock, and the first sighting of it', () => {
  const mod = fold([SELF_UNLOCK, OTHER_UNLOCK, SELF_UNLOCK])
  const state = mod.snapshot().state
  assert.equal(state.length, 1, 'a re-read of the same line is not a second unlock')
  assert.equal(state[0].className, 'Paladin')
  assert.equal(state[0].ts, Date.parse('Jul 28 2026 15:51:40'))
})

test('the delta carries the unlock once and then has nothing to say', () => {
  const mod = fold([SELF_UNLOCK])
  const first = mod.flushDelta()
  assert.ok(first)
  assert.equal(first.delta.appended.length, 1)
  assert.equal(mod.flushDelta(), null)
})

test('the epoch boundary drops a dead character unlocks', () => {
  // Character rebirth reuses the same log file (epochDetector.ts), and an unlock belongs to the
  // character that earned it. Same refusal the turn-in ledger makes.
  const mod = fold([SELF_UNLOCK])
  mod.onEvent({ kind: 'epoch', seq: 99, ts: 0, raw: '', at: 0 })
  assert.deepEqual(mod.snapshot().state, [])
})

// ---------------------------------------------------------------------------
// THE ROWS
// ---------------------------------------------------------------------------

/** The part of a quest the derivation reads, and nothing else. */
function quest(className: string, name: string, turnIns: number): {
  className: string
  name: string
  turnIns: number
} {
  return { className, name, turnIns }
}

/** The derivation is structural over quests; this is the cast every call below shares. */
function rows(
  qs: { className: string; name: string; turnIns: number }[],
  observed: ClassUnlockRecord[] = []
): ClassUnlockRow[] {
  return classUnlockRows(qs as never, observed)
}

const byClass = (list: ClassUnlockRow[], name: string): ClassUnlockRow => {
  const r = list.find((x) => x.className === name)
  assert.ok(r, `no row for ${name}`)
  return r
}

test('N of M counts the tests turned in at least once, per class', () => {
  const list = rows([
    quest('Warrior', 'Warrior Test of Skill', 2),
    quest('Warrior', 'Warrior Test of Think', 1),
    quest('Warrior', 'Warrior Test of Bash', 0),
    quest('Bard', 'Bard Test of Tone', 0)
  ])
  const war = byClass(list, 'Warrior')
  assert.equal(war.turnedIn, 2, 'a second turn-in of the same test is not a second test')
  assert.equal(war.total, 3)
  assert.equal(war.remaining, 1)
  assert.equal(byClass(list, 'Bard').remaining, 1)
})

test('a complete set reads unlocked, and says the reading is ours', () => {
  const war = byClass(
    rows([quest('Warrior', 'Warrior Test of Skill', 1), quest('Warrior', 'Warrior Test of Bash', 3)]),
    'Warrior'
  )
  assert.equal(war.unlocked, true)
  assert.equal(war.source, 'derived')
  assert.equal(war.unlockedAt, undefined, 'a derived row has no instant to report')
})

test('THE OWNER PALADIN - a logged unlock outranks the turn-in count', () => {
  // His real case: unlocked at level 11, 2 of 4 tests turned in. A derived-only tab calls this
  // locked, which is the defect the observed source exists to prevent.
  const list = rows(
    [
      quest('Paladin', 'Paladin Test of Spirit', 1),
      quest('Paladin', 'Paladin Test of Sacrifice', 1),
      quest('Paladin', 'Paladin Test of Love', 0),
      quest('Paladin', 'Paladin Test of Compassion', 0)
    ],
    [{ ts: 1_700_000, className: 'Paladin' }]
  )
  const pal = byClass(list, 'Paladin')
  assert.equal(pal.unlocked, true)
  assert.equal(pal.source, 'observed')
  assert.equal(pal.unlockedAt, 1_700_000)
  assert.equal(pal.remaining, 2, 'the tests it still has are still work, and still say so')
})

test('the log class spelling is matched case-insensitively, and the catalog spelling is shown', () => {
  const list = rows([quest('Shadow Knight', 'Shadow Knight Test of Bash', 0)], [
    { ts: 1, className: 'shadow knight' }
  ])
  assert.equal(list[0].className, 'Shadow Knight')
  assert.equal(list[0].source, 'observed')
})

test('an observed class the Sky data has never heard of gets no row', () => {
  const list = rows([quest('Bard', 'Bard Test of Tone', 0)], [{ ts: 1, className: 'Doombringer' }])
  assert.deepEqual(list.map((r) => r.className), ['Bard'])
})

test('a class with no tests in the data never derives unlocked', () => {
  // Zero required quests is missing data about a class, not a finished one (law 1). Reachable
  // when every one of a class's quests has been ignored on the tab.
  assert.deepEqual(rows([]), [])
})

// ---------------------------------------------------------------------------
// THE ORDER
// ---------------------------------------------------------------------------

const NO_PINS = (): number => 0

test('fewest tests left first, ties by name', () => {
  const list = orderClassUnlockRows(
    rows([
      quest('Warrior', 'a', 0),
      quest('Bard', 'b', 1),
      quest('Cleric', 'c', 0),
      quest('Cleric', 'd', 0)
    ]),
    NO_PINS
  )
  // Bard 0 left, then Warrior (1) before Cleric (2).
  assert.deepEqual(list.map((r) => r.className), ['Bard', 'Warrior', 'Cleric'])
})

test('a starred class is pinned above the order, which JOS-146 permits here', () => {
  // The order subject is a COUNT OF QUESTS, a standing property — not an event — so the pin
  // composes with it legitimately. See classUnlocks.orderClassUnlockRows.
  const list = orderClassUnlockRows(
    rows([quest('Warrior', 'a', 0), quest('Bard', 'b', 1), quest('Cleric', 'c', 0)]),
    (r) => (r.className === 'Cleric' ? 1 : 0)
  )
  assert.equal(list[0].className, 'Cleric')
  assert.deepEqual(list.slice(1).map((r) => r.className), ['Bard', 'Warrior'])
})

test('the pinned group keeps the closest-first order inside it', () => {
  const list = orderClassUnlockRows(
    rows([
      quest('Warrior', 'a', 0),
      quest('Warrior', 'a2', 0),
      quest('Bard', 'b', 1),
      quest('Cleric', 'c', 0)
    ]),
    (r) => (r.className === 'Warrior' || r.className === 'Bard' ? 1 : 0)
  )
  assert.deepEqual(list.map((r) => r.className), ['Bard', 'Warrior', 'Cleric'])
})

// ---------------------------------------------------------------------------
// THE REAL LOG (guarded — CI has no game log; assertions are anchor-independent)
// ---------------------------------------------------------------------------

test('the real log yields only self unlocks, and only of classes that exist', { skip: !existsSync(LOG) && 'no game log here' }, () => {
  const unlocks: ClassUnlockEvent[] = []
  let family = 0
  let seq = 0
  // `\r?\n`, not `\n`: the game writes CRLF, and the parser's own line regex ends at `$` with no
  // multiline flag, so a trailing carriage return makes EVERY line fail to parse. That is the
  // Tailer's job in production (it splits on the real newline and hands over clean lines); a test
  // that split on `\n` alone would silently assert against 1.4M nulls.
  for (const raw of readFileSync(LOG, 'utf8').split(/\r?\n/)) {
    if (raw.includes('completed achievement')) family += 1
    const ev = parseEvent(raw, seq++)
    if (ev?.kind === 'classUnlock') unlocks.push(ev)
  }
  assert.ok(family > 100, 'the achievement family should be well populated')
  assert.ok(unlocks.length >= 1, 'the owner has at least his level-11 primary')
  // No frozen count (the log grows by append), but every one must be a real EQ class and none
  // may be a duplicate — the module dedupes, and a parser emitting the same class twice from two
  // different lines would mean the rule had widened onto something it should not claim.
  const names = unlocks.map((u) => u.className)
  assert.equal(new Set(names).size, names.length, `duplicate class unlocks: ${names.join(', ')}`)
  for (const n of names) assert.match(n, /^[A-Z][A-Za-z ]{2,20}$/, `implausible class name: ${n}`)
})
