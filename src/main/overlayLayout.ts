// Default overlay window placement (Task #59).
//
// Overlay windows persist their bounds the moment the user moves/resizes them, so this only
// ever decides where a kind appears the FIRST time it is opened (or after its stored bounds are
// cleared). The persisted position ALWAYS wins — see `overlayPlacement` in windows.ts, which
// prefers `cfg.bounds` and calls in here only when there are none.
//
// Layout: every kind docks to the BOTTOM-RIGHT of the primary display's work area, stacked
// upward in OVERLAY_KINDS order with a small gutter, so opening two or three overlays never
// lands one exactly on top of another. When the stack would run past the top of the work area it
// WRAPS INTO A NEW COLUMN to the left instead — with one uniform size that is exact, so no two
// kinds can ever overlap on their first open.
//
// SIZE IS UNIFORM across kinds (user decision): every overlay opens at the same width x height,
// whatever it renders. It is erring on the large side of the old per-kind values so the event
// log — the only kind that is a list rather than a handful of dense bars — is not cramped.
//
// …AND THE UNIFORM SIZE IS NOW A FUNCTION OF THE DISPLAY (JOS-119). Splitting the buff/timer
// overlay in two made a SEVENTH meter kind, which is exactly the case the old note in
// shared/types.ts warned about: seven 380x320 slots do not fit a 1366x728 laptop's work area
// under any column arrangement (three columns fit, two rows fit, that is six slots), so the wrap
// would have clamped a fourth column on top of the third and two windows would have opened
// exactly over each other. The answer is NOT to let them overlap and it is NOT a per-kind size:
// on a display that cannot hold the whole reserved grid, EVERY kind shrinks TOGETHER by the same
// factor until the grid fits. Uniformity survives, the no-overlap guarantee survives, and a
// display big enough for the full grid (anything 1080p or larger) is untouched at 380x320.

import { OVERLAY_KINDS, type OverlayKind } from '../shared/types'

export interface Size {
  width: number
  height: number
}
export interface Bounds extends Size {
  x: number
  y: number
}

/**
 * The ONE default size every overlay kind opens at. Chosen to be ≥ every per-kind size this
 * replaced (the largest was the event log's 360x300): wide enough for a meter's `name · stats ·
 * rate · total` bar row without ellipsis, tall enough for ~8 event-log lines plus chrome.
 */
const DEFAULT_SIZE: Size = { width: 380, height: 320 }

/**
 * THE FLOOR EVERY OVERLAY KIND SHARES — how small the user is allowed to drag one (JOS-278).
 *
 * 200x90 → 140x90, on a 0.23.0 report from a player who runs Lossless Scaling: a third-party
 * magnifier multiplies the overlay along with the game, so the app's own floor arrives on screen
 * at 1.5–2x the number written here and the debuff strip could not be made narrow enough to live
 * beside the spellbar. Owner ruling 2026-08-13: allow a lower minimum. A floor still EXISTS —
 * this is the promise that a window can never be dragged down to a few pixels and lost — and the
 * floor is ONE rectangle for every kind, because the widest chrome any kind wears is what the
 * number has to survive and a per-kind floor would only hide that.
 *
 * BOTH NUMBERS ARE MEASURED IN THE RUNNING APP, not chosen — tests/e2e/overlayMinSizeSteps.mts
 * re-measures them and fails if any control ever leaves the window at this size again.
 *
 *   WIDTH 200 → 140. The binding row is the HEADER: the live dot, the kind tag, the title, the
 *   drag gutter and the lock/close pair. At 140 all of it is inside the window; below 140 the
 *   CLOSE control starts leaving it, which is the one control you cannot get back from inside.
 *   140 needs the two give-way rules that ship with this change (overlay/OverlayHeader.tsx: the
 *   drag gutter and the kind tag shrink) and the footer WRAP beside them (overlay/overlayScale.tsx
 *   `FOOTER_ROW`).
 *
 *   HEIGHT 90 → 90, AND THAT IS THE FINDING. The old 90 was a guess that happened to be right:
 *   measured, the buffs window's footer needs 88px of window to keep A− / A+ off the bottom edge
 *   at 140 wide, so 90 is two pixels of margin over a real limit rather than a round number. What
 *   90 is NOT is "one row of content" — at 90 the scrolling pane is 8px, i.e. its own padding and
 *   nothing else. This floor is about REACHING a window, never about reading it; the height that
 *   makes a timer list useful is the user's to choose, well above here.
 *
 * WHAT THE OLD FLOOR WAS ACTUALLY DOING, since it is the reason the width could move at all: at
 * 200x90 the buffs, debuffs and XP windows already had their text-size stepper OFF THE SCREEN
 * (measured at x=237, 233 and 216 against a 200px window). The floor was not too small for the
 * chrome — the chrome had no way to give, so it ran off the edge. Wrapping is what makes a
 * narrower floor honest, and it is what fixes the old one on the way past.
 *
 * The content itself imposes nothing: bars, feed rows and timers ellipsize their names and the
 * pane scrolls, so at the floor they truncate rather than overlap.
 */
