// maps/zoneAdviceUi — the words and colours the "Where to level" table and its bar share.
//
// One place for the fit chips and the goal specs so the bar's filter chips and the table's rows
// cannot disagree about what "a reach" is called or which colour "deadly" wears.

import type { ZoneAdvice, ZoneGoal } from '@shared/zoneAdvice'
import type { ZoneFit } from '@shared/zoneLevels'

/** How a fit reads, and how loudly. `deadly` only ever appears on the wish-list goal. */
export const FIT: Readonly<Record<ZoneFit, { label: string; color: 'success' | 'warning' | 'error' | 'default' }>> = {
  even: { label: 'on level', color: 'success' },
  hard: { label: 'a reach', color: 'warning' },
  green: { label: 'easy', color: 'default' },
  deadly: { label: 'deadly', color: 'error' }
}

/** The fits in the order the filter chips draw them. */
export const FIT_ORDER: readonly ZoneFit[] = ['even', 'hard', 'green', 'deadly']

/** The goal's own numeric column, or none — see `MapZoneAdvice`'s header for why none is honest. */
export interface GoalColumn {
  head: string
  title: string
  value: (row: ZoneAdvice) => number
}

export interface GoalSpec {
  label: string
  /** the one sentence the chip's hover states about what this ranking is for */
  hint: string
  column: GoalColumn | null
}

export const GOALS: Readonly<Record<ZoneGoal, GoalSpec>> = {
  exp: {
    label: 'Experience',
    hint: 'Zones that con even or a little above you first, then the easy ones. Con drives experience and mote drops alike.',
    column: {
      head: 'Motes / 100',
      title: 'Motes per 100 kills at this con, measured from this app`s own logged fights. A rate, not a total: it says nothing about how fast you clear a zone.',
      value: (row) => row.motesPer100
    }
  },
  motes: {
    label: 'Mote grade',
    hint: 'Harder zones first: the grade floor rises with difficulty, and Superior-and-better come from harder content rather than luckier kills. Easy zones are left off. Which zones offer which instance tier (D0 to D4) is stated in no data this app holds, so this ranks by the band alone.',
    column: null
  },
  wish: {
    label: 'Wish list',
    hint: 'Zones by how many different items on your wish list can drop there. The one list that keeps a deadly zone, because the item is where it is.',
    column: {
      head: 'Wished',
      title: 'How many different items on your wish list the bestiary says can drop in this zone.',
      value: (row) => row.wished
    }
  }
}

export const GOAL_ORDER: readonly ZoneGoal[] = ['exp', 'motes', 'wish']
