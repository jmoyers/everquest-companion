import { type JSX, useRef, useState } from 'react'
import {
  HOVER,
  OverlaySelectPopup,
  type ElementRef,
  type OverlaySelectRow
} from './OverlaySelect'
import { IconButton, ICON_ACCENT_GOLD } from './IconButton'
import type { CaptureReason, OverlayChrome } from './useOverlayChrome'

/**
 * OverlayHeader — the ONE header row every overlay kind renders, and (in interactive mode) the
 * selector's trigger.
 *
 * WHY IT EXISTS: the five kinds hand-rolled three near-identical header bars, and each METER kind
 * then stacked a SECOND row underneath holding the segment selector. On a 380×320 window that row
 * cost 26–32px of bars to repeat what the header was already saying — the same name, the same live
 * dot, the same rate. So the header row IS the trigger now: click it and the existing popup
 * (OverlaySelect) opens directly under the header, unchanged rows and all. Picking a row updates
 * this header in place, because the header has always rendered the SELECTED segment.
 *
 * WORDING IS UNTOUCHED. The title is still the segment's own name and the tag still carries
 * `· LAST` for a head row that is a finished fight — the honest live/last vocabulary (world-model
 * law 6 / the Fight-vs-Overall scope rule) is not restated, re-cased or re-ordered here. All this
 * row gained is a chevron.
 *
 * MODES:
 *   interactive — title + tail are a no-drag click target with a chevron; the popup anchors to
 *                 this row's bottom edge and spans the window width.
 *   locked      — the SAME row, and (owner ruling P3, docs/plans/combat-overlay-parity.md) the
 *                 SAME working selector. A locked meter is click-through everywhere else; this
 *                 row is the exception, because "which fight am I watching" is the one question
 *                 a pinned meter still has to be able to answer. The mechanism is the hover
 *                 sensor the meters already run (`useOverlayChrome.capture`): the pointer
 *                 entering this row asks main to stop ignoring mouse events, leaving it (with
 *                 the list closed) asks it to resume. Nothing new hooks the mouse.
 *                 A caller that supplies no `capture` keeps the old plain-header behaviour —
 *                 without the sensor there is no way for the click to land, and a chevron that
 *                 did nothing would be worse than no chevron.
 *
 * DRAG: this row is the window's ONLY drag handle, and a `-webkit-app-region: drag` element
 * swallows clicks entirely — so the trigger carries `no-drag` and the LEFT cluster (live dot +
 * kind tag), the GUTTER before the controls, and the padding around them stay the drag surface.
 *
 * WHAT JOS-121 TOOK OUT, AND WHERE THE ROOM WENT. This row used to carry a third fixed item: the
 * read-only scope word ('Group', or the long 'Group (no roster yet)') that JOS-115 kept when it
 * retired the inline scope control. It is gone from here — it says the same sentence from the
 * panel floor now (overlay/scopeFloor.tsx) — and the width it was holding was split two ways:
 *
 *   - the SELECTOR takes most of it, because it is the item that was actually starved. Its title
 *     is a mob name under `textOverflow: ellipsis`, so every pixel is a character.
 *   - a DRAG GUTTER (`GUTTER_W`) takes a fixed slice at the right end, where before there was
 *     only the 6px flex gap between a full-width no-drag trigger and the controls. That sliver
 *     was the whole reachable drag target on the right half of the bar.
 *
 * Those two are zero-sum against each other — one row, one width — so THE ROW GOT TALLER: 4px of
 * vertical padding per edge became 7. That is the only lever that is not a swap. Full-row-width
 * drag surface, and the trigger's height is content-driven so none of it goes back to the no-drag
 * half.
 *
 * IT IS ALSO THE HONEST READING OF THE ASK ("more title-bar room for the fight selector and for
 * dragging"): a title bar you drag a window by should be tall enough to aim at. MEASURED
 * (tests/e2e/overlayScopeSteps.mts, which rebuilds the JOS-115 row in place to have a before):
 * at the LONG scope word — `Group (no roster yet)`, 87px of it — the selector's trigger went
 * 155.3→242.1px and the fight name inside it 89.1→175.9px, which cost 1,649px² of drag area; the
 * three extra padding pixels put 2,268px² back, so the drag surface still finished up at
 * 7,171→7,790px² on a 378px-wide window. The short word (`Group`) is the easy case: it frees less
 * width, so it takes less drag area with it. The price is 6px of the bars pane, stated not hidden.
 *
 * WHAT JOS-158 TOOK OUT, AND WHERE THAT ROOM WENT TOO. The row's third fixed item is now gone as
 * well: the METERS' numeric tail, the aggregate `21.7k dps` / `1.2k hps` that sat hard right of the
 * fight name. The owner's ruling (2026-08-09, with a screenshot) is that the aggregate belongs in
 * the panel content, on the header row above the bars, where it can be LABELED for what it covers
 * instead of floating unlabelled beside a mob name (overlay/meterCrumb.tsx). So `tail` is OPTIONAL
 * here now, and a header given none draws no tail span at all - the title's `flexGrow` swallows
 * every pixel it was holding, which is the whole point: a long mob name truncates later.
 *
 * The tail did NOT go away for every kind. The buffs/debuffs and event-log headers still pass one,
 * and theirs is a COUNT of what the list below holds rather than an aggregate of it - there is no
 * second place in those windows for it to live, and nothing about them is crowding a mob name.
 *
 * MUI-FREE ON PURPOSE: plain React + inline styles, like every file in this bundle.
 */

