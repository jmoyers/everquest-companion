// JOS-435 — THE RANGER DoT THE CENSUS HAD ALREADY NAMED.
//
// THE REPORT (01M0GR6H8SJH69XS9W2RH61W90, v1.6.0, a ranger): "Ranger Spell: Swarm of Pain not
// tracking in Debuffs overlay."
//
// THE MECHANISM IS THE SUBJECT SWEEP'S, AND NOTHING ELSE MOVED. `castOnOtherSuffix()` keys the
// cast-on-other table on what follows a `Someone ` subject and on nothing else; the wiki wrote this
// spell's third-person landing as `is covered in a swarm of nifiliks.`, subject CROPPED, so the row
// was in no table, `<mob> is covered in a swarm of nifiliks.` classified as `{kind:'unknown'}`, and
// no `buffApply` ever existed for the overlay to draw a bar from. The registry row is otherwise
// correct — `Detrimental`, 1 Min, Ranger 40 — and `spellLines.json` already lists the spell in
// `swarm-line`, so the fix is DATA in `spellCorrectionsSubjectsList.ts` and no routing changed.
//
// WHAT MAKES THIS TICKET WORTH ITS OWN FILE: THE CENSUS ANSWERED BACK. The spell was ALREADY named
// in `tests/spellSubjectAudit.test.mts`'s `NO_SUBJECT_CENSUS`, in the 82-row cropped-subject
// population, with the reason it carried no correction stated in advance — the awaiting-sample law,
// no log had printed the sentence attached to a cast. So triage was not an investigation; it was one
// measurement against a row the validator had been listing since JOS-412. The argument lives in
// `src/main/data/spellCorrectionsSubjects.ts` under THE CENSUS ANSWERS BACK.
//
// WHERE THE BYTES COME FROM: nothing is injected, which the JOS-245 druid case could not say. The
// owner's log holds BOTH halves at volume — 219 of his own `You begin casting Swarm of Pain.` casts
// and 199 `<mob> is covered in a swarm of nifiliks.` landings, 198 of them 0-3 s after one of those
// casts, measured 2026-08-20 over 2,192,979 lines — so the cycle below is HIS, verbatim and with no
// name swapped (Sat Aug 15 20:50:43 / :44, wear-off 20:51:45), re-stamped by `at()`. The reporter's
// own sequence is the same shape one rank up (`You begin casting Swarm of Pain V.` then `Gorgalosk
// is covered in a swarm of nifiliks.` two seconds later) and none of his bytes enter the tree.
//
// THE LAW-8 TRIPWIRE, whole-log, both DBs in one process (2026-08-20, 2,192,979 lines): `unknown`
// 210,432 -> 210,233 and `buffApply` 146,467 -> 146,666. EXACTLY 199 lines move and all 57 other
// kinds are byte-identical, so the minted tail takes nothing from any classifier below.
//
// WHY THIS IS NOT INSIDE `tests/spellCorrectionsSubjects.test.mts`, where the other five reports'
// acceptances live: that file is AT the 400-code-line factoring ceiling and this section pushed it
// to 443. Same reason `tests/calmLineTimers.test.mts` sits beside `tests/buffTimers.test.mts`. The
// sweep's own invariants (shape, no-partial-overlap, the refusals) still cover this row there.
//
// Run: `npm test`.

import test from 'node:test'
import assert from 'node:assert/strict'
import { parseEvent } from '../src/main/log/parser.ts'
import { installSpellDb } from '../src/main/log/rulesets.ts'
import { buildSpellDb, castOnOtherSuffix, loadSpellDb, matchCastOnOtherSuffix } from '../src/main/data/spellDb.ts'
import { applySpellCorrections, SPELL_CORRECTIONS } from '../src/main/data/spellCorrections.ts'
import { SUBJECT_PLACEHOLDER_CORRECTIONS } from '../src/main/data/spellCorrectionsSubjects.ts'
import { BuffsModule } from '../src/main/modules/buffs.ts'
import { BuffTimersModule } from '../src/main/modules/buffTimers.ts'
import { buildTimerRows, rowsForSurface } from '../src/shared/buffTimers.ts'
import type { SpellDbFile } from '../src/shared/types.ts'
import spellsJson from '../src/main/data/spells.json' with { type: 'json' }

const RAW = (spellsJson as SpellDbFile).spells

/** The registry as it shipped BEFORE the subject sweep — every correction except those. */
const HAND_DERIVED = SPELL_CORRECTIONS.filter((c) => !SUBJECT_PLACEHOLDER_CORRECTIONS.includes(c))

/** An EQ-stamped line at `sec` seconds past 20:50:43 — the owner's own stamp for this cycle. */
function at(sec: number, text: string): string {
  const two = (n: number): string => String(n).padStart(2, '0')
  return `[Sat Aug 15 20:${two(50 + Math.floor((43 + sec) / 60))}:${two((43 + sec) % 60)} 2026] ${text}`
}

/**
 * The sweep suite's harness, verbatim in shape: both modules, wired the way `modules/wiring.ts`
 * wires them, so a landing anchors against the buffs module's own cast history. `withDb` replays
 * against a registry other than the committed one, which is how the "…and without the correction"
 * half states the defect through the same machinery rather than by inspection.
 */
