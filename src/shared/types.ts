// Types shared across the main process, preload bridge, and renderer.

import type { ConsiderFaction, LootDisposition } from './logEvents'
import type { ItemStatBlock } from './itemStats'
import type { MobKnowledge } from './mobTypes'
// The toast overlay's per-kind knobs live beside its payload in ./toast (this file is at its
// factoring ceiling); OverlayConfig names the blob, that file owns its shape + normalizer.
import type { ToastOverlayConfig } from './toast'
// Same posture for the alert banner's knobs (JOS-378): TYPE-ONLY, so the cycle it closes is
// erased at compile time, and the kind's own vocabulary lives beside the code that gives it
// meaning rather than in this file, which is at its factoring ceiling.
import type { AlertBannerOverlayConfig } from './alertBanner'
// Same posture a third time for the con card's one knob (JOS-383): TYPE-ONLY, so the cycle it
// closes is erased at compile time, and the kind's own vocabulary (its payload, its suppression
// window, its chip projection) lives beside the code that gives it meaning.
import type { ConCardOverlayConfig } from './conCard'
// TYPE-ONLY, and the cycle it closes (buffTimers.ts imports `OverlayKind` from here) is erased at
// compile time. The union lives beside the function that applies it, which is where the argument
// for each value is written down.
import type { TimerGrouping } from './buffTimers'
// Same posture again for the XP overlay's two knobs (JOS-195): TYPE-ONLY, so the cycles they
// close (both files import from here) are erased at compile time, and each union lives beside the
// code that gives it meaning rather than in this file, which is at its factoring ceiling.
import type { XpRowId } from './xpOverlay'
import type { SliceId } from './timeslice'

export type { LootDisposition, ItemStatBlock }

/**
 * The spawnable overlay window KINDS (Task #54 — overlay v2; 'events' added in Task #59):
 *   - 'fight'   : the CURRENT-fight meter + a FIGHT selector (recent encounters).
 *   - 'overall' : the ZONE meter + a ZONE-session selector.
 *   - 'events'  : the EVENT LOG — a live reverse-chronological feed of alerts firing,
 *                 notable loot, and quest completions (see FeedEvent below).
 *   - 'heal-fight' / 'heal-overall' (Task #59): the HEALING pair — the same two selection
 *                 semantics as the damage pair ('heal-fight' = current encounter, 'heal-overall'
 *                 = zone session), rendering `SegmentView.healing` instead of the damage bars.
 *   - 'toast' (docs/plans/celebration-toasts.md): the CELEBRATION strip — normally renders
 *                 nothing; a boss kill or a Sky quest completion animates a card in, holds, and
 *                 leaves. Not a meter: it has no selector, no drill and no scope.
 *   - 'buffs' / 'debuffs' (JOS-89, split in JOS-119; docs/plans/buff-timer-overlay.md): the
 *                 BUFF/TIMER bars, as TWO windows over ONE model. 'buffs' draws the beneficial
 *                 spells you have running (on yourself, on your pet, on whoever you buffed);
 *                 'debuffs' draws what you have put ON something else — debuffs and the
 *                 per-enemy crowd-control clocks (mez and slow ARE debuffs, owner ruling), so a
 *                 chain-mez shows a named countdown per enemy. They are two SURFACES, not two
 *                 models: both hydrate the same `buffs` + `buffTimers` modules and both project
 *                 through `shared/buffTimers.ts buildTimerRows`; the only difference is which
 *                 rows each one keeps (`overlayShowsRow`). Both ship DEFAULT OFF — JOS-89's
 *                 internal-validation stance continues. Neither has a selector or a drill, and
 *                 both obey one law: a duration spells.json STATES counts down, a duration
 *                 nobody states counts UP.
 *   - 'xp' (JOS-195): the PROGRESS read, floating — how fast the bar is moving, when it lands,
 *                 and motes per hour by type, over the app-wide slice (shared/timeslice.ts) with
 *                 `session` as its own default. It derives nothing: every number is the Leveling
 *                 tab's, through `renderer/overlay/xpRows.ts`. Ships DEFAULT OFF like the timer
 *                 windows. Its only configurability is a ROW CHECKLIST (`OverlayConfig.xpRows`) —
 *                 no widget builder, by owner scope.
 *   - 'alertBanner' (JOS-378): the ALERT BANNER — big text where your eyes are, for the alerts
 *                 you marked "Show on screen". Built on the celebration toast's queue machinery
 *                 (the generic half now lives in renderer/overlay/cardQueue.ts) but a SEPARATE
 *                 kind on purpose: the celebration strip sits at the top of the screen and this
 *                 belongs in the upper third where you are already looking, and the two must be
 *                 positioned, sized, held and locked independently. Ships DEFAULT OFF (owner
 *                 ruling, 2026-08-15) — it is text over the game nobody asked for until they do.
 *                 Its own knobs (hold, max lines, introduced) live in shared/alertBanner.ts.
 *   - 'conCard' (JOS-383): the CON CARD — one tooltip-shaped card at the top centre of the screen
 *                 when you `/con` a creature: its level, its zone, its five resist chips, its top
 *                 drops and its respawn. A STRIP like the two above (empty and click-through at
 *                 rest, its own queue of exactly one card), and the FIRST of the three to ship ON
 *                 (owner, 2026-08-16) — it answers a question the player just asked by typing
 *                 `/con`, which is what makes it different from text nobody asked for. Its one knob
 *                 (the auto-hide, 0 = never) lives in shared/conCard.ts.
 * Each kind has its own independently-persisted OverlayConfig (bounds/alpha/lock/text size/drill)
 * and can be open simultaneously. IPC channels + the store are keyed by this.
 *
 * APPEND NEW KINDS AT THE END. `overlayLayout.ts` derives a kind's reserved dock slot from its
 * INDEX here and `tests/overlayLayout.test.mts` pins the exact bounds of slots 0–2, so inserting
 * in the middle moves somebody's window. The SEVENTH meter kind ('debuffs') is the one this note
 * used to warn about: on a 1366×728 laptop seven uniform 380×320 slots cannot be laid out without
 * a column landing on its neighbour. That is now answered in `overlayLayout.ts` — the uniform size
 * SHRINKS (uniformly, all kinds together) on a display that cannot hold the full reserved grid —
 * rather than by silently overlapping two windows. The EIGHTH ('xp') is the first kind to arrive
 * after that machinery existed, and it absorbed it exactly as promised: MEASURED in
 * tests/overlayLayout.test.mts, 1080p and up still seat all eight reserved slots at 380×320 and
 * the small laptop shrinks one rung further rather than overlapping anything.
 *
 * The NINTH ('respawn', JOS-194) is appended on the same terms and needed no geometry code at
 * all — but it did MOVE a rung, and the measurement is recorded rather than glossed: 1080p and
 * 1440p still seat all nine at 380x320, while a 1920x960 work area (80 px shorter than 1080p with
 * a taskbar, which costs it a third row) drops to 323x272 and seats fifteen. `meterSize` chose
 * that on its own, which is the whole point of deriving the layout instead of tabulating it.
 * tests/overlayLayout.test.mts pins both halves.
 */
