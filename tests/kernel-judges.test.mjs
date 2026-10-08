/**
 * The judges that talk to a provider.
 *
 * Every network call here runs against a fake `fetch`, so the tests pin the
 * things that must not drift: the System One wire shape, how a failure is
 * classified, that a key or a body never reaches a message, and that the chat
 * fallback says out loud that it is one.
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  ChatJsonJudge,
  buildChatPrompt,
  extractJsonObject,
} from '../src/kernel/judges/chat-json.js'
import {
  SystemOneJudge,
  buildAuthorizationHeader,
  buildSystemOnePayload,
  resolveEndpoint,
  toWireQuestion,
} from '../src/kernel/judges/typesafe.js'
import { buildHeaders } from '../src/kernel/judges/http.js'
import { isJudgeError } from '../src/kernel/errors.js'

/** A fetch that answers with one canned response and records what it was sent. */
function fakeFetch(response, recorded = []) {
  const impl = async (url, init) => {
    recorded.push({ url, init })
    return {
      ok: response.status >= 200 && response.status < 300,
      status: response.status,
      text: async () => response.body,
    }
  }
  impl.recorded = recorded
  return impl
}

// ── the wire ─────────────────────────────────────────────────────────────────

test('a base URL and the endpoint path are joined once', () => {
  assert.equal(resolveEndpoint('https://api.example.com'), 'https://api.example.com/v1/systemone')
  assert.equal(
    resolveEndpoint('https://api.example.com/provider/'),
    'https://api.example.com/provider/v1/systemone',
  )
  assert.equal(
    resolveEndpoint('https://api.example.com/v1/systemone'),
    'https://api.example.com/v1/systemone',
  )
  assert.equal(resolveEndpoint('http://127.0.0.1:8700', ''), 'http://127.0.0.1:8700')
})

test('a boolean question becomes a noul on the wire', () => {
  assert.deepEqual(toWireQuestion({ type: 'boolean', instructions: 'Urgent?' }), {
    type: 'noul',
    instructions: 'Urgent?',
  })
  assert.deepEqual(
    toWireQuestion({ type: 'boolean', instructions: 'Urgent?', criteria: { true: 'x', false: 'y' } }),
    { type: 'noul', instructions: 'Urgent?', criteria: { true: 'x', false: 'y' } },
  )
  assert.deepEqual(
    toWireQuestion({
      type: 'choice',
      instructions: 'Team?',
      criteria: { billing: 'charges', other: 'rest' },
    }),
    { type: 'choice', instructions: 'Team?', criteria: { billing: 'charges', other: 'rest' } },
  )
})

test('the payload is one state and one question map', () => {
  const payload = buildSystemOnePayload({
    model: 'jev',
    state: { passage: 'text' },
    questions: { keep: { type: 'boolean', instructions: 'Keep?' } },
  })
  assert.deepEqual(payload, {
    model: 'jev',
    state: { passage: 'text' },
    questions: { keep: { type: 'noul', instructions: 'Keep?' } },
  })
})

test('the authentication header follows the configured scheme', () => {
  assert.equal(buildAuthorizationHeader({ apiKey: 'k', authScheme: 'Bearer' }), 'Bearer k')
  assert.equal(buildAuthorizationHeader({ apiKey: 'k', authScheme: '' }), 'k')
})

test('a managed header cannot be overridden by extra headers', () => {
  const headers = buildHeaders({
    apiKey: 'secret',
    authScheme: 'Bearer',
    extraHeaders: { authorization: 'stolen', 'X-Tenant': 't1', 'Content-Type': 'text/plain' },
  })
  assert.equal(headers.Authorization, 'Bearer secret')
  assert.equal(headers.authorization, undefined)
  assert.equal(headers['X-Tenant'], 't1')
  assert.equal(headers['content-type'], 'application/json')
})

// ── the System One judge ─────────────────────────────────────────────────────

