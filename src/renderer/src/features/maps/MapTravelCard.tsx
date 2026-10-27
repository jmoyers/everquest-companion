// maps/MapTravelCard — "what is this zone for, and how do I get here".
//
// Two owner asks in one strip (kaltinril 2026-09-11): the nearest druid / wizard / boat / item
// port, and the zone's level range. `useZoneTravel` gathers the three witnesses; this only draws.
//
// IT NEVER SAYS "BOAT". Legends replaced the boats with translocator NPCs at the docks (owner,
// 2026-09-11) and the map files still print the old word; `zoneTravel.ts` translates it once, and
// the copy here says dock and translocator because that is what the player walks up to.
//
// ── ONE LINE PER ZONE YOU CAN LAND IN, NEAREST FIRST ─────────────────────────────────────────
//
// The first version drew one row per SPELL, and the owner read two rows that differed only by
// which wizard spell (2026-09-12): *"if there is a SOLO and GROUP port and alternate class, combine
// them to 1 line ... the point is to show the top 2-3 closest zones that you can port into"*. The
// unit of the answer is the zone you land in; the spells are how, and they fold into chips on the
// line - `[WIZ 20 29] [DRU 19 29]` - with every level still a click through to its spell. The
// fold itself is `zoneTravel.landings`, because a renderer never groups a domain collection.
//
// The walk after landing is spelled out with every zone a link to its map, and past one hop names
// the zones passed through, because that IS the route and the reader is about to take it.
//
// ── A LINK HAS TO LOOK LIKE ONE ───────────────────────────────────────────────────────────────
//
// The first cut drew the zone links in the sentence's own colour, and the owner asked the only
// question that matters about a link nobody can see (2026-09-12): *"how do i know i'm supposed to
// click on toxxulia forest to look at that zone?"*. They take the app's link colour and a dotted
// underline now - the same dotted underline every item name in the app wears when it opens a card.
//
// ── IT HAS A NAME, AND IT FOLDS AWAY ─────────────────────────────────────────────────────────
//
// Owner, same night: *"make the closest port have a title for the section saying 'closest port'
// and be collapsible so someone doesn't have to use up much space on the map page if they don't
// want to"*. The level line stays - it is one line and the other ask - and everything under the
// "Closest port" head folds, remembered the way the sidebar is (`useMapData.TRAVEL_OPEN_KEY`).
//
// ── THE BAND IS THE HEADLINE AND THE EXTREMES ARE THE HOVER ──────────────────────────────────
//
// `zoneLevels.ts` carries the argument: Befallen's catalog rows run 4 to 61 and the band is 7-25.
// The caption states the band, the title states both plus the count it rests on, because `n` is
// what makes the band honest and a number nobody can weigh is worse than no number.
//
// NOTHING IS INVENTED WHEN NOTHING IS KNOWN. A zone whose map labels no seams and whose bestiary
// states no levels draws NO card at all rather than a row of blanks.

import { useState, type JSX } from 'react'
import { Box, Chip, IconButton, Link, Paper, Stack, Typography } from '@mui/material'
import ExpandMoreIcon from '@mui/icons-material/ExpandMore'
import ChevronRightIcon from '@mui/icons-material/ChevronRight'
import { MAX_HOPS, type Landing, type ZonePort } from '@shared/zoneTravel'
import type { ZoneLevelBand } from '@shared/zoneLevels'
import type { ZoneTravel } from './useZoneTravel'
import { loadTravelOpen, saveTravelOpen } from './useMapData'
// The two hover-and-drill seams the rest of the app already uses for these nouns. `SpellTooltip`
// carries its own click-through to the spell page (lib/spellLink.tsx publishes the opener
// app-wide), and `KnownItemTooltip` is the same card every other item name in the app opens.
import { SpellTooltip } from '../../lib/SpellCard'
import { KnownItemTooltip } from '../../lib/KnownItemTooltip'

const TINY = { height: 18, fontSize: 10, '& .MuiChip-label': { px: 0.6 } } as const

