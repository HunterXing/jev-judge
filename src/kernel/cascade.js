/**
 * The tier cascade.
 *
 * Judges differ in what they are good at and what they cost, so they are tried
 * in order and each later judge only sees what the earlier ones left uncertain.
 * A judge that fails does not end the call: the next tier may still answer, and
 * a tier system that answers nothing is the ordinary fallback case, not an
 * incident.
 *
 * Tiers run in sequence, never in parallel: a later judge is expected to see the
 * questions the earlier one could not settle, and asking everything twice is the
 * cost this cascade exists to avoid.
 *
 * @module dsh-jev-judge/kernel/cascade
 */

import { toJudgeError } from './errors.js'
import { uncertainQuestionIds } from './policy.js'

/**
 * What one tier did, for the ledger.
 *
 * @typedef {object} TierReport
 * @property {string} id
 * @property {string[]} asked Question ids this tier was asked.
 * @property {string[]} answered Question ids this tier answered.
 * @property {number} latencyMs
 * @property {string} [modelId] The model the provider reported answering.
 * @property {string} [errorKind] Set when the tier failed to answer at all.
 * @property {string} [errorMessage]
 * @property {import('./contract.js').JudgeUsage} [usage]
 */

/**
 * Whether a judge is able to answer a question that requires `capability`. A
 * judge that declares no capabilities is treated as able to try anything.
 *
 * @param {{capabilities?: readonly string[]}} judge
 * @param {string | undefined} capability
 * @returns {boolean}
 */
function canAnswer(judge, capability) {
  if (capability === undefined) return true
  if (!Array.isArray(judge.capabilities) || judge.capabilities.length === 0) return true
  return judge.capabilities.includes(capability)
}

/**
 * Run the tiers in order and merge what they answer.
 *
 * @param {readonly {id: string, evaluate: Function, capabilities?: readonly string[]}[]} tiers
 * @param {object} request
 * @param {import('./contract.js').JudgeInput} request.state
 * @param {Record<string, import('./contract.js').Question>} request.questions
 * @param {Record<string, string | undefined>} [request.capabilities] Per question id.
 * @param {import('./policy.js').UncertaintyBand} request.band
 * @param {AbortSignal} [request.signal]
 * @returns {Promise<{
 *   answers: Record<string, import('./contract.js').Answer>,
 *   tiers: TierReport[],
 *   usage?: import('./contract.js').JudgeUsage,
 *   warnings: import('./contract.js').JudgeWarning[],
 *   error?: {kind: string, message: string},
 * }>}
 */
export async function runCascade(tiers, request) {
  /** @type {Record<string, import('./contract.js').Answer>} */
  const answers = {}
  /** @type {TierReport[]} */
  const reports = []
  /** @type {import('./contract.js').JudgeWarning[]} */
  const warnings = []
  /** @type {import('./contract.js').JudgeUsage | undefined} */
  let usage
  /** @type {{kind: string, message: string} | undefined} */
  let lastError
  const capabilities = request.capabilities ?? {}

  for (const judge of tiers) {
    if (request.signal?.aborted) break

    const open = uncertainQuestionIds(request.questions, answers, request.band).filter((id) =>
      canAnswer(judge, capabilities[id]),
    )
    if (open.length === 0) break

    /** @type {Record<string, import('./contract.js').Question>} */
    const asked = {}
    for (const id of open) asked[id] = request.questions[id]

    const startedAt = Date.now()
    try {
      const response = await judge.evaluate({
        state: request.state,
        questions: asked,
        signal: request.signal,
      })
      const answered = Object.keys(response.answers ?? {}).filter((id) => id in asked)
      for (const id of answered) {
        // A tier replaces the uncertain answer that caused it to be asked; an
        // answer for a question it was not asked is not admitted at all.
        answers[id] = response.answers[id]
      }
      if (response.warnings) warnings.push(...response.warnings)
      if (response.usage) usage = mergeUsage(usage, response.usage)
      reports.push({
        id: judge.id,
        asked: open,
        answered,
        latencyMs: Date.now() - startedAt,
        ...(response.modelId ? { modelId: response.modelId } : {}),
        ...(response.usage ? { usage: response.usage } : {}),
      })
    } catch (error) {
      // A provider may throw anything. Classifying here keeps the ledger's
      // reason the same whether the failure was a `JudgeError` or a raw throw.
      const classified = toJudgeError(error, { service: `judge "${judge.id}"` })
      lastError = { kind: classified.kind, message: classified.message }
      reports.push({
        id: judge.id,
        asked: open,
        answered: [],
        latencyMs: Date.now() - startedAt,
        errorKind: classified.kind,
        errorMessage: classified.message,
      })
    }
  }

  // An error is reported only when nothing at all was answered: a tier that
  // failed after an earlier tier answered is a partial success, and the failure
  // stays visible in that tier's report.
  const error = Object.keys(answers).length === 0 ? lastError : undefined
  return {
    answers,
    tiers: reports,
    warnings,
    ...(usage ? { usage } : {}),
    ...(error ? { error } : {}),
  }
}

/**
 * Add two usage reports.
 *
 * @param {import('./contract.js').JudgeUsage | undefined} left
 * @param {import('./contract.js').JudgeUsage} right
 * @returns {import('./contract.js').JudgeUsage}
 */
function mergeUsage(left, right) {
  return {
    inputTokens: (left?.inputTokens ?? 0) + (right.inputTokens ?? 0),
    outputTokens: (left?.outputTokens ?? 0) + (right.outputTokens ?? 0),
  }
}
