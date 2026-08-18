// ============================================================================
// wiring.ts — the ordered module set, constructed in ONE place and folded in two.
// ============================================================================
//
// pipeline.ts is the app's composition root and is Electron-bound by design: it reaches for the
// settings store, the windows it pushes deltas to, and the two knowledge lookups that touch
// userData and the network. Nothing outside Electron can import it.
//
// The startup fold, though, is exactly the thing `npm run bench:replay` needs to take apart
// (JOS-55): which consumer spends the 31 microseconds every event costs. The bench measures that
// IN PROCESS — no Electron, no window, no IPC — and an attribution table built from a hand-copied
// list of modules would describe a pipeline nobody ships. One module missing, or two swapped, and
// the percentages are about a different program.
//
// So the CONSTRUCTION and the REGISTRATION ORDER live here, Electron-free, with every impure
// dependency injected. pipeline.ts calls it with the real store/window/lookup deps and re-exports
// the instances it always exported; tests/bench/foldArm.mts calls it with stubs. There is one list,
// and it is this one.
//
// WHAT IS NOT HERE: the bus, the combat engine, the epoch/session detectors and the registry host.
// Those are three lines of wiring each and both callers want them wired differently (the bench
// times the engine's subscription, production pushes deltas over IPC), so they stay at their call
// sites. This file owns the modules and their order, and nothing else.

import { installSpellDb } from '../log/rulesets'
import { loadSpellDb, applyOverlayCorrections, type SpellDb } from '../data/spellDb'
import { MessageOverlayMiner, type OverlaySeed } from '../data/messageOverlay'
import { ComboModule } from './combo'
import { RosterModule } from './roster'
import { LootModule } from './loot'
import { TurnInsModule } from './turnins'
import { ClassUnlocksModule } from './classUnlocks'
import { KillsModule } from './kills'
import { RespawnModule } from './respawn'
import { LevelingModule } from './leveling'
import { ProgressionModule } from './progression'
import { CharacterModule } from './character'
import { OutputFilesModule } from './outputFiles'
import { SpellSetsModule } from './spellSets'
import { ItemTiersModule } from './itemTiers'
import { AlertsModule } from './alerts'
import { BuffsModule } from './buffs'
import { BuffTimersModule } from './buffTimers'
import { ConsiderModule, type ConsiderDeps } from './consider'
import { EventFeedModule, type EventFeedDeps } from './eventFeed'
import { ResistModule, type ResistLedgerSeam } from '../resist/module'
import type { EqModule } from './types'
import { buildTimerRows } from '../../shared/buffTimers'
import type { LogEvent } from '../../shared/logEvents'
import type { AlertDef } from '../../shared/types'
import type { BuffTrustPrefs } from '../../shared/buffTrust'
import type { RespawnPrefs } from '../../shared/respawn'

/** Everything the module set needs from outside itself. Every field is a seam pipeline.ts fills
 *  from Electron and the bench fills with a stub or an empty list. */
export interface ModuleWiringDeps extends ConsiderDeps, EventFeedDeps {
  /** The userData-backed resist ledger. Absent ⇒ an in-memory one that writes nothing. */
  resistLedger?: ResistLedgerSeam
  /** The user's alert definitions (the store owns them; the module is kept in sync by setDefs). */
  alertDefs?: AlertDef[]
  /**
   * Observed-message counts to seed the miner with, in merge order: the committed baseline, then
   * the user's persisted buckets. Each carries the SOURCE KEY its counts belong to (JOS-231) —
   * that is what lets a re-fold of a log replace its own previous contribution instead of adding
   * to it. All are additive and all are optional — a caller with no userData (the bench) passes
   * the baseline alone and says so.
   */
  overlays?: readonly OverlaySeed[]
  /**
   * Where the buffs module hands its RESOLVED `buffExpired` back (Task #47) — `bus.emitDerived` in
   * both callers, but the bus is the caller's, so the function is injected rather than the bus.
   */
  emitDerived?: (ev: LogEvent, live: boolean) => void
  /**
   * WHOSE casts may anchor a landing besides your own (JOS-140, shared/buffTrust.ts). Absent ⇒
   * you and nobody else, which is the shipped default and what every caller but the composition
   * root passes.
   */
  buffTrust?: BuffTrustPrefs
  /**
   * The user's respawn watch list (JOS-194). The store owns it; absent ⇒ the shipped default,
   * which is an EMPTY list — tracking is opt-in per mob, so a caller that passes nothing gets a
   * module that clocks nothing. That is what the bench and every non-Electron caller wants.
   */
  respawnPrefs?: RespawnPrefs
}

