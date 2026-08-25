// One-off PET-CLAIM fixture extractor (JOS-47) — the unbound pet, the public lines it speaks,
// and the damage the meter throws away because nothing in the log says whose it is.
//
//   npm run fixtures:pet-claim -- "<path-to-eqlog>"
//
// (Run it under the tsx loader like its siblings — tests/fixture-scrub.mjs is a shim over the
// TypeScript src/shared/logScrub.ts. The npm script already does.)
//
// SCRUB: routed through the SHARED scrub, like every extractor. THIS FAMILY IS THE SECOND
// REASON THE SCRUB CHANGED (the group extractor's header records the first). The six pet-voiced
// SAY sentences carry the quoted-speech comma-quote, so until JOS-47 they were dropped from
// every committed fixture and every feedback slice — and they are the only public evidence that
// an entity is somebody's pet. They are an NPC's words and an NPC's name, so the carve-out costs
// no one their privacy; see src/shared/logScrub.ts for the enumeration that made it exact.
//
// …and it is the FOURTH reason too (JOS-52): `<Name> says, 'My leader is <You>.'` is the one
// pet-voiced line that names its OWNER, so it is the one that binds — and the one that carries a
// player's name inside the quote, so its carve-out is gated on `selfName` rather than on the
// speaker being an NPC. `keep()` below passes 'Primitive', which is what lets this extractor cut
// the owner's own answer while a stranger's pet naming a stranger still falls to the drop list.
//
// WHAT IS KEPT INSIDE A WINDOW: everything the scrub allows, verbatim and contiguous. The
// candidate detector reasons about SHARED TARGETS over time, so a window filtered down to "just
// the pet lines" would prove nothing at all.
//
// Line numbers below were located in eqlog_Primitive_freeport.txt on 2026-08-06. The log only
// ever APPENDS, so historical line numbers stay valid as it grows; re-locate if it is truncated
// or rotated.
import { readFileSync, writeFileSync } from 'fs'
import { dirname, join } from 'path'
import { fileURLToPath } from 'url'
import { scrubKeep } from './fixture-scrub.mjs'

// Fixtures resolve RELATIVE to this file — never hardcode a repo path here.
const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), 'fixtures')
const LOG = process.argv[2]
if (!LOG) throw new Error('usage: npm run fixtures:pet-claim -- "<path-to-eqlog>"')
const lines = readFileSync(LOG, 'utf8').split(/\r?\n/)

/** A scrub-surviving, timestamped log line. Self is 'Primitive' — the owner's own /who row. */
function keep(line) {
  return line.startsWith('[') && scrubKeep(line, { selfName: 'Primitive' })
}

/** Write one fixture from a 1-based inclusive line RANGE. */
function slice(from, to, out) {
  const seg = []
  for (let i = from - 1; i < to && i < lines.length; i++) {
    if (keep(lines[i])) seg.push(lines[i])
  }
  writeFileSync(join(FIXTURES, out), seg.join('\n') + '\n')
  console.log(`${out}: ${seg.length} lines`)
  return seg
}

// P1 — THE UNBOUND PET, TWENTY MINUTES OF IT (Thu Jul 30 16:10–16:30, Solusek's Eye).
//
// The owner's ENCHANTER animation pet, summoned by `Yegoreff's Animation`. It is called Kober,
// and the app has never once been able to see it, because:
//   * it is not charmed, so there is no `has been charmed.` broadcast to bind it;
//   * the owner never ORDERS it, so it never sends the private `… Master.'` tell that is the
//     only signal a summoned pet's binding has ever had.
// It says `Sorry, Master... calming down.` twice, `Now regrouping, master.` once and
// `As you wish, oh great one.` once — all PUBLIC, all worthless as proof of ownership on their
// own, and until this extractor all four were scrubbed out of every fixture in the repo.
//
// Meanwhile it lands 105 hits for 1,966 points across four mobs, THREE of which the owner is
// hitting too (a noxious spider, a sonic bat, a fire giant warrior). Every one of those hits is
// dropped by classify()'s admission gate. This window is the reporter's bug reproduced in the
// owner's own log, which is the whole reason it is the fixture.
//
// It also carries its own NEGATIVE CONTROL: `Guard Effel` is proper-named, fights the same
// mobs, and is a HOSTILE — it swings at the owner. Nothing may ever offer it as a pet.
const p1 = slice(491470, 493040, 'p1-unbound-pet.log')

