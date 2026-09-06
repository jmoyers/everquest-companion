// BossSections — the roster's CARDS and the two ways of sectioning them. Split out of BossView
// so that view is the toolbar + the filtering it owns, and so a second grouping could be added
// without the file growing past the factoring ceiling.
//
// TWO GROUPINGS, ONE GRID. `CategorySection` is EQ raid progression order (Open World → Fear →
// Hate → Sky) and stays the default: it is what the roster is FOR. `LoadoutSections` answers the
// other question this app can now ask — "which classes was I running when I killed these?" — by
// TIME-JOINING each kill run against the class-combo intervals (loadoutGroups.ts, which owns
// the pure half of that join, over shared/comboIndex).
//
// THE JOIN IS A DISPLAY GROUPING AND NOTHING ELSE. bossStatus.ts stays combo-unaware, no kill
// record is stamped with an interval id (ids are recompute-unstable by design — see
// shared/comboIndex.ts), and no signal changes: the same kills, the same confetti, the same
// bossDefeat sound. Only the headers above them are new.
//
// ONE ROW PER TIER-RUN, not per target (2026-08-04). The rule used to be "a target killed
// repeatedly lands under the loadout of its MOST RECENT kill" — the only rule the old
// five-scalar kill record could state, since it carried a `bestTier` and a `lastTs` that could
// come from different kills. It filed Lord of Ire's d4 badge (Aug 01, PAL/MNK/ENC) under the
// ROG/PAL/BER interval covering its Aug 03 d0 kill. The record is now per instance tier
// (shared/kills.ts), so a multi-tier target splits into one card per tier: each joins the
// combo interval at ITS OWN most recent kill and wears ITS OWN tier badge, and the header's
// claim is true of every card under it. Single-tier targets — nearly all of them — project to
// exactly the card they rendered before.
//
// ONE SECTION PER LOADOUT (JOS-236, 2026-08-12). A section is a claim about CLASSES, not about a
// span of the timeline, so every interval stating the same trio draws ONE header here — the
// owner's board was showing PAL / MNK / ENC twice because he had swapped away and back. The rule
// and everything it decides (which member's chips, whose provenance, how the union span is
// worded, what the badge means) lives in loadoutGroups.ts's header; this file only draws it:
// `spansText` over the section's members instead of `spanText` over one, and a tooltip that
// spells the stretches out when there is more than one.
//
// AND A HEADER MAY DECLINE TO NAME A LOADOUT (JOS-239, 2026-08-12). The owner's roster showed Lord
// Nagafen defeated at D4 under `ENC / WIZ / MNK`; the wizard was level 25 and had never entered the
// zone. `loadoutGroups` now routes intervals that fail the confidence gate into ONE unresolved
// section, and this file draws it as `Mixed loadouts` + the spans — deliberately the same shape as
// the `Loadout not known` header, because it is the same kind of sentence (a fact about our
// knowledge, not about the classes) and the surface should not grow a third dialect for it.

import { type JSX, useMemo, useState } from 'react'
import { Box, Chip, Paper, Stack, Typography } from '@mui/material'
import { HideTargetButton, TargetKilledBadge } from './cardCorners'
import type { RaidTarget } from '@shared/types'
import type { TargetStatus } from './bossStatus'
import { tierLadder, type LadderRung, type TierLock } from './lockout'
import DifficultyLadder from './DifficultyLadder'
import { loadoutGroups, type LoadoutCard, type LoadoutGrouping } from './loadoutGroups'
import type { MobTarget } from '../mobs/mobTarget'
import { tierStyle, type TierStyle } from '../../lib/tierChip'
import { formatDate, formatDateTime } from '../../lib/formatDate'
import { cachedImageUrl } from '../../lib/imageUrl'
import { useComboIntervals } from '../profiles/ClassComboData'
import { ProvenanceChip, SlotChips } from '../profiles/ClassComboChips'
import { spanText, spansText } from '../profiles/ClassComboLabels'
import { Tooltip } from '../../lib/Tooltip'

