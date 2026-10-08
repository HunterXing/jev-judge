/**
 * The decision points this kernel ships.
 *
 * Each one is a bounded question about a small state plus the effect its answer
 * is allowed to have, declared with `defineDecision` so that a misdeclared point
 * fails at import time rather than in a session. They are host-free: a DeepSeek
 * Harness plugin, an MCP tool and a command-hook adapter all run the same
 * objects.
 *
 * @module dsh-jev-judge/decisions
 */

export { judgeItems, MAX_ITEMS, MAX_ITEM_CHARS, SELECT_THRESHOLD, prepareItems } from './judge-items.js'
export {
  MIN_JUDGED_CHARS,
  MAX_CHUNKS,
  KEEP_THRESHOLD,
  admissionNote,
  shouldJudge,
  splitChunks,
  toolAdmission,
} from './tool-admission.js'
export {
  MAX_PASSAGES,
  MIN_PASSAGE_CHARS,
  WITHHOLD_THRESHOLD,
  ruleWithheldPassages,
  screen,
  splitPassages,
  toolInjection,
  withholdingNote,
} from './tool-injection.js'
export { VOUCH_THRESHOLD, looksRisky, toolRisk } from './tool-risk.js'
export {
  CLAIM_THRESHOLD,
  UNVERIFIED_THRESHOLD,
  completionNudge,
  showsVerification,
  turnCompletion,
} from './turn-completion.js'
export {
  ASK_THRESHOLD,
  PROMISE_THRESHOLD,
  REQUEST_THRESHOLD,
  announcedIrreversibleStep,
  continuationNudge,
  turnContinue,
} from './turn-continue.js'
export { CAPTURE_THRESHOLD, MAX_LESSON_CHARS, memoryCapture, toLesson } from './memory-capture.js'

import { judgeItems } from './judge-items.js'
import { memoryCapture } from './memory-capture.js'
import { toolAdmission } from './tool-admission.js'
import { toolInjection } from './tool-injection.js'
import { toolRisk } from './tool-risk.js'
import { turnCompletion } from './turn-completion.js'
import { turnContinue } from './turn-continue.js'

/**
 * Every decision point, by id. The keys are the stable identities the ledger
 * records and the configuration switches.
 *
 * @type {Record<string, import('../kernel/decision.js').DecisionSpec>}
 */
export const DECISIONS = Object.freeze({
  [judgeItems.id]: judgeItems,
  [toolAdmission.id]: toolAdmission,
  [toolInjection.id]: toolInjection,
  [toolRisk.id]: toolRisk,
  [turnCompletion.id]: turnCompletion,
  [turnContinue.id]: turnContinue,
  [memoryCapture.id]: memoryCapture,
})

/** The decision point ids, in the order they are most often met. */
export const DECISION_IDS = Object.freeze(Object.keys(DECISIONS))

/**
 * Look a decision point up by id.
 *
 * @param {string} id
 * @returns {import('../kernel/decision.js').DecisionSpec | undefined}
 */
export function decisionById(id) {
  return DECISIONS[id]
}