// prettier-ignore
export type OverlayKind = 'fight' | 'overall' | 'events' | 'heal-fight' | 'heal-overall' | 'toast' | 'buffs' | 'debuffs' | 'xp' | 'respawn' | 'alertBanner' | 'conCard'
// prettier-ignore
export const OVERLAY_KINDS: OverlayKind[] = ['fight', 'overall', 'events', 'heal-fight', 'heal-overall', 'toast', 'buffs', 'debuffs', 'xp', 'respawn', 'alertBanner', 'conCard']

/** True for the two HEALING overlay kinds (they render HealMeter, not OverlayMeter). */
export function isHealOverlayKind(kind: OverlayKind): boolean {
  return kind === 'heal-fight' || kind === 'heal-overall'
}

/** True for the kinds whose selector lists FIGHTS (the others list zone sessions). */
export function isFightOverlayKind(kind: OverlayKind): boolean {
  return kind === 'fight' || kind === 'heal-fight'
}

// The TIMER kinds' vocabulary (`TimerOverlayKind` / `isTimerOverlayKind` / `timerRowSurface`) is
// NOT here: it lives in `shared/buffTimers.ts` beside the projection whose rows it routes, so the
// two windows' one rule sits in one file. This module is at its factoring ceiling anyway — the
// same argument that put `ToastOverlayConfig` in ./toast.

/**
 * The overlay meter's mini drill-down (Task #54): which entity's flat ability list is on screen.
 * `null` (or absent) = level 1, the entity bars.
 *
 * JOS-105 added an optional `category` (a third drill level, one damage type of the source);
 * JOS-113 removed that level — per-ability stats expand INLINE now, not as a level — so the field
 * is gone. A store written by a JOS-105 build that carries a `category` needs no migration: the
 * normalizer (`store.ts`) rebuilds the drill field by field and simply drops it, degrading to the
 * flat ability list — the same "a stale drill degrades to the level it can still show" rule.
 */
export interface OverlayDrill {
  entityId: string
}

/**
 * Persisted config for one floating overlay DPS-meter window (Task #52; keyed by kind in
 * Task #54). Stored in electron-store under `overlays.<kind>`. Small + JSON-serializable.
 *
 * NO ROW BUDGET. A `topN` (5 or 10) used to cap the bars; owner feedback 2026-08-05 retired it —
 * every row renders and the content pane scrolls, because a meter that silently hid the 6th
 * healer was answering a question nobody asked. Stores written before that still carry the key
 * and are tolerated, not migrated: `getOverlayConfig` drops it on read.
 */
