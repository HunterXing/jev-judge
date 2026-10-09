/**
 * The `judge_items` tool as DeepSeek Harness sees it.
 *
 * The definition is a plain JSON-Schema tool: this package imports nothing from
 * the harness at runtime, so the registry validates the model's arguments
 * against the schema declared here and this module owns everything after that.
 *
 * @module dsh-jev-judge/runtimes/dsh/tool
 */

import { prepareItems, maxItemsFrom, runItemsJudgment } from '../../decisions/judge-items.js'

/** The tool name the model calls. */
export const TOOL_NAME = 'judge_items'

/** What the model reads before deciding to call it. */
export const TOOL_DESCRIPTION =
  'Ask one yes/no question about many items at once and get a probability for each. ' +
  'Use it when a task means sorting, filtering or screening a list — log lines, files, findings, ' +
  'passages — and reading every item would cost more than the judgment. ' +
  'Ask one predicate per call; split compound questions and combine the answers yourself. ' +
  'Read only the items whose `selected` is true.'

/** The argument schema, in the JSON Schema subset the registry validates. */
export const TOOL_PARAMETERS = {
  type: 'object',
  additionalProperties: false,
  required: ['question', 'items'],
  properties: {
    question: {
      type: 'object',
      additionalProperties: false,
      required: ['instructions'],
      description: 'The single yes/no question asked of every item.',
      properties: {
        instructions: {
          type: 'string',
          description: 'One predicate, e.g. "Does this passage mention the failing request?"',
        },
        criteria: {
          type: 'object',
          additionalProperties: false,
          description: 'Optional examples for the true and false cases.',
          properties: { true: {}, false: {} },
        },
      },
    },
    items: {
      type: 'array',
      description: 'The candidates, each with a stable id and its text.',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['text'],
        properties: { id: { type: 'string' }, text: { type: 'string' } },
      },
    },
    task: {
      type: 'string',
      description: 'What the work is about; the judge reads it alongside each item.',
    },
  },
}

/** The canonical value the tool returns, so a caller can rely on its fields. */
export const TOOL_OUTPUT_SCHEMA = {
  type: 'object',
  additionalProperties: true,
  properties: {
    selected: { type: 'array', items: { type: 'string' } },
    items: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: true,
        properties: {
          id: { type: 'string' },
          // The harness's schema subset has no type arrays, so a field that can
          // be null is expressed as an exact-one union.
          probability: { oneOf: [{ type: 'number' }, { type: 'null' }] },
          selected: { type: 'boolean' },
          truncated: { type: 'boolean' },
        },
      },
    },
    unavailable: { type: 'boolean' },
    note: { type: 'string' },
    reason: { type: 'string' },
    latencyMs: { type: 'number' },
  },
}

/**
 * Build the tool definition for one kernel runtime.
 *
 * @param {object} runtime The runtime from `createJudgeRuntime`.
 * @returns {object} A `ToolDefinition` the harness registry accepts.
 */
export function createJudgeItemsTool(runtime) {
  return {
    name: TOOL_NAME,
    description: TOOL_DESCRIPTION,
    parameters: TOOL_PARAMETERS,
    output: {
      schema: TOOL_OUTPUT_SCHEMA,
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
    },

    /**
     * @param {{question: {instructions: string, criteria?: unknown}, items: {id?: string, text: string}[], task?: string}} args
     * @param {{signal: AbortSignal}} exec
     * @returns {Promise<object>}
     */
    async execute(args, exec) {
      if (runtime.judgeNames.length === 0) {
        const detail = runtime.problems.length > 0 ? ` (${runtime.problems[0]})` : ''
        return {
          selected: [],
          items: [],
          unavailable: true,
          note:
            `No judge is available${detail}. Judge the items yourself, or check the plugin ` +
            'configuration with `jev-judge doctor`.',
        }
      }

      // A call the model made on purpose is a request to judge now, whatever the
      // configured mode says; every other point still earns its mode first. A
      // list longer than one request is split, and the verdicts are merged.
      const outcome = await runItemsJudgment({
        engine: runtime.engine,
        input: { task: args.task ?? '', question: args.question, items: args.items },
        maxItems: maxItemsFrom(runtime.kernel.options),
      })

      const prepared = prepareItems(args.items ?? [])
      return {
        ...outcome,
        ...(prepared.truncated > 0
          ? { note: `${prepared.truncated} item(s) were truncated before judging.` }
          : {}),
      }
    },
  }
}