function BossImage({
  target,
  height,
  dim
}: {
  target: RaidTarget
  height: number
  dim?: boolean
}): JSX.Element {
  const [failed, setFailed] = useState(false)
  if (target.image && !failed) {
    return (
      <Box
        component="img"
        // NEVER the raw `target.image`. `bosses.json` carries real wiki.project1999.com URLs
        // (scraped data stays honest), but a portrait must be downloaded at most ONCE ever —
        // so it is served from the app's permanent cache instead. A URL the main process
        // refuses, or a portrait that 404s, falls through to the initials tile below via
        // onError, exactly as before.
        src={cachedImageUrl(target.image)}
        alt={target.name}
        onError={() => setFailed(true)}
        sx={{
          width: '100%',
          height,
          objectFit: 'cover',
          objectPosition: 'top',
          display: 'block',
          filter: dim ? 'grayscale(1) brightness(0.5)' : 'none'
        }}
      />
    )
  }
  const initials = target.name
    .replace(/[^A-Za-z ]/g, '')
    .split(' ')
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0])
    .join('')
  return (
    <Box
      sx={{
        width: '100%',
        height,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        bgcolor: 'action.hover',
        color: 'text.disabled',
        fontSize: height > 90 ? 26 : 18,
        fontWeight: 700
      }}
    >
      {initials}
    </Box>
  )
}

// The little tier-coloured tick in the card's top-left corner: "you have this one".

/**
 * What the corner chip says, and whether the card reads as "you have this one".
 *
 * TWO READINGS, ONE CARD (JOS-74). Without a `lock` this is the OVERALL roster, unchanged since
 * before the week view existed: the chip is the highest tier you have ever killed the target at,
 * and an undefeated target greys out under a neutral "not defeated" scrim. WITH a `lock` — the
 * THIS WEEK view — the same slot reports the difficulties you are on lockout at, so the card
 * lights up for what you have already taken this week and greys out for what is still open.
 * An empty `lock` array is "open", which is not the same statement as "never killed".
 */
function chipFacts(
  s: TargetStatus,
  tier: TierStyle,
  lock?: TierLock[]
): { on: boolean; label: string; style: TierStyle } {
  if (!lock) {
    return {
      on: s.killed,
      label: s.killed ? tier.label : 'not defeated',
      style: tier
    }
  }
  const top = lock[lock.length - 1]
  if (!top) return { on: false, label: 'open', style: tier }
  const style = tierStyle(top.tier)
  // The chip states the highest tier and nothing else (owner ruling 2026-08-09) — the
  // difficulty ladder on the weekly card already carries the full per-tier picture.
  return { on: true, label: style.label, style }
}

type ChipFacts = ReturnType<typeof chipFacts>

// Portrait + the tier chip that overlays its top-right corner. An undefeated target is
// greyed out and its chip reads "not defeated" on a neutral scrim instead of a tier colour.
function TargetCardMedia({
  s,
  chip,
  height
}: {
  s: TargetStatus
  chip: ChipFacts
  height: number
}): JSX.Element {
  return (
    <Box sx={{ position: 'relative' }}>
      <BossImage target={s.target} height={height} dim={!chip.on} />
      <Chip
        size="small"
        label={chip.label}
        sx={{
          position: 'absolute',
          top: 4,
          right: 4,
          height: 20,
          bgcolor: chip.on ? chip.style.bg : 'rgba(0,0,0,0.65)',
          color: chip.on ? chip.style.fg : '#fff',
          fontWeight: 700,
          fontSize: 11,
          '& .MuiChip-label': { px: 0.75 }
        }}
      />
    </Box>
  )
}

// The date line under a DEFEATED target's name. A single kill states one date; repeats
// spell out first and last in the tooltip. The comfortable density also shows the count.
function TargetKillDate({ s, compact }: { s: TargetStatus; compact: boolean }): JSX.Element {
  return (
    <Tooltip
      title={
        s.firstTs && s.firstTs !== s.lastTs
          ? `First ${formatDateTime(s.firstTs)} · Last ${formatDateTime(s.lastTs)}`
          : `Defeated ${formatDateTime(s.lastTs || s.firstTs)}`
      }
    >
      <Typography variant="caption" color="text.secondary" noWrap display="block">
        {formatDate(s.lastTs || s.firstTs)}
        {!compact && ` · ${s.count} kill${s.count === 1 ? '' : 's'}`}
      </Typography>
    </Tooltip>
  )
}

