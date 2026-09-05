// ============================================================================
// eslint.domainMunging.mjs — OWNER RULING 4, AS A RULE THAT FAILS THE BUILD.
// ============================================================================
//
// Ruling 4 (docs/plans/data-server.md, 2026-08-24), verbatim:
//
//   > **The renderer never munges domain data.** No list filter/sort/aggregation client-side;
//   > views arrive filtered, sorted, windowed, render-ready. Enforce by protocol shape, payload
//   > budgets, and a lint rule failing builds on `.sort()`/`.filter()` over domain collections in
//   > renderer code.
//
// This is that rule. It is the SECOND of the two boundary laws the engine program promised on day
// one — the first being the engine's own CI budgets (`engine/crates/engined/tests/budget.rs`) — and
// the two are deliberately the same shape: a law the architecture rests on, enforced by something
// that goes red, rather than by everybody remembering.
//
// ---------------------------------------------------------------------------------------------
// WHAT COUNTS AS DOMAIN DATA, AND HOW THIS DECIDES
// ---------------------------------------------------------------------------------------------
// The ticket's definition: **served rows and engine-derived collections — not UI state.** A list of
// open tabs may sort itself; a list of loot rows may not.
//
// The discriminator is the ELEMENT TYPE'S DECLARATION SITE, read through TypeScript's own checker
// (the config already runs type-aware, so the program is there). An array whose element type is
// declared in one of the DOMAIN_MODULES below is domain data; everything else is not. That choice
// is worth defending against the two obvious alternatives:
//
//   * BY VARIABLE NAME (`rows`, `items`) — defeated by a rename, and it would fire on
//     `const rows = tabs.map(...)`. A lint rule that can be silenced by renaming a variable teaches
//     renaming variables.
//   * BY CALL-SITE ORIGIN (does this value flow from `useView`?) — correct in principle and
//     defeated in practice by one destructure or one helper function. The renderer passes rows
//     through five layers of props before anything sorts them, and a rule that could not see
//     through a prop boundary would miss almost every real site.
//
// A TYPE, by contrast, survives renames, props, destructuring and helper functions — which is
// exactly the set of hops the real violations take between the engine and the `.sort()`.
//
// THE REGISTRY IS EXPLICIT, AND IT IS AUDITED. `DOMAIN_MODULES` is a hand-written list, which is a
// duplicate of a fact that lives elsewhere and therefore able to rot. `tests/domainMunging.test.mts`
// re-derives the domain surface and fails when a module that serves rows is missing from it — the
// same shape as the audits in `tests/alertTargetToken.test.mts` and
// `tests/breadcrumbVocabulary.test.mts`. A duplicated list is fine when something compares it
// against the thing it duplicates.
//
// ---------------------------------------------------------------------------------------------
// WHICH METHODS, AND — LOUDLY — WHICH NOT
// ---------------------------------------------------------------------------------------------
// FLAGGED: `.sort`, `.filter`, `.reduce`, `.flatMap`. These are the ruling's own three words —
// filter, sort, aggregation — with `flatMap` beside `reduce` because it is how this codebase spells
// half its aggregations.
//
// NOT FLAGGED: `.slice()`, and the omission is a judgement rather than an oversight. The ruling says
// views arrive "windowed", and they do: a descriptor carries `{offset, limit}` and the engine cuts
// the window. What `.slice()` overwhelmingly does in this renderer is VIRTUALISATION — clipping an
// already-windowed list to the rows a scroll box can paint — and that is render geometry, not a
// query. `src/main/dataServer/README.md` makes the same distinction in prose ("the ledger
// virtualizes; it does not page"). Flagging it would put ~70 entries in the register that say
// nothing about the boundary, and burying a law in noise is how a law stops being read.
//
// NOT FLAGGED: `.map()`. A projection is what a renderer is FOR. `rows.map(toRow)` is rendering;
// `rows.reduce(...)` is deriving.
//
// ---------------------------------------------------------------------------------------------
// THE ALLOWLIST, AND WHY IT IS NOT A RATCHET
// ---------------------------------------------------------------------------------------------
// Every exemption is an INLINE disable with a STATED REASON, and the rule refuses a bare one:
//
//     // eslint-disable-next-line eqc/no-domain-munging -- JOS-NNN: <why>
//
// A file-level register (the shape `eslint.ratchet.mjs` uses for the factoring rules) was the
// obvious move and is deliberately not what this is. The ratchet answers "this FILE is too big",
// which is a fact about a file; this rule answers "this EXPRESSION re-derives served data", which
// is a fact about one line and has a different answer on the next line down. An exemption that
// covered a whole file would silently cover the next violation somebody added to it — which is the
// one thing a boundary law must never do.
//
// ZERO SILENT EXEMPTIONS is enforced mechanically twice over: `reportUnusedDisableDirectives` is
// already `error` in the flat config, so an exemption that stops being needed fails the build; and
// this rule's own `requireReason` option (on) makes a disable comment with no `--` reason itself a
// violation.

