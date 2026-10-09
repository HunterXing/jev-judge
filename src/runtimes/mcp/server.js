/**
 * The Model Context Protocol face of the kernel.
 *
 * MCP is how this reaches agents that this project does not build a plugin for:
 * any client that speaks stdio JSON-RPC gets the same three capabilities — judge
 * many items at once, ask typed questions about a state, read what was already
 * decided. The kernel itself stays host-free; this module is the only part that
 * knows about a wire protocol.
 *
 * The transport is one JSON-RPC message per line, as MCP's stdio transport
 * specifies. stdout carries protocol messages only: a stray `console.log` here
 * would corrupt the stream, so diagnostics go to stderr.
 *
 * @module dsh-jev-judge/runtimes/mcp
 */

import { VERSION } from '../../meta.js'
import { defineDecision } from '../../kernel/decision.js'
import { isJudgeError } from '../../kernel/errors.js'
import { maxItemsFrom, runItemsJudgment } from '../../decisions/judge-items.js'
import { createJudgeRuntime } from '../../kernel/registry.js'

/** The protocol revision used when a client does not name one. */
export const DEFAULT_PROTOCOL_VERSION = '2024-11-05'

/** JSON-RPC error codes this server produces. */
export const ERROR_CODES = Object.freeze({
  parse: -32700,
  invalidRequest: -32600,
  methodNotFound: -32601,
  invalidParams: -32602,
  internal: -32603,
})

/**
 * The tools this server offers, with the schemas a client reads to build calls.
 *
 * `judge_items` is the one that pays for itself: one call, many candidates, and
 * only the selected ones ever need to be read.
 */
export const TOOLS = Object.freeze([
  {
    name: 'judge_items',
    description:
      'Ask one yes/no question about many items at once and get a probability for each. ' +
      'Use it when a task means sorting, filtering or screening a list — log lines, files, ' +
      'findings, passages — and reading every item would cost more than the judgment. ' +
      'The question must have a single predicate; put the items in `items` and the task in `task`. ' +
      'Read only the items whose `selected` is true.',
    inputSchema: {
      type: 'object',
      properties: {
        question: {
          type: 'object',
          description: 'The single yes/no question asked of every item.',
          properties: {
            instructions: {
              type: 'string',
              description: 'One predicate, e.g. "Does this passage mention the failing request?"',
            },
            criteria: {
              type: 'object',
              description: 'Optional examples for the true and false cases.',
              properties: { true: {}, false: {} },
              additionalProperties: false,
            },
          },
          required: ['instructions'],
          additionalProperties: false,
        },
        items: {
          type: 'array',
          description: 'The candidates, each with a stable id and its text.',
          items: {
            type: 'object',
            properties: { id: { type: 'string' }, text: { type: 'string' } },
            required: ['text'],
            additionalProperties: false,
          },
        },
        task: {
          type: 'string',
          description: 'What the work is about; the judge reads it alongside each item.',
        },
      },
      required: ['question', 'items'],
      additionalProperties: false,
    },
  },
  {
    name: 'judge_ask',
    description:
      'Ask typed questions about one state: yes/no (a probability), choice (one of a named set), ' +
      'or score (a position on an ordered rubric). Use it instead of asking a chat model to return ' +
      'JSON: the answer is a probability, not prose to parse.',
    inputSchema: {
      type: 'object',
      properties: {
        state: {
          description: 'The small state the judge reads. A string, object or array.',
          anyOf: [{ type: 'string' }, { type: 'object' }, { type: 'array' }],
        },
        questions: {
          type: 'object',
          description:
            'Question id to question. A boolean question is {type:"boolean",instructions}; ' +
            'a choice question adds a non-empty `criteria` option map and must include an ' +
            'escape option such as `other`; a score question adds `criteria` as ordered levels.',
        },
      },
      required: ['state', 'questions'],
      additionalProperties: false,
    },
  },
  {
    name: 'judge_ledger',
    description:
      'Read the most recent decisions: which decision point ran, whether a judge or the fallback ' +
      'answered, the probabilities and the latency. Use it to find out why part of a result was ' +
      'condensed or withheld instead of guessing that a tool failed.',
    inputSchema: {
      type: 'object',
      properties: {
        limit: {
          type: 'integer',
          description: 'How many recent records to return (default 20, 0 for every record).',
        },
      },
      additionalProperties: false,
    },
  },
])

