/**
 * The layering rule the portability of this package rests on: the kernel and the
 * decision points must not know which agent is running them.
 *
 * A host import that creeps into `src/kernel` would make the MCP and hook
 * adapters depend on a harness, and the package would stop loading outside it —
 * so the rule is checked by reading the source, not by convention.
 */

import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

const src = fileURLToPath(new URL('../src/', import.meta.url))

/**
 * Every `.js` file under a directory, recursively.
 *
 * @param {string} directory
 * @returns {string[]} Absolute paths.
 */
function sourceFiles(directory) {
  const found = []
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = `${directory}${entry.name}`
    if (entry.isDirectory()) found.push(...sourceFiles(`${path}/`))
    else if (entry.name.endsWith('.js')) found.push(path)
  }
  return found
}

test('the kernel never imports a host runtime', () => {
  const forbidden = [/(?:from|import)\s*\(?\s*['"]@deepseek-ai\//, /['"]@modelcontextprotocol\//]
  for (const file of sourceFiles(`${src}kernel/`)) {
    const source = readFileSync(file, 'utf8')
    for (const pattern of forbidden) {
      assert.ok(!pattern.test(source), `${file} must not import a host runtime`)
    }
  }
})

test('the kernel only reaches into itself', () => {
  // Anchored to the start of a line so prose in a doc comment cannot be mistaken
  // for an import statement.
  const importFrom = /^\s*(?:import|export)[^\n]*from\s+['"]([^'"]+)['"]/gm
  for (const file of sourceFiles(`${src}kernel/`)) {
    const source = readFileSync(file, 'utf8')
    for (const match of source.matchAll(importFrom)) {
      const specifier = match[1]
      assert.ok(
        specifier.startsWith('node:') || specifier.startsWith('./') || specifier.startsWith('../'),
        `${file} imports ${specifier}; the kernel has no runtime dependency`,
      )
    }
  }
})

test('the decision points stay host-free too', () => {
  for (const file of sourceFiles(`${src}decisions/`)) {
    const source = readFileSync(file, 'utf8')
    assert.ok(!/['"]@deepseek-ai\//.test(source), `${file} must not import a host runtime`)
    assert.ok(!/runtimes\//.test(source), `${file} must not reach into an adapter`)
  }
})
