/**
 * The manifest is the contract three consumers read without running any of this
 * code: npm, the DeepSeek Harness plugin manager, and the community plugin
 * registry. These tests keep the manifest and the files it points at in step.
 */

import assert from 'node:assert/strict'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

const root = new URL('../', import.meta.url)
const manifest = JSON.parse(readFileSync(new URL('package.json', root), 'utf8'))

/** Resolve a package-relative path to an absolute path. */
const at = (relative) => fileURLToPath(new URL(relative, root))

test('the package is a DeepSeek Harness bundle', () => {
  assert.equal(manifest.name, 'dsh-jev-judge')
  assert.match(manifest.version, /^\d+\.\d+\.\d+$/)

  const patch = manifest.dsh?.bundle?.patch
  assert.equal(typeof patch, 'string', 'dsh.bundle.patch must be declared')
  assert.ok(existsSync(at(patch)), `${patch} must exist`)
})

test('the bundle patch mounts this package own host entry', () => {
  const patch = readFileSync(at(manifest.dsh.bundle.patch), 'utf8')
  const rows = [...patch.matchAll(/^\s*-?\s*name:\s*'([^']+)'\s*$/gm)].map((match) => match[1])
  assert.deepEqual(rows, ['dsh-jev-judge/host'])

  const [packageName, subpath] = rows[0].split('/')
  assert.equal(packageName, manifest.name)
  const exported = manifest.exports[`./${subpath}`]
  assert.equal(typeof exported, 'string', `exports["./${subpath}"] must resolve the row`)
  assert.ok(existsSync(at(exported)), `${exported} must exist`)
})

test('every advertised entry point exists', () => {
  for (const [key, target] of Object.entries(manifest.exports)) {
    assert.equal(typeof target, 'string', `exports["${key}"] must be a string path`)
    assert.ok(existsSync(at(target)), `exports["${key}"] -> ${target} must exist`)
  }
  for (const target of Object.values(manifest.bin)) {
    assert.ok(existsSync(at(target)), `bin -> ${target} must exist`)
    assert.ok(statSync(at(target)).mode & 0o111, `bin -> ${target} must be executable`)
    assert.match(readFileSync(at(target), 'utf8').split('\n')[0], /^#!/)
  }
})

test('the published file list exists and carries the skill with it', () => {
  for (const entry of manifest.files) {
    assert.ok(existsSync(at(entry)), `files entry ${entry} must exist`)
  }
  assert.ok(manifest.files.includes('skills'), 'the bundled Skill ships with the package')
})

test('the host requirement is declared for the plugin market', () => {
  assert.equal(typeof manifest.engines?.node, 'string')
  // A peer range without an explicit prerelease branch silently excludes every
  // prerelease harness build, and the market badge reads `engines.dsh`.
  assert.match(manifest.engines?.dsh ?? '', /^>=0\.2\.1-alpha\.1\b/)
})