test('a System One answer is decoded into typed answers', async () => {
  const fetchImpl = fakeFetch({
    status: 200,
    body: JSON.stringify({
      model: 'jev-1.13',
      answers: {
        keep: { type: 'noul', noul: 0.87 },
        team: { type: 'choice', choice: 'billing', probabilities: { billing: 0.8, other: 0.2 } },
      },
      usage: { input_tokens: 120, output_tokens: 8 },
    }),
  })
  const judge = new SystemOneJudge({
    apiKey: 'k',
    model: 'jev',
    baseUrl: 'https://api.example.com/provider',
    fetch: fetchImpl,
  })

  const result = await judge.evaluate({
    state: { passage: 'p' },
    questions: {
      keep: { type: 'boolean', instructions: 'Keep?' },
      team: { type: 'choice', instructions: 'Team?', criteria: { billing: 'x', other: 'y' } },
    },
  })

  assert.equal(result.answers.keep.probability, 0.87)
  assert.equal(result.answers.team.choice, 'billing')
  assert.deepEqual(result.usage, { inputTokens: 120, outputTokens: 8 })
  assert.equal(result.modelId, 'jev-1.13')

  const [sent] = fetchImpl.recorded
  assert.equal(sent.url, 'https://api.example.com/provider/v1/systemone')
  assert.equal(sent.init.method, 'POST')
  assert.equal(sent.init.headers.Authorization, 'Bearer k')
  assert.deepEqual(JSON.parse(sent.init.body).questions.keep, { type: 'noul', instructions: 'Keep?' })
})

test('an unusable answer is dropped with a warning, not guessed', async () => {
  const fetchImpl = fakeFetch({
    status: 200,
    body: JSON.stringify({ answers: { keep: { type: 'noul', noul: 'yes' }, ghost: { noul: 1 } } }),
  })
  const judge = new SystemOneJudge({ apiKey: 'k', model: 'jev', baseUrl: 'https://x.test', fetch: fetchImpl })
  const result = await judge.evaluate({
    state: 's',
    questions: { keep: { type: 'boolean', instructions: 'Keep?' } },
  })
  assert.deepEqual(result.answers, {})
  assert.deepEqual(
    result.warnings.map((warning) => warning.type).sort(),
    ['unexpected-answer', 'unusable-answer'],
  )
})

test('a failure is classified without echoing the body or the key', async () => {
  const secrets = 'sk-live-should-never-appear'
  const cases = [
    [401, 'auth'],
    [402, 'payment_required'],
    [403, 'auth'],
    [429, 'rate_limited'],
    [500, 'server'],
    [400, 'bad_request'],
  ]
  for (const [status, expected] of cases) {
    const fetchImpl = fakeFetch({ status, body: `{"error":"${secrets} ${expected}"}` })
    const judge = new SystemOneJudge({
      apiKey: secrets,
      model: 'jev',
      baseUrl: 'https://x.test',
      fetch: fetchImpl,
    })
    const error = await judge
      .evaluate({ state: 's', questions: { keep: { type: 'boolean', instructions: 'x' } } })
      .then(() => null, (thrown) => thrown)
    assert.ok(isJudgeError(error), `HTTP ${status} must throw a JudgeError`)
    assert.equal(error.kind, expected, `HTTP ${status} kind`)
    assert.ok(!error.message.includes(secrets), 'the message must not contain the key or the body')
    assert.ok(!error.message.includes('balance'), 'the body must not reach the message')
  }
})

test('a 403 that names billing is read as a plan problem, not a bad key', async () => {
  const judge = new SystemOneJudge({
    apiKey: 'k',
    model: 'jev',
    baseUrl: 'https://x.test',
    fetch: fakeFetch({ status: 403, body: '{"error":"your credit balance is too low"}' }),
  })
  const error = await judge
    .evaluate({ state: 's', questions: { keep: { type: 'boolean', instructions: 'x' } } })
    .then(() => null, (thrown) => thrown)
  assert.equal(error.kind, 'payment_required')
})

test('a non-JSON success body is a malformed failure', async () => {
  const judge = new SystemOneJudge({
    apiKey: 'k',
    model: 'jev',
    baseUrl: 'https://x.test',
    fetch: fakeFetch({ status: 200, body: '<html>gateway</html>' }),
  })
  const error = await judge
    .evaluate({ state: 's', questions: { keep: { type: 'boolean', instructions: 'x' } } })
    .then(() => null, (thrown) => thrown)
  assert.equal(error.kind, 'malformed')
})

