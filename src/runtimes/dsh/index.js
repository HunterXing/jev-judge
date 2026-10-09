/**
 * The DeepSeek Harness face of the judgment kernel.
 *
 * This module is the plugin row target of `cordis.patch.yml`, loaded by the
 * harness Loader by package subpath (`dsh-jev-judge/host`). It imports nothing
 * from the harness at runtime: the extension points arrive through the `ctx` it
 * is handed, which keeps the package loadable from a plain checkout with no
 * build step and no peer resolution.
 *
 * Every listener here follows the same rule — the kernel may fall back, but this
 * plugin may not fail. A judgment that cannot be made leaves the harness exactly
 * as it was, and an unexpected error is logged and skipped rather than thrown
 * into a turn.
 *
 * @module dsh-jev-judge/host
 */

import { randomUUID } from 'node:crypto'
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

import { admissionNote, shouldJudge, toolAdmission } from '../../decisions/tool-admission.js'
import { memoryCapture, toLesson } from '../../decisions/memory-capture.js'
import { toolInjection } from '../../decisions/tool-injection.js'
import { completionNudge, turnCompletion } from '../../decisions/turn-completion.js'
import { announcedIrreversibleStep, continuationNudge, turnContinue } from '../../decisions/turn-continue.js'
import { looksRisky, toolRisk } from '../../decisions/tool-risk.js'
import { createJudgeRuntime } from '../../kernel/registry.js'
import { createJudgeItemsTool } from './tool.js'

/** Plugin name as the Loader sees it. */
export const name = 'jev-judge'

/** The one service this plugin needs from the composition. */
export const inject = ['tools']

/** Tools whose result came from outside the machine, and is therefore screened. */
const EXTERNAL_TOOL_HINT = /^(?:mcp|mcp__|web_fetch|web_search|fetch|browser)/i

/** How much of a tool result is kept in memory while deciding about the turn. */
const MAX_TRACKED_TEXT = 4000

/** How many commands one turn remembers, for the completion check. */
const MAX_TRACKED_COMMANDS = 40

/** Nudges allowed per turn, mirroring the decision points' own discipline. */
const NUDGE_BUDGET = Object.freeze({ completion: 1, continuation: 2 })

/**
 * Mount the kernel for one profile.
 *
 * @param {object} ctx The Cordis context of this plugin's fiber.
 * @param {unknown} config The row's `config` object from the patch layer.
 * @returns {void}
 */
