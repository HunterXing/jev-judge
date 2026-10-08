/**
 * What the ledger keeps and what it must never keep.
 *
 * The record has to be comparable across sessions without becoming a second copy
 * of someone's content or credentials, so both halves are pinned here: the digest
 * by default, and the scrubber in front of every string that is written.
 */

import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import { FileLedger, MemoryLedger, createLedger, stateDigest } from '../src/kernel/ledger.js'
import { createRedactor, environmentSecrets, redactText, redactValue } from '../src/kernel/redact.js'

/** A temp directory that cleans itself up. */
function withTempDir() {
  const dir = mkdtempSync(join(tmpdir(), 'jev-judge-ledger-'))
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) }
}

const record = {
  point: 'tool.admission',
  version: 1,
  mode: 'active',
  source: 'judge',
  outcome: 'keep',
  answers: { keep: { type: 'boolean', probability: 0.93 } },
  latencyMs: 312,
  state: { task: 'fix the crash', passage: 'a stack trace' },
}

// ── scrubbing ────────────────────────────────────────────────────────────────

test('credential shapes are removed from text', () => {
  assert.equal(redactText('Authorization: Bearer sk-live-abcdef123456'), 'Authorization: Bearer [redacted]')
  assert.equal(redactText('used key api_key=sk-live-abcdef123456 here'), 'used key api_key=[redacted] here')
  assert.equal(redactText('https://x.test/v1?key=sk-live-abcdef123456&model=jev'), 'https://x.test/v1?key=[redacted]&model=jev')
  assert.equal(redactText('x-api-key: "sk-live-abcdef123456"'), 'x-api-key: "[redacted]"')
  assert.equal(redactText('nothing to hide'), 'nothing to hide')
})

test('every occurrence of a known secret value goes, whatever the context', () => {
  const secret = 'sk-live-abcdef123456'
  assert.equal(redactText(`a ${secret} b ${secret} c`, [secret]), 'a [redacted] b [redacted] c')
})

test('secret-looking environment values are collected by name, not printed', () => {
  const secrets = environmentSecrets({
    JEV_API_KEY: 'sk-live-abcdef123456',
    SOME_TOKEN: 'tok-abcdefghijkl',
    PASSWORD: 'hunter2hunter2',
    PATH: '/usr/bin:/bin',
    SHORT_KEY: 'tiny',
  })
  assert.ok(secrets.has('sk-live-abcdef123456'))
  assert.ok(secrets.has('tok-abcdefghijkl'))
  assert.ok(secrets.has('hunter2hunter2'))
  assert.ok(!secrets.has('/usr/bin:/bin'), 'an ordinary variable is not a secret')
  assert.ok(!secrets.has('tiny'), 'too short to be a credential')
})

test('a value is scrubbed at any depth, and hostile shapes do not hang it', () => {
  const cyclic = { key: 'sk-live-abcdef123456' }
  cyclic.self = cyclic
  const scrubbed = redactValue({ nested: [{ token: 'Bearer sk-live-abcdef123456' }], cyclic })
  assert.equal(scrubbed.nested[0].token, 'Bearer [redacted]')
  assert.equal(scrubbed.cyclic.self, '[circular]')

  let deep = 'sk-live-abcdef123456'
  for (let index = 0; index < 20; index += 1) deep = { next: deep }
  assert.equal(JSON.stringify(redactValue(deep)).includes('[truncated]'), true)
})

test('one redactor covers a whole deployment', () => {
  const redactor = createRedactor({ env: { MY_API_KEY: 'sk-live-abcdef123456' }, secrets: ['extra-secret-value'] })
  assert.equal(redactor.text('sk-live-abcdef123456 and extra-secret-value'), '[redacted] and [redacted]')
})

// ── the ledger ───────────────────────────────────────────────────────────────

test('a record keeps a digest of the judged state, not the state', () => {
  const ledger = new MemoryLedger()
  const stored = ledger.append(record)
  assert.equal(stored.state, undefined)
  assert.equal(stored.stateDigest, stateDigest(record.state))
  assert.equal(typeof stored.id, 'string')
  assert.deepEqual(stored.answers, record.answers)
})

