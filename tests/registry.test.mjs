/**
 * What a host adapter's own row has to reach.
 *
 * A deployment mounts the kernel as one row and states its settings there: which
 * decision points may act, and where the ledger goes. Both halves are pinned
 * here, because a row whose settings are silently dropped still judges — it just
 * stops leaving the evidence that a point's `active` was earned from, which is
 * the one failure that looks like success.
 */

import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import { judgeItems } from '../src/decisions/index.js'
import { createJudgeRuntime } from '../src/kernel/registry.js'

/** A temp directory that cleans itself up. */
function withTempDir() {
  const dir = mkdtempSync(join(tmpdir(), 'jev-judge-registry-'))
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) }
}

/**
 * A runtime with no provider record and no kernel file: no judge resolves, so a
 * decision never touches the network and every verdict is a fallback.
 *
 * @param {string} dir
 * @param {object} [overrides]
 * @returns {ReturnType<typeof createJudgeRuntime>}
 */
function bareRuntime(dir, overrides) {
  return createJudgeRuntime({
    env: {
      JEV_SKILL_CONFIG: join(dir, 'absent-provider.json'),
      JEV_JUDGE_CONFIG: join(dir, 'absent-kernel.json'),
    },
    ...(overrides ? { overrides } : {}),
  })
}

/** An input the items point accepts. */
const itemsInput = {
  task: 'review the diff',
  question: 'Does this line mention the failing request?',
  items: [{ id: 'a', text: 'the request timed out' }],
}

// ── the ledger a host asks for ───────────────────────────────────────────────

test('a host override states where the ledger goes', async () => {
  const { dir, cleanup } = withTempDir()
  try {
    const path = join(dir, 'ledger.ndjson')
    const runtime = bareRuntime(dir, { ledger: { path }, modes: { default: 'active' } })

    assert.equal(runtime.ledger?.path, path, 'the row’s ledger path is the one opened')

    const decision = await runtime.engine.decide(judgeItems, itemsInput)
    assert.ok(decision.ledgerId, 'the decision reports the record it left')

    const lines = readFileSync(path, 'utf8').trim().split('\n')
    assert.equal(lines.length, 1)
    const record = JSON.parse(lines[0])
    assert.equal(record.point, 'judge.items')
    assert.equal(record.mode, 'active')
    // A fallback is recorded too: a ledger that keeps only the acted verdicts
    // cannot show how often a point was silent for want of an answer.
    assert.equal(record.source, 'fallback')
  } finally {
    cleanup()
  }
})

// ── the modes a host asks for ────────────────────────────────────────────────

test('a host override states which points may act', async () => {
  const { dir, cleanup } = withTempDir()
  try {
    const shadow = bareRuntime(dir, { modes: { default: 'shadow' } })
    assert.equal((await shadow.engine.decide(judgeItems, itemsInput)).mode, 'shadow')

    const acting = bareRuntime(dir, { modes: { default: 'shadow', 'judge.items': 'active' } })
    assert.equal((await acting.engine.decide(judgeItems, itemsInput)).mode, 'active')

    const off = bareRuntime(dir, { modes: { default: 'active', 'judge.items': 'off' } })
    const decision = await off.engine.decide(judgeItems, itemsInput)
    assert.equal(decision.mode, 'off')
    assert.equal(decision.ledgerId, undefined, 'an off point is absent, not recorded')
  } finally {
    cleanup()
  }
})

// ── the deployment that asked for nothing ────────────────────────────────────

test('a runtime with no ledger configured opens none', async () => {
  const { dir, cleanup } = withTempDir()
  try {
    const runtime = bareRuntime(dir)

    assert.equal(runtime.ledger, null)
    assert.equal(runtime.judgeNames.length, 0, 'no provider means no judge')
    const decision = await runtime.engine.decide(judgeItems, itemsInput)
    assert.equal(decision.mode, 'shadow', 'an unconfigured point stays shadow')
    assert.equal(decision.ledgerId, undefined)
    assert.equal(existsSync(join(dir, 'ledger.ndjson')), false)
  } finally {
    cleanup()
  }
})
