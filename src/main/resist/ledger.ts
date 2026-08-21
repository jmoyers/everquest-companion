// The resist ledger: per-source buckets of pooled observations (JOS-382).
//
// Pure — no Electron, no node. `ledgerStore.ts` is the half that touches disk, and
// `scripts/gen-resist-baseline.ts` drives this half directly.
//
// A RE-FOLD REPLACES A SOURCE'S BUCKET, IT NEVER ADDS TO IT (JOS-231, learned the expensive way on
// the message overlay: seeding a fold from its own persisted output doubled every count on every
// cold launch). This app re-reads the whole log at startup, so idempotence cannot be a discipline
// the caller remembers — it has to be structural. `beginSource(key)` DISCARDS the bucket before
// its log is folded again; `rowsFor()` sums across buckets. Folding the same log twice is a no-op
// by construction, and a bucket for a character you are not folding is knowledge nothing can
// re-derive, so it survives untouched.
//
// AND A BUCKET HOLDS COUNTS, NEVER VERDICTS. There is no R, no interval and no "immune" anywhere
// in this file. A stored verdict is a second opinion waiting to disagree with the derived one,
// and every one of them would have to be recomputed when a patch moves a spell's resist adjust.

import {
  MAX_DISTINCT_DAMAGE_VALUES,
  RESIST_LEDGER_SCHEMA,
  type ResistLedger,
  type ResistRow,
  type ResistSource,
} from '../../shared/resistTypes'
import { isoWeekKey, laterWeek } from '../../shared/resistDecay'

/** Everything a row is keyed BY. The counts and timestamps are what accretes onto it. */
export type RowSpec = Omit<ResistRow, 'resist' | 'land' | 'dmg' | 'firstTs' | 'lastTs'>

/**
 * The pooling key: every term of `rc` except R itself. See resistTypes.ts for the argument.
 *
 * THE RANK AND THE INVOCATION ARE IN IT (JOS-387) because both are resist adjust: a rank is -15
 * each and overchannel is -150 plus -15 per non-hybrid caster class, so two casts of the same spell
 * at different ranks — or one in overchannel and one out of it — rolled against different numbers
 * and may not be pooled.
 *
 * THE CLASS COUNT IS IN IT ONLY WHERE IT MATTERS, which is a size decision made once here rather
 * than a special case scattered through the estimator: it contributes to `rc` only when overchannel
 * was up, so keying on it unconditionally would split every ordinary row in the shipped baseline on
 * a value that changes nothing about them.
 *
 * AND THE WEEK IS IN IT (JOS-397), which is the one term that is not about `rc` at all. It is about
 * AGE: recent evidence weighs more (`shared/resistDecay.ts`), and a row that pooled March into this
 * evening would have no age to weigh. Weekly rather than daily because a 21-day half-life cannot use
 * a finer resolution and a day bucket would multiply the ledger by seven to say the same thing.
 */
export function rowKey(row: RowSpec): string {
  return [
    row.mobKey,
    row.spellKey,
    row.family,
    row.casterKind,
    row.casterLevel ?? '',
    row.mobLevel ?? '',
    row.debuffs,
    row.rank,
    row.overchannel === null ? '?' : row.overchannel ? 'oc' : '-',
    row.overchannel === true ? (row.casterClasses ?? 0) : '',
    row.week ?? '',
  ].join('|')
}

/** An empty observation row for a key. */
export function blankRow(spec: RowSpec, ts: number): ResistRow {
  return { ...spec, resist: 0, land: 0, dmg: {}, firstTs: ts, lastTs: ts }
}

/** Total observations a row carries — the number every threshold in this feature is stated in. */
export function rowTotal(row: ResistRow): number {
  let total = row.resist + row.land
  for (const count of Object.values(row.dmg)) total += count
  return total
}

/**
 * One bucket, accreting. Kept as a Map for the fold's benefit; `rows()` is what gets serialized.
 */
export class ResistBucket {
  private byKey = new Map<string, ResistRow>()

  get size(): number {
    return this.byKey.size
  }

  clear(): void {
    this.byKey = new Map()
    this.newest = undefined
  }

  /**
   * THE NEWEST WEEK THIS BUCKET HOLDS, maintained as rows arrive rather than scanned for.
   *
   * The read side asks for it on EVERY card draw (it is the instant every row's age is measured
   * against — shared/resistDecay.ts), and the alternative is a pass over four thousand rows per
   * draw to re-derive a maximum the writer already knew.
   */
  private newest: string | undefined

  newestWeek(): string | undefined {
    return this.newest
  }

  row(spec: RowSpec, ts: number): ResistRow {
    this.newest = laterWeek(this.newest, spec.week)
    const key = rowKey(spec)
    let row = this.byKey.get(key)
    if (!row) {
      row = blankRow(spec, ts)
      this.byKey.set(key, row)
    }
    if (ts < row.firstTs) row.firstTs = ts
    if (ts > row.lastTs) row.lastTs = ts
    return row
  }

  /**
   * Record one damage number. PAST THE CAP THE ROW GIVES UP ON THE HISTOGRAM: a spell whose
   * damage genuinely varies carries no partial information anyway (the estimator can only read
   * "message or no message" off it), and an unbounded map is a disk-size bug with a long tail.
   * `variable` says the give-up happened, so a later reader can tell it from a spell that simply
   * has not been cast much.
   */
  addDamage(row: ResistRow, amount: number): void {
    const key = String(amount)
    if (row.variable === true) {
      row.land += 1
      return
    }
    if (row.dmg[key] === undefined && Object.keys(row.dmg).length >= MAX_DISTINCT_DAMAGE_VALUES) {
      row.variable = true
      for (const count of Object.values(row.dmg)) row.land += count
      row.dmg = {}
      row.land += 1
      return
    }
    row.dmg[key] = (row.dmg[key] ?? 0) + 1
  }

