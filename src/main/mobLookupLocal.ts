// mobLookupLocal.ts — the COMMITTED-DATASET half of mob knowledge (Task #63).
//
// Split out from mobLookup.ts (which imports electron `app` for the userData cache) so the two
// local-first indexes are importable in the node test runner, exactly the way itemLookupParse.ts
// is split from itemLookup.ts. No network, no cache, no electron: just the two scraped JSON
// datasets and the lookups over them.
//
//   LOCAL 1 — mobs.json  (scripts/scrape-mobs.ts): the DEFINITIVE drop table. The wiki states
//             what a mob can drop; that is static content, so it is scraped once and committed
//             rather than fetched per `/con`. This is why a consider answers instantly and
//             offline, and why `mobLookup`'s live wiki call is only a fallback for mobs the
//             catalog doesn't have yet.
//   LOCAL 2 — quests.json (scripts/scrape-quests.ts): `relatedNpcs`, the quests that name a mob.
//
// Both JSONs are ES-imported so electron-vite INLINES them into the main bundle — a
// path-relative readFile would miss in out/main/ (AGENTS.md toolchain note).

import { type MobLootIndex, mobKey } from './mobLookupParse'
import type { MobIdentity } from './mobAliases'
import type { MobData, MobDrop, MobEntry, MobKnowledge, MobQuestUse, QuestData } from '../shared/types'
import mobsJson from '../renderer/src/data/eqlegends/mobs.json'
import questsJson from '../renderer/src/data/eqlegends/quests.json'

// ---- LOCAL 1: the scraped mob catalog (the definitive drop table) ---------------

const mobData = mobsJson as unknown as MobData

/**
 * Index the committed mob catalog by canonical name. Keyed BOTH ways a mob can be named:
 *   - the page's `|name` (the IN-GAME name, which is what a consider line prints), and
 *   - the wiki PAGE TITLE, which for most mobs is the same string title-cased ("A Froglok Gaz
 *     Knight" redirects to "A froglok gaz knight") but is occasionally the only spelling.
 * `mobKey` folds casing and the three apostrophe glyphs, so the two keys collapse for most
 * mobs. The page-title pass runs SECOND and only fills gaps, so a real mob's own name can
 * never be displaced by another page's title.
 */
const mobByName = new Map<string, MobEntry>()
for (const m of mobData.mobs ?? []) {
  const key = mobKey(m.name)
  if (key && !mobByName.has(key)) mobByName.set(key, m)
}
for (const m of mobData.mobs ?? []) {
  const key = mobKey(m.page)
  if (key && !mobByName.has(key)) mobByName.set(key, m)
}

/** The catalog's entry for a mob, or null when it has none (⇒ try the live wiki fallback). */
export function localMobEntry(name: string): MobEntry | null {
  return mobByName.get(mobKey(name)) ?? null
}

/** How many mobs the committed catalog holds (diagnostic / startup log). */
export const MOB_CATALOG_SIZE = mobData.mobs?.length ?? 0

/**
 * Turn a catalog entry into the WIKI half of a knowledge record. The catalog is compact by
 * design (names only — see MobEntry), so a per-drop `rarity` is simply ABSENT here; the live
 * fallback is where one comes from. Absent is honest; a made-up rarity would not be.
 */
export function knowledgeFromCatalog(display: string, e: MobEntry): MobKnowledge {
  const out: MobKnowledge = { name: display, page: e.page, cached: true }
  if (e.level) out.levelText = e.level
  if (e.zones?.length) out.zone = e.zones.join(', ')
  if (e.drops?.length) out.dropsWiki = e.drops.map((item): MobDrop => ({ item }))
  return out
}

// ---- LOCAL 2: quest catalog cross-ref (relatedNpcs) ----------------------------

const questData = questsJson as unknown as QuestData

