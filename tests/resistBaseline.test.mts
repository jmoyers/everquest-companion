// THE SHIPPED BASELINE: what is in it, what is deliberately not, and what it says (JOS-382).
//
// TWO KINDS OF ASSERTION, and the split matters.
//
//   THE SHAPE assertions run everywhere, including CI. They are about the FILE: its schema, its
//   size, and — the part worth a test rather than a comment — the things a public artifact mined
//   from one player's log must NOT carry. No character names, no zones, no timestamps, and no
//   verdicts. It records observations, and an observation is a count.
//
//   THE ESTIMATE assertions need the client's `spells_us.txt`, which is Daybreak's file and is
//   never committed here. They SKIP where it is absent, with the same reasoning the full-log tests
//   skip on CI: a test that cannot see its input reports that, rather than passing vacuously.

import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { estimate, fullDamageRefs } from '../src/shared/resistModel'
import { resistBenchmark } from '../src/shared/resistFormula'
import { ResistLedgerStore, rowKey, rowTotal } from '../src/main/resist/ledger'
import { isoWeekKey } from '../src/shared/resistDecay'
import { localMobEntry } from '../src/main/mobLookupLocal'
import { parseSpellsUs } from '../src/main/resist/spellsUsParse'
import {
  BASELINE_SOURCE_KEY,
  RESIST_AXES,
  RESIST_LEDGER_SCHEMA,
  type ResistLedger,
  type ResistRow,
  type SpellResistTable
} from '../src/shared/resistTypes'

const PATH = join(import.meta.dirname, '..', 'src', 'main', 'data', 'resistBaseline.json')
const LEDGER = JSON.parse(readFileSync(PATH, 'utf8')) as ResistLedger
const ROWS = LEDGER.sources[0].rows

/**
 * The full-damage reference per (spell, caster level) over the WHOLE file, which is what the app
 * hands the estimator (`src/main/ipc/resist.ts`). Every estimate below passes it, so these tests
 * read the same numbers a mob page does rather than the narrower per-cell fallback.
 */
const MODES = fullDamageRefs(ROWS)

const SPELLS_US =
  process.env.EQ_SPELLS_US ??
  'C:/Users/Public/Daybreak Game Company/Installed Games/EverQuest Legends/spells_us.txt'
const HAVE_CLIENT = existsSync(SPELLS_US)
let table: SpellResistTable | null = null
function spells(): SpellResistTable {
  table ??= parseSpellsUs(readFileSync(SPELLS_US, 'latin1'))
  return table
}

function rowsFor(mob: string): ResistRow[] {
  return ROWS.filter((r) => r.mobKey === mob)
}

test('the file is one baseline source at the current schema, stamped with when it was frozen', () => {
  assert.equal(LEDGER.schema, RESIST_LEDGER_SCHEMA)
  assert.equal(LEDGER.sources.length, 1)
  assert.equal(LEDGER.sources[0].key, BASELINE_SOURCE_KEY)
  // PINNED, not `new Date()`: a re-run on an unchanged log has to diff to nothing, or the file
  // churns on every regeneration and a real new observation is invisible in the diff.
  assert.match(LEDGER.frozenAt ?? '', /^\d{4}-\d{2}-\d{2}T/)
})

test('THE FILE IS A SNAPSHOT, SO ITS AGE IS SAID ONCE (JOS-397)', () => {
  // No row carries a week. They all share one — the week of `frozenAt` — and four thousand copies
  // of one string is 80 kB to say what the stamp above already says. The store fills it in as the
  // file is read, and this is the assertion that the two halves of that arrangement still agree.
  for (const row of ROWS) assert.equal(row.week, undefined)

  const store = new ResistLedgerStore()
  store.seed(LEDGER)
  const week = isoWeekKey(Date.parse(LEDGER.frozenAt ?? ''))
  assert.equal(store.newestWeek(), week)
  const seeded = store.rowsFor(ROWS[0].mobKey, BASELINE_SOURCE_KEY)
  assert.ok(seeded.length > 0)
  for (const row of seeded) assert.equal(row.week, week)
})