/**
 * Wrap one value as an MCP tool result.
 *
 * @param {unknown} value
 * @param {{isError?: boolean}} [options]
 * @returns {{content: {type: 'text', text: string}[], isError?: true}}
 */
function toolResult(value, options = {}) {
  const result = { content: [{ type: 'text', text: JSON.stringify(value, null, 2) }] }
  return options.isError ? { ...result, isError: true } : result
}

/**
 * The message a caller gets when no judge can answer, so a tool never silently
 * pretends that "nothing matched" is a verdict.
 *
 * @param {string[]} problems
 * @returns {string}
 */
function unavailableNote(problems) {
  const detail = problems.length > 0 ? ` (${problems[0]})` : ''
  return `No judge is available${detail}. Judge the items yourself, or fix the provider configuration with "jev-judge doctor".`
}

/**
 * Build the request handlers around one kernel runtime.
 *
 * @param {object} [options]
 * @param {ReturnType<typeof createJudgeRuntime>} [options.runtime]
 * @returns {{handle: (message: unknown) => Promise<object | null>, runtime: object}}
 */
export function createMcpServer(options = {}) {
  const runtime = options.runtime ?? createJudgeRuntime()

  /**
   * Run one decision point in `active` mode: a client that asks for a judgment
   * is asking for it now, whatever the configured mode says.
   */
  async function judge(spec, input) {
    return runtime.engine.decide(spec, input, { mode: 'active' })
  }

  /** @type {Record<string, (args: Record<string, unknown>) => Promise<object>>} */
  const tools = {
    async judge_items(args) {
      const question = args.question
      const items = args.items
      if (typeof question !== 'object' || question === null || !Array.isArray(items)) {
        return toolResult({ error: 'judge_items needs `question` (an object) and `items` (an array).' }, { isError: true })
      }
      if (runtime.judgeNames.length === 0) {
        return toolResult({ unavailable: true, note: unavailableNote(runtime.problems), selected: [], items: [] })
      }

      const outcome = await runItemsJudgment({
        engine: runtime.engine,
        input: { task: typeof args.task === 'string' ? args.task : '', question, items },
        maxItems: maxItemsFrom(runtime.kernel.options),
      })
      return toolResult(outcome)
    },

    async judge_ask(args) {
      if (typeof args.questions !== 'object' || args.questions === null) {
        return toolResult({ error: 'judge_ask needs `questions` (an object keyed by question id).' }, { isError: true })
      }
      if (args.state === undefined) {
        return toolResult({ error: 'judge_ask needs `state`.' }, { isError: true })
      }

      // The same contract as every shipped decision point: a question that could
      // not be answered (an option set with no escape, a score with one level)
      // is rejected here rather than sent and silently dropped.
      let spec
      try {
        spec = defineDecision({
          id: 'mcp.judge_ask',
          version: 1,
          questions: args.questions,
          cacheImpact: 'none',
          latency: 'inline',
          buildState: () => args.state,
          policy: (answers) => answers,
          fallback: () => ({}),
        })
      } catch (error) {
        return toolResult(
          { error: error instanceof Error ? error.message : 'invalid questions' },
          { isError: true },
        )
      }
      if (runtime.judgeNames.length === 0) {
        return toolResult({ answers: {}, unavailable: true, note: unavailableNote(runtime.problems) })
      }

      const decision = await judge(spec, undefined)
      return toolResult({
        answers: decision.answers ?? {},
        source: decision.source,
        ...(decision.reason ? { reason: decision.reason } : {}),
        latencyMs: decision.latencyMs,
        ...(decision.usage ? { usage: decision.usage } : {}),
      })
    },

    async judge_ledger(args) {
      const ledger = runtime.ledger
      const limit = Number.isInteger(args.limit) ? Number(args.limit) : 20
      if (ledger === null) {
        return toolResult({ path: null, records: [], note: 'No ledger is configured.' })
      }
      return toolResult({ path: runtime.kernel.ledger.path ?? null, records: ledger.read({ limit }) })
    },
  }

  /**
   * Handle one protocol message. Returns `null` for a notification, which must
   * not be answered.
   *
   * @param {unknown} message
   * @returns {Promise<object | null>}
   */
  async function handle(message) {
    if (typeof message !== 'object' || message === null || Array.isArray(message)) {
      return errorResponse(null, ERROR_CODES.invalidRequest, 'message must be a JSON object')
    }
    const { id, method, params } = /** @type {Record<string, unknown>} */ (message)
    const notification = id === undefined || id === null

    try {
      if (method === 'initialize') {
        const requested = /** @type {Record<string, unknown>} */ (params ?? {}).protocolVersion
        return notification
          ? null
          : {
              jsonrpc: '2.0',
              id,
              result: {
                protocolVersion:
                  typeof requested === 'string' && requested !== ''
                    ? requested
                    : DEFAULT_PROTOCOL_VERSION,
                capabilities: { tools: {} },
                serverInfo: { name: 'dsh-jev-judge', version: VERSION },
              },
            }
      }
      if (method === 'notifications/initialized' || method === 'notifications/cancelled') {
        return null
      }
      if (method === 'ping') {
        return notification ? null : { jsonrpc: '2.0', id, result: {} }
      }
      if (method === 'tools/list') {
        return notification
          ? null
          : {
              jsonrpc: '2.0',
              id,
              result: {
                tools: TOOLS.map((tool) => ({
                  name: tool.name,
                  description: tool.description,
                  inputSchema: tool.inputSchema,
                })),
              },
            }
      }
      if (method === 'tools/call') {
        const call = /** @type {Record<string, unknown>} */ (params ?? {})
        const name = String(call.name ?? '')
        const tool = tools[name]
        if (tool === undefined) {
          return notification
            ? null
            : errorResponse(id, ERROR_CODES.invalidParams, `unknown tool "${name}"`)
        }
        const args = typeof call.arguments === 'object' && call.arguments !== null
          ? /** @type {Record<string, unknown>} */ (call.arguments)
          : {}
        const result = await tool(args)
        return notification ? null : { jsonrpc: '2.0', id, result }
      }
      return notification
        ? null
        : errorResponse(id, ERROR_CODES.methodNotFound, `unknown method "${String(method)}"`)
    } catch (error) {
      // A judge failure is already a fallback inside the kernel; reaching here
      // means something else went wrong, and the client still needs an answer.
      const detail = isJudgeError(error) ? `${error.kind}: ${error.message}` : 'internal error'
      return notification ? null : errorResponse(id, ERROR_CODES.internal, detail)
    }
  }

  return { handle, runtime }
}