export interface OverlayConfig {
  /** Was the overlay open when the app last quit? Restored on launch. */
  open: boolean
  /** Locked = click-through (mouse passes to the game); unlocked = interactive. */
  locked: boolean
  /** Background translucency, 0..1 (alpha of the dark panel fill). */
  bgAlpha: number
  /** Persisted window bounds so position + size survive a restart. */
  bounds?: { x: number; y: number; width: number; height: number }
  /**
   * Persisted mini drill-down: the entity whose breakdown is showing. Remembered state, not a
   * preference — a drill survives a restart exactly like position does. A stale id (per-session
   * `pet:<instanceId>` ids don't survive a restart; the fight changed; 'you' is briefly absent
   * between fights) renders level 1 WITHOUT clearing the stored value, so the drill re-applies
   * the moment the entity reappears. Only an explicit back/undrill (or picking a different
   * fight/zone session) clears it.
   *
   * `null` (or absent) IS LEVEL 1 — the ranked source list, which is what every meter and the
   * Combat tab open on (owner ruling 2026-08-05, JOS-35; renderer `features/combat/petRows.ts`).
   * It used to mean "no drill of my own", with the pet preference then choosing the opening
   * level; a stored `null` written under that rule reads correctly here — it is still "the level
   * I did not drill from".
   */
  drill?: OverlayDrill | null
  /**
   * The 'toast' kind's own knobs (sound / volume / duration — shared/toast.ts). Present only
   * on that kind; every other kind ignores it. Optional so a store written before the toast
   * landed round-trips untouched and `getOverlayConfig` fills it from the defaults.
   */
  toast?: ToastOverlayConfig
  /**
   * The 'alertBanner' kind's own knobs (hold / max lines / introduced — shared/alertBanner.ts).
   * Present only on that kind; `setOverlayConfig` deletes it everywhere else so a malformed patch
   * cannot grow one on a meter. Optional so every store written before JOS-378 round-trips
   * untouched and `getOverlayConfig` fills it from the defaults — the toast blob's arrangement,
   * for the same reason.
   */
  alertBanner?: AlertBannerOverlayConfig
  /**
   * The 'conCard' kind's own knob (the auto-hide, 0 = never — shared/conCard.ts). Present only on
   * that kind; `setOverlayConfig` deletes it everywhere else so a malformed patch cannot grow one
   * on a meter. Optional so every store written before JOS-383 round-trips untouched and
   * `getOverlayConfig` fills it from the defaults — the two blobs above, arranged the same way.
   */
  conCard?: ConCardOverlayConfig
  /**
   * TEXT SIZE for this overlay, as a CSS `zoom` factor on its CONTENT pane (1 = as shipped;
   * owner feedback, 2026-08-05: "text size scaling for overlays. we are old folks now."). It
   * scales the reading matter — bars, feed rows, toast cards — and NOT the control chrome, which
   * lays out against the real window width so a scaled overlay can never push its own controls
   * out of the window (renderer `overlay/overlayScale.tsx`).
   *
   * Per KIND, like every other knob here: the damage meter you read mid-pull and the event log
   * parked on a second monitor are not the same reading distance.
   *
   * Optional so a store written before this landed round-trips untouched; `getOverlayConfig`
   * fills (and clamps) it on the way out, exactly as it does the toast blob above.
   */
  textScale?: number
  /**
   * HOW THE TWO TIMER WINDOWS ARRANGE THEIR ROWS (JOS-140) — 'none' for one flat
   * soonest-to-expire list, 'target' for per-target blocks. Present only on the 'buffs' and
   * 'debuffs' kinds; every other kind ignores it, and `setOverlayConfig` deletes it there so a
   * malformed patch cannot grow one a meter.
   *
   * ABSENT MEANS "the window's own default", which is not the same for both: debuffs open flat
   * (the owner's ask — a queue of things running out) and buffs keep their blocks. So it is
   * optional rather than defaulted here, and shared/buffTimers.ts holds the per-surface answer.
   */
  grouping?: TimerGrouping
  /**
   * SHOW THE BUFFS THAT NEVER EXPIRE (JOS-215) — Yaulp, the Shielding ladder, a rogue's blade
   * coats, a druid's wolf form. Present only on the 'buffs' and 'debuffs' kinds, like `grouping`
   * above, and `setOverlayConfig` deletes it everywhere else.
   *
   * ABSENT MEANS HIDDEN, and that is the owner's ruling for this ticket rather than a default
   * anyone is free to re-argue: a permanent buff has no clock, so it can never be the thing you
   * are watching a timer window to see, and a stack of them at the bottom of every bar list would
   * push the countdowns that matter off the top. The user who wants the roster switches it on.
   *
   * IT IS A RENDERER FILTER, NOT A MODEL ONE — the same shape the grouping chip beside it has. The
   * rows exist in the model either way (they have to: the hygiene sweep, the wear-off and the death
   * censor all act on them), and only the window decides whether to draw them. Nothing is ever
   * hidden from the learner, because there is nothing here for the learner to hear.
   *
   * Stored ONLY when true, so "absent" and "the default" are the same fact rather than two.
   */
  showPermanent?: boolean
  /**
   * WHICH ROWS THE XP OVERLAY DRAWS (JOS-195) — the whole of that window's configurability, by
   * owner scope: a checklist, never a widget builder. Present only on the 'xp' kind;
   * `setOverlayConfig` deletes it everywhere else so a malformed patch cannot grow one on a meter.
   *
   * ABSENT MEANS EVERY ROW, and it is deliberately a different answer from `[]` — which is a user
   * who switched all three off and is entitled to their empty window. `shared/xpOverlay.ts`
   * normalizes it (closed union, deduped, this-file's order) on the way in.
   */
  xpRows?: XpRowId[]
  /**
   * WHICH STRETCH THAT WINDOW MEASURES (JOS-195) — one id from the app-wide slice vocabulary
   * (shared/timeslice.ts, JOS-130), which is also where JOS-71's duration rungs live now.
   *
   * ABSENT MEANS `zoneSession` (owner ruling, JOS-288 — it was `session` from JOS-195 until then).
   * A floating pace read is asking "how am I doing right now", and the audit measured what the
   * session slice alone does to that answer: across a loadout swap the session's `levelEquiv` sums
   * straight over the LEVEL-50 leg that preceded it, so the same instant read 7.03 lvl/hr in
   * `zoneSession` and a diluted figure in `session`, and the scope disagreement against `all` was
   * 10x. The camp you are standing in, this session, is the stretch the number is about.
   *
   * It DEGRADES rather than sticks — a preset this record cannot define is not offered, and
   * `resolveSliceId` falls back to `all` exactly as the tab's control does.
   *
   * It is remembered per window like position is, not shared with the main app's pick: the two
   * are read at different moments, and a slice chosen on the Loot tab has no business silently
   * re-scoping a window floating over the game.
   */
  xpSlice?: SliceId
  // THE XP WINDOW'S DENOMINATOR AND ITS TIER MEMBERSHIP USED TO BE TWO MORE KEYS HERE (`xpBasis`,
  // JOS-288; `xpZoneScope`, JOS-291) AND THEY ARE GONE (JOS-332).
  //
  // Not because the window stopped having them — it still draws both toggles in its footer — but
  // because they were never this window's facts to remember. The Leveling tab shows the same two
  // controls, and while each side kept its own copy the reader had no way to tell which one the
  // numbers in front of them obeyed: the owner had *this tier* on screen over the game and read the
  // every-tier `elapsed 27m` off the tab. They are now ONE app-wide selection held in main and
  // fanned out to every window (`shared/scopeSelection.ts`), EPHEMERAL like the global fight
  // selection beside it, because both halves were already session-lifetime in the app and one fact
  // cannot have two lifetimes.
  //
  // A store written by an older build may still carry the two keys; `setOverlayConfig` no longer
  // preserves them, so the first patch of any kind drops them. One dead scalar (two, here) is not
  // worth a schema bump — the same verdict `topN` got in `getOverlayConfig`.
  //
  // `xpSlice` deliberately STAYED: which stretch a floating window measures is its own business
  // (its doc above says why), and it is not a knob the tab also shows.
}

