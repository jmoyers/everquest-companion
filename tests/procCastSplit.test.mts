// THE CAST / PROC SPLIT (JOS-167) — two real windows and one synthetic arrangement.
//
// THE DEFECT, in the owner's words: a cleric spams Banish Undead while a weapon procs the same
// effect, the meter files both under one source, and the proc rate is unknowable without
// deliberately not casting. The owner's discriminator is law: a real cast has a corresponding
// `You begin casting …` line preceding the landing; a proc lands with no cast line.
//
// IT IS NOT HYPOTHETICAL AND IT DID NOT NEED INVENTING. `Discordant Mind` is this character's
// gem-1 nuke AND what the `spellblade` invocation fires cast-lessly — 739 cast lines against
// 1,132 landings across the whole log. `w59-proc-cast-split.log` is the tightest span carrying
// both shapes, and it carries them in two consecutive fights so the same fixture answers all
// three of the acceptance questions:
//
//   e1  Ashenbone Broodmaster   MIXED     4 cast-less firings, then 11 cast/landing pairs
//   e2  Magi P`tasa             PROC-ONLY 6 firings, not one cast line in the fight
//   w60 a bloodthirsty ghoul    CAST-ONLY one Anarchy cast that was INTERRUPTED and recovered
//
// EVERY NUMBER BELOW WAS HAND-READ off the fixture with grep and the clock before the engine
// was asked. The four cast-less firings are 449 + 449 + 98 + 507 = 1,503 at 13:59:50, 14:00:07,
// :11 and :16 — the previous `You begin casting Discordant Mind II.` in the log is at 13:54:50,
// five minutes earlier. The eleven casts are 1,234 (Critical) + 507 + 227 + 462 + 71 + 476 +
// 515 + 484 + 511 + 471 + 449 = 5,407, each landing one second after its own cast line.
//
// THE TRIPWIRE IS THE POINT OF THE LAST TEST (law 8). A split is a re-KEYING inside one
// category, so the spell category total, the source total and the fight total may not move by a
// point: before this change the single `Discordant Mind` row read 9,324 over 21 hits, and the
// two rows still sum to exactly that.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { parseEvent } from '../src/main/log/parser'
import { installSpellDb } from '../src/main/log/rulesets'
import { CombatEngine } from '../src/main/combat/engine'
import type { SegmentView, SkillView, SourceView } from '../src/shared/combat'

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), 'fixtures')

function fixture(name: string): string[] {
  const p = join(FIXTURES, name)
  return existsSync(p) ? readFileSync(p, 'utf8').split(/\r?\n/).filter((l) => l.length > 0) : []
}

const W59 = fixture('w59-proc-cast-split.log')
const W60 = fixture('w60-cast-interrupt-recovery.log')
const missing = (...w: string[][]): string | false =>
  w.some((f) => f.length === 0) ? 'fixture not present' : false

/** Replay through the REAL parser + engine — the whole path a live tail takes. */
function replay(lines: string[]): { eng: CombatEngine; lastTs: number } {
  installSpellDb(undefined)
  const eng = new CombatEngine()
  let seq = 0
  let lastTs = 0
  for (const raw of lines) {
    const ev = parseEvent(raw, seq++)
    if (ev) {
      lastTs = ev.ts
      eng.ingestEvent(ev, false)
    }
  }
  return { eng, lastTs }
}

/** The `You` row of one segment. */
function you(eng: CombatEngine, lastTs: number, id: string): SourceView {
  const seg = eng.snapshot(lastTs, { selectedId: id }).selected
  assert.ok(seg, `segment ${id} resolves`)
  const row = seg.entities.find((e) => e.id === 'you')
  assert.ok(row, `${id} has a You row`)
  return row
}

function segmentOf(eng: CombatEngine, lastTs: number, id: string): SegmentView {
  const seg = eng.snapshot(lastTs, { selectedId: id }).selected
  assert.ok(seg, `segment ${id} resolves`)
  return seg
}

const laneOf = (row: SourceView, name: string): { hits: number; total: number } => {
  const s = row.skills.find((k) => k.name === name)
  return s ? { hits: s.hits, total: s.total } : { hits: 0, total: 0 }
}