export function apply(ctx, config) {
  const settings = readSettings(config, ctx)
  const runtime = createJudgeRuntime({ overrides: settings.overrides })

  for (const problem of runtime.problems) warn(ctx, problem)
  if (runtime.judgeNames.length === 0) {
    warn(ctx, 'no judge is configured; every decision point will return its fallback')
  }

  /** Per-agent turn state: what the user asked, what the model said, what ran. */
  const turns = new Map()
  const turnState = (agent) => {
    const key = String(agent?.id ?? 'unknown')
    let state = turns.get(key)
    if (state === undefined) {
      state = { user: '', assistant: '', commands: [], nudges: { completion: 0, continuation: 0 } }
      turns.set(key, state)
    }
    return state
  }

  ctx.tools.register(createJudgeItemsTool(runtime))

  ctx.on('agent/inbox/claimed', ({ agent, message }) => {
    // A new turn starts with a clean slate: the previous turn's text must never
    // be judged as if it were this one's.
    const state = turnState(agent)
    state.user = textOfContent(message?.content).slice(0, MAX_TRACKED_TEXT)
    state.assistant = ''
    state.commands = []
    state.nudges = { completion: 0, continuation: 0 }
  })

  ctx.on('agent/assistant-stream', ({ agent, frame }) => {
    if (frame?.type !== 'chunk' || frame.chunk?.type !== 'text-delta') return
    const state = turnState(agent)
    state.assistant = `${state.assistant}${frame.chunk.text}`.slice(-MAX_TRACKED_TEXT)
  })

  ctx.on('tools/result', (exec) => {
    const state = turns.get(String(exec.agent?.id ?? 'unknown'))
    if (state === undefined) return
    const command = commandOf(exec)
    const entry = command === '' ? String(exec.name) : `${exec.name} ${command}`
    state.commands.push(entry.slice(0, 400))
    if (state.commands.length > MAX_TRACKED_COMMANDS) state.commands.shift()
  })

  ctx.on('tools/pre-execute', async (exec, next) => {
    try {
      const command = commandOf(exec)
      if (command === '') return next()
      const risk = looksRisky(command)
      if (!risk.risky) return next()

      const state = turns.get(String(exec.agent?.id ?? 'unknown'))
      const decision = await runtime.engine.decide(toolRisk, {
        tool: exec.name,
        command,
        request: state?.user ?? '',
      })

      // The verdict only acts when a judge actually answered in `active` mode.
      // A shadowed point, a fallback and an unreachable judge all leave the
      // harness's own policy untouched.
      if (decision.source !== 'judge') return next()
      if (decision.outcome === 'ask') {
        return {
          kind: 'ask',
          reason: `jev-judge: this looks like it ${risk.reason}, and the judge was not satisfied that this turn asked for it.`,
        }
      }
      return next()
    } catch (error) {
      warn(ctx, `tool.risk failed: ${messageOf(error)}`)
      return next()
    }
  })

  ctx.on('tools/post-execute', async (exec, result, next) => {
    // The downstream decision is taken first: a plugin that blocked this result
    // must never be overruled by a rewrite from here.
    const downstream = await next()
    if (downstream.kind !== 'accept') return downstream

    try {
      const original = textOfContent(result.content)
      if (original === '') return downstream

      let text = original
      const notes = []

      if (EXTERNAL_TOOL_HINT.test(String(exec.name))) {
        const screened = await runtime.engine.decide(toolInjection, {
          source: exec.name,
          text,
        })
        if (screened.outcome.mode === 'screened') {
          text = screened.outcome.content
          notes.push(`withheld ${screened.outcome.withheldCount} passage(s) that read as instructions`)
        }
      }

      if (shouldJudge(text, settings.admissionMinChars === undefined ? {} : { minChars: settings.admissionMinChars })) {
        const state = turns.get(String(exec.agent?.id ?? 'unknown'))
        const spillPath = writeSpill(original, String(exec.name))
        const admitted = await runtime.engine.decide(toolAdmission, {
          tool: exec.name,
          task: state?.user ?? '',
          output: text,
          spillPath,
        })
        if (admitted.outcome.mode !== 'keep') {
          text = admitted.outcome.mode === 'drop' ? '' : admitted.outcome.content
          notes.push(admissionNote({ spillPath, ...admitted.outcome }))
        }
      }

      if (notes.length === 0) return downstream
      const content = [
        ...(text === '' ? [] : [{ type: 'text', text }]),
        { type: 'text', text: notes.join('\n') },
      ]
      return { ...downstream, content }
    } catch (error) {
      warn(ctx, `tool result screening failed: ${messageOf(error)}`)
      return downstream
    }
  })

  ctx.on('agent/turn-stopping', async ({ agent }) => {
    const state = turnState(agent)
    if (state.assistant === '' && state.user === '') return

    try {
      const [completion, continuation, capture] = await runtime.engine.decideMany([
        {
          spec: turnCompletion,
          input: { finalMessage: state.assistant, runCommands: state.commands },
          subject: { agent: String(agent?.id ?? '') },
        },
        {
          spec: turnContinue,
          input: {
            userMessage: state.user,
            finalMessage: state.assistant,
            irreversible: announcedIrreversibleStep(state.assistant),
          },
          subject: { agent: String(agent?.id ?? '') },
        },
        {
          spec: memoryCapture,
          input: { userMessage: state.user },
          subject: { agent: String(agent?.id ?? '') },
        },
      ])

      if (capture.outcome === 'capture') rememberLesson(state.user)

      if (decideToNudge(completion, 'completion', state)) {
        steer(agent, completionNudge(), ctx)
        return
      }
      if (decideToNudge(continuation, 'continuation', state)) {
        steer(agent, continuationNudge(), ctx)
      }
    } catch (error) {
      warn(ctx, `turn checks failed: ${messageOf(error)}`)
    }
  })

  ctx.on('agent/disposed', ({ agent }) => {
    turns.delete(String(agent?.id ?? 'unknown'))
  })
}

/**
 * Whether this verdict should send the model back to work, respecting the
 * per-turn budget. A shadowed point returns the fallback, which is never a nudge.
 *
 * @param {{outcome: unknown, source: string}} decision
 * @param {'completion' | 'continuation'} kind
 * @param {{nudges: {completion: number, continuation: number}}} state
 * @returns {boolean}
 */
function decideToNudge(decision, kind, state) {
  if (decision.outcome !== 'nudge' || decision.source !== 'judge') return false
  if (state.nudges[kind] >= NUDGE_BUDGET[kind]) return false
  state.nudges[kind] += 1
  return true
}

/**
 * Send the model back to work. `steer` continues the same turn rather than
 * queueing a new one, which is what a nudge means.
 *
 * @param {object} agent
 * @param {string} text
 * @param {object} ctx
 * @returns {void}
 */
function steer(agent, text, ctx) {
  if (typeof agent?.steer !== 'function') {
    warn(ctx, 'this harness build does not expose steer(); the nudge was dropped')
    return
  }
  agent.steer(createInjectedMessage(text))
}

/**
 * Build the message a nudge carries. It is the same shape the harness's own
 * `createUserMessage` produces, built here so the package needs no import of the
 * harness: a fresh id, user role, text content, and a source kind that says where
 * it came from. A TypeScript consumer declares the kind by merging it into
 * `MessageSourceMap`; consumers of unknown kinds fall through by design.
 *
 * @param {string} text
 * @returns {object}
 */
