/**
 * Failure classification.
 *
 * A judge that cannot answer is an ordinary condition, not an incident: the
 * kernel turns every classified failure into the decision point's fallback and
 * records the kind. The classification exists so a caller can tell "your key is
 * wrong" from "the provider is overloaded" without ever reading a provider body.
 *
 * @module dsh-jev-judge/kernel/errors
 */

/** Every failure the kernel distinguishes. */
export const JUDGE_ERROR_KINDS = Object.freeze([
  'config',
  'auth',
  'payment_required',
  'rate_limited',
  'server',
  'bad_request',
  'timeout',
  'network',
  'malformed',
])

/** Kinds worth one more attempt within the same request budget. */
const RETRYABLE_KINDS = new Set(['rate_limited', 'server', 'network', 'timeout'])

/**
 * A classified judge failure.
 */
export class JudgeError extends Error {
  /**
   * @param {string} kind One of {@link JUDGE_ERROR_KINDS}.
   * @param {string} message Human-readable, and safe: never carries a key or the
   *   submitted state.
   * @param {{cause?: unknown, retryable?: boolean}} [options]
   */
  constructor(kind, message, options = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause })
    this.name = 'JudgeError'
    this.kind = kind
    this.retryable = options.retryable ?? RETRYABLE_KINDS.has(kind)
  }
}

/**
 * @param {unknown} value
 * @returns {value is JudgeError}
 */
export function isJudgeError(value) {
  return value instanceof JudgeError
}

/**
 * Map an HTTP status onto a failure kind. The message is only consulted for the
 * one status where providers disagree about what it means.
 *
 * @param {number} status
 * @param {string} [message]
 * @returns {string} One of {@link JUDGE_ERROR_KINDS}.
 */
export function errorKindForStatus(status, message = '') {
  if (status === 401) return 'auth'
  if (status === 402) return 'payment_required'
  if (status === 403) {
    return /credit|payment|billing|quota|balance/i.test(message) ? 'payment_required' : 'auth'
  }
  if (status === 408 || status === 504) return 'timeout'
  if (status === 429) return 'rate_limited'
  if (status >= 500) return 'server'
  return 'bad_request'
}

/**
 * Wrap an arbitrary thrown value as a `JudgeError`, classifying the shapes Node
 * and `fetch` actually throw.
 *
 * @param {unknown} error
 * @param {{service?: string}} [context]
 * @returns {JudgeError}
 */
export function toJudgeError(error, context = {}) {
  if (isJudgeError(error)) return error

  const service = context.service ?? 'judge provider'
  if (error instanceof Error) {
    if (error.name === 'AbortError' || error.name === 'TimeoutError') {
      return new JudgeError('timeout', `${service} did not answer in time`, { cause: error })
    }
    if (error.name === 'TypeError') {
      return new JudgeError('network', `${service} is unreachable`, { cause: error })
    }
    return new JudgeError('network', `${service} failed: ${error.message}`, { cause: error })
  }
  return new JudgeError('network', `${service} failed with a non-Error value`, { cause: error })
}
