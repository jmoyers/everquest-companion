// The single parse pass. `parseEvent(raw, seq)` turns one raw log line into a
// canonical LogEvent (or null when the line isn't a timestamped log line at all).
//
// This ABSORBS both former regex batteries — the content matchers that lived in
// parse.ts (loot/zone/kill/offer/trade/level/AA) and the combat matchers from
// combat/parse.ts (melee/spell/dot/ds/charm/uncharm/death/zone) — plus the two
// NEW parse-only families (heal, miss). It preserves every documented fix (verb
// conjugations, incoming-DS variant, charm-spell stems, AA improved format,
// singular/plural points, caster-less DoT → attacker:null).
//
// PERF: a full 68MB replay must stay ~seconds. The old scan ran cheap substring
// pre-filters before the regex battery; that logic now lives INSIDE parseEvent as
// an implementation detail (no caller-visible pre-filters). The hot path for the
// overwhelming majority of lines — misses and avoided swings — is gated by a
// single `includes(', but ')` check before any regex runs, and the ubiquitous
// combat/heal/loot families are each guarded by a substring probe. Lines matching
// nothing return a shared UNKNOWN-shaped result cheaply.
//
// FACTORING: the line-shape cascade is split across four sibling modules by family
// (parseCombat / parseCasts / parseWorld, over parseCommon's shared context+names).
// The CASCADE ORDER below is SEMANTIC, not cosmetic — several families overlap on
// purpose and are disambiguated by which one is offered the line first (the resist
// family tests YOUR form before the named-caster form because 712 spell names
// contain `'s`; the spell-landing emote is matched LAST so it can never shadow a
// real family; item merges come after loot so an auto-merge-on-pickup stays one
// 'combined' loot event). NEVER reorder CLASSIFIERS.

import { DEFAULT_PROFILE } from '../../shared/profiles'
import type { LogEvent } from '../../shared/logEvents'
import { getParserConfig } from './rulesets'
import type { ClassifyCtx, Classifier } from './parseCommon'
import { classifyDamage, classifyHeal, classifyMiss, classifyMitigation, classifyResist } from './parseCombat'
import {
  classifyAaActivate,
  classifyCastLifecycle,
  classifyCcApply,
  classifyCcWake,
  classifyCharm,
  classifyDbBuff,
  classifyIllusionFade,
  classifyPetClaim,
  classifyAllyPetLeader,
  classifyPetLeader,
  classifyPetSay,
  classifyPoisonCoat,
  classifyPoisonProc,
  classifySpellEmote,
  classifySpellGems,
  classifyStance,
  classifyWornOff
} from './parseCasts'
import {
  classifyClassUnlock,
  classifyItemActivate,
  classifySelfWho,
  classifySkillUp,
  classifySpecialAttack
} from './parseWho'
import { classifyAcquire } from './parseAcquire'
import { classifyCamp, classifyOutputFile, classifySessionStart } from './parseSession'
import { classifyGroup } from './parseGroup'
import {
  classifyAa,
  classifyConsider,
  classifyDeath,
  classifyExp,
  classifyItemMerge,
  classifyLevel,
  classifyLoot,
  classifyAaPotion,
  classifyTurnIn,
  classifyZone
} from './parseWorld'

export { idKey, looksDamage, spellCanonKey } from './parseCommon'
export { TIER_LABELS, zoneTier } from './parseWorld'

// ----- line prefix + timestamp (unchanged from the old parse.ts) -----

/** Matches the EQ log prefix: "[Sat Aug 01 13:00:28 2026] message". */
const LINE_RE = /^\[(.+?)\]\s?(.*)$/

/**
 * Parse an EQ timestamp like "Sat Aug 01 13:00:28 2026" to epoch millis.
 * Reformatted to an ISO-ish string that Date can parse deterministically.
 */
export function parseEqTimestamp(stamp: string): number {
  // "Sat Aug 01 13:00:28 2026" -> "Aug 01 2026 13:00:28"
  const m = /^\w{3}\s+(\w{3})\s+(\d{1,2})\s+(\d{2}:\d{2}:\d{2})\s+(\d{4})$/.exec(stamp.trim())
  if (!m) {
    const t = Date.parse(stamp)
    return Number.isNaN(t) ? 0 : t
  }
  const [, mon, day, time, year] = m
  const t = Date.parse(`${mon} ${day} ${year} ${time}`)
  return Number.isNaN(t) ? 0 : t
}

// ----- the single pass -----

