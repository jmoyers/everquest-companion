// The canonical, typed log-event stream. ONE parse pass over the EQ Legends log
// produces this discriminated union (see main/log/parser.ts). Both feeders (the
// historical scan and the live tailer) emit these onto the in-main bus
// (main/log/bus.ts); every consumer (loot/kills/levels/AA reducers, the combat
// engine, the coming world model) subscribes to the stream instead of running its
// own regexes. Keep this pure and serializable — no behavior, just data.

import type { DamageType, DamageCategory } from './combat'
import type { PoisonEffect, PoisonGroup } from './poisons'
// The /consider LADDER (rungs, chip labels, the app's faction palette, the difficulty
// shorthand) moved to ./considerFaction in JOS-128, when this file hit its 400-line factoring
// ceiling. Three of the four are presentation and the fourth is the parser's phrase table, so
// none of them was an event shape. RE-EXPORTED verbatim below: every existing import site still
// reads them from `@shared/logEvents`, exactly as it always has.
import type { ConsiderFaction } from './considerFaction'

// The ACQUISITION event shapes (coin / itemReceived / purchase — JOS-144) live in
// ./acquireEvents for the same reason the consider ladder moved out: this file is long past its
// factoring ceiling. RE-EXPORTED verbatim, so every consumer still reads them from
// `@shared/logEvents`, and the union below carries the three new members.
import type { CoinEvent, ItemReceivedEvent, PurchaseEvent } from './acquireEvents'

// WHAT IS IN YOUR GEMS (JOS-391) — the memorize / forget / spell-set shapes, out in
// ./gemEvents for the same file-mass reason as the two imports above. Re-exported verbatim.
import type { SpellForgetEvent, SpellMemorizeEvent, SpellSetEvent } from './gemEvents'

export type { SpellForgetEvent, SpellMemorizeEvent, SpellSetEvent } from './gemEvents'

export type { ConsiderFaction }
export type {
  Coins,
  CoinEvent,
  CoinSource,
  ItemReceivedEvent,
  ItemReceivedVia,
  PurchaseEvent
} from './acquireEvents'
export {
  CONSIDER_FACTION_COLOR,
  CONSIDER_FACTION_LABEL,
  CONSIDER_FACTION_RUNGS,
  considerDifficultyShort
} from './considerFaction'

/** Fields present on every event: a monotonic sequence, timestamp, and the raw line. */
export interface LogEventBase {
  /** Monotonic sequence across scan+tail for a character (feeder-owned). */
  seq: number
  /** Epoch millis from the bracketed timestamp. */
  ts: number
  /** The raw log line (post-`\r` strip), for display / debugging. */
  raw: string
}

/** `You have entered <zone>.` */
export interface ZoneEvent extends LogEventBase {
  kind: 'zone'
  zone: string
}

/**
 * Where a looted-and-routed item went (Tasks #40/#47). The held-vs-gone rule lives in
 * ONE place — `computeHeldCounts` (renderer, features/posky/heldCounts.ts):
 *   'currency' — stored in the currency tab (kept, quest-countable — e.g. Wind Runes)
 *   'sold'     — auto-vendored the instant it dropped (gone, never held)
 *   'hoard'    — stored in the Dragon Hoard (bank-type storage — HELD)
 *   'depot'    — stored in the tradeskill depot (bank-type storage — HELD)
 *   'combined' — consumed on pickup to create an upgraded `<item> +N` (see `created`;
 *      net-ZERO for held counts — the looted copy and a held copy merge into one)
 *   'destroyed' — the ONE member of this family that is a SUBTRACTION (JOS-401). It rides the
 *      loot lane rather than a kind of its own because everything a destroy has to reach
 *      already reads loot rows (the module, the snapshot, the deltas, every held-count fold);
 *      what it means to each reader is `shared/lootDisposition.ts`.
 */
export type LootDisposition = 'currency' | 'sold' | 'hoard' | 'depot' | 'combined' | 'destroyed'

/** `--You have looted a <item> from <mob>'s corpse.--` (self-loot). */
export interface LootEventE extends LogEventBase {
  kind: 'loot'
  item: string
  source?: string
  /**
   * Auto-disposition (Tasks #40/#47) for the one-line looted-and-routed variants
   * (`You looted …` — no leading "have", no dashes). Undefined for the ordinary
   * `--You have looted …--` form (kept, no routing implied). See LootDisposition.
   */
  disposition?: LootDisposition
  /**
   * Stack size when the line names one (Task #47): `--You have looted 2 Bone Chips …--`,
   * `You looted 2 Phosphorous Powder … and sold it …`. Undefined = 1. Held counts add
   * `count`, not 1 — a stacked loot is that many items.
   */
  count?: number
  /** The upgraded item a 'combined' loot created (`… to create a <item> +N`). */
  created?: string
}

/** `You offered N <item> to <NPC>.` — one per item offered. */
export interface OfferEvent extends LogEventBase {
  kind: 'offer'
  item: string
  npc: string
}

/** `You complete the trade with <NPC>.` — closes a pending offer group. */
export interface TradeEvent extends LogEventBase {
  kind: 'trade'
  npc: string
}

/** `You have gained a level! Welcome to level N!` */
export interface LevelEventE extends LogEventBase {
  kind: 'level'
  level: number
}

/**
 * `You gain experience! (3.288%)` / `You gain party experience! (1.373%)`, and the
 * percent-LESS variants of both. The percentage is an INCREMENT of the CURRENT level's
 * bar (proven: Σ between consecutive dings ≈ 100), never a bar position.
 *
 * `pct` is UNDEFINED when the line stated none — never 0. In the real log every
 * percent-less line falls inside one contiguous at-the-cap window (level 50, no ding
 * for 34 h), i.e. the game prints a percentage only while a level bar exists.
 *
 * FULL-LOG SWEEP (read-only, 2026-08-03, 1.11M lines): 3865 `You gain experience! (N%)`,
 * 471 `You gain party experience! (N%)`, 474 percent-less, 28 percent-less party — 4838
 * lines, EVERY ONE of which previously fell through to `{kind:'unknown'}` (verified by
 * replaying the whole log through the pre-change parser). The only other lines containing
 * "experience" are 11 player chat lines and one mob emote (`Coercer T\`vala experiences a
 * quickening.`), which is why the classifier's regex is anchored at BOTH ends.
 *
 * UNIT HONESTY (law 1): 1% at level 40 is far more raw experience than 1% at level 10, and
 * the log never states a raw exp number, a to-next-level total, or a bar position. Σ percent
 * is therefore "levels of progress", never "xp" — see shared/progressionStats.ts.
 */
export interface ExpGainEvent extends LogEventBase {
  kind: 'expGain'
  /** stated level-bar percent gained; undefined when the line printed none. */
  pct?: number
  /** the `party experience` shape — a group-mate's kill paid you. */
  party: boolean
}

/** `You have gained N ability point(s)! You now have M ability point(s).` */
export interface AaGainEvent extends LogEventBase {
  kind: 'aaGain'
  amount: number
  nowHave: number
}

/** `You have gained the ability "X" …` / `You have improved X <rank> …` at a cost of N. */
export interface AaSpendEvent extends LogEventBase {
  kind: 'aaSpend'
  ability: string
  rank?: number
  cost: number
}

/**
 * The item-shop AA potion landing: `You are filled with the spirit of alternate adventure.`
 * (Bottle of Alternate Adventure). The line carries NO number — not the charges it grants and
 * not the multiplier — so this event states one fact only: a bottle was quaffed at `ts`.
 * Everything else about it is `shared/aaPace.ts`'s modelling, and is labeled there.
 */
export interface AaPotionEvent extends LogEventBase {
  kind: 'aaPotion'
}

/**
 * Unifies the three death shapes:
 *   `You have slain X!`            → bySelf:true
 *   `X has been slain by Y!`       → bySelf:false, killer:Y
 *   `X died.`                      → bySelf:false, killer:undefined  (JOS-101)
 * Both the kills tracker and the combat engine consume this one event.
 *
 * The third is the KILLERLESS shape — the mob twin of the player's own `You died.` — printed
 * when the killing blow had no attacker to name (a damage-over-time tick). `killer` is absent
 * rather than guessed; it is the ONLY case where bySelf is false and killer is undefined, and
 * it means "this died, the log does not say by whose hand", never "a third party killed it".
 */
export interface DeathEvent extends LogEventBase {
  kind: 'death'
  name: string
  bySelf: boolean
  killer?: string
}

/**
 * A single damage application. Names are RAW (display case) — canonicalization
 * via idKey() stays the engine's job. `attacker` is null for caster-less
 * other-player DoT lines (`X has taken N damage by <Spell>.`); the engine ignores
 * null-attacker damage.
 */
export interface DamageEventE extends LogEventBase {
  kind: 'damage'
  attacker: string | null
  target: string
  amount: number
  dtype: DamageType
  dclass?: string
  skill: string
  crit: boolean
  /** Raw trailing paren modifier, verbatim ("Riposte Critical"). Kept for provenance. */
  modifier?: string
  /**
   * Taxonomy dimension (Task #51), additive over dtype: 'melee' | 'slay' | 'spell' |
   * 'dot' | 'ds'. A melee swing with a Slay Undead proc is 'slay' (its own category
   * per the user); every other dtype maps 1:1. Computed at parse time via
   * combat/taxonomy.ts. Optional so pre-#51 profiles/tests stay byte-compatible.
   */
  category?: DamageCategory
  /**
   * Parsed paren-modifier tokens (Task #51): ["Riposte","Critical"], ["Slay Undead"],
   * etc. Empty/omitted when the line has no modifier. `crit` is derived from the
   * presence of "Critical" here.
   */
  modifiers?: string[]
  /**
   * THE RAW MELEE VERB, lowercased and un-conjugated ('strike', 'kick', 'crush') — present on
   * melee/slay lines only, absent for every spell/dot/ds shape.
   *
   * `skill` is already the verb's SKILL NAME, but that mapping is many-to-one on purpose
   * (`hit`/`claw`/`punch`/`slash`/`crush`/`strike` all read "Melee"), so it cannot answer the
   * one question the special-attack model asks: WHICH generic verb printed this swing. EQ
   * Legends' upgraded specials print no verb of their own — a Dragon Punch is a `strike`, a
   * Flying Kick is a `kick` — so the verb is the join key between a swing and the special the
   * log SAID was active (see SpecialAttackEvent and combat/specialAttacks.ts).
   *
   * It stays here rather than being re-derived downstream because the parser is the only place
   * that ever sees the sentence; a second verb regex over `raw` would be a second opinion that
   * could drift from MELEE_VERBS.
   */
  verb?: string
}

