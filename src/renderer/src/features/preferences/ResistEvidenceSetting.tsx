// ResistEvidenceSetting — Preferences → Combat → "Learn resists from pets and NPC casters"
// (JOS-385).
//
// ONE SWITCH OVER A QUESTION THAT IS GENUINELY OPEN. The resist profiles on the mob page and the
// con card are mined from what the log printed; this decides whether a charmed pet's casts and an
// NPC's casts on another NPC are part of that. The owner's worry, and the reason the switch exists
// rather than a hard-wired answer: pets may be tuned differently from players, and if they are,
// their casts would drag a mob's number toward "easy" on exactly the axis a player finds hard. The
// measured comparison on the owner's log did not find that skew, so it ships ON — and it stays a
// switch because the kind of fact that can be measured can also change under a patch.
//
// WHERE IT LIVES. The Combat section, beside the two cards about what the meters show: all three
// answer "what does this app count", which is what a person looking for this control has in mind.
// It is not a privacy question, so it is not in Usage analytics.
//
// STATE, NEVER PROCESS (the repo's UI law): the caption says what the numbers currently include,
// never that a preference is read at estimate time or that a ledger folds regardless. What the
// reader is owed is the one consequence they can see — flipping it re-draws the numbers, and it
// never throws away anything the log saw.
//
// SEEDED FROM THE PANE'S SNAPSHOT (JOS-340), like every other card, and it matters here for the
// `processPriority` reason: the default is ON, so the only person whose stored value differs is
// the one who turned it OFF, and a switch that flashes ON for them is the defect at its loudest.

import { type JSX, useCallback, useState } from 'react'
import { FormControlLabel, Stack, Switch, Typography } from '@mui/material'
import type { ResistPrefs } from '@shared/resistPrefs'
import { recordPref, usePrefsSeed } from './prefsHydration'

/**
 * The stored blob, seeded from the gate and written back on every flip. Main's reply is
 * authoritative — it is what the shared normalizer actually stored — and it is what the cache
 * keeps, so the next mount of this card paints the change rather than what the pane loaded.
 */
function useResistPrefs(): [ResistPrefs, (patch: Partial<ResistPrefs>) => void] {
  const [prefs, setPrefs] = useState<ResistPrefs>(usePrefsSeed().resists)

  const update = useCallback((patch: Partial<ResistPrefs>) => {
    setPrefs((cur) => ({ ...cur, ...patch }))
    void window.eq.setResistPrefs(patch).then((stored) => {
      setPrefs(stored)
      recordPref('resists', stored)
    })
  }, [])

  return [prefs, update]
}

export function ResistEvidenceSetting(): JSX.Element {
  const [prefs, update] = useResistPrefs()
  return (
    <Stack spacing={1} data-testid="pref-resist-evidence">
      <FormControlLabel
        control={
          <Switch
            size="small"
            data-testid="pref-resist-npc-casters"
            checked={prefs.includeNpcCasters}
            onChange={(e) => {
              update({ includeNpcCasters: e.target.checked })
            }}
          />
        }
        label={<Typography variant="body2">Count pets and other creatures as evidence</Typography>}
      />
      <Typography variant="caption" color="text.secondary">
        {prefs.includeNpcCasters
          ? 'A charmed pet or another creature casting on a mob counts toward that mob’s resist numbers, alongside what you and other players cast.'
          : 'Only spells cast by people count toward a mob’s resist numbers. What pets and other creatures cast is still listed as evidence on the mob page, and no number is worked out from it.'}
      </Typography>
    </Stack>
  )
}