test('recordState is the only way the judged state is written', () => {
  const ledger = new MemoryLedger({ recordState: true })
  const stored = ledger.append(record)
  assert.deepEqual(stored.state, record.state)
  assert.equal(stored.stateDigest, undefined)
})

test('the file ledger writes NDJSON that reads back in order', () => {
  const { dir, cleanup } = withTempDir()
  try {
    const ledger = new FileLedger({ path: join(dir, 'nested', 'ledger.ndjson') })
    ledger.append({ ...record, point: 'first' })
    ledger.append({ ...record, point: 'second' })
    ledger.append({ ...record, point: 'third' })

    const lines = readFileSync(join(dir, 'nested', 'ledger.ndjson'), 'utf8').trim().split('\n')
    assert.equal(lines.length, 3)
    for (const line of lines) assert.doesNotThrow(() => JSON.parse(line))

    assert.deepEqual(
      ledger.read({ limit: 2 }).map((entry) => entry.point),
      ['second', 'third'],
    )
    assert.deepEqual(
      ledger.read().map((entry) => entry.point),
      ['first', 'second', 'third'],
    )
  } finally {
    cleanup()
  }
})

test('a ledger file is private from the moment it exists', () => {
  const { dir, cleanup } = withTempDir()
  try {
    const path = join(dir, 'ledger.ndjson')
    new FileLedger({ path }).append(record)
    assert.equal(statSync(path).mode & 0o077, 0, 'no group or world access')
  } finally {
    cleanup()
  }
})

test('a crashed line is skipped rather than failing the read', () => {
  const { dir, cleanup } = withTempDir()
  try {
    const path = join(dir, 'ledger.ndjson')
    const ledger = new FileLedger({ path })
    ledger.append(record)
    // A crash mid-write leaves a half line behind.
    writeFileSync(path, '{"point":"truncated"', { flag: 'a' })
    assert.deepEqual(
      ledger.read().map((entry) => entry.point),
      ['tool.admission'],
    )
  } finally {
    cleanup()
  }
})

test('the ledger rotates instead of growing without bound', () => {
  const { dir, cleanup } = withTempDir()
  try {
    const path = join(dir, 'ledger.ndjson')
    const ledger = new FileLedger({ path, maxBytes: 200 })
    for (let index = 0; index < 8; index += 1) ledger.append({ ...record, point: `p${index}` })
    assert.ok(statSync(`${path}.1`).size > 0, 'the previous file is kept as .1')
    assert.equal(ledger.read().at(-1).point, 'p7')
  } finally {
    cleanup()
  }
})

test('a credential in a record never reaches the file', () => {
  const { dir, cleanup } = withTempDir()
  try {
    const path = join(dir, 'ledger.ndjson')
    const redactor = createRedactor({ env: { JEV_API_KEY: 'sk-live-abcdef123456' } })
    const ledger = new FileLedger({ path, recordState: true, redactor })
    ledger.append({
      ...record,
      reason: 'auth: Bearer sk-live-abcdef123456 rejected',
      state: { url: 'https://x.test/v1?key=sk-live-abcdef123456' },
    })
    const contents = readFileSync(path, 'utf8')
    assert.ok(!contents.includes('sk-live-abcdef123456'), 'the key must not be in the ledger')
    assert.match(contents, /\[redacted\]/)
  } finally {
    cleanup()
  }
})

test('createLedger only builds one when a path is configured', () => {
  assert.equal(createLedger({}), null)
  assert.equal(createLedger({ path: null }), null)
  assert.ok(createLedger({ path: '/tmp/example-ledger.ndjson' }) instanceof FileLedger)
})

test('a ledger that cannot be written never breaks a decision', () => {
  const ledger = new FileLedger({ path: '/proc/definitely/not/writable/ledger.ndjson' })
  assert.equal(ledger.append(record).point, 'tool.admission')
})
