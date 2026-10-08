/**
 * The host entry is loaded by the harness Loader by its package subpath, so what
 * matters here is that it mounts with no harness present and that a malformed
 * row is reported instead of thrown — a harness boot is all-or-nothing.
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'
import { apply, name } from '../src/runtimes/dsh/index.js'

/** A stand-in for the Cordis context: the entry only reaches for its logger. */
function fakeContext() {
  const warnings = []
  return { warnings, logger: { warn: (message) => warnings.push(message) } }
}

test('the plugin announces its loader name', () => {
  assert.equal(name, 'jev-judge')
})

test('mounting with no config is a no-op', () => {
  const ctx = fakeContext()
  apply(ctx, undefined)
  apply(ctx, null)
  apply(ctx, {})
  assert.deepEqual(ctx.warnings, [])
})

test('a malformed config is reported and skipped, not thrown', () => {
  for (const bad of ['nope', 42, [], true]) {
    const ctx = fakeContext()
    assert.doesNotThrow(() => apply(ctx, bad))
    assert.equal(ctx.warnings.length, 1)
    assert.match(ctx.warnings[0], /^jev-judge: plugin config must be an object/)
  }
})
