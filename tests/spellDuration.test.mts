// JOS-189 — THE DURATION THE WIKI STATED AND WE COULD NOT READ.
//
// THE REPORT: a shaman on 0.18.0 said the buffs window does not track Spirit of the Puma, and
// quoted the three lines that prove the messages are RIGHT — the cast, the landing
// (`You begin to snarl as your features become feline.`) and the fade (`The spirit of the puma
// departs.`). They are all in `spells.json`, verbatim, and the spell still drew nothing.
//
// THE DEFECT was one field away from the messages. `durationMs` is DERIVED from `durationText` by
// `parseDurationMs`, which lived inside `scripts/scrape-spells.ts` and therefore only ever ran when
// somebody re-scraped — so every duration string it could not read became a PERMANENT null in the
// committed catalog. `BuffInstances.applyMessageBuff` returns early for a landing with no duration
// and no illusion flag, so those spells could never open an instance at all. Spirit of the Puma's
// wiki duration is the three characters `60s`.
//
// MEASURED on the committed scrape: 88 rows in that state, in two families the reader had no case
// for — the SINGLE-LETTER units (`60s`, `24s`, `18s`, `12s`, `2h 24m`, `1m 36s`) and the CLOCK form
// (`0:06`, `0:30`, `40:00`, `1:12:00`, `6:00:00`, `0:00:24`, `2:24:00 (3:36:00)`). Two more say
// `Unlimited`, which is a real "no duration" and stays null.
//
// THREE THINGS ARE PINNED HERE:
//
//   1. THE READER, against the forms the committed file actually contains — including the ones it
//      already handled, so a change made for the new families cannot quietly move an old answer.
//   2. THE FILL IS A FILL. `fillDerivedDurations` may ADD a duration and may never change one, and
//      it is inert on a file a fixed scrape has already written. That is what makes it idempotent
//      in both directions, the property `spellCorrections.ts` is built around.
//   3. THE ACCEPTANCE: the reported defect, end to end, through the real parser and the real
//      unified model. The reporter's own cast/landing/fade cycle draws a bar and learns its length.
//
// WHERE THE BYTES COME FROM. The three Spirit of the Puma sentences are the DB's OWN
// `msgCastOnYou`/`msgWearsOff` text and the ordinary `You begin casting <Spell> <rank>.` shape every
// combat fixture carries, restamped — no reporter-slice bytes enter the tree (AGENTS.md). The
// owner's log has the third-person half of the same spell (`<X> growls with the spirit of the
// puma.`, 3 lines whole-log) but never the self half, because he is not a shaman.
//
// Run: `npm test`.

import test from 'node:test'
import assert from 'node:assert/strict'
import { parseEvent } from '../src/main/log/parser.ts'
import { installSpellDb } from '../src/main/log/rulesets.ts'
import { applyDerivedDurations, loadSpellDb } from '../src/main/data/spellDb.ts'
import { parseDurationMs } from '../src/shared/spellDuration.ts'
import { BuffsModule } from '../src/main/modules/buffs.ts'
import { BuffTimersModule } from '../src/main/modules/buffTimers.ts'
import { buildTimerRows } from '../src/shared/buffTimers.ts'
import type { SpellDbFile } from '../src/shared/types.ts'
import spellsJson from '../src/main/data/spells.json' with { type: 'json' }

const RAW = (spellsJson as SpellDbFile).spells

// ---------------------------------------------------------------------------------------------
// 1 — THE READER
// ---------------------------------------------------------------------------------------------

test('the reader still answers every form it already answered', () => {
  // The regression guard on the OLD families. The single letters were added at the END of the unit
  // alternation precisely so `2 Min 30 Sec` keeps matching `min`/`sec` and not `m`/`s`; without
  // that ordering this compound would read as 2 ms + 30 ms.
  assert.equal(parseDurationMs('27 minutes'), 1_620_000)
  assert.equal(parseDurationMs('16 Min'), 960_000)
  assert.equal(parseDurationMs('2 Min 30 Sec'), 150_000)
  assert.equal(parseDurationMs('1.5 hours'), 5_400_000)
  assert.equal(parseDurationMs('3 ticks'), 18_000)
  assert.equal(parseDurationMs('48 Sec'), 48_000)
  assert.equal(parseDurationMs('4.4 minutes @L44 to 6.0 minutes @L60'), 360_000, 'a formula takes the max')
  assert.equal(parseDurationMs('Instant'), null)
  assert.equal(parseDurationMs('Permanent'), null)
  assert.equal(parseDurationMs('4 per tick'), null, 'a regen rate is not a duration')
  assert.equal(parseDurationMs(undefined), null)
})

