# Group model — who you're with, and what you're battling

Status: DESIGN. Author: planning session (Fable), 2026-08-05. Owner-requested
same day ("definitely make a group model if possible — then we can allowlist
those members… who you're with and what you're battling should be the focus").
Triggered by feedback 01KZA9BVNYDKN9FDVT2N6ZVYPS (group member missing from
meters); the PARSE half of that report is a separate fix already in flight —
this model is the presentation-layer half, and neither depends on the other.

**JOS-430 (owner ruling 2026-08-20) MADE §0 TRUE.** For the whole life of this
plan §0 described an intent the build contradicted: `classify()`'s admission
gate meant the roster decided whether a bystander's damage was RECORDED, so a
wrong or empty roster did corrupt a number — it deleted one. The ruling
("Everyone means ANY fight the log can see; participation not required") moved
recording out from behind the roster: every player-vs-mob row is recorded, as
`SourceKind 'other'` when nothing claims the name, and the roster's remaining
jobs are the ENGAGEMENT LICENCE (a member's target is a mob YOUR fight is
engaged with; a stranger's is not) and the Group allowlist. Read
`src/main/combat/otherCombatants.ts` for the refusal ladder and its whole-log
measurements, `otherRouting.ts` for the aggregate-only discipline a recorded row
keeps, and `tests/combatRecordEveryone.test.mts` for the pins. §3.5 below is
kept verbatim as the diagnosis it was; the sentence in it that begins "So G2's
exact surface is" describes a build that has now been superseded.

## 0. The one rule that protects everything else

THE ROSTER NEVER TOUCHES THE PARSER. The combat engine records every entity's
damage exactly as today — pets, charm pets, bystanders, NPC-vs-NPC. The group
model is a separate module whose snapshot the METERS consult when choosing
which rows to show. A wrong roster can therefore hide a row, never corrupt a
number; switching scope re-filters the same recorded truth. This is what
"shouldn't interfere with other parser accuracy" means structurally.

## 1. Membership truth (messages, law 1 — never proximity inference)

Fold, in one main-process module (registry pattern, beside combo/buffs):

- `Soandso has joined the group.` / `You have joined the group.` → add
- `Soandso has left the group.` / `You remove Soandso…` / disband shapes → remove
- `Soandso tells the group, '…'` / `You tell your party, '…'` → CONFIRM
  (re-assert membership; also the recovery path when a join predates the log)
- EQ Legends instance roster: `X has been added to/removed from <instance> - Group.`
  → add/remove with `source: instance` (these even survive the slice scrubber)
- Explicit user edits (see §3) → `source: user`, which outranks everything —
  same provenance ladder the class combo already uses (user > stated > inferred).

Per-member record: `{name, source, sinceTs, lastConfirmedTs}`. Epoch boundary
clears the roster (same contract as every character-scoped module). An
`offlineGap` does NOT clear it — EQ drops groups silently on camp, so the
post-login roster is marked STALE (rendered dimmed) until any confirm signal
lands; stale members still pass the allowlist (hiding a real member is the
worse error — it is literally the bug that started this).

**G4 — THE SECOND RECOVERY PATH (JOS-85, shipped; report
01KZEWFNSEHJN33W1BA797F806).** The rungs above all read a line EQ prints ONCE,
and `confirm` — the one rung meant to survive a group that predates the log
window — needs somebody to talk. A quiet group never does, and the scrub strips
group chat from every artifact anyway. Measured on the reporter's slice: 12,376
lines, 5,726 damage events, **zero group events of any kind**, so the roster
stayed empty and the admission gate dropped 1,544 damage events / 174,922 points
from one group-mate and 612 / 84,277 from the other — invisible under Group AND
under Everyone, because nothing was ever recorded for Everyone to show.

The path added is a CONJUNCTION of two lines the game states outright:

- `You activate Quick Buff.` → one cast printing two or more
  `You healed <X> … by <Spell>.` lines in the SAME second. This ENUMERATES the
  people your buffs reached. Owner's log: 83 such casts, **all 83** within 15 s
  of a Quick Buff line, so the shape is about that ability and not about spell
  target types — the wiki DB calls the very spells involved "Single Friendly",
  which is a fact about a different server.
- `You gain party experience!` → a group exists right now. Names nobody.

Neither is sufficient. The fan-out alone names three other players in the
owner's log, one inside a join-proven group window on all 11 appearances and two
a townside buff hand-out; requiring a party-exp line EARLIER IN THE SESSION
removes exactly those two, and the result is identical at every backward window
from 2 minutes to 6 hours. The gate is therefore sticky, backward-only, and
ended by the same things that end a group (epoch, self-leave, offline gap).
Provenance `buffed`, the WEAKEST rung — a burst also lands on your own pets, so
the tailed character, every charmed mob and every claimed pet are refused, the
pet refusals retroactively and for this rung only. Whole-log regression: the
owner's 900,562-line log produces a byte-identical roster (Dranix and Rykkerr,
both `joined`) and the new rung never fires. src/main/modules/buffFanOut.ts,
tests/groupBuffFanOut.test.mts, tests/fixtures/g2-buff-fanout.log.

Fixture reality check before building: sweep the committed log corpus for the
exact join/leave/tell shapes (the fixtures extractor family is the tool). Any
shape not found in the corpus ships behind a test written from the wiki text
and is labeled unverified in a comment.

## 2. Scopes — the meter question this answers

Three, on the combat dashboard AND each damage/heal overlay:

- **You** — you + your pets (today's drill default, unchanged)
- **Group** — you + roster members + pets ATTRIBUTED BY THE EXISTING
  pet-ownership logic (petRows) to any of those. Charm pets follow whatever
  attribution already decides; this plan changes no attribution.
- **Everyone** (THE DEFAULT, JOS-229) — every recorded source. Since JOS-430
  that means EVERY COMBATANT THE LOG NAMED, including everyone the roster never
  heard of; before it, "every recorded source" was a much smaller set than it
  sounded, because the roster gated what got recorded.

Defaulting: if the roster is EMPTY or the model has seen no signal this
session, Group scope is not silently wrong — it falls back to rendering as
Everyone with the scope chip showing `Group (no roster yet)`. Law 1: an empty
roster means unknown, and unknown must not hide people. The moment a signal
lands, the allowlist engages.

**JOS-229 MOVED THE DEFAULT TO EVERYONE.** This plan shipped Group as the
default (G2 below) on the strength of that fallback: an empty roster can hide
nobody, so the narrow answer looked free. It is free only for the EMPTY
roster, not the WRONG one — membership here is inferred from lines the game
prints once, so a join the log never carried, a group formed before the app
was open, or a break EQ never announced leaves a roster the model has "seen"
and that is missing a real player. Group then hides that player's bars with no
fallback to explain it, and the report the owner receives is that the damage
meter is broken. So the opening answer is the one that filters nobody, and
Group is a deliberate narrowing a user asks for. It is a FRESH-STATE default
only: `eq.combat.meterScope` is written exclusively by the Preferences control,
so a stored 'group' is a choice and is handed back untouched — no migration.
The deeper fix (making membership detection less lossy) is separate work.

"What you're battling" needs no new model — fights/targets are already
segmented; scope only filters SOURCES, never targets.

## 3. UI

- Scope control: **one preference, in Preferences > Combat** (JOS-115). It
  shipped as a compact three-state chip repeated on the combat toolbar and on
  every overlay header, each persisting its own key; the owner retired that —
  a selector on every surface is clutter answering a question you set once,
  and three surfaces holding three answers was the common case rather than the
  useful one. One key (`eq.combat.meterScope`, default Everyone since
  JOS-229), read by the Combat tab, the Overview damage card and every
  floating meter.
- Scope visibility: the surfaces keep the WORD, read-only — the Combat tab's
  lens line and, on the floating meters, the PANEL FLOOR (JOS-121). A meter
  that is filtering rows out has to be able to say so where the rows are
  missing, and `Group (no roster yet)` is the sentence that explains the law-1
  fallback. On an overlay the word started in the title bar beside the kind
  tag; that row is also the fight selector's whole width budget and the
  window's only drag handle, so it moved down to an understated, low-contrast,
  `pointerEvents: none` watermark in a reserved band at the bottom of the bars
  pane (`src/renderer/src/overlay/scopeFloor.tsx`). Two consequences worth
  stating: the band is reserved rather than shared, so a bar can never cover
  the long form; and unlike the header tag it replaced, it does NOT vanish
  when the overlay is locked — a pinned meter has no selector, no controls and
  no tooltip left, so it is the one that most needs to be able to say why a
  name is missing.
- Roster visibility: a small popover from the group icon beside that readout,
  listing members with provenance (joined · confirmed · instance · added by
  you · stale), each removable; an add box (name entry) for the member whose
  join message the log never carried. Still a CONTROL: correcting a
  mis-inferred group is a different act from choosing a scope. User edits
  persist per character until epoch.
- Nothing about the roster is ever transmitted: names stay local (same law as
  everything else; telemetry carries no names, slices already scrub group
  social lines).

## 3.5 Root cause of the triggering report (verified by slice replay, 2026-08-05)

The reporter's slice replayed through the real parser and engine settles it:
every damage-shaped line parses (0 unmatched shapes; `reaves`, `Reaving
Strike`, damage-shield credits all covered), and the group member still appears
in ZERO fights — because `classify()` (src/main/combat/routing.ts:48) is the
single admission gate and its last rule is `attacker not you/pet, target not
you → ignore`. 2,224 parsed events fell through that line. Deliberate solo
scoping (Task #65's protections against strangers entering the model), not a
regression.

So G2's exact surface is: `classify()` grows a roster parameter and an
`out-member` attribution; `outSource()` grows a `member` SourceKind (per-member
rows, same instance discipline as pets); `engageHostile()` already refuses
known players and MUST also refuse roster members (a member's TARGET engages,
the member never does — the 214-second-merged-pull failure is the cautionary
tale); lifecycle liveness must never read member presence as hostile presence.
Incoming-on-members (mobs hitting your group) stays OUT of scope for G2 —
sources first, one wave at a time.

- **G1 — the module**: shapes swept from corpus, roster module + deltas +
  tests (join/leave/confirm/instance/stale/epoch), no UI. Ships dark.
- **G2 — scope filtering**: meters + overlays consume the snapshot; scope
  chip + persistence; Group default with the no-roster fallback (JOS-229 later
  moved that default to Everyone — see §2); e2e coverage
  via the E2 fixture-append driver (write join lines into the tailed fixture,
  assert the allowlist engages live).
- **G3 — roster popover + user edits** (provenance ladder, add/remove).

G1 must not start until the in-flight combat parse fix lands (its verdict
table may add verb shapes the sweep should include); G2 depends on e2e wave
E2 only for its e2e, not for shipping.
