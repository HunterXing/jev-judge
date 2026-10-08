/**
 * Decision points and the engine that runs them.
 *
 * A decision point is one bounded question about a small state, plus what the
 * answer is allowed to change. The engine owns everything that must not vary
 * between points: whether the point may act at all, which judge answers, how
 * long to wait, what happens when nobody answers, and what gets recorded.
 *
 * Two rules shape every line below:
 *
 * - **The fallback is the behaviour without this kernel.** A point that cannot
 *   be answered — no judge, no time, a broken provider, an `ABSTAIN` — returns
 *   exactly what the host would have done anyway.
 * - **Nothing here throws at the caller.** A kernel failure is a fallback with a
 *   reason, never an exception in an agent loop.
 *
 * @module dsh-jev-judge/kernel/decision
 */

import { runCascade } from './cascade.js'
import {
  CAPABILITIES,
  MODES,
  hasEscapeOption,
  isPlainObject,
  validateQuestions,
} from './contract.js'
import { toJudgeError } from './errors.js'
import { DEFAULT_UNCERTAINTY, normalizeBand, within } from './policy.js'

/**
 * Returned by a policy to decline: the answers were not good enough to act on,
 * so the fallback stands. This is the honest way to say "I was not sure" — it is
 * recorded, and it is not confused with a judge failure.
 */
export const ABSTAIN = Symbol('jev-judge.abstain')

/** What acting on a decision does to the provider prompt cache. */
const CACHE_IMPACTS = Object.freeze(['none', 'append-only', 'prefix-mutating'])

/** How long the action may wait for a verdict. */
const LATENCY_CLASSES = Object.freeze(['inline', 'parallel', 'background'])

/**
 * @typedef {object} DecisionSpec
 * @property {string} id Stable identity, e.g. `tool.admission`.
 * @property {number} version Bump when wording or policy changes, so ledger records stay comparable.
 * @property {Record<string, import('./contract.js').Question>} questions
 * @property {(input: any) => Record<string, import('./contract.js').Question>} [questionsFor]
 *   Build the questions from the input, for a list whose length is only known at
 *   run time. One state, many questions: the judge answers them in one request.
 * @property {import('./contract.js').Capability | Record<string, import('./contract.js').Capability>} [capabilities]
 * @property {import('./contract.js').CacheImpact} cacheImpact
 * @property {import('./contract.js').LatencyClass} latency
 * @property {boolean} [allowChoicesWithoutEscape]
 * @property {(input: any) => import('./contract.js').JudgeInput} buildState
 * @property {(answers: Record<string, import('./contract.js').Answer>, input: any) => any} policy
 * @property {(input: any) => any} fallback
 */

/**
 * Declare a decision point, validating it now rather than in production.
 *
 * @param {DecisionSpec} spec
 * @returns {DecisionSpec}
 * @throws {TypeError} When the declaration could not be answered or acted on.
 */
export function defineDecision(spec) {
  if (typeof spec?.id !== 'string' || spec.id.trim() === '') {
    throw new TypeError('A decision needs a non-empty `id`')
  }
  if (!Number.isInteger(spec.version) || spec.version < 1) {
    throw new TypeError(`Decision "${spec.id}" needs a positive integer \`version\``)
  }
  if (!CACHE_IMPACTS.includes(spec.cacheImpact)) {
    throw new TypeError(
      `Decision "${spec.id}" needs \`cacheImpact\` one of ${CACHE_IMPACTS.join(', ')}`,
    )
  }
  if (!LATENCY_CLASSES.includes(spec.latency)) {
    throw new TypeError(
      `Decision "${spec.id}" needs \`latency\` one of ${LATENCY_CLASSES.join(', ')}`,
    )
  }
  for (const name of ['buildState', 'policy', 'fallback']) {
    if (typeof spec[name] !== 'function') {
      throw new TypeError(`Decision "${spec.id}" needs a \`${name}\` function`)
    }
  }
  if (spec.questionsFor === undefined) {
    validateQuestions(spec.questions)
  } else if (typeof spec.questionsFor !== 'function') {
    throw new TypeError(`Decision "${spec.id}" has a non-function \`questionsFor\``)
  }
  if (spec.capabilities !== undefined && typeof spec.capabilities !== 'string') {
    if (!isPlainObject(spec.capabilities)) {
      throw new TypeError(`Decision "${spec.id}" \`capabilities\` must be a string or a map`)
    }
  }
  if (typeof spec.capabilities === 'string' && !CAPABILITIES.includes(spec.capabilities)) {
    throw new TypeError(
      `Decision "${spec.id}" has capability "${spec.capabilities}"; expected one of ${CAPABILITIES.join(', ')}`,
    )
  }
  if (!spec.allowChoicesWithoutEscape) {
    for (const [questionId, question] of Object.entries(spec.questions)) {
      if (question.type === 'choice' && !hasEscapeOption(question)) {
        throw new TypeError(
          `Choice question "${questionId}" of decision "${spec.id}" has no escape option ` +
            '(one of none, other, unclear, unknown); a judge must be able to decline',
        )
      }
    }
  }
  return spec
}

