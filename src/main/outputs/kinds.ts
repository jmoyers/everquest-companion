// ============================================================================
// outputs/kinds.ts — the PARSE half of the `/outputfile` registry.
// ============================================================================
//
// The FACTS (which kinds exist, the command, the why-clause, the filename pattern, whether a
// kind is `supported`) moved to `shared/outputs/kinds.ts` in JOS-44 so the renderer can render
// them without inventing its own copy. This file is what could not move: parsing needs the
// parsers, and the parsers are main's.
//
// The no-guessing law lives with the facts — see the header of shared/outputs/kinds.ts. Its
// enforcement is here: an `awaiting-sample` kind refuses in a typed way and never half-parses.
//
// The facts are RE-EXPORTED from here so `import … from './kinds'` (and from `../outputs`)
// still reaches the whole registry from main's side.

import type { InventoryDump } from '../../shared/outputs/inventory'
import { parseAchievementsDump, type AchievementsDump } from '../../shared/outputs/achievements'
import { outputKind, type OutputKindId } from '../../shared/outputs/kinds'
import { parseInventoryDump } from './inventoryParse'

export {
  isOutputFileName,
  outputFileNames,
  outputKind,
  preferredOutputFile,
  OUTPUT_KINDS,
  type OutputFileStatus,
  type OutputKindDef,
  type OutputKindId
} from '../../shared/outputs/kinds'

/** The inventory kind's payload — the deep model (shared/outputs/inventory.ts). */
export interface InventoryOutput {
  kind: 'inventory'
  dump: InventoryDump
}

/**
 * The achievements kind's payload (JOS-429). Unlike inventory, the PARSE is shared rather than
 * main's: the row model is what the renderer joins against the Sky quest set, so splitting the
 * format across the two halves of the app would leave neither able to state it. The header of
 * shared/outputs/achievements.ts carries the measured format.
 */
export interface AchievementsOutput {
  kind: 'achievements'
  dump: AchievementsDump
}

/** The parsed payload of each supported kind: a union with one member per graduated kind. */
export type OutputData = InventoryOutput | AchievementsOutput

/** A parse either produced a typed payload, or explicitly refused and said why. */
export type OutputParseResult =
  | { ok: true; kind: OutputKindId; data: OutputData }
  | { ok: false; kind: OutputKindId; reason: 'unsupported'; message: string }

/**
 * Parse a dump's text as the given kind. Unsupported kinds refuse in a typed way — see the law
 * at the top of shared/outputs/kinds.ts.
 */
export function parseOutput(id: OutputKindId, text: string): OutputParseResult {
  const def = outputKind(id)
  if (def.id === 'inventory') {
    return { ok: true, kind: id, data: { kind: 'inventory', dump: parseInventoryDump(text) } }
  }
  if (def.id === 'achievements') {
    return { ok: true, kind: id, data: { kind: 'achievements', dump: parseAchievementsDump(text) } }
  }
  return {
    ok: false,
    kind: id,
    reason: 'unsupported',
    message: `unsupported: no verified sample for ${def.command}. ${def.note}`
  }
}
