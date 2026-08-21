// Cast / buff / pet families of the parse cascade (see parser.ts for the ordered list):
// the cast lifecycle, charm + crowd control, targeted and targetless buff fades, pet
// ownership claims, stances + invocations, the illusion click-off, rogue poisons, the
// DB-gated message-driven buff events, and — matched LAST of all — spell-landing emotes.
// Every regex, table and comment here is verbatim from the single-pass parser.

import type { CcVerb, LogEvent, PetSayKind } from '../../shared/logEvents'
import { PET_LEADER_RE, PET_SAY_LINES, PET_SAY_RE } from '../../shared/logScrub'
import { isPlayerShapedName } from '../../shared/playerShape'
import type { PoisonProcDef } from '../../shared/poisons'
import { POISON_BY_COAT_MSG, POISON_DRY_MSG, POISON_PROCS } from '../../shared/poisons'
import { matchCastOnOtherSuffix } from '../data/spellDb'
import type { ParserConfig } from './rulesets'
import { idKey, norm, type ClassifyCtx } from './parseCommon'

const CHARM_RE = /^(.+?) has been charmed\.$/
const UNCHARM_RE = /^Your (.+?) spell has worn off of (.+?)\.$/
// Crowd-control APPLICATION (mez/root), NOT charm: "<mob> has been mesmerized." and
// siblings. Charm is handled separately (CHARM_RE); the DoT-application shapes
// (poisoned/diseased) and unrelated spell notices (smitten/overwritten) are NOT CC
// and are excluded. `ensnared` is a root (a hold), so it counts.
// The verb is CAPTURED since JOS-228: three of these four sentences describe a hold that damage
// breaks and one does not, and the model needs the word to tell a corpse it can explain from one
// it cannot (`CcEvent.verb` states the whole argument).
const CC_APPLY_RE = /^(.+?) has been (mesmerized|enthralled|entranced|ensnared)\.$/
// The CC BREAK ANNOTATION (JOS-180): "<mob> has been awakened by <name>." — one shape, measured
// over the whole log (1,518 occurrences, zero variants; `by` is the player 1,364 times, a group
// member or a mob for the rest). It was `{kind:'unknown'}` before this rule existed, so it can
// neither shadow nor be shadowed. Anchored end-to-end so the zone name `The Plane of Fear - Solo 1
// (Awakened)` and the mob tier suffix `(Awakened)` cannot reach it.
const CC_WAKE_RE = /^(.+?) has been awakened by (.+?)\.$/
// Pet-ownership claim (direct tell). Two phrasings, both pet-only in the real log:
//   "<Name> told you, 'Attacking <target> Master.'"
//   "<Name> told you, 'I am unable to wake <mob>, Master.'"
// The direct-tell channel ("told you") ends in "Master.'" ONLY for pets — a full
// scan found zero player false positives (players use "tells General1:1", not a
// direct tell ending in ", Master.'"). We match these two exact suffixes rather
// than a loose "…Master.'" to stay conservative. Captures the pet's name.
const PET_CLAIM_RE =
  /^(.+?) told you, '(?:Attacking .+ Master|I am unable to wake .+?, Master)\.'$/
// The PET-VOICED PUBLIC SAY (JOS-47) — the six exact sentences a pet speaks out loud. The
// vocabulary and the regex live in shared/logScrub.ts, because the SCRUB has to carve the same
// six lines out of every public artifact and a second copy of the list here is a second copy
// that drifts. Imported rather than restated; `PET_SAY_LINES` also supplies the discriminant.
const SAY_KIND_BY_TEXT = new Map<string, PetSayKind>(PET_SAY_LINES.map(([k, s]) => [s, k]))

// ----- buffs (Task #19): cast lifecycle + self/pet buff fades -----
// Validated shapes (real log, 2026-08-01):
//   "You begin casting <Spell>."            12,309×  — player starts a cast
//   "You begin singing <Song>."                  5×  — bard song (same pending model)
//   "Your <Spell> spell fizzles!"              476×  — cast failed (always names spell)
//   "Your <Spell> spell is interrupted."             — cast interrupted (always names spell;
//        there is NO bare "Your spell is interrupted." in the log)
//   "Your <Spell> spell has worn off."        (self-cast buff on the player expired)
//   "Your pet's <Spell> spell has worn off."  (buff the player cast on their pet expired)
// The worn-off-OF-<mob> shape (charm/mez) is handled earlier by uncharm/cc; these
// TARGETLESS forms are never charm/cc, so buffFade is a pure fallthrough with no
// overlap. "You regain your concentration…" is a recovered cast — never treated as an
// interrupt; it is its own `castResumed` kind (JOS-167), because a cast that recovers still
// lands and the proc detector has to be able to put back the record the interrupt took away.
// The verb is CAPTURED, not discarded (JOS-382): "singing" is the only statement anywhere in this
// app's inputs that a spell is a bard song, and a song re-rolls resistance every 6-second pulse
// where a cast rolls once. See CastBeginEvent.sung.
const CAST_BEGIN_RE = /^You begin (casting|singing) (.+?)\.$/
// THIRD-PERSON cast (JOS-140): "<Name> begins casting <Spell>." — the only line that says who else
// is casting what, and therefore the only thing that can ANCHOR a landing sentence to an
// allowlisted external caster. The subject is a name-shaped token (EQ names carry spaces,
// apostrophes and backticks: "Lord Nagafen", "Innoruuk`s Chosen"); the verb is third-person so
// "You begin casting" cannot reach it, and the first-person branch above runs first anyway.
const OTHER_CAST_BEGIN_RE = /^(.+?) begins (?:casting|singing) (.+?)\.$/
const CAST_FIZZLE_RE = /^Your (.+?) spell fizzles!$/
const CAST_INTERRUPT_RE = /^Your (.+?) spell is interrupted\.$/
// The interrupt's counterpart (JOS-167): the cast recovered and WILL land. One exact sentence in
// the whole log — matched as an equality, never as a /concentration/ pattern.
const CAST_RESUMED_LINE = 'You regain your concentration and continue your casting.'
// Targetless worn-off (no " of <mob>"): self-cast or pet-cast buff expiry.
const BUFF_FADE_PET_RE = /^Your pet's (.+?) spell has worn off\.$/
const BUFF_FADE_SELF_RE = /^Your (.+?) spell has worn off\.$/