/**
 * The questions a spec asks for one input.
 *
 * @param {DecisionSpec} spec
 * @param {unknown} input
 * @returns {Record<string, import('./contract.js').Question>}
 */
function questionsFor(spec, input) {
  const questions = spec.questionsFor ? spec.questionsFor(input) : spec.questions
  if (!isPlainObject(questions)) {
    throw new TypeError(`Decision "${spec.id}" produced no questions for this input`)
  }
  return /** @type {Record<string, import('./contract.js').Question>} */ (questions)
}

/**
 * The capability each question needs, expanded from the spec's declaration.
 *
 * @param {DecisionSpec} spec
 * @param {Record<string, unknown>} questions
 * @returns {Record<string, string | undefined>}
 */
function capabilitiesFor(spec, questions) {
  /** @type {Record<string, string | undefined>} */
  const map = {}
  for (const id of Object.keys(questions)) {
    if (spec.capabilities === undefined) map[id] = undefined
    else if (typeof spec.capabilities === 'string') map[id] = spec.capabilities
    else map[id] = spec.capabilities[id]
  }
  return map
}

/**
 * What the engine decided for one call.
 *
 * @typedef {object} Decision
 * @property {string} pointId
 * @property {number} version
 * @property {import('./contract.js').Mode} mode
 * @property {unknown} outcome What the caller must act on.
 * @property {'judge' | 'fallback'} source
 * @property {string} [reason] Why the fallback stood.
 * @property {unknown} [judged] What the judge produced, when it was not acted on.
 * @property {Record<string, import('./contract.js').Answer>} [answers]
 * @property {number} latencyMs
 * @property {import('./contract.js').JudgeUsage} [usage]
 * @property {import('./cascade.js').TierReport[]} [tiers]
 * @property {import('./contract.js').JudgeWarning[]} [warnings]
 * @property {string} [ledgerId]
 */

/**
 * Counters a deployment can report without reading the ledger.
 *
 * @typedef {object} EngineStats
 * @property {number} decisions
 * @property {number} judgeCalls
 * @property {number} failures
 * @property {number} abstentions
 * @property {number} fallbacks
 */

/**
 * Create the engine.
 *
 * @param {object} options
 * @param {Record<string, {id: string, evaluate: Function, capabilities?: readonly string[]}>} [options.judges]
 *   Named judges, as the configuration declares them.
 * @param {readonly string[]} [options.tiers] Judge names to try, in order.
 * @param {Record<string, readonly string[]>} [options.routes] Per decision point judge names.
 * @param {Record<string, string>} [options.modes] `default` plus per point overrides.
 * @param {Partial<import('./policy.js').UncertaintyBand>} [options.band]
 * @param {number} [options.timeoutMs] Per decision budget; defaults to 3000 for inline, 10000 otherwise.
 * @param {{append: Function}} [options.ledger]
 * @param {() => number} [options.now]
 * @returns {object} The engine: `decide`, `decideMany`, `mode`, `stats`.
 */
