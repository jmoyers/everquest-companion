// World / progression families of the parse cascade (see parser.ts for the ordered list):
// consider, deaths, zone transitions, the loot family, item merges, turn-ins, level-ups and
// AA gains/spends — plus the zone-name tier decoder every consumer of `zone` events uses.
// Every regex, table and comment here is verbatim from the single-pass parser.

import type { ConsiderFaction, LogEvent, LootDisposition } from '../../shared/logEvents'
import { CONSIDER_FACTION_RUNGS } from '../../shared/logEvents'
import { itemTierFromName } from '../../shared/itemStats'
import { TIER_OPEN_WORLD, TIER_UNKNOWN } from '../../shared/kills'
import { cleanMob, norm, type ClassifyCtx } from './parseCommon'

// ─────────────────────────────────────────────────────────────────────────────
// THE ZONE NAME IS THE ONLY THING THAT STATES A DIFFICULTY (JOS-166)
// ─────────────────────────────────────────────────────────────────────────────
//
// EQ Legends encodes instance difficulty in the zone name, and nowhere else: no kill line, no
// lockout line and no instance-creation notice carries one (the sweep is quoted in the header of
// renderer/features/bosses/lockout.ts). So `zoneTier` is where the app decides what a kill's
// difficulty was, and everything downstream inherits whatever it decides here.
//
// THE THREE WORLDS. A full-log sweep of every `You have entered <X>.` in the owner's 1.4M-line
// log (2026-08-09, read-only) yields exactly these shapes, and they fall into three kinds:
//
//   INSTANCED, DIFFICULTY NAMED — the adjective is the whole rule (d1..d4):
//     You have entered The Plane of Hate - Solo 4 (Refined).
//     You have entered Nagafen's Lair - Group 3 (Fused).
//     You have entered Najena 4 (Refined).                  ← no Solo/Group word, still instanced
//     You have entered The Plane of Sky 1 (Awakened).
//
//   INSTANCED, NO ADJECTIVE — the BASE difficulty, d0, and a real one (7 in the log):
//     You have entered The Plane of Hate - Solo.
//     You have entered Nagafen's Lair - Solo.
//     You have entered The Permafrost Caverns - Solo.
//
//   NOT INSTANCED — the open world, which carries no lockout of any kind:
//     You have entered The Plane of Hate.
//     You have entered Innothule Swamp.
//
// WHY d0 IS NOW ITS OWN ANSWER (owner decision, 2026-08-09, corroborated by the community wiki):
// a raid target has FIVE weekly lockouts, d0 through d4, and the owner clears all five most
// weeks. The base instance is a difficulty like any other; what it is NOT is the open world, and
// the suffix is what tells them apart. Until this ticket all three kinds decoded to 0, so an
// open-world kill and a base-instance clear were the same fact to every consumer.
//
// FOUR ANSWERS, NOT FIVE. `TIER_UNKNOWN` covers both "no zone line has been seen yet" (an empty
// string — the kills module's state before the scan reaches one) and "an instance whose
// adjective this app has never decoded". The second used to fall through to 0; a parenthetical
// the table does not know is still unmistakably an INSTANCE (the base difficulty never prints
// one), so calling it d0 would be inventing the one fact the line failed to state (law 1).
const TIER_ADJ: Record<string, number> = { awakened: 1, adaptive: 2, fused: 3, refined: 4 }

/** Difficulty names, indexed by the five DIFFICULTY tier keys; the two non-difficulties have
 *  no entry here (the renderer spells them in lib/tierChip.ts, where the chips live). */
export const TIER_LABELS = ['d0', 'd1 · Awakened', 'd2 · Adaptive', 'd3 · Fused', 'd4 · Refined']

/** A `- Solo` / `- Group N` suffix: the word that makes a zone an INSTANCE of itself. */
const INSTANCE_SUFFIX_RE = /\s-\s*(Solo|Group)\b/i

