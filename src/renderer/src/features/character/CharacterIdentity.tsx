// character/CharacterIdentity — who this sheet is about.
//
// THREE FACTS, THREE SOURCES, AND EACH ONE IS ALLOWED TO BE ABSENT.
//   * NAME + SERVER — the `character` module, i.e. the log file being tailed. Always known
//     when there is a log at all.
//   * LEVEL — `currentLevel()` over the progression snapshot: the TAIL of the level series,
//     never max(). EQ Legends gives one level to a three-class loadout and swapping a class in
//     drops the level with no log line, so the latest value is the only honest answer (the rule
//     already written down in overviewLevelingData.ts). Null before the first ding this log has
//     seen — and then the chip is omitted rather than guessing one.
//   * CLASS TRIO — the `combo` module's current interval, drawn with the SAME chips the
//     Profiles panel and the Overview card use (`SlotChips`, `ProvenanceChip`), so the three
//     surfaces cannot drift into three dialects. An unresolved slot stays unresolved on screen.
//
// The dump itself carries none of this: it has no header, no preamble and no character
// metadata — the name and server appear only in its FILENAME (JOS-45 spike, confirmed against
// the client binary). So nothing here reads the sheet.

import type { JSX } from 'react'
import { Stack, Typography } from '@mui/material'
import type { CharacterDelta, CharacterSnap, ProgressionDelta, ProgressionSnap } from '@shared/types'
import { useModule } from '../../lib/useModule'
import { EMPTY_PROGRESSION, applyProgressionDelta } from '../leveling/progressionDelta'
import { currentLevel } from '../overview/overviewLevelingData'
import { ProvenanceChip, SlotChips } from '../profiles/ClassComboChips'
import { useComboSnap } from '../profiles/ClassComboData'

function applyCharacterDelta(state: CharacterSnap, delta: CharacterDelta): CharacterSnap {
  return { ...state, ...delta }
}

export default function CharacterIdentity(): JSX.Element {
  const who = useModule<CharacterSnap, CharacterDelta>('character', applyCharacterDelta)
  const prog = useModule<ProgressionSnap, ProgressionDelta>('progression', applyProgressionDelta)
  const combo = useComboSnap()

  const character = who?.character ?? null
  const level = currentLevel(prog ?? EMPTY_PROGRESSION)

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
      {level !== null && (
        <Typography variant="subtitle2" color="text.secondary">
          Level {level}
        </Typography>
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
