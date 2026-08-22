---
name: explain
description: Render every decision currently waiting on the owner as a plain-English, self-contained decision sheet — no conversation history, Linear, or code access needed to decide. Use when the owner asks "explain those", "what's waiting on me", "give me the decision sheet" — AND (owner directive 2026-08-21) use it UNPROMPTED whenever presenting anything that needs an owner ruling: a gated ticket, a design fork, a triage readout item, a worker-flagged judgment call. If the owner must decide it, it goes through this format.
---

# The /explain decision sheet

The owner steers by making calls. This skill produces the document they make
them from: every open decision, explained so completely in plain language that
the owner can answer from the sheet alone — without scrolling the conversation,
opening Linear, reading code, or trusting memory. The sheet is the deliverable;
its quality bar is "decidable cold."

## When it fires (owner directive 2026-08-21: always, for any ruling)

Not only on request. ANY time a session needs an owner ruling — a gated
ticket ready for its call, a design fork a worker surfaced, a triage item
that isn't an obvious fix, a hold that could lift — the ask is presented in
this sheet format, unprompted. A ruling requested outside this format is a
ruling requested badly: if the owner has to reconstruct context to answer,
the question was not finished being asked. Scope the sheet to what actually
needs deciding (one item is a one-item sheet; the full gather below is for
"what's waiting on me" sweeps).

## Gather (all four sources, every time)

1. **Gated Linear tickets** — `npx tsx scripts/linear.mts list --state Todo`
   plus any In Progress ticket carrying an open sub-question. Anything whose
   title or latest comment says GATED / CHARACTERIZED / owner call / owner
   picks / DESIGN FIRST / CAPTURED is a sheet item. Read each with `show` —
   the body and comments carry the evidence to restate.
2. **Held feedback reports** — `npx tsx scripts/triage-feedback.mts list
   --since <window> --status new --profile eqc`, then `show` EVERY one (list
   output truncates descriptions at ~60 chars and is never sufficient — see
   the primary-evidence memory).
3. **Pending chips** — the session's spawn_task chips not yet clicked or
   dismissed.
4. **Session residue** — questions asked and not yet answered, worker-flagged
   judgment calls, deferred halves of multi-part reports. If the session is
   fresh, the latest JOS-153 ledger comments carry what was left open.

## Write (the rules that make it decidable cold)

- **Self-contained or it doesn't count.** Every item restates its story from
  zero: who reported what (quote short user phrasing verbatim — it carries
  color and precision), what was found, what is true now. If the owner would
  need to open anything to decide, the item is unfinished.
- **Define every internal name inline, first use.** "The store (the one JSON
  file holding all settings)", "a pack (a folder of alert sound clips)",
  "provisioning (the startup step that downloads missing shipped content)".
  Never assume a codename survives in the owner's head.
- **Mechanism as cause and effect, not jargon.** "The updater force-kills the
  running app; a save caught mid-write leaves a half-written file; the next
  launch can't read it and starts factory-fresh" — not "torn write triggers
  quarantineStore fallback". File:line stays in the ticket; the sheet gets
  prose.
- **Every option names its user-visible consequence and its honest cost** —
  installer size, coarser data, risk direction, blast radius. Include the
  consequence of doing nothing.
- **Numbers are quoted, not referenced.** "~350 occurrences across 0.18–0.23",
  "92,361,271 bytes", "5 sightings". If the evidence is a measurement, the
  measurement is in the sheet.
- **One recommendation per item**, stated plainly, with the reasoning visible.
  When options compose, say which combination and in what order.
- **Global numbering, options lettered**, so the owner answers in shorthand
  ("1a+1e, 4 yes, 6d skip"). Close the sheet by inviting exactly that.
- **Asymmetric risks are said out loud.** When wrong-in-one-direction is worse
  than wrong-in-the-other (misattribution vs missing data; false alarm vs
  silence), name which direction each option fails toward.
- **Register matches stakes.** Data loss and trust erosion get sober prose;
  cosmetic items get a sentence. Thank-yous and user voice quotes keep their
  warmth.
- **Chips are a single line each** — what it does, why it exists, click or
  dismiss.

## After the owner answers

Route each answer through the standing loops: build rulings become GATE LIFTED
comments and dispatches per the linear-board skill; declines and
answer-in-place stamps go back to the feedback system per the feedback-triage
skill; every captured constraint is quoted verbatim in the ticket as law.
