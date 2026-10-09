/**
 * The command-hook face of the judgment kernel.
 *
 * Claude Code, Codex and DeepSeek Harness all run the same shape of hook: the
 * host writes one JSON event to a command's stdin and reads JSON back from its
 * stdout, with exit 0 for "the hook spoke" and exit 2 for "block this". One
 * mapping therefore serves all three — the dialect argument this module accepts
 * changes nothing about the contract and exists only so a log can say which host
 * produced a payload.
 *
 * The mapping is a pure function of the event, the runtime and a scratch state
 * under the project's `.jev-judge/` directory. A host that fails to load a
 * module is a menu that disappears or a turn that does not start, so nothing
 * here may reach the caller as an exception: an unexpected failure is answered
 * with exit 0 and no output, which is exactly the behaviour of a host running
 * without this package.
 *
 * @module dsh-jev-judge/runtimes/hooks
 */

import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

import { admissionNote, shouldJudge, toolAdmission } from '../../decisions/tool-admission.js'
import { toolInjection } from '../../decisions/tool-injection.js'
import { looksRisky, toolRisk } from '../../decisions/tool-risk.js'
import { completionNudge, turnCompletion } from '../../decisions/turn-completion.js'
import { announcedIrreversibleStep, continuationNudge, turnContinue } from '../../decisions/turn-continue.js'
import { memoryCapture, toLesson } from '../../decisions/memory-capture.js'
import { createJudgeRuntime } from '../../kernel/registry.js'

/** The environment variable a hook config names its dialect with. */
export const DIALECT_ENV = 'JEV_JUDGE_HOOK_DIALECT'

/** The dialect reported when nothing names one. */
export const DEFAULT_DIALECT = 'claude-code'

/** How many `turn.completion` nudges one session may receive. */
export const MAX_COMPLETION_NUDGES = 1

/** How many `turn.continue` nudges one session may receive. */
export const MAX_CONTINUATION_NUDGES = 2

/**
 * What `turn.completion` and `turn.continue` are each allowed to say, so the
 * budget can be spent without asking a point that is no longer allowed to act.
 */
const COMPLETION = 'completion'
const CONTINUATION = 'continuation'

/** The directory hooks keep their scratch state in, relative to the project. */
const STATE_DIRECTORY = '.jev-judge'

/** The file the nudge budgets live in, per session. */
const STATE_FILE = 'hook-state.json'

/** The file captured lessons live in, one line each. */
const LESSONS_FILE = 'lessons.md'

/** The brief a session starts with. Kept under 400 characters by its own test. */
const KERNEL_HINT =
  'jev-judge runs small judgments for you (tool output worth reading, pages instructing the AI, risky commands). ' +
  'Each one is recorded in a ledger. Ask through the judgment tool or CLI instead of reading everything yourself.'

/**
 * The result of one hook event: what the process must do with it.
 *
 * @typedef {object} HookDecision
 * @property {number} exitCode 0 when the hook spoke, 2 when it blocks.
 * @property {string} stdout JSON for the host, empty when there is nothing to say.
 * @property {string} stderr Text the host treats as a blocking reason.
 */

/**
 * A resolved deployment: the kernel's configuration, loaded once.
 *
 * @typedef {object} HookRuntime
 * @property {ReturnType<typeof createJudgeRuntime>} kernel
 * @property {string} dialect
 */

/**
 * Everything the mapping needs about one deployment, resolved once per process:
 * loading the configuration, building the judges and opening the ledger are
 * per-deployment work, not per-event work.
 *
 * @param {{dialect?: string}} [options]
 * @returns {HookRuntime}
 */
export function createHookRuntime(options = {}) {
  return {
    kernel: createJudgeRuntime(),
    dialect: options.dialect ?? resolveDialect(),
  }
}

/**
 * The dialect a hook process should report. The argument wins over the
 * environment, and an unrecognized value is kept as given: the contract is
 * identical across hosts, so a new name needs no code change.
 *
 * @param {string | undefined} [argument] The CLI argument, when one was passed.
 * @param {Record<string, string | undefined>} [env]
 * @returns {string}
 */
