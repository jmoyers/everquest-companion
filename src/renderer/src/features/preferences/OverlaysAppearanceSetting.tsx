// OverlaysAppearanceSetting — Preferences → Appearance → the ONE OVERLAYS CARD (JOS-408).
//
// WHAT IT REPLACES, AND WHY. JOS-405 put the overlays' text size in Preferences and JOS-407 put
// their transparency beside it; each arrived as its own card with its own Independent switch, and a
// third card carried twelve rows whose halves were disabled by whichever switch was off. The owner
// walked the finished page on 2026-08-17 and named the defect exactly: "our first pass had enabled
// controls when they didn't do anything. That's a bad pattern." Three cards, two switches that
// looked identical, and — while synced — twenty-four controls that were rendered, greyed, and
// explained by a tooltip instead of simply not being there.
//
// THE RULE THIS CARD IS BUILT ON: a control is visible only if pressing it changes something on
// screen right now. No disabled controls except a stepper at a clamp (the value cannot move, which
// is a fact about the value rather than about permission), no tooltip explaining why a control is
// dead, and never two controls for one number.
//
// SO THE CARD HAS EXACTLY TWO SHAPES:
//
//   SWITCH OFF   one text size, one transparency — two steppers, and NO list. The twelve per-kind
//                values still exist and are still remembered; they are simply not what anything is
//                doing, so there is nothing to show for them.
//   SWITCH ON    twelve rows, every control live, and NO shared steppers. The shared values still
//                exist too, for the same reason in the other direction.
//
// ONE SWITCH OVER TWO STORED FLAGS. The plumbing is untouched: two prefs objects, two stores, two
// migrations, eight IPC channels, and each overlay window still reads its own feature's prefs. The
// page reads `overlayIndependent(...)` and writes both flags through the one call that keeps them
// atomic (shared/overlayIndependent.ts carries the whole argument, including why main reconciles
// an install whose two flags disagree).
//
// A CLOSED WINDOW SAYS SO. A row for an overlay that is not open still writes its stored value —
// that is what the window will come up at — but nothing on screen moves when you press it, and
// under this card's own rule that has to be visible. Hence the quiet `closed` tag: the control is
// live and honest, and the tag is why the game did not change.
//
// ONE BORDER: PreferencesView already wraps each item in an outlined Paper, so this renders a bare
// Stack.

import { type JSX, useCallback, useEffect, useState } from 'react'
import { Box, FormControlLabel, Stack, Switch, Typography } from '@mui/material'
import {
  TEXT_SCALE_MAX,
  TEXT_SCALE_MIN,
  TEXT_SCALE_STEP,
  clampTextScale,
  effectiveOverlayTextScale,
  type OverlayTextSizePrefs
} from '@shared/overlayTextScale'
import {
  BG_ALPHA_MAX,
  BG_ALPHA_MIN,
  clampBgAlpha,
  effectiveOverlayBgAlpha,
  stepBgAlpha,
  type OverlayBgAlphaPrefs
} from '@shared/overlayBgAlpha'
import { overlayIndependent } from '@shared/overlayIndependent'
import { OVERLAY_KIND_LABEL, OVERLAY_LABEL_ORDER, OVERLAY_STRIP_KINDS } from '@shared/overlayLabels'
import type { OverlayKind } from '@shared/types'
import { PREF_STEPPER_W, PrefStepper } from './PrefStepper'
import { recordPref, usePrefsSeed } from './prefsHydration'

/** The percentage, which is the vocabulary the whole Appearance section speaks. */
const pct = (v: number): string => `${String(Math.round(v * 100))}%`

/** One feature's prefs blob, as this card needs to hold it. */
interface PrefsHook<T> {
  prefs: T
  /** Merge-patch through THIS feature's own channel — a shared size, a shared alpha. */
  update: (patch: Partial<T>) => void
  /**
   * Take a whole value from somewhere else: main's push, or the one-switch call's reply.
   *
   * It records into the hydration cache as well as into state, exactly as `update` does with main's
   * reply, so a rail click away and back seeds from what just happened rather than from what the
   * pane loaded minutes ago.
   */
  adopt: (p: T) => void
}

/**
 * The overlays' TEXT SIZE prefs, seeded from the pane's hydration snapshot (JOS-340) and kept
 * current by main's PUSH as well as by this card's own writes.
 *
 * The push is not decoration: the shared size has thirteen controls — twelve windows' own A− / A+
 * and this card's stepper — so a Preferences pane left open while somebody scales their fight meter
 * would otherwise print a stale percentage.
 */
