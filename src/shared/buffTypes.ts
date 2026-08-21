// buffTypes.ts — the SPELL/BUFF half of the shared type surface: the mined buff-duration
// model, the learned message overlay, the scraped spell DB, and the suggested-alerts catalog
// derived from it.
//
// Split out of types.ts, which had grown past the 400-code-line factoring ceiling. The section
// text is UNCHANGED and every name here is still exported from `shared/types` (which
// re-exports this module), so no importer moved and no import path changed.

import type { ClassAbbr } from './classCombo'

// ----- Buffs extension (Task #19) -----
//
// A log-mined buff-duration model. The player's own casts are tracked as a small
// state machine: `You begin casting <S>` → pending; a fizzle/interrupt/new-cast
// clears it; otherwise the cast is treated as LANDED (see BuffsModule for the
// approximation). Each landed cast is paired with the NEXT worn-off of the same
// spell to yield a duration sample; per-spell samples become median/IQR stats,
// which drive an estimated-remaining bar for currently-active buffs.
//
// Scope (v1): only spells that have EVER produced a self/pet buffFade in history
// are treated as buffs — nukes/mez/charm get cast lines too but never self-fade,
// so that fade is the honest discriminator. Durations are mined from the player's
// own buffs (self and pet-targeted; in this Enchanter's log the pet is the main
// buff target — see logEvents.ts BuffFadeEvent).

/**
 * Whether a spell is a beneficial BUFF or a detrimental DEBUFF (Task #35).
 *
 * This is a property of the SPELL, not of who it's on. It comes from the scraped spell
 * DB's `spellType` (Beneficial → 'buff', Detrimental → 'debuff'); for a spell absent
 * from the DB it falls back to the plurality of its observed fade-target dispositions (a
 * spell that mostly fades on hostile entities is a debuff).
 *
 * NOTE (Task #35 model correction): there is deliberately NO 'pet' class. A buff cast on
 * the pet is just a 'buff' bound to the pet ENTITY — "pet" is a priority/grouping concern
 * for the UI (show self first, then other entities), not a data-model taxonomy. Do not
 * reintroduce a 'pet' BuffClass.
 */
export type BuffClass = 'buff' | 'debuff'

/**
 * WHERE A DURATION ESTIMATE CAME FROM — the provenance of every countdown this app draws
 * (buffsStats.ts `estimateFor` is the one place that decides it).
 *
 *   'db'       — the spell-database baseline held: nothing observed beat it, and nothing
 *                observed corroborated a shorter answer.
 *   'observed' — a logged cycle ran LONGER than the baseline (AA/focus extension) and won.
 *   'cluster'  — the app's own clean cycles agree the spell is SHORTER than the baseline says,
 *                and there are enough of them to say so (JOS-212, owner ruling 2026-08-12).
 *                It is a separate label from 'observed' on purpose: the two answers are read off
 *                the same samples but they make opposite claims about the database row, and a UI
 *                that said "longer than the baseline" for both would be lying about one of them.
 *   'deathBound' — a mob DIED still carrying the debuff and the log never printed a wear-off for
 *                it, so the app knows the spell lasted AT LEAST that long and does not know what
 *                it would have lasted (JOS-379, owner ruling 2026-08-15). It is the only source
 *                that is a BOUND rather than an answer, which is why it is not spelled
 *                'observed': a surface that draws it must say "at least", the way
 *                `shared/respawn.ts` prints its death-gap estimates with a `≤`.
 *
 * Every consumer that is not asking specifically about the DB floor should treat 'cluster' the
 * way it treats 'observed' — both are this caster's own measured cycles. 'deathBound' is the one
 * that needs its own sentence, because the claim it makes is weaker than either.
 */
export type EstimatorSource = 'db' | 'observed' | 'cluster' | 'deathBound'

