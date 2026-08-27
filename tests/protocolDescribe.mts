// protocolDescribe.mts — the message describers the fixture suite narrates with (JOS-464..486).
//
// SPLIT OUT of protocolSchema.test.mts when the knowledge family (JOS-486) landed beside the
// combat family (JOS-485) and the union put the test file over the repo's max-lines ceiling and
// describeClient over the complexity ceiling — the rule is split, never ratchet. The
// exhaustive-never trick survives intact: a message shape added to the schema without being
// described here is a TYPECHECK failure in this module.

import type { ClientMessage, EngineMessage } from '../src/shared/dataServer/protocol.generated'

/** Exhaustive over the union's tag. The `never` arm is the point: adding a message kind to the
 *  schema without teaching this switch is a TYPECHECK failure, not a runtime surprise. */
export function describeEngine(message: EngineMessage): string {
  switch (message.kind) {
    case 'hello':
      return `hello ok=${String(message.ok)} v${String(message.protocolVersion)}`
    case 'reply':
      return `reply#${String(message.id)}`
    case 'error':
      return `error#${String(message.id)} ${message.error.code}`
    case 'reset':
      return `reset#${String(message.id)} epoch=${String(message.epoch)} rows=${String(message.rows.length)}`
    case 'diff':
      return `diff#${String(message.id)} epoch=${String(message.epoch)} ops=${String(message.ops.length)}`
    case 'epoch':
      return `epoch=${String(message.epoch)} ${message.reason}`
    // NO id AND NO epoch, and the description says so: a fire belongs to the world rather than to a
    // subscription, and it is a thing that happened rather than window state to reconcile.
    case 'fire':
      return `fire ${message.rule} [${message.sound}] at ${String(message.at)}`
    // NO id AND NO epoch EITHER (JOS-486), and for a third reason on top of the fire's two: a miss
    // describes the process's CORPUS — committed data plus an overlay that survives an attach — so
    // there is no generation it could belong to.
    case 'knowledgeMiss':
      return `knowledgeMiss ${message.domain}/${message.name}`
    // A CON CARD IS A FIRE'S TWIN on this axis — no id, no epoch — and its chips are always five,
    // which is worth saying out loud here because "all five axes, always" is a contract rather than
    // a coincidence of the fixture.
    case 'conCard':
      return `conCard ${message.name} L${String(message.level ?? 0)} chips=${String(message.chips.length)} spellData=${String(message.spellData)}`
    // A NAME AND A CURSOR. If this description ever needs a third field, the frame has grown state
    // it was designed not to carry.
    case 'moduleChanged':
      return `moduleChanged ${message.module}@${String(message.seq)}`
    default: {
      const unreachable: never = message
      throw new Error(`unhandled engine message ${JSON.stringify(unreachable)}`)
    }
  }
}

/**
 * THE FIVE `*.define` COMMANDS (JOS-482), split out of `describeClient` rather than folded into it.
 *
 * A SPLIT, NOT A WILDCARD: the exhaustive-switch trick is the whole point of these two functions —
 * a message shape added to the schema without being described here is a TYPECHECK failure — and it
 * survives the split intact, because the two halves are disjoint by TYPE (`DefineMessage` and its
 * exclusion) rather than by a runtime string test. Each says the size of the set it replaced, which
 * is the one thing a full-set replace has to be readable as.
 */
type DefineMessage = Extract<ClientMessage, { op: `${string}.define` }>

function describeDefine(message: DefineMessage): string {
  const at = `define#${String(message.id)}`
  switch (message.op) {
    case 'alerts.define':
      return `${at} alerts×${String(message.params.defs.length)}`
    case 'buffTrust.define':
      return `${at} buffTrust×${String(message.params.trust.externals.length)}`
    case 'respawn.define':
      return `${at} respawn×${String(message.params.prefs.watches.length)}`
    case 'combo.define':
      return `${at} combo×${String(message.params.corrections.length)}`
    case 'roster.define':
      return `${at} roster×${String(message.params.edits.length)}`
    // THE ONE DEFINE THAT IS NOT A FULL-SET REPLACE (JOS-486), and the description says so at
    // length: the other five carry user PREFERENCES, which a store can restate whole, and this one
    // carries the WIKI, which is unbounded and learned one answer at a time. It lands in this
    // function because it is a `*.define` BY NAME, and the count it reports is deliberately `×1` —
    // that is what a push of one entry is, and printing a set size it does not have would be the
    // line above pretending the two commands are the same law.
    case 'knowledge.define':
      return `${at} knowledge/${message.params.domain} ${message.params.name}×1`
    default: {
      const unreachable: never = message
      throw new Error(`unhandled define ${JSON.stringify(unreachable)}`)
    }
  }
}

function isDefine(message: ClientMessage): message is DefineMessage {
  return message.op.endsWith('.define')
}

/**
 * THE COMBAT SURFACE (JOS-485), split out on exactly `describeDefine`'s terms and for exactly its
 * reason: the exhaustive-switch trick survives a split by TYPE, and `describeClient` is at the
 * measured complexity ceiling — the rule there is to split rather than to ratchet.
 */
type CombatMessage = Extract<ClientMessage, { op: `combat.${string}` }>

function describeCombat(message: CombatMessage): string {
  switch (message.op) {
    // THE OPTS ARE OPTIONAL AND THE DESCRIPTION SAYS SO — `combat.snapshot` with no params at all is
    // the ordinary call, which is what `combat.snapshot(Date.now(), opts ?? {})` already means
    // app-side.
    case 'combat.snapshot':
      return `combat#${String(message.id)} ${message.params.opts === undefined ? 'default' : 'opts'}`
    case 'combat.searchFights':
      return `searchFights#${String(message.id)} ${JSON.stringify(message.params.query)}`
    default: {
      const unreachable: never = message
      throw new Error(`unhandled combat op ${JSON.stringify(unreachable)}`)
    }
  }
}

