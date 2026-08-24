// A RAIN CAST IS ONE CAST (JOS-414, GitHub issue 39) — the real window, the synthetic N×M cast,
// and the roster's derivation.
//
// THE REPORT: a wizard's ability breakdown showed `Lava Storm` twice in one fight — once plain,
// once as `Lava Storm · proc` wearing a 6.21 ppm rate — which reads as the same damage counted
// twice. The mechanism was the cast/proc join's INSTANT rule (procDetect.ts): one
// `You begin casting …` explains the landings of ONE second, so a rain's first wave scored
// `cast` and every later wave scored `proc`.
//
// MEASURED BEFORE THE FIX, on the fixture below (real parser + real engine, both branches run):
//   before   Poison Storm        1 hit  61      +  Poison Storm · proc  2 hits 122   ledger: 2 firings
//   after    Poison Storm        3 hits 183                       (no proc lane)     ledger: none
// The fight's `outTotal` is 1,354 either way — the defect was never a doubled TOTAL, it was a
// split lane and a fabricated proc rate, and the tripwire below pins that the fix moves no damage.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { parseEvent } from '../src/main/log/parser'
import { installSpellDb } from '../src/main/log/rulesets'
import { CombatEngine } from '../src/main/combat/engine'
import {
  MESSAGE_RAIN_NAMES,
  RAIN_PAGES,
  RAIN_SPELL_NAMES,
  isRainSpell,
  rainWaves
} from '../src/main/data/rainSpells'
import { DEFAULT_AE_MAX_TARGETS, aeHits } from '../src/shared/aoeSpells'
import spellsJson from '../src/main/data/spells.json'
import { procEligibleDamage } from '../src/main/combat/procDetect'
import { groupByTarget } from '../src/renderer/src/features/combat/dashboardData'
import type { SegmentView, SourceView } from '../src/shared/combat'
import type { SpellDbFile } from '../src/shared/types'

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), 'fixtures')

function fixture(name: string): string[] {
  const p = join(FIXTURES, name)
  return existsSync(p) ? readFileSync(p, 'utf8').split(/\r?\n/).filter((l) => l.length > 0) : []
}

const W71 = fixture('w71-rain-waves.log')
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

function segmentOf(eng: CombatEngine, lastTs: number, id: string): SegmentView {
  const seg = eng.snapshot(lastTs, { selectedId: id }).selected
  assert.ok(seg, `segment ${id} resolves`)
  return seg
}

function you(eng: CombatEngine, lastTs: number, id: string): SourceView {
  const row = segmentOf(eng, lastTs, id).entities.find((e) => e.id === 'you')
  assert.ok(row, `${id} has a You row`)
  return row
}

const laneOf = (row: SourceView, name: string): { hits: number; total: number } => {
  const s = row.skills.find((k) => k.name === name)
  return s ? { hits: s.hits, total: s.total } : { hits: 0, total: 0 }
}

/** Every lane on the row whose name is that spell, marker or not. */
const lanesFor = (row: SourceView, spell: string): string[] =>
  row.skills.filter((k) => k.name === spell || k.name === `${spell} · proc`).map((k) => k.name)

// ---------------------------------------------------------------------------------------
// 1. THE REAL WINDOW — one cast, three waves, one lane
// ---------------------------------------------------------------------------------------

test('W71: a real rain cast is ONE lane carrying every wave', { skip: missing(W71) }, () => {
  const { eng, lastTs } = replay(W71)
  const row = you(eng, lastTs, 'zone')

  // `You begin casting Poison Storm.` 14:50:19, then 61 at :20, 61 at :23, 61 at :26 — hand-read
  // off the fixture. All three are waves of the one cast, so all three are the one lane.
  assert.deepEqual(lanesFor(row, 'Poison Storm'), ['Poison Storm'])
  assert.deepEqual(laneOf(row, 'Poison Storm'), { hits: 3, total: 183 })

  // …and the ledger counts NO firing: a rain is not a proc, so it never enters proc analytics
  // and can never wear a ppm.
  const seg = segmentOf(eng, lastTs, 'zone')
  assert.deepEqual(seg.procs.lanes.filter((l) => l.name === 'Poison Storm'), [])
  assert.deepEqual(
    (seg.procs.procSkills ?? []).filter((t) => t.lane === 'Poison Storm'),
    []
  )
})

