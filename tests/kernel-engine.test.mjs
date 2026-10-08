/**
 * The engine: what each mode is allowed to do, what happens when nobody
 * answers, and what the ledger keeps.
 *
 * The tests are written against the two promises the kernel makes — a verdict
 * that is not certain enough to act on becomes the fallback, and no failure in
 * the kernel reaches the caller as an exception.
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'

import { ABSTAIN, createEngine, defineDecision } from '../src/kernel/decision.js'
import { MockJudge, alwaysJudge, silentJudge } from '../src/kernel/judges/mock.js'
import { MemoryLedger } from '../src/kernel/ledger.js'

/** A point that keeps or drops a passage, the shape most points have. */
function keepDecision(overrides = {}) {
  return defineDecision({
    id: 'test.keep',
    version: 1,
    questions: {
      keep: {
        type: 'boolean',
        instructions: 'Does `passage` matter for `task`?',
        criteria: { true: 'like a stack trace', false: 'like a timestamp' },
      },
    },
    cacheImpact: 'none',
    latency: 'inline',
    buildState: (input) => ({ task: input.task, passage: input.passage }),
    policy: (answers) => (answers.keep.probability >= 0.8 ? 'keep' : 'drop'),
    fallback: () => 'drop',
    ...overrides,
  })
}

test('a decision point is rejected when it could not be answered or acted on', () => {
  assert.throws(() => defineDecision({ ...keepDecision(), id: '' }), /non-empty `id`/)
  assert.throws(() => defineDecision({ ...keepDecision(), version: 0 }), /positive integer/)
  assert.throws(() => defineDecision({ ...keepDecision(), cacheImpact: 'sometimes' }), /cacheImpact/)
  assert.throws(() => defineDecision({ ...keepDecision(), latency: 'whenever' }), /latency/)
  assert.throws(() => defineDecision({ ...keepDecision(), policy: undefined }), /`policy` function/)
  assert.throws(
    () =>
      defineDecision({
        ...keepDecision(),
        questions: { team: { type: 'choice', instructions: 'x', criteria: { a: 'x' } } },
      }),
    /no escape option/,
  )
  assert.doesNotThrow(() =>
    defineDecision({
      ...keepDecision(),
      allowChoicesWithoutEscape: true,
      questions: { team: { type: 'choice', instructions: 'x', criteria: { a: 'x' } } },
    }),
  )
})

test('active applies the judged outcome; shadow records it and changes nothing', async () => {
  const ledger = new MemoryLedger()
  const spec = keepDecision()
  const judge = alwaysJudge({ keep: { type: 'boolean', probability: 0.95 } })

  const active = createEngine({ judges: { mock: judge }, modes: { default: 'active' }, ledger })
  const acted = await active.decide(spec, { task: 'fix the crash', passage: 'stack trace' })
  assert.equal(acted.outcome, 'keep')
  assert.equal(acted.source, 'judge')
  assert.equal(acted.answers.keep.probability, 0.95)
  assert.equal(ledger.records.length, 1)
  assert.equal(ledger.records[0].source, 'judge')
  assert.equal(ledger.records[0].point, 'test.keep')

  const shadow = createEngine({ judges: { mock: judge }, modes: { default: 'shadow' }, ledger })
  const watched = await shadow.decide(spec, { task: 'fix the crash', passage: 'stack trace' })
  assert.equal(watched.outcome, 'drop')
  assert.equal(watched.source, 'fallback')
  assert.equal(watched.judged, 'keep')
  assert.equal(shadow.stats().decisions, 1)
})

test('an unconfigured point is shadow: a verdict has to earn the right to act', async () => {
  const judge = alwaysJudge({ keep: { type: 'boolean', probability: 0.99 } })
  const engine = createEngine({ judges: { mock: judge } })
  assert.equal(engine.mode('test.keep'), 'shadow')
  const decision = await engine.decide(keepDecision(), { task: 't', passage: 'p' })
  assert.equal(decision.source, 'fallback')
})

test('an off point asks nothing and records nothing', async () => {
  const ledger = new MemoryLedger()
  const judge = alwaysJudge({ keep: { type: 'boolean', probability: 0.99 } })
  const engine = createEngine({ judges: { mock: judge }, modes: { 'test.keep': 'off' }, ledger })
  const decision = await engine.decide(keepDecision(), { task: 't', passage: 'p' })
  assert.equal(decision.outcome, 'drop')
  assert.equal(decision.reason, 'off')
  assert.equal(judge.requests.length, 0)
  assert.equal(ledger.records.length, 0)
})

