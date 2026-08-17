// THE GEAR PLAN BOARD — persistence.
//
// The `tests/gearSetStore.test.mts` suite, for the fourth planner document. Three promises, none
// of them visible from the renderer:
//
//  1. `ProgressState.gearPlan` is ADDITIVE. No schema bump, no migration step — so a store written
//     by every build that shipped before the board must load in today's build BYTE-FOR-BYTE
//     UNCHANGED, and a store carrying a board must survive a build that has never heard of it.
//  2. The VALIDATOR is the only door. `storePlans.getGearPlan` runs it on the way out and
//     `IPC.gearPlanSet` runs it on the way in, so a valid board round-trips untouched (a fixed
//     point) and anything else is stripped field by field rather than rejected wholesale — losing
//     a user's other twenty cells to one bad socket is the failure mode.
//  3. AND THE PROMISE THIS DOCUMENT OWES THE THREE BESIDE IT. `exaltPlans` and `gearSets` are
//     RETIRED FROM THE UI AND KEPT ON DISK on an owner promise (JOS-325/JOS-326), and `wishlist`
//     is live. A store carrying all four must round-trip all four, and the three existing
//     validators must return their inputs unchanged — this file is where "additive ALONGSIDE"
//     stops being a claim in a comment.
//
// The plus-state promise comes along from the gear-set suite unchanged: a state the game cannot be
// in is CLAMPED by phase 0's own `normalizeUpgradeState`, not by a range check the validator
// invents. Tier 0 and tier 10 bank nothing; a fraction lives in 0..2^full-1.
//
// No Electron: the sanitizers are pure and `migrateStoreFile` takes a path.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CURRENT_SCHEMA_VERSION } from '../src/main/storeMigrations'
import { migrateStoreFile } from '../src/main/storeFile'
import {
  sanitizeExaltPlans,
  sanitizeGearSets,
  sanitizeGearPlan,
  sanitizeWishlist
} from '../src/main/planner/validate'
import type { GearPlan } from '../src/shared/planner/gearPlan'

const STORE = 'everquest-companion-progress.json'
const NOW = 1_754_200_000_000

