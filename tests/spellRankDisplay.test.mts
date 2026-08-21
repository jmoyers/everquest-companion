// THE RANK THE BUFFS TAB SHOWS FOLLOWS THE RANK YOU CAST (JOS-411).
//
// THE REPORT (C3QVVN, v1.5.0), verbatim: *"I now have the Mesmerization spell levelled up to X
// (+10). The buffs section of EQLC, under Debuffs, lists 'Mesmerization VI'. ... should either
// A) update to the highest/most recent level seen, or B) not list the spell upgrade level at all.
// I'm a fan of option A."* Owner ruling 2026-08-19: option A.
//
// THE MECHANISM the ticket found: the per-(line, caster) stats record's display name was written
// when the record was first minted and never again, so `statFor`/`buildStats` served the first rank
// ever measured to the tab forever. The live overlay was never wrong — a hold re-reads its ranked
// name from the anchored cast on every landing.
//
// THE RULE IS HIGHEST-RANK-WINS, not last-write: this store is GAME knowledge and survives every
// rebirth/character clear, so a second enchanter on the same log would otherwise drag the name back
// down. The argument in full is on `buffsStats.ts preferredDisplayName`.
//
// The end-to-end half below replays the REAL `w10-cazic-slow.log` — nine measured Mesmerization III
// cycles through the real parser, the real BuffsModule and the real BuffTimersModule — and then
// appends the ONE thing the owner's log cannot contain, because it is the REPORTER's spellbook and
// not his: three lines in the fixture's own shapes, rank swapped, in the same evening.

import test from 'node:test'
import assert from 'node:assert/strict'
import { readFixture, replayBuffTimers } from './harness.mts'
import { SpellStats, preferredDisplayName } from '../src/main/modules/buffsStats.ts'
import { SELF_CASTER } from '../src/shared/buffTrust.ts'

const MEZ = 'mesmerization'
const W10 = readFixture('w10-cazic-slow.log')

/** A landed-and-broken mez cycle spelled the way the fixture spells one, at `rank`. */
function mezCycle(rank: string, mob: string, hhmm: string): string[] {
  return [
    `[Sat Aug 01 ${hhmm}:10 2026] You begin casting Mesmerization ${rank}.`,
    `[Sat Aug 01 ${hhmm}:11 2026] ${mob} has been mesmerized.`,
    `[Sat Aug 01 ${hhmm}:41 2026] Your Mesmerization spell has worn off of ${mob}.`
  ]
}

// ---------------------------------------------------------------------------------------------
// THE PURE RULE.
// ---------------------------------------------------------------------------------------------

test('a higher rank replaces the name, a lower one never does', () => {
  assert.equal(preferredDisplayName('Mesmerization VI', 'Mesmerization X'), 'Mesmerization X')
  assert.equal(preferredDisplayName('Mesmerization X', 'Mesmerization VI'), 'Mesmerization X')
  assert.equal(preferredDisplayName('Mesmerization X', 'Mesmerization X'), 'Mesmerization X')
  // An unsuffixed name is rank 1 (shared/spellLines.ts) — it loses to any suffix and beats none.
  assert.equal(preferredDisplayName('Mesmerization', 'Mesmerization II'), 'Mesmerization II')
  assert.equal(preferredDisplayName('Mesmerization II', 'Mesmerization'), 'Mesmerization II')
  // The bare LINE KEY is what an unresolved hold falls back to; the first real name displaces it.
  assert.equal(preferredDisplayName('mesmerization', 'Mesmerization VI'), 'Mesmerization VI')
  // A DIFFERENT base is not a rank comparison — the newest name wins outright (a renamed line,
  // JOS-161, or a family's first candidate).
  assert.equal(preferredDisplayName('Solon`s Bravura', 'Solon`s Bewitching Bravura II'), 'Solon`s Bewitching Bravura II')
  assert.equal(preferredDisplayName('Dazzle IV', 'Mesmerize'), 'Mesmerize')
  // Nothing is not a statement.
  assert.equal(preferredDisplayName('Mesmerization X', '   '), 'Mesmerization X')
})

// ---------------------------------------------------------------------------------------------
// THE ACCEPTANCE CASE, at the store: mint at VI, cast X, cast VI again.
// ---------------------------------------------------------------------------------------------

