// THE SHIPPED APP LAUNCHES NO PROCESSES AT ALL (JOS-182 + JOS-184).
//
// Two tickets, one week, the same defect wearing two costumes. The presence watcher was a hidden
// `powershell.exe` (`-ExecutionPolicy Bypass -EncodedCommand <base64>`) that compiled C# at
// runtime and enumerated every process on the machine; EQ-folder discovery shelled out to
// `reg.exe query … /s /f EverQuest` eight times and to `wmic logicaldisk`. To a behavioural
// antivirus engine each of those is a paragraph of an infostealer's résumé, and between them they
// made this app the most-flagged thing its author had ever shipped. They also simply DID NOT WORK
// on locked-down machines — hundreds of installs' worth of `ENOENT` — where the features they
// served were silently dead for every session.
//
// Both were replaced by native code called IN PROCESS, which is what every other Windows program
// does to ask the same questions. What is left is one property, and it is a property of the whole
// source tree rather than of any module, so this file reads the tree:
//
//   ** NOTHING UNDER src/ MAY START A PROCESS. **
//
// It is a guard rather than a note because the pressure to add "just one `execFileSync`" never
// goes away — the next Windows fact somebody needs will have a one-line command-line answer and a
// twenty-line native one, and this file is where that trade is forced into the open. If a future
// ticket genuinely needs to launch something, it adds itself to `SPAWNERS` below with its reason
// in the same breath.
//
// `tests/presence.test.mts` pins what the presence watcher DOES and `tests/presenceWorker.test.mts`
// runs it; neither can see this, because neither reads a file it did not import.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'

const SRC_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', 'src')

/**
 * THE ONE EXEMPTION, and it is prose rather than a loophole.
 *
 * `shared/releaseNotes.ts` is the app's own history, rendered in the What's-new panel. The release
 * that removed the PowerShell watcher has to be able to SAY so — a note that cannot name the thing
 * it took away is a note that explains nothing to the player whose antivirus was shouting at them.
 * Nothing in that module is executable in any sense; it is a list of sentences.
 */
const NOT_CODE = new Set(['shared/releaseNotes.ts'])

/** A path relative to src/, spelled the same way on every platform. */
function key(file: string): string {
  return relative(SRC_ROOT, file).replace(/\\/g, '/')
}

/** Every .ts/.tsx under src/, recursively. */
function sourceFiles(dir: string): string[] {
  const out: string[] = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) out.push(...sourceFiles(full))
    else if (/\.tsx?$/.test(entry.name)) out.push(full)
  }
  return out
}

/** The text of every string literal and template chunk in a file — i.e. what the program can say,
 *  as opposed to what its author wrote about. */
function literalText(file: string): string[] {
  const src = ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true)
  const found: string[] = []
  const visit = (node: ts.Node): void => {
    if (
      ts.isStringLiteral(node) ||
      ts.isNoSubstitutionTemplateLiteral(node) ||
      ts.isTemplateHead(node) ||
      ts.isTemplateMiddle(node) ||
      ts.isTemplateTail(node)
    ) {
      found.push(node.text)
    }
    ts.forEachChild(node, visit)
  }
  visit(src)
  return found
}

test('NO SHIPPED CODE CAN NAME POWERSHELL — the watcher launches nothing at all now', () => {
  const files = sourceFiles(SRC_ROOT)
  assert.ok(files.length > 100, 'the walk found the tree, or this test proves nothing')
  const offenders: string[] = []
  let exempted = 0
  for (const file of files) {
    if (NOT_CODE.has(key(file))) {
      exempted++
      continue
    }
    for (const text of literalText(file)) {
      if (/powershell|pwsh/i.test(text)) {
        offenders.push(`${key(file)}: ${JSON.stringify(text.slice(0, 80))}`)
      }
    }
  }
  assert.deepEqual(offenders, [], 'a string literal names PowerShell')
  // The exemption must still be REACHED, or a rename would silently turn it into a second guard
  // over nothing while looking exactly as green as it does today.
  assert.equal(exempted, NOT_CODE.size, 'every exempt file is still there to be exempted')
})

/**
 * The one module allowed to launch a process, and it is not in a shipped build.
 *
 * `src/main/triage/store.ts` runs `terraform output -json` for the operator's backlog client. It
 * is reached only through a dynamic import gated on `!app.isPackaged`, and its dependencies are
 * devDependencies that electron-builder never installs — so in a packaged app the require cannot
 * resolve at all. That is a property of the PACKAGING, not a promise about a boolean, and it is
 * spelled out at the `externalizeDeps` line in electron.vite.config.ts.
 */
const SPAWNERS = new Set(['main/triage/store.ts'])

/** Every module specifier a file imports or re-exports. */
function importSpecifiers(file: string): string[] {
  const src = ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true)
  const out: string[] = []
  const visit = (node: ts.Node): void => {
    const spec =
      (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier
        ? node.moduleSpecifier
        : ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword
          ? node.arguments[0]
          : undefined
    if (spec !== undefined && ts.isStringLiteral(spec)) out.push(spec.text)
    ts.forEachChild(node, visit)
  }
  visit(src)
  return out
}

test('NOTHING UNDER src/ CAN START A PROCESS — one exemption, and it never ships', () => {
  const files = sourceFiles(SRC_ROOT)
  const offenders: string[] = []
  let exempted = 0
  for (const file of files) {
    const name = key(file)
    // Both spellings: `child_process` and the `node:` prefix the tree is migrating towards.
    const spawns = importSpecifiers(file).filter((spec) => /^(node:)?child_process$/.test(spec))
    if (spawns.length === 0) continue
    if (SPAWNERS.has(name)) {
      exempted++
      continue
    }
    offenders.push(`${name}: ${spawns.join(', ')}`)
  }
  assert.deepEqual(offenders, [], 'a module imports a child-process API')
  // The exemption must still be REACHED. Without this, deleting the triage client would leave a
  // guard standing over nothing, looking exactly as green as it does today.
  assert.equal(exempted, SPAWNERS.size, 'every exempt module is still there to be exempted')
})
