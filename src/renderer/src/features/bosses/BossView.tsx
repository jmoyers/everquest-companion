// BossView — the raid-progression roster: search, filters, and the sectioning toggle. The cards
// and the two section kinds live in BossSections.tsx; this file owns the state above them.
//
// The "Recently considered" strip that used to live here MOVED to the Mobs tab in Task #64.
// It lodged here because this tab already answered the other mob question ("which named things
// have I killed") and a con strip needed a roof; Mobs is its actual module home. This tab is
// about RAID PROGRESSION again — and its cards now route to the same mob page everything else
// does, instead of opening a modal only this tab knew how to open.

import { type JSX, useCallback, useMemo, useState } from 'react'
import {
  Box,
  FormControlLabel,
  Stack,
  Switch,
  TextField,
  ToggleButton,
  ToggleButtonGroup,
  Typography
} from '@mui/material'
import { getBossData } from '../../data'
import { useBossKills } from './useBossKills'
import type { BossKill, TargetStatus } from './bossStatus'
import { CategorySection, LoadoutSections } from './BossSections'
import { untilReset } from './lockout'
import { useLockoutWeek } from './useLockoutWeek'
import type { MobTarget } from '../mobs/mobTarget'
import Confetti from '../../lib/Confetti'

// EQL raid progression order.
const CATEGORY_ORDER = ['Open World', 'Plane of Fear', 'Plane of Hate', 'Plane of Sky']

const DENSITY_KEY = 'eq.bossDensity'
type Density = 'compact' | 'comfortable'

/**
 * The two readings of the same roster (JOS-74). OVERALL is the default: it is the view this tab
 * has always been, everything you have ever killed. THIS WEEK is the loot-lockout view: of those
 * kills, the ones inside the current lockout window (lockout.ts).
 *
 * IT IS PERSISTED NOW (JOS-152), and JOS-74 said the opposite in this very comment: "deliberately
 * NOT persisted - the roster's job is progression, so a new session opens on progression." That
 * was a guess about who the tab is for, and a reporter (01KZM0T1YNREY466752BQZVFBR) corrected it:
 * a raid coordinator opens this tab to run a week, so the week view IS their progression and the
 * app threw it away on every trip to another tab. Owner disposition 2026-08-09: remember the
 * selected tab. The mechanism is JOS-90's, for JOS-90's reason - `App`'s `ViewContent` mounts
 * exactly one feature view at a time, so plain `useState` here does not survive leaving the tab,
 * let alone a restart, and a stored key is one promise for both.
 */
type Mode = 'overall' | 'week'

const MODE_KEY = 'eq.bosses.mode'

/**
 * The stored mode. An absent key is the DEFAULT (overall), never a claim the user chose it, and
 * anything that is not one of the two words reads as the default too - a hand-edited or
 * future-written value degrades to the view this tab has always opened on rather than to a blank
 * screen. Same shape as `useStoredSort` on the Sky tab.
 */
function loadMode(): Mode {
  const v = localStorage.getItem(MODE_KEY)
  return v === 'week' || v === 'overall' ? v : 'overall'
}

const bosses = getBossData()

// Mode / search / defeated-only / grouping / density, plus the running tally on the right.
function BossToolbar({
  mode,
  onModeChange,
  query,
  onQueryChange,
  filters,
  density,
  onDensityChange,
  tally
}: {
  mode: Mode
  onModeChange: (m: Mode | null) => void
  query: string
  onQueryChange: (q: string) => void
  /** The two switches, bundled so the toolbar keeps a readable parameter list. */
  filters: {
    defeatedOnly: boolean
    onDefeatedOnlyChange: (v: boolean) => void
    byLoadout: boolean
    onByLoadoutChange: (v: boolean) => void
  }
  density: Density
  onDensityChange: (d: Density | null) => void
  tally: string
}): JSX.Element {
  return (
    <Stack direction="row" spacing={2} alignItems="center" flexWrap="wrap" useFlexGap>
      <ToggleButtonGroup
        data-testid="boss-mode"
        size="small"
        exclusive
        value={mode}
        onChange={(_e, v: Mode | null) => onModeChange(v)}
      >
        <ToggleButton data-testid="boss-mode-overall" value="overall">
          Overall
        </ToggleButton>
        <ToggleButton data-testid="boss-mode-week" value="week">
          This week
        </ToggleButton>
      </ToggleButtonGroup>
      <TextField
        size="small"
        label="Search target"
        value={query}
        onChange={(e) => onQueryChange(e.target.value)}
        sx={{ minWidth: 200 }}
      />
      <FormControlLabel
        control={
          <Switch
            checked={filters.defeatedOnly}
            onChange={(e) => filters.onDefeatedOnlyChange(e.target.checked)}
          />
        }
        label="Defeated only"
      />
      <FormControlLabel
        control={
          <Switch
            checked={filters.byLoadout}
            onChange={(e) => filters.onByLoadoutChange(e.target.checked)}
          />
        }
        label="By class loadout"
      />
      <ToggleButtonGroup
        size="small"
        exclusive
        value={density}
        onChange={(_e, v: Density | null) => onDensityChange(v)}
      >
        <ToggleButton value="compact">Compact</ToggleButton>
        <ToggleButton value="comfortable">Comfortable</ToggleButton>
      </ToggleButtonGroup>
      <Box sx={{ flexGrow: 1 }} />
      <Typography data-testid="boss-tally" variant="body2" color="text.secondary">
        {tally}
      </Typography>
    </Stack>
  )
}

