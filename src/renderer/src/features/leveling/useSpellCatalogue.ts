// THE CLIENT'S OWN SPELL CATALOGUE, ASKED OVER THE ENGINE (JOS-507).
//
// The readout's search box folds the committed WIKI catalog in this window (`shared/bestSpellsSearch
// .ts`, ~1,450 rows, no IPC per keystroke). This hook answers an entirely different question against
// an entirely different source: `spells.search` over the player's OWN `spells_us.txt`, which is the
// only thing that knows what TYPE a spell is — the Category and Subcategory the in-game
// Actions/Spells window prints.
//
// ── WHY THIS IS A REQUEST AND NOT A FOLD IN HERE (owner ruling 4) ─────────────────────────────
//
// The obvious cheaper design is to pull the categories once and join them onto the wiki rows this
// window already holds. That join and the filter over it would live in `src/shared` over domain
// data, which is exactly the client-side munging ruling 4 exists to forbid — it would need lint
// exemptions to ship, and it would put a second opinion about what matches a `Taps` search in a
// second language. So the ENGINE filters, sorts and windows, and this hook holds what it sent and
// nothing derived from it. There is no sort, no filter and no re-keying anywhere in this file.
//
// ── NO ENGINE IS THE ORDINARY STATE, AND IT IS SAID RATHER THAN HIDDEN ────────────────────────
//
// The context holds `null` whenever this window has no connection — a launch with no built binary,
// an engine that has not become ready yet, a connection that just died (`engineProvider.tsx`'s
// header). This hook reads the context DIRECTLY rather than through `useEngineClient`, which throws;
// every engine-gated surface does the same. What the panel must NOT do with that state is fall back
// to the wiki rows unfiltered: the reader asked for taps and would be shown everything, which is a
// wrong answer wearing a right answer's clothes. So `offline` is reported and the surface says so.
//
// ── AND IT ASKS NOTHING UNTIL SOMEBODY WANTS IT ───────────────────────────────────────────────
//
// `enabled` is false until the reader opens the type control or has a filter active, so a panel
// nobody has touched issues no request at all and the ranked readout costs exactly what it cost
// before this file existed.

import { useContext, useEffect, useRef, useState } from 'react'
import { EngineClientContext } from '../../lib/useView'
import type { ClassAbbr, SpellsSearchResult } from '@shared/dataServer/protocol.generated'

/**
 * How long a change waits before it becomes a request.
 *
 * The wiki box next door is memoized rather than debounced and its header says why — there is no IPC
 * on that path. There is on this one, so a typed word is one round trip per keystroke without this.
 * It paces REQUESTS and decides nothing about what matches, which is the engine's business either
 * way.
 */
const DEBOUNCE_MS = 150

/** What to ask. Every field is passed to the engine untouched. */
export interface SpellCatalogueQuery {
  /** The search box's text, shared with the wiki search — it filters name, category and subcategory. */
  readonly text: string
  /** The picked category, or null for every category. */
  readonly category: string | null
  /** The picked subcategory, or null. */
  readonly subcategory: string | null
  /**
   * The classes to scope to. EMPTY IS EVERY CLASS on the wire, which is the show-all toggle — the
   * schema and the engine agree on that reading because an optional array cannot carry its own
   * absence into Rust.
   */
  readonly classes: readonly ClassAbbr[]
  /** How many rows the window holds. The engine clamps it and echoes what it applied. */
  readonly limit: number
}

export interface SpellCatalogueState {
  /** Exactly what the engine answered, or null before anything has. Never re-ordered here. */
  readonly result: SpellsSearchResult | null
  readonly loading: boolean
  /** There is no connection to ask. See the header — this is said, never fallen back from. */
  readonly offline: boolean
  /** The engine refused the request. Its own message, for the surface to print. */
  readonly error: string | null
}

const IDLE: SpellCatalogueState = { result: null, loading: false, offline: false, error: null }

/**
 * The identity of a question, for the effect's dependency list — `useView.ts`'s `descriptorKey`
 * trick and the same reason: the query is written inline at the call site, so it is a new object
 * every render and cannot be a dependency itself.
 *
 * A FIXED ORDER rather than a canonicalization, exactly as that file argues: this is renderer code
 * and it may not sort anything.
 */
function queryKey(query: SpellCatalogueQuery): string {
  return JSON.stringify([
    query.text,
    query.category,
    query.subcategory,
    [...query.classes],
    query.limit
  ])
}

/**
 * Ask the engine for a window onto the client's spell table.
 *
 * The previous answer is HELD while a new one is in flight, so a typed character re-ranks the list
 * without blanking it — the same reason `useView` keeps its window across a diff rather than
 * dropping to loading. A change of question that produces an error clears the rows, because showing
 * the last successful answer under a question that failed would be the stalest possible lie.
 */
export function useSpellCatalogue(
  query: SpellCatalogueQuery,
  enabled: boolean
): SpellCatalogueState {
  const client = useContext(EngineClientContext)
  const [state, setState] = useState<SpellCatalogueState>(IDLE)
  const key = queryKey(query)
  // The latest question without making the effect depend on its identity — `useView.ts`'s
  // `descriptorRef` exactly, and `key` is what decides whether to ask again.
  const queryRef = useRef(query)
  queryRef.current = query

  useEffect(() => {
    if (!enabled) {
      setState(IDLE)
      return
    }
    if (client === null) {
      setState({ result: null, loading: false, offline: true, error: null })
      return
    }
    let live = true
    setState((held) => ({ ...held, loading: true, offline: false, error: null }))
    const timer = setTimeout(() => {
      const asked = queryRef.current
      void client
        .request('spells.search', {
          // AN EMPTY STRING IS OMITTED rather than sent: the schema reads an absent filter and an
          // empty one the same way, and not sending it is the smaller message.
          text: asked.text === '' ? undefined : asked.text,
          category: asked.category ?? undefined,
          subcategory: asked.subcategory ?? undefined,
          classes: [...asked.classes],
          limit: asked.limit
        })
        .then(
          (result) => {
            if (!live) return
            setState({ result, loading: false, offline: false, error: null })
          },
          (reason: unknown) => {
            if (!live) return
            setState({
              result: null,
              loading: false,
              offline: false,
              error: reason instanceof Error ? reason.message : 'the engine refused that question'
            })
          }
        )
    }, DEBOUNCE_MS)
    return () => {
      live = false
      clearTimeout(timer)
    }
  }, [client, enabled, key])

  return state
}