// The extractor asserts what it believes rather than writing a hollowed-out fixture (the
// session extractor's rule). If the scrub's DROP list ever grows back over the pet-say family,
// this fails loudly here instead of silently turning the golden window into a mute one.
const counted = (re) => p1.filter((l) => re.test(l)).length
const expected = [
  [/^\[.*\] Kober says, 'Sorry, Master\.\.\. calming down\.'$/, 2],
  [/^\[.*\] Kober says, 'Now regrouping, master\.'$/, 1],
  [/^\[.*\] Kober says, 'As you wish, oh great one\.'$/, 1]
]
for (const [re, n] of expected) {
  const got = counted(re)
  if (got !== n) throw new Error(`p1-unbound-pet.log: expected ${n} line(s) matching ${re}, got ${got}`)
}
// …and the two things the window must NOT contain, because their absence is the bug.
for (const [re, what] of [
  [/^\[.*\] Kober told you, /, 'a private pet tell'],
  [/^\[.*\] Kober has been charmed\.$/, 'a charm broadcast']
]) {
  if (counted(re) !== 0) throw new Error(`p1-unbound-pet.log: ${what} for Kober would defeat the fixture`)
}
const koberHits = p1.filter((l) => /\] Kober [a-z]+ .* for \d+ points? of damage\.$/.test(l)).length
if (koberHits < 90) throw new Error(`p1-unbound-pet.log: expected the pet's combat lines to survive, got ${koberHits}`)
const guardHits = p1.filter((l) => /\] Guard Effel /.test(l)).length
if (guardHits < 10) throw new Error(`p1-unbound-pet.log: the negative control (Guard Effel) must be present`)
console.log(`p1-unbound-pet.log: 4 pet says, ${koberHits} unbound pet hits, ${guardHits} negative-control lines`)

// P2 — THE WHOLE ARC OF A PET, IN ELEVEN MINUTES (Thu Aug 06 12:34–12:46, a Nagafen's Lair
// instance). Located by the owner, JOS-49.
//
// P1 is a pet that is NEVER bound; this is the other half of the story, and the half the
// currency gate exists for — the same window carries the UNBOUND period, the tell that ends it,
// the second pet that replaces the first, and that one's tell:
//
//   12:35:28  you zone into your own instance
//   12:35:43  `You begin casting Kintaz's Animation.` → Jaber
//   12:35:47→ Jaber fights the greater kobolds you are fighting. It is UNBOUND for seven and a
//             half minutes: nothing tells you it is yours, so every point of it is dropped.
//   12:43:12  `Jaber told you, 'Attacking a greater kobold Master.'` — the tell BINDS. The
//             question retires (it is an unbound-state offer).
//   12:44:45  a second Kintaz cast → Gonekn; the single-pet invariant retires Jaber.
//   12:44:51  Gonekn's own tell binds it, three seconds after its first swing.
//
// AND THE ANIMATION CASTS SPELLS, which is the fact this window exists to nail down. Jaber opens
// with `Jaber begins casting Wrath.`, lands 168-point magic hits by it, casts Stun, Daring and
// Symbol of Ryltan, and HEALS ITSELF (`Jaber healed himself for 104 hit points by Daring.`). A
// detector that treated casting or self-healing as player-shaped evidence would disqualify the
// one entity the feature exists for, silently, on the owner's own current pet.
//
// ONE LINE IN THIS SPAN WAS DELIBERATELY LOST TO THE SCRUB UNTIL JOS-52: `Jaber says, 'My leader
// is Primitive.'` (12:44:20), the `/pet who leader` answer. It is quoted speech outside the six
// pet-voiced sentences, so `scrubKeep` dropped it and the assertion below pinned its ABSENCE, so
// that the golden could not start depending on it before the carve-out existed. JOS-52 added the
// carve-out (gated on `selfName`, since this is the one pet-voiced line that names a PLAYER) and
// the bind, so the fixture was RE-CUT through the new scrub and the assertion is now a positive
// one. Re-cutting was measured before it was chosen: this line is the ONLY byte that moved in
// either fixture (p1 is byte-identical — the whole 1.4M-line log holds exactly one leader say),
// it arrives at 12:44:20 when Jaber has been bound by its own tell since 12:43:12, and
// `world.claim()` is idempotent — so every number in petClaimWindows.test.mts is unchanged, which
// that file's tests re-assert line by line.
const p2 = slice(1399620, 1400300, 'p2-pet-arc-bound.log')

