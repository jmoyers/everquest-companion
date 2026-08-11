// Suggested-alert templates + id convention (Task #38).
//
// The ONE place that maps a spell (catalog entry) → the exact AlertDef a one-click
// suggestion authors. Kept separate from the dialog so the id convention is a single source
// of truth: the wizard uses it to build defs AND to detect already-created suggestions
// (checked/disabled), and AGENTS.md documents it.
//
// ID CONVENTION:  `suggest:<spellKey>:<template>`
//   spellKey = the catalog entry's canonical (lowercased, rank-stripped) key.
//   template ∈ 'wearsOff' | 'fade' | 'lands' | 'landsOnOther' | 'breaks' | 'charmBreaks'.
//   Illusion is the SHARED, deduped suggestion `suggest:illusion:fade` (one alert for the
//   generic `Your illusion fades.` line, which names no spell — see logEvents.ts IllusionFade).
//
// Each template's trigger was validated to actually fire in the AlertsModule against a
// matching synthetic LogEvent (scripts/_task38_harness.mts): the `where.spell` matcher tests
// the event's `spell` field case-insensitively; illusionFade carries no spell field, so its
// suggestion has no `where`.

import type { AlertDef, LogEventKind, SpellCatalogEntry } from '@shared/types'
// RELATIVE value import, not `@shared/*` (repo law, the mobSearch.ts precedent): this module is
// now NODE-TESTED — tests/suggestedAlertsFire.test.mts pushes the defs it authors through the
// real parser and the real AlertsModule — and the alias resolves only through the vite/tsconfig
// path map, so an aliased VALUE import makes the module unloadable under tsx. That it was
// unloadable is part of why JOS-84 shipped: no test could ever have run a real suggestion def.
import { spellIdFragment, parseSpellRank } from '../../../../shared/spellLines'
import type { SpellRank } from '@shared/spellLines'

export type TemplateKind =
  | 'wearsOff'
  | 'fade'
  | 'lands'
  | 'landsOnOther'
  | 'breaks'
  | 'charmBreaks'

/**
 * RANK-AWARE templates (spell levelling intelligence). Everything above is rank-LESS by
 * construction: the fade / wears-off / landing lines the parser matches drop the roman-numeral
 * suffix, so an alert on them survives every rank change untouched. Two families keep the
 * suffix, and those are the ones worth pinning to a rank — and the ones the upgrade offers
 * exist for:
 *   castRank   `You begin casting Mesmerization III.`      → castBegin { spell }
 *   resistRank `<mob> resisted your Mesmerization III!`     → resist { caster:'you', spell }
 * Both shapes were verified against the real log (359 and 136 occurrences for that one rank).
 */
export type RankTemplateKind = 'castRank' | 'resistRank'

/** UI + authoring metadata for each template. */
export const SUGGEST_TEMPLATES: Record<
  TemplateKind,
  {
    chip: string
    kind: LogEventKind
    verb: string
    sound: string
    where?: (name: string) => Record<string, string>
    /** A SECOND event kind the same def also fires on, as an `any` composite. See `wearsOff`. */
    alsoKind?: LogEventKind
    /**
     * This template authors a `raw` capture trigger instead of an event one, and the pattern
     * comes off the catalog entry (`castOnOtherCapture`). See `landsOnOther`.
     */
    raw?: true
  }
