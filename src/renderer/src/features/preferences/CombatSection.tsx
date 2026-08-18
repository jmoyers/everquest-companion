// THE COMBAT SECTION of Preferences — the meters' two shaping choices, and the section descriptor
// that names them.
//
// Its DESCRIPTOR lives here rather than in PreferencesView.tsx for the reason PerfSetting's and
// GraphicsSetting's do: that file sits at the 400-code-line factoring ceiling and `buildSections`
// at the 100-line one, and the honest home for a section's label, icon and search keywords is
// beside the cards it names. JOS-115 gave the section a second card and that was the line.
//
// THE TWO METER CARDS are RENDERER-LOCAL preferences (localStorage,
// features/combat/useCombatPrefs.ts) — no store migration, and they apply LIVE across windows:
// same-window readers are notified directly, and the floating overlays are same-origin, so the
// DOM's own 'storage' event carries the change to them with no IPC channel involved.
//
// THE THIRD CARD is not one of those, and the difference is worth a line: what teaches the resist
// numbers (JOS-385) is a MAIN-side store value, because the thing that reads it is the estimator in
// main, and because it is the kind of preference that has to survive a reinstall of the renderer's
// localStorage. It joins the section on subject rather than on mechanism — all three cards answer
// "what does this app count".

import { type JSX } from 'react'
import { FormControlLabel, Stack, Switch, Typography } from '@mui/material'
import BarChartIcon from '@mui/icons-material/BarChart'
import { useCombinePetRow } from '../combat/useCombatPrefs'
import { MeterScopeSetting } from './MeterScopeSetting'
import { ResistEvidenceSetting } from './ResistEvidenceSetting'
import type { PrefSection } from './PreferencesView'

/**
 * Pet nesting (owner direction, 2026-08-03). ON by default: the game is mostly played solo, so
 * "you and your pet" is the shape of nearly every fight, and a two-row source meter is a lid on
 * the only list worth reading. Combined, the pet is ONE line item inside your breakdown —
 * labelled with its real name, drillable into its own skills, and never summed into a skill row
 * of yours (features/combat/petRows.ts). Off, it is a separate source row, as it always was.
 *
 * IT IS THE PET'S LAYOUT, NOT A ZOOM (owner ruling, 2026-08-05 — JOS-35). Every meter opens on
 * level 1 whatever this says; what it decides is WHERE the pet's damage lives. On ⇒ inside your
 * level-1 bar, and once more as a drillable line item in your breakdown — never a source row of
 * its own, so a fight's damage is never listed twice. Off ⇒ the pet keeps its own bar and
 * nothing is nested.
 *
 * ONE SWITCH, EVERY DAMAGE METER (owner ruling, 2026-08-04 — the floating overlay used to render
 * the engine's own pet fold instead, and showed a different breakdown for the same fight). The
 * Combat tab, the Overview card and the floating overlay meters all read THIS value and build
 * their rows with `petRows.meterPanel`.
 */
function PetNestingSetting(): JSX.Element {
  const [combine, setCombine] = useCombinePetRow()
  return (
    <Stack spacing={1}>
      <FormControlLabel
        control={
          <Switch
            size="small"
            checked={combine}
            data-testid="pref-combine-pet"
            onChange={(e) => setCombine(e.target.checked)}
          />
        }
        label={<Typography variant="body2">Show your pet inside your damage</Typography>}
      />
      <Typography variant="caption" color="text.secondary">
        {combine
          ? 'Your pet’s damage rides inside your bar, and appears once more as one row inside your breakdown - click it for the pet’s own skills. Your per-skill numbers stay yours; the pet’s damage is never folded into them.'
          : 'Your pet gets its own bar beside yours, and each bar drills into its own skills.'}
      </Typography>
    </Stack>
  )
}

/** Scope first, then layout: whose damage the meters show, and where the pet's sits inside it. */
export function combatSection(): PrefSection {
  return {
    id: 'combat',
    label: 'Combat',
    icon: <BarChartIcon fontSize="small" />,
    items: [
      {
        id: 'meter-scope',
        label: 'Whose damage the meters show',
        keywords:
          'scope whose damage you group everyone party raid roster member members source cohort filter meter meters overlay combat dps show hide',
        content: <MeterScopeSetting />
      },
      {
        id: 'combine-pet',
        label: 'Show your pet inside your damage',
        keywords: 'pet combine merge damage breakdown solo meter drill charm nest source zoom default level',
        content: <PetNestingSetting />
      },
      {
        id: 'resist-evidence',
        label: 'What teaches the resist numbers',
        // Written for the person who saw a mob's resist number move and came looking for why, so
        // the words they would use about the FEATURE (resists, mob page, con card) are here beside
        // the words for the thing the switch is about (pets, charm, NPC casters).
        keywords:
          'resist resists resistance evidence npc mob creature pet pets charm charmed caster casters learn mine mined data mob page con card magic fire cold poison disease sample samples',
        content: <ResistEvidenceSetting />
      }
    ]
  }
}