test('a provider that never answers spends the budget and is a timeout', async () => {
  const hanging = (url, init) =>
    new Promise((resolve, reject) => {
      init.signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })))
    })
  const judge = new SystemOneJudge({
    apiKey: 'k',
    model: 'jev',
    baseUrl: 'https://x.test',
    timeoutMs: 20,
    fetch: hanging,
  })
  const error = await judge
    .evaluate({ state: 's', questions: { keep: { type: 'boolean', instructions: 'x' } } })
    .then(() => null, (thrown) => thrown)
  assert.equal(error.kind, 'timeout')
  assert.match(error.message, /within 20ms/)
  assert.equal(error.retryable, true)
})

test('a caller cancellation is not reported as a provider outage', async () => {
  const hanging = (url, init) =>
    new Promise((resolve, reject) => {
      init.signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })))
    })
  const controller = new AbortController()
  const judge = new SystemOneJudge({
    apiKey: 'k',
    model: 'jev',
    baseUrl: 'https://x.test',
    timeoutMs: 5000,
    fetch: hanging,
  })
  const pending = judge.evaluate({
    state: 's',
    questions: { keep: { type: 'boolean', instructions: 'x' } },
    signal: controller.signal,
  })
  controller.abort()
  const error = await pending.then(() => null, (thrown) => thrown)
  assert.equal(error.kind, 'timeout')
  assert.match(error.message, /cancelled/)
})

// ── the chat fallback ────────────────────────────────────────────────────────

test('the chat prompt carries the state and the questions as data', () => {
  const prompt = buildChatPrompt({ passage: 'p' }, {
    keep: { type: 'boolean', instructions: 'Keep?' },
  })
  assert.match(prompt, /one JSON object and nothing else/)
  assert.match(prompt, /"passage":"p"/)
  assert.match(prompt, /"type":"noul"/)
})

test('a fenced or padded JSON reply is still read', () => {
  assert.deepEqual(extractJsonObject('{"answers":{}}'), { answers: {} })
  assert.deepEqual(extractJsonObject('Sure!\n```json\n{"answers":{"a":1}}\n```'), { answers: { a: 1 } })
  assert.deepEqual(extractJsonObject('here you go: {"answers":{"a":1}} hope that helps'), {
    answers: { a: 1 },
  })
  assert.equal(extractJsonObject('no json at all'), undefined)
  assert.equal(extractJsonObject('{"broken": '), undefined)
})

test('a chat answer is decoded and marked as lower fidelity', async () => {
  const fetchImpl = fakeFetch({
    status: 200,
    body: JSON.stringify({
      model: 'gpt-x',
      choices: [{ message: { content: '```json\n{"answers":{"keep":{"noul":0.91}}}\n```' } }],
    }),
  })
  const judge = new ChatJsonJudge({
    apiKey: 'k',
    model: 'gpt-x',
    baseUrl: 'https://gateway.test',
    fetch: fetchImpl,
  })
  const result = await judge.evaluate({
    state: 's',
    questions: { keep: { type: 'boolean', instructions: 'Keep?' } },
  })
  assert.equal(result.answers.keep.probability, 0.91)
  assert.deepEqual(result.warnings, [
    { type: 'fidelity', message: 'answered by a prompted chat model, not by a typed decision endpoint' },
  ])
  assert.equal(fetchImpl.recorded[0].url, 'https://gateway.test/v1/chat/completions')
})

test('a chat reply that is not JSON is a malformed failure', async () => {
  const judge = new ChatJsonJudge({
    apiKey: 'k',
    model: 'gpt-x',
    baseUrl: 'https://gateway.test',
    fetch: fakeFetch({ status: 200, body: JSON.stringify({ choices: [{ message: { content: 'I think yes.' } }] }) }),
  })
  const error = await judge
    .evaluate({ state: 's', questions: { keep: { type: 'boolean', instructions: 'x' } } })
    .then(() => null, (thrown) => thrown)
  assert.equal(error.kind, 'malformed')
})