/** The selector this header triggers. Omitted by kinds that have nothing to select (events). */
export interface OverlayHeaderSelect {
  rows: OverlaySelectRow[]
  value: string
  onChange: (v: string) => void
  /** the owning overlay's accent color (damage gold / heal green). */
  accent: string
}

/**
 * ONE EXTRA TITLE-BAR CONTROL a kind may ask for (JOS-322). Today's only user is the ZONE meter's
 * "New session" (owner ruling 2026-08-21: *small, in the title bar*, alongside the Loot bar's own
 * affordance), and the shape is deliberately the narrowest thing that serves it — one glyph, one
 * accessible name, one handler.
 *
 * IT IS NOT A SLOT. A `ReactNode` here would let a kind hang arbitrary chrome in the one row whose
 * whole business is the pixels a mob name gets to use (JOS-158/JOS-278), and the shrink order in
 * this row has already had to be argued twice. A glyph in the existing 20px `IconButton` costs the
 * title exactly what the close ✕ costs it, and nothing new can appear here without editing this
 * type.
 */
export interface OverlayHeaderAction {
  /** The accessible NAME — never a tooltip (owner ruling 2026-08-16: no hover text on an overlay). */
  label: string
  /** One character. It sits in a 20px box at 11px, beside 📌 and ✕. */
  glyph: string
  onClick: () => void
}

const TAIL_COLOR = 'rgba(255,255,255,0.7)'

/**
 * The P3 sensor, as this file needs it. Optional at the prop boundary (the event log has no
 * selector and never opted in), defaulted to a no-op inside so nothing below has to branch.
 */
type HeaderCapture = (reason: CaptureReason, active: boolean) => void
const NO_CAPTURE: HeaderCapture = () => undefined

/** The IconButton's box (IconButton.tsx: 20 x 20), so the slot below can hold its shape. */
const CONTROL_PX = 20

/**
 * Lock/close, shown when interactive or while a locked overlay has captured the mouse.
 *
 * THE SLOT KEEPS ITS SIZE WHEN THE CONTROLS ARE HIDDEN (owner, hands-on, 2026-08-16: "the locked
 * title bar should not adjust the size when the lock appears"). Returning `null` here made the
 * unlock pin the tallest thing in the header row, so a locked overlay's title bar grew by the
 * button's overhang the moment the pointer arrived and shrank when it left - a jump on the exact
 * gesture that is supposed to feel like nothing. The hidden state is therefore an empty box of the
 * one control a locked header ever reveals (the unlock pin; the close ✕ is unlocked-only), with the
 * same margin, so the row's height and the title's width are the same hovered or not.
 *
 * A PLACEHOLDER, NOT A HIDDEN BUTTON. `visibility:hidden` would keep the shape too, but the e2e
 * (overlay-sync) proves the reveal by counting `<button>`s from zero, and a control that cannot be
 * pressed has no business being a button in the DOM: the placeholder is `aria-hidden` and inert.
 */
