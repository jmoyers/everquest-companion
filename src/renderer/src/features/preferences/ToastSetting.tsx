// ToastSetting — Preferences → Overlays → "Celebration toasts"
// (docs/plans/celebration-toasts.md §3).
//
// TWO controls over one window: is it on, and where does it sit. (The third knob — text size —
// is on the toast's own frame, because that frame is the only chrome this kind ever shows and a
// size control that lived here would be sizing something you cannot see.)
//
// ON/OFF IS THE WINDOW'S OPEN-STATE. There is no second `enabled` flag: the toast overlay is a
// sixth overlay kind, so "on" means its window is open, persisted and restored exactly like
// every other overlay's. Two switches for one state is how they drift.
//
// THERE IS NO SOUND CONTROL HERE (owner, 2026-08-05: "remove the sound controls from
// preferences, they are already covered by Alerts module"). This panel briefly carried a pack /
// line picker whose default was Silent, with a caption explaining that the "Raid target defeated"
// and "Quest complete" alerts already speak for these events. A control whose honest caption
// tells you not to use it is a control that should not exist: the ALERTS module owns what these
// celebrations sound like, in one place, for every surface that reports them.
//
// STATE, NEVER PROCESS (the repo's UI law): every caption says what is true now, not how the
// window is implemented. Nothing here mentions click-through, IPC or `setIgnoreMouseEvents`.

import { type JSX, useCallback, useEffect, useState } from 'react'
import { FormControlLabel, Stack, Switch, Typography } from '@mui/material'
import { recordPref, usePrefsSeed, type ToastSeed } from './prefsHydration'

/** The two facts this panel shows. The toast's `durationMs` is not exposed — it is a timing
 *  constant with a good default, and the card pins under the pointer anyway. */
type ToastState = ToastSeed

/**
 * The toast window's open-state + lock: SEEDED from the pane's hydration snapshot, then kept
 * current by the two channels that can change it behind this card's back.
 *
 * THE SEED IS THE JOS-340 HALF. It used to mount on `{ open: false, locked: true }` and correct
 * itself, and BOTH of those defaults are wrong for a user who has changed them — `locked: true`
 * in particular meant the "Move it" switch painted OFF and then rose for anyone with the strip
 * unlocked. The gate's snapshot reads exactly these two facts (./prefsHydration.tsx) and hands
 * them over before the first render.
 *
 * THE LISTENERS STAY, and they are not a second hydration path — they are the two ways this value
 * genuinely changes while the card is on screen. The focus re-read is the alert player's
 * precedent: the toast's own frame carries a Done button, so the lock can change in the OTHER
 * window. And an overlay can close itself (the app quitting, its own window controls), so the
 * switch listens rather than trusting the value it started with. Both write back to the snapshot,
 * so the next mount of this card starts from what they learned.
 */
function useToastState(): [ToastState, (patch: Partial<ToastState>) => void] {
  const [state, setState] = useState<ToastState>(usePrefsSeed().toast)

  // ONE place writes the snapshot back, and it is an EFFECT rather than a line inside each
  // setter: a `useState` updater has to be pure (React may run it twice), and there are three
  // ways this value moves — the switches, the focus re-read, and the overlay's own push.
  useEffect(() => {
    recordPref('toast', state)
  }, [state])

  useEffect(() => {
    let alive = true
    const hydrate = (): void => {
      void Promise.all([window.eq.getOverlayState(), window.eq.getToastConfig()]).then(([open, cfg]) => {
        if (alive) setState({ open: open.toast, locked: cfg.locked })
      })
    }
    window.addEventListener('focus', hydrate)
    const off = window.eq.onOverlayState((s) => {
      if (s.kind === 'toast') setState((cur) => ({ ...cur, open: s.open }))
    })
    return () => {
      alive = false
      window.removeEventListener('focus', hydrate)
      off()
    }
  }, [])

  const update = useCallback((patch: Partial<ToastState>) => {
    setState((cur) => ({ ...cur, ...patch }))
  }, [])
  return [state, update]
}

export function ToastSetting(): JSX.Element {
  const [state, update] = useToastState()

  const setLocked = (locked: boolean): void => {
    update({ locked })
    window.eq.setToastLocked(locked)
  }

  return (
    <Stack spacing={2} data-testid="pref-toast">
      <Stack spacing={0.5}>
        <FormControlLabel
          control={
            <Switch
              size="small"
              data-testid="pref-toast-enabled"
              checked={state.open}
              onChange={() => void window.eq.toggleOverlay('toast')}
            />
          }
          label={<Typography variant="body2">Celebrate boss kills and Sky quests on screen</Typography>}
        />
        <Typography variant="caption" color="text.secondary">
          {state.open
            ? 'A card slides in at the top of the screen when you drop a raid target or finish a Plane of Sky quest, then fades. Point at it to keep it up; a quest’s reward card opens the Plane of Sky tab.'
            : 'Off. Boss kills and quest completions still show up in the app and in your alerts - nothing appears over the game.'}
        </Typography>
        {/* JOS-405: the strip's own A− / A+ is in a drag frame you have to unlock to see, so this
            says where else the size lives. One sentence, state not process. */}
        <Typography variant="caption" color="text.secondary" data-testid="pref-toast-text-size-note">
          Its text size and transparency are Appearance → Overlays.
        </Typography>
      </Stack>

      <Stack spacing={0.5}>
        <FormControlLabel
          control={
            <Switch
              size="small"
              data-testid="pref-toast-move"
              disabled={!state.open}
              checked={!state.locked}
              onChange={(e) => setLocked(!e.target.checked)}
            />
          }
          label={<Typography variant="body2">Move it</Typography>}
        />
        <Typography variant="caption" color="text.secondary">
          {state.locked
            ? 'The strip sits where you left it and clicks pass straight through to the game.'
            : 'The strip is showing its outline - drag it anywhere, and size its text with A− / A+ on the frame. Turn this off (or press Done) when it sits where you want it.'}
        </Typography>
      </Stack>
    </Stack>
  )
}
