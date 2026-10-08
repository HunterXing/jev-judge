/**
 * The tier cascade: cheap judges first, only the open questions forwarded, and
 * one judge's failure never ending the call.
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'

import { runCascade } from '../src/kernel/cascade.js'
import { MockJudge, alwaysJudge } from '../src/kernel/judges/mock.js'
import { DEFAULT_UNCERTAINTY } from '../src/kernel/policy.js'

const questions = {
  urgent: { type: 'boolean', instructions: 'Urgent?' },
  bug: { type: 'boolean', instructions: 'A bug?' },
}

test('a later tier is asked only what the earlier one left open', async () => {
  const first = alwaysJudge({ urgent: { type: 'boolean', probability: 0.95 } }, { id: 'first' })
  const second = alwaysJudge({ bug: { type: 'boolean', probability: 0.9 } }, { id: 'second' })

  const result = await runCascade([first, second], {
    state: 'state',
    questions,
    band: DEFAULT_UNCERTAINTY,
  })

  assert.deepEqual(Object.keys(first.requests[0].questions), ['urgent', 'bug'])
  assert.deepEqual(Object.keys(second.requests[0].questions), ['bug'], 'only the uncertain one')
  assert.equal(result.answers.urgent.probability, 0.95)
  assert.equal(result.answers.bug.probability, 0.9)
  assert.deepEqual(result.tiers.map((tier) => tier.id), ['first', 'second'])
  assert.deepEqual(result.tiers[1].asked, ['bug'])
})

test('tiers stop as soon as every question is settled', async () => {
  const first = new MockJudge(
    () => ({
      urgent: { type: 'boolean', probability: 0.95 },
      bug: { type: 'boolean', probability: 0.05 },
    }),
    { id: 'first' },
  )
  const second = alwaysJudge({}, { id: 'second' })
  const result = await runCascade([first, second], { state: 's', questions })
  assert.equal(second.requests.length, 0)
  assert.equal(result.tiers.length, 1)
})

test('a failing tier is recorded and the next one still answers', async () => {
  const failing = new MockJudge(() => {
    throw new Error('down')
  }, { id: 'failing' })
  const backup = alwaysJudge({ urgent: { type: 'boolean', probability: 0.9 } }, { id: 'backup' })

  const result = await runCascade([failing, backup], { state: 's', questions })
  assert.equal(result.answers.urgent.probability, 0.9)
  assert.equal(result.error, undefined, 'a later tier answered, so this is not a failed call')
  assert.equal(result.tiers[0].errorKind, 'network')
  assert.deepEqual(result.tiers[0].answered, [])
})

test('a call no tier could answer reports the last failure', async () => {
  const failing = new MockJudge(() => {
    throw new Error('down')
  }, { id: 'failing' })
  const silent = new MockJudge(() => undefined, { id: 'silent' })

  const result = await runCascade([failing, silent], { state: 's', questions })
  assert.deepEqual(result.answers, {})
  assert.equal(result.error.kind, 'network')
  assert.equal(result.tiers.length, 2)
})

test('a tier is skipped for a question it cannot answer', async () => {
  const local = alwaysJudge({ urgent: { type: 'boolean', probability: 0.99 } }, {
    id: 'local',
    capabilities: ['classify'],
  })
  const hosted = alwaysJudge({ urgent: { type: 'boolean', probability: 0.99 } }, { id: 'hosted' })

  const result = await runCascade([local, hosted], {
    state: 's',
    questions,
    capabilities: { urgent: undefined, bug: 'relate' },
  })
  // The local judge may try `urgent` (no capability required) but nothing else.
  assert.deepEqual(result.tiers[0].asked, ['urgent'])
  assert.deepEqual(result.tiers[1].asked, ['bug'])
  assert.equal(hosted.requests.length, 1)
})

test('usage is summed across the tiers that answered', async () => {
  const first = new MockJudge(() => ({
    usage: { inputTokens: 10, outputTokens: 2 },
    answers: { urgent: { type: 'boolean', probability: 0.5 } },
  }), { id: 'first' })
  const second = new MockJudge(() => ({
    usage: { inputTokens: 5, outputTokens: 1 },
    answers: { urgent: { type: 'boolean', probability: 0.99 } },
  }), { id: 'second' })

  const result = await runCascade([first, second], { state: 's', questions })
  assert.deepEqual(result.usage, { inputTokens: 15, outputTokens: 3 })
  assert.equal(
    result.answers.urgent.probability,
    0.99,
    'the tier that was asked because the answer was uncertain replaces it',
  )
})

test('an aborted call stops before asking the next tier', async () => {
  const controller = new AbortController()
  const first = new MockJudge(() => {
    controller.abort()
    return { urgent: { type: 'boolean', probability: 0.5 } }
  }, { id: 'first' })
  const second = alwaysJudge({}, { id: 'second' })

  const result = await runCascade([first, second], {
    state: 's',
    questions,
    signal: controller.signal,
  })
  assert.equal(second.requests.length, 0)
  assert.equal(result.tiers.length, 1)
})
