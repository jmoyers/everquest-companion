// ============================================================================
// pipeline.ts — the log-derived world: one event stream, and everything that folds it.
// ============================================================================
//
// See AGENTS.md → Architecture. Both feeders (the startup scan and the live Tailer) push
// onto ONE LogBus; the ModuleRegistry folds every event into each extension module and the
// CombatEngine folds it into its own state machine.
//
// This module CONSTRUCTS that world and wires it, at import time, in the order the design
// requires — the module instances (via `modules/wiring.ts`, which owns the list and its order),
// the registry host that pushes `module:delta`, and the two bus subscriptions. index.ts imports
// it as the composition root's first act; `session.ts` drives it (scan → tail → reset on
// character switch).
//
// The module ORDER is load-bearing and is documented in modules/wiring.ts, beside the
// constructions. Do not reorder them. That file is Electron-free on purpose: `npm run bench:replay`
// folds the same modules in the same order OUTSIDE Electron to attribute the startup fold per
// consumer (JOS-55), and it must not be holding a private copy of the list.

import { IPC } from '../shared/ipc'
import { logInfo } from './errorLog'
// A leaf (see its header) — it starts at `replayDone` and is imported here only to bracket the
// rebuild fan-out below.
import { timeSeam } from './perfAttribution'
import { LogBus } from './log/bus'
import { EpochDetector } from './log/epochDetector'
import { SessionDetector } from './log/sessionDetector'
import { baselineOverlay, loadUserSources } from './data/overlayPersistence'
import { BASELINE_SOURCE } from './data/messageOverlay'
import { spellCorrectionsReport, spellPlaceholdersReport, spellRemovalsReport } from './data/spellDb'
// The registry VALIDATOR (JOS-412). It is not one of the load passes and reports from here rather
// than from the loader on purpose — see `spellSubjectAudit.ts`'s header for the one-way edge.
import { auditSpellSubjects } from './data/spellSubjectAudit'
// The era join's own census (JOS-393). It reports from `spellEra.ts` rather than from the loader
// beside its three siblings because the pass has two callers over one catalog — see that file.
import { spellEraReport } from './data/spellEra'
import { CombatEngine } from './combat/engine'
import { ModuleRegistry } from './modules/registry'
import { createModules } from './modules/wiring'
import { resistLedgerSeam } from './resist/store'
import type { ModuleDelta } from './modules/types'
import { heldClickySpells, lookupItem } from './itemLookup'
import { MOB_CATALOG_SIZE, lookupMob, ownLoot } from './mobLookup'
import { getAlerts, getBuffTrustPrefs } from './store'
import { getRespawnPrefs } from './storeRespawn'
import { getOverlayWindow, sendToMain } from './windows'
import type { AlertsDelta, CharacterRef, HeldCounts, OverlayKind } from '../shared/types'

/**
 * Log-derived state for the active character, rebuilt on launch + appended live.
 * A single canonical LogEvent stream (bus) feeds every consumer: the module
 * registry folds it into each extension module, the combat engine folds it into
 * its state machine. Both feeders (scan + tail) share one monotonic seq counter,
 * owned by session.ts.
 */
export const bus = new LogBus()
export const combat = new CombatEngine()
// …AND THE ENGINE HANDS ONE THING BACK (JOS-454): the JOS-188 pet-buff bind, as a derived
// `petClaim{via:'petBuff'}`. It is the third binding signal, it is a PAIR of lines and therefore
// per-stream state the parser cannot emit, and until this line it never left the engine — so the
// Leveling tab filed a bound pet's kills as strangers' for the fifty-five minutes before its first
// `… Master.'` tell (combat/petClaims.ts carries the measurement). Same emitDerived queue as the
// buffs module's `buffExpired`, and the engine ignores the kind on the way back in, so there is no
// feedback loop.
combat.setDerivedEmitter((ev, live) => {
  bus.emitDerived(ev, live)
})
// Character-epoch detection (Task #49; anchor replaced in Task #50): the OFFICIAL LAUNCH
// (2026-07-28 00:00 local) is the boundary of a same-name+server character being WIPED +
// recreated at launch (they reuse the same log file — see epochDetector.ts's beta-wipe
// story). The first at/after-launch event hands a derived `epoch` event back onto the SAME
// bus (the Task #47 emitDerived path), which every character-scoped module resets on, so
// post-scan tallies (AA/loot/kills/turn-ins/quests) reflect ONLY the current character.
// Fires mid-replay during a rescan, so epochs apply historically for free; a live crossing
// works identically. (The old level-regression heuristic was removed — EQ Legends loadout
// swaps legitimately change level, so a level drop is NOT a reliable rebirth signal.)
export const epoch = new EpochDetector()
// LOGIN/LOGOUT (the session frame). `Welcome to EverQuest Legends!` is a parsed `sessionStart`;
// this detector turns each one into a derived `offlineGap {fromTs, toTs, camped}` on the SAME
// bus (the emitDerived path epoch and buffs already use), so every consumer learns the world
// stopped being observable for a while. It shares index.ts's LAST bus subscription with the
// epoch detector for the same reason: it must see each event only after the modules and the
// combat engine have folded it. See sessionDetector.ts for why `fromTs` is NOT the last event
// before the Welcome (a measured reconnect preamble makes that read a 13-hour absence as 6s).
export const sessionDetector = new SessionDetector()

