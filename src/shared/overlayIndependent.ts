// overlayIndependent.ts — ONE SWITCH OVER TWO STORED FLAGS (JOS-408).
//
// WHY THIS FILE EXISTS. JOS-405 gave the overlays' TEXT SIZE a shared/independent switch and
// JOS-407 gave their TRANSPARENCY its own, on the reasoning that a player might want one size
// everywhere and a fainter respawn window. The owner reviewed the finished page on 2026-08-17 and
// ruled the other way: the two controls are about the same twelve windows and belong to ONE card
// under ONE switch, because a pane with two switches that look identical and govern different
// halves of the same row is a pane you have to experiment with to understand.
//
// THE PLUMBING STAYS. Both prefs objects, both stores, both migrations, both broadcast paths and
// both bridges are unchanged — they are how the values actually travel, and collapsing them would
// have re-migrated every install for a control-layout decision. What changes is that the UI reads
// ONE derived boolean and writes BOTH flags together, and that main makes the two flags agree the
// first time it looks at them.
//
// ZERO-IMPORT, like shared/uiScale.ts and shared/perf.ts: it takes the two stores as an INJECTED
// io rather than importing them, so `tests/overlayIndependent.test.mts` can watch the whole
// sequence — including the seed a `false -> true` write triggers — without Electron or a store.

/** What the two stores say about being independent, read together. */
export interface IndependentFlags {
  /** `overlayTextSize.independent` — the per-kind text sizes are in force. */
  text: boolean
  /** `overlayBgAlpha.independent` — the per-kind transparencies are in force. */
  bg: boolean
}

/**
 * THE TWO STORES, AS THE ONLY THREE OPERATIONS ANY OF THIS NEEDS.
 *
 * The setters are the FEATURES' OWN setters (`setOverlayTextSize` / `setOverlayBgAlpha`), never a
 * raw write, and that is the load-bearing part of this interface: each of them runs its
 * seed-on-first-opt-in, which is what makes turning the switch on change nothing on screen.
 */
export interface IndependentIo {
  read: () => IndependentFlags
  setText: (independent: boolean) => void
  setBg: (independent: boolean) => void
}

/**
 * THE ONE BOOLEAN THE PAGE DRAWS. Either flag being on means the twelve rows are what is in force
 * for something, so the switch is on and the rows are what the page shows.
 *
 * It is an OR rather than an AND because the reconcile below guarantees they agree in practice —
 * so the only case where they differ is the instant before the reconcile has run, and the honest
 * answer there is the one that shows the user the per-kind values that ARE being obeyed.
 */
export function overlayIndependent(flags: IndependentFlags): boolean {
  return flags.text || flags.bg
}

/**
 * MAKE THE TWO FLAGS AGREE, ONCE, DOING THE LEAST HARM (the ticket's own rule).
 *
 * WHY ANY INSTALL IS IN THIS STATE. JOS-407's migration read the twelve stored `bgAlpha` values and
 * came up INDEPENDENT wherever they differed — which is most real stores, because nothing ever
 * fanned that field out. The text size's switch, meanwhile, stayed OFF, because its own migration
 * found twelve equal values (the retired fan-out wrote them). So a great many installs hold
 * `{ text: false, bg: true }`, and under one switch that is a state the page cannot draw.
 *
 * IT RESOLVES UPWARD, TO INDEPENDENT, AND NOTHING ON SCREEN MOVES. Turning transparency off would
 * repaint every window that the least-harm migration had just decided to leave alone. Turning text
 * size ON instead costs nothing visible: `setOverlayTextSize` seeds every kind from the in-force
 * shared size on that first opt-in, so all twelve windows keep drawing exactly what they were
 * drawing. That asymmetry is the whole argument for the direction.
 *
 * Returns whether it wrote, so a caller can log it once rather than wonder.
 */
export function reconcileOverlayIndependent(io: IndependentIo): boolean {
  const flags = io.read()
  if (flags.text === flags.bg) return false
  if (!flags.text) io.setText(true)
  if (!flags.bg) io.setBg(true)
  return true
}

/**
 * WHAT THE ONE SWITCH DOES: move both flags to `on`.
 *
 * Only the flag that disagrees is written, so the flip that turns an already-independent half on
 * again is not a write — which matters because a write is also a broadcast, and a broadcast that
 * says nothing is how a Preferences pane learns to flicker.
 */
export function setOverlayIndependent(io: IndependentIo, on: boolean): void {
  const flags = io.read()
  if (flags.text !== on) io.setText(on)
  if (flags.bg !== on) io.setBg(on)
}
