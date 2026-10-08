/**
 * The CLI is what a user meets first and what a host adapter shells out to, so
 * its two non-negotiables are covered here: `--version` reports the manifest
 * version, and an unknown command fails loudly instead of silently doing nothing.
 */

import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'

const run = promisify(execFile)
const cli = fileURLToPath(new URL('../src/cli.js', import.meta.url))
const manifest = JSON.parse(
  readFileSync(fileURLToPath(new URL('../package.json', import.meta.url)), 'utf8'),
)

/** Run the CLI, returning stdout, stderr and the exit code instead of throwing. */
async function cli_(args) {
  try {
    const { stdout, stderr } = await run(process.execPath, [cli, ...args])
    return { stdout, stderr, code: 0 }
  } catch (error) {
    return { stdout: error.stdout ?? '', stderr: error.stderr ?? '', code: error.code }
  }
}

test('--version reports the manifest identity', async () => {
  const { stdout, code } = await cli_(['--version'])
  assert.equal(code, 0)
  assert.equal(stdout.trim(), `${manifest.name} ${manifest.version}`)
})

test('--help lists the usage and the available commands', async () => {
  const { stdout, code } = await cli_(['--help'])
  assert.equal(code, 0)
  assert.match(stdout, /Usage: jev-judge <command> \[options\]/)
})

test('an unknown command fails with a nonzero code', async () => {
  const { stderr, code } = await cli_(['nope'])
  assert.equal(code, 2)
  assert.match(stderr, /unknown command "nope"/)
})

test('an unknown option fails with a nonzero code', async () => {
  const { stderr, code } = await cli_(['--nope'])
  assert.equal(code, 2)
  assert.match(stderr, /jev-judge:/)
})
