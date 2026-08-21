// THE REGISTRY VALIDATOR FOR SUBJECT PLACEHOLDERS (JOS-412).
//
// A SWEEP IS NOT A GUARANTEE, AND THIS FILE IS THE DIFFERENCE. `spellCorrectionsSubjects.ts` is a
// LIST — one measured entry per proven sentence — and a list only ever knows about the reports that
// reached it. JOS-174 swept `Odium` (shaman 43) and its own junior rank `Curse` (shaman 34) stayed
// unmatchable until a second reporter noticed from the same overlay, ten days and one GitHub issue
// later. Nothing in the tree had ever ASKED which spells were in that state.
//
// This module asks, on every load, and `tests/spellSubjectAudit.test.mts` pins the answer as a
// CENSUS: a spell that becomes unmatchable this way — by a re-scrape, by a new page, by a
// correction that rots — is a failing test on the next run, not a report six weeks later. It is the
// same move the pack registry made after the 47-pack drop (JOS-162): run the repo's own validators
// against the live data and read what they say, rather than trusting the data because it is ours.
//
// ─────────────────────────────────────────────────────────────────────────────
// WHAT MAKES A LANDING UNMATCHABLE, RESTATED FROM THE MATCHER.
//
// `buildSpellDb` keys the cast-on-other table on `castOnOtherSuffix(msg)` — the tail left after
// stripping the wiki's `Someone ` subject, and NOTHING else strips. So a third-person message
// written with any other subject (`Target staggers under a dark curse.`) or with none at all
// (`'s wounds fester.`) yields no suffix, the spell is in NO table, its live line classifies as
// `{kind:'unknown'}`, and no `buffApply` is ever emitted for it. No bar, no alert, no candidate
// list, no pet binding. That is one arithmetic fact and it is what this file computes.
//
// TWO VERDICTS, because the two populations need different answers and lumping them together is how
// a census stops being actionable:
//
//   `wrongSubject`  The message BEGINS with a subject placeholder that is not `Someone`. The wiki
//                   has DECLARED that a name goes there, so the repair is a one-token swap and
//                   nothing about the sentence is guessed. `restored` carries the exact repair.
//   `noSubject`     The message carries no placeholder at all — the wiki cropped the subject. The
//                   repair is a CLAIM about a cropped sentence rather than a token swap, so
//                   `restored` is null and a row here needs its own evidence like any correction.
//
// AND ONE FLAG THAT DECIDES HOW MUCH A ROW COSTS. `spellUnreachable` is false when ANOTHER row of
// the same spell name keys a suffix — the scrape carries era/rank duplicates, and a message
// correction writes the FIRST row of a name only (`spellCorrections.ts rowsFor`), so a duplicate
// row's wrong subject is unfixable BY THIS MECHANISM and costs nothing, because the spell is
// already reachable through the row that keys. `Illusion: Air Elemental`, `Ring of South Ro` and
// `Dustdevil` are in exactly that state today. A row that is unreachable is a spell the app can
// never resolve to its own landing; that is the number a reader should watch.
//
// ─────────────────────────────────────────────────────────────────────────────
// THE FIRST-PERSON HALF, WHICH IS THE MIRROR DEFECT AND IS MEASURED EMPTY.
//
// `castOnYou` and `wearsOff` are EXACT-TEXT maps — a first-person sentence splices no name into
// itself, so there is no suffix question and the whole message is the key. Which means a THIRD-
// PERSON placeholder in one of those fields is unmatchable for the opposite reason: the log will
// never print the literal word `Target`. Measured over the committed registry: ZERO today. It is
// audited anyway and pinned at zero, because "the scrape has never done this" is exactly the kind
// of claim a re-scrape falsifies quietly, and the cost of asking is one regex per field.
//
// WHAT THIS FILE DOES NOT DO: it does not fix anything, and it must not. A repair is DATA and goes
// through the corrections overlay with the evidence bar `spellCorrectionsList.ts` states — a
// validator that silently rewrote the registry would be the blanket subject-stripper JOS-174
// measured and refused, wearing a different hat.
//
// AND IT IS NOT PART OF THE LOAD. `loadSpellDb` does not call it and must not: the edge to
// `spellDb.ts` is ONE-WAY at runtime (this file imports `castOnOtherSuffix`; nothing there imports
// this), which is the same discipline `rulesets.ts` keeps with its `import type`. The audit runs
// where the registry's other validators report — `pipeline.ts`, over `loadSpellDb().spells`, which
// IS the effective list — and in `tests/spellSubjectAudit.test.mts`, which is the half that fails a
// build.

import type { SpellEntry } from '../../shared/types'
import { castOnOtherSuffix } from './spellDb'

/** Why a third-person landing yields no suffix. See the header — the two need different repairs. */
export type SubjectVerdict = 'wrongSubject' | 'noSubject'