/** Every lane on the row whose name is that spell, marker or not — the two halves of a split. */
const lanesFor = (row: SourceView, spell: string): SkillView[] =>
  row.skills.filter((k) => k.name === spell || k.name === `${spell} · proc`)

// ---------------------------------------------------------------------------------------
// 1. BOTH ORIGINS IN ONE FIGHT → TWO LANES
// ---------------------------------------------------------------------------------------

test('W59 e1: the same spell cast and procced in one pull is TWO rows, with exact counts', { skip: missing(W59) }, () => {
  const { eng, lastTs } = replay(W59)
  const row = you(eng, lastTs, 'e1')

  // THE CAST LANE KEEPS THE SPELL NAME. Eleven `You begin casting Discordant Mind II.` lines,
  // each with its own landing one second later.
  assert.deepEqual(laneOf(row, 'Discordant Mind'), { hits: 11, total: 5407 })
  // THE PROC LANE CARRIES THE MARKER. Four spellblade firings, nothing behind them.
  assert.deepEqual(laneOf(row, 'Discordant Mind · proc'), { hits: 4, total: 1503 })

  // …and this is what the ticket asked for in one assertion: the fight has two distinguishable
  // rows for one spell, which is the only way `4 of my 15 Discordant Minds procced` is readable.
  assert.deepEqual(
    lanesFor(row, 'Discordant Mind').map((k) => k.name).sort(),
    ['Discordant Mind', 'Discordant Mind · proc']
  )

  // THE OLD ANSWER, stated so the regression is legible: one row of 15 hits for 6,910, with a
  // proc rate of zero — the twelve-second window never closed between casts.
  assert.equal(11 + 4, 15)
  assert.equal(5407 + 1503, 6910)
})

test('W59 e1: the drill annotation moves to the PROC row, and off the hand-casts', { skip: missing(W59) }, () => {
  const { eng, lastTs } = replay(W59)
  const seg = segmentOf(eng, lastTs, 'e1')
  const tagged = (seg.procs.procSkills ?? []).filter((t) => t.lane === 'Discordant Mind')
  // ONE tag, on the cast-less row. Before the split it hung on the single mixed row, which is
  // how a hand-cast nuke came to wear a proc rate.
  assert.deepEqual(tagged.map((t) => t.skill), ['Discordant Mind · proc'])
  assert.equal(tagged[0].rate.count, 4, 'the ledger still counts the FIRINGS, not the rows')

  // The ledger itself is untouched by the split: it is keyed on the SPELL, so one lane.
  const lanes = seg.procs.lanes.filter((l) => l.name === 'Discordant Mind')
  assert.equal(lanes.length, 1)
  assert.equal(lanes[0].origin, 'spell')
  assert.equal(lanes[0].count, 4)
})

// ---------------------------------------------------------------------------------------
// 2. ONE ORIGIN → ONE LANE (both directions)
// ---------------------------------------------------------------------------------------

test('W59 e2: a fight that only ever PROCS the spell shows one lane', { skip: missing(W59) }, () => {
  const { eng, lastTs } = replay(W59)
  const row = you(eng, lastTs, 'e2')
  // Magi P`tasa, 14:02:25 → 14:03:47: six firings for 524 + 467 + 515 + 511 + 386 + 11 = 2,414,
  // and no `You begin casting Discordant Mind` anywhere in the fight.
  assert.deepEqual(lanesFor(row, 'Discordant Mind').map((k) => k.name), ['Discordant Mind · proc'])
  assert.deepEqual(laneOf(row, 'Discordant Mind · proc'), { hits: 6, total: 2414 })
})

test('W60: a cast that was INTERRUPTED and recovered stays a cast — one lane, no proc row', { skip: missing(W60) }, () => {
  const { eng, lastTs } = replay(W60)
  const row = you(eng, lastTs, 'e1')
  // 17:13:10 begin → 17:13:11 `Your Anarchy spell is interrupted.` → 17:13:22 `You regain your
  // concentration and continue your casting.` → 17:13:22 the 271 lands, twelve seconds after
  // the cast began and exactly on the window edge. Dropping the record on the interrupt without
  // honouring the recovery would print a phantom `Anarchy · proc` row here.
  assert.deepEqual(lanesFor(row, 'Anarchy').map((k) => k.name), ['Anarchy'])
  assert.deepEqual(laneOf(row, 'Anarchy'), { hits: 1, total: 271 })
  assert.equal(
    (segmentOf(eng, lastTs, 'e1').procs.lanes.filter((l) => l.name === 'Anarchy')).length,
    0,
    'and the ledger counts no Anarchy firing at all'
  )
})

