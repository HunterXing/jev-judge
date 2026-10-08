#!/usr/bin/env node
/**
 * `jev-judge` — the command line face of the judgment kernel.
 *
 * The command table below is the single source of truth for `--help`: a command
 * appears there when it exists and works. Run `jev-judge <command> --help` for
 * one command's own options.
 *
 * @module dsh-jev-judge/cli
 */

import { parseArgs } from 'node:util'
import { PACKAGE_NAME, VERSION } from './meta.js'

/**
 * @typedef {object} Command
 * @property {string} summary One line shown in `--help`.
 * @property {(argv: string[]) => Promise<number>} run Runs the command; the
 *   return value is the process exit code.
 */

/** @type {Record<string, Command>} */
const COMMANDS = {}

const USAGE = `${PACKAGE_NAME} ${VERSION}

Usage: jev-judge <command> [options]

Options:
  -h, --help     Show this help.
  -v, --version  Show the version.

Commands:
${Object.entries(COMMANDS)
  .map(([name, command]) => `  ${name.padEnd(14)}${command.summary}`)
  .join('\n')}
`

/**
 * Run one invocation and answer the exit code.
 *
 * @param {string[]} argv Arguments after the executable name.
 * @returns {Promise<number>} The process exit code.
 */
export async function main(argv) {
  let parsed
  try {
    parsed = parseArgs({
      args: argv,
      options: {
        help: { type: 'boolean', short: 'h' },
        version: { type: 'boolean', short: 'v' },
      },
      allowPositionals: true,
      strict: true,
    })
  } catch (error) {
    process.stderr.write(`jev-judge: ${error.message}\n`)
    return 2
  }

  if (parsed.values.version) {
    process.stdout.write(`${PACKAGE_NAME} ${VERSION}\n`)
    return 0
  }

  const [commandName, ...rest] = parsed.positionals
  if (commandName === undefined || parsed.values.help) {
    process.stdout.write(USAGE)
    return 0
  }

  const command = COMMANDS[commandName]
  if (command === undefined) {
    process.stderr.write(`jev-judge: unknown command "${commandName}"\n\n${USAGE}`)
    return 2
  }
  return command.run(rest)
}

const exitCode = await main(process.argv.slice(2)).catch((error) => {
  process.stderr.write(`jev-judge: ${error?.stack ?? String(error)}\n`)
  return 1
})
process.exitCode = exitCode