/** The level band, or nothing. `n` rides the hover — see the header. */
function LevelLine({ band }: { band: ZoneLevelBand | null }): JSX.Element | null {
  if (band === null) return null
  const [low, high] = band.typical
  return (
    <Typography
      variant="caption"
      color="text.secondary"
      data-testid="map-level-band"
      title={`${String(band.n)} catalog mobs, level ${String(band.min)} to ${String(band.max)} outright. The band is the tenth to ninetieth percentile - what the zone is for, rather than what can wander into it.`}
    >
      Levels{' '}
      <Box component="span" sx={{ color: 'text.primary', fontVariantNumeric: 'tabular-nums' }}>
        {low === high ? low : `${String(low)} to ${String(high)}`}
      </Box>
      {band.max > high && ` (up to ${String(band.max)})`}
    </Typography>
  )
}

/**
 * A zone name that opens that zone's map (owner, 2026-09-12: *"i should be able to click on the
 * name of the 'lands in' portal to jump to the map for that"*). Inert text when the card was
 * mounted without an opener, the `onOpenLoot` rule: no control rather than a dead one.
 */
function ZoneLink({ zone, name, onPick }: { zone: string; name: string; onPick?: (zone: string) => void }): JSX.Element {
  if (onPick === undefined) return <>{name}</>
  return (
    <Link
      component="button"
      variant="caption"
      underline="none"
      data-testid="map-travel-zone"
      title={`Open the ${name} map`}
      onClick={() => {
        onPick(zone)
      }}
      sx={{
        verticalAlign: 'baseline',
        color: 'primary.main',
        textDecoration: 'underline dotted',
        textUnderlineOffset: 2,
        '&:hover': { textDecoration: 'underline solid' }
      }}
    >
      {name}
    </Link>
  )
}

/** The walk as one string, for the row's hover - `Walk` below draws it with the zones as links. */
function walkText(landing: Landing): string {
  const { path } = landing
  if (path.length === 0) return 'lands here'
  const kinds = new Set(path.map((p) => p.kind))
  const how = kinds.size === 1 && kinds.has('walk') ? 'on foot' : 'on foot and by translocator'
  const via = path.slice(0, -1).map((p) => p.name)
  const end = path[path.length - 1].name
  return via.length === 0
    ? `lands in ${landing.zoneName}, then ${how} to ${end}`
    : `lands in ${landing.zoneName}, then ${how} via ${via.join(', ')} to ${end}`
}

/** The walk after landing, with every zone named a link to its map. */
function Walk({ landing, onPick }: { landing: Landing; onPick?: (zone: string) => void }): JSX.Element {
  const { path } = landing
  if (path.length === 0) return <>lands here</>
  const kinds = new Set(path.map((p) => p.kind))
  const how = kinds.size === 1 && kinds.has('walk') ? 'on foot' : 'on foot and by translocator'
  const via = path.slice(0, -1)
  const end = path[path.length - 1]
  return (
    <>
      {'lands in '}
      <ZoneLink zone={landing.zone} name={landing.zoneName} onPick={onPick} />
      {`, then ${how} `}
      {via.length > 0 && (
        <>
          {'via '}
          {via.map((step, i) => (
            <span key={step.zone}>
              {i > 0 && ', '}
              <ZoneLink zone={step.zone} name={step.name} onPick={onPick} />
            </span>
          ))}
          {' '}
        </>
      )}
      {'to '}
      <ZoneLink zone={end.zone} name={end.name} onPick={onPick} />
    </>
  )
}

/**
 * `[WIZ 20 29]` — one class's casts into this zone, cheapest first, every level a click through
 * to its spell. Nothing at all when the class has no cast here.
 */
function CasterChip({ label, ports }: { label: string; ports: readonly ZonePort[] }): JSX.Element | null {
  if (ports.length === 0) return null
  return (
    <Chip
      size="small"
      variant="outlined"
      data-testid="map-travel-caster"
      title={ports.map((p) => `${p.spell} (${String(p.level ?? '?')})`).join(', ')}
      sx={TINY}
      label={
        <>
          {label}
          {ports.map((p) => (
            <SpellTooltip key={p.spell} name={p.spell}>
              <Box component="span" sx={{ ml: 0.5, fontVariantNumeric: 'tabular-nums' }}>
                {p.level ?? '?'}
              </Box>
            </SpellTooltip>
          ))}
        </>
      }
    />
  )
}

/** Open one item's page - the app's loot deep link. Absent, the names are hover-only text. */
type OpenItem = (name: string) => void

