/**
 * Configuration: the private provider record, and the kernel's own settings.
 *
 * The provider half is the contract published by the `typesafe-ai-jev-skill`
 * Agent Skill, ported unchanged so one file serves both: `JEV_SKILL_CONFIG`
 * first, then `<agent-home>/.config/typesafe-ai-jev-skill.json`. The validation
 * rules are the ones that skill's verifier enforces, including the ones that
 * only protect the user — https for anything remote, no credentials in the URL,
 * no placeholder key, and a config file no other local user can read.
 *
 * The kernel half is separate and optional: which decision points may act, which
 * judges answer, and where the ledger goes.
 *
 * @module dsh-jev-judge/kernel/config
 */

import { readFileSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

import { MODES, isPlainObject } from './contract.js'
import { normalizeBand } from './policy.js'
import { SYSTEM_ONE_PATH } from './judges/typesafe.js'
import { CHAT_PATH } from './judges/chat-json.js'

/** The environment variable a deployment points at its private provider record. */
export const PROVIDER_CONFIG_ENV = 'JEV_SKILL_CONFIG'

/** Where the Agent Skill puts the provider record. */
export const DEFAULT_PROVIDER_CONFIG_PATH = join(
  homedir(),
  '.config',
  'typesafe-ai-jev-skill.json',
)

/** Where this kernel keeps its own settings. */
export const DEFAULT_KERNEL_CONFIG_PATH = join(homedir(), '.config', 'jev-judge', 'kernel.json')

/** A configuration problem the user has to fix, as opposed to a judge failure. */
export class ConfigError extends Error {
  /**
   * @param {string} message
   * @param {{cause?: unknown}} [options]
   */
  constructor(message, options = {}) {
    super(message, { cause: options.cause })
    this.name = 'ConfigError'
  }
}

/**
 * @param {string} hostname
 * @returns {boolean}
 */
function isLoopback(hostname) {
  const normalized = hostname.toLowerCase()
  return normalized === 'localhost' || normalized === '127.0.0.1' || normalized === '::1'
}

/**
 * Whether a value is still a placeholder rather than a credential.
 *
 * @param {string} value
 * @returns {boolean}
 */
export function isPlaceholderSecret(value) {
  const normalized = value.trim().toLowerCase()
  if (!normalized) return true
  return (
    normalized.includes('<') ||
    normalized.includes('>') ||
    normalized.includes('your-') ||
    normalized.includes('changeme') ||
    normalized.includes('replace') ||
    normalized.includes('todo') ||
    normalized === 'sk-xxx' ||
    normalized === 'xxx'
  )
}

/**
 * Check and trim an endpoint path.
 *
 * @param {unknown} raw
 * @param {string} [fallback]
 * @returns {string}
 */
export function normalizeEndpointPath(raw, fallback = SYSTEM_ONE_PATH) {
  if (raw === undefined || raw === null || raw === '') return fallback
  const value = String(raw).trim()
  if (value.includes('://') || value.includes('?') || value.includes('#')) {
    throw new ConfigError('endpointPath must be a URL path without query or fragment')
  }
  return value.replace(/^\/+|\/+$/g, '')
}

/**
 * Check an HTTP header name.
 *
 * @param {unknown} raw
 * @param {string} [fallback]
 * @returns {string}
 */
export function normalizeHeaderName(raw, fallback = 'Authorization') {
  const value = String(raw ?? fallback).trim()
  if (!/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(value)) {
    throw new ConfigError('authHeader is not a valid HTTP header name')
  }
  return value
}

/**
 * Normalize the base URL and derive the request endpoint. A base URL that is
 * already the endpoint is accepted and not suffixed twice.
 *
 * @param {unknown} raw
 * @param {string} [systemOnePath]
 * @returns {{baseUrl: string, endpoint: string}}
 */
export function normalizeBaseUrl(raw, systemOnePath = SYSTEM_ONE_PATH) {
  const value = String(raw ?? '').trim()
  if (!value) throw new ConfigError('baseUrl is required in the config file')

  let parsed
  try {
    parsed = new URL(value)
  } catch (error) {
    throw new ConfigError('baseUrl must be a valid absolute URL', { cause: error })
  }

  if (parsed.protocol !== 'https:' && !isLoopback(parsed.hostname)) {
    throw new ConfigError('remote baseUrl must use https; loopback HTTP is allowed')
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    throw new ConfigError('baseUrl must use http or https')
  }
  if (!parsed.hostname) throw new ConfigError('baseUrl must include a hostname')
  if (parsed.username || parsed.password) {
    throw new ConfigError('baseUrl cannot include credentials')
  }
  if (parsed.search || parsed.hash) {
    throw new ConfigError('baseUrl cannot include a query string or fragment')
  }

  let path = parsed.pathname.replace(/\/+$/, '')
  const normalized = normalizeEndpointPath(systemOnePath)
  if (normalized && path.toLowerCase().endsWith(`/${normalized.toLowerCase()}`)) {
    path = path.slice(0, -`/${normalized}`.length)
  }

  const baseUrl = path && path !== '/' ? `${parsed.origin}${path}` : parsed.origin
  const endpoint = normalized ? `${baseUrl}/${normalized}` : baseUrl
  return { baseUrl, endpoint }
}

/**
 * Validate a provider record and resolve its key.
 *
 * @param {unknown} source The parsed JSON object.
 * @param {Record<string, string | undefined>} [env] Where `apiKeyEnv` is read.
 * @returns {{
 *   providerName: string, baseUrl: string, endpoint: string, model: string,
 *   apiKey: string, apiKeySource: string, protocol: 'systemone' | 'chat',
 *   endpointPath: string, authHeader: string, authScheme: string,
 *   extraHeaders: Record<string, string>, timeoutSeconds: number,
 * }}
 * @throws {ConfigError}
 */
export function validateProviderConfig(source, env = process.env) {
  if (!isPlainObject(source)) throw new ConfigError('config must be a JSON object')

  const providerName = String(source.providerName ?? 'custom-provider').trim()
  if (!providerName) throw new ConfigError('providerName cannot be empty')

  const model = String(source.model ?? '').trim()
  if (!model) throw new ConfigError('model is required in the config file')
  if (model.includes('://') || /\s/.test(model)) {
    throw new ConfigError('model must be a provider model identifier')
  }

  const protocol = String(source.protocol ?? 'systemone').trim().toLowerCase()
  if (protocol !== 'systemone' && protocol !== 'chat') {
    throw new ConfigError('protocol must be "systemone" or "chat"')
  }

  // A chat gateway serves a different path; an explicit endpointPath still wins.
  const defaultPath = protocol === 'chat' ? CHAT_PATH : SYSTEM_ONE_PATH
  const endpointPath = normalizeEndpointPath(source.endpointPath ?? source.systemOnePath, defaultPath)
  const { baseUrl, endpoint } = normalizeBaseUrl(source.baseUrl, endpointPath)

  const apiKeyEnv = String(source.apiKeyEnv ?? '').trim()
  let apiKey
  let apiKeySource
  if (apiKeyEnv) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(apiKeyEnv)) {
      throw new ConfigError('apiKeyEnv must be a valid environment-variable name')
    }
    apiKey = String(env[apiKeyEnv] ?? '').trim()
    apiKeySource = `environment variable ${apiKeyEnv}`
  } else {
    apiKey = String(source.apiKey ?? '').trim()
    apiKeySource = 'config file apiKey'
  }
  if (!apiKey || isPlaceholderSecret(apiKey)) {
    throw new ConfigError(
      apiKeyEnv
        ? `apiKeyEnv ${apiKeyEnv} is missing or still contains a placeholder`
        : 'apiKey is missing or still contains a placeholder',
    )
  }
  if (/\s/.test(apiKey)) throw new ConfigError('API key cannot contain whitespace')

  const authHeader = normalizeHeaderName(source.authHeader)
  const authScheme = String(source.authScheme ?? 'Bearer').trim()
  if (/[\r\n]/.test(authScheme)) throw new ConfigError('authScheme cannot contain line breaks')

  const extraHeaders = source.extraHeaders ?? {}
  if (!isPlainObject(extraHeaders)) throw new ConfigError('extraHeaders must be a JSON object')
  /** @type {Record<string, string>} */
  const safeExtraHeaders = {}
  for (const [name, value] of Object.entries(extraHeaders)) {
    normalizeHeaderName(name)
    if (typeof value !== 'string' || /[\r\n]/.test(value)) {
      throw new ConfigError(`extraHeaders.${name} must be a single-line string`)
    }
    const lower = name.toLowerCase()
    if (['authorization', 'content-length', 'host'].includes(lower) || lower === authHeader.toLowerCase()) {
      throw new ConfigError(`extraHeaders.${name} is managed by the client and cannot be overridden`)
    }
    safeExtraHeaders[name] = value
  }

  const timeoutSeconds = Number(source.timeoutSeconds ?? 30)
  if (!Number.isFinite(timeoutSeconds) || timeoutSeconds <= 0) {
    throw new ConfigError('timeoutSeconds must be a positive number')
  }

  return {
    providerName,
    baseUrl,
    endpoint,
    model,
    apiKey,
    apiKeySource,
    protocol,
    endpointPath,
    authHeader,
    authScheme,
    extraHeaders: safeExtraHeaders,
    timeoutSeconds,
  }
}

