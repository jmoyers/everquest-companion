// useAlertFilter — the alerts search box's state, and the list it narrows (JOS-178).
//
// The house search pattern (AGENTS.md "UI conventions", lib/search.ts): the input echoes from
// local state IMMEDIATELY and the FILTER consumes a DEFERRED copy, so typing never waits on a
// re-render of the list. The haystacks are built once per alert/pack change — never per
// keystroke — which is the same "lowercase key computed once" rule, spelled as tokens because
// the matcher is the house tokenizer rather than a substring test (alertSearch.ts).
//
// `filtering` READS THE DEFERRED QUERY, not the typed one, and that matters: it is what an empty
// list says about itself ("nothing matches that search" vs "you have no alerts yet"), and while
// React is still catching up the full list is what is on screen — so the deferred answer is the
// one that describes what the user is actually looking at.

import { useDeferredValue, useMemo, useState } from 'react'
import type { AlertDef, SoundPack } from '@shared/types'
import { tokenize } from '../../../../shared/fuzzy'
import { alertHaystack, indexPacks, matchesAlert } from './alertSearch'

export interface AlertFilter {
  /** What is in the box right now (echoes every keystroke). */
  query: string
  setQuery: (q: string) => void
  /** True while the list on screen is narrowed — what an empty list says about itself. */
  filtering: boolean
  /** The alerts to render, in the stored order with non-matches removed. */
  visible: AlertDef[]
}

export function useAlertFilter(alerts: AlertDef[], packs: SoundPack[]): AlertFilter {
  const [query, setQuery] = useState('')
  const deferred = useDeferredValue(query)

  const haystacks = useMemo(() => {
    const index = indexPacks(packs)
    return alerts.map((def) => alertHaystack(def, index))
  }, [alerts, packs])

  const tokens = useMemo(() => tokenize(deferred), [deferred])

  const visible = useMemo(
    () =>
      tokens.length === 0
        ? alerts
        : alerts.filter((_def, i) => matchesAlert(tokens, haystacks[i])),
    [alerts, haystacks, tokens]
  )

  return { query, setQuery, filtering: tokens.length > 0, visible }
}
