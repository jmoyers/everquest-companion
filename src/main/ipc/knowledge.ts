// IPC: the reference-data lookups — spells, items, mobs. All cache-first and local-first in
// main, none of them ever reject: a failed fetch degrades to a cached/negative record so the
// renderer is never left hanging.

import { ipcMain } from 'electron'
import { IPC } from '../../shared/ipc'
import { buildLevelUnlocks, isUnlocksRequest } from '../data/levelUnlocks'
import { buildSpellCatalog } from '../data/spellDb'
import { buildSpellDetail } from '../data/spellDetail'
import { lookupItem } from '../itemLookup'
import { lookupMob } from '../mobLookup'
import { appSpellDb } from '../appSpellDb'
// THE SERVED ARM (JOS-496). These three reads are the census's `spell catalog stats`,
// `spellLastCast` and `observed ranks`, and all three are GENUINE QUERIES rather than mirrors —
// their callers are `ipcMain.handle` bodies that already return promises, so there is somewhere to
// put an await and nothing has to be cached. See `moduleState` below.
import { serveMobDropsSeen, serveModuleSnapshot } from '../dataServer/serveShim'
import { currentWornFocus } from '../planner/wornFocusCurrent'
// THE CLIENT'S SPELL TABLE, AWAITED AT THE HANDLER (JOS-396, inverted 2026-08-23). This imported
// `spellTableNow()` — the already-resolved table or null, so nothing waited on the parse — and the
// laziness was the bug once the renderer began pulling once-per-window datasets folded FROM the
// table: a hydration that beat the parse kept a clientless dataset all session (the owner's
// Supernova at four targets, the launch after a cache-version bump forced the full re-parse).
// `spellTable()` is the load promise itself; it settles once per run and every later await is
// already-resolved, so the wait is paid exactly where the race was.
import { spellTable } from '../resist/spellTable'
import type { AlertsSnap } from '../../shared/alertTypes'
import { resolvedClasses, type ClassAbbr, type ComboSnap } from '../../shared/classCombo'
import {
  OBSERVED_SPELL_RANKS_MODULE_ID,
  observedRankRow,
  type ObservedSpellRanksSnap
} from '../../shared/spellRanks'
import type { BuffsSnap } from '../../shared/types'

/**
 * ONE MODULE'S PUBLISHED STATE, FROM WHICHEVER WORLD ANSWERS THIS APP'S READS (JOS-496).
 *
 * THE SAME TWO-ARM SHAPE `ipc/world.ts` USES, and deliberately spelled the same way: the app's own
 * fold is a NAMED THUNK, the served arm is `serveModuleSnapshot`, and the flag decides per call. So
 * everything the shim already guarantees applies here unchanged — the echo test, the deadline, the
 * coalesced fallback narration, and above all the law that the engine arm can never make a caller
 * worse off than the flag-off world, because every one of its failures resolves to `own()`.
 *
 * WHY THIS CHANNEL RATHER THAN `module:getSnapshot`. These are main-side reads, not renderer ones:
 * the catalog and the detail card are JOINS this process performs (the committed spell DB, the
 * client's own table, the worn focus) against one fold fact each. Sending the renderer to the module
 * transport for the fold half and doing the join here would be two round trips and a shape the
 * renderer would then have to munge, which is ruling 4's whole subject.
 *
 * IT ANSWERS `undefined` FOR AN ABSENT MODULE, which is what all three call sites already handled:
 * `registry.get(id)?.snapshot()?.state` has always been able to be undefined for a build that does
 * not carry the module, and an engine that refuses an unknown module falls back to exactly that.
 */
async function moduleState(moduleId: string): Promise<unknown> {
  // ONE ARM (JOS-499). The app-side thunk is deleted with the fold, and an engine that cannot
  // answer resolves to `null` here — which lands on the same `undefined` state the three call
  // sites have always handled for a build that does not carry the module.
  const snap = await serveModuleSnapshot(moduleId)
  return snap?.state
}

