/**
 * Configuration: the provider record is the Agent Skill's contract, so these
 * tests are the ones that keep this kernel from accepting a file that skill
 * would reject (and the reverse), plus the kernel's own settings.
 */

import assert from 'node:assert/strict'
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import {
  ConfigError,
  DEFAULT_PROVIDER_CONFIG_PATH,
  discoverProviderConfigPath,
  isPlaceholderSecret,
  loadKernelConfig,
  loadProviderConfig,
  normalizeBaseUrl,
  readConfigFile,
  validateKernelConfig,
  validateProviderConfig,
} from '../src/kernel/config.js'

/** A provider record that passes, so each test changes one field. */
const valid = {
  providerName: 'custom-provider',
  baseUrl: 'https://api.example.com/provider',
  model: 'jev',
  protocol: 'systemone',
  apiKey: 'sk-a-real-looking-key-0001',
}

/** Make a private temp file and clean it up with the test. */
function withTempConfig(source, mode = 0o600) {
  const dir = mkdtempSync(join(tmpdir(), 'jev-judge-'))
  const path = join(dir, 'config.json')
  writeFileSync(path, typeof source === 'string' ? source : JSON.stringify(source), { mode })
  chmodSync(path, mode)
  return { path, cleanup: () => rmSync(dir, { recursive: true, force: true }) }
}

// ── the provider record ──────────────────────────────────────────────────────

test('a complete record resolves its endpoint and keeps its key hidden behind a source', () => {
  const config = validateProviderConfig(valid, {})
  assert.equal(config.baseUrl, 'https://api.example.com/provider')
  assert.equal(config.endpoint, 'https://api.example.com/provider/v1/systemone')
  assert.equal(config.protocol, 'systemone')
  assert.equal(config.apiKeySource, 'config file apiKey')
  assert.equal(config.timeoutSeconds, 30)
  assert.equal(config.authHeader, 'Authorization')
  assert.equal(config.authScheme, 'Bearer')
})

test('a base URL that is already the endpoint is not suffixed twice', () => {
  const config = validateProviderConfig({ ...valid, baseUrl: 'https://api.example.com/v1/systemone' }, {})
  assert.equal(config.baseUrl, 'https://api.example.com')
  assert.equal(config.endpoint, 'https://api.example.com/v1/systemone')
})

test('a chat record defaults to its own path', () => {
  const config = validateProviderConfig({ ...valid, protocol: 'chat' }, {})
  assert.equal(config.endpoint, 'https://api.example.com/provider/v1/chat/completions')
})

test('a record the Agent Skill would reject is rejected here too', () => {
  const cases = [
    [{ ...valid, baseUrl: undefined }, /baseUrl is required/],
    [{ ...valid, baseUrl: 'not a url' }, /valid absolute URL/],
    [{ ...valid, baseUrl: 'http://api.example.com' }, /must use https/],
    [{ ...valid, baseUrl: 'https://user:pw@api.example.com' }, /cannot include credentials/],
    [{ ...valid, baseUrl: 'https://api.example.com?key=1' }, /query string or fragment/],
    [{ ...valid, model: '' }, /model is required/],
    [{ ...valid, model: 'https://api.example.com' }, /model identifier/],
    [{ ...valid, protocol: 'grpc' }, /protocol must be/],
    [{ ...valid, apiKey: 'your-key-here' }, /placeholder/],
    [{ ...valid, apiKey: undefined }, /placeholder/],
    [{ ...valid, apiKey: 'has space inside' }, /whitespace/],
    [{ ...valid, apiKeyEnv: '1BAD' }, /valid environment-variable name/],
    [{ ...valid, authHeader: 'Author ization' }, /valid HTTP header name/],
    [{ ...valid, authScheme: 'Bearer\nx' }, /line breaks/],
    [{ ...valid, extraHeaders: [] }, /must be a JSON object/],
    [{ ...valid, extraHeaders: { authorization: 'x' } }, /cannot be overridden/],
    [{ ...valid, extraHeaders: { 'X-A': 'a\nb' } }, /single-line string/],
    [{ ...valid, timeoutSeconds: 0 }, /positive number/],
    [{ ...valid, endpointPath: 'v1/systemone?x=1' }, /without query or fragment/],
  ]
  for (const [source, expected] of cases) {
    assert.throws(
      () => validateProviderConfig(source, {}),
      (error) => error instanceof ConfigError && expected.test(error.message),
      `expected a ConfigError matching ${expected} for ${JSON.stringify(source)}`,
    )
  }
})

