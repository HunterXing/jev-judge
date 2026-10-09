/**
 * The tool schemas have to survive the hosts' own validators, and a schema that
 * does not is a plugin that silently fails to load — which is exactly what
 * happened the first time this package was installed into a real DeepSeek
 * Harness: `type: ['number', 'null']` was rejected, because the harness's
 * enforced subset takes one scalar `type` and nothing else.
 *
 * The harness accepts: a single scalar `type` (`object`, `array`, `string`,
 * `number`, `integer`, `boolean`, `null`), `oneOf` with at least two schemas and
 * no sibling constraint keyword, `properties`/`required`/boolean
 * `additionalProperties` on objects, `items` on arrays, type-correct
 * `enum`/`const`, and the annotations `description`/`title`/`default`/`examples`.
 * Everything else rejects. This file checks that subset locally, so the failure
 * is a red test rather than a broken install.
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'

import { TOOL_OUTPUT_SCHEMA, TOOL_PARAMETERS } from '../src/runtimes/dsh/tool.js'
import { TOOLS } from '../src/runtimes/mcp/server.js'

/** The keywords the harness's subset admits. */
const CONSTRAINT_KEYWORDS = new Set([
  'type',
  'oneOf',
  'properties',
  'required',
  'additionalProperties',
  'items',
  'enum',
  'const',
])
const ANNOTATION_KEYWORDS = new Set(['description', 'title', 'default', 'examples'])
const SCALAR_TYPES = new Set(['object', 'array', 'string', 'number', 'integer', 'boolean', 'null'])
const ONE_OF_SIBLINGS = [
  'properties',
  'required',
  'additionalProperties',
  'items',
  'enum',
  'const',
]

/**
 * Walk a schema and collect every way it falls outside the subset.
 *
 * @param {unknown} node
 * @param {string} path
 * @param {string[]} violations
 * @returns {void}
 */
function checkSubset(node, path, violations) {
  if (typeof node !== 'object' || node === null || Array.isArray(node)) {
    violations.push(`${path} must be a schema object`)
    return
  }

  for (const key of Object.keys(node)) {
    if (CONSTRAINT_KEYWORDS.has(key) || ANNOTATION_KEYWORDS.has(key)) continue
    violations.push(`${path}.${key} is not in the supported subset`)
  }

  const hasType = Object.hasOwn(node, 'type')
  const hasOneOf = Object.hasOwn(node, 'oneOf')

  if (hasType && hasOneOf) {
    violations.push(`${path} cannot declare both type and oneOf`)
    return
  }

  if (hasOneOf) {
    for (const key of ONE_OF_SIBLINGS) {
      if (Object.hasOwn(node, key)) violations.push(`${path}.${key} is not supported beside oneOf`)
    }
    const oneOf = node.oneOf
    if (!Array.isArray(oneOf) || oneOf.length < 2) {
      violations.push(`${path}.oneOf must be an array of at least two schemas`)
      return
    }
    oneOf.forEach((entry, index) => checkSubset(entry, `${path}.oneOf[${index}]`, violations))
    return
  }

  if (!hasType) {
    // An annotation-only schema is the unconstrained-JSON form, and it may not
    // carry a constraint keyword.
    for (const key of ONE_OF_SIBLINGS) {
      if (Object.hasOwn(node, key)) violations.push(`${path}.${key} requires type or oneOf`)
    }
    return
  }

  if (typeof node.type !== 'string' || !SCALAR_TYPES.has(node.type)) {
    violations.push(
      Array.isArray(node.type)
        ? `${path}.type must be a single type string (type arrays are not supported)`
        : `${path}.type must be one of ${[...SCALAR_TYPES].join('/')}`,
    )
    return
  }

  if (node.type === 'object') {
    if (Object.hasOwn(node, 'additionalProperties') && typeof node.additionalProperties !== 'boolean') {
      violations.push(`${path}.additionalProperties must be a boolean`)
    }
    if (Object.hasOwn(node, 'required')) {
      if (!Array.isArray(node.required) || node.required.some((entry) => typeof entry !== 'string')) {
        violations.push(`${path}.required must be an array of strings`)
      } else {
        // A required name has to be declared, whether or not `properties` is
        // present: the harness reads a missing map as an empty one.
        const declared = node.properties ?? {}
        for (const key of node.required) {
          if (!Object.hasOwn(declared, key)) {
            violations.push(`${path}.required names "${key}", which is not in properties`)
          }
        }
      }
    }
    for (const [key, value] of Object.entries(node.properties ?? {})) {
      checkSubset(value, `${path}.properties.${key}`, violations)
    }
    return
  }

  if (node.type === 'array' && Object.hasOwn(node, 'items')) {
    checkSubset(node.items, `${path}.items`, violations)
  }
}

/**
 * @param {unknown} schema
 * @returns {string[]}
 */
function violationsOf(schema) {
  const violations = []
  checkSubset(schema, 'schema', violations)
  return violations
}

test('the judge_items argument schema is inside the harness subset', () => {
  assert.deepEqual(violationsOf(TOOL_PARAMETERS), [])
})

test('the judge_items output schema is inside the harness subset', () => {
  assert.deepEqual(violationsOf(TOOL_OUTPUT_SCHEMA), [])
})

test('the checker rejects the shapes the harness rejects', () => {
  // Each of these is a real way to write a schema the harness refuses to load.
  assert.match(violationsOf({ type: ['number', 'null'] }).join(' '), /single type string/)
  assert.match(violationsOf({ type: 'object', anyOf: [{ type: 'string' }] }).join(' '), /not in the supported subset/)
  assert.match(violationsOf({ type: 'object', required: ['a'] }).join(' '), /not in properties/)
  assert.match(
    violationsOf({ oneOf: [{ type: 'number' }, { type: 'null' }], type: 'number' }).join(' '),
    /cannot declare both type and oneOf/,
  )
  assert.match(
    violationsOf({ oneOf: [{ type: 'number' }, { type: 'null' }], items: {} }).join(' '),
    /not supported beside oneOf/,
  )
  // And the exact form this package uses for a nullable field is accepted.
  assert.deepEqual(violationsOf({ oneOf: [{ type: 'number' }, { type: 'null' }] }), [])
})

test('the MCP tool schemas name the tools and stay object-rooted', () => {
  assert.deepEqual(
    TOOLS.map((tool) => tool.name),
    ['judge_items', 'judge_ask', 'judge_ledger'],
  )
  for (const tool of TOOLS) {
    assert.equal(tool.inputSchema.type, 'object', `${tool.name} must be object-rooted`)
    assert.equal(typeof tool.inputSchema.additionalProperties, 'boolean')
  }
})
