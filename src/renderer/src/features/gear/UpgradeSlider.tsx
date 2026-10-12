// gear/UpgradeSlider.tsx — THE GLOBAL PLUS-STATE SELECTOR: every number in the table, at +N.
//
// AND THE ITEM CARD'S (fork, kaltinril 2026-09-13): the Loot drill-down mounts this same control
// under a wearable item's window (ItemDetailDialog.tsx), where its state is local to the item
// rather than remembered. `testId` and `wrap` are the whole difference between the two mounts.
//
// WHAT IT IS. `ItemUpgradeState` is the in-game item window's `Tier N   x / y` row (phase 0,
// src/shared/itemUpgrade.ts): `full` is the tier 0..10 and `fraction` is the merge exp banked
// toward the next one, out of `2^full`. So the control is TWO sliders and not one — a single
// slider over the 1,024 reachable states would put nine of its eleven tiers in the last third of
// its travel, because the states are not evenly distributed. The tier slider is the one anybody
// drags; the fraction slider appears only where a fraction exists (tier 0 has no denominator and
// tier 10 is the cap, so neither can bank partial exp — `normalizeUpgradeState` states that rule
// and this control obeys it rather than restating it).
//
// WHY A LIVE SLIDER IS ALLOWED HERE. Scaling all 6,766 rows at one state is measured at ~18 ms
// (tests/gearIndex.test.mts prints it on every run), which is inside a frame — that measurement is
// the whole reason the ticket could ask for a live selector instead of an Apply button. The table
// still reads the state through `useDeferredValue` (GearView), so the THUMB is never waiting on a
// re-sort of six thousand rows: the control echoes instantly and the numbers follow, which is the
// same law the search box has obeyed since the beginning.
//
// AND IT SAYS WHAT IT IS SIMULATING. The percent label is `percentLabel` — phase 0's own spelling
// of the number the wiki's item slider displays (`+27.5%`) — beside the raw `Tier 2 · 3/4`, so the
// row can be read against the item window in the game without translating anything.

import type { JSX } from 'react'
import { Box, Slider, Stack, Typography } from '@mui/material'
import { ITEM_MAX_TIER } from '@shared/itemStats'
import { ITEM_UPGRADE_BASE, percentLabel, type ItemUpgradeState } from '@shared/itemUpgrade'

/** The tier ticks — every whole level, which is what a player merges toward. */
const TIER_MARKS = Array.from({ length: ITEM_MAX_TIER + 1 }, (_, i) => ({ value: i }))

/** `2^full` — the denominator the game prints, and the fraction slider's ceiling. */
function fractionMax(full: number): number {
  return full <= 0 || full >= ITEM_MAX_TIER ? 0 : 2 ** full - 1
}

export interface UpgradeSliderProps {
  state: ItemUpgradeState
  onChange: (next: ItemUpgradeState) => void
  /** testid prefix: `gear` on the Gear toolbar (the e2e's spelling), `item` on the item card */
  testId?: string
  /** let the label and the fraction slider fall to a second line — a 340px card, not a toolbar */
  wrap?: boolean
}

export default function UpgradeSlider({ state, onChange, testId = 'gear', wrap = false }: UpgradeSliderProps): JSX.Element {
  const max = fractionMax(state.full)
  const base = state.full === ITEM_UPGRADE_BASE.full && state.fraction === ITEM_UPGRADE_BASE.fraction
  return (
    <Stack
      direction="row"
      spacing={1.5}
      alignItems="center"
      useFlexGap={wrap}
      sx={{ flexWrap: wrap ? 'wrap' : 'nowrap', minWidth: 0 }}
      data-testid={`${testId}-upgrade`}
    >
      <Typography variant="caption" color="text.secondary" sx={{ flexShrink: 0 }}>
        Simulate upgrade
      </Typography>

      <Box sx={{ width: 180, flexShrink: 0, px: 1 }}>
        <Slider
          size="small"
          min={0}
          max={ITEM_MAX_TIER}
          step={1}
          marks={TIER_MARKS}
          value={state.full}
          data-testid={`${testId}-tier-slider`}
          aria-label="Simulated upgrade tier"
          // The fraction is re-clamped by the TIER move, not left to drift: dropping from tier 5 to
          // tier 1 with 17 banked would state a fraction its own denominator (2) cannot hold.
          onChange={(_e, v) => {
            const full = typeof v === 'number' ? v : v[0]
            onChange({ full, fraction: Math.min(state.fraction, fractionMax(full)) })
          }}
        />
      </Box>

      <Typography
        variant="caption"
        data-testid={`${testId}-upgrade-label`}
        color={base ? 'text.secondary' : 'primary.main'}
        sx={{ flexShrink: 0, fontVariantNumeric: 'tabular-nums', minWidth: 132 }}
        title="What the table is showing: every stat scaled to this upgrade state, the way the item window reads it."
      >
        Tier {state.full}
        {max > 0 && ` · ${String(state.fraction)}/${String(max + 1)}`} · {percentLabel(state)}
      </Typography>

      {/* Only where a fraction can exist. An empty slot is not a disabled control: tier 0 and tier
          10 bank nothing at all, so there is no value to disable. */}
      {max > 0 && (
        <Box sx={{ width: 110, flexShrink: 0, px: 1 }}>
          <Slider
            size="small"
            min={0}
            max={max}
            step={1}
            value={state.fraction}
            data-testid={`${testId}-fraction-slider`}
            aria-label="Merge exp banked toward the next tier"
            onChange={(_e, v) => {
              onChange({ full: state.full, fraction: typeof v === 'number' ? v : v[0] })
            }}
          />
        </Box>
      )}
    </Stack>
  )
}