test('W71: a genuine weapon proc in the SAME window still splits', { skip: missing(W71) }, () => {
  const { eng, lastTs } = replay(W71)
  const row = you(eng, lastTs, 'zone')
  // `Condemnation of Nife` fires cast-less at 14:50:15 for 207 — the shape the JOS-167 split
  // exists for. The rain gate is a gate on the SPELL, so it takes nothing away from it.
  assert.deepEqual(lanesFor(row, 'Condemnation of Nife'), ['Condemnation of Nife · proc'])
  assert.deepEqual(laneOf(row, 'Condemnation of Nife · proc'), { hits: 1, total: 207 })
})

test('W71: the fix is a re-keying — the fight total does not move', { skip: missing(W71) }, () => {
  const { eng, lastTs } = replay(W71)
  const seg = segmentOf(eng, lastTs, 'zone')
  const row = you(eng, lastTs, 'zone')
  // 1,354 is what the window totalled BEFORE the change too (both branches measured — see the
  // header). Law 8's tripwire: an attribution fix may not move a point of damage.
  assert.equal(seg.outTotal, 1354)
  assert.equal(row.total, 1354)
  assert.equal(row.categories.reduce((n, c) => n + c.total, 0), row.total, 'Σ categories == source total')
})

// ---------------------------------------------------------------------------------------
// 2. THE ACCEPTANCE ARRANGEMENT — N waves × M targets
// ---------------------------------------------------------------------------------------

// SYNTHETIC, AND SAYING SO. Every line shape is one the log prints (`You begin casting <Spell>.`,
// `You hit <mob> for N points of fire damage by <Spell>.`); the ARRANGEMENT is the reporter's
// spell — `Lava Storm`, which the owner's log has only from OTHER players — at the wave cadence
// his own rains print: wave 1 at +1s, wave 2 at +4s, wave 3 at +7s (measured over 128 of his
// casts), each wave striking both mobs in the radius.
const T = (mmss: string, text: string): string => `[Wed Aug 05 19:${mmss} 2026] ${text}`

const RAIN_CAST = [
  T('32:20', 'You slash a greater kobold for 40 points of damage.'),
  T('32:22', 'You begin casting Lava Storm.'),
  T('32:23', 'You hit a greater kobold for 401 points of fire damage by Lava Storm.'),
  T('32:23', 'You hit a kobold shaman for 401 points of fire damage by Lava Storm.'),
  T('32:26', 'You hit a greater kobold for 401 points of fire damage by Lava Storm.'),
  T('32:26', 'You hit a kobold shaman for 401 points of fire damage by Lava Storm.'),
  T('32:29', 'You hit a greater kobold for 605 points of fire damage by Lava Storm. (Critical)'),
  T('32:29', 'You hit a kobold shaman for 401 points of fire damage by Lava Storm.'),
  T('32:31', 'You slash a greater kobold for 30 points of damage.')
]

const RAIN_LINE_SUM = 401 * 5 + 605

test('a rain cast of N waves × M targets totals exactly the sum of its lines, in ONE lane', () => {
  const { eng, lastTs } = replay(RAIN_CAST)
  const row = you(eng, lastTs, 'zone')

  // THE ACCEPTANCE CRITERION: six damage lines, six hits, and the arithmetic of the lines.
  assert.deepEqual(lanesFor(row, 'Lava Storm'), ['Lava Storm'])
  assert.deepEqual(laneOf(row, 'Lava Storm'), { hits: 6, total: RAIN_LINE_SUM })
  assert.equal(RAIN_LINE_SUM, 2610)

  // Attributed as DIRECT SPELL waves — the `spell` category, never `dot`.
  const spell = row.categories.find((c) => c.category === 'spell')
  assert.ok(spell)
  assert.equal(spell.total, RAIN_LINE_SUM)
  assert.equal(row.categories.find((c) => c.category === 'dot')?.total ?? 0, 0)

  // No proc lane, no ledger firing, no ppm anywhere.
  const seg = segmentOf(eng, lastTs, 'zone')
  assert.deepEqual(seg.procs.lanes.filter((l) => l.name === 'Lava Storm'), [])
  assert.deepEqual((seg.procs.procSkills ?? []).filter((t) => t.lane === 'Lava Storm'), [])
})

