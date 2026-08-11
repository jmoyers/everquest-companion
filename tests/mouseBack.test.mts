// Pure unit tests for THE MOUSE'S BACK BUTTON (JOS-201) — both halves of it, neither needing a
// DOM, a log or an Electron.
//
// The feature is three pieces: a main-process predicate deciding which `app-command` means "back"
// (src/main/appBack.ts), a renderer rule deciding what "back" means where the reader is standing
// (src/renderer/src/backTargets.ts), and a React seam bolting them together (appBack.tsx, covered
// by tests/e2e/deep-link-back.e2e.mts because a subscription and a mount order are not things a
// pure test can see). What is pinned here is exactly what could quietly rot:
//   1. the command list stays CLOSED — `app-command` carries dozens of shell/media verbs and this
//      app answers one of them, so a substring test or a widened set is a regression, not a
//      convenience;
//   2. `browser-forward` is NOT handled, which is a decision (the app has no forward stack) rather
//      than an omission;
//   3. the innermost registered affordance wins, because that is what a reader means by "back";
//   4. a target that reports it did nothing FALLS THROUGH instead of swallowing the press — the
//      same boolean contract JOS-43's `NavBack.back()` owes its callers;
//   5. unregistering is BY ID, so two live affordances retiring out of order cannot leave a dead
//      closure holding the button;
//   6. with nothing registered and nothing parked, a press is a no-op that says so.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { isBackCommand } from '../src/main/appBack'
import { addTarget, removeTarget, runBack, type BackTarget } from '../src/renderer/src/backTargets'

test('only browser-backward is the Back button', () => {
  assert.equal(isBackCommand('browser-backward'), true)
  // The rest of what Windows can raise on this event. None of them navigate this app.
  for (const cmd of [
    'browser-forward',
    'browser-refresh',
    'browser-stop',
    'browser-search',
    'browser-favorites',
    'browser-home',
    'media-play-pause',
    'media-nexttrack',
    'volume-mute',
    'volume-up',
    'app-left',
    ''
  ]) {
    assert.equal(isBackCommand(cmd), false, cmd)
  }
})

test('the command match is exact — no substring, no case folding', () => {
  assert.equal(isBackCommand('Browser-Backward'), false)
  assert.equal(isBackCommand('xbrowser-backward'), false)
  assert.equal(isBackCommand('browser-backwards'), false)
})

/** A target that records it ran and reports whether it handled the press. */
function spy(id: number, handled: boolean, log: number[]): BackTarget {
  return {
    id,
    run: () => {
      log.push(id)
      return handled
    }
  }
}

test('the innermost registered affordance wins', () => {
  const log: number[] = []
  const stack = addTarget(addTarget([], spy(1, true, log)), spy(2, true, log))
  assert.equal(
    runBack(stack, () => {
      log.push(-1)
      return true
    }),
    true
  )
  // Only the top ran: the outer affordance and the app-level fallback were never asked.
  assert.deepEqual(log, [2])
})

test('a target that handled nothing falls through to the next, then to the fallback', () => {
  const log: number[] = []
  const stack = addTarget(addTarget([], spy(1, false, log)), spy(2, false, log))
  assert.equal(
    runBack(stack, () => {
      log.push(-1)
      return true
    }),
    true
  )
  assert.deepEqual(log, [2, 1, -1])
})

test('with nothing on screen, the app-level fallback is the whole answer', () => {
  const log: number[] = []
  assert.equal(
    runBack([], () => {
      log.push(-1)
      return true
    }),
    true
  )
  assert.deepEqual(log, [-1])
})

test('a press with nowhere to go is a no-op that reports itself as one', () => {
  assert.equal(
    runBack([], () => false),
    false
  )
})

test('unregistering is by id, so affordances retiring out of order retire the right one', () => {
  const log: number[] = []
  let stack = addTarget(addTarget([], spy(1, true, log)), spy(2, true, log))
  // The OUTER one leaves first (a tab switch under an open dialog): the inner must survive.
  stack = removeTarget(stack, 1)
  assert.deepEqual(
    stack.map((t) => t.id),
    [2]
  )
  runBack(stack, () => false)
  assert.deepEqual(log, [2])
  // And retiring an id that is already gone changes nothing.
  assert.deepEqual(removeTarget(removeTarget(stack, 2), 2), [])
})

test('the stack functions never mutate the array they were handed', () => {
  const log: number[] = []
  const before: BackTarget[] = [spy(1, true, log)]
  addTarget(before, spy(2, true, log))
  removeTarget(before, 1)
  assert.deepEqual(
    before.map((t) => t.id),
    [1]
  )
})