/**
 * `<healer> healed <target> for N hit points[ by <spell>].` — and the overheal
 * variant `... for N (M) hit points ...` where N is the effective (actual) heal
 * and M is the raw/pre-overheal amount. `amount` is always the effective heal.
 */
export interface HealEvent extends LogEventBase {
  kind: 'heal'
  target: string
  amount: number
  /** Raw/pre-overheal amount from the "(M)" group, when the line includes it. */
  rawAmount?: number
  spell?: string
  healer?: string
  /**
   * A CRITICAL heal (Task #59). Heal lines carry the same trailing paren modifier the damage
   * family does — `… by Superior Healing. (Critical)` — AFTER the sentence period. The original
   * `\.$`-anchored regex rejected every one of them, silently dropping 233 real heals from the
   * model (all nine distinct spells that can crit). Verified full-log sweep 2026-08-02:
   * `(Critical)` is the ONLY modifier a heal line has ever carried.
   */
  crit?: boolean
  /**
   * A HEAL-OVER-TIME TICK — `You healed Primitive over time for 102 hit points by Ethereal
   * Cleansing.` (752 such lines in the real log, 12 spells). Load-bearing for the cast-less
   * proc detector and nothing else today: a HoT tick is cast-DETACHED by construction, so a
   * tick arriving more than the attribution window after its cast would misclassify as a proc
   * — the exact failure the damage path's DoT gate exists to prevent. Absent = a direct heal.
   */
  overTime?: boolean
}

/**
 * AN ANNOUNCED HEAL THE LOG NEVER VALUES (JOS-86) — the monk's Mend.
 *
 * `You mend your wounds and heal some damage.` is the whole sentence: no number, no target, no
 * third-person twin. Hit points really did go back on the bar and the game declines to say how
 * many, so this is the exact inverse of MitigationEvent below — that one is an amount attached
 * to something that never touched a health bar; this one is a health bar with no amount.
 *
 * IT IS ITS OWN KIND FOR THE SAME REASON MITIGATION IS. Emitting a `heal` with `amount: 0`
 * would be a lie that every downstream consumer would then have to un-learn: the healing ledger
 * would file it as a tick that landed on a full health bar (`fullOverheal`), the row's `min`
 * would collapse to 0, and `foldHealAnalytics` would enter a 0-damage "Mend proc" into the proc
 * model. A kind with NO `amount` FIELD AT ALL makes the absence structural — there is nothing
 * to accidentally sum.
 *
 * VERIFIED shapes (full-log sweep of eqlog_Primitive_freeport.txt, 2026-08-07 — 1,178 lines
 * contain "mend" case-insensitively and they partition exactly):
 *   876  `You mend your wounds and heal some damage.`  — the ONLY mechanical heal shape
 *   200  `You have become better at Mend! (N)`         — the skill-up stream (skillUp)
 *     1  `You have gained the ability to use Mend.`
 *     2  a mob literally named `a Nisch Mas Mender`
 *    99  third-party chat about the skill (all quoted, all dropped by the scrub)
 * So: FIRST PERSON ONLY (no `<X> mends …` exists), no failure shape, no "you are not wounded"
 * refusal, and no amount in any of the 876. Do not invent a third-person arm for a sentence the
 * game has never printed (AGENTS.md awaiting-sample law).
 */
export interface HealUnstatedEvent extends LogEventBase {
  kind: 'healUnstated'
  /**
   * The class SKILL that healed. 'Mend' is the only value the log has ever produced; it is a
   * field rather than a constant so a second amount-less family graduates by adding a regex,
   * not by reshaping the ledger.
   */
  skill: string
  /** Who it landed on. The sentence is first-person only, so this is always 'You' today. */
  target: string
}

/**
 * ABSORPTION / MITIGATION families (Task #59) — damage PREVENTED, never hit points restored.
 * Deliberately a separate event kind from `heal`: folding these into healing would inflate a
 * healing meter with numbers that never touched the health bar.
 *
 * VERIFIED shapes (full-log sweep of eqlog_Primitive_freeport.txt, 2026-08-02):
 *   'rune'               `You gain a rune for 12 points of absorption.`  (1,016 lines; the
 *                        user's berserker rune AA. The amount is absorption GRANTED — the log
 *                        never says how much of it was actually consumed.)
 *   'absorbSwing'        `<mob> tries to bash YOU, but YOUR magical skin absorbs the blow!`
 *                        (362 lines, incl. a trailing ` (Riposte)` variant). COUNT ONLY — the
 *                        log carries NO amount for an absorbed swing, so never synthesize one.
 *   'absorbDamageShield' `YOUR magical skin absorbs the damage of <mob>'s thorns.` (235 lines)
 *                        — an incoming damage-shield tick absorbed. COUNT ONLY, same rule.
 *
 * Only the SELF ("YOUR"/"You") forms are emitted here. The possessive third-person twin
 * (`… but a revenant's magical skin absorbs the blow!`, 1,426 lines) is a MOB's rune and
 * belongs to the miss family (mtype 'absorb'), not to your mitigation lane.
 */
export type MitigationType = 'rune' | 'absorbSwing' | 'absorbDamageShield'

export interface MitigationEvent extends LogEventBase {
  kind: 'mitigation'
  mtype: MitigationType
  /** Absorption points granted — 'rune' ONLY. Absent for the count-only families. */
  amount?: number
  /** The attacker whose blow / damage shield was absorbed ('absorb*' only). */
  source?: string
}

export type MissType = 'miss' | 'dodge' | 'parry' | 'riposte' | 'block' | 'absorb'

/**
 * `<A> tr(y|ies) to <verb> <B>, but <outcome>!` — an avoided melee swing.
 * Parse-only for now (the engine may ignore or ring-log it).
 */
export interface MissEvent extends LogEventBase {
  kind: 'miss'
  attacker: string
  target: string
  mtype: MissType
  /**
   * The un-conjugated melee verb the line named ('slash', 'backstab', 'kick') — the same join
   * key `DamageEventE.verb` carries, so an avoided swing can enter the ROUND grouper and the
   * special-attack lane naming exactly as a landed one does
   * (docs/plans/attack-round-stats.md). ADDITIVE: nothing that existed before this reads it,
   * and the miss still lanes under 'Melee' in the accuracy stats.
   */
  verb?: string
  /**
   * The line's decomposed paren modifiers. A miss CAN be annotated — measured full-log
   * 2026-08-05: 7,224 `(Riposte)`, 123 `(Flurry)`, 92 `(Rampage)` on miss lines, and those 123
   * are very nearly half of every flurry annotation in the log (253). Counting only landed
   * flurries would halve the stat. Only the three single-word forms above ever appear here;
   * a compound tail on a miss line does not exist in this log family.
   */
  modifiers?: string[]
}

/**
 * A SPELL RESIST (Task #51 timeline v2) — a detrimental spell fully resisted by its
 * target, the caster-side analogue of a melee miss. Three VERIFIED shapes in the real
 * log (eqlog_Primitive_freeport.txt sweep, 2026-08-02):
 *   `<target> resisted your <Spell>!`            → caster = 'you'
 *   `<target> resisted <caster>'s <Spell>!`      → caster = <caster> name (a pet or mob)
 *   `You resist[ed] <caster>'s <Spell>!`         → INCOMING: you resisted a mob's spell
 * The spell display name may carry a rank suffix ("Mesmerization III"); `spell` keeps the
 * DISPLAY form (rank preserved) and the engine rank-normalizes with spellCanonKey for lane
 * / attribution keys, mirroring the buffs model convention. `target` is the entity the
 * spell was cast ON (the incoming form's target is 'You'). Additive — with no consumer this
 * never affects damage totals (it carries no amount).
 */
export interface ResistEvent extends LogEventBase {
  kind: 'resist'
  /** who cast the resisted spell: 'you' | a caster name (pet/mob). */
  caster: string
  /** the entity that resisted (the spell's target). 'You' for the incoming form. */
  target: string
  /** the resisted spell, DISPLAY form (rank suffix preserved). */
  spell: string
  /** true for the incoming `You resist <mob>'s <Spell>` form (you were the resister). */
  incoming: boolean
}

/**
 * `<mob> has been charmed.` — a charm LANDED on that mob.
 *
 * IT IS A BROADCAST AND IT NAMES NO CASTER. (The old comment here claimed "only the charmer
 * sees this"; that was measured FALSE in 2026-08-04. The text is the spell DB's own
 * `msg_cast_on_other` — the wiki records it verbatim as `Someone has been charmed.` for Charm,
 * Beguile, Allure, Cajoling Whispers, Dictate and Boltran's Agacerie — so every player in
 * earshot gets the line when ANY of them charms anything. Whole-log counts: 381 of these, of
 * which 15 were cast by ten other players, and one stranger's charm block put 91 hits /
 * 10,016 points of his pet's damage onto the owner's meter.)
 *
 * So this event means "a charm landed on <mob>", NOT "you charmed <mob>". Ownership is decided
 * downstream by correlating it with the owner's own `castBegin` — see
 * src/main/combat/charmModel.ts, which owns that judgement and its measurements.
 */