/**
 * Where the provider record is looked for: the environment variable first, then
 * the Agent Skill's documented path.
 *
 * @param {Record<string, string | undefined>} [env]
 * @returns {{path: string, fromEnv: boolean}}
 */
export function discoverProviderConfigPath(env = process.env) {
  const fromEnv = String(env[PROVIDER_CONFIG_ENV] ?? '').trim()
  if (fromEnv) return { path: fromEnv, fromEnv: true }
  return { path: DEFAULT_PROVIDER_CONFIG_PATH, fromEnv: false }
}

/**
 * Read and validate a config file.
 *
 * @param {string} path
 * @param {{env?: Record<string, string | undefined>, requirePrivate?: boolean}} [options]
 * @returns {unknown} The parsed object.
 * @throws {ConfigError}
 */
export function readConfigFile(path, options = {}) {
  let stats
  try {
    stats = statSync(path)
  } catch (error) {
    throw new ConfigError(`config file not found: ${path}`, { cause: error })
  }
  if (!stats.isFile()) throw new ConfigError(`config path is not a file: ${path}`)
  if (
    options.requirePrivate !== false &&
    process.platform !== 'win32' &&
    (stats.mode & 0o077) !== 0
  ) {
    throw new ConfigError(
      `config file permissions are too broad for ${path}; run: chmod 600 ${JSON.stringify(path)}`,
    )
  }

  let raw
  try {
    raw = readFileSync(path, 'utf8')
  } catch (error) {
    throw new ConfigError(`cannot read config file: ${path}`, { cause: error })
  }
  try {
    return JSON.parse(raw)
  } catch (error) {
    throw new ConfigError('config file must contain valid JSON', { cause: error })
  }
}