/** The overlay kinds that consume the generic module transport — see the fan-out below. */
// 'xp' (JOS-195) reads TWO of them — `progression` for the pace and the projection, `loot` for
// the mote rates — and needs the rebuild signal below at least as much as the timer windows do:
// its whole subject is a fold over months of log, and a window open at launch hydrates part-way
// through one.
const MODULE_READING_OVERLAYS: OverlayKind[] = ['events', 'buffs', 'debuffs', 'xp', 'respawn']

/**
 * Push to every overlay window that reads modules — the fan-out `emitDelta` performs, as a
 * function, because a delta is no longer the only thing an overlay has to be told (JOS-172).
 *
 * An overlay window that reads a module needs BOTH halves of the transport the main window has
 * always had: the increments, and the "throw it all away and ask again" signal. It had only the
 * first, which is invisible until the moment the two disagree — a COLD START with an overlay
 * already open. The window is created while the historical fold is running (index.ts restores
 * overlays in the same `whenReady` turn that kicked off `startTailing`), so it hydrates from a
 * snapshot taken at a random instant part-way through months of log; `endReplay` then DISCARDS
 * what the fold accumulated (registry.ts — deliberately, so a character switch cannot fire the
 * celebration detectors), so no delta ever describes the rest of it. A charm or an Ensnare that
 * genuinely survived the fold was in the model, in the main window, and missing from the overlay
 * until the next live event happened to touch that module.
 *
 * THE DELIVERY IS THE FIX, NOT THE DISCARD. Exempting buffs/buffTimers from `endReplay` would
 * mean shipping one module's whole history as an INCREMENT again — the exact shape JOS-60
 * removed — and would leave the other module-reading overlay (the event log) with the same
 * asymmetry. Re-hydration is what the main window does (`useModule` on `log:character`), so the
 * overlays now get the same signal through the same list.
 */
export function sendToModuleOverlays(channel: string, ...args: unknown[]): void {
  for (const kind of MODULE_READING_OVERLAYS) {
    const w = getOverlayWindow(kind)
    if (w && !w.isDestroyed()) w.webContents.send(channel, ...args)
  }
}

/**
 * "The world for this character was rebuilt — re-hydrate." ONE call, every window that folds a
 * module: the main window and the module-reading overlays.
 *
 * Every `log:character` send in this process goes through here (session.ts's two, index.ts's
 * live-epoch re-send), so "who is told the world was rebuilt" is answered in one place rather
 * than at each call site — which is precisely how the overlays came to be missing from it.
 *
 * A TIMED SEAM (JOS-458), and the one this ticket suspects most. It fires in the minute after a
 * fold — which is exactly the window the two field reports describe — and its cost is a FAN-OUT:
 * one `webContents.send` per open module-reading window, each of which serializes the payload and
 * wakes a renderer that immediately asks for a full snapshot back. The bracket covers OUR half
 * (the sends), never the renderers' work, so a large number here is main's own bill and nobody
 * else's.
 */
export function sendWorldRebuilt(character: CharacterRef | null): void {
  timeSeam('worldRebuilt', () => {
    sendToMain(IPC.onCharacter, character)
    sendToModuleOverlays(IPC.onCharacter, character)
  })
}