test('the tab`s record follows the upgrade — VI, then X ⇒ X, and a later VI leaves it at X', () => {
  const stats = new SpellStats()
  stats.everFaded.add(MEZ)

  stats.pushSample(MEZ, SELF_CASTER, 'Mesmerization VI', { ms: 24_000, ts: 60_000 })
  assert.equal(stats.buildStats()[MEZ].spell, 'Mesmerization VI', 'the first mint names the row')

  stats.pushSample(MEZ, SELF_CASTER, 'Mesmerization X', { ms: 44_000, ts: 120_000 })
  assert.equal(stats.buildStats()[MEZ].spell, 'Mesmerization X', 'the upgrade is what the tab shows')

  stats.pushSample(MEZ, SELF_CASTER, 'Mesmerization VI', { ms: 20_000, ts: 180_000 })
  assert.equal(stats.buildStats()[MEZ].spell, 'Mesmerization X', 'and a lower rank never walks it back')

  // The samples themselves pool across ranks exactly as they always did (JOS-140 ruling 4) — this
  // ticket moves the NAME and nothing else.
  assert.equal(stats.statFor(MEZ)?.n, 3, 'three cycles, one line, one learner key')
  assert.equal(stats.statFor(MEZ)?.maxMs, 44_000)
})

test('a name arrives before any cycle closes — a row with no samples still names itself', () => {
  const stats = new SpellStats()
  stats.everFaded.add(MEZ)

  // The landing seam (buffTimers.apply) writes the name with no sample behind it: a mez broken by
  // the player's own nuke mints nothing, and waiting for a clean cycle is what left the upgraded
  // rank invisible.
  stats.noteDisplayName(MEZ, SELF_CASTER, 'Mesmerization VI')
  assert.equal(stats.statFor(MEZ), null, 'no samples ⇒ no stat row, exactly as before')
  assert.equal(stats.buildStats()[MEZ].spell, 'Mesmerization VI', 'and the tab reads the name anyway')
  assert.equal(stats.buildStats()[MEZ].n, 0)

  stats.noteDisplayName(MEZ, SELF_CASTER, 'Mesmerization X')
  assert.equal(stats.buildStats()[MEZ].spell, 'Mesmerization X')
})

test('an external caster`s rank is their own — the learner key keeps the names apart', () => {
  const stats = new SpellStats()
  stats.everFaded.add(MEZ)
  stats.pushSample(MEZ, SELF_CASTER, 'Mesmerization X', { ms: 44_000, ts: 60_000 })
  stats.pushSample(MEZ, 'grouped-enchanter', 'Mesmerization II', { ms: 20_000, ts: 120_000 })

  assert.equal(stats.sampleSpellName(MEZ), 'Mesmerization X', 'the tab reports the SELF caster`s row')
  assert.equal(stats.sampleSpellName(MEZ, 'grouped-enchanter'), 'Mesmerization II', 'theirs is theirs')
})

// ---------------------------------------------------------------------------------------------
// END TO END, through the real modules — the reporter's own sequence.
// ---------------------------------------------------------------------------------------------

test('the real mez path names the tab row after the cast that landed', () => {
  const before = replayBuffTimers(W10)
  assert.equal(
    before.buffs.stats[MEZ].spell,
    'Mesmerization III',
    'the fixture casts rank III all evening and the tab says so'
  )

  const upgraded = replayBuffTimers([...W10, ...mezCycle('X', 'a scareling', '21:02')])
  assert.equal(upgraded.buffs.stats[MEZ].spell, 'Mesmerization X', 'one rank-X cast moves the tab')

  const andBackDown = replayBuffTimers([
    ...W10,
    ...mezCycle('X', 'a scareling', '21:02'),
    ...mezCycle('VI', 'a phantasm', '21:04')
  ])
  assert.equal(
    andBackDown.buffs.stats[MEZ].spell,
    'Mesmerization X',
    'a lower-rank cast afterwards is not a downgrade of the spell'
  )
})

test('a hold that never closes still renames the row — the LANDING is what states the rank', () => {
  // No wear-off line, so no cycle, so no sample: `pushSample` alone would never hear about this
  // upgrade. On the crowd-control path that is the common case, not the corner one — the cast line
  // is the only line in a mez's family that carries the numeral, and a mez the player's own damage
  // breaks mints nothing at all.
  const landedOnly = replayBuffTimers([
    ...W10,
    '[Sat Aug 01 21:02:10 2026] You begin casting Mesmerization X.',
    '[Sat Aug 01 21:02:11 2026] a scareling has been mesmerized.'
  ])
  assert.equal(landedOnly.buffs.stats[MEZ].spell, 'Mesmerization X')
  assert.equal(landedOnly.buffs.stats[MEZ].n, 9, 'and the fixture`s own nine cycles are untouched')
})
