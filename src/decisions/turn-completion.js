/**
 * `turn.completion` — "done" is a claim, and claims need evidence.
 *
 * The model says it fixed something. Whether anything actually checked is a
 * question about two small things: what the closing message claims, and what was
 * run before it. Asking those as one compound question is what makes judges
 * unreliable — mu's own wording study showed a compound question scoring 0.79
 * where its two halves scored 0.29 and 0.38 — so it is asked in two parts and
 * combined in the policy.
 *
 * The verdict is a nudge, never a block: one reminder that nothing verified the
 * change, and only when the message claims completion and nothing looks like
 * verification.
 *
 * @module dsh-jev-judge/decisions/turn-completion
 */

import { defineDecision } from '../kernel/decision.js'

/** At or above this, the message counts as claiming completion. */
export const CLAIM_THRESHOLD = 0.8

/** At or below this, the run commands count as showing no verification. */
export const UNVERIFIED_THRESHOLD = 0.2

/**
 * Commands that verify something, for the fallback path. Deliberately narrow:
 * the fallback is only allowed to stay silent, never to nag on its own.
 */
const VERIFICATION_HINTS = [
  /\b(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?(?:test|tests|typecheck|lint|build|check)\b/,
  /\b(?:vitest|jest|pytest|mocha|ava|node --test|go test|cargo test|mvn|gradle)\b/,
  /\b(?:tsc|eslint|ruff|mypy|golangci-lint|shellcheck)\b/,
  /\b(?:make|just)\b/,
]

/**
 * Whether the commands run in this turn include something that could verify the
 * work.
 *
 * @param {string[]} commands
 * @returns {boolean}
 */
export function showsVerification(commands) {
  return commands.some((command) => VERIFICATION_HINTS.some((hint) => hint.test(String(command))))
}

/**
 * The decision point.
 *
 * Input: `{finalMessage, goal?, runCommands?: string[]}`
 * Outcome: `'nudge'` (ask the model to verify before finishing) or `'ok'`.
 */
export const turnCompletion = defineDecision({
  id: 'turn.completion',
  version: 1,
  questions: {
    claims_done: {
      type: 'boolean',
      instructions:
        'Does `final_message` claim that the work is finished, fixed, complete or working?',
      criteria: {
        true: 'says the fix is in, the task is done, the tests pass, or the feature works',
        false: 'reports progress, asks a question, lists what is left, or describes a blocker',
      },
    },
    verified: {
      type: 'boolean',
      instructions:
        'Do `run_commands` show that something checked the result — a test, typecheck, build, lint, or the program being run — after the change?',
      criteria: {
        true: 'a test suite, typecheck, build, lint or a run of the program appears in the commands',
        false: 'only edits, file reads, searches, installs or unrelated commands appear',
      },
    },
  },
  capabilities: 'classify',
  cacheImpact: 'none',
  latency: 'inline',

  buildState: (input) => ({
    ...(input.goal ? { goal: String(input.goal) } : {}),
    final_message: String(input.finalMessage ?? ''),
    run_commands: Array.isArray(input.runCommands) ? input.runCommands.map(String) : [],
  }),

  policy: (answers) => {
    const claims = answers.claims_done.probability
    const verified = answers.verified?.probability
    if (claims < CLAIM_THRESHOLD) return 'ok'
    // No answer about verification is not evidence of verification.
    if (verified === undefined || verified > UNVERIFIED_THRESHOLD) return 'ok'
    return 'nudge'
  },

  // Never nag without a judge: the behaviour without this point is a silent end.
  fallback: () => 'ok',
})

/**
 * The reminder the model is sent when the verdict is `nudge`. It states what is
 * missing and lets the model decide what would verify it.
 *
 * @returns {string}
 */
export function completionNudge() {
  return (
    'Before finishing: nothing in this turn appears to have checked that the change works. ' +
    'Run the narrowest verification you can (the test, typecheck, build or command that exercises the change) ' +
    'and report what it showed — or say plainly which part is unverified.'
  )
}

export default turnCompletion
