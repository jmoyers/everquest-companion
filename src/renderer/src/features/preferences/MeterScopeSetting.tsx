// WHOSE DAMAGE THE METERS SHOW — the Combat section's second card (JOS-115).
//
// It used to be a chip on every combat surface: one on the Combat tab's lens line, one on each
// floating overlay's header row, each writing its own key. The owner's reading was that a
// three-state selector repeated on every surface is clutter answering a question you set once
// ("the You / Group / Everyone meter SOURCE-scope control is shown INLINE on every combat surface
// and is too crowded"), so it is ONE preference now, written here and read by the Combat tab, the
// Overview damage card and every floating meter (features/combat/useCombatPrefs.useMeterScope).
//
// A SEGMENTED CONTROL, NOT A CYCLE. The overlay's chip was a cycle because a two-inch pinned
// window has room for one word; a preferences card has room for three, and three visible options
// with the chosen one lit is the shape that says what the alternatives even are.
//
// The DESCRIPTION under it is the selected scope's own sentence out of shared/roster.ts — the one
// phrasing every surface's tooltip already uses, so this card cannot drift from what the meters
// say about themselves. The Group row carries one extra line, because Group is the default and its
// no-roster fallback is the single thing about this setting a user is most likely to be confused
// by: an empty roster makes Group render as Everyone (law 1 — unknown must never hide people), and
// the meters label themselves `Group (no roster yet)` while it does.
//
// It is a SEPARATE FILE from PreferencesView.tsx for the reason PerfSetting and GraphicsSetting
// are: that file sits at the 400-code-line factoring ceiling, and the answer there is to split.

import { type JSX } from 'react'
import { Stack, ToggleButton, ToggleButtonGroup, Typography } from '@mui/material'
import { useMeterScope } from '../combat/useCombatPrefs'
import { METER_SCOPES, SCOPE_HINT, SCOPE_LABEL, type MeterScope } from '@shared/roster'

export function MeterScopeSetting(): JSX.Element {
  const [scope, setScope] = useMeterScope()
  return (
    <Stack spacing={1}>
      <ToggleButtonGroup
        size="small"
        exclusive
        value={scope}
        data-testid="pref-meter-scope"
        // A group with `exclusive` hands back `null` when the pressed button is the selected one.
        // Scope has no "off" — every meter is showing SOMEBODY — so a null is a no-op rather than
        // a fourth state, and the setting can never be left without an answer.
        onChange={(_e, v: MeterScope | null) => {
          if (v !== null) setScope(v)
        }}
        sx={{ alignSelf: 'flex-start' }}
      >
        {METER_SCOPES.map((s) => (
          <ToggleButton key={s} value={s} data-testid={`pref-meter-scope-${s}`} sx={{ px: 1.5, py: 0.25 }}>
            {SCOPE_LABEL[s]}
          </ToggleButton>
        ))}
      </ToggleButtonGroup>
      <Typography variant="caption" color="text.secondary">
        {SCOPE_HINT[scope]}.
        {scope === 'group'
          ? ' Until the log gives the app a group signal there is no roster to filter by, so Group shows everyone and the meters say so (“Group (no roster yet)”).'
          : ''}
      </Typography>
    </Stack>
  )
}