// The overlays TEXT SIZE (owner feedback 2026-08-05) lives in ./overlayTextScale.ts and is
// re-exported here, so every importer of `@shared/types` is untouched. See that file for why.
export { TEXT_SCALE_DEFAULT, TEXT_SCALE_MAX, TEXT_SCALE_MIN, TEXT_SCALE_STEP, clampTextScale } from './overlayTextScale'
// …and the overlays' BACKGROUND TRANSPARENCY (JOS-407) lives in ./overlayBgAlpha.ts on exactly the
// same terms. Only the clamp is re-exported: `OverlayConfig.bgAlpha` above is the field it governs,
// and store.ts reads it beside `clampTextScale` on the very next line of the same function.
export { clampBgAlpha } from './overlayBgAlpha'

/** One EverQuest character whose log we watch. */
export interface CharacterRef {
  name: string
  server: string
  logPath: string
  /** log file mtime (ms) — used as "last played" */
  lastPlayed?: number
}

/**
 * "ANOTHER CHARACTER'S LOG IS ACTIVE — SWITCH?" (JOS-432), main → the main window.
 *
 * Sent at most ONCE per candidate log per app session; the guarantee and the whole argument live in
 * `src/main/log/quietSwitch.ts`. It is a QUESTION and nothing else — the app never switches by
 * itself (owner ruling, 2026-08-21: two accounts on one PC must never get yanked between
 * characters), so the renderer's only powers are to offer `character:set` and to forget the card.
 */
export interface LogSwitchNudge {
  /** The sibling log we watched grow — what the offer is to switch TO. */
  candidate: CharacterRef
  /** The character we are attached to, whose log has gone silent. */
  attached: CharacterRef
  /** How long that log had been silent when we asked, in ms. */
  quietMs: number
}

/**
 * The effective EQ install-dir configuration surfaced to the Settings UI. `root`
 * is the directory in use (override ?? auto-discovery ?? default); `source` says
 * how it was chosen; `characterCount` is how many `eqlog_*.txt` logs were found
 * under `<root>\Logs` (0 ⇒ show the empty-state prompt).
 */
export interface EqConfig {
  root: string
  logsDir: string
  source: 'manual' | 'auto' | 'default'
  characterCount: number
  /** Whether a manual override is currently persisted (vs auto-detecting). */
  overridden: boolean
  /**
   * How reading `logsDir` went (JOS-82). `characterCount` is 0 for BOTH "the folder holds no
   * character log" and "the folder could not be listed at all", and those two need opposite
   * advice — so the verdict the card prints reads this, never the count alone.
   */
  readable: 'ok' | 'missing' | 'unreadable'
  /** The OS errno behind `readable === 'unreadable'` (e.g. 'EPERM'), for the card's copy. */
  readError?: string
}

/** Result of picking/validating an EQ install dir from the Settings folder-picker. */
export interface EqConfigResult {
  /** false when the user cancelled the OS folder dialog. */
  ok: boolean
  config: EqConfig
}

/** A single parsed log line. */
export interface LogLine {
  /** epoch millis from the bracketed timestamp */
  ts: number
  /** the message text after the timestamp */
  text: string
  /** raw line as read from disk */
  raw: string
}

/** A loot event detected in the log ("You have looted a X from <mob>'s corpse"). */
export interface LootEvent {
  ts: number
  item: string
  /** mob the item was looted from, if present */
  source?: string
  /** zone the character was in when it was looted */
  zone?: string
  /**
   * Auto-disposition (Tasks #40/#47) for looted-and-routed lines — currency/hoard/depot
   * are kept (held), sold is gone, combined is net-zero (consumed into `created`). The
   * ONE held-count rule lives in computeHeldCounts (features/posky/heldCounts.ts).
   * Undefined for ordinary kept loot.
   */
  disposition?: LootDisposition
  /** Stack size when the line names one (`2 Bone Chips`); undefined = 1 (Task #47). */
  count?: number
  /** The upgraded item a 'combined' loot created (`… to create a <item> +N`). */
  created?: string
}

/** A completed NPC trade / quest turn-in ("You offered … / complete the trade"). */
export interface TurnInEvent {
  ts: number
  npc: string
  items: string[]
}

/** A level-up ("You have gained a level! Welcome to level N!"). */
export interface LevelEvent {
  ts: number
  level: number
}

/** An AA/ability-point gain ("You have gained N ability point(s)! You now have M"). */
export interface AAEvent {
  ts: number
  /** points gained by this event */
  amount: number
  /** unspent points the game reports after the gain */
  nowHave: number
}

/**
 * An AA-potion quaff ("You are filled with the spirit of alternate adventure.").
 *
 * A timestamp and nothing else, because the line says nothing else — not the charges, not the
 * multiplier. `shared/aaPace.ts` is where those are modelled, cross-checked against the points
 * the gain lines actually stated, and labeled.
 */
export interface AAPotionEvent {
  ts: number
}

/** An AA purchase ("You have gained the ability X at a cost of N ability points"). */
export interface AASpendEvent {
  ts: number
  /** ability name, including the trailing rank when present (e.g. "Mnemonic Retention 5") */
  ability: string
  cost: number
  /** the rank number when the line is the "You have improved <name> <rank>" form */
  rank?: number
}

// Aggregated kill info for a mob (for loot sourcing + boss instance tiers). The record is
// PER INSTANCE TIER and lives in ./kills (this file is at its factoring cap); re-exported
// here so every existing `from '@shared/types'` import keeps working.
export type { KillInfo, KillMap, KillTierRun } from './kills'

// ----- Plane of Sky quest data (produced by scripts/scrape-posky.ts) -----

export interface PoskyItem {
  /** required turn-in item name */
  name: string
  /** mobs/NPCs known to drop it */
  who: string[]
  /** island / location string from the wiki */
  where: string
  /** how many are needed (defaults to 1) */
  count: number
  /** wiki page title for the item (for linking) */
  page?: string
  /** EQ-style stat block text (name/flags/slot/stats), for the hover popover */
  stats?: string
}

