/**
 * System One over HTTP: the typed decision protocol this kernel prefers.
 *
 * The request is one state and one map of bounded questions; the response is one
 * answer per question, each a probability or a closed choice. There is no prose
 * to parse and no streaming: a decision call is short by construction.
 *
 * Anything that fails is classified and thrown as a `JudgeError`. Nothing in the
 * message, the ledger or a log ever contains the key or the submitted state.
 *
 * @module dsh-jev-judge/kernel/judges/typesafe
 */

import { JudgeError, toJudgeError } from '../errors.js'
import { decodeAnswers, normalizeUsage } from '../judge.js'
import {
  DEFAULT_TIMEOUT_MS,
  buildAuthorizationHeader,
  buildHeaders,
  classifyTransportFailure,
  postJson,
  withBudget,
} from './http.js'

/** The path a System One service serves by default. */
export const SYSTEM_ONE_PATH = 'v1/systemone'

export { DEFAULT_TIMEOUT_MS, buildAuthorizationHeader }

/**
 * Join a configured base URL with the System One path, tolerating a base URL
 * that is already the full endpoint (the Agent Skill documents both).
 *
 * @param {string} baseUrl
 * @param {string} [endpointPath]
 * @returns {string}
 */
export function resolveEndpoint(baseUrl, endpointPath = SYSTEM_ONE_PATH) {
  const base = String(baseUrl).trim().replace(/\/+$/, '')
  const path = String(endpointPath ?? '').trim().replace(/^\/+|\/+$/g, '')
  if (path === '') return base
  if (base.toLowerCase().endsWith(`/${path.toLowerCase()}`)) return base
  return `${base}/${path}`
}

/**
 * Translate one kernel question into its System One wire form. The wire calls a
 * yes/no question `noul`; `choice` and `score` keep their names and criteria.
 *
 * @param {import('../contract.js').Question} question
 * @returns {Record<string, unknown>}
 */
export function toWireQuestion(question) {
  if (question.type !== 'boolean') return { ...question }
  const wire = { type: 'noul', instructions: question.instructions }
  return question.criteria ? { ...wire, criteria: question.criteria } : wire
}

/**
 * Build the request body.
 *
 * @param {{model: string, state: import('../contract.js').JudgeInput, questions: Record<string, import('../contract.js').Question>}} request
 * @returns {Record<string, unknown>}
 */
export function buildSystemOnePayload({ model, state, questions }) {
  /** @type {Record<string, Record<string, unknown>>} */
  const wire = {}
  for (const [id, question] of Object.entries(questions)) wire[id] = toWireQuestion(question)
  return { model, state, questions: wire }
}

/**
 * A System One judge: TypeSafe's own service, a relay, or any gateway that
 * implements the same protocol.
 */
export class SystemOneJudge {
  /**
   * @param {object} options
   * @param {string} options.apiKey
   * @param {string} options.model
   * @param {string} options.baseUrl
   * @param {string} [options.endpointPath]
   * @param {string} [options.authHeader]
   * @param {string} [options.authScheme]
   * @param {Record<string, string>} [options.extraHeaders]
   * @param {number} [options.timeoutMs]
   * @param {readonly string[]} [options.capabilities] What this judge can answer.
   * @param {typeof fetch} [options.fetch]
   */
  constructor(options) {
    this.endpoint = resolveEndpoint(options.baseUrl, options.endpointPath ?? SYSTEM_ONE_PATH)
    this.model = options.model
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
    this.fetch = options.fetch ?? globalThis.fetch
    this.capabilities = options.capabilities
    this.id = `systemone:${options.model}`
    this.headers = buildHeaders({
      apiKey: options.apiKey,
      authHeader: options.authHeader,
      authScheme: options.authScheme ?? 'Bearer',
      extraHeaders: options.extraHeaders,
    })
  }

  /**
   * Answer a set of questions about one state.
   *
   * @param {{state: import('../contract.js').JudgeInput, questions: Record<string, import('../contract.js').Question>, signal?: AbortSignal}} request
   * @returns {Promise<import('../contract.js').ProviderResponse>}
   */
  async evaluate(request) {
    if (typeof this.fetch !== 'function') {
      throw new JudgeError('config', 'this Node.js runtime provides no global fetch')
    }
    const budget = withBudget(request.signal, this.timeoutMs)
    try {
      const parsed = await postJson({
        fetch: this.fetch,
        url: this.endpoint,
        headers: this.headers,
        body: buildSystemOnePayload({
          model: this.model,
          state: request.state,
          questions: request.questions,
        }),
        signal: budget.signal,
      })

      const warnings = []
      const answers = decodeAnswers(request.questions, parsed.answers, { warnings })
      const usage = normalizeUsage(parsed.usage)
      const modelId = typeof parsed.model === 'string' ? parsed.model : this.model
      return usage === undefined
        ? { answers, modelId, warnings }
        : { answers, modelId, warnings, usage }
    } catch (error) {
      if (error instanceof JudgeError) throw error
      const classified = classifyTransportFailure(error, {
        timedOut: budget.timedOut(),
        cancelled: request.signal?.aborted === true,
        timeoutMs: this.timeoutMs,
      })
      throw classified ?? toJudgeError(error, { service: 'judge provider' })
    } finally {
      budget.cleanup()
    }
  }
}