/** One registry row whose third-person landing message the suffix table cannot key. */
export interface UnkeyableLanding {
  /** `SpellEntry.name`, as the EFFECTIVE registry spells it (post-removals, post-corrections). */
  spell: string
  /** The message the row carries, verbatim — the thing a correction's `from` must equal. */
  message: string
  verdict: SubjectVerdict
  /**
   * The one-token repair for a `wrongSubject` row — the same sentence with `Someone` in the
   * placeholder's place, which is precisely what a `spellCorrectionsSubjects.ts` entry's `to`
   * states. Null for `noSubject`, where there is no token to swap and the repair is a claim.
   */
  restored: string | null
  /** True when NO row of this spell name keys a suffix — the spell itself is unmatchable. */
  spellUnreachable: boolean
}

/** A first-person field carrying a third-person placeholder — the mirror defect, measured empty. */
export interface MisplacedSubject {
  spell: string
  field: 'msgCastOnYou' | 'msgWearsOff'
  message: string
}

/** What one audit pass found, for the startup line and for the census test. */
export interface SubjectAuditReport {
  /** Every unkeyable third-person landing row, in registry order. */
  landings: UnkeyableLanding[]
  /** Rows whose `msgCastOnYou`/`msgWearsOff` names a third person and so can never match. */
  firstPerson: MisplacedSubject[]
  /** `landings` split by verdict, so a boot line can say which population moved. */
  wrongSubject: number
  noSubject: number
  /** The names of spells with NO keyable row at all — the ones that cost a user something. */
  unreachable: string[]
}

/**
 * The wiki's subject vocabulary MINUS the one the table keys on, with the possessive spellings the
 * scrape actually writes (`Target's`, and the wiki's spaced `Someone 's` form for the others).
 *
 * NOT a copy of `alertCaptures.SUBJECT_TOKENS` and not a copy of `spellDb.BARE_SUBJECTS`, for the
 * reason those two already state about each other: the three answer different questions. That one
 * asks which leading placeholder can become a name capture (so it INCLUDES `Someone`); the bare
 * list asks whether a message is nothing but a subject (so it includes `You`). This one asks which
 * placeholder the suffix table cannot key, which is every third-person token except `Someone`.
 */
const WRONG_SUBJECT_RE = /^(?:Target|Player|Soandso|Other_Player)\b/

/** Any third-person placeholder, `Someone` included — the first-person half's whole test. */
const ANY_SUBJECT_RE = /^(?:Someone|Target|Player|Soandso|Other_Player)\b/

/** The one-token repair, or null when the message carries no placeholder to swap. */
export function restoreSubject(message: string): string | null {
  if (!WRONG_SUBJECT_RE.test(message)) return null
  return message.replace(WRONG_SUBJECT_RE, 'Someone')
}

/** Every name the registry can resolve a third-person landing for — one keyable row is enough. */
function reachableNames(spells: readonly SpellEntry[]): ReadonlySet<string> {
  const reachable = new Set<string>()
  for (const s of spells) {
    if (s.msgCastOnOther && castOnOtherSuffix(s.msgCastOnOther) !== null) reachable.add(s.name)
  }
  return reachable
}

/**
 * VALIDATE THE EFFECTIVE REGISTRY. Pure over the spell list it is handed — no cache, no I/O, no
 * Electron — so the audit test can run it against a hand-built list as easily as against the
 * committed one, and `loadSpellDb` can run it against the entries the parser is really about to
 * read (after removals, durations, corrections and the placeholder pass, not before).
 */
export function auditSpellSubjects(spells: readonly SpellEntry[]): SubjectAuditReport {
  const reachable = reachableNames(spells)
  const landings: UnkeyableLanding[] = []
  const firstPerson: MisplacedSubject[] = []
  const unreachable = new Set<string>()
  for (const s of spells) {
    if (s.msgCastOnYou && ANY_SUBJECT_RE.test(s.msgCastOnYou)) {
      firstPerson.push({ spell: s.name, field: 'msgCastOnYou', message: s.msgCastOnYou })
    }
    if (s.msgWearsOff && ANY_SUBJECT_RE.test(s.msgWearsOff)) {
      firstPerson.push({ spell: s.name, field: 'msgWearsOff', message: s.msgWearsOff })
    }
    if (!s.msgCastOnOther || castOnOtherSuffix(s.msgCastOnOther) !== null) continue
    const restored = restoreSubject(s.msgCastOnOther)
    const spellUnreachable = !reachable.has(s.name)
    if (spellUnreachable) unreachable.add(s.name)
    landings.push({
      spell: s.name,
      message: s.msgCastOnOther,
      verdict: restored === null ? 'noSubject' : 'wrongSubject',
      restored,
      spellUnreachable
    })
  }
  return {
    landings,
    firstPerson,
    wrongSubject: landings.reduce((n, r) => n + (r.verdict === 'wrongSubject' ? 1 : 0), 0),
    noSubject: landings.reduce((n, r) => n + (r.verdict === 'noSubject' ? 1 : 0), 0),
    unreachable: [...unreachable]
  }
}
