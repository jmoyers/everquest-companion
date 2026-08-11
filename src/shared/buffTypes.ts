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
   * logged cast that beat the floor wins. Provenance in `estimatorSource`. Null when neither is
   * available (n=0, no DB duration).
   */
  estimateMs?: number | null
  /** Where `estimateMs` came from: 'db' (floor held) | 'observed' (a logged cast beat it). */
  estimatorSource?: 'db' | 'observed'
  /**
   * The newest event ts (ms epoch) this spell was seen — the last castBegin / apply / fade
   * involving it (Task #45). The RECENCY signal the suggested-alerts wizard sorts by (recent
   * spells over merely-frequent ones). Absent when the spell was never seen live.
   */
  lastSeenMs?: number | null
}

/** A currently-active (landed, not yet faded) buff INSTANCE = (spell, target entity). */
export interface ActiveBuff {
  spell: string
  /** buff vs debuff — a SPELL property (Task #35), not who it's on. */
  cls: BuffClass
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
   * Where `estimatedMs` came from (JOS-117):
   *   'db'       — the spell-database baseline held (no logged cast beat it).
   *   'observed' — a logged cast beat the floor: max over the recent sample window.
   *   undefined  — no estimate (n=0 and no DB duration).
   */
  durationSource?: 'db' | 'observed'
  /**
   * THE BUFFS/TIMER OVERLAY's countdown duration (ms). Since JOS-117 this is the SAME estimator the
   * Buffs TAB uses — max(DB floor, recent observed max) — so both surfaces agree; a below-base
   * click-off no longer becomes the overlay number (JOS-114's most-recent-sample rule did exactly
   * that, showing Swift at ~28m for a 33:36 buff) and a focus-extended duration is honoured. Null
   * for a permanent buff, or when there is no floor and no sample (the overlay counts UP). See
   * buffsStats.ts `estimateFor` and shared/buffTimers.ts `timerModeOf`.
   */
  overlayDurationMs?: number | null
  /** Where `overlayDurationMs` came from: 'db' (floor held) | 'observed' (a logged cast beat it). */
  overlaySource?: 'db' | 'observed'
  /**
   * True when this buff is PERMANENT (Task #34): an illusion-flagged spell the player
   * self-cast while the Permanent Illusion AA is owned (self-cast illusions last forever
   * on the player). The UI shows "permanent · illusion AA" and no countdown.
   */
  permanent?: boolean
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
}

/** The committed spells.json shape: metadata + the spell list. */
export interface SpellDbFile {
  scrapedAt: string
  count: number
  spells: SpellEntry[]
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
