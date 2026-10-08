/**
 * Secret scrubbing.
 *
 * Two things can carry a credential out of this kernel: an error message built
 * from a provider body or a URL, and a ledger record. Both go through here
 * first. Scrubbing is deliberately blunt — a value that looks like a key is
 * removed even when it is not one, because the cost of the false positive is a
 * less readable message and the cost of the false negative is a leaked key.
 *
 * @module dsh-jev-judge/kernel/redact
 */

/** Environment variables whose values are treated as secrets. */
const SECRET_NAME = /(?:api[_-]?key|apikey|token|secret|password|passwd|credential|bearer|access[_-]?key)/i

/** Below this length a value is too short to be a credential and too likely to be a word. */
const MIN_SECRET_LENGTH = 12

/** The marker left where a secret was removed. */
export const REDACTED = '[redacted]'

/**
 * Text patterns that carry a credential regardless of environment. Applied to
 * every message and every ledger string, so a key that reached the process some
 * other way is still removed.
 */
const PATTERNS = [
  // Authorization: Bearer eyJ... / Token abc... / key sk-...
  [/\b(Bearer|Token|Basic)\s+[A-Za-z0-9._~+/=-]{8,}/gi, `$1 ${REDACTED}`],
  // api_key=..., "x-api-key": "...", password: ... — the surrounding quotes are kept
  // so the message still reads as JSON when it came from a JSON body.
  [
    /\b([A-Za-z0-9_-]*(?:api[_-]?key|apikey|token|secret|password|passwd|credential)[A-Za-z0-9_-]*)\b(\s*[:=]\s*)(["']?)([^\s"'&,;})\]]{6,})\3/gi,
    `$1$2$3${REDACTED}$3`,
  ],
  // ?key=...&access_token=... in a URL
  [/([?&](?:key|api[_-]?key|apikey|token|access[_-]?token|secret)=)[^\s&"'#]*/gi, `$1${REDACTED}`],
]

/**
 * Collect the values of secret-looking environment variables.
 *
 * @param {Record<string, string | undefined>} [env] Defaults to `process.env`.
 * @param {{minLength?: number}} [options]
 * @returns {Set<string>} The values to scrub, never the names.
 */
export function environmentSecrets(env = process.env, options = {}) {
  const minLength = options.minLength ?? MIN_SECRET_LENGTH
  const secrets = new Set()
  for (const [name, value] of Object.entries(env)) {
    if (typeof value !== 'string' || value.length < minLength) continue
    if (SECRET_NAME.test(name)) secrets.add(value)
  }
  return secrets
}

/**
 * Remove known secret values and credential-shaped text from a string.
 *
 * @param {string} text
 * @param {Iterable<string>} [secrets] Exact values to remove.
 * @returns {string}
 */
export function redactText(text, secrets = []) {
  let result = String(text)
  for (const secret of secrets) {
    if (secret.length < MIN_SECRET_LENGTH) continue
    result = result.split(secret).join(REDACTED)
  }
  for (const [pattern, replacement] of PATTERNS) {
    result = result.replace(pattern, replacement)
  }
  return result
}

/**
 * Deep-copy a JSON-shaped value with every string scrubbed. Cycles are cut, and
 * nesting is bounded, so a hostile or accidental structure cannot hang the
 * caller.
 *
 * @param {unknown} value
 * @param {Iterable<string>} [secrets]
 * @param {{depth?: number}} [options]
 * @returns {unknown}
 */
export function redactValue(value, secrets = [], options = {}) {
  const maxDepth = options.depth ?? 12
  const seen = new WeakSet()

  /** @param {unknown} node @param {number} depth */
  const walk = (node, depth) => {
    if (typeof node === 'string') return redactText(node, secrets)
    if (node === null || typeof node !== 'object') return node
    if (depth >= maxDepth) return '[truncated]'
    if (seen.has(node)) return '[circular]'
    seen.add(node)

    if (Array.isArray(node)) return node.map((item) => walk(item, depth + 1))
    if (node instanceof Date) return node.toISOString()
    if (node instanceof Map) return walk(Object.fromEntries(node), depth + 1)

    /** @type {Record<string, unknown>} */
    const result = {}
    for (const [key, item] of Object.entries(node)) {
      result[key] = walk(item, depth + 1)
    }
    return result
  }

  return walk(value, 0)
}

/**
 * Build a scrubber once, for a caller that scrubs many values.
 *
 * @param {{secrets?: Iterable<string>, env?: Record<string, string | undefined>}} [options]
 * @returns {{text: (text: string) => string, value: (value: unknown) => unknown, secrets: Set<string>}}
 */
export function createRedactor(options = {}) {
  const secrets = new Set(options.secrets ?? [])
  for (const value of environmentSecrets(options.env ?? process.env)) secrets.add(value)
  return {
    secrets,
    text: (text) => redactText(text, secrets),
    value: (value) => redactValue(value, secrets),
  }
}
