// planner/gear.ts — the GEAR PLANNER's candidate row: one equippable item, described in NUMBERS
// (JOS-283, phase 2 of the gear planner; the builder is src/main/planner/gearIndex.ts).
//
// THE ONE DESIGN RULE THIS FILE EXISTS TO SERVE (the ticket's, and every other choice follows it):
// every sort and filter key must be computable AT ANY PLUS-STATE by a PURE MAP over the rows —
// `rows.map((r) => scaleGearRow(r, state))` — never by rebuilding the index. So the row carries a
// NUMERIC BASE VECTOR (`stats`) rather than the item's stat-block text, and `gearScale.ts` maps
// that vector through phase 0's own rules (src/shared/itemUpgrade.ts). Rebuilding 6,814 rows out
// of the 8.6 MB corpus per slider tick is the thing this shape makes impossible.
//
// WHAT A ROW IS NOT. It is a SEARCH index, not an item card: the full stat block, the flags prose,
// the recipes and the drop story already have a door (`IPC.itemsLookup` → `ItemKnowledge`, which
// the ItemWindow already draws). So a value the vector cannot read as a number is COUNTED in the
// build census (`GearBuildStats`) rather than carried as text — law 1 is satisfied by the census
// making the omission visible and test-pinnable, not by every row dragging its own prose around.
//
// THE STAT VOCABULARY IS CLOSED AND MEASURED (census over the committed corpus, 2026-08-13, the
// 2026-08-05 scrape — 11,161 distinct pages). The stat/save keys the corpus states, by frequency:
//   STR 1741 · HP 1375 · WIS 1341 · MANA 1282 · SV MAGIC 1279 · STA 1244 · INT 1199 · DEX 1086 ·
//   SV FIRE 1045 · SV COLD 1042 · AGI 952 · SV DISEASE 951 · SV POISON 949 · CHA 897 ·
//   CHARGES 443 · HASTE 64 · END 30 · COOLDOWN 9 · CAST TIME 5 · REQUIRED LEVEL 5 · REGEN 5 ·
//   SV VOID 2 · ATTACK 1 · MANA REGEN 1
// plus the structural numeric fields `parseStatsBlock` keys separately: AC 4600, WT 11143,
// DMG/Atk Delay 1709, Dmg Bon, Backstab, Range 212.
// `GEAR_STAT_KEYS` is the COMPARISON subset of that census — the keys a player sorts and
// threshold-filters gear by. CHARGES / COOLDOWN / CAST TIME / REQUIRED LEVEL are deliberately out:
// they are per-item facts, not gear comparisons, and a "sort by charges" column would rank six
// hundred items by a field twenty of them state. Every key left out is COUNTED by key in
// `GearBuildStats.unindexedStatKeys`, and `tests/gearIndex.test.mts` pins that census — so a
// rescrape that invents a stat spelling turns the suite red instead of silently dropping a column.
//
// KEYS ARE `itemUpgrade.normalizeStatKey`'s SPELLING, not the corpus's: MANA → MP, REGEN →
// HP_REGEN, ENDURANCE → END. That is not a preference — it is the vocabulary phase 0's
// `upgradeStatClass` dispatches on, and a vector keyed any other way could not be scaled without
// re-stating the alias table (which this file, like effectIndex.ts, never does).

import type { ClassAbbr } from '../classCombo'
import type { ItemEffectKind } from '../itemStats'
import type { EffectFacts } from './effectText'
import type { EraDerivation } from './era'
import type { EquipSlot, ExtractTier, SocketType } from './types'

// ---- the numeric vector ------------------------------------------------------------------

/**
 * The comparison stats, in the order a table draws its columns: AC, the seven attributes, the
 * three pools, the three regens, Attack and Haste, the ten saves, then the weapon block and
 * weight. Closed on purpose — see the census in the header.
 *
 * The ten `SV_*` keys are the full save vocabulary `shared/itemStats.ts SAVE_KEYS` recognizes,
 * not just the eight the corpus states today: SV_VOID is SYNTHESIZED by an upgrade (phase 0's
 * `synthesizesVoidSave`), so a scaled vector can carry a key no base row ever did, and the two
 * that no item states at all cost one union member each rather than a future migration.
 */