export function zoneTier(zone: string): { base: string; tier: number } {
  const base = zone
    .replace(/\s*-\s*(Solo|Group)\b.*$/i, '')
    .replace(/\s+\d+\s*\([^)]*\)\s*$/, '')
    .replace(/\s+\([^)]*\)\s*$/, '')
    .trim()
  const adj = /\(([A-Za-z]+)\)\s*$/.exec(zone)
  if (adj) return { base, tier: TIER_ADJ[adj[1].toLowerCase()] ?? TIER_UNKNOWN }
  if (INSTANCE_SUFFIX_RE.test(zone)) return { base, tier: 0 }
  return { base, tier: base ? TIER_OPEN_WORLD : TIER_UNKNOWN }
}

// ----- content matchers (verbatim regexes from the two old parsers) -----

// Loot (self):
//   --You have looted a Mote of Infinitesimal Potential from Bazzzazzt's corpse.--
//   --You have looted an Efreeti War Staff from the Hand of Veeshan's corpse.--
//   --You have looted 2 Bone Chips from an elf skeleton's corpse.--
// Every loot form can carry a STACK COUNT where the article goes (Task #47): a digit
// run + space instead of "a "/"an ". Captured separately so the item name stays clean
// (the old regexes swallowed "2 Bone Chips" as the item — a distinct bogus counting
// key). VERIFIED SAFE against the real log: no looted item name starts with a digit
// (stacked shapes observed only on the dashed + sold forms; the capture is symmetric
// across the family anyway so a future stacked variant parses right).
const LOOT_RE = /^--You have looted (?:(\d+) |an? )?(.+?)(?: from (.+?) corpse)?\.--$/
// Dashless fallback for servers/cases that omit the surrounding dashes.
const LOOT_RE_PLAIN = /^You have looted (?:(\d+) |an? )?(.+?)(?: from (.+?) corpse)?\.$/
// Auto-disposition loot (Tasks #40/#47): the client can loot-and-route an item in one
// line. These use "You looted" (no leading "have", no surrounding dashes). VERIFIED
// shapes (real log 2026-08-01/02 — the full family, no unrouted "You looted" exists):
//   You looted a Wind Rune Caza from a greater sphinx's corpse and stored it in your currency
//   You looted a Belt of Concordance +1 from Noble Dojorn's corpse and sold it for free.
//   You looted 2 Spider Silk from a giant black widow's corpse and sold it for 2 gold, 8 silver and 6 copper.
//   You looted a Dull Wooden Spear from Officer Grush's corpse and stored it in your Dragon Hoard
//   You looted a Griffenne Blood from a soul carrier's corpse and stored it in your tradeskill depot
//   You looted a Silver Earring from a necro acolyte's corpse to create a Silver Earring +1
// Sold lines carry a trailing period; currency/hoard/depot/combine lines carry NONE
// (tolerated everywhere). Dispositions: 'currency'/'hoard'/'depot' are all KEPT storage
// (count toward held/quest progress); 'sold' was vendored — GONE, never held;
// 'combined' consumed the looted copy AND a held copy to create the upgraded `created`
// item (every one of the 293 real combine lines creates `<same base> +N`), so it nets
// ZERO held. The one held-count rule lives in computeHeldCounts (renderer).
const LOOT_CURRENCY_RE = /^You looted (?:(\d+) |an? )?(.+?) from (.+?) corpse and stored it in your currency\.?$/
const LOOT_SOLD_RE = /^You looted (?:(\d+) |an? )?(.+?) from (.+?) corpse and sold it for (?:free|[\d,]+ (?:platinum|gold|silver|copper).*?)\.?$/
const LOOT_STORED_RE = /^You looted (?:(\d+) |an? )?(.+?) from (.+?) corpse and stored it in your (Dragon Hoard|tradeskill depot)\.?$/
const LOOT_COMBINE_RE = /^You looted (?:(\d+) |an? )?(.+?) from (.+?) corpse to create (?:an? )?(.+?)\.?$/
// THE ONE LINE THAT SUBTRACTS (JOS-401):
//   You successfully destroyed 1 Enchanted Fine Steel Morning Star +3.
//   You successfully destroyed 38 Bone Chips.
//   You successfully destroyed 3 Mosquito Rations*.
// FULL-LOG SWEEP (read-only, 2026-08-16, eqlog_Primitive_freeport.txt): 356 lines, and every one
// of them matches this shape — a count that is always stated (stacks say the stack size), the
// item name verbatim, a trailing period. It joins the loot family as `disposition: 'destroyed'`
// with NO source, because a destroy happens in your bags and names no mob.
//
// ANCHORED AT BOTH ENDS, like every other family here, and that is what keeps player chat out of
// it: seven other lines in the log contain "destroyed" and six are quoted speech (`'i just
// destroyed …'`), which ends in a quote rather than a period and never starts the message.
//
// THE ` +N` AND THE TRAILING `*` ARE KEPT VERBATIM, exactly as the loot family keeps a `+N`:
// `itemCountKey` folds the `+N` at the counting boundary downstream (law 2). The `*` is NOT
// folded, and that is measured rather than overlooked — no loot line in the whole log carries one
// (0 of 6,216), while the `/outputfile inventory` dump writes the same six items with the same
// star (`Backpack*`, `Bandages*`), so keeping it verbatim is what makes a destroy line and a dump
// row land on ONE counting key. Stripping it would invent a fold neither source asked for.
const DESTROY_RE = /^You successfully destroyed (\d+) (.+?)\.$/

