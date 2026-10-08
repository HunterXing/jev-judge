/**
 * The ledger: one line per decision, and the only place a decision point's track
 * record lives.
 *
 * Every judgment — including the ones that fell back — is recorded, because the
 * ledger is what a decision point is promoted from `shadow` to `active` on. The
 * judged state is hashed rather than stored by default: a record has to be
 * comparable and countable without becoming a second copy of the user's content.
 *
 * The format is NDJSON, so `tail`, `jq` and any log pipeline already read it, and
 * a crash mid-write costs at most the last line.
 *
 * @module dsh-jev-judge/kernel/ledger
 */

import { appendFileSync, mkdirSync, readFileSync, renameSync, statSync } from 'node:fs'
import { createHash, randomUUID } from 'node:crypto'
import { dirname } from 'node:path'

/** How large a ledger grows before the previous file replaces `.1`. */
export const DEFAULT_MAX_BYTES = 8 * 1024 * 1024

/**
 * One decision, as the ledger stores it.
 *
 * @typedef {object} LedgerRecord
 * @property {string} id
 * @property {string} ts ISO timestamp.
 * @property {string} point Decision point id.
 * @property {number} version Decision point version.
 * @property {string} mode `off` | `shadow` | `active`.
 * @property {'judge' | 'fallback'} source
 * @property {unknown} outcome
 * @property {string} [reason] Why the fallback stood, when it did.
 * @property {Record<string, import('./contract.js').Answer>} [answers]
 * @property {number} [latencyMs]
 * @property {import('./contract.js').JudgeUsage} [usage]
 * @property {import('./cascade.js').TierReport[]} [tiers]
 * @property {import('./contract.js').JudgeWarning[]} [warnings]
 * @property {string} [stateDigest] Correlates records without storing content.
 * @property {unknown} [state] Present only when `recordState` is on.
 * @property {Record<string, unknown>} [subject] Caller-supplied identity, e.g. a session id.
 */

/**
 * A digest of the judged state: stable, short, and not reversible by reading it.
 *
 * @param {unknown} state
 * @returns {string}
 */
export function stateDigest(state) {
  return createHash('sha256').update(JSON.stringify(state) ?? 'null').digest('hex').slice(0, 16)
}

/**
 * Apply the storage policy to a record: a judged state is kept only when the
 * deployment asked for it, and otherwise leaves a digest behind. Every ledger
 * goes through here, so an in-memory ledger used by tests and dry runs cannot
 * quietly keep content a file ledger would have dropped.
 *
 * @param {object} record
 * @param {{recordState?: boolean}} [options]
 * @returns {object}
 */
export function toStoredRecord(record, options = {}) {
  const { state, ...rest } = record
  if (state === undefined) return rest
  return options.recordState ? { ...rest, state } : { ...rest, stateDigest: stateDigest(state) }
}

/**
 * An append-only ledger on disk.
 */
export class FileLedger {
  /**
   * @param {object} options
   * @param {string} options.path
   * @param {boolean} [options.recordState] Store the judged state, not just its digest.
   * @param {number} [options.maxBytes]
   * @param {{value: (value: unknown) => unknown}} [options.redactor]
   */
  constructor(options) {
    this.path = options.path
    this.recordState = options.recordState ?? false
    this.maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES
    this.redactor = options.redactor
  }

  /**
   * Write one record and answer it as stored.
   *
   * @param {Omit<LedgerRecord, 'id' | 'ts'> & {id?: string, ts?: string}} record
   * @returns {LedgerRecord}
   */
  append(record) {
    /** @type {LedgerRecord} */
    const full = {
      id: record.id ?? randomUUID(),
      ts: record.ts ?? new Date().toISOString(),
      ...toStoredRecord(record, { recordState: this.recordState }),
    }

    const redacted = /** @type {LedgerRecord} */ (
      this.redactor ? this.redactor.value(full) : full
    )
    this.write(redacted)
    return redacted
  }