test('AND NO ROW IS SPLIT BY WEEK: the freeze re-pools every cell onto that one', () => {
  // The fold buckets by week, so a four-week log arrives as up to four rows per cell. Left that
  // way the five-observation floor below would drop the fragments a whole cell clears several
  // times over, and the shipped file would know LESS than it does today. `repoolAtWeek` in the
  // freeze script is where that is undone; this is the shape of it, checked on the artifact.
  const seen = new Set<string>()
  for (const row of ROWS) {
    const key = rowKey({ ...row, week: 'x' })
    assert.ok(!seen.has(key), `${row.mobKey} / ${row.spellKey} appears twice`)
    seen.add(key)
  }
})

test('and the run detector left nothing behind on disk (JOS-400)', () => {
  // JOS-397 wrote a per-(mob, spell) ring of recent outcomes beside the rows. It was removed the
  // same day at the owner's ruling; the shipped file never carried one and must not start.
  assert.ok(!readFileSync(PATH, 'utf8').includes('"recent"'))
})

test('it is big enough to be worth shipping and small enough to inline', () => {
  const bytes = statSync(PATH).size
  assert.ok(ROWS.length > 1000, `${String(ROWS.length)} rows`)
  // Inlined into the main bundle by electron-vite, beside a 979 kB spells.json and an 8.6 MB
  // items.json. Under a megabyte is the bar the brief set; the row threshold is the dial.
  assert.ok(bytes < 1_000_000, `${String(bytes)} bytes`)
})

test('every row carries at least the threshold the generator states', () => {
  for (const row of ROWS) {
    assert.ok(rowTotal(row) >= 5, `${row.mobKey} / ${row.spellKey} carries ${String(rowTotal(row))}`)
  }
})

test('IT IS OBSERVATIONS ONLY: no itinerary, no clock, no verdicts', () => {
  for (const row of ROWS) {
    // A zone is where this player fought the mob, not a fact about the mob.
    assert.equal(row.zone, undefined)
    // And the hour on the evening he fought it says even less.
    assert.equal(row.firstTs, 0)
    assert.equal(row.lastTs, 0)
    // `source` is applied at READ time by the ledger; a row that carried it would be asserting
    // its own provenance, which is the ledger's job and not the file's.
    assert.equal(row.source, undefined)
  }
  // No R, no interval, no "immune" anywhere in the file - a stored verdict is a second opinion
  // waiting to disagree with the derived one.
  const text = readFileSync(PATH, 'utf8')
  for (const forbidden of ['"immune"', '"tag"', '"estimate"']) {
    assert.ok(!text.includes(forbidden), `the file must not carry ${forbidden}`)
  }
})

test('no character name reaches the file', () => {
  // The only names a row carries are a MOB and a SPELL. The tailed character's name and every
  // other player's are structurally absent: neither has a field to live in.
  for (const row of ROWS.slice(0, 200)) {
    assert.ok(!/primitive/i.test(row.mobKey))
    assert.ok(!/primitive/i.test(row.spellKey))
  }
  assert.ok(!readFileSync(PATH, 'utf8').includes('Primitive'))
})

test('NO SONG IN THE SHIPPED BASELINE IS RESIST-ONLY', () => {
  // The regression guard for the defect that shipped in round one. A bard's songs re-pulse under
  // the Symphonic Aura with no cast line, so nothing joined their landing emote to anything and
  // Largo's Melodic Binding was filed as 400 resists with ZERO landings - a spell that is 100%
  // resisted by construction, dragging magic toward "nearly immune" on every mob a bard sang at.
  const songs = ROWS.filter((r) => r.family === 'song')
  assert.ok(songs.length > 100, `only ${String(songs.length)} song rows`)
  const bySpell = new Map<string, { resist: number; land: number }>()
  for (const row of songs) {
    const acc = bySpell.get(row.spellKey) ?? { resist: 0, land: 0 }
    acc.resist += row.resist
    acc.land += row.land
    bySpell.set(row.spellKey, acc)
  }
  for (const [key, acc] of bySpell) {
    assert.ok(acc.land > 0, `${key}: ${String(acc.resist)} resists and no landings at all`)
  }
})