test('…and the two families it could not: single-letter units, and the clock', () => {
  assert.equal(parseDurationMs('60s'), 60_000, 'Spirit of the Puma — THE REPORTED DEFECT')
  assert.equal(parseDurationMs('24s'), 24_000)
  assert.equal(parseDurationMs('2h 24m'), 8_640_000, 'Form of the Bear')
  assert.equal(parseDurationMs('1m 36s'), 96_000, 'Instill, a root between Root`s 48 s and Fetter`s 3 min')

  // The clock, read by counting colons. Three fields are H:MM:SS and two are M:SS.
  assert.equal(parseDurationMs('0:06'), 6_000)
  assert.equal(parseDurationMs('0:30'), 30_000)
  assert.equal(parseDurationMs('40:00'), 2_400_000)
  assert.equal(parseDurationMs('1:12:00'), 4_320_000)
  assert.equal(parseDurationMs('6:00:00'), 21_600_000)
  assert.equal(parseDurationMs('0:00:24'), 24_000, 'Laceration writes the zero hours out in full')
  assert.equal(parseDurationMs('0:00:12'), 12_000, '…and so does Promised Renewal')
  assert.equal(
    parseDurationMs('2:24:00 (3:36:00)'),
    8_640_000,
    'the BASE, not the parenthesized extended figure: the DB number is a floor an observed cycle may raise'
  )
  assert.equal(parseDurationMs('Unlimited'), null, 'a real "no duration", and it stays one')
})

test('the clock reading agrees with the DB`s own words for the same span', () => {
  // The witness the reading rests on, as an assertion rather than a claim in a comment. Three rows
  // state 2h24m three different ways; read as H:MM:SS they agree, and read any other way they
  // contradict one another.
  const spans = ['2 hours 24 minutes', '2h 24m', '2:24:00 (3:36:00)'].map((t) => parseDurationMs(t))
  assert.deepEqual(spans, [8_640_000, 8_640_000, 8_640_000])
  assert.equal(RAW.find((s) => s.name === 'Form of the Great Bear')?.durationText, '2 hours 24 minutes')
  assert.equal(RAW.find((s) => s.name === 'Form of the Bear')?.durationText, '2h 24m')
})

// ---------------------------------------------------------------------------------------------
// 2 — THE FILL IS A FILL
// ---------------------------------------------------------------------------------------------

test('THE WHOLE BLAST RADIUS, by name: 87 nulls filled and ONE stated number corrected', () => {
  // The pass re-derives rather than merely filling, so this is the guard that says what that costs.
  // A change to the reader that moves a duration nobody asked it to move fails HERE, with the spell
  // and both numbers — which is the report needed to decide whether the move was intended.
  const { spells, report } = applyDerivedDurations(RAW)
  assert.equal(spells.length, RAW.length)
  assert.equal(report.filled, 87, 'the rows the old reader could not read at all')
  assert.deepEqual(
    report.corrected,
    [{ spell: 'Sicken', text: '1 min 24s', from: 60_000, to: 84_000 }],
    'the ONE stated number that moves: the old reader summed `1 min` and dropped the `24s` beside it'
  )
  // Nothing loses a duration it had. A reader that stopped understanding a form the scrape did read
  // would show up here rather than as a spell that quietly stopped drawing a bar.
  const lost = spells.filter((s, i) => RAW[i].durationMs != null && s.durationMs == null)
  assert.deepEqual(lost.map((s) => `${s.name}: ${s.durationText}`), [])
})

test('…and it is inert on a file the fixed scrape has already written', () => {
  // The re-scrape direction. Applying the pass twice is applying it once, so nothing about this
  // depends on WHEN the catalog was scraped.
  const once = applyDerivedDurations(RAW)
  const twice = applyDerivedDurations(once.spells)
  assert.equal(twice.report.filled, 0, 'nothing left to fill')
  assert.deepEqual(twice.report.corrected, [])
  assert.deepEqual(twice.spells, once.spells)
})

test('the pass never writes through the imported JSON module', () => {
  const before = RAW.find((s) => s.name === 'Spirit of the Puma')?.durationMs
  applyDerivedDurations(RAW)
  assert.equal(before, null, 'the committed scrape still says what the old reader wrote')
  assert.equal(RAW.find((s) => s.name === 'Spirit of the Puma')?.durationMs, null)
})

test('the loaded DB carries the filled durations, not the file`s nulls', () => {
  const db = loadSpellDb()
  assert.equal(db.byKey.get('spirit of the puma')?.durationMs, 60_000, 'THE REPORTED DEFECT, at the load seam')
  assert.equal(db.byKey.get('instill')?.durationMs, 96_000)
  assert.equal(db.byKey.get('laceration')?.durationMs, 24_000)
  assert.equal(db.byKey.get('form of the bear')?.durationMs, 8_640_000)
  assert.equal(db.byKey.get('infectious spores')?.durationMs, null, '`Unlimited` is still no duration at all')
})