const p2has = (re) => p2.filter((l) => re.test(l)).length
for (const [re, n, what] of [
  [/^\[.*\] You begin casting Kintaz's Animation\.$/, 2, 'both animation casts'],
  [/^\[.*\] Jaber told you, 'Attacking a greater kobold Master\.'$/, 1, "Jaber's binding tell"],
  [/^\[.*\] Gonekn told you, 'Attacking a greater kobold Master\.'$/, 1, "Gonekn's binding tell"],
  [/^\[.*\] Jaber says, 'My leader is Primitive\.'$/, 1, 'the /pet who leader answer (JOS-52)']
]) {
  const got = p2has(re)
  if (got !== n) throw new Error(`p2-pet-arc-bound.log: expected ${n} × ${what}, got ${got}`)
}
for (const [re, what] of [
  [/^\[.*\] Jaber (begins casting|hit .* by |healed himself)/, "Jaber's spellcasting and self-heal"],
  [/^\[.*\] Gonekn says, 'Sorry, Master\.\.\. calming down\.'$/, "Gonekn's pet-voiced says"]
]) {
  if (p2has(re) === 0) throw new Error(`p2-pet-arc-bound.log: ${what} must survive the scrub`)
}
const jaberHits = p2.filter((l) => /\] Jaber .* for \d+ points? of (magic )?damage/.test(l)).length
const gonekHits = p2.filter((l) => /\] Gonekn .* for \d+ points? of (magic )?damage/.test(l)).length
console.log(`p2-pet-arc-bound.log: Jaber ${jaberHits} hits, Gonekn ${gonekHits} hits, 2 binding tells`)

// P3 — THE UPGRADED PET, AND THE BUFF THAT NAMES IT (Sun Jul 19 21:06–21:12, Oggok). JOS-188.
//
// The reporter's defect ("if you change pets, they stop showing up in the damage meter — I
// upgraded from a level 10 water elemental to a level 14 … relogging did not resolve"), in the
// OWNER'S OWN BYTES, which is why the fixture is this window and not the reporter's slice
// (AGENTS.md: a reporter's slice never becomes a fixture):
//
//   21:06:26  `Vebann told you, 'Attacking Lost Crusader Master.'` — the PREDECESSOR, bound the
//             only way the app has ever been able to bind one: the owner ordered it.
//   21:09:29  `You begin casting Haunting Corpse.` — the upgrade. The game says NOTHING about
//             the pet it replaces (JOS-54's whole premise) and the successor has a new name, so
//             the claim that would retire Vebann never arrives.
//   21:09:55  `You begin casting Intensify Death.` — a `targetType: Pet` spell. Only the player
//             prints this line, and the game will not let the spell land on anyone else's pet.
//   21:10:02  `Vabantik's eyes gleam with madness.` — the landing NAMES the new pet.
//   21:10:44→ Vabantik fights. Before JOS-188 every point of it was nobody's.
//   21:12:31  `Vabantik told you, 'Attacking an ogre guard Master.'` — the tell, 149 SECONDS
//             after the buff already said whose it was.
//
// The window is the measurement in miniature: whole-log, the pet-buff rung binds 14 names and
// all 14 are names a tell ALSO binds, always later — 1,865 hits / 27,088 points arrive in those
// gaps. Here it is 76 hits / 1,356 points, and the same bind retires Vebann.
const p3 = slice(117380, 119420, 'p3-pet-upgraded-buff-bound.log')

