// Combat golden-window fixture extractor (Task #55 — multi-mob pull segmentation).
//
// Unlike extract-fixtures.mjs (buffs/entity windows, which prune aggressively to the
// lifecycle lines), COMBAT windows must replay the fight VERBATIM: every damage / miss /
// resist / heal / death line is load-bearing for segmentation and for the byte-identical
// damage tripwire. So this slicer keeps the raw span and drops ONLY what the shared scrub
// (tests/fixture-scrub.mjs) classifies as third-party chat/social — which can never affect
// the combat model but bloats the fixture and would leak other players into a PUBLIC repo.
//
// Usage: node tests/extract-combat-fixtures.mjs "<path to eqlog_Primitive_freeport.txt>"
import { readFileSync, writeFileSync } from 'fs'
import { fileURLToPath } from 'url'
import { dirname, join } from 'path'
import { scrubKeep } from './fixture-scrub.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const LOG = process.argv[2]
const lines = readFileSync(LOG, 'utf8').split(/\r?\n/)

function slice(fromLine, toLine, out) {
  const seg = []
  for (let i = fromLine - 1; i < toLine && i < lines.length; i++) {
    const l = lines[i]
    if (!l.startsWith('[')) continue
    if (!scrubKeep(l)) continue
    seg.push(l)
  }
  writeFileSync(join(HERE, 'fixtures', out), seg.join('\n') + '\n')
  console.log(`${out}: ${seg.length} lines (from raw ${toLine - fromLine + 1})`)
}

// W24 MULTI-MOB PULL MUST BE ONE ENCOUNTER (Sun Aug 02 15:30:23 → 15:32:17, raw
// 991860..992222). Three things had to be inside the span:
//   1. A CLEAN start: the PREVIOUS fight (a Teir`Dal rogue) is already in progress and is
//      slain at 15:30:27, then 12s of silence — so the V`Zher pull provably opens its own
//      encounter and the window contains exactly TWO fights, not one merged blob.
//   2. The whole two-mob pull: Soldier of V`Zher + Baron Telyx V`Zher both land damage on
//      YOU from 15:30:39; the Baron even HEALS the Soldier at 15:31:01 (hostile-on-hostile
//      heal = presence evidence for both); the Soldier dies 15:31:09 and the Baron fight
//      continues unbroken to his death at 15:32:00.
//   3. Trailing quiet (to 15:32:17) so the encounter's death-linger closure is observable.
slice(991860, 992222, 'w24-multi-mob-no-split.log')

// W25 PER-MOB GHOST ROWS (Task #58) — the "Damage by mob" panel showed FOUR rows for a
// two-mob widow fight: the two real instances plus two 0-damage phantoms. This is the
// user's actual widow session in Steamfont (Sun Aug 02 16:50:57 → 16:53:23, raw
// 1006240..1007109), which reproduces BOTH phantoms verbatim:
//   1. a bare "a deadly black widow" row — miss ticks carried the RAW log name while
//      damage ticks carried the world-model INSTANCE label ("… (7)" / "… (8)").
//   2. an "on a deadly black widow" row — the frenzy miss family ("You try to frenzy ON
//      X, but miss!") leaked the preposition into the target capture; the LANDED form
//      ("You frenzy on X for N points…") always parsed clean.
// Three fights are inside the span, and all three are load-bearing:
//   16:50:57–16:52:09  a six-widow blob (gens 1–6) — proves the per-instance split of a
//                      long chain of misses, and that the bare gen-1 row is REAL here.
//   16:52:14–16:52:32  a vampire-bat fight containing ONE stray whiff at a widow that is
//                      not engaged in it — the case that must NOT spawn a world instance
//                      (if it did, the widows below would renumber to (8)/(9)).
//   16:52:38–16:53:22  THE REPORTED FIGHT: exactly two widow instances, gens 7 and 8,
//                      with 56 outgoing misses (4 of them frenzy) to distribute.
slice(1006240, 1007109, 'w25-per-mob-miss-ghosts.log')

// ---------------------------------------------------------------------------
// HEALING + ABSORPTION windows (Task #59). Three compact real spans, each cut to isolate one
// family the healing meter has to get right. All three are Befallen (Sun Aug 02) and Freeport
// (Sun Aug 02) fights from the user's own session.
// ---------------------------------------------------------------------------

// W26 CRITICAL HEALS (Sun Aug 02 17:10:51 → 17:11:39, raw 1011100..1011400). A ghoul-knight
// grind with four self-heals, ONE of which carries the trailing `(Critical)` modifier that the
// old `\.$`-anchored HEAL_RE rejected outright — 233 real heals were silently dropped log-wide.
// Two rune grants ride along, so the same window also proves absorption stays OUT of healing.
slice(1011100, 1011400, 'w26-healing-crit.log')

// W27 OVERHEAL + ABSORBED SWING (Sun Aug 02 17:13:50 → 17:14:49, raw 1011923..1012345). The
// overheal form is here verbatim — `You healed Primitive for 1351 (5968) hit points by Lay on
// Hands VI.` — alongside four plain heals (raw == effective ⇒ zero waste), eleven rune grants,
// and the one line in the span where YOUR rune eats a swing outright
// (`… but YOUR magical skin absorbs the blow! (Riposte)`), which carries NO amount.
slice(1011923, 1012345, 'w27-healing-overheal-absorb.log')