> = {
  // Beneficial: the DUAL-DEFAULT expiry (Task #47). The user's directive — "the wears off for
  // you is different than for somebody else … build good sane defaults that help with both by
  // default." The buffs module emits a RESOLVED `buffExpired { spell, target }` for BOTH sides:
  // a self message wears-off (target 'self') AND a fade on your pet/target (target = its name).
  // So ONE simple trigger `{buffExpired, where:{spell}}` (target omitted → matches any) fires
  // whether the buff wears off YOU or your pet — the sane both-sides default, no composite
  // needed for this template. (The composite machinery still ships for user-authored combos.)
  //
  // WIDENED TO A COMPOSITE (JOS-103), because the derived event alone covers only the buffs YOU
  // cast. `buffExpired` is synthesized by the buffs module when it RESOLVES a wear-off against
  // its active set — and the module's OWN-CAST GATE (buffs.ts `onBuffApply`, the user's rule "if
  // something isn't cast by me we shouldn't track it") means a buff a GROUPMATE cast on you never
  // becomes an active instance, so nothing is ever resolved and no buffExpired is ever emitted.
  // MEASURED for Spirit of the Puma: `You begin to snarl as your features become feline.` →
  // `The spirit of the puma departs.` yields buffApply + buffWearOff and ZERO derived events.
  // Every group buff in the game is in that state — which is most of the buffs a player actually
  // wants a wear-off alert for.
  //
  // The raw `buffWearOff` is the other half: EQ prints the wears-off emote to the buff's HOLDER,
  // so the event always means "this wore off YOU", whoever cast it. An `any` composite covers
  // both, and the two can never double-fire in practice: the derived event is stamped with the
  // PRIMARY event's ts (buffs.ts `emitBuffExpired`), so both arrive at the same millisecond and
  // the alert's own cooldown swallows the second. One chip, both sides, one sound.
  wearsOff: {
    chip: 'When it wears off (you or your pet)',
    kind: 'buffExpired',
    verb: 'wears off',
    // "A moment of your time, if you'd be so kind."
    sound: 'input-required-input-required-01',
    where: (name) => ({ spell: name }),
    alsoKind: 'buffWearOff'
  },
  // Beneficial: JUST the pet/named-target fade side (target-only), for users who want to
  // separate it from the self-side. Uses the raw buffFade the parser already emits.
  // "That, as they say, is that."
  fade: {
    chip: 'When it fades on pet/target only',
    kind: 'buffFade',
    verb: 'fades',
    sound: 'resource-limit-resource-limit-09',
    where: (name) => ({ spell: name })
  },
  // Detrimental + cast-on-other: the debuff landing on a target.
  //
  // THE TRIGGER NAMES A FAMILY, NOT A SPELL (JOS-84), and it has to. EQ prints ONE landing
  // sentence for a whole spell line — `<mob> slows down.` is five spells, `<mob> looks frail.`
  // is three — so `buffApply.spell` is a documented BEST-EFFORT first candidate and pinning an
  // alert to it was a coin flip the user always lost: a v0.10.0 enchanter created this exact
  // suggestion for Shiftless Deeds and the parser handed the matcher "Forlorn Deeds", so it
  // never fired once. The def below is UNCHANGED; what changed is that a `where.spell` matcher
  // now tests the event's whole candidate list (main/modules/alerts.ts `spellCandidateNames`),
  // which means this alert fires when the SENTENCE its spell prints appears — and cannot tell
  // you which member of the family printed it, because the log does not say.
  // "Consider this my opening move."
  lands: {
    chip: 'When it lands on a target',
    kind: 'buffApply',
    verb: 'lands',
    sound: 'task-acknowledge-task-acknowledge-05',
    where: (name) => ({ spell: name })
  },
  // THE CAPTURE TEMPLATE (JOS-103) — "who did this land on?", answered out loud.
  //
  // THE REPORTED CASE, and why it cannot be an event trigger. Spirit of the Puma's cast-on-other
  // message is `Target growls with the spirit of the puma.` The suffix table that drives
  // `buffApply` is keyed by what is left after stripping the wiki's "Someone " subject, and this
  // message does not use that subject — so it is not in the table, and MEASURED against the
  // owner's own log, `[Sat Aug 01 18:38:10 2026] Fail growls with the spirit of the puma.` parses
  // to kind `unknown`. There is no typed event for this family. A `raw` trigger is not a shortcut
  // taken here; it is the only thing that exists.
  //
  // THE PATTERN IS NOT WRITTEN HERE. It arrives on the catalog entry as `castOnOtherCapture`,
  // authored in main by `subjectCapturePattern` (shared/alertCaptures.ts), because its two
  // security properties — the `^\[…\] ` timestamp anchor and the name-shaped character class —
  // are what stop a stranger typing the sentence into guild chat and having their text captured
  // and spoken. Read that module's threat model before touching this.
  //
  // IT SPEAKS, AND IT ALSO PLAYS. `audio:'both'` rather than 'speech': a suggestion the APP
  // authors has to be audible on a machine with no speech voices at all, and `speechPlan`
  // (lib/speech.ts) falls back to the pack sound only when the TEXT is empty — never when the
  // engine is missing. The sound is the guaranteed half; the spoken name rides behind it.
  // "Consider this my opening move."
  landsOnOther: {
    chip: 'When it lands on someone (say who)',
    kind: 'buffApply', // unused for this template — see `raw`; kept so the record shape is total.
    verb: 'lands on someone',
    sound: 'task-acknowledge-task-acknowledge-05',
    raw: true
  },
  // Crowd control: the HOLD ENDING, per spell (JOS-161).
  //
  // WHY IT IS NOT `wearsOff`. That template is beneficial-only and rests on the derived
  // `buffExpired`, which the buffs module synthesizes only from an AUTHORITATIVE wear-off message.
  // A mez on a mob has none: `Your <Song> spell has worn off of <mob>.` is claimed by
  // `classifyWornOff` and becomes `cc {refresh:true}` (that is how the "Mez / root broke" group has
  // always fired), and the hygiene cull that retires an unwitnessed hold is deliberately silent. So
  // a bard asking for "tell me when my mez expires" had nothing to click and nothing to hand-write
  // — the reported defect, and it was true of every mez and root in the game, not just this ladder.
  //
  // `refresh:'true'` is what separates the BREAK from the landing: the same `cc` kind carries both,
  // and only the break shape names a spell (the landing carries `candidates`). The group alert
  // pins the same key for the same reason (shared/alertGroups.ts `group:cc:broke`).
  //
  // THE HONEST LIMIT, restated from that group because it is the same sentence: EQ prints this line
  // whether the hold ran its course or a nuke broke it early. This alert is "it ended", never "it
  // ended early", and it is named that way.
  // "It has all gone rather pear-shaped."
  breaks: {
    chip: 'When the mez/root breaks',
    kind: 'cc',
    verb: 'broke',
    sound: 'task-error-task-error-08',
    where: (name) => ({ spell: name, refresh: 'true' })
  },
  // The CHARM breaking, per spell (JOS-200) — `breaks`'s twin, and a different EVENT.
  //
  // WHY IT IS NOT `breaks`. One sentence, two rosters, two events: `classifyWornOff` tests
  // `charmSpell` first and emits `uncharm`, then `ccSpell` and emits `cc {refresh:true}`. A charm
  // break therefore never carries `refresh`, and the mez template's trigger cannot see it — which
  // is exactly what three bards hit in a row (JOS-200: Solon's Bewitching Bravura was in the wrong
  // roster AND had no charm-shaped chip to click even once it moved).
  //
  // WHY IT EXISTS BESIDE THE GROUP. `shared/alertGroups.ts` has fired "Charm break" for every
  // charm at once since JOS-69, but a user goes looking by SPELL NAME — an enchanter typing
  // "Allure", a bard typing "Bravura" — and until now the search surface had nothing for them.
  // Same argument the per-spell mez break made in JOS-161, applied to the other roster.
  //
  // NO `refresh` KEY, deliberately: `uncharm` carries `mob` and `spell` and nothing else, so
  // pinning the name is the whole trigger. Measured for JOS-200 over the owner's whole log: 3,382
  // of 3,383 `Your <X> spell has worn off of <mob>.` lines are rank-less, so the catalog's display
  // name is the string the sentence actually carries.
  //
  // SAME SOUND AS THE SEEDED CHARM-BREAK ALERT (`SOUND.charmBreak` in shared/alertGroups.ts, and
  // DEFAULT_ALERT_SOUNDS.charmBreak in main): a user who owns both hears one charm-break voice.
  // "I find myself... requiring your attention."
  charmBreaks: {
    chip: 'When the charm breaks',
    kind: 'uncharm',
    verb: 'charm broke',
    sound: 'input-required-input-required-02',
    where: (name) => ({ spell: name })
  }
}

