// SPELLS THE WIKI CARRIES AND THE GAME DOES NOT HAVE (JOS-337).
//
// `spells.json` is a SCRAPE of eqlwiki's `Template:Spellpage`, and `scripts/scrape-spells.ts`
// rewrites it wholesale — so a spell deleted out of it by hand comes back on the next re-scrape,
// exactly the way a hand-edited SENTENCE comes back. `spellCorrectionsList.ts` is the file that
// solved that for sentences; this is the same arrangement for the one thing a correction cannot
// express. The wiki dataset stays PRISTINE and IDEMPOTENT under re-scrape, and everything we know
// that the wiki does not lives beside it: five drift classes of wrong WORDS over there, and over
// here the sixth, which is not a drift in the words at all.
//
// THE DRIFT CLASS. eqlwiki documents EverQuest as the fan community has known it across decades of
// clients. EQ Legends is a particular server running a particular build, and it does not have
// every page the wiki has. When the wiki carries a spell the game lacks, nothing about the entry
// is misspelled: its messages are fine, its name is fine, its classes and levels are fine, and
// every one of them is a fact about a spell that is not there. The corrections layer patches four
// fields — `msgCastOnYou`, `msgCastOnOther`, `msgWearsOff`, `name` — and there is no assignment to
// any of them that makes a nonexistent spell stop existing.
//
// WHY IT MATTERS AT ALL, and it is not the parser this time. A message for a spell nobody can cast
// is inert: no line ever matches it, and the cost is a candidate in a list. What is NOT inert is
// everything that reads the DB as a CATALOG and shows it to the player as something they can act
// on. `buildLevelUnlocks` joins `classes` to level and the New-at-this-level panel offers the
// spell as a thing to go buy at 22, 24 and 30. `buildSpellCatalog` offers it in the alert wizard as
// a thing to set a sound for. Both are the app telling the owner, in his own words, to go do
// something the game will not let him do — which is the same failure the corrections layer exists
// to prevent, arriving from the opposite direction. A correction fixes an alert that can never
// fire; a removal withdraws an offer that can never be taken.
//
// ---------------------------------------------------------------------------------------------
// THE EVIDENCE BAR — this class's own, and it CANNOT be the corrections bar
// ---------------------------------------------------------------------------------------------
//
// Read the corrections bar first (`spellCorrectionsList.ts`, THE EVIDENCE BAR) and then notice
// that all four of its rules rest on the same instrument: counting occurrences of a sentence in
// 1.6M lines of the owner's log. Rule 1 wants zero of the wiki's text, rule 2 wants some of the
// replacement's, rules 3 and 4 read the two against each other. That instrument is not merely
// unavailable here — the corrections file already states, in so many words, why pointing it at an
// absence gives a wrong answer:
//
//     "The large majority of 'the DB says a sentence the log never prints' is not drift at all: a
//      DETRIMENTAL spell you cast lands on a MOB, so its msgCastOnYou and msgWearsOff print to the
//      MOB and are unobservable in your own log forever. … Absence of evidence is not evidence of
//      drift."
//
// The same sentence, one word changed, is why zero log lines can never remove a spell. A spell may
// be missing from a log because it is not in the game, because this character's classes cannot
// cast it, because nobody standing near him cast it, because it is detrimental and its lines print
// to somebody else, or because he simply never bothered. Five explanations, one observation, and
// the log cannot separate them. A layer that deleted rows on a zero count would delete hundreds of
// real spells, and it would do it silently.
//
// So the instrument is a PERSON. The bar is:
//
//   1. AN EXPLICIT, DATED OWNER VERIFICATION, PER ENTRY. Somebody with the game open looked for
//      this spell — in the spellbook, at the vendor, wherever it should be — and it was not there.
//      The date is `verified`, a required field rather than a line of prose, because it is the
//      only evidence this class has and a claim about a live service goes stale: a patch can add
//      the spell back, and a reader in six months needs to know how old the look was. ONE ENTRY,
//      ONE SPELL. The corrections layer can settle a family with one measurement because the
//      siblings share the sentence being measured; nobody's one look settles a family, and
//      `SpellRemoval` is singular so that no entry can pretend otherwise.
//
//   2. A STATED MECHANICAL REASON WHERE ONE EXISTS — AND `null` WHERE ONE DOES NOT. A verification
//      says "it is not there". A mechanical reason says "and here is the system it belonged to,
//      which is also not there", which is a far broader claim: it would license removing every
//      other spell in the same family, and the first entry below is precisely the case where
//      somebody nearly did. The field is held to its own bar, separately, and `null` is a real
//      answer that costs the entry nothing — rule 1 alone admits it.
//
//   3. THE REMOVAL MUST BE THE ONLY FIX. If the game HAS the spell under another name, that is
//      drift class five and it is a `name` correction, not a removal (`Solon's Bravura` was one
//      look away from being deleted for exactly this reason). If the game has it with different
//      words, that is classes one through four. A removal is admitted only where there is no
//      sentence, no name and no field that would make the row true.
//
//   4. SAY WHAT THE REMOVAL DOES NOT TAKE WITH IT. A row's messages are frequently SHARED (world
//      model law 3), and dropping one owner of a shared sentence must not be mistaken for dropping
//      the sentence. Each entry states which of its texts survive under other spells, because that
//      is the sentence a reader will otherwise go looking for after the row is gone.
//
// AND THE BOUNDARY THE WHOLE LAYER SITS ON: THIS REMOVES WHAT THE APP OFFERS, NEVER WHAT IT CAN
// DESCRIBE. A removal is the statement "no player can go and learn this spell", and that is a
// narrower statement than "this name means nothing". The first entry below is also the case that
// proves the difference: SEVEN items in the committed corpus carry an `Invigor` effect — Frozen
// Efreeti Boots, Tolan's Darkwood Boots, Mrylokar's Greaves, Singing Steel Vambraces, Camii's
// Bracer of Vigor, Abram's Axe of the Stoic, Orb of the Crimson Bull — and the gear planner joins
// an item's `Effect:` line to the spell page of the same name to print its one-liner
// (`planner/effectIndex.ts`). Feeding that join a list this layer has shortened would blank the
// description on seven real, obtainable items in order to hide a spell scroll: a regression bought
// with a fix. So the seam is applied where the app makes an OFFER (the level-unlock cards, the
// alert wizard's catalog, the parser's own tables) and deliberately NOT where it merely explains
// something the player is holding. `tests/spellRemovals.test.mts` enumerates every importer of the
// scrape and makes each one state which side of that line it is on.
//
// WHAT THIS FILE IS NOT FOR, stated so the reader can tell it apart from what it is for:
//
//   * A SPELL NOBODY LOOKED FOR. "It has no log lines and it looks like an old mechanic" is the
//     shape of every wrong removal, and it is not admissible. See the first entry: the pure
//     stamina-loss family has SEVEN more members and exactly one of them has been verified.
//   * AN ERA GATE. `spells.json` carries Kunark and Velious rows on purpose, and content this
//     server has not opened yet is not content the wiki got wrong. If a whole expansion needs
//     hiding, that is a filter with an era column behind it, not a hand list of names.
//   * A SPELL A CLASS CANNOT USE. `classes` already answers that, and `parseSpellClasses` already
//     drops what it cannot place. A spell the owner's loadout cannot cast is still in the game.
//
// ---------------------------------------------------------------------------------------------
// THE TOMBSTONE — what a re-scrape does to an entry, in both directions
// ---------------------------------------------------------------------------------------------
//
// The corrections layer gets its anti-rot guard for free: every correction restates the text it
// replaces, so a wiki that moves out from under it reports `stale` and the suite goes red. A
// removal has nothing to restate. It names a row and deletes it, and the only two states it can
// observe are "the row is here" and "the row is not".
//
// SO THE DECISION IS EXPLICIT, AND IT FOLLOWS `from: null`. That correction shape faces the same
// shortage — an ABSENT field has no text to compare — and resolves it by making absence itself the
// match condition: `from: null` applies while the field is empty, and reports `satisfied` the
// moment a re-scrape supplies the same text, because the world has arrived where the entry was
// pointing. A removal is that argument with the row in place of the field. If a future re-scrape
// drops the page naturally — the wiki editors notice, the template stops emitting it, the spell
// list shrinks — then the entry has got exactly what it asked for, and it reports `satisfied`. It
// does NOT fail the suite. `RemovalsReport` therefore has no `stale` list and no `unknownSpells`
// list; there is no third state for it to describe.
//
// THE ENTRY STAYS. A satisfied removal is a TOMBSTONE and is kept, which is the one place this
// layer's advice differs from the corrections layer's (whose header says an upstream fix means "we
// can drop it"). The wiki is a live, editable document and a re-scrape is a data change, not a
// refresh: a page that vanished in June can be restored in July by one editor, and the entry is
// the only record that somebody once opened the game and looked. Deleting it would mean the spell
// silently reappears in the unlock panel the next time somebody re-scrapes, with nothing in the
// tree remembering why it should not. `satisfied` is reported by NAME in the boot line so a
// tombstone that has been dead for years is visible rather than merely cheap.
//
// AND THE TYPO IS CAUGHT SOMEWHERE ELSE, WHICH IS THE PRICE OF THAT DECISION — stated plainly
// because it is the honest cost. A misspelled `spell` name and a naturally-dropped page are
// indistinguishable at run time: both are entries that match nothing. So the guard cannot be the
// report, and it is not: `tests/spellRemovals.test.mts` asserts by NAME, per entry, what the
// committed DB looks like after the pass. A new removal is authored against the committed
// spells.json in the same commit, where a typo removes nothing and the named acceptance fails
// immediately. That is a weaker guard than the corrections layer's and it is the strongest one
// this class admits.
//
// A REMOVED SPELL MAY NOT ALSO BE CORRECTED. The two lists are applied in order — removals, then
// corrections — so a correction naming a removed row would report `unknownSpells` at load and fail
// the corrections audit. That is a real backstop and it is not the guard: the audit refuses the
// pair STATICALLY, by reading both lists, so the contradiction is reported as what it is (two
// entries that disagree about whether a spell exists) rather than as a rotted correction.
//
// ---------------------------------------------------------------------------------------------
// THE DUPLICATE PAGE — the second claim this layer can make, and its own instrument (JOS-440)
// ---------------------------------------------------------------------------------------------
//
// Everything above is one claim: EQ LEGENDS DOES NOT HAVE THIS SPELL. `supersededBy` is a second,
// narrower one: THE WIKI DOCUMENTS THIS SPELL TWICE AND THIS PAGE IS THE COPY EQ LEGENDS IS NOT
// RUNNING. The two are not the same statement and must not be filed under one bar, because after
// an absence removal the DB says nothing about the spell at all, while after a superseded removal
// the spell is still there — under the name `supersededBy` states, offered by every surface, with
// its own row's facts. Nothing is withdrawn from the player. A DUPLICATE is.
//
// WHY IT BELONGS HERE AND NOT IN THE CORRECTIONS LAYER, which is the obvious first guess. A
// correction patches FIELDS, and the surfaces that fold two rows into one line do not merge fields
// — `db.byKey`, `dbRowFor` and `spellRows` all take the FIRST row of the name, in the scrape's own
// `localeCompare` order. So when two pages disagree about a NUMBER, renaming them together does
// not pick the right answer; it picks whichever page happens to sort first, and the corrections
// layer has no field for `mana`, `castTimeMs`, `targetType` or `durationText` with which to argue.
// The only lever that decides WHICH row answers is whether the other row is in the list, and that
// lever is this file. (Measured on JOS-440: a bare `name` correction re-joined the twins and handed
// the joined card the stale page's 30 mana and 5.00 s cast.)
//
// AND THE INSTRUMENT IS DIFFERENT, WHICH IS THE PART THE BAR ABOVE COULD NOT HAVE ANTICIPATED.
// Rule 1 makes a PERSON the instrument because absence cannot be measured from a log, and it is
// right about that. But a superseded entry is not asking about absence: it asks WHICH OF TWO
// DESCRIPTIONS this client runs, and the client answers that itself. `spells_us.txt` — the game's
// own complete spell table, which this repo already parses (`src/main/resist/spellTable.ts`,
// JOS-396's "the client's slots answer where the page does not") — states the id, the name, the
// cast time, the duration and the mana for every spell the client has. It is not a log and it is
// not a sample: a page whose numbers contradict it describes some other client. So `verified` for
// this kind is the date the client table was read, `evidence` restates the row it was read from as
// DATA (id and figures, so a reader need not have the install), and `reason` keeps its own bar
// exactly as before.
//
// THE THREE OBLIGATIONS A SUPERSEDED ENTRY CARRIES, all checked in `tests/spellRemovals.test.mts`:
//
//   1. `supersededBy` NAMES A ROW THAT SURVIVES THE WHOLE LOAD — removals and corrections both.
//      An absence entry leaves nothing behind and is asserted that way; this one must leave the
//      spell standing, or it is an absence removal wearing the wrong label.
//   2. THE SURVIVOR MAY BE A RENAME TARGET, and on JOS-440 it is. The original audit refused any
//      removal whose `spell` is a name a correction PRODUCES, for a stated reason: such an entry
//      "would silently match nothing and report itself satisfied". That hazard is real and it is
//      already caught twice over — `report.satisfied` must be empty and `report.removed` must
//      equal the entry count, both asserted against the committed scrape — so the audit is now
//      narrowed to the hazard rather than to the shape. The second hazard the blanket rule also
//      covered (a re-scrape renames the surviving page UPSTREAM, both rows end up sharing the name,
//      and the removal eats both) is caught by that same `removed === entries` assertion going to
//      three, which is a red suite and not a silent loss.
//   3. IT STILL SAYS WHAT IT DOES NOT TAKE WITH IT (rule 4), and for a duplicate that is a sharper
//      question than usual, because the two pages share most of their sentences by construction.
//
// THE MECHANISM IS NEXT DOOR. `spellRemovals.ts` holds the types, the report and
// `applySpellRemovals` — which is what every consumer imports, and which re-exports this list so
// the seam is one import. The two are apart only because this one is a DATA file that grows by one
// entry per defect and the repo's max-lines ceiling is about code mass; keeping the prose above
// beside the entries it governs is the whole point of the split.

