/**
 * An in-process judge for tests and for host authors checking their own decision
 * points. It answers with kernel-shaped values, so a test never depends on a
 * provider payload, and it records every request so a test can assert what the
 * kernel actually asked.
 *
 * @module dsh-jev-judge/kernel/judges/mock
 */

import { validateAnswer } from '../judge.js'

/**
 * A judge whose answers a test supplies.
 */
export class MockJudge {
  /**
   * @param {(request: {state: import('../contract.js').JudgeInput, questions: Record<string, import('../contract.js').Question>}, call: number) => unknown} handler
   *   Returns a map of question id to a kernel-shaped answer, a whole
   *   `{answers, usage}` response, or `undefined`/`null` to answer nothing. May
   *   throw to exercise the fallback path.
   * @param {{id?: string, capabilities?: readonly string[]}} [options]
   */
  constructor(handler, options = {}) {
    this.handler = handler
    this.id = options.id ?? 'mock'
    this.capabilities = options.capabilities
    /** @type {{state: unknown, questions: Record<string, unknown>}[]} */
    this.requests = []
  }

  /**
   * @param {{state: import('../contract.js').JudgeInput, questions: Record<string, import('../contract.js').Question>, signal?: AbortSignal}} request
   * @returns {Promise<import('../contract.js').ProviderResponse>}
   */
  async evaluate(request) {
    const call = this.requests.length
    this.requests.push({ state: request.state, questions: request.questions })
    const raw = await this.handler({ state: request.state, questions: request.questions }, call)
    if (raw === undefined || raw === null) return { answers: {} }

    const answerMap = 'answers' in raw ? raw.answers : raw
    const warnings = 'answers' in raw && Array.isArray(raw.warnings) ? [...raw.warnings] : []
    /** @type {Record<string, import('../contract.js').Answer>} */
    const answers = {}
    for (const [id, value] of Object.entries(answerMap ?? {})) {
      const question = request.questions[id]
      if (question === undefined) {
        warnings.push({
          type: 'unexpected-answer',
          message: `mock answered "${id}", which was not asked`,
          questionId: id,
        })
        continue
      }
      const answer = validateAnswer(question, value)
      if (answer === undefined) {
        warnings.push({
          type: 'unusable-answer',
          message: `mock answer to "${id}" does not fit a ${question.type} question`,
          questionId: id,
        })
        continue
      }
      answers[id] = answer
    }

    const response = { answers, warnings }
    if ('usage' in raw && raw.usage) response.usage = raw.usage
    return response
  }
}

/**
 * Build a judge that always answers the same way, for a test that only cares
 * about one verdict.
 *
 * @param {Record<string, import('../contract.js').Answer>} answers
 * @param {{id?: string}} [options]
 * @returns {MockJudge}
 */
export function alwaysJudge(answers, options = {}) {
  return new MockJudge(() => answers, options)
}

/**
 * Build a judge that never answers, standing in for a provider that is down.
 *
 * @param {{id?: string}} [options]
 * @returns {MockJudge}
 */
export function silentJudge(options = {}) {
  return new MockJudge(() => undefined, { id: options.id ?? 'silent' })
}
