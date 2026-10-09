/**
 * The MCP adapter, driven the way a client drives it.
 *
 * The server is a real child process talking real newline-delimited JSON over
 * stdio, and the judge is a real HTTP call to a fake System One provider on
 * loopback. Nothing here is mocked at the layer the tests are about.
 */

import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

const cli = fileURLToPath(new URL('../src/cli.js', import.meta.url))

/** A fake System One provider: answers every asked question with one probability. */
async function withProvider(probability = 0.93) {
  const requests = []
  const server = createServer((request, response) => {
    let body = ''
    request.on('data', (chunk) => {
      body += chunk
    })
    request.on('end', () => {
      const payload = JSON.parse(body)
      requests.push(payload)
      const answers = {}
      for (const id of Object.keys(payload.questions ?? {})) {
        answers[id] = { type: 'noul', noul: probability }
      }
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ model: 'jev-test', answers }))
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

/** A temporary private provider record plus kernel settings. */
function withConfig(dir, baseUrl, kernel, missingProvider = false) {
  const provider = join(dir, 'provider.json')
  if (missingProvider) {
    // A deployment with no provider record at all is the real "no judge" case.
    const env = { JEV_SKILL_CONFIG: join(dir, 'absent.json') }
    if (kernel) {
      const kernelPath = join(dir, 'kernel.json')
      writeFileSync(kernelPath, JSON.stringify(kernel), { mode: 0o600 })
      env.JEV_JUDGE_CONFIG = kernelPath
    }
    return env
  }
  writeFileSync(
    provider,
    JSON.stringify({
      providerName: 'local-test',
      baseUrl,
      model: 'jev-test',
      protocol: 'systemone',
      apiKey: 'sk-local-test-key-0001',
      timeoutSeconds: 5,
    }),
    { mode: 0o600 },
  )
  chmodSync(provider, 0o600)
  const env = { JEV_SKILL_CONFIG: provider }
  if (kernel) {
    const kernelPath = join(dir, 'kernel.json')
    writeFileSync(kernelPath, JSON.stringify(kernel), { mode: 0o600 })
    env.JEV_JUDGE_CONFIG = kernelPath
  }
  return env
}

/**
 * A client around the spawned server: write a line, await the next response.
 */
class McpClient {
  constructor(env) {
    this.child = spawn(process.execPath, [cli, 'mcp'], {
      env: { ...process.env, ...env },
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    this.buffer = ''
    this.pending = []
    this.stderr = ''
    this.child.stdout.on('data', (chunk) => {
      this.buffer += String(chunk)
      let newline = this.buffer.indexOf('\n')
      while (newline !== -1) {
        const line = this.buffer.slice(0, newline)
        this.buffer = this.buffer.slice(newline + 1)
        if (line.trim() !== '') this.pending.push(JSON.parse(line))
        newline = this.buffer.indexOf('\n')
      }
    })
    this.child.stderr.on('data', (chunk) => {
      this.stderr += String(chunk)
    })
  }

  /** Send one message. */
  send(message) {
    this.child.stdin.write(`${JSON.stringify(message)}\n`)
  }

  /** Await the next response, with a deadline so a hung server fails the test. */
  async next(timeoutMs = 5000) {
    const startedAt = Date.now()
    while (this.pending.length === 0) {
      if (Date.now() - startedAt > timeoutMs) throw new Error('the server did not answer in time')
      await new Promise((resolve) => setTimeout(resolve, 10))
    }
    return this.pending.shift()
  }

  /** Give the server a moment to prove it does NOT answer. */
  async quiet(milliseconds = 200) {
    await new Promise((resolve) => setTimeout(resolve, milliseconds))
    return this.pending.length
  }

  async close() {
    this.child.stdin.end()
    await new Promise((resolve) => {
      this.child.on('exit', resolve)
      setTimeout(() => {
        this.child.kill()
        resolve()
      }, 2000)
    })
  }
}

/** Run one scenario against a fresh server. */
async function withClient(run, options = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'jev-judge-mcp-'))
  const provider = options.provider ?? (await withProvider(options.probability ?? 0.93))
  const client = new McpClient(
    withConfig(dir, provider.baseUrl, options.kernel, options.missingProvider === true),
  )
  try {
    await run(client, provider)
  } finally {
    await client.close()
    if (options.provider === undefined) await provider.close()
    rmSync(dir, { recursive: true, force: true })
  }
}

test('the handshake names the server and answers the requested protocol', async () => {
  await withClient(async (client) => {
    client.send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } })
    const response = await client.next()
    assert.equal(response.id, 1)
    assert.equal(response.result.protocolVersion, '2025-06-18')
    assert.deepEqual(response.result.capabilities, { tools: {} })
    assert.equal(response.result.serverInfo.name, 'dsh-jev-judge')
    assert.match(response.result.serverInfo.version, /^\d+\.\d+\.\d+$/)
  })
})

test('a notification is never answered', async () => {
  await withClient(async (client) => {
    client.send({ jsonrpc: '2.0', method: 'notifications/initialized' })
    assert.equal(await client.quiet(), 0, 'a notification must not produce a response')

    // The server is still alive and ordered after the notification.
    client.send({ jsonrpc: '2.0', id: 2, method: 'ping' })
    assert.deepEqual((await client.next()).result, {})
  })
})

