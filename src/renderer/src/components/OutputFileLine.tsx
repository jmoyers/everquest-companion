// components/OutputFileLine.tsx — ONE LINE THAT SAYS WHERE A SURFACE'S DATA CAME FROM AND HOW TO
// REFRESH IT (JOS-42 refinement 5).
//
// THE PROBLEM IT SOLVES. Several surfaces in this app are fed by a file the PLAYER writes with an
// `/outputfile <kind>` command — the Exaltations tab's worn hosts today, and whatever JOS-44's
// export-command work adopts next. Those surfaces have a failure mode that looks exactly like
// success: the data renders, it is simply OLD, because the dump is a snapshot from whenever the
// command was last typed. Nothing on screen said so. A player who swapped gear an hour ago saw
// last week's loadout presented with total confidence.
//
// SO THE LINE STATES THREE THINGS AND STOPS: the command to type, ONE clause of why it is worth
// typing, and how old the file is. That last one is the whole point — it is read from the file's
// own mtime, so it is WHEN THE PLAYER DUMPED, never when the app read it.
//
// IT IS NOT A CAVEAT, and the tooltip-and-caveat diet is why it looks like this. It does not
// apologise for the data, footnote where a number came from, or explain how the parser works; it
// is a control surface for an action the player takes in game, with the freshness as ambient
// state (the `formatAge` idiom the update chip established). One row, `nowrap`, the why-clause the
// only group allowed to ellipsize.
//
// SHARED BY CONSTRUCTION rather than by refactor-later: it takes the command and the clause as
// props and knows nothing about inventories, so a second `/outputfile` surface adopts it by
// importing it (JOS-44's sequencing note — whichever of us landed second was to use the other's).
//
// AND THE FOURTH THING (JOS-185): HOW to type it. This is not a retreat from the caveat diet — it
// is the same argument that put the command here in the first place. `/outputfile inventory` is
// CONDITIONAL: the Dragon's Hoard is exported only while its window is open, the tradeskill depot
// only if it has been loaded, and both third-party EQ Legends trackers tell their users to stand
// at a banker with the Bank up. A dump typed anywhere else is not an error, does not look like
// one, and quietly omits whole storages — which is a player's Sky weapons going missing from a
// file that parsed perfectly. So the steps are part of the CONTROL SURFACE for the action, in the
// same row as the action, and they are COLLAPSED by default: nothing about the line changes for
// somebody who is not asking, and one click gets the answer without leaving the tab.
//
// A surface with no steps to give renders exactly what it rendered before — the toggle only
// exists when `steps` is non-empty, so the three-things-and-stop contract is intact everywhere it
// was already true.

import { type JSX, useEffect, useState } from 'react'
import { Box, Button, Collapse, Paper, Stack, Typography } from '@mui/material'
import { formatDateTime } from '../lib/formatDate'
import { outputAgeLabel, outputUpdatedMillis } from '../lib/outputFreshness'

/** How often the age re-renders. Coarse, matching `formatAge`'s own resolution (UpdateChip). */
const AGE_TICK_MS = 60_000

export interface OutputFileLineProps {
  /** the command as the player must type it, verbatim — e.g. `/outputfile inventory` */
  command: string
  /** ONE clause saying why it is worth typing. No caveats, no methodology. */
  why: string
  /**
   * The dump file's mtime, ISO. Absent means no file exists yet, and the line then says so in
   * words — "not yet run" — rather than claiming an age. "Never" is not a timestamp, and the
   * silence it replaced read as "no age worth mentioning" on a surface whose data does not exist
   * at all (JOS-44: the never-run state is a state, not an omission).
   */
  updatedAt?: string
  /**
   * How to type the command so it captures everything, one short imperative per step. The
   * registry owns them (`OutputKindDef.steps`); an empty list renders no toggle at all.
   */
  steps?: readonly string[]
  testId?: string
}

export default function OutputFileLine({
  command,
  why,
  updatedAt,
  steps = [],
  testId
}: OutputFileLineProps): JSX.Element {
  const [now, setNow] = useState(() => Date.now())
  const [showSteps, setShowSteps] = useState(false)
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), AGE_TICK_MS)
    return () => {
      clearInterval(t)
    }
  }, [])

  // THREE STATES, one slot on the right — never run / fresh / stale. The rule (and why "stale" is
  // not a separate rendering) lives with the words, in lib/outputFreshness.ts.
  const at = outputUpdatedMillis(updatedAt)
  const age = outputAgeLabel(at, now)
  return (
    <Paper variant="outlined" data-testid={testId} sx={{ px: 1.25, py: 0.75, mb: 1 }}>
      <Stack direction="row" spacing={1} alignItems="baseline" sx={{ flexWrap: 'nowrap', minWidth: 0 }}>
        <Typography
          variant="body2"
          sx={{ fontFamily: 'monospace', fontWeight: 700, flexShrink: 0 }}
          data-testid={testId === undefined ? undefined : `${testId}-command`}
        >
          {command}
        </Typography>
        <Typography variant="caption" color="text.secondary" noWrap sx={{ minWidth: 0, flexShrink: 1 }}>
          {why}
        </Typography>
        <Box sx={{ flexGrow: 1, minWidth: 8 }} />
        {/* The steps toggle sits BEFORE the age and never shrinks: it is a control, and the
            why-clause remains the one group allowed to give up room (the compact-bar contract). */}
        {steps.length > 0 && (
          <Button
            size="small"
            variant="text"
            onClick={() => setShowSteps((v) => !v)}
            data-testid={testId === undefined ? undefined : `${testId}-steps-toggle`}
            sx={{ flexShrink: 0, minWidth: 0, px: 0.75, py: 0 }}
          >
            {showSteps ? 'Hide steps' : 'How'}
          </Button>
        )}
        {/* The exact clock time is one hover away; the ambient text stays coarse (formatDate's
            own contract). This is the ONE place a tooltip is warranted here — it states the
            precise value of the number beside it, which is what makes the coarse one safe. */}
        <Typography
          variant="caption"
          color="text.disabled"
          title={at === undefined ? undefined : formatDateTime(at)}
          data-testid={testId === undefined ? undefined : `${testId}-age`}
          sx={{ flexShrink: 0 }}
        >
          {age}
        </Typography>
      </Stack>
      {/* Numbered because the ORDER is the content: opening the hoard after typing the command
          captures nothing, which is the whole failure this is here to prevent. */}
      <Collapse in={showSteps} unmountOnExit>
        <Box
          component="ol"
          data-testid={testId === undefined ? undefined : `${testId}-steps`}
          sx={{ m: 0, mt: 0.75, pl: 2.5 }}
        >
          {steps.map((s) => (
            <Typography key={s} component="li" variant="caption" color="text.secondary">
              {s}
            </Typography>
          ))}
        </Box>
      </Collapse>
    </Paper>
  )
}