function useOverlayTextSize(): PrefsHook<OverlayTextSizePrefs> {
  const [prefs, setPrefs] = useState<OverlayTextSizePrefs>(usePrefsSeed().overlayTextSize)

  const adopt = useCallback((p: OverlayTextSizePrefs) => {
    setPrefs(p)
    recordPref('overlayTextSize', p)
  }, [])

  useEffect(() => window.eq.onOverlayTextSize(adopt), [adopt])

  const update = useCallback(
    (patch: Partial<OverlayTextSizePrefs>) => {
      setPrefs((cur) => ({ ...cur, ...patch }))
      void window.eq.setOverlayTextSize(patch).then(adopt)
    },
    [adopt]
  )

  return { prefs, update, adopt }
}

/** …and their BACKGROUND TRANSPARENCY, on exactly the same terms (fifteen controls, same push). */
function useOverlayBgAlpha(): PrefsHook<OverlayBgAlphaPrefs> {
  const [prefs, setPrefs] = useState<OverlayBgAlphaPrefs>(usePrefsSeed().overlayBgAlpha)

  const adopt = useCallback((p: OverlayBgAlphaPrefs) => {
    setPrefs(p)
    recordPref('overlayBgAlpha', p)
  }, [])

  useEffect(() => window.eq.onOverlayBgAlpha(adopt), [adopt])

  const update = useCallback(
    (patch: Partial<OverlayBgAlphaPrefs>) => {
      setPrefs((cur) => ({ ...cur, ...patch }))
      void window.eq.setOverlayBgAlpha(patch).then(adopt)
    },
    [adopt]
  )

  return { prefs, update, adopt }
}

/** Every kind's OWN size, live: seeded from the pane's snapshot, corrected by main's push (a press
 *  made on a WINDOW while this list is open), and written through the same door that press uses. */
function useKindScales(): [Record<OverlayKind, number>, (kind: OverlayKind, next: number) => void] {
  const [scales, setScales] = useState<Record<OverlayKind, number>>(usePrefsSeed().overlayTextScales)

  useEffect(() => {
    return window.eq.onOverlayTextScales((m) => {
      setScales(m)
      recordPref('overlayTextScales', m)
    })
  }, [])

  const setKind = useCallback((kind: OverlayKind, textScale: number) => {
    setScales((cur) => ({ ...cur, [kind]: textScale }))
    void window.eq.setOverlayTextScale(kind, textScale).then((cfg) => {
      const stored = clampTextScale(cfg.textScale)
      setScales((cur) => {
        const next = { ...cur, [kind]: stored }
        recordPref('overlayTextScales', next)
        return next
      })
    })
  }, [])

  return [scales, setKind]
}

/** …and every kind's OWN transparency, on exactly the same terms. */
function useKindAlphas(): [Record<OverlayKind, number>, (kind: OverlayKind, next: number) => void] {
  const [alphas, setAlphas] = useState<Record<OverlayKind, number>>(usePrefsSeed().overlayBgAlphas)

  useEffect(() => {
    return window.eq.onOverlayBgAlphas((m) => {
      setAlphas(m)
      recordPref('overlayBgAlphas', m)
    })
  }, [])

  const setKind = useCallback((kind: OverlayKind, bgAlpha: number) => {
    setAlphas((cur) => ({ ...cur, [kind]: bgAlpha }))
    void window.eq.setOverlayBgAlphaFor(kind, bgAlpha).then((cfg) => {
      const stored = clampBgAlpha(cfg.bgAlpha)
      setAlphas((cur) => {
        const next = { ...cur, [kind]: stored }
        recordPref('overlayBgAlphas', next)
        return next
      })
    })
  }, [])

  return [alphas, setKind]
}

/**
 * WHICH OVERLAY WINDOWS ARE OPEN, live.
 *
 * The one fact this card needs that is not a stored value: a row for a closed window is honest only
 * if it says so. Seeded from the pane's snapshot (the same `getOverlayState` read the toast, banner
 * and con-card cards already share) and kept current by main's per-kind push, because a window can
 * be opened from the title bar's Overlay menu while this pane is on screen.
 */
function useOverlayOpen(): Record<OverlayKind, boolean> {
  const [open, setOpen] = useState<Record<OverlayKind, boolean>>(usePrefsSeed().overlayOpen)

  useEffect(() => {
    return window.eq.onOverlayState((s) => {
      setOpen((cur) => ({ ...cur, [s.kind]: s.open }))
    })
  }, [])

  return open
}

// ------------------------------------------------------------------------------ the two shapes