export interface PoskyQuest {
  /** class this quest unlocks / belongs to, e.g. "Paladin" */
  className: string
  /** quest name, e.g. "Test of Sacrifice" */
  name: string
  /** quest-giver NPC, if known */
  giver?: string
  /** required wind rune, if listed */
  rune?: string
  /** reward item name */
  reward?: string
  /** reward item stat blob (EQ-style text) */
  rewardStats?: string
  /** wiki page title for the reward item */
  rewardPage?: string
  /** required turn-in items */
  items: PoskyItem[]
  /** source wiki page title */
  source: string
}

export interface PoskyData {
  scrapedAt: string
  quests: PoskyQuest[]
}

// ----- Wiki quest catalog (produced by scripts/scrape-quests.ts) -----
//
// The SECOND local-first source for item knowledge. Item pages only carry a quest
// association when someone filled in their `|relatedquests` field, so classic turn-in
// items (Dwarven Ale, Guard Bracelet, …) look quest-less from the item side. The linkage
// actually lives on the QUEST pages, which this catalog indexes item-first.

/** One quest scraped from an eqlwiki quest page (Category:Quests + quest subcategories). */
export interface QuestEntry {
  /** display name (the wiki page title) */
  name: string
  /** wiki page title (linkable) */
  page: string
  /** "Start Zone" cell */
  startZone?: string
  /** "Quest Giver" NPC */
  giver?: string
  /** "Minimum Level" (numeric part only) */
  minLevel?: number
  /** classes the quest is offered to ("All" when unrestricted) */
  classes?: string[]
  /** "Related Zones" cell */
  relatedZones?: string[]
  /** "Related NPCs" cell */
  relatedNpcs?: string[]
  /** reward items (from the Reward section's item boxes/links) */
  rewards?: { name: string }[]
  /** items the quest body references (turn-ins / collectibles), reward items excluded */
  requiredItems?: string[]
  /** page carries an experience-reward marker */
  expReward?: boolean
}

export interface QuestData {
  scrapedAt: string
  /** human-readable provenance, e.g. "eqlwiki.com Category:Quests (+ subcategories)" */
  source: string
  quests: QuestEntry[]
}

// ----- Item knowledge ("what's this lore/quest item for", Task #53) -----

/** One quest an item is used in (or given by), as learned from the wiki / posky. */
export interface ItemQuestUse {
  /** quest display name (e.g. "Paladin Test of Love", "Coin of Tash (Tashania spell)") */
  quest: string
  /** wiki page title to resolve the quest (for future linking); may equal `quest` */
  page?: string
  /**
   * Where this association came from: the local Plane of Sky dataset, the local scraped
   * wiki quest catalog (`quests.json`), or a live item-page `|relatedquests` lookup.
   */
  source: 'posky' | 'quests' | 'wiki'
  /** quest-giver NPC, when known (posky / quests) */
  giver?: string
  /**
   * How the item relates to the quest, when the source knows: a turn-in/collectible
   * ('required') or something the quest hands out ('reward'). Omitted by posky/wiki uses.
   */
  role?: 'required' | 'reward'
  /** the quest's start zone, when known (quests catalog only) */
  zone?: string
  /**
   * What the quest HANDS OUT, for a `role: 'required'` use — i.e. the outcome of turning
   * this item in. Names only (capped; see MAX_ATTACHED_REWARDS), so the UI can offer the
   * reward item as its own hoverable card without a second index. Present ONLY on the
   * 'quests' source and ONLY when the catalog actually names rewards (law 1: never
   * invented), and never on a 'reward'-role use — an item is not its own outcome.
   */
  rewards?: string[]
}

/**
 * One place the ITEM PAGE itself says this item drops (`|dropsfrom`) — a mob, and the zone
 * heading it was listed under when the page grouped its mobs by zone.
 *
 * This is a SECOND, independent witness to the mob catalog's `|known_loot` inversion, not a
 * replacement for it: the catalog answers "what does this mob drop", the item page answers
 * "where does this item come from", and the two disagree by omission in both directions (43 of
 * the 126 effect-bearing donors the catalog knows no source for are zone-resolvable from their
 * own page). `zone` is absent when the page listed mobs with no zone heading above them — an
 * unknown zone, never a guessed one (law 1).
 */
export interface ItemDropSource {
  /** the mob as the page writes it ("a froglok gaz squire") — display text, wiki markup stripped */
  mob: string
  /** the nearest preceding zone heading; absent when the page stated none */
  zone?: string
}

/**
 * One tradeskill recipe that CONSUMES this item as an ingredient (item page `|recipes`).
 * This is the answer for the large family of items whose stats block says QUEST ITEM but
 * which appear in no quest anywhere on the wiki: they are tradeskill components.
 */
export interface ItemRecipeUse {
  /** the recipe / result item name ("Gnome Kabobs") */
  recipe: string
  /** wiki page title, when the link was piped and differs from the label */
  page?: string
  /** the tradeskill it sits under ("Baking"), when the field grouped it */
  tradeskill?: string
  /** trivial level, when the line states one */
  trivial?: number
}

/** One ingredient line of a recipe that PRODUCES this item. */
export interface ItemCraftIngredient {
  name: string
  /** how many the combine consumes, when stated */
  qty?: number
  /** where the ingredient comes from, verbatim ("Bought", "Dropped", "Crafted", …) */
  sources?: string[]
}

/** One way this item is itself player-crafted (item page `|playercrafted`). */
export interface ItemCraftRecipe {
  /** "Baking", "Blacksmithing", "Pottery" … */
  tradeskill?: string
  trivial?: number
  /** the combine container ("Oven", "Forge", "Kiln") */
  container?: string
  /** what the combine yields — normally this item */
  yieldItem?: string
  yieldQty?: number
  ingredients: ItemCraftIngredient[]
}