test('a key from the environment is preferred and named, never printed', () => {
  const config = validateProviderConfig({ ...valid, apiKey: undefined, apiKeyEnv: 'JEV_TEST_KEY' }, {
    JEV_TEST_KEY: 'sk-from-environment-9999',
  })
  assert.equal(config.apiKey, 'sk-from-environment-9999')
  assert.equal(config.apiKeySource, 'environment variable JEV_TEST_KEY')
  assert.throws(
    () => validateProviderConfig({ ...valid, apiKey: undefined, apiKeyEnv: 'JEV_MISSING' }, {}),
    /JEV_MISSING/,
  )
})

test('loopback HTTP is allowed while remote HTTP is not', () => {
  assert.equal(validateProviderConfig({ ...valid, baseUrl: 'http://127.0.0.1:8700' }, {}).baseUrl, 'http://127.0.0.1:8700')
  assert.equal(validateProviderConfig({ ...valid, baseUrl: 'http://localhost:8700' }, {}).baseUrl, 'http://localhost:8700')
  assert.throws(() => validateProviderConfig({ ...valid, baseUrl: 'http://api.example.com' }, {}), /https/)
})

test('placeholders are recognised in the shapes people actually write', () => {
  for (const value of ['', '<your-key>', 'your-key', 'CHANGEME', 'replace-me', 'TODO', 'sk-xxx', 'xxx']) {
    assert.ok(isPlaceholderSecret(value), `${value} must count as a placeholder`)
  }
  assert.ok(!isPlaceholderSecret('sk-live-abcdef123456'))
})

test('the endpoint is derived without losing a base path', () => {
  assert.deepEqual(normalizeBaseUrl('https://api.example.com/a/b/', 'v1/systemone'), {
    baseUrl: 'https://api.example.com/a/b',
    endpoint: 'https://api.example.com/a/b/v1/systemone',
  })
  // An empty endpointPath is the documented default, not "no path at all".
  assert.deepEqual(normalizeBaseUrl('https://api.example.com', ''), {
    baseUrl: 'https://api.example.com',
    endpoint: 'https://api.example.com/v1/systemone',
  })
  assert.deepEqual(normalizeBaseUrl('https://api.example.com/a/b', 'evaluate'), {
    baseUrl: 'https://api.example.com/a/b',
    endpoint: 'https://api.example.com/a/b/evaluate',
  })
})

// ── discovery and the file ───────────────────────────────────────────────────

test('the environment variable wins over the documented path', () => {
  assert.deepEqual(discoverProviderConfigPath({}), {
    path: DEFAULT_PROVIDER_CONFIG_PATH,
    fromEnv: false,
  })
  assert.deepEqual(discoverProviderConfigPath({ JEV_SKILL_CONFIG: '/tmp/x.json' }), {
    path: '/tmp/x.json',
    fromEnv: true,
  })
})

test('a config file readable by others is refused', () => {
  const loose = withTempConfig(valid, 0o644)
  try {
    assert.throws(() => readConfigFile(loose.path), /too broad/)
  } finally {
    loose.cleanup()
  }
  const closed = withTempConfig(valid, 0o600)
  try {
    assert.deepEqual(readConfigFile(closed.path), valid)
  } finally {
    closed.cleanup()
  }
})