test('the tools are listed with usable schemas', async () => {
  await withClient(async (client) => {
    client.send({ jsonrpc: '2.0', id: 1, method: 'tools/list' })
    const { result } = await client.next()
    assert.deepEqual(
      result.tools.map((tool) => tool.name),
      ['judge_items', 'judge_ask', 'judge_ledger'],
    )
    for (const tool of result.tools) {
      assert.equal(tool.inputSchema.type, 'object')
      assert.equal(tool.inputSchema.additionalProperties, false)
      assert.ok(tool.description.length > 40, `${tool.name} needs a real description`)
    }
    assert.deepEqual(result.tools[0].inputSchema.required, ['question', 'items'])
  })
})

test('judge_items answers one question about many items in one request', async () => {
  await withClient(async (client, provider) => {
    client.send({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: {
        name: 'judge_items',
        arguments: {
          task: 'fix the crash',
          question: { instructions: 'Does this mention the crash?' },
          items: [
            { id: 'a', text: 'crash at login' },
            { id: 'b', text: 'a health line' },
          ],
        },
      },
    })

    const { result } = await client.next()
    assert.equal(result.isError, undefined)
    const payload = JSON.parse(result.content[0].text)
    assert.deepEqual(payload.selected, ['a', 'b'])
    assert.equal(payload.items[0].probability, 0.93)
    assert.equal(provider.requests.length, 1, 'both items travel in one request')
    assert.deepEqual(Object.keys(provider.requests[0].questions), ['a', 'b'])
  })
})

test('judge_items reports an unavailable judge instead of pretending nothing matched', async () => {
  await withClient(
    async (client) => {
      client.send({
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: {
          name: 'judge_items',
          arguments: { question: { instructions: 'relevant?' }, items: [{ id: 'a', text: 'x' }] },
        },
      })
      const payload = JSON.parse((await client.next()).result.content[0].text)
      assert.equal(payload.unavailable, true)
      assert.deepEqual(payload.selected, [])
      assert.match(payload.note, /No judge is available/)
    },
    { missingProvider: true },
  )
})

test('judge_ask answers typed questions and rejects malformed ones', async () => {
  await withClient(async (client) => {
    client.send({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: {
        name: 'judge_ask',
        arguments: {
          state: { ticket: 'charged twice' },
          questions: { urgent: { type: 'boolean', instructions: 'Is this urgent?' } },
        },
      },
    })
    const good = JSON.parse((await client.next()).result.content[0].text)
    assert.equal(good.answers.urgent.probability, 0.93)
    assert.equal(good.source, 'judge')

    client.send({
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/call',
      params: {
        name: 'judge_ask',
        arguments: {
          state: {},
          questions: { team: { type: 'choice', instructions: 'Which team?', criteria: { billing: 'x' } } },
        },
      },
    })
    const bad = await client.next()
    assert.equal(bad.result.isError, true)
    assert.match(bad.result.content[0].text, /escape option/)
  })
})

test('judge_ledger is empty rather than an error when nothing is configured', async () => {
  await withClient(async (client) => {
    client.send({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'judge_ledger', arguments: {} } })
    const payload = JSON.parse((await client.next()).result.content[0].text)
    assert.deepEqual(payload, { path: null, records: [], note: 'No ledger is configured.' })
  })
})

test('judge_ledger reads a configured ledger, newest last', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'jev-judge-mcp-ledger-'))
  try {
    const ledgerPath = join(dir, 'ledger.ndjson')
    writeFileSync(
      ledgerPath,
      `${JSON.stringify({ id: '1', ts: '2026-10-08T00:00:00.000Z', point: 'tool.admission', version: 1, mode: 'active', source: 'judge', outcome: 'trimmed', latencyMs: 12 })}\n`,
    )
    await withClient(async (client) => {
      client.send({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'judge_ledger', arguments: {} } })
      const payload = JSON.parse((await client.next()).result.content[0].text)
      assert.equal(payload.records.length, 1)
      assert.equal(payload.records[0].point, 'tool.admission')
      assert.match(payload.path, /ledger\.ndjson$/)
    }, { kernel: { ledger: { path: ledgerPath } } })
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('protocol mistakes come back as JSON-RPC errors, not silence', async () => {
  await withClient(async (client) => {
    client.send({ jsonrpc: '2.0', id: 1, method: 'no/such/method' })
    const unknown = await client.next()
    assert.equal(unknown.error.code, -32601)

    client.send({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'no_such_tool' } })
    assert.equal((await client.next()).error.code, -32602)

    client.child.stdin.write('this is not json\n')
    const parseError = await client.next()
    assert.equal(parseError.error.code, -32700)
    assert.equal(parseError.id, null)
  })
})

test('the CLI documents the mcp command', async () => {
  const { execFile } = await import('node:child_process')
  const { promisify } = await import('node:util')
  const { stdout } = await promisify(execFile)(process.execPath, [cli, 'mcp', '--help'])
  assert.match(stdout, /mcpServers/)
  assert.match(stdout, /js|json|mcp/i)
})
