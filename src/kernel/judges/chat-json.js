/**
 * A chat-completions judge: the documented lower-fidelity fallback.
 *
 * A gateway that only speaks chat completions cannot answer typed questions, so
 * this judge prompts a model to produce the same JSON shape and decodes it with
 * the same rules. It costs tokens, it can answer in prose, and it proves nothing
 * about System One compatibility — so every answer it returns carries a
 * `fidelity` warning, and the ledger keeps it distinguishable from a typed
 * verdict.
 *
 * @module dsh-jev-judge/kernel/judges/chat-json
 */

import { JudgeError, toJudgeError } from '../errors.js'
import { decodeAnswers } from '../judge.js'
import {
  DEFAULT_TIMEOUT_MS,
  buildHeaders,
  classifyTransportFailure,
  postJson,
  withBudget,
} from './http.js'

/** The path a chat-completions gateway serves by default. */
export const CHAT_PATH = 'v1/chat/completions'

/** Attached to every answer this judge produces. */
export const FIDELITY_WARNING = Object.freeze({
  type: 'fidelity',
  message: 'answered by a prompted chat model, not by a typed decision endpoint',
})

/** A cap on generated tokens: an answer is a small JSON object, not an essay. */
export const DEFAULT_MAX_TOKENS = 512

/**
 * Build the instruction the chat model answers. The question vocabulary is sent
 * as data, so a wrong shape is a parse failure rather than a silent misread.
 *
 * @param {import('../contract.js').JudgeInput} state
 * @param {Record<string, import('../contract.js').Question>} questions
 * @returns {string}
 */
export function buildChatPrompt(state, questions) {
  const wire = {}
  for (const [id, question] of Object.entries(questions)) {
    const type = question.type === 'boolean' ? 'noul' : question.type
    wire[id] = { type, instructions: question.instructions, criteria: question.criteria }
  }
  return [
    'You are a judge answering bounded questions about one state.',
    'Answer every question exactly once. Reply with one JSON object and nothing else.',
    'Shapes: a noul answer is {"noul": <probability between 0 and 1>},',
    'a choice answer is {"choice": "<one of the option names>"},',
    'a score answer is {"score": <number between the first and last level>}.',
    '',
    'STATE:',
    JSON.stringify(state),
    '',
    'QUESTIONS:',
    JSON.stringify(wire),
    '',
    'Reply as {"answers": {"<question id>": <answer>}}.',
  ].join('\n')
}

/**
 * Pull the first complete JSON object out of a model reply, tolerating a fenced
 * code block or a sentence around it.
 *
 * @param {string} text
 * @returns {unknown}
 */
export function extractJsonObject(text) {
  const trimmed = String(text).trim()
  const candidates = [trimmed]
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i)
  if (fenced) candidates.push(fenced[1].trim())

  for (const candidate of candidates) {
    try {
      return JSON.parse(candidate)
    } catch {
      // Fall through to the brace scan below.
    }
  }

  const start = trimmed.indexOf('{')
  if (start === -1) return undefined
  let depth = 0
  let inString = false
  let escaped = false
  for (let index = start; index < trimmed.length; index += 1) {
    const char = trimmed[index]
    if (escaped) {
      escaped = false
      continue
    }
    if (char === '\\') {
      escaped = true
      continue
    }
    if (char === '"') {
      inString = !inString
      continue
    }
    if (inString) continue
    if (char === '{') depth += 1
    if (char === '}') {
      depth -= 1
      if (depth === 0) {
        try {
          return JSON.parse(trimmed.slice(start, index + 1))
        } catch {
          return undefined
        }
      }
    }
  }
  return undefined
}

/**
 * A judge that reaches a chat-completions gateway.
 */
export class ChatJsonJudge {
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
   * @param {number} [options.maxTokens]
   * @param {readonly string[]} [options.capabilities]
   * @param {typeof fetch} [options.fetch]
   */
  constructor(options) {
    this.url = `${String(options.baseUrl).trim().replace(/\/+$/, '')}/${String(
      options.endpointPath ?? CHAT_PATH,
    ).replace(/^\/+/, '')}`
    this.model = options.model
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
    this.maxTokens = options.maxTokens ?? DEFAULT_MAX_TOKENS
    this.fetch = options.fetch ?? globalThis.fetch
    this.capabilities = options.capabilities
    this.id = `chat:${options.model}`
    this.headers = buildHeaders({
      apiKey: options.apiKey,
      authHeader: options.authHeader,
      authScheme: options.authScheme ?? 'Bearer',
      extraHeaders: options.extraHeaders,
    })
  }

  /**
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
        url: this.url,
        headers: this.headers,
        body: {
          model: this.model,
          messages: [{ role: 'user', content: buildChatPrompt(request.state, request.questions) }],
          max_tokens: this.maxTokens,
          stream: false,
        },
        signal: budget.signal,
      })

      const choice = Array.isArray(parsed.choices) ? parsed.choices[0] : undefined
      const content = choice?.message?.content
      if (typeof content !== 'string') {
        throw new JudgeError('malformed', 'chat judge returned no message content')
      }
      const decoded = extractJsonObject(content)
      if (decoded === undefined) {
        throw new JudgeError('malformed', 'chat judge did not return a JSON answer object')
      }

      const warnings = [FIDELITY_WARNING]
      const answers = decodeAnswers(
        request.questions,
        /** @type {Record<string, unknown>} */ (decoded).answers,
        { warnings },
      )
      const modelId = typeof parsed.model === 'string' ? parsed.model : this.model
      return { answers, modelId, warnings }
    } catch (error) {
      if (error instanceof JudgeError) throw error
      const classified = classifyTransportFailure(error, {
        timedOut: budget.timedOut(),
        cancelled: request.signal?.aborted === true,
        timeoutMs: this.timeoutMs,
      })
      throw classified ?? toJudgeError(error, { service: 'chat judge' })
    } finally {
      budget.cleanup()
    }
  }
}
