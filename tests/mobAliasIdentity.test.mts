// JOS-142 — ONE GOD, TWO SPELLINGS, ONE PAGE. The alias-resolution boundary
// (src/main/mobAliases.ts) and what it does to the local merge (mobLookupLocal.mergeLocalKnowledge).
//
// ── THE DEFECT ──────────────────────────────────────────────────────────────────────────────
//
// The log spells the Plane of Fear god `Cazic-Thule`, with a HYPHEN. The wiki, the committed mob
// catalog (page `Cazic Thule (God)`, 18 known drops) and the raid roster all spell it with a
// SPACE. Kills already bridged that — `bossStatus.statusFor` folds every roster `match` alias
// against the kill map — so the reporter's kill registered and looked healthy. LOOT did not: the
// own-loot index files each drop under `mobKey(ev.source)`, the raw LOG spelling, while the boss
// card asks the mob page for `target.name`, the ROSTER spelling. Four items off one god's corpse,
// and the page showed none of them. Reaching the same page BY the log name had the mirror hole:
// your loot but no drop table, and a 7-day `notFound` cached under the hyphenated key.
//
// ── WHERE THE EVIDENCE COMES FROM, AND WHY THERE IS NO FIXTURE ──────────────────────────────
//
// Report 01KZKVGAVAQGYZT2TE54NTT7KH, a 7,184-line slice. `.gitignore` says of `.triage/` that
// those slices are a user's own game log and never enter git, so the slice cannot become a
// fixture (AGENTS.md, "A REPORTER'S SLICE NEVER BECOMES A FIXTURE"). The sanctioned move is to
// INJECT the sentences the owner's log lacks, quoted verbatim and cited by report id — which is
// all this window needs, because the boundary under test is a pure fold over parsed loot events
// and wants no log span around it. The five lines below are the reporter's bytes unchanged;
// unlike mobLifetapPlayer.test.mts the mob's name is NOT swapped, because the mob's name is the
// entire subject.
//
// The owner's own 1.4M-line log cannot reproduce this and that is measured, not an excuse: it has
// no god-Cazic kill at all, and the three Fear gods it does have (Terror, Fright, Dread) are
// name-identical between log and roster, which is exactly why this shipped.
//
// INNORUUK IS COVERED BY CONSTRUCTION, NOT BY EVIDENCE. Its roster row carries the same kind of
// two-spelling `match` list (`Innoruuk, the Prince of Hate` / `Innoruuk`), so it resolves through
// the same table — but which form the LOG prints on a kill line is unobserved in every log this
// repo can read, so nothing here claims to know it (awaiting-sample law). The assertions below
// test the roster row, never an invented log line.
//
// Run: `npm test`.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseEvent } from '../src/main/log/parser'
import { MobLootIndex } from '../src/main/mobLookupParse'
import { ALIASED_TARGET_COUNT, poisonedAliasKeys, resolveMobIdentity } from '../src/main/mobAliases'
import { knowledgeFromCatalog, localMobEntry, mergeLocalKnowledge } from '../src/main/mobLookupLocal'
import bossesJson from '../src/renderer/src/data/eqlegends/bosses.json'
import type { BossData, MobKnowledge, MobSeenDrop } from '../src/shared/types'

const bosses = bossesJson as unknown as BossData

// =============================================================================
// 1. THE ROSTER TABLE — what the boundary knows, and what it refuses to know
// =============================================================================

test('the alias table is exactly the roster targets the roster spells more than one way', () => {
  // MEASURED against the committed bosses.json: 32 targets, 2 of them multi-spelling.
  assert.equal(bosses.targets.length, 32)
  assert.equal(ALIASED_TARGET_COUNT, 2)
  const aliased = bosses.targets.filter((t) => resolveMobIdentity(t.name).aliased).map((t) => t.name)
  assert.deepEqual(aliased, ['Cazic Thule', 'Innoruuk'])
})