// Everything below the portrait: name, zone (comfortable only) and — depending on the view — the
// difficulty ladder or the kill/no-kill line.
//
// THE WEEK CARD ENDS IN THE LADDER (JOS-171, owner ruling 2026-08-09). It used to end in a
// `LockLine` under the rungs: `Locked · Sat 8/8` when any difficulty was taken, `open` when none
// was, with a tooltip spelling out each lock. Every word of that is now either drawn by the rungs
// themselves or one hover away (`rungTitle` — lockout.ts), so the line was the card saying the
// same thing twice in less detail: it could name only the HIGHEST lock, while five chips name all
// five. The same ruling that stripped the tier chip back to its label (JOS-169) applies here — the
// ladder tells the whole per-tier story, so nothing is written underneath it.
//
// The OVERALL view is untouched: it has no ladder, so its date line is the only thing that ever
// stated when the kill landed and it stays exactly as it was.
function TargetCardCaption({
  s,
  compact,
  ladder
}: {
  s: TargetStatus
  compact: boolean
  ladder?: LadderRung[]
}): JSX.Element {
  return (
    <Box sx={{ p: compact ? 0.75 : 1 }}>
      <Typography
        variant={compact ? 'caption' : 'body2'}
        noWrap
        title={s.target.name}
        sx={{ fontWeight: 600, color: s.killed ? 'text.primary' : 'text.secondary' }}
      >
        {s.target.name}
      </Typography>
      {!compact && (
        <Typography variant="caption" color="text.secondary" noWrap display="block">
          {s.target.zone ?? ''}
        </Typography>
      )}
      {/* The five difficulties, every week, whether or not any of them is taken (JOS-152) — and
          since JOS-171 the last thing on the card. Its presence IS the view: a ladder is derived
          exactly when the week's lock function is (see `Section`), so it is the discriminator the
          removed `lock` prop used to be. */}
      {ladder ? (
        <DifficultyLadder rungs={ladder} compact={compact} />
      ) : s.killed ? (
        <TargetKillDate s={s} compact={compact} />
      ) : (
        !compact && (
          <Typography variant="caption" color="text.disabled" display="block">
            not defeated
          </Typography>
        )
      )}
    </Box>
  )
}

/**
 * What a roster card hands the app-wide mob page. A roster card carries no consider (you may
 * never have conned it), so the page simply renders without the con block — never with an
 * invented one. The kill facts come from the status the roster already computed, which is
 * article-insensitive matching the log's `match` names (bossStatus.ts).
 */
function mobTargetForStatus(t: TargetStatus): MobTarget {
  return {
    mob: t.target.name,
    kill:
      t.count > 0
        ? { count: t.count, bestTier: t.bestTier, firstTs: t.firstTs, lastTs: t.lastTs }
        : undefined
  }
}

function TargetCard({
  s,
  compact,
  flash,
  lock,
  ladder,
  onOpen,
  hidden = false,
  onToggleHidden
}: {
  s: TargetStatus
  compact: boolean
  flash?: boolean
  /** present ⇒ THIS WEEK view; the difficulties this card is locked at (empty = open). */
  lock?: TierLock[]
  /**
   * The five-rung difficulty ladder (JOS-152), derived from the WHOLE target rather than from
   * this card's slice — see `Section`, which is where the two inputs part company.
   */
  ladder?: LadderRung[]
  onOpen: () => void
  /** This target is hidden (issue #32) — the card only renders under the toolbar's peek, DIMMED,
   *  so a peeked roster reads as two populations rather than quietly merging them back. */
  hidden?: boolean
  onToggleHidden?: () => void
}): JSX.Element {
  const imgH = compact ? 70 : 120
  const chip = chipFacts(s, tierStyle(s.bestTier), lock)
  const tier = chip.style
  const tierColor = tier.bg
  return (
    <Paper
      data-testid="boss-card"
      variant="outlined"
      // A raid target IS a mob, so it opens the same mob PAGE everything else does (Task #64).
      onClick={onOpen}
      title={`${s.target.name} - drops, quests, your kills`}
      sx={{
        overflow: 'hidden',
        position: 'relative',
        cursor: 'pointer',
        borderWidth: 2,
        borderColor: flash ? tierColor : chip.on ? tierColor : 'divider',
        boxShadow: flash
          ? `0 0 22px ${tierColor}, 0 0 8px ${tierColor}`
          : chip.on
            ? `0 0 10px ${tierColor}55`
            : 'none',
        transform: flash ? 'scale(1.04)' : 'none',
        transition: 'transform 200ms, box-shadow 200ms, border-color 200ms',
        '&:hover': { transform: flash ? 'scale(1.04)' : 'translateY(-2px)' },
        opacity: hidden ? 0.45 : 1
      }}
    >
      {chip.on && <TargetKilledBadge tier={tier} />}
      {onToggleHidden && <HideTargetButton name={s.target.name} hidden={hidden} onToggle={onToggleHidden} />}
      <TargetCardMedia s={s} chip={chip} height={imgH} />
      <TargetCardCaption s={s} compact={compact} ladder={ladder} />
    </Paper>
  )
}

