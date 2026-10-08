#!/usr/bin/env node
/**
 * `jev-judge` — the command line face of the judgment kernel.
 *
 * The command table below is the single source of truth for `--help`: a command
 * appears there when it exists and works. Everything after the command name
 * belongs to that command, including `--help`, so the dispatcher never has to
 * guess which options are its own.
 *
 * @module dsh-jev-judge/cli
 */

import { PACKAGE_NAME, VERSION } from './meta.js'
import { command as doctor } from './commands/doctor.js'
import { command as judge } from './commands/judge.js'
import { command as ledger } from './commands/ledger.js'
import { command as smoke } from './commands/smoke.js'
import { command as verify } from './commands/verify.js'
import { UsageError, out } from './commands/support.js'

/**
 * @typedef {object} Command
 * @property {string} summary One line shown in `--help`.
 * @property {string} [usage] The command's own options, shown for `<command> --help`.
 * @property {(argv: string[]) => Promise<number>} run Runs the command; the return
 *   value is the process exit code.
 */

/** @type {Record<string, Command>} */
const COMMANDS = { verify, doctor, judge, ledger, smoke }

const USAGE = `${PACKAGE_NAME} ${VERSION}

Usage: jev-judge <command> [options]

Options:
  -h, --help     Show this help.
  -v, --version  Show the version.

Commands:
${Object.entries(COMMANDS)
  .map(([name, command]) => `  ${name.padEnd(12)}${command.summary}`)
  .join('\n')}

Run "jev-judge <command> --help" for one command's options.`

/**
 * Run one invocation and answer the exit code.
 *
 * @param {string[]} argv Arguments after the executable name.
 * @returns {Promise<number>} The process exit code.
 */
export async function main(argv) {
  const [firstName] = argv

  if (firstName === undefined || firstName === '--help' || firstName === '-h') {
    out(USAGE)
    return 0
  }
  if (firstName === '--version' || firstName === '-v') {
    out(`${PACKAGE_NAME} ${VERSION}`)
    return 0
  }

  const command = COMMANDS[firstName]
  if (command === undefined) {
    process.stderr.write(`jev-judge: unknown command "${firstName}"\n\n${USAGE}\n`)
    return 2
  }

  const rest = argv.slice(1)
  if (rest.includes('--help') || rest.includes('-h')) {
    out(command.usage ?? `${firstName} — ${command.summary}`)
    return 0
  }

  try {
    return await command.run(rest)
  } catch (error) {
    if (error instanceof UsageError) {
      process.stderr.write(`jev-judge ${firstName}: ${error.message}\n`)
      return 2
    }
    throw error
  }
}

const exitCode = await main(process.argv.slice(2)).catch((error) => {
  process.stderr.write(`jev-judge: ${error?.stack ?? String(error)}\n`)
  return 1
})
process.exitCode = exitCode