/** The "what's this item for" knowledge card for a single item name. */
export interface ItemKnowledge {
  /** the item name looked up (as requested; display name, not normalized) */
  name: string
  /** the wiki page title actually resolved (may differ via redirect/search) */
  page?: string
  /** LORE ITEM flag (only one may be held at a time) */
  lore: boolean
  /** QUEST ITEM flag OR any related-quest association (a quest/collectible piece) */
  quest: boolean
  /** quests this item is required by / used in */
  questUses: ItemQuestUse[]
  /** where the ITEM PAGE says it drops (`|dropsfrom`) — mob + the zone heading it sat under */
  dropsFrom?: ItemDropSource[]
  /**
   * The wiki's own era claim for this page, VERBATIM ("Velious", "Chardok Revamp", "kunark") —
   * from the page-top `{{X Era}}` banner (`parseEraTag`), or, on the 52 pages that carry no banner
   * but file themselves under an era anyway, from the page's `[[Category:X Era]]`
   * (`parseEraCategory`, JOS-328). The banner wins; the category speaks only into its silence.
   * Neither is an `{{Itempage}}` field. Absent when the page states no era either way. What a
   * token MEANS is decided in `shared/planner/era.ts`, never here.
   */
  eraTag?: string
  /** one-line freeform summary (from the wiki `notes` field), trimmed */
  summary?: string
  /** the raw stat/flag block text from the item page (LORE/NO DROP/slot/…) */
  statsBlock?: string
  /**
   * The same stat block parsed into the in-game item WINDOW's structure (flags, slot,
   * class/race, attributes, saves, effects) so the UI can draw it with the game's
   * hierarchy instead of dumping monospace text. Base/wiki data only — it carries no
   * tier or exaltation-socket state, because item pages don't have any.
   */
  stats?: ItemStatBlock
  /** wiki icon id (`lucy_img_ID`) → File:Item <id>.png on eqlwiki */
  iconId?: number
  /** tradeskill recipes that USE this item as an ingredient (`|recipes`) */
  recipes?: ItemRecipeUse[]
  /** prose fallback when `|recipes` wasn't a parseable bullet list */
  recipesNote?: string
  /** true ONLY when a structured `|playercrafted` recipe was read (never inferred) */
  playerCrafted?: boolean
  /** how this item is made — one entry per craft recipe (`|playercrafted`) */
  craftedBy?: ItemCraftRecipe[]
  /** prose fallback when `|playercrafted` wasn't a structured recipe ("Non-Tradeskill (Quest)") */
  craftedNote?: string
  /** whether this result was served from cache (vs a fresh network lookup) */
  cached: boolean
  /** true when the wiki lookup was attempted but found no page (negative result) */
  notFound?: boolean
  /** true when the wiki was unreachable (offline) — local posky data may still apply */
  offline?: boolean
}

// ----- Mob knowledge -----
//
// The scraped catalog (`MobEntry`/`MobData`) and the consider card (`MobKnowledge` and
// friends) live in ./mobTypes.ts — this barrel grew past its measured 400-code-line ceiling
// when the map viewer added spawn coordinates, and the block moved out rather than the rule
// moving up. Re-exported here so every existing `@shared/types` import keeps working.
export type * from './mobTypes'

// ----- consider module (Task #63) -----

/**
 * One row of the "recently considered" ring — ONE PER MOB, most recent con wins. A mob conned
 * five times in a pull is one row with `cons: 5`, not five rows: the ring answers "what have I
 * been sizing up", and five identical lines answer it worse than one.
 */
export interface ConsiderRow {
  /** stable id (the canonical mob key) — the React key AND the delta merge handle */
  id: string
  /** RAW display name of the most recent con (see logEvents.ConsiderEvent.mob) */
  mob: string
  /** timestamp of the most recent con */
  ts: number
  rare: boolean
  level?: number
  faction: ConsiderFaction
  /** VERBATIM difficulty clause — considerDifficultyShort() renders it */
  difficulty: string
  /** the zone we were in when we conned it, when known */
  zone?: string
  /** how many times this mob has been conned since the last reset */
  cons: number
  /** async enrichment (mobLookup). Absent until it lands — never blocks the event path. */
  knowledge?: MobKnowledge
}

/** consider module. Delta = the rows that changed (new cons + landed enrichment). */
export type ConsiderSnap = ConsiderRow[]
export interface ConsiderDelta {
  upserted: ConsiderRow[]
}

// ----- Raid targets (bosses) -----

export interface RaidTarget {
  /** display name */
  name: string
  /** grouping, e.g. "Plane of Hate", "Dragons", "Gods & Avatars" */
  category: string
  /** exact in-log "slain" names to match against kills */
  match: string[]
  /** hotlinked wiki image URL */
  image?: string
  /** home zone / instance */
  zone?: string
}

export interface BossData {
  scrapedAt: string
  targets: RaidTarget[]
}

// ----- Module transport payloads (see main/modules/*) -----
//
// Each built-in module has a Snap (full hydration state) and a Delta (the
// increment applied by useModule). Kept here because preload + renderer both
// need them and shared/types.ts is the one place all three layers import from.

/** Payload of the generic `module:delta` push. */
export interface ModuleDelta<Delta = unknown> {
  moduleId: string
  seq: number
  delta: Delta
}

/** Payload of the generic `module:getSnapshot` reply. */
export interface ModuleSnapshot<Snap = unknown> {
  seq: number
  state: Snap
}

/** loot module. Delta = loot rows appended since the last flush. */
export type LootSnap = LootEvent[]
export interface LootDelta {
  appended: LootEvent[]
}

/** turnins module. Delta = turn-ins appended since the last flush. */
export type TurnInSnap = TurnInEvent[]
export interface TurnInDelta {
  appended: TurnInEvent[]
}

// classUnlocks module (JOS-148). Defined in ./classUnlocks beside the record itself and the
// argument for its shape, on the `kills.ts` precedent — this file is at its line budget.
export type { ClassUnlockDelta, ClassUnlockRecord, ClassUnlockSnap } from './classUnlocks'