function replay(lines: [number, string][], observeSec: number, withDb?: ReturnType<typeof loadSpellDb>) {
  const db = withDb ?? loadSpellDb()
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
  return { rows: buildTimerRows(b, timers.snapshot().state), active: b.active }
}

/** The owner's own cast/landing pair, one second apart, exactly as his log prints it. */
const RANGER_DOT: [number, string][] = [
  [0, 'You begin casting Swarm of Pain.'],
  [1, 'Maestro of Rancor is covered in a swarm of nifiliks.']
]

test('THE REPORTED DEFECT: a Swarm of Pain cast plus its landing opens the DoT`s debuff bar', () => {
  const r = replay(RANGER_DOT, 10)
  const row = r.rows.find((x) => x.target === 'Maestro of Rancor')
  assert.ok(row, `no dot row: ${r.rows.map((x) => `${x.name}@${x.target ?? 'self'}`).join(', ') || '(none)'}`)
  assert.equal(row.name, 'Swarm of Pain')
  assert.equal(row.kind, 'debuff', 'spellType `Detrimental` folds to a debuff — spellDb.ts DETRIMENTAL_TYPES')
  assert.equal(row.mode, 'countdown', 'a bar with a number on it, which is the whole report')
  assert.equal(row.durationMs, 60_000, 'the committed DB states 1 Min, which is the FLOOR (see below)')
  assert.ok(rowsForSurface(r.rows, 'debuffs').includes(row), 'and the DEBUFFS window is where it was missing')
  assert.deepEqual(rowsForSurface(r.rows, 'buffs'), [], 'a DoT on a mob is never a buff of yours')
  assert.ok(
    r.active.some((a) => a.spell === 'Swarm of Pain' && a.target === 'Maestro of Rancor'),
    `no held instance: ${r.active.map((a) => `${a.spell}@${a.target ?? 'self'}`).join(', ') || '(none)'}`
  )
})

test('…and without the correction the same landing is not an event at all, which is the defect', () => {
  const bare = buildSpellDb(applySpellCorrections(RAW, HAND_DERIVED).spells)
  try {
    const r = replay(RANGER_DOT, 10, bare)
    assert.deepEqual(r.rows, [], 'no row at all: the landing sentence was in no table under any key')
    assert.equal(
      castOnOtherSuffix(bare.byKey.get('swarm of pain')?.msgCastOnOther ?? ''),
      null,
      'because the scrape cropped the subject off and the table keys on `Someone `'
    )
    installSpellDb(bare)
    assert.equal(
      parseEvent('[Sat Aug 15 20:50:44 2026] Maestro of Rancor is covered in a swarm of nifiliks.', 0)?.kind,
      'unknown',
      'the live line classified as nothing — so the mint TAKES no line from any classifier below'
    )
  } finally {
    installSpellDb(loadSpellDb())
  }
})

test('the minted tail resolves to Swarm of Pain alone', () => {
  // The row MINTS rather than joins, so the question a reader asks is who else could claim the
  // sentence. Nobody: `Swarm of Pain` is the only registry row whose messages mention nifiliks.
  // The sweep suite's invariant 2 pins the general no-partial-overlap rule; this pins the answer.
  const db = loadSpellDb()
  const hit = matchCastOnOtherSuffix('Maestro of Rancor is covered in a swarm of nifiliks.', db)
  assert.ok(hit, 'the live sentence must resolve at all')
  assert.equal(hit.target, 'Maestro of Rancor')
  assert.deepEqual(hit.entry.cands.map((c) => c.name), ['Swarm of Pain'])
})

test('the restored landing is what lets the bar LEARN the rank`s real duration', () => {
  // THE HONEST-DURATION HALF, same shape as JOS-245's and with the owner's own log as witness: his
  // fourteen clean land-to-wear-off cycles run 61-65 s against the DB's stated 60 s, so the floor
  // was very slightly low and only an OBSERVABLE cycle can say so. Before this row there was no
  // landing, hence no instance, hence nothing for `Your Swarm of Pain spell has worn off of <mob>.`
  // to close — and the wear-off path never needed a fix, it needed something to pair with.
  const cycle: [number, string][] = [
    ...RANGER_DOT,
    [62, 'Your Swarm of Pain spell has worn off of Maestro of Rancor.'],
    [70, 'You begin casting Swarm of Pain.'],
    [71, 'Maestro of Rancor is covered in a swarm of nifiliks.']
  ]
  const r = replay(cycle, 80)
  const row = r.rows.find((x) => x.target === 'Maestro of Rancor')
  assert.ok(row, 'the second cast opens its own row')
  assert.equal(row.durationMs, 61_000, 'the observed span of the owner`s own cycle, not the wiki`s 60 s')
  const held = r.active.find((a) => a.spell === 'Swarm of Pain')
  assert.equal(held?.durationSource, 'observed', 'and the bar says which number it is showing')
  assert.equal(held?.n, 1, 'one clean cycle, which is exactly what the correction made observable')
})