// The extension framework. Modules own their slice of log-derived state and push
// deltas to the renderer over the generic `module:delta` channel. Registration
// order = bus delivery order.
export const registry = new ModuleRegistry({
  emitDelta: (delta: ModuleDelta) => {
    sendToMain(IPC.onModuleDelta, delta)
    // Task #59: alert fires are ALSO event-log rows. Folding them here (rather than teaching
    // AlertsModule about the feed) keeps the alerts module untouched, and because eventFeed is
    // registered LAST the row it appends is picked up by the same flush pass.
    feedAlertDelta(delta)
    // OVERLAYS THAT READ MODULES GET THE DELTA TOO. The 'events' overlay hydrates the eventFeed
    // module and rides its deltas; the 'buffs' and 'debuffs' overlays (JOS-89, split in JOS-119)
    // do the same for `buffs` + `buffTimers` — two SURFACES over one model, so both subscribe to
    // the same two modules and each keeps the rows that are its subject (shared/buffTimers.ts
    // `timerRowSurface`). The fan-out stays an explicit per-kind list rather than a broadcast over
    // OVERLAY_KINDS: an overlay that reads no module has no business being woken ~10×/second,
    // and a new kind that DOES read one should have to say so here.
    sendToModuleOverlays(IPC.onModuleDelta, delta)
  }
})
/**
 * EVERY MODULE, IN BUS-DELIVERY ORDER — built by `modules/wiring.ts`, not here (JOS-55).
 *
 * The construction and the registration order moved to that file for one reason: the startup
 * fold is what `npm run bench:replay` takes apart per consumer, and it measures the fold IN
 * PROCESS, outside Electron, where THIS file cannot be imported (store, windows, the two
 * knowledge lookups). A bench holding its own hand-copied list of modules would attribute a
 * pipeline nobody ships. There is one list; this is its only Electron-flavoured caller.
 *
 * Everything impure is injected from here — the user's alert defs, both message overlays, the
 * item/mob knowledge lookups, the shared own-loot index, and the bus the buffs module hands its
 * derived `buffExpired` back to (Task #47: queued until the current primary event finishes
 * delivering — no re-entrancy, no feedback loop, since buffs ignores buffExpired).
 */
const modules = createModules({
  alertDefs: getAlerts(),
  // The one Electron-touching half of the resist module (src/main/resist/module.ts states why).
  resistLedger: resistLedgerSeam(),
  // WHOSE casts may anchor a landing besides your own (JOS-140). Empty unless the user named
  // somebody in Preferences; ipc/buffTrust.ts keeps it in sync while the app runs.
  buffTrust: getBuffTrustPrefs(),
  // Which mobs get a respawn clock (JOS-194). ipc/respawn.ts keeps it in sync while the app runs.
  respawnPrefs: getRespawnPrefs(),
  // The committed baseline first, then what this user's own logs have taught since install — each
  // under the SOURCE KEY that produced it (JOS-231), so the fold about to re-mine a character's
  // log replaces that character's bucket rather than piling onto it.
  overlays: [
    { key: BASELINE_SOURCE, counts: baselineOverlay() },
    ...loadUserSources().map((s) => ({ key: s.key, counts: s }))
  ],
  lookupItem,
  lookupMob,
  ownLoot,
  emitDerived: (ev, live) => {
    bus.emitDerived(ev, live)
  }
})

export const spellDb = modules.spellDb
export const comboModule = modules.combo
export const rosterModule = modules.roster
export const lootModule = modules.loot
export const turnInsModule = modules.turnIns
export const killsModule = modules.kills
export const respawnModule = modules.respawn
export const progressionModule = modules.progression
export const levelingModule = modules.leveling
export const characterModule = modules.character
export const outputFilesModule = modules.outputFiles
export const itemTiersModule = modules.itemTiers
export const alertsModule = modules.alerts
export const buffsModule = modules.buffs
export const considerModule = modules.consider
export const eventFeedModule = modules.eventFeed
export const resistModule = modules.resist