// W28 ENEMY COUNTER-HEALING + ABSORBED DAMAGE SHIELDS (Sun Aug 02 15:55:20 → 15:55:42, raw
// 997999..998129). A Teir`Dal ranger fight where the mob SELF-HEALS mid-fight
// (`a Teir`Dal ranger healed herself for 64 hit points by Skin like Rock.`) — counter-healing
// that undid our damage and must rank on its own ledger, never in "who kept me alive". The
// ranger also runs a thorns damage shield, so the span carries the third absorption family:
// `YOUR magical skin absorbs the damage of a Teir`Dal ranger's thorns.` (count-only).
slice(997999, 998129, 'w28-healing-enemy-thorns.log')

// ---------------------------------------------------------------------------
// W29 BOTH ABSORB SHAPES IN ONE WINDOW — the MISS_RE self-absorb fix.
// ---------------------------------------------------------------------------
//
// MISS_RE's absorb alternative used to require a POSSESSIVE `<name>'s magical skin`, so the SELF
// form (`<mob> tries to <verb> YOU, but YOUR magical skin absorbs the blow!`) never matched and
// fell through to 'unknown'. Full-log sweep: 385 self-form lines dropped vs 1,428 possessive
// lines parsed. Every dropped line is an INCOMING avoided swing, so the loss was a silent
// undercount in the incoming miss aggregates (addIncMiss) and in defensive hit%.
//
// This span (Sun Aug 02 15:25:34 → 15:26:04, raw 990649..990795) is the tightest real window that
// carries BOTH shapes back to back, so one replay proves the fix AND proves the possessive path
// is untouched. It opens on `Auto attack is on.` five seconds after the previous fight's mob died
// (raw 990644), so the first encounter here provably starts clean. It holds two back-to-back
// PULLS, which the engine correctly keeps as ONE encounter (the second mob lands damage 4s after
// the first dies — inside the death-linger, law 7):
//   15:25:34–15:25:43  Kahaptra Z`Taj — a named mob running BOTH a rune and a thorns shield.
//                      THREE possessive absorbs (`You try to slash Kahaptra Z`Taj, but Kahaptra
//                      Z`Taj's magical skin absorbs the blow!`) = the mob's own rune eating OUR
//                      swings, which must stay OUTGOING misses and must never be credited to our
//                      mitigation. Four `YOUR magical skin absorbs the damage of …'s thorns.`
//                      ticks ride along (the third absorption family, count-only).
//   15:25:47–15:26:03  a Teir`Dal priest — TWO self absorbs (`A Teir`Dal priest tries to bash/
//                      crush YOU, but YOUR magical skin absorbs the blow!` @15:25:57 and
//                      @15:26:01), the previously-dropped lines, alongside three plain incoming
//                      misses so the aggregate they belong in is populated either way.
// The window ends on the loot line after the priest dies, one second before the next pull opens.
slice(990649, 990795, 'w29-absorb-both-shapes.log')

// ---------------------------------------------------------------------------
// W34 SENTENCE-CASE SPLITS ONE MOB IN TWO — the world-model display-casing fix.
// ---------------------------------------------------------------------------
//
// The "Damage by mob" panel showed BOTH `a zol ghoul knight (230)` and
// `A zol ghoul knight (230)` — one instance, two rows, the capitalized one carrying only a
// resist. EQ capitalizes a lowercase-article mob name at the START of a sentence, so the
// SAME spawn is printed two ways: mid-sentence (`You slash a zol ghoul knight for 19…`) it
// carries its true name, sentence-initial (`A zol ghoul knight resisted your Condemnation of
// Nife!`, `A zol ghoul knight hits YOU for 17…`) it is capitalized. WorldModel.resolve()
// adopted the LATEST sighting's casing, so the instance display flip-flopped and whichever
// timeline instant was written while it was sentence-cased froze the wrong string. Aggregate
// rows key by instanceId so they merely relabel; the timeline's per-mob grouping keys by the
// RAW target string, so it split.
//
// THE WINDOW (Sun Aug 02 19:28:01 → 19:29:15, raw 1022491..1023067) is the user's actual
// reported fight in Befallen, and it is self-contained:
//   19:28:01  opens on `Auto attack is on.` six seconds after the PREVIOUS zol knight was
//             slain (raw 1022489) — so the first damage here provably opens a fresh encounter.
//   19:28:01→ a continuous zol-ghoul-knight grind (three knights + an urd ghoul wizard, all
//             slain inside the span) whose outgoing damage lines are all LOWERCASE and whose
//             incoming melee lines are all sentence-CAPITALIZED — the flip-flop driver.
//   19:28:52  `A zol ghoul knight resisted your Condemnation of Nife!` — THE reported tick,
//             sentence-initial, on a knight that took `You backstab a zol ghoul knight for
//             177…` one second later and damage before it.
//   19:29:15  the last knight is slain + its loot lines; the span ends on the buff-fade line
//             that follows, so the encounter closes on evidence rather than mid-swing.
slice(1022491, 1023067, 'w34-resist-case-merge.log')