export function resolveDialect(argument, env = process.env) {
  const fromArgument = String(argument ?? '').trim()
  if (fromArgument !== '') return fromArgument
  const fromEnvironment = String(env[DIALECT_ENV] ?? '').trim()
  return fromEnvironment === '' ? DEFAULT_DIALECT : fromEnvironment
}

/**
 * Answer one hook event.
 *
 * This is the whole adapter: everything except reading stdin and writing stdout,
 * which is what makes it testable without spawning a process.
 *
 * @param {object} options
 * @param {string | undefined} options.event The hook event name.
 * @param {unknown} options.payload The JSON event the host wrote to stdin.
 * @param {HookRuntime} options.runtime
 * @returns {Promise<HookDecision>}
 */
export async function decideHookEvent({ event, payload, runtime }) {
  try {
    return await mapEvent({ event, payload, runtime })
  } catch (error) {
    // Fail open. A host that cannot run this hook must behave exactly as it did
    // before the hook existed, so the failure leaves one line behind and no
    // exit code the host would act on.
    return { exitCode: 0, stdout: '', stderr: `jev-judge hook: ${message(error)}\n` }
  }
}

/**
 * The mapping itself, allowed to throw: `decideHookEvent` is the boundary that
 * turns an unexpected throw into a silent pass.
 *
 * @param {object} options
 * @param {string | undefined} options.event
 * @param {unknown} options.payload
 * @param {HookRuntime} options.runtime
 * @returns {Promise<HookDecision>}
 */
async function mapEvent({ event, payload, runtime }) {
  const name = normalizeEvent(event ?? read(payload, 'hook_event_name'))
  const where = hookStateDirectory(payload)

  switch (name) {
    case 'SessionStart':
      return speak(contextPackage('SessionStart', KERNEL_HINT))
    case 'UserPromptSubmit':
      // The prompt itself is the only state this point would have, and it is the
      // model's to read. Context injection is available here, nothing to add.
      return silence()
    case 'PreToolUse':
      return await pretoolUse(payload, runtime, where)
    case 'PostToolUse':
      return await postToolUse(payload, runtime, where)
    case 'Stop':
      return await stop(payload, runtime, where)
    default:
      // An event this adapter does not map is not this adapter's business. The
      // hook stays installed and quiet rather than guessing what a host means.
      return silence()
  }
}

/**
 * `PreToolUse` — a risky call is checked against what the user asked for, and
 * the verdict may remove the approval the host was about to ask for.
 *
 * @param {unknown} payload
 * @param {HookRuntime} runtime
 * @param {string} where
 * @returns {Promise<HookDecision>}
 */
async function pretoolUse(payload, runtime, where) {
  const tool = text(read(payload, 'tool_name')) || 'tool'
  const input = read(payload, 'tool_input')
  const command = commandOf(tool, input)

  // The rule half comes first: most calls are not worth a judge, and a call the
  // rules did not flag has nothing this point could usefully say.
  const flagged = looksRisky(command)
  if (!flagged.risky) return silence()

  const decision = await runtime.kernel.engine.decide(
    toolRisk,
    {
      tool,
      command,
      request: userMessage(payload),
      ...(read(payload, 'irreversible') === true ? { irreversible: true } : {}),
    },
    { subject: subjectOf(payload, where) },
  )

  // `deny` is deliberately unreachable here: rule-flagged calls are the ones the
  // host would have asked a human about, and this point only ever vouches.
  const permission = decision.outcome === 'allow' ? 'allow' : 'ask'
  return speak(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: permission,
        permissionDecisionReason: reasonFor(decision, flagged.reason),
      },
    }),
  )
}

/**
 * `PostToolUse` — what a tool returned is screened for instructions aimed at the
 * model, and long output is trimmed to the chunks the task needs.
 *
 * @param {unknown} payload
 * @param {HookRuntime} runtime
 * @param {string} where
 * @returns {Promise<HookDecision>}
 */