test('each AE wave counts for ITS OWN target — the per-mob split adds up', () => {
  const { eng, lastTs } = replay(RAIN_CAST)
  // The "Damage by mob" panel's own input: the fight's event ring, grouped by target.
  const tl = eng.snapshot(lastTs, { selectedId: 'e1', timeline: true }).timeline
  assert.ok(tl, 'the pull has a timeline ring')
  const { rows, total } = groupByTarget(tl)
  const dmg = (re: RegExp): number => rows.find((r) => re.test(r.target))?.total ?? 0
  // Three waves each: the shaman took 401 × 3, the kobold 401 + 401 + 605 plus the two swings
  // that bracket the cast. A wave is never folded into the other target's row.
  assert.equal(dmg(/kobold shaman/i), 1203, 'the shaman took three waves of 401')
  assert.equal(dmg(/greater kobold/i), 401 + 401 + 605 + 40 + 30, 'three waves plus two swings')
  assert.equal(total, RAIN_LINE_SUM + 70, 'and nothing landed anywhere else')
})

test('the pre-fix answer, stated so the regression is legible', () => {
  // With the instant rule applied to a rain, wave 1 was the cast lane and waves 2–3 the proc
  // lane: 2 hits / 402+401 = the phantom row, and a ledger firing count of 2 driving a ppm.
  // The lane list above is the assertion that neither exists any more.
  const { eng, lastTs } = replay(RAIN_CAST)
  assert.deepEqual(laneOf(you(eng, lastTs, 'zone'), 'Lava Storm · proc'), { hits: 0, total: 0 })
})

// ---------------------------------------------------------------------------------------
// 3. THE ROSTER — a registry of 23, audited against the two derivations it came from
// ---------------------------------------------------------------------------------------
//
// JOS-449 widened the roster from 17 to 23 and gave every row a wave COUNT. The three instruments
// and the whole sweep are in `src/main/data/rainSpells.ts`'s header; what is pinned here is that
// the shipped registry still AGREES with the sources it was derived from, so a re-scrape that adds,
// removes or re-words a rain goes red rather than drifting silently.

test('THE CENSUS: 23 rains, named, every one of them three waves', () => {
  assert.deepEqual([...RAIN_SPELL_NAMES], [
    'Avalanche',
    'Blizzard',
    'Cascade of Hail',
    'Energy Storm',
    'Firestorm',
    'Frost Storm',
    'Gale of Poison',
    'Icestrike',
    'Lava Storm',
    'Lightning Storm',
    'Manastorm',
    'Pogonip',
    'Poison Storm',
    'Rain of Blades',
    'Rain of Fire',
    'Rain of Lava',
    'Rain of Spikes',
    'Rain of Swords',
    'Sirocco',
    'Tears of Druzzil',
    'Tears of Prexus',
    'Tears of Solusek',
    'Torrent of Poison'
  ])
  assert.equal(RAIN_SPELL_NAMES.length, 23)
  assert.equal(RAIN_PAGES.length, 23)
  // NOT ONE PAGE IN THE WHOLE CACHE STATES A COUNT OTHER THAN THREE, which is the finding this
  // uniform 3 records. It is spelled per row so a four-wave rain would be expressible; the day one
  // appears, this assertion is the thing that has to be re-argued.
  for (const p of RAIN_PAGES) assert.equal(p.waves, 3, p.name)
  // Every row cites its page. A row that cannot is a hand list, which is the thing this is not.
  for (const p of RAIN_PAGES) {
    assert.ok(p.quote.length > 40, `${p.name} has no page quote`)
    assert.match(p.quote, /wave/i, `${p.name}'s quote does not state waves: ${p.quote}`)
  }
})

test('THE AUDIT: the registry still equals what the committed wikitext cache derives', () => {
  // THE SWEEP, RE-RUN. `scripts/sources/cache/spells` is committed (see .gitignore's note on which
  // caches are), so this costs no network and re-reads the exact source the roster was built from:
  // every damage spell in the catalog whose page `description` states waves. A re-scrape that adds
  // a rain, drops one, or re-words a page out of the pattern fails HERE.
  const derived = derivedRainsFromCache()
  assert.ok(derived.length > 0, 'the wikitext cache is present and parseable')
  assert.deepEqual(derived, [...RAIN_SPELL_NAMES])
})