const ZONE_RE = /^You have entered (.+?)\.$/
// Pseudo-zone notices that share the "You have entered <X>." grammar but are NOT
// real zone transitions. Emitting a zone event for these wipes the tracked zone
// (so the kills module computes tier 0 for everything killed inside an instance)
// AND spuriously finalizes the current encounter / clears charm / resets zoneAgg
// mid-instance. Every instanced-zone entry is followed ~instantly by one of these.
//
// Evidence (full-log `grep -oaE "You have entered [^.]*\." | uniq -c`, 2026-08-01):
// real zones are all Title Case; the ONLY non-zone shape observed is the effect
// notice below. We reject the tightest filter the evidence supports — the exact
// "an area where …" effect-notice family — rather than a blanket lowercase reject
// (no lowercase-starting REAL zone exists today, but future ones might).
//   14×  "an area where levitation effects do not function"
// Other plausible effect notices ("...where binding is not permitted", "an Arena
// (PvP) area") do NOT appear in the real log; `^an area where ` covers the whole
// observed family and any sibling effect notice of the same shape.
const PSEUDO_ZONE_RE = /^an area where /i

// Kills:
//   "You have slain a spectre!"
//   "Maestro of Rancor has been slain by Innoruuk`s Chosen!"
const SLAIN_SELF_RE = /^You have slain (.+?)!$/
const SLAIN_BY_RE = /^(.+?) has been slain by (.+?)!$/
// Player's own death: "You have been slain by <killer>!" (distinct from the
// third-person "<mob> has been slain by <x>!" SLAIN_BY_RE, which needs "has").
const PLAYER_DEATH_RE = /^You have been slain by (.+?)!$/
// …and the KILLERLESS form. When the killing blow is a DoT tick (or anything else with no
// attacker to name), the client prints this instead of the slain sentence — same death,
// no killer. Measured over the 1.11M-line sweep log: 23 player deaths, 22 slain sentences
// and this one line, so the two shapes together are the whole set. Deliberately NOT
// widened further: "You have been knocked unconscious!" precedes 23/23 deaths but also
// fires once where the player survived, and "Returning to <bind>. Please wait..." is a
// redundant echo whose text varies by server (JOS-88).
const YOU_DIED = 'You died.'

// The MOB twin of `You died.`: `<Name> died.` — the killerless THIRD-PERSON death, and the
// reason a boss killed by a damage-over-time tick reads as "0 kills" (JOS-101). Same cause as
// the player form above: with no attacker to name, the client prints this INSTEAD of a slain
// sentence, never as well as one.
//
// FULL-LOG SWEEP (read-only, 2026-08-08, eqlog_Primitive_freeport.txt, 1.44M lines): 21 lines
// end in " died." — 2 are `You died.`, claimed above by exact equality before this regex is
// ever reached, and the other 19 are mob names ("An azarack died.", "A froglok gaz shaman
// died.", "Soldier of V`Zher died."). NOT ONE of the 21 has a `slain` line within ±3 lines, so
// this shape never duplicates a slain sentence and cannot double-count a kill. 15 of the 19
// carry `You gain experience!` on the line immediately before — the join that credits them
// (shared/kills.ts KILL_EXP_JOIN_MS). The sibling log eqlog_Primitive_halas.txt has 0.
//
// The pattern looks wide open but player CHAT cannot be claimed by it: a say/tell/group line
// wraps its text in quotes, so it ends `died.'` and not `died.` — which is why a sweep this
// broad finds zero chat lines. Anchored at both ends for the same reason EXP_RE is.
const MOB_DIED_RE = /^(.+?) died\.$/