/**
 * Build one JSON-RPC error response.
 *
 * @param {unknown} id
 * @param {number} code
 * @param {string} message
 * @returns {object}
 */
export function errorResponse(id, code, message) {
  return { jsonrpc: '2.0', id: id ?? null, error: { code, message } }
}

/**
 * Serve the kernel over stdio until the input ends.
 *
 * @param {object} [options]
 * @param {ReturnType<typeof createJudgeRuntime>} [options.runtime]
 * @param {NodeJS.ReadableStream} [options.stdin]
 * @param {NodeJS.WritableStream} [options.stdout]
 * @param {NodeJS.WritableStream} [options.stderr]
 * @returns {Promise<void>}
 */
export async function serveStdio(options = {}) {
  const stdin = options.stdin ?? process.stdin
  const stdout = options.stdout ?? process.stdout
  const stderr = options.stderr ?? process.stderr
  const server = createMcpServer({ runtime: options.runtime ?? createJudgeRuntime() })

  let buffer = ''
  /** Serialize handling so responses keep the order the client sent. */
  let queue = Promise.resolve()

  /**
   * @param {string} line
   * @returns {void}
   */
  const dispatch = (line) => {
    const text = line.trim()
    if (text === '') return
    let message
    try {
      message = JSON.parse(text)
    } catch {
      queue = queue.then(() => {
        stdout.write(`${JSON.stringify(errorResponse(null, ERROR_CODES.parse, 'invalid JSON'))}\n`)
      })
      return
    }
    queue = queue.then(async () => {
      const response = await server.handle(message)
      if (response !== null) stdout.write(`${JSON.stringify(response)}\n`)
    })
  }

  for await (const chunk of stdin) {
    buffer += String(chunk)
    let newline = buffer.indexOf('\n')
    while (newline !== -1) {
      dispatch(buffer.slice(0, newline))
      buffer = buffer.slice(newline + 1)
      newline = buffer.indexOf('\n')
    }
  }
  dispatch(buffer)
  await queue
  stderr.write('jev-judge: mcp server stopped (input closed)\n')
}