export interface CharmEvent extends LogEventBase {
  kind: 'charm'
  mob: string
  /**
   * Every charm spell `<mob> has been charmed.` could be, from the DB's cast-on-other suffix
   * table — the same list `cc` carries, and for the same reason (JOS-84's law: the parser hands
   * over candidates, the MODEL resolves them against the player's own casts).
   *
   * ADDED BY JOS-140, because charm is a DETRIMENTAL HOLD like any other and the owner wants its
   * countdown: charm-break timing is the whole game for an enchanter, and the sentence is seven
   * spells in the committed DB with durations from 48 s to 19 minutes, so a bar cannot be drawn
   * from it without knowing which one you cast. Absent when no spell DB is installed, which
   * leaves the event byte-identical to what it was.
   */
  candidates?: { name: string; durationMs: number | null }[]
}

/** `Your <charm spell> spell has worn off of <mob>.` — pet off (charm spells only). */
export interface UncharmEvent extends LogEventBase {
  kind: 'uncharm'
  mob: string
  /**
   * The charm spell the line NAMED. The regex has always captured it and the event used to throw
   * it away; JOS-140 carries it so the break closes the charm hold by LINE rather than closing
   * every hold on that mob anonymously — which is also what makes the span a clean cycle the
   * learner may mint from.
   */
  spell?: string
}

/**
 * A crowd-control application or refresh on a mob — mez/root, NOT charm. Two shapes
 * produce it:
 *   application: `<mob> has been mesmerized.` (Mesmerize/Enthrall/Entrance/…) or
 *                `<mob> has been ensnared.` (root).
 *   refresh:     `Your <mez/root spell> spell has worn off of <mob>.` — a CC spell
 *                (as opposed to a charm spell, which stays an `uncharm`) wearing off
 *                is evidence the mob was under CC right up to that moment, so it is
 *                treated as a keep-alive refresh (`refresh:true`) rather than dropped.
 * The engine uses this to hold an encounter open across the mez-and-wait gap: a CC'd
 * instance is engaged-and-alive by definition. `spell` is present on the worn-off
 * shape; the application shape carries only the mob.
 */
/** The four crowd-control APPLICATION verbs `classifyCcApply` claims, verbatim from the log. */
export type CcVerb = 'mesmerized' | 'enthralled' | 'entranced' | 'ensnared'

export interface CcEvent extends LogEventBase {
  kind: 'cc'
  mob: string
  spell?: string
  /** True when derived from a "spell has worn off" line (keep-alive), not a fresh application. */
  refresh?: boolean
  /**
   * THE WORD THE GAME USED (JOS-228) — present only on the APPLICATION shape, and reported rather
   * than interpreted (world-model law 1: messages over inference).
   *
   * WHY A CONSUMER WANTS IT. Three of these four sentences describe a hold that ANY damage breaks
   * — a mesmerized mob cannot be hit without waking up — and the fourth (`ensnared`) is a snare,
   * which does nothing to stop you killing the mob it is on. That difference decides whether a
   * `<mob> died.` line arriving while the hold still stands can be ABOUT that hold, and it is the
   * whole of JOS-228: killing one mob of a name was closing a landing on the mezzed mob standing
   * beside it, so the bar vanished at the moment it mattered most.
   *
   * IT IS THE VERB AND NOT A CLASSIFICATION on purpose. The alternative was a hand-authored roster
   * of mez spell NAMES, which is exactly the substitution JOS-200 caught and reversed — spells.json
   * has no effect column, the game reuses one landing sentence for two effects, and "a message
   * family is not an effect family". These four words are what the log itself prints; the ruling
   * about which of them a corpse can explain belongs to the model (modules/buffTimers.ts).
   */
  verb?: CcVerb
  /**
   * EVERY spell whose `msg_cast_on_other` produced this APPLICATION sentence (JOS-89), from the
   * same DB suffix table `buffApply` reads — present only on the application shape, only when a
   * spell database is installed on the parser config, and only when the sentence matched one.
   *
   * WHY IT IS HERE AND NOT DOWNSTREAM. `<mob> has been mesmerized.` is claimed by
   * `classifyCcApply`, which sits ABOVE `classifyDbBuff` in the cascade, so the DB matcher never
   * sees the line and the candidate list the buff family would have carried was simply lost. The
   * parser is the only place that ever sees the sentence — the same argument `DamageEventE.verb`
   * makes — so re-running a suffix matcher in a module would be a second opinion that can drift.
   *
   * IT IS A CANDIDATE LIST, NEVER A NAME (JOS-84). Measured over the committed spells.json, the
   * four sentences this classifier claims resolve to sets of 4 / 2 / 1 / 1 spells whose stated
   * durations DISAGREE in two of the four cases (`has been mesmerized.` = Dazzle 96 s /
   * Mesmerization 24 s / Mesmerize 24 s / Sathir's Mesmerization no duration at all;
   * `has been ensnared.` = Ensnare 660 s / Snare 180 s). So a consumer that wants a duration has
   * to narrow this against the player's own cast history and refuse to state one when it cannot —
   * exactly what `buffApply.candidates` already demands of its consumers.
   *
   * The REFRESH shape never carries it: that line names its spell outright in `spell`.
   */
  candidates?: { name: string; durationMs: number | null }[]
}

/**
 * `<Mob> has been awakened by <Name>.` — a crowd-control hold that somebody BROKE (JOS-180).
 *
 * It is the log naming the cause of an ending the wear-off sentence describes without explaining.
 * `Your <S> spell has worn off of <mob>.` is printed identically whether a mez ran its full course
 * or a nuke ended it at two seconds (world-model law 3's censoring, stated in buffsStats.ts), and
 * that ambiguity is what made JOS-180: a learner fed break spans as if they were durations settles
 * BELOW the real one and can never climb back. This line is the missing half of the pair.
 *
 * IT IS AN ANNOTATION, NEVER AN ENDING. The hold is already closed by the wear-off line that
 * precedes it — MEASURED over the owner's whole log (1,518 wakes): 1,472 of them share the exact
 * second of that mob's wear-off, the wear-off line comes FIRST in every single one (1,462 of them
 * immediately adjacent), one sits 27 s from an unrelated cycle, and 45 have no wear-off within
 * 30 s at all. So a consumer must not close anything on it; `modules/buffTimers.ts` uses it only
 * to mark the sample the wear-off just minted as CENSORED.
 *
 * `by` is whoever the line names — the player, a group member, or a mob that hit it. It is carried
 * because it is stated, not because anything reads it yet: the censoring rule cares only that the
 * hold was broken, and by-whom is the same fact regardless of the answer.
 */
export interface CcWakeEvent extends LogEventBase {
  kind: 'ccWake'
  mob: string
  /** The name the line states as having broken the hold. Raw (world-model law 2: display raw). */
  by: string
}

/**
 * A pet-ownership claim: a line in which a pet identifies YOU as its owner, proving the named
 * entity is your pet. ONE canonical event, TWO log lines that state the same fact — the same
 * shape-to-kind canonicalization `damage` and `resist` already are.
 *
 * `via: 'tell'` — THE DIRECT-TELL FAMILY:
 *   `<Name> told you, 'Attacking <target> Master.'`
 *   `<Name> told you, 'I am unable to wake <mob>, Master.'`
 * which in the real log is emitted ONLY by pets (no player false positives; see parser.ts).
 * This is how random proper-named SUMMONED pets (Vebarn, Garer, …), which never appear in a
 * charm line, get bound to you. Charmed pets also emit it (harmlessly — they're already bound
 * via the charm line).
 *
 * ITS ONE BLIND SPOT, and JOS-47 is what measured it: the tell fires only when the pet is
 * ORDERED. `/pet attack` produces "Attacking X Master."; `/pet back off` on a mezzed mob
 * produces the wake-failure variant. A pet that engages on its OWN aggro emits nothing
 * private at all — so a player who never types a pet command has a pet this signal can never
 * bind, and 13,555 points of it went unrecorded in the reporter's 30-minute slice.
 *
 * `via: 'leader'` — THE `/pet who leader` ANSWER (JOS-52), which is the ON-DEMAND way out of
 * that blind spot:
 *   `<Name> says, 'My leader is <You>.'`
 * A player who has never ordered their pet can type one command and have it say whose it is.
 * Unlike the six pet-voiced sentences in `PetSayEvent`, this one NAMES ITS OWNER, so it is a
 * bind and not a nomination — but unlike the tell it is BROADCAST, so the leader's name is the
 * entire guard and the parser refuses every line naming anyone but the tailed character (see
 * classifyPetLeader for the guard, its measurement, and the one forgery it cannot rule out).
 *
 * The two are the SAME fact and therefore the same kind: every consumer (combat ingest's
 * world.claim + JOS-54 succession, modules/buffs.ts's buff-entity succession,
 * modules/progression.ts's pet ledger, the alerts vocabulary) binds identically, which is the
 * point — a second kind would be a second retirement path for one of those three models to
 * forget, and world-model law 4 is a scar from exactly that.
 */
export interface PetClaimEvent extends LogEventBase {
  kind: 'petClaim'
  name: string
  /** WHICH line said so. Never a behavioural switch — it is what the engine's debug line, an
   *  alert author and a test read to tell an ordered pet from an interrogated one. */
  via: 'tell' | 'leader'
}

