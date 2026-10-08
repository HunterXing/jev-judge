/**
 * Thresholds and bounded waits.
 *
 * A probability is a direction, not a decision: the policy of a decision point
 * turns it into an outcome. This module holds the two pieces every policy needs
 * — where "uncertain" lies, and how long a verdict is worth waiting for — so
 * that the numbers are named, configurable and testable in one place.
 *
 * @module dsh-jev-judge/kernel/policy
 */

import { ESCAPE_OPTIONS, normalizeOptionName } from './contract.js'

/**
 * Where a judge's answer counts as uncertain rather than as a direction.
 *
 * Boolean probabilities are compressed: clear cases land near 0.15 and 0.85, so
 * a band of (0.2, 0.8) is where a second judge earns its cost. Choice answers
 * are sharper, so for them uncertainty is an escape option or a low confidence
 * rather than a low top probability.
 *
 * @typedef {object} UncertaintyBand
 * @property {number} low Below or equal to this, a boolean answer counts as no.
 * @property {number} high At or above this, a boolean answer counts as yes.
 * @property {number} minConfidence Reported confidence below which any answer is uncertain.
 */

/** The band the kernel uses unless a deployment configures another. */
export const DEFAULT_UNCERTAINTY = Object.freeze({
  low: 0.2,
  high: 0.8,
  minConfidence: 0.5,
})

/**
 * Check a band and fill in the defaults.
 *
 * @param {Partial<UncertaintyBand> | undefined} band
 * @returns {UncertaintyBand}
 * @throws {TypeError}
 */
export function normalizeBand(band) {
  if (band === undefined) return { ...DEFAULT_UNCERTAINTY }
  if (typeof band !== 'object' || band === null || Array.isArray(band)) {
    throw new TypeError('uncertainty band must be an object')
  }
  const merged = { ...DEFAULT_UNCERTAINTY, ...band }
  const { low, high, minConfidence } = merged
  for (const [name, value] of Object.entries({ low, high, minConfidence })) {
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 1) {
      throw new TypeError(`uncertainty band \`${name}\` must be a number in [0, 1]`)
    }
  }
  if (low >= high) {
    throw new TypeError('uncertainty band needs `low` below `high`')
  }
  return merged
}

/**
 * Whether a boolean probability is a confident yes.
 *
 * @param {number} probability
 * @param {UncertaintyBand} [band]
 * @returns {boolean}
 */
export function isYes(probability, band = DEFAULT_UNCERTAINTY) {
  return probability >= band.high
}

/**
 * Whether a boolean probability is a confident no.
 *
 * @param {number} probability
 * @param {UncertaintyBand} [band]
 * @returns {boolean}
 */
export function isNo(probability, band = DEFAULT_UNCERTAINTY) {
  return probability <= band.low
}

/**
 * Whether an answer leaves the question open. A missing answer is the strongest
 * form of uncertainty: it means no judge answered at all.
 *
 * @param {{type: string, probability?: number, choice?: string, confidence?: number}} question
 * @param {import('./contract.js').Answer | undefined} answer
 * @param {UncertaintyBand} [band]
 * @param {{escapeOptions?: readonly string[]}} [options]
 * @returns {boolean}
 */
export function isUncertain(question, answer, band = DEFAULT_UNCERTAINTY, options = {}) {
  if (answer === undefined) return true
  if (answer.confidence !== undefined && answer.confidence < band.minConfidence) return true

  if (question.type === 'boolean') {
    const probability = answer.probability
    if (typeof probability !== 'number') return true
    return probability > band.low && probability < band.high
  }

  if (question.type === 'choice') {
    const escape = options.escapeOptions ?? ESCAPE_OPTIONS
    return escape.includes(normalizeOptionName(answer.choice))
  }

  return false
}

/**
 * The question ids a later tier should still be asked, given what an earlier
 * tier answered: exactly the ones left uncertain.
 *
 * @param {Record<string, {type: string}>} questions
 * @param {Record<string, import('./contract.js').Answer>} answers
 * @param {UncertaintyBand} [band]
 * @returns {string[]}
 */
export function uncertainQuestionIds(questions, answers, band = DEFAULT_UNCERTAINTY) {
  return Object.entries(questions)
    .filter(([id, question]) => isUncertain(question, answers[id], band))
    .map(([id]) => id)
}

/**
 * Wait for a promise, but never longer than `timeoutMs`. Resolves to the
 * fallback value instead of rejecting when the wait runs out, because a slow
 * judge must cost a verdict and not a stalled agent loop.
 *
 * @template T
 * @param {Promise<T>} promise
 * @param {number} timeoutMs
 * @param {{fallback?: T, signal?: AbortSignal}} [options]
 * @returns {Promise<T>}
 */
export function within(promise, timeoutMs, options = {}) {
  const fallback = options.fallback
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    return Promise.resolve(fallback)
  }
  if (options.signal?.aborted) return Promise.resolve(fallback)

  return new Promise((resolve) => {
    let settled = false
    const finish = (value) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      options.signal?.removeEventListener('abort', onAbort)
      resolve(value)
    }
    const onAbort = () => finish(fallback)
    const timer = setTimeout(() => finish(fallback), timeoutMs)
    options.signal?.addEventListener('abort', onAbort, { once: true })
    promise.then(finish, () => finish(fallback))
  })
}
