/**
 * `judge.items` — one question, asked of many items, answered in one request.
 *
 * This is the decision point a model reaches for on purpose: hundreds of log
 * lines, files or findings that would otherwise all have to be read into the
 * context window before anything could be decided. The item text travels once,
 * in the shared state; each question is a short predicate that names its item by
 * path.
 *
 * @module dsh-jev-judge/decisions/judge-items
 */

import { defineDecision } from '../kernel/decision.js'

/** How many items one call may carry. Beyond this, the caller must chunk. */
export const MAX_ITEMS = 512

/** The judge reads fastest from short fields; longer items are truncated. */
export const MAX_ITEM_CHARS = 2000

/** A bound on the whole state, so one call cannot overrun the judge's window. */
export const MAX_TOTAL_CHARS = 60_000

/** At or above this probability, an item counts as a match. */
export const SELECT_THRESHOLD = 0.8

/**
 * Prepare the items a call would send: bounded, named, and honest about what was
 * truncated. An empty item is dropped rather than asked about.
 *
 * @param {{id?: string, text: string}[]} items
 * @param {{maxItems?: number, maxItemChars?: number, maxTotalChars?: number}} [limits]
 * @returns {{items: {id: string, text: string, truncated: boolean, originalChars: number}[], dropped: number, truncated: number}}
 */
export function prepareItems(items, limits = {}) {
  const maxItems = limits.maxItems ?? MAX_ITEMS
  const maxItemChars = limits.maxItemChars ?? MAX_ITEM_CHARS
  const maxTotalChars = limits.maxTotalChars ?? MAX_TOTAL_CHARS

  const prepared = []
  let dropped = 0
  let truncated = 0
  let budget = maxTotalChars

  for (const [index, item] of items.entries()) {
    const text = String(item?.text ?? '')
    // The budget decides how many whole items fit; an item is never reduced to a
    // fragment too short to answer a question about.
    if (text.trim() === '' || prepared.length >= maxItems || budget < maxItemChars) {
      dropped += 1
      continue
    }
    const originalChars = text.length
    const allowance = Math.max(0, Math.min(maxItemChars, budget))
    const clipped = text.length > allowance
    const kept = clipped ? text.slice(0, allowance) : text
    if (clipped) truncated += 1
    budget -= kept.length
    prepared.push({
      id: String(item.id ?? index),
      text: kept,
      truncated: clipped,
      originalChars,
    })
  }

  return { items: prepared, dropped, truncated }
}

/**
 * The decision point.
 *
 * Input: `{items: [{id, text}], question: {instructions, criteria?}, task?}`
 * Outcome: `{items: [{id, probability, selected, truncated}], selected: string[], unavailable?: true}`
 */
export const judgeItems = defineDecision({
  id: 'judge.items',
  version: 1,
  questions: {},
  capabilities: 'classify',
  cacheImpact: 'none',
  latency: 'inline',

  questionsFor: (input) => {
    const { items } = prepareItems(input.items ?? [])
    /** @type {Record<string, {type: string, instructions: string, criteria?: unknown}>} */
    const questions = {}
    for (const item of items) {
      const question = {
        type: 'boolean',
        instructions: `Does item \`items.${item.id}\` satisfy this condition: ${input.question.instructions}`,
      }
      if (input.question.criteria !== undefined) question.criteria = input.question.criteria
      questions[item.id] = question
    }
    return questions
  },

  buildState: (input) => {
    const { items } = prepareItems(input.items ?? [])
    /** @type {Record<string, string>} */
    const state = {}
    for (const item of items) state[item.id] = item.text
    return {
      ...(input.task ? { task: input.task } : {}),
      question: input.question.instructions,
      items: state,
    }
  },

  policy: (answers, input) => {
    const { items } = prepareItems(input.items ?? [])
    const results = items.map((item) => {
      const answer = answers[item.id]
      const probability = answer === undefined ? null : answer.probability
      return {
        id: item.id,
        probability,
        selected: probability !== null && probability >= SELECT_THRESHOLD,
        truncated: item.truncated,
      }
    })
    return {
      items: results,
      selected: results.filter((item) => item.selected).map((item) => item.id),
    }
  },

  // Without a judge a caller must read everything itself; answering "nothing
  // matched" would silently hide the very items the question was about.
  fallback: () => ({ items: [], selected: [], unavailable: true }),
})

export default judgeItems