test('a low probability is judged and then declined by the policy', async () => {
  const judge = alwaysJudge({ keep: { type: 'boolean', probability: 0.3 } })
  const engine = createEngine({ judges: { mock: judge }, modes: { default: 'active' } })
  const decision = await engine.decide(keepDecision(), { task: 't', passage: 'p' })
  assert.equal(decision.outcome, 'drop')
  assert.equal(decision.source, 'judge')
})

test('ABSTAIN is a decline, not a failure', async () => {
  const judge = alwaysJudge({ keep: { type: 'boolean', probability: 0.5 } })
  const engine = createEngine({ judges: { mock: judge }, modes: { default: 'active' } })
  const spec = keepDecision({ policy: () => ABSTAIN })
  const decision = await engine.decide(spec, { task: 't', passage: 'p' })
  assert.equal(decision.outcome, 'drop')
  assert.equal(decision.source, 'fallback')
  assert.equal(decision.reason, 'abstain')
  assert.equal(engine.stats().abstentions, 1)
})

test('no judge configured means the fallback, with the reason kept', async () => {
  const engine = createEngine({ judges: {} })
  const decision = await engine.decide(keepDecision(), { task: 't', passage: 'p' }, { mode: 'active' })
  assert.equal(decision.outcome, 'drop')
  assert.equal(decision.reason, 'no-judge-configured')
})

test('a judge that answers nothing is not an error', async () => {
  const engine = createEngine({ judges: { silent: silentJudge() }, modes: { default: 'active' } })
  const decision = await engine.decide(keepDecision(), { task: 't', passage: 'p' })
  assert.equal(decision.reason, 'no-answer')
  assert.equal(decision.source, 'fallback')
})

test('a judge that throws is classified and never escapes', async () => {
  const boom = new MockJudge(() => {
    throw new Error('provider exploded')
  }, { id: 'boom' })
  const engine = createEngine({ judges: { boom }, modes: { default: 'active' } })
  const decision = await engine.decide(keepDecision(), { task: 't', passage: 'p' })
  assert.equal(decision.source, 'fallback')
  assert.match(decision.reason, /network: judge "boom" failed: provider exploded/)
  assert.equal(engine.stats().failures, 1)
})

test('a policy that throws yields the fallback instead of an exception', async () => {
  const judge = alwaysJudge({ keep: { type: 'boolean', probability: 0.9 } })
  const engine = createEngine({ judges: { mock: judge }, modes: { default: 'active' } })
  const spec = keepDecision({
    policy: () => {
      throw new Error('bad threshold')
    },
  })
  const decision = await engine.decide(spec, { task: 't', passage: 'p' })
  assert.equal(decision.outcome, 'drop')
  assert.match(decision.reason, /policy-error: bad threshold/)
})

test('a fallback that throws still returns a value', async () => {
  const engine = createEngine({ judges: {} })
  const spec = keepDecision({
    fallback: () => {
      throw new Error('fallback is broken')
    },
  })
  const decision = await engine.decide(spec, { task: 't', passage: 'p' })
  assert.deepEqual(decision.outcome, { error: 'fallback-failed', message: 'fallback is broken' })
})

test('a slow judge spends the budget, not the turn', async () => {
  const slow = new MockJudge(
    () => new Promise((resolve) => setTimeout(() => resolve({}), 200)),
    { id: 'slow' },
  )
  const engine = createEngine({ judges: { slow }, modes: { default: 'active' }, timeoutMs: 20 })
  const startedAt = Date.now()
  const decision = await engine.decide(keepDecision(), { task: 't', passage: 'p' })
  assert.equal(decision.outcome, 'drop')
  assert.match(decision.reason, /timeout after 20ms/)
  assert.ok(Date.now() - startedAt < 150, 'the decision must not wait for the judge')
})

