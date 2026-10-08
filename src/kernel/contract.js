/**
 * The kernel's data contract: what a decision point may ask, and what a judge's
 * answer has to look like before any policy is allowed to trust it.
 *
 * The vocabulary is small on purpose. A judge reads a 32K window fastest from a
 * few short fields, so a question is one predicate over a small state, and an
 * answer is a probability or a closed choice — never prose.
 *
 * @module dsh-jev-judge/kernel/contract
 */

/**
 * A value that survives a JSON round trip.
 *
 * @typedef {string | number | boolean | null | JsonValue[] | {[key: string]: JsonValue}} JsonValue
 */

/**
 * What the judge reads: a string, or a structured object/array whose fields the
 * question refers to by name.
 *
 * @typedef {string | {[key: string]: JsonValue} | JsonValue[]} JudgeInput
 */

/**
 * A yes/no question. The community name for this primitive is "Noul", which is
 * also what the System One wire calls it.
 *
 * @typedef {object} BooleanQuestion
 * @property {'boolean'} type
 * @property {JudgeInput} instructions
 * @property {{true?: JudgeInput | null, false?: JudgeInput | null}} [criteria]
 */

/**
 * Pick one option from a closed set. The set must carry an escape answer, so a
 * judge is never forced to choose something that does not fit.
 *
 * @typedef {object} ChoiceQuestion
 * @property {'choice'} type
 * @property {JudgeInput} instructions
 * @property {Record<string, JudgeInput | null>} criteria Option name to description.
 */

/**
 * Place the state on an ordered rubric of at least two levels, indexed from 0.
 *
 * @typedef {object} ScoreQuestion
 * @property {'score'} type
 * @property {JudgeInput} instructions
 * @property {(JudgeInput | null)[]} criteria Ordered levels.
 */

/** @typedef {BooleanQuestion | ChoiceQuestion | ScoreQuestion} Question */

/**
 * What answering a question takes, which is what separates judges in practice:
 * `classify` says what one piece of text is; `relate` says how two pieces of
 * text relate; `rate` places the state on an ordinal rubric; `meta` judges a
 * property of the request itself.
 *
 * @typedef {'classify' | 'relate' | 'rate' | 'meta'} Capability
 */

/**
 * How much a verdict is allowed to change. A point whose verdict can only
 * loosen policy earns `active` from a ledger; it does not start there.
 *
 * @typedef {'off' | 'shadow' | 'active'} Mode
 */

/**
 * What acting on a decision does to the provider prompt cache. A
 * `prefix-mutating` verdict rewrites earlier context and is only safe at a cache
 * boundary.
 *
 * @typedef {'none' | 'append-only' | 'prefix-mutating'} CacheImpact
 */

/**
 * Whether the action waits for the judge (`inline`), races other work
 * (`parallel`), or never blocks the loop (`background`).
 *
 * @typedef {'inline' | 'parallel' | 'background'} LatencyClass
 */

/**
 * Optional self-assessment a provider may attach to an answer. Jev over System
 * One sends `confidence`; a judge that sends none leaves it undefined.
 *
 * @typedef {object} AnswerSignals
 * @property {number} [confidence] Provider-reported confidence in [0, 1].
 * @property {string} [judge] Which judge produced the answer, when several are chained.
 */

/** @typedef {{type: 'boolean', probability: number} & AnswerSignals} BooleanAnswer */
/** @typedef {{type: 'choice', choice: string, probabilities?: Record<string, number>} & AnswerSignals} ChoiceAnswer */
/** @typedef {{type: 'score', score: number, probabilities?: Record<string, number>} & AnswerSignals} ScoreAnswer */
/** @typedef {BooleanAnswer | ChoiceAnswer | ScoreAnswer} Answer */

/** @typedef {{inputTokens?: number, outputTokens?: number}} JudgeUsage */

/**
 * Something the provider did that the caller did not ask for, such as truncating
 * the state or answering a question that does not exist.
 *
 * @typedef {object} JudgeWarning
 * @property {string} type
 * @property {string} [message]
 * @property {string} [questionId]
 */