/**
 * The ordered line-shape cascade. Each entry is offered the line and either claims it
 * (returns its event) or declines (null). ORDER IS SEMANTIC — see the module header.
 * Ordering is cheap-discriminator-first: each family is gated by a substring probe on
 * the message text so the regex battery only runs for candidate lines. The huge
 * miss/avoid family is checked first (via a single `, but ` probe) and short-circuits,
 * since it dominates a real combat log by an order of magnitude.
 */
const CLASSIFIERS: readonly Classifier[] = [
  classifyMiss,
  classifyMitigation,
  classifyResist,
  classifyDamage,
  classifyHeal,
  classifyConsider,
  classifyCastLifecycle,
  classifyCharm,
  classifyWornOff,
  classifyCcApply,
  // …and the OTHER end of the same hold (JOS-180): `<mob> has been awakened by <name>.`, the one
  // line that says a mez ENDED EARLY rather than merely ended. All 1,518 occurrences in the real
  // log measured `{kind:'unknown'}` before this entry existed, so the position is for legibility
  // (beside the family it annotates) and not for disambiguation.
  classifyCcWake,
  classifyPetClaim,
  // …and the PUBLIC half of the same family, directly beneath it so the private/public split
  // is visible in the cascade itself (JOS-47). Cannot shadow anything: the six sentences it
  // matches were `{kind:'unknown'}` before it existed.
  classifyPetSay,
  // THE `/pet who leader` ANSWER (JOS-52) — the one public pet line that names its owner, so
  // the one that BINDS. Beneath classifyPetSay because it is the same broadcast channel and the
  // exception to that rule's whole point; the two cannot shadow each other (the six sentences
  // and "My leader is <X>." are disjoint), and this shape was `{kind:'unknown'}` before it
  // existed — the whole log holds exactly one line of it.
  classifyPetLeader,
  // …and the SAME sentence about somebody else (JOS-250). It MUST sit directly beneath the self
  // rule and never above it: the two differ only in whose name the second capture holds, so the
  // self rule has to be offered every line first or your own `/pet who leader` answer would parse
  // as a stranger's pet. It claims nothing the self rule claims, and the whole log holds zero
  // lines of its shape (the one occurrence of the family names the owner).
  classifyAllyPetLeader,
  classifyDeath,
  classifyZone,
  // SESSION frame (login / camp-out / camp-abort). Beside the zone rule because they answer
  // the same question one level up — zone says WHERE you are, these say WHETHER you are in
  // the world at all — and because a Welcome is always followed within 0–1 lines by a zone
  // line, so reading the pair adjacently is how the log itself reads. All three are EXACT
  // string matches on lines that were measured to be `{kind:'unknown'}` before they existed
  // (41 lines total), so they can neither shadow nor be shadowed by any other family; the
  // position is for legibility, not disambiguation.
  classifySessionStart,
  classifyCamp,
  // THE EXPORT RECEIPT (JOS-128) — `Outputfile Complete: <file>`. Beside the session frame
  // because it is the same level: the player operating the CLIENT, not the world. It is
  // anchored at the start of the message and gated on a leading `O`, and the whole log holds
  // exactly two lines of this shape, both previously `{kind:'unknown'}` — so like its three
  // neighbours it can neither shadow nor be shadowed, and the position is for legibility.
  classifyOutputFile,
  // WHO YOU ARE WITH (docs/plans/group-model.md §1) — beside the session frame for the same
  // reason those two are beside the zone rule: they are the frame around the world model, one
  // level up from its contents. Every shape it claims was MEASURED to be `{kind:'unknown'}`
  // before this entry existed (parseGroup.ts lists the ten with their counts), so like the
  // session family the position is for legibility, not disambiguation.
  classifyGroup,
  classifyLoot,
  classifyItemMerge,
  // EVERY OTHER WAY AN ITEM OR A COIN REACHES YOU (JOS-144, parseAcquire.ts) — coin off a
  // corpse, a merchant buy or sell, a destroy payout, a marketplace delivery, a tradeskill
  // combine. It sits directly beneath the two corpse families because it is the rest of the
  // same question, and BENEATH rather than above so a loot sentence is never offered to it
  // first. It cannot shadow anything regardless: a full-log replay measured all 5,002 lines it
  // claims as `{kind:'unknown'}` beforehand, and the histogram of the 46 pre-existing kinds is
  // byte-identical across the change.
  classifyAcquire,
  classifyTurnIn,
  classifyLevel,
  // Experience: gated on a `You gain ` prefix and END-anchored, so it can only ever claim the
  // four exp shapes — all of which produced `{kind:'unknown'}` before this entry existed. It
  // sits after classifyLevel because a ding prints the level line first and the exp line
  // second; neither can shadow the other, and this keeps the progression families adjacent.
  classifyExp,
  classifyAa,
  // The AA potion quaff, beside the AA economy it modifies. An EXACT string match on a line
  // that was MEASURED to be `{kind:'unknown'}` before it existed (all 32), so like its
  // session/skill-up neighbours the position is for legibility, not disambiguation.
  classifyAaPotion,
  classifyAaActivate,
  classifyStance,
  // WHAT IS IN YOUR GEMS (JOS-391) — memorize / forget / spell set. Beside the stance and
  // invocation rules because it is the same family of statement (the player operating their own
  // character sheet, not the world acting on them), and, like them, MEASURED to claim only lines
  // that were `{kind:'unknown'}` beforehand: all 4,321 begin, 4,285 finished, 4,232 forget and
  // 474 spell-set lines of the owner's 2,048,450-line log. So the position is legibility.
  classifySpellGems,
  // CLASS EVIDENCE (class-combo inference Wave 1). Both are gated on a substring probe and
  // both were MEASURED to claim only lines that previously produced `{kind:'unknown'}` (all
  // 421 /who rows, all 10,216 skill-ups). They sit beside the stance/invocation rule because
  // that is the same evidence family — what the character can DO tells you what it IS — and
  // ahead of the DB-driven buff matchers, which no /who or skill-up line can reach anyway.
  classifySelfWho,
  classifySkillUp,
  // THE ACTIVE SPECIAL ATTACK (`You will now use Dragon Punch instead of Eagle Strike while
  // attacking.`). Beside its two siblings for the same reason they are adjacent — all three are
  // statements about the CHARACTER — and, like them, MEASURED to claim only lines that were
  // `{kind:'unknown'}` before it existed (all 21).
  classifySpecialAttack,
  // WHAT THE CHARACTER IS ALLOWED TO BE (JOS-148) — the fourth statement-about-the-character,
  // beside the three above for that reason. Anchored on the full `You have completed
  // achievement: Primary Class Unlock - ` prefix and gated on the leading `Y`; a full-log sweep
  // measured all 155 lines of the achievement family as `{kind:'unknown'}` before it existed, so
  // like its neighbours it can neither shadow nor be shadowed and the position is legibility.
  classifyClassUnlock,
  classifyIllusionFade,
  classifyPoisonCoat,
  classifyPoisonProc,
  classifyDbBuff,
  // ITEM ACTIVATION (class-combo inference Wave 3) — `Your <item> shimmers briefly.` It sits
  // here, immediately before the permissive landing-emote matcher, for two reasons: the buff
  // fade / worn-off families own the other `Your …` shapes and are matched far earlier, and
  // the emote matcher WOULD otherwise claim 172 of these lines as a subject-"Your Idol of the
  // Underking" candidate (measured; the other 7,749 were `unknown`). Moving them here was
  // proven inert against a full-log BuffsModule replay.
  classifyItemActivate,
  classifySpellEmote
]

/**
 * Parse one raw log line into a canonical LogEvent, or null if it isn't a
 * timestamped log line. `seq` is stamped onto the event by the feeder.
 */
export function parseEvent(raw: string, seq: number, profileId: string = DEFAULT_PROFILE): LogEvent | null {
  const pm = LINE_RE.exec(raw)
  if (!pm) return null
  const ts = parseEqTimestamp(pm[1])
  const text = pm[2]
  const cfg = getParserConfig(profileId)
  return classify({ text, ts, seq, raw, cfg })
}

/**
 * A parsed log-line envelope (`ts`/`text`/`raw`) with no content classification.
 * Kept for the `log:line` IPC push, whose payload shape the renderer relies on.
 * Returns null when the line has no timestamp prefix.
 */
export function parseLine(raw: string): { ts: number; text: string; raw: string } | null {
  const m = LINE_RE.exec(raw)
  if (!m) return null
  return { ts: parseEqTimestamp(m[1]), text: m[2], raw }
}

function classify(c: ClassifyCtx): LogEvent {
  for (const match of CLASSIFIERS) {
    const ev = match(c)
    if (ev) return ev
  }
  return { kind: 'unknown', seq: c.seq, ts: c.ts, raw: c.raw }
}