/** The constructed world's modules: each one by name (pipeline.ts re-exports them under the names
 *  the rest of the app has always imported) plus THE list, in bus-delivery order. */
export interface ModuleWiring {
  spellDb: SpellDb
  /** How many cast-message corrections the overlay applied over the wiki DB (for the boot log). */
  overlayCorrections: number
  combo: ComboModule
  roster: RosterModule
  loot: LootModule
  turnIns: TurnInsModule
  classUnlocks: ClassUnlocksModule
  kills: KillsModule
  respawn: RespawnModule
  progression: ProgressionModule
  leveling: LevelingModule
  character: CharacterModule
  outputFiles: OutputFilesModule
  spellSets: SpellSetsModule
  itemTiers: ItemTiersModule
  alerts: AlertsModule
  buffs: BuffsModule
  buffTimers: BuffTimersModule
  consider: ConsiderModule
  eventFeed: EventFeedModule
  resist: ResistModule
  /** REGISTRATION ORDER = BUS DELIVERY ORDER. Load-bearing; see the comments below. */
  ordered: EqModule[]
}

/**
 * The EFFECTIVE spell DB: spells.json + the observed-message overlay, overlay WINS (Task #36).
 *
 * Built before any module, and installed into the parser before any event is folded, because it
 * changes what the PARSER emits — a self-landing line the wiki got wrong or omitted (Symbol of
 * Pinzarn's real message) is only recognized once the corrections are in the cast-on-you table.
 * A fold that skipped this step would parse a different event stream and time a different program.
 */
function effectiveSpellDb(overlays: readonly OverlaySeed[]): {
  db: SpellDb
  corrections: number
} {
  const db = loadSpellDb()
  const seedMiner = new MessageOverlayMiner(db.byKey)
  // EVERY seed, the persisted buckets included — the corrections a user's OWN log has earned reach
  // the parser through here and nowhere else (this runs before the fold that would re-derive them,
  // and nothing recomputes them afterwards). JOS-231 changed how counts are FILED, never which of
  // them inform the DB.
  for (const seed of overlays) seedMiner.merge(seed.counts, seed.key)
  const corrections = applyOverlayCorrections(db, seedMiner.deriveLandingCorrections())
  installSpellDb(db)
  return { db, corrections }
}

/**
 * Build every log module, in the order the bus delivers to them.
 *
 * THE ORDER IS THE DESIGN and is documented at each entry below. It is the same order pipeline.ts
 * spelled out inline before this file existed; moving it did not change it, and the bench folds it
 * unchanged.
 */