/** Per-spell mined duration statistics (milliseconds). */
export interface BuffStat {
  /** spell name (display casing of the first observed cast/fade). */
  spell: string
  /** buff vs debuff — a spell property (Task #35). */
  cls: BuffClass
  /** number of duration samples (landed→fade pairs). */
  n: number
  /** median duration (ms); null when n === 0 (spell seen fading but never cleanly paired). */
  medianMs: number | null
  /** 25th percentile duration (ms), null when n === 0. */
  p25: number | null
  /** 75th percentile duration (ms), null when n === 0. */
  p75: number | null
  /** min / max sample (ms), null when n === 0. */
  minMs: number | null
  maxMs: number | null
  /**
   * The AUTHORITATIVE wiki duration (ms) for this spell, when the scraped DB knows it
   * (Task #34). This is the prior/truth and takes precedence over mined samples in the
   * estimator; null when the DB has no duration (mined-only spell).
   */
  dbDurationMs?: number | null
  /**
   * The value the estimator uses for the remaining-time bar (JOS-117): max(DB baseline, recent
   * observed max) — the DB is a FLOOR that below-base click-off samples cannot pull under, and a
   * logged cast that beat the floor wins. Since JOS-212 the floor is no longer absolute: a
   * corroborated cluster of clean below-floor cycles removes it (see {@link EstimatorSource}).
   * Provenance in `estimatorSource`. Null when neither is available (n=0, no DB duration).
   */
  estimateMs?: number | null
  /** Where `estimateMs` came from — see {@link EstimatorSource}. */
  estimatorSource?: EstimatorSource
  /**
   * The newest event ts (ms epoch) this spell was seen — the last castBegin / apply / fade
   * involving it (Task #45). The RECENCY signal the suggested-alerts wizard sorts by (recent
   * spells over merely-frequent ones). Absent when the spell was never seen live.
   */
  lastSeenMs?: number | null
}