/**
 * Files whose exported TYPES describe domain data. See the header for why this is a type test.
 *
 * THE SHARED MODEL LAYER WHOLESALE, and the bundled corpora beside it. `src/shared/` is where this
 * app puts everything both processes agree about, so it is the boundary domain data crosses on its
 * way to a renderer — which is exactly the crossing ruling 4 is about.
 */
const DOMAIN_MODULES = ['src/shared/', 'src/renderer/src/data/eqlegends/']

/**
 * …EXCEPT THESE, which live in `src/shared/` for a different reason and are not game domain data.
 *
 * MEASURED, not imagined: running this rule with `src/shared/` wholesale reported 107 sites, and
 * reading them found three families that are the renderer's own business by anybody's reading of
 * the ruling —
 *
 *   * **user configuration.** An `AlertDef` is a rule the USER wrote and the app persists; the
 *     alerts editor filtering its own list is a settings screen filtering settings. The engine
 *     serves alert FIRES, not alert definitions — definitions travel the other way, pushed in as a
 *     `*.define` command (boundary verdict 3), so there is no view for the renderer to have asked
 *     for instead.
 *   * **diagnostics about the app itself.** Perf rows, telemetry, feedback and the triage tab's
 *     release health are measurements OF the app, not data the fold produces. They are also
 *     owner-tools-gated and never on a user's screen.
 *   * **presentation and window state** — scale, toasts, overlays, update channels.
 *
 * Sweeping these in would have put a third of the register's entries on lines that have nothing to
 * do with the boundary, and a law whose examples are mostly false positives stops being read. The
 * carve-out is a LIST rather than a pattern so that adding to it is a visible decision.
 */
const NOT_DOMAIN_MODULES = [
  // user configuration, pushed to the engine rather than served by it
  'src/shared/alertTypes.ts',
  'src/shared/alertGroups.ts',
  'src/shared/alertCaptures.ts',
  'src/shared/alertTargets.ts',
  'src/shared/alertBanner.ts',
  'src/shared/buffAllow.ts',
  'src/shared/buffTrust.ts',
  'src/shared/soundPacks.ts',
  'src/shared/userSounds.ts',
  'src/shared/speechText.ts',
  'src/shared/graphicsPrefs.ts',
  'src/shared/uiScale.ts',
  'src/shared/closeToTray.ts',
  'src/shared/update.ts',
  'src/shared/toast.ts',
  'src/shared/xpOverlay.ts',
  'src/shared/itemOverrides.ts',
  'src/shared/shareSchema.ts',
  'src/shared/shareMerge.ts',
  // diagnostics ABOUT the app, not data the fold produced
  'src/shared/triage.ts',
  'src/shared/feedback.ts',
  'src/shared/feedbackAttachments.ts',
  'src/shared/feedbackPerf.ts',
  'src/shared/feedbackPerfSeams.ts',
  'src/shared/enginePerf.ts',
  'src/shared/errorReport.ts',
  'src/shared/errorReportLocation.ts',
  'src/shared/analyticsSchema.ts',
  'src/shared/dataWeight.ts',
  'src/shared/audioFailureLog.ts',
  'src/shared/devRestart.ts',
  'src/shared/perf.ts',
  // committed CONTENT rather than folded data: the changelog the What's New panel renders
  'src/shared/releaseNotes.ts'
]