async function postToolUse(payload, runtime, where) {
  const tool = text(read(payload, 'tool_name')) || 'tool'
  const output = resultText(read(payload, 'tool_response'))
  if (output.trim() === '') return silence()

  const subject = subjectOf(payload, where)
  const injection = await runtime.kernel.engine.decide(
    toolInjection,
    { source: `result of ${tool}`, text: output },
    { subject },
  )
  const screened = injection.outcome ?? {}
  const screenedBody = screened.mode === 'screened' ? String(screened.content ?? '') : output

  // A screened result is the kept passages followed by one note, so the note is
  // the last thing the screen wrote — anywhere else it would be a page that
  // happens to quote it.
  const note = screened.mode === 'screened' ? lastNoteOf(screenedBody) : ''

  if (note !== '' && screenedBody.trim() === note) {
    // Every passage read as an instruction to the model. There is nothing left
    // to hand over, so this is a block — and the note is its reason.
    return block(note)
  }

  // This dialect cannot rewrite a result, so what the screen kept is handed over
  // as context: without it the model would still be reading the passages the
  // screen removed, and would have no way to tell which version to trust.
  const parts = note === '' ? [] : [screenedBody]
  const body = screenedBody

  // Output small enough to have cost nothing to read is not worth a judge: the
  // point exists to save tokens, and this output has none to save.
  if (!shouldJudge(body)) return reply(parts)

  const admission = await runtime.kernel.engine.decide(
    toolAdmission,
    { tool, output: body, task: userMessage(payload) },
    { subject },
  )
  const kept = admission.outcome ?? {}

  if (kept.mode === 'keep' || kept.mode === undefined) return reply(parts)

  // The note is what tells the model that something was removed and why, so it
  // is emitted whether or not a judge trimmed anything further.
  parts.push(
    admissionNote({
      kept: kept.kept ?? 0,
      dropped: kept.dropped ?? 0,
      chunks: kept.chunks ?? 0,
    }),
  )
  parts.push(String(kept.content ?? ''))
  return reply(parts)
}

/**
 * `Stop` — the turn is ending. Did it claim more than it showed, stop in front
 * of a step it announced, or leave a correction worth keeping?
 *
 * `turn.completion` and `turn.continue` share no state, so they go to the engine
 * together and the state is billed once. Each is asked only while its own nudge
 * budget lasts, because a point that may no longer act is not worth paying for.
 *
 * @param {unknown} payload
 * @param {HookRuntime} runtime
 * @param {string} where
 * @returns {Promise<HookDecision>}
 */
async function stop(payload, runtime, where) {
  const finalMessage = lastAssistantMessage(payload)
  const user = userMessage(payload)
  const runCommands = runCommandsOf(payload)
  const irreversible = announcedIrreversibleStep(finalMessage)
  const session = sessionOf(payload, where)

  // Best effort: a budget that cannot be read is a budget that is not spent.
  const state = readState(where)
  const spent = nudgeCounts(state, session)

  /** @type {{spec: unknown, input: unknown}[]} */
  const entries = []
  if (spent[COMPLETION] < MAX_COMPLETION_NUDGES) {
    entries.push({ spec: turnCompletion, input: { finalMessage, runCommands } })
  }
  if (spent[CONTINUATION] < MAX_CONTINUATION_NUDGES) {
    // An announced step that cannot be undone is never pushed at the model: the
    // point declines when it is told, so the information has to reach it here.
    entries.push({
      spec: turnContinue,
      input: { userMessage: user, finalMessage, irreversible },
    })
  }

  const decisions = entries.length === 0
    ? []
    : await runtime.kernel.engine.decideMany(entries.map((entry) => ({ ...entry, subject: subjectOf(payload, where) })))

  const capture = user.trim() === ''
    ? undefined
    : await runtime.kernel.engine.decide(
        memoryCapture,
        { userMessage: user },
        { subject: subjectOf(payload, where) },
      )

  // A lesson is written before the nudge is emitted: if the nudge ends the
  // process, the correction is already on disk.
  if (capture?.outcome === 'capture') writeLesson(where, toLesson(user))

  const decisionFor = (spec) => decisions.find((decision) => decision.pointId === spec.id)
  const kind = nudgeKind(decisionFor(turnCompletion), decisionFor(turnContinue))
  if (kind === undefined) return silence()

  writeState(where, withSpent(state, session, kind))
  return block(kind === COMPLETION ? completionNudge() : continuationNudge())
}

/**
 * Which point, if either, earned a nudge. A fallback speaks for the host, not
 * for the kernel: only a judge's own verdict is allowed to reopen a turn.
 *
 * @param {object | undefined} completion
 * @param {object | undefined} continuation
 * @returns {'completion' | 'continuation' | undefined}
 */