/**
 * Load the provider record from the discovery order.
 *
 * @param {{env?: Record<string, string | undefined>, path?: string}} [options]
 * @returns {{config: ReturnType<typeof validateProviderConfig>, path: string, fromEnv: boolean}}
 */
export function loadProviderConfig(options = {}) {
  const env = options.env ?? process.env
  const discovered = options.path
    ? { path: options.path, fromEnv: false }
    : discoverProviderConfigPath(env)
  const source = readConfigFile(discovered.path, { env })
  return { config: validateProviderConfig(source, env), ...discovered }
}

/**
 * Validate the kernel's own settings. Every field is optional: a kernel with no
 * configuration runs every point in `shadow` and keeps no ledger, which is the
 * behaviour of a deployment that has not decided anything yet.
 *
 * @param {unknown} source
 * @returns {{
 *   modes: Record<string, string>, tiers?: string[],
 *   routes: Record<string, string[]>, judges: Record<string, Record<string, unknown>>,
 *   ledger: {path?: string, recordState: boolean, maxBytes?: number},
 *   uncertainty: import('./policy.js').UncertaintyBand,
 *   timeoutMs?: number, options: Record<string, Record<string, unknown>>,
 * }}
 * @throws {ConfigError}
 */
export function validateKernelConfig(source) {
  if (source === undefined || source === null) source = {}
  if (!isPlainObject(source)) throw new ConfigError('kernel config must be a JSON object')

  const modes = source.modes ?? {}
  if (!isPlainObject(modes)) throw new ConfigError('`modes` must be an object')
  for (const [point, mode] of Object.entries(modes)) {
    if (!MODES.includes(mode)) {
      throw new ConfigError(`mode for "${point}" must be one of ${MODES.join(', ')}`)
    }
  }

  const tiers = source.tiers
  if (tiers !== undefined && (!Array.isArray(tiers) || tiers.some((n) => typeof n !== 'string'))) {
    throw new ConfigError('`tiers` must be an array of judge names')
  }

  const routes = source.routes ?? {}
  if (!isPlainObject(routes)) throw new ConfigError('`routes` must be an object')
  for (const [point, names] of Object.entries(routes)) {
    if (!Array.isArray(names) || names.some((name) => typeof name !== 'string')) {
      throw new ConfigError(`route for "${point}" must be an array of judge names`)
    }
  }

  const judges = source.judges ?? {}
  if (!isPlainObject(judges)) throw new ConfigError('`judges` must be an object')
  for (const [name, judge] of Object.entries(judges)) {
    if (!isPlainObject(judge)) throw new ConfigError(`judge "${name}" must be an object`)
    const type = judge.type ?? 'typesafe'
    if (type !== 'typesafe' && type !== 'chat') {
      throw new ConfigError(`judge "${name}" has unsupported type "${String(type)}"`)
    }
  }

  const ledger = source.ledger ?? {}
  if (!isPlainObject(ledger)) throw new ConfigError('`ledger` must be an object')
  if (ledger.path !== undefined && typeof ledger.path !== 'string') {
    throw new ConfigError('`ledger.path` must be a string path')
  }
  if (ledger.recordState !== undefined && typeof ledger.recordState !== 'boolean') {
    throw new ConfigError('`ledger.recordState` must be a boolean')
  }
  if (ledger.maxBytes !== undefined && !(Number.isFinite(ledger.maxBytes) && ledger.maxBytes > 0)) {
    throw new ConfigError('`ledger.maxBytes` must be a positive number')
  }

  let uncertainty
  try {
    uncertainty = normalizeBand(source.uncertainty)
  } catch (error) {
    throw new ConfigError(error instanceof Error ? error.message : 'invalid uncertainty band')
  }

  if (source.timeoutMs !== undefined && !(Number.isFinite(source.timeoutMs) && source.timeoutMs > 0)) {
    throw new ConfigError('`timeoutMs` must be a positive number')
  }

  const options = source.options ?? {}
  if (!isPlainObject(options)) throw new ConfigError('`options` must be an object')

  return {
    modes,
    ...(tiers ? { tiers } : {}),
    routes,
    judges,
    ledger: {
      ...(ledger.path ? { path: ledger.path } : {}),
      recordState: ledger.recordState ?? false,
      ...(ledger.maxBytes ? { maxBytes: ledger.maxBytes } : {}),
    },
    uncertainty,
    ...(source.timeoutMs ? { timeoutMs: source.timeoutMs } : {}),
    options,
  }
}

/**
 * Load the kernel settings. A missing file is not an error: it means "no
 * configuration yet".
 *
 * @param {{env?: Record<string, string | undefined>, path?: string}} [options]
 * @returns {ReturnType<typeof validateKernelConfig>}
 */
export function loadKernelConfig(options = {}) {
  const env = options.env ?? process.env
  const path = options.path ?? process.env.JEV_JUDGE_CONFIG ?? DEFAULT_KERNEL_CONFIG_PATH
  try {
    const source = readConfigFile(path, { env, requirePrivate: false })
    return validateKernelConfig(source)
  } catch (error) {
    if (error instanceof ConfigError && /not found/.test(error.message)) {
      return validateKernelConfig({})
    }
    throw error
  }
}
