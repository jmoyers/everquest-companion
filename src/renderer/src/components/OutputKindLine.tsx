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
    const off = window.eq.onInventoryReload(() => read(live))
    return () => {
      alive = false
      off()
    }
  }, [read])

  return state
}

export interface OutputKindLineProps {
  kind: OutputKindId
  /** Override the registry's clause when a surface has something truer to say. Rarely needed. */
  why?: string
  testId?: string
}

/**
 * The line for one `/outputfile` kind. Renders nothing until the first read settles, so a surface
 * never flashes "not yet run" at somebody who ran the command an hour ago.
 */
export default function OutputKindLine({ kind, why, testId }: OutputKindLineProps): JSX.Element | null {
  const { status, ready } = useOutputStatus(kind)
  if (!ready || status === null) return null
  return (
    <OutputFileLine
      command={status.command}
      why={why ?? status.why}
      updatedAt={status.updatedAt ?? undefined}
      steps={status.steps}
      testId={testId}
    />
  )
}