// ---------------------------------------------------------------------------
// ROGUE POISONS (Task #64) — the two windows behind the poison/proc model.
//
// The user's log holds exactly ONE rogue-poison session (Mon Aug 03 01:05–01:33, the tail of
// the file): 6 coat lines, 2 dry lines, 25 slow landings log-wide of which 16 fall inside
// this session, and every Strike-proc emote family the model recognizes. Both windows are
// cut from it, and W35 is designed to be replayed as a PRIME for W36 — the coat that makes
// the whole fight sequence slow-capable is applied 7 minutes before the first swing, so a
// combat-only window cannot establish it.
// ---------------------------------------------------------------------------

// W35 THE COAT SEQUENCE (Mon Aug 03 01:05:08 → 01:23:00, raw 1100627..1100792). Small and
// dense: every coat the user has ever applied, in order, with the two replacement `dries`
// lines and both third-person forms. Hand-read, load-bearing beats:
//   01:05:08/10  activate + `You coat your blades in asp venom.`         → COMBAT (Asp Venom)
//   01:05:11/13  `… in a siphoning poison.`                              → COMBAT (Blood Siphon)
//   01:05:33/36  `… with a stunning agent.`                              → COMBAT (Stunning)
//   01:06:14/16  `… in a neurotoxic poison.`                             → UTILITY (Neurotoxic)
//   01:06:44/47  `The poison dries from the blade.` THEN `… in mage bane poison.` — the
//                utility slot being REPLACED, both lines in the same second. This pair is
//                why a utility coat must be a single slot and a dry must not clear the
//                combat venoms: all three of those stay up through the fights in W36.
//   01:16:26/29  dry + `… in a neurotoxic poison.` again — Mage Bane is swapped back out, so
//                the coat active for every fight in W36 is Neurotoxic (slow-capable).
//   01:19:30     `Skandercoats their blades in poison.` — ANOTHER PLAYER's coat, verbatim
//                with the game's missing space. It must parse (who != you) and must NOT
//                touch your own slots.
// The span ends one line before the zone entry W36 opens on.
slice(1100627, 1100792, 'w35-poison-coats.log')

// W36 SLOW TIME-TO-LAND (Mon Aug 03 01:23:01 → 01:26:47, raw 1100793..1102500). The first
// ~4 minutes of the Ruins of Old Paineel grind that follows the W35 coats, chosen because it
// is the shortest span holding SEVERAL pulls with a mix of slow-landed and slow-never-landed
// fights — the two halves of the honest denominator. Hand-read beats:
//   01:23:01  `You have entered The Ruins of Old Paineel.` — a clean zone boundary, so the
//             window opens with an empty zone aggregate.
//   01:23:13  first outgoing damage (an elemental warrior) — the first pull's engage instant,
//             which is the t0 every time-to-slow below is measured from.
//   01:23:15  `You hit … by Asp Venom Strike.` + `screams as poison burns their veins!` — a
//             COMBAT venom proccing while the UTILITY coat is Neurotoxic. Impossible under a
//             one-poison model; this is the line that proves the two-slot design.
//   01:23:33  `stumbles, clutching their head!` (Befuddling Strike — Neurotoxic's other proc)
//   01:24:29  `an elemental warrior's limbs move slower!` — THE slow landing.
//   01:26:03  and 01:26:19 two more slow landings on a rock golem.
//   01:26:0x  `begins to sway!` (Stunning Strike) and `begins to bleed profusely!` (Blood
//             Siphon Strike) — the remaining two combat venoms' procs, so all four active
//             poisons are represented.
// The window ends mid-grind rather than on a death: the last encounter is still open, which
// is exactly the LIVE case the meter's "slow: not landed" chip has to render honestly.
slice(1100793, 1102500, 'w36-poison-slow-timing.log')

// ---------------------------------------------------------------------------
// CHARM OWNERSHIP (Task #65) — the two windows behind the charm world model.
//
// `<mob> has been charmed.` is a BROADCAST: the whole zone sees it and it names NO caster
// (it is the msgCastOnOther of Charm/Beguile/Allure/Cajoling Whispers/Dictate/Boltran's
// Agacerie, and the wiki records it as "Someone has been charmed."). The engine used to bind
// every one of them into `petNames`, so ANOTHER enchanter's pet became the owner's. These two
// windows are the negative and the positive case, cut from the same real log.
// ---------------------------------------------------------------------------