function nudgeKind(completion, continuation) {
  // Completion first: a turn that claims done without evidence is the more
  // specific finding, and the completion nudge asks for the verification the
  // continuation nudge would only ask for as work.
  if (completion?.source === 'judge' && completion.outcome === 'nudge') return COMPLETION
  if (continuation?.source === 'judge' && continuation.outcome === 'nudge') return CONTINUATION
  return undefined
}

// ── the project's scratch state ──────────────────────────────────────────────

/**
 * Where a hook payload's project keeps its scratch files. The host's `cwd` is
 * authoritative: the hook runs inside the session's project, whatever directory
 * the process itself was started in.
 *
 * @param {unknown} payload
 * @returns {string}
 */
export function hookStateDirectory(payload) {
  const cwd = text(read(payload, 'cwd')).trim()
  return cwd === '' ? join(process.cwd(), STATE_DIRECTORY) : join(cwd, STATE_DIRECTORY)
}

/**
 * One session's nudge budgets.
 *
 * @param {unknown} state
 * @param {string} session
 * @returns {{completion: number, continuation: number}}
 */
function nudgeCounts(state, session) {
  const sessions = isObject(state) && isObject(state.sessions) ? state.sessions : {}
  const entry = isObject(sessions[session]) ? sessions[session] : {}
  return {
    completion: countOf(entry.completion),
    continuation: countOf(entry.continuation),
  }
}

/**
 * The same state with one more nudge recorded for a session.
 *
 * @param {unknown} state
 * @param {string} session
 * @param {string} kind
 * @returns {Record<string, unknown>}
 */
function withSpent(state, session, kind) {
  const base = isObject(state) ? state : {}
  const sessions = isObject(base.sessions) ? { ...base.sessions } : {}
  const entry = { ...(isObject(sessions[session]) ? sessions[session] : {}) }
  entry[kind] = countOf(entry[kind]) + 1
  sessions[session] = entry
  return { ...base, sessions }
}

/**
 * Read the budget file. A file that is missing or unreadable means no budget has
 * been spent, which is the safe direction: an unreadable file must not turn into
 * an unbounded number of nudges either way, so the counts restart at zero and
 * the point is asked at most once per call.
 *
 * @param {string} where
 * @returns {Record<string, unknown>}
 */
function readState(where) {
  try {
    const parsed = JSON.parse(readFileSync(join(where, STATE_FILE), 'utf8'))
    return isObject(parsed) ? parsed : {}
  } catch {
    return {}
  }
}

/**
 * Write the budget file. A failure is silent: losing a counter costs a repeated
 * nudge at worst, and must never cost the turn.
 *
 * @param {string} where
 * @param {Record<string, unknown>} state
 * @returns {void}
 */
function writeState(where, state) {
  try {
    mkdirSync(where, { recursive: true })
    writeFileSync(join(where, STATE_FILE), `${JSON.stringify(state, null, 2)}\n`)
  } catch {
    // Best effort by design.
  }
}

/**
 * Append one lesson, one line at a time, skipping a line that is already there.
 *
 * @param {string} where
 * @param {string} lesson
 * @returns {void}
 */
function writeLesson(where, lesson) {
  const line = String(lesson ?? '').trim()
  if (line === '') return
  try {
    const path = join(where, LESSONS_FILE)
    let existing = ''
    try {
      existing = readFileSync(path, 'utf8')
    } catch {
      existing = ''
    }
    const lines = existing.split('\n').map((entry) => entry.trim())
    if (lines.includes(line)) return
    mkdirSync(dirname(path), { recursive: true })
    const separator = existing === '' || existing.endsWith('\n') ? '' : '\n'
    appendFileSync(path, `${separator}${line}\n`)
  } catch {
    // Best effort by design: a correction that cannot be written is not an error.
  }
}

// ── reading a payload the hosts shape differently ────────────────────────────

/**
 * Read one payload field. Hosts disagree on the exact field names they send, so
 * every read takes the alternatives rather than assuming one host's spelling.
 *
 * @param {unknown} payload
 * @param {...string} names
 * @returns {unknown}
 */