export const OVERLAY_MIN_SIZE: Size = { width: 140, height: 90 }

/**
 * THE TOAST IS NOT A METER, and its geometry says so (docs/plans/celebration-toasts.md §3).
 * It is a transparent strip at the TOP CENTRE of the screen that normally renders nothing: it
 * has no selector, no drill and no bars, so the uniform meter size and the bottom-right stack
 * are both wrong for it. Width 560 (the card's own width), and tall enough to hold the capped
 * queue of three cards — the window is transparent, so unused height costs nothing visually
 * and the empty window is fully click-through.
 *
 * 440 → 560 and 300 → 360 on 2026-08-05: "look and feel is good, but it needs to be a bit
 * bigger/more prominent" (owner). The card's type scaled with it (overlay/ToastCard.tsx), so the
 * lane and its contents still fit exactly. PERSISTED BOUNDS STILL WIN — a user who has already
 * dragged or resized the strip keeps their geometry, and only sees the larger type.
 */
const TOAST_SIZE: Size = { width: 560, height: 360 }
/** Gap from the top of the work area to the first card. */
const TOAST_TOP = 12

/**
 * THE ALERT BANNER IS NOT A METER EITHER (JOS-378), and it is not the toast: it is a WIDE strip
 * where your eyes already are. The celebration toast parks at the very top of the screen, which is
 * the right place for something you look at afterwards and the wrong place for a raid call you
 * have to read mid-pull.
 *
 * 720 wide because the line is one sentence at a large type size and wrapping a warning is how it
 * stops being glanceable; 260 tall holds the default four lines plus the drag frame. The window is
 * transparent and renders nothing when idle, so unused height costs nothing.
 */
const BANNER_SIZE: Size = { width: 720, height: 260 }

/**
 * THE CON CARD IS THE THIRD STRIP (JOS-383), and it wants the TOP of the screen for the reason the
 * banner does not: this is a card you read for a moment BEFORE you pull, not a warning you catch
 * mid-fight, so it belongs out of the way of the fight rather than in the middle of it. Top centre
 * is also where a player's own `/con` output already draws their eye.
 *
 * 520 wide because the widest thing on it is a drop line (`Gnarled Bone Ring  seen by you: 3x ·
 * 0.25 per kill`) and wrapping those turns a five-line card into ten.
 *
 * THE HEIGHT IS A FIRST-OPEN PLACEHOLDER, NOT A SIZE (JOS-386). This window's height FOLLOWS THE
 * CARD from the moment its renderer has measured one — see `fittedOverlayHeight` below, which is
 * the only thing that decides how tall this window ever is once a card exists. The number here is
 * what the window is for the instant between construction and that first measurement, so it is
 * deliberately no larger than a plausible card: the old 300 was picked as "tall enough for
 * anything", and since the card is a few lines of chips and drops, most of it was an empty apron —
 * invisible while the overlay is transparent, a dark box under the card in the JOS-40 opaque mode,
 * and in BOTH modes a rectangle that captures the mouse for as long as a card is up.
 *
 * IT SITS AT THE TOP, IN THE CELEBRATION STRIP'S BAND (owner ruling, 2026-08-16). It used to start
 * BELOW that band (`TOAST_TOP + TOAST_SIZE.height + 12`, ~384 px down) so that two kinds which both
 * ship ON could never open in the same pixels. That was a real concern and the owner has overruled
 * it for a better one: 384 px down is over the character, which is the one place a card you read
 * before a pull must not be. Both strips are TRANSIENT and both are closable, so a celebration
 * arriving in the same band as a con card is an overlap the owner accepts; nothing about this
 * kind's z-order or hit rules changes. The alert banner still keeps its own band a third of the way
 * down, and persisted bounds still win for everyone who has already moved either window.
 */