export const GEAR_STAT_KEYS = [
  'AC',
  'STR',
  'STA',
  'AGI',
  'DEX',
  'WIS',
  'INT',
  'CHA',
  'HP',
  'MP',
  'END',
  'HP_REGEN',
  'MANA_REGEN',
  'END_REGEN',
  'ATTACK',
  'HASTE',
  'SV_FIRE',
  'SV_COLD',
  'SV_MAGIC',
  'SV_DISEASE',
  'SV_POISON',
  'SV_VOID',
  'SV_CORRUPTION',
  'SV_CHROMATIC',
  'SV_PRISMATIC',
  'SV_ALL',
  'DMG',
  'DELAY',
  'DMG_BONUS',
  'BACKSTAB',
  'RANGE',
  'WEIGHT'
] as const

export type GearStatKey = (typeof GEAR_STAT_KEYS)[number]

const GEAR_STAT_KEY_SET: ReadonlySet<string> = new Set<string>(GEAR_STAT_KEYS)

/** Is this (already `normalizeStatKey`-folded) key one the vector indexes? */
export function isGearStatKey(key: string): key is GearStatKey {
  return GEAR_STAT_KEY_SET.has(key)
}

/**
 * One item's numbers. ABSENT MEANS THE ITEM STATED NONE (law 1) — never zero: an item with no
 * `HASTE:` line is not an item with 0% haste, and a filter that reads the two the same way would
 * rank every plain sword above every haste item on "haste ascending".
 *
 * `HASTE` is a PERCENT (`HASTE: +41%`, 64 pages) and `WEIGHT` is the only non-integer key
 * (`WT: 2.5`). Everything else is a plain integer.
 */
export type GearStats = Partial<Record<GearStatKey, number>>

/** The percent-valued keys — a display concern, and the reason `gearStatNumber` reads a `%`. */
export const GEAR_PERCENT_STAT_KEYS: readonly GearStatKey[] = ['HASTE']

// ---- what an effect looks like on a gear row ----------------------------------------------

/**
 * One effect line, read the way the exaltation planner reads it (JOS-283 brief: "same as exalts").
 * `socketTypeOf` decides the socket, `extractionTier` the merge tier, `isHasteEffect` the lock and
 * `parseFocusEffect` the focus family — every one of them the same call `effectIndex.ts` makes, so
 * the two indices can never disagree about what a proc is.
 *
 * TWO DELIBERATE DIVERGENCES FROM THE DONOR ROW, both because the questions differ. The donor index
 * answers "what can I EXTRACT", so it drops socketless `Effect:` lines and drops summoned/GM items
 * entirely (V9). A gear row answers "what does this item DO", and a worn Regeneration line is a
 * reason to wear the item whether or not it can ever be donated — so socketless lines are KEPT with
 * `socket` absent (the wiki did not say; law 1), and no item is excluded for being unfarmable.
 */
export interface GearEffect extends EffectFacts {
  /** effect name as written ("Improved Healing III") */
  name: string
  /** the parenthetical as written ("Combat, Casting Time: Instant") */
  detail?: string
  reqLevel?: number
  /** the corpus's own kind, verbatim — `combat` is what the wiki spells a proc (D2) */
  kind: ItemEffectKind
  /** the exaltation socket; ABSENT when the line named none (a bare `Effect:`) */
  socket?: SocketType
  /** merge tier this effect extracts at (R1) — absent exactly when `socket` is */
  tierRequired?: ExtractTier
  /** R3 — attack haste never travels as an exaltation. Present only when true. */
  hasteLocked?: true
  /** V5 — the focus family and its rank; focus rows only, same as the donor index */
  family?: string
  familyTier?: number
}

// ---- the row -------------------------------------------------------------------------------