// kills module. Snapshot = the map + its shape version; delta = the per-mob entries that
// changed, each REPLACING its mob wholesale. Defined in ./kills beside the record itself.
export type { KillsSnap, KillsDelta } from './kills'

/** leveling module: levels + AA gains + AA spends. */
export interface LevelingSnap {
  levels: LevelEvent[]
  aaGains: AAEvent[]
  aaSpends: AASpendEvent[]
  /** AA-potion quaffs in log order. Uncapped like its siblings — the charge count is read off
   *  the LAST one, and a bottle never expires, so an old activation is still load-bearing. */
  aaPotions: AAPotionEvent[]
}
export interface LevelingDelta {
  levels: LevelEvent[]
  aaGains: AAEvent[]
  aaSpends: AASpendEvent[]
  aaPotions: AAPotionEvent[]
}

/** character module: current character, zone, and the level the log last STATED (JOS-192). The
 *  shapes moved to ./characterTypes when the level field pushed this file over its ceiling. */
export type { CharacterDelta, CharacterSnap } from './characterTypes'

/**
 * itemTiers module (Task #60): the OBSERVED item level of an item the CURRENT character has
 * merged. One row per base item name; absent = unknown (never tier 0). See
 * main/modules/itemTiers.ts for what counts as evidence.
 */
export interface ItemTierRow {
  /** `itemTierKey(name)` — lowercased, ` +N` stripped (the loot counting key) */
  key: string
  /** RAW base name for display ("Thelvorn, Blade of Light") */
  name: string
  /** HIGHEST tier observed. Undefined on a merge that named no item level (spell scroll). */
  tier?: number
  /** tier named by the MOST RECENT observation (several copies climb in parallel) */
  lastTier?: number
  /** how many merges we watched land on this item name */
  merges: number
  firstAt: number
  lastAt: number
}
/** kills-style map transport: full map to hydrate, changed rows as the delta. */
export type ItemTiersSnap = Record<string, ItemTierRow>
export interface ItemTiersDelta {
  changed: ItemTiersSnap
}

// ----- Event feed / event-log overlay (Task #59) -----
//
// A capped, LIVE-ONLY stream of "things worth noticing" — what the 'events' overlay renders in
// reverse-chronological order. The feed module (main/modules/eventFeed.ts) is the single source
// of truth; it is fed from three places, all of them already-existing detectors:
//   'alert' — the alerts module fired (main-side event/raw triggers) or the renderer routed an
//             'app'-signal fire through alerts:appFired.
//   'loot'  — a LIVE loot line whose item resolved (itemLookup, cache-first) to a NOTABLE
//             record (lore / quest / used by a quest). Same predicate as the loot tab's
//             "notable pickups" strip (shared/itemKnowledge.ts).
//   'quest' — a Sky quest completed live (the renderer's useProgress turn-in detector, reported
//             over `feed:report`).
//
// HONESTY (world-model law 1): every field here is either observed or scraped. `reward` exists
// only when the quest dataset actually names a reward item — an unknown reward shows NO item
// hover rather than a fabricated one, and `page` is absent when no wiki page is known.

export type FeedEventKind = 'alert' | 'loot' | 'quest' | 'con'

/**
 * The consider context of a 'con' row (Task #63). Carried structurally instead of baked into
 * `detail` so the overlay can color the row by FACTION rung and its hover card can lead with
 * the same facts without re-parsing a sentence. Every field came off the log line.
 */
export interface FeedConsider {
  faction: ConsiderFaction
  level?: number
  rare: boolean
  /** VERBATIM difficulty clause */
  difficulty: string
}

/** The item a quest awards, when the quest data actually names one. */
export interface FeedReward {
  /** reward item display name */
  item: string
  /** wiki page title for the reward item (for the hover card's link), when known */
  page?: string
  /** EQ-style stat blob from the scraped quest data — renders offline, before any lookup */
  stats?: string
}

/** One entry in the live event feed. */
export interface FeedEvent {
  /** stable id (monotonic, per session) — the React key + dedupe handle */
  id: string
  kind: FeedEventKind
  /** epoch millis of the underlying log line / signal */
  ts: number
  /** headline: the alert name, the item name, or the quest name */
  title: string
  /** supporting line: what triggered the alert, the source mob, the quest's class */
  detail?: string
  /** wiki page TITLE this row links to (quest page for quests, item page for loot) */
  page?: string
  /** for a quest that awards an item: what you got. Absent when the data doesn't say. */
  reward?: FeedReward
  /** for a 'con' row: the consider facts, structurally (Task #63). */
  con?: FeedConsider
}

/** eventFeed module. Delta = feed entries appended since the last flush. */
export type FeedSnap = FeedEvent[]
export interface FeedDelta {
  appended: FeedEvent[]
}

/**
 * What the RENDERER may report into the feed over `feed:report` (main owns ids + the ring).
 * Today: quest completions, which only the renderer's posky/turn-in machinery can detect.
 */
export interface FeedReport {
  kind: 'quest'
  ts: number
  title: string
  detail?: string
  page?: string
  reward?: FeedReward
}

// ----- The persisted per-character record (JOS-286: MOVED, not changed) -----
//
// `HeldCounts`, `CountSource`, `ProgressState`, `PetClaimEdit` and `RosterEdit` now live in
// ./progressState.ts. This file was AT the measured 400-code-line ceiling and the repo law is to
// SPLIT rather than to widen a threshold (windows.ts → windowErrors.ts, store.ts → storePlans.ts
// are the precedents). Re-exported here so every importer keeps the door it already used.
export type { CountSource, HeldCounts, PetClaimEdit, ProgressState, RosterEdit } from './progressState'
// The hand-stated held count (JOS-186) lives in ./itemOverrides.ts with the rules that govern it,
// and comes back through this door for the same reason the five names above do.
export type { ItemCountOverride } from './itemOverrides'