function isCombat(message: ClientMessage): message is CombatMessage {
  return message.op.startsWith('combat.')
}

/**
 * THE KNOWLEDGE FAMILY (JOS-486), split out on exactly the terms `describeDefine` is — and here the
 * repo's own complexity ceiling is what asked for the split rather than a preference. Four more
 * `case` labels put `describeClient` at 16 against a maximum of 12, and that number is a measurement
 * of this tree (p95 is 8): a switch that has grown a fifth family is a switch asking to have one
 * lifted out. The exhaustive-`never` property survives the lift intact, because the halves are
 * disjoint by TYPE rather than by a runtime string test — `knowledge.define` is EXCLUDED here and
 * lands in `describeDefine`, which is where its ack shape says it belongs.
 */
type KnowledgeMessage = Exclude<Extract<ClientMessage, { op: `knowledge.${string}` }>, DefineMessage>

function isKnowledge(message: ClientMessage): message is KnowledgeMessage {
  return message.op.startsWith('knowledge.')
}

function describeKnowledge(message: KnowledgeMessage): string {
  // The three lookups name a THING and the search names a STRING, which is the whole difference
  // between them and the reason `total` exists on only one of the two answers.
  const what =
    message.op === 'knowledge.search' ? JSON.stringify(message.params.query) : message.params.name
  return `${message.op}#${String(message.id)} ${what}`
}

/**
 * THE FOURTH FAMILY (JOS-502), lifted for exactly the reason the third one was and stated in the
 * comment above it: a switch that has grown another family is a switch asking to have one lifted
 * out. Surface 8's third op took `describeCore` to a complexity of 14 against a ceiling of 12; the
 * three perf ops share a prefix, share an answer shape, and share the property that what a reader
 * of a transcript wants is WHICH question was asked — so they describe as their own op name, which
 * is one line for all three and none in the core.
 */
type PerfMessage = Extract<ClientMessage, { op: `perf.${string}` }>

function isPerf(message: ClientMessage): message is PerfMessage {
  return message.op.startsWith('perf.')
}

function describePerf(message: PerfMessage): string {
  // Three questions that printed the same sentence would make the one conversation exercising all
  // three unreadable exactly where it is most worth reading — so the op names itself.
  return `${message.op}#${String(message.id)}`
}

/**
 * The client's spell-catalogue family (JOS-507) — one op today, given a family for the reason the
 * header records about the last split: `describeCore`'s own branches are what put that function over
 * the complexity ceiling, and lint caught this one adding the thirteenth. A family is the shape this
 * file already reaches for when that happens.
 */
type SpellsMessage = Extract<ClientMessage, { op: `spells.${string}` }>

function isSpells(message: ClientMessage): message is SpellsMessage {
  return message.op.startsWith('spells.')
}

function describeSpells(message: SpellsMessage): string {
  // IT NAMES WHAT IT FILTERED BY, because that is the whole question here: a `tap` TEXT search and a
  // `Taps` CATEGORY search return overlapping lists for entirely different reasons, and a transcript
  // printing only the id could not tell the two apart — which is exactly the distinction the JOS-507
  // fixture exists to show.
  const by = message.params.text ?? message.params.category ?? ''
  return `${message.op}#${String(message.id)} ${JSON.stringify(by)}`
}

/** Same trick on the client half. */
export function describeClient(message: ClientMessage): string {
  // ORDER IS LOAD-BEARING: `knowledge.define` satisfies both tests at runtime, and it belongs to the
  // ack family, so the define check goes first and the type exclusion above says the same thing.
  if (isDefine(message)) return describeDefine(message)
  if (isCombat(message)) return describeCombat(message)
  if (isKnowledge(message)) return describeKnowledge(message)
  if (isPerf(message)) return describePerf(message)
  if (isSpells(message)) return describeSpells(message)
  return describeCore(message)
}

/** The un-familied core of the client union — split from `describeClient` when the third family
 *  landed and the dispatcher's own branches put one function over the complexity ceiling. */
function describeCore(
  message: Exclude<
    ClientMessage,
    DefineMessage | CombatMessage | KnowledgeMessage | PerfMessage | SpellsMessage
  >
): string {
  switch (message.op) {
    case 'hello':
      return `hello v${String(message.protocolVersion)}`
    case 'echo':
      return `echo ${message.params.text}`
    case 'session.attach':
      return `attach ${message.params.logPath}`
    case 'session.health':
    case 'session.progress':
      return `${message.op}#${String(message.id)}`
    case 'module.snapshot':
      return `snapshot#${String(message.id)} of ${message.params.module}`
    case 'view.subscribe':
      return `subscribe#${String(message.id)} ${message.params.source}`
    case 'view.unsubscribe':
      return `unsubscribe#${String(message.id)} of ${String(message.params.subscription)}`
    case 'sessionMarks.add':
      return `mark#${String(message.id)} at ${String(message.params.at)}`
    // THE ROW AND NOTHING ELSE, and the description carries no instant because the command does
    // not: a confirm re-bases onto the row's own `seenTs`, which is a LOG timestamp the fold
    // already holds. A mark's whole point is the caller's clock; this one's is the caller's ROW.
    case 'respawn.confirmSighting':
      return `confirm#${String(message.id)} ${message.params.rowId}`
    default: {
      const unreachable: never = message
      throw new Error(`unhandled client message ${JSON.stringify(unreachable)}`)
    }
  }
}