test('the CAST-MESSAGE instrument is still a strict subset — the two can never quietly diverge', () => {
  // JOS-414 derived 17 rains from `\brains? down\b` over the DB's own cast messages. Those 17 are
  // still derived at runtime and must all be in the registry; the six the registry adds are the
  // ones whose message never says the word ("You are pelted by hailstones.").
  for (const name of MESSAGE_RAIN_NAMES) {
    assert.equal(isRainSpell(name), true, `${name} says it rains down but is not in the registry`)
  }
  assert.equal(MESSAGE_RAIN_NAMES.length, 17)
  const added = RAIN_SPELL_NAMES.filter((n) => !MESSAGE_RAIN_NAMES.includes(n))
  assert.deepEqual(added, ['Avalanche', 'Blizzard', 'Cascade of Hail', 'Icestrike', 'Pogonip', 'Sirocco'])
})

test('the three EXCLUSIONS are out, and each one is out for a stated reason', () => {
  // Reads `AEDuration 7500` like every rain and its page agrees it is applied like one, but: "it
  // does not deal direct damage on each wave, rather it applies a DoT for 3 or 4 ticks". Its only
  // effect line is `Decrease Hitpoints by 125 per tick`, already totalled as a DoT.
  assert.equal(isRainSpell('Strike of Thunder'), false)
  // `AEDuration 7500`, no wave prose, "This AE is cast by Ixiblat Fer and Noble Dojorn".
  assert.equal(isRainSpell('Efreeti Fire'), false)
  // "Targeted AoE / Rain Type spell without waves. Hits up to 4 creatures max." An area spell that
  // belongs in the AOE tab and lands ONCE per target.
  assert.equal(isRainSpell('Circle of Force'), false)
})

test('membership is rank-blind, and the drain family is NOT in it', () => {
  assert.equal(isRainSpell('Lava Storm'), true)
  assert.equal(isRainSpell('lava storm'), true, 'canonical key, so case does not matter')
  assert.equal(isRainSpell('Rain of Fire II'), true, 'a rank suffix folds away (law 2)')
  // The near-miss the anchored regex exists for: 42 lifetaps say `drain`, and `rain` is a
  // substring of every one of them.
  assert.equal(isRainSpell('Siphon Life'), false)
  assert.equal(isRainSpell('Lifedraw'), false)
  // …and an ordinary single-hit nuke of the same school stays eligible.
  assert.equal(isRainSpell('Anarchy'), false)
})

test('the wave COUNT answers the same way, and everything else answers one', () => {
  assert.equal(rainWaves('Frost Storm'), 3)
  assert.equal(rainWaves('frost storm'), 3)
  assert.equal(rainWaves('Rain of Fire II'), 3, 'rank-blind, like membership')
  assert.equal(rainWaves('Anarchy'), 1, 'not a rain: one landing, which is what every caller wants')
  assert.equal(rainWaves('Strike of Thunder'), 1)
})

// ---------------------------------------------------------------------------------------
// 4. THE MAGNITUDE IS PER WAVE — the evidence the x3 rests on
// ---------------------------------------------------------------------------------------

test('the log lands the CATALOG\'S OWN stated magnitude ON EACH WAVE, not split across them', () => {
  // THIS IS THE LOAD-BEARING CLAIM OF JOS-449. `Lava Storm`'s page states one line,
  // `Decrease Hitpoints by 401`, and the synthetic-but-real-shaped cast above lands 401 THREE
  // TIMES per target. If the stated figure were the whole cast, each wave would land ~134.
  //
  // Mined from the owner's real log for the same conclusion (JOS-449's diagnosis, kept here as the
  // record because the casters are third parties and their slices never become fixtures):
  //   Kreljnok's Lava Storm  605 at :23, 605 at :26, 488 at :29  (three waves ~3s apart, one mob)
  //   Nilmeca's Lava Storm   392..409 per landing against the catalog's stated 401
  //   Eklipz's Firestorm     45 / 45 / 45 at 2-6s spacing, trailing 21 (a partial)
  const stated = 401
  const { eng, lastTs } = replay(RAIN_CAST)
  const tl = eng.snapshot(lastTs, { selectedId: 'e1', timeline: true }).timeline
  assert.ok(tl)
  const { rows } = groupByTarget(tl)
  const shaman = rows.find((r) => /kobold shaman/i.test(r.target))
  assert.ok(shaman)
  assert.equal(shaman.total, stated * 3, 'one mob, three waves, the stated magnitude each time')
  assert.equal(shaman.total / stated, rainWaves('Lava Storm'), 'and the roster states that count')
})

