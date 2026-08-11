// ThanksSetting — the Preferences section that says whose pictures these are (JOS-198).
//
// WHY IT EXISTS. Every item icon and every raid-boss portrait in this app was made by, or
// uploaded to, one of two volunteer-run EverQuest wikis. Until this ticket the app fetched them
// at runtime, which at least meant a user could see where they came from in a network log if
// they went looking. Now the bytes SHIP INSIDE THE INSTALLER — 780 files, ~3.75 MB — and nothing
// on screen would say so. Art you redistribute without naming the source is the kind of quiet
// borrowing that is fine right up until it is not, and the people it borrows from are two
// hobbyist wikis that never asked for anything. So the credit is a section a user can find, not
// a line in a file only developers read.
//
// It carries the DISCLOSURE as well as the thanks, because the two are one sentence: the images
// are copies, they are stored in the app, and the app therefore does not phone the wikis to draw
// them. That last clause is also the honest answer to "does this thing talk to the internet",
// which the app answers in several other places and should not contradict here.
//
// The URLs are real links. Both hosts are already on `EXTERNAL_LINK_ALLOWLIST` (security.ts) —
// which is exactly the allowlist that lets `setWindowOpenHandler` hand them to
// `shell.openExternal` — so a credit that names a site can also open it. Nothing here is a new
// permission; the same two hosts have been openable since the mob and item pages linked them.
//
// A SECTION, not a line under Updates, for the same reason What's new and Usage analytics are
// sections: it is a reading surface with no controls, and burying an attribution under something
// else is most of the way back to not making it.

import type { JSX } from 'react'
import { Link, Stack, Typography } from '@mui/material'
import FavoriteIcon from '@mui/icons-material/Favorite'
import type { PrefSection } from './PreferencesView'

/** One credited source: who they are, what of theirs is in the app, and where to find them. */
interface Credit {
  readonly host: string
  readonly url: string
  readonly what: string
}

/**
 * The two wikis, in the order their contribution is visible to a user. Portraits first: they are
 * the pictures somebody actually looks at, and two thirds of the bundle by bytes.
 *
 * This list is checkable rather than decorative — `tests/bundledImages.test.mts` asserts every
 * shipped file's URL passes the runtime host allowlist, which is the same two hosts, so a third
 * source could not arrive without that test going red first.
 */
export const IMAGE_CREDITS: readonly Credit[] = [
  {
    host: 'wiki.project1999.com',
    url: 'https://wiki.project1999.com/',
    what: 'the raid-boss portraits on the Raid targets cards'
  },
  {
    host: 'eqlwiki.com',
    url: 'https://eqlwiki.com/',
    what: 'the item icons throughout loot, inventory and the planner - and the item, spell and quest knowledge behind them'
  }
]

export function ThanksSetting(): JSX.Element {
  return (
    <Stack spacing={1.25} data-testid="prefs-thanks">
      <Typography variant="body2">
        The pictures in this app are not ours. Item icons and boss portraits come from two
        volunteer-run EverQuest wikis, and they are copied into the app when it is built - so they
        are here on your machine, and drawing them never asks those sites for anything.
      </Typography>
      <Stack spacing={1}>
        {IMAGE_CREDITS.map((c) => (
          <Stack key={c.host} spacing={0.25}>
            <Link
              href={c.url}
              target="_blank"
              rel="noreferrer"
              variant="body2"
              data-testid={`prefs-thanks-link-${c.host}`}
            >
              {c.host}
            </Link>
            <Typography variant="caption" color="text.secondary">
              {c.what}
            </Typography>
          </Stack>
        ))}
      </Stack>
      <Typography variant="caption" color="text.secondary">
        Both are run by people who have spent years writing this game down for everyone else, and
        neither is affiliated with this app. If you have ever looked something up mid-raid, you owe
        them one.
      </Typography>
    </Stack>
  )
}

/**
 * The section descriptor, beside its own card — the arrangement PerfSetting/GraphicsSetting
 * established, and the reason PreferencesView.tsx only names it in the table.
 */
export function thanksSection(): PrefSection {
  return {
    id: 'thanks',
    label: 'Thanks',
    icon: <FavoriteIcon fontSize="small" />,
    items: [
      {
        id: 'image-credits',
        label: 'Where the art comes from',
        keywords:
          'thanks credit credits attribution wiki wikis eqlwiki project1999 p99 image images icon icons ' +
          'art portrait portraits picture source sources license attribution offline bundled shipped',
        content: <ThanksSetting />
      }
    ]
  }
}
