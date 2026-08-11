# Celebration toasts — transient top-center overlay alerts

Status: DESIGN. Author: planning session (Fable), 2026-08-04. Owner-requested.
Constrained by AGENTS.md: overlay laws (MUI-free bundle, persisted bounds win,
click-through when locked), celebrations law (live transitions only — the law
is replay-vs-live, not first-vs-every), Electron trust boundary (one
WEB_PREFERENCES, hardenWebContents covers every window), UI conventions
(state never process). Wave L; dispatches after wave J frees the overlay
files.

## 0. What we are building, in one paragraph

A sixth overlay kind, **`toast`**: a transparent, always-on-top strip at the
**top-center of the screen** that normally renders nothing. When something
worth celebrating happens — a **boss kill**, a **Plane of Sky quest
completion** — a compact card animates in (subtle slide-down + fade, ~250 ms),
plays a **subtle sound**, holds for ~6 s, and fades away. **Mouse-over pins
it** (stays until mouse-out, then resumes its exit). The Sky-completion toast
embeds the reward **item card**; clicking it focuses the main window and jumps
to that quest on the PoS page. Position is top-center by default and
configurable the way every overlay already is: drag it in interactive mode,
persisted bounds win forever after.

## 1. Decisions

| # | Decision | Why |
|---|---|---|
| T1 | Toast is a NEW OVERLAY KIND in the existing system (`overlays.toast` config, same overlay.html bundle, `?kind=toast`) — not a new window species | The overlay infra already solves transparency, always-on-top, per-kind persisted config, spawn/close IPC, the security wrapper; a sixth kind is additive |
| T2 | The window is PERSISTENT while enabled, click-through when idle; when a card is visible it flips `setIgnoreMouseEvents(false)` so hover/click work, and back when the card exits | On-demand window creation would pay ~200 ms of Electron spawn on every toast — the exact moment we want the animation crisp |
| T3 | Content arrives over ONE IPC push `toast:show` with a self-contained payload (text, kind, optional embedded item block, optional deep-link target); the overlay renders, times, and dismisses locally | The overlay must stay dumb and MUI-free; timing/hover-pin is pure renderer state |
| T4 | Producers are the EXISTING app-signal detectors (bossDefeat, questComplete) in the main window renderer — they already own the live-only/replay-silence discipline; they call a new `window.eq.showToast(payload)` and main fans out to the toast window | No second detector, no drift between what celebrates and what toasts (celebrations law kept in ONE place) |
| T5 | The Sky item card is a MUI-FREE compact item window (icon via `eqimg://`, name in EQ item color, key stat lines) rendered from data RESOLVED IN MAIN (lookupItem) and embedded in the payload | The overlay bundle is MUI-free by law and must not fetch: payload carries everything, offline-safe |
| T6 | Click-through to the quest: the card's click sends the existing cross-window `AppFocus` nav (closed union gains a posky/quest member) — focus main window, open PoS anchored at the quest | The AppFocus pattern is exactly this; deep links stay nonce-keyed like openMob/openLoot |
| T7 | Sound: per-toast-kind sound from the installed packs, default a subtle line from the shipped default pack; volume + mute in the toast config; played by the MAIN WINDOW's existing alert audio path, not the overlay | The overlay bundle has no audio stack; the alert player already handles packs, volume, coalescing — a toast sound is one more caller |
| T8 | Auto-dismiss default 6 s; hover pauses the clock (pin), mouse-out resumes with ~1.5 s grace; a queue of ≥2 stacks vertically (newest under oldest), each with its own clock, capped at 3 with oldest evicted | The owner's stated interaction, plus the obvious burst case (boss + quest complete on the same kill) |
| T9 | Boss-kill toast fires EVERY kill (owner decision, same as the audio-alert change in wave K); hydration/replay never toast | Celebrations law reread: once-per-live-transition ≠ once-ever |

## 2. Payload