/** A labelled row with one stepper on the right — the shape both halves of this card are made of. */
function StepperRow({
  label,
  tag,
  dim,
  children
}: {
  label: string
  /** `closed`, or nothing. */
  tag?: string
  dim?: boolean
  children: JSX.Element | JSX.Element[]
}): JSX.Element {
  return (
    <Stack direction="row" alignItems="center" spacing={1}>
      <Stack direction="row" alignItems="baseline" spacing={0.75} sx={{ flexGrow: 1, minWidth: 0 }}>
        <Typography variant="body2" sx={{ opacity: dim === true ? 0.7 : 1 }} noWrap>
          {label}
        </Typography>
        {tag !== undefined && (
          <Typography variant="caption" color="text.disabled" sx={{ flexShrink: 0 }}>
            {tag}
          </Typography>
        )}
      </Stack>
      {children}
    </Stack>
  )
}

/**
 * THE SWITCH OFF SHAPE: one text size, one transparency, and nothing else.
 *
 * No list, because while these two are in force the twelve per-kind values are not doing anything —
 * and a row that shows a number nothing is obeying is the confusion this ticket removes.
 */
function SharedRows({
  size,
  alpha
}: {
  size: PrefsHook<OverlayTextSizePrefs>
  alpha: PrefsHook<OverlayBgAlphaPrefs>
}): JSX.Element {
  return (
    <Stack spacing={0.5}>
      <StepperRow label="Text size">
        <PrefStepper
          kind="size"
          value={pct(size.prefs.shared)}
          name="the overlays"
          atMin={size.prefs.shared <= TEXT_SCALE_MIN}
          atMax={size.prefs.shared >= TEXT_SCALE_MAX}
          onStep={(dir) => {
            size.update({ shared: clampTextScale(size.prefs.shared + dir * TEXT_SCALE_STEP) })
          }}
          testid="pref-overlay-text-size"
        />
      </StepperRow>
      <StepperRow label="Transparency">
        <PrefStepper
          kind="transparency"
          value={pct(alpha.prefs.shared)}
          name="the overlays"
          atMin={alpha.prefs.shared <= BG_ALPHA_MIN}
          atMax={alpha.prefs.shared >= BG_ALPHA_MAX}
          onStep={(dir) => {
            alpha.update({ shared: stepBgAlpha(alpha.prefs.shared, dir) })
          }}
          testid="pref-overlay-bg-alpha"
        />
      </StepperRow>
    </Stack>
  )
}

/** One overlay's row: its name, whether its window is open, its size, its transparency. */
function OverlayRow({
  kind,
  open,
  scale,
  onStep,
  alpha,
  onAlpha
}: {
  kind: OverlayKind
  open: boolean
  scale: number
  onStep: (dir: 1 | -1) => void
  alpha: number
  onAlpha: (dir: 1 | -1) => void
}): JSX.Element {
  return (
    <Box data-testid={`pref-overlay-row-${kind}`}>
      <StepperRow label={OVERLAY_KIND_LABEL[kind]} tag={open ? undefined : 'closed'} dim={!open}>
        {/* TWO COLUMNS UNDER TWO HEADERS (owner, 2026-08-17). The steppers sit `COLUMN_GAP` apart
            so the header row above can name each column without the labels running together, and
            their faces are the plain − / + because the header is the label — see PrefStepper. */}
        <Stack direction="row" alignItems="center" spacing={COLUMN_GAP}>
          <PrefStepper
            kind="size"
            plain
            value={pct(scale)}
            name={OVERLAY_KIND_LABEL[kind]}
            atMin={scale <= TEXT_SCALE_MIN}
            atMax={scale >= TEXT_SCALE_MAX}
            onStep={onStep}
            testid={`pref-overlay-text-size-${kind}`}
          />
          <PrefStepper
            kind="transparency"
            plain
            value={pct(alpha)}
            name={OVERLAY_KIND_LABEL[kind]}
            atMin={alpha <= BG_ALPHA_MIN}
            atMax={alpha >= BG_ALPHA_MAX}
            onStep={onAlpha}
            testid={`pref-overlay-bg-alpha-${kind}`}
          />
        </Stack>
      </StepperRow>
    </Box>
  )
}

/** The room between the two stepper columns, in theme spacing units — enough for two headers. */
const COLUMN_GAP = 3

/**
 * THE HEADER ROW over the per-overlay list: nothing over the names, then `Text size` and `Opacity`
 * each centred over its column of steppers. Sized from the stepper's own exported width and the
 * same gap, so the words sit over the controls they name at any pane width.
 */
function ColumnHeaders(): JSX.Element {
  return (
    <Stack direction="row" alignItems="center" spacing={1} data-testid="pref-overlay-columns">
      <Box sx={{ flexGrow: 1, minWidth: 0 }} />
      <Stack direction="row" spacing={COLUMN_GAP}>
        {(['Text size', 'Opacity'] as const).map((h) => (
          <Typography
            key={h}
            variant="caption"
            color="text.secondary"
            sx={{ width: PREF_STEPPER_W, textAlign: 'center', flexShrink: 0 }}
          >
            {h}
          </Typography>
        ))}
      </Stack>
    </Stack>
  )
}