// Activated AA (Task #34): "You activate Quick Buff." (69× in the real log). A Quick Buff
// activation is followed within ~2-3s by a burst of self-buff landing messages (no "You
// begin casting" lines) — the buffs module uses it as context to mark those applies
// confident. Any activated AA matches; consumers filter by name.
const AA_ACTIVATE_RE = /^You activate (.+?)\.$/

// ----- combat stances + invocations (Task #51) -----
// EQ Legends has two mutually-exclusive combat-modifier groups. The COMMIT line names
// the chosen one; the "You begin to change your <group>." lines are pre-commit flavor
// (594 stance / 2339 invocation) and are deliberately NOT emitted (they carry no name).
//   STANCE (9 verified, full-log counts): defensive 210, offensive 176, balanced 59,
//                mage hunter 43, evasive 36, striker 35, berserker 22, channeler 11,
//                ranged 1. Regex is name-permissive (.+?) so a 10th stance still parses.
//   INVOCATION (9 verified): inversion 937, overchannel 487, recovery 450, spellblade
//                263, divine 134, inviolable 19, empowering 15, arcane mastery 14,
//                unyielding 5. (The brief listed 5; the sweep found 9 — "arcane mastery"
//                is a two-word name a single-word grep misses, so the .+? capture matters.)
// The article ("a"/"an") is dropped from the stance name; names are lowercased.
const STANCE_RE = /^You assume an? (.+?) stance\.$/
const INVOCATION_RE = /^You begin reciting the (.+?) invocation\.$/

// ----- WHAT IS IN YOUR GEMS (JOS-391) -----
// Four shapes, all four MEASURED `{kind:'unknown'}` over the owner's 2,048,450-line log before
// this existed (4,321 / 4,285 / 4,232 / 474), so this family can neither shadow nor be shadowed:
//   `Beginning to memorize Heat Blood...`         the gem is being loaded
//   `You have finished memorizing Heat Blood.`    the gem IS loaded
//   `You forget Symbol of Transal.`               the gem is empty
//   `Spell set primary loaded.`  / `saved.` / `deleted.`
// Each regex is anchored at both ends and the name capture is permissive, because spell names
// carry apostrophes and commas (`Denon's Disruptive Discord`) and SET names carry spaces and
// digits (`sham rang buff 2`). The three verbs are an alternation rather than a `(.+?)` so an
// unknown fifth verb stays `unknown` instead of arriving as a mystery action.
const MEMORIZE_BEGIN_RE = /^Beginning to memorize (.+?)\.\.\.$/
const MEMORIZE_DONE_RE = /^You have finished memorizing (.+?)\.$/
const FORGET_RE = /^You forget (.+?)\.$/
const SPELL_SET_RE = /^Spell set (.+?) (saved|loaded|deleted)\.$/

// ----- spell-landing emotes (Task #33): the cast-target discriminator -----
// EQ prints a short flavor line the instant a buff lands. Two forms:
//   SELF:  "You feel much faster."  "You feel much better."  "You feel armored."  …
//   PET:   "<Name> feels much faster."  "Bzzazzt feels much better."             …
// These are CANDIDATES only — the buffs module learns which emote reliably follows a
// given spell's cast (≥2×, no contradiction) before trusting it, and only uses a
// temporally-adjacent one to set a cast's target. So the gate is deliberately
// PERMISSIVE: it just needs to isolate the "<subject> <perception-verb> …." shape and
// reject the obvious non-emotes (upkeep/weather/state spam) so the learner sees a clean
// candidate stream. It is matched LAST in classify() (after every real family), so it
// can never shadow a combat/cast/charm/etc. line — anything that already parsed is gone.
//
// Self form: "You <verb> …." where <verb> is a perception/appearance verb. We EXCLUDE
// the ubiquitous upkeep/state lines ("You are hungry/thirsty/no longer …", "You have
// …", "You feel a traveling spirit …" is allowed — harmless flavor). The exclusions
// keep the candidate stream lean; a stray candidate that doesn't consistently follow a
// cast is ignored by the learner anyway.
const EMOTE_SELF_RE =
  /^You (?:feel|look|sense|seem)\b[^.]*\.$/