function read(payload, ...names) {
  if (!isObject(payload)) return undefined
  for (const name of names) {
    if (payload[name] !== undefined && payload[name] !== null) return payload[name]
  }
  return undefined
}

/**
 * The command a tool call is about, for the risk rules. A shell tool names it
 * directly; for anything else the whole input is the substance of the call.
 *
 * @param {string} tool
 * @param {unknown} input
 * @returns {string}
 */
function commandOf(tool, input) {
  if (isObject(input) && typeof input.command === 'string') return input.command
  if (typeof input === 'string') return input
  return render(input)
}

/**
 * The text a tool returned, whichever way the host wrapped it.
 *
 * @param {unknown} response
 * @returns {string}
 */
function resultText(response) {
  if (typeof response === 'string') return response
  if (Array.isArray(response)) return response.map(resultText).filter(Boolean).join('\n')
  if (isObject(response)) {
    const parts = []
    for (const name of ['stdout', 'stderr', 'content', 'output', 'text', 'result']) {
      const value = response[name]
      if (typeof value === 'string' && value !== '') parts.push(value)
      else if (Array.isArray(value)) parts.push(value.map(resultText).filter(Boolean).join('\n'))
    }
    if (parts.length > 0) return parts.filter(Boolean).join('\n')
  }
  return render(response)
}

/**
 * The last assistant message a Stop payload carries, when it carries one.
 *
 * @param {unknown} payload
 * @returns {string}
 */
function lastAssistantMessage(payload) {
  const direct = read(
    payload,
    'last_assistant_message',
    'lastAssistantMessage',
    'assistant_message',
    'final_message',
    'message',
  )
  if (typeof direct === 'string') return direct
  const transcript = read(payload, 'transcript', 'messages')
  if (!Array.isArray(transcript)) return ''
  for (let index = transcript.length - 1; index >= 0; index -= 1) {
    const entry = transcript[index]
    if (!isObject(entry)) continue
    if (entry.role !== undefined && entry.role !== 'assistant') continue
    const content = resultText(entry.content ?? entry.message ?? entry.text)
    if (content.trim() !== '') return content
  }
  return ''
}

/**
 * The user's own words: what a risk verdict is checked against, what memory may
 * keep, and what "you already asked for this" is measured on.
 *
 * @param {unknown} payload
 * @returns {string}
 */
function userMessage(payload) {
  const message = text(read(payload, 'prompt', 'user_message', 'last_user_message', 'userMessage'))
  if (message.trim() !== '') return message
  const transcript = read(payload, 'transcript', 'messages')
  if (!Array.isArray(transcript)) return ''
  for (let index = transcript.length - 1; index >= 0; index -= 1) {
    const entry = transcript[index]
    if (!isObject(entry) || entry.role !== 'user') continue
    const content = resultText(entry.content ?? entry.message ?? entry.text)
    if (content.trim() !== '') return content
  }
  return ''
}

/**
 * The commands this turn ran, from the transcript's tool calls, so
 * `turn.completion` can tell whether anything checked the work.
 *
 * @param {unknown} payload
 * @returns {string[]}
 */
function runCommandsOf(payload) {
  const transcript = read(payload, 'transcript', 'messages')
  if (!Array.isArray(transcript)) return []
  /** @type {string[]} */
  const commands = []
  for (const entry of transcript) {
    if (!isObject(entry)) continue
    const calls = Array.isArray(entry.tool_calls) ? entry.tool_calls : []
    for (const call of calls) {
      const input = isObject(call) ? (call.input ?? call.arguments) : undefined
      const parsed = typeof input === 'string' ? parseObject(input) : input
      const command = isObject(parsed) ? text(parsed.command) : ''
      if (command !== '') commands.push(command)
    }
  }
  return commands
}

/**
 * The session the budgets belong to.
 *
 * @param {unknown} payload
 * @param {string} where
 * @returns {string}
 */
function sessionOf(payload, where) {
  const session = text(read(payload, 'session_id', 'sessionId')).trim()
  return session === '' ? where : session
}

/**
 * What the ledger records this decision was about, so a session can be followed
 * across points without a record containing the session's content.
 *
 * @param {unknown} payload
 * @param {string} where
 * @returns {Record<string, unknown>}
 */