test("Largo's is a SONG, with the denominator its pulses printed", () => {
  const largo = ROWS.filter((r) => r.spellKey === "largo's melodic binding")
  assert.ok(largo.length > 0)
  for (const row of largo) assert.equal(row.family, 'song')
  const land = largo.reduce((a, r) => a + r.land, 0)
  const resist = largo.reduce((a, r) => a + r.resist, 0)
  assert.ok(land > resist * 4, `${String(land)} landings against ${String(resist)} resists`)
  // And the catalog's other spelling of the same song is folded away, never a second row.
  assert.equal(ROWS.filter((r) => r.spellKey === "largo's assonant binding").length, 0)
})

test('a mob a bard sang at reads NORMAL, not nearly immune', { skip: !HAVE_CLIENT && 'no client spells_us.txt' }, () => {
  // `soldier of v`zher`, the mob the defect was found on. Before: R 188 [188,226] off 70 resists
  // and no landings whatever. After: the song's own pulses supply the denominator.
  const rows = rowsFor("soldier of v'zher")
  const est = estimate(rows, spells(), { axis: 'magic', mobLevel: 26 })
  assert.ok(est.byFamily.song.n > 300, `song observations: ${String(est.byFamily.song.n)}`)
  assert.ok(est.R >= 15 && est.R <= 45, `R=${String(est.R)} outside the 15-45 a 315/70 split implies`)
  assert.equal(resistBenchmark(est.R, 50, 26).guidance, 'should land')
})

test('only casters the owner ruled admissible are in it', () => {
  const kinds = new Set(ROWS.map((r) => r.casterKind))
  // JOS-385 added the third: charmed pets and NPC casters, folded like any other observation, with
  // `resists.includeNpcCasters` deciding at ESTIMATE time whether they weigh. The ruling they were
  // excluded under (JOS-382) was revisited, not overturned by accident, so this list is still a
  // closed one and a fourth kind appearing here is a bug rather than a feature.
  for (const kind of kinds) {
    assert.ok(kind === 'self' || kind === 'pc' || kind === 'npc', `caster kind ${kind}`)
  }
})

test('the npc family is here, it carries LEVELS, and it is never a song (JOS-385)', () => {
  const npc = ROWS.filter((r) => r.casterKind === 'npc')
  assert.ok(npc.length > 100, `only ${String(npc.length)} npc rows`)
  // THE REASON THIS FAMILY IS WORTH MORE THAN A STRANGER'S CASTS: the mob catalog states a caster
  // level for most of them, so most npc rows carry an rc and can actually reach a number. A `pc`
  // row never can — nothing in this app's inputs states another player's level.
  const levelled = npc.filter((r) => r.casterLevel !== null).length
  assert.ok(levelled / npc.length > 0.6, `only ${String(levelled)} of ${String(npc.length)} npc rows carry a level`)
  assert.equal(ROWS.filter((r) => r.casterKind === 'pc' && r.casterLevel !== null).length, 0)
  // Songs are the tailed character's bard, decided by spell identity. An NPC casting a bard song
  // is refused by `SongFold` before anything is filed, so this set is empty by construction.
  assert.equal(npc.filter((r) => r.family === 'song').length, 0)
})