/** A currently-active (landed, not yet faded) buff INSTANCE = (spell, target entity). */
export interface ActiveBuff {
  /**
   * THE SPELL'S IDENTITY, and since JOS-238 that means the DB's own display name whenever the
   * model resolved which spell this is — never the ranked text one cast line happened to spell.
   *
   * It used to be the cast line's when a cast ANCHOR resolved an ambiguous landing, and the cost
   * was the whole reason that ticket exists: `Swift Like the Wind IV` travelled from the anchor
   * into this field, into the learner's display, and into the derived `buffExpired`, so a
   * suggested wears-off alert — which pins the bare catalog name, `Swift Like The Wind` — could
   * never fire for a spell cast at rank II or above. The rank is now {@link castName}.
   *
   * A FAMILY the anchors could not narrow still names every candidate here (`A / B`) and says so
   * with `candidates`; that is an honest absence of an identity, not a second spelling of one.
   */
  spell: string
  /**
   * The RANKED name the cast line spelled (`Swift Like the Wind IV`), when the model resolved this
   * instance from a cast anchor AND the log's spelling says something `spell` does not (JOS-238).
   *
   * DISPLAY ONLY, and deliberately so: nothing keys, matches, learns or alerts off this field. It
   * exists because the rank is genuinely information — the cast line is the ONLY line in the whole
   * family that carries one — and losing it entirely would give back a fact JOS-126 asked for. A
   * surface that wants to show "which rank is up" reads this; everything that wants to know WHICH
   * SPELL is up reads `spell`.
   */
  castName?: string
  /** buff vs debuff — a SPELL property (Task #35), not who it's on. */
  cls: BuffClass
  /**
   * True when the spell CALMS its target — the calm/lull line (JOS-213): a spell whose effect
   * happens to a MOB's aggression. Absent for every other spell.
   *
   * It is a SECOND, ORTHOGONAL fact about the spell, not a correction to `cls`. What it adds is
   * that the thing the spell does is a mob-state effect, which is what routes its timer to the
   * DEBUFFS overlay beside the slows and the mez holds (shared/buffTimers.ts `timerRowSurface`)
   * instead of leaving an aggro clock among the player's own buffs. Filled by main from the DB
   * roster (`data/spellDb.ts spellCalmsTarget`), and — like `cls` since JOS-140 ruling 8 — never
   * resolved by looking at who the spell landed on.
   *
   * JOS-213 WROTE THIS FIELD FOR A `cls: 'buff'` ROW AND IT IS NO LONGER ONE. The owner ruled
   * (JOS-413, 2026-08-19) that a lull is a DEBUFF, so the family's `cls` is 'debuff' now and the
   * row reaches the debuffs window on its kind. The field is kept because it is a true, derived,
   * audited statement about the spell, because it is the guard that keeps a friendly buff off that
   * window, and because it is still the answer for a calm-line spell the polarity ruling has no row
   * for — not because the routing still depends on it alone.
   */
  calmsTarget?: true
  /**
   * True when this instance is on the PLAYER (self). False when it's on some other
   * entity (a pet, another player, or — for a debuff — a hostile mob). The UI shows
   * self instances first ("Your buffs"), then per-entity groups (Task #35).
   */
  self: boolean
  /**
   * The bound entity disposition (Task #32), kept for the module's own censor logic:
   * 'self' | 'summoned' | 'charmed' | 'hostile'. The UI groups by `self`/`target`, not by this.
   */
  disposition?: 'self' | 'summoned' | 'charmed' | 'hostile'
  /** ts (ms) the cast landed / was last refreshed. */
  startedTs: number
  /** estimated duration from mined median (ms); null when no samples yet. */
  estimatedMs: number | null
  /** p25/p75 spread (ms) for the ± hint; null when no samples. */
  p25: number | null
  p75: number | null
  /** sample count behind the estimate (confidence hint). */
  n: number
  /**
   * The bound entity's display name for a NON-self instance (the pet's name, another
   * player, or the inferred mob for a debuff); undefined for a self instance. This is
   * both the group key and the target chip in the UI (Task #35).
   */
  target?: string
  /**
   * True when `target` is an INFERENCE, not fact (Task #32): a debuff's active target
   * is inferred from the pet's current fight target because castBegin carries no
   * target. The UI must present this as "target: inferred", never as a silent guess.
   */
  inferredTarget?: boolean
  /**
   * Where `estimatedMs` came from (JOS-117) — see {@link EstimatorSource}. `undefined` means no
   * estimate at all (n=0 and no DB duration).
   */
  durationSource?: EstimatorSource
  /**
   * THE BUFFS/TIMER OVERLAY's countdown duration (ms). Since JOS-117 this is the SAME estimator the
   * Buffs TAB uses — max(DB floor, recent observed max) — so both surfaces agree; a below-base
   * click-off no longer becomes the overlay number (JOS-114's most-recent-sample rule did exactly
   * that, showing Swift at ~28m for a 33:36 buff) and a focus-extended duration is honoured. Null
   * for a permanent buff, or when there is no floor and no sample (the overlay counts UP). See
   * buffsStats.ts `estimateFor` and shared/buffTimers.ts `timerModeOf`.
   */
  overlayDurationMs?: number | null
  /** Where `overlayDurationMs` came from — see {@link EstimatorSource}. */
  overlaySource?: EstimatorSource
  /**
   * True when this buff NEVER EXPIRES, for either of the two reasons `permanentSource` names
   * (Task #34's Permanent Illusion AA; JOS-215's permanent SPELLS). The UI draws no countdown, the
   * hygiene sweep never retires it, and no duration sample is ever paired from it — only a
   * wear-off, a death or a zone can take it off the board.
   */
  permanent?: boolean
  /**
   * WHY it is permanent, so the row can say so without guessing (JOS-215).
   *
   *   'spell'       — the spell database states `Permanent` for this line. 62 rows, all Self:
   *                   Yaulp, the Shielding ladder, the blade coats, Instrument of Nife, the wolf
   *                   forms. Nothing about the player's AAs is involved.
   *   'illusion-aa' — the Permanent Illusion AA (Task #34): an illusion-flagged spell the player
   *                   self-cast at or after buying it, whose OWN duration is finite.
   *
   * Present only when `permanent` is true. It is DERIVED in main from the same DB row the
   * permanence was read off (buffsView.ts), never plumbed through the landing, so the two can not
   * disagree. The distinction is the whole of the JOS-215 copy fix: the row used to hardcode
   * "permanent · illusion AA" and said it about a rogue's poison coat.
   */
  permanentSource?: 'spell' | 'illusion-aa'
  /**
   * True when this active was applied by an EXACT chat MESSAGE match (Task #34) — a
   * msg_cast_on_you / msg_cast_on_other / self-heal-by-buff line. Since JOS-118 this is the ONLY
   * way an instance is opened, so it is true on every active the model produces; it is kept as
   * the explicit statement that a row rests on a line the log actually printed.
   */
  messageDriven?: boolean
  /**
   * HOW MANY OF THAT NAME ARE HOLDING THIS SPELL (JOS-140 ruling 7). Absent or 1 for the ordinary
   * case; 2+ when a round landed on several entities that share a display name.
   *
   * EQ stamps are second-resolution and print no instance identifier, so one AE cast landing on
   * five mobs called `a wan ghoul knight` is five byte-identical lines in one second — the model
   * cannot separate them and does not pretend to. It keeps a landing each and draws ONE row with a
   * count chip, because five identical rows with five identical clocks is noise. `startedTs` is
   * the OLDEST of them, which is the one the next anonymous wear-off will close.
   */
  count?: number
  /**
   * WHOSE cast this is: absent for your own (the overwhelming case), else the allowlisted external
   * caster's name (shared/buffTrust.ts). It is what the row's countdown is keyed on — a duration
   * is a fact about a caster's AAs and focus, so their estimate is theirs and never pooled with
   * yours (JOS-140 ruling 4).
   */
  caster?: string
  /**
   * Present only when the landing sentence is shared by several spells and the anchor could not
   * narrow it — a Quick Buff burst names no spell, so its landings can be admitted as YOURS
   * without being resolvable to one (JOS-140). `spell` then reads as the joined family and the UI
   * shows the ~ chip; a family instance mints nothing into the learner.
   */
  candidates?: string[]
}

