// THE SUBJECT-RESTORATION TABLE — THE DATA (JOS-412 split it out of `spellCorrectionsSubjects.ts`).
//
// READ THAT FILE'S HEADER FIRST. It carries the whole argument this table is held to: the defect,
// why it is a measured LIST rather than a wider subject stripper, the two shapes a row may take
// (MINT a tail or JOIN one), the sentences the sweep deliberately refuses, and what `hits`,
// `attribution` and `evidence` each have to say. Nothing about an entry is decided here.
//
// WHY THE SPLIT, and it is the same reason `spellCorrections.ts` keeps `spellCorrectionsList.ts`
// next door: this is a data file that grows by one entry per defect, and it should not be counted
// against a code-mass ceiling shared with the machinery that reads it. The edge is one-way at
// runtime — this file imports only the TYPE, the other imports the value.

import type { SubjectDrift } from './spellCorrectionsSubjects'

/**
 * Ordered by owner-log frequency WITHIN EACH WAVE, so a reader checking the load-bearing ones reads
 * the top of the wave that added them. The waves are the reports: JOS-174/189/245/349 first, then
 * the JOS-412 block at the bottom, which is the first one a VALIDATOR produced rather than a
 * reporter (see THE VALIDATOR AND ITS CENSUS in `spellCorrectionsSubjects.ts`).
 */