const CON_CARD_SIZE: Size = { width: 520, height: 220 }
/** Gap from the top of the work area — the celebration strip's own, because they share the band. */
const CON_CARD_TOP = TOAST_TOP

/**
 * How far down the work area the banner's top edge sits, as a fraction of its height: the UPPER
 * THIRD. Not the top (the toast is there, and so is every game's own chat/target chrome) and not
 * the middle (that is where the player is aiming). A third down is peripheral vision from the
 * centre of the screen, which is what "where the eyes are" actually means for a strip of text.
 */
const BANNER_TOP_FRACTION = 1 / 3

/**
 * The first-open size for a kind — the same for all the meters; the toast is its own strip.
 *
 * `workArea` is optional because one caller genuinely has no display to ask about (windows.ts's
 * headless/e2e path sizes a window before any screen info exists). Without it the answer is the
 * full uniform size, which is what every display large enough for the reserved grid gets anyway.
 *
 * FOR A FIT KIND, THE HEIGHT THIS RETURNS IS NOT A CHOICE ANYBODY MADE (JOS-386). Every other kind
 * gets a first-open size and then the USER owns both numbers — they are what `overlays.<kind>.bounds`
 * remembers. A fit kind's height is DERIVED FROM ITS CONTENT EVERY TIME (`fittedOverlayHeight`), so
 * this is only the placeholder the window wears until its renderer has measured a card, and it is
 * also what `windows.ts` writes into the store in place of whatever height the window happens to be
 * wearing when the user moves it. Position and WIDTH persist; height never does — otherwise one
 * tall card would become the size of every empty window from then on.
 */
export function overlayDefaultSize(kind: OverlayKind, workArea?: Bounds): Size {
  if (kind === 'toast') return { ...TOAST_SIZE }
  if (kind === 'alertBanner') return { ...BANNER_SIZE }
  if (kind === 'conCard') return { ...CON_CARD_SIZE }
  return workArea ? meterSize(workArea) : { ...DEFAULT_SIZE }
}

/**
 * THE KINDS WHOSE HEIGHT IS THE CONTENT'S, NEVER THE USER'S (JOS-386).
 *
 * The con card is the third answer to "may this window be resized", and the three are worth reading
 * together (the block beside `resizable:` in windows.ts holds the other two):
 *
 *   toast       — neither. A fixed-width card lane; everything around the card is transparent, so
 *                 resizing would only change how much invisible nothing surrounds it.
 *   alertBanner — both. Its lines are sentences that WRAP, so width decides whether a raid call
 *                 reads in one glance, and height decides how many lines survive.
 *   conCard     — MOVE and WIDTH. The card is a fixed set of rows (identity, the resist chips it
 *                 has something to say about, up to five drops, a respawn); width decides whether a
 *                 drop line wraps, and the height that follows from that is arithmetic, not taste.
 *                 A user-chosen height could only ever be too big (an apron of empty window that
 *                 still eats the mouse) or too small (a card cut off at the bottom).
 *
 * A list rather than a `kind === 'conCard'`, because the alert banner is the obvious next candidate
 * if the owner ever decides its wrapped height should follow its lines too — and because a caller
 * that must not fit a meter should be able to ASK rather than remember.
 */
export const FIT_HEIGHT_KINDS: OverlayKind[] = ['conCard']

/** Is this a kind whose window height follows what it renders? */
export function fitsHeightToContent(kind: OverlayKind): boolean {
  return FIT_HEIGHT_KINDS.includes(kind)
}

/**
 * HOW TALL THE WINDOW ACTUALLY GETS when its renderer asks for `requested` px of content (JOS-386).
 *
 * The renderer measures what it drew — the card, plus the overlay's own padding, plus the drag
 * frame while the window is unlocked — and this decides what that request becomes on the display
 * the window is currently on. Pure, so the whole policy is `npm test`-able and the Electron half is
 * three lines of `setBounds`.
 *
 * THE TOP EDGE NEVER MOVES, WHICH IS THE WHOLE POINT. A card that will not fit between its top edge
 * and the bottom of the work area SHRINKS THE REQUEST — it does not slide the window up. The card's
 * position is the user's (dragged, or the top-centre default); its height is ours, so ours is the
 * one that gives. A window whose top edge is somehow already off the bottom of the work area gets
 * the floor rather than a negative number.
 *
 * THE FLOOR IS `OVERLAY_MIN_SIZE.height`, the same one every kind shares, and it is doing real work
 * here rather than defending against the renderer: Electron clamps `setBounds` against the window's
 * own `minHeight` anyway, so a request below the floor that was NOT clamped here would leave main
 * believing the window is one height while it is another.
 */
