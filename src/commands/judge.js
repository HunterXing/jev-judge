/**
 * `jev-judge judge` — ask a typed question from a shell, a hook or a script.
 *
 * This is the primitive the adapters are built on: one state, one map of bounded
 * questions, answers with probabilities. It is also what makes the kernel usable
 * from an agent that has neither an MCP client nor a hook config — any tool that
 * can run a command can ask a typed question.
 *
 * Answered questions exit 0; a judge that answered nothing exits 1, so a script
 * can tell "the answer was no" from "there was no answer".
 *
 * @module dsh-jev-judge/commands/judge
 */

import { validateQuestions } from '../kernel/contract.js'
import { createJudgeRuntime } from '../kernel/registry.js'
import { fail, out, parse, parseJson, readStateText } from './support.js'

/**
 * Render one answer for a human.
 *
 * @param {string} id
 * @param {Record<string, unknown>} answer
 * @returns {string}
 */
function render(id, answer) {
  const confidence = answer.confidence === undefined ? '' : ` confidence=${answer.confidence}`
  if (answer.type === 'boolean') return `${id}: ${answer.probability.toFixed(4)}${confidence}`
  if (answer.type === 'choice') {
    const distribution = answer.probabilities
      ? ` [${Object.entries(answer.probabilities)
          .map(([option, probability]) => `${option}=${Number(probability).toFixed(3)}`)
          .join(' ')}]`
      : ''
    return `${id}: ${answer.choice}${distribution}${confidence}`
  }
  return `${id}: ${answer.score}${confidence}`
}

/** @type {import('../cli.js').Command} */
export const command = {
  summary: 'Ask typed questions about one state and print the answers.',
  usage: `judge — ask typed questions about one state and print the answers.

Options:
  --question <json>       The questions, as JSON. Read from stdin when omitted.
  --question-file <path>  Read the questions from a file ("-" for stdin).
  --state <json>          The state the questions are about.
  --state-file <path>     Read the state from a file ("-" for stdin).
  --json                  Print the answers as JSON.
  --mode <mode>           active (default), shadow, or off.`,
  async run(argv) {
    const { values } = parse(argv, {
      question: { type: 'string' },
      'question-file': { type: 'string' },
      state: { type: 'string' },
      'state-file': { type: 'string' },
      json: { type: 'boolean' },
      mode: { type: 'string' },
    })

    // Questions come from `--question`, `--question-file`, or stdin; the state
    // comes from `--state`/`--state-file`. Only one of the two may use stdin.
    const questionsText = values.question
      ? String(values.question)
      : values['question-file']
        ? readStateText({ 'state-file': values['question-file'] })
        : readStateText({ 'state-file': '-' })
    const questions = parseJson(questionsText, 'the questions')
    validateQuestions(questions)

    const hasState = Boolean(values.state) || Boolean(values['state-file'])
    const stateText = hasState ? readStateText(values) : ''
    const state = stateText.trim() === '' ? '' : parseJson(stateText, 'the state')

    const runtime = createJudgeRuntime()
    if (runtime.problems.length > 0 && runtime.judgeNames.length === 0) {
      for (const problem of runtime.problems) fail(`problem: ${problem}`)
      return 1
    }

    const spec = {
      id: 'cli.judge',
      version: 1,
      questions,
      cacheImpact: 'none',
      latency: 'inline',
      buildState: () => state,
      policy: (answers) => answers,
      fallback: () => ({}),
    }

    const decision = await runtime.engine.decide(spec, undefined, {
      mode: values.mode === 'shadow' || values.mode === 'off' ? String(values.mode) : 'active',
    })
    const answers = decision.answers ?? {}

    if (values.json) {
      out(
        JSON.stringify(
          {
            answers,
            source: decision.source,
            ...(decision.reason ? { reason: decision.reason } : {}),
            latencyMs: decision.latencyMs,
            ...(decision.usage ? { usage: decision.usage } : {}),
            tiers: decision.tiers ?? [],
          },
          null,
          2,
        ),
      )
    } else {
      for (const [id, answer] of Object.entries(answers)) out(render(id, answer))
      for (const tier of decision.tiers ?? []) {
        const detail = tier.errorKind ? `failed (${tier.errorKind}: ${tier.errorMessage})` : `${tier.answered.length} answered`
        out(`[${tier.id}] ${tier.latencyMs}ms ${detail}`)
      }
      if (Object.keys(answers).length === 0) fail(`no answer: ${decision.reason ?? 'unknown reason'}`)
    }

    return Object.keys(answers).length > 0 ? 0 : 1
  },
}
