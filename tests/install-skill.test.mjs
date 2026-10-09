/**
 * Installing the bundled Skill.
 *
 * A Skill that lands in the wrong directory is a Skill the client never reads,
 * and the client says nothing about it — so the command's whole job is to name
 * the right place and to refuse to clobber work that is already there.
 */

import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'

const run = promisify(execFile)
const cli = fileURLToPath(new URL('../src/cli.js', import.meta.url))
const bundled = readFileSync(fileURLToPath(new URL('../skills/jev-judge/SKILL.md', import.meta.url)), 'utf8')

/** Run the CLI, capturing the exit code instead of throwing. */
async function jev(args) {
  try {
    const { stdout, stderr } = await run(process.execPath, [cli, ...args])
    return { stdout, stderr, code: 0 }
  } catch (error) {
    return { stdout: error.stdout ?? '', stderr: error.stderr ?? '', code: error.code }
  }
}

/** A temp directory that cleans itself up. */
function withTempDir() {
  const dir = mkdtempSync(join(tmpdir(), 'jev-judge-skill-'))
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) }
}

test('the Skill installs into the given directory and is idempotent', async () => {
  const { dir, cleanup } = withTempDir()
  try {
    const first = await jev(['install-skill', '--dir', dir])
    assert.equal(first.code, 0)
    const installed = join(dir, 'jev-judge', 'SKILL.md')
    assert.ok(existsSync(installed))
    assert.equal(readFileSync(installed, 'utf8'), bundled)

    const second = await jev(['install-skill', '--dir', dir])
    assert.equal(second.code, 0)
    assert.match(second.stdout, /Already installed/)
  } finally {
    cleanup()
  }
})

test('a different file already there is not overwritten by accident', async () => {
  const { dir, cleanup } = withTempDir()
  try {
    const destination = join(dir, 'jev-judge')
    mkdirSync(destination, { recursive: true })
    writeFileSync(join(destination, 'SKILL.md'), 'mine, edited by hand\n')

    const refused = await jev(['install-skill', '--dir', dir])
    assert.equal(refused.code, 1)
    assert.match(refused.stderr, /Refusing to overwrite/)
    assert.equal(readFileSync(join(destination, 'SKILL.md'), 'utf8'), 'mine, edited by hand\n')

    const forced = await jev(['install-skill', '--dir', dir, '--force'])
    assert.equal(forced.code, 0)
    assert.equal(readFileSync(join(destination, 'SKILL.md'), 'utf8'), bundled)
  } finally {
    cleanup()
  }
})

test('--print says where it would go without writing anything', async () => {
  const { stdout, code } = await jev(['install-skill', '--print'])
  assert.equal(code, 0)
  assert.match(stdout, /jev-judge[\\/]SKILL\.md/)
})

test('an unknown or missing client is a usage error, not a stray directory', async () => {
  const missing = await jev(['install-skill'])
  assert.equal(missing.code, 2)
  assert.match(missing.stderr, /--agent is required/)

  const unknown = await jev(['install-skill', '--agent', 'emacs'])
  assert.equal(unknown.code, 2)
  assert.match(unknown.stderr, /unknown agent "emacs"/)
})
