// mobAliases.ts — THE ONE PLACE THIS TREE SAYS "these two spellings are one creature" (JOS-142).
//
// THE DEFECT IT EXISTS FOR (characterized in JOS-137, reproduced from report
// 01KZKVGAVAQGYZT2TE54NTT7KH): the log spells the Plane of Fear god `Cazic-Thule` with a HYPHEN.
// The wiki, the committed mob catalog (page `Cazic Thule (God)`, 18 known drops) and the raid
// roster all spell it with a SPACE. Kills already bridged that divergence, because
// `bossStatus.statusFor` folds every roster `match` alias against the kill map. LOOT did not: the
// own-loot index files each drop under `mobKey(ev.source)` — the raw LOG spelling — while the boss
// card asks the mob page for `target.name`, the ROSTER spelling. Four items looted off one god's
// corpse, and the page showed none of them. The mirror entrance (reaching the page BY the log
// name) had the opposite hole: your loot but no drop table, plus a 7-day negative cached under the
// hyphenated key.
//
// WHY A TABLE AND NOT A RULE. `RaidTarget.match` in bosses.json is the only place in the tree
// where the two spellings are already STATED to be the same creature. Reading that statement is
// grounded evidence; string-massaging a hyphen into a space would be an invented normalization
// applied to 7.9k catalog mobs that never asked for it (world-model law 1, the awaiting-sample
// law, and JOS-137 constraints 2 and 3). So this file is a lookup over committed data and
// contains no name arithmetic of any kind.
//
// WHY NOT WIDEN `mobKey`. It is the identity key for the loot index, the consider ring, the
// kill-map re-key AND the wiki identity gate that stops a cousin's drop table being hung off this
// mob. Folding hyphen to space there would redefine what counts as the same MOB everywhere, and
// every collision it introduced would be silent and global (JOS-137 constraint 1).
//
// THE BYTE-IDENTICAL GUARANTEE (JOS-137 constraint 4). A roster target whose `name` and every
// `match` name collapse to ONE `mobKey` is not indexed here at all — it never enters the map, so
// `resolveMobIdentity` hands back the trivial identity and every caller runs the code path it ran
// before. MEASURED against the committed roster: 32 targets, exactly 2 aliased (Cazic Thule,
// Innoruuk), 30 untouched.
//
// Electron-free and dataset-only, like mobLookupLocal.ts, so the node test runner can drive the
// SHIPPED roster directly. bosses.json is ES-imported so electron-vite inlines it into the main
// bundle (a path-relative readFile would miss in out/main/ — AGENTS.md toolchain note).

import { mobKey } from './mobLookupParse'
import type { BossData } from '../shared/types'
import bossesJson from '../renderer/src/data/eqlegends/bosses.json'

/**
 * One creature, and every spelling the roster states for it.
 *
 * `canonical` is the name to ASK the catalog and the wiki with — the roster's own `name`, which
 * is the spelling those two sources use. It is NEVER what the page DISPLAYS: callers keep handing
 * the raw name they were given to `knowledgeFromCatalog`, so a page reached by the log spelling
 * still reads "Cazic-Thule" (world-model law 2 / JOS-137 constraint 5).
 *
 * `keys` is every `mobKey` this creature answers to, canonical key FIRST. For an unaliased name
 * it is the single key `mobKey(name)`, which is why the union reads below degrade exactly to the
 * single-key reads they replaced.
 */
export interface MobIdentity {
  canonical: string
  keys: string[]
  /** the roster stated more than one spelling for this creature */
  aliased: boolean
}

const bossData = bossesJson as unknown as BossData

/**
 * Every alias key of every MULTI-SPELLING roster target → its identity. Built once at import.
 *
 * Targets whose spellings all collapse to one key are SKIPPED (the byte-identical guarantee
 * above). A key claimed by two different targets keeps the first — the roster is curated and has
 * no such collision today, but silently merging two gods on a later scrape is not a thing this
 * boundary should be able to do by accident.
 */
const identityByKey = new Map<string, MobIdentity>()
for (const t of bossData.targets ?? []) {
  const keys: string[] = []
  for (const spelling of [t.name, ...(t.match ?? [])]) {
    const k = mobKey(spelling)
    if (k && !keys.includes(k)) keys.push(k)
  }
  if (keys.length < 2) continue
  const id: MobIdentity = { canonical: t.name, keys, aliased: true }
  for (const k of keys) if (!identityByKey.has(k)) identityByKey.set(k, id)
}

/** How many roster targets the roster spells more than one way (diagnostic / regression pin). */
export const ALIASED_TARGET_COUNT = new Set(identityByKey.values()).size

/**
 * THE BOUNDARY. Resolve any mob name — a log spelling, a roster spelling, a catalog spelling — to
 * the one identity the roster states, or to itself when the roster has never heard of it.
 *
 * Total and allocation-light: an unaliased name (7.9k catalog mobs and everything else) gets a
 * fresh trivial identity whose `canonical` is the name it was handed, so every downstream read is
 * the read it was before.
 */
export function resolveMobIdentity(name: string): MobIdentity {
  const key = mobKey(name)
  const known = identityByKey.get(key)
  if (known) return known
  return { canonical: name, keys: key ? [key] : [], aliased: false }
}

/** The one fact the cache repair below needs about a stored wiki record. */
export interface CachedVerdict {
  notFound?: boolean
  offline?: boolean
}

/**
 * WHICH CACHED ENTRIES THIS IDENTITY POISONED (JOS-142; JOS-137 constraint 8).
 *
 * Before the boundary existed, opening a raid god's page BY THE LOG SPELLING resolved the
 * roster/wiki page, failed the identity gate against the hyphenated key, and persisted a
 * `notFound` that stood for SEVEN DAYS. Resolving through the canonical name already ROUTES
 * AROUND those entries, but a wrong answer left sitting in a user's userData is not repaired by
 * not reading it, so mobLookup deletes exactly what this returns.
 *
 * Two deliberate limits. Only NON-canonical keys: the canonical name's own negative is a real
 * verdict about the name the wiki actually knows. And only NEGATIVES — `notFound` or an
 * `offline` miss, the two things the old gate could have written wrongly here. A cached POSITIVE
 * under an alias key is a page somebody really fetched and parsed; nothing about this defect
 * makes it false, so it is left alone.
 *
 * Pure and structural (a plain key → `{ data }` reader) so it is node-testable — mobLookup.ts
 * imports electron's `app` for the cache path and cannot be loaded under tsx.
 */
export function poisonedAliasKeys(
  id: MobIdentity,
  cache: ReadonlyMap<string, { data: CachedVerdict }>
): string[] {
  if (!id.aliased) return []
  const canonical = mobKey(id.canonical)
  const out: string[] = []
  for (const key of id.keys) {
    if (key === canonical) continue
    const stale = cache.get(key)
    if (!stale) continue
    if (stale.data.notFound !== true && stale.data.offline !== true) continue
    out.push(key)
  }
  return out
}