/** UI metadata for the two rank-pinned templates. `chip` takes the rank display name. */
export const RANK_TEMPLATES: Record<
  RankTemplateKind,
  { chip: (rank: string) => string; kind: LogEventKind; verb: string; sound: string }
> = {
  castRank: {
    chip: (rank) => `When you cast ${rank}`,
    kind: 'castBegin',
    verb: 'cast',
    // "Consider this my opening move."
    sound: 'task-acknowledge-task-acknowledge-05'
  },
  resistRank: {
    chip: (rank) => `When ${rank} is resisted`,
    kind: 'resist',
    verb: 'resisted',
    // a dry error read — it was shrugged off.
    sound: 'task-error-task-error-01'
  }
}

/** A concrete suggestion: the template it came from + the exact AlertDef it authors. */
export interface Suggestion {
  template: TemplateKind | RankTemplateKind | 'illusion'
  def: AlertDef
  /** the rank display name a rank-pinned suggestion targets (absent for rank-less ones). */
  rank?: string
}

/**
 * The default sound pack — the ONE pack the app ships, the pack every picker
 * pre-selects (AlertsView), and the pack the seeded built-ins + these suggestions use.
 * Mirrors DEFAULT_ALERT_PACK_ID / DEFAULT_ALERT_SOUNDS in src/main/data/defaultPacks.ts
 * — repeated as literals because the renderer bundle can't import from src/main. Keep
 * the two in sync (the ids there carry the spoken line each one is).
 */
