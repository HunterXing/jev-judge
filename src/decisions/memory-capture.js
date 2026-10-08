/**
 * `memory.capture` — was that a correction, or the next task?
 *
 * A message like "no, use pnpm here, not npm" is worth keeping: it applies to
 * every future turn in this project. A message like "now add a logout button"
 * is not — it is work, not a rule. Both arrive as ordinary user text, and
 * mistaking the second for the first fills the project with noise.
 *
 * What is kept is short by construction: one line, taken from the user's own
 * words, because a lesson the agent rewrote is a lesson nobody can check against
 * what the user actually said.
 *
 * @module dsh-jev-judge/decisions/memory-capture
 */

import { defineDecision } from '../kernel/decision.js'

/** At or above this, the message is kept as a lesson. */
export const CAPTURE_THRESHOLD = 0.8

/** How long a stored lesson may be, so the file stays readable. */
export const MAX_LESSON_CHARS = 240

/** Messages longer than this are working instructions, not corrections. */
export const MAX_CAPTURE_INPUT_CHARS = 1200

/**
 * The decision point.
 *
 * Input: `{userMessage}`
 * Outcome: `'capture'` or `'ignore'`.
 */
export const memoryCapture = defineDecision({
  id: 'memory.capture',
  version: 1,
  questions: {
    lesson: {
      type: 'boolean',
      instructions:
        'Does `user_message` correct how the assistant works or set a rule for later, rather than assigning the next task?',
      criteria: {
        true: 'like "use pnpm in this repo", "never touch the generated folder", "I already told you not to use that name"',
        false: 'like "add a logout button", "now fix the login page", "what does this function do?" — a task or a question',
      },
    },
  },
  capabilities: 'classify',
  cacheImpact: 'none',
  latency: 'parallel',

  buildState: (input) => ({
    user_message: String(input.userMessage ?? '').slice(0, MAX_CAPTURE_INPUT_CHARS),
  }),

  policy: (answers) => (answers.lesson.probability >= CAPTURE_THRESHOLD ? 'capture' : 'ignore'),

  // Without a judge nothing is written: an unasked-for lesson file is worse than
  // a missing one.
  fallback: () => 'ignore',
})

/**
 * Turn a message into the line that gets stored: the user's own words, one line,
 * bounded, with the pleasantries and the preamble trimmed.
 *
 * @param {string} message
 * @param {{maxChars?: number}} [options]
 * @returns {string}
 */
export function toLesson(message, options = {}) {
  const maxChars = options.maxChars ?? MAX_LESSON_CHARS
  const text = String(message ?? '')
    .replace(/\s+/g, ' ')
    .trim()
    // Drop a leading acknowledgement so the rule itself is the first thing read.
    .replace(/^(?:no|nope|wait|actually|hmm|well)[,.:;]?\s+/i, '')
  if (text === '') return ''
  return text.length <= maxChars ? text : `${text.slice(0, maxChars - 1).trimEnd()}…`
}

export default memoryCapture