/**
 * …and two types that live in an otherwise-domain module.
 *
 * `respawn.ts` is domain (the engine folds respawn windows and serves `respawn.watches`), but
 * `RespawnWatchPref` in the same file is the USER'S list of what to watch — a preference pushed
 * into the engine, not a row served out of it. Excluding by module would have taken the real
 * respawn rows with it, so the exception is by NAME, which is narrow and visible.
 */
const NOT_DOMAIN_TYPES = ['RespawnWatchPref']

/** The methods ruling 4 names, plus the one this codebase spells aggregations with. */
const MUNGERS = new Set(['sort', 'filter', 'reduce', 'flatMap'])

/** Normalise a path so the comparison is separator-blind — `node:path` is not available here. */
const norm = (p) => p.replace(/\\/g, '/')

/**
 * Does this type's declaration live in a domain module?
 *
 * WALKS UNIONS AND ARRAYS, because the real shapes are `Row[] | null` and `readonly Loot[]`. A
 * union counts as domain if ANY arm is — `rows: Loot[] | null` is a loot list whether or not it has
 * loaded, and the whole point is to catch the sort that happens once it has.
 */
/** Is this file one of the domain modules, and not one of the carve-outs? */
function isDomainFile(file) {
  if (NOT_DOMAIN_MODULES.some((m) => file.endsWith(m))) return false
  return DOMAIN_MODULES.some((m) => file.includes(m))
}

/** Every file a type is declared in. Split out because the optional chaining a compiler API needs
 *  costs a branch apiece, and `complexity 12` counts them — this repo's own factoring law. */
function declaredIn(symbol) {
  const decls = symbol?.getDeclarations?.() ?? []
  return decls.map((d) => norm(d.getSourceFile?.().fileName ?? ''))
}

/** The arms of a union or intersection, or null when the type is neither. */
function armsOf(type) {
  const composite = type.isUnion?.() === true || type.isIntersection?.() === true
  return composite ? type.types : null
}

function isDomainType(checker, type, depth = 0) {
  if (type === undefined || depth > 4) return false
  const arms = armsOf(type)
  if (arms !== null) return arms.some((t) => isDomainType(checker, t, depth + 1))
  const symbol = type.getSymbol?.() ?? type.aliasSymbol
  if (NOT_DOMAIN_TYPES.includes(symbol?.getName?.() ?? '')) return false
  return declaredIn(symbol).some(isDomainFile)
}

/**
 * The element type of an array-ish type, or undefined when it is not a list at all.
 *
 * TYPE ARGUMENTS FIRST, and `getNumberIndexType` only as the fallback — which is the opposite of
 * the obvious order and was arrived at by MEASUREMENT. Against this tree's real receivers
 * (`FlatSkill[]`, `SegmentSummary[]`, `readonly Loot[]`) `getNumberIndexType` answered `undefined`
 * for every one of them, so the first draft of this rule reported nothing at all and looked exactly
 * like a clean tree. `getTypeArguments` on the `Array<T>` reference answers correctly for all of
 * them. The fallback stays for the shapes it does cover (index signatures, some tuples).
 */
function elementOf(checker, type) {
  if (type === undefined) return undefined
  if (type.isUnion?.()) {
    for (const arm of type.types) {
      const el = elementOf(checker, arm)
      if (el !== undefined) return el
    }
    return undefined
  }
  const args = checker.getTypeArguments?.(type) ?? []
  if (args.length === 1) return args[0]
  return checker.getNumberIndexType?.(type) ?? undefined
}