/**
 * `<PetName> says, 'My leader is <SomeoneElse>.'` — the SAME `/pet who leader` sentence as
 * `PetClaimEvent{via:'leader'}`, spoken by a pet that belongs to somebody who is not you (JOS-250).
 *
 * A SEPARATE KIND ON PURPOSE, and this is the exception that proves law 4's rule. The tell and the
 * self-leader say are one FACT ("this entity is my pet") and so are one kind; this line states the
 * opposite fact ("this entity is somebody ELSE's pet") and every consumer of `petClaim` — the
 * combat world model's `claim()`, the JOS-54 single-pet succession, `modules/buffs.ts`'s
 * buff-entity succession, the progression pet ledger, the roster — would bind it to YOU if it
 * arrived wearing that kind. Reusing `petClaim` with an `owner` field would make all five of them
 * responsible for reading a field they have never read; a distinct kind makes the one consumer
 * that wants it (combat's ally-charm model) opt in and leaves the other five untouched.
 *
 * IT IS THE STRONGEST ALLY BIND THERE IS, because it names both ends out loud, and it is the only
 * one that also covers a SUMMONED pet of someone else's (a charm broadcast covers only charms).
 *
 * THE GUARD IS THE SAME ONE `classifyPetLeader` uses, inverted and then re-tightened: the leader
 * must NOT be the tailed character (that line is a `petClaim` and is claimed first), the leader
 * must be PLAYER-SHAPED, and the tailed character's name must be installed at all — with no
 * character installed the self rule cannot run, so this rule would silently claim the user's own
 * pet line. Same forgeability caveat as the self form, with the same bounded cost (one row in a
 * meter, attributed to a stranger rather than to you).
 *
 * MEASURED (owner's whole log, 1,608,483 lines, 2026-08-12): the family has exactly ONE occurrence
 * and it is the SELF form (`Jaber says, 'My leader is Primitive.'`). There is no third-party
 * instance in this corpus, so this rule is STRUCTURALLY covered — the sentence shape is proven by
 * a real line, the third-party variant is that same line with a different name in one capture, and
 * it is unit-tested against a constructed sentence. It is stated rather than implied because the
 * awaiting-sample law asks which half of "verified" a claim is standing on. The scrub keeps
 * dropping it (AGENTS.md: the pet-leader carve-out is SELF-GATED, a stranger's pet naming a
 * stranger falls to the quoted-speech rule), so no fixture can ever carry one either.
 */
export interface AllyPetLeaderEvent extends LogEventBase {
  kind: 'allyPetLeader'
  /** The speaking pet, spelled as the log spelled it (world-model law 2). */
  pet: string
  /** The player it named as its leader. Never the tailed character — that line is a `petClaim`. */
  owner: string
}

/** Which of the six pet responses was spoken (shared/logScrub.ts `PET_SAY_LINES`). */
export type PetSayKind = 'follow' | 'regroup' | 'calm' | 'hold' | 'comply' | 'illegalTarget'

/**
 * A pet-voiced PUBLIC say — one of the six exact sentences in `PET_SAY_LINES`
 * ("Following you, Master.", "Sorry, Master... calming down.", "As you wish, oh great one.", …).
 *
 * THIS EVENT NEVER BINDS ANYTHING, and the pet model's honesty rests on that. `says` is
 * broadcast to everyone in earshot, so the line proves the speaker is SOMEBODY's pet and says
 * nothing whatever about whose. Binding on it would hand a stranger's pet to your meter —
 * precisely the failure Task #65 spent a wave undoing for charm broadcasts, which are
 * broadcasts for the same reason.
 *
 * IT ALSO NO LONGER NOMINATES. It used to pair with "…and that entity is fighting the target
 * YOU are fighting" to put a "<Name> — your pet?" question above the meter; the owner cut that
 * outright (JOS-49 — "if you just have to pet attack once, this is a lot of work we can get
 * wrong"), so the combat engine consumes this event nowhere at all. It still PARSES, and it is
 * still in the alert-trigger vocabulary (shared/logEventKinds.ts), so a user can alert on their
 * pet answering a command. JOS-52 is where a say gets a real job: `<Name> says, 'My leader is
 * <You>.'` — the /pet who leader answer, which unlike these six NAMES ITS OWNER OUT LOUD.
 *
 * MEASURED (whole-log sweep, 1.4M lines, JOS-47): 113 of these exist across 6 sentence forms.
 * 85 came from a name an EARLIER private tell had already bound (so binding on the say would
 * have added nothing at all), 22 from a name a LATER tell bound, and 6 from names no tell ever
 * bound — six lines of upside against adopting a stranger's pet, which is the trade that got
 * the question deleted rather than tuned.
 */
export interface PetSayEvent extends LogEventBase {
  kind: 'petSay'
  /** The speaker, spelled as the log spelled it (world-model law 2). */
  name: string
  say: PetSayKind
}

/**
 * `You begin casting <Spell>.` (and `You begin singing <Song>.` for bard songs) —
 * the player STARTS a cast. The buffs module treats this as a pending cast that
 * lands unless a fizzle/interrupt/new-cast intervenes. Only the player's own casts
 * produce this line (mob/other-player casts are not "You begin …").
 */
export interface CastBeginEvent extends LogEventBase {
  kind: 'castBegin'
  spell: string
  /**
   * The line said SINGING, not casting (JOS-382). A bard song re-checks resistance on every
   * 6-second pulse while a cast rolls once, so the resist engine has to tell them apart — and the
   * log is the only place the answer exists in this app: the wiki catalog carries no such column,
   * and the client's own `spells_us.txt` is not ours to redistribute. Additive and optional, so
   * every consumer that existed before this rides unchanged.
   */
  sung?: boolean
}

/**
 * `<Name> begins casting <Spell>.` — SOMEBODY ELSE's cast, named (JOS-140).
 *
 * The third-person twin of `castBegin`, and the only line in the log that says who else is
 * casting what. It exists because the buffs model's attribution is CAST-ANCHORED: a landing
 * sentence is a broadcast that names no caster, so a buff another player put on your group can
 * only be admitted if something anchors it — and this is the something.
 *
 * IT IS NOT A LICENCE. Emitting the event says the line was printed, nothing more; the buffs model
 * records it as an anchor ONLY for a caster on the user's externals allowlist, which ships EMPTY
 * (shared/buffTrust.ts). The subject may equally be a MOB — `Lord Nagafen begins casting
 * Immobilize.` is 583 lines of the committed fixtures — so a rule that trusted the shape would
 * hand a raid boss's debuffs to your own bars.
 *
 * Matched AFTER the first-person cast lifecycle, so `You begin casting …` can never reach it.
 */
export interface OtherCastBeginEvent extends LogEventBase {
  kind: 'otherCastBegin'
  /** The caster's raw display name, exactly as the line spelled it. */
  caster: string
  /** The spell name, rank suffix intact — the only line family that carries one. */
  spell: string
}

/**
 * `Your <Spell> spell fizzles!` — the player's cast failed (no effect). Clears the
 * pending cast. Spell is captured (the real log always names it; targetless
 * `spell fizzles!` was never observed).
 */
export interface CastFizzleEvent extends LogEventBase {
  kind: 'castFizzle'
  spell: string
}

/**
 * `Your <Spell> spell is interrupted.` — the player's cast was interrupted (moved,
 * stunned, etc.). Clears the pending cast. NOTE (log evidence, 2026-08-01): the
 * real log has NO bare `Your spell is interrupted.` line — the shape always names
 * the spell. `You regain your concentration and continue your casting.` is the
 * OPPOSITE (a recovered cast) and is never parsed as an interrupt — it is its own
 * kind, `castResumed` below.
 */
export interface CastInterruptedEvent extends LogEventBase {
  kind: 'castInterrupted'
  spell: string
}

/**
 * `You regain your concentration and continue your casting.` — the interrupted cast is BACK ON
 * and will land (JOS-167). Parsed because the interrupt line alone is not evidence a cast
 * failed: measured over the whole log, every one of the nine interrupts followed by a landing of
 * the same spell has this line between them, so a model that drops the cast on the interrupt has
 * to be told when to put it back.
 *
 * It names NO spell, and does not need to: casting is serial, so the only cast it can be about
 * is the one that was just interrupted.
 */
export interface CastResumedEvent extends LogEventBase {
  kind: 'castResumed'
}

/**
 * `Your <Spell> spell has worn off[ of <target>].` — a buff the PLAYER cast has
 * expired. Two shapes with distinct semantics (validated against the real log):
 *   - `Your <Spell> spell has worn off.`          → self-cast buff on the player.
 *   - `Your pet's <Spell> spell has worn off.`    → buff the player cast on their
 *      pet (target='pet'). In this Enchanter's log EVERY targetless worn-off line
 *      is the pet form — the player's charmed pet is the main buff target — so the
 *      duration model is effectively mined from pet buffs; both are the player's
 *      own casts and both are mineable. `target` is 'pet' for the pet form and
 *      undefined for true-self.
 * CRITICAL: the `worn off OF <mob>` shape (charm/mez) is a DIFFERENT line handled
 * by uncharm/cc BEFORE this — buffFade only fires for targetLESS worn-off lines,
 * which are never charm/cc, so there is no overlap and no regression.
 */
export interface BuffFadeEvent extends LogEventBase {
  kind: 'buffFade'
  spell: string
  /** 'pet' when the buff was on the player's pet; undefined when on the player. */
  target?: string
}

/**
 * The PLAYER died (buffs are stripped). Two log shapes, one event: `You have been slain by
 * <killer>!`, and the killerless `You died.` the client prints when a DoT tick lands the
 * killing blow — hence `killer` is optional (JOS-88).
 */
export interface PlayerDeathEvent extends LogEventBase {
  kind: 'playerDeath'
  killer?: string
}

/**
 * A CANDIDATE spell-landing emote (Task #33). EQ prints a short flavor line the instant
 * a buff lands — self-form `You feel much faster.` / `You feel much better.` or the
 * third-person form `<Name> feels much faster.` naming the pet the buff landed on. These
 * DISCRIMINATE a cast's target (self vs pet) that `castBegin` alone can't: the buffs
 * module learns castBegin(S) → emote within 3s and, when the emote's SUBJECT is self,
 * marks S's active as a SELF buff; a pet-name subject marks the pet.
 *
 * This is a permissive CANDIDATE (many of these lines are unrelated flavor — hunger,
 * weather, ambient effects). The buffs module only trusts one that consistently follows
 * a given spell's cast (seen ≥2× with no contradiction) AND is temporally adjacent to a
 * live cast, so false candidates never bind. `subject` is 'self' for the `You …` form,
 * else the raw name (a pet). `text` is the whole emote (for association keying).
 */
export interface SpellEmoteEvent extends LogEventBase {
  kind: 'spellEmote'
  /** 'self' for the `You <verb> …` form; otherwise the named subject (a pet name). */
  subject: string
  /** The full emote text (association key). */
  text: string
}