function HeaderControls({
  chrome,
  iconAccentBg,
  action
}: {
  chrome: Pick<OverlayChrome, 'locked' | 'hovering' | 'noDrag' | 'toggleLock'>
  iconAccentBg: string
  /** The kind's one extra control, drawn UNLOCKED ONLY — see `OverlayHeader`'s `action` prop. */
  action?: OverlayHeaderAction
}): JSX.Element | null {
  const { locked, hovering, noDrag, toggleLock } = chrome
  if (locked && !hovering) {
    return <div aria-hidden style={{ width: CONTROL_PX, height: CONTROL_PX, marginLeft: 2, flexShrink: 0 }} />
  }
  return (
    <div style={{ ...noDrag, display: 'flex', alignItems: 'center', gap: 2, marginLeft: 2 }}>
      {/* UNLOCKED ONLY, exactly like the close ✕ two lines down, and for both of its reasons. A
          locked meter reveals only the unlock pin, and the placeholder above is sized for exactly
          that one control — so an action that appeared on hover while pinned would put back the
          title-bar height jump the owner had removed. It is also an irreversible-ish action on a
          click-through window: a split you did not mean to make is one you have to press again to
          live with (the undo is API-only, by ruling). */}
      <IconButton
        label={locked ? 'Unlock (interactive)' : 'Lock (click-through)'}
        onClick={toggleLock}
        accent={locked}
        accentBg={iconAccentBg}
      >
        {locked ? '🔓' : '📌'}
      </IconButton>
      {!locked && action && (
        <IconButton label={action.label} onClick={action.onClick} accentBg={iconAccentBg}>
          {action.glyph}
        </IconButton>
      )}
      {!locked && (
        <IconButton
          label="Close overlay"
          onClick={() => window.eqOverlay.close()}
          danger
          accentBg={iconAccentBg}
        >
          ✕
        </IconButton>
      )}
    </div>
  )
}

/** Name + (interactive) chevron + the numeric tail, when the kind still has one. Identical
 *  content in both modes. */
