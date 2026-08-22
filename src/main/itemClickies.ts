// THE HELD-CLICKY GATE (JOS-438, report 01M0BS3FJW1YWP6ZNMM41HCMS2) — "which spells can a
// cast-less first-person line of YOURS have come from an item you CLICKED".
//
// THE DEFECT. An instant item click prints exactly ONE line about its effect and no
// `You begin casting` line at all, which is the same footprint a weapon proc leaves. So
// procDetect's cast-less inference — correct for every proc it was measured against — filed the
// reporter's bow and earring clickies as procs and put a PROCS-PER-MINUTE rate on them. From the
// attached slice, both of them, three firings each inside ten minutes:
//
//   [Tue Aug 18 17:54:57 2026] You hit Master Yael for 302 points of fire damage by Firestrike.
//   [Tue Aug 18 17:54:58 2026] You hit Master Yael for 100 points of magic damage by Gravity Flux.
//
// The reporter holds `Rain Caller` (RANGE — `Effect: Firestrike (Must Equip, Casting Time:
// Instant, Cooldown: 120s)`) and `Earring of Displacement` (Ear — `Effect: Gravity Flux (Must
// Equip, Casting Time: Instant)`). The two fire ONE SECOND APART on all three occasions, 182s and
// 361s apart from each other — a human working two hotkeys, at intervals that clear the bow's own
// 120s cooldown. Nothing about that is melee-paced.
//
// ── THE CATALOG CANNOT BE THE GATE, AND THAT IS MEASURED (not inherited from JOS-355) ──
//
// The obvious rule — "the spell is an instant click effect on SOME item, and a combat effect on
// NO item, therefore a cast-less firing of it is a click" — was swept over the owner's own
// 1,155,043-line log before it was written. It moves 161 firings, and 148 of them are WRONG:
//
//   Vampiric Curse   40 cast / 148 cast-less   → the catalog says `Pestilence Scythe` (Charges: 1)
//
// Those 148 are `You healed Primitive for 21 hit points by Vampiric Curse.` lines spaced SIX
// SECONDS apart through whole fights. That is a weapon proc off a weapon this DB has never heard
// of — items.json is 11,375 pages, not the game — and "no item in the catalog grants it as a
// combat effect" is therefore ABSENCE OF EVIDENCE, not evidence. A catalog-only rule reads that
// absence as a verdict and relabels a real proc lane. (`Light Healing`, 10 more, same shape.)
//
// So the gate is OWNERSHIP, which is the conclusion JOS-355's investigation reached from the
// other side. It is sound HERE in a way it was not there, and the difference is the line:
// `You hit <mob> … by Firestrike.` is FIRST-PERSON. Nobody else's click, cast or proc can print
// it, so the "your groupmate cast it on you" ambiguity that blocks the buff-landing half of
// JOS-355 does not arise on the damage half at all. The dump is still a snapshot of what you had
// when you typed `/outputfile inventory`, and that is the honest limit of this gate — but a
// snapshot of YOUR bags cannot mistake somebody else's spell for yours.
//
// MEASURED WITH THE OWNERSHIP GATE ON, same log: the owner holds exactly TWO instant clickies
// with no combat-effect twin (`Allure` from Wand of Allure, `Reclaim Energy` from Staff of
// Elemental Mastery: Earth) and NEITHER fires cast-less anywhere in it. Zero of the owner's
// 33,070 cast-less firings move. The reporter holds six, of which `Gravity Flux` and (once
// Rain Caller's row parses — part 1 of this ticket) `Firestrike` are the two the slice fires.
//
// ── WHAT THIS REFUSES TO DECIDE ──
//
// A spell that is BOTH an instant clicky you hold AND a proc on a weapon you are swinging is
// counted as a click here, and the log cannot separate the two firings (law 6). The alternative
// — refusing both — puts the reporter's complaint straight back. The residual is stated rather
// than engineered around, exactly like the same-second absorption procDetect's header states.
//
// A TIMED clicky (`Casting Time: 4.0`) is deliberately NOT in this table: it prints a real
// `You begin casting` line, so it already scores `cast` and has never been part of the defect.