/** @typedef {{answers: Record<string, Answer>, usage?: JudgeUsage, modelId?: string, warnings?: JudgeWarning[]}} ProviderResponse */

/**
 * A backend that answers typed questions about one shared state.
 *
 * An implementation throws a `JudgeError` for every failure it can classify and
 * never retries: the kernel owns timeouts and the fail-open policy.
 *
 * @typedef {object} JudgeProvider
 * @property {string} id Stable identifier, reported in the ledger and errors.
 * @property {(request: {state: JudgeInput, questions: Record<string, Question>, signal?: AbortSignal}) => Promise<ProviderResponse>} evaluate
 */

/** The rollout modes, in the order they are earned. */
export const MODES = Object.freeze(['off', 'shadow', 'active'])

/** The question kinds a decision point may declare. */
export const QUESTION_TYPES = Object.freeze(['boolean', 'choice', 'score'])

/** What answering a question takes. */
export const CAPABILITIES = Object.freeze(['classify', 'relate', 'rate', 'meta'])

/**
 * Option names that count as an escape answer: the judge may always decline to
 * pick something that does not fit, and a `choice` question is rejected at
 * definition time without one.
 */
export const ESCAPE_OPTIONS = Object.freeze([
  'none',
  'none_of_the_above',
  'no_match',
  'other',
  'unclear',
  'unknown',
  'unsure',
  'not_sure',
  'neither',
])

/**
 * Whether a value is a plain JSON object (not an array, not null).
 *
 * @param {unknown} value
 * @returns {boolean}
 */
export function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Whether a question input is one of the shapes the wire accepts.
 *
 * @param {unknown} value
 * @returns {boolean}
 */
function isJudgeInput(value) {
  return (
    typeof value === 'string' ||
    Array.isArray(value) ||
    isPlainObject(value)
  )
}

/**
 * Fold an option name to the form the escape list is written in, so `No match`,
 * `no-match` and `NO_MATCH` all count.
 *
 * @param {string} option
 * @returns {string}
 */
export function normalizeOptionName(option) {
  return String(option).trim().toLowerCase().replaceAll(/[\s-]+/g, '_')
}

/**
 * Whether a choice question's option set carries an escape answer.
 *
 * @param {ChoiceQuestion} question
 * @returns {boolean}
 */
export function hasEscapeOption(question) {
  return Object.keys(question.criteria).some((option) =>
    ESCAPE_OPTIONS.includes(normalizeOptionName(option)),
  )
}

/**
 * Validate one question, throwing a `TypeError` that names the decision point
 * and the question so a misdeclared point fails at import time rather than in
 * production.
 *
 * @param {string} id
 * @param {unknown} question
 * @throws {TypeError}
 * @returns {void}
 */
export function validateQuestion(id, question) {
  if (!isPlainObject(question)) {
    throw new TypeError(`Question "${id}" must be an object`)
  }
  const { type } = question
  if (!QUESTION_TYPES.includes(type)) {
    throw new TypeError(
      `Question "${id}" has type "${String(type)}"; expected one of ${QUESTION_TYPES.join(', ')}`,
    )
  }
  if (!isJudgeInput(question.instructions)) {
    throw new TypeError(`Question "${id}" needs \`instructions\` (string, object or array)`)
  }
  if (type === 'boolean') {
    const criteria = question.criteria
    if (criteria !== undefined && !isPlainObject(criteria)) {
      throw new TypeError(`Boolean question "${id}" \`criteria\` must be an object when present`)
    }
    return
  }
  if (type === 'choice') {
    const criteria = question.criteria
    if (!isPlainObject(criteria) || Object.keys(criteria).length === 0) {
      throw new TypeError(`Choice question "${id}" needs a non-empty \`criteria\` option map`)
    }
    for (const [option, description] of Object.entries(criteria)) {
      if (description !== null && !isJudgeInput(description)) {
        throw new TypeError(
          `Choice option "${option}" of question "${id}" must be text, a structured value, or null`,
        )
      }
    }
    return
  }
  const levels = question.criteria
  if (!Array.isArray(levels) || levels.length < 2) {
    throw new TypeError(
      `Score question "${id}" needs \`criteria\` as an array of at least two ordered levels`,
    )
  }
}

