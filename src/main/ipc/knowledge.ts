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
// THE CLIENT'S SPELL TABLE, READ AT THE HANDLER (JOS-396). `spellTableNow()` is the already-resolved
// table or null — never a promise, so nothing here waits on a 38 MB parse. Reading it HERE, on every
// invoke, is what makes the fallback lazy: the table lands on a worker some seconds into a cold
// launch, and the next read after it lands is the one that carries the figures.
import { spellTableNow } from '../resist/spellTable'
import type { AlertsSnap } from '../../shared/alertTypes'
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
  ipcMain.handle(IPC.spellsCatalog, (_e, req: unknown) => {
    if (isUnlocksRequest(req)) return buildLevelUnlocks(spellTableNow())
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
  ipcMain.handle(IPC.spellsDetail, (_e, name: unknown) => {
    const snap = registry.get('alerts')?.snapshot()?.state as AlertsSnap | undefined
    const observed = Object.keys(snap?.spellLastCast ?? {})
    return buildSpellDetail(spellDb, typeof name === 'string' ? name : '', observed, spellTableNow())
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