import type { SpellRemoval } from './spellRemovals'

/**
 * The removals, ordered oldest first. There is no family grouping here of the kind the corrections
 * list uses, because there are no families: an absence entry is one spell and one person's one
 * look, and a `supersededBy` entry is one wiki page and one reading of the client's own table.
 */
export const SPELL_REMOVALS: readonly SpellRemoval[] = [
  // --- INVIGOR: the classic stamina buff the owner cannot find in EQ Legends ---------------------
  //
  // THE REPORT (owner directive, 2026-08-13). The New-at-this-level panel offered Invigor to a
  // PAL/RNG/SHM loadout at 22, 24 and 30 — three cards for a spell the owner says the game does not
  // have. One row in the scrape, `Decrease Stamina Loss by 35`, CLR 9 / PAL 22 / DRU 14 / SHM 24 /
  // ENC 24 / RNG 30. Nothing about the row is misspelled, which is what made it this layer's first
  // entry rather than a correction.
  //
  // WHAT THE REMOVAL DOES NOT TAKE WITH IT (bar rule 4). Both of Invigor's messages are SHARED with
  // `Extinguish Fatigue` (CLR 19 / DRU 29 / SHM 39 / ENC 44 / RNG 52), verbatim: `Your body zings
  // with energy.` and `Someone looks energized.` Dropping this row therefore changes no message
  // table at all — both sentences keep an owner, and a line that printed either would still
  // resolve. The only thing that changes is who the app OFFERS, which is the entire point.
  //
  // AND THE MECHANICAL REASON IS `null`, WHICH IS THE PART WORTH READING (bar rule 2). The ticket
  // proposed one — "the classic stamina-loss mechanic does not exist in EQL" — and the owner's own
  // log refutes it, which is exactly why rule 2 exists as a separate bar rather than as a clause of
  // rule 1. MEASURED, whole-log over `eqlog_Primitive_freeport.txt` (1,668,301 lines, 2026-08-13):
  //
  //     `Jaxan's Jig o' Vigor` (Bard 3) states ONE effect and it is `Decrease Stamina Loss by 10
  //     (L3) to 25 (L60)` — a pure stamina-loss spell with no second effect to carry it. Its
  //     cast-on-you sentence, `The jig sends energy zinging through your body.`, occurs 1,028 times
  //     in the owner's log; its wear-off, `You are no longer invigorated.`, 6 times; and at
  //     09:12:26 on the first of those days the log reads `Beginning to memorize Jaxan's Jig o`
  //     Vigor...`, so the owner was playing the bard who sang it. The mechanic was in the client he
  //     played.
  //
  //     THE HONEST QUALIFIER: all 1,028 landings fall on Sun Jul 19 2026, which is BEFORE official
  //     launch (2026-07-28, the epoch anchor) and is the only day the owner has played a bard. So
  //     the measurement establishes that the mechanic existed in the pre-launch client and does not
  //     establish that it survived to 2026-08-13. It does not need to: it is enough to show the
  //     wider claim was never checked, and an unchecked reason must not be written down as a fact
  //     that would license removing the seven other pure-stamina rows beside this one (Extinguish
  //     Fatigue, Jaxan's Jig o' Vigor, Word of Vigor, Cantana of Soothing, Cantana of
  //     Replenishment, Acumen, and the Yaulp ladder's stamina component).
  //
  // SO THE ENTRY RESTS ON RULE 1 AND NOTHING ELSE, which is what rule 1 is for: the owner looked
  // for Invigor and it was not there. That admits Invigor and admits nothing else, and the seven
  // siblings stay in the DB until somebody looks for them too.
  //
  // THE EFFECT IS NOT THE SPELL, and for this row that is a measurement rather than a caveat: the
  // committed items corpus carries SEVEN items whose `Effect:` is `Invigor` (Frozen Efreeti Boots,
  // Tolan's Darkwood Boots, Mrylokar's Greaves, Singing Steel Vambraces, Camii's Bracer of Vigor,
  // Abram's Axe of the Stoic, Orb of the Crimson Bull), five of them clickies a player equips and
  // uses. The removal says no player can go and LEARN Invigor; it does not say the name means
  // nothing, and the gear planner's one-liner join is exempted from this layer for exactly that
  // reason — see the boundary paragraph in the header, and the exemption table in the suite.
  //
  // ONE OBSERVATION THAT CUTS THE OTHER WAY, recorded rather than suppressed: the log carries a
  // single General-chat line from a stranger shopping for an Invigor spell scroll (Sun Jul 19
  // 2026). It is a third party's speech, so it is not quoted here and could never enter a fixture
  // (AGENTS.md's scrub law), and it proves nothing either way — a player can want a spell the
  // server does not have, and the wiki is where they would have read about it. It is noted because
  // a later reader searching the log for `invigor` will find it, and should find this paragraph
  // too rather than concluding the entry was written without seeing it.
  {
    spell: 'Invigor',
    verified: '2026-08-13',
    reason: null,
    evidence:
      'Owner verified absent from EQ Legends, 2026-08-13 (owner directive; the New-at-this-level panel was offering it to his PAL/RNG/SHM loadout at 22/24/30). No mechanical reason is claimed: the ticket proposed that the classic stamina-loss mechanic does not exist in EQL, and the owner`s own log measures the opposite for the pre-launch client — `Jaxan`s Jig o` Vigor`, whose ONLY effect is `Decrease Stamina Loss`, lands 1,028 times on Sun Jul 19 2026 and wears off 6 times, with the owner memorizing it himself. Both of Invigor`s messages survive the removal under `Extinguish Fatigue`, which carries them verbatim, so no message table changes.'
  },
  // --- THE INVISIBILITY TWINS: the classic-EQ copy of a page the wiki carries twice (JOS-440) ----
  //
  // THE REPORT (owner, via JOS-439). eqlwiki has documented this one spell on TWO pages for as long
  // as we have scraped it. Until 2026-08-18 both were titled with the word `versus` and differed
  // only in case, so `spellCanonKey` folded them to ONE catalog entry and nobody noticed. A wiki
  // editor then retitled the newer page to `Invisibility vs. Undead`; the fold stopped joining
  // them, and the level-unlock panel drew TWO rows for the same spell at Necromancer 1, Shadow
  // Knight 4, Cleric 11, Enchanter 14 and Paladin 17.
  //
  // THE TWO PAGES, AND WHICH ONE EQ LEGENDS IS RUNNING:
  //
  //   pageid 49735, `spellname = Invisibility vs. Undead` — mana 40, casting_time 4.00, duration
  //     `27 Min`, target_type `Single Friendly (or Self)`, `Shadowknight - Level 4 (Autogranted)`,
  //     slot `Invisibility versus Undead`, and an items/vendor section listing the Potions of
  //     Unlife Awareness, Cloak of the Undead Eye, Rotting Boots and Warlock`s Boots.
  //   pageid 57190, `spellname = Invisibility Versus Undead` — mana 30, casting_time 5.00, duration
  //     `27 minutes`, target_type `Single`, no autogrant note, slot `Invisibility(1)`, and its
  //     items and vendor sections COMMENTED OUT around a 1999 vendor list (Ak`Anon, East Cabilis,
  //     Neriak, Erudin Palace…). This is the classic-EverQuest description of the spell.
  //
  // THE CLIENT SETTLES IT, WHICH IS THE WHOLE POINT OF THE `supersededBy` INSTRUMENT. The install`s
  // own `spells_us.txt` carries `235^Invisibility Versus Undead^…^4000^1500^4000^3^270^0^40^…`:
  // cast 4000 ms, 270 ticks (27 minutes) and 40 mana. That is pageid 49735`s row, field for field,
  // and it is not pageid 57190`s. The owner`s log agrees independently — of 28 own-cast → `You feel
  // your skin tingle.` pairs, the modal gap is 4 s and NO pair is longer than 4 s, which a 5.00 s
  // cast cannot produce. So 57190 documents a build this server does not run.
  //
  // AND THE NAME GOES THE OTHER WAY, which is why this entry does not travel alone. The game prints
  // `Invisibility Versus Undead` — 83 lines in the owner`s whole log (2,235,271 lines): 28 `You
  // begin casting`, 15 memorize completions, 15 `You forget`, 15 `Beginning to memorize`, 7
  // fizzles, one autogrant, one other player`s cast — and `Invisibility vs. Undead` ZERO times.
  // The wiki`s retitle was an editorial change, not a patch. So the surviving row is renamed to the
  // spelling the game prints by a JOS-161 `name` correction, and this removal drops the page whose
  // NUMBERS are wrong while that correction fixes the name that was wrong. `supersededBy` names the
  // survivor so the pair can never be read as a spell being withdrawn.
  //
  // WHAT THE REMOVAL DOES NOT TAKE WITH IT (bar rule 4), and for a duplicate this is the sharp
  // question, because the two pages share their sentences by construction:
  //   * `You feel your skin tingle.` and `Someone fades a little.` are carried VERBATIM by the
  //     surviving row, and beyond it by `Invisibility to Undead`, `Improved Invis vs Undead` and
  //     `Improved Invisibility to Undead`. No message table loses an owner.
  //   * `Your skin stops tingling. <!--` was 57190`s alone, and it is a SCRAPE ARTIFACT rather than
  //     a sentence — the field parser swallowed the opening of the page`s commented-out items
  //     block. It had a correction of its own in `spellCorrectionsList.ts` (the scrape-artifacts
  //     family) which is retired with this row; the clean sentence survives on the surviving row.
  //     The parser defect itself is untouched here and is reported separately: `classes` on this
  //     same page leaks the same `<!--`, so the swallow is general, not one page`s bad luck.
  //   * The NINE items whose `Effect:` line reads `[[Invisibility versus Undead]]` (Potion of
  //     Unlife Awareness x3, Cloak of the Undead Eye, Rat Bone Powder, Rotting Boots, Plague
  //     Bearer`s Boots, Warlock`s Boots, Boots of the Bonecaster) keep their one-liner: the gear
  //     planner`s join reads `spells.json` RAW, on the exemption this layer`s header states, and
  //     folds case — so it resolves against the pristine scrape either way.
  {
    spell: 'Invisibility Versus Undead',
    verified: '2026-08-21',
    reason:
      'eqlwiki carries this one spell on two pages; pageid 57190 is the classic-EverQuest copy, and EQ Legends runs the other one. Its own commented-out vendor list is the 1999 one.',
    supersededBy: 'Invisibility Versus Undead',
    evidence:
      'The install`s own spell table settles which page this client runs: spells_us.txt row `235^Invisibility Versus Undead^…^4000^1500^4000^3^270^0^40` states cast 4000 ms, 270 ticks (27 min) and 40 mana, which is pageid 49735 (mana 40, casting_time 4.00, `27 Min`, `Single Friendly (or Self)`) field for field and is NOT pageid 57190 (mana 30, casting_time 5.00, `27 minutes`, `Single`). Read 2026-08-21. The owner`s log agrees independently: 28 own-cast → `You feel your skin tingle.` pairs, modal gap 4 s, maximum gap 4 s, which a 5.00 s cast cannot produce. Blast radius: spellClassIndex 1413 -> 1412 (the two spellings held two keys for one spell and now hold one); no per-class count moves, because both pages placed the same five classes at the same five levels; the unlock panel draws one card per level instead of two. The nine items whose Effect line names this spell are unaffected (the planner join reads the raw scrape, per this layer`s exemption).'
  }
]
