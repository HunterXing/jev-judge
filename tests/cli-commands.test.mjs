/**
 * The commands, end to end.
 *
 * A local HTTP server stands in for the provider, so the whole path is exercised
 * — discovery, validation, the wire call, the answers, the exit code — without a
 * key and without a bill. Loopback HTTP is allowed by the same rule that lets a
 * local judge run, which is what makes this possible.
 */

import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'

const run = promisify(execFile)
const cli = fileURLToPath(new URL('../src/cli.js', import.meta.url))

/** Run the CLI with a controlled environment, capturing output instead of throwing. */
async function jev(args, env = {}) {
  try {
    const { stdout, stderr } = await run(process.execPath, [cli, ...args], {
      env: { ...process.env, ...env },
      maxBuffer: 8 * 1024 * 1024,
    })
    return { stdout, stderr, code: 0 }
  } catch (error) {
    return { stdout: error.stdout ?? '', stderr: error.stderr ?? '', code: error.code }
  }
}

/** A temp directory that cleans itself up. */
function withTempDir() {
  const dir = mkdtempSync(join(tmpdir(), 'jev-judge-cli-'))
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) }
}

/** Write a private provider record pointing at `baseUrl`. */
function writeProvider(dir, baseUrl, extra = {}) {
  const path = join(dir, 'provider.json')
  writeFileSync(
    path,
    JSON.stringify({
      providerName: 'local-test',
      baseUrl,
      model: 'jev-test',
      protocol: 'systemone',
      apiKey: 'sk-local-test-key-0001',
      timeoutSeconds: 5,
      ...extra,
    }),
    { mode: 0o600 },
  )
  chmodSync(path, 0o600)
  return path
}

