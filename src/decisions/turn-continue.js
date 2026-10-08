/**
 * `turn.continue` — a run that stopped short, or asked for permission it had.
 *
 * Two failures look the same from the outside and are common enough to be worth
 * a judge: the turn ends announcing the next step instead of taking it ("Let me
 * run the tests next."), and the turn ends asking the user to approve work the
 * user already asked for.
 *
 * The nudge is bounded by the caller, and one class of step is never pushed at
 * all: anything hard to undo or reaching beyond this machine — pushing,
 * publishing, deleting, paying. When the pending step is one of those, the point
 * declines rather than pushing, because a wrong nudge there cannot be taken back.
 *
 * @module dsh-jev-judge/decisions/turn-continue
 */

import { ABSTAIN, defineDecision } from '../kernel/decision.js'

/** At or above this, the closing message counts as promising an action. */
export const PROMISE_THRESHOLD = 0.8

/** At or above this, the closing message counts as asking for a go-ahead. */
export const ASK_THRESHOLD = 0.8

/** At or above this, the user's message counts as already asking for the work. */
export const REQUEST_THRESHOLD = 0.8

/**
 * Steps that are never pushed at the model: if a nudge is wrong here, something
 * has left the machine or been destroyed. The rule half of this point.
 */
const IRREVERSIBLE_PATTERNS = [
  /\bgit\s+push\b|\bpush (?:the |this |my )?(?:branch|commit|commits|changes|code|tag|release)\b/i,
  /\b(?:npm|pnpm|yarn)\s+publish\b|\bpublish (?:the |this )?(?:package|release|version|site)\b/i,
  /\bgh\s+(?:release|pr|repo)\s+(?:create|merge|delete)\b/,
  /\b(?:kubectl|helm|terraform)\s+(?:apply|destroy|delete|uninstall)\b/,
  /\brm\s+-[a-zA-Z]*r[a-zA-Z]*f?\b|\bdelete (?:the |all )?(?:branch|file|files|directory|database|resources?)\b/i,
  /\b(?:drop|truncate)\s+(?:table|database)\b/i,
  /\bdeploy (?:to |the )/i,
  /\b(?:send|email|post|upload) (?:the |this )?(?:file|files|report|data|message)\b/i,
  /\b(?:charge|pay|purchase|subscribe)\b/i,
]

/**
 * Whether the next step the turn announced is hard to undo.
 *
 * @param {string} text The closing message, or the step it announces.
 * @returns {boolean}
 */
export function announcedIrreversibleStep(text) {
  const candidate = String(text ?? '')
  return IRREVERSIBLE_PATTERNS.some((pattern) => pattern.test(candidate))
}

/**
 * The decision point.
 *
 * Input: `{userMessage, finalMessage, irreversible?}`
 * Outcome: `'nudge'` (let the model carry on) or `'end'`.
 */
export const turnContinue = defineDecision({
  id: 'turn.continue',
  version: 1,
  questions: {
    promised: {
      type: 'boolean',
      instructions:
        'Does `final_message` say the assistant will now act, continue working, or call a tool, and then end without doing so?',
      criteria: {
        true: 'like "Let me run the tests next." or "I will now update the config."',
        false: 'like "The fix is done and the tests pass." — the statement reports what already happened',
      },
    },
    asks_go_ahead: {
      type: 'boolean',
      instructions: 'Does `final_message` ask the user for permission or a decision before continuing?',
      criteria: {
        true: 'like "Should I go ahead and apply this?" or "Want me to continue?"',
        false: 'reports a result, states a blocker, or asks a question about requirements',
      },
    },
    work_requested: {
      type: 'boolean',
      instructions: 'Does `user_message` already ask for the work that the assistant is waiting to be allowed to do?',
      criteria: {
        true: 'the user asked for the change, the fix, the file or the outcome the assistant is waiting on',
        false: 'the user asked a question, described a problem without asking for a change, or asked for something else',
      },
    },
  },
  capabilities: 'relate',
  cacheImpact: 'none',
  latency: 'inline',

  buildState: (input) => ({
    user_message: String(input.userMessage ?? ''),
    final_message: String(input.finalMessage ?? ''),
  }),

  policy: (answers, input) => {
    // A step that cannot be undone is never pushed: ending is the safe verdict.
    if (input.irreversible === true) return ABSTAIN
    if (answers.promised.probability >= PROMISE_THRESHOLD) return 'nudge'
    const asked = answers.asks_go_ahead?.probability ?? 0
    const requested = answers.work_requested?.probability ?? 0
    if (asked >= ASK_THRESHOLD && requested >= REQUEST_THRESHOLD) return 'nudge'
    return 'end'
  },

  // Without a judge the turn ends: this point exists to catch a specific
  // failure, not to keep every turn alive.
  fallback: () => 'end',
})

/**
 * The message the model receives when the verdict is `nudge`.
 *
 * @param {{kind?: 'promised' | 'asked'}} [details]
 * @returns {string}
 */
export function continuationNudge(details = {}) {
  if (details.kind === 'asked') {
    return (
      'You asked for a go-ahead on work that was already requested. Carry on with it — ' +
      'stop only if something irreversible is next, or if you are blocked.'
    )
  }
  return (
    'You ended the turn announcing the next step without taking it. Take that step now, ' +
    'or say plainly why you cannot.'
  )
}

export default turnContinue