/**
 * @param onOpenMob  route a roster card to the app-wide mob page (the Mobs tab). This view no
 *                   longer owns a detail surface of its own — one mob, one page, everywhere.
 */
export default function BossView({ onOpenMob }: { onOpenMob: (t: MobTarget) => void }): JSX.Element {
  const [mode, setMode] = useState<Mode>(loadMode)
  const [query, setQuery] = useState('')
  const [defeatedOnly, setDefeatedOnly] = useState(false)
  // Sectioning: progression category (the default — it is what the roster is for) or the class
  // loadout you were running. A DISPLAY choice; nothing about the kills themselves changes.
  const [byLoadout, setByLoadout] = useState(false)
  const [density, setDensity] = useState<Density>(
    () => (localStorage.getItem(DENSITY_KEY) as Density) || 'compact'
  )
  // Names of bosses currently flashing, and the id of the active confetti burst.
  const [flashing, setFlashing] = useState<Set<string>>(new Set())
  const [burst, setBurst] = useState<number | null>(null)

  // Any live roster-boss kill CREDITED to you (incl. a repeat at the same/lower tier,
  // Task #24): fire confetti over the view and flash the boss card for ~3s. The kills
  // module (via useBossKills) already gates out the historical baseline, so this only
  // fires for kills that happen while the app is open — and only for kills the log paid
  // you for, so a stranger's open-world kill still fills in the card without a party.
  // The bossDefeat *sound* rides
  // the same predicate from App's always-mounted detector, so the two agree on every
  // kill and the alert's cooldown stops the pair double-playing.
  // The payload carries the kill's own tier (JOS-165); this surface wants only WHICH target,
  // because the card it flashes goes on saying the highest-ever tier a card is right to say.
  const onKill = useCallback(({ status }: BossKill) => {
    setBurst((n) => (n ?? 0) + 1)
    setFlashing((prev) => new Set(prev).add(status.target.name))
    window.setTimeout(() => {
      setFlashing((prev) => {
        const next = new Set(prev)
        next.delete(status.target.name)
        return next
      })
    }, 3000)
  }, [])

  const { statuses } = useBossKills(bosses.targets, { onKill })

  const setDensityPersist = (d: Density | null): void => {
    if (!d) return
    localStorage.setItem(DENSITY_KEY, d)
    setDensity(d)
  }
  const compact = density === 'compact'

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    let list = statuses
    if (defeatedOnly) list = list.filter((s) => s.killed)
    if (q) list = list.filter((s) => s.target.name.toLowerCase().includes(q))
    return list
  }, [statuses, query, defeatedOnly])

  const byCategory = useMemo(() => {
    const map = new Map<string, TargetStatus[]>()
    for (const s of filtered) {
      const arr = map.get(s.target.category) ?? []
      arr.push(s)
      map.set(s.target.category, arr)
    }
    return [...map.entries()].sort(
      (a, b) => (CATEGORY_ORDER.indexOf(a[0]) + 1 || 99) - (CATEGORY_ORDER.indexOf(b[0]) + 1 || 99)
    )
  }, [filtered])

  const { week, lockOf } = useLockoutWeek(mode === 'week')
  const locked = statuses.filter((s) => lockOf(s).length > 0).length
  const defeated = statuses.filter((s) => s.killed).length
  const tally =
    mode === 'week'
      ? `${locked} / ${statuses.length} locked this week · resets in ${untilReset(week)} · green rung = cleared`
      : `${defeated} / ${statuses.length} defeated · badge = highest instance tier`
  const section = {
    compact,
    minCol: compact ? 116 : 180,
    flashing,
    onOpenMob,
    ...(mode === 'week' ? { lockOf } : {})
  }

  return (
    <Stack spacing={1.5} sx={{ height: '100%', position: 'relative' }}>
      {burst != null && <Confetti key={burst} onDone={() => setBurst(null)} />}
      <BossToolbar
        mode={mode}
        onModeChange={(m) => {
          // A null `m` is MUI re-clicking the active button in an exclusive group: it is not a
          // choice, so it neither changes the view nor rewrites the stored one.
          if (!m) return
          localStorage.setItem(MODE_KEY, m)
          setMode(m)
        }}
        query={query}
        onQueryChange={setQuery}
        filters={{
          defeatedOnly,
          onDefeatedOnlyChange: setDefeatedOnly,
          byLoadout,
          onByLoadoutChange: setByLoadout
        }}
        density={density}
        onDensityChange={setDensityPersist}
        tally={tally}
      />

      <Box sx={{ flexGrow: 1, overflow: 'auto' }}>
        {byLoadout ? (
          <LoadoutSections {...section} list={filtered} />
        ) : (
          byCategory.map(([category, list]) => (
            <CategorySection key={category} {...section} category={category} list={list} />
          ))
        )}
      </Box>
    </Stack>
  )
}