export function createEngine(options = {}) {
  const judges = options.judges ?? {}
  const defaultTiers = options.tiers ?? Object.keys(judges)
  const routes = options.routes ?? {}
  const modes = options.modes ?? {}
  const band = normalizeBand(options.band)
  const ledger = options.ledger ?? null
  const now = options.now ?? (() => Date.now())

  const stats = {
    decisions: 0,
    judgeCalls: 0,
    failures: 0,
    abstentions: 0,
    fallbacks: 0,
  }

  /**
   * The mode a point runs in. An unconfigured point is `shadow`: a verdict has
   * to earn the right to act, and a fresh install records before it changes
   * anything.
   *
   * @param {string} pointId
   * @returns {import('./contract.js').Mode}
   */
  function modeFor(pointId) {
    const configured = modes[pointId] ?? modes.default ?? 'shadow'
    return MODES.includes(configured) ? configured : 'shadow'
  }

  /**
   * Resolve the ordered judges for one point.
   *
   * @param {string} pointId
   * @returns {object[]}
   */
  function tiersFor(pointId) {
    const names = routes[pointId] ?? defaultTiers
    const resolved = []
    for (const name of names ?? []) {
      const judge = judges[name]
      if (judge !== undefined) resolved.push(judge)
    }
    return resolved
  }

  /**
   * The budget for one point, from its latency class unless configured.
   *
   * @param {DecisionSpec} spec
   * @returns {number}
   */
  function budgetFor(spec) {
    if (Number.isFinite(options.timeoutMs)) return options.timeoutMs
    return spec.latency === 'inline' ? 3000 : 10_000
  }

  /**
   * Record one decision.
   *
   * @param {object} entry
   * @returns {string | undefined} The ledger record id.
   */
  function record(entry) {
    if (ledger === null) return undefined
    try {
      const stored = ledger.append(entry)
      return stored?.id
    } catch {
      // The ledger must never be the reason a decision fails.
      return undefined
    }
  }

  /**
   * Run one decision point.
   *
   * @param {DecisionSpec} spec
   * @param {any} input
   * @param {{mode?: import('./contract.js').Mode, subject?: Record<string, unknown>}} [overrides]
   * @returns {Promise<Decision>}
   */
  async function decide(spec, input, overrides = {}) {
    const mode = overrides.mode ?? modeFor(spec.id)
    const startedAt = now()

    if (mode === 'off') {
      // Nothing is asked and nothing is recorded: an off point is absent.
      return {
        pointId: spec.id,
        version: spec.version,
        mode,
        outcome: safeFallback(spec, input),
        source: 'fallback',
        reason: 'off',
        latencyMs: now() - startedAt,
      }
    }

    stats.decisions += 1
    const questions = questionsFor(spec, input)
    const state = spec.buildState(input)
    const result = await runTiers(spec, questions, state, budgetFor(spec), capabilitiesFor(spec, questions))

    const decision = {
      pointId: spec.id,
      version: spec.version,
      mode,
      latencyMs: now() - startedAt,
      ...(result.answers !== undefined && Object.keys(result.answers).length > 0
        ? { answers: result.answers }
        : {}),
      ...(result.usage ? { usage: result.usage } : {}),
      ...(result.tiers.length > 0 ? { tiers: result.tiers } : {}),
      ...(result.warnings.length > 0 ? { warnings: result.warnings } : {}),
    }

    /** @type {unknown} */
    let judged
    /** @type {string | undefined} */
    let reason = result.reason
    if (reason === undefined && Object.keys(result.answers ?? {}).length > 0) {
      try {
        const verdict = spec.policy(result.answers, input)
        if (verdict === ABSTAIN) {
          stats.abstentions += 1
          reason = 'abstain'
        } else {
          judged = verdict
        }
      } catch (error) {
        reason = `policy-error: ${error instanceof Error ? error.message : 'unknown'}`
      }
    }

    const acts = mode === 'active' && judged !== undefined && reason === undefined
    const outcome = acts ? judged : safeFallback(spec, input)
    if (!acts) stats.fallbacks += 1

    const ledgerId = record({
      point: spec.id,
      version: spec.version,
      mode,
      source: acts ? 'judge' : 'fallback',
      outcome,
      ...(acts ? {} : { reason: reason ?? 'no-verdict' }),
      ...(judged !== undefined && !acts ? { judged } : {}),
      ...(decision.answers ? { answers: decision.answers } : {}),
      ...(decision.usage ? { usage: decision.usage } : {}),
      ...(decision.tiers ? { tiers: decision.tiers } : {}),
      ...(decision.warnings ? { warnings: decision.warnings } : {}),
      ...(overrides.subject ? { subject: overrides.subject } : {}),
      latencyMs: decision.latencyMs,
      state,
    })

    return {
      ...decision,
      outcome,
      source: acts ? 'judge' : 'fallback',
      ...(acts ? {} : { reason: reason ?? 'no-verdict' }),
      ...(judged !== undefined && !acts ? { judged } : {}),
      ...(ledgerId ? { ledgerId } : {}),
    }
  }

  /**
   * Ask the tiers, bounded by the point's budget. A spent budget is a reason,
   * not an exception.
   *
   * @param {DecisionSpec} spec
   * @param {Record<string, import('./contract.js').Question>} questions
   * @param {import('./contract.js').JudgeInput} state
   * @param {number} budgetMs
   * @param {Record<string, string | undefined>} capabilities
   * @returns {Promise<{answers?: Record<string, import('./contract.js').Answer>, tiers: any[], warnings: any[], usage?: any, reason?: string}>}
   */
  async function runTiers(spec, questions, state, budgetMs, capabilities) {
    const tiers = tiersFor(spec.id)
    if (tiers.length === 0) {
      return { tiers: [], warnings: [], reason: 'no-judge-configured' }
    }
    const controller = new AbortController()
    const pending = runCascade(tiers, {
      state,
      questions,
      capabilities,
      band,
      signal: controller.signal,
    }).then(
      (value) => ({ kind: 'value', value }),
      (error) => ({ kind: 'error', error: toJudgeError(error, { service: 'judge' }) }),
    )

    stats.judgeCalls += 1
    const raced = await within(pending, budgetMs, { fallback: null })
    controller.abort()
    if (raced === null) {
      stats.failures += 1
      return { tiers: [], warnings: [], reason: `timeout after ${budgetMs}ms` }
    }
    if (raced.kind === 'error') {
      stats.failures += 1
      return { tiers: [], warnings: [], reason: `${raced.error.kind}: ${raced.error.message}` }
    }
    const value = raced.value
    if (value.error !== undefined) stats.failures += 1
    const reason =
      value.error !== undefined
        ? `${value.error.kind}: ${value.error.message}`
        : Object.keys(value.answers).length === 0
          ? 'no-answer'
          : undefined
    return { ...value, ...(reason ? { reason } : {}) }
  }

  /**
   * A fallback that cannot itself break the loop: if a point's own fallback
   * throws, the error is the answer and the caller still gets a value.
   *
   * @param {DecisionSpec} spec
   * @param {unknown} input
   * @returns {unknown}
   */
  function safeFallback(spec, input) {
    try {
      return spec.fallback(input)
    } catch (error) {
      stats.failures += 1
      return {
        error: 'fallback-failed',
        message: error instanceof Error ? error.message : 'unknown',
      }
    }
  }

  /**
   * Run several decision points, asking the judge once per distinct state.
   *
   * Points that are asked about the same state share one request: their
   * questions are merged under prefixed ids, and each point's own policy is
   * applied to its own answers afterwards. That is the point of batching — the
   * state is billed once.
   *
   * @param {{spec: DecisionSpec, input: any, subject?: Record<string, unknown>}[]} entries
   * @returns {Promise<Decision[]>}
   */
  async function decideMany(entries) {
    /** @type {Map<string, {state: import('./contract.js').JudgeInput, entries: {spec: DecisionSpec, input: any, subject?: Record<string, unknown>, index: number, questions: Record<string, import('./contract.js').Question>}[], questions: Record<string, import('./contract.js').Question>, capabilities: Record<string, string | undefined>}>} */
    const groups = new Map()

    for (const [index, entry] of entries.entries()) {
      const mode = modeFor(entry.spec.id)
      const state = entry.spec.buildState(entry.input)
      // Points share a request only when they ask about the same state *and*
      // resolve to the same judges: a per-point route must still pick its own
      // judge, batching or not.
      const tierKey = tiersFor(entry.spec.id)
        .map((judge) => judge.id)
        .join(',')
      const key = `${mode}|${tierKey}|${JSON.stringify(state)}`
      let group = groups.get(key)
      if (group === undefined) {
        group = { state, entries: [], questions: {}, capabilities: {} }
        groups.set(key, group)
      }
      // An off point contributes no question, so it can never pull a neighbour
      // into a request the neighbour would not have made on its own.
      const questions = mode === 'off' ? {} : questionsFor(entry.spec, entry.input)
      group.entries.push({ ...entry, index, questions })
      const capabilities = capabilitiesFor(entry.spec, questions)
      for (const [questionId, question] of Object.entries(questions)) {
        group.questions[`${index}:${questionId}`] = question
        group.capabilities[`${index}:${questionId}`] = capabilities[questionId]
      }
    }

    /** @type {Decision[]} */
    const results = new Array(entries.length)
    for (const group of groups.values()) {
      const budgetMs = Math.max(...group.entries.map((entry) => budgetFor(entry.spec)))
      const shared =
        group.entries.length > 1 && Object.keys(group.questions).length > 0
          ? await runTiers(
              group.entries[0].spec,
              group.questions,
              group.state,
              budgetMs,
              group.capabilities,
            )
          : undefined

      for (const entry of group.entries) {
        const mode = modeFor(entry.spec.id)
        const startedAt = now()
        stats.decisions += 1
        if (mode === 'off') {
          results[entry.index] = {
            pointId: entry.spec.id,
            version: entry.spec.version,
            mode,
            outcome: safeFallback(entry.spec, entry.input),
            source: 'fallback',
            reason: 'off',
            latencyMs: 0,
          }
          continue
        }

        /** @type {Record<string, import('./contract.js').Answer> | undefined} */
        let answers
        let tiers
        let usage
        let warnings
        let reason
        if (shared !== undefined) {
          answers = {}
          const prefix = `${entry.index}:`
          for (const [id, answer] of Object.entries(shared.answers ?? {})) {
            if (id.startsWith(prefix)) answers[id.slice(prefix.length)] = answer
          }
          tiers = shared.tiers
          usage = shared.usage
          warnings = shared.warnings
          reason = shared.reason
        } else {
          const single = await runTiers(
            entry.spec,
            entry.questions,
            group.state,
            budgetMs,
            capabilitiesFor(entry.spec, entry.questions),
          )
          answers = single.answers
          tiers = single.tiers
          usage = single.usage
          warnings = single.warnings
          reason = single.reason
        }

        /** @type {unknown} */
        let judged
        let fallbackReason = reason
        if (
          fallbackReason === undefined &&
          answers !== undefined &&
          Object.keys(answers).length > 0
        ) {
          try {
            const verdict = entry.spec.policy(answers, entry.input)
            if (verdict === ABSTAIN) {
              stats.abstentions += 1
              fallbackReason = 'abstain'
            } else {
              judged = verdict
            }
          } catch (error) {
            fallbackReason = `policy-error: ${error instanceof Error ? error.message : 'unknown'}`
          }
        }
        const acts = mode === 'active' && judged !== undefined && fallbackReason === undefined
        if (!acts) stats.fallbacks += 1
        const outcome = acts ? judged : safeFallback(entry.spec, entry.input)
        const latencyMs = now() - startedAt
        const ledgerId = record({
          point: entry.spec.id,
          version: entry.spec.version,
          mode,
          source: acts ? 'judge' : 'fallback',
          outcome,
          ...(acts ? {} : { reason: fallbackReason ?? 'no-verdict' }),
          ...(judged !== undefined && !acts ? { judged } : {}),
          ...(answers && Object.keys(answers).length > 0 ? { answers } : {}),
          ...(usage ? { usage } : {}),
          ...(tiers && tiers.length > 0 ? { tiers } : {}),
          ...(warnings && warnings.length > 0 ? { warnings } : {}),
          ...(entry.subject ? { subject: entry.subject } : {}),
          latencyMs,
          state: group.state,
        })

        results[entry.index] = {
          pointId: entry.spec.id,
          version: entry.spec.version,
          mode,
          outcome,
          source: acts ? 'judge' : 'fallback',
          ...(acts ? {} : { reason: fallbackReason ?? 'no-verdict' }),
          ...(judged !== undefined && !acts ? { judged } : {}),
          ...(answers && Object.keys(answers).length > 0 ? { answers } : {}),
          ...(usage ? { usage } : {}),
          ...(tiers && tiers.length > 0 ? { tiers } : {}),
          ...(warnings && warnings.length > 0 ? { warnings } : {}),
          ...(ledgerId ? { ledgerId } : {}),
          latencyMs,
        }
      }
    }
    return results
  }

  return {
    decide,
    decideMany,
    mode: modeFor,
    judges,
    tiers: defaultTiers,
    band,
    /** @returns {EngineStats} */
    stats: () => ({ ...stats }),
  }
}