/**
 * ONE EQUIPPABLE ITEM. "Equippable" is `slots.length > 0` after `normalizeSlotTokens` and the
 * curated slot repair (JOS-67) — 6,884 of the corpus's 11,213 pages state a `Slot:`, and three more
 * arrive from the curated layer. An item the corpus places nowhere is not a gear candidate; it is
 * still in item lookup, and still a `PlannerItemHit` for the exaltation board's host picker.
 */
export interface GearRow {
  /** `itemKey(name)` — the corpus key every other index joins on (donors, ownership, loot) */
  key: string
  name: string
  /** precomputed lowercase name — the standing search law's "computed once, not per keystroke" */
  searchKey: string
  iconId?: number
  /** normalized equip slots, at least one (that is what makes the row exist) */
  slots: EquipSlot[]
  /** normalized classes; `[]` = the page stated none or stated it unreadably (UNKNOWN, never "nobody") */
  classes: ClassAbbr[]
  /**
   * Race tokens, upper-cased and de-punctuated, VERBATIM otherwise (`['ALL']`,
   * `['ALL', 'EXCEPT', 'IKS']`). No complement is computed and no race vocabulary is claimed:
   * unlike classes there is no measured closed race table in this repo, and the census is 12
   * tokens over 11k pages (ALL 10098 · IKS 335 · TRL 325 · OGR 325 · BAR 299 · NONE 218 ·
   * EXCEPT 191 · ELF 12 · DEF 1 · HEF 1). Inventing the sixteen-race complement from that would
   * be exactly the fuzzy join law 12 refuses.
   */
  races: string[]
  /** the page-top `{{X Era}}` banner's token, VERBATIM — `shared/planner/era.ts` decides meaning */
  eraTag?: string
  /**
   * LAYER 3 (JOS-333): the ONE stated acquisition edge that points at out-of-era content, present
   * only on rows whose own page and own drop zones state no era at all. The rules, the census and
   * the refusals are in `src/main/planner/eraDerive.ts`; `plannerData.donorEra` reads it, and only
   * where its own verdict came back `unknown`, so this field can never overrule a witness.
   */
  eraDerived?: EraDerivation
  /** the stat block's flag phrases, source order ("Magic Item", "Lore Item", "No Drop") */
  flags: string[]
  quest: boolean
  playerCrafted: boolean
  /** weapon skill as written ("1H Slashing", "Archery"); absent on non-weapons */
  skill?: string
  /** `Range:` verbatim when it is NOT a single number ("50 / 75 / 100", 30 arrow pages) */
  rangeText?: string
  /** THE BASE numeric vector — the whole point of the row (see `gearScale.ts`) */
  stats: GearStats
  /** every effect line the page states, socketed or not */
  effects: GearEffect[]
  /**
   * Phase 0's `synthesizesVoidSave` answered ONCE at build: does an upgrade of this item grant the
   * synthetic `SV VOID: +full` line? Present only when true.
   *
   * It is a fact about the BASE block (two or more distinct trigger fields, and no SV VOID of its
   * own) and depends on the state only through `full > 0` — so caching it here is what lets the
   * scaler reproduce `scaleStatBlock` EXACTLY without re-stating the trigger table, and without
   * the row carrying the block the rule reads.
   */
  voidSynth?: true
  /**
   * What the ITEM PAGE says about where this drops (`|dropsfrom`) — carried for the same reason
   * `PlannerDonor` carries it: it is a second witness beside the renderer's mob-catalog inversion,
   * and a consumer should not need a second index to answer "where do I get this". Absent when the
   * page carried none; an entry's `zone` is absent when the page listed the mob under no heading.
   */
  wikiSources?: { mob: string; zone?: string }[]
  /**
   * WHERE IT DROPS, FOLDED AT BUILD (fork decision, kaltinril 2026-08-25) — both witnesses merged
   * (`shared/itemSources.mergeItemSources`: the mob catalog's `|known_loot` inversion and the
   * page's own `wikiSources` above) and folded into the Gear tab's three columns by
   * `dropDetails`. The four arrays are ALIGNED: `dropLevels[i]` and `dropPages[i]` belong to
   * `dropMobs[i]`, `''` where the catalog stated none.
   *
   * ON THE WIRE rather than derived per window, which is data-server ruling 4 (docs/plans/
   * data-server.md: *the renderer never munges domain data* — views arrive render-ready). The
   * renderer folded these itself from 2026-08-15 to 2026-08-25, 6,814 rows per fetch. ABSENT
   * when nobody names the item (a quest reward, a crafted item) — an empty array would be this
   * index inventing an answer where the catalog stated none.
   */
  dropMobs?: string[]
  dropZones?: string[]
  dropLevels?: string[]
  dropPages?: string[]
  /**
   * Reads as a shield (`renderer/features/gear/gearFilter.isShieldLike`'s rule — SECONDARY slot
   * and a shield word in the name or a `Skill: Shield` line), answered ONCE at build so the search
   * word and the Weapon-type pick come off one flag. Present only when true. MEASURED 2026-08-25:
   * 130 rows (the census the `shieldRows` stat pins).
   */
  shield?: true
}

