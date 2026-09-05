// The link affordance a NAME inside someone else's row wears (first spelled by the Sky dropper
// cell, posky/DropperCell.tsx `DropperName`): a span that reads as a link, keyboard-reachable,
// click stopped so the host row's own click and hover machinery never sees it. One idiom on
// purpose — the Gear drop trio, the Loot drill-down's sources and the wish list's camps are all
// the same gesture, and a reader should not have to learn a second spelling of "this name opens".

import type { JSX } from 'react'
import { Box } from '@mui/material'

export function CellLink({ text, onOpen }: { text: string; onOpen: () => void }): JSX.Element {
  const open = (e: { stopPropagation: () => void }): void => {
    e.stopPropagation()
    onOpen()
  }
  return (
    <Box
      component="span"
      role="button"
      tabIndex={0}
      onClick={open}
      onKeyDown={(e: React.KeyboardEvent) => {
        if (e.key !== 'Enter' && e.key !== ' ') return
        e.preventDefault()
        open(e)
      }}
      sx={{
        cursor: 'pointer',
        textDecoration: 'underline dotted',
        textUnderlineOffset: 2,
        '&:hover': { color: 'primary.main' },
        '&:focus-visible': { outline: '1px solid', outlineColor: 'primary.main', borderRadius: 0.5 }
      }}
    >
      {text}
    </Box>
  )
}