// Turn-ins: "You offered 1 Sphinx Claw to Dason Goldblade." then
//           "You complete the trade with Dason Goldblade."
const OFFER_RE = /^You offered [\d,]+ (.+?) to (.+?)\.$/
const TRADE_DONE_RE = /^You complete the trade with (.+?)\.$/

// "You have gained a level! Welcome to level 26!"
const LEVEL_RE = /^You have gained a level! Welcome to level (\d+)!$/

// Experience (leveling analytics). FOUR shapes, from a full-log sweep (2026-08-03, 1.11M
// lines): `You gain experience! (3.288%)` ×3865, `You gain party experience! (1.373%)` ×471,
// and the percent-LESS variants of both (×474 / ×28). The percentage is an INCREMENT of the
// CURRENT level's bar, not a bar position — proven by summing it between consecutive
// `Welcome to level N!` lines: 98.8 / 100.2 / 100.5 / 102.1 over four level spans.
//
// The regex is anchored at BOTH ends on purpose. 12 other lines in the log contain the word
// "experience" — 11 player chat lines ("this is a retro experience") and one mob emote
// (`Coercer T`vala experiences a quickening.`) — and an unanchored match would claim them,
// minting phantom experience for somebody else's typing. Anchored, it claims exactly 4838
// lines, every one of which previously fell through to `{kind:'unknown'}`.
const EXP_RE = /^You gain (party )?experience!(?: \(([\d.]+)%\))?$/

// "You have gained an ability point!  You now have 7 ability points."
// "You have gained 2 ability point(s)!  You now have 3 ability point(s)."
const AA_RE = /^You have gained (an|\d+) ability point(?:\(s\))?!\s+You now have (\d+) ability point/

// The item-shop AA potion (Bottle of Alternate Adventure) landing on YOU. An EXACT-string
// family: a full-log sweep (1.36M lines) finds 32 of these against 34 `You begin casting
// Bottle of Alternate Adventure.` and 2 interrupts, and none of the 32 followed another
// player's cast of it — the line is self-only, which is why no name is extracted.
//
// It was `{kind:'unknown'}` before this rule existed, so it can neither shadow nor be shadowed
// by another family. It is NOT in spells.json, so `classifyDbBuff` never had it either; the
// learned message overlay does carry it as a verified landing, and buffs.ts keeps feeding the
// miner from the new kind so that stays byte-identical.
const AA_POTION_LANDING = 'You are filled with the spirit of alternate adventure.'

// Spending AA (two forms — see AGENTS.md).
const AA_SPEND_RE = / at a cost of (\d+) ability points?\.$/
const AA_ABILITY_RE = /gained the ability (?:"([^"]+)"|to use (.+?)) at a cost of/
const AA_IMPROVED_RE = /^You have improved (.+?) (\d+) at a cost of/

