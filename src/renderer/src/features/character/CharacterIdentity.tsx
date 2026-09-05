// character/CharacterIdentity — who this sheet is about.
//
// THREE FACTS, THREE SOURCES, AND EACH ONE IS ALLOWED TO BE ABSENT.
//   * NAME + SERVER — the `character` module, i.e. the log file being tailed. Always known
//     when there is a log at all.
//   * LEVEL — the `character` module's STATED level fact (JOS-192): the later of your last ding
//     and your own `/who` row, read through `currentLevelRead` so the chip can also say which
//     one said it and how long ago. EQ Legends gives one level to a three-class loadout and
//     swapping a class in drops the level with NO log line, so the tail of the dings alone is
//     silent for exactly as long as it matters — and a `/who` on yourself is the one move that
//     fixes it. Null before anything has stated a level — and then the chip is omitted rather
//     than guessing one.
//   * CLASS TRIO — the `combo` module's current interval, drawn with the SAME chips the
//     Profiles panel and the Overview card use (`SlotChips`, `ProvenanceChip`), so the three
//     surfaces cannot drift into three dialects. An unresolved slot stays unresolved on screen.
//
// The dump itself carries none of this: it has no header, no preamble and no character
// metadata — the name and server appear only in its FILENAME (JOS-45 spike, confirmed against
// the client binary). So nothing here reads the sheet.

import type { JSX } from 'react'
import { Stack, Typography } from '@mui/material'
import type { CharacterSnap, ProgressionSnap } from '@shared/types'
import { currentLevelRead } from '@shared/currentLevel'
import { Tooltip } from '../../lib/Tooltip'
import { useModule } from '../../lib/useModule'
import { EMPTY_PROGRESSION } from '../leveling/progressionDelta'
import { ProvenanceChip, SlotChips } from '../profiles/ClassComboChips'
import { useComboSnap } from '../profiles/ClassComboData'


export default function CharacterIdentity(): JSX.Element {
  const who = useModule<CharacterSnap>('character')
  const prog = useModule<ProgressionSnap>('progression')
  const combo = useComboSnap()

  const character = who?.character ?? null
  // The progression snapshot supplies the LOG CLOCK the statement's age is measured against (and
  // the ding-tail fallback for the frame before the character module hydrates) — never the wall
  // clock, which would call a freshly-loaded log three weeks stale.
  const level = currentLevelRead(who?.level, prog ?? EMPTY_PROGRESSION)

  return (
    <Stack
      direction="row"
      spacing={1.25}
      alignItems="baseline"
      flexWrap="wrap"
      useFlexGap
      sx={{ minWidth: 0 }}
      data-testid="character-identity"
    >
      <Typography variant="h6" sx={{ lineHeight: 1.2 }}>
        {character?.name ?? 'No character'}
      </Typography>
      {character && (
        <Typography variant="caption" color="text.disabled">
          {character.server}
        </Typography>
      )}
      {level && (
        <Tooltip title={level.title}>
          <Typography variant="subtitle2" color="text.secondary" data-testid="character-level">
            Level {level.level}
            {level.cue && (
              <Typography component="span" variant="caption" color="text.disabled" sx={{ ml: 0.5 }}>
                {level.cue}
              </Typography>
            )}
          </Typography>
        </Tooltip>
      )}
      {combo.current ? (
        <Stack direction="row" spacing={0.5} alignItems="center" flexWrap="wrap" useFlexGap>
          <SlotChips slots={combo.current.slots} />
          <ProvenanceChip interval={combo.current} />
        </Stack>
      ) : (
        <Typography variant="caption" color="text.disabled">
          No loadout read yet - one appears as soon as the log names classes you played.
        </Typography>
      )}
    </Stack>
  )
}
