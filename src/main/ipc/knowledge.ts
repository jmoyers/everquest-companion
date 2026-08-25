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
import { registry, spellDb } from '../pipeline'
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
import {
  OBSERVED_SPELL_RANKS_MODULE_ID,
  observedRankRow,
  type ObservedSpellRanksSnap
} from '../../shared/spellRanks'
import type { BuffsSnap } from '../../shared/types'

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
    const snap = registry.get('buffs')?.snapshot()?.state as BuffsSnap | undefined
    if (snap)
      for (const [key, stat] of Object.entries(snap.stats)) {
        usage.set(key, stat.n)
        if (stat.lastSeenMs != null) lastSeen.set(key, stat.lastSeenMs)
      }
    return buildSpellCatalog(spellDb, usage, lastSeen)
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
  ipcMain.handle(IPC.spellsDetail, async (_e, name: unknown) => {
    const snap = registry.get('alerts')?.snapshot()?.state as AlertsSnap | undefined
    const observed = Object.keys(snap?.spellLastCast ?? {})
    const wanted = typeof name === 'string' ? name : ''
    const rankSnap = registry.get(OBSERVED_SPELL_RANKS_MODULE_ID)?.snapshot()?.state as
      | ObservedSpellRanksSnap
      | undefined
    return buildSpellDetail(spellDb, wanted, observed, {
      // Awaited for the unlocks handler's reason, one hover earlier: a card opened in the first
      // seconds of a launch would otherwise state clientless facts for that one open.
      client: await spellTable(),
      rank: observedRankRow(rankSnap, wanted)?.rank,
      // JOS-452 — the same worn-focus answer the planner's inventory payload carries, from the same
      // memoized resolution, so the card and the leveling table can never credit a different item.
      focus: currentWornFocus()
    })
  })

  // ---- item knowledge ("what's this lore/quest item for", Task #53) ----
  // Local posky-first, then a cached, politely-throttled wiki lookup. lookupItem never
  // rejects (degrades to a cached negative/offline record that still carries local posky
  // associations), so a failure here never leaves the renderer hanging.
  ipcMain.handle(IPC.itemsLookup, (_e, name: string) => lookupItem(name))
  // Mob knowledge (Task #63) — "what does this thing drop". Cache-first + local-first in main,
  // so the hover card is usually answered without touching the network. Never rejects.
  ipcMain.handle(IPC.mobsLookup, (_e, name: string) => lookupMob(name))
}