/** The grid's presentation knobs — everything a section needs except its rows. */
interface GridProps {
  compact: boolean
  minCol: number
  flashing: Set<string>
  onOpenMob: (t: MobTarget) => void
  /**
   * THE VIEW MODE, and the only thing that distinguishes the two (JOS-74). Absent ⇒ OVERALL, the
   * roster exactly as it has always rendered. Present ⇒ THIS WEEK: it answers, per card, which
   * difficulties that card's kills have you on loot lockout at. It takes the CARD's status, so a
   * loadout section's per-tier cards each report their own tier and never the target's whole
   * record.
   */
  lockOf?: (s: TargetStatus) => TierLock[]
  /** Is this target hidden (issue #32)? A hidden card renders only under the toolbar's peek. */
  hiddenOf?: (name: string) => boolean
  /** The card's own hide/unhide control writes through this — the one writer of the set. */
  onToggleHidden?: (name: string) => void
}

/** Everything a section needs to draw its grid — identical for both groupings. */
export interface SectionProps extends GridProps {
  list: TargetStatus[]
}

/**
 * One card. `s` is what the card DRAWS (for a loadout section, the target seen through one
 * tier run); `whole` is the target's complete kill record, which is what the mob page opens
 * with — clicking the d4 card must not tell the mob page you killed it once. Defined by the
 * loadout grouping, which is the only producer that makes the two differ.
 */
type CardRow = LoadoutCard

/** The identity rows: a card that is its own whole target (both category sections + undefeated). */
function wholeRows(list: TargetStatus[]): CardRow[] {
  return list.map((s) => ({ s, whole: s }))
}

/** A header plus the grid under it. The ONE grid in this feature; both groupings use it. */
function Section({ header, rows, compact, minCol, flashing, onOpenMob, lockOf, hiddenOf, onToggleHidden }: GridProps & { header: JSX.Element; rows: CardRow[] }): JSX.Element {
  return (
    <Box sx={{ mb: compact ? 1.5 : 2.5 }}>
      {header}
      <Box
        sx={{
          display: 'grid',
          gridTemplateColumns: `repeat(auto-fill, minmax(${minCol}px, 1fr))`,
          gap: compact ? 1 : 1.5
        }}
      >
        {rows.map((row) => (
          <TargetCard
            key={row.s.target.name}
            s={row.s}
            compact={compact}
            flash={flashing.has(row.s.target.name)}
            lock={lockOf?.(row.s)}
            // THE LADDER READS `whole`, NOT `s` (JOS-152). The chip and the date line are claims
            // about THIS CARD's kills, which under the loadout grouping is one tier run — right
            // for them, wrong for a ladder. "Which of this boss's difficulties has my week taken"
            // is a question about the BOSS, and answering it from a d4-only slice would grey out
            // four rungs a d0 card two sections down is showing green. Under the category
            // grouping (the default) `whole` IS `s`, so nothing moves there.
            ladder={lockOf && tierLadder(lockOf(row.whole))}
            onOpen={() => onOpenMob(mobTargetForStatus(row.whole))}
            hidden={hiddenOf?.(row.s.target.name) ?? false}
            onToggleHidden={onToggleHidden && (() => onToggleHidden(row.s.target.name))}
          />
        ))}
      </Box>
    </Box>
  )
}

/** One progression category (Open World, Fear, Hate, Sky) and its grid of target cards. */
export function CategorySection({ category, list, ...grid }: SectionProps & { category: string }): JSX.Element {
  return (
    <Section
      {...grid}
      rows={wholeRows(list)}
      header={
        <Typography variant="subtitle2" sx={{ mb: 0.75, color: 'primary.main' }}>
          {category}{' '}
          <Typography component="span" variant="caption" color="text.secondary">
            ({list.filter((s) => s.killed).length}/{list.length})
          </Typography>
        </Typography>
      }
    />
  )
}