/**
 * Index the scraped quest catalog by mob name → the quests that name it under "Related NPCs".
 * 764 of the 905 catalog quests list at least one, covering 1,121 distinct NPC names — which is
 * how a conned mob can carry a quest badge with zero network.
 *
 * Keyed by `mobKey` so the catalog's casing ("A Giant Rat") folds onto the log's ("a giant rat")
 * — the same canonicalize-at-the-boundary rule the KillMap uses (world-model law 2).
 */
const questsByMob = new Map<string, MobQuestUse[]>()
for (const q of questData.quests ?? []) {
  for (const npc of q.relatedNpcs ?? []) {
    const key = mobKey(npc)
    if (!key) continue
    const uses = questsByMob.get(key) ?? []
    if (!uses.some((u) => u.quest === q.name)) {
      uses.push({ quest: q.name, page: q.page, giver: q.giver, zone: q.startZone })
    }
    questsByMob.set(key, uses)
  }
}

/** Quests the LOCAL catalog ties to this mob. Null when it knows none (never an empty claim). */
export function localMobQuests(name: string): MobQuestUse[] | null {
  const uses = questsByMob.get(mobKey(name))
  return uses?.length ? uses : null
}

/**
 * Quests the LOCAL catalog ties to this CREATURE, under every spelling the roster states for it
 * (JOS-142). De-duped by quest name; an unaliased identity is one key, so this is exactly the
 * single `localMobQuests` call it has always been.
 */
function identityQuests(id: MobIdentity): MobQuestUse[] | null {
  if (!id.aliased) return localMobQuests(id.canonical)
  const merged: MobQuestUse[] = []
  for (const key of id.keys) {
    for (const q of localMobQuests(key) ?? []) {
      if (!merged.some((x) => x.quest.toLowerCase() === q.quest.toLowerCase())) merged.push(q)
    }
  }
  return merged.length ? merged : null
}

// ---- the LOCAL merge (mobLookup's every-read step) -----------------------------

/**
 * Attach the two LOCAL sources to a (possibly cached) wiki record. Done on EVERY read, never
 * baked into the cache: your own loot history changes with every corpse, and the quest catalog
 * ships with the app, so caching either would immediately be stale (JOS-137 constraint 6).
 *
 * Reads by IDENTITY rather than by the one name the caller happened to hold (JOS-142). The
 * own-loot index files a drop under the corpse's LOG name and the boss card asks with the ROSTER
 * name; `id.keys` is the roster's own statement that those are one creature, so the union is
 * evidence rather than a guess. What comes back is still `dropsSeen` — YOUR observations — and
 * the mob page keeps showing anything the wiki page does not list under its own separate "Also
 * looted by you" heading, so alias-gathered loot is never dressed up as documented drops
 * (JOS-137 constraint 7).
 *
 * LIVES HERE, not in mobLookup.ts, so the node test runner can drive the real merge: mobLookup
 * imports electron's `app` for the userData cache path and cannot be loaded under tsx, and an
 * untestable merge is exactly where the JOS-137 defect sat unseen (the suggestions.ts precedent).
 * `loot` is passed in for the same reason — production hands it mobLookup's shared singleton.
 */
export function mergeLocalKnowledge(
  base: MobKnowledge,
  id: MobIdentity,
  loot: MobLootIndex
): MobKnowledge {
  const out: MobKnowledge = { ...base }
  const seen = loot.dropsAcross(id.keys)
  if (seen.length) out.dropsSeen = seen
  else delete out.dropsSeen
  const quests = identityQuests(id)
  // The wiki page's own `|related_quests` links and the catalog's `relatedNpcs` are two views of
  // the same relation, so de-dupe by quest name; local wins (it carries the giver + zone).
  if (quests) {
    const merged = [...quests]
    for (const u of base.quests ?? []) {
      if (!merged.some((x) => x.quest.toLowerCase() === u.quest.toLowerCase())) merged.push(u)
    }
    out.quests = merged
  }
  return out
}