// W44 A FOREIGN CHARM MUST NOT BIND, AND A PLAYER IS NEVER A HOSTILE (Tue Aug 04 16:58:32 →
// 17:05:30, raw 1256800..1259685). The user's reported segment: "Champion of Innoruuk (12) +3"
// swallowing three separate pulls. Hand-read beats:
//   16:59:26  `Scooba begins casting Allure VII.` (unparsed — third-party casts have no event)
//   16:59:27  `a Knight of Innoruuk has been charmed.` — ANOTHER PLAYER's charm. The owner is
//             idle (his last swing was 16:48:45) and has cast no charm spell in this window at
//             all, so nothing here may bind.
//   16:59:34→ `Scooba begins casting Mesmerization VI.` then TWO foreign mez broadcasts at
//             16:59:35 — the CC half of the same defect (each set a 120s ccActiveUntil hold).
//   16:59:43  `an elite dragoon has been charmed.` — a second foreign charm.
//   16:59:51→ Scooba and his charmed Knight trade blows with the rest of the camp for ~90s.
//             Pre-fix, EVERY `A Knight of Innoruuk <verb> Scooba` line was booked as the
//             owner's pet damage (measured 153 hits / 13,866 points) and entered the PLAYER
//             Scooba into `enc.engaged` as a hostile.
//   17:00:10, :23, :25, :33  `Scooba healed itself …` — booked as ENEMY healing, and each one
//             refreshed Scooba's presence so the pull could never close.
//   17:00:55  `Auto attack is on.` — the OWNER's first pull opens (a Disciple of Innoruuk),
//             slain 17:01:39.
//   17:01:43  second pull (a Champion of Innoruuk), slain 17:03:09 — 14s after the Disciple.
//   17:03:23  third pull (a Champion of Innoruuk), slain 17:05:08 — 23s after the second.
//   Both gaps are far under FALLBACK_IDLE_MS (60s), so the ONLY thing that can separate these
//   three pulls is the death-close — which needs every engaged hostile gone. Scooba (alive,
//   self-healing, never dying) vetoed it forever.
// The window ends on the loot line of the last kill (17:05:08); the next owner swing is over
// three minutes later, so the final pull's closure is entirely the test's to observe.
slice(1256800, 1259658, 'w44-foreign-charm-player-hostile.log')

// W45 AN OWNER-CAST CHARM STILL BINDS (Tue Jul 28 16:47:14 → 16:49:12, raw 213988..214240) —
// the positive case, from the owner's enchanter epoch. Everything the model needs to say YES
// is here, and the timings are the ones the arm window was measured against:
//   16:47:33  `You begin casting Charm.` (Charm's DB cast time is 2400 ms)
//   16:47:35  `a kodiak has been charmed.`            → +2s: inside the arm, BIND
//   16:47:41  `Your Charm spell has worn off of a kodiak.` → unbind, 6s later, with no pet
//             damage and no Master tell in between. This is the 8%-of-binds case that proves
//             a bind may NOT require corroboration to have been real.
//   16:48:00  `You begin casting Charm.`
//   16:48:03  `a kodiak has been charmed.`            → +3s: still inside the arm, BIND
//   16:48:05  `A kodiak told you, 'Attacking a Dervish Cutthroat Master.'` — the corroboration
//             that promotes the bind to CONFIRMED.
//   16:48:03→ the pet kills a Dervish Cutthroat (16:48:23) and a black bear (16:48:55), then
//             tanks an orc legionnaire to its death at 16:49:10 — all of it attributed to the
//             owner as PET damage, which is exactly what must survive the gating.
slice(213988, 214240, 'w45-owner-charm-bind.log')

// ---------------------------------------------------------------------------
// ALLY CHARM (JOS-250) — the three windows behind "whose pet is that, when it is not yours?"
//
// W44 above is the fourth, and it is the one that changed meaning: `Scooba begins casting
// Allure VII.` was already in it, one second before each broadcast, and JOS-250 is what finally
// reads it. These three are the shapes W44 does not carry — a clean credit, a same-named twin,
// and a two-caster tie — cut from the same real log at the three instants the whole-log sweep
// found them. Whole-log measurement (1,608,483 lines, 2026-08-12, through the SHIPPED roster and
// arm window): 456 charm broadcasts, 441 the owner's own, 15 a NAMED third party's, 0 unmatched,
// 0 resolving both.
// ---------------------------------------------------------------------------

// W66 AN ALLY'S CHARM PET IS CREDITED, THEN PROVES ITS OWN BREAK (Fri Jul 31 20:05:40 →
// 20:06:35, raw 741548..741690). The cleanest of the fifteen, and it carries three of the four
// bind/unbind ends in fifty seconds:
//   20:05:57  `Gordon begins casting Cajoling Whispers III.`  (DB cast time 5,500 ms)
//   20:05:58  `an imp protector has been charmed.`   → +1s, inside the arm: BIND to Gordon.
//   20:05:59→ the imp fights `a lava guardian` — the mob-vs-mob damage the meter has always
//             dropped, now Gordon's row.
//   20:06:05  `An imp protector hits Gordon for 8 points of damage.` — SOFT-HOSTILE PROOF. The
//             pet turned on its own charmer, so the charm is over at that instant and nothing
//             after it is credited. (Its swing-and-miss at Gordon in the same second is the
//             same proof; whichever the model reads first ends the bind.)
//   20:06:12  `Gordon begins casting Cajoling Whispers III.` again
//   20:06:14  `an imp protector has been charmed.`   → RE-CHARM: the same name, the same
//             charmer, a fresh bind and a fresh hold, and the crediting resumes.
// The owner is not fighting in this window at all, which is the point of choosing it: every
// number in it belongs to somebody else and none of it may touch his.
slice(741548, 741690, 'w66-ally-charm-credited-and-broken.log')