/**
 * A PRECISE, message-driven buff application (Task #34). Emitted when a log line exactly
 * matches a spell's `msg_cast_on_you` (target 'self') or a `msg_cast_on_other` suffix
 * (target = the named subject). This is DB-driven and requires a spell database installed
 * on the parser config (ParserConfig.spellDb); with no DB it never fires, so profiles
 * without a DB behave exactly as before.
 *
 * This is what makes SELF buffs cast via a Quick Buff burst visible: the burst prints only
 * landing messages ("A cool breeze slips through your mind.") with NO "You begin casting"
 * line, so the cast-timing miner never saw them — the message match does.
 */
export interface BuffApplyEvent extends LogEventBase {
  kind: 'buffApply'
  /**
   * The resolved spell name (display casing from the DB). When the landing message is
   * AMBIGUOUS across several spells (many haste/clarity spells share one message — e.g.
   * "You feel much faster." is Alacrity/Celerity/Quickness/Swift), this is a best-effort
   * pick; `candidates` carries the full set so the buffs module can resolve it against the
   * player's own recent cast history (which spell they actually cast).
   */
  spell: string
  /** 'self' for a msg_cast_on_you match; the named target for a msg_cast_on_other match. */
  target: string
  /** True when the (resolved) spell's effects are an Illusion (Permanent Illusion AA). */
  illusion: boolean
  /** DB duration in ms (the authoritative prior), or null when the DB has no duration. */
  durationMs: number | null
  /**
   * All spells whose landing message equals this line (Task #34). Length 1 when the
   * message is unique. When >1, the message alone can't name the spell; the buffs module
   * disambiguates by the player's recent casts. Each candidate carries its own name +
   * duration + illusion flag (they usually share a duration but not always).
   */
  candidates: { name: string; durationMs: number | null; illusion: boolean }[]
}

/**
 * A PRECISE, message-driven buff expiry (Task #34): a log line exactly matched a spell's
 * `msg_wears_off`. Message-driven expiry is FAVORED over estimate-based removal (the user
 * directive). Target is 'self' — wears-off emotes are printed to the buff holder (the
 * player) regardless of who the buff was on, so we treat them as clearing the player's bar.
 */
export interface BuffWearOffEvent extends LogEventBase {
  kind: 'buffWearOff'
  /** Best-effort first candidate (display casing). Prefer `candidates` — the message may be shared. */
  spell: string
  /**
   * ALL spells whose `msg_wears_off` equals this line (Task #45). Many families share a
   * wears-off message (9 haste spells share "Your speed returns to normal.", 13 share
   * "Your strength fades.", …), so the message alone can't name which one faded. The buffs
   * module resolves against the player's ACTIVE self buffs — EQ stacking rules keep at most
   * one candidate of a family active at a time, so the active set names the real spell.
   */
  candidates: string[]
  target: 'self'
}

/**
 * `You activate <X>.` — an activated AA (e.g. Quick Buff). The buffs module uses a Quick
 * Buff activation as CONTEXT: the buff applies in the ~2-3s burst that follows are marked
 * confident (message-driven). Any activated AA is captured; consumers filter by name.
 */
export interface AaActivateEvent extends LogEventBase {
  kind: 'aaActivate'
  name: string
}

/**
 * `Your illusion fades.` — the player's ACTIVE illusion clicked/wore off (Task #36). This
 * is the click-off/removal line printed for EVERY illusion-flagged spell (Illusion: <race>,
 * Boon of the Garou, …) — the DB records it as the `msg_wears_off` for 27 distinct spells,
 * so the message alone can NOT name which illusion faded. It doesn't have to: the user's
 * rule is that only ONE illusion can be active on the player at a time, so this line removes
 * whichever illusion-flagged self buff is currently active (there is at most one). Emitted
 * IN PLACE OF a generic buffWearOff for this exact line so the buffs module never has to
 * guess a spell key from the 27-way-ambiguous wears-off table. `target` is always 'self'
 * (the illusion is on the player). DB-gated only in the sense that it is a plain message
 * match with no candidate list — it fires regardless of the DB (the text is unambiguous).
 */
export interface IllusionFadeEvent extends LogEventBase {
  kind: 'illusionFade'
  target: 'self'
}

/**
 * A DERIVED, RESOLVED buff-expiry event (Task #47). Unlike the parser's raw buffWearOff
 * (which carries an AMBIGUOUS `candidates` list for the 123 shared-message families) or
 * illusionFade (which names no spell at all), this event is SYNTHESIZED by the buffs module
 * AFTER it resolves the wear-off against the live active set — so `spell` is the ACTUAL buff
 * that faded and `target` is who it was on.
 *
 * DERIVED EVENTS (the design contract): the buffs module is the only authoritative source of
 * the resolved "wears off YOU" signal — the raw parser line is inherently ambiguous. Rather
 * than duplicate the active-set resolution in the alerts module, buffs emits this ONE
 * resolved event back onto the SAME bus (see log/bus.ts `emitDerived`), which the alerts
 * module (registered after buffs) matches like any other event. It is clearly namespaced,
 * never re-emitted by any consumer (buffs ignores it), and covers BOTH sides of the user's
 * "the wears off for you is different than for somebody else" concern with a single kind:
 *   - a SELF wears-off (message-driven buffWearOff / illusionFade, resolved) → target:'self'.
 *   - a fade on the pet / another entity (buffFade, already resolved spell+target) →
 *     target = that entity's display name.
 * So an alert `{event, buffExpired, where:{spell:'Swift Like the Wind'}}` fires whether the
 * buff wore off the player OR the player's pet — the "good sane default that helps with both".
 */
export interface BuffExpiredEvent extends LogEventBase {
  kind: 'buffExpired'
  /** The RESOLVED spell that expired (display casing) — never ambiguous. */
  spell: string
  /** 'self' when it wore off the player; else the bound entity's display name (pet/mob/player). */
  target: string
}

/**
 * A DERIVED character-EPOCH boundary (Task #49; anchor REPLACED in Task #50). NOT a parsed
 * line: it is SYNTHESIZED by the feeder (index.ts bus subscription) and handed back onto the
 * SAME bus via `emitDerived` at the OFFICIAL LAUNCH boundary — the fingerprint of a character
 * REBIRTH (a same-name+server character wiped/recreated at launch, which reuses the SAME log
 * file). The user's real case: a BETA character reached level 26/30 (Jul 19-20), was WIPED at
 * launch, and the log continues with `Welcome to EverQuest Legends!` then a `Welcome to level
 * 2!` re-level on Jul 28 — everything before that boundary belongs to a DEAD character and
 * contaminates AA / loot / kills / turn-ins / quest counts.
 *
 * DETECTION (in the feeder): the FIRST event whose timestamp is at/after the official launch
 * instant 2026-07-28 00:00 LOCAL (see epochDetector.ts `LAUNCH_MS`). The launch DATE replaced
 * the old level-regression heuristic, which was UNSAFE: EQ Legends loadout swaps legitimately
 * change character level, so a decisive downward level jump is not a reliable rebirth signal.
 * The date is unambiguous and can't be confused with in-game mechanics.
 *
 * On this event, character-scoped modules RESET their live folded state (see modules/*),
 * so post-scan state reflects ONLY the current character. `reason` documents the trigger.
 */
export interface EpochEvent extends LogEventBase {
  kind: 'epoch'
  reason: 'launch'
}

/**
 * A LOGIN — `Welcome to EverQuest Legends!`, printed on EVERY entry into the world
 * (19× in the real 1.15M-line log; measured, not assumed). It is NOT an epoch signal
 * (epochDetector.ts says so explicitly) — it is the ONE unambiguous "the character is in
 * the world again" line, and therefore the right side of every offline gap.
 *
 * The line carries nothing but itself: no character, no zone, no elapsed time. A
 * `You have entered <zone>.` ALWAYS follows within 0–1 lines (verified for all 19), so
 * the existing zone path — not this event — remains the single source of the zone-change
 * censor (world-model law 4). Nothing here duplicates it.
 */
export interface SessionStartEvent extends LogEventBase {
  kind: 'sessionStart'
}

/**
 * WHO YOU ARE GROUPED WITH — one membership statement (docs/plans/group-model.md §1).
 *
 * The game states group membership outright, so nothing here is ever inferred from proximity
 * (world-model law 1). Every shape below was MEASURED against the real 1,382,093-line log on
 * 2026-08-05; the counts are in parseGroup.ts beside each pattern, and the two shapes with no
 * occurrence in this log are labeled `unverified` there rather than pretended verified.
 *
 * These lines used to be scrubbed out of committed fixtures and feedback slices; JOS-15 kept
 * them (shared/logScrub.ts family 3) precisely so this model could exist. Group CHAT still
 * falls to the quoted-speech drop rule, which is why `confirm` — the one shape carried by a
 * chat line — can never appear in a committed fixture and is tested from synthetic lines.
 *
 * `change` is the whole payload beside the name:
 *   'join'      `<Name> has joined the group.`             — <Name> is with you
 *   'leave'     `<Name> has left the group.`               — <Name> is not
 *   'leader'    `<Name> is now the leader of your group.`  — <Name> is with you (weaker: it
 *               states a role, and the leader of YOUR group is by definition in it)
 *   'confirm'   `<Name> tells the group, '…'`              — <Name> is with you, re-asserted;
 *               the recovery path when the join predates the log
 *   'selfJoin'  `You have joined the group.`               — a group now exists; no member named
 *   'selfLeave' `You have been removed from the group.`    — the group is over; roster clears
 *   'invite'    `You invite <Name> to join your group.` / `<Name> invites you to join a group.`
 *               — an OFFER, never a membership fact (it may be declined and often is: this log
 *               has 7 invites and only 5 of the joins that would answer them). Parsed so the
 *               UI can explain a missing member, never folded into the roster.
 *
 * `name` is absent exactly for the two self shapes.
 */
