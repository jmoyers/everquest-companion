// components/OutputKindLine.tsx — the freshness line, WIRED TO THE REGISTRY (JOS-44).
//
// `OutputFileLine` is the generic row (JOS-42): it takes a command, a clause and an mtime and
// knows nothing about EverQuest. This is the adopter that fills those props from the one place
// that knows them — the `/outputfile` registry over `IPC.outputsStatus` — so a surface fed by an
// export command says `<OutputKindLine kind="inventory" />` and inherits the command string, the
// why-clause and the file's own age without re-typing any of them.
//
// IT ANSWERS THE NEVER-RUN CASE TOO. A kind whose command has never been run on this machine has
// `updatedAt: null`, and the line then reads "not yet run" beside the command — which is exactly
// the surface that used to render its numbers with total confidence over a file that does not
// exist. A surface that already teaches the command in a card of its own (the Exaltations tab)
// keeps doing that; this line is for the ones where the data is on screen either way.
//
// LIVE, WITHOUT A NEW CHANNEL: main already pushes `inventory:autoReloaded` when the watched dump
// settles, and the registry re-reads on every ask, so re-asking on that push is what makes the
// age fall back to "just now" the moment the player types the command. Nothing is cached here —
// the whole failure mode this closes is an answer from before the command was typed.
//
// AND `onProgress` IS THE SECOND SUCH PUSH SINCE JOS-429, which is what kept the second graduated
// kind from needing a channel of its own. `inventory:autoReloaded` means something specific — the
// held counts moved — and an achievements dump moves no count, so re-using it would have been a
// lie told to every other listener. What both loads DO have in common is that they write
// `ProgressState` and push it. Listening to both is strictly a widening: a kind whose file was
// rewritten is now re-asked about on either push, and the registry is one readdir plus one stat
// with nothing cached, so a redundant ask costs an answer that was already correct.

import { type JSX, useCallback, useEffect, useState } from 'react'
import type { OutputFileStatus, OutputKindId } from '@shared/outputs/kinds'
import OutputFileLine from './OutputFileLine'

export interface OutputStatusState {
  status: OutputFileStatus | null
  /** false until the first read settles — a data-availability flag, not an error */
  ready: boolean
}

/** One kind's registry status, re-read whenever a dump is picked up live. */
export function useOutputStatus(kind: OutputKindId): OutputStatusState {
  const [state, setState] = useState<OutputStatusState>({ status: null, ready: false })

  const read = useCallback(
    (alive: () => boolean) => {
      void window.eq
        .outputsStatus()
        .then((all) => {
          if (alive()) setState({ status: all.find((s) => s.kind === kind) ?? null, ready: true })
        })
        .catch(() => {
          // Main never rejects; a missing answer is "we do not know", not a failure to render.
          if (alive()) setState({ status: null, ready: true })
        })
    },
    [kind]
  )

  useEffect(() => {
    let alive = true
    const live = (): boolean => alive
    read(live)
    const offInv = window.eq.onInventoryReload(() => read(live))
    const offProgress = window.eq.onProgress(() => read(live))
    return () => {
      alive = false
      offInv()
      offProgress()
    }
  }, [read])

  return state
}

export interface OutputKindLineProps {
  kind: OutputKindId
  /** Override the registry's clause when a surface has something truer to say. Rarely needed. */
  why?: string
  /**
   * When this app last READ the dump (JOS-253) — passed THROUGH rather than read from the
   * registry, and that is the whole design decision here. The registry answers questions about
   * the FILE (`outputStatus` is one readdir + one stat), and "did we load it" is not one of them:
   * it is a fact about the consumer's own state, which for inventory is
   * `ProgressState.inventorySource.readAt` and for the next kind will be something else. A
   * registry field would have to be invented per consumer and could not be true for two surfaces
   * at once. `null` ⇒ this surface reads the dump and has none; omitted ⇒ it does not read it.
   */
  loadedAt?: number | null
  /** Draw it understated (JOS-268) — chrome only, passed straight through to `OutputFileLine`. */
  quiet?: boolean
  /**
   * Re-read the dump on demand (JOS-431), passed straight through. The ACT belongs to the caller
   * for the reason `loadedAt` does: this component knows the FILE's status and nothing about who
   * consumes it, and "read it again" is a request to that consumer. Omitted ⇒ no affordance, which
   * is every surface that had none before.
   */
  onRefresh?: () => void
  testId?: string
}

/**
 * The line for one `/outputfile` kind. Renders nothing until the first read settles, so a surface
 * never flashes "not yet run" at somebody who ran the command an hour ago.
 */
export default function OutputKindLine({
  kind,
  why,
  loadedAt,
  quiet,
  onRefresh,
  testId
}: OutputKindLineProps): JSX.Element | null {
  const { status, ready } = useOutputStatus(kind)
  if (!ready || status === null) return null
  return (
    <OutputFileLine
      command={status.command}
      why={why ?? status.why}
      updatedAt={status.updatedAt ?? undefined}
      steps={status.steps}
      {...(loadedAt === undefined ? {} : { loadedAt })}
      quiet={quiet}
      {...(onRefresh === undefined ? {} : { onRefresh })}
      testId={testId}
    />
  )
}
