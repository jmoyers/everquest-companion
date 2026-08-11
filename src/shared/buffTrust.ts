// buffTrust.ts — WHOSE SPELL IS THIS, AND WHOSE DURATION ARE WE ENTITLED TO LEARN FROM (JOS-140).
//
// The buffs/debuffs model has exactly one way in: a landing sentence is admitted only when a CAST
// LINE anchors it (ruling 2). This module is the vocabulary of that anchor — who the caster of an
// anchor may be, and the one preference that widens it.
//
// THE DEFAULT IS YOU AND NOBODY ELSE. EQ prints a landing sentence as a BROADCAST: `<mob> has been
// mesmerized.` and `<ally> is resistant to magic.` name no caster at all, so in a crowded zone the
// only thing separating your work from a stranger's is that you have a `You begin casting <X>.`
// line and they do not. That is the whole of `SELF_CASTER`, and it is why the externals list ships
// EMPTY: an allowlist is the user saying "this person is in my group and I want their work on my
// bars", never something the app infers from proximity.
//
// AN ANCHOR IS EVIDENCE THE CASTER CAST, IN WHATEVER FORM THE LOG STATES IT — the begin-casting
// line is ONE form and not the definition (owner amendment, 2026-08-09, from live testing). Three
// forms exist, and all three are first-person or allowlisted:
//   `You begin casting <S>.` / `You begin singing <S>.`  — names the spell, so it narrows.
//   `You activate Quick Buff.`                           — names NO spell: a WINDOW, not a name.
//   `<Name> begins casting <S>.`                         — the third-person cast line, allowlist only.
// The Quick Buff AA applies many spells at once with no cast line of their own (measured: one
// activation, eleven landings in the same second across the player AND a charmed pet), so a rule
// that demanded a per-spell cast line would refuse the player's own buffs. What it may NOT do is
// name a spell it has no evidence for: a burst landing whose sentence is shared by several spells
// stays a FAMILY and states a duration only when the candidates agree on one.
//
// AND THE EXTERNAL PATH IS THE SAME PATH. A name on this list does not get a looser rule; it gets
// the identical one, anchored on `<Name> begins casting <Spell>.` — the third-person cast line the
// log really prints (measured in a reporter's own slice: two distinct player names casting in a
// fifteen-minute window). No allowlisted name, no anchor, no bar.
//
// WHAT THE LEARNER DOES WITH IT (ruling 4). A duration is a fact about a CASTER: their AAs, their
// focus items, their rank. So a sample is keyed on (rank-stripped spell LINE, caster) and never
// pooled across casters — your 44-second mez and a grouped enchanter's 31-second one are two
// answers to two different questions, and averaging them would give you a bar that is wrong for
// both. Ranks WITHIN one caster ARE pooled, which is the owner overruling the investigation's A2:
// the committed spell DB has no rank VI+ rows at all, so a per-rank key would start every upgrade
// back at the DB floor and re-learn from zero on every level.
//
// Lives in shared/ because both ends need it: main folds it into the model, the renderer's
// Preferences card edits it, and the normalizer must be the same code in both places.

/** The sentinel caster key for the player themselves. Never a name — names are foldable. */
export const SELF_CASTER = 'self'

/** How many external casters a user may allowlist. A preference, not a roster import. */
export const MAX_EXTERNAL_CASTERS = 16

/** The longest name we will store. EQ character names are short; this only bounds abuse. */
export const MAX_CASTER_NAME_CHARS = 32

/**
 * The per-caster externals allowlist (ruling 4's option), as it is persisted.
 *
 * `externals` holds DISPLAY spellings, in the order the user added them, because that is what the
 * Preferences list shows back to them. Matching is always case-insensitive — world-model law 2:
 * names are dirty, canonicalize at the boundary, display raw.
 */
export interface BuffTrustPrefs {
  externals: string[]
}

/** Nobody but you. The shipped default, and the one this app is designed around. */
export const DEFAULT_BUFF_TRUST_PREFS: BuffTrustPrefs = { externals: [] }

/** A caster name folded to its comparison key (world-model law 2). */
export function casterKey(name: string): string {
  return name.trim().toLowerCase()
}

/**
 * A name is storable when it is a bare name: non-empty, short, and free of the characters a log
 * line uses as structure. This is not a guess at EQ's naming rules — it is a refusal to store
 * something that could never match a cast line anyway.
 */
function storableName(raw: unknown): string | null {
  if (typeof raw !== 'string') return null
  const t = raw.trim()
  if (t.length === 0 || t.length > MAX_CASTER_NAME_CHARS) return null
  if (/[[\]'"\n\r\t]/.test(t)) return null
  if (casterKey(t) === SELF_CASTER || casterKey(t) === 'you') return null
  return t
}

/**
 * The ONE normalizer, run by the store reader, the IPC setter and the renderer alike (the
 * `graphicsPrefs` precedent). Anything it cannot read becomes the default rather than an error:
 * a hand-edited settings file must not be able to stop the app folding buffs.
 */
export function normalizeBuffTrustPrefs(raw: unknown): BuffTrustPrefs {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return { externals: [] }
  const list = (raw as { externals?: unknown }).externals
  if (!Array.isArray(list)) return { externals: [] }
  const seen = new Set<string>()
  const externals: string[] = []
  for (const entry of list) {
    const name = storableName(entry)
    if (name === null) continue
    const key = casterKey(name)
    if (seen.has(key)) continue
    seen.add(key)
    externals.push(name)
    if (externals.length >= MAX_EXTERNAL_CASTERS) break
  }
  return { externals }
}

/** Add a name, preserving order and refusing duplicates. Returns the same object when nothing changed. */
export function addExternalCaster(prefs: BuffTrustPrefs, name: string): BuffTrustPrefs {
  const next = normalizeBuffTrustPrefs({ externals: [...prefs.externals, name] })
  return next.externals.length === prefs.externals.length ? prefs : next
}

/** Remove a name (case-insensitively). Returns the same object when the name was not there. */
export function removeExternalCaster(prefs: BuffTrustPrefs, name: string): BuffTrustPrefs {
  const key = casterKey(name)
  const externals = prefs.externals.filter((n) => casterKey(n) !== key)
  return externals.length === prefs.externals.length ? prefs : { externals }
}

/**
 * The gate itself: may a cast line by `casterName` anchor a landing?
 *
 * `undefined` (or the self sentinel) is the player and is always allowed. Anyone else must be on
 * the list — there is no "in my group" shortcut, because the roster changes without the user
 * choosing it and this preference is a choice.
 */
export function casterTrusted(prefs: BuffTrustPrefs, casterName: string | undefined): boolean {
  if (casterName === undefined) return true
  const key = casterKey(casterName)
  if (key === SELF_CASTER || key === 'you') return true
  return prefs.externals.some((n) => casterKey(n) === key)
}

/**
 * THE LEARNER'S KEY (ruling 4): one rank-stripped spell line, one caster. Kept here rather than in
 * the stats store so the two halves of the model — the buff instances and the crowd-control holds
 * — cannot end up computing it differently, which is precisely how the two systems this ticket
 * unifies drifted apart in the first place.
 *
 * The separator is a `|`, which no spell line and no EQ name contains. (An earlier instance key in
 * this repo used a raw NUL for the same reason; a NUL in a source file makes git treat it as
 * binary, so it is spelled `String.fromCharCode(0)` there and simply avoided here.)
 */
export function learnKey(lineKey: string, caster: string): string {
  return `${lineKey}|${caster}`
}
