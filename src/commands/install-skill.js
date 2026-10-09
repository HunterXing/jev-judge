/**
 * `jev-judge install-skill` — put the Agent Skill where an agent reads it.
 *
 * The Skill is what tells an agent *when* to hand a judgment over instead of
 * reading everything itself, so it has to live in the directory its client
 * scans. Those directories differ per client and per platform, and a client
 * that does not find the file says nothing — which is why this command exists
 * rather than a line in the README telling people to copy a path by hand.
 *
 * @module dsh-jev-judge/commands/install-skill
 */

import { copyFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

import { UsageError, fail, out, parse } from './support.js'

/** Where this package keeps the Skill it ships. */
export const SKILL_SOURCE = new URL('../../skills/jev-judge/SKILL.md', import.meta.url)

/** The directory this Skill installs into, under each client's skills root. */
export const SKILL_DIRECTORY = 'jev-judge'

/**
 * The skills root each supported client scans, or `null` when the client reads
 * no user-level skills and the caller has to name a directory.
 */
export const TARGETS = Object.freeze({
  'claude-code': () => join(homedir(), '.claude', 'skills'),
  codex: () => join(homedir(), '.codex', 'skills'),
  opencode: () => join(homedir(), '.config', 'opencode', 'skills'),
  agents: () => join(homedir(), '.agents', 'skills'),
})

/** @type {import('../cli.js').Command} */
export const command = {
  summary: 'Install the bundled Agent Skill into a client skill directory.',
  usage: `install-skill — install the bundled Agent Skill into a client skill directory.

Options:
  --agent <name>   claude-code, codex, opencode, or agents.
  --dir <path>     Install into this directory instead of a known client.
  --force          Overwrite an existing, different SKILL.md.
  --print          Print the file's path instead of writing anything.`,
  async run(argv) {
    const { values } = parse(argv, {
      agent: { type: 'string' },
      dir: { type: 'string' },
      force: { type: 'boolean' },
      print: { type: 'boolean' },
    })

    if (values.print) {
      out(join(SKILL_DIRECTORY, 'SKILL.md'))
      out(`source: ${new URL(SKILL_SOURCE).pathname}`)
      return 0
    }

    const root = values.dir ? String(values.dir) : resolveTarget(values.agent)
    const destination = join(root, SKILL_DIRECTORY)
    const path = join(destination, 'SKILL.md')

    if (existsSync(path)) {
      const same = readFileSync(path, 'utf8') === readFileSync(SKILL_SOURCE, 'utf8')
      if (same) {
        out(`Already installed: ${path}`)
        return 0
      }
      if (!values.force) {
        fail(`Refusing to overwrite a different file: ${path}`)
        fail('Re-run with --force to replace it.')
        return 1
      }
    }

    try {
      mkdirSync(destination, { recursive: true })
      copyFileSync(SKILL_SOURCE, path)
    } catch (error) {
      fail(`Could not install the Skill: ${error instanceof Error ? error.message : String(error)}`)
      return 1
    }

    out(`Installed: ${path}`)
    return 0
  },
}

/**
 * The skills root for one client name.
 *
 * @param {unknown} agent
 * @returns {string}
 * @throws {UsageError}
 */
function resolveTarget(agent) {
  const name = String(agent ?? '').trim()
  if (name === '') {
    throw new UsageError(
      `--agent is required (one of ${Object.keys(TARGETS).join(', ')}) unless --dir is given`,
    )
  }
  const resolve = TARGETS[name]
  if (resolve === undefined) {
    throw new UsageError(
      `unknown agent "${name}"; expected one of ${Object.keys(TARGETS).join(', ')}, or --dir <path>`,
    )
  }
  return resolve()
}