/** A fake System One provider: answers every question from the payload. */
async function withProvider(handler) {
  const requests = []
  const server = createServer((request, response) => {
    let body = ''
    request.on('data', (chunk) => {
      body += chunk
    })
    request.on('end', () => {
      requests.push(JSON.parse(body))
      const payload = handler(JSON.parse(body), requests.length)
      response.writeHead(payload.status ?? 200, { 'content-type': 'application/json' })
      response.end(
        payload.status && payload.status >= 400
          ? (payload.body ?? '{"error":"nope"}')
          : JSON.stringify(payload.body),
      )
    })
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address()
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    requests,
    close: () => new Promise((resolve) => server.close(resolve)),
  }
}

// ── verify ───────────────────────────────────────────────────────────────────

test('verify reports the contract and hides the key', async () => {
  const { dir, cleanup } = withTempDir()
  try {
    const config = writeProvider(dir, 'https://api.example.com/provider')
    const { stdout, code } = await jev(['verify', '--config', config])
    assert.equal(code, 0)
    assert.match(stdout, /^Configuration valid\.$/m)
    assert.match(stdout, /Provider:\s+local-test/)
    assert.match(stdout, /Endpoint:\s+https:\/\/api\.example\.com\/provider\/v1\/systemone/)
    assert.match(stdout, /Key source: config file apiKey; value hidden/)
    assert.ok(!stdout.includes('sk-local-test-key-0001'), 'the key is never printed')
  } finally {
    cleanup()
  }
})

test('verify fails on a record the contract rejects', async () => {
  const { dir, cleanup } = withTempDir()
  try {
    const config = writeProvider(dir, 'http://api.example.com')
    const { stdout, stderr, code } = await jev(['verify', '--config', config])
    assert.equal(code, 1)
    assert.match(stdout + stderr, /Configuration invalid: .*https/)
  } finally {
    cleanup()
  }
})

test('verify --quiet reports through the exit code only', async () => {
  const { dir, cleanup } = withTempDir()
  try {
    const config = writeProvider(dir, 'https://api.example.com')
    const { stdout, code } = await jev(['verify', '--config', config, '--quiet'])
    assert.equal(code, 0)
    assert.equal(stdout.trim(), '')
  } finally {
    cleanup()
  }
})

// ── doctor ───────────────────────────────────────────────────────────────────

test('doctor shows what will happen, and nothing else', async () => {
  const { dir, cleanup } = withTempDir()
  try {
    const config = writeProvider(dir, 'https://api.example.com/provider')
    const kernel = join(dir, 'kernel.json')
    writeFileSync(kernel, JSON.stringify({ modes: { default: 'shadow', 'tool.admission': 'active' } }), {
      mode: 0o600,
    })

    const { stdout, code } = await jev(['doctor', '--config', config, '--kernel', kernel])
    assert.equal(code, 0)
    assert.match(stdout, /model:\s+jev-test/)
    assert.match(stdout, /tiers:\s+jev/)
    assert.match(stdout, /"tool\.admission":"active"/)
    assert.ok(!stdout.includes('sk-local-test-key-0001'))
  } finally {
    cleanup()
  }
})

test('doctor --json is machine readable and reports problems through the exit code', async () => {
  const { dir, cleanup } = withTempDir()
  try {
    const missing = join(dir, 'nope.json')
    const { stdout, code } = await jev(['doctor', '--config', missing, '--json'])
    assert.equal(code, 1)
    const report = JSON.parse(stdout)
    assert.equal(report.provider.configured, false)
    assert.deepEqual(report.judges, [])
    assert.ok(report.problems.length > 0)
  } finally {
    cleanup()
  }
})

// ── judge ────────────────────────────────────────────────────────────────────

test('judge asks a typed question and prints the probability', async () => {
  const provider = await withProvider(() => ({
    body: { model: 'jev-test', answers: { keep: { type: 'noul', noul: 0.93 } } },
  }))
  const { dir, cleanup } = withTempDir()
  try {
    const config = writeProvider(dir, provider.baseUrl)
    const { stdout, code } = await jev(
      [
        'judge',
        '--state',
        '{"passage":"a stack trace"}',
        '--question',
        '{"keep":{"type":"boolean","instructions":"Keep?"}}',
      ],
      { JEV_SKILL_CONFIG: config },
    )
    assert.equal(code, 0)
    assert.match(stdout, /keep: 0\.9300/)

    const [sent] = provider.requests
    assert.equal(sent.model, 'jev-test')
    assert.deepEqual(sent.questions.keep, { type: 'noul', instructions: 'Keep?' })
    assert.deepEqual(sent.state, { passage: 'a stack trace' })
  } finally {
    cleanup()
    await provider.close()
  }
})

test('judge --json carries the answers and the tier report', async () => {
  const provider = await withProvider(() => ({
    body: {
      answers: { team: { type: 'choice', choice: 'billing', probabilities: { billing: 0.8, other: 0.2 } } },
      usage: { input_tokens: 20, output_tokens: 4 },
    },
  }))
  const { dir, cleanup } = withTempDir()
  try {
    const config = writeProvider(dir, provider.baseUrl)
    const { stdout, code } = await jev(
      [
        'judge',
        '--state',
        '{}',
        '--question',
        '{"team":{"type":"choice","instructions":"Which team?","criteria":{"billing":"charges","other":"rest"}}}',
        '--json',
      ],
      { JEV_SKILL_CONFIG: config },
    )
    assert.equal(code, 0)
    const parsed = JSON.parse(stdout)
    assert.equal(parsed.answers.team.choice, 'billing')
    assert.equal(parsed.source, 'judge')
    assert.deepEqual(parsed.usage, { inputTokens: 20, outputTokens: 4 })
    assert.equal(parsed.tiers[0].id, 'systemone:jev-test')
  } finally {
    cleanup()
    await provider.close()
  }
})

test('judge exits 1 when the provider answers nothing', async () => {
  const provider = await withProvider(() => ({ body: { answers: {} } }))
  const { dir, cleanup } = withTempDir()
  try {
    const config = writeProvider(dir, provider.baseUrl)
    const { stderr, code } = await jev(
      ['judge', '--state', '{}', '--question', '{"keep":{"type":"boolean","instructions":"Keep?"}}'],
      { JEV_SKILL_CONFIG: config },
    )
    assert.equal(code, 1)
    assert.match(stderr, /no answer: no-answer/)
  } finally {
    cleanup()
    await provider.close()
  }
})

test('judge reports a provider failure as a classified reason', async () => {
  const provider = await withProvider(() => ({ status: 401, body: '{"error":"bad key sk-local-test-key-0001"}' }))
  const { dir, cleanup } = withTempDir()
  try {
    const config = writeProvider(dir, provider.baseUrl)
    const { stderr, code } = await jev(
      ['judge', '--state', '{}', '--question', '{"keep":{"type":"boolean","instructions":"Keep?"}}'],
      { JEV_SKILL_CONFIG: config },
    )
    assert.equal(code, 1)
    assert.match(stderr, /auth: judge provider answered HTTP 401/)
    assert.ok(!stderr.includes('sk-local-test-key-0001'), 'the key never reaches the output')
  } finally {
    cleanup()
    await provider.close()
  }
})

test('judge rejects a malformed question before calling anyone', async () => {
  const provider = await withProvider(() => ({ body: { answers: {} } }))
  const { dir, cleanup } = withTempDir()
  try {
    const config = writeProvider(dir, provider.baseUrl)
    const { code } = await jev(['judge', '--question', '{"x":{"type":"prose","instructions":"?"}}'], {
      JEV_SKILL_CONFIG: config,
    })
    assert.equal(code, 1)
    assert.equal(provider.requests.length, 0)
  } finally {
    cleanup()
    await provider.close()
  }
})

// ── ledger ───────────────────────────────────────────────────────────────────

test('ledger prints the recent records, filters by point, and prints JSON', async () => {
  const { dir, cleanup } = withTempDir()
  try {
    const path = join(dir, 'ledger.ndjson')
    const record = (point, reason) =>
      JSON.stringify({
        id: `id-${point}`,
        ts: '2026-10-08T00:00:00.000Z',
        point,
        version: 1,
        mode: 'active',
        source: reason ? 'fallback' : 'judge',
        outcome: 'keep',
        ...(reason ? { reason } : {}),
        latencyMs: 12,
      })
    writeFileSync(path, `${record('tool.admission')}\n${record('turn.continue', 'abstain')}\n`)

    const kernel = join(dir, 'kernel.json')
    writeFileSync(kernel, JSON.stringify({ ledger: { path } }), { mode: 0o600 })

    const env = { JEV_JUDGE_CONFIG: kernel }
    const all = await jev(['ledger'], env)
    assert.equal(all.code, 0)
    assert.match(all.stdout, /tool\.admission/)
    assert.match(all.stdout, /turn\.continue/)
    assert.match(all.stdout, /\(abstain\)/)

    const filtered = await jev(['ledger', '--point', 'turn.continue'], env)
    assert.match(filtered.stdout, /turn\.continue/)
    assert.ok(!filtered.stdout.includes('tool.admission'))

    const json = await jev(['ledger', '--json'], env)
    const parsed = JSON.parse(json.stdout)
    assert.equal(parsed.length, 2)
    assert.equal(parsed[1].reason, 'abstain')
  } finally {
    cleanup()
  }
})

test('ledger says so when nothing is configured', async () => {
  const { dir, cleanup } = withTempDir()
  try {
    const kernel = join(dir, 'kernel.json')
    writeFileSync(kernel, '{}', { mode: 0o600 })
    const { stderr, code } = await jev(['ledger'], { JEV_JUDGE_CONFIG: kernel })
    assert.equal(code, 2)
    assert.match(stderr, /no ledger is configured/)
  } finally {
    cleanup()
  }
})

// ── smoke ────────────────────────────────────────────────────────────────────

test('smoke refuses to spend money without --yes', async () => {
  const provider = await withProvider(() => ({ body: { answers: {} } }))
  const { dir, cleanup } = withTempDir()
  try {
    const config = writeProvider(dir, provider.baseUrl)
    const { stderr, code } = await jev(['smoke', '--config', config])
    assert.equal(code, 2)
    assert.match(stderr, /without --yes/)
    assert.equal(provider.requests.length, 0, 'no request may be sent')
  } finally {
    cleanup()
    await provider.close()
  }
})

test('smoke with --yes reports the answer it got', async () => {
  const provider = await withProvider(() => ({
    body: { model: 'jev-test', answers: { is_configuration_valid: { type: 'noul', noul: 0.97 } } },
  }))
  const { dir, cleanup } = withTempDir()
  try {
    const config = writeProvider(dir, provider.baseUrl)
    const { stdout, code } = await jev(['smoke', '--yes', '--config', config])
    assert.equal(code, 0)
    assert.match(stdout, /systemone reachable: model=jev-test is_configuration_valid=0\.9700/)
    assert.equal(provider.requests.length, 1)
  } finally {
    cleanup()
    await provider.close()
  }
})

test('smoke fails cleanly when the provider refuses', async () => {
  const provider = await withProvider(() => ({ status: 500 }))
  const { dir, cleanup } = withTempDir()
  try {
    const config = writeProvider(dir, provider.baseUrl)
    const { stderr, code } = await jev(['smoke', '--yes', '--config', config])
    assert.equal(code, 1)
    assert.match(stderr, /Smoke test failed — server: judge provider answered HTTP 500/)
  } finally {
    cleanup()
    await provider.close()
  }
})

// ── the shell itself ─────────────────────────────────────────────────────────

test('a command that does not exist fails without running anything', async () => {
  const { stderr, code } = await jev(['frobnicate'])
  assert.equal(code, 2)
  assert.match(stderr, /unknown command "frobnicate"/)
})

test('every command documents itself', async () => {
  const { stdout, code } = await jev(['--help'])
  assert.equal(code, 0)
  const names = [...stdout.matchAll(/^ {2}(\w+)\s+\S/gm)].map((match) => match[1])
  assert.deepEqual(names.sort(), ['doctor', 'hook', 'judge', 'ledger', 'mcp', 'smoke', 'verify'])

  for (const name of names) {
    const help = await jev([name, '--help'])
    assert.equal(help.code, 0, `${name} --help must succeed`)
    // Every command explains itself beyond its one-line summary. A command with
    // no options of its own documents arguments instead, so either heading is a
    // complete answer.
    assert.ok(
      help.stdout.includes('Options:') || help.stdout.includes('Arguments:'),
      `${name} must document its own arguments`,
    )
    assert.ok(help.stdout.length > 60, `${name} --help must say something useful`)
  }
})