/**
 * Validate every question of a decision point.
 *
 * @param {Record<string, unknown>} questions
 * @throws {TypeError}
 * @returns {void}
 */
export function validateQuestions(questions) {
  if (!isPlainObject(questions)) {
    throw new TypeError('`questions` must be an object keyed by question id')
  }
  for (const [id, question] of Object.entries(questions)) {
    validateQuestion(id, question)
  }
}

/**
 * Clamp a number into a range, reporting whether it had to move.
 *
 * @param {number} value
 * @param {number} min
 * @param {number} max
 * @returns {{value: number, clamped: boolean}}
 */
function clamp(value, min, max) {
  if (value < min) return { value: min, clamped: true }
  if (value > max) return { value: max, clamped: true }
  return { value, clamped: false }
}

/**
 * Turn one provider answer into a kernel `Answer`, or `undefined` when it is
 * not usable. An unusable answer is not an error: it means "no judge answered
 * this question", and the caller's fallback stands.
 *
 * @param {Question} question The question the answer must fit.
 * @param {unknown} raw The provider's answer payload.
 * @param {{warnings?: JudgeWarning[]}} [context] Collects normalization notes.
 * @returns {Answer | undefined}
 */
export function coerceAnswer(question, raw, context = {}) {
  if (!isPlainObject(raw)) return undefined

  const signals = {}
  if (typeof raw.confidence === 'number' && Number.isFinite(raw.confidence)) {
    signals.confidence = Math.min(1, Math.max(0, raw.confidence))
  }
  if (typeof raw.judge === 'string' && raw.judge !== '') signals.judge = raw.judge

  if (question.type === 'boolean') {
    const probability = raw.noul
    if (typeof probability !== 'number' || !Number.isFinite(probability)) return undefined
    const bounded = clamp(probability, 0, 1)
    if (bounded.clamped) {
      context.warnings?.push({
        type: 'out-of-range',
        message: `boolean probability ${probability} clamped into [0, 1]`,
      })
    }
    return { type: 'boolean', probability: bounded.value, ...signals }
  }

  if (question.type === 'score') {
    const score = raw.score
    if (typeof score !== 'number' || !Number.isFinite(score)) return undefined
    const bounded = clamp(score, 0, question.criteria.length - 1)
    if (bounded.clamped) {
      context.warnings?.push({
        type: 'out-of-range',
        message: `score ${score} clamped into [0, ${question.criteria.length - 1}]`,
      })
    }
    const probabilities = probabilitiesOf(raw.probabilities, Object.keys(question.criteria).map(String))
    return probabilities
      ? { type: 'score', score: bounded.value, probabilities, ...signals }
      : { type: 'score', score: bounded.value, ...signals }
  }

  if (typeof raw.choice !== 'string' || !Object.hasOwn(question.criteria, raw.choice)) {
    return undefined
  }
  const probabilities = probabilitiesOf(raw.probabilities, Object.keys(question.criteria))
  return probabilities
    ? { type: 'choice', choice: raw.choice, probabilities, ...signals }
    : { type: 'choice', choice: raw.choice, ...signals }
}

/**
 * Keep only finite, non-negative entries of a probability map, optionally
 * restricted to known keys. A provider that sends nothing usable yields
 * `undefined` rather than an empty object, so callers can tell the two apart.
 *
 * @param {unknown} value
 * @param {string[]} [allowed]
 * @returns {Record<string, number> | undefined}
 */
export function probabilitiesOf(value, allowed) {
  if (!isPlainObject(value)) return undefined
  const entries = Object.entries(value).filter(
    (entry) =>
      typeof entry[1] === 'number' &&
      Number.isFinite(entry[1]) &&
      (allowed === undefined || allowed.includes(entry[0])),
  )
  return entries.length > 0 ? Object.fromEntries(entries) : undefined
}
