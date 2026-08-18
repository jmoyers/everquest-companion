// Cut the committed fixtures for the resist fold (JOS-382).
//
// Run: `npm run fixtures:resist -- <path to the live log>`
//
// Every line goes through the shared scrub (`scrubKeep`), like every other extractor in this
// directory: the repo is public, and the scrub DROPS third-party chat rather than rewriting it —
// a rewritten line still parses into a fake event and would pollute the golden expectation.
//
// ── r1-kodiak-fight.log ─────────────────────────────────────────────────────────────────────────
//
// Hand-read window, West Commonlands, Tue Jul 28 2026 16:42:13 to 16:45:56. It was chosen because
// one pull contains every shape the fold has to get right, and it contains them about a mob whose
// name has an ARTICLE:
//
//   * the zone line that opens it, so the fold has a zone to file rows under;
//   * `You begin casting Languid Pace.` joined to `a kodiak slows down.` — an all-or-nothing
//     landing earned by a cast-to-emote join, the only way one is ever earned;
//   * `You hit a kodiak for 30 points of magic damage by Chaotic Feedback.` repeatedly at the SAME
//     value, which is what a fixed-damage nuke landing in full looks like and what the estimator
//     later reads partials against;
//   * `You crush a kodiak for 35 points of damage. (Critical)` — a crit, which is a LANDING and
//     must never enter the damage histogram (its number is not the spell's full damage);
//   * `You hit a kodiak for 28 points of magic damage by Smiting Strike.` — the -250 proc, whose
//     resist adjust is the whole argument for modelling adjusts at all;
//   * `A kodiak resisted your Chaotic Feedback!` and `A young kodiak resisted your Chaotic
//     Feedback!` — note the CAPITALISED article, where every damage line above spells it
//     lowercase. Both fold to one key or the whole feature counts one mob as two;
//   * `Your Chaotic Feedback spell fizzles!` — a cast that never happened, and must file nothing;
//   * melee both ways, which is what puts a mob "in contact" for a song pulse;
//   * two kills, so the debuff windows and the contact set have something to close on;
//   * a `/con` line, which is how a mob's level beats the catalog's.
//
// ── r2-song-pulses.log ──────────────────────────────────────────────────────────────────────────
//
// Hand-read window, Sun Jul 19 2026 16:29:32 to 16:30:02 — six consecutive SYMPHONIC AURA pulses,
// and the whole reason round two of this ticket exists. There is no cast line anywhere in it: the
// aura re-pulses every six seconds by itself, and what the log prints is
//
//     [16:29:32] Your feet move faster.                                   <- the aura's heartbeat
//     [16:29:32] Soldier of V`Zher resisted your Largo's Melodic Binding!  <- a pulse that missed
//     [16:29:32] Baron Telyx V`Zher is bound by strands of solid music.    <- a pulse that landed
//
// repeated at :38, :44, :50, :56 and 16:30:02, exactly six seconds apart. So for a song whose
// landing sentence the catalog knows, attempts are lands plus resists EXACTLY, per mob, with
// nothing reconstructed — and a fold that files the resists and drops the landings (which is what
// shipped before this window was cut) reports a mob that resists 100% of everything.
//
// It also carries the naming defect this feature has to survive: the catalog files
// "is bound BY strands of solid music" under Largo's ASSONANT Binding (Bard 51) while every resist
// line here names Largo's MELODIC Binding (Bard 20), cast by a level-21 character. See
// src/main/resist/songIdentity.ts.
//
// ── r3-song-shared-message.log ──────────────────────────────────────────────────────────────────
//
// A second window, cut because ONE SENTENCE CAN BE TWO SONGS. `<mob> winces.` is the catalog's
// landing message for BOTH Denon's Disruptive Discord (Bard 18) and Chords of Dissonance (Bard 2),
// so the parser hands over a two-candidate list and the model has to resolve it — against what the
// log NAMED, which here is Denon's, eight times. Pooling the two instead would smear a -100 resist
// adjust into a spell that has none, which is the exact thing this model exists to take out.
//
// ── r4-npc-casters.log ──────────────────────────────────────────────────────────────────────────
//
// Hand-read window, Lavastorm, Thu Jul 30 2026 15:44:57 to 15:46:33 — the fight JOS-385 exists for.
// A pack of imp protectors is throwing Dry Bone Fire Burst at the player AND at each other while
// the player nukes one of them, so a hundred lines carry all four cases at once:
//
//   * `an imp protector hit an imp protector for 12 points of fire damage by Dry Bone Fire Burst.`
//     — an NPC caster landing on another NPC. THE new family: a fire observation about a creature
//     the tailed character never once cast fire at, with a caster level the catalog states.
//   * `An imp protector resisted an imp protector's Dry Bone Fire Burst!` — the other half of the
//     same binomial, five times, which is what makes the cell estimable rather than a count.
//   * `an imp protector hit you for 46 points of fire damage by Dry Bone Fire Burst.` — the SAME
//     spell from the SAME caster, on the player. It must file nothing: a row keyed `you` is a
//     statement about a creature's resist stat with a person in the creature's place.
//   * `You hit an imp protector for 147 points of magic damage by Smiting Strike.` — the player's
//     own casts on the same mob in the same seconds, so the fixture proves the two families land
//     in separate rows rather than pooling.
//
// It also carries `An imp protector begins casting Dry Bone Fire Burst.` a dozen times, which is
// the line the fold deliberately does NOT arm (fold.ts's header says why), and an
// `An imp protector has been slain by an imp protector!` to close a debuff window on.
//
// NOTHING IS INJECTED AND NOTHING IS AUTHORED. These are the owner's real bytes.

import { readFileSync, writeFileSync } from 'fs'
import { fileURLToPath } from 'url'
import { dirname, join } from 'path'
import { scrubKeep } from './fixture-scrub.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const LOG =
  process.argv[2] ??
  'C:/Users/Public/Daybreak Game Company/Installed Games/EverQuest Legends/Logs/eqlog_Primitive_freeport.txt'
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

slice(213496, 213730, 'r1-kodiak-fight.log')
slice(50380, 50700, 'r2-song-pulses.log')
slice(12400, 12660, 'r3-song-shared-message.log')
slice(490395, 490800, 'r4-npc-casters.log')
