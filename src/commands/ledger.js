/**
 * `jev-judge ledger` — read what the kernel decided.
 *
 * The ledger is how a decision point earns `active`, so reading it has to be
 * cheap and honest: one line per decision, newest last, with the reason a
 * fallback stood. `--json` prints the records as stored, which is what a script
 * or a spreadsheet wants.
 *
 * @module dsh-jev-judge/commands/ledger
 */

import { createLedger } from '../kernel/ledger.js'
import { createJudgeRuntime, expandHome } from '../kernel/registry.js'
import { UsageError, out, parse } from './support.js'

/**
 * Print one record as a single line.
 *
 * @param {import('../kernel/ledger.js').LedgerRecord} record
 * @returns {string}
 */
function line(record) {
  const parts = [
    record.ts,
    record.point.padEnd(18),
    record.mode.padEnd(6),
    record.source.padEnd(8),
    `${Math.round(record.latencyMs ?? 0)}ms`.padStart(7),
    summarize(record),
  ]
  return parts.join('  ')
}

/**
 * A record's outcome and reason, short enough to scan.
 *
 * @param {import('../kernel/ledger.js').LedgerRecord} record
 * @returns {string}
 */
function summarize(record) {
  const outcome =
    typeof record.outcome === 'string' ? record.outcome : JSON.stringify(record.outcome)
  const head = outcome === undefined ? '' : String(outcome)
  return record.reason ? `${head}  (${record.reason})` : head
}

/** @type {import('../cli.js').Command} */
export const command = {
  summary: 'Read the ledger: what was decided, by whom, and why not.',
  usage: `ledger — read the ledger: what was decided, by whom, and why not.

Options:
  [n]                How many records to show (default 20).
  --path <path>      Read another ledger file.
  --point <id>       Only this decision point.
  --json             Print the records as stored.`,
  async run(argv) {
    const { values, positionals } = parse(
      argv,
      {
        path: { type: 'string' },
        limit: { type: 'string', short: 'n' },
        point: { type: 'string' },
        json: { type: 'boolean' },
      },
      { allowPositionals: true },
    )

    const limitText = positionals[0] ?? values.limit
    const limit = limitText === undefined ? 20 : Number(limitText)
    if (!Number.isInteger(limit) || limit < 0) {
      throw new UsageError('the limit must be a whole number of records')
    }

    const runtime = createJudgeRuntime()
    const path = values.path ? expandHome(String(values.path)) : runtime.kernel.ledger.path
    if (!path) {
      throw new UsageError(
        'no ledger is configured; set `ledger.path` in the kernel settings or pass --path',
      )
    }
    const ledger = values.path ? createLedger({ path }) : runtime.ledger
    const records = (ledger?.read({ limit: 0 }) ?? []).filter(
      (record) => values.point === undefined || record.point === values.point,
    )

    if (values.json) {
      out(JSON.stringify(records.slice(-limit), null, 2))
      return 0
    }

    if (records.length === 0) {
      out(`No records in ${path}.`)
      return 0
    }

    out(`${path} — ${records.length} record(s), showing the last ${Math.min(limit, records.length)}`)
    out()
    for (const record of records.slice(-limit)) out(line(record))
    return 0
  },
}