// W67 A SAME-NAMED TWIN MAKES THE NAME UNREADABLE (Thu Jul 30 18:27:08 → 18:27:36, raw
// 508140..508430) — the rock-golem episode the investigation named, and the canonical fixture
// for the twin refusal:
//   18:27:12  `Enzee begins singing Solon's Bewitching Bravura III.`  — a BARD charm, whose
//             landing sentence is `Someone 's eyes glaze over.` and which therefore cannot be
//             what a `has been charmed.` broadcast resolved (JOS-200's standing cost). It must
//             not arm the join, or every enchanter binding beside a bard becomes a tie.
//   18:27:12  `President begins casting Cajoling Whispers V.`
//   18:27:15  `A rock golem cleaves a rock golem for 128 points of damage.` — the twin is
//             ALREADY swinging, one second before the broadcast.
//   18:27:16  `a rock golem has been charmed.`   → binds to President (the only eligible cast)
//   18:27:17  `A rock golem pierces a rock golem for 102 points of damage.` — and the name is
//             ambiguous from that line forward. The window continues that way for its whole
//             length, so the honest credit is ZERO.
slice(508140, 508430, 'w67-ally-charm-same-named-twin.log')

// W68 TWO CASTERS, ONE MOB, ONE SECOND APART (Fri Jul 31 21:13:09 → 21:13:20, raw
// 747240..747300) — the ONLY multi-caster tie in the whole log, and therefore the only sample
// the refusal has:
//   21:13:12  `Paladrial begins casting Cajoling Whispers III.`
//   21:13:13  `Satya begins casting Cajoling Whispers III.`     — same spell, same target
//   21:13:14  `a lava duct crawler has been charmed.`  → BOTH arms contain it, and nothing in
//             the log separates them. REFUSE: a coin flip credited to a named person is worse
//             than silence. The crawler then fights a sonic bat for the rest of the window,
//             which is exactly the damage a guess would have handed to whichever name won.
slice(747240, 747300, 'w68-ally-charm-multi-caster-tie.log')

// W37 DISPEL VARIANTS ARE NOT A ROGUE PROC (Mon Aug 03 00:38:18 → 00:40:02, raw
// 1095620..1096030) — the Efreeti Lord Djarn kill, cut because it is the densest dispel
// window in the log and because it sits BEFORE the poison session (the first coat is at
// 01:05), which makes it the negative case for every poison assertion at the same time.
// Hand-read beats:
//   00:38:18→ the Djarn fight already underway: his damage shield, his rune eating our swings.
//   00:39:02, :07, :16, :24  `Efreeti Lord Djarn feels a bit dispelled.` ×4. That message is
//             the Cancel Magic FAMILY's landing line (Cancel Magic | Phobocancel — eleven
//             classes plus NPCs cast it), so the lane must be counted exactly, labeled with
//             both candidates, and flagged ambiguous. The rogue's own dispel proc would print
//             `'s blessings wither!`; this window has none, and neither does the whole log.
//   00:39:59  `You have slain Efreeti Lord Djarn!` — the fight closes on evidence.
// No coat has ever been applied at this point in the log, so this encounter must report
// slowExpected:false and an EMPTY strike ledger — a poison feature that lights up on a fight
// with no poison would be worthless.
slice(1095620, 1096030, 'w37-dispel-variants.log')

// ---------------------------------------------------------------------------
// SPECIAL-ATTACK LANES (user report 01KZ9AAQ4ES1R2NVYK0JJ68EBQ, "Dragon Punch DPS isn't
// tracked"). EQ Legends' upgraded specials print NO verb of their own — a Dragon Punch, an
// Eagle Strike and a Tiger Claw all land as `You strike <mob> …` — so the only thing that can
// name the lane is the state line the game prints once at the switch. See
// src/main/combat/specialAttacks.ts for the full sweep behind the lane table.
//
// The three windows below are cut so that each one carries BOTH sides of a transition, and so
// that replaying a window IN ISOLATION exercises the pre-state: none of them contains the
// earlier state line that would have established its lane, so every swing before the window's
// own state line must keep the parser's generic name.
// ---------------------------------------------------------------------------

// W46 THE EAGLE STRIKE ERA (Tue Jul 28 22:06:00 → 22:10:00, raw 273133..274518) — a dense
// froglok grind in Guk straddling the FIRST in-lane upgrade this character ever made:
//   22:07:16  `You will now use Eagle Strike instead of Tiger Claw while attacking.`
// The owner's own `strike` swings sit on BOTH sides of that line — 10 landing before it, 8
// after — so one replay pins the pre-state (generic "Melee": the window does NOT contain the
// Tiger Claw grant from 16:09:14, and inventing it would be a guess) and the post-state
// ("Eagle Strike"). Three further things earn their place here:
//   - `You have become better at Eagle Strike!` ticks 2→7 land beside the strikes, which is the
//     corroboration the lane table was built on — but NOT an input to the model (see
//     specialAttacks.ts on why skill-ups can never drive the state).
//   - the ROUND KICK era is live and its state line is far outside the window, so every kick
//     swing must stay plain "Kick": a lane the log has not spoken about in this replay is never
//     guessed from the table.
//   - Dranix (another player) strikes throughout. His swings are the not-you control: the state
//     line is first-person-only, so nobody else's `strikes` may ever be relabelled.
// The window stops one line short of a `/who`-shaped friends list at 22:11:00 (whose rows the
// scrub would drop anyway) — nothing after 22:10:00 is load-bearing.
slice(273133, 274518, 'w46-special-eagle-strike.log')