logInfo(
  `[everquest-companion] Message overlay: applied ${modules.overlayCorrections} cast-message corrections over the wiki DB.`
)
// The COMMITTED half of the same idea (JOS-150): our corrections to the scrape, applied at load.
// `stale` is the one number worth watching in a boot log — it means a re-scrape moved a message
// out from under a correction, and the correction now describes nothing.
{
  const c = spellCorrectionsReport()
  if (c) {
    logInfo(
      `[everquest-companion] Spell corrections: ${c.applied} applied, ${c.satisfied} already correct upstream, ${c.stale.length} stale.`
    )
  }
}
// The REMOVALS layer (JOS-337), counted on its own line rather than folded into the corrections
// numbers — the two answer different questions and adding them would misreport both. `removed`
// counts DB rows dropped for spells EQ Legends does not have; a `satisfied` entry is a TOMBSTONE,
// an entry whose page a re-scrape already dropped, and it is NAMED rather than counted so a dead
// entry is visible in a boot log instead of merely cheap.
{
  const r = spellRemovalsReport()
  if (r) {
    const tombstones = r.satisfied.length > 0 ? ` Tombstones: ${r.satisfied.join(', ')}.` : ''
    logInfo(
      `[everquest-companion] Spell removals: ${r.removed} row${r.removed === 1 ? '' : 's'} dropped (absent from EQ Legends), ${r.satisfied.length} already absent upstream.${tombstones}`
    )
  }
}
// The PLACEHOLDER pass (JOS-342) — the scrape's stub messages (`You .`, `Someone .`, `N/A`) blanked
// so the absent-field rules downstream read them as the nothing they are. NAMED rather than
// counted, like the tombstones above: this pass DELETES text, so a boot log that only said "10"
// would give a reader no way to notice it had started deleting something else.
{
  const p = spellPlaceholdersReport()
  if (p) {
    const which = p.rows.map((r) => `${r.spell}/${r.field}`).join(', ')
    logInfo(
      `[everquest-companion] Spell placeholders: ${p.nulled} stub message${p.nulled === 1 ? '' : 's'} read as absent${which ? ` (${which})` : ''}.`
    )
  }
}
// The ERA JOIN (JOS-393) — the wiki's own out-of-era verdict for each spell's page, joined from the
// era sidecar at load. `silent` is the number worth watching: it counts rows the sidecar has NO
// answer for, so a re-scrape of spells.json that outran the page-era scrape shows up here as a jump
// rather than as spells quietly reappearing on level rows.
{
  const e = spellEraReport()
  if (e) {
    logInfo(
      `[everquest-companion] Spell era: ${e.marked} row${e.marked === 1 ? '' : 's'} the wiki badges out of era, ${e.silent} with no verdict (of ${e.table} in the sidecar).`
    )
  }
}
// THE SUBJECT VALIDATOR (JOS-412) — the only line here that reports on the registry AS SHIPPED
// rather than on a pass we ran over it. It answers "which spells can never be resolved to their own
// landing sentence", which is the question `Odium` and then `Curse` had to be reported for. Run
// here, over `spellDb.spells` (the effective list), because the edge to spellDb.ts is one-way at
// runtime — see that module's header. `unreachable` is the number worth watching: the other two
// count ROWS, and a duplicate era row's wrong subject costs a user nothing.
{
  const a = auditSpellSubjects(spellDb.spells)
  logInfo(
    `[everquest-companion] Spell subjects: ${a.unreachable.length} spell${a.unreachable.length === 1 ? '' : 's'} unreachable by their landing sentence (${a.wrongSubject} rows with the wrong subject placeholder, ${a.noSubject} with none, ${a.firstPerson.length} first-person fields naming a third party).`
  )
}
logInfo(`[everquest-companion] Spell DB: ${spellDb.spells.length} spells (${spellDb.castOnYou.size} unique cast-on-you msgs).`)
logInfo(
  `[everquest-companion] Mob catalog: ${MOB_CATALOG_SIZE} mobs (scraped drop tables; the live wiki lookup is the fallback).`
)

/** Fold an `alerts` module delta into the event feed (alert id → its display name). */
function feedAlertDelta(delta: ModuleDelta): void {
  if (delta.moduleId !== 'alerts') return
  const { fired } = delta.delta as AlertsDelta
  if (!fired?.length) return
  const defs = alertsModule.snapshot().state.defs
  for (const f of fired) {
    const def = defs.find((d) => d.id === f.alertId)
    eventFeedModule.noteAlertFire(def?.name ?? f.alertId, f.matchedText, f.ts)
  }
}