// ----- Cross-window deep link ("take me to this in the app", Task #64) -----
//
// An overlay window is a GLANCE surface: it says a thing happened, in a few square inches, over
// the game. When the thing it named deserves a real answer — a con row's mob and everything it
// drops — the overlay's job ends and the MAIN WINDOW's begins. This is the payload that hands
// off: the overlay asks main to focus the app on a view, main shows/focuses the window and
// forwards the same payload to the app's renderer, which switches tabs and drills.
//
// Deliberately a small, CLOSED union rather than a route string: a renderer window asking
// another window to navigate is a capability, and the set of destinations it may name is
// spelled out here (and re-validated at the IPC handler) instead of being whatever text the
// asking window happened to send.

/**
 * Destinations a deep link may name. Three today; the union is the extension point.
 * 'posky' is the Sky celebration toast's click target (docs/plans/celebration-toasts.md T6);
 * 'leveling' is the level-up toast's (docs/plans/levelup-whats-new.md §2) — a ding fired, and
 * clicking the card opens the Leveling tab's "New at this level" panel AT THAT LEVEL.
 */
export type AppFocusView = 'mobs' | 'posky' | 'leveling'

/**
 * "Focus the app on this." Every payload field is OPTIONAL and view-scoped: the view is the
 * destination, the field is the anchor inside it. A field the destination does not understand is
 * simply unused — the union stays closed, and each anchor is validated at the IPC handler.
 */
export interface AppFocus {
  view: AppFocusView
  /** the mob to drill into, when the request targets a specific one ('mobs'). RAW display name. */
  mob?: string
  /** the Sky quest to expand + scroll to ('posky'), as the canonical `Class::Name` quest key. */
  quest?: string
  /** the character level the "New at this level" panel opens on ('leveling'). */
  level?: number
}

// ----- Auto-update (Task #27) -----

/**
 * Release channel the auto-updater tracks:
 * - 'main'   : bleeding edge — every push to main publishes a prerelease here
 * - 'stable' : only tagged `v*` releases (the `latest` electron-updater channel)
 *
 * No longer user-selectable (Task #55): the stored value is read internally so
 * existing installs keep their feed; new installs default to 'main'.
 */
export type UpdateChannel = 'main' | 'stable'

/**
 * Update lifecycle pushed over `update:status` (main -> renderer) AND returned by
 * the `update:getStatus` pull (a late-mounting Preferences view would otherwise
 * miss every push). `percent` is present while downloading; `version` once known;
 * `message` on error; `checkedAt` is epoch millis of the last COMPLETED check
 * (not-available / available / error all count) and rides along on every
 * subsequent status so "Last checked" never blanks mid-download.
 */
export interface UpdateStatus {
  state: 'idle' | 'checking' | 'available' | 'downloading' | 'ready' | 'error'
  version?: string
  percent?: number
  message?: string
  checkedAt?: number
  /** The updater machinery is OFF for this process (dev / unpackaged build). The UI must say
   *  so instead of showing an eternally-stale "not checked yet" that reads as a broken
   *  updater — dev is the only place that state can persist. */
  disabled?: boolean
}

// ----- Split-out sections -----
//
// Alerts + sound packs, and the spell/buff model, used to live in this file verbatim. They
// were moved out purely for file mass (max-lines). `shared/types` stays the ONE import site
// for every consumer, so nothing downstream changed.
// The re-export is EXPLICIT (never `export *`): the test suite runs these modules through
// tsx's CJS transform, where a star re-export becomes a runtime property copy that the ESM
// named-import linker cannot see — `import { X } from '../src/shared/types'` in a .mts test
// would fail to link. Naming each export also keeps this list a readable index.
export type {
  LogEventKind,
  AppSignal,
  AlertTriggerPrimitive,
  AlertTriggerComposite,
  AlertTrigger,
  AlertSoundRef,
  AlertDef,
  AlertPrefs,
  SpeechMode,
  AlertAudio,
  AlertAudioChoice,
  AlertSpeech,
  SpeechEngine,
  VoicePrefs,
  SpeechVoice,
  SpeechUnavailableReason,
  SpeechSayRequest,
  SpeechSayResult,
  SpeechInstallResult,
  SpeechInstallProgress,
  FiredAlert,
  AlertFireRecord,
  AlertsSnap,
  AlertsDelta,
  SpellCastRecency,
  PoisonSlowRecency,
  PackSound,
  SoundPackManifest,
  SoundPack,
  SoundData,
  RegistryPack,
  RegistryPackView,
  RegistryListResult,
  PackInstallProgress,
  PackMutationResult,
  PackPreviewSound,
  PackPreviewList,
  UserSound,
  UserSoundRejection,
  UserSoundImportResult,
  UserSoundRemoveResult
} from './alertTypes'

export type {
  BuffClass,
  BuffStat,
  EstimatorSource,
  ActiveBuff,
  OverlayVerdict,
  OverlayMessage,
  MessageOverlay,
  BuffsSnap,
  BuffsDelta,
  SpellEntry,
  SpellDbFile,
  SpellTemplateFlags,
  SpellCatalogEntry,
  SpellCatalog
} from './buffTypes'

export type {
  ProgressionSnap,
  ProgressionDropFront,
  ProgressionDelta,
  ProgressionKill
} from './progressionTypes'

// NOTE (presence-driven settings — the cursor ring + overlay auto-hide): their shapes
// (CursorRingPrefs, OverlayAutoHidePrefs, PresenceState, ScreenRect, CursorPoint) are NOT
// re-exported here. They live in `shared/presencePrefs.ts` beside their normalizers — the
// `shared/speechText.ts` arrangement, because `storeMigrations.ts` must reach the normalizers
// from store.ts's module scope without importing this file (and the LogEvent union behind it).
// Consumers import them from `@shared/presencePrefs` directly, which is a deliberate exception
// to the one-import-site convention: this file is AT the 400-code-line factoring ceiling, and
// widening a measured threshold to hold five re-export names is exactly the trade the ratchet
// exists to refuse.
