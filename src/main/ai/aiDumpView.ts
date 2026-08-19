// Honesty for /outputfile dumps the model reads. Empty and stale are stated,
// never implied. Electron-free.

export const DUMP_STALE_MS = 20 * 60 * 1000

export interface DumpHonesty {
  kind: string
  command: string
  empty: boolean
  updatedAt: number | null
  ageMs: number | null
  stale: boolean
  text: string
  note: string
}

function ageNote(ageMs: number): string {
  const min = Math.max(1, Math.round(ageMs / 60_000))
  if (min < 120) return `${String(min)} min`
  return `${String(Math.round(min / 60))} h`
}

export function dumpHonesty(input: {
  kind: string
  command: string
  text: string
  updatedAtMs: number | null
  nowMs: number
}): DumpHonesty {
  const empty = input.text.length === 0 || input.text === '[EMPTY]'
  const updatedAt = input.updatedAtMs
  const ageMs = updatedAt != null ? Math.max(0, input.nowMs - updatedAt) : null
  const stale = !empty && ageMs != null && ageMs > DUMP_STALE_MS
  let note: string
  if (empty) {
    note = `No dump. Tell the player to type ${input.command} in EverQuest. Do not invent bag or book contents.`
  } else if (stale && ageMs != null) {
    note = `This dump is ${ageNote(ageMs)} old. It may not match what they are wearing now. Offer ${input.command}.`
  } else if (ageMs != null) {
    note = `Dump from ${ageNote(ageMs)} ago.`
  } else {
    note = 'Dump age unknown.'
  }
  return {
    kind: input.kind,
    command: input.command,
    empty,
    updatedAt,
    ageMs,
    stale,
    text: empty ? '[EMPTY]' : input.text,
    note
  }
}