  /** Sorted for a byte-stable serialization: a re-run on unchanged input must diff to nothing. */
  rows(): ResistRow[] {
    return [...this.byKey.entries()].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0)).map((e) => e[1])
  }

  /** Seed from a persisted bucket (a character you are not folding this run). */
  seed(rows: readonly ResistRow[]): void {
    for (const row of rows) {
      this.byKey.set(rowKey(row), { ...row, dmg: { ...row.dmg } })
      this.newest = laterWeek(this.newest, row.week)
    }
  }
}

/**
 * RE-POOL A SET OF ROWS ONTO ONE WEEK (JOS-397), merging every row whose key then collides.
 *
 * It exists for the shipped baseline and nothing else. That file is a SNAPSHOT rather than a diary:
 * its rows have carried `firstTs: 0` since JOS-382 because one player's itinerary is not a fact
 * about a creature, and its whole content is aged from `frozenAt` for the same reason. Left split by
 * their real weeks, the owner's four weeks would fragment every cell into four buckets and the
 * freeze script's five-observation floor would then drop most of them — a smaller file that knows
 * less, which is the opposite of the trade.
 */
export function repoolAtWeek(rows: readonly ResistRow[], week: string): ResistRow[] {
  const byKey = new Map<string, ResistRow>()
  for (const row of rows) {
    const moved: ResistRow = { ...row, week, dmg: { ...row.dmg } }
    const key = rowKey(moved)
    const held = byKey.get(key)
    if (!held) {
      byKey.set(key, moved)
      continue
    }
    held.resist += moved.resist
    held.land += moved.land
    for (const [value, count] of Object.entries(moved.dmg)) {
      held.dmg[value] = (held.dmg[value] ?? 0) + count
    }
    if (moved.variable === true) held.variable = true
    if (moved.firstTs < held.firstTs) held.firstTs = moved.firstTs
    if (moved.lastTs > held.lastTs) held.lastTs = moved.lastTs
    // THE HISTOGRAM CAP IS THE BUCKET'S OWN RULE and merging must not smuggle a row past it: four
    // weeks of a variable-damage proc could otherwise arrive with 128 distinct values in a file
    // whose whole point is to stay small. Same give-up, same meaning (see `addDamage`).
    if (held.variable !== true && Object.keys(held.dmg).length > MAX_DISTINCT_DAMAGE_VALUES) {
      held.variable = true
      for (const count of Object.values(held.dmg)) held.land += count
      held.dmg = {}
    }
  }
  return [...byKey.values()]
}

/** Every bucket, keyed by source. The whole ledger the app holds in memory. */
export class ResistLedgerStore {
  private buckets = new Map<string, ResistBucket>()

  bucket(key: string): ResistBucket {
    let b = this.buckets.get(key)
    if (!b) {
      b = new ResistBucket()
      this.buckets.set(key, b)
    }
    return b
  }

  /** Discard a source's bucket before its log is folded again. THE idempotence seam. */
  beginSource(key: string): ResistBucket {
    const fresh = new ResistBucket()
    this.buckets.set(key, fresh)
    return fresh
  }

  keys(): string[] {
    return [...this.buckets.keys()].sort()
  }

  /** Every row for one mob, each tagged with where it came from. Sources are `baseline` or you. */
  rowsFor(mobKey: string, baselineKey: string): ResistRow[] {
    const out: ResistRow[] = []
    for (const [key, bucket] of this.buckets) {
      const source: ResistSource = key === baselineKey ? 'baseline' : 'user'
      for (const row of bucket.rows()) {
        if (row.mobKey !== mobKey) continue
        out.push({ ...row, source })
      }
    }
    return out
  }

  /** The newest week ANY bucket holds: the instant every row's age is measured against. */
  newestWeek(): string | undefined {
    let best: string | undefined
    for (const bucket of this.buckets.values()) best = laterWeek(best, bucket.newestWeek())
    return best
  }

  /** Distinct mob keys anything has been observed about. */
  mobKeys(): Set<string> {
    const out = new Set<string>()
    for (const bucket of this.buckets.values()) {
      for (const row of bucket.rows()) out.add(row.mobKey)
    }
    return out
  }

  toLedger(): ResistLedger {
    return {
      schema: RESIST_LEDGER_SCHEMA,
      sources: this.keys().map((key) => ({ key, rows: this.bucket(key).rows() })),
    }
  }

  /**
   * A LEDGER OF ANY OTHER SCHEMA IS DISCARDED, NOT MIGRATED (JOS-387 bumped this to 2, JOS-397 to
   * 3). A schema-1 row pooled its counts across upgrade ranks and across invocation states, and a
   * schema-2 row pooled them across WEEKS; no migration can un-pool either — so the honest upgrade
   * is the re-fold this app performs from the log on every launch anyway.
   */
  seed(ledger: ResistLedger | null | undefined): void {
    if (ledger?.schema !== RESIST_LEDGER_SCHEMA) return
    // THE SHIPPED BASELINE'S AGE IS ITS FREEZE STAMP (JOS-397). Its rows omit the week because they
    // all share one and the file already states it once; this is where the one becomes the four
    // thousand, so that everything downstream sees a row with a week on it and no special case.
    const frozenWeek = ledger.frozenAt === undefined ? undefined : isoWeekKey(Date.parse(ledger.frozenAt))
    for (const src of ledger.sources) {
      const rows =
        frozenWeek === undefined ? src.rows : src.rows.map((r) => (r.week === undefined ? { ...r, week: frozenWeek } : r))
      this.bucket(src.key).seed(rows)
    }
  }
}