```ts
// shared (new file src/shared/toast.ts)
export type ToastKind = 'bossKill' | 'skyQuestComplete'
export interface ToastItemCard {
  name: string
  iconId?: number
  colorFlag?: string        // magic/lore rendering hint for the name color
  lines: string[]           // pre-formatted key stat lines, MAIN resolves them
}
export interface ToastPayload {
  id: string                // dedupe/eviction key
  kind: ToastKind
  title: string             // "Lord Nagafen defeated" / "Quest complete: <quest>"
  subtitle?: string         // tier chip text, zone, etc.
  item?: ToastItemCard      // sky completion embeds the reward
  focus?: AppFocus          // click target (posky quest anchor)
  durationMs?: number       // default 6000
}
```

## 3. Config & shell

`overlays.toast`: `{ enabled, bounds?, sound: {packId, soundId} | null,
volume, durationMs }`. Default geometry: width 440, height fit-content,
x = centered on the primary display, y = 12 — computed in overlayLayout.ts
beside the existing default-stack logic; persisted bounds always win.
Interactive mode shows a faint outline + drag handle (matching the meter
overlays' idiom) so "configurable position later" is just the existing
mechanism. Settings live with the other overlay toggles in Preferences.

## 4. Look & feel

Transparent window, card = dark glass (rgba theme-derived, 1px hairline,
8px radius, backdrop blur if cheap), EQ-gold title line, subtitle muted.
Enter: translateY(-8px→0) + opacity 0→1, 250 ms ease-out. Exit: reverse,
300 ms. Subtle. No confetti in the overlay (the main window keeps its own
celebration behavior). The Sky variant renders the item card beneath the
title; hover anywhere pins; the item card is the click target for T6 and
gets a pointer cursor + hairline highlight on hover — the only affordance.

## 5. Scope fences

- No generic user-authored toast rules in v1 (the alert engine is not
  involved); exactly the two producers, extensible by payload kind.
- No stacking config, no per-kind positions, no animation options.
- Overlay stays MUI-free; no network, no lookup from the overlay.

## 6. Waves

- **Wave L (after J lands — overlay files)**: shared/toast.ts + config +
  windows/overlayLayout wiring + overlay renderer (card, queue, hover-pin,
  animations) + IPC + preload + detector calls + main-window audio hookup +
  posky AppFocus anchor + tests (payload validation, layout default, queue
  timing pure-function tests) + e2e smoke (toast window spawns hidden in
  EQ_E2E, receives a payload, renders the card).

## 7. As shipped — owner amendments, 2026-08-05

Four corrections after living with wave L for a night. They supersede the
decisions above where they disagree; the rows are left intact because the
reasoning that produced them is still worth reading.

- **T7 IS RETIRED. A toast has no sound of its own.** "Remove the sound
  controls from preferences, they are already covered by Alerts module."
  The picker, `overlays.toast.sound`/`.volume` and the `toast:sound`
  channel are gone. The seeded "Raid target defeated" / "Quest complete"
  ALERTS speak on these exact events, from the same callbacks — T7 could
  only ever add a second voice over one kill. (Stray persisted keys are
  left where they lie: nothing reads them, and the blob drops them on its
  next write.)
- **T9 GAINS ITS MISSING WORD: every kill CREDITED TO YOU.** "It looks
  like its celebrating even when im not the killer of the boss — im in
  open world and somebody killed. if im not in a group with them, it
  should not count." The kills module now joins each slain line to the
  experience line that precedes it (`KillTierRun.credited`), and
  `bossStatus.bossKills` compares that instead of the raw count. Group
  kills still celebrate — party experience is experience. Tracking is
  untouched: the roster still records every boss that dies.
- **ON BY DEFAULT.** "It should be on by default." `overlays.toast.open`
  defaults true — the one overlay kind that does, because it is invisible
  and click-through except for the seconds a card is up. Schema v9
  corrects stores written at the old default (storeMigrations.ts).
- **BIGGER.** "Look and feel is good, but it needs to be a bit
  bigger/more prominent." Lane 440 → 560 px, title 14 → 18, subtitle
  11 → 13, item name 12 → 14, item lines 10.5 → 12, icon 40 → 52, padding
  10/12 → 14/18. §4's ANIMATION is untouched — it was already right.
  Persisted bounds still win, so a user who moved the strip keeps it.

## 8. The window says what it is — JOS-83, 2026-08-07

A brand-new user reported the strip as a black rectangle they took for a
malfunction, and uninstalled. §4 gave the CARD an affordance (the reward
block) and gave the WINDOW none, on the reasoning that a window rendering
nothing needs no chrome. That reasoning holds right up until the window
renders nothing *and is visible anyway* — which is what a driver that
cannot composite a transparent window produces (the JOS-40 report;
`shared/graphicsPrefs.ts` is the escape hatch, and it only helps someone
who already knows which program to blame).

- **Every card carries the overlay's name and a ×** (`ToastCard`'s chrome
  row). The × dismisses that card through the queue reducer's `dismiss`
  action, which had existed since wave L with nothing wired to it.