function subjectOf(payload, where) {
  const session = text(read(payload, 'session_id', 'sessionId')).trim()
  const source = text(read(payload, 'cwd')).trim()
  return {
    ...(session === '' ? {} : { session }),
    ...(source === '' ? { project: where } : { project: source }),
  }
}

/**
 * The event name, however a host spelled it.
 *
 * @param {unknown} event
 * @returns {string}
 */
function normalizeEvent(event) {
  const name = text(event).trim()
  switch (name) {
    case 'session-start':
      return 'SessionStart'
    case 'user-prompt-submit':
      return 'UserPromptSubmit'
    case 'pre-tool-use':
      return 'PreToolUse'
    case 'post-tool-use':
      return 'PostToolUse'
    case 'stop':
      return 'Stop'
    default:
      return name
  }
}

// ── small helpers ────────────────────────────────────────────────────────────

/**
 * The withholding note a screened result carries, or an empty string when it
 * carries none. The screen appends it, so only the text after the last note is
 * missed — and a note is the only thing this adapter ever looks for there.
 *
 * @param {unknown} content
 * @returns {string}
 */
function lastNoteOf(content) {
  const lines = String(content ?? '').split('\n')
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index].trim()
    if (line.startsWith('[jev-judge]')) return line
  }
  return ''
}

/**
 * Why the host should show what it is about to show. A judged verdict can say
 * what the judge saw; a fallback can only repeat the rule that flagged the call.
 *
 * @param {{source?: string, reason?: string}} decision
 * @param {string} flagged Reason the rules flagged the call.
 * @returns {string}
 */
function reasonFor(decision, flagged) {
  if (decision.source === 'judge') {
    return 'jev-judge: the user asked for this call, so the approval was answered.'
  }
  const why = decision.reason === undefined ? '' : ` (${decision.reason})`
  return `jev-judge: ${flagged}${why}; no judge vouched for this call, so a human still decides.`
}

/**
 * Render a value a hook event carried, so its state can be judged as text.
 *
 * @param {unknown} value
 * @returns {string}
 */
function render(value) {
  if (value === undefined || value === null) return ''
  if (typeof value === 'string') return value
  try {
    return JSON.stringify(value) ?? ''
  } catch {
    return ''
  }
}

/**
 * @param {unknown} value
 * @returns {string}
 */
function text(value) {
  return typeof value === 'string' ? value : value === undefined || value === null ? '' : String(value)
}

/**
 * @param {unknown} value
 * @returns {number}
 */
function countOf(value) {
  return Number.isInteger(value) && value > 0 ? value : 0
}

/**
 * @param {unknown} value
 * @returns {value is Record<string, any>}
 */
function isObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * @param {string} source
 * @returns {Record<string, unknown> | undefined}
 */
function parseObject(source) {
  try {
    const parsed = JSON.parse(source)
    return isObject(parsed) ? parsed : undefined
  } catch {
    return undefined
  }
}

/**
 * @param {unknown} error
 * @returns {string}
 */
function message(error) {
  return error instanceof Error ? error.message : String(error)
}

/**
 * @param {string} json
 * @returns {HookDecision}
 */
function speak(json) {
  return { exitCode: 0, stdout: `${json}\n`, stderr: '' }
}

/**
 * The JSON a host parses to show the model some context.
 *
 * @param {string} hookEventName
 * @param {string} context
 * @returns {string}
 */
function contextPackage(hookEventName, context) {
  return JSON.stringify({ hookSpecificOutput: { hookEventName, additionalContext: context } })
}

/**
 * Add context the host will show the model. Nothing to add is nothing emitted:
 * an empty line in a hook's stdout is a parse error in some hosts.
 *
 * @param {string[]} parts
 * @returns {HookDecision}
 */
function reply(parts) {
  const content = parts.filter((part) => String(part ?? '').trim() !== '').join('\n\n')
  if (content === '') return silence()
  return speak(contextPackage('PostToolUse', content))
}

/**
 * @param {string} reason
 * @returns {HookDecision}
 */
function block(reason) {
  return { exitCode: 2, stdout: '', stderr: `${reason}\n` }
}

/**
 * @returns {HookDecision}
 */
function silence() {
  return { exitCode: 0, stdout: '', stderr: '' }
}
