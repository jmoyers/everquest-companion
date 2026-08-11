// Combat families of the parse cascade (see parser.ts for the ordered list):
// misses/avoided swings, absorption/mitigation, spell resists, the damage battery
// (melee / typed spell / DoT / damage shield) and heals. Every regex and comment here is
// verbatim from the single-pass parser it was factored out of.

import type { DamageType } from '../../shared/combat'
import type { LogEvent, MissType } from '../../shared/logEvents'
import { parseModifiers, hasCritical, damageCategory } from '../combat/taxonomy'
import { norm, type ClassifyCtx } from './parseCommon'

// ----- combat matchers (verbatim from combat/parse.ts) -----

// Every verb must match BOTH first-person ("You slash") and third-person
// ("A mob slashes"). Spelled out explicitly (a bare `slashes?` drops all
// first-person melee).
const MELEE_VERBS =
  'hit(?:s)?|slash(?:es)?|pierce(?:s)?|crush(?:es)?|bash(?:es)?|kick(?:s)?|bite(?:s)?|claw(?:s)?|gore(?:s)?|maul(?:s)?|punch(?:es)?|strike(?:s)?|slice(?:s)?|backstab(?:s)?|slam(?:s)?|sting(?:s)?|rend(?:s)?|smash(?:es)?|gnaw(?:s)?|lash(?:es)?|smite(?:s)?|cleave(?:s)?|reave(?:s)?|shoot(?:s)?|frenzies on|frenzy on|flurries|flurry'