export interface GroupEvent extends LogEventBase {
  kind: 'group'
  change: 'join' | 'leave' | 'leader' | 'confirm' | 'selfJoin' | 'selfLeave' | 'invite'
  /** The member the line names. Absent for `selfJoin` / `selfLeave`. */
  name?: string
}

/**
 * The player STARTED camping out — `It will take you about 30 seconds to prepare your camp.`
 * (20× in the real log). Only the INITIATION line is an event; the five countdown ticks
 * (`It will take about {25,20,15,10,5} more seconds to prepare your camp.`, 78 lines) stay
 * `unknown` on purpose — they are the same fact repeated and nothing consumes them.
 *
 * A camp is CANCELLABLE, and the game SAYS SO (see {@link CampAbortEvent}) — so a campStart
 * is an INTENT, never a completed logout. Only the pairing rule in sessionDetector.ts decides
 * whether a gap was camped.
 */
export interface CampStartEvent extends LogEventBase {
  kind: 'campStart'
}

/**
 * A `/outputfile` DUMP FINISHED WRITING — `Outputfile Complete: Primitive_freeport-Inventory.txt`
 * (JOS-128). The ONE line that says WHEN the player produced an export, in EQ's own clock.
 *
 * This is the whole reason the event exists. An inventory dump is the BASELINE of the inventory
 * model (owner, 2026-08-09): loading one RESETS what we think you hold, and log-derived loot
 * accumulates from that instant forward. Deciding "forward" needs the generation instant, and
 * comparing it against a loot event's `ts` is only sound inside ONE time base — this line's
 * timestamp is parsed by the same `parseTs` every loot row's is, so the comparison never crosses
 * a clock. The file's mtime is the fallback (`shared/outputs/baseline.ts` states its failure
 * modes); the dump's CONTENT carries no date at all, verified against the real 295-row dump.
 *
 * MEASURED against the real 116 MB log (2026-08-09): `^\[…\] Outputfile Complete: ` matches
 * exactly 2 lines (Sat Aug 01 13:33:43 and Thu Aug 06 15:39:12), both this shape. Full-log kind
 * histogram diffed with the classifier off and on: `unknown` 270631 → 270629, `outputFile`
 * 0 → 2, every other kind byte-identical. The `usage: /outputfile […]` line the game prints for
 * a malformed command is NOT this shape and stays unknown — it wrote no file.
 *
 * `file` is the name EQ printed, with no directory: EQ writes dumps into the install root. It is
 * carried verbatim rather than matched against a kind, because `/outputfile inventory <name>`
 * lets the player choose the name and the only honest join is against the file we actually read.
 */
export interface OutputFileEvent extends LogEventBase {
  kind: 'outputFile'
  /** The dump's file name, exactly as the game printed it. */
  file: string
}

/**
 * The camp was CANCELLED — `You abandon your preparations to camp.` (2× in the real log,
 * Aug 02 01:34:09 and 01:34:14, each in the SAME second as its own campStart).
 *
 * World-model law 1 (messages over inference): the brief for this feature assumed an abort
 * had to be INFERRED from "camp lines followed by more activity without a Welcome". It does
 * not — the game prints an explicit line, so we read it instead of guessing. Without it, a
 * player who aborts a camp and then CRASHES seconds later would be reported as having camped.
 */
export interface CampAbortEvent extends LogEventBase {
  kind: 'campAbort'
}

/**
 * A DERIVED absence: the character was OUT OF THE WORLD between two known instants.
 * Synthesized by sessionDetector.ts at each {@link SessionStartEvent} and handed back onto
 * the SAME bus via `emitDerived` (the Task #47 path the epoch detector and the buffs module
 * both use), so consumers see it AFTER the Welcome finishes delivering. Identical in replay
 * and live — nothing here reads the wall clock.
 *
 * WHY `fromTs` IS NOT "THE LAST EVENT BEFORE THE WELCOME" (measured correction). Every login
 * prints a RECONNECT PREAMBLE *before* the Welcome — `You are not currently assigned to an
 * adventure.`, `The Marketplace is unavailable at this time. Please try again later.`,
 * `Channel <X> was too full to join`, `Channels: 1=…`, and (because the client is already
 * connected to chat and receiving zone updates) other players' channel chat AND other players'
 * COMBAT. Across all 19 logins in the original measurement the newest event before the Welcome
 * is 0–2 SECONDS older than it — every single time. Anchoring on it would report a 13-hour
 * absence as a 1-second one and emit ZERO gaps, ever.
 *
 * So `fromTs` is the newest event that could ONLY have been printed because THIS CHARACTER was
 * in the world (`sessionDetector.ts inWorldEvidence` — JOS-262). It was a 30-second window
 * until that ticket measured what the window costs: a preamble longer than the constant emits
 * no gap at all. It is a LOWER bound on the last known in-world instant, so the absence it
 * implies is never under-stated and can run long by the trailing tail of lines that name
 * nobody (measured: 24s across an ordinary camp).
 */
export interface OfflineGapEvent extends LogEventBase {
  kind: 'offlineGap'
  /** Last instant the character is KNOWN to have been in the world (a lower bound). */
  fromTs: number
  /** The Welcome line's ts — the character is in the world again. Exact. */
  toTs: number
  /** True when a non-aborted `campStart` sits within 60s of `fromTs` (an orderly logout). */
  camped: boolean
}

/**
 * The player changed their combat STANCE (Task #51). EQ Legends has two mutually-
 * exclusive combat-modifier groups; this is the melee/general one. The commit line is
 * `You assume a <stance> stance.` (`You begin to change your stance.` is the pre-commit
 * flavor and is NOT emitted — 594 of those vs the assume lines that name the stance).
 * VERIFIED stances (full-log sweep): defensive, offensive, balanced, mage hunter,
 * evasive, striker, berserker, channeler, ranged (9 total — MORE than the 5 the task
 * brief listed; swept, not assumed). `stance` is the lowercased canonical name; the
 * regex is name-permissive so a 10th stance still parses.
 */
export interface StanceChangeEvent extends LogEventBase {
  kind: 'stanceChange'
  stance: string
}

/**
 * The player changed their INVOCATION (Task #51) — the second mutually-exclusive
 * combat-modifier group (a caster/mixed self-buff recited into an active slot). Commit
 * line: `You begin reciting the <invocation> invocation.` (`You begin to change your
 * invocation.` is pre-commit flavor, NOT emitted — 2339 of those). VERIFIED invocations
 * (full-log sweep): inversion, overchannel, recovery, spellblade, divine, inviolable,
 * empowering, arcane mastery, unyielding (9 total — MORE than the 5 the brief listed;
 * "arcane mastery" is a two-word name a single-word grep misses). `invocation` is the
 * lowercased canonical name.
 */
export interface InvocationChangeEvent extends LogEventBase {
  kind: 'invocationChange'
  invocation: string
}

/**
 * The character's OWN `/who` row — the ONLY line in the game that states the class loadout
 * (docs/plans/class-combo-inference.md § 2/A1). EQ Legends runs up to THREE classes at once
 * and never logs a swap, so this row is the single Tier-A observation the combo model can
 * anchor on; everything else is inference.
 *
 * VERIFIED shape (full-log sweep of eqlog_Primitive_freeport.txt, 2026-08-03 — 421 `/who`
 * rows, 11 of them the character's own):
 *
 *   [50 PAL/MNK/ENC] Primitive (Dark Elf)  ZONE: East Freeport (freporte)··
 *   [7 CLR/BER] Primitive (Froglok)  ZONE: West Commonlands (commons)··
 *
 * Every row ends in TWO trailing spaces, and the general `/who` grammar carries three more
 * variants this character has not printed yet but the matcher tolerates anyway (refusing one
 * would silently drop the only loadout statement in the log):
 *   guild tag   `[9 WAR/MAG] Name (Ogre) <Gothic Circle> ZONE: …`  (ONE space before ZONE)
 *   AFK          ` AFK [4 WAR/ENC] Name (Human)  ZONE: …`
 *   corpse       `* RIP *[3 MNK/BER] Name's corpse (Iksar)  ZONE: …`
 * `[ANONYMOUS] Name` states no classes at all and is NOT this event.
 *
 * SELF ONLY, and that is a load-bearing guard, not a filter: a `/who` prints every stranger
 * in the zone, so the rule matches ONLY the tailed character's name (ParserConfig.characterName,
 * injected per session — never a constant). With no character installed the rule declines
 * every line, so a third party's row can never be mistaken for the player's loadout.
 *
 * `classes` is the row's own arity — 2 before the tertiary slot unlocks at level 10, 3 after —
 * so the row is ground truth about cardinality as well as membership. `level` is the DISPLAYED
 * level, which is the MINIMUM of the loadout's class levels; a drop is a legitimate swap, never
 * a rebirth (see epochDetector.ts).
 */
export interface SelfWhoEvent extends LogEventBase {
  kind: 'selfWho'
  /** the bracketed level — min(class levels), not any one class's level. */
  level: number
  /** the /who class codes in row order, e.g. ['PAL','MNK','ENC']. Length 2 or 3. */
  classes: string[]
  /** the race in parens, verbatim ('Dark Elf'). Illusions change it — NOT combo evidence. */
  race?: string
  /** the zone display name with the trailing `(shortname)` id dropped ('East Freeport'). */
  zone?: string
}

/**
 * `You have become better at <Skill>! (<n>)` — a skill tick (design § 2/B3). The ONLY
 * evidence family that can see the four classes with (almost) no spells: BER, MNK and WAR
 * have ZERO spells and ROG has nine, so cast evidence is structurally blind to them and a
 * skill-up is all the log ever says.
 *
 * FULL-LOG SWEEP (2026-08-03, 1.12M lines): 10,216 lines across 54 distinct skills, EVERY one
 * of which previously fell through to `{kind:'unknown'}`, and EVERY one carrying the trailing
 * `(<n>)` — the new skill value. `value` is nevertheless optional so a value-less shape stays
 * expressible without a breaking change, and the matcher accepts it.
 *
 * `skill` is the string EXACTLY as the CLIENT prints it — `1H Slashing`, `Channeling`,
 * `Stringed Instruments` — which is NOT how the wiki spells several of them (`1 Hand
 * Slashing`, `Channelling`, `String`). classes.json's `skills` table is keyed by the client
 * name and carries the alias mapping; the event must never pre-translate, or the table's key
 * and the log's word would drift apart.
 */