/**
 * `[item]` — the clicks that land here, each name a card AND A CLICK THROUGH (owner, 2026-09-12:
 * *"looks like i can't click the items to see more info on this item that allows me to port"*).
 * The card was hover-only; the name now opens the item on the Loot tab the way the drops card's
 * rows do, drawn as the same dotted link `ZoneLink` uses beside it.
 */
function ItemChip({ ports, onOpenItem }: { ports: readonly ZonePort[]; onOpenItem?: OpenItem }): JSX.Element | null {
  if (ports.length === 0) return null
  return (
    <Chip
      size="small"
      variant="outlined"
      data-testid="map-travel-items"
      title={ports.map((p) => p.item ?? p.spell).join(', ')}
      sx={TINY}
      label={
        <>
          {ports.length === 1 ? 'item' : `items ${String(ports.length)}`}
          {ports.map((p) => (
            <ItemName key={p.item ?? p.spell} name={p.item ?? p.spell} onOpenItem={onOpenItem} />
          ))}
        </>
      }
    />
  )
}

/**
 * The item's name inside the chip, under its card: a link when the view can open items, plain
 * text otherwise. The tooltip wraps the Box/Link HERE rather than wrapping this component: MUI's
 * Tooltip clones its child with a ref and the hover handlers, and a plain function component in
 * that seat dropped both, so the card never opened over a map item and React warned on every
 * render (errors.log, 2026-09-13 on). The link carries no `title` for the same reason: the card
 * is the hover text, and MUI refuses a child that brings its own.
 */
function ItemName({ name, onOpenItem }: { name: string; onOpenItem?: OpenItem }): JSX.Element {
  if (onOpenItem === undefined) {
    return (
      <KnownItemTooltip name={name} clickThrough>
        <Box component="span" sx={{ ml: 0.5, textDecoration: 'underline dotted', textUnderlineOffset: 2 }}>
          {name}
        </Box>
      </KnownItemTooltip>
    )
  }
  return (
    <KnownItemTooltip name={name} clickThrough>
      <Link
        component="button"
        variant="caption"
        underline="none"
        data-testid="map-travel-item"
        onClick={() => {
          onOpenItem(name)
        }}
        sx={{
          ml: 0.5,
          verticalAlign: 'baseline',
          color: 'primary.main',
          textDecoration: 'underline dotted',
          textUnderlineOffset: 2,
          '&:hover': { textDecoration: 'underline solid' }
        }}
      >
        {name}
      </Link>
    </KnownItemTooltip>
  )
}

/** One zone you can land in: who casts you there, and the walk after. */
function LandingRow({
  landing,
  onPick,
  onOpenItem
}: {
  landing: Landing
  onPick?: (zone: string) => void
  onOpenItem?: OpenItem
}): JSX.Element {
  return (
    <Stack direction="row" spacing={0.75} alignItems="center" data-testid="map-travel-landing" data-hops={landing.path.length}>
      <CasterChip label="WIZ" ports={landing.wizard} />
      <CasterChip label="DRU" ports={landing.druid} />
      <ItemChip ports={landing.items} onOpenItem={onOpenItem} />
      <Typography variant="caption" component="span" color="text.secondary" noWrap sx={{ minWidth: 0 }} title={walkText(landing)}>
        <Walk landing={landing} onPick={onPick} />
      </Typography>
    </Stack>
  )
}

/** The closest zones you can port into - the owner's "top 2-3". */
const SHOWN = 3