/** A scratch store file, cleaned up when `fn` returns. */
function withStore(body: unknown, fn: (path: string, before: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), 'eqc-gearPlan-store-'))
  try {
    const path = join(dir, STORE)
    const text = `${JSON.stringify(body, null, 2)}\n`
    writeFileSync(path, text, 'utf8')
    fn(path, text)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

/** The shape a current build writes for a character that has never opened the gear plan tab. */
const preGearPlanStore = {
  schemaVersion: CURRENT_SCHEMA_VERSION,
  byCharacter: {
    primitive_freeport: {
      inventory: { 'rusty short sword': 2 },
      completedQuests: ['ROG::Test of Stealth'],
      combo: { corrections: [] }
    }
  },
  activeLogPath: 'C:/eq/Logs/eqlog_Primitive_freeport.txt'
}

/**
 * A fully-populated, VALID board — the fixed point the round trip must not touch. It names all
 * three kinds of cell on purpose (an ordinary slot, the second of a pair — JOS-67 — and an
 * any-slot, JOS-104) and carries a socket at every one of the four types.
 */
const goodBoard: GearPlan = {
  updatedAt: NOW,
  cells: {
    HEAD: {
      key: 'crown of narandi',
      name: 'Crown of Narandi',
      state: { full: 4, fraction: 3 },
      sockets: {
        focus: {
          effect: 'Improved Healing III',
          donorKey: 'robe of the lost circle',
          donorName: 'Robe of the Lost Circle'
        },
        proc: {
          effect: 'Lifetap Strike',
          donorKey: 'blade of the black dragon eye',
          donorName: 'Blade of the Black Dragon Eye'
        }
      }
    },
    FINGER2: {
      key: 'ring of pureblood',
      name: 'Ring of Pureblood',
      state: { full: 0, fraction: 0 },
      sockets: {
        worn: { effect: 'Shielding', donorKey: 'shield of rainbow hues', donorName: 'Shield of Rainbow Hues' }
      }
    },
    ANY1: {
      key: 'thelvorn, blade of light',
      name: 'Thelvorn, Blade of Light',
      state: { full: 7, fraction: 12 },
      sockets: {
        click: { effect: 'Gate', donorKey: 'jaded circlet', donorName: 'Jaded Circlet' }
      }
    }
  }
}

// ------------------------------------------------------------------ the store key

test('a pre-gearPlan store loads UNCHANGED — the key is additive, no migration runs', () => {
  withStore(preGearPlanStore, (path, before) => {
    const result = migrateStoreFile(path)
    assert.equal(result.status, 'up-to-date', 'a current store must need no step')
    assert.equal(result.wrote, false, 'nothing may be rewritten')
    assert.equal(readFileSync(path, 'utf8'), before, 'the file must be byte-identical')
  })
  // …and the reader's answer for a character with no key at all is an EMPTY board, never undefined.
  assert.deepEqual(sanitizeGearPlan(undefined, NOW), { cells: {}, updatedAt: NOW })
})

test('a store WITH a gearPlan survives a build that has never heard of one', () => {
  const withBoard = {
    ...preGearPlanStore,
    byCharacter: {
      primitive_freeport: { ...preGearPlanStore.byCharacter.primitive_freeport, gearPlan: goodBoard }
    }
  }
  withStore(withBoard, (path, before) => {
    const result = migrateStoreFile(path)
    assert.equal(result.status, 'up-to-date')
    assert.equal(readFileSync(path, 'utf8'), before)
    const reread = JSON.parse(readFileSync(path, 'utf8')) as typeof withBoard
    assert.deepEqual(
      sanitizeGearPlan(reread.byCharacter.primitive_freeport.gearPlan, NOW),
      goodBoard,
      'the stored board must read back exactly as written'
    )
  })
})

test('the three KEPT documents are neither read nor rewritten by the fourth', () => {
  const plan = {
    id: 'plan-1',
    name: 'Raid',
    classes: ['PAL'],
    createdAt: NOW,
    updatedAt: NOW,
    slots: { HEAD: { hostKey: 'crown of narandi', hostName: 'Crown of Narandi', sockets: {} } }
  }
  const gearSet = {
    id: 'set-1',
    name: 'Manaburn',
    createdAt: NOW,
    updatedAt: NOW,
    slots: { CHEST: { key: 'robe of the lost circle', name: 'Robe of the Lost Circle', state: { full: 2, fraction: 1 } } }
  }
  const wishlist = {
    entries: [{ itemKey: 'jaded circlet', name: 'Jaded Circlet', kind: 'gear', source: 'user', addedAt: NOW }],
    clearedDone: []
  }

  const all = {
    ...preGearPlanStore,
    byCharacter: {
      primitive_freeport: {
        ...preGearPlanStore.byCharacter.primitive_freeport,
        exaltPlans: [plan],
        gearSets: [gearSet],
        wishlist,
        gearPlan: goodBoard
      }
    }
  }

  withStore(all, (path, before) => {
    assert.equal(migrateStoreFile(path).status, 'up-to-date')
    assert.equal(readFileSync(path, 'utf8'), before, 'a fourth key may not rewrite a byte of the file')
    const c = (JSON.parse(readFileSync(path, 'utf8')) as typeof all).byCharacter.primitive_freeport
    // All four documents read back as themselves, through their own validators, unchanged.
    assert.deepEqual(sanitizeExaltPlans(c.exaltPlans, NOW), [plan])
    assert.deepEqual(sanitizeGearSets(c.gearSets, NOW), [gearSet])
    assert.deepEqual(sanitizeWishlist(c.wishlist, NOW), wishlist)
    assert.deepEqual(sanitizeGearPlan(c.gearPlan, NOW), goodBoard)
  })
})

// ------------------------------------------------------------------ the validator

test('a valid board round-trips untouched (get/set is a fixed point)', () => {
  const once = sanitizeGearPlan(goodBoard, NOW)
  assert.deepEqual(once, goodBoard)
  // Sanitizing twice — which is what a write does (handler, then store) — must change nothing.
  assert.deepEqual(sanitizeGearPlan(once, NOW), once)
})

test('malformed input is STRIPPED cell by cell, never thrown and never wholesale', () => {
  const board = sanitizeGearPlan(
    {
      updatedAt: NOW,
      cells: {
        // A cell the board cannot draw. `EAR3` is the shape of the mistake: plausible, not real.
        EAR3: { key: 'earring of the solstice', name: 'Earring of the Solstice' },
        // A cell naming no item is not a plan for that cell.
        NECK: { name: 'Nameless', state: { full: 2, fraction: 0 } },
        // …and the survivor, carrying one good socket and three bad ones.
        HEAD: {
          key: 'crown of narandi',
          name: 'Crown of Narandi',
          state: { full: 4, fraction: 0 },
          sockets: {
            // Ornamentation is not one of the four transferable types.
            ornamentation: { effect: 'Cloak Appearance', donorKey: 'velium cloak', donorName: 'Velium Cloak' },
            // A socket with no donor names a wish, not a plan.
            click: { effect: 'Gate' },
            // …and one that is entirely well-formed.
            focus: {
              effect: 'Improved Healing III',
              donorKey: 'robe of the lost circle',
              donorName: 'Robe of the Lost Circle'
            }
          }
        }
      }
    },
    NOW
  )

  assert.deepEqual(Object.keys(board.cells), ['HEAD'], 'the unknown cell and the item-less one go')
  assert.deepEqual(Object.keys(board.cells.HEAD?.sockets ?? {}), ['focus'], 'and the two bad sockets')
  assert.equal(board.cells.HEAD?.sockets.focus?.donorName, 'Robe of the Lost Circle')
})

test('a plus-state is CLAMPED to one the game can be in — phase 0`s normalizer, not a new rule', () => {
  const board = sanitizeGearPlan(
    {
      cells: {
        HEAD: { key: 'a', name: 'A', state: { full: 99, fraction: -3 } },
        NECK: { key: 'b', name: 'B', state: { full: 3, fraction: 99 } },
        // A cell carrying no state at all reads at base, which is what an unmerged item is.
        CHEST: { key: 'c', name: 'C' }
      }
    },
    NOW
  )
  assert.deepEqual(board.cells.HEAD?.state, { full: 10, fraction: 0 }, 'tier 10 banks nothing')
  assert.deepEqual(board.cells.NECK?.state, { full: 3, fraction: 7 }, '2^3 - 1 is the ceiling')
  assert.deepEqual(board.cells.CHEST?.state, { full: 0, fraction: 0 })
})

test('a cell or a donor with no name falls back to its key rather than rendering blank', () => {
  const board = sanitizeGearPlan(
    { cells: { HEAD: { key: 'crown of narandi', sockets: { focus: { effect: 'IH III', donorKey: 'robe' } } } } },
    NOW
  )
  assert.equal(board.cells.HEAD?.name, 'crown of narandi')
  assert.equal(board.cells.HEAD?.sockets.focus?.donorName, 'robe')
})

test('an unreadable document is an EMPTY board, which is what a fresh character has anyway', () => {
  for (const bad of [null, 42, 'a board', [], { cells: 'not a map' }]) {
    assert.deepEqual(sanitizeGearPlan(bad, NOW), { cells: {}, updatedAt: NOW })
  }
})