test('a missing, unreadable or malformed file is a ConfigError', () => {
  assert.throws(() => readConfigFile('/nonexistent/jev-judge.json'), /not found/)
  const broken = withTempConfig('{not json')
  try {
    assert.throws(() => readConfigFile(broken.path), /valid JSON/)
  } finally {
    broken.cleanup()
  }
  const array = withTempConfig([])
  try {
    assert.throws(() => validateProviderConfig(readConfigFile(array.path)), /JSON object/)
  } finally {
    array.cleanup()
  }
})

test('loading a record reports where it came from', () => {
  const file = withTempConfig(valid)
  try {
    const loaded = loadProviderConfig({ path: file.path, env: {} })
    assert.equal(loaded.path, file.path)
    assert.equal(loaded.fromEnv, false)
    assert.equal(loaded.config.model, 'jev')
  } finally {
    file.cleanup()
  }
})

// ── the kernel settings ──────────────────────────────────────────────────────

test('an empty configuration means every point is shadow and no ledger', () => {
  const kernel = validateKernelConfig({})
  assert.deepEqual(kernel.modes, {})
  assert.equal(kernel.ledger.recordState, false)
  assert.equal(kernel.ledger.path, undefined)
  assert.equal(kernel.uncertainty.high, 0.8)
  assert.deepEqual(kernel.judges, {})
})

test('kernel settings are validated where they would otherwise fail silently', () => {
  assert.throws(() => validateKernelConfig({ modes: { default: 'whenever' } }), /must be one of off, shadow, active/)
  assert.throws(() => validateKernelConfig({ modes: [] }), /must be an object/)
  assert.throws(() => validateKernelConfig({ tiers: 'jev' }), /array of judge names/)
  assert.throws(() => validateKernelConfig({ routes: { 'tool.admission': 'jev' } }), /array of judge names/)
  assert.throws(() => validateKernelConfig({ judges: { x: { type: 'magic' } } }), /unsupported type/)
  assert.throws(() => validateKernelConfig({ ledger: { path: 1 } }), /ledger.path/)
  assert.throws(() => validateKernelConfig({ ledger: { maxBytes: -1 } }), /positive number/)
  assert.throws(() => validateKernelConfig({ uncertainty: { low: 0.95 } }), /below `high`/)
  assert.throws(() => validateKernelConfig({ timeoutMs: 0 }), /positive number/)
})

test('a full kernel configuration round-trips', () => {
  const kernel = validateKernelConfig({
    modes: { default: 'shadow', 'tool.admission': 'active' },
    tiers: ['jev', 'fast'],
    routes: { 'tool.risk': ['fast'] },
    judges: { fast: { type: 'chat', model: 'small', baseUrl: 'https://x.test' } },
    ledger: { path: '~/.config/jev-judge/ledger.ndjson', recordState: true, maxBytes: 1024 },
    uncertainty: { low: 0.15, high: 0.85 },
    timeoutMs: 2500,
    options: { admission: { maxChunks: 8 } },
  })
  assert.equal(kernel.modes['tool.admission'], 'active')
  assert.deepEqual(kernel.tiers, ['jev', 'fast'])
  assert.deepEqual(kernel.routes['tool.risk'], ['fast'])
  assert.equal(kernel.judges.fast.type, 'chat')
  assert.equal(kernel.ledger.recordState, true)
  assert.equal(kernel.uncertainty.low, 0.15)
  assert.equal(kernel.timeoutMs, 2500)
  assert.deepEqual(kernel.options.admission, { maxChunks: 8 })
})

test('a missing kernel settings file is not an error', () => {
  const kernel = loadKernelConfig({ path: '/nonexistent/jev-judge-kernel.json', env: {} })
  assert.deepEqual(kernel.modes, {})
})

test('a broken kernel settings file is reported and defaults are used', () => {
  const file = withTempConfig({ modes: { default: 'nope' } })
  try {
    assert.throws(() => loadKernelConfig({ path: file.path, env: {} }), /must be one of/)
  } finally {
    file.cleanup()
  }
})