test('the SINGLE-TARGET total is waves, and the MAX-TARGET total is the four-hit cap', () => {
  // The two readings the DD tab and the AOE tab take, over the same registry number.
  const waves = rainWaves('Frost Storm')
  assert.equal(aeHits(waves, 1, DEFAULT_AE_MAX_TARGETS), 3)
  assert.equal(aeHits(waves, DEFAULT_AE_MAX_TARGETS, DEFAULT_AE_MAX_TARGETS), 4)
})

/**
 * THE SWEEP, RE-RUN OVER THE COMMITTED CACHE — the audit's instrument.
 *
 * Reads each `<pageid>.wikitext` for its `spellname` and `description`, keeps the ones that are
 * DAMAGE spells in the committed catalog, and answers the ones whose description states a COUNT of
 * waves. The count is what makes the pattern safe: a bare `/waves?/` also matches `Circle of Force`
 * ("Targeted AoE / Rain Type spell without waves"), `Wave of Flame` and `Waves of the Deep Sea`
 * ("with a wave of water"), which is three false positives out of 26.
 *
 * ONE exclusion is applied by NAME, and it is justified in the test above: `Strike of Thunder`
 * really does say "three waves" and really is not one of these. A name list is the right shape for
 * "here is a known counter-example"; it would be the wrong shape for the roster itself.
 */
function derivedRainsFromCache(): string[] {
  const dir = join(dirname(fileURLToPath(import.meta.url)), '..', 'scripts', 'sources', 'cache', 'spells')
  if (!existsSync(dir)) return []
  const damage = new Map(
    (spellsJson as SpellDbFile).spells
      .filter((s) => (s.effects ?? []).some((e) => /^decrease\s+(current\s+)?hit\s?points?/i.test(e)))
      .map((s) => [s.name, s])
  )
  const NOT_A_RAIN = new Set(['Strike of Thunder'])
  const out = new Set<string>()
  for (const file of readdirSync(dir)) {
    if (!file.endsWith('.wikitext')) continue
    const txt = readFileSync(join(dir, file), 'utf8')
    const name = wikiField(txt, 'spellname')
    if (!name || !damage.has(name) || NOT_A_RAIN.has(name)) continue
    if (WAVE_COUNT_RE.test(wikiField(txt, 'description'))) out.add(name)
  }
  return [...out].sort()
}

/**
 * A COUNT of waves, in every spelling the cache actually uses:
 *   `three waves of 125`  `falls in three waves`  `1-3 waves of 540`  `(x3 waves?)`  `Each wave`
 */
const WAVE_COUNT_RE =
  /\b(?:one|two|three|four|five|six|x?\d+(?:\s*-\s*\d+)?)\s+waves?\b|\beach\s+wave\b/i

/** One `| field = value` out of a `Spellpagesmart` template, flattened to a single line. */
function wikiField(txt: string, name: string): string {
  const re = new RegExp(`\\n\\s*\\|\\s*${name}\\s*=\\s*([\\s\\S]*?)(?=\\n\\s*\\|\\s*[a-zA-Z_]+\\s*=|\\n\\}\\})`)
  const m = re.exec(txt)
  return m ? m[1].trim().replace(/\s+/g, ' ') : ''
}

test('the proc gate refuses a rain outright, on every damage type', () => {
  assert.equal(procEligibleDamage('spell', 'Anarchy'), true)
  assert.equal(procEligibleDamage('spell', 'Lava Storm'), false)
  assert.equal(procEligibleDamage('dot', 'Anarchy'), false)
  assert.equal(procEligibleDamage('melee', 'Kick'), false)
  assert.equal(procEligibleDamage('ds', 'thorns'), false)
})
