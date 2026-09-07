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
import { untilReset, hasCreditedAmbiguousKill, type LockoutWindow } from './lockout'
import { useLockoutWeek } from './useLockoutWeek'
import { useWeekClears, type WeekClearsApi } from './useWeekClears'
import { bossClearKey } from './weekClears'
import { defeatedThisWeek, everDefeated, filterRoster } from './rosterFilter'
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
            data-testid="boss-defeated-only"
            checked={filters.defeatedOnly}
            onChange={(e) => filters.onDefeatedOnlyChange(e.target.checked)}
          />
        }
        // THE LABEL FOLLOWS THE MODE (JOS-237). The switch filters on what "defeated" means in
        // the view you are standing in (rosterFilter.ts), so on the week view it must SAY so —
        // "Defeated only" beside a roster of this week's clears reads as the all-time filter it
        // used to be, which is the wrong answer written the wrong way round.
        label={mode === 'week' ? 'Defeated this week' : 'Defeated only'}
      />
      <FormControlLabel
        control={
          <Switch
            data-testid="boss-by-loadout"
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
 * The per-card manual base-rung bundle for the week view (section 2a). Module scope so BossView's
 * body stays inside its line budget; the component wraps it in `useMemo` for a stable identity.
 * `canMarkBase` gates on a credited open-world/unknown kill THIS week; `baseTs` / `onToggleBase`
 * are the live mark and its toggle, keyed by the roster's name identity.
 */
function weekManualClear(
  weekClears: WeekClearsApi,
  week: LockoutWindow
): {
  baseTs: (s: TargetStatus) => number | undefined
  canMarkBase: (s: TargetStatus) => boolean
  onToggleBase: (s: TargetStatus) => void
} {
  return {
    baseTs: (s) => weekClears.liveBaseTs(bossClearKey(s.target.name), week),
    canMarkBase: (s) => weekClears.canToggle && hasCreditedAmbiguousKill(s.tiers, week),
    onToggleBase: (s) => weekClears.toggle(bossClearKey(s.target.name), week)
  }
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

  // The week's clock, and it is the ONLY one on this view: the ladder, the chips, the tally and
  // — since JOS-237 — the "Defeated only" filter all read this same window. Idle on OVERALL.
  const { week, lockOf } = useLockoutWeek(mode === 'week')

  // The manual base-rung clear (section 2a): one per-card bundle for the week view. `useMemo` only
  // for a stable identity — the reads inside are cheap (per boss per render, fine at roster scale).
  const weekClears = useWeekClears()
  const manualClear = useMemo(() => (mode === 'week' ? weekManualClear(weekClears, week) : undefined), [mode, week, weekClears])

  /**
   * WHAT THE SWITCH FILTERS ON, and the whole of JOS-237 (rosterFilter.ts carries the argument).
   * The all-time flag is right for the OVERALL roster and wrong for the week view, which is about
   * this reset week and nothing else — so the predicate is the mode's, not the roster's.
   */
  const defeated = useMemo(() => (mode === 'week' ? defeatedThisWeek(week) : everDefeated), [mode, week])

  const filtered = useMemo(
    () => filterRoster(statuses, { query, defeatedOnly, defeated }),
    [statuses, query, defeatedOnly, defeated]
  )

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

  // The tally counts the WHOLE roster, never `filtered` — it is the denominator the filter is
  // measured against, so it must not move when a switch is flipped.
  const locked = statuses.filter((s) => lockOf(s).length > 0).length
  const everKilled = statuses.filter((s) => s.killed).length
  const tally =
    mode === 'week'
      ? `${locked} / ${statuses.length} locked this week · resets in ${untilReset(week)} · green rung = cleared`
      : `${everKilled} / ${statuses.length} defeated · badge = highest instance tier`
  const section = {
    compact,
    minCol: compact ? 116 : 180,
    flashing,
    onOpenMob,
    ...(mode === 'week' ? { lockOf, manualClear } : {})
  }

  // `data-week-clears-ready` (week view only): whether useWeekClears has learned the character. A
  // rung is markable only when it is `true`, so an e2e that finds no markable rung can tell
  // "nothing eligible this week" (fine) from "the store never bootstrapped" (Critical 1 regressed).
  const weekClearsReady = mode === 'week' ? String(weekClears.canToggle) : undefined
  return (
    <Stack data-testid="boss-view" data-week-clears-ready={weekClearsReady} spacing={1.5} sx={{ height: '100%', position: 'relative' }}>
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
          // THE SWITCH REACHES THE CARDS, NOT ONLY THE TARGETS (JOS-237). Sectioning by loadout
          // splits a target into one card per tier run, so filtering the roster alone would leave
          // a card describing kills that took no lockout this week sitting under "Defeated this
          // week" — grey, chipped `open`, and drawn only because ANOTHER of the target's runs was
          // cleared. The same predicate, applied at the same grain the cards are.
          <LoadoutSections
            {...section}
            list={filtered}
            keep={defeatedOnly ? defeated : undefined}
          />
        ) : (
          byCategory.map(([category, list]) => (
            <CategorySection key={category} {...section} category={category} list={list} />
          ))
        )}
      </Box>
    </Stack>
  )
}