// ----- Observed-message overlay (Task #36) -----
//
// The user's directive: "augment the spell database with our own method of verifying
// variations of the cast messages for everything we encounter." During replay AND live
// the buffs model MINES associations between the messages the game prints and the spell
// the player was casting at the time, then derives a per-message VERDICT. The overlay is a
// learned layer ON TOP of the scraped spells.json — where the overlay disagrees, it wins
// (the wiki is known-inaccurate in places, e.g. Symbol of Pinzarn's landing message).
//
// A future agent should consult the overlay BEFORE trusting a wiki cast message: a message
// the overlay marks SHARED can NOT identify a spell on its own (resolve via cast history);
// a CONTRADICTS-WIKI verdict means the wiki's msg_* field for that spell is wrong.

/** The verdict the overlay derives for one observed message text (Task #36). */
export type OverlayVerdict =
  | 'verified' // consistently follows exactly ONE spell (n≥2) — a reliable identifier.
  | 'shared' // follows MULTIPLE spells (e.g. "You feel different.") — can't name a spell.
  | 'contradicts-wiki' // observed pairing differs from spells.json's msg_* for that spell.
  | 'unknown' // too few observations to judge (n<2, single spell).

/** One observed message and what the overlay learned about it (Task #36). */
export interface OverlayMessage {
  /** The exact message text as it appears in the log (a landing or wears-off line). */
  text: string
  /** Whether it was observed as a landing message or a wears-off message. */
  role: 'landing' | 'wearsOff'
  /** The overlay's verdict for this message. */
  verdict: OverlayVerdict
  /** Per-spell observation counts (spell display name → times seen following that cast). */
  spells: { spell: string; count: number }[]
  /** Total observations of this message across all spells. */
  total: number
  /**
   * For a CONTRADICTS-WIKI verdict: the spell whose spells.json msg_* field this message
   * contradicts, and what the wiki claims. Undefined otherwise.
   */
  wikiConflict?: { spell: string; wikiText: string }
}

/**
 * The persisted/served overlay (Task #36). `messages` is the learned registry; `corrections`
 * is the subset the buffs model should APPLY over spells.json (verified single-spell landing
 * messages the DB was missing, and contradiction fixes). Versioned so a schema change can
 * invalidate a stale on-disk snapshot.
 */
export interface MessageOverlay {
  version: number
  /** When this overlay was last derived (ISO). */
  updatedAt: string
  /** The full learned message registry (for the audit UI). */
  messages: OverlayMessage[]
  /** Summary counts for the diagnostics header. */
  stats: { verified: number; shared: number; contradictions: number; unknown: number }
}