test('both spellings of the Fear god resolve to ONE identity, canonical = the roster name', () => {
  const fromLog = resolveMobIdentity('Cazic-Thule')
  const fromRoster = resolveMobIdentity('Cazic Thule')
  assert.equal(fromLog.canonical, 'Cazic Thule')
  assert.equal(fromRoster.canonical, 'Cazic Thule')
  assert.deepEqual(fromLog.keys, ['cazic thule', 'cazic-thule'])
  assert.deepEqual(fromLog, fromRoster)
})

test('Innoruuk resolves through the same table, from the long form the roster states', () => {
  // The roster's own `match` list, nothing else. Which of these the log prints is unobserved.
  const short = resolveMobIdentity('Innoruuk')
  const long = resolveMobIdentity('Innoruuk, the Prince of Hate')
  assert.equal(short.canonical, 'Innoruuk')
  assert.deepEqual(long, short)
  assert.deepEqual(short.keys, ['innoruuk', 'innoruuk, the prince of hate'])
})

test('NO general hyphen rule: a non-roster mob is never normalized into another spelling', () => {
  // `dark-boned skeleton` is a real catalog mob and one of only three hyphenated names in the
  // 7,866-entry catalog. Nothing states it is the same creature as any space-spelled name, so
  // the boundary refuses to say so (JOS-137 constraint 3, world-model law 1).
  const hyphen = resolveMobIdentity('dark-boned skeleton')
  const space = resolveMobIdentity('dark boned skeleton')
  assert.equal(hyphen.aliased, false)
  assert.equal(space.aliased, false)
  assert.deepEqual(hyphen.keys, ['dark-boned skeleton'])
  assert.deepEqual(space.keys, ['dark boned skeleton'])
  // …and a name nothing has ever heard of resolves to itself, one key, unaliased.
  const stranger = resolveMobIdentity('a giant rat')
  assert.deepEqual(stranger, { canonical: 'a giant rat', keys: ['a giant rat'], aliased: false })
})

test('the 30 name-identical roster targets carry ONE key each — the byte-identical gate', () => {
  const identical = bosses.targets.filter((t) => !resolveMobIdentity(t.name).aliased)
  assert.equal(identical.length, 30)
  for (const t of identical) {
    const id = resolveMobIdentity(t.name)
    assert.equal(id.keys.length, 1, `${t.name} should resolve to a single key`)
    assert.equal(id.canonical, t.name)
  }
})

// =============================================================================
// 2. THE OWN-LOOT UNION — the reporter's four items, off the reporter's lines
// =============================================================================

/**
 * The five lines the report's slice ends on, VERBATIM (report 01KZKVGAVAQGYZT2TE54NTT7KH, log
 * lines 7166..7173). Two of the four loots take the auto-disposition COMBINE shape and two take
 * the plain `--You have looted …--` shape; all four name the corpse with a hyphen.
 */
const SLICE_LINES = [
  `[Sun Aug 09 14:03:59 2026] You have slain Cazic-Thule!`,
  `[Sun Aug 09 14:04:06 2026] You looted a Blood Fire +1 from Cazic-Thule's corpse to create a Blood Fire +1`,
  `[Sun Aug 09 14:04:07 2026] You looted a Barbarian Spiritist\`s Hammer +1 from Cazic-Thule's corpse to create a Barbarian Spiritist\`s Hammer +2`,
  `[Sun Aug 09 14:04:13 2026] --You have looted a Puppet Strings from Cazic-Thule's corpse.--`,
  `[Sun Aug 09 14:04:14 2026] --You have looted a Darkwood Trunk from Cazic-Thule's corpse.--`
]

/** The same shapes for a name-identical Fear god, from the SAME slice (lines 6182..6183). */
const DREAD_LINES = [
  `[Sun Aug 09 13:59:05 2026] You have slain Dread!`,
  `[Sun Aug 09 13:59:05 2026] You looted a Crystallized Sulfur from Dread's corpse and sold it for 1 gold, 1 silver and 8 copper.`
]