// ----- item upgrade / merge (Task #60) -----
// FULL-LOG SWEEP (read-only, 2026-08-02) of every merge/upgrade/mote/exaltation line family.
// What EXISTS, and what we parse:
//
//   PARSED
//   236×  `You have successfully merged two items together to create a new item: <Name>`
//         The upgrade itself. The result name is the ONLY tier signal the game ever prints:
//         159 of the 236 end in ` +N` (an item level); the other 77 end in a ROMAN RANK
//         (`Shiftless Deeds III`, `Allure VI`) because the same line fires when two SPELL
//         SCROLLS are merged. A rank is not a tier, so `tier` stays undefined there.
//     4×  `Your request to merge <target> with <component> failed. The items do not match,
//         are the exact same item, cannot be merged, the component (the item to be
//         destroyed) has an augment, or one of the items is no longer in your inventory.`
//         The ONLY failure shape that names items — and `<target>` carries its ` +N`, i.e.
//         it states the tier of an item you are holding.
//     9×  `The item you are trying to add will not work, this mote is not sufficiently
//         powerful to upgrade this item.`                            (no item named)
//     4×  `The item you are trying to add will not work, you cannot fuse an item to
//         itself.` — NB this one never says "merge", so a sweep on that word alone MISSES
//         it; it surfaced by diffing parsed output against the raw log. (no item named)
//     1×  `The item you are trying to add will not work, you cannot merge two different
//         types of items.`                                           (no item named)
//     1×  `Request to merge items canceled, both items remain unmodified.` (no item named)
//   356×  `You successfully destroyed <N> <Item>[ +N][*].` — PARSED SINCE JOS-401, as a loot event
//         with disposition 'destroyed' (see DESTROY_RE above). It was in the not-parsed list below
//         for two releases on the reasoning "a destroy can only retire tier evidence we never
//         claimed to be current inventory" — which was true of TIERS, the only thing this sweep was
//         about, and false of held counts, which is the whole of the Sky tracker. The item-tier
//         module still ignores it (it folds 'combined' rows only) and that reasoning still holds
//         there; what changed is that something else now needs the line.
//
//   EXISTS, DELIBERATELY NOT PARSED (nothing to model — see the reason on each)
//   302×  `You looted <item> from <mob>'s corpse to create a <item> +N` — an AUTO-merge on
//         pickup. ALREADY parsed by the loot family as disposition:'combined' + `created`
//         (every one of the 302 creates `<same base> +N`), so a second matcher would
//         double-count. The itemTiers module folds it from the loot event.
//  6433×  `Your <Item> (Exaltation) shimmers briefly.` / `feels alive with power.` /
//         `flickers with a pale light.` / `pulses with light as your vision sharpens.`
//         A socketed exaltation FIRING. It names the exaltation's SOURCE item, never the
//         host it is socketed into, and carries no tier, so it can neither identify the
//         item in front of you nor advance any tier state.
//   Motes appear ONLY inside ordinary loot lines (`--You have looted a Mote of
//   Infinitesimal Potential …--`), which the loot family already parses.
//   NOTHING anywhere reports item EXP within a tier, socket CONTENTS, or the tier of an
//   item you merely hold — hence no exp fill in the UI (law 1).
const ITEM_MERGE_RE = /^You have successfully merged two items together to create a new item: (.+)$/
const ITEM_MERGE_FAIL_RE = /^Your request to merge (.+?) with (.+?) failed\. /