export function createModules(deps: ModuleWiringDeps = {}): ModuleWiring {
  const overlays = deps.overlays ?? []
  const { db: spellDb, corrections } = effectiveSpellDb(overlays)

  // Class-combo inference (docs/plans/class-combo-inference.md): which up-to-three classes the
  // character was running, and when that changed — a swap the game NEVER logs.
  const combo = new ComboModule()
  // The group roster (docs/plans/group-model.md): who you are with, folded from the membership
  // lines the log prints outright.
  const roster = new RosterModule()
  const loot = new LootModule()
  const turnIns = new TurnInsModule()
  // WHICH CLASSES THIS CHARACTER MAY RUN AS A PRIMARY (JOS-148) — the observed half of the Sky
  // tab's class-unlock reading, folded from the one line that states an unlock outright. Beside
  // the turn-in ledger because the two are read together and neither is derivable from the other:
  // a class unlocks from the level-11 pick or a token with no turn-in behind it at all.
  const classUnlocks = new ClassUnlocksModule()
  const kills = new KillsModule()
  // Respawn clocks (JOS-194): the same death line, read as "when can I kill it again". Its watch
  // list is user prefs the store owns, seeded here and re-synced by the IPC setter — the alerts
  // module's exact arrangement, and for the same reason (a second input that is not the log).
  const respawn = new RespawnModule(deps.respawnPrefs)
  // Leveling analytics (docs/plans/leveling-analytics.md): the capped, range-queryable series
  // behind the drag-select stats panel. A SEPARATE module from leveling on purpose — LevelingSnap
  // is uncapped by contract (the AA identity needs the whole history) and this one is a ring.
  const progression = new ProgressionModule()
  const leveling = new LevelingModule()
  const character = new CharacterModule()
  // WHEN THE PLAYER LAST EXPORTED EACH DUMP (JOS-128) — the one fact the inventory baseline
  // rule needs, folded from `Outputfile Complete: <file>`. Surface-free: main reads it directly
  // when it loads a dump, nothing in the renderer subscribes.
  const outputFiles = new OutputFilesModule()
  // WHAT IS IN YOUR GEMS (JOS-391) — the memorized bar and the CURRENT definition of each named
  // spell set. Beside `outputFiles` because it is the same kind of fact: the player operating
  // their own client, not the world acting on them. It reads three event kinds nothing else reads
  // and no other module reads its state, so its position is free.
  const spellSets = new SpellSetsModule()
  // Observed item levels (Task #60): character-scoped, epoch-aware per-item tier state.
  const itemTiers = new ItemTiersModule()
  // The alerts extension (Task #18): evaluates event/raw triggers on LIVE events only. Its defs
  // are user prefs (owned by the store), loaded in here and re-synced on every save.
  const alerts = new AlertsModule()
  alerts.setDefs(deps.alertDefs ?? [])
  // The buffs extension (Task #19; message-driven model Task #34), seeded warm with the committed
  // baseline + whatever this user's log has taught (Task #36). DERIVED EVENTS (Task #47): it is
  // the only authoritative source of the RESOLVED "wears off you / your pet" signal, and hands a
  // `buffExpired` back onto the SAME bus for the alerts module (registered after it) to match.
  const buffs = new BuffsModule(spellDb, [...overlays])
  if (deps.emitDerived) buffs.setDerivedEmitter(deps.emitDerived)
  if (deps.buffTrust) buffs.setTrust(deps.buffTrust)
  // The CROWD-CONTROL half of the buffs/timer overlay (JOS-89, docs/plans/buff-timer-overlay.md).
  // Deliberately tiny: it owns ONLY the per-target mez/root holds, which are the one thing the
  // buffs model above does not track (its landing sentence is claimed by `classifyCcApply` before
  // the DB matcher can turn it into an instance). Everything else the overlay draws — self buffs,
  // per-target debuffs, the DB duration prior, cast-anchored attribution, death/zone censoring —
  // is read off `BuffsSnap.active`, because a second fold of the same events is the two-models
  // scar world-model law 4 is made of.
  //
  // AND IT IS HANDED THE SAME ANCHORS AND THE SAME LEARNER (JOS-140 ruling 1). This is the line
  // that makes "one model" true rather than aspirational: the CC half used to keep its own cast
  // history and had no learner at all, so a mez could never be taught its real duration and the
  // two halves could disagree about whose spell had just landed.
  const buffTimers = new BuffTimersModule(buffs.castAnchors(), buffs.spellStats())
  // THE EARLY-WARNING OFFSET READS THE TIMER PROJECTION, AND NOTHING ELSE (JOS-216). An alert may
  // fire N seconds before a tracked debuff's estimated end; the end it counts back from is the very
  // row the debuffs overlay draws — `buildTimerRows` over these two snapshots — so the feature adds
  // no duration tracking of its own and can never disagree with the bar the user is looking at.
  // A LAZY reader, not a subscription: the alerts module calls it at most once per heartbeat, and
  // only while a warning is actually armed (alertsEarlyWarning.ts `idle`).
  alerts.setTimerRows(() => buildTimerRows(buffs.snapshot().state, buffTimers.snapshot().state))
  // The consider ring (Task #63): the mobs you've recently `/con`ed. It also OWNS the shared
  // own-loot index's lifetime — it folds every loot event into `ownLoot` and resets it on
  // epoch/character switch.
  const consider = new ConsiderModule({
    ...(deps.lookupMob ? { lookupMob: deps.lookupMob } : {}),
    ...(deps.ownLoot ? { ownLoot: deps.ownLoot } : {})
  })
  // The event-log feed (Task #59): the live "things worth noticing" ring behind the 'events'
  // overlay. It resolves loot notability through the SAME cache-first lookupItem the loot tab uses.
  const eventFeed = new EventFeedModule({
    ...(deps.lookupItem ? { lookupItem: deps.lookupItem } : {})
  })
  // Per-mob resist profiles (JOS-382). It reads the WIKI spell catalog to recognise a resist
  // debuff by its verbatim effect line, and nothing else — the client's spells_us.txt is joined in
  // at estimate time, never at fold time (src/main/resist/fold.ts states why). The LEDGER is
  // injected because it is the only Electron-touching part, and this function has to stay
  // constructible under plain node (the bench and tests/foldDeterminism.test.mts both do it).
  const resist = new ResistModule({
    spellDb,
    ...(deps.resistLedger ? { ledger: deps.resistLedger } : {})
  })

  return {
    spellDb,
    overlayCorrections: corrections,
    combo,
    roster,
    loot,
    turnIns,
    classUnlocks,
    kills,
    respawn,
    progression,
    leveling,
    character,
    outputFiles,
    spellSets,
    itemTiers,
    alerts,
    buffs,
    buffTimers,
    consider,
    eventFeed,
    resist,
    // combo goes FIRST (design § 5.1): within one bus delivery every later module — and the combat
    // engine, which folds the same event afterwards — then sees an already-advanced combo state.
    // roster goes SECOND for the same reason: the engine's admission gate pulls the roster through
    // a seam installed before it ever folds a line, so the roster must already be advanced.
    // eventFeed stays LAST: a row appended while an earlier module's delta is being emitted still
    // rides out on the same flush pass.
    ordered: [
      combo,
      roster,
      loot,
      turnIns,
      // Position is free: it folds one line kind no other module reads, and nothing reads its
      // state within a delivery. Beside turnIns because that is where a reader looks for it.
      classUnlocks,
      kills,
      // Beside `kills` because it folds the SAME death line — and AFTER it, so anything reading
      // both within one delivery sees the kill counted before the clock that kill started.
      // Position is otherwise free: no module reads its state.
      respawn,
      progression,
      leveling,
      character,
      // Beside `character` because it answers the same shape of question one level up: the
      // client's own bookkeeping. Position is otherwise free — it folds one line kind that no
      // other module reads and it emits no delta.
      outputFiles,
      // Beside `outputFiles` for the same reason it sits beside `character`: the client's own
      // bookkeeping, one more level of it. Free position — three event kinds nobody else folds,
      // and no module reads its state within a delivery.
      spellSets,
      itemTiers,
      alerts,
      buffs,
      // AFTER buffs, because the overlay's projection composes the two snapshots and the CC
      // ledger's END is what retires an instance the buffs model left standing — reading a
      // half-advanced pair would show a mez for one extra flush.
      buffTimers,
      consider,
      // Position is free: it reads no other module's state and pushes no delta (it is read by
      // pulling, like the combat engine). AFTER consider so a `/con` that states a mob's level is
      // already folded when the same delivery files an observation about that mob.
      resist,
      eventFeed
    ]
  }
}