// W47 THE DRAGON PUNCH SWITCH (Wed Jul 29 14:53:00 → 14:58:00, raw 327002..327849) — the exact
// transition the user's report is about, in a zol-ghoul-knight grind:
//   14:53:00→ Eagle-Strike-era strikes open the window (the first line IS one).
//   14:54:14  `You will now use Dragon Punch instead of Eagle Strike while attacking.`
//   14:56:17→ `You have become better at Dragon Punch!` ticks 2→27, every one of them beside a
//             `You strike …` line — the log itself saying what the strikes were.
// 27 self strikes across the two eras, plus slash/crush/bash/kick/smite lanes running the whole
// time, which is what makes this window the law-8 tripwire as well as the labeling test: the
// melee category total must come out to exactly what it was before any of this existed.
slice(327002, 327849, 'w47-special-dragon-punch.log')

// W48 A GRANT RESETS A LANE — AND SLAM DOES NOT CLAIM ONE (Sun Aug 02 01:55:04 → 02:03:51, raw
// 969559..970396). The Aug 02 loadout swap prints six state lines in nine seconds:
//   01:55:04 Backstab · :06 Bash · :08 Frenzy · :09 Kick · :12 Slam instead of Bash · :13 Smite
// Two of them are the whole point:
//   `Kick while auto attacking.` is a bare GRANT, and it RESETS the kick lane — the character
//     had been on Flying Kick since Jul 29. The log agrees without being asked: Flying Kick
//     skill-ups stop dead here and `You have become better at Kick!` ticks 21→30 resume inside
//     this very window. The test primes Flying Kick first (one verbatim line from Jul 29
//     21:28:03) so the reset is observable rather than merely absent.
//   `Slam instead of Bash` is the lane the evidence REFUSED (specialAttacks.ts): 35 self bash
//     swings follow it in this window and must all stay "Bash", because Bash skill-ups keep
//     firing during Slam eras log-wide and a `better at Slam!` line does not exist.
// The window also crosses THREE zone lines (West Commonlands → Befallen → Befallen 4), which is
// how it proves the lane state survives zoning — a special is chosen once, not per zone.
slice(969559, 970396, 'w48-special-lane-reset.log')

// ---------------------------------------------------------------------------
// ATTACK ROUNDS (docs/plans/attack-round-stats.md) — the three windows the round grouper is
// pinned on. Each isolates one thing the grouper has to get right, and each is cut from a span
// the design's mechanics sweep actually measured.
// ---------------------------------------------------------------------------

// W49 THE TRIPLE BACKSTAB (Tue Aug 04 17:54:49 → 17:55:30, raw 1265581..1266000) — the
// measured second the whole per-event tier rests on. Hand-read beats:
//   17:54:49  `Auto attack is on.`, 1s after the Knight's Harm Touch opens on YOU — a clean
//             pull start, so the window's first outgoing damage provably opens its own fight.
//   17:55:20  THREE `You backstab a Knight of Innoruuk` lines in one second (70, 145, 392), at
//             ONE target. Backstab's ~10s reuse timer means this cannot be three attacks, so
//             it is one round of three swings and the backstab lane must show exactly one
//             3-swing round — with NOTHING in the 4+ bucket.
//   17:55:20  FOUR `You frenzy on a Knight of Innoruuk` lines in the same second — frenzy is
//             multi-hit by design and must be EXCLUDED wholesale, never counted as a 4x round.
//   17:55:2x  `A Knight of Innoruuk … YOU … (Riposte)` counter-swings, landed and avoided —
//             riposte TAKEN, whose only evidence is the counter itself (there is no
//             `but <mob> ripostes!` line anywhere in this log).
slice(1265581, 1266000, 'w49-round-triple-backstab.log')

// W50 THE CROSS-TARGET FAN-OUT (Mon Aug 03 01:29:51 → 01:30:53, raw 1102931..1103533) — two of
// the log's five 4x-backstab seconds, back to back, and both are the SAME shape:
//   01:30:45  backstab a rock golem 60, an elemental capturer 60, a rock golem 51, an
//             elemental capturer 51
//   01:30:49  backstab a rock golem 92, an elemental capturer 92, a rock golem 32, an
//             elemental capturer 32
// Two targets, identical ordered damage sequences: ONE double-attack round fanned across two
// defenders and printed twice. Grouping per-target alone would report two 2-swing rounds;
// not grouping by target at all would report a 4x backstab the reuse timer forbids. The
// collapse must turn each second into exactly one 2-swing round with `fanned` set.
// The window opens on `Auto attack is on.` six seconds after the previous mob was slain and
// ends on `You have slain an elemental capturer!`.
slice(1102931, 1103533, 'w50-round-fanout.log')