// ── WHY THIS MODULE TAKES THE DB RATHER THAN IMPORTING IT ──
//
// It follows itemsDb.ts's stated rule ("Nothing here loads the JSON — itemLookup.ts owns that
// import, so a script or a test pays for the 8 MB only when it actually wants it"), and here that
// rule turned out to have TEETH.
//
// MEASURED, six e2e runs of `tests/e2e/sky-inventory-autoload.e2e.mts` while this branch was being
// rebased onto JOS-431. Giving this module a static `import … from './data/items.json'` and
// importing THIS module from session.ts (and then from pipeline.ts) broke that spec's
// delete-and-recreate watcher check — deterministically, with every other check still green and no
// error printed anywhere:
//
//   edge present, both call sites live        FAIL
//   edge present, one call site               FAIL
//   edge present, function NEVER invoked      FAIL   ← the discriminator
//   edge absent,  call site live (empty set)  PASS
//   edge absent,  no call                     PASS
//
// So the fault followed the IMPORT EDGE and not the work — the index build below is 3.8 ms and was
// never a candidate. Routing the same call through `itemLookup.ts`, an edge pipeline.ts ALREADY
// had, is green at main's own wall clock.
//
// WHAT IS NOT KNOWN: precisely which rollup ordering the new edge disturbed, or why a file watcher
// is sensitive to it at all. items.json has four other static importers (ipc/characterSheet.ts,
// ipc/planner.ts, mobDropEra.ts, itemLookup.ts), so "a second importer" is NOT the rule — what was
// tested is this edge, in this position, against that spec. That a chokidar watcher can be broken
// by module order is a defect in its own right and is worth a ticket; adding no edge is this
// ticket's way around it, not an explanation of it.

import { itemKey } from './itemsDb'
import { spellCanonKey } from './log/parseCommon'
import type { ItemDbEntry } from './itemsDb'
import type { ItemEffect } from '../shared/itemStats'
import type { HeldCounts } from '../shared/types'

/** `Casting Time: Instant` — the only click shape that prints no cast line. */
const INSTANT = /\binstant\b/i

/** `ItemDbFile['items']`, named here so the parameter reads as what it is: the committed DB, handed
 *  in by the module that owns its import. */
export type ItemDb = Record<string, ItemDbEntry>

interface ClickyIndex {
  /** `itemKey` → the instant-click spells that item grants, canonical keys. */
  byItem: Map<string, string[]>
  /** Canonical keys of every spell some item grants as a COMBAT effect (a weapon proc). */
  combat: Set<string>
}

/** The last DB walked, and its index. Memoized on the DB's IDENTITY rather than a boolean, so the
 *  app (one frozen singleton, walked once at 3.8 ms) and a test (its own fixture) can both be
 *  right. */
let cached: { items: unknown; index: ClickyIndex } | undefined

/** File one item's effects into the two tables. Separated from the walk so neither the branch
 *  count nor the nesting depth of `index()` depends on how many effect kinds there are. */
function fileEffects(entry: { page: string; stats?: { effects: ItemEffect[] } }, into: ClickyIndex): void {
  for (const e of entry.stats?.effects ?? []) {
    const name = e.name.trim()
    if (!name) continue
    const spell = spellCanonKey(name)
    if (e.kind === 'combat' || e.kind === 'proc') into.combat.add(spell)
    else if (e.kind === 'click' && INSTANT.test(e.detail ?? '')) push(into.byItem, itemKey(entry.page), spell)
  }
}

function push(m: Map<string, string[]>, key: string, value: string): void {
  const list = m.get(key)
  if (list) list.push(value)
  else m.set(key, [value])
}

/** Walk one item DB into the two tables, once per DB. */
function index(items: ItemDb): ClickyIndex {
  if (cached?.items === items) return cached.index
  const built: ClickyIndex = { byItem: new Map(), combat: new Set() }
  for (const entry of Object.values(items)) fileEffects(entry, built)
  cached = { items, index: built }
  return built
}

/**
 * One held-count key, folded to the catalog's item key.
 *
 * `heldCountsFromDump` LOWERCASES the client's spelling verbatim, so a socketed exaltation copy
 * arrives as `polished mithril mask (exaltation)` — and `parseItemName`'s suffix rules are cased,
 * so they cannot see it. The three suffixes are therefore stripped here, case-insensitively and in
 * the order the client writes them (`<Item> +N* (Exaltation)`), before `itemKey` folds the rest.
 *
 * An exaltation copy IS the item for this question: it grants the same click effect.
 */
function heldItemKey(raw: string): string {
  return itemKey(
    raw
      .replace(/\s*\(exaltation\)\s*$/i, '')
      .replace(/\*\s*$/, '')
      .trim()
  )
}

/**
 * The canonical spell keys a cast-less first-person line may be attributed to a CLICK of.
 *
 * Empty for a character who has never typed `/outputfile inventory`, which is exactly the
 * behaviour that shipped before this gate existed: no dump, no ownership evidence, no
 * reclassification, and every cast-less firing stays in the proc lane it is in today.
 *
 * Held-count keys are folded through `heldItemKey` — law 2, at the counting boundary.
 *
 * `items` is the committed DB, passed in rather than imported — see the note above the imports.
 */
export function heldClickySpells(items: ItemDb, counts: HeldCounts): ReadonlySet<string> {
  const { byItem, combat } = index(items)
  const out = new Set<string>()
  for (const [raw, n] of Object.entries(counts)) {
    if (n <= 0) continue
    for (const spell of byItem.get(heldItemKey(raw)) ?? []) {
      // A spell some weapon procs is never attributed to a click, however many of them you own.
      if (!combat.has(spell)) out.add(spell)
    }
  }
  return out
}
