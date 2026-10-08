/**
 * Turning configuration into judges and an engine.
 *
 * This is the one place that knows how a judge name in the configuration becomes
 * something that can answer: the built-in `jev` judge comes from the private
 * provider record, and a `judges` block may name more, each inheriting whatever
 * it does not override.
 *
 * A half-configured deployment is not an error. When no judge can be built, the
 * engine is still handed back — every decision point then returns its fallback
 * and the caller gets the reasons in `problems`, which is exactly what `doctor`
 * prints and what an adapter logs once at startup.
 *
 * @module dsh-jev-judge/kernel/registry
 */

import { homedir } from 'node:os'
import { isAbsolute, join } from 'node:path'

import { ChatJsonJudge } from './judges/chat-json.js'
import { SystemOneJudge } from './judges/typesafe.js'
import { ConfigError, DEFAULT_KERNEL_CONFIG_PATH, loadKernelConfig, loadProviderConfig, validateKernelConfig } from './config.js'
import { createEngine } from './decision.js'
import { MemoryLedger, createLedger } from './ledger.js'
import { createRedactor } from './redact.js'

/** The judge name the provider record always provides. */
export const DEFAULT_JUDGE_NAME = 'jev'

/**
 * Expand a leading `~` to the user's home directory.
 *
 * @param {string} path
 * @returns {string}
 */
export function expandHome(path) {
  if (path === '~') return homedir()
  if (path.startsWith('~/') || path.startsWith('~\\')) return join(homedir(), path.slice(2))
  return isAbsolute(path) ? path : join(process.cwd(), path)
}

/**
 * Build one judge from its configuration, inheriting from the provider record.
 *
 * @param {string} name
 * @param {Record<string, unknown>} spec
 * @param {object | null} provider The validated provider record, when available.
 * @param {typeof fetch} [fetchImpl]
 * @returns {{judge: object} | {problem: string}}
 */
export function buildJudge(name, spec, provider, fetchImpl) {
  const type = spec.type ?? 'typesafe'
  const model = String(spec.model ?? provider?.model ?? '').trim()
  const baseUrl = String(spec.baseUrl ?? provider?.baseUrl ?? '').trim()
  const authHeader = String(spec.authHeader ?? provider?.authHeader ?? 'Authorization')
  const authScheme =
    spec.authScheme !== undefined ? String(spec.authScheme) : (provider?.authScheme ?? 'Bearer')
  const endpointPath = spec.endpointPath ?? spec.path ?? provider?.endpointPath
  const timeoutMs = Number.isFinite(spec.timeoutMs)
    ? spec.timeoutMs
    : provider
      ? provider.timeoutSeconds * 1000
      : undefined

  // A key and a header belong to one service. They are inherited only when the
  // judge talks to the same service as the provider record; a judge pointing
  // somewhere else has to name its own credentials.
  const sameService = spec.baseUrl === undefined || String(spec.baseUrl) === provider?.baseUrl
  const inheritedKey = sameService ? (provider?.apiKey ?? '') : ''
  const inheritedHeaders = sameService ? provider?.extraHeaders : undefined

  const apiKeyEnv = typeof spec.apiKeyEnv === 'string' ? spec.apiKeyEnv : undefined
  const apiKey = apiKeyEnv
    ? String(process.env[apiKeyEnv] ?? '').trim()
    : String(spec.apiKey ?? inheritedKey).trim()

  if (!model) return { problem: `judge "${name}" has no model` }
  if (!baseUrl) return { problem: `judge "${name}" has no baseUrl` }
  if (!apiKey) {
    return {
      problem: apiKeyEnv
        ? `judge "${name}" needs environment variable ${apiKeyEnv}`
        : sameService
          ? `judge "${name}" has no key`
          : `judge "${name}" points at another service and needs its own key`,
    }
  }

  const options = {
    apiKey,
    model,
    baseUrl,
    endpointPath,
    authHeader,
    authScheme,
    extraHeaders: inheritedHeaders,
    ...(timeoutMs ? { timeoutMs } : {}),
    ...(Array.isArray(spec.capabilities) ? { capabilities: spec.capabilities } : {}),
    ...(spec.fetch ? { fetch: spec.fetch } : fetchImpl ? { fetch: fetchImpl } : {}),
  }

  const judge = type === 'chat' ? new ChatJsonJudge(options) : new SystemOneJudge(options)
  return { judge }
}

/**
 * Build the enabled judges and the tier order.
 *
 * @param {object} options
 * @param {ReturnType<import('./config.js').validateKernelConfig>} options.kernel
 * @param {object | null} options.provider
 * @param {typeof fetch} [options.fetch]
 * @returns {{judges: Record<string, object>, tiers: string[], problems: string[]}}
 */