// W51 THE FLURRY ERA (Tue Aug 04 00:25:25 → 00:26:57, raw 1241090..1241650) — the two fights
// that straddle the Burst of Power purchase, i.e. the provenance of flurry itself:
//   00:25:26  `You have gained the ability "Burst of Power" at a cost of 3 ability points.`
//             (+ its rank-2 improve line in the same second)
//   00:25:35  the character's FIRST-EVER outgoing `(Flurry)` swings, NINE SECONDS later — two
//             slashes on Master of Spite, who is slain at 00:25:52.
//   00:26:24  `Auto attack is on.` — the next pull (Grandmaster R`tal).
//   00:26:53  `You try to slash Grandmaster R`tal, but miss! (Flurry)` — a flurry on an
//             AVOIDED swing. This is why the window reaches past the first fight: 123 of the
//             log's 253 flurry annotations are on miss lines, so a model that only reads
//             landed hits reports less than half the flurries there were.
// Every flurry swing must also be EXCLUDED from round counting (it is an extra swing by
// definition). The window carries incoming `(Riposte)` counters and a frenzy burst too, so the
// exclusion ledger has all three reasons populated at once. It ends mid-grind — R`tal is still
// alive — which is the live case the panel has to render honestly.
slice(1241090, 1241650, 'w51-round-flurry-era.log')

// W52 THE CLEAVE LANE (Wed Aug 05 17:05:51 -> 17:08:03, raw 1369065..1369590) — JOS-77, user
// report 01KZCZ3BYRQRD4JQJ0PW7FQRG5: "the combat parser does not appear to capture cleave, or
// at a minimum it's not split out like Frenzy, Bash and Kick are." The damage was always
// counted; `meleeSkill('cleave')` answered "Melee", so no Cleave ROW could exist.
//
// THE OWNER'S LOG HAS NO SELF CLEAVE AT ALL — zero `You cleave` lines in 1,404,458, against
// 71k `You slash`, because Cleave is a WAR-only skill (classes.json) and he has never carried
// it. So this window pins the two arms his bytes DO have, and the test injects the third:
//   PET  — `a gust of wind`, a charmed pet, cleaves throughout. Its claim tell
//          (`Attacking an essence tamer Master.`) is line 1, so the whole window is bound and
//          nothing has to reach backwards (a tell binds FORWARD, JOS-49).
//   INCOMING — an essence carrier and an essence tamer both cleave YOU, landed and avoided,
//          so the enemy lane and the avoided-swing (`tries to cleave YOU`) path are both live.
// The window ends on the carrier's death + its two loot lines, so the fight closes inside it.
slice(1369065, 1369590, 'w52-cleave-lane.log')

// W57 THE RANGED LANE (Mon Aug 03 16:06:51 -> 16:07:09, raw 1142851..1142980) — JOS-92, a
// ranger's report: "Could you split Ranged (bow) into another field separate from Melee? …
// stance switching Ranger/Ranged stance uses bow in melee. currently that is lumped into the
// same bar as melee." `shoot` has been in MELEE_VERBS since the missing-verbs fix, so bow
// damage was always COUNTED; `meleeSkill('shoot')` answered "Melee", so no Ranged ROW existed.
//
// THE OWNER HAS NEVER FIRED A BOW — `You shoot` is ZERO across all three of his logs and all
// 101 committed fixtures, and `You have become better at Archery!` ticks exactly ONCE in
// 1,438,942 lines (the rarest skill in the file, tied with Forage and Pick Lock). Every one of
// the log's nine `shoots` damage lines belongs to some OTHER player. So this window pins the
// arms his bytes DO have and the test injects the self arm, exactly as W52 does for cleave.
//
// Chosen because the owner is fighting HARD through the whole span while a bow user works the
// mob beside him — which is what makes it the law-8 control. Inside it:
//   HIS OWN FIGHT — Commander Yarik, unbroken: slash / pierce / smite / bash / backstab /
//     frenzy / kick, the Smiting Strike proc, rune gains, a Blood Siphon Strike lifetap-heal
//     and incoming punches. Seven melee lanes that must not move by one point.
//   THE BOW — `Sinzar shoots a wanderer for 1 point of damage.` (16:06:59, the SINGULAR
//     `point of` arm), `… for 15 points of damage.` (16:07:02, the plural arm) and
//     `Sinzar tries to shoot a wanderer, but a wanderer dodges!` (16:07:05, the avoided-shot
//     arm, which lanes through the same meleeSkill() the landed one does).
// Sinzar is neither the owner, his pet, nor a rostered group member, so the ENGINE ignores his
// damage by design (routing.ts classify) — his bytes are here for the PARSER arms. The window
// ends mid-fight; Yarik is still up, which is the live case the meter has to render honestly.
slice(1142851, 1142980, 'w57-ranged-lane.log')

// W58 THE CRITICAL BOW SHOT (Fri Aug 07 16:09:42 -> 16:09:57, raw 1438572..1438700) — the one
// arm W57 lacks. `Brakk shoots a gloomwater mermaid for 60 points of damage. (Critical)` at
// 16:09:52 is a bow shot carrying a trailing paren modifier, and a whole-log sweep of all nine
// `shoots` lines proves `(Critical)` is the ONLY annotation the family has ever carried — there
// is no `(Double Bow Shot)` line anywhere (the one `bow shot` hit in the file is a player
// bragging about a score in General chat). The owner is mid-pull on gloomstalker mermaids
// throughout, slaying one at 16:09:42 and another at 16:09:57, so the span is a clean fight of
// his own with a real critical bow shot landing beside it.
slice(1438572, 1438700, 'w58-ranged-critical.log')

