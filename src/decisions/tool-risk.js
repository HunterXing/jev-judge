/**
 * `tool.risk` — the judge only vouches that the user asked for it.
 *
 * Deciding whether a command is dangerous is a rule's job: the patterns are
 * known, they do not change with context, and a rule never hallucinates a
 * backdoor into `rm -rf`. What a rule cannot do is know whether *this* user
 * asked for *this* command in *this* conversation — and that is the only
 * question asked here.
 *
 * The verdict can therefore only do one thing: turn a pending approval into a
 * silent allow. An unsure judge, an unreachable judge, or no judge at all all
 * leave the approval exactly where it was.
 *
 * @module dsh-jev-judge/decisions/tool-risk
 */

import { defineDecision } from '../kernel/decision.js'

/**
 * At or above this probability the judge is understood to have vouched for the
 * call. Deliberately high: this verdict removes a human check.
 */
export const VOUCH_THRESHOLD = 0.9

/**
 * What makes a call worth asking about. These are the rule half of the point:
 * they decide whether the judge is consulted at all.
 */
const RISKY_PATTERNS = [
  [/\brm\s+(?:-[a-zA-Z]*\s+)*(?:\/|~|\$HOME|\*)/, 'deletes files outside a project path'],
  [/\bgit\s+push\b[^\n]*(?:--force|-f)\b/, 'force-pushes over published history'],
  [/\bgit\s+(?:reset\s+--hard|clean\s+-[a-zA-Z]*f)/, 'discards uncommitted work'],
  [/\b(?:chmod|chown)\s+(?:-R\s+)?(?:777|\/)/, 'changes permissions broadly'],
  [/\b(?:curl|wget)\b[^\n]*\|\s*(?:sudo\s+)?(?:ba|z|k)?sh\b/, 'pipes a download into a shell'],
  [/\b(?:mkfs|dd\s+if=|diskutil\s+erase)/, 'writes to a device'],
  [/\b(?:npm|pnpm|yarn)\s+(?:publish|unpublish)\b/, 'publishes a package'],
  [/\b(?:kubectl|helm)\s+(?:delete|uninstall)\b/, 'deletes deployed resources'],
  [/\bterraform\s+(?:destroy|apply)\b/, 'changes infrastructure'],
  [/\bdrop\s+(?:table|database)\b/i, 'drops data'],
  [/\b(?:sudo|doas)\b/, 'runs with elevated privileges'],
  [/\b(?:gh|git)\s+(?:release\s+create|tag\s+-d)\b/, 'publishes or removes a release'],
]

/**
 * Whether a command matches one of the rules, and why.
 *
 * @param {string} command
 * @returns {{risky: true, reason: string} | {risky: false}}
 */
export function looksRisky(command) {
  const text = String(command ?? '')
  for (const [pattern, reason] of RISKY_PATTERNS) {
    if (pattern.test(text)) return { risky: true, reason }
  }
  return { risky: false }
}

/**
 * The decision point.
 *
 * Input: `{tool, command, request, irreversible?: boolean}`
 * Outcome: `'allow'` (the judge vouched) or `'ask'` (a human still decides).
 */
export const toolRisk = defineDecision({
  id: 'tool.risk',
  version: 1,
  questions: {
    requested: {
      type: 'boolean',
      instructions:
        'Does `user_request` ask for `command` to be run — or ask for an outcome that `command` is a direct, necessary step of?',
      criteria: {
        true: 'the user named the action, the file, the release or the environment it acts on, or asked for an outcome only this step produces',
        false: 'the user asked for something else, asked a question, or the command matches the request only by sharing a keyword',
      },
    },
  },
  capabilities: 'relate',
  cacheImpact: 'none',
  latency: 'inline',

  buildState: (input) => ({
    tool: input.tool ?? 'command',
    command: String(input.command ?? ''),
    user_request: String(input.request ?? ''),
  }),

  policy: (answers) => (answers.requested.probability >= VOUCH_THRESHOLD ? 'allow' : 'ask'),

  // The rules already flagged this call, so the behaviour without a judge is the
  // approval the host would have asked for.
  fallback: () => 'ask',
})

export default toolRisk