export function fittedOverlayHeight(requested: number, top: number, workArea: Bounds): number {
  const floor = OVERLAY_MIN_SIZE.height
  if (!Number.isFinite(requested)) return floor
  const room = workArea.y + workArea.height - top
  const ceiling = Math.max(floor, Math.min(room, workArea.height))
  return Math.max(floor, Math.min(Math.round(requested), ceiling))
}

/**
 * The con card's first-open placement: horizontally CENTRED at the top of the work area, in the
 * celebration strip's own band (owner ruling, 2026-08-16 — the argument is at CON_CARD_SIZE).
 * Clamped like every other kind, so a display too short to hold it at the top simply gets it as low
 * as it fits rather than off the bottom edge.
 */
function conCardBounds(workArea: Bounds): Bounds {
  const size = { ...CON_CARD_SIZE }
  const x = workArea.x + Math.round((workArea.width - size.width) / 2)
  return {
    ...size,
    x: Math.max(workArea.x, Math.min(x, workArea.x + workArea.width - size.width)),
    y: Math.max(workArea.y, Math.min(workArea.y + CON_CARD_TOP, workArea.y + workArea.height - size.height))
  }
}

/**
 * The banner's first-open placement: horizontally CENTRED, its top edge a third of the way down
 * the work area. Clamped like every other kind so a display smaller than the strip still lands
 * on-screen — and a display too short for a third-down strip simply gets it as low as it fits.
 */
function bannerBounds(workArea: Bounds): Bounds {
  const size = { ...BANNER_SIZE }
  const x = workArea.x + Math.round((workArea.width - size.width) / 2)
  const y = workArea.y + Math.round(workArea.height * BANNER_TOP_FRACTION)
  return {
    ...size,
    x: Math.max(workArea.x, Math.min(x, workArea.x + workArea.width - size.width)),
    y: Math.max(workArea.y, Math.min(y, workArea.y + workArea.height - size.height))
  }
}

/**
 * The toast's first-open placement: horizontally CENTRED on the work area, 12px from its top.
 * Clamped like every other kind so a display narrower than the strip still lands on-screen.
 */
function toastBounds(workArea: Bounds): Bounds {
  const size = { ...TOAST_SIZE }
  const x = workArea.x + Math.round((workArea.width - size.width) / 2)
  return {
    ...size,
    x: Math.max(workArea.x, Math.min(x, workArea.x + workArea.width - size.width)),
    y: Math.max(workArea.y, Math.min(workArea.y + TOAST_TOP, workArea.y + workArea.height - size.height))
  }
}

/** Gap from the screen edge and between stacked overlays. */
const MARGIN = 16
const GUTTER = 10

/**
 * The kinds that dock into the bottom-right stack — every kind except the three STRIPS (the
 * celebration toast at the top, the con card below it, the alert banner a third of the way down).
 * None holds a slot in the meter grid, so none may consume an index either: adding one that did
 * would shift every meter's reserved slot out from under a user who has never opened it.
 */
export const METER_KINDS: OverlayKind[] = OVERLAY_KINDS.filter(
  (k) => k !== 'toast' && k !== 'alertBanner' && k !== 'conCard'
)

/**
 * How many uniform slots of this height stack between the bottom and top margins of a work area.
 * Always at least one — a display shorter than a single overlay still has to place it somewhere,
 * and the final clamp in `defaultOverlayBounds` keeps it on-screen.
 */
function rowsThatFit(height: number, workArea: Bounds): number {
  return Math.max(1, Math.floor((workArea.height - 2 * MARGIN + GUTTER) / (height + GUTTER)))
}

/**
 * How many columns of this width fit walking LEFT from the right margin. Column `c` starts at
 * `workArea.width - width - MARGIN - c * (width + GUTTER)` measured from the work area's left
 * edge, so it fits while that expression is >= 0. Always at least one, for the same reason as above.
 */
function colsThatFit(width: number, workArea: Bounds): number {
  return Math.max(1, Math.floor((workArea.width - MARGIN - width) / (width + GUTTER)) + 1)
}

