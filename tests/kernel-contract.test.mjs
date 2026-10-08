/**
 * The data contract and the thresholds built on it. These are the rules a
 * decision point is rejected for breaking at import time, and the rules that
 * decide whether an answer is a direction or a shrug.
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  coerceAnswer,
  hasEscapeOption,
  normalizeOptionName,
  probabilitiesOf,
  validateQuestion,
  validateQuestions,
} from '../src/kernel/contract.js'
import {
  DEFAULT_UNCERTAINTY,
  isNo,
  isUncertain,
  isYes,
  normalizeBand,
  uncertainQuestionIds,
  within,
} from '../src/kernel/policy.js'

// ── questions ────────────────────────────────────────────────────────────────

test('a boolean question needs instructions and an optional criteria pair', () => {
  assert.doesNotThrow(() =>
    validateQuestion('urgent', { type: 'boolean', instructions: 'Is this urgent?' }),
  )
  assert.doesNotThrow(() =>
    validateQuestion('urgent', {
      type: 'boolean',
      instructions: 'Is this urgent?',
      criteria: { true: 'like "ASAP"', false: 'like "whenever"' },
    }),
  )
  assert.throws(() => validateQuestion('urgent', { type: 'boolean' }), /instructions/)
  assert.throws(
    () => validateQuestion('urgent', { type: 'boolean', instructions: 'x', criteria: [] }),
    /criteria/,
  )
})

test('a choice question needs a non-empty option map', () => {
  assert.doesNotThrow(() =>
    validateQuestion('team', {
      type: 'choice',
      instructions: 'Which team?',
      criteria: { billing: 'charges', other: 'anything else' },
    }),
  )
  assert.throws(
    () => validateQuestion('team', { type: 'choice', instructions: 'x', criteria: {} }),
    /non-empty/,
  )
  assert.throws(
    () => validateQuestion('team', { type: 'choice', instructions: 'x', criteria: { a: 1 } }),
    /text, a structured value, or null/,
  )
})

test('a score question needs at least two ordered levels', () => {
  assert.doesNotThrow(() =>
    validateQuestion('quality', {
      type: 'score',
      instructions: 'How good?',
      criteria: ['bad', 'ok', 'good'],
    }),
  )
  assert.throws(
    () => validateQuestion('quality', { type: 'score', instructions: 'x', criteria: ['only'] }),
    /at least two ordered levels/,
  )
})

test('an unknown question type is rejected', () => {
  assert.throws(
    () => validateQuestion('x', { type: 'prose', instructions: 'x' }),
    /expected one of boolean, choice, score/,
  )
  assert.throws(() => validateQuestions({ a: { type: 'boolean', instructions: 'x' }, b: {} }), /Question "b"/)
})

test('escape options are recognised however they are spelled', () => {
  for (const option of ['none', 'Other', 'no-match', 'UNKNOWN', 'unclear', 'not sure']) {
    assert.equal(normalizeOptionName(option), option.trim().toLowerCase().replaceAll(/[\s-]+/g, '_'))
  }
  assert.ok(hasEscapeOption({ criteria: { a: 'x', 'No match': 'y' } }))
  assert.ok(!hasEscapeOption({ criteria: { a: 'x', billing: 'y' } }))
})

// ── answers ──────────────────────────────────────────────────────────────────

test('a boolean answer decodes from the wire name and is clamped', () => {
  const question = { type: 'boolean', instructions: 'x' }
  assert.deepEqual(coerceAnswer(question, { noul: 0.9 }), { type: 'boolean', probability: 0.9 })
  assert.deepEqual(coerceAnswer(question, { noul: 0.9, confidence: 0.5 }), {
    type: 'boolean',
    probability: 0.9,
    confidence: 0.5,
  })

  const warnings = []
  assert.deepEqual(coerceAnswer(question, { noul: 1.4 }, { warnings }), {
    type: 'boolean',
    probability: 1,
  })
  assert.equal(warnings[0].type, 'out-of-range')
})

test('an answer that does not fit its question is dropped, not guessed', () => {
  const warnings = []
  assert.equal(coerceAnswer({ type: 'boolean', instructions: 'x' }, { score: 2 }), undefined)
  assert.equal(coerceAnswer({ type: 'boolean', instructions: 'x' }, { noul: 'yes' }), undefined)
  assert.equal(coerceAnswer({ type: 'boolean', instructions: 'x' }, undefined), undefined)
  assert.equal(
    coerceAnswer(
      { type: 'choice', instructions: 'x', criteria: { a: 'x', other: 'y' } },
      { choice: 'billing' },
      { warnings },
    ),
    undefined,
  )
  assert.equal(warnings.length, 0)
})

test('a choice answer keeps an optional distribution restricted to real options', () => {
  const question = { type: 'choice', instructions: 'x', criteria: { a: 'x', other: 'y' } }
  assert.deepEqual(coerceAnswer(question, { choice: 'a', probabilities: { a: 0.7, ghost: 0.3 } }), {
    type: 'choice',
    choice: 'a',
    probabilities: { a: 0.7 },
  })
})

test('a score answer is clamped to its rubric', () => {
  const question = { type: 'score', instructions: 'x', criteria: ['a', 'b', 'c'] }
  assert.deepEqual(coerceAnswer(question, { score: 1.5 }), { type: 'score', score: 1.5 })
  assert.deepEqual(coerceAnswer(question, { score: 9 }), { type: 'score', score: 2 })
})

test('probabilities drop non-numbers and empty distributions', () => {
  assert.deepEqual(probabilitiesOf({ a: 0.5, b: 'x' }), { a: 0.5 })
  assert.equal(probabilitiesOf({ a: 'x' }), undefined)
  assert.equal(probabilitiesOf(null), undefined)
  assert.deepEqual(probabilitiesOf({ a: 0.5, b: 0.5 }, ['a']), { a: 0.5 })
})

// ── thresholds ───────────────────────────────────────────────────────────────

test('the uncertainty band is validated and defaulted', () => {
  assert.deepEqual(normalizeBand(undefined), DEFAULT_UNCERTAINTY)
  assert.deepEqual(normalizeBand({ low: 0.1 }), { ...DEFAULT_UNCERTAINTY, low: 0.1 })
  assert.throws(() => normalizeBand({ low: 0.9 }), /below `high`/)
  assert.throws(() => normalizeBand({ high: 2 }), /number in \[0, 1\]/)
  assert.throws(() => normalizeBand([]), /must be an object/)
})

test('a boolean is a direction only outside the band', () => {
  assert.ok(isYes(0.85))
  assert.ok(isNo(0.15))
  assert.ok(!isYes(0.6))
  assert.ok(!isNo(0.6))
  assert.ok(isUncertain({ type: 'boolean' }, { type: 'boolean', probability: 0.6 }))
  assert.ok(!isUncertain({ type: 'boolean' }, { type: 'boolean', probability: 0.95 }))
})

test('a missing answer is the strongest uncertainty', () => {
  assert.ok(isUncertain({ type: 'boolean' }, undefined))
  assert.ok(isUncertain({ type: 'boolean' }, { type: 'boolean', probability: 0.99, confidence: 0.2 }))
  assert.ok(isUncertain({ type: 'choice' }, { type: 'choice', choice: 'other' }))
  assert.ok(!isUncertain({ type: 'choice' }, { type: 'choice', choice: 'billing' }))
  assert.ok(!isUncertain({ type: 'score' }, { type: 'score', score: 2 }))
})

test('only the uncertain questions are forwarded to the next tier', () => {
  const questions = {
    urgent: { type: 'boolean' },
    team: { type: 'choice', instructions: 'x', criteria: { billing: 'x', other: 'y' } },
    quality: { type: 'score', instructions: 'x', criteria: ['a', 'b'] },
  }
  const ids = uncertainQuestionIds(questions, {
    urgent: { type: 'boolean', probability: 0.95 },
    team: { type: 'choice', choice: 'other' },
    quality: { type: 'score', score: 1 },
  })
  assert.deepEqual(ids, ['team'])
})

// ── bounded waits ────────────────────────────────────────────────────────────

test('within resolves to the fallback instead of rejecting', async () => {
  const slow = new Promise((resolve) => setTimeout(() => resolve('late'), 50))
  assert.equal(await within(slow, 5, { fallback: 'gave up' }), 'gave up')
  assert.equal(await within(Promise.resolve('quick'), 50, { fallback: 'gave up' }), 'quick')
  assert.equal(await within(Promise.reject(new Error('boom')), 50, { fallback: 'safe' }), 'safe')
})

test('within gives up immediately when the budget is already gone', async () => {
  let settled = false
  const pending = new Promise((resolve) => setTimeout(() => { settled = true; resolve('late') }, 20))
  assert.equal(await within(pending, 0, { fallback: null }), null)
  assert.equal(settled, false)
})

test('within honours an already-aborted signal', async () => {
  const controller = new AbortController()
  controller.abort()
  const pending = new Promise((resolve) => setTimeout(() => resolve('late'), 20))
  assert.equal(await within(pending, 100, { fallback: 'cancelled', signal: controller.signal }), 'cancelled')
})