// ---------------------------------------------------------------------------
// W61 A CC HOLD SPEAKS FOR AN ENGAGED HOSTILE — NOT FOR YOUR OWN PET (JOS-176). The owner's
// Fused Hate run, Sun Aug 09: the Grandmaster R`tal encounter OPENED at 20:10:02, seventy-eight
// seconds before the pull, so the boss fight's meter carried the whole preceding twin skirmish.
//
// The shape only exists because in the Plane of Hate the owner's CHARMED PET and the mobs he is
// killing share one name — `Innoruuk`s Chosen` — so the world model holds a charmed instance and
// hostile twins under one nameKey, and a CC line naming that name resolves to whichever instance
// is live. Two spans, because the pet is bound six minutes before the window and a combat-only
// cut cannot establish it (the same prime-then-window arrangement W35 → W36 uses).
// ---------------------------------------------------------------------------

// W61 PRIME (Sun Aug 09 20:02:45 → 20:03:17, raw 1502972..1503072) — the charm bind, nothing
// else. `You begin casting Allure VI.` at 20:02:58, `Innoruuk`s Chosen has been charmed.` at
// 20:03:02 (inside the arm, so the ownership gate BINDS it), and the pet's own claim tell
// `Innoruuk`s Chosen told you, 'Attacking Coercer T`vala Master.'` at 20:03:17 confirming it.
// The span opens on the zone line, so the replay starts from an empty world model.
slice(1502972, 1503072, 'w61-twin-mez-prime.log')

// W61 THE WINDOW (Sun Aug 09 20:08:50 → 20:11:59, raw 1505971..1507053). Hand-read beats:
//   20:08:50  `Master of Spite has been slain by Innoruuk`s Chosen!` — a clean start: the
//             previous pull is over and 15s of quiet follow, so the skirmish below provably
//             opens its own encounter.
//   20:09:05  the twin skirmish opens (`You bash Innoruuk`s Chosen for 4 points of damage.`) —
//             a HOSTILE `Innoruuk`s Chosen`, spawned as gen 2 beside the charmed gen 1.
//   20:09:18  `Innoruuk`s Chosen has been mesmerized.` — the owner's own mez, which correctly
//             resolves to the HOSTILE twin (gen 2) and opens a 120s hold on it.
//   20:09:50  `Innoruuk`s Chosen has been slain by Innoruuk`s Chosen!` — gen 2 dies, and its
//             hold is cleared by the death path (88s of it still unexpired).
//   20:10:02  `Your Dazzle spell has worn off of Innoruuk`s Chosen.` — a CC REFRESH (JOS-161:
//             the caster-only wear-off line parses as `cc {refresh:true}`), and by now NO
//             hostile twin is live, so it resolves to the only remaining instance of that
//             name: THE OWNER'S OWN PET. It opens an encounter and stamps a hold on the pet
//             until 20:12:02.
//   20:10:38  the second twin (gen 3, spawned right after) is slain. Every engaged hostile is
//             now gone and the fight should close five seconds later.
//   20:10:43→ 46 SECONDS OF SILENCE. The pet's hold vetoed the death-close for all of it.
//   20:11:20  the pet re-tells (`Attacking Grandmaster R`tal Master.`) and at 20:11:24 R`tal
//             lands the pull's first blows — which, pre-fix, joined the 20:10:02 encounter.
// The window stops at 20:11:59, six seconds before the charm breaks and the pet turns on the
// owner: everything after that is a different story and none of it is load-bearing here.
slice(1505971, 1507053, 'w61-twin-mez-skirmish.log')

// ---------------------------------------------------------------------------
// W71 A RAIN CAST IS ONE CAST, NOT A CAST PLUS TWO PROCS (JOS-414, GitHub issue 39).
// ---------------------------------------------------------------------------
// The reporter's screenshot showed `Lava Storm` and `Lava Storm · proc` as two rows of one
// fight. The owner casts no Lava Storm, but he casts `Poison Storm` 86 times — the same
// mechanic and the same wave shape — and this is the tightest span carrying one clean cast.
//
// Thu Aug 13 14:50:09 → 14:50:30, raw 1668894..1668989. Hand-read beats:
//   14:50:09  `You have slain a shin ghoul knight!` — the previous kill, so the fight below
//             provably opens its own encounter.
//   14:50:19  `You begin casting Poison Storm.`
//   14:50:20  wave 1 — 61
//   14:50:23  wave 2 — 61   <- the cast record already claimed 14:50:20, so before JOS-414
//   14:50:26  wave 3 — 61   <- this pair scored `proc` and opened a `Poison Storm · proc` lane
//   14:50:30  the knight dies; the span stops before the next pull (14:50:53) and before the
//             one general-chat line at 14:50:43, which the shared scrub drops anyway.
// One target throughout, so the three lines are three WAVES and nothing else — the AE breadth
// half of the mechanic is covered by the synthetic N x M cast in the test.
slice(1668894, 1668989, 'w71-rain-waves.log')