export interface SkillUpEvent extends LogEventBase {
  kind: 'skillUp'
  /** client spelling, verbatim ('Flying Kick', '1H Piercing'). */
  skill: string
  /** the new skill value from the trailing `(n)`; absent when the line printed none. */
  value?: number
}

/**
 * THE ACTIVE SPECIAL ATTACK CHANGED — the ONLY line that ever names which special attack a
 * character is currently using, and the fix for "Dragon Punch DPS isn't tracked" (user report
 * 01KZ9AAQ4ES1R2NVYK0JJ68EBQ). EQ Legends' upgraded specials NEVER print their own verb: a
 * Dragon Punch lands as `You strike <mob> for N points of damage.`, exactly like the Eagle
 * Strike and the Tiger Claw before it. So the damage was always counted — it just folded into
 * an anonymous melee lane and no Dragon Punch row could ever exist.
 *
 * TWO VERIFIED SHAPES (full-log sweep 2026-08-05, 1.35M lines — 21 lines, ALL previously
 * `{kind:'unknown'}`, and NO third-person variant exists: every one of them starts `You will
 * now use`, and the log contains no other `now use` line at all):
 *
 *   `You will now use Tiger Claw while auto attacking.`                  11×  autoAttack:true
 *   `You will now use Dragon Punch instead of Eagle Strike while attacking.` 10×  autoAttack:false
 *
 * The two clauses are strictly correlated in the real log — the bare form always says `while
 * auto attacking.` and the replacement form always says `while attacking.` — but they are
 * captured INDEPENDENTLY so a future line that mixes them still parses honestly rather than
 * being silently reshaped to fit the correlation.
 *
 * WHAT EACH SHAPE MEANS, read off the real log rather than assumed:
 *   - the bare form is a GRANT: the character now HAS this special. The Aug 02 01:55 loadout
 *     swap prints six of them in nine seconds (Backstab, Bash, Frenzy, Kick, Smite, + a Slam
 *     replacement) — one per special the new loadout confers. It is also how a lane RESETS: that
 *     burst's `Kick while auto attacking.` put the kick lane back to plain Kick, and the
 *     skill-up stream agrees exactly (Flying Kick ticks stop dead, Kick ticks resume).
 *   - the `instead of` form is an UPGRADE WITHIN A LANE: Tiger Claw → Eagle Strike → Dragon
 *     Punch, Kick → Round Kick → Flying Kick, Bash ↔ Slam.
 *
 * SELF ONLY, structurally: the line has no third-person grammar, so this can only ever describe
 * the tailed character. Nothing here can label a mob's or a pet's swing.
 */
export interface SpecialAttackEvent extends LogEventBase {
  kind: 'specialAttack'
  /** the special now in use, client spelling verbatim ('Dragon Punch', 'Round Kick'). */
  skill: string
  /** the special it displaced; absent on the bare grant form. */
  replaces?: string
  /** true for `while auto attacking.` (a grant / lane reset), false for `instead of … while
   *  attacking.` (an in-lane upgrade). */
  autoAttack: boolean
}

/**
 * A CLASS BECAME AVAILABLE AS A PRIMARY — `You have completed achievement: Primary Class Unlock
 * - Paladin` (JOS-148). The one line the game prints that states an unlock outright, and
 * therefore the only thing in this repo that can OBSERVE one rather than derive it.
 *
 * WHY IT EXISTS AT ALL, measured rather than assumed. The Sky class tests are supposed to unlock
 * their class (external claim, eqlwiki Plane_of_Sky), so the obvious model is "all M turn-ins
 * therefore unlocked". That model is INCOMPLETE, and the owner's own log is the counterexample:
 * a full Sky turn-in circuit on 2026-08-09 (26 completed trades across 14 of the 16 givers)
 * printed NOTHING but `You gain experience!` — no achievement, no reward line — while the ONE
 * first-person unlock line in all 1,461,881 lines fired at `Welcome to level 11!` in a dungeon,
 * for Paladin, on a character that had never handed a Sky giver anything. A class unlocks from
 * the level-11 primary pick, from the free level-50 token and from a bought token, and none of
 * those leaves a turn-in behind. So turn-ins are evidence of PROGRESS and this line is evidence
 * of the ANSWER, and a tab that had only the first would call an unlocked class locked.
 *
 * SELF ONLY, and that is a choice rather than a limitation of the grammar. The third-person
 * `<Name> has completed achievement: Primary Class Unlock - <Class>` does exist (3 lines,
 * strangers) and stays `{kind:'unknown'}` deliberately: a stranger's unlock is not a fact about
 * this character, and the only consumer asks what THIS character can play. Anchoring on
 * `You have completed achievement: ` is also what makes the rule safe, because the classifier
 * sees the message with its `[timestamp] ` prefix already stripped, so a chat line quoting the
 * sentence begins with the speaker's name and can never reach it.
 *
 * THE CLASS NAME IS CARRIED VERBATIM (law 2: canonicalize at boundaries, display raw). Matching
 * it to the bundled Sky data's spelling is the RENDERER's job, case-insensitively, because the
 * parser has no business importing a quest catalog and a pre-translated name would put the
 * alias in two places.
 *
 * MEASURED before it existed: all 155 lines of the achievement family (113 `You have completed
 * achievement:` plus the reward/token siblings) parsed as `{kind:'unknown'}`, so this rule can
 * neither shadow nor be shadowed by anything already in the cascade.
 *
 * WHAT THIS LINE CANNOT SAY, stated rather than papered over: no class in the owner's log is
 * anywhere near a complete Sky set (best is 3 of 7), so nothing here witnesses a Sky-DRIVEN
 * unlock. That the last turn-in prints this same line is a wiki claim, and the tab is written
 * so it never has to be true.
 */
export interface ClassUnlockEvent extends LogEventBase {
  kind: 'classUnlock'
  /** the class as the client spelled it ('Paladin', 'Shadow Knight'), untranslated. */
  className: string
}

/**
 * A WORN ITEM EFFECT ANNOUNCED ITSELF. TWO verified shapes, and a full-log sweep found no third
 * `Your <item> …` activation family:
 *
 *   `Your Djarn's Amethyst Ring (Exaltation) shimmers briefly.`      7,014×
 *   `Your Idol of the Underking (Exaltation) feels alive with power.` 2,408×
 *
 * WHAT IT IS NOT, and this correction is JOS-79: it is not an item CASTING a spell. Wave 3 read
 * it that way — the next line is `You begin casting <Spell>.` in the same second — and had the
 * combo module discard any cast within 2.5 s after one. MEASURED whole-log (1.43M lines,
 * 2026-08-06) that reading is wrong three times over:
 *   * FIVE items print the line and every one the catalog knows is a FOCUS item — Djarn's
 *     Amethyst Ring / Spell Haste II, Idol of the Underking / Improved Healing III, Polished
 *     Mithril Mask / Improved Damage II, Golden Efreeti Boots / Enhancement Haste II. A focus
 *     is worn and passive; it speaks when it modifies a spell YOU cast.
 *   * A clicky casts ONE spell. Djarn's ring precedes 7,033 casts across the player's whole
 *     spellbook, era by era.
 *   * The two healing/damage focuses precede a cast on only 2.0% of their firings (48 of 2,408;
 *     25 of 1,281) — they fire when the spell LANDS. An item that cast would print one always.
 * The rule cost 7,452 of 16,857 own casts (44.2%) and every WIZ observation in the log, which
 * is why a wizard loadout was undetectable. `modules/comboEvidence.ts` carries the full note.
 *
 * WHY IT IS STILL ITS OWN EVENT: 7,749 of these lines were `{kind:'unknown'}` and 172 were
 * being swept into the spell-emote candidate stream (below). Claiming them is worth it on its
 * own; they simply say nothing about the wearer's classes, in either direction.
 *
 * `item` is the RAW display name including any trailing ` (Exaltation)` — law 2: canonicalize
 * at counting boundaries, display what the game printed. Nothing keys off it today; it exists
 * so a future consumer can say WHICH item spoke.
 *
 * CASCADE PLACEMENT: immediately before the permissive spell-landing-emote matcher. 7,749 of
 * the 7,921 lines were `{kind:'unknown'}`; the other 172 (`Your Idol of the Underking feels
 * alive with power.`, the variant with no ` (Exaltation)` for the emote's name pattern to trip
 * over) were being swept into the emote CANDIDATE stream with a subject of "Your Idol of the
 * Underking". Claiming them here was proven inert: a full-log BuffsModule replay produces a
 * byte-identical snapshot before and after (see the wave commit message).
 */
export interface ItemActivateEvent extends LogEventBase {
  kind: 'itemActivate'
  /** raw item display name, verbatim (`Djarn's Amethyst Ring (Exaltation)`). */
  item: string
  /** which message fired — 'shimmer' | 'alive'. Kept so a future family stays expressible. */
  effect: 'shimmer' | 'alive'
}

/**
 * ITEM UPGRADE (merge) — `You have successfully merged two items together to create a new
 * item: <Name>` (236× in the real log). The mechanic (eqlwiki "Item Upgrade System", quoted
 * in main/itemLookupParse.ts): merging consumes a second copy — or a Mote of Potential — to
 * add item EXP; tier N→N+1 costs 2^N. The line names the RESULT, so its ` +N` suffix is the
 * tier the item just REACHED. It is the only line in the game that reports an upgrade.
 *
 * `tier` is UNDEFINED when the result name carries no ` +N`, which is NOT a base item: the
 * SAME line fires for spell-scroll merges, whose result is rank-suffixed instead
 * (`Shiftless Deeds III`, `Allure VI`, `Superior Healing IV` — 77 of the 236 vs 159 that
 * name an item level). A Roman rank is not an item level (law 1: never claim a tier we did
 * not read), so consumers fold only tier-bearing merges and leave scroll merges as what they
 * are — an observed merge with no tier.
 */
