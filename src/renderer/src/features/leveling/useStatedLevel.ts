// useStatedLevel — "what level am I", subscribed (JOS-192).
//
// The `character` module carries the STATED level fact: the later of your last ding and your own
// `/who` row, with which one said it and when (shared/currentLevel.ts). This is the two lines that
// turn it into something a surface can draw — the subscription, and the read against the log clock
// the progression snapshot supplies.
//
// WHY THE FIELDS ARE FLATTENED AND NEVER NULL. Every consumer wants "the number, the cue beside it,
// the sentence on hover", and a nullable read makes each of them write the same three null guards.
// A level nothing has stated is `level: null` with two empty strings, which is exactly what the
// surfaces already do with it: omit the chip, print no cue, hang no tooltip.

import { useMemo } from 'react'
import type { CharacterSnap, ProgressionSnap } from '@shared/types'
import { currentLevelRead } from '@shared/currentLevel'
import { useModule } from '../../lib/useModule'


export interface StatedLevel {
  /** the level the log last stated, or null when nothing ever has */
  level: number | null
  /** '/who' or 'Nh ago' beside the number; '' when the bare number is the whole fact */
  cue: string
  /** which line stated it and how long ago; '' when there is nothing to say */
  title: string
}

/**
 * `prog` is the caller's own progression snapshot — it supplies the LOG clock the statement's age
 * is measured against (never the wall clock, which would call a freshly-loaded log three weeks
 * stale) and the ding-tail fallback for the frame before the character module hydrates.
 */
/**
 * MEMOIZED ON ITS TWO INPUTS (JOS-511 item 2). `currentLevelRead` walks the ding tail to date the
 * statement, and it ran on EVERY render of the tab — including every pointer-driven one — because
 * an unmemoized call has no way not to. Both the read and the flattened object are kept: the object
 * is what the hero cards take, so a fresh one per render is three changed props on them as well.
 */
export function useStatedLevel(prog: ProgressionSnap): StatedLevel {
  const who = useModule<CharacterSnap>('character')
  const level = who?.level
  return useMemo(() => {
    const read = currentLevelRead(level, prog)
    if (!read) return { level: null, cue: '', title: '' }
    return { level: read.level, cue: read.cue, title: read.title }
  }, [level, prog])
}