const MELEE_RE = new RegExp(`^(.+?) (?:${MELEE_VERBS}) (.+?) for (\\d+) points? of damage\\.(?: \\((.+?)\\))?$`)
const MELEE_VERB_RE = new RegExp(` (${MELEE_VERBS}) `)
const SPELL_RE = /^(.+?) (?:hits?) (.+?) for (\d+) points of ([\w-]+) damage by (.+?)\.(?: \((.+?)\))?$/
const DS_RE = /^(.+?) is \w+ by (YOUR|.+?'s) (.+?) for (\d+) points? of non-melee damage\.$/
// Incoming DS on the player: "YOU are burned by a X's flames for N points of
// non-melee damage!" (reversed grammar + trailing '!'). Mob = attacker.
const DS_INC_RE = /^YOU are \w+ by (.+?)'s (.+?) for (\d+) points? of non-melee damage!$/
// DoT with a caster: "<B> has taken N damage from your <Spell>." | "… from <Spell> by <caster>."
// An optional trailing " (Critical)" (or other) modifier may follow the period.
const DOT_RE = /^(.+?) has taken (\d+) damage from (.+?)\.(?: \((.+?)\))?$/
// Caster-less DoT (someone else's): "<B> has taken N damage by <Spell>." → attacker:null.
const DOT_NOCASTER_RE = /^(.+?) has taken (\d+) damage by (.+?)\.(?: \((.+?)\))?$/

// ----- heal (NEW): "<healer> healed <target> for N hit points[ by <spell>]." -----
// Two shapes in the real log:
//   "<healer> healed <target> for 120 hit points by <Spell>."         (amount only)
//   "<healer> healed <target> for 85 (107) hit points by <Spell>."    (actual first,
//     raw/overheal amount in parens — ~2.7k lines the old amount-only regex missed).
// `amount` is always the FIRST number (effective heal); the parenthesized raw amount
// is captured separately as `rawAmount`. Singular "hit point" is tolerated too.
//
// CRITICAL HEALS (Task #59): heal lines carry the damage family's trailing paren modifier —
// "… by Superior Healing. (Critical)" — AFTER the sentence period, so the old `\.$` anchor
// REJECTED all 233 of them and the model silently lost those heals (nine distinct spells,
// including the biggest single-hit heals in the log). The optional trailing group fixes that;
// a full-log sweep (2026-08-02) confirms `(Critical)` is the ONLY modifier a heal ever carries.
// Spell names contain no '.', so the lazy spell capture can never swallow the period.
//
// HEAL-OVER-TIME TICKS (2026-08-04). `<healer> healed <target> OVER TIME for N hit points by
// <Spell>.` is a real and common shape — 752 lines in the log across 12 distinct spells
// (Slugs Healing 191, Ethereal Cleansing 131, Echoing Light 78, …), 117 of them the player's
// own. The ` over time` sits between the target and the `for`, so the lazy target capture
// SWALLOWED it and every HoT tick was attributed to a phantom entity called
// "Primitive over time". It is now captured as its own optional group: the target is the real
// name again, and `overTime` reaches the model, where the cast-less proc detector needs it (a
// HoT tick is cast-DETACHED exactly the way a DoT tick is — see procDetect's DoT gate).
const HEAL_RE =
  /^(.+?) healed (.+?)( over time)? for (\d+)(?: \((\d+)\))? hit points?(?: by (.+?))?\.(?: \(([A-Za-z][A-Za-z ]*)\))?$/

// ----- Mend (JOS-86): a heal the log ANNOUNCES but never VALUES -----
// `You mend your wounds and heal some damage.` — the monk skill, 876 lines whole-log, and the
// only mechanical Mend shape there is (the full partition of all 1,178 "mend" lines is written
// out above HealUnstatedEvent in shared/logEvents.ts). It carries no number and no target, so it
// yields a `healUnstated` event rather than a `heal` with a fabricated 0 — see that type's header
// for why the absence is structural instead of a flag.
//
// ANCHORED WHOLE, deliberately. The sentence is a fixed string with no captures, so the regex
// asserts the entire line rather than sniffing for the word "mend": `a Nisch Mas Mender healed
// itself for 154 hit points by Symbol of Ryltan.` is a mob's name and belongs to the heal family,
// and the 99 chat lines that discuss the skill must never reach the ledger.
const MEND_RE = /^You mend your wounds and heal some damage\.$/
/** The skill behind MEND_RE. Named here so the ledger lane and the parser can never disagree. */
const MEND_SKILL = 'Mend'

// ----- absorption / mitigation (Task #59) — damage PREVENTED, never hit points restored -----
// Three VERIFIED self-form families (see MitigationEvent in shared/logEvents.ts for the counts):
//   `You gain a rune for 12 points of absorption.`                       → 'rune' (has an amount)
//   `<mob> tries to bash YOU, but YOUR magical skin absorbs the blow!`   → 'absorbSwing' (COUNT)
//        …but as of the MISS_RE self-absorb fix this shape is claimed by the MISS family
//        instead (miss, mtype 'absorb', target 'You'); see the note below RUNE_GAIN_RE.
//   `YOUR magical skin absorbs the damage of <mob>'s thorns.`            → 'absorbDamageShield'
// The blow form is matched ONLY AFTER MISS_RE has been given the line (see classify). That fix
// HAS NOW LANDED: MISS_RE learned the bare-`YOUR` alternative, so every real absorbed swing is a
// `miss` event with mtype 'absorb' and target 'You', and this branch no longer fires for any shape
// present in the log. It is kept as the safety net for the one shape MISS_RE still declines — a
// COMPOUND trailing modifier (`! (Riposte Slay Undead)`), which MISS_RE's single-word
// `\([A-Za-z]+\)` tail rejects while this regex's `[A-Za-z ]+` accepts. No such line exists today
// (full-log sweep 2026-08-02: the miss family's only modifiers are the single words Riposte 4751,
// Rampage 92, Flurry 65 — compound modifiers appear on DAMAGE lines only). Either way a line yields
// EXACTLY ONE event, so the engine (which counts absorbed swings off both the mitigation path and
// incoming misses with mtype 'absorb') can never double-count.
const RUNE_GAIN_RE = /^You gain a rune for (\d+) points? of absorption\.$/
const SKIN_ABSORB_BLOW_RE =
  /^(.+?) tr(?:y|ies) to \w+ (?:on )?YOU, but YOUR magical skin absorbs the blow!(?: \([A-Za-z ]+\))?$/
const SKIN_ABSORB_DS_RE = /^YOUR magical skin absorbs the damage of (.+?)'s .+\.$/

// ----- miss (NEW): "<A> tr(y|ies) to <verb> <B>, but <outcome>!" -----
// Outcome disambiguates the miss type:
//   miss!/misses!                        → 'miss' (self uses base, 3rd person -es)
//   <defender> parries/dodges/ripostes/blocks!   → defender-named, 3rd person verb
//   YOU parry/dodge/riposte/block!               → defender = you, base verb
//   <name>'s magical skin absorbs the blow!      → 'absorb', defender = <name>
//   YOUR magical skin absorbs the blow!          → 'absorb', defender = You
// An optional trailing swing modifier " (Riposte)"/"(Flurry)"/"(Rampage)" may
// follow the "!" — allowed and discarded.
//
// SELF RUNE ABSORB (bug fix, verified against the real log 2026-08-02): the absorb
// alternative used to require a POSSESSIVE `<name>'s magical skin`, so the SELF form —
// `A deadly black widow tries to bite YOU, but YOUR magical skin absorbs the blow!` —
// never produced a MISS event. (It fell through to 'unknown' originally; Task #59 then
// caught it downstream as a `mitigation` event, which fixed the absorption COUNT but left
// the miss aggregate just as blind, since a mitigation event never reaches routeMiss.)
// Full-log sweep: 385 bare-`YOUR` lines vs 1,428 possessive lines that parsed fine. Every
// dropped line is an INCOMING avoided swing, so the loss was a pure undercount in the
// engine's incoming miss aggregates (addIncMiss) and therefore in defensive hit% /
// avoidance — no damage total moved (a miss carries no amount, law 8).
// The two absorb shapes are DISJOINT (`.+?'s ` needs a literal apostrophe-s that the
// `YOUR` form does not have), so the added alternative can never steal a possessive line.
// The self branch names NO defender — group 2 is the swing's object — so it supplies one
// itself: YOUR skin means the swing was at YOU (see classify()). Observed shapes are all
// third-person `<mob> tries to <verb> YOU, …`, with `(Riposte)` the only modifier (34×).
//
// PREPOSITIONAL VERBS (Task #58): a few melee verbs take an object preposition —
// "You try to frenzy ON a deadly black widow, but miss!" — and the bare `\w+ (.+?)`
// capture swallowed it, so the miss carried the target "on a deadly black widow"
// while the LANDED form ("You frenzy on X for N points…") parsed clean. That leaked a
// phantom "on <mob>" defender into every per-mob view. The optional `(?:on )?` is
// greedy, so it is consumed whenever present and skipped otherwise.
// VERIFIED against the real log (full sweep, 2026-08-02): of the 26 distinct verbs in the
// "tr(y|ies) to <verb>" family, `frenzy` is the ONLY one that takes a preposition
// (1,012 lines, all "on"); no other verb is ever followed by on/at/with/upon/into, and no
// mob name begins with the word "on", so the strip cannot eat part of a real name.
const MISS_RE = new RegExp(
  '^(.+?) tr(?:y|ies) to \\w+ (?:on )?(.+?), but ' +
    '(?:(miss|misses)' + // 3: plain miss (self/3rd person)
    '|(.+?) (parries|dodges|ripostes|blocks)' + // 4:defender 5:3rd-person verb
    '|(YOU) (parry|dodge|riposte|block)' + // 6:YOU 7:base verb
    "|.+?'s magical skin (absorbs) the blow" + // 8: absorb, possessive (defender NAMED)
    '|(YOUR) magical skin absorbs the blow)' + // 9: absorb, SELF (defender is You)
    '!(?: \\([A-Za-z]+\\))?$'
)

// ----- spell resist (NEW, Task #51 timeline v2) -----
// A detrimental spell fully resisted — the caster-side analogue of a melee miss.
// VERIFIED shapes (full-log sweep, 2026-08-02):
//   "<target> resisted your <Spell>!"          → you cast it (caster = 'you')
//   "<target> resisted <caster>'s <Spell>!"    → a named caster (pet or mob)
//   "You resist[ed] <caster>'s <Spell>!"       → INCOMING, you resisted a mob's spell
// The spell may carry a trailing rank ("Mesmerization III"); we keep the display form and
// let the engine rank-normalize. NB the "your" and "<caster>'s" forms OVERLAP when the
// spell name itself contains "'s" (e.g. "Denon's Disruptive Discord"), so we test the
// possessive-YOUR form FIRST and only then the named-caster form (712 such lines in the
// real log). The incoming "You resist" form is tested before either outgoing form.
// The gate below also excludes the "…unresistable damage…" line family (a damage line).
const RESIST_YOURS_RE = /^(.+?) resisted your (.+?)!$/
const RESIST_CASTER_RE = /^(.+?) resisted (.+?)'s (.+?)!$/
const RESIST_INCOMING_RE = /^You resist(?:ed)? (.+?)'s (.+?)!$/

/**
 * The BASE (first-person) form of every verb MELEE_VERBS spells out. Kept as its own set
 * rather than derived from that alternation, because the alternation is deliberately written
 * long-hand (see its comment) and must stay readable; `tests/specialAttackWindows.test.mts` pins the
 * two against each other, so a verb added to one and forgotten in the other fails a test rather
 * than silently un-naming a lane.
 */
const MELEE_VERB_BASES = new Set([
  'hit', 'slash', 'pierce', 'crush', 'bash', 'kick', 'bite', 'claw', 'gore', 'maul', 'punch',
  'strike', 'slice', 'backstab', 'slam', 'sting', 'rend', 'smash', 'gnaw', 'lash', 'smite',
  'cleave', 'reave', 'shoot', 'frenzy', 'flurry'
])

/**
 * Un-conjugate a matched melee verb to its base form ('slashes' → 'slash', 'crushes' → 'crush',
 * 'frenzies on' → 'frenzy'). The suffix rules are tried longest-first and each is CONFIRMED
 * against the base set before it is accepted, so `slices` cannot become `slic` — the `-es` rule
 * declines it and the `-s` rule answers `slice`. An unrecognized word is returned unchanged
 * rather than mangled (law 1: never invent).
 */
export function meleeVerbBase(verb: string): string {
  const v = verb.toLowerCase()
  // The two prepositional/irregular pairs ("frenzies on"/"frenzy on", "flurries"/"flurry").
  if (v.startsWith('frenz')) return 'frenzy'
  if (v.startsWith('flurr')) return 'flurry'
  if (MELEE_VERB_BASES.has(v)) return v
  if (v.endsWith('es') && MELEE_VERB_BASES.has(v.slice(0, -2))) return v.slice(0, -2)
  if (v.endsWith('s') && MELEE_VERB_BASES.has(v.slice(0, -1))) return v.slice(0, -1)
  return v
}

/**
 * The lane name a melee VERB damages under. Exported so an avoided swing can be laned the same
 * way a landed one is (`routeMiss` → the round grouper's lane label): one derivation, so a miss
 * can never disagree with the hit it accompanied about what skill was swung.
 *
 * THE RULE IS "A NAMED CLASS SKILL, NOT A WEAPON SWING". `slash`/`pierce`/`crush`/`hit` and the
 * rest are what a weapon in a hand prints, and four of them are one auto-attack lane — so they
 * share the generic name and the Rounds panel splits them by verb instead. A verb that names an
 * ABILITY the class list grants gets its own row, because a player who pressed a button wants to
 * see what it did. Each entry below is evidence-verified against `src/main/data/classes.json`'s
 * skill→class table (Backstab ROG, Bash PAL/SHD/WAR, Kick BST/MNK/RNG/WAR, Frenzy BER,
 * Cleave WAR, Smite PAL) — never a matcher over verb spelling, which would happily promote
 * `slice`.
 *
 * CLEAVE (JOS-77, user report 01KZCZ3BYRQRD4JQJ0PW7FQRG5 — "the combat parser does not appear
 * to capture cleave, or at a minimum it's not split out like Frenzy, Bash and Kick are"). The
 * damage was never missing: `cleave` has been in MELEE_VERBS since the missing-verbs fix, and
 * the reporter's own 30-minute slice folds all 171 of his cleave hits into the generic lane.
 * The ROW could not exist — the same shape as the Dragon Punch report, one lane over.
 * MEASURED, and this is what makes it a skill rather than a damage tier of some weapon verb:
 * `Cleave` is WAR-only at level 5 in the class table, and the owner's own 1.4M-line log — 71k
 * `You slash` lines up to 2,100 damage, 11k `You crush` — contains ZERO self cleaves, while it
 * carries 20,334 INCOMING ones from mobs. A verb that never once prints for a player who lacks
 * the skill, however hard he swings, is gated on the skill and not on the damage.
 *
 * SMITE (JOS-81 — cleave's twin, closing the gap this comment used to describe). `Smite` is a
 * PAL-only innate at level 9 in the class table, and the owner IS a paladin, so unlike cleave
 * the evidence is his own swings: 13,984 `You smite` lines and 1,223 third-person ones (all of
 * them other players' — Lizgar and friends), every one of them reading "Melee" until now.
 * WHAT PROVES IT IS A SKILL AND NOT A WEAPON VERB is the skill-up stream, and it is decisive:
 * `You have become better at Smite!` ticks 280 times, whereas a weapon verb NEVER ticks under
 * its own name — a slash ticks `1H Slashing`, a crush `1H Blunt`, a pierce `1H Piercing`, a
 * punch `Hand to Hand` (whole-log enumeration of all 56 skill-up names, 2026-08-06). Smite ticks
 * beside Kick, Bash, Backstab and Frenzy, which is exactly the company this table keeps.
 *
 * THE SKILL LANE AND THE SPELL LANE SHARE A STEM AND MUST NEVER MERGE. `Smiting Strike` is the
 * paladin's proc — `You hit <mob> for 259 points of magic damage by Smiting Strike.`, 15,016
 * lines — and it is a SPELL: it comes in on the `by <Spell>` path, carries no melee verb at all
 * (`verb` is undefined by construction), lands in the `spell` category and has always had its
 * own named row. This function never sees it. The two are one second apart in the log and one
 * letter apart in the eye; "Smite" is the melee verb only.
 *
 * ── RANGED (JOS-92), AND IT IS *NOT* THE CLEAVE/SMITE ARGUMENT ───────────────────────────────
 *
 * A ranger's report: "Could you split Ranged (bow) into another field separate from Melee? I
 * would love to see DPS differences between my dual wield melees and my bow … stance switching
 * Ranger/Ranged stance uses bow in melee. currently that is lumped into the same bar as melee."
 * Same SHAPE as cleave and smite — `shoot` has been in MELEE_VERBS since the missing-verbs fix,
 * so bow damage was always COUNTED, and `meleeSkill('shoot')` answered "Melee", so the ROW could
 * not exist — but a DIFFERENT justification, and the difference has to be stated rather than
 * borrowed, because the borrowed one is false.
 *
 * THE SKILL-UP TEST THAT PROVED SMITE *REFUSES* THIS LANE. JOS-81 decided the question with the
 * skill-up stream: a weapon verb never ticks under its own name (a slash ticks `1H Slashing`, a
 * crush `1H Blunt`, a punch `Hand to Hand`), while `Smite` ticks 280 times under `Smite`. Run
 * that same test on `shoot` and it comes back a WEAPON verb: there is no `better at Shoot!` line
 * anywhere, `shoot` ticks under `Archery`, and `Archery` sits squarely in the weapon-type family
 * beside 1H Slashing / 2H Slashing / 1H Blunt / 1H Piercing / Hand to Hand. By JOS-81's test
 * alone, `shoot` belongs in the generic row. So this lane does not rest on that test.
 *
 * IT RESTS ON THE CLAUSE JOS-77 ALREADY WROTE DOWN AND NEVER HAD TO USE. The reason
 * slash/pierce/crush/hit share one anonymous row is not "weapon verbs never get rows" — it is
 * that those four "are what a weapon IN A HAND prints, and four of them are ONE auto-attack
 * lane". A bow is not in that lane. It is fired from a different equipment slot, under a
 * different skill, and none of the hand lane's multipliers reach it (Dual Wield 322 skill-ups,
 * Double Attack 395, Triple Attack 100 — all of them about swings from hands). The game states
 * the mode change itself, in the reporter's own words and its own: `You assume a ranged stance.`
 * — which is where this lane takes its NAME from, rather than from a skill table.
 *
 * So the rule gains a second clause, and it is narrow: a weapon verb that fires from a DIFFERENT
 * SLOT than the hands is not the hand lane, however weapon-shaped its skill is. `shoot` is the
 * ONLY verb in MELEE_VERBS that qualifies. No thrown lane is invented beside it, because the log
 * has never printed one: `You throw` is ZERO whole-log and ` throws ` is ZERO, `Throwing` occurs
 * only inside item names (`Throwing Boulder` ×143), and there is no `better at Throwing!` tick.
 * A lane the log has not demonstrated does not get written from grammar (the awaiting-sample law).
 *
 * THE LANE IS DRIVEN BY THE MESSAGE FORM AND NOTHING ELSE — no class guessing, which matters
 * doubly here because the reporter is a ranger who STANCE-SWITCHES: his bow and his dual wield
 * land in the same fight, seconds apart, so a class-keyed or stance-keyed split would mis-assign
 * both. The verb is the whole discriminator, and a whole-log sweep of all nine `shoots` damage
 * lines confirms nothing else in the line could serve: they are shape-identical to melee
 * (`<A> shoots <B> for N point(s) of damage.`) and the ONLY trailing annotation the family has
 * ever carried is `(Critical)` — there is no `(Double Bow Shot)` line in the file (AGENTS.md
 * listed that annotation as unobserved and it still is).
 *
 * THE OWNER HAS NEVER FIRED A BOW, so this lane is EMPTY in every committed fixture and in all
 * three of his logs: `You shoot` is ZERO in 1,438,942 lines, and `You have become better at
 * Archery!` ticks exactly ONCE. That is the law-8 statement in its strongest form — not one
 * existing figure can move, because there is no self `shoot` line anywhere to move it. What the
 * log DOES carry is nine third-person bow hits and eight avoided ones from other players, which
 * is what `w57-ranged-lane.log` and `w58-ranged-critical.log` pin (tests/combatRangedLane.test.mts).
 *
 * ── AND THE LANE THAT DOES *NOT* BELONG IN THIS FUNCTION AT ALL (JOS-102) ────────────────────
 *
 * Tail Rake — user report 01KZGADDMWEGAVPX9V95F8H4Y2, "missing from the DPS overview" — reads
 * like the next branch to add here, and it is not one. It is a monk SKILL and it is MNK-only at
 * level 25 in the class table, so it passes JOS-77's test on paper; the reason it gets no branch
 * is that THE GAME NEVER PRINTS IT AS A VERB. `tail rake` is ZERO in all three owner logs and in
 * every committed fixture, because upgraded specials in EQ Legends land as a generic verb and
 * are named only by the state line (`You will now use Tail Rake instead of Eagle Strike while
 * attacking.`) — exactly like Dragon Punch, whose seat in the `strike` chain Tail Rake shares as
 * the Iksar variant. It is therefore handled by `src/main/combat/specialAttacks.ts`, which holds
 * the evidence, and adding a `tail rake` alternation to MELEE_VERBS would invent a message shape
 * no log has ever printed (the awaiting-sample law).
 *
 * The distinction this function draws is between a WEAPON verb and a SKILL verb. The one above
 * is prior to it: a skill that prints no verb of its own is not this function's business, however
 * plainly it is a skill.
 *
 * ── STRIKE (JOS-163), THE FLOOR UNDER THAT LANE — A VERB'S ROW, NOT A SPECIAL'S NAME ─────────
 *
 * A monk on 0.16.0: strikes lumped into Melee while his kicks show up fine. Confirmed, and it is
 * the OTHER HALF of the Dragon Punch fix rather than a regression of it. `strike` had no branch
 * here, so the ONLY thing that could ever name a strike was the stateful rename in
 * src/main/combat/specialAttacks.ts — and that state has exactly one source, the
 * `You will now use <X> …` line the game prints ONCE, at the level-up. A player whose current log
 * file postdates that level-up (fresh install, log rotation, `/log on` switched on later) never
 * has the line: 100% of his strikes read "Melee", permanently, with no way to earn the row back.
 * The loadout-swap re-announce burst does not include the strike lane (see
 * tests/fixtures/w48-special-lane-reset.log — six state lines, none of them a strike), and an
 * epoch reset wipes the lane with nothing to re-seed it from. v0.5.0 fixed the case where the
 * state line EXISTS; this branch is every other case.
 *
 * WHAT IT CLAIMS IS EXACTLY WHAT THE VERB PROVES, AND NOT ONE WORD MORE. It labels the lane
 * "Strike" — the verb, neutrally — and never a name from the chain. Seeding the row with
 * `Tiger Claw` is the guess specialAttacks.ts refuses by design (its header, "PRE-STATE IS HONEST
 * BY OMISSION"), because a strike is a Tiger Claw, an Eagle Strike, a Dragon Punch or an Iksar's
 * Tail Rake and the log has not said which. "Strike" asserts only what the damage line itself
 * printed, which is the same standing every other row in this table has.
 *
 * THE EVIDENCE IS ALREADY WRITTEN DOWN, and it is the exclusivity proof specialAttacks.ts won on
 * the owner's own bytes: `strike` is EXCLUSIVE to the special-attack chain. His first-ever
 * `You strike …` is three seconds after `You will now use Tiger Claw while auto attacking.`, after
 * nine days and hundreds of thousands of swings without one; a base unarmed attack prints
 * `hit`/`claw`/`punch` instead (Hand to Hand skill-ups sit on those three). So an unnamed strike
 * is not an ordinary weapon swing that wandered in — it is a special whose NAME is unknown, and
 * pooling it with slash/crush/hit was the miscategorization. That also makes this the one lane in
 * this table justified by neither JOS-77's class-skill test nor JOS-92's equipment-slot test: the
 * verb earns its row because it is a special-attack verb, and the row it earns is anonymous
 * precisely because the special is.
 *
 * THE STATE LINE STILL WINS WHEN IT EXISTS. `nameSpecialLane` (combat/ingest.ts) and `missFold`
 * (combat/routing.ts) both consult `specials.laneSkill(verb)` FIRST and fall through to this
 * function, so a log that carries the grant reads "Dragon Punch" exactly as it did before — this
 * branch only changes what an UNCLAIMED lane is called. Nothing is seeded from the table and no
 * skill-up is read (specialAttacks.ts's stated law): "Strike" is the floor, the state line is the
 * upgrade.
 *
 * AND IT IS PERSON-AGNOSTIC, like every other branch here. A mob's `strikes` reads "Strike" too,
 * for the same reason its `kicks` has always read "Kick": the verb is the whole discriminator and
 * this function has never known who swung. The stateful rename above it stays first-person-only.
 */
export function meleeSkill(verb: string): string {
  const v = verb.toLowerCase()
  if (v.startsWith('backstab')) return 'Backstab'
  if (v.startsWith('bash')) return 'Bash'
  if (v.startsWith('kick')) return 'Kick'
  if (v.startsWith('cleav')) return 'Cleave'
  if (v.startsWith('smite')) return 'Smite'
  if (v.startsWith('shoot')) return 'Ranged'
  if (v.startsWith('strike')) return 'Strike'
  if (v.startsWith('frenz')) return 'Frenzy'
  if (v.startsWith('flurr')) return 'Flurry'
  return 'Melee'
}

function dmg(
  { ts, seq, raw }: ClassifyCtx,
  spec: { attacker: string | null; target: string; amount: number; dtype: DamageType; skill: string; crit: boolean }
): LogEvent {
  // DS lines carry no paren modifier; category maps 1:1 from dtype (never 'slay').
  const { attacker, target, amount, dtype, skill, crit } = spec
  return { kind: 'damage', seq, ts, raw, attacker, target, amount, dtype, skill, crit, category: damageCategory(dtype, []) }
}

/**
 * Resolve a MISS_RE match into its miss type + defender.
 * Groups: 1=attacker 2=verb-object 3=miss|misses 4=defender 5=3rd-verb
 *         6=YOU 7=base-verb 8=absorbs(possessive) 9=YOUR(self)
 */
function missOutcome(m: RegExpExecArray): { mtype: MissType; target: string } {
  if (m[3]) return { mtype: 'miss', target: norm(m[2]) }
  if (m[5]) {
    const mtype: MissType =
      m[5] === 'parries' ? 'parry' : m[5] === 'dodges' ? 'dodge' : m[5] === 'ripostes' ? 'riposte' : 'block'
    return { mtype, target: norm(m[4]) }
  }
  // parry|dodge|riposte|block (base form == MissType)
  if (m[7]) return { mtype: m[7] as MissType, target: 'You' }
  if (m[9]) {
    // SELF rune absorb ("… but YOUR magical skin absorbs the blow!"). This branch names
    // no defender — group 2 is only the swing's OBJECT — so the defender comes from the
    // branch itself: it is YOUR skin, so the swing was aimed at You. (The object capture
    // does read "YOU" on every observed line, but the branch is the authority: `YOUR
    // magical skin` can only ever describe the player, whatever the object text says.)
    return { mtype: 'absorb', target: 'You' }
  }
  // Possessive absorb ("… but <B>'s magical skin absorbs the blow!") — a MOB's own rune
  // eating our swing. The defender is the swing's object, exactly as before.
  return { mtype: 'absorb', target: norm(m[2]) }
}

/**
 * The swing VERB and the trailing paren annotation of a miss line, read as two small
 * side-extractions rather than as new capture groups (attack-round stats).
 *
 * MISS_RE's nine groups are positional and `missOutcome` indexes them by number, so widening
 * that alternation to capture the verb would renumber every branch — a change with no upside
 * over two anchored one-liners that only run on a line MISS_RE has already claimed. The verb
 * is un-conjugated through the same `meleeVerbBase` the damage path uses, so `You try to
 * slash` and `slashes` land on one lane. The tail is single-word by construction (MISS_RE
 * itself only admits `\([A-Za-z]+\)`), which matches the log: (Riposte), (Flurry), (Rampage)
 * are the only annotations a miss line has ever carried.
 */
const MISS_VERB_RE = / tr(?:y|ies) to (\w+)/
const MISS_MOD_RE = / \(([A-Za-z]+)\)$/

function missAnnotations(text: string): { verb?: string; modifiers?: string[] } {
  const v = MISS_VERB_RE.exec(text)
  const mod = MISS_MOD_RE.exec(text)
  return {
    ...(v ? { verb: meleeVerbBase(v[1]) } : {}),
    ...(mod ? { modifiers: parseModifiers(mod[1]) } : {})
  }
}

/** Misses / avoided swings (by far the most common combat line). */
export function classifyMiss({ text, ts, seq, raw }: ClassifyCtx): LogEvent | null {
  if (text.includes(', but ') && (text.startsWith('You try to ') || text.includes(' tries to '))) {
    const m = MISS_RE.exec(text)
    if (m) {
      const attacker = norm(m[1])
      const { mtype, target } = missOutcome(m)
      return { kind: 'miss', seq, ts, raw, attacker, target, mtype, ...missAnnotations(text) }
    }
    // MISS_RE declined the line. It now OWNS the self rune-absorb form ("… but YOUR magical skin
    // absorbs the blow!") — every shape in the real log parses as a miss with mtype 'absorb' — so
    // this stays purely as the downstream safety net for a compound trailing modifier MISS_RE's
    // single-word tail rejects. Whichever regex claims the line, exactly ONE event is emitted.
    const a = SKIN_ABSORB_BLOW_RE.exec(text)
    if (a) return { kind: 'mitigation', seq, ts, raw, mtype: 'absorbSwing', source: norm(a[1]) }
  }
  return null
}

/**
 * Absorption / mitigation (Task #59): rune grants + absorbed damage-shield ticks.
 * Checked BEFORE the damage battery: the rune line contains "points of", which is that
 * battery's gate, and it must never be mistaken for a damage line.
 */
export function classifyMitigation({ text, ts, seq, raw }: ClassifyCtx): LogEvent | null {
  if (text.startsWith('You gain a rune for ')) {
    const m = RUNE_GAIN_RE.exec(text)
    if (m) return { kind: 'mitigation', seq, ts, raw, mtype: 'rune', amount: Number(m[1]) }
  }
  if (text.startsWith('YOUR magical skin absorbs the damage of ')) {
    const m = SKIN_ABSORB_DS_RE.exec(text)
    if (m) return { kind: 'mitigation', seq, ts, raw, mtype: 'absorbDamageShield', source: norm(m[1]) }
  }
  return null
}

/**
 * Spell resists (NEW, Task #51 timeline v2) — the caster-side "miss".
 * Gate: the word "resist" is present AND this is a resist EMOTE line (not a
 * "…unresistable damage…" damage line, which carries "points of" and is handled by
 * the damage battery below). Every real resist emote line ends in "!" and contains
 * "resisted"/"resist". Check the incoming "You resist…" form first, then the
 * possessive-"your" outgoing form (BEFORE the named-caster form, because a spell name
 * may itself contain "'s" — e.g. "Denon's Disruptive Discord").
 */
export function classifyResist({ text, ts, seq, raw }: ClassifyCtx): LogEvent | null {
  if (text.includes('resist') && !text.includes('points of') && text.endsWith('!')) {
    if (text.startsWith('You resist')) {
      const m = RESIST_INCOMING_RE.exec(text)
      if (m) return { kind: 'resist', seq, ts, raw, caster: norm(m[1]), target: 'You', spell: m[2].trim(), incoming: true }
    } else {
      let m = RESIST_YOURS_RE.exec(text)
      if (m) return { kind: 'resist', seq, ts, raw, caster: 'you', target: norm(m[1]), spell: m[2].trim(), incoming: false }
      m = RESIST_CASTER_RE.exec(text)
      if (m) return { kind: 'resist', seq, ts, raw, caster: norm(m[2]), target: norm(m[1]), spell: m[3].trim(), incoming: false }
    }
  }
  return null
}

/** The "points of damage" half of the damage battery: damage shield, spell nuke, melee. */
function pointsDamage(c: ClassifyCtx): LogEvent | null {
  const { text, ts, seq, raw } = c
  // Damage shield out: "<B> is <verb> by (YOUR|<owner>'s) <element> for N points of non-melee damage."
  let m = DS_RE.exec(text)
  if (m) {
    const owner = m[2] === 'YOUR' ? 'You' : norm(m[2].replace(/'s$/, ''))
    return dmg(c, { attacker: owner, target: norm(m[1]), amount: Number(m[4]), dtype: 'ds', skill: m[3].trim(), crit: false })
  }
  // Incoming DS on you.
  m = DS_INC_RE.exec(text)
  if (m) {
    return dmg(c, { attacker: norm(m[1]), target: 'You', amount: Number(m[3]), dtype: 'ds', skill: m[2].trim(), crit: false })
  }
  // Typed spell nuke.
  m = SPELL_RE.exec(text)
  if (m) {
    const modifier = m[6]
    const mods = parseModifiers(modifier)
    return {
      kind: 'damage', seq, ts, raw,
      attacker: norm(m[1]), target: norm(m[2]), amount: Number(m[3]),
      dtype: 'spell', dclass: m[4], skill: m[5].trim(),
      crit: hasCritical(mods), modifier, modifiers: mods, category: damageCategory('spell', mods)
    }
  }
  // Melee.
  m = MELEE_RE.exec(text)
  if (m) {
    const verbM = MELEE_VERB_RE.exec(text)
    const modifier = m[4]
    const mods = parseModifiers(modifier)
    // The un-conjugated verb rides along on melee lines ONLY (see DamageEventE.verb): it is the
    // join key between a swing and the special attack the log said was active, and `skill` is
    // many-to-one so it cannot serve. Purely additive — nothing here reads it.
    const verb = meleeVerbBase(verbM ? verbM[1] : 'hit')
    return {
      kind: 'damage', seq, ts, raw,
      attacker: norm(m[1]), target: norm(m[2]), amount: Number(m[3]),
      dtype: 'melee', skill: meleeSkill(verb), verb,
      crit: hasCritical(mods), modifier, modifiers: mods, category: damageCategory('melee', mods)
    }
  }
  return null
}

/** The "has taken N damage" half of the damage battery: DoTs, with and without a caster. */
function takenDamage({ text, ts, seq, raw }: ClassifyCtx): LogEvent | null {
  // DoT with a caster: "<B> has taken N damage from your <Spell>." | "… from <Spell> by <caster>."
  let m = DOT_RE.exec(text)
  if (m) {
    const target = norm(m[1])
    const amount = Number(m[2])
    const rest = m[3]
    const crit = /critical/i.test(m[4] ?? '')
    let attacker: string | null = null
    let skill = rest
    if (/^your /i.test(rest)) {
      attacker = 'You'
      skill = rest.replace(/^your /i, '')
    } else {
      const by = / by (.+)$/.exec(rest)
      if (by) {
        attacker = norm(by[1])
        skill = rest.slice(0, by.index)
      }
    }
    // "from <Spell>" with no "by <caster>" and not "your" → someone else's DoT
    // whose caster the game didn't name; fall through to the caster-less form.
    if (attacker !== null) {
      const mods = parseModifiers(m[4])
      return { kind: 'damage', seq, ts, raw, attacker, target, amount, dtype: 'dot', skill: skill.trim(), crit, modifier: m[4], modifiers: mods, category: 'dot' }
    }
  }
  // Caster-less DoT: "<B> has taken N damage by <Spell>." → attacker:null.
  m = DOT_NOCASTER_RE.exec(text)
  if (m) {
    const crit = /critical/i.test(m[4] ?? '')
    const mods = parseModifiers(m[4])
    return { kind: 'damage', seq, ts, raw, attacker: null, target: norm(m[1]), amount: Number(m[2]), dtype: 'dot', skill: m[3].trim(), crit, modifier: m[4], modifiers: mods, category: 'dot' }
  }
  return null
}

/**
 * Damage: melee / spell / dot / damage-shield.
 * Gate on the shared damage substrings so non-combat lines skip the battery.
 * Both plural ("50 points of") and singular ("1 point of") forms count — the
 * old looksCombat pre-filter only checked "points of" and silently dropped
 * every 1-damage swing; the underlying regexes always handled `points?`.
 */
export function classifyDamage(c: ClassifyCtx): LogEvent | null {
  const { text } = c
  const hasPoints = text.includes('points of') || text.includes('point of')
  const hasTaken = text.includes('has taken')
  if (hasPoints) {
    const ev = pointsDamage(c)
    if (ev) return ev
  }
  if (hasTaken) {
    const ev = takenDamage(c)
    if (ev) return ev
  }
  return null
}

/** Heals (NEW), plus the one heal family that states no amount (JOS-86). */
export function classifyHeal({ text, ts, seq, raw }: ClassifyCtx): LogEvent | null {
  // Cheapest discriminator first, and it is disjoint from ' healed ' by construction — the mend
  // sentence contains "heal some damage", never the past participle the HEAL_RE family uses.
  if (text.startsWith('You mend') && MEND_RE.test(text)) {
    return { kind: 'healUnstated', seq, ts, raw, skill: MEND_SKILL, target: 'You' }
  }
  if (text.includes(' healed ')) {
    const m = HEAL_RE.exec(text)
    if (m) {
      const healer = norm(m[1])
      // "<X> healed itself/himself/herself/themselves" → target is the healer.
      const tRaw = m[2].trim()
      const reflexive = /^(itself|himself|herself|themselves)$/i.test(tRaw)
      return {
        kind: 'heal', seq, ts, raw,
        target: reflexive ? healer : norm(tRaw),
        amount: Number(m[4]),
        rawAmount: m[5] ? Number(m[5]) : undefined,
        spell: m[6]?.trim() || undefined,
        healer,
        crit: /critical/i.test(m[7] ?? ''),
        ...(m[3] ? { overTime: true } : {})
      }
    }
  }
  return null
}
