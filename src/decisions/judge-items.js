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

/**
 * How many items one request may carry. A larger list is split into this many
 * per call.
 *
 * The limit is the provider's, not ours: the System One endpoint this package
 * was verified against answers a 21st question with
 * `at most 20 questions per call`. A deployment whose judge allows more raises
 * it in `options["judge.items"].maxItems` rather than being held to the smallest
 * provider in the world.
 */
export const MAX_ITEMS = 20

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
    /** @type {Record<string, {type: string, instructions: string}>} */
    const questions = {}
    for (const item of items) {
      // The predicate and its examples live once in the shared state; repeating
      // them per item is the difference between a request a small judge can take
      // and a 400 from the provider when a list is long.
      questions[item.id] = {
        type: 'boolean',
        instructions: `Does \`items.${item.id}\` satisfy the condition in \`question\`?`,
      }
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
      ...(input.question.criteria ? { examples: input.question.criteria } : {}),
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

/**
 * The per-call item limit a deployment configured, or the built-in default.
 *
 * @param {Record<string, unknown> | undefined} options The kernel's `options`.
 * @returns {number}
 */
export function maxItemsFrom(options) {
  const configured = options?.['judge.items']?.maxItems ?? options?.judgeItems?.maxItems
  return Number.isFinite(configured) && configured > 0 ? Number(configured) : MAX_ITEMS
}

/**
 * Split items into request-sized groups.
 *
 * @param {{id?: string, text: string}[]} items
 * @param {{maxItems?: number}} [options]
 * @returns {{id?: string, text: string}[][]}
 */
export function chunkItems(items, options = {}) {
  const maxItems = Math.max(1, Math.floor(options.maxItems ?? MAX_ITEMS))
  const groups = []
  for (let index = 0; index < items.length; index += maxItems) {
    groups.push(items.slice(index, index + maxItems))
  }
  return groups
}

/**
 * Judge a list of items, splitting it into as many requests as the list needs
 * and merging the verdicts into one outcome.
 *
 * A judge reads a bounded window, so a list longer than one request is the
 * caller's problem to route and not the provider's to absorb: sending 1200 items
 * once is how a 400 arrives instead of a verdict.
 *
 * @param {{engine: object, input: {question: object, items: object[], task?: string}, mode?: string, maxItems?: number}} request
 * @returns {Promise<{items: object[], selected: string[], batches: number, latencyMs: number, unavailable?: true, reason?: string}>}
 */
export async function runItemsJudgment({ engine, input, mode = 'active', maxItems }) {
  const items = Array.isArray(input.items) ? input.items : []
  const groups = chunkItems(items, { maxItems })
  if (groups.length === 0) {
    return { items: [], selected: [], batches: 0, latencyMs: 0 }
  }

  const merged = []
  const selected = []
  let latencyMs = 0
  let reason
  for (const group of groups) {
    const decision = await engine.decide(
      judgeItems,
      { ...input, items: group },
      { mode },
    )
    latencyMs += decision.latencyMs ?? 0
    if (decision.outcome?.unavailable) {
      return { ...decision.outcome, batches: groups.length, latencyMs, ...(decision.reason ? { reason: decision.reason } : {}) }
    }
    if (decision.source !== 'judge' && decision.reason) reason = decision.reason
    merged.push(...(decision.outcome?.items ?? []))
    selected.push(...(decision.outcome?.selected ?? []))
  }

  return {
    items: merged,
    selected,
    batches: groups.length,
    latencyMs,
    ...(reason ? { reason } : {}),
  }
}