const GROUP_RULE = 'Grouped by the loadout you were running for these kills.'
/**
 * Said only where it applies (JOS-236). A section can cover several stretches of the same trio —
 * you swapped away and came back, or a `/who` restated it — and the caption already says how
 * many; the tooltip is where they are spelled out, so the header stays one line.
 */
const MERGED_RULE = 'You ran this loadout more than once; those stretches are one section:'
/**
 * The gated section's sentence (JOS-239). It states the two facts the model has — that the stretch
 * held more than one loadout, and which stretch — and refuses the third. No trio, no chips, no
 * "probably": naming a loadout here is the defect the ticket is about, and a greyed-out guess is
 * still a guess. `MERGED_RULE`'s spelled-out stretches still apply, so a reader can go and look.
 */
const MIXED_RULE =
  'More classes showed up in these stretches than a loadout holds, or your level went backwards inside one - so a swap happened in there that nothing in the log dated. These kills are yours; which loadout took them is not something this app can honestly say.'

/** The loadout header: the slots as chips, its provenance, and the span(s) they cover. */
function LoadoutHeader({ group }: { group: LoadoutGrouping }): JSX.Element {
  const interval = group.interval
  const ranges = group.intervals
  const rule = group.uncertain ? MIXED_RULE : GROUP_RULE
  const title = ranges.length > 1 ? `${rule} ${MERGED_RULE} ${ranges.map(spanText).join('; ')}` : rule
  return (
    <Tooltip title={title}>
      <Stack
        // The header is the sentence this whole feature is judged on, so it is addressable and it
        // states which of the three it is: a named loadout, a gated stretch, or an unattributed
        // one. tests/e2e/bosses-week.e2e.mts reads both attributes.
        data-testid="boss-loadout-header"
        data-loadout={interval ? 'named' : group.uncertain ? 'mixed' : 'unknown'}
        direction="row"
        spacing={0.75}
        alignItems="center"
        flexWrap="wrap"
        useFlexGap
        sx={{ mb: 0.75 }}
      >
        {interval ? (
          <>
            <SlotChips slots={interval.slots} />
            <ProvenanceChip interval={interval} />
            <Typography variant="caption" color="text.secondary">
              {spansText(ranges)}
            </Typography>
          </>
        ) : group.uncertain ? (
          <>
            <Typography variant="subtitle2" color="warning.main">
              Mixed loadouts
            </Typography>
            <Typography variant="caption" color="text.secondary">
              {spansText(ranges)}
            </Typography>
          </>
        ) : (
          <Typography variant="subtitle2" color="text.secondary">
            Loadout not known
          </Typography>
        )}
        <Typography variant="caption" color="text.secondary">
          ({group.rows.length})
        </Typography>
      </Stack>
    </Tooltip>
  )
}

/** Defeated targets, split per tier run and time-joined to the combo intervals (loadoutGroups). */
function useLoadoutGroups(list: TargetStatus[], keep?: (card: TargetStatus) => boolean): LoadoutGrouping[] {
  const intervals = useComboIntervals()
  return useMemo(() => loadoutGroups(intervals, list, keep), [intervals, list, keep])
}

/**
 * The roster sectioned by class loadout. Undefeated targets carry no timestamp to join on, so
 * they keep their own trailing section instead of being silently dropped or attributed.
 *
 * `keep` is the toolbar's "defeated" filter at CARD grain (JOS-237): a card here is one tier run
 * of a target, so a filter that only ran over whole targets would let a run it excludes back onto
 * the screen. Absent = the switch is off and every card stands.
 */
export function LoadoutSections({
  list,
  keep,
  ...grid
}: SectionProps & { keep?: (card: TargetStatus) => boolean }): JSX.Element {
  const groups = useLoadoutGroups(list, keep)
  const undefeated = list.filter((s) => !s.killed || s.lastTs === 0)
  return (
    <>
      {groups.map((group) => (
        <Section key={group.key} {...grid} rows={group.rows} header={<LoadoutHeader group={group} />} />
      ))}
      {undefeated.length > 0 && (
        <Section
          {...grid}
          rows={wholeRows(undefeated)}
          header={
            <Typography variant="subtitle2" sx={{ mb: 0.75 }} color="text.secondary">
              Not defeated{' '}
              <Typography component="span" variant="caption" color="text.secondary">
                ({undefeated.length})
              </Typography>
            </Typography>
          }
        />
      )}
    </>
  )
}