/** buffs module snapshot: live active buffs + mined per-spell stats + the message overlay. */
export interface BuffsSnap {
  active: ActiveBuff[]
  stats: Record<string, BuffStat>
  /** The observed-message overlay (Task #36) — for the diagnostics/audit UI. */
  overlay?: MessageOverlay
}
/** buffs module delta: the module ships a full snapshot each flush (small state). */
export type BuffsDelta = BuffsSnap

// ----- Spell database (Task #34) -----
//
// A committed, scraped catalog of EQ Legends spells from the wiki (Template:Spellpage).
// It is the PRIOR/TRUTH for buff durations and the source of the exact chat messages a
// spell prints when it lands / wears off — which lets the parser emit PRECISE buffApply/
// buffWearOff events (message-driven, not cast-timing-mined). See scripts/scrape-spells.ts
// and src/main/data/spellDb.ts (the derived lookup tables + parser injection).

/** One scraped spell (a Template:Spellpage page). Fields are best-effort; null when the
 *  wiki page omits/uses an unparseable value (the raw text is retained where useful). */
export interface SpellEntry {
  /** Spell name (page title / spellname field). Rank variants are separate entries. */
  name: string
  /** Raw duration text from the wiki ("27 minutes", "instant", a level formula). */
  durationText?: string
  /** Parsed duration in ms; null when durationText is unparseable/absent/instant. */
  durationMs: number | null
  /** Casting time in ms (from casting_time seconds), when present. */
  castTimeMs?: number
  /** target_type ("Single Friendly (or Self)", "Single Hostile", …). */
  targetType?: string
  /** spell_type ("Beneficial" / "Detrimental"). */
  spellType?: string
  /** classes text ("Enchanter - Level 26"). */
  classes?: string
  /** msg_cast_on_you — printed to the caster when it lands on THEM ("A cool breeze …"). */
  msgCastOnYou?: string
  /** msg_cast_on_other — printed when it lands on someone else ("Someone looks tranquil."). */
  msgCastOnOther?: string
  /** msg_wears_off — printed when the buff fades ("The cool breeze fades."). */
  msgWearsOff?: string
  /** True when the effects/description text mentions an Illusion (Permanent Illusion AA). */
  illusion: boolean
  /** mana cost, when present. */
  mana?: number
  /**
   * THE WIKI'S NUMBERED EFFECT LIST, VERBATIM (JOS-251) — one string per `{{SpellSlotRow}}` on
   * the page, in the order the page prints them:
   *
   *   ["Charm (up to L37)", "Decrease Magic Resist by 4 (L27) to 8 (L60)"]
   *
   * RAW, and deliberately so. Wiki markup is stripped exactly the way every other field's text
   * is (`clean()` in the scrape — links, bold, tags), and NOTHING else is normalised: no
   * lower-casing, no re-ordering, no interpretation. The two phrasings the wiki uses for the same
   * effect ("Charm up to level 37" and "Charm (up to L37)") both survive here as written, because
   * the file's job is to record what the wiki said. What the strings MEAN is a separate,
   * deletable layer — `src/main/data/spellEffectClass.ts` — for the reason the corrections overlay
   * exists: a scrape rewrites this file wholesale, so anything we conclude must not live in it.
   *
   * Absent when the page carries no slot list at all. The slot NUMBER is not kept: it is the
   * list's own ordinal for every page but the seven that write `?`, and no reader needs it.
   */
  effects?: string[]
  /**
   * The bard pages' `Enhanced by instrument?` row, verbatim ("Yes", "No", "Required",
   * "Yes (just the resists debuff)"). It is a row of the same slot table but is not an effect, so
   * it gets its own field rather than polluting `effects`. Absent on the ~95% of pages (every
   * non-song) that have no such row.
   */
  instrumentEnhanced?: string
  /**
   * THE WIKI BADGES THIS SPELL'S PAGE OUT OF ERA (JOS-393) — DERIVED AT LOAD, never in spells.json.
   *
   * `src/main/data/spellEra.ts` joins it from the era sidecar (`pageEra.json`, written by
   * `scripts/scrape-page-era.ts` off eqlwiki's own `action=eqlmetadata` predicate — the same one
   * that decides whether the wiki draws its red pill on a link). The spell scrape rewrites
   * `spells.json` wholesale, so a verdict from a DIFFERENT scrape cannot live in it; the field is
   * attached by the loader, exactly as the corrections and removals overlays are applied there.
   *
   * `true` OR ABSENT, and never `false`. The endpoint answers `false` both for a page it files as
   * classic and for a page nobody has classified, and the table is silent for a name it was never
   * asked about — so the only thing worth carrying is the positive claim. A surface reads an absent
   * field as "nothing to say", which is exactly what it is.
   */
  outOfEra?: boolean
}