const p3has = (re) => p3.filter((l) => re.test(l)).length
for (const [re, n, what] of [
  [/^\[.*\] Vebann told you, 'Attacking Lost Crusader Master\.'$/, 1, "the predecessor's binding tell"],
  [/^\[.*\] You begin casting Haunting Corpse\.$/, 1, 'the re-summon'],
  [/^\[.*\] You begin casting Intensify Death\.$/, 1, 'the own cast of the pet-only spell'],
  [/^\[.*\] Vabantik's eyes gleam with madness\.$/, 1, 'the landing that names the successor'],
  [/^\[.*\] Vabantik told you, 'Attacking an ogre guard Master\.'$/, 1, "the successor's late tell"]
]) {
  const got = p3has(re)
  if (got !== n) throw new Error(`p3-pet-upgraded-buff-bound.log: expected ${n} × ${what}, got ${got}`)
}
// The gap between the buff and the tell IS the fixture. A window that lost either end, or that
// crossed a zone line (which would retire the world model out from under the succession), proves
// nothing at all.
if (p3has(/^\[.*\] You have entered /) !== 0)
  throw new Error('p3-pet-upgraded-buff-bound.log: a zone line inside the window would reset the world model')
const vabantikHits = p3.filter((l) => /\] Vabantik .* for \d+ points? of (\w+ )?damage/.test(l)).length
const vebannHits = p3.filter((l) => /\] Vebann .* for \d+ points? of (\w+ )?damage/.test(l)).length
if (vabantikHits < 60) throw new Error(`p3-pet-upgraded-buff-bound.log: the successor's hits must survive, got ${vabantikHits}`)
console.log(`p3-pet-upgraded-buff-bound.log: Vebann ${vebannHits} hits, Vabantik ${vabantikHits} hits, buff bind 149s before the tell`)

// P4 — THE BOUND PET WHOSE KILLS WENT TO NOBODY (Sun Aug 23 13:42–13:53, The Plane of Hate 4
// (Refined)). JOS-454, and the half of JOS-188 that never left the combat engine.
//
// P3 proves the pet-buff rung BINDS. This window proves who was never told:
//
//   13:42:27  `You begin casting Cackling Bones.` — the necromancer pet summon. The pet is
//             Vibartik, a proper-named SUMMONED pet and NOT a charm (the ticket reported him as
//             a charmed shadow knight; there is no charm broadcast for that name anywhere).
//   13:42:42  `You begin casting Augment Death.` — a `targetType: Pet` spell.
//   13:42:43  `Vibartik's eyes gleam with madness.` — the landing. The combat engine binds him
//             here, on the spot, and the DPS meter has had him ever since.
//   13:49:08  `A revultant rat has been slain by Vibartik!`
//   13:52:46  `An evil little imp has been slain by Vibartik!`
//
// …and NOT ONE `… Master.'` TELL, in this window or for another 45 minutes after it (the first
// is at 14:37:53). The ProgressionModule — which is what the Leveling tab's kill counts,
// levels-per-hour and idle classifier are folded from — knew only the tell and the charm
// broadcast, so it filed both of those kills as `witnessTs`, somebody else's, under a panel
// reading "2 kills by others seen" beside a meter that had the pet bound the whole time.
//
// The ABSENCE of the tell is the fixture, exactly as in P1: with one, nothing here proves
// anything.
const p4 = slice(2442745, 2446766, 'p4-pet-buff-kill-credit.log')

const p4has = (re) => p4.filter((l) => re.test(l)).length
for (const [re, n, what] of [
  [/^\[.*\] You begin casting Cackling Bones\.$/, 1, 'the pet summon'],
  [/^\[.*\] You begin casting Augment Death\.$/, 1, 'the own cast of the pet-only spell'],
  [/^\[.*\] Vibartik's eyes gleam with madness\.$/, 1, 'the landing that names the pet'],
  [/^\[.*\] A revultant rat has been slain by Vibartik!$/, 1, "the pet's first kill"],
  [/^\[.*\] An evil little imp has been slain by Vibartik!$/, 1, "the pet's second kill"]
]) {
  const got = p4has(re)
  if (got !== n) throw new Error(`p4-pet-buff-kill-credit.log: expected ${n} × ${what}, got ${got}`)
}
for (const [re, what] of [
  [/^\[.*\] Vibartik told you, /, 'a pet tell'],
  [/^\[.*\] Vibartik says, 'My leader is /, 'a leader say'],
  [/^\[.*\] Vibartik has been charmed\.$/, 'a charm broadcast'],
  [/^\[.*\] You have entered /, 'a zone line, which would reset the world model mid-arc']
]) {
  if (p4has(re) !== 0) throw new Error(`p4-pet-buff-kill-credit.log: ${what} would defeat the fixture`)
}
const p4self = p4has(/^\[.*\] You have slain .+!$/)
const p4exp = p4has(/^\[.*\] You gain experience!/)
if (p4self < 6) throw new Error(`p4-pet-buff-kill-credit.log: the owner's own kills must survive, got ${p4self}`)
console.log(`p4-pet-buff-kill-credit.log: ${p4self} self kills, 2 pet kills, ${p4exp} experience lines, 0 tells`)