/** Fold real log lines through the real parser into a real index — no hand-built events. */
function indexOf(lines: string[]): MobLootIndex {
  const idx = new MobLootIndex()
  let seq = 0
  for (const line of lines) {
    const ev = parseEvent(line, seq++)
    if (ev?.kind === 'loot') idx.note(ev.item, ev.source, ev.ts, ev.count ?? 1)
  }
  return idx
}

const ITEMS_OFF_THE_GOD = [
  'Darkwood Trunk',
  'Puppet Strings',
  'Barbarian Spiritist`s Hammer +1',
  'Blood Fire +1'
]

test('the loot files under the LOG spelling — the state the defect starts from', () => {
  const idx = indexOf(SLICE_LINES)
  assert.equal(idx.size, 1)
  assert.deepEqual(idx.drops('Cazic-Thule').map((d) => d.item), ITEMS_OFF_THE_GOD)
  // The pre-fix read the boss card performed. Still empty: nothing widened `mobKey`.
  assert.deepEqual(idx.drops('Cazic Thule'), [])
})

test('dropsAcross unions the two spellings, and one spelling is drops() unchanged', () => {
  const idx = indexOf(SLICE_LINES)
  const id = resolveMobIdentity('Cazic Thule')
  assert.deepEqual(idx.dropsAcross(id.keys), idx.drops('Cazic-Thule'))
  // Single-key identities take the short-circuit and are literally the old read.
  const dread = indexOf(DREAD_LINES)
  const dreadId = resolveMobIdentity('Dread')
  assert.deepEqual(dread.dropsAcross(dreadId.keys), dread.drops('Dread'))
})

test('dropsAcross ADDS counts and takes the later lastTs when both spellings saw an item', () => {
  const idx = new MobLootIndex()
  idx.note('Puppet Strings', 'Cazic-Thule', 2000, 1)
  idx.note('Puppet Strings', 'Cazic Thule', 5000, 2)
  idx.note('Blood Fire', 'Cazic-Thule', 9000, 1)
  const id = resolveMobIdentity('Cazic-Thule')
  assert.deepEqual(idx.dropsAcross(id.keys), [
    { item: 'Puppet Strings', count: 3, lastTs: 5000 },
    { item: 'Blood Fire', count: 1, lastTs: 9000 }
  ] satisfies MobSeenDrop[])
  // The union is a fresh record: neither per-spelling read was mutated by building it (the
  // hyphenated spelling still holds one of each, ties broken by recency).
  assert.deepEqual(idx.drops('Cazic-Thule'), [
    { item: 'Blood Fire', count: 1, lastTs: 9000 },
    { item: 'Puppet Strings', count: 1, lastTs: 2000 }
  ])
})

// =============================================================================
// 3. THE TWO ENTRANCES — what the mob page now gets, from either name
// =============================================================================

/** What `lookupMob` does on its LOCAL-FIRST path: resolve, read the catalog, merge the locals. */
function pageFor(display: string, loot: MobLootIndex): MobKnowledge {
  const id = resolveMobIdentity(display)
  const entry = localMobEntry(id.canonical)
  assert.ok(entry, `catalog should hold ${id.canonical}`)
  return mergeLocalKnowledge(knowledgeFromCatalog(display, entry), id, loot)
}

test('FORWARD HALF: the boss card asks with the roster name and gets the log-name loot', () => {
  const k = pageFor('Cazic Thule', indexOf(SLICE_LINES))
  assert.deepEqual(k.dropsSeen?.map((d) => d.item), ITEMS_OFF_THE_GOD)
  assert.equal(k.dropsWiki?.length, 18)
  assert.equal(k.page, 'Cazic Thule (God)')
})

test('MIRROR HALF: entering by the log name gets the wiki table, and still READS as the log', () => {
  const k = pageFor('Cazic-Thule', indexOf(SLICE_LINES))
  // Law 2: canonicalize at the boundary, DISPLAY RAW. The page heading is the log's spelling.
  assert.equal(k.name, 'Cazic-Thule')
  assert.equal(k.page, 'Cazic Thule (God)')
  assert.equal(k.dropsWiki?.length, 18)
  assert.deepEqual(k.dropsSeen?.map((d) => d.item), ITEMS_OFF_THE_GOD)
})