export function createInjectedMessage(text) {
  return deepFreeze({
    id: randomUUID(),
    role: 'user',
    content: [{ type: 'text', text }],
    source: { kind: 'jev-judge' },
  })
}

/**
 * Freeze a message the way the harness freezes its own, so nothing downstream
 * can mutate a committed message.
 *
 * @param {unknown} value
 * @returns {unknown}
 */
function deepFreeze(value) {
  if (value === null || typeof value !== 'object') return value
  for (const item of Object.values(value)) deepFreeze(item)
  return Object.freeze(value)
}

/**
 * Append one lesson, deduplicated, to the home-level lessons file.
 *
 * @param {string} message
 * @returns {void}
 */
function rememberLesson(message) {
  const lesson = toLesson(message)
  if (lesson === '') return
  try {
    const path = join(dshHome(), 'jev-judge', 'lessons.md')
    mkdirSync(join(dshHome(), 'jev-judge'), { recursive: true })
    let existing = ''
    try {
      existing = readFileSync(path, 'utf8')
    } catch {
      existing = ''
    }
    if (existing.includes(`${lesson}\n`)) return
    appendFileSync(path, `- ${lesson}\n`, { mode: 0o600 })
  } catch {
    // Losing a lesson is a smaller failure than breaking a turn.
  }
}

/**
 * Where this deployment keeps its own state.
 *
 * @returns {string}
 */
function dshHome() {
  return process.env.DSH_HOME ?? join(homedir(), '.dsh')
}

/**
 * Write a tool result that is being withheld so the model can still ask for it.
 *
 * @param {string} text
 * @param {string} toolName
 * @returns {string | undefined}
 */
function writeSpill(text, toolName) {
  try {
    const directory = join(dshHome(), 'jev-judge', 'spill')
    mkdirSync(directory, { recursive: true })
    const safeTool = toolName.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 40)
    const path = join(directory, `${Date.now()}-${safeTool}.txt`)
    writeFileSync(path, text, { mode: 0o600 })
    return path
  } catch {
    return undefined
  }
}

/**
 * Normalize the row configuration, warning instead of throwing when it is
 * unusable: a harness boot is all-or-nothing, and a bad row must not cost it.
 *
 * @param {unknown} config
 * @param {object} ctx
 * @returns {{overrides: object, admissionMinChars: number | undefined}}
 */
function readSettings(config, ctx) {
  if (config === undefined || config === null) return { overrides: {}, admissionMinChars: undefined }
  if (typeof config !== 'object' || Array.isArray(config)) {
    warn(ctx, 'plugin config must be an object; using defaults')
    return { overrides: {}, admissionMinChars: undefined }
  }

  const modes = config.modes
  const ledger = config.ledger
  const judges = config.judges
  const options = config.options

  if (modes !== undefined && (typeof modes !== 'object' || modes === null || Array.isArray(modes))) {
    warn(ctx, '`modes` must be an object keyed by decision point id; ignored')
  }
  if (ledger !== undefined && (typeof ledger !== 'object' || ledger === null || Array.isArray(ledger))) {
    warn(ctx, '`ledger` must be an object; ignored')
  }
  if (judges !== undefined && (typeof judges !== 'object' || judges === null || Array.isArray(judges))) {
    warn(ctx, '`judges` must be an object; ignored')
  }

  const admissionMinChars = plainObject(options)?.admission?.minChars

  return {
    overrides: {
      ...(plainObject(modes) ? { modes } : {}),
      ...(plainObject(judges) ? { judges } : {}),
      ...(plainObject(ledger) ? { ledger } : {}),
      ...(plainObject(options) ? { options } : {}),
    },
    admissionMinChars: Number.isFinite(admissionMinChars) ? Number(admissionMinChars) : undefined,
  }
}

/**
 * @param {unknown} value
 * @returns {value is Record<string, any>}
 */
function plainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * The text blocks of a message or result, joined.
 *
 * @param {unknown} content
 * @returns {string}
 */
function textOfContent(content) {
  if (!Array.isArray(content)) return ''
  return content
    .filter((block) => plainObject(block) && block.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text)
    .join('\n')
}

/**
 * The command line a tool call carries, when it has one.
 *
 * @param {{arguments?: unknown}} exec
 * @returns {string}
 */
function commandOf(exec) {
  const args = exec.arguments
  if (typeof args === 'string') return args
  if (!plainObject(args)) return ''
  if (typeof args.command === 'string') return args.command
  if (typeof args.cmd === 'string') return args.cmd
  if (Array.isArray(args.command)) return args.command.map(String).join(' ')
  return ''
}

/**
 * @param {unknown} error
 * @returns {string}
 */
function messageOf(error) {
  return error instanceof Error ? error.message : String(error)
}

/**
 * Report a skipped setting the way the harness reports them.
 *
 * @param {object} ctx
 * @param {string} message
 * @returns {void}
 */
function warn(ctx, message) {
  ctx.logger?.warn(`jev-judge: ${message}`)
}