/** @type {import('eslint').Rule.RuleModule} */
const noDomainMunging = {
  meta: {
    type: 'problem',
    docs: {
      description:
        'Owner ruling 4: the renderer never filters, sorts or aggregates domain data — views arrive render-ready.'
    },
    schema: [
      {
        type: 'object',
        properties: { requireReason: { type: 'boolean' } },
        additionalProperties: false
      }
    ],
    messages: {
      munged:
        'RULING 4: `.{{method}}()` over domain data ({{what}}). Views arrive filtered, sorted and windowed — ' +
        'move this into the view descriptor the engine answers, or exempt the line with a stated reason: ' +
        '`// eslint-disable-next-line eqc/no-domain-munging -- JOS-NNN: why`.',
      reasonless:
        'An exemption from ruling 4 must SAY WHY. Write `-- JOS-NNN: <reason>` after the rule name; a silent ' +
        'exemption is the thing this law exists to prevent.'
    }
  },

  create(context) {
    const services = context.sourceCode.parserServices
    // NO PROGRAM, NO OPINION. `tests/**` and plain `.mjs` are `disableTypeChecked` in the flat
    // config, so this rule simply does not run there — which is correct: a test may sort whatever
    // it likes to make an assertion readable.
    if (!services?.program || !services.esTreeNodeToTSNodeMap) return {}
    const checker = services.program.getTypeChecker()

    return {
      CallExpression(node) {
        const callee = node.callee
        if (callee.type !== 'MemberExpression' || callee.computed) return
        if (callee.property.type !== 'Identifier') return
        const method = callee.property.name
        if (!MUNGERS.has(method)) return

        const tsNode = services.esTreeNodeToTSNodeMap.get(callee.object)
        if (tsNode === undefined) return
        let receiver
        try {
          receiver = checker.getTypeAtLocation(tsNode)
        } catch {
          // A type the checker cannot resolve is not evidence of a violation. Stay quiet.
          return
        }
        const element = elementOf(checker, receiver)
        if (!isDomainType(checker, element)) return

        const name = checker.typeToString?.(element) ?? 'a served row'
        context.report({
          node: callee.property,
          messageId: 'munged',
          data: { method, what: name.length > 60 ? `${name.slice(0, 57)}…` : name }
        })
      }
    }
  }
}

/**
 * THE REASON CHECK, as its own rule.
 *
 * It is separate from the rule above because it must see disable comments for a rule that did NOT
 * report — an exemption on a line that is currently fine is exactly the stale directive
 * `reportUnusedDisableDirectives` catches, and this one catches the other half: a live exemption
 * that never said why.
 */
const exemptionsStateAReason = {
  meta: {
    type: 'problem',
    docs: { description: 'A ruling-4 exemption must name its ticket or its reason.' },
    schema: [],
    messages: {
      reasonless:
        'An exemption from ruling 4 must SAY WHY: `// eslint-disable-next-line eqc/no-domain-munging -- ' +
        'JOS-NNN: <reason>`. Zero silent exemptions is the whole design.'
    }
  },
  create(context) {
    return {
      Program() {
        for (const comment of context.sourceCode.getAllComments()) {
          const text = comment.value
          if (!text.includes('eqc/no-domain-munging')) continue
          if (!/eslint-disable(-next-line|-line)?\b/.test(text)) continue
          // ESLint's own convention: everything after ` -- ` is the human's description.
          const said = text.split(' -- ')[1]?.trim() ?? ''
          if (said.length >= 8) continue
          context.report({ loc: comment.loc, messageId: 'reasonless' })
        }
      }
    }
  }
}

export const domainMungingPlugin = {
  rules: {
    'no-domain-munging': noDomainMunging,
    'munging-exemptions-state-a-reason': exemptionsStateAReason
  }
}

export { DOMAIN_MODULES, NOT_DOMAIN_MODULES, NOT_DOMAIN_TYPES, MUNGERS }