// REGISTRATION ORDER IS BUS DELIVERY ORDER, and the order itself is stated (with its reasons) in
// modules/wiring.ts beside the constructions — combo first, roster second, eventFeed last. This
// loop is the whole registration: a module added there is registered here without an edit, which
// is exactly the property that keeps the bench's attribution honest.
for (const mod of modules.ordered) registry.register(mod)
// Subscribe consumers to the bus ONCE, at startup. The bus persists across
// character switches; on a switch we reset() each consumer rather than tearing
// down and re-subscribing (the old bus.clear() churned subscriptions and risked
// registration-order drift). Registry first, then combat — same order as before.
registry.attach(bus)
// THE ROSTER SEAM (docs/plans/group-model.md §3.5). The engine's admission gate and its scope
// filtering both read the roster through this ONE pull, installed before the engine ever folds
// a line: the registry is attached above, so within a single bus delivery the roster module has
// already consumed the event the engine is about to. A pull rather than a copy, because a user
// edit made between two log lines must be visible to the very next one.
combat.setRoster(rosterModule)
// THE CLASS-COMBO SEAM (JOS-305), installed on the same principle and in the same place: the
// combo module is FIRST in the registration order above, so by the time the engine folds a line
// the combo model has already consumed it. Its one consumer is the blade-coat clear — a character
// who stopped being a rogue keeps no poison on their blades, and the log prints nothing when that
// happens. A pull, so a `/who` row typed between two log lines reaches the very next one; the
// engine gates HOW OFTEN it pulls (combat/coatClass.ts), because unlike the roster this answer
// costs a rebuild.
combat.setCombo(comboModule)
bus.subscribe((ev, live) => combat.ingestEvent(ev, live))
// Item-knowledge prefetch (Task #53): when a LIVE loot event arrives, warm the
// "what's this for" cache in the background (throttled by itemLookup's serialized queue
// + persistent cache) so the answer is ready by the time the user clicks the item. LIVE
// only — the historical scan (live:false) would otherwise fire thousands of lookups; the
// cache/local-posky path covers those instantly on demand.
//
// Task #59 folded this INTO the event-feed module: its live-loot notability probe calls the
// same cache-first `lookupItem`, so the cache is warmed exactly as before with ONE request
// per item (the module also de-dupes concurrent probes of the same name, which the bare
// prefetch did not). A second subscription here would double-request every uncached loot.
//
// The THIRD and last subscription — epoch detection — is added by index.ts, after this
// module has finished wiring: it must observe each event only once the modules and the
// combat engine have folded it, and it reaches for the active character, which session.ts
// owns. See the composition root.

/**
 * When the log-derived world finished being CONSTRUCTED, in ms since process start — the
 * `dataLoaded` startup phase (docs/plans/perf-profiling.md P4): the spell DB is parsed, the
 * learned message overlay is folded in, the mob catalog is counted and every module exists.
 *
 * A plain exported number, for the same reason `STORE_READY_MS` is one: this all happens during
 * module EVALUATION, long before Electron's `ready`, and importing main's perf module from here
 * to mark it would buy a dependency cycle for a timestamp. The composition root imports both and
 * does the marking.
 */
export const DATA_READY_MS = performance.now()

/**
 * THE HELD-CLICKY SEAM (JOS-438): install the spells this character owns an instant item click
 * for, derived from their `/outputfile inventory` counts.
 *
 * A FUNCTION rather than a module-scope call like the two seams above, because unlike the roster
 * and the combo this one has no live source to pull from — a dump is a snapshot the player writes
 * by hand, so session.ts re-installs it whenever one is read.
 *
 * IT LIVES HERE, and that is the whole point of the indirection: this module already imports
 * itemLookup (`lookupItem`, above) and session.ts already imports this one, so the feature adds no
 * module edge to the main bundle anywhere. Reaching the catalog through a NEW edge instead — from
 * session.ts, then from here — was measured to break JOS-431's delete-and-recreate inventory
 * watcher with the derivation never even called (main/itemClickies.ts carries the bisect).
 *
 * It TAKES the counts rather than reading the store, so session.ts stays the only module that
 * knows which character is active.
 */
export function installHeldClickies(counts: HeldCounts): void {
  combat.setHeldClickies(heldClickySpells(counts))
}