// ---------------------------------------------------------------------------------------------
// 3 — THE ACCEPTANCE
// ---------------------------------------------------------------------------------------------

/** An EQ-stamped line at `sec` seconds past 12:47:00 — the real `[Day Mon DD HH:MM:SS YYYY] ` shape. */
function at(sec: number, text: string): string {
  const two = (n: number): string => String(n).padStart(2, '0')
  return `[Mon Aug 10 12:${two(47 + Math.floor(sec / 60))}:${two(sec % 60)} 2026] ${text}`
}

/** The `tests/spellCorrections.test.mts` harness: both modules, wired the way wiring.ts wires them. */
function replay(lines: [number, string][], observeSec: number) {
  const db = loadSpellDb()
  installSpellDb(db)
  const buffs = new BuffsModule(db)
  buffs.reset()
  const timers = new BuffTimersModule(buffs.castAnchors(), buffs.spellStats())
  timers.reset()
  let seq = 0
  for (const [sec, text] of lines) {
    const ev = parseEvent(at(sec, text), seq++)
    if (!ev) continue
    buffs.onEvent(ev)
    timers.onEvent(ev)
  }
  const tick = parseEvent(at(observeSec, 'x'), seq)?.ts ?? 0
  buffs.onTick(tick)
  timers.onTick(tick)
  const b = buffs.snapshot().state
  return { rows: buildTimerRows(b, timers.snapshot().state), active: b.active, stats: b.stats }
}

test('THE REPORTED DEFECT: a Spirit of the Puma cast plus its landing draws a bar', () => {
  const r = replay(
    [
      [0, 'You begin casting Spirit of the Puma VI.'],
      [2, 'You begin to snarl as your features become feline.']
    ],
    20
  )
  const row = r.rows.find((x) => x.name === 'Spirit of the Puma VI')
  assert.ok(row, `no Puma row: ${r.rows.map((x) => `${x.name}@${x.target ?? 'self'}`).join(', ') || '(none)'}`)
  assert.equal(row.kind, 'buff')
  assert.equal(row.mode, 'countdown', 'a bar with a duration, which is the whole report')
  assert.equal(row.durationMs, 60_000, 'the wiki`s `60s`, which nothing in the tree could read before')
  assert.ok(
    r.active.some((a) => a.spell === 'Spirit of the Puma VI'),
    `no held instance: ${r.active.map((a) => a.spell).join(', ') || '(none)'}`
  )
})

test('…and the fade closes the cycle, so the rank`s real length is learned', () => {
  // The reporter's own shape: rank VI runs far longer than the base rank's 60 s, and the estimator
  // treats the DB figure as a FLOOR a clean observed cycle may raise. Before the fill there was no
  // instance to close, so `n` could only ever be 0 — which is exactly what their Buffs tab said
  // ("no cast/wear off pair yet").
  const r = replay(
    [
      [0, 'You begin casting Spirit of the Puma VI.'],
      [2, 'You begin to snarl as your features become feline.'],
      [113, 'The spirit of the puma departs.']
    ],
    120
  )
  const stat = r.stats['spirit of the puma']
  assert.ok(stat, 'the line must reach the Buffs tab at all')
  assert.equal(stat.n, 1, 'one clean cast-to-fade cycle')
  assert.equal(stat.dbDurationMs, 60_000, 'the floor is the wiki`s 60 s')
  assert.equal(stat.medianMs, 111_000, 'and the observed cycle is the rank the reporter actually casts')
  assert.equal(stat.estimateMs, 111_000)
  assert.equal(stat.estimatorSource, 'observed')
})

test('…and with the wiki`s unread duration the same sequence opens nothing, which is the defect', () => {
  // The defect stated the way `spellCorrections.test.mts` states the Allure and Bravura pairs: the
  // fill is the only thing standing between this test and the two above. `applyMessageBuff` returns
  // early on `durationMs == null && !illusion`, so the landing produced no instance at all.
  const puma = RAW.find((s) => s.name === 'Spirit of the Puma')
  assert.ok(puma)
  assert.equal(puma.durationMs, null, 'the committed scrape states no duration')
  assert.equal(puma.durationText, '60s', 'even though the wiki states one')
  assert.equal(puma.msgCastOnYou, 'You begin to snarl as your features become feline.', 'the messages were never wrong')
  assert.equal(puma.msgWearsOff, 'The spirit of the puma departs.')
})
