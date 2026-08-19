// ConCardSetting — Preferences → Overlays → "Mob card on con" (JOS-383).
//
// THREE controls over one window: is it on, where does it sit, and how long a card stays.
//
// ON/OFF IS THE WINDOW'S OPEN-STATE. There is no second `enabled` flag: the card is an overlay
// kind, so "on" means its window is open, persisted and restored exactly like every other
// overlay's. Two switches for one state is how they drift.
//
// AND THIS IS THE ONE THAT SHIPS ON, which changes what the card owes the reader. A switch that is
// already true has to say what it is doing — hence the caption naming the trigger (`/con`) rather
// than describing the window — and it has to be findable by somebody who saw a card appear over
// their game and wants to know what it was, which is what the keyword list in PreferencesView is
// for.
//
// SEEDED FROM THE PANE'S SNAPSHOT (JOS-340), like every other card: a control never paints a value
// it does not know. It matters more here than next door — the person whose stored value differs
// from the shipped one is precisely the person who turned this OFF, and a switch that flashes ON
// for them is the defect at its loudest.
//
// STATE, NEVER PROCESS (the repo's UI law): every caption says what is true now, not how the window
// is implemented. Nothing here mentions click-through, IPC or queues.

import { type JSX, useCallback, useEffect, useState } from 'react'
import { FormControlLabel, MenuItem, Select, Stack, Switch, Typography } from '@mui/material'
import {
  CON_CARD_NEVER_HIDES,
  DEFAULT_CON_CARD_CONFIG,
  type ConCardOverlayConfig
} from '@shared/conCard'
import { recordPref, usePrefsSeed, type ConCardSeed } from './prefsHydration'

/**
 * The auto-hides this card offers, in seconds, plus the owner's NEVER.
 *
 * A closed list rather than a slider, for the reason the banner's hold is one: the difference
 * between 20 s and 22 s is not a decision anybody has. `0` is a real member of the list and reads
 * as words, because "it stays until I close it" is a different KIND of answer from a duration and
 * a slider pinned at one end could never say it.
 *
 * THE SHIPPED DEFAULT IS ALWAYS ON THE LIST, and it has now been the head of it twice (JOS-388's
 * five, JOS-390's three). A closed list has one failure mode a slider does not: a stored value with
 * no member to match is a control that paints nothing, and the shipped default is precisely the
 * value EVERY untouched install carries. The list has to contain it or this card breaks its own
 * law — a control never paints a value it does not know (the header above). THREE is also the
 * floor (`CON_CARD_MIN_AUTO_HIDE_MS`), so the list starts exactly where the normalizer does.
 */
const HIDE_CHOICES_SEC = [3, 5, 10, 15, 20, 30, 45, 60, CON_CARD_NEVER_HIDES]

const hideLabel = (sec: number): string =>
  sec === CON_CARD_NEVER_HIDES ? 'until I close it' : `${String(sec)} seconds`

type CardState = ConCardSeed

/**
 * The card window's open-state, lock and knob — SEEDED from the pane's hydration snapshot, then
 * kept current by the two channels that can change them behind this card's back: the overlay's own
 * Done button (the lock lives in the other window) and an overlay closing itself. Both are the
 * genuine ways these values move while this card is on screen, not a second hydration path.
 */
function useConCardState(): [CardState, (patch: Partial<CardState>) => void] {
  const [state, setState] = useState<CardState>(usePrefsSeed().conCard)

  useEffect(() => {
    recordPref('conCard', state)
  }, [state])

  useEffect(() => {
    let alive = true
    const hydrate = (): void => {
      void Promise.all([window.eq.getOverlayState(), window.eq.getConCardConfig()]).then(([open, cfg]) => {
        if (!alive) return
        setState({ open: open.conCard, locked: cfg.locked, cfg: cfg.conCard ?? DEFAULT_CON_CARD_CONFIG })
      })
    }
    window.addEventListener('focus', hydrate)
    const off = window.eq.onOverlayState((s) => {
      if (s.kind === 'conCard') setState((cur) => ({ ...cur, open: s.open }))
    })
    return () => {
      alive = false
      window.removeEventListener('focus', hydrate)
      off()
    }
  }, [])

  const update = useCallback((patch: Partial<CardState>) => {
    setState((cur) => ({ ...cur, ...patch }))
  }, [])
  return [state, update]
}

export function ConCardSetting(): JSX.Element {
  const [state, update] = useConCardState()

  const setLocked = (locked: boolean): void => {
    update({ locked })
    window.eq.setConCardLocked(locked)
  }
  const setHide = (autoHideMs: number): void => {
    const cfg: ConCardOverlayConfig = { ...state.cfg, autoHideMs }
    update({ cfg })
    void window.eq.setConCardConfig({ conCard: cfg })
  }

  return (
    <Stack spacing={2} data-testid="pref-con-card">
      <Stack spacing={0.5}>
        <FormControlLabel
          control={
            <Switch
              size="small"
              data-testid="pref-con-card-enabled"
              checked={state.open}
              onChange={() => void window.eq.toggleOverlay('conCard')}
            />
          }
          label={<Typography variant="body2">Show a mob card when you con</Typography>}
        />
        <Typography variant="caption" color="text.secondary">
          {state.open
            ? 'Con a creature and a card appears over the game with its level and what your logs know about its resists. Click it to open that creature in the app - its drops, your kills and the full resist table. The next con replaces it, and it closes on its own x.'
            : 'Off. Conning a creature does nothing over the game - the mobs you con are still listed on the Overview.'}
        </Typography>
        {/* JOS-405. Two 1.4.0 reports about this card said the text was too small and that the
            text size options did not affect it - and this card's own Preferences entry is where
            they looked. One sentence, state not process, pointing at the control that moves it. */}
        <Typography variant="caption" color="text.secondary" data-testid="pref-con-card-text-size-note">
          Its text size and transparency are Appearance → Overlays.
        </Typography>
      </Stack>

      <Stack spacing={0.5}>
        <FormControlLabel
          control={
            <Switch
              size="small"
              data-testid="pref-con-card-move"
              disabled={!state.open}
              checked={!state.locked}
              onChange={(e) => setLocked(!e.target.checked)}
            />
          }
          label={<Typography variant="body2">Move it</Typography>}
        />
        <Typography variant="caption" color="text.secondary">
          {state.locked
            ? 'The card sits where you left it and clicks pass straight through to the game.'
            : 'The card area is showing its outline - drag it anywhere, and size its text with A- / A+ on the frame. Turn this off (or press Done) when it sits where you want it.'}
        </Typography>
      </Stack>

      <Stack sx={{ minWidth: 200, maxWidth: 260 }}>
        <Typography variant="caption" color="text.secondary">
          A card stays for
        </Typography>
        <Select
          size="small"
          disabled={!state.open}
          data-testid="pref-con-card-hide"
          value={state.cfg.autoHideMs}
          onChange={(e) => setHide(Number(e.target.value))}
        >
          {HIDE_CHOICES_SEC.map((sec) => (
            <MenuItem key={sec} value={sec * 1000}>
              {hideLabel(sec)}
            </MenuItem>
          ))}
        </Select>
      </Stack>
    </Stack>
  )
}