export const DEFAULT_PACK_ID = 'alan-rickman'
/** Default cooldown for a suggested alert (ms). */
const DEFAULT_COOLDOWN_MS = 3000

function suggestionId(spellKey: string, template: TemplateKind): string {
  return `suggest:${spellKey}:${template}`
}

/** Function words a spell name hides its distinctive noun behind. */
const NAME_FUNCTION_WORDS: ReadonlySet<string> = new Set(['of', 'the', 'de', 'in', 'a', 'an'])

/**
 * The DISTINCTIVE word of a spell name, for the default spoken phrase — "Spirit of the Puma" →
 * "Puma", "Ward of Calliav" → "Calliav", "Clarity" → "Clarity".
 *
 * WHY NOT `spellFirstWord`. The speech resolver already has a shortest-utterance mode and it
 * takes the FIRST word, which is right for "Swift Like the Wind" and useless for the whole
 * "<something> of the <something>" family: "Spirit" names Spirit of Wolf, Spirit of the Puma,
 * Spirit of the Scorpion, Spirit of Bih`Li and a dozen more. The rule here is one line — take the
 * words after the LAST function word, else the first word — and it is AUTHORING ONLY: it picks
 * the default text of an editable phrase and renames nothing. `speechFirstWord` is untouched.
 *
 * MEASURED over the committed DB (1,926 spells): 48 names resolve to more than one word and the
 * rest to exactly one. Its known weak case is the leading possessive — "Sha's Lethargy" → "Sha's"
 * — which is a worse-sounding default and not a wrong one, and the user edits the phrase.
 */
export function spellShortName(name: string): string {
  const words = parseSpellRank(name).base.trim().split(/\s+/).filter(Boolean)
  if (words.length === 0) return name.trim()
  let last = -1
  for (let i = 0; i < words.length; i += 1) {
    if (NAME_FUNCTION_WORDS.has(words[i].toLowerCase())) last = i
  }
  return last >= 0 && last < words.length - 1 ? words.slice(last + 1).join(' ') : words[0]
}

/**
 * The trigger one template authors for one spell.
 *
 * Three shapes, and the branch order is the record's own declaration order: a `raw` capture
 * template (`landsOnOther`), a two-kind `any` composite (`wearsOff`), and the plain event trigger
 * every other template has always authored. A `landsOnOther` for an entry with no
 * `castOnOtherCapture` is unreachable — `suggestionsFor` gates on `templates.landsOnOther`, which
 * main sets only when it also wrote the pattern — but it degrades to the event shape rather than
 * throwing, because a suggestion that crashes the wizard is worse than one that is merely dull.
 */
function buildTrigger(entry: SpellCatalogEntry, template: TemplateKind): AlertDef['trigger'] {
  const t = SUGGEST_TEMPLATES[template]
  const where = t.where ? t.where(entry.name) : undefined
  if (t.raw && entry.castOnOtherCapture) return { type: 'raw', regex: entry.castOnOtherCapture }
  if (t.alsoKind) {
    return {
      type: 'any',
      conditions: [
        { type: 'event', kind: t.kind, ...(where ? { where } : {}) },
        { type: 'event', kind: t.alsoKind, ...(where ? { where } : {}) }
      ]
    }
  }
  return { type: 'event', kind: t.kind, where }
}