/**
 * THE LOADOUT YOU ARE PLAYING RIGHT NOW, as the combo module has RESOLVED it (JOS-508).
 *
 * A FOURTH read off the same door the ranks and the buff stats come through, and the same rules
 * apply: never mutated, an absent module simply means no answer, and the answer is `[]` rather than
 * a guess. `resolvedClasses` keeps only slots holding exactly ONE candidate — a trio where two
 * slots are known and the third is `{CLR,PAL}` reports two classes, which is what "2 of 3 known"
 * honestly looks like and is exactly what the drilldown needs: every level it prints as YOURS has
 * to be a level the game will actually give this character.
 *
 * ONLY THE OPEN INTERVAL. `snap.current` is the span still running; an earlier interval describes a
 * loadout that has since been swapped away from, and answering a spell page with it would print
 * levels for a combo the player is not in.
 */
async function currentCombo(): Promise<ClassAbbr[]> {
  const snap = (await moduleState('combo')) as ComboSnap | undefined
  return snap?.current ? resolvedClasses(snap.current) : []
}

export function registerKnowledgeIpc(): void {
  // ---- suggested-alerts wizard (Task #38) ----
  // Return the slim, searchable spell catalog: the effective DB (spells.json + overlay
  // corrections applied at startup) joined with live per-spell usage read straight off the
  // buffs module's snapshot stats (`n` = observed land→fade samples). Read-only w.r.t. the
  // buffs module — we never mutate it.
  //
  // ---- and the LEVEL-UNLOCK dataset (docs/plans/levelup-whats-new.md, wave O2) ----
  // Same door, one flag: "what does the spell DB say" is this channel's question, and
  // `{unlocks:true}` asks the other half of it — the (class, level) unlock rows the Leveling
  // tab's "New at this level" panel draws, joined with classes.json's skill/disc/innate tables.
  // It rides the catalog channel because shared/ipc.ts was owned by a concurrent wave the day
  // this shipped (src/main/data/levelUnlocks.ts says so at the seam); the flag is VALIDATED, not
  // trusted, like every other renderer-supplied argument at a handler. A bare invoke — the
  // wizard's — still gets the wizard's catalog, unchanged and no larger than it was.
  ipcMain.handle(IPC.spellsCatalog, async (_e, req: unknown) => {
    // AWAITED, NOT SAMPLED (2026-08-23, owner field report). This read `spellTableNow()` — the
    // table if it happened to be loaded — and the renderer pulls this dataset ONCE per window on a
    // premise that died when the client table joined the fold (recastMs fallback, clientHp,
    // aeMaxTargets): a hydration that beat the parse got a clientless dataset for the whole
    // session. The owner hit exactly that on the launch after the v4 cache bump forced a full
    // re-parse — Supernova at the default four targets all session. `spellTable()` resolves when
    // the parse settles (ok, missing or unloadable), so the one pull now always carries whatever
    // client facts this machine has; a missing install still folds clientless, as a value.
    if (isUnlocksRequest(req)) return buildLevelUnlocks(await spellTable())
    const usage = new Map<string, number>()
    const lastSeen = new Map<string, number>()
    const snap = (await moduleState('buffs')) as BuffsSnap | undefined
    if (snap)
      for (const [key, stat] of Object.entries(snap.stats)) {
        usage.set(key, stat.n)
        if (stat.lastSeenMs != null) lastSeen.set(key, stat.lastSeenMs)
      }
    return buildSpellCatalog(appSpellDb(), usage, lastSeen)
  })

  // ---- ONE spell, in full (JOS-293: the rich spell card) ----
  // The deep read behind the hover card: every field the committed DB states for this name, the
  // effect classes derived from its effect list, and the ranks of its line that a source names.
  //
  // THE RANKS COME FROM THE ALERTS MODULE, and that is the whole reason this handler is not a pure
  // function of the DB. `AlertsSnap.spellLastCast` is the only rank-PRESERVING record in the app
  // (the buffs model's keys are rank-folded), and the DB holds a single row for ~1,800 of its
  // ~1,900 lines - so without it the card could never name the rank a spell replaces. Read
  // exactly the way the catalog reads the buffs snapshot above: off the registry, never mutated,
  // and an absent module simply means no observed ranks.
  //
  // The argument is a renderer string, so it is VALIDATED rather than trusted: anything that is
  // not a string is answered with the same not-found record an unknown spell gets.
  // AND THE MOTE RANK COMES FROM THE OBSERVED-RANK MODULE (JOS-447), read off the registry the same
  // way. It is a SECOND rank source beside `spellLastCast` on purpose and they answer different
  // questions: the alerts map names the rank display strings a lineage can list, while JOS-446's
  // fold answers "the highest rank this character holds" over merges as well as casts - which is
  // the number the `yours: VIII` pill already states, and therefore the number the at-rank figures
  // beside it have to be read at, or the card would contradict itself.
  // AND THE LOADOUT (JOS-508), which is what turns the upgrade ladder from a list of spells into a
  // SCHEDULE: the level each rung unlocks at for the classes you are actually playing. Read here
  // rather than in the renderer for the header's reason — the join belongs on the side that already
  // holds the catalog, and a renderer that assembled it would be munging (ruling 4).
  //
  // THE FOUR READS RUN TOGETHER NOW, AND THE FOURTH IS WHY. These were four sequential awaits over
  // three engine round trips and a worker's parse, none of which depends on any other — so the
  // handler's latency was their SUM for no reason. Adding a fourth made that visible rather than
  // merely wasteful: `tests/e2e/unlockRowSteps.mts` had been reading the hover card at mount rather
  // than at answer, an always-wrong read that the extra milliseconds turned into a reliable failure.
  // The spec's own wait is fixed there (wave E3's law); this is the other half, and it makes the
  // card FASTER than it was before this ticket rather than merely no slower.
  ipcMain.handle(IPC.spellsDetail, async (_e, name: unknown) => {
    const wanted = typeof name === 'string' ? name : ''
    const [snap, rankSnap, client, combo] = await Promise.all([
      moduleState('alerts') as Promise<AlertsSnap | undefined>,
      moduleState(OBSERVED_SPELL_RANKS_MODULE_ID) as Promise<ObservedSpellRanksSnap | undefined>,
      // Awaited for the unlocks handler's reason, one hover earlier: a card opened in the first
      // seconds of a launch would otherwise state clientless facts for that one open.
      spellTable(),
      currentCombo()
    ])
    return buildSpellDetail(appSpellDb(), wanted, Object.keys(snap?.spellLastCast ?? {}), {
      client,
      rank: observedRankRow(rankSnap, wanted)?.rank,
      // JOS-452 — the same worn-focus answer the planner's inventory payload carries, from the same
      // memoized resolution, so the card and the leveling table can never credit a different item.
      focus: currentWornFocus(),
      combo
    })
  })

  // ---- item knowledge ("what's this lore/quest item for", Task #53) ----
  // Local posky-first, then a cached, politely-throttled wiki lookup. lookupItem never
  // rejects (degrades to a cached negative/offline record that still carries local posky
  // associations), so a failure here never leaves the renderer hanging.
  ipcMain.handle(IPC.itemsLookup, (_e, name: string) => lookupItem(name))
  // Mob knowledge (Task #63) — "what does this thing drop". Cache-first + local-first in main,
  // so the hover card is usually answered without touching the network. Never rejects.
  /**
   * ONE MOB CARD, with the "you have seen it drop" section taken from the ENGINE (JOS-499, owner
   * ruling 6a).
   *
   * `lookupMob` still answers everything else — the committed catalog, the wiki fallback, the alias
   * resolution, the era join — because those are all app-side and unchanged. What it can no longer
   * answer is `dropsSeen`: that came from `mobLookup.ownLoot`, an index the FOLD filled, and the
   * fold is deleted, so the app's copy is permanently empty and the section vanished from every
   * card. The engine holds that index now (boundary verdict 5) and serves it on `knowledge.mob`.
   *
   * THE HANDLER WAS ALREADY ASYNC, which is why this is a graft rather than a redesign: an
   * `ipcMain.handle` body may await, and the renderer has always received a promise here.
   *
   * ABSENT STAYS ABSENT, and the three outcomes are three — see `serveMobDropsSeen`. An engine that
   * cannot be asked leaves the record exactly as `lookupMob` built it, which is the honest silence
   * rather than a stale array.
   */
  ipcMain.handle(IPC.mobsLookup, async (_e, name: string) => {
    const base = await lookupMob(name)
    const box = await serveMobDropsSeen(name)
    if (box === null) return base
    if (box.seen === undefined) {
      const { dropsSeen: _dropped, ...rest } = base
      return rest
    }
    return { ...base, dropsSeen: box.seen }
  })
}
