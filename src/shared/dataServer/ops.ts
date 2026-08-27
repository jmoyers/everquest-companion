// THE CLOSED REGISTRY, APP SIDE (JOS-468) — which result shape belongs to which op, and the one
// error type a caller of this client ever sees.
//
// The schema states the rule and refuses to restate it on the wire: a reply carries no op of its
// own, because the op of the REQUEST whose id it names is what decides the result shape (a reply
// that repeated its own op would be a second place for the two to disagree). That rule is not
// expressible in the generated types — `ReplyResult` is a bare union there — so this file is where
// it becomes one, and `OpsAreExhaustive` makes a new op in `protocol/schema/` a compile error here
// until somebody writes down what it answers with.
//
// PARAMS ARE DERIVED, NEVER RESTATED. `ParamsFor` reads them straight off the wire union, so only
// the result side of the registry can drift at all.

import type { ClientMessage, ErrorCode, Hello, ReplyResult, RequestId } from './protocol.generated'
import type {
  AttachResult,
  CombatSearchFightsResult,
  CombatSnapshotResult,
  DefineAck,
  EchoResult,
  HealthResult,
  KnowledgeResult,
  KnowledgeSearchResult,
  LogsListResult,
  ModuleSnapshotResult,
  PerfBudgetsResult,
  PerfSnapshotResult,
  PerfTimelineResult,
  ResistLevelsResult,
  ResistSpellResult,
  RespawnConfirmAck,
  SessionMarkAck,
  SpellsSearchResult,
  SubscribeAck
} from './protocol.generated'

interface ResultRegistry {
  echo: EchoResult
  'session.attach': AttachResult
  'session.health': HealthResult
  'session.progress': SubscribeAck
  'module.snapshot': ModuleSnapshotResult
  'perf.snapshot': PerfSnapshotResult
  // SURFACE 8's OTHER TWO OPS (ruling 19, JOS-502). Three perf ops and three shapes, and the
  // reason they are not one op with three sections is lifetime: a budget verdict is a judgement
  // about the whole generation and changes rarely, the timeline moves on every beat, and the
  // snapshot's totals are what both of the others are derived from. A panel wants them at three
  // different rates, and a client that had to refetch a thirty-moment ring to re-read a verdict
  // would pay the largest payload for the smallest answer.
  'perf.budgets': PerfBudgetsResult
  'perf.timeline': PerfTimelineResult
  'view.subscribe': SubscribeAck
  'view.unsubscribe': SubscribeAck
  // THE FIVE `*.define` COMMANDS (JOS-482) SHARE ONE ANSWER, and the registry says so once per op
  // rather than collapsing them into a wildcard: the whole point of this file is that a NEW op
  // cannot compile until somebody writes down what it answers with, and five ops that happen to
  // agree today are still five entries.
  'alerts.define': DefineAck
  'buffTrust.define': DefineAck
  'respawn.define': DefineAck
  'combo.define': DefineAck
  'roster.define': DefineAck
  // THE ONE COMMAND WHOSE ANSWER IS NOT AN ACKNOWLEDGEMENT (JOS-487, boundary verdict 6). A define
  // always applies; a mark can be REFUSED while the fold is still replaying, and the caller has to
  // branch on it — `pressNewSession`'s "both halves or neither" is exactly that branch.
  'sessionMarks.add': SessionMarkAck
  // THE SECOND COMMAND, AND THE SECOND ANSWER THAT IS NOT AN ACKNOWLEDGEMENT (JOS-494). A confirm
  // re-bases one clock or does nothing at all, and the two are as different to a reader of the dev
  // log as a taken mark is from a refused one — so it gets its own shape rather than borrowing
  // `DefineAck`, whose `applied` six ops already mean.
  'respawn.confirmSighting': RespawnConfirmAck
  // THE COMBAT SURFACE (JOS-485). Two ops and two shapes: the meter's whole state, and a ranked
  // answer to a search box. Neither is a `view.*` — one is the app's own `combat:snapshot` IPC
  // moved server-side, the other is a question rather than a window — and the third surface the
  // ticket adds, `combat.live`, is a view SOURCE and therefore not an op at all.
  'combat.snapshot': CombatSnapshotResult
  'combat.searchFights': CombatSearchFightsResult,
  // THE KNOWLEDGE SURFACE (JOS-486). Three lookups share one result shape and that is the shape
  // being right rather than the registry being lazy: `KnowledgeResult` names its own `domain`, so a
  // caller holding an item card and a mob card can tell them apart from the value alone — which is
  // what the five `*.define` ops CANNOT do with `DefineAck`, and why they are five entries too.
  'knowledge.item': KnowledgeResult
  'knowledge.mob': KnowledgeResult
  'knowledge.spell': KnowledgeResult
  'knowledge.search': KnowledgeSearchResult
  // …and the push-back reuses `DefineAck`, because it IS a define: one entry taken, `applied` true,
  // and no `count`, which the schema already says is what a non-list payload answers with.
  'knowledge.define': DefineAck
  // THE LAST SYNCHRONOUS FOLD READ IN MAIN (JOS-497 item 1, cutover ledger item 6). Its own shape
  // rather than a `KnowledgeResult`, and the reason is the guard matrix below rather than taste: a
  // level fact is not a knowledge CARD — it carries no `record`, has no `domain`, and answers for a
  // list — so borrowing that shape would have made a fourth arm nothing could separate from three
  // others by value alone.
  'resist.levels': ResistLevelsResult
  // THE CLIENT'S OWN SPELL TABLE, PER SPELL (boundary verdict 7, JOS-497 item 3). A `resist.*` op
  // rather than an extension of `knowledge.spell` because the two answer about different SOURCES:
  // that one serves the committed wiki scrape with removals, corrections and derived durations
  // applied, and this serves Daybreak's `spells_us.txt`. A caller asking "how is this resisted" and
  // one asking "what does the wiki say" must be able to tell which answered, and one merged record
  // would make that unanswerable from the value — the same argument that keeps the five `*.define`
  // ops five entries.
  'resist.spell': ResistSpellResult
  // THE SAME TABLE, ASKED A DIFFERENT KIND OF QUESTION (JOS-507). `resist.spell` answers about ONE
  // spell's mechanics; this answers about the table as a CATALOGUE — what exists, filed under what,
  // learnable by whom and when. It is a `spells.*` op rather than a third `resist.*` one for that
  // reason, and it is not `knowledge.search`, which ranks the committed wiki scrape and knows
  // nothing about the client's categories at all. Its own shape, because a windowed list with facets
  // beside it shares no field with any of the three.
  'spells.search': SpellsSearchResult
  // LOG DISCOVERY (owner ruling 21, decision sheet 1a — JOS-498). A COMMAND AND A QUERY, and the
  // command answers with the ack six ops already share: `logs.setDir` pushes one directory, which is
  // not a list, so there is nothing per-family to report back and `DefineAck` is exactly right. It
  // is written down as its own entry for the reason every shared shape here is — five ops that agree
  // today are still five entries, because the point of this file is that a NEW op cannot compile
  // until somebody says what it answers with.
  'logs.setDir': DefineAck
  'logs.list': LogsListResult
}