/** Build the AlertDef for one (spell, template) pair. */
function buildDef(entry: SpellCatalogEntry, template: TemplateKind): AlertDef {
  const t = SUGGEST_TEMPLATES[template]
  const def: AlertDef = {
    id: suggestionId(entry.key, template),
    name: `${entry.name} ${t.verb}`,
    enabled: true,
    trigger: buildTrigger(entry, template),
    sound: { packId: DEFAULT_PACK_ID, soundId: t.sound },
    cooldownMs: DEFAULT_COOLDOWN_MS,
    note: `Suggested alert (Task #38/#47) - ${template} for ${entry.name}.`
  }
  if (template === 'landsOnOther') {
    // The shipped demonstration of capture substitution (JOS-103): the phrase names the group the
    // pattern declares, so this def SAYS "Puma on Fail". `{player}` matches the group name
    // `subjectCapturePattern` authors; if the two ever disagree the token renders literally,
    // which is visible in the editor's preview rather than silent.
    def.audio = 'both'
    def.speech = { mode: 'custom', phrase: `${spellShortName(entry.name)} on {player}` }
  }
  return def
}

/**
 * Build the AlertDef for one (rank, rank-template) pair. The trigger pins the DISPLAY name
 * with its suffix, which is exactly what makes the def go stale on a level-up — and exactly
 * what `detectRankUpgrades` (shared/spellLines.ts) looks for.
 */
function buildRankDef(entry: SpellCatalogEntry, rank: string, template: RankTemplateKind): AlertDef {
  const t = RANK_TEMPLATES[template]
  // resist carries a caster field: pin it to YOUR casts so a pet's or a bystander's resist of
  // the same spell never fires the alert (the parser sets caster='you' for your own — Task #51).
  const where: Record<string, string> =
    template === 'resistRank' ? { caster: 'you', spell: rank } : { spell: rank }
  return {
    id: `suggest:${entry.key}:${template}:${spellIdFragment(rank)}`,
    name: `${rank} ${t.verb}`,
    enabled: true,
    trigger: { type: 'event', kind: t.kind, where },
    sound: { packId: DEFAULT_PACK_ID, soundId: t.sound },
    cooldownMs: DEFAULT_COOLDOWN_MS,
    note: `Suggested alert - ${template} for ${rank}.`
  }
}

/**
 * All suggestions the spell DB supports for this catalog entry (excludes the shared illusion
 * one). When a `rank` is supplied — the MOST RECENTLY CAST rank of the entry's line, per the
 * owner's ordering rule — the two rank-pinned templates are offered as well.
 */
export function suggestionsFor(entry: SpellCatalogEntry, rank?: SpellRank | null): Suggestion[] {
  const out: Suggestion[] = []
  if (entry.templates.wearsOff) out.push({ template: 'wearsOff', def: buildDef(entry, 'wearsOff') })
  if (entry.templates.fade) out.push({ template: 'fade', def: buildDef(entry, 'fade') })
  if (entry.templates.lands) out.push({ template: 'lands', def: buildDef(entry, 'lands') })
  if (entry.templates.landsOnOther) {
    out.push({ template: 'landsOnOther', def: buildDef(entry, 'landsOnOther') })
  }
  if (entry.templates.breaks) out.push({ template: 'breaks', def: buildDef(entry, 'breaks') })
  // Disjoint with `breaks` by construction — `charmSpell` is tested first in classifyWornOff, so
  // the two rosters cannot both claim a spell (tests/charmCcRoster.test.mts pins that).
  if (entry.templates.charmBreaks) {
    out.push({ template: 'charmBreaks', def: buildDef(entry, 'charmBreaks') })
  }
  // Rank-pinned chips are offered only for a rank we have actually SEEN cast: a rank the log
  // has never printed cannot be confirmed to exist for this character, and an alert on a
  // spelling we guessed would sit there silently forever.
  if (rank?.lastCastMs != null) {
    out.push({ template: 'castRank', rank: rank.name, def: buildRankDef(entry, rank.name, 'castRank') })
    if (entry.spellType === 'Detrimental') {
      out.push({
        template: 'resistRank',
        rank: rank.name,
        def: buildRankDef(entry, rank.name, 'resistRank')
      })
    }
  }
  return out
}

/** The single, shared illusion-fade suggestion (deduped — one alert for any illusion). */
export function illusionSuggestion(): Suggestion {
  return {
    template: 'illusion',
    def: {
      id: 'suggest:illusion:fade',
      name: 'Illusion fades',
      enabled: true,
      trigger: { type: 'event', kind: 'illusionFade' },
      // "It has all gone rather pear-shaped."
      sound: { packId: DEFAULT_PACK_ID, soundId: 'task-error-task-error-08' },
      cooldownMs: DEFAULT_COOLDOWN_MS,
      note: 'Suggested alert (Task #38) - fires when your illusion clicks/wears off.'
    }
  }
}