- **The overlay introduces itself ONCE per install** — one card, on the
  first launch that ever opens it, naming EQ Legends Companion, saying the
  window is not EverQuest's, and offering a button that closes the overlay
  and persists `open:false`. Remembered as `overlays.toast.toast.introduced`;
  an absent key reads false, so installs written before this get it too.
  Its hold is `TOAST_MAX_DURATION_MS` — the longest a card may ever hold,
  and bounded, because a card on screen is a card capturing the mouse.
- **The resting state is unchanged**: no card ⇒ nothing painted, fully
  click-through. That is still what makes this the one kind that defaults
  on, and it is why the introduction is a card rather than a permanent
  label or an outline.
- `intro` joins `ToastKind` but NOT `TOAST_KINDS`: the overlay builds the
  card for itself out of its own config, so the wire must keep refusing it.

## 9. The toast names the kill, not the career — JOS-165, 2026-08-09

The boss card and the boss toast were built from the same number, and only
one of them was entitled to it. `TargetStatus.bestTier` is a fold over every
kill a target ever took — its highest instance tier EVER — which is what a
card should badge and the opposite of what an event should announce. The
owner clears d0 through d4 every week, so his most recent kill of a target is
routinely BELOW his best; a Sunday d1 Maestro of Rancor kept announcing
itself as the d4 he beat nine days earlier. (The d3 he reported seeing was
the same bug on the boss beside it: three of that session's twelve toasts
read "D3 · Fused" for targets whose career best genuinely is d3.)

- **The tier is a fact about the EVENT, so it rides the event.**
  `bossStatus.bossKills` now returns a `BossKill` — `{ status, tier }` —
  where `tier` is the run whose CREDITED count just grew (ties resolve to
  the latest `lastCreditedTs`, then the higher tier). Nothing was added to
  `TargetStatus`: a field that means nothing on the statuses no kill just
  fired for is a field someone will read on a card.
- **The zone is the one you were standing in.** The subtitle took
  `target.zone` — the roster's static "Plane of Hate" — and now takes the
  character module's live zone, raw as the game spells it, so
  "- Solo 1 (Awakened)" is distinguishable from "- Group 2 (Awakened)". A
  zone no line has ever named falls back to the roster's; nothing is
  invented.
- **CURRENT IS PRIMARY** (owner semantics): a toast may show highest AND
  current, current first — never highest alone. It shows current only.
- **The card is untouched.** `BossView`/`BossSections` still badge
  `bestTier`, and the per-loadout cards still project one tier run each.
- Pinned by `tests/bossToastTier.test.mts` against
  `tests/fixtures/bosstier-maestro-ladder.log` — one mob, d3 then d4 then,
  nine days later, d1.
