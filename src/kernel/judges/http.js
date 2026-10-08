/**
 * The HTTP plumbing every judge that talks to a provider shares: building safe
 * headers, bounding a request, and turning a response into either a parsed body
 * or a classified failure.
 *
 * @module dsh-jev-judge/kernel/judges/http
 */

import { isPlainObject } from '../contract.js'
import { JudgeError, errorKindForStatus } from '../errors.js'

/** How much of a failure body is read before classification. */
const CLASSIFY_BODY_LIMIT = 4096

/** The request budget used when a provider does not configure one. */
export const DEFAULT_TIMEOUT_MS = 30_000

/**
 * Build the authentication header value from the configured scheme and key. An
 * empty scheme sends the raw key, which is how `x-api-key` providers work.
 *
 * @param {{apiKey: string, authScheme?: string}} config
 * @returns {string}
 */
export function buildAuthorizationHeader({ apiKey, authScheme }) {
  return authScheme ? `${authScheme} ${apiKey}` : apiKey
}

/**
 * Build the request headers, letting a managed authentication header win over
 * anything a deployment put in `extraHeaders`.
 *
 * @param {{apiKey: string, authHeader?: string, authScheme?: string, extraHeaders?: Record<string, string>}} options
 * @returns {Record<string, string>}
 */
export function buildHeaders(options) {
  const authHeader = options.authHeader ?? 'Authorization'
  const headers = { 'content-type': 'application/json' }
  for (const [name, value] of Object.entries(options.extraHeaders ?? {})) {
    const lower = name.toLowerCase()
    if (lower === 'content-type') continue
    if (lower === authHeader.toLowerCase()) continue
    headers[name] = value
  }
  headers[authHeader] = buildAuthorizationHeader({
    apiKey: options.apiKey,
    authScheme: options.authScheme,
  })
  return headers
}

/**
 * A request budget that honours both a configured timeout and the caller's
 * cancellation.
 *
 * @param {AbortSignal | undefined} signal
 * @param {number} timeoutMs
 * @returns {{signal: AbortSignal, timedOut: () => boolean, cleanup: () => void}}
 */
export function withBudget(signal, timeoutMs) {
  const controller = new AbortController()
  let timedOut = false

  const onAbort = () => controller.abort(signal?.reason)
  if (signal !== undefined) {
    if (signal.aborted) controller.abort(signal.reason)
    else signal.addEventListener('abort', onAbort, { once: true })
  }
  const timer =
    Number.isFinite(timeoutMs) && timeoutMs > 0
      ? setTimeout(() => {
          timedOut = true
          controller.abort()
        }, timeoutMs)
      : undefined

  return {
    signal: controller.signal,
    timedOut: () => timedOut,
    cleanup: () => {
      clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
    },
  }
}

/**
 * Send one JSON request and hand back the parsed body.
 *
 * A non-2xx status becomes a classified `JudgeError` whose message names the
 * status and nothing else: a gateway may reflect credentials or user content in
 * its error body, so the body is read for classification and then dropped.
 *
 * @param {object} options
 * @param {typeof fetch} options.fetch
 * @param {string} options.url
 * @param {Record<string, string>} options.headers
 * @param {unknown} options.body
 * @param {AbortSignal} options.signal
 * @returns {Promise<Record<string, unknown>>}
 */
export async function postJson(options) {
  const response = await options.fetch(options.url, {
    method: 'POST',
    headers: options.headers,
    body: JSON.stringify(options.body),
    signal: options.signal,
  })

  if (!response.ok) {
    const body = await response.text().catch(() => '')
    throw new JudgeError(
      errorKindForStatus(response.status, body.slice(0, CLASSIFY_BODY_LIMIT)),
      `judge provider answered HTTP ${response.status}`,
    )
  }

  let parsed
  try {
    parsed = JSON.parse(await response.text())
  } catch {
    throw new JudgeError('malformed', 'judge provider returned a non-JSON response')
  }
  if (!isPlainObject(parsed)) {
    throw new JudgeError('malformed', 'judge provider returned an unexpected JSON shape')
  }
  return parsed
}

/**
 * Turn a thrown transport error into a classified failure, distinguishing a
 * spent budget and a cancelled call from a genuine provider failure.
 *
 * @param {unknown} error
 * @param {{timedOut: boolean, cancelled: boolean, timeoutMs: number}} state
 * @returns {JudgeError | undefined} A classified failure, or `undefined` when
 *   the transport failed for some other reason and the caller must classify it.
 */
export function classifyTransportFailure(error, state) {
  if (state.timedOut) {
    return new JudgeError('timeout', `judge provider did not answer within ${state.timeoutMs}ms`, {
      cause: error,
    })
  }
  if (state.cancelled) {
    return new JudgeError('timeout', 'the judgment was cancelled before it answered', {
      cause: error,
    })
  }
  return null
}