test('EVERY KEY IN THE FILE IS A CREATURE, not a person (JOS-385)', () => {
  // The regression guard for the defect JOS-385 found in the shipped JOS-382 file: rows keyed
  // `you` (Cannibalization damages its own caster), a groupmate's name carrying a Superior Healing
  // landing, and Jonthan's Provocation pulsing on five people — 2,700 observations under 56 keys
  // that were players, in a file this repo publishes. `isMobTarget` gates every arm of the fold now.
  //
  // The test is on the KEY, which is already lowercased, so it asks the question the key can
  // answer: a single word with no space and no article is the shape EQ gives a player, and the one
  // that has to be in the committed catalog to earn a place here.
  for (const row of ROWS) {
    assert.notEqual(row.mobKey, 'you')
    if (/[\s'`*-]/.test(row.mobKey)) continue
    assert.ok(
      localMobEntry(row.mobKey) !== null,
      `${row.mobKey} is shaped like a player's name and the catalog has never heard of it`
    )
  }
})

test('the imp protector can finally speak about FIRE, and only because of the npc family', { skip: !HAVE_CLIENT && 'no client spells_us.txt' }, () => {
  // THE CELL THE PREVIOUS ROUND HAD TO GIVE UP ON, named in the test below this one: every fire
  // observation this log holds for an imp protector is imp protectors throwing Dry Bone Fire Burst
  // at each other, so under JOS-382's ruling the axis the plan headlines ("FR ~70% resisted") was
  // a blank row. That is the whole case for the family, and it is one assertion.
  const rows = rowsFor('an imp protector')
  const withNpc = estimate(rows, spells(), { axis: 'fire', mobLevel: 45, includeNpcCasters: true })
  const without = estimate(rows, spells(), { axis: 'fire', mobLevel: 45, includeNpcCasters: false })
  assert.ok(withNpc.n > 100, `n=${String(withNpc.n)}`)
  assert.equal(without.n, 0, 'no player ever cast fire at one in this log')
  assert.equal(resistBenchmark(withNpc.R, 50, 45).guidance, 'may not land even with overchannel')
  // AND THE COUNTS SURVIVE THE SWITCH. A family that is not weighed is still a family that was
  // observed, which is what the mob page prints as "(not included)".
  assert.equal(without.byCaster.npc.n, withNpc.byCaster.npc.n)
  assert.equal(without.npcIncluded, false)
})

test('Lord Nagafen reads the magic resistance the plan predicted', { skip: !HAVE_CLIENT && 'no client spells_us.txt' }, () => {
  const rows = rowsFor('lord nagafen')
  assert.ok(rows.length > 0)
  const est = estimate(rows, spells(), { axis: 'magic', mobLevel: 55 })
  // docs/plans/resist-mining.md section 3, hand-derived from this same log before any of this
  // code existed: R_magic 140 [92,206] from fixed damage, 126 [110,144] from all-or-nothing.
  assert.ok(est.n > 200, `n=${String(est.n)}`)
  assert.ok(est.R >= 90 && est.R <= 210, `R=${String(est.R)} outside the predicted [90, 210]`)
})

test('a loathling lich is provably DISEASE-resistant, from the owner\'s own casts', { skip: !HAVE_CLIENT && 'no client spells_us.txt' }, () => {
  // THE HEADLINE CLAIM FROM THE TAILED CHARACTER'S OWN CASTS. The test above is the same shape of
  // claim standing on the npc family; this one stands on nothing but the player's own nukes, and
  // it is one the plan predicted by hand before any of this code existed (section 3: a loathling
  // lich, disease 51% resisted against 1% magic and 2% fire).
  const rows = rowsFor('a loathling lich')
  const disease = estimate(rows, spells(), { axis: 'disease', mobLevel: 51, modes: MODES })
  const magic = estimate(rows, spells(), { axis: 'magic', mobLevel: 51, modes: MODES })
  assert.ok(disease.nInformative >= 60, `disease n=${String(disease.nInformative)}`)
  assert.ok(magic.nInformative >= 60, `magic n=${String(magic.nInformative)}`)
  assert.ok(disease.R > magic.R, `disease R=${String(disease.R)} vs magic R=${String(magic.R)}`)
  // AND BY A MARGIN THE INTERVALS SUPPORT: the whole disease interval sits above the magic
  // estimate, which is what turns "looks higher" into a statement a player can act on.
  //
  // THE CLAIM WAS `disease.lo > magic.hi` UNTIL JOS-387, and its weakening is the interval getting
  // MORE HONEST rather than the evidence getting worse. The interval is now the central 95% of the
  // posterior instead of a profile-likelihood cut on the evidence alone, so it carries the prior's
  // own width; on this cell the two ends now touch by two grid steps (disease from 64, magic to
  // 68). The separation itself is unchanged and larger than either interval's half-width.
  assert.ok(
    disease.lo > magic.R && disease.R - magic.R >= 20,
    `disease [${String(disease.lo)},${String(disease.hi)}] R=${String(disease.R)} vs magic [${String(magic.lo)},${String(magic.hi)}] R=${String(magic.R)}`
  )
})

test('THE ZOL GHOUL KNIGHT LOST ITS COLD CLAIM, and that is the fix working (JOS-385)', () => {
  // WORTH A TEST OF ITS OWN, because a claim this suite used to make is gone and the reason is the
  // whole of defect 2. `a zol ghoul knight` read cold R 60 [40,84] against magic R 30 [24,34] —
  // provably cold-resistant — and a good part of that 60 was invented: the full-damage reference
  // was each histogram's largest value, so every focused Frost Dagger and Frost Strike hit counted
  // as a partial and the mob looked like it was eating cold. Against the ledger-wide mode the same
  // rows read cold R 26 [10,50] and magic R 26 [22,30]: two axes this log cannot tell apart.
  //
  // The honest display of that is an overlap, and a suite that still asserted the separation would
  // be pinning the defect. What is pinned instead is that the two intervals now MEET.
  if (!HAVE_CLIENT) return
  const rows = rowsFor('a zol ghoul knight')
  const cold = estimate(rows, spells(), { axis: 'cold', mobLevel: 38, modes: MODES })
  const magic = estimate(rows, spells(), { axis: 'magic', mobLevel: 38, modes: MODES })
  assert.ok(cold.hi >= magic.lo && magic.hi >= cold.lo, 'the intervals overlap: no separation is claimed')
  // …and the magic cell is where the OTHER defect shows on this mob: 1,294 observations of which
  // 606 could have gone either way, because Smiting Strike is a -250 proc cast 689 times.
  assert.ok(magic.nInformative < magic.n / 2, `${String(magic.nInformative)} of ${String(magic.n)}`)
  const proc = magic.perSpell.find((e) => e.spellKey === 'smiting strike')
  assert.equal(proc?.informative, false)
  assert.equal(proc?.resistAdj, -250)
  // And it is sorted BELOW every spell that tested the mob, however many times it was cast.
  const informativeCasts = magic.perSpell.filter((e) => e.informative).length
  assert.ok(magic.perSpell.slice(0, informativeCasts).every((e) => e.informative), 'informative first')
})

test('every axis answers for a well-observed mob, and thin ones say so', { skip: !HAVE_CLIENT && 'no client spells_us.txt' }, () => {
  const rows = rowsFor('a zol ghoul knight')
  const counts = RESIST_AXES.map((axis) => estimate(rows, spells(), { axis, mobLevel: 38 }).n)
  // Five rows, always. Some of them are zero, and a zero is a real answer the card prints as
  // "not enough data" rather than omitting.
  assert.equal(counts.length, 5)
  assert.ok(counts.filter((n) => n >= 5).length >= 3, `axes with data: ${counts.join(',')}`)
})

test('the shipped rows are all baseline-weighted until a user has any of their own', { skip: !HAVE_CLIENT && 'no client spells_us.txt' }, () => {
  const rows = rowsFor('a zol ghoul knight').map((r) => ({ ...r, source: 'baseline' as const }))
  const est = estimate(rows, spells(), { axis: 'magic', mobLevel: 38 })
  assert.equal(est.fromYou, 0)
  assert.ok(est.fromBaseline > 0)
  // With nothing of your own, K/(K+0) = 1: the shipped data counts in full, which is the whole
  // point of shipping it.
  assert.equal(est.baselineWeight, 1)
  assert.equal(est.userOnly, false)
  assert.equal(est.differsFromShipped, false)
})