/** The committed spells.json shape: metadata + the spell list. */
export interface SpellDbFile {
  scrapedAt: string
  count: number
  spells: SpellEntry[]
  /**
   * Scrape schema version — bumped when the scraper starts capturing a new per-spell field, so a
   * consumer can tell an old committed file from a new one instead of guessing from absent keys.
   * 2 = the effect list + instrument flag (JOS-251). Absent means 1 (pre-JOS-251).
   */
  schema?: number
  /** How many spells carry a non-empty `effects` list — scrape health at a glance. */
  withEffects?: number
}

// ----- Suggested-alerts wizard (Task #38) -----
//
// A slim, searchable catalog derived from spells.json + live usage. For each spell the
// renderer needs just enough to (a) filter/sort (name, buff/debuff, illusion, usageCount)
// and (b) know which one-click alert TEMPLATES the spell database can actually support —
// each template maps to a LogEvent kind that can genuinely fire (validated against
// logEvents.ts + the AlertsModule matcher). Built in main from the effective DB; usage is
// folded in from the buffs module's snapshot stats (per-spell sample count `n`).

/** Which suggested-alert templates a spell supports (a template is offered only when its
 *  trigger can actually fire — gated by the DB fields the parser needs). */
export interface SpellTemplateFlags {
  /** Beneficial-class + has a wears-off message → "wears off you" (buffExpired ∪ buffWearOff). */
  wearsOff: boolean
  /** Beneficial-class → "fades on your pet/target" (kind: buffFade). */
  fade: boolean
  /**
   * Beneficial-class + a cast-on-YOU message → "lands on you" (kind: buffApply, target 'self').
   *
   * THE HOLE IT FILLS (JOS-318). `lands` is DETRIMENTAL-only — it was written for a debuff landing
   * on a mob and gates on the cast-on-OTHER sentence — so a beneficial spell had no landing chip at
   * all, even though the parser emits a perfectly good `buffApply {target:'self'}` for it off the
   * DB's `msgCastOnYou`. A druid who clicked everything the wizard offered for `Flowering Heal` got
   * `fade` (which needs a wear-off line the spell does not print) and `landsOnOther` (which fires
   * when it lands on somebody ELSE), and nothing at all for the case they were asking about: the
   * heal landing on THEM. That is report 3JM1ZD, and it is the same shape as report
   * 01KZZXVW888E09C088QBRD5HCD one spell along the same shaman ladder.
   *
   * The gate is the cast-on-you message and nothing else, because that message IS the parser's key:
   * `SpellDb.castOnYou` is an exact-text map built from it, so a spell that has one can emit the
   * event and a spell that does not never can. Placeholder stubs are already `undefined` by the time
   * this is read (spellDb.ts `applyPlaceholderMessages`), so a `You .` cannot buy a chip.
   */
  landsOnYou: boolean
  /**
   * The wiki's effect list says the spell HEALS OVER TIME → "while it is healing" (kind: `heal`,
   * pinned to the spell name).
   *
   * THE ONE LINE A HoT CANNOT FAIL TO PRINT (JOS-318). `<healer> healed <target> over time for N hit
   * points by <Spell>.` names the spell verbatim and WITHOUT its rank, so this trigger is immune to
   * both failure modes the two reports hit: a wiki row whose landing/wear-off sentences are missing
   * or wrong (Slugs Healing states neither — its scrape says `You .`), and a spell that has been
   * upgraded since the alert was written (the cast line says `Slugs Healing VII`, this line says
   * `Slugs Healing`). Every other spell template rests on a sentence the wiki had to get right.
   *
   * Gated on the DERIVED effect class (`spellEffectClass.ts healOverTime`) plus a beneficial nature,
   * not on `spellType`: the shaman ladder is typed `Heal Over Time` but `Tortoises Healing` and the
   * whole druid seeded-heal family are typed plain `Beneficial`, and reading what the spell DOES
   * finds all of them. Measured: of the 19 spells the owner's log prints a tick for, the roster
   * reads 18 — the miss is not in spells.json at all.
   */
  healsOverTime: boolean
  /**
   * Detrimental-class + a cast-on-other message the parser can actually MATCH → "lands on a
   * target" (kind: buffApply). The second half of that gate is not decoration: the message has
   * to yield a `castOnOtherSuffix`, or no buffApply is ever emitted for the spell and the
   * suggestion is dead on arrival (spellDb.ts `suggestionTemplates`).
   */
  lands: boolean
  /**
   * Has a cast-on-other message whose SUBJECT can be turned into a named capture → "lands on
   * someone, and say who" (a `raw` trigger with `(?<player>…)`, JOS-103).
   *
   * Deliberately NOT gated on beneficial/detrimental. It is the only template that covers a
   * spell somebody else casts ON you or your group — Spirit of the Puma is the reported case —
   * and "who did this land on" is a question worth asking of a buff and a debuff alike.
   */
  landsOnOther: boolean
  /**
   * A CROWD-CONTROL spell the parser's `ccSpell` roster claims → "the hold broke" (kind: `cc`
   * with `refresh:true`, pinned to this spell's name).
   *
   * THE HOLE IT FILLS (JOS-161). `wearsOff` is beneficial-only and rests on the derived
   * `buffExpired`, which the buffs module synthesizes ONLY from an authoritative wear-off
   * message. A mez on a mob has neither: `Your <Song> spell has worn off of <mob>.` is claimed
   * by `classifyWornOff` and becomes a `cc` refresh, and the silent hygiene cull that retires an
   * unwitnessed hold emits nothing on purpose. So a bard who reached for "alert me when this
   * expires" found no template that could fire and no trigger they could hand-write that would —
   * which is the report this ticket came from, and it was true of every mez and root in the game.
   * The curated "Mez / root broke" GROUP already fires on this event; what did not exist was the
   * per-spell version, and it is the per-spell version a user goes looking for by name.
   *
   * The roster is the gate for the usual reason: the flag is a CLAIM the alert can fire, and a
   * spell `ccSpell` does not match parses to `buffFade` instead, where this trigger never sees it.
   */
  breaks: boolean
  /**
   * A CHARM spell the parser's `charmSpell` roster claims → "the charm broke" (kind: `uncharm`,
   * pinned to this spell's name).
   *
   * THE TWIN OF `breaks`, AND WHY IT IS A SEPARATE FLAG (JOS-200). The same sentence — `Your <X>
   * spell has worn off of <mob>.` — becomes `uncharm` for a charm and `cc {refresh:true}` for a
   * mez/root, so the two rosters answer to two different EVENTS and one template cannot author
   * both triggers. Until now only the mez half had a per-spell offer: the curated "Charm break"
   * GROUP fired for every charm at once, but a user who went looking for their charm BY NAME —
   * which is what all three JOS-200 reporters did, and what a bard reaching for Solon's Bewitching
   * Bravura does — found nothing. An enchanter searching "Allure" had the identical hole.
   *
   * Same gate argument as `breaks`: the flag is a CLAIM the alert can fire, and a spell
   * `charmSpell` does not match parses to `cc` or `buffFade` instead, where this trigger never
   * sees it.
   */
  charmBreaks: boolean
}