/**
 * THE SHRINK LADDER. Rungs are tried largest-first and the first one whose grid holds every meter
 * kind wins, so a display that can seat the full stack never leaves the top rung.
 *
 * It is a fixed ladder rather than a solved equation because the fit is a step function of both
 * dimensions (floor() twice) and a two-variable search would answer with sizes nobody chose. Five
 * rungs down to 70 % is enough for every display this app can be opened on: at 0.7 the slot is
 * 266x224 and a 1366x728 work area seats 4 columns x 3 rows = 12 of them. The bottom rung is
 * returned even if it still does not fit — an overlay that is slightly too big is a better answer
 * than a postage stamp, and `defaultOverlayBounds` clamps every window on-screen regardless.
 */
const SHRINK_LADDER = [1, 0.85, 0.8, 0.75, 0.7] as const

/** The uniform meter size for one display: the largest ladder rung whose grid seats every kind. */
function meterSize(workArea: Bounds): Size {
  const needed = METER_KINDS.length
  for (const scale of SHRINK_LADDER) {
    const size = {
      width: Math.round(DEFAULT_SIZE.width * scale),
      height: Math.round(DEFAULT_SIZE.height * scale)
    }
    if (colsThatFit(size.width, workArea) * rowsThatFit(size.height, workArea) >= needed) return size
  }
  const last = SHRINK_LADDER[SHRINK_LADDER.length - 1]
  return { width: Math.round(DEFAULT_SIZE.width * last), height: Math.round(DEFAULT_SIZE.height * last) }
}

/**
 * Where a kind's window goes when it has no persisted bounds: docked bottom-right, offset upward
 * past every kind stacked below it (whether or not those are currently open — the slot is
 * RESERVED so positions stay stable and predictable), wrapping into a fresh column to the left
 * once a column is full. Clamped to the work area as a last resort on a display too small to
 * hold even one full column.
 */
export function defaultOverlayBounds(kind: OverlayKind, workArea: Bounds): Bounds {
  if (kind === 'toast') return toastBounds(workArea)
  if (kind === 'alertBanner') return bannerBounds(workArea)
  if (kind === 'conCard') return conCardBounds(workArea)
  const size = overlayDefaultSize(kind, workArea)
  // No strip holds a slot in the meter stack, so none consumes an index (METER_KINDS).
  const idx = Math.max(0, METER_KINDS.indexOf(kind))
  // How many uniform slots fit between the bottom and top margins of this work area.
  const perColumn = rowsThatFit(size.height, workArea)
  const col = Math.floor(idx / perColumn)
  const row = idx % perColumn
  const x = workArea.x + workArea.width - size.width - MARGIN - col * (size.width + GUTTER)
  const y = workArea.y + workArea.height - size.height - MARGIN - row * (size.height + GUTTER)
  return {
    ...size,
    x: Math.max(workArea.x, Math.min(x, workArea.x + workArea.width - size.width)),
    y: Math.max(workArea.y, Math.min(y, workArea.y + workArea.height - size.height))
  }
}

/**
 * Per-kind OS WINDOW TITLE — never user-visible on a frameless overlay, but it is what shows up in
 * a window list, a crash report, and the Task Manager row somebody screenshots into a bug report.
 *
 * It lives HERE, beside the size and the reserved slot, because it is the same kind of fact: a
 * per-kind presentation constant with no Electron in it. It used to sit in windows.ts, whose
 * subject is the runtime — BrowserWindow construction, the trust boundary, the hide policy — and
 * which reached the 400-code-line ceiling the moment JOS-194 added a tenth row to this table. The
 * repo's answer to that ceiling is a split, and a pure lookup table is the part of that file which
 * was never about Electron in the first place.
 *
 * Partial + fallback, so a new kind can never break the build here: an untitled window gets
 * Electron's default rather than a compile error in the middle of the window factory.
 */
export const OVERLAY_TITLE: Partial<Record<OverlayKind, string>> = {
  fight: 'Fight Overlay',
  overall: 'Zone Overlay',
  events: 'Event Log Overlay',
  'heal-fight': 'Fight Healing Overlay',
  'heal-overall': 'Zone Healing Overlay',
  toast: 'Celebration Overlay',
  buffs: 'Buff Timer Overlay',
  debuffs: 'Debuff Timer Overlay',
  xp: 'XP Overlay',
  respawn: 'Respawn Timer Overlay',
  alertBanner: 'Alert Banner Overlay',
  conCard: 'Mob Card Overlay'
}
