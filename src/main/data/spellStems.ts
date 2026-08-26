// ============================================================================
// spellStems.ts — THE TWO CROWD-CONTROL ROSTERS, AS COMMITTED DATA (JOS-499 item 2).
// ============================================================================
//
// `CHARM_STEMS` and `CC_STEMS` were written in `log/rulesets.ts` because that is where the parser
// config was assembled. They are not parser machinery: they are a statement about which spells in
// the shipped catalog charm and which hold, and their readers outlive the fold. `data/spellDb.ts`
// builds the alert catalog off them (the `breaks` template is gated on `CC_STEMS`, its
// `charmBreaks` twin on `CHARM_STEMS` — AGENTS.md, JOS-161) and `tests/charmCcRoster.test.mts`
// re-derives both families from `spells.json` on every run.
//
// WHY ITS OWN LEAF RATHER THAN INSIDE `spellDb.ts`, which is where the brief pointed. Two reasons,
// and the second is the one that decided it:
//
//   * `spellDb.ts` imports `CC_STEMS`/`CHARM_STEMS` FROM `rulesets.ts` today, while `rulesets.ts`
//     imports `charmRoster` from `spellEffectClass.ts` — a cycle that works only because of what
//     each side reaches for first. Putting the stems in a leaf both files import removes the cycle
//     instead of reversing it, which is the difference between a fix and a coin flip.
//   * `max-lines 400` is a lint gate here, and `spellDb.ts` is already a large file. Forty lines of
//     roster plus the argument they carry would have spent a budget this ticket has no business
//     spending, and the ratchet is the integrator's to widen, never a worker's.
//
// THE PATTERNS ARE VERBATIM. Not one character of either alternation is changed — these are join
// keys against the shipped catalog and a "tidy" would silently reclassify a spell. The full
// argument for every member, the Solon's-songs ruling and the derived-roster half-swap all stay in
// `rulesets.ts`'s header until that file is deleted, and the surviving half of it lands here.
//
// THE `.` IN `Kelin.s` / `Largo.s` / `Solon.s` IS DELIBERATE, and is the same trick `SLOW_SPELLS`
// uses: EQ writes possessives with both an apostrophe and a backtick, so one character class
// covers the pair. It is not a typo and must not be "corrected" to `'`.

/**
 * THE CHARM ROSTER (fallback arm). Since JOS-251 `charmSpell` is DERIVED from each spell page's
 * numbered effect list (`spellEffectClass.ts charmRoster`), and this alternation is the fallback
 * for a name the catalog does not carry — which is the only case left, because the derived set is
 * keyed by `spellCanonKey` and therefore already answers a ranked log name (`Allure VII`).
 *
 * `\bcharm\b(?! of )` is the negative-lookahead that keeps `Naki's Charm of Pernicity` out: a name
 * stem matched substrings of NAMES, which is the drift class `spellEffectClass.ts` opens with, and
 * anchoring at the head of the effect sentence is what fixed it there.
 */
export const CHARM_STEMS =
  /\bcharm\b(?! of )|beguile|\ballure\b(?! of death)|alluring whispers|cajol|dictate|besiege|agacerie|beckon|command of druzzil|dominate|thrall of bones|enslave death|befriend animal|call of karana|tunare.s request|solon.s ((bewitching )?bravura|song of the sirens)/i

/**
 * THE HOLD ROSTER. Still stems ON PURPOSE (AGENTS.md): the derived hold roster disagrees on 19
 * spells including `Ensnare`, reconciling the two is an owner ruling, and the derivation's answer
 * is pinned in `tests/spellEffectClass.test.mts` waiting for it. Do not swap this one to the
 * derived set without that ruling.
 *
 * BOTH OF SOLON'S SONGS ARE IN THE CHARM ROSTER ABOVE, NOT HERE (JOS-200 ruling). A spell has one
 * effect: leaving `song of the sirens` in both would make it the only member satisfying both
 * rosters, which the roster oracle refuses outright.
 */
export const CC_STEMS =
  /mesmeriz|enthrall|entranc|dazzle|screaming terror|ensnar|immobiliz|suffocat|kelin.s lucid lullaby|pixie strike|sionachie.s dreams/i