test('both entrances produce the same record apart from the name they were asked with', () => {
  const loot = indexOf(SLICE_LINES)
  const fromLog = { ...pageFor('Cazic-Thule', loot), name: '' }
  const fromRoster = { ...pageFor('Cazic Thule', loot), name: '' }
  assert.deepEqual(fromLog, fromRoster)
})

test('HONESTY SPLIT: alias-gathered loot is never promoted into the wiki drop table', () => {
  // MobPage.tsx's own rule, re-derived here: an observed item the page does not list stays in
  // the separate "Also looted by you" list (JOS-137 constraint 7). Two of the four match a wiki
  // row and annotate it; the two carrying a `+N` tier suffix do not, and are shown as YOURS.
  const k = pageFor('Cazic Thule', indexOf(SLICE_LINES))
  const wikiKeys = new Set((k.dropsWiki ?? []).map((d) => d.item.toLowerCase()))
  const extra = (k.dropsSeen ?? []).filter((d) => !wikiKeys.has(d.item.toLowerCase()))
  assert.deepEqual(extra.map((d) => d.item), [
    'Barbarian Spiritist`s Hammer +1',
    'Blood Fire +1'
  ])
  // …and the wiki table itself gained nothing: 18 rows in, 18 rows out.
  assert.equal(k.dropsWiki?.length, 18)
})

test('REGRESSION GATE: a name-identical roster target comes out byte-identical', () => {
  const loot = indexOf(DREAD_LINES)
  const id = resolveMobIdentity('Dread')
  const entry = localMobEntry('Dread')
  assert.ok(entry)
  const now = mergeLocalKnowledge(knowledgeFromCatalog('Dread', entry), id, loot)
  // What the pre-JOS-142 merge computed: a single-name loot read and a single-name quest read.
  const before: MobKnowledge = { ...knowledgeFromCatalog('Dread', entry) }
  const seen = loot.drops('Dread')
  if (seen.length) before.dropsSeen = seen
  assert.deepEqual(now, before)
  assert.deepEqual(now.dropsSeen?.map((d) => d.item), ['Crystallized Sulfur'])
})

// =============================================================================
// 4. THE POISONED NEGATIVE — repairing what the old build cached
// =============================================================================

test('a 7-day notFound cached under the log spelling is named for deletion, once', () => {
  const id = resolveMobIdentity('Cazic-Thule')
  const cache = new Map([
    ['cazic-thule', { data: { notFound: true } }],
    ['a giant rat', { data: { notFound: true } }]
  ])
  assert.deepEqual(poisonedAliasKeys(id, cache), ['cazic-thule'])
  // The deletion mobLookup performs, and then there is nothing left to repair.
  for (const k of poisonedAliasKeys(id, cache)) cache.delete(k)
  assert.deepEqual(poisonedAliasKeys(id, cache), [])
  // An unrelated mob's negative is not this identity's business.
  assert.equal(cache.has('a giant rat'), true)
})

test('an offline miss is repaired too; a cached POSITIVE under an alias key is left alone', () => {
  const id = resolveMobIdentity('Cazic Thule')
  assert.deepEqual(
    poisonedAliasKeys(id, new Map([['cazic-thule', { data: { offline: true } }]])),
    ['cazic-thule']
  )
  // A page somebody really fetched and parsed. Nothing about this defect makes it false.
  assert.deepEqual(poisonedAliasKeys(id, new Map([['cazic-thule', { data: {} }]])), [])
})

test('the CANONICAL key is never repaired, and an unaliased mob is never touched', () => {
  const id = resolveMobIdentity('Cazic Thule')
  // A negative under `cazic thule` is a real verdict about the name the wiki actually knows.
  assert.deepEqual(poisonedAliasKeys(id, new Map([['cazic thule', { data: { notFound: true } }]])), [])
  const rat = resolveMobIdentity('a giant rat')
  assert.deepEqual(poisonedAliasKeys(rat, new Map([['a giant rat', { data: { notFound: true } }]])), [])
})