export interface ItemMergeEvent extends LogEventBase {
  kind: 'itemMerge'
  /** the RAW result name, exactly as printed (`Thelvorn, Blade of Light +5`) */
  item: string
  /** the reached item level, when the result name carries one */
  tier?: number
}

/**
 * A merge that did NOT happen. FIVE VERIFIED shapes (full-log sweep 2026-08-02); only the
 * first names any item:
 *   'mismatch'  `Your request to merge <target> with <component> failed. The items do not
 *               match, are the exact same item, cannot be merged, the component (the item to
 *               be destroyed) has an augment, or one of the items is no longer in your
 *               inventory.`                                                            (4×)
 *   'weakMote'  `The item you are trying to add will not work, this mote is not
 *               sufficiently powerful to upgrade this item.`                            (9×)
 *   'selfFuse'  `The item you are trying to add will not work, you cannot fuse an item to
 *               itself.`                                                                (4×)
 *   'wrongType' `The item you are trying to add will not work, you cannot merge two
 *               different types of items.`                                              (1×)
 *   'canceled'  `Request to merge items canceled, both items remain unmodified.`        (1×)
 * (The 'selfFuse' wording is why the family cannot be swept by the word "merge" alone — that
 * line never uses it. It was found by diffing parsed output against the raw log, not by
 * guessing sibling phrasings.)
 * NOTHING changed tier here — the value is the 'mismatch' shape, which STATES the tier of an
 * item sitting in your inventory (`… merge Valorium Bracers +2 with Valorium Bracers …`).
 */
export interface ItemMergeFailedEvent extends LogEventBase {
  kind: 'itemMergeFailed'
  reason: 'mismatch' | 'weakMote' | 'selfFuse' | 'wrongType' | 'canceled'
  /** the item that would have been UPGRADED (kept), raw — 'mismatch' only */
  target?: string
  /** the item that would have been CONSUMED, raw — 'mismatch' only */
  component?: string
}

/**
 * A CONSIDER (`/con`) — the player sized a mob up (Task #63). ONE shape, verified by a
 * full-log sweep of eqlog_Primitive_freeport.txt (2026-08-03, 357 lines):
 *
 *   <Mob>[ - a rare creature -] <faction phrase> -- <difficulty phrase> (Lvl: N)
 *
 *   A zol ghoul knight scowls at you, ready to attack -- what would you like your tombstone to say? (Lvl: 38)
 *   A froglok gaz knight regards you indifferently -- looks quite risky, but might be worth a try. (Lvl: 18)
 *   Baron Telyx V`Zher - a rare creature - scowls at you, ready to attack -- what would you like your tombstone to say? (Lvl: 28)
 *
 * `(Lvl: N)` is the family's anchor and EVERY one of the 357 lines carries it (the only other
 * lines in the whole log containing ` -- ` are 9 player chat lines, which have no `(Lvl:`).
 * `level` is nevertheless optional on the type so a future level-less shape stays expressible
 * without a breaking change — see parser.ts, which requires the group today.
 *
 * `mob` is the RAW display name, exactly as printed. A consider line SENTENCE-CASES the leading
 * article ("A zol ghoul knight") where a You-have-slain line does not ("a zol ghoul knight"), so
 * every consumer keys by `idKey(mob)` and adopts the display the same way KillInfo does — see
 * world-model law 2.
 */
export interface ConsiderEvent extends LogEventBase {
  kind: 'consider'
  /** RAW display name, verbatim (article casing preserved; canonicalize with idKey). */
  mob: string
  /** the ` - a rare creature - ` infix was present (12 lines in the real log). */
  rare: boolean
  /** the stated level. Always present today; see the note above. */
  level?: number
  /** the faction rung, canonicalized 1:1 from the phrase (never inferred) — see FACTION_RUNGS. */
  faction: ConsiderFaction
  /** the difficulty clause, VERBATIM (gendered variants preserved). See considerDifficultyShort. */
  difficulty: string
}

// ---------------------------------------------------------------------------
// ROGUE POISON events (Task #64). The catalog these describe — the roster, the coat/dry
// message tables, the Strike proc emotes and the dispel family — lives in shared/poisons.ts;
// its block comment carries the evidence (spell DB + eqlwiki) behind every string.
// ---------------------------------------------------------------------------


/**
 * A rogue-poison Strike LANDING on a target (Task #64). Emitted from the Strike's own
 * cast-on-other emote — the only line the game prints for a proc (there is no cast line and
 * no attacker name, so this event deliberately does NOT claim a caster; see law 6 and the
 * block comment above).
 */
export interface PoisonProcEvent extends LogEventBase {
  kind: 'poisonProc'
  /** Best-effort strike name (the first candidate). Prefer `candidates` when it matters. */
  strike: string
  /** Every strike sharing this emote. Length 1 unless the emote is one of the two shared ones. */
  candidates: string[]
  /** Effect class — unambiguous even when `strike` is not (both members of a pair agree). */
  effect: PoisonEffect
  /** The entity the proc landed on, RAW display name (canonicalize with idKey). */
  target: string
}

/**
 * The player coated their blades (Task #64). `poison` is the DB spell name when the coat
 * line is one we know, else 'unknown'.
 *
 * THIRD PERSON: other players' coats print two shapes, both in the real log —
 *   `Pollux coats their blades in asp venom!`   (named; Asp Venom's own msgCastOnOther)
 *   `Skandercoats their blades in poison.`      (generic; note the MISSING SPACE — that is
 *      how the game actually prints it, verified verbatim on all 2 occurrences, so the
 *      matcher must not require one)
 * The generic form deliberately hides which poison, so it carries `poison: 'unknown'`. These
 * are somebody ELSE's blades and never touch your coat state — `who` is what says so.
 */
export interface PoisonCoatEvent extends LogEventBase {
  kind: 'poisonCoat'
  /** DB spell name, or 'unknown' for the generic third-person form. */
  poison: string
  /** Which slot it occupies — 'unknown' when the poison itself is unknown. */
  group: PoisonGroup | 'unknown'
  /** 'you' for your own coat; otherwise the other player's raw name. */
  who: string
}

/**
 * A coat wore off / was replaced (Task #64) — `The poison dries from the blade.` (utility)
 * or `The venom drips away.` (combat). The line names no poison; `group` is all it can say.
 */
export interface PoisonDryEvent extends LogEventBase {
  kind: 'poisonDry'
  group: PoisonGroup
}

/** A line that parsed as a log line (had a timestamp) but matched no content rule. */
export interface UnknownEvent extends LogEventBase {
  kind: 'unknown'
}

/** The canonical discriminated union of everything the parser can emit. */
export type LogEvent =
  | ZoneEvent
  | LootEventE
  // The three acquisition families that carry no corpse (JOS-144, ./acquireEvents). They sit
  // beside loot because they answer the same question — how did this reach me — and every line
  // any of them claims was MEASURED `{kind:'unknown'}` before they existed.
  | CoinEvent
  | ItemReceivedEvent
  | PurchaseEvent
  | OfferEvent
  | TradeEvent
  | LevelEventE
  | ExpGainEvent
  | AaGainEvent
  | AaSpendEvent
  | AaPotionEvent
  | DeathEvent
  | DamageEventE
  | HealEvent
  | HealUnstatedEvent
  | MitigationEvent
  | MissEvent
  | ResistEvent
  | CharmEvent
  | UncharmEvent
  | CcEvent
  // Beside `cc` because it annotates one: the line that says a hold was BROKEN rather than that it
  // ended (JOS-180). Deliberately NOT in `shared/alertTypes.ts`'s curated `LogEventKind` — it is
  // parser-internal evidence for the duration learner, and JOS-161's per-song break alerts already
  // cover "my mez ended" from the `cc {refresh:true}` side.
  | CcWakeEvent
  | PetClaimEvent
  // The same `/pet who leader` sentence spoken about SOMEBODY ELSE (JOS-250). A separate kind
  // rather than a field on PetClaimEvent, for the reason its own doc comment gives: five models
  // bind `petClaim` to YOU and none of them should have to learn a new field to keep doing it.
  | AllyPetLeaderEvent
  | PetSayEvent
  | CastBeginEvent
  | OtherCastBeginEvent
  | CastFizzleEvent
  | CastInterruptedEvent
  | CastResumedEvent
  | BuffFadeEvent
  | PlayerDeathEvent
  | SpellEmoteEvent
  | BuffApplyEvent
  | BuffWearOffEvent
  | AaActivateEvent
  | IllusionFadeEvent
  | BuffExpiredEvent
  | EpochEvent
  | SessionStartEvent
  | CampStartEvent
  | CampAbortEvent
  | OutputFileEvent
  | GroupEvent
  | OfflineGapEvent
  | StanceChangeEvent
  | InvocationChangeEvent
  // WHAT IS IN YOUR GEMS (JOS-391). Beside the stance/invocation pair because it is the same
  // level of statement — the player operating their own character sheet — and, like them,
  // MEASURED `{kind:'unknown'}` before it existed (4,321 + 4,285 + 4,232 + 474 lines).
  | SpellMemorizeEvent
  | SpellForgetEvent
  | SpellSetEvent
  | SelfWhoEvent
  | SkillUpEvent
  | SpecialAttackEvent
  // Beside the three statements-about-the-character above, because it is a fourth one: what
  // this character is allowed to BE (JOS-148). Measured `{kind:'unknown'}` before it existed.
  | ClassUnlockEvent
  | ItemActivateEvent
  | ItemMergeEvent
  | ItemMergeFailedEvent
  | ConsiderEvent
  | PoisonProcEvent
  | PoisonCoatEvent
  | PoisonDryEvent
  | UnknownEvent