// ---- the served payload ---------------------------------------------------------------------

/**
 * THE WIRE VERSION, and the discipline that goes with it (the same one `ExaltPlan` fields follow):
 * a field ADDED to `GearRow` or `GearStats` is OPTIONAL and every reader defaults, so it does NOT
 * bump this number — an older renderer simply does not read it, which is not a failure. The bump is
 * reserved for a change that makes an existing field mean something ELSE (a key renamed, a unit
 * changed, a stat vector that stops being base values). A renderer that meets a version it does not
 * know refuses the payload rather than mis-drawing it.
 */
export const GEAR_INDEX_VERSION = 1

/** What the build SAW — the corpus is the thing under test (the `PlannerBuildStats` precedent). */
export interface GearBuildStats {
  /** distinct item PAGES walked */
  pages: number
  /** `|itemname` alias keys skipped because their page was already read */
  aliasKeys: number
  /** pages the corpus places in no slot — walked, counted, and not rows */
  slotless: number
  /** rows dropped because another page already described the same item key */
  duplicatePages: number
  /** emitted rows carrying a DMG or Atk Delay (the weapon subset) */
  weaponRows: number
  /** emitted rows carrying at least one effect line */
  effectRows: number
  /** effect lines whose name matched a spell page (the V6 one-liner join) */
  spellJoined: number
  /** effect lines the wiki gave no socket (kept, `socket` absent) */
  socketless: number
  /** rows that gain the synthetic SV VOID line when upgraded */
  voidSynthRows: number
  /** stat values read as a plain integer (`statInteger`) */
  statValues: number
  /** stat values read as a percent (`+41%` — HASTE, and the census pins that) */
  percentValues: number
  /** `Range:` values that were not a single number, kept verbatim in `rangeText` */
  rangeTexts: number
  /** rows carrying a LAYER 3 acquisition-edge verdict (JOS-333, `eraDerive.ts`) */
  eraDerivedRows: number
  /** rows naming at least one drop mob after the two-witness merge (`dropMobs` present) */
  dropRows: number
  /** rows the shield rule accepts (`shield: true`) — 130 on the 2026-08-25 census */
  shieldRows: number
  /** stat keys the vector does not index, by normalized key — the law-1 census (see the header) */
  unindexedStatKeys: Record<string, number>
  /** stat values no parse could read, by normalized key */
  unreadableStatKeys: Record<string, number>
  /** slot tokens `normalizeSlotTokens` did not recognize, verbatim — must stay empty */
  unknownSlotTokens: string[]
}

/** The one answer `IPC.gearIndex` serves. Built once in main, fetched once by the renderer. */
export interface GearIndexPayload {
  /** `GEAR_INDEX_VERSION` at build time */
  version: number
  /** the corpus's own `scrapedAt` — WHEN the data is from, never when the index was built */
  scrapedAt: string
  rows: GearRow[]
  stats: GearBuildStats
}