export const SUBJECT_DRIFTS: readonly SubjectDrift[] = [
  { spells: ['Celestial Echo', 'Echo of Health', 'Echoing Light', 'Sacred Echo'],
    from: 'Target is embraced by a spirit of healing.',
    to: 'Someone is embraced by a spirit of healing.',
    hits: 166 },
  { spells: ["Forest's Renewal", "Kragg's Salve", 'Spirit Salve'],
    from: "Target's wounds heal.",
    to: "Someone's wounds heal.",
    hits: 84 },
  { spells: ['Healing Light'],
    from: "'s wounds heal.",
    to: "Someone's wounds heal.",
    hits: 84,
    evidence:
      'Owner log: 84 lines of `<T>`s wounds heal.`, which had no DB owner. The same sentence as the entry above, from the OTHER shape of the same drift — this row lost its subject entirely where those three kept a placeholder — so the two land on one suffix and the four spells share it.' },
  { spells: ['Tangling Weeds'],
    from: "Target's movements slow as their feet are covered in tangling weeds.",
    to: "Someone's movements slow as their feet are covered in tangling weeds.",
    hits: 68 },
  { spells: ["Elnerick's Entombment of Ice"],
    from: 'Target is entombed by elemental ice.',
    to: 'Someone is entombed by elemental ice.',
    hits: 39 },
  {
    spells: ['Tiny Companion'],
    from: 'Target shrinks.',
    to: 'Someone shrinks.',
    hits: 33,
    attribution: 'cast',
    evidence:
      'THE REPORTED DEFECT (01M00ACVVFDRVWBXRDCFPHESNZ, JOS-349, a SHM/WAR/BRD): "Pet is not getting parsed. at the end of the log his name is Zarober." THE SECOND SHAPE OF THE JOIN (see THE PET-BINDING HALF in this file`s header): `Ant Legs` and `Shrink` carry the `Someone` subject for the one sentence all three write, `Tiny Companion` carries `Target`, so the pet-shrink spell was in no table and could not be a CANDIDATE for its own landing. Reporter`s slice through the real parser, 6,544 lines: `You begin casting Guardian Spirit.` 16:15:54 -> `You summon a guardian spirit.` 16:16:08 -> `You begin casting Tiny Companion.` 16:16:21 -> `Zarober shrinks.` 16:16:25, four seconds later and inside the DB`s own 4 s cast time — the JOS-188 pet-only pair, exactly, and the ONLY binding line in the whole slice (zero `… Master.` tells, zero `/pet who leader` answers). Replayed before this row: `petDisplayNames() === []` and 142 Zarober lines attributed to nobody. Owner log: 33 lines of ` shrinks.`, all of them already owned by the two `Someone` siblings, and 0 `You begin casting Tiny Companion.` — he bought and scribed the spell and never cast it, which is why his log cannot witness the pair and the slice carries the count.'
  },
  {
    spells: ['Blooming Heal', 'Blossoming Heal', 'Budding Heal', 'Efflorescing Heal', 'Flowering Heal', 'Sprouting Heal'],
    from: 'Target is seeded with healing energy.',
    to: 'Someone is seeded with healing energy.',
    hits: 28 },
  {
    spells: ["Tuyen's Chant of Disease", "Tuyen's Chant of Poison"],
    from: 'Target begins to chant.',
    to: 'Someone begins to chant.',
    hits: 6,
    attribution: 'cast',
    evidence:
      'THE REPORTED DEFECT (01KZN3FSW4BQ519N3TV8CQ1TC1, v0.17.0, a bard): "chant of frost being active when it was not on a mob and NOT showing chant of poison or disease. The only one it had correct was chant of Flame". All four chants share ONE landing sentence and the DB gave it only TWO owners — Flame and Frost carry the `Someone` subject, Disease and Poison carry `Target`, so they were in no table at all. That is the whole report in one line: with only two candidates, `admitLanding` resolves each landing to the most recently cast of THEM, so the disease and poison landings were filed under frost — a frost the slice shows RESISTED on every cast — and the two real debuffs had no row. Restoring the subject makes all four candidates, and the bard`s 3 s chain then resolves each landing to its own cast. The suffix ALREADY EXISTS, so this creates no new tail: it adds two owners to a sentence the cast anchor was already narrowing. Owner log: 6 lines of the shape, with Flame 14 / Disease 12 / Frost 11 third-person casts beside them.'
  },
  { spells: ['Odium'],
    from: 'Target staggers under a dark curse.',
    to: 'Someone staggers under a dark curse.',
    hits: 19,
    attribution: 'cast',
    evidence:
      'THE REPORTED DEFECT. Report 01KZMS8NG4FBYCP1P51VK8WP1B (v0.14.0, a shaman): 10 `You begin casting Odium VI.` lines, 7 of them followed within 0-1 s by `<mob> staggers under a dark curse.` and the other 3 by a resist. Owner log: 19 lines of the shape with no DB owner, 0 of the wiki form. Vexing Mordinia writes a different curse sentence, so nothing else can be meant.' },
  { spells: ["Riftwind's Protection"],
    from: "'s skin glows with a pale greenish tint.",
    to: "Someone's skin glows with a pale greenish tint.",
    hits: 16 },
  { spells: ['Leviathan Eyes'],
    from: "Player's eyes fill with the water of the deep.",
    to: "Someone's eyes fill with the water of the deep.",
    hits: 12 },
  { spells: ['Blessing of Faith'],
    from: 'Target is quickened by the Blessing of Faith.',
    to: 'Someone is quickened by the Blessing of Faith.',
    hits: 8 },
  { spells: ['Blessing of the Knight'],
    from: "Target's hands gain a pale gold glow.",
    to: "Someone's hands gain a pale gold glow.",
    hits: 8 },
  { spells: ['Guard of Vie'],
    from: 'has been surrounded in a dull white aura.',
    to: 'Someone has been surrounded in a dull white aura.',
    hits: 8 },
  { spells: ['Blessing of Piety'],
    from: 'is quickened by the Blessing of Reverence.',
    to: 'Someone is quickened by the Blessing of Reverence.',
    hits: 6 },
  { spells: ['Insidious Retrogression'],
    from: "'s body is pelted by spores.",
    to: "Someone's body is pelted by spores.",
    hits: 6 },
  { spells: ['Minor Familiar'],
    from: 'Player summons forth a minor familiar.',
    to: 'Someone summons forth a minor familiar.',
    hits: 6 },
  { spells: ['Spiritual Brawn'],
    from: 'Target has been filled with spiritual brawn.',
    to: 'Someone has been filled with spiritual brawn.',
    hits: 6 },
  { spells: ['Pack Shrew', 'Spirit of the Shrew'],
    from: 'Target begins to move more gracefully.',
    to: 'Someone begins to move more gracefully.',
    hits: 5 },
  { spells: ['Spike of Disease'],
    from: "'s wounds fester.",
    to: "Someone's wounds fester.",
    hits: 5 },
  { spells: ['Laceration'],
    from: 'Soandso begins to bleed.',
    to: 'Someone begins to bleed.',
    hits: 4 },
  { spells: ["Nature's Precision"],
    from: 'becomes one with their weapons.',
    to: 'Someone becomes one with their weapons.',
    hits: 4 },
  { spells: ['Blessing of the Page'],
    from: "Other_Player's hands have a dull gold glow.",
    to: "Someone's hands have a dull gold glow.",
    hits: 3 },
  { spells: ['Promised Renewal'],
    from: 'Target is promised a divine renewal.',
    to: 'Someone is promised a divine renewal.',
    hits: 3 },
  { spells: ['Ward of the Divine'],
    from: 'is cloaked in the blessing of a divine touch.',
    to: 'Someone is cloaked in the blessing of a divine touch.',
    hits: 3 },
  { spells: ['Ward of Vie'],
    from: 'has been surrounded in a faint white aura.',
    to: 'Someone has been surrounded in a faint white aura.',
    hits: 3 },
  { spells: ['Dustdevil'],
    from: "'s body is crushed by flying debris.",
    to: "Someone's body is crushed by flying debris.",
    hits: 2 },
  { spells: ['Blood of Pain'],
    from: 'is tormented by the blood of pain.',
    to: 'Someone is tormented by the blood of pain.',
    hits: 1 },
  { spells: ['Dark Soul'],
    from: 'has been surrounded in cold darkness.',
    to: 'Someone has been surrounded in cold darkness.',
    hits: 1 },
  { spells: ['Dark Temptation'],
    from: "'s aura grows cold.",
    to: "Someone's aura grows cold.",
    hits: 1 },
  { spells: ['Hawk Eye'],
    from: "'s eyes sharpen with an aura of avian presence.",
    to: "Someone's eyes sharpen with an aura of avian presence.",
    hits: 1 },
  { spells: ['Mana Detonation'],
    from: 'Target is pierced by extraplanar energy.',
    to: 'Someone is pierced by extraplanar energy.',
    hits: 1 },
  { spells: ['Mana Ignition'],
    from: 'Target is pierced by cosmic energy.',
    to: 'Someone is pierced by cosmic energy.',
    hits: 1 },
  {
    spells: ["Sha's Lethargy"],
    from: 'feels lethargic.',
    to: 'Someone feels lethargic.',
    hits: 4,
    attribution: 'cast',
    evidence:
      'THE SENTENCE JOS-174 REFUSED, and the one that had to be TAKEN rather than added (see THE PRECEDENCE CASE below). Reported by a beastlord (01KZP5B8F9GJ0J0BNCP29DH59J, v0.18.0): "Sha`s Lethargy the Beastlord lvl 50 slow doesn`t show up in the debuff windows". Owner log, 1,557,569 lines: `<T> feels lethargic.` occurs 4 times and ALL FOUR fall within 12 s (p50 3 s) of one of the 33 `<Name> begins casting Sha`s Lethargy.` lines, so every occurrence of the sentence in the whole log is a Sha`s Lethargy landing and no other spell in the DB writes it. The wiki form occurs 0 times, as it must — it has no subject at all.'
  },
  { spells: ['Spirit of the Puma'],
    from: 'Target growls with the spirit of the puma.',
    to: 'Someone growls with the spirit of the puma.',
    hits: 1,
    evidence:
      'Owner log: 1 line, `Fail growls with the spirit of the puma.` (Sat Aug 01 18:38:10), which had no DB owner. AGENTS.md records this exact line as the one with "NO typed event at all" — JOS-103 shipped a `raw` capture suggestion because there was no typed path for the family. There is one now, and the raw alert is unaffected: a `raw` condition tests `ev.raw` whatever the event`s kind turns out to be.' },
  { spells: ['Voice of Darkness'],
    from: 'speaks with the voice of darkness.',
    to: 'Someone speaks with the voice of darkness.',
    hits: 1 },
  { spells: ['Tortoises Healing'],
    from: 'is healed by the spirit of the tortoise.',
    to: 'Someone is healed by the spirit of the tortoise.',
    hits: 1,
    evidence:
      'JOS-318, and the row is here for symmetry rather than for its count. The shaman heal-over-time ladder is Snails 14 → Tortoises 28 → Slugs 42 → Sloths 50, and the wiki filled the messages in for this rank only — which is exactly why the reporter of 01KZZXVW888E09C088QBRD5HCD saw Tortoise Healing work and Slugs Healing not. The other two rows are corrected in spellCorrectionsList.ts (their fields are the scrape`s `Someone .` stub, not a subject drift); THIS one lost only its subject, so it belongs in this sweep and its restored tail is byte-identical in shape to the two minted there. Owner log: 1 line of `<T> is healed by the spirit of the tortoise.`, 0 of the wiki form, beside 49 of his own `You begin casting Tortoises Healing.` casts — the count is low because a shaman casting a HoT on HIMSELF prints the first-person landing instead, and that field was never wrong.' },
  {
    spells: ['Vengeance of the Wild'],
    from: 'Target has been consumed in the flames of the wild.',
    to: 'Someone has been consumed in the flames of the wild.',
    hits: 0,
    attribution: 'cast',
    evidence:
      'THE REPORTED DEFECT (01KZSR4HQVWJKDG0NCDGZ01928, v0.21.0, a druid): Vengeance of the Wild does not appear in debuff tracking. THE OWNER`S LOG CANNOT WITNESS IT — 1,608,490 lines measured 2026-08-12 hold 0 of the restored shape, 0 of the wiki form, 0 of the self landing, 0 of the wear-off and not one line naming the spell at all — so the evidence log is the reporter`s slice, cited by id (see THE ROW THE OWNER`S LOG CANNOT WITNESS in this file`s header). That slice, 3,405 lines through the real parser: 7 `You begin casting Vengeance of the Wild VI.` casts, 6 lines of `<mob> has been consumed in the flames of the wild.`, one per cast at EXACTLY +2 s, and the 7th cast is the one it shows interrupted. 0 of the wiki form. The tail is new to the suffix table and no other DB message mentions the flames of the wild, so nothing else could be meant either.'
  },

  // ───────────────────────────────────────────────────────────────────────────────────────────
  // THE JOS-412 BLOCK — the validator's own wave. See THE VALIDATOR AND ITS CENSUS above.
  // The one evidenced MINT first, then the 17 JOINS by the whole-log frequency of the sentence
  // they join. Every join is attribution `db`: the family already spells the subject correctly.
  // ───────────────────────────────────────────────────────────────────────────────────────────

  {
    spells: ['Curse'],
    from: 'Target has been cursed.',
    to: 'Someone has been cursed.',
    hits: 68,
    attribution: 'cast',
    evidence:
      'THE REPORTED DEFECT (GitHub issue 43, and in-app report 01M0BSTF14C2CHJ3D38BACGDZC, a shaman): the level-34 Curse never appears on the debuff tracker. It is ODIUM ONE RANK DOWN THE SAME SHAMAN LINE — the wiki writes `Target has been cursed.`, the table keys on `Someone`, so the spell was in no table and `<mob> has been cursed.` classified as `{kind:`unknown`}`. THE OWNER`S OWN LOG WITNESSES THIS ONE, which Odium`s could not: 2,138,726 lines measured 2026-08-19 hold 89 `You begin casting Curse.` casts and 68 lines of `<mob> has been cursed.`, and EVERY ONE of the 68 falls 0-3 s after one of those casts — the DB`s own 3 s cast time. 0 of the wiki form, 0 of `You have been cursed.` (a debuff you cast lands on a MOB, so the self line is unobservable forever). The reporter`s slice says the same thing from the other end: 19 `You begin casting Curse III.` casts and 19 landings, each 1-2 s later. THE TAIL IS MINTED and collides with nothing: `Magi Curse` owns ` has been Magi cursed.`, and neither tail is a suffix of the other; no other DB message writes this sentence; and the sentence matches no poison-proc suffix and no emote verb, so nothing is taken from any classifier below.'
  },
  {
    spells: ['SpectreLifetap'],
    from: 'Soandso staggers.',
    to: 'Someone staggers.',
    hits: 29_829,
    attribution: 'db',
    evidence:
      'A JOIN, and the biggest sentence in the DB: 37 spells already own ` staggers.` under the scrape`s own `Someone staggers.` — `Lifetap`, `Drain Soul`, `Curse of the Garou` and the rest of the lifetap family — so this row mints nothing and adds one candidate to lines that already parse. Owner log 2026-08-19: 29,829 lines of the shape, every one of them already owned. The row exists because the SPELL was unreachable, not because the sentence was: an NPC lifetap the player never casts can never be resolved out of a candidate list it is not in, and the validator counts that as unmatchable however loud the sentence is.'
  },
  {
    spells: ['Spirit of Bih`Li'],
    from: 'Target is surrounded by a brief lupine aura.',
    to: 'Someone is surrounded by a brief lupine aura.',
    hits: 566,
    attribution: 'db',
    evidence:
      'A JOIN: `Spirit of Wolf`, `Pack Spirit` and `Spirit of Scale` already own ` is surrounded by a brief lupine aura.` with the `Someone` subject, so the family is its own witness and this row is the odd one out. Owner log 2026-08-19: 566 lines of the shape.'
  },
  {
    spells: ['Beholder Dispel'],
    from: 'Soandso feels very dispelled.',
    to: 'Someone feels very dispelled.',
    hits: 358,
    attribution: 'db',
    evidence:
      'A JOIN: `Strip Enchantment` and `Pillage Enchantment` already own ` feels very dispelled.`. Owner log 2026-08-19: 358 lines of the shape, all owned.'
  },
  {
    spells: ['Shock of Venom'],
    from: 'Target screams in pain.',
    to: 'Someone screams in pain.',
    hits: 302,
    attribution: 'db',
    evidence:
      'A JOIN: `Blast of Poison` and `Shock of the Tainted` already own ` screams in pain.`. Owner log 2026-08-19: 302 lines of the shape, all owned, and the tripwire says all 302 keep `Blast of Poison` as the parser`s best-effort first pick — this spell sorts after it in the registry, so it is appended rather than promoted (the six rows that DO take the lead are named in the header). An ambiguous landing still resolves against the caster`s own recent casts, which is the only thing that can tell these three apart.'
  },
  {
    spells: ['Harnessing of Spirit'],
    from: 'Target looks tougher.',
    to: 'Someone looks tougher.',
    hits: 174,
    attribution: 'db',
    evidence:
      'A JOIN: the shaman talisman family — `Talisman of Altuna`, `Talisman of Kragg`, `Talisman of Tnarg` — already owns ` looks tougher.`. Owner log 2026-08-19: 174 lines of the shape.'
  },
  {
    spells: ['Talisman of the Beast'],
    from: 'Target looks stronger.',
    to: 'Someone looks stronger.',
    hits: 144,
    attribution: 'db',
    evidence:
      'A JOIN: twelve strength buffs already own ` looks stronger.` (`Strengthen`, `Spirit Strength`, `Furious Strength`, …). Owner log 2026-08-19: 144 lines of the shape.'
  },
  {
    spells: ['Armor of the Faithful'],
    from: 'Target looks protected.',
    to: 'Someone looks protected.',
    hits: 74,
    attribution: 'db',
    evidence:
      'A JOIN: `Armor of Protection` already owns ` looks protected.`. Owner log 2026-08-19: 74 lines of the shape.'
  },
  {
    spells: ['Protection of Nature'],
    from: "Target's skin shimmers with divine power.",
    to: "Someone's skin shimmers with divine power.",
    hits: 60,
    attribution: 'db',
    evidence:
      "A JOIN: `Skin Like Nature` already owns `'s skin shimmers with divine power.` — the same druid skin line one rank up. Owner log 2026-08-19: 60 lines of the shape."
  },
  {
    spells: ['Frenzy'],
    from: 'Target goes berserk.',
    to: 'Someone goes berserk.',
    hits: 55,
    attribution: 'db',
    evidence:
      'A JOIN: `Fury`, `Rage`, `Burnout` and `Voice of the Berserker` already own ` goes berserk.`. Owner log 2026-08-19: 55 lines of the shape.'
  },
  {
    spells: ['Bounce'],
    from: "Player's image shimmers.",
    to: "Someone's image shimmers.",
    hits: 53,
    attribution: 'db',
    evidence:
      "A JOIN: 23 illusions already own `'s image shimmers.` under the wiki`s spaced possessive `Someone 's image shimmers.`. Owner log 2026-08-19: 53 lines of the shape. `Illusion: Air Elemental` carries the same wrong token and is NOT named here: it is a DUPLICATE row of a name whose first row already keys, and a message correction writes the first row only (see the header)."
  },
  {
    spells: ["O`Keil's Embers", "O`Keil's Flickering Flame"],
    from: 'Target begins to radiate.',
    to: 'Someone begins to radiate.',
    hits: 32,
    attribution: 'db',
    evidence:
      "A JOIN: `O'Keils Radiation`, `O`Keils Flickering Flame` and the two fire-elemental auras already own ` begins to radiate.` — including a row of this very spell under the wiki`s OTHER spelling of its name, which is as literal as `the DB is its own witness` gets. Owner log 2026-08-19: 32 lines of the shape."
  },
  {
    spells: [
      'Circle of Misty Thicket',
      'Circle of South Ro',
      'Circle of Stonebrunt',
      'Circle of West Commons',
      'Lesser Evacuate',
      'Lesser Succor',
      'Succor: Butcherblock',
      'Succor: East Karana',
      'Succor: North Karana',
      'Succor: South Ro'
    ],
    from: 'Player creates a mystic portal.',
    to: 'Someone creates a mystic portal.',
    hits: 31,
    attribution: 'db',
    evidence:
      'A JOIN, and the largest one: 23 druid circles and succors already own ` creates a mystic portal.` (`Circle of Butcher`, `Succor: Ro`, `Evacuate`, …) while these ten spell the subject `Player`. Owner log 2026-08-19: 31 lines of the shape. `Ring of South Ro` carries the same wrong token and is NOT named here — it is a DUPLICATE row whose first row already keys ` fades away.` (see the header).'
  },
  {
    spells: ['Protection of Diamond'],
    from: "Player's skin turns hard as diamond.",
    to: "Someone's skin turns hard as diamond.",
    hits: 16,
    attribution: 'db',
    evidence:
      "A JOIN: `Skin Like Diamond` already owns `'s skin turns hard as diamond.`. Owner log 2026-08-19: 16 lines of the shape."
  },
  {
    spells: ['Share Form of the Great Wolf'],
    from: 'Player turns into a wolf.',
    to: 'Someone turns into a wolf.',
    hits: 14,
    attribution: 'db',
    evidence:
      'A JOIN: six wolf forms already own ` turns into a wolf.`, `Share Wolf Form` — this spell`s own junior rank — among them. Owner log 2026-08-19: 14 lines of the shape.'
  },
  {
    spells: [
      'Cazic Temple Portal',
      'Evacuate: Greater Faydark',
      'Evacuate: Greater Nektulos',
      'Evacuate: North Karana',
      'Evacuate: South Ro',
      'Evacuate: West Karana',
      'Greater Faydark Portal',
      'Nektulos Portal',
      'North Karana Portal',
      'North Ro Portal',
      'Stonebrunt Portal',
      'Toxxulia Portal',
      'West Commons Portal',
      'West Karana Portal'
    ],
    from: 'Player creates a shimmering portal.',
    to: 'Someone creates a shimmering portal.',
    hits: 8,
    attribution: 'db',
    evidence:
      "A JOIN: 21 wizard portals and evacuates already own ` creates a shimmering portal.` (`Cazic Portal`, `Evacuate: Fay`, `Markar's Relocation`, …) while these fourteen spell the subject `Player`. Owner log 2026-08-19: 8 lines of the shape."
  },
  {
    spells: ['Form of the Bear'],
    from: 'Target turns into a bear.',
    to: 'Someone turns into a bear.',
    hits: 8,
    attribution: 'db',
    evidence:
      'A JOIN: `Form of the Great Bear` already owns ` turns into a bear.`. Owner log 2026-08-19: 8 lines of the shape.'
  },
  {
    spells: ['Wave of Fire'],
    from: "Soandso's skin sears.",
    to: "Someone's skin sears.",
    hits: 0,
    attribution: 'db',
    evidence:
      "A JOIN whose sentence the owner`s log has never printed: `Rain of Molten LAva` already owns `'s skin sears.`, and the shape occurs 0 times in 2,138,726 lines (measured 2026-08-19). `hits: 0` here is the JOIN reading of the field, not the reporter-slice one — a join mints no tail, so its blast radius is provably zero in both directions and the count is a fact about the sentence rather than about the correction. The row is admitted because the SPELL was unreachable and the DB is its own witness for the sentence; it can wait for a log without being wrong in the meantime."
  }
]