test('the ledger keeps the verdict, the answers and never the raw state by default', async () => {
  const ledger = new MemoryLedger()
  const judge = alwaysJudge({ keep: { type: 'boolean', probability: 0.95, confidence: 0.9 } })
  const engine = createEngine({ judges: { mock: judge }, modes: { default: 'active' }, ledger })
  const decision = await engine.decide(
    keepDecision(),
    { task: 'fix the crash', passage: 'secret-looking passage' },
    { subject: { session: 's-1' } },
  )

  const [record] = ledger.records
  assert.equal(record.id, decision.ledgerId)
  assert.equal(record.point, 'test.keep')
  assert.equal(record.version, 1)
  assert.equal(record.mode, 'active')
  assert.equal(record.source, 'judge')
  assert.equal(record.outcome, 'keep')
  assert.equal(record.answers.keep.probability, 0.95)
  assert.deepEqual(record.subject, { session: 's-1' })
  assert.equal(record.state, undefined)
  assert.equal(typeof record.stateDigest, 'string')
  assert.match(record.ts, /^\d{4}-\d{2}-\d{2}T/)
})

test('batching asks once per distinct state and keeps each point own policy', async () => {
  const ledger = new MemoryLedger()
  const judge = new MockJudge(({ questions }) => {
    const answers = {}
    for (const id of Object.keys(questions)) answers[id] = { type: 'boolean', probability: 0.95 }
    return answers
  }, { id: 'batch' })

  const first = keepDecision()
  const second = defineDecision({
    id: 'test.escalate',
    version: 1,
    questions: { escalate: { type: 'boolean', instructions: 'Does `task` need a human?' } },
    cacheImpact: 'none',
    latency: 'inline',
    // Same state as `first`, so the two points can share one request.
    buildState: (input) => ({ task: input.task, passage: input.passage }),
    policy: (answers) => (answers.escalate.probability >= 0.8 ? 'human' : 'agent'),
    fallback: () => 'agent',
  })
  const engine = createEngine({ judges: { batch: judge }, modes: { default: 'active' }, ledger })

  const decisions = await engine.decideMany([
    { spec: first, input: { task: 'same state', passage: 'p' } },
    { spec: second, input: { task: 'same state', passage: 'p' } },
  ])

  assert.equal(judge.requests.length, 1, 'one request for one shared state')
  assert.deepEqual(Object.keys(judge.requests[0].questions).sort(), ['0:keep', '1:escalate'])
  assert.equal(decisions[0].outcome, 'keep')
  assert.equal(decisions[1].outcome, 'human')
  assert.equal(decisions[0].answers.keep.probability, 0.95)
  assert.equal(decisions[1].answers.escalate.probability, 0.95)
  assert.equal(ledger.records.length, 2)
  assert.equal(engine.stats().decisions, 2)
})

test('batching keeps unrelated states apart', async () => {
  const judge = alwaysJudge({ keep: { type: 'boolean', probability: 0.95 } })
  const engine = createEngine({ judges: { mock: judge }, modes: { default: 'active' } })
  const spec = keepDecision()
  await engine.decideMany([
    { spec, input: { task: 'a', passage: 'p' } },
    { spec, input: { task: 'b', passage: 'p' } },
  ])
  assert.equal(judge.requests.length, 2)
})

test('batching skips an off point without dragging its neighbour out of one request', async () => {
  const judge = alwaysJudge({ keep: { type: 'boolean', probability: 0.95 } })
  const engine = createEngine({
    judges: { mock: judge },
    modes: { default: 'active', 'test.keep': 'off' },
  })
  const spec = keepDecision()
  const decisions = await engine.decideMany([
    { spec, input: { task: 'a', passage: 'p' } },
    { spec: keepDecision({ id: 'test.keep2' }), input: { task: 'a', passage: 'p' } },
  ])
  assert.equal(judge.requests.length, 1)
  assert.equal(decisions[0].reason, 'off')
  assert.equal(decisions[1].outcome, 'keep')
})

test('per-point routes pick their own judges', async () => {
  const cheap = alwaysJudge({ keep: { type: 'boolean', probability: 0.1 } }, { id: 'cheap' })
  const careful = alwaysJudge({ keep: { type: 'boolean', probability: 0.95 } }, { id: 'careful' })
  const engine = createEngine({
    judges: { cheap, careful },
    tiers: ['cheap'],
    routes: { 'test.keep': ['careful'] },
    modes: { default: 'active' },
  })
  const decision = await engine.decide(keepDecision(), { task: 't', passage: 'p' })
  assert.equal(decision.outcome, 'keep')
  assert.equal(careful.requests.length, 1)
  assert.equal(cheap.requests.length, 0)
})