function HeaderBody({
  title,
  titleColor,
  tail,
  tailTitle,
  tailColor,
  open
}: {
  title: string
  titleColor: string
  /** absent on the METERS since JOS-158 — their aggregate is on the panel's own header row. */
  tail?: string
  tailTitle?: string
  tailColor: string
  /** null when this header has nothing to open — then no chevron is drawn at all. */
  open: boolean | null
}): JSX.Element {
  return (
    <>
      <span
        style={{
          fontWeight: 700,
          color: titleColor,
          whiteSpace: 'nowrap',
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          flexGrow: 1
        }}
      >
        {title}
      </span>
      {open !== null && (
        <span style={{ color: 'rgba(255,255,255,0.45)', fontSize: 9, flexShrink: 0 }}>
          {open ? '▲' : '▼'}
        </span>
      )}
      {/* A kind that passes no tail draws NO span here — not an empty one. An empty flex child
          still costs the row its `gap`, and this row's whole business is the pixels a mob name
          gets to use (JOS-158). */}
      {tail !== undefined && tail !== '' && (
        <span
          aria-label={tailTitle}
          style={{ color: tailColor, fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap' }}
        >
          {tail}
        </span>
      )}
    </>
  )
}

/** The live/idle dot (kinds without a combat state — the event log — pass no `live` at all). */
function LiveDot({ live }: { live: boolean }): JSX.Element {
  return (
    <span
      aria-label={live ? 'In combat' : 'Idle'}
      style={{
        width: 8,
        height: 8,
        borderRadius: '50%',
        flexShrink: 0,
        background: live ? '#5fbf72' : 'rgba(255,255,255,0.25)',
        boxShadow: live ? '0 0 5px #5fbf72' : 'none'
      }}
    />
  )
}

/** The small uppercase kind tag, with the finished-fight marker the locked overlay depends on. */
function HeaderTag({ tag, last }: { tag: string; last: boolean }): JSX.Element {
  return (
    <span
      style={{
        fontSize: 8,
        letterSpacing: 0.5,
        textTransform: 'uppercase',
        color: 'rgba(255,255,255,0.4)',
        // IT GIVES WAY LAST, BUT IT DOES GIVE WAY (JOS-278). This used to be `flexShrink: 0`,
        // and on the longest tag there is (`FIGHT · LAST`) that fixed 55px was what pushed the
        // CLOSE control off the right edge of a narrow window — a dead pixel budget spent on a
        // label, at the cost of the one control that is not recoverable from inside the window.
        // Shrink order is the priority order: the title yields first (its own `minWidth: 0`),
        // then this. It only bites below ~150px, and never in LOCKED mode — a pinned overlay
        // draws no controls at all, so the tag has the row to itself and its `· LAST` marker,
        // which is the state that marker exists for, is never the thing that truncates.
        minWidth: 0,
        overflow: 'hidden',
        textOverflow: 'ellipsis',
        whiteSpace: 'nowrap'
      }}
    >
      {tag}
      {/* The head row is a FINISHED fight (no pull is open). Say so in the tag, because a LOCKED
          overlay has no selector at all — the tag would otherwise read as if this fight were
          still going. */}
      {last && <span style={{ opacity: 0.75 }}> · LAST</span>}
    </span>
  )
}

/**
 * THE DRAG GUTTER (JOS-121) — a reachable strip of drag surface at the right end of the row.
 *
 * The trigger is `no-drag` and spans everything the fixed items leave, so before this the only
 * drag surface on the right half of a meter's title bar was the 6px flex gap in front of the
 * controls (and, on a LOCKED meter, whose controls are not rendered until it captures the mouse,
 * the row's 8px of padding). A window whose one drag handle is 6px wide is a window you miss.
 *
 * It carries no `no-drag`, so it inherits the row's `-webkit-app-region: drag` — the same way the
 * live dot, the kind tag and the padding always have. `alignSelf: stretch` makes it the full
 * height of the row's content box rather than a zero-height flex item.
 */
const GUTTER_W = 20

function DragGutter(): JSX.Element {
  return (
    <div
      data-testid="overlay-drag-gutter"
      // IT IS THE FIRST THING TO GO ON A NARROW WINDOW (JOS-278): 20px of deliberate emptiness
      // is exactly the right thing to spend when the alternative is the lock/close pair leaving
      // the window. `minWidth: 0` is what makes the shrink real — a flex item's default floor is
      // its content, and a `width` with nothing in it still refuses to go below that without it.
      style={{ width: GUTTER_W, flexShrink: 1, minWidth: 0, alignSelf: 'stretch' }}
    />
  )
}

/**
 * The interactive half: the header's title/tail wrapped as a click target, plus the popup it
 * opens. Anchored to the ROW (not to itself) so the list hangs off the header's bottom edge and
 * spans the window, and marked `no-drag` so the click reaches React instead of moving the window.
 */
function HeaderTrigger({
  select,
  rowRef,
  noDrag,
  capture,
  children
}: {
  select: OverlayHeaderSelect
  rowRef: ElementRef
  noDrag: React.CSSProperties
  /** P3: hold the mouse for as long as the list is open (see CaptureReason). No-op unlocked. */
  capture: HeaderCapture
  /** the header body, which needs `open` for its chevron. */
  children: (open: boolean) => JSX.Element
}): JSX.Element {
  const triggerRef = useRef<HTMLDivElement>(null)
  // Open state lives HERE, not in the header, so a mode change that unmounts this can never
  // leave a popup half-open waiting to reappear later.
  const [open, setOpen] = useState(false)
  const [hot, setHot] = useState(false)
  const current = select.rows.find((r) => r.value === select.value) ?? select.rows[0] ?? null

  /**
   * Open/close is also a CAPTURE boundary while locked. The popup is `position: fixed` and so is
   * not a child of the header row — moving the pointer into the open list fires the row's
   * `mouseleave`, and without this second, independently-released reason the list would go
   * click-through the instant the user reached for it.
   *
   * Every close path goes through here (chevron, pick, Esc, outside mousedown), so there is no
   * route that leaves 'popup' held after the list is gone.
   */
  const setOpenCaptured = (next: boolean): void => {
    setOpen(next)
    capture('popup', next)
  }

  return (
    <>
      <div
        ref={triggerRef}
        role="button"
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={() => setOpenCaptured(!open)}
        onMouseEnter={() => setHot(true)}
        onMouseLeave={() => setHot(false)}
        // The disambiguation timing the popup rows carry, on the closed state too — the header
        // shows the name, the tooltip says WHICH one.
        aria-label={current ? `${current.label} · ${current.timing}` : undefined}
        style={{
          ...noDrag,
          display: 'flex',
          alignItems: 'center',
          gap: 6,
          flexGrow: 1,
          minWidth: 0,
          padding: '2px 4px',
          borderRadius: 4,
          cursor: 'pointer',
          userSelect: 'none',
          background: open || hot ? HOVER : 'transparent'
        }}
      >
        {children(open)}
      </div>

      {open && (
        <OverlaySelectPopup
          rows={select.rows}
          value={select.value}
          accent={select.accent}
          anchorRef={rowRef}
          triggerRef={triggerRef}
          noDragStyle={noDrag}
          onPick={(v) => {
            select.onChange(v)
            setOpenCaptured(false)
          }}
          onClose={() => setOpenCaptured(false)}
        />
      )}
    </>
  )
}

export function OverlayHeader({
  live,
  tag,
  last = false,
  title,
  titleColor,
  tail,
  tailTitle,
  tailColor = TAIL_COLOR,
  iconAccentBg = ICON_ACCENT_GOLD,
  select,
  action,
  chrome
}: {
  /** omit entirely for a kind with no combat state (the event log draws no dot). */
  live?: boolean
  tag: string
  /** the head row is the LAST (finished) fight — never dress it up as live. */
  last?: boolean
  title: string
  titleColor: string
  /** OPTIONAL since JOS-158: the meters draw no tail, and the width goes to the title. */
  tail?: string
  tailTitle?: string
  tailColor?: string
  iconAccentBg?: string
  select?: OverlayHeaderSelect
  /** ONE extra control beside the lock/close pair, unlocked only (JOS-322). Absent for every kind
   *  but the zone meter, whose title bar carries "New session". */
  action?: OverlayHeaderAction
  chrome: Pick<OverlayChrome, 'locked' | 'hovering' | 'dragRegion' | 'noDrag' | 'toggleLock'> & {
    /** P3: opt in to a WORKING selector while locked. Absent ⇒ the old plain locked header. */
    capture?: HeaderCapture
  }
}): JSX.Element {
  const { locked, dragRegion, noDrag } = chrome
  const capture = chrome.capture ?? NO_CAPTURE
  const rowRef = useRef<HTMLDivElement>(null)

  // An empty list has nothing to pick, and a locked overlay with no hover sensor has no way to
  // deliver the click: both fall back to the plain header, so a dead hit-test target can never
  // leak into either state. A locked overlay WITH the sensor keeps its selector (P3).
  const selectable = select && select.rows.length > 0 && (!locked || chrome.capture) ? select : null
  const body = (open: boolean | null): JSX.Element => (
    <HeaderBody
      title={title}
      titleColor={titleColor}
      tail={tail}
      tailTitle={tailTitle}
      tailColor={tailColor}
      open={open}
    />
  )

  return (
    <div
      ref={rowRef}
      // THE P3 SENSOR, and the whole of it: while locked, the pointer being over THIS ROW is what
      // makes the window stop ignoring mouse events — so the selector (and the lock/close pair
      // that reveals with it) is clickable and the meter body below is not. Unlocked, `capture`
      // is a no-op and these are two dead handlers.
      onMouseEnter={() => capture('selector', true)}
      onMouseLeave={() => capture('selector', false)}
      style={{
        ...dragRegion,
        display: 'flex',
        alignItems: 'center',
        gap: 6,
        // 7px, not 4 (JOS-121). See the file header: this is the one lever that is not a swap
        // against the selector, and it is what makes the drag hit-area grow at the LONG scope
        // word rather than only at the short one.
        padding: '7px 8px',
        borderBottom: '1px solid rgba(255,255,255,0.08)',
        fontSize: 11,
        flexShrink: 0
      }}
    >
      {live !== undefined && <LiveDot live={live} />}
      <HeaderTag tag={tag} last={last} />

      {selectable ? (
        <HeaderTrigger select={selectable} rowRef={rowRef} noDrag={noDrag} capture={capture}>
          {body}
        </HeaderTrigger>
      ) : (
        body(null)
      )}

      {/* The scope word used to sit above, between the kind tag and the trigger. It says the same
          sentence from the panel floor now (overlay/scopeFloor.tsx); this is where a slice of the
          width it was holding went. */}
      <DragGutter />
      <HeaderControls chrome={chrome} iconAccentBg={iconAccentBg} action={action} />
    </div>
  )
}
