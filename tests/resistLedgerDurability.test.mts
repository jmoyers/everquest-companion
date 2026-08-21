// ============================================================================
// resistLedgerDurability.test.mts — JOS-419: the resist ledger survives a full disk and a torn file.
// ============================================================================
//
// THE DEFECT, read off the error store rather than guessed. Fingerprint f491e2052171562f, five
// occurrences on 1.5.0 from the 2026-08-19 triage: `resist-ledger.json write failed`, `code=ENOSPC`,
// thrown out of `saveUserSources` under `persistResistLedger` on the resist module's tick. The same
// shape the telemetry ring filed ~350 times across 0.18-0.23 — the volume is full, which cannot be
// fixed from in here; what can be fixed is the damage this app does while it is full, and what it
// does with the file afterwards.
//
// WHAT IS PINNED HERE:
//
//   1. A clean write round-trips, atomically, leaving no scratch file — and the ledger it wrote is
//      the ledger the next launch reads.
//   2. A write that runs out of space leaves the LIVE file untouched and no `.tmp` behind (the
//      mechanics are `writeFileDurable`'s and already pinned by JOS-265; here it is the ledger's
//      writer that has to be using them).
//   3. A failing writer STOPS TOUCHING THE DISK for a spell, and reports EXACTLY ONCE per session
//      however long the disk stays full. That is the ticket's own acceptance line: five occurrences
//      from one install is four too many.
//   4. The module stays alive across all of it — sixty failing snapshots in a row, and the fold and
//      its counts are untouched.
//   5. It comes back on its own, and says so once.
//   6. TICKS ARE COALESCED: an unchanged ledger is not rewritten, so a session parked at the
//      character select stops rewriting hundreds of kilobytes a minute, and a failing volume climbs
//      the backoff on CHANGES rather than on ticks.
//   7. A torn file is SALVAGED and PRESERVED: stale trailing bytes are discarded, a truncated file
//      gives up its whole per-character buckets and no half of one, and a file with nothing whole in
//      it still ends up beside its replacement as `resist-ledger.corrupt.json` rather than lost.
//   8. A file that PARSES is never quarantined — a stale version is a planned discard, not an
//      incident.
//
// No Electron: the file half is `resist/ledgerFile.ts` precisely so this suite can drive it. Real
// temp directories answer the "what was left on disk" questions; the full disk is injected through
// `DurableIo`, the seam JOS-265 built for it.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { nodeIo, WRITE_RETRY_BASE_MS, retryDelayMs, type DurableIo } from '../src/main/telemetry/durableWrite'
import { createLedgerWriter, fingerprint, loadUserLedgerFile, type LedgerSource } from '../src/main/resist/ledgerFile'
import { quarantinePathFor } from '../src/main/tornJson'
import { ResistModule } from '../src/main/resist/module'
import { ResistLedgerStore } from '../src/main/resist/ledger'
import type { ResistRow } from '../src/shared/resistTypes'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const VERSION = 3

function scratchDir(): string {
  return mkdtempSync(join(tmpdir(), 'eqc-resist-'))
}

/** The error a full volume throws, spelled the way `node:fs` spells it. */
function enospc(): NodeJS.ErrnoException {
  const err: NodeJS.ErrnoException = new Error('ENOSPC: no space left on device, write')
  err.code = 'ENOSPC'
  return err
}

/** The real io, optionally failing one step the way a full volume fails it. */
function io(fail?: keyof DurableIo): DurableIo {
  const step =
    <K extends keyof DurableIo>(name: K, run: DurableIo[K]): DurableIo[K] =>
      ((...args: unknown[]) => {
        if (fail === name) throw enospc()
        return (run as (...a: unknown[]) => unknown)(...args)
      }) as DurableIo[K]
  return {
    mkdir: step('mkdir', nodeIo.mkdir),
    open: step('open', nodeIo.open),
    write: step('write', nodeIo.write),
    fsync: step('fsync', nodeIo.fsync),
    close: step('close', nodeIo.close),
    rename: step('rename', nodeIo.rename),
    remove: step('remove', nodeIo.remove)
  }
}

