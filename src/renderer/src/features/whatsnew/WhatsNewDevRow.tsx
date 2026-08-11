// ============================================================================
// DEV-ONLY: drive the what's-new states by hand (JOS-73).
// ============================================================================
//
// The feature has four states and three of them are only reachable by having ALREADY been a user
// of an older build. That is not something anyone can arrange on a dev machine, and it is
// exactly the kind of thing that ships broken because nobody could look at it. So the states are
// drivable: each button writes the one store key the whole feature derives from, and the panel
// above and the teaser strip below re-derive in front of you (features/whatsnew/session.ts).
//
// IT IS A WRITE, NOT A MOCK. There is no test mode, no injected state and no second code path —
// the buttons put the app into a real configuration and everything downstream behaves the way it
// would for a user who arrived there by upgrading. A simulation that bypassed the store would be
// proving that the simulation works.
//
// TIER 1 (`DEV_TOOLS`, plain `import.meta.env.DEV`), not owner-tools: it reads no credentials and
// touches nothing but this install's own settings, so it is a contributor convenience like the
// dev restart button — AGENTS.md's two-tier rule. Its one call site is behind `DEV_TOOLS`, which
// folds to a literal `false` in every `electron-vite build`, so rollup deletes the branch and
// then this unreferenced module with it.
//
// The chip says what this is (the tooltip diet); nothing confirms, because every state is one
// click away from every other and "Real" is always the way back.

import { type JSX, useCallback, useState } from 'react'
import { Button, Chip, Stack, Typography } from '@mui/material'
import { RELEASE_NOTES, variantLastSeen, type WhatsNewVariant } from '@shared/releaseNotes'
import { realLastSeenVersion, resetToRealLastSeen, simulateLastSeen } from './session'

/** The three simulated states, in the order somebody hand-testing walks them: the state the app
 *  ships in, then one release of news, then the multi-release case the marking exists for. */
const VARIANTS: readonly { id: WhatsNewVariant; label: string }[] = [
  { id: 'fresh', label: 'Fresh install' },
  { id: 'previous', label: 'From previous' },
  { id: 'several', label: 'From several back' }
]

/** What a button actually does to the store, said out loud under the row — the difference
 *  between "I clicked something" and "I know what state this app is in". */
function variantNote(variant: WhatsNewVariant | 'real'): string {
  if (variant === 'real') {
    const real = realLastSeenVersion()
    return real === null
      ? 'Back to the real state: no release seen (this install has never been shown notes).'
      : `Back to the real state: last seen v${real}.`
  }
  const seen = variantLastSeen(variant, RELEASE_NOTES)
  return seen === null
    ? 'No release seen - no teaser, nothing marked new. This is what a brand-new install does.'
    : `Last seen v${seen} - every release above it is marked new, and the teaser names the newest.`
}

export function WhatsNewDevRow(): JSX.Element {
  const [applied, setApplied] = useState<WhatsNewVariant | 'real' | null>(null)

  const apply = useCallback((variant: WhatsNewVariant) => {
    simulateLastSeen(variantLastSeen(variant, RELEASE_NOTES))
    setApplied(variant)
  }, [])

  const reset = useCallback(() => {
    resetToRealLastSeen()
    setApplied('real')
  }, [])

  return (
    <Stack spacing={0.5} data-testid="whats-new-dev">
      <Stack direction="row" alignItems="center" spacing={1} flexWrap="wrap" useFlexGap>
        {VARIANTS.map((v) => (
          <Button
            key={v.id}
            size="small"
            variant={applied === v.id ? 'contained' : 'outlined'}
            data-testid={`whats-new-dev-${v.id}`}
            onClick={() => {
              apply(v.id)
            }}
          >
            {v.label}
          </Button>
        ))}
        <Button
          size="small"
          variant={applied === 'real' ? 'contained' : 'outlined'}
          data-testid="whats-new-dev-real"
          onClick={reset}
        >
          Real
        </Button>
        <Chip
          size="small"
          label="dev only"
          variant="outlined"
          color="warning"
          sx={{ height: 18, fontSize: 10, '& .MuiChip-label': { px: 0.75 } }}
        />
      </Stack>
      <Typography variant="caption" color="text.secondary" data-testid="whats-new-dev-note">
        {applied === null
          ? 'Simulate arriving from an older build - the notes above and the strip along the bottom follow immediately.'
          : variantNote(applied)}
      </Typography>
    </Stack>
  )
}