export function createJudges({ kernel, provider, fetch }) {
  /** @type {Record<string, object>} */
  const judges = {}
  const problems = []
  const declared = Object.entries(kernel.judges ?? {})

  if (declared.length === 0) {
    if (provider === null) {
      problems.push(
        'no judge is available: the private provider record is missing or invalid',
      )
    } else if (provider.protocol === 'chat') {
      const built = buildJudge(DEFAULT_JUDGE_NAME, { type: 'chat' }, provider, fetch)
      if ('judge' in built) judges[DEFAULT_JUDGE_NAME] = built.judge
      else problems.push(built.problem)
    } else {
      const built = buildJudge(DEFAULT_JUDGE_NAME, { type: 'typesafe' }, provider, fetch)
      if ('judge' in built) judges[DEFAULT_JUDGE_NAME] = built.judge
      else problems.push(built.problem)
    }
  } else {
    for (const [name, spec] of declared) {
      const built = buildJudge(name, spec, provider, fetch)
      if ('judge' in built) judges[name] = built.judge
      else problems.push(built.problem)
    }
  }

  const tiers = kernel.tiers ?? Object.keys(judges)
  const missing = tiers.filter((name) => judges[name] === undefined)
  if (missing.length > 0) {
    problems.push(`tiers name unknown judges: ${missing.join(', ')}`)
  }

  return { judges, tiers: tiers.filter((name) => judges[name] !== undefined), problems }
}

/**
 * Build the engine an adapter runs on: configuration loaded, judges resolved,
 * ledger opened, problems collected rather than thrown.
 *
 * @param {object} [options]
 * @param {Record<string, string | undefined>} [options.env]
 * @param {string} [options.providerPath] Explicit provider record path.
 * @param {string} [options.kernelPath] Explicit kernel settings path.
 * @param {boolean} [options.memoryLedger] Keep the ledger in memory (tests, dry runs).
 * @param {typeof fetch} [options.fetch]
 * @param {Record<string, Record<string, unknown>>} [options.judgeOverrides] Extra judge definitions.
 * @returns {{
 *   engine: ReturnType<typeof createEngine>,
 *   kernel: ReturnType<import('./config.js').validateKernelConfig>,
 *   provider: object | null,
 *   paths: {provider: string, kernel: string},
 *   problems: string[],
 *   judgeNames: string[],
 * }}
 */
export function createJudgeRuntime(options = {}) {
  const env = options.env ?? process.env
  const problems = []
  const kernelPath = options.kernelPath ?? env.JEV_JUDGE_CONFIG ?? DEFAULT_KERNEL_CONFIG_PATH

  let kernel
  try {
    kernel = loadKernelConfig({ env, path: options.kernelPath })
  } catch (error) {
    // A broken settings file must not take the kernel down: every point simply
    // runs on the built-in defaults, and `doctor` shows why.
    problems.push(error instanceof Error ? error.message : 'invalid kernel configuration')
    kernel = validateKernelConfig({})
  }

  let provider = null
  let providerPath = options.providerPath ?? ''
  try {
    const loaded = loadProviderConfig({ env, path: options.providerPath })
    provider = loaded.config
    providerPath = loaded.path
  } catch (error) {
    problems.push(error instanceof Error ? error.message : 'invalid provider configuration')
    providerPath = providerPath || (env.JEV_SKILL_CONFIG ?? '').trim() ||
      join(homedir(), '.config', 'typesafe-ai-jev-skill.json')
  }

  const kernelWithOverrides = options.judgeOverrides
    ? {
        ...kernel,
        judges: { ...(kernel.judges ?? {}), ...options.judgeOverrides },
        tiers: kernel.tiers ?? Object.keys({ ...(kernel.judges ?? {}), ...options.judgeOverrides }),
      }
    : kernel

  const { judges, tiers, problems: judgeProblems } = createJudges({
    kernel: kernelWithOverrides,
    provider,
    fetch: options.fetch,
  })
  problems.push(...judgeProblems)

  const redactor = createRedactor({ env, secrets: provider ? [provider.apiKey] : [] })
  const ledgerOptions = {
    path: kernel.ledger.path ? expandHome(kernel.ledger.path) : null,
    recordState: kernel.ledger.recordState,
    maxBytes: kernel.ledger.maxBytes,
    redactor,
  }
  const ledger = options.memoryLedger
    ? new MemoryLedger()
    : createLedger(ledgerOptions)

  const engine = createEngine({
    judges,
    tiers,
    routes: kernel.routes,
    modes: kernel.modes,
    band: kernel.uncertainty,
    timeoutMs: kernel.timeoutMs,
    ledger,
  })

  return {
    engine,
    kernel: kernelWithOverrides,
    provider,
    paths: { provider: providerPath, kernel: kernelPath },
    problems,
    judgeNames: Object.keys(judges),
    ledger,
    redactor,
  }
}

export { ConfigError }