// ---------------------------------------------------------------------------------------
// 3. AN INTERRUPTED CAST THAT NEVER RECOVERED
// ---------------------------------------------------------------------------------------

// SYNTHETIC, AND SAYING SO. Every line shape below is one the log prints thousands of times
// (`You begin casting <Spell>.`, `Your <Spell> spell is interrupted.`, `You hit <mob> for N
// points of magic damage by <Spell>.`), but the ARRANGEMENT — an interrupt with no recovery,
// followed inside the window by a firing of the same spell — has no instance in the owner's
// 1.4M lines: all 1,030 interrupts either never land, or recover first. So the rule is proved
// on the real parser and the real engine, over authored lines, and this comment is the label.
const T = (mmss: string, text: string): string => `[Wed Jul 29 17:${mmss} 2026] ${text}`

const NEVER_RECOVERED = [
  T('13:00', 'You slash a bloodthirsty ghoul for 40 points of damage.'),
  T('13:02', 'You begin casting Anarchy.'),
  T('13:03', 'Your Anarchy spell is interrupted.'),
  T('13:07', 'You hit a bloodthirsty ghoul for 271 points of magic damage by Anarchy.'),
  T('13:09', 'You slash a bloodthirsty ghoul for 30 points of damage.')
]

test('an interrupted cast never claims a later firing — the discriminator, end to end', () => {
  const { eng, lastTs } = replay(NEVER_RECOVERED)
  const row = you(eng, lastTs, 'zone')
  // The cast never resolved, so the firing four seconds later — well inside the twelve-second
  // window — has nothing behind it and is a proc.
  assert.deepEqual(lanesFor(row, 'Anarchy').map((k) => k.name), ['Anarchy · proc'])
  assert.deepEqual(laneOf(row, 'Anarchy · proc'), { hits: 1, total: 271 })

  // The same window WITH the recovery line is the opposite verdict, from the same five lines.
  const withRecovery = [...NEVER_RECOVERED]
  withRecovery.splice(3, 0, T('13:06', 'You regain your concentration and continue your casting.'))
  const back = replay(withRecovery)
  assert.deepEqual(lanesFor(you(back.eng, back.lastTs, 'zone'), 'Anarchy').map((k) => k.name), ['Anarchy'])
})

// ---------------------------------------------------------------------------------------
// 4. THE TRIPWIRE — a split moves no damage (law 8)
// ---------------------------------------------------------------------------------------

test('W59: the split is a re-keying, so every total is byte-identical', { skip: missing(W59) }, () => {
  const { eng, lastTs } = replay(W59)
  for (const id of ['e1', 'e2', 'zone']) {
    const seg = segmentOf(eng, lastTs, id)
    const row = you(eng, lastTs, id)
    // Σ category.total == source.total, per source — the shipped per-source tripwire.
    assert.equal(row.categories.reduce((n, c) => n + c.total, 0), row.total, `${id}: Σ categories`)
    // …and the two halves of the split live in ONE category, so Σ of that category's own lanes
    // is unchanged by the re-keying. The spell category is capped at 12 rows and this window
    // has five, so the sum is complete.
    const spell = seg.entities
      .find((e) => e.id === 'you')
      ?.categories.find((c) => c.category === 'spell')
    assert.ok(spell)
    assert.equal(spell.skills.reduce((n, k) => n + k.total, 0), spell.total, `${id}: Σ spell lanes`)
  }

  // The zone's Discordant Mind rows sum to the 21 landings the window contains, for the 9,324
  // the single row used to hold.
  const zone = you(eng, lastTs, 'zone')
  const dm = lanesFor(zone, 'Discordant Mind')
  assert.equal(dm.reduce((n, k) => n + k.hits, 0), 21)
  assert.equal(dm.reduce((n, k) => n + k.total, 0), 9324)
  assert.equal(segmentOf(eng, lastTs, 'zone').outTotal, 51612)
})