/**
 * THE SWITCH ON SHAPE: all twelve, every control live, and no shared steppers above them.
 *
 * GROUPED AS THE APP NAMES THEM (shared/overlayLabels.ts): the nine windows you open from the
 * Overlay menu, in that menu's order, then the three strips that appear by themselves.
 */
function PerOverlayRows({
  size,
  alpha,
  open
}: {
  size: OverlayTextSizePrefs
  alpha: OverlayBgAlphaPrefs
  open: Record<OverlayKind, boolean>
}): JSX.Element {
  const [scales, setScale] = useKindScales()
  const [alphas, setAlpha] = useKindAlphas()

  return (
    <Stack spacing={0.25}>
      <ColumnHeaders />
      {OVERLAY_LABEL_ORDER.map((kind) => {
        // IN FORCE, never remembered — the one rule the rows keep from the retired list. Under this
        // switch that is the kind's own value, which is also what the window is drawing.
        const scale = effectiveOverlayTextScale(size, scales[kind])
        const a = effectiveOverlayBgAlpha(alpha, alphas[kind])
        return (
          <Box key={kind}>
            {kind === OVERLAY_STRIP_KINDS[0] && (
              <Typography variant="caption" color="text.secondary" sx={{ display: 'block', pt: 1, pb: 0.5 }}>
                These appear by themselves when something happens.
              </Typography>
            )}
            <OverlayRow
              kind={kind}
              open={open[kind]}
              scale={scale}
              onStep={(dir) => {
                setScale(kind, clampTextScale(scale + dir * TEXT_SCALE_STEP))
              }}
              alpha={a}
              onAlpha={(dir) => {
                setAlpha(kind, stepBgAlpha(a, dir))
              }}
            />
          </Box>
        )
      })}
    </Stack>
  )
}

// ------------------------------------------------------------------------------------ the card

/**
 * THE OVERLAYS CARD: one switch, then EITHER two steppers OR twelve rows. Never both.
 *
 * The two shapes are mounted alternately rather than hidden, and that is the other half of the
 * ticket's fix: a hidden shared row keeps its state, so flipping the switch twice used to leave
 * stale percentages sitting behind a `display: none` waiting to be revealed.
 */
export function OverlaysAppearanceSetting(): JSX.Element {
  const size = useOverlayTextSize()
  const alpha = useOverlayBgAlpha()
  const open = useOverlayOpen()
  const independent = overlayIndependent({ text: size.prefs.independent, bg: alpha.prefs.independent })
  // THE SHARED STEPPERS' VERSION OF THE `closed` TAG (JOS-408 confusion audit). Every row that
  // governs a closed window says so; the two SHARED steppers govern all twelve at once, so the
  // equivalent state is "none of them is open" — and there the honest answer to "what changes on
  // screen when I press this" is "nothing yet". Hiding the steppers would be worse than saying so:
  // the value they set is what those windows will open at, which is a real thing to come here for.
  // It is a rare state (the mob card ships open) and it is one sentence, not a control.
  const nothingOpen = OVERLAY_LABEL_ORDER.every((kind) => !open[kind])

  const flip = (on: boolean): void => {
    // Optimistic, so the switch moves under the finger rather than after an IPC round trip; main's
    // reply is authoritative and arrives with both stores' real answers, seeds included.
    size.adopt({ ...size.prefs, independent: on })
    alpha.adopt({ ...alpha.prefs, independent: on })
    void window.eq.setOverlayIndependent(on).then(({ text, bg }) => {
      size.adopt(text)
      alpha.adopt(bg)
    })
  }

  return (
    <Stack spacing={1.25}>
      <Stack spacing={0.25}>
        <FormControlLabel
          control={
            <Switch
              size="small"
              data-testid="pref-overlay-independent"
              checked={independent}
              onChange={(e) => {
                flip(e.target.checked)
              }}
            />
          }
          label={<Typography variant="body2">Independent per overlay</Typography>}
        />
        <Typography variant="caption" color="text.secondary" data-testid="pref-overlay-independent-note">
          {independent
            ? 'Each overlay keeps its own text size and transparency.'
            : 'All overlays share one text size and one transparency.'}
          {/* Only in the shared shape: with the switch on, every row already carries its own
              `closed` tag and this sentence would repeat twelve of them. */}
          {!independent && nothingOpen && ' None is open right now, so this is what they will open at.'}
        </Typography>
      </Stack>

      {independent ? (
        <PerOverlayRows size={size.prefs} alpha={alpha.prefs} open={open} />
      ) : (
        <SharedRows size={size} alpha={alpha} />
      )}
    </Stack>
  )
}