// ----- consider (`/con`, Task #63) -----
// ONE shape, from a full-log sweep of the 357 `(Lvl: N)` lines (2026-08-03):
//   <Mob>[ - a rare creature -] <faction phrase> -- <difficulty clause> (Lvl: N)
// The faction phrase is what SPLITS the mob name from the rest — a greedy/lazy `.+?` alone
// cannot, because a mob name and a con phrase are both free text. So the alternation is built
// from the ladder in shared/logEvents.ts (7 rungs observed here + the 2 unobserved classic
// rungs; counts documented there). A rung we don't know would make the line DECLINE rather
// than mis-split a mob name in half — never invent a name (law 2).
//
// Notes on the captures:
//   - the ` - a rare creature - ` infix (12 lines) sits BETWEEN the name and the rung, so it is
//     an optional group rather than something stripped from the name afterwards.
//   - the difficulty clause is captured VERBATIM (gendered variants — "looks like HE would wipe
//     the floor with you!" — are real and kept); `\s*` before `(Lvl:` absorbs the one clause in
//     the log that is padded with trailing spaces ("looks kind of risky... you might win.   ").
//   - `(Lvl: N)` is REQUIRED by the matcher: all 357 lines state a level. `ConsiderEvent.level`
//     is optional only so a future level-less shape stays expressible.
const CONSIDER_RE = new RegExp(
  '^(.+?)( - a rare creature -)? (' +
    CONSIDER_FACTION_RUNGS.map((r) => r.phrase.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|') +
    ') -- (.+?)\\s*\\(Lvl: (\\d+)\\)$'
)
/** phrase → rung, for the O(1) lookup after CONSIDER_RE captures the phrase. */
const CONSIDER_FACTION_BY_PHRASE = new Map<string, ConsiderFaction>(
  CONSIDER_FACTION_RUNGS.map((r) => [r.phrase, r.faction])
)

/** Build a loot event from the shared capture layout of the loot regex family (Task #47):
 *  optional stack-count digits (in the article slot), item, source, disposition. `count`
 *  is omitted (not 1) when the line names no stack, keeping the common case payload-free. */
function loot(
  { ts, seq, raw }: ClassifyCtx,
  spec: {
    item: string
    source: string | undefined
    disposition: LootDisposition | undefined
    countStr: string | undefined
  }
): LogEvent & { kind: 'loot' } {
  const ev: LogEvent & { kind: 'loot' } = {
    kind: 'loot', seq, ts, raw, item: spec.item.trim(), source: spec.source
  }
  if (spec.disposition) ev.disposition = spec.disposition
  if (spec.countStr) ev.count = Number(spec.countStr)
  return ev
}

/**
 * Consider (`/con`, Task #63).
 * Gated on `(Lvl: `, which in the whole real log appears ONLY on consider lines. Placed
 * here (after the combat/heal battery, before every "You …"-prefixed family) purely for
 * hot-path cost: it is one substring probe and the regex runs for ~357 lines in 1.02M.
 * No earlier family can claim a consider line — the two clauses containing ", but " are
 * rejected by the miss gate's `You try to `/` tries to ` requirement, and the resist gate
 * needs a trailing "!" where a consider always ends in ")".
 */
export function classifyConsider({ text, ts, seq, raw }: ClassifyCtx): LogEvent | null {
  if (text.includes('(Lvl: ')) {
    const m = CONSIDER_RE.exec(text)
    if (m) {
      const faction = CONSIDER_FACTION_BY_PHRASE.get(m[3])
      // The alternation can only match a phrase from the ladder, so this is total; the guard
      // exists so a future edit that widens the regex can't silently emit a bogus rung.
      if (faction) {
        return {
          kind: 'consider',
          seq,
          ts,
          raw,
          mob: m[1].trim(),
          rare: m[2] !== undefined,
          level: Number(m[5]),
          faction,
          difficulty: m[4].trim()
        }
      }
    }
  }
  return null
}

/** Deaths (unifies self-slain and slain-by). */
export function classifyDeath({ text, ts, seq, raw }: ClassifyCtx): LogEvent | null {
  // The killerless player death, checked first and by exact equality so the common path
  // pays one length-guarded string compare. Emits the SAME `playerDeath` kind as the slain
  // sentence — one death detector, one event — just without a killer (the field is already
  // optional, and no consumer reads it: buffs strip, combat censors, the alert fires).
  if (text === YOU_DIED) return { kind: 'playerDeath', seq, ts, raw }
  if (text.includes('slain')) {
    // Player's OWN death (Task #19): "You have been slain by <killer>!" — strips all
    // buffs. Matched before the third-person SLAIN_BY_RE (which needs "has been",
    // not "have been", so it never claims this line anyway). Kept separate from the
    // mob `death` kind so buff-clearing is unambiguous.
    const pd = PLAYER_DEATH_RE.exec(text)
    if (pd) return { kind: 'playerDeath', seq, ts, raw, killer: pd[1].trim() }
    let m = SLAIN_SELF_RE.exec(text)
    if (m) return { kind: 'death', seq, ts, raw, name: norm(m[1]), bySelf: true }
    m = SLAIN_BY_RE.exec(text)
    if (m) return { kind: 'death', seq, ts, raw, name: norm(m[1]), bySelf: false, killer: m[2].trim() }
  }
  // The killerless MOB death, gated on a cheap suffix test so the common path pays nothing.
  // `bySelf:false` with NO killer is the honest shape and a deliberate one: the line names no
  // attacker, and law 1 forbids inventing one. `bySelf:true` would credit you with a stranger's
  // kill and make the combat engine attribute the killing blow to you; a synthesized killer
  // would be a fabricated entity. Every consumer already spells the no-killer case — combat/
  // ingest.ts computes `killerKey: undefined`, reducers.ts `isCountedKill` short-circuits to
  // true (it IS a kill of that mob), kills.ts credits it purely from the experience join, and
  // progression.ts files it as NEITHER credited nor witnessed, because "somebody else killed
  // it" is exactly the claim this line does not make.
  if (text.endsWith(' died.')) {
    const m = MOB_DIED_RE.exec(text)
    if (m) return { kind: 'death', seq, ts, raw, name: norm(m[1]), bySelf: false }
  }
  return null
}

/** Zone transitions. */
export function classifyZone({ text, ts, seq, raw }: ClassifyCtx): LogEvent | null {
  if (text.includes('entered')) {
    const m = ZONE_RE.exec(text)
    // Reject pseudo-zone effect notices (e.g. "an area where levitation effects do
    // not function") so they don't overwrite the real zone / disrupt the engine.
    if (m && !PSEUDO_ZONE_RE.test(m[1])) return { kind: 'zone', seq, ts, raw, zone: m[1].trim() }
  }
  return null
}

/** Self-loot, including the auto-disposition variants — and the destroy, which is the negative. */
export function classifyLoot(c: ClassifyCtx): LogEvent | null {
  const { text } = c
  // The destroy (JOS-401). Its own probe rather than a branch of the loot gate below, because the
  // sentence never says "looted"; a `startsWith` costs one length-guarded compare on the hot path.
  if (text.startsWith('You successfully destroyed ')) {
    const d = DESTROY_RE.exec(text)
    if (d) return loot(c, { item: d[2], source: undefined, disposition: 'destroyed', countStr: d[1] })
  }
  if (text.includes('looted')) {
    const m = LOOT_RE.exec(text) ?? LOOT_RE_PLAIN.exec(text)
    if (m) return loot(c, { item: m[2], source: cleanMob(m[3]), disposition: undefined, countStr: m[1] })
    // Auto-disposition variants (Tasks #40/#47): looted-and-routed in one line. These carry
    // a `disposition` the loot module/quest counting use to decide whether the item is
    // still held ('currency'/'hoard'/'depot' = kept, quest-countable), gone ('sold' =
    // vendored), or merged into an upgrade ('combined' = consumed→created, net-zero held).
    const cur = LOOT_CURRENCY_RE.exec(text)
    if (cur) return loot(c, { item: cur[2], source: cleanMob(cur[3]), disposition: 'currency', countStr: cur[1] })
    const sold = LOOT_SOLD_RE.exec(text)
    if (sold) return loot(c, { item: sold[2], source: cleanMob(sold[3]), disposition: 'sold', countStr: sold[1] })
    const stored = LOOT_STORED_RE.exec(text)
    if (stored) {
      return loot(c, {
        item: stored[2],
        source: cleanMob(stored[3]),
        disposition: stored[4] === 'Dragon Hoard' ? 'hoard' : 'depot',
        countStr: stored[1]
      })
    }
    const comb = LOOT_COMBINE_RE.exec(text)
    if (comb) {
      return {
        ...loot(c, { item: comb[2], source: cleanMob(comb[3]), disposition: 'combined', countStr: comb[1] }),
        created: comb[4].trim()
      }
    }
  }
  return null
}

/**
 * Item upgrade (merge) — the tier event + every failure shape. Two substring probes,
 * because the mote-too-weak failure is the one line in the family that never says "merge"
 * ("The item you are trying to add will not work, this mote is not sufficiently powerful
 * to upgrade this item."). Ordered AFTER loot so the auto-merge-on-pickup line
 * (`… to create a <item> +N`) stays a single 'combined' loot event and is never
 * double-counted here.
 */
export function classifyItemMerge({ text, ts, seq, raw }: ClassifyCtx): LogEvent | null {
  if (text.includes('merge') || text.startsWith('The item you are trying to add')) {
    const m = ITEM_MERGE_RE.exec(text)
    if (m) {
      const item = m[1].trim()
      // A ` +N` result is an item level; a Roman-rank result is a merged SPELL SCROLL and
      // carries no tier (law 1 — we never invent one for it).
      const tier = itemTierFromName(item)
      return tier === undefined
        ? { kind: 'itemMerge', seq, ts, raw, item }
        : { kind: 'itemMerge', seq, ts, raw, item, tier }
    }
    const f = ITEM_MERGE_FAIL_RE.exec(text)
    if (f) {
      return { kind: 'itemMergeFailed', seq, ts, raw, reason: 'mismatch', target: f[1].trim(), component: f[2].trim() }
    }
    if (text === 'The item you are trying to add will not work, this mote is not sufficiently powerful to upgrade this item.') {
      return { kind: 'itemMergeFailed', seq, ts, raw, reason: 'weakMote' }
    }
    if (text === 'The item you are trying to add will not work, you cannot fuse an item to itself.') {
      return { kind: 'itemMergeFailed', seq, ts, raw, reason: 'selfFuse' }
    }
    if (text === 'The item you are trying to add will not work, you cannot merge two different types of items.') {
      return { kind: 'itemMergeFailed', seq, ts, raw, reason: 'wrongType' }
    }
    if (text === 'Request to merge items canceled, both items remain unmodified.') {
      return { kind: 'itemMergeFailed', seq, ts, raw, reason: 'canceled' }
    }
  }
  return null
}

/** Turn-ins: the offer line, then the trade-complete line. */
export function classifyTurnIn({ text, ts, seq, raw }: ClassifyCtx): LogEvent | null {
  if (text.includes('offered')) {
    const m = OFFER_RE.exec(text)
    if (m) return { kind: 'offer', seq, ts, raw, item: m[1].trim(), npc: m[2].trim() }
  }
  if (text.includes('complete the trade')) {
    const m = TRADE_DONE_RE.exec(text)
    if (m) return { kind: 'trade', seq, ts, raw, npc: m[1].trim() }
  }
  return null
}

/** Leveling. */
export function classifyLevel({ text, ts, seq, raw }: ClassifyCtx): LogEvent | null {
  if (text.includes('gained a level')) {
    const m = LEVEL_RE.exec(text)
    if (m) return { kind: 'level', seq, ts, raw, level: Number(m[1]) }
  }
  return null
}

/**
 * Experience gains. `pct` is OMITTED — never 0 — when the line stated no percentage: in the
 * real log every percent-less line falls inside one contiguous at-the-cap window (level 50,
 * no ding for 34h), i.e. the game prints a percentage only while a level bar exists. Emitting
 * 0 there would turn "the log didn't say" into "you earned nothing" (law 1).
 *
 * ORDERING at a ding needs no special case: the level line comes FIRST, then the exp line
 * carrying the overflow into the new level (verified `Mon Aug 03 00:40:46` — `Welcome to
 * level 41!` then `You gain experience! (3.867%)`), so nothing is double counted.
 */
export function classifyExp({ text, ts, seq, raw }: ClassifyCtx): LogEvent | null {
  if (text.startsWith('You gain ')) {
    const m = EXP_RE.exec(text)
    if (m) {
      const party = m[1] !== undefined
      return m[2] === undefined
        ? { kind: 'expGain', seq, ts, raw, party }
        : { kind: 'expGain', seq, ts, raw, party, pct: Number(m[2]) }
    }
  }
  return null
}

/** AA gains / spends. */
export function classifyAa({ text, ts, seq, raw }: ClassifyCtx): LogEvent | null {
  if (text.includes('ability point')) {
    const g = AA_RE.exec(text)
    if (g) return { kind: 'aaGain', seq, ts, raw, amount: g[1] === 'an' ? 1 : Number(g[1]), nowHave: Number(g[2]) }
    const c = AA_SPEND_RE.exec(text)
    if (c) {
      const cost = Number(c[1])
      const imp = AA_IMPROVED_RE.exec(text)
      if (imp) {
        const rank = Number(imp[2])
        return { kind: 'aaSpend', seq, ts, raw, ability: `${imp[1].trim()} ${rank}`, cost, rank }
      }
      const a = AA_ABILITY_RE.exec(text)
      return { kind: 'aaSpend', seq, ts, raw, ability: (a?.[1] ?? a?.[2] ?? 'ability').trim(), cost }
    }
  }
  return null
}

/**
 * The AA potion quaff. One fact, no numbers: the bottle landed. How many completions it pays
 * double for is nowhere in the log — see `shared/aaPace.ts`, which models it and says so.
 */
export function classifyAaPotion({ text, ts, seq, raw }: ClassifyCtx): LogEvent | null {
  return text === AA_POTION_LANDING ? { kind: 'aaPotion', seq, ts, raw } : null
}