  /**
   * Best-effort write. A ledger that cannot be written is a lost record, never a
   * broken turn: the record is still handed back to the caller, and the reason
   * shows up as a missing line rather than as an exception in an agent loop.
   *
   * @param {LedgerRecord} record
   * @returns {void}
   */
  write(record) {
    try {
      mkdirSync(dirname(this.path), { recursive: true })
      this.rotateIfNeeded()
      // Append synchronously: a record is a few hundred bytes, and a synchronous
      // write removes every interleaving question from a hot path.
      appendFileSync(this.path, `${JSON.stringify(record)}\n`, { mode: 0o600 })
    } catch {
      // Intentionally silent: the caller has no better fallback, and a retry
      // would only delay the decision it is trying to record.
    }
  }

  /** @returns {void} */
  rotateIfNeeded() {
    try {
      if (statSync(this.path).size < this.maxBytes) return
    } catch {
      return
    }
    try {
      renameSync(this.path, `${this.path}.1`)
    } catch {
      // A failed rotation must never cost a record: keep appending.
    }
  }

  /**
   * How many records the ledger holds. A count never needs the parsed records,
   * so this does not pay for `JSON.parse` on a large file.
   *
   * @returns {number}
   */
  count() {
    try {
      const text = readFileSync(this.path, 'utf8')
      let total = 0
      for (const line of text.split('\n')) if (line.trim() !== '') total += 1
      return total
    } catch {
      return 0
    }
  }

  /**
   * Read the most recent records, oldest first. Unreadable lines are skipped:
   * a truncated last line is expected after a crash.
   *
   * @param {{limit?: number}} [options]
   * @returns {LedgerRecord[]}
   */
  read(options = {}) {
    const limit = options.limit ?? 50
    let text
    try {
      text = readFileSync(this.path, 'utf8')
    } catch {
      return []
    }
    const lines = text.split('\n').filter((line) => line.trim() !== '')
    const tail = limit > 0 ? lines.slice(-limit) : lines
    /** @type {LedgerRecord[]} */
    const records = []
    for (const line of tail) {
      try {
        records.push(JSON.parse(line))
      } catch {
        // Skip a partial line rather than failing the read.
      }
    }
    return records
  }
}

/**
 * A ledger that keeps records in memory, for tests and dry runs.
 */
export class MemoryLedger {
  /**
   * @param {{recordState?: boolean}} [options]
   */
  constructor(options = {}) {
    this.recordState = options.recordState ?? false
    /** @type {LedgerRecord[]} */
    this.records = []
  }

  /**
   * @param {Omit<LedgerRecord, 'id' | 'ts'> & {id?: string, ts?: string}} record
   * @returns {LedgerRecord}
   */
  append(record) {
    const full = {
      id: record.id ?? randomUUID(),
      ts: record.ts ?? new Date().toISOString(),
      ...toStoredRecord(record, { recordState: this.recordState }),
    }
    this.records.push(/** @type {LedgerRecord} */ (full))
    return /** @type {LedgerRecord} */ (full)
  }

  /**
   * @param {{limit?: number}} [options]
   * @returns {LedgerRecord[]}
   */
  read(options = {}) {
    const limit = options.limit ?? 50
    return limit > 0 ? this.records.slice(-limit) : [...this.records]
  }

  /** @returns {number} */
  count() {
    return this.records.length
  }
}

/**
 * Build the ledger a configuration asks for.
 *
 * @param {{path?: string | null, recordState?: boolean, maxBytes?: number, redactor?: {value: (value: unknown) => unknown}}} [options]
 * @returns {FileLedger | MemoryLedger | null} `null` when no path is configured.
 */
export function createLedger(options = {}) {
  if (!options.path) return null
  return new FileLedger({
    path: options.path,
    recordState: options.recordState,
    maxBytes: options.maxBytes,
    redactor: options.redactor,
  })
}