/** Every client message that carries a request id — i.e. everything except the handshake. */
export type RequestMessage = Exclude<ClientMessage, Hello>
/** Every op that can be requested. */
export type RequestOp = keyof ResultRegistry
/** The params the schema gives that op. */
export type ParamsFor<O extends RequestOp> = Extract<RequestMessage, { op: O }>['params']
/** The result the registry gives that op. */
export type ResultFor<O extends RequestOp> = ResultRegistry[O]

/** Compile-time pin, both directions: the registry names every op the schema has, and no other. */
export type OpsAreExhaustive = [Exclude<RequestMessage['op'], RequestOp>] extends [never]
  ? [Exclude<RequestOp, RequestMessage['op']>] extends [never]
    ? true
    : false
  : false
export const OPS_ARE_EXHAUSTIVE: OpsAreExhaustive = true

/**
 * One discriminating field per result shape. The registry is a CLAIM about what the engine answers
 * with; this is the cheapest possible check that it kept its side of it. A reply whose shape the op
 * does not own becomes an `internal` failure rather than a value handed to a caller who is about to
 * read a field that is not there.
 */
export const RESULT_GUARDS: Record<RequestOp, (result: ReplyResult) => boolean> = {
  echo: (r) => 'text' in r,
  // `accepted` ALONE STOPPED BEING A DISCRIMINATOR when `sessionMarks.add` arrived (JOS-487) — the
  // same thing that happened to `status` when `perf.snapshot` did, and caught the same way, by the
  // matrix in `tests/dataServerOps.test.mts` rather than by a caller reading a field that was not
  // there. Two ops now answer with an `accepted` flag, and what separates them is that an attach
  // names the GENERATION it created while a mark creates none.
  'session.attach': (r) => 'accepted' in r && 'epoch' in r,
  // `status` ALONE STOPPED BEING A DISCRIMINATOR when `perf.snapshot` arrived (JOS-483): that
  // result restates the five facts health gives, `status` among them, and neither shape has a
  // required field the other lacks. So the guard names what health is NOT — it carries no serve
  // table — which is the smallest true statement that separates the two. A guard both arms pass is
  // a guard that cannot tell them apart, and the matrix in `tests/dataServerOps.test.mts` is what
  // caught this rather than a caller reading a field that was not there.
  //
  // AND `status` ALONE GOT WEAKER AGAIN with `sessionMarks.add` (JOS-487), which carries the same
  // five-member status so that a REFUSAL can say what it was refusing under. Three arms now carry
  // that field, so the positive half of this guard moved to `uptimeMs` — the fact only a question
  // ABOUT THIS PROCESS has an answer to — and the negative half still separates it from perf's.
  // Twice in two tickets is a pattern worth naming: `status` is a value, not an identity.
  'session.health': (r) => 'uptimeMs' in r && !('serve' in r),
  'session.progress': (r) => 'subscribed' in r,
  // `module` rather than `state`: it is the field no other arm carries, and it is the one a caller
  // reads first anyway. `state` would be a weaker guard for the same cost — the schema lets it be
  // any JSON at all, including a value `in` cannot be asked about meaningfully.
  'module.snapshot': (r) => 'module' in r,
  // `serve` rather than `status`: `session.health` already owns `status`, and a guard that two
  // arms of the registry both pass is a guard that cannot tell them apart. `serve` is required by
  // the schema and carried by no other result shape.
  'perf.snapshot': (r) => 'serve' in r,
  // `budgets` and `timeline` — each op's OWN WORD, picked the way `confirmed`, `levels` and
  // `characters` were rather than found to be free (JOS-502). The tempting picks were the generic
  // ones a later shape is most likely to want too — `epoch` (which four arms already carry) and
  // `capacity` — and the matrix has now caught that mistake twice, on `hits` and on `status`.
  //
  // AND THE SCHEMA HAD TO GIVE WAY FOR THESE TO BE ONE-FIELD GUARDS AT ALL. `PerfSnapshotResult`
  // restates five of `HealthResult`'s facts, which is what forced health's guard down to
  // `'uptimeMs' in r && !('serve' in r)`; a budgets result that had restated `uptimeMs` in the same
  // spirit would have been a THIRD arm that guard could not refuse, and the negation would have had
  // to grow a second clause naming a shape it has nothing to do with. So these two results carry
  // the epoch (a budget verdict is a fact about ONE generation) and deliberately not the uptime.
  // The schema says so where it is decided; this is the reader that would have paid for it.
  'perf.budgets': (r) => 'budgets' in r,
  'perf.timeline': (r) => 'timeline' in r,
  'view.subscribe': (r) => 'subscribed' in r,
  'view.unsubscribe': (r) => 'subscribed' in r,
  // `applied` is the field no other arm carries — `count` would be a weaker guard, because it is
  // absent for the two families whose payload is one object rather than a list.
  'alerts.define': (r) => 'applied' in r,
  'buffTrust.define': (r) => 'applied' in r,
  'respawn.define': (r) => 'applied' in r,
  'combo.define': (r) => 'applied' in r,
  'roster.define': (r) => 'applied' in r,
  // `accepted` IS SHARED WITH `AttachResult`, so the guard names what a mark ack is NOT — it carries
  // no epoch. Same reasoning as `session.health`'s: a guard both arms pass cannot tell them apart,
  // and the matrix in `tests/dataServerOps.test.mts` is what would catch it if it did.
  'sessionMarks.add': (r) => 'accepted' in r && !('epoch' in r),
  // `confirmed` — A WORD NO OTHER ARM CARRIES, and chosen for that rather than found to be free.
  // The two collisions above are the whole argument: `applied` would have made this a seventh
  // member of the define family and separable from none of them, and `accepted` is already two
  // arms deep. A one-field result has exactly one chance to be discriminating, so the field is
  // named after what the act is called (`confirmSighting`, `respawn-confirm-sighting`) rather than
  // after the generic shape of an ack.
  'respawn.confirmSighting': (r) => 'confirmed' in r,
  // `snapshot` rather than `now`: the payload is the field this result exists for, and a name as
  // generic as `now` is the one a later result shape is most likely to want too. The lesson is
  // JOS-483's — a guard is only worth its line if no other arm can pass it — and `status` losing its
  // discriminating power the moment `perf.snapshot` restated it is what taught it.
  'combat.snapshot': (r) => 'snapshot' in r,
  // `corpus`, NOT `hits` — the integration lesson two parallel workers taught the matrix: both the
  // fight search and the knowledge search reached for `hits` independently, and the matrix caught
  // the collision at merge. `corpus` is this shape's own word and no other arm carries it.
  'combat.searchFights': (r) => 'corpus' in r,
  // `record` rather than `found`: it is the field no other arm carries, and a boolean guard would
  // read `false` as "wrong shape" if `in` were ever swapped for a truthiness test by a later hand.
  'knowledge.item': (r) => 'record' in r,
  'knowledge.mob': (r) => 'record' in r,
  'knowledge.spell': (r) => 'record' in r,
  // `query` — same collision, same lesson: `hits` stopped discriminating the moment two searches
  // existed. The query echo is required by the schema and carried by no other shape.
  'knowledge.search': (r) => 'query' in r,
  'knowledge.define': (r) => 'applied' in r,
  // `levels` — this shape's own word, and chosen the way `confirmed` was rather than found to be
  // free. The two collisions the matrix has already caught (`hits`, `status`) both happened to
  // fields named after a GENERIC role; `levels` is named after what the op is called, no other arm
  // carries it, and the schema requires it even when it is empty — which matters, because "nothing
  // states a level for any of these creatures" is a real answer here and must not read as a wrong
  // shape.
  'resist.levels': (r) => 'levels' in r,
  // `table` — the field that is on EVERY answer this op gives, which is the property a guard needs
  // and the one `spell` does not have: a miss and a missing file both carry no `spell`, and both
  // are real answers rather than wrong shapes. Same lesson as `knowledge.item`'s `record` over its
  // `found`, reached from the other direction.
  'resist.spell': (r) => 'table' in r,
  // `spells` — this shape's own word, and the reason the RESULT calls its state field `spellTable`
  // rather than `table`. `resist.spell` above owns the bare `table`, and a second arm carrying that
  // field would have made this the shape that guard could no longer refuse: the exact failure the
  // matrix has now caught four times (`status`, `accepted`, `hits`, and this one at design time).
  // So the schema gave way instead, which is what `perf.budgets` did when it declined to restate
  // `uptimeMs`. The field is required even when it is EMPTY — a filter that excludes everything is a
  // real answer here and must not read as a wrong shape.
  'spells.search': (r) => 'spells' in r,
  // `applied` — the push joins the ack family, and the guard says so rather than pretending
  // otherwise. `logs.setDir` carries ONE DIRECTORY and therefore no `count`, which is the same
  // answer `buffTrust.define` and `respawn.define` give, so no field could separate it from the six
  // and a guard that claimed to would be a guard that lies (`knowledge.define`'s reasoning exactly).
  'logs.setDir': (r) => 'applied' in r,
  // `characters` — this shape's own word, chosen the way `confirmed` and `levels` were rather than
  // found to be free. `dir` would have been the tempting pick and is the weaker one for the reason
  // the matrix has now caught twice (`hits`, `status`): it is named after a GENERIC role that a
  // later result shape is likely to want too. `characters` is what the op is FOR, no other arm
  // carries it, and the schema requires it even when it is empty — which matters here, because "this
  // install has no character logs" is a real answer and must not read as a wrong shape.
  'logs.list': (r) => 'characters' in r
}

/**
 * Why a request or a subscription failed. `code` is what a caller branches on — the message is for
 * a log line and a bug report, never for parsing.
 *
 * The codes are the schema's own closed set, and this client borrows two of them for failures that
 * happen on THIS side of the wire: `unavailable` for a connection that is gone, replaced or closed
 * (with the underlying `TransportError` kept as `cause`), and `protocolMismatch` for a handshake
 * whose versions disagree. One rejection type for every caller is worth more than a second error
 * class that means "and this one came from us".
 */
export class EngineError extends Error {
  constructor(
    readonly code: ErrorCode,
    message: string,
    readonly requestId?: RequestId,
    readonly cause?: unknown
  ) {
    super(message)
    this.name = 'EngineError'
  }
}