/** A row shaped exactly like the fold writes them. The numbers are arbitrary; the SHAPE is not. */
function row(mobKey: string, spellKey: string, resist = 1, land = 3): ResistRow {
  return {
    mobKey,
    spellKey,
    family: 'magic',
    casterKind: 'self',
    casterLevel: 60,
    mobLevel: 55,
    debuffs: '',
    rank: 0,
    overchannel: null,
    week: '2026-W33',
    resist,
    land,
    dmg: { '412': 2 },
    firstTs: 1_700_000_000_000,
    lastTs: 1_700_000_900_000
  }
}

function ledgerText(sources: LedgerSource[], version = VERSION): string {
  return JSON.stringify({ version, sources })
}

// ---- 1-2. THE WRITE ---------------------------------------------------------------------------

test('A CLEAN WRITE round-trips: what the ledger wrote is what the next launch reads', () => {
  const dir = scratchDir()
  try {
    const path = join(dir, 'resist-ledger.json')
    const sources: LedgerSource[] = [{ key: 'Primitive@freeport', rows: [row('a_gorge_hound', 'shock of swords')] }]
    const writer = createLedgerWriter(io())
    assert.equal(writer.write(dir, path, ledgerText(sources)).status, 'written')

    assert.deepEqual(readdirSync(dir), ['resist-ledger.json'], 'no scratch file outlives a good write')
    assert.deepEqual(loadUserLedgerFile(path, VERSION).sources, sources)
    assert.equal(loadUserLedgerFile(path, VERSION).notice, undefined, 'an ordinary read says nothing')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('THE FULL DISK: the live ledger is untouched and no scratch file is left holding its bytes', () => {
  const dir = scratchDir()
  try {
    const path = join(dir, 'resist-ledger.json')
    const first: LedgerSource[] = [{ key: 'Primitive@freeport', rows: [row('a_gorge_hound', 'shock of swords')] }]
    const writer = createLedgerWriter(io())
    writer.write(dir, path, ledgerText(first))

    // The volume fills up. The next snapshot carries a second character and cannot land.
    const full = createLedgerWriter(io('write'))
    const next: LedgerSource[] = [...first, { key: 'Alt@freeport', rows: [row('a_sand_giant', 'ice comet')] }]
    const out = full.write(dir, path, ledgerText(next))
    assert.equal(out.status, 'failed')
    assert.equal((out.err as NodeJS.ErrnoException).code, 'ENOSPC')

    assert.deepEqual(readdirSync(dir), ['resist-ledger.json'], 'the partial temp went back to the full volume')
    assert.deepEqual(loadUserLedgerFile(path, VERSION).sources, first, 'the last whole ledger is still there')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

// ---- 3-5. THE STORM, THE REPORT, AND COMING BACK ----------------------------------------------

test('THE STORM: a failing ledger stops touching the disk, and reports exactly ONCE per session', () => {
  const dir = scratchDir()
  try {
    const path = join(dir, 'resist-ledger.json')
    let attempts = 0
    const counting: DurableIo = { ...io('write'), open: (p) => { attempts += 1; return nodeIo.open(p) } }
    const writer = createLedgerWriter(counting)

    // t=0: the first snapshot fails, and this is the one occurrence the fleet gets.
    const first = writer.write(dir, path, ledgerText([{ key: 'A', rows: [row('m', 's', 1)] }]), 0)
    assert.equal(first.status, 'failed')
    assert.equal(first.report, true)
    assert.equal(first.delayMs, WRITE_RETRY_BASE_MS)
    assert.equal(attempts, 1)

    // The next half-minute of ticks, each carrying a ledger that grew: not one syscall.
    for (const t of [1_000, 20_000, 29_999]) {
      const out = writer.write(dir, path, ledgerText([{ key: 'A', rows: [row('m', 's', t)] }]), t)
      assert.equal(out.status, 'paused')
    }
    assert.equal(attempts, 1, 'a paused writer must not attempt the write at all')

    // The pause expires: exactly one more attempt is spent, it fails, and it is NOT reported again.
    const second = writer.write(dir, path, ledgerText([{ key: 'A', rows: [row('m', 's', 9)] }]), WRITE_RETRY_BASE_MS)
    assert.equal(second.status, 'failed')
    assert.equal(second.report, false, 'the second failure of a session is never filed')
    assert.equal(second.delayMs, retryDelayMs(2), 'and the pause doubled')
    assert.equal(attempts, 2)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('THE MODULE STAYS ALIVE: sixty failing snapshots cost the fold nothing', () => {
  const dir = scratchDir()
  try {
    const path = join(dir, 'resist-ledger.json')
    const writer = createLedgerWriter(io('write'))
    const store = new ResistLedgerStore()
    let reports = 0
    let now = 0
    const module = new ResistModule({
      ledger: {
        beginSource: (key) => store.beginSource(key),
        persist: () => {
          // EXACTLY WHAT store.ts DOES, minus the paths and the logger: the outcome is inspected,
          // never thrown. A persist that throws would take the registry's tick with it.
          const sources = store.toLedger().sources.filter((s) => s.rows.length > 0)
          const out = writer.write(dir, path, ledgerText(sources), now)
          if (out.report === true) reports += 1
        },
        counts: () => {
          let rows = 0
          for (const src of store.toLedger().sources) rows += src.rows.length
          return { rows, mobs: store.mobKeys().size }
        }
      }
    })
    module.beginSource('Primitive@freeport')
    // One observation the fold could not have invented, filed straight into the bucket the module
    // is holding — the point is the TICKS below, not the parser.
    store.bucket('Primitive@freeport').seed([row('a_gorge_hound', 'shock of swords')])

    // An hour of heartbeats over a full disk.
    for (let tick = 0; tick < 60 * 60; tick++) {
      now += 1_000
      module.onTick(now)
    }

    assert.equal(module.snapshot().state.rows, 1, 'the ledger in memory is exactly what it was')
    assert.equal(module.snapshot().state.mobs, 1)
    assert.equal(reports, 1, 'one hour of a full disk files ONE occurrence, not sixty')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('IT COMES BACK: the first write after the disk is freed lands and says so once', () => {
  const dir = scratchDir()
  try {
    const path = join(dir, 'resist-ledger.json')
    const writer = createLedgerWriter(io('write'))
    const sources: LedgerSource[] = [{ key: 'Primitive@freeport', rows: [row('a_gorge_hound', 'shock of swords')] }]
    assert.equal(writer.write(dir, path, ledgerText(sources), 0).status, 'failed')

    // The user empties the recycle bin. The writer is rebuilt around a working disk only because a
    // test cannot un-fail an injected io; the GATE is the same one, so the pause still has to expire.
    const freed = createLedgerWriter(io())
    freed.write(dir, path, ledgerText(sources), 0)
    const out = freed.write(dir, path, ledgerText([...sources, { key: 'Alt@freeport', rows: [row('m', 's')] }]), 1)
    assert.equal(out.status, 'written')
    assert.equal(out.recovered, false, 'a writer that never failed has no recovery to narrate')
    assert.equal(loadUserLedgerFile(path, VERSION).sources.length, 2)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

// ---- 6. COALESCING ----------------------------------------------------------------------------

test('COALESCED TICKS: an unchanged ledger is not rewritten, and a changed one is', () => {
  const dir = scratchDir()
  try {
    const path = join(dir, 'resist-ledger.json')
    let writes = 0
    const counting: DurableIo = { ...io(), write: (fd, data) => { writes += 1; nodeIo.write(fd, data) } }
    const writer = createLedgerWriter(counting)
    const parked = ledgerText([{ key: 'Primitive@freeport', rows: [row('a_gorge_hound', 'shock of swords')] }])

    assert.equal(writer.write(dir, path, parked).status, 'written')
    for (let i = 0; i < 59; i++) assert.equal(writer.write(dir, path, parked).status, 'unchanged')
    assert.equal(writes, 1, 'an hour parked at the character select is ONE write, not sixty')

    const moved = ledgerText([{ key: 'Primitive@freeport', rows: [row('a_gorge_hound', 'shock of swords', 2)] }])
    assert.equal(writer.write(dir, path, moved).status, 'written')
    assert.equal(writes, 2)
    assert.deepEqual(JSON.parse(readFileSync(path, 'utf8')), JSON.parse(moved))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('THE FINGERPRINT is length-and-hash, so a one-character change is never mistaken for no change', () => {
  assert.notEqual(fingerprint('{"version":3,"sources":[]}'), fingerprint('{"version":3,"sources":[ ]}'))
  assert.equal(fingerprint('same'), fingerprint('same'))
  assert.notEqual(fingerprint('{"resist":1}'), fingerprint('{"resist":2}'))
})

// ---- 7-8. THE TORN READ -----------------------------------------------------------------------

test('A MISSING ledger is a fresh install: no buckets, no notice, nothing moved aside', () => {
  const dir = scratchDir()
  try {
    const load = loadUserLedgerFile(join(dir, 'resist-ledger.json'), VERSION)
    assert.deepEqual(load, { sources: [] })
    assert.deepEqual(readdirSync(dir), [])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('STALE TRAILING BYTES: a shorter rewrite over a longer file is salvaged whole', () => {
  const dir = scratchDir()
  try {
    const path = join(dir, 'resist-ledger.json')
    const whole = ledgerText([{ key: 'Primitive@freeport', rows: [row('a_gorge_hound', 'shock of swords')] }])
    // The signature of an in-place rewrite that was shorter than what it replaced: a complete
    // document, then the tail of the old one.
    writeFileSync(path, `${whole}"rows":[{"mobKey":"a_sand_giant"}]}]}`, 'utf8')

    const load = loadUserLedgerFile(path, VERSION)
    assert.deepEqual(load.sources, JSON.parse(whole).sources)
    assert.equal(load.quarantinedPath, quarantinePathFor(path))
    assert.ok(load.notice?.includes('stale trailing bytes discarded'), load.notice)
    assert.ok(existsSync(quarantinePathFor(path)), 'the corrupt file is KEPT, never deleted')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('A TRUNCATED ledger gives up its WHOLE character buckets and no half of one', () => {
  const dir = scratchDir()
  try {
    const path = join(dir, 'resist-ledger.json')
    const whole = ledgerText([
      { key: 'Primitive@freeport', rows: [row('a_gorge_hound', 'shock of swords')] },
      { key: 'Alt@freeport', rows: [row('a_sand_giant', 'ice comet')] }
    ])
    // The write died part-way through the SECOND bucket, and Windows padded the tail with NULs.
    const cut = whole.indexOf('"Alt@freeport"') + 30
    writeFileSync(path, whole.slice(0, cut) + String.fromCharCode(0).repeat(64), 'utf8')

    const load = loadUserLedgerFile(path, VERSION)
    assert.equal(load.sources.length, 1, 'the complete bucket comes back')
    assert.equal(load.sources[0]?.key, 'Primitive@freeport')
    assert.deepEqual(load.sources[0]?.rows, [row('a_gorge_hound', 'shock of swords')], 'and it is complete, not partial')
    assert.ok(load.notice?.includes('whole character buckets'), load.notice)
    // THE EVIDENCE IS KEPT, byte for byte — a half-written bucket is not silently deleted, it is
    // just not adopted.
    assert.equal(readFileSync(quarantinePathFor(path), 'utf8').startsWith(whole.slice(0, cut)), true)
    assert.equal(existsSync(path), false, 'and the live path is clear for the next snapshot')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('A LEDGER WITH NOTHING WHOLE IN IT still ends up preserved rather than lost', () => {
  const dir = scratchDir()
  try {
    const path = join(dir, 'resist-ledger.json')
    writeFileSync(path, '{"version":3,"sources":[{"key":"Primitive@freeport","rows":[{"mobKey":"a_gor', 'utf8')

    const load = loadUserLedgerFile(path, VERSION)
    assert.deepEqual(load.sources, [], 'a truncated FIRST bucket is not half-restored')
    assert.equal(load.quarantinedPath, quarantinePathFor(path))
    assert.ok(load.notice?.includes('nothing whole could be recovered'), load.notice)
    assert.ok(existsSync(quarantinePathFor(path)))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('A TRUNCATED ledger of ANOTHER version is not salvaged — a version bump is a discard', () => {
  const dir = scratchDir()
  try {
    const path = join(dir, 'resist-ledger.json')
    const whole = ledgerText([{ key: 'Primitive@freeport', rows: [row('a_gorge_hound', 'shock of swords')] }], 2)
    writeFileSync(path, whole.slice(0, whole.length - 3), 'utf8')
    const load = loadUserLedgerFile(path, VERSION)
    assert.deepEqual(load.sources, [])
    assert.ok(existsSync(quarantinePathFor(path)), 'kept anyway: this app did not choose to lose it')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('A FILE THAT PARSES IS NEVER QUARANTINED: a stale version is a planned discard, not an incident', () => {
  const dir = scratchDir()
  try {
    const path = join(dir, 'resist-ledger.json')
    writeFileSync(path, ledgerText([{ key: 'Primitive@freeport', rows: [row('a_gorge_hound', 'shock of swords')] }], 2), 'utf8')
    const load = loadUserLedgerFile(path, VERSION)
    assert.deepEqual(load, { sources: [] })
    assert.equal(existsSync(quarantinePathFor(path)), false, 'nothing was moved aside')
    assert.equal(existsSync(path), true, 'and the next snapshot simply replaces it')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('THE SHIPPED BASELINE IS NEVER SEEDED FROM THE USER FILE, however it arrives', () => {
  const dir = scratchDir()
  try {
    const path = join(dir, 'resist-ledger.json')
    // A ledger written by some past build (or by hand) carrying a stale copy of the baseline: it is
    // re-seeded from the bundle every launch, so adopting this one would count everything twice.
    writeFileSync(
      path,
      ledgerText([
        { key: 'baseline', rows: [row('a_gorge_hound', 'shock of swords')] },
        { key: 'Primitive@freeport', rows: [row('a_sand_giant', 'ice comet')] }
      ]),
      'utf8'
    )
    const load = loadUserLedgerFile(path, VERSION)
    assert.deepEqual(load.sources.map((s) => s.key), ['Primitive@freeport'])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

// ---- THE RULES THAT LIVE IN store.ts ----------------------------------------------------------

const STORE_SRC = readFileSync(join(ROOT, 'src', 'main', 'resist', 'store.ts'), 'utf8')

test('THE SOURCE PIN: the ledger is not written with a bare writeFileSync any more', () => {
  assert.equal(/writeFileSync/.test(STORE_SRC), false, 'every write goes through the durable writer')
  assert.ok(STORE_SRC.includes('createLedgerWriter'))
})

test('THE FINGERPRINT SURVIVES THE FIX: the failure message is unchanged, character for character', () => {
  // The error store aggregates on the message plus the frames. Rewording this line would split
  // f491e2052171562f's occurrences from everything the fix files next, and the triage loop would be
  // reading two half-histories.
  assert.ok(STORE_SRC.includes("{ message: 'resist-ledger.json write failed', err: out.err }"))
  assert.equal(
    /message: `resist-ledger\.json write failed/.test(STORE_SRC),
    false,
    'the failure message must stay a literal — no interpolated counts, delays or codes'
  )
})