// Third-person: "<Name> <verb>s …." — the verb ends in s (feels/looks/seems) and the
// subject is a name (may contain spaces/apostrophes/backticks, EQ mob names).
const EMOTE_PET_RE =
  /^([A-Z][A-Za-z'`]*(?: [A-Za-z'`]+)*) (?:feels|looks|seems)\b[^.]*\.$/

// ----- rogue poisons (Task #64) -----
// Three families, all driven by the tables in shared/logEvents.ts (every string there is
// copied verbatim from the committed spell DB — see that file's block comment):
//
//   COAT   `You coat your blades in a neurotoxic poison.` and 19 siblings, matched by EXACT
//          EQUALITY against POISON_BY_COAT_MSG. Not a pattern: the prose is idiosyncratic
//          per poison ("a weak paralytic", "with a stunning agent", "in asp venom"), so a
//          regex over "in <name> poison" would both miss real coats and invent names.
//          Plus the two third-person shapes below.
//   DRY    `The poison dries from the blade.` / `The venom drips away.` — exact equality.
//   PROC   a Strike's landing emote, matched by SUFFIX (POISON_PROCS).
//
// PLACEMENT (deliberate, and MEASURED — this was probed against the real parser before it
// was written, not assumed):
//   - The PROC emotes and the third-person coats currently classify as 'unknown': the spell
//     DB's cast-on-other SUFFIX table does not carry them (it is built from the
//     "Someone …"/"Soandso …" message shapes, and these messages have neither prefix). So
//     this branch shadows nothing that exists today, and it OWNS them deliberately from now
//     on — a stable, DB-independent proc stream is what the golden tests and the engine's
//     time-to-slow measurement need.
//   - The FIRST-PERSON coat and dry lines DO match the DB today (buffApply /
//     buffWearOff). Claiming them here is still a no-op for the world model: replaying the
//     real coat window (2026-08-03 01:05–01:23) through the real BuffsModule produced ZERO
//     poison actives either way — a coat prints no `You begin casting` line, so own-cast
//     gating drops it, and the shared `dries` wears-off resolves against an active set that
//     never contains a poison. Owning them here buys a single, DB-free code path in the
//     engine instead of two.
// The whole family is gated on cheap probes so the hot path is untouched.

/** Third person, poison NAMED: `Pollux coats their blades in asp venom!` (Asp Venom's own
 *  msgCastOnOther). Ends in '!'. */
const POISON_COAT_OTHER_NAMED_RE = /^(.+?) coats their blades in (.+?)!$/
/** Third person, GENERIC: `Skandercoats their blades in poison.` — verbatim from the real
 *  log, MISSING SPACE included (both occurrences, 2026-07-31 and 2026-08-03). The optional
 *  `\s?` is what lets the lazy name capture stop at "Skander" instead of eating "Skandercoats". */
const POISON_COAT_OTHER_GENERIC_RE = /^(.+?)\s?coats their blades in poison\.$/

/**
 * Last WORD of every proc emote → the emotes that end with it. The gate is one
 * `lastIndexOf(' ')` + one Map lookup, so an ordinary log line costs nothing; the handful of
 * lines that clear it then run an exact `endsWith` against a 1–2 entry list. (A bare
 * `endsWith` loop over all ten suffixes would run for every unclassified line in the log.)
 */
const POISON_PROC_BY_LAST_WORD = ((): ReadonlyMap<string, PoisonProcDef[]> => {
  const m = new Map<string, PoisonProcDef[]>()
  for (const p of POISON_PROCS) {
    const w = p.suffix.slice(p.suffix.lastIndexOf(' ') + 1)
    const list = m.get(w)
    if (list) list.push(p)
    else m.set(w, [p])
  }
  return m
})()

/**
 * `You begin casting|singing <Spell>.` — the player's own cast, with the VERB kept (JOS-382).
 * Its own function because the sung/cast branch is one decision too many for the cascade arm it
 * used to live in, and because "which verb did the log print" is a question worth a name.
 */
function ownCastBegin(c: ClassifyCtx): LogEvent | null {
  const { text, ts, seq, raw } = c
  const m = CAST_BEGIN_RE.exec(text)
  if (!m) return null
  const spell = m[2].trim()
  // Absent rather than false for a cast: an optional present only when it says something keeps
  // every existing golden and every existing consumer byte-identical.
  return m[1] === 'singing'
    ? { kind: 'castBegin', seq, ts, raw, spell, sung: true }
    : { kind: 'castBegin', seq, ts, raw, spell }
}

/** Cast lifecycle (Task #19): begin / fizzle / interrupt (player's own casts). */
export function classifyCastLifecycle(c: ClassifyCtx): LogEvent | null {
  const { text, ts, seq, raw } = c
  if (text.startsWith('You begin ')) {
    const own = ownCastBegin(c)
    if (own) return own
  }
  if (text.includes(' begins casting ') || text.includes(' begins singing ')) {
    const m = OTHER_CAST_BEGIN_RE.exec(text)
    // `idKey(m[1]) !== 'you'` mirrors classifySpellEmote's guard: the first-person branch above
    // owns every line about the player, and a subject that folds to "you" is never somebody else.
    if (m && idKey(m[1]) !== 'you') {
      return { kind: 'otherCastBegin', seq, ts, raw, caster: norm(m[1]), spell: m[2].trim() }
    }
  }
  if (text.includes('spell fizzles!')) {
    const m = CAST_FIZZLE_RE.exec(text)
    if (m) return { kind: 'castFizzle', seq, ts, raw, spell: m[1].trim() }
  }
  if (text.includes('spell is interrupted.')) {
    // Only the PLAYER's own interrupt ("Your <Spell> spell is interrupted.");
    // "<mob>'s <Spell> spell is interrupted." is someone else and is ignored.
    const m = CAST_INTERRUPT_RE.exec(text)
    if (m) return { kind: 'castInterrupted', seq, ts, raw, spell: m[1].trim() }
  }
  // The RECOVERY (JOS-167). Exact sentence, no capture: it names no spell, and casting is
  // serial, so the only cast it can be about is the one just interrupted. See CastResumedEvent
  // for the measurement that made it load-bearing.
  if (text === CAST_RESUMED_LINE) return { kind: 'castResumed', seq, ts, raw }
  return null
}

/**
 * Charm application — the first half of the charm lifecycle.
 *
 * THE CANDIDATE LIST (JOS-140), on exactly the argument `classifyCcApply` below already makes:
 * charm is a detrimental HOLD, the owner wants its countdown, and `<mob> has been charmed.` is
 * seven spells in the committed DB with durations from 48 s to 19 minutes. Purely additive — the
 * branch is gated on a spell DB being installed, so with no DB the event is byte-identical to what
 * it was, and `mob` is untouched either way.
 */
export function classifyCharm({ text, ts, seq, raw, cfg }: ClassifyCtx): LogEvent | null {
  if (text.includes('has been charmed')) {
    const m = CHARM_RE.exec(text)
    if (!m) return null
    const db = cfg.spellDb
    const cands = db ? matchCastOnOtherSuffix(text, db)?.entry.cands : undefined
    return {
      kind: 'charm',
      seq,
      ts,
      raw,
      mob: norm(m[1]),
      ...(cands ? { candidates: cands.map((s) => ({ name: s.name, durationMs: s.durationMs })) } : {})
    }
  }
  return classifyNonEnchanterCharm({ text, ts, seq, raw, cfg })
}

/**
 * THE OTHER TWO CHARM LANDINGS (JOS-250 charm roster research 2026-08-12) —
 * `<mob> blinks.` (Druid/Shaman) and `<mob> moans.` (Necromancer charm-undead).
 *
 * `<mob> has been charmed.` is the ENCHANTER family and nothing else, which quietly made every
 * charm inference in this app enchanter-only: the charm hold (JOS-140), the ownership model
 * (Task #65) and the ally attribution (JOS-250) all key off the `charm` EVENT, and a druid's
 * charm never produced one. A druid charming for your group contributed exactly as much as they
 * did before any of that work existed.
 *
 * THE ADMISSION TEST IS THE FAMILY'S PURITY, NOT THE SENTENCE. These two lines are far more
 * generic than "has been charmed", so the rule refuses unless the DB's own candidate list for the
 * matched suffix is entirely charm-family (`cfg.charmSpell`, the audited roster). Measured in the
 * committed spells.json: `Someone blinks.` is 7/7 castable charms (Befriend Animal 13 → Tunare`s
 * Request 55) and `Someone moans.` is 5/5 (Dominate Undead 18 → Enslave Death 60). If a future
 * scrape puts a non-charm under either sentence, the purity test fails and the line falls through
 * to `classifyDbBuff` exactly as it does today — the rule shrinks itself rather than misfiling.
 *
 * DB-GATED, so with no spell DB installed this branch cannot fire and the parser is byte-identical
 * to what it was — the same construction `classifyCcApply`'s and `classifyCharm`'s candidate lists
 * already use.
 *
 * IT SHADOWS `classifyDbBuff` FOR THESE LINES, on purpose: they used to parse as `buffApply` with
 * the same candidate list, which no consumer routed anywhere (none is in DISPEL_FAMILY,
 * PROC_BUFF_CATALOG, SELF_LANDING_PROCS or PET_TARGET_SPELLS). MEASURED before making the swap:
 * the owner's whole log holds ZERO lines ending ` blinks.` or ` moans.`, and so does every
 * committed fixture — so this rule is STRUCTURALLY covered, changes not one number in any golden,
 * and is the awaiting-sample law's "say which" rather than a claim of verification.
 */
function classifyNonEnchanterCharm({ text, ts, seq, raw, cfg }: ClassifyCtx): LogEvent | null {
  if (!text.endsWith(' blinks.') && !text.endsWith(' moans.')) return null
  const db = cfg.spellDb
  if (!db) return null
  const hit = matchCastOnOtherSuffix(text, db)
  if (!hit) return null
  const cands = hit.entry.cands
  if (cands.length === 0 || !cands.every((s) => cfg.charmSpell.test(s.name))) return null
  return {
    kind: 'charm',
    seq,
    ts,
    raw,
    mob: norm(hit.target),
    candidates: cands.map((s) => ({ name: s.name, durationMs: s.durationMs }))
  }
}

/**
 * "worn off" — uncharm / CC refresh / named-target fade, else the TARGETLESS self+pet fade.
 * The two shapes are an if/else pair exactly as in the original cascade.
 */
export function classifyWornOff({ text, ts, seq, raw, cfg }: ClassifyCtx): LogEvent | null {
  if (text.includes('worn off of')) {
    const m = UNCHARM_RE.exec(text)
    if (m) {
      // A charm spell wearing off retires the pet (uncharm). A MEZ/ROOT spell wearing
      // off is instead a CC keep-alive refresh — the mob was held right up to now.
      // Charm/cc precedence is UNCHANGED (regression-gated).
      // `spell` is carried since JOS-140: the charm hold it ends is keyed by LINE, and this is the
      // line that names it. (The capture is unchanged — it was simply discarded before.)
      if (cfg.charmSpell.test(m[1])) {
        return { kind: 'uncharm', seq, ts, raw, mob: norm(m[2]), spell: m[1].trim() }
      }
      if (cfg.ccSpell.test(m[1])) return { kind: 'cc', seq, ts, raw, mob: norm(m[2]), spell: m[1].trim(), refresh: true }
      // NAMED-TARGET buff fade (Task #30): a NON-charm, NON-cc spell wearing off OF a
      // named target is a real buff the player cast on that target (e.g. a pet buff
      // cast on the charmed mob by name: "Your Swift Like the Wind spell has worn off
      // of an ice giant."). Previously this fell through and emitted NOTHING, so the
      // Buffs tab missed every named-target fade. The raw target name is carried on
      // `target` (can be a mob name); the buffs miner keys samples per spell — see
      // buffs.ts (per-spell-per-target pairing is a known v1 simplification).
      return { kind: 'buffFade', seq, ts, raw, spell: m[1].trim(), target: norm(m[2]) }
    }
  } else if (text.includes('worn off.')) {
    // TARGETLESS worn-off — the player's own buff (self or pet) expired. This is the
    // fallthrough AFTER the "worn off of <mob>" (charm/cc) handler above; these forms
    // never overlap (no " of "), so uncharm/cc emission is untouched (regression-safe).
    let m = BUFF_FADE_PET_RE.exec(text)
    if (m) return { kind: 'buffFade', seq, ts, raw, spell: m[1].trim(), target: 'pet' }
    m = BUFF_FADE_SELF_RE.exec(text)
    if (m) return { kind: 'buffFade', seq, ts, raw, spell: m[1].trim() }
  }
  return null
}

/**
 * Crowd-control application (mez/root, not charm).
 *
 * THE CANDIDATE LIST (JOS-89). This classifier sits ABOVE `classifyDbBuff` in the cascade, so
 * for the four sentences it claims the DB matcher never runs and the candidate list a `buffApply`
 * would have carried was lost entirely — leaving `cc` naming a mob and nothing else, which is why
 * no consumer could ever put a spell (or a duration) on a mez. It now runs the SAME cast-on-other
 * suffix lookup `classifyDbBuff` uses and carries what it finds. Purely additive: the branch is
 * gated on a spell DB being installed (`cfg.spellDb`), so with no DB the event is byte-identical
 * to what it was, and `mob` — the only field anything depended on — is untouched either way.
 *
 * It is a LIST and never a name: `has been mesmerized.` is four spells with three different
 * stated durations. Narrowing it is the model's job (world-model law 3).
 */
export function classifyCcApply({ text, ts, seq, raw, cfg }: ClassifyCtx): LogEvent | null {
  if (text.includes('has been ')) {
    const m = CC_APPLY_RE.exec(text)
    if (!m) return null
    const db = cfg.spellDb
    const cands = db ? matchCastOnOtherSuffix(text, db)?.entry.cands : undefined
    return {
      kind: 'cc',
      seq,
      ts,
      raw,
      mob: norm(m[1]),
      verb: m[2] as CcVerb,
      ...(cands ? { candidates: cands.map((s) => ({ name: s.name, durationMs: s.durationMs })) } : {})
    }
  }
  return null
}

/**
 * The CROWD-CONTROL BREAK (JOS-180) — `<mob> has been awakened by <name>.`
 *
 * WHY THE PARSER CARRIES IT. `Your <S> spell has worn off of <mob>.` is the same sentence whether
 * the mez ran its course or a nuke ended it two seconds in, and the duration learner cannot tell
 * those apart from the wear-off alone — which is the whole of JOS-180's trap (a learner fed break
 * spans settles below the real duration, culls every full-length hold before its wear-off arrives,
 * and can never climb back out). This line is the only thing in the log that names the difference.
 *
 * IT CLOSES NOTHING, AND THE MEASUREMENT IS WHY (see CcWakeEvent for the full tally): the wear-off
 * line always comes FIRST and in the same second, so by the time this arrives the hold is already
 * closed and its sample already minted. The consumer's job is to go back and mark that sample
 * CENSORED, never to end a second thing.
 *
 * It sits directly beneath `classifyCcApply` — the same family, the other end of the hold — and
 * beneath rather than above so the four APPLICATION sentences are always offered to the
 * application rule first. Neither can shadow the other (`awakened` is in neither pattern).
 */
export function classifyCcWake({ text, ts, seq, raw }: ClassifyCtx): LogEvent | null {
  if (!text.includes(' has been awakened by ')) return null
  const m = CC_WAKE_RE.exec(text)
  if (!m) return null
  return { kind: 'ccWake', seq, ts, raw, mob: norm(m[1]), by: norm(m[2]) }
}

/** Pet-ownership claim (direct tell ⇒ the named entity is your pet). */
export function classifyPetClaim({ text, ts, seq, raw }: ClassifyCtx): LogEvent | null {
  if (text.includes(" told you, '")) {
    const m = PET_CLAIM_RE.exec(text)
    if (m) return { kind: 'petClaim', seq, ts, raw, name: norm(m[1]), via: 'tell' }
  }
  return null
}

/**
 * THE `/pet who leader` ANSWER (JOS-52) — `<Name> says, 'My leader is <You>.'`
 *
 * The second binding signal a summoned pet has, and the ON-DEMAND one: the tell only fires when
 * the pet is ORDERED, so a player who never types a pet command has a pet the app cannot see
 * (AGENTS.md, JOS-47/JOS-49). One `/pet who leader` makes the pet answer out loud, and unlike
 * the six sentences in `classifyPetSay` below it names the owner — so it BINDS. It emits
 * `petClaim`, the same canonical event the tell emits, so the whole downstream (world.claim's
 * idempotence, the JOS-54 single-pet succession, the everCharmed PROMOTE path, the buff-entity
 * succession in modules/buffs.ts, the progression ledger) is shared rather than re-derived.
 *
 * MEASURED (whole-log sweep, 1,404,458 lines, 2026-08-06): the family has exactly ONE member and
 * ONE occurrence — `Jaber says, 'My leader is Primitive.'`, Thu Aug 06 12:44:20. No follower
 * variant, no no-leader variant, no charmed variant; a second shape would need a real line first
 * (the awaiting-sample law). Hence the EXACT shape and not a `/leader/` pattern: the same sweep
 * turned up seven `<Name> is now the leader of your group.` lines and five players talking about
 * leadership in chat, and the six-says precedent is standing law here.
 *
 * THE LEADER'S NAME IS THE WHOLE GUARD, and it comes from `ParserConfig.characterName` — the
 * session injects the tailed character (rulesets.ts installCharacterName), never a constant.
 * `says` is BROADCAST: another player's pet in earshot prints this exact line naming ITS owner,
 * so a rule that read the shape without the name would hand you a stranger's pet. With no
 * character installed the rule declines every line, which is the same safe default the
 * self-`/who` rule takes for the same reason (parseWho.ts classifySelfWho) — that rule is this
 * one's direct precedent, down to the permissive regex whose only real test is the name.
 *
 * THE ONE THING IT CANNOT RULE OUT, stated rather than pretended away: a `says` line is
 * forgeable. A player standing next to you can type `/say My leader is <You>.` and be admitted
 * as your pet. The private tell cannot be forged; this cannot be defended, because the game
 * gives `/pet who leader` no other answer. The cost is bounded and local — a bogus row in your
 * own meter, in your own session, from someone who has to be in earshot and do it on purpose —
 * and the owner asked for the command's text supported knowing what the command is.
 *
 * Declines (returns null) for every other leader, which is the codebase's idiom for a line that
 * parses to nothing: it becomes no event at all, exactly like the mob growl beside it. A
 * stranger's pet naming a stranger is not information about our world model.
 */
export function classifyPetLeader({ text, ts, seq, raw, cfg }: ClassifyCtx): LogEvent | null {
  const self = cfg.characterName
  if (self === undefined || self === '' || !text.includes(" says, 'My leader is ")) return null
  const m = PET_LEADER_RE.exec(text)
  if (!m) return null
  // Case-insensitive like every other name comparison in this parser (world-model law 2).
  if (m[2].toLowerCase() !== self.trim().toLowerCase()) return null
  return { kind: 'petClaim', seq, ts, raw, name: norm(m[1]), via: 'leader' }
}

/**
 * THE SAME ANSWER, ABOUT SOMEBODY ELSE (JOS-250) — `<PetName> says, 'My leader is <Player>.'`
 * where `<Player>` is NOT the tailed character.
 *
 * `classifyPetLeader` above declines these, on purpose and correctly: nothing in this app used to
 * have a use for a stranger's pet, and a `petClaim` naming one would have been bound to YOU by
 * five different models. JOS-250 gives it a use — the ally-charm attribution model, which credits
 * a third party's charm pet to that third party and never to you — so the line gets its OWN kind
 * (`allyPetLeader`) rather than a flag on the one everything else reads.
 *
 * IT MUST RUN AFTER `classifyPetLeader`, which is why it sits directly beneath it in the cascade:
 * the two are the same sentence and are separated only by WHOSE name is in the second capture, so
 * the self rule has to be offered the line first or your own pet would arrive as a stranger's.
 *
 * THE CHARACTER NAME IS STILL LOAD-BEARING even though this rule refuses it. With no character
 * installed, `classifyPetLeader` declines EVERY line (its own safe default), so without this guard
 * this rule would claim the user's own `/pet who leader` answer and file the user's own pet as an
 * ally's. Declining while the name is unknown keeps the pair's precedence honest in both states.
 *
 * THE LEADER MUST BE PLAYER-SHAPED (shared/playerShape.ts). `says` is a broadcast channel and the
 * whole log's mob speech goes through it; a leader capture that admitted `a fire giant warrior`
 * would invent a charmer out of a growl.
 *
 * NO REAL THIRD-PARTY OCCURRENCE EXISTS IN THE OWNER'S LOG (whole-log sweep, 1,608,483 lines,
 * 2026-08-12: one `says, 'My leader is …'` line in total, and it names the owner). See
 * `AllyPetLeaderEvent` for what that means for the evidence standing behind this rule.
 */
export function classifyAllyPetLeader({ text, ts, seq, raw, cfg }: ClassifyCtx): LogEvent | null {
  const self = cfg.characterName
  if (self === undefined || self === '' || !text.includes(" says, 'My leader is ")) return null
  const m = PET_LEADER_RE.exec(text)
  if (!m) return null
  const owner = m[2]
  // The self form belongs to classifyPetLeader (which ran first); restated here so the two rules
  // cannot both claim a line if the cascade is ever reordered.
  if (owner.toLowerCase() === self.trim().toLowerCase()) return null
  if (!isPlayerShapedName(owner)) return null
  return { kind: 'allyPetLeader', seq, ts, raw, pet: norm(m[1]), owner: norm(owner) }
}

/**
 * A pet's PUBLIC response (JOS-47) — `<Name> says, '<one of six>'`.
 *
 * NOT a claim, and the two classifiers sit next to each other so that stays obvious: `told you`
 * is a channel only the owner can read, `says` is a channel everyone in earshot reads. This
 * event nominates a candidate; it never binds a pet. See shared/logEvents.ts PetSayEvent.
 *
 * The `says, '` pre-test is the same cheap guard the claim family uses — this runs on every
 * line of a 1.4M-line replay and the full regex is an alternation of six sentences.
 */
export function classifyPetSay({ text, ts, seq, raw }: ClassifyCtx): LogEvent | null {
  if (!text.includes(" says, '")) return null
  const m = PET_SAY_RE.exec(text)
  if (!m) return null
  const say = SAY_KIND_BY_TEXT.get(m[2])
  return say ? { kind: 'petSay', seq, ts, raw, name: norm(m[1]), say } : null
}

/** Activated AA (Task #34): "You activate <X>." (e.g. Quick Buff). */
export function classifyAaActivate({ text, ts, seq, raw }: ClassifyCtx): LogEvent | null {
  if (text.startsWith('You activate ')) {
    const m = AA_ACTIVATE_RE.exec(text)
    if (m) return { kind: 'aaActivate', seq, ts, raw, name: m[1].trim() }
  }
  return null
}

/** Combat stance + invocation changes (Task #51). */
export function classifyStance({ text, ts, seq, raw }: ClassifyCtx): LogEvent | null {
  // --- combat stance change (Task #51): "You assume a <stance> stance." ---
  if (text.startsWith('You assume ')) {
    const m = STANCE_RE.exec(text)
    if (m) return { kind: 'stanceChange', seq, ts, raw, stance: m[1].trim().toLowerCase() }
  }
  // --- invocation change (Task #51): "You begin reciting the <name> invocation." ---
  // (Gated on the specific prefix so it never touches the "You begin casting/singing"
  // cast-lifecycle lines already handled above.)
  if (text.startsWith('You begin reciting ')) {
    const m = INVOCATION_RE.exec(text)
    if (m) return { kind: 'invocationChange', seq, ts, raw, invocation: m[1].trim().toLowerCase() }
  }
  return null
}

/**
 * WHAT IS IN YOUR GEMS (JOS-391) — the memorize / forget / spell-set family.
 *
 * ONE CLASSIFIER FOR FOUR SHAPES because they are one subject and one consumer
 * (`src/main/modules/spellSets.ts`), and because the three cheap prefix probes below run on
 * every line of a two-million-line replay: the regexes only execute for a line that already
 * starts with the right words.
 *
 * THE MEMORIZE LINES STAY SUPPRESSED WHERE THEY WERE SUPPRESSED (buffsShapes.ts
 * `CASTING_SYSTEM_RE`). That module is the landing-message MINER and these lines are not spell
 * landings — a coincidental burst pairing on `You forget Center.` would teach the overlay a
 * message for a spell that just left the bar. Parsing them into events here and refusing them
 * there are the same decision from two sides: the miner is not the consumer.
 */
export function classifySpellGems({ text, ts, seq, raw }: ClassifyCtx): LogEvent | null {
  if (text.startsWith('You forget ')) {
    const m = FORGET_RE.exec(text)
    return m ? { kind: 'spellForget', seq, ts, raw, spell: m[1].trim() } : null
  }
  if (text.startsWith('You have finished memorizing ')) {
    const m = MEMORIZE_DONE_RE.exec(text)
    return m ? { kind: 'spellMemorize', seq, ts, raw, spell: m[1].trim(), done: true } : null
  }
  if (text.startsWith('Beginning to memorize ')) {
    const m = MEMORIZE_BEGIN_RE.exec(text)
    return m ? { kind: 'spellMemorize', seq, ts, raw, spell: m[1].trim(), done: false } : null
  }
  if (text.startsWith('Spell set ')) {
    const m = SPELL_SET_RE.exec(text)
    if (m) return { kind: 'spellSet', seq, ts, raw, set: m[1].trim(), action: m[2] as 'saved' | 'loaded' | 'deleted' }
  }
  return null
}

/**
 * Illusion click-off (Task #36): "Your illusion fades."
 * The shared removal line for EVERY illusion-flagged spell (Illusion: <race>, Boon of
 * the Garou, …) — the DB lists it as msg_wears_off for 27 distinct spells, so it can't
 * name which illusion faded. It doesn't need to: only ONE illusion is active at a time
 * (the user's rule), so this removes whichever illusion self buff is active. Emitted
 * HERE, before the DB buffWearOff table below, so the 27-way-ambiguous wears-off match
 * never fires for this exact line (which would remove an arbitrary first candidate).
 * NOT DB-gated — the text is unambiguous on its own.
 */
export function classifyIllusionFade({ text, ts, seq, raw }: ClassifyCtx): LogEvent | null {
  if (text === 'Your illusion fades.') {
    return { kind: 'illusionFade', seq, ts, raw, target: 'self' }
  }
  return null
}

/** Rogue poisons (Task #64), coat half: first- and third-person. See the tables above. */
export function classifyPoisonCoat({ text, ts, seq, raw }: ClassifyCtx): LogEvent | null {
  if (text.startsWith('You coat your blades ')) {
    const p = POISON_BY_COAT_MSG.get(text)
    // An unknown coat line is still a coat — we say so and decline to name the poison
    // (law 1) rather than dropping the only evidence that the blades were re-coated.
    if (text.endsWith('.')) {
      return p
        ? { kind: 'poisonCoat', seq, ts, raw, poison: p.name, group: p.group, who: 'you' }
        : { kind: 'poisonCoat', seq, ts, raw, poison: 'unknown', group: 'unknown', who: 'you' }
    }
  }
  if (text.includes('coats their blades in ')) {
    // Named third person (`… in asp venom!`): the descriptor is the same noun phrase the
    // first-person line uses, so we resolve it through the SAME table instead of keeping a
    // second one. Unresolvable ⇒ 'unknown', never a guessed name.
    let m = POISON_COAT_OTHER_NAMED_RE.exec(text)
    if (m) {
      const p = POISON_BY_COAT_MSG.get(`You coat your blades in ${m[2].trim()}.`)
      return {
        kind: 'poisonCoat', seq, ts, raw,
        poison: p?.name ?? 'unknown', group: p?.group ?? 'unknown', who: norm(m[1])
      }
    }
    // Generic third person (`Skandercoats their blades in poison.`) — the game deliberately
    // hides which poison, so there is nothing to resolve.
    m = POISON_COAT_OTHER_GENERIC_RE.exec(text)
    if (m) return { kind: 'poisonCoat', seq, ts, raw, poison: 'unknown', group: 'unknown', who: norm(m[1]) }
  }
  return null
}

/** The proc emote's target (the text before the suffix), or null when this proc doesn't match. */
function poisonProcTarget(text: string, p: PoisonProcDef): string | null {
  // Possessive suffixes attach straight to the name; bare ones follow a space —
  // the same two-shape rule the DB's own cast-on-other matcher uses.
  const tail = p.suffix.startsWith("'s") ? p.suffix : ` ${p.suffix}`
  if (!text.endsWith(tail) || text.length <= tail.length) return null
  return text.slice(0, text.length - tail.length).trim() || null
}

/** Rogue poisons (Task #64), dry + Strike-proc half. */
export function classifyPoisonProc({ text, ts, seq, raw }: ClassifyCtx): LogEvent | null {
  const group = POISON_DRY_MSG[text]
  if (group) return { kind: 'poisonDry', seq, ts, raw, group }
  if (text.endsWith('!') || text.endsWith('.')) {
    const cands = POISON_PROC_BY_LAST_WORD.get(text.slice(text.lastIndexOf(' ') + 1))
    for (const p of cands ?? []) {
      const target = poisonProcTarget(text, p)
      if (target) {
        return {
          kind: 'poisonProc', seq, ts, raw,
          strike: p.strikes[0], candidates: [...p.strikes], effect: p.effect, target: norm(target)
        }
      }
    }
  }
  return null
}

/**
 * Match a log line against the DB cast-on-other SUFFIX table (Task #34). The wiki records
 * "Someone looks tranquil."; the log names the target ("a froglok looks tranquil."), so a
 * line matches when it ENDS WITH a known suffix ("looks tranquil.") and the prefix is a
 * plausible (non-empty) target name. Returns the spell + captured target, or null.
 *
 * The lookup itself lives in spellDb.ts beside the table and the index it reads (JOS-58 — it
 * used to walk all 648 suffixes here, which was 9.2 s of an 11.5 s parse); this wrapper is the
 * parser's half, and all it adds is `norm` on the captured target.
 */
function matchCastOnOther(
  text: string,
  db: NonNullable<ParserConfig['spellDb']>
): { cands: import('../data/spellDb').SpellDb['spells']; target: string } | null {
  const hit = matchCastOnOtherSuffix(text, db)
  return hit ? { cands: hit.entry.cands, target: norm(hit.target) } : null
}

/** Build a buffApply event from a target + candidate spell list (Task #34). The `spell`
 *  field is the first candidate (best-effort); `candidates` carries the full set for the
 *  buffs module to resolve against the player's cast history when ambiguous. */
function buffApplyEvent(
  { ts, seq, raw }: ClassifyCtx,
  target: string,
  cands: import('../data/spellDb').SpellDb['spells']
): LogEvent {
  const first = cands[0]
  return {
    kind: 'buffApply', seq, ts, raw, target,
    spell: first.name,
    illusion: first.illusion,
    durationMs: first.durationMs,
    candidates: cands.map((s) => ({ name: s.name, durationMs: s.durationMs, illusion: s.illusion }))
  }
}

/**
 * Message-driven buff events (Task #34) — DB-gated, additive. Emitted only when a
 * spell database is installed on the config (installSpellDb); with no DB these never
 * fire so parser purity holds and existing tests/profiles are byte-for-byte unchanged.
 * These matches take precedence over the permissive spellEmote candidate below: a line
 * that EXACTLY matches a DB message names the exact spell, which is strictly more
 * informative than an emote candidate. Unmatched emote-shaped lines still fall through
 * to spellEmote, so Task #33's cast-target learning is untouched for non-DB spells.
 */
export function classifyDbBuff(c: ClassifyCtx): LogEvent | null {
  const { text, ts, seq, raw } = c
  const db = c.cfg.spellDb
  if (!db) return null
  // Self landing: msg_cast_on_you match → buffApply { self }. (Covers the Quick Buff
  // burst, whose landing messages have no "You begin casting" line.) A message may map to
  // several candidate spells (shared haste/clarity messages); we carry them all so the
  // buffs module resolves via the player's cast history.
  const selfCands = db.castOnYou.get(text)
  if (selfCands?.length) return buffApplyEvent(c, 'self', selfCands)
  // Buff fade: msg_wears_off match → buffWearOff { self }. Message-driven expiry is
  // favored over estimate-based removal (the user directive). MANY spells share a
  // wears-off message ("Your speed returns to normal." = 9 haste spells, "Your strength
  // fades." = 13, …), so we carry the FULL candidate list (Task #45): the buffs module
  // resolves against the player's ACTIVE self buffs (EQ stacking ⇒ one candidate active at
  // a time). Removing by only the first candidate MISSED the actually-active buff.
  const wornCands = db.wearsOff.get(text)
  if (wornCands?.length) {
    return {
      kind: 'buffWearOff',
      seq,
      ts,
      raw,
      spell: wornCands[0].name,
      candidates: wornCands.map((s) => s.name),
      target: 'self'
    }
  }
  // Cast-on-other: the log names the target ("a froglok looks tranquil."), so match by
  // the invariant SUFFIX the wiki records as "Someone looks tranquil." → "looks
  // tranquil.". The target is the text before the suffix.
  const other = matchCastOnOther(text, db)
  if (other) return buffApplyEvent(c, other.target, other.cands)
  return null
}

/**
 * Spell-landing emotes (Task #33) — matched LAST so it never shadows a real
 * family. A candidate emote the buffs module uses to discriminate cast targets.
 */
export function classifySpellEmote({ text, ts, seq, raw }: ClassifyCtx): LogEvent | null {
  if (text.startsWith('You ')) {
    // Exclude upkeep/state spam that shares the "You <verb> …" shape but is never a
    // spell-landing emote (hunger/thirst/state-off). "You feel/look/sense/seem …" only.
    if (EMOTE_SELF_RE.test(text)) return { kind: 'spellEmote', seq, ts, raw, subject: 'self', text }
  } else {
    const m = EMOTE_PET_RE.exec(text)
    // Never treat "You"/"Your" as a pet subject (self form handled above).
    if (m && idKey(m[1]) !== 'you') return { kind: 'spellEmote', seq, ts, raw, subject: norm(m[1]), text }
  }
  return null
}
