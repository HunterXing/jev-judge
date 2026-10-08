/**
 * Shared command plumbing: argument parsing, the state a command is asked about,
 * and the output conventions the commands share.
 *
 * @module dsh-jev-judge/commands/support
 */

import { readFileSync } from 'node:fs'
import { parseArgs } from 'node:util'

/** A usage mistake: the message is safe to print and exits 2. */
export class UsageError extends Error {
  /**
   * @param {string} message
   */
  constructor(message) {
    super(message)
    this.name = 'UsageError'
  }
}

/**
 * Parse a command's own arguments, turning a usage mistake into a message rather
 * than a stack trace.
 *
 * @param {string[]} argv
 * @param {import('node:util').ParseArgsConfig['options']} options
 * @param {{allowPositionals?: boolean}} [behaviour]
 * @returns {{values: Record<string, unknown>, positionals: string[]}}
 * @throws {UsageError} With a message safe to print.
 */
export function parse(argv, options, behaviour = {}) {
  try {
    const parsed = parseArgs({
      args: argv,
      options,
      allowPositionals: behaviour.allowPositionals ?? false,
      strict: true,
    })
    return { values: parsed.values, positionals: parsed.positionals }
  } catch (error) {
    throw new UsageError(error instanceof Error ? error.message : 'could not parse arguments')
  }
}

/**
 * The state a judgment is about: `--state` inline, `--state-file`, or stdin.
 *
 * @param {{state?: unknown, 'state-file'?: unknown}} values
 * @returns {string} The raw text, already validated as JSON by the caller.
 */
export function readStateText(values) {
  if (typeof values.state === 'string' && values.state.trim() !== '') return values.state
  if (typeof values['state-file'] === 'string') {
    if (values['state-file'] === '-') return readFileSync(0, 'utf8')
    return readFileSync(values['state-file'], 'utf8')
  }
  return readFileSync(0, 'utf8')
}

/**
 * Parse JSON with a message that names what failed.
 *
 * @param {string} text
 * @param {string} label
 * @returns {unknown}
 * @throws {Error}
 */
export function parseJson(text, label) {
  try {
    return JSON.parse(text)
  } catch (error) {
    throw new Error(`${label} must be valid JSON: ${error instanceof Error ? error.message : 'unparsable'}`)
  }
}

/**
 * Write a line to stdout.
 *
 * @param {string} [line]
 * @returns {void}
 */
export function out(line = '') {
  process.stdout.write(`${line}\n`)
}

/**
 * Write a line to stderr.
 *
 * @param {string} line
 * @returns {void}
 */
export function fail(line) {
  process.stderr.write(`${line}\n`)
}