/** Everything under the "Closest port" head: the crossings, the landings, and the honest empties. */
function TravelBody({
  travel,
  onPick,
  onOpenItem
}: {
  travel: ZoneTravel
  onPick?: (zone: string) => void
  onOpenItem?: OpenItem
}): JSX.Element {
  const { rides, landings, ready } = travel
  // Until the port table has crossed from main, drawing "no ports" would be a claim about the
  // corpus rather than about the wait (law 1).
  const shown = ready ? landings.slice(0, SHOWN) : []
  return (
    <Stack spacing={0.5} data-testid="map-travel-body">
      {/* The crossings somebody built, read as arrivals - what the ask called the "boat". */}
      {rides.map((ride) => (
        <Stack key={`${ride.kind}-${ride.zone}`} direction="row" spacing={0.75} alignItems="center" data-testid="map-travel-ride">
          <Chip size="small" variant="outlined" label={ride.kind === 'translocator' ? 'dock' : 'portal'} sx={TINY} />
          <Typography variant="caption" component="span" sx={{ color: 'text.primary' }}>
            <ZoneLink zone={ride.zone} name={ride.name} onPick={onPick} />
          </Typography>
          <Typography variant="caption" color="text.secondary" noWrap sx={{ minWidth: 0 }}>
            {ride.kind === 'translocator' ? 'translocator at the dock' : 'portal from here'}
          </Typography>
        </Stack>
      ))}
      {shown.map((landing) => (
        <LandingRow key={landing.zone} landing={landing} onPick={onPick} onOpenItem={onOpenItem} />
      ))}
      {ready && landings.length === 0 && (
        <Typography variant="caption" color="text.disabled">
          {`No port lands within ${String(MAX_HOPS)} zones of here, by the seams the maps label.`}
        </Typography>
      )}
      {landings.length > SHOWN && (
        <Typography variant="caption" color="text.disabled">
          {`and ${String(landings.length - SHOWN)} more zones`}
        </Typography>
      )}
    </Stack>
  )
}

/** The "Closest port" head: the fold, the name, the era gate, and the nearest landing when folded. */
function TravelHead({
  travel,
  open,
  onOpen
}: {
  travel: ZoneTravel
  open: boolean
  onOpen: (next: boolean) => void
}): JSX.Element {
  const { landings, eraOnly, setEraOnly } = travel
  return (
    <Stack direction="row" spacing={0.5} alignItems="center">
      <IconButton
        size="small"
        data-testid="map-travel-toggle"
        aria-label={open ? 'Collapse closest port' : 'Expand closest port'}
        onClick={() => {
          onOpen(!open)
        }}
        sx={{ p: 0.25 }}
      >
        {open ? <ExpandMoreIcon fontSize="small" /> : <ChevronRightIcon fontSize="small" />}
      </IconButton>
      <Typography variant="caption" color="text.secondary" sx={{ fontWeight: 600 }}>
        Closest port
      </Typography>
      {/* ON BY DEFAULT (owner, 2026-09-12): the pack ships every zone the client ever had, and a
          route through Plane of Knowledge is a route through nothing. Lifting it shows the pack's
          own graph, for whoever wants to see what is coming. */}
      <Chip
        size="small"
        label="Current era"
        title={eraOnly ? 'Only zones EQ Legends has now are used as landings or walked through. Click to lift.' : 'Every zone the map pack knows is in play, including ones not in the game yet. Click to limit.'}
        data-testid="map-travel-era"
        color={eraOnly ? 'primary' : 'default'}
        variant={eraOnly ? 'filled' : 'outlined'}
        onClick={() => {
          setEraOnly(!eraOnly)
        }}
        sx={TINY}
      />
      {!open && landings.length > 0 && (
        <Typography variant="caption" color="text.disabled" noWrap sx={{ minWidth: 0 }}>
          {`${landings[0].zoneName}${landings.length > 1 ? ` and ${String(landings.length - 1)} more` : ''}`}
        </Typography>
      )}
    </Stack>
  )
}

export default function MapTravelCard({
  travel,
  onPick,
  onOpenItem
}: {
  travel: ZoneTravel
  /** open a zone's map by stem - the view's own `pick`; absent, the zone names are plain text */
  onPick?: (zone: string) => void
  /** open an item's page - the app's `openLoot` deep link; absent, the item names are hover-only */
  onOpenItem?: OpenItem
}): JSX.Element | null {
  const { band, exits, landings } = travel
  const [open, setOpen] = useState(loadTravelOpen)
  if (band === null && exits.length === 0 && landings.length === 0) return null
  return (
    <Paper variant="outlined" data-testid="map-travel-card" sx={{ p: 1, mb: 1 }}>
      <Stack spacing={0.5}>
        <LevelLine band={band} />
        <TravelHead
          travel={travel}
          open={open}
          onOpen={(next) => {
            setOpen(next)
            saveTravelOpen(next)
          }}
        />
        {open && <TravelBody travel={travel} onPick={onPick} onOpenItem={onOpenItem} />}
      </Stack>
    </Paper>
  )
}
