/**
 * Decoding a provider's raw answers into the kernel's answer contract.
 *
 * Every provider ends up here, so the rules that decide whether an answer may be
 * trusted live in one place: the answer must fit the question it claims to
 * answer, a wrong-shaped answer is dropped as "no judge answered" rather than
 * coerced into something plausible, and anything unusual is reported as a
 * warning instead of failing the call.
 *
 * @module dsh-jev-judge/kernel/judge
 */

import { coerceAnswer, isPlainObject } from './contract.js'

/**
 * Decode one provider answer payload against its question.
 *
 * @param {import('./contract.js').Question} question
 * @param {unknown} raw
 * @param {import('./contract.js').JudgeWarning[]} warnings
 * @returns {import('./contract.js').Answer | undefined}
 */
export function answerFromRaw(question, raw, warnings) {
  const answer = coerceAnswer(question, raw, { warnings })
  return answer === undefined ? undefined : { ...answer }
}

/**
 * Check an answer that is already in kernel form, as a mock or an in-process
 * judge returns it.
 *
 * @param {import('./contract.js').Question} question
 * @param {unknown} answer
 * @returns {import('./contract.js').Answer | undefined}
 */
export function validateAnswer(question, answer) {
  if (!isPlainObject(answer) || answer.type !== question.type) return undefined
  const signals = {}
  if (typeof answer.confidence === 'number' && Number.isFinite(answer.confidence)) {
    signals.confidence = Math.min(1, Math.max(0, answer.confidence))
  }
  if (typeof answer.judge === 'string' && answer.judge !== '') signals.judge = answer.judge

  if (question.type === 'boolean') {
    const probability = answer.probability
    if (typeof probability !== 'number' || !Number.isFinite(probability)) return undefined
    return { type: 'boolean', probability: Math.min(1, Math.max(0, probability)), ...signals }
  }
  if (question.type === 'score') {
    const score = answer.score
    if (typeof score !== 'number' || !Number.isFinite(score)) return undefined
    return {
      type: 'score',
      score: Math.min(question.criteria.length - 1, Math.max(0, score)),
      ...signals,
    }
  }
  if (typeof answer.choice !== 'string' || !Object.hasOwn(question.criteria, answer.choice)) {
    return undefined
  }
  return { type: 'choice', choice: answer.choice, ...signals }
}

/**
 * Decode a provider's answer map against the questions that were asked.
 *
 * @param {Record<string, import('./contract.js').Question>} questions
 * @param {unknown} rawAnswers
 * @param {{warnings?: import('./contract.js').JudgeWarning[]}} [context]
 * @returns {Record<string, import('./contract.js').Answer>}
 */
export function decodeAnswers(questions, rawAnswers, context = {}) {
  const warnings = context.warnings ?? []
  const answers = {}
  if (!isPlainObject(rawAnswers)) return answers

  for (const [id, raw] of Object.entries(rawAnswers)) {
    const question = questions[id]
    if (question === undefined) {
      warnings.push({
        type: 'unexpected-answer',
        message: `judge answered "${id}", which was not asked`,
        questionId: id,
      })
      continue
    }
    const answer = answerFromRaw(question, raw, warnings)
    if (answer === undefined) {
      warnings.push({
        type: 'unusable-answer',
        message: `answer to "${id}" does not fit a ${question.type} question and was dropped`,
        questionId: id,
      })
      continue
    }
    answers[id] = answer
  }
  return answers
}

/**
 * Read token usage out of a provider payload, in either naming convention.
 *
 * @param {unknown} raw
 * @returns {import('./contract.js').JudgeUsage | undefined}
 */
export function normalizeUsage(raw) {
  if (!isPlainObject(raw)) return undefined
  const input = firstFinite(raw.inputTokens, raw.input_tokens, raw.prompt_tokens)
  const output = firstFinite(raw.outputTokens, raw.output_tokens, raw.completion_tokens)
  if (input === undefined && output === undefined) return undefined
  const usage = {}
  if (input !== undefined) usage.inputTokens = input
  if (output !== undefined) usage.outputTokens = output
  return usage
}

/**
 * @param {...unknown} values
 * @returns {number | undefined}
 */
function firstFinite(...values) {
  return values.find((value) => typeof value === 'number' && Number.isFinite(value) && value >= 0)
}