/** One catalog row: a spell the wizard can build alerts for. */
export interface SpellCatalogEntry {
  /** Canonical (lowercased, rank-stripped) key — the stable id for suggestion ids. */
  key: string
  /** Display name (DB casing). */
  name: string
  /** 'Beneficial' | 'Detrimental' | undefined (unknown). */
  spellType?: string
  /** True when the spell is an Illusion (offered the shared illusion-fade suggestion). */
  illusion: boolean
  /** Which one-click alert templates this spell supports. */
  templates: SpellTemplateFlags
  /**
   * The `raw` trigger pattern the `landsOnOther` template uses, with the subject as a named
   * capture — e.g. `^\[[^\]]*\] (?<player>[A-Za-z' \`]{1,48}) growls with the spirit of the puma\.`
   * Present exactly when `templates.landsOnOther` is true.
   *
   * AUTHORED IN MAIN, not in the renderer, and that is deliberate. The anchor and the name
   * character class are the two things that keep this pattern unreachable through a chat line
   * (shared/alertCaptures.ts `subjectCapturePattern`), so the pattern is derived ONCE, beside the
   * DB it is derived from, and travels to the wizard as a finished string. A renderer that
   * rebuilt it from a message would be a second implementation of a security property.
   */
  castOnOtherCapture?: string
  /**
   * The DB's stated duration in ms, or absent when the wiki states none / states "Instant".
   *
   * ONE READER TODAY, and it is a COOLDOWN rather than a display (JOS-318): the `healsOverTime`
   * suggestion fires on a tick line that repeats every six seconds for the whole duration, so its
   * def is authored with a cooldown of the spell's own duration and one cast makes one sound. The
   * figure is the wiki's and is a FLOOR in this app (spellCorrectionsList.ts's WRONG NUMBER note),
   * which is the right direction for a cooldown: it can let a re-cast through early, never swallow
   * one late.
   */
  durationMs?: number
  /** How often the buffs model has observed this spell (land→fade sample count `n`); 0 = never. */
  usageCount: number
  /**
   * Newest event ts (ms epoch) this spell was seen live (last cast/apply/fade), or null when
   * never seen (Task #45). The wizard sorts USED spells by this DESC (recency over
   * frequency), tie-breaking on usageCount, then the never-used alphabetical tail.
   */
  lastSeenMs?: number | null
  /**
   * SPELL-LINE INTELLIGENCE. `key` is already the rank-folded line key, so a catalog row IS a
   * line; these two fields make that explicit.
   *
   * `classLevels` — the DB's per-class entry level for the LINE ("Enchanter 16"). The wiki DB
   * has no per-RANK rows at all (only 42 of 1,926 spells form a multi-rank family), so this is
   * never a level for a specific rank and the UI must not present it as one.
   *
   * `rankNames` — every DISPLAY name in this line that the DB knows, ascending by rank
   * ("Rune I" … "Rune V"). The LOG knows more ranks than the DB does (it casts
   * "Mesmerization III" where the DB has only "Mesmerization"), so the renderer unions these
   * with the ranks observed in AlertsSnap.spellLastCast — see shared/spellLines.ts.
   */
  classLevels?: { cls: ClassAbbr; level: number }[]
  rankNames?: string[]
  /**
   * THE SEARCH SURFACE, prejoined and LOWERCASED once in main (spellDb.ts `searchTextFor`).
   *
   * Name + every rank display name + the spell's three message texts (cast-on-you /
   * cast-on-other / wears-off), separated by a space. The messages are what make the dialog's
   * search comprehensive without inventing an effect taxonomy: "slower" finds the spells whose
   * landing emote says it, "dispelled" finds the dispel family, and none of that is a curated
   * list that can go stale (world-model law 1 — the message IS the ground truth).
   *
   * Prejoined because the renderer filters per KEYSTROKE across ~1.6k rows: the per-row work
   * must stay ONE substring test against ONE string (AGENTS.md UI conventions — the search key
   * is computed per data change, never per keystroke). Built server-side so even that is paid
   * once, at catalog build.
   */
  searchText: string
}

/** Reply of `spells:catalog`: the catalog + summary stats for the wizard header. */
export interface SpellCatalog {
  entries: SpellCatalogEntry[]
  /** Total spells in the DB. */
  total: number
  /** How many entries have usageCount > 0 (the "frequent" set). */
  withUsage: number
  /** Whether ANY illusion spell exists (the shared illusion-fade suggestion is offerable). */
  hasIllusions: boolean
}
