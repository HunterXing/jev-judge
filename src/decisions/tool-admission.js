/**
 * `tool.admission` — only what matters from a long tool result enters the context.
 *
 * A test log, a directory listing, a stack of search hits: the useful part is a
 * fraction of the bytes, and the fraction depends on the task, which is exactly
 * what a fixed rule cannot know. The output is cut into chunks, each chunk is
 * asked about once, and the chunks nobody needed are replaced by a pointer to
 * the full text.
 *
 * Short output is never sent: the cost of a call is only worth paying when the
 * chunking is what saves the tokens. Neither is output the agent asked for the
 * shape of — see `DEFAULT_TOOL_NAMES` for where that line is drawn.
 *
 * @module dsh-jev-judge/decisions/tool-admission
 */

import { defineDecision } from '../kernel/decision.js'

/** Below this size, the output is admitted unchanged and nobody is asked. */
export const MIN_JUDGED_CHARS = 4000

/** How much text one chunk carries before the output is split further. */
export const CHUNK_CHARS = 3000

/** The most chunks one call is allowed to ask about. */
export const MAX_CHUNKS = 12

/** At or above this probability, a chunk is kept. */
export const KEEP_THRESHOLD = 0.8

/**
 * The tools whose output is *scanned* rather than worked on.
 *
 * A result whose shape the agent chose — a file it decided to read, a pattern it
 * decided to search for — is evidence, and thinning it costs a re-read that may
 * come back thinned differently. What is worth screening is output whose size
 * nobody chose: a log, a dump, a listing, a page.
 *
 * Against 55 days of real sessions, the results over the threshold that came
 * from deliberate reads were 100% dense (a unique line on every line) and held
 * half of every byte over the threshold, while `cordis_inspect_query` was 90%
 * repeated noise. This is the noisy side of that line. Anything not on it is
 * passed through untouched.
 */
export const DEFAULT_TOOL_NAMES = Object.freeze([
  'bash',
  'cordis_inspect_*',
  'mcp__*',
  'web_fetch',
  'webfetch',
  'web_search',
  'websearch',
  'fetch',
])

/**
 * Whether a tool's output is one this point screens.
 *
 * Names are compared without case, because the same tool is spelled differently
 * per dialect (`bash` in the harness, `Bash` in Claude Code). A pattern matches
 * the whole name, or its prefix when it ends in `*`; `web_fetch` and `webfetch`
 * are both listed since neither spelling normalizes into the other. An unnamed
 * tool is never screened: skipping a judgment costs nothing, while screening
 * something that was wanted costs the evidence.
 *
 * @param {string | undefined} tool
 * @param {readonly string[]} [patterns]
 * @returns {boolean}
 */
export function matchesTool(tool, patterns = DEFAULT_TOOL_NAMES) {
  if (typeof tool !== 'string' || tool === '') return false
  const name = tool.toLowerCase()
  return patterns.some((pattern) => {
    if (typeof pattern !== 'string') return false
    const wanted = pattern.toLowerCase()
    return wanted.endsWith('*') ? name.startsWith(wanted.slice(0, -1)) : name === wanted
  })
}

/**
 * Whether an output is worth judging at all.
 *
 * Two things have to hold: the output is long enough for the chunking to be what
 * saves the tokens, and it came from a tool whose output is scanned.
 *
 * @param {string} output
 * @param {{minChars?: number, tool?: string, toolNames?: readonly string[]}} [options]
 * @returns {boolean}
 */
export function shouldJudge(output, options = {}) {
  if (String(output ?? '').length < (options.minChars ?? MIN_JUDGED_CHARS)) return false
  return matchesTool(options.tool, options.toolNames ?? DEFAULT_TOOL_NAMES)
}

/**
 * Cut an output into chunks at line boundaries, covering all of it with at most
 * `maxChunks` pieces. A very large output produces fewer, larger chunks rather
 * than a tail nobody asked about.
 *
 * @param {string} text
 * @param {{chunkChars?: number, maxChunks?: number}} [options]
 * @returns {{index: number, text: string, chars: number}[]}
 */
export function splitChunks(text, options = {}) {
  const source = String(text ?? '')
  if (source === '') return []
  const maxChunks = Math.max(1, options.maxChunks ?? MAX_CHUNKS)
  const target = Math.max(options.chunkChars ?? CHUNK_CHARS, Math.ceil(source.length / maxChunks))

  // A single enormous line (minified JSON, a one-line log entry) would otherwise
  // become one chunk nobody can afford; cut it at the chunk size first, then let
  // the line-based pass merge the pieces back up to the budget.
  const pieces = []
  for (const line of source.split('\n')) {
    if (line.length <= target) {
      pieces.push(line)
      continue
    }
    for (let offset = 0; offset < line.length; offset += target) {
      pieces.push(line.slice(offset, offset + target))
    }
  }

  const chunks = []
  let current = []
  let currentChars = 0

  const flush = () => {
    if (current.length === 0) return
    const chunkText = current.join('\n')
    chunks.push({ index: chunks.length, text: chunkText, chars: chunkText.length })
    current = []
    currentChars = 0
  }

  for (const line of pieces) {
    if (currentChars > 0 && currentChars + line.length + 1 > target) flush()
    current.push(line)
    currentChars += line.length + 1
  }
  flush()

  // Cutting at line boundaries leaves chunks a little under the target, so the
  // count can still exceed the budget: merge the smallest neighbours, which
  // keeps every line and respects the cap.
  while (chunks.length > maxChunks) {
    let bestIndex = 0
    let bestSize = Number.POSITIVE_INFINITY
    for (let index = 0; index < chunks.length - 1; index += 1) {
      const size = chunks[index].chars + chunks[index + 1].chars
      if (size < bestSize) {
        bestSize = size
        bestIndex = index
      }
    }
    const [left, right] = [chunks[bestIndex], chunks[bestIndex + 1]]
    chunks.splice(bestIndex, 2, {
      index: left.index,
      text: `${left.text}\n${right.text}`,
      chars: left.chars + right.chars + 1,
    })
  }
  for (const [index, chunk] of chunks.entries()) chunk.index = index
  return chunks
}

/**
 * The note that replaces what was withheld. It has to answer three questions for
 * the model that reads it: what happened, where the text went, and how to get it
 * back.
 *
 * @param {{spillPath?: string, kept: number, dropped: number, chunks: number}} details
 * @returns {string}
 */
export function admissionNote(details) {
  const where = details.spillPath ? ` The full output is at ${details.spillPath}.` : ''
  if (details.kept === 0) {
    return `[jev-judge] None of the ${details.chunks} chunks of this result were relevant to the task, so the result was withheld.${where}`
  }
  return `[jev-judge] Kept ${details.kept} of ${details.chunks} chunks; ${details.dropped} were not relevant and were withheld.${where}`
}

/**
 * The decision point.
 *
 * Input: `{tool, output, task, spillPath?}`
 * Outcome: `{mode: 'keep'|'trimmed'|'drop', content, kept, dropped, chunks, bytesBefore, bytesAfter}`
 */
export const toolAdmission = defineDecision({
  id: 'tool.admission',
  version: 1,
  questions: {},
  capabilities: 'relate',
  cacheImpact: 'none',
  latency: 'inline',

  questionsFor: (input) => {
    const chunks = splitChunks(input.output)
    /** @type {Record<string, {type: string, instructions: string, criteria: unknown}>} */
    const questions = {}
    for (const chunk of chunks) {
      questions[`c${chunk.index}`] = {
        type: 'boolean',
        instructions:
          `Does chunk \`chunks.c${chunk.index}\` contain anything needed to understand, ` +
          'verify or fix the task, rather than being routine output that can be discarded?',
        criteria: {
          true: 'a failure, an error, a relevant path, a value the task needs, or the line that changed the outcome',
          false: 'routine progress lines, repeated successes, unrelated files, or noise',
        },
      }
    }
    return questions
  },

  buildState: (input) => {
    const chunks = splitChunks(input.output)
    /** @type {Record<string, string>} */
    const state = {}
    for (const chunk of chunks) state[`c${chunk.index}`] = chunk.text
    return {
      task: input.task ?? '',
      tool: input.tool ?? 'tool',
      chunks: state,
    }
  },

  policy: (answers, input) => {
    const chunks = splitChunks(input.output)
    const kept = chunks.filter((chunk) => {
      const answer = answers[`c${chunk.index}`]
      return answer !== undefined && answer.probability >= KEEP_THRESHOLD
    })
    const bytesBefore = String(input.output ?? '').length

    if (chunks.length === 0) {
      return {
        mode: 'keep',
        content: String(input.output ?? ''),
        kept: 0,
        dropped: 0,
        chunks: 0,
        bytesBefore,
        bytesAfter: bytesBefore,
      }
    }

    // A tool result the agent asked for is evidence, and the pointer to where it
    // was spilled may lead somewhere that agent cannot read at all — an MCP-only
    // client has no filesystem. So when no chunk earned its place, the head still
    // goes through: the result degrades to "trimmed, with a pointer", never to a
    // note with nothing behind it.
    const floored = kept.length === 0
    const forwarded = floored ? [chunks[0]] : kept
    const forwardedIndexes = new Set(forwarded.map((chunk) => chunk.index))
    const dropped = chunks.filter((chunk) => !forwardedIndexes.has(chunk.index))
    const mode = kept.length === chunks.length ? 'keep' : 'trimmed'
    const content =
      mode === 'keep'
        ? String(input.output ?? '')
        : forwarded.map((chunk) => chunk.text).join('\n')

    return {
      mode,
      content,
      kept: forwarded.length,
      dropped: dropped.length,
      chunks: chunks.length,
      ...(floored ? { headKept: true } : {}),
      bytesBefore,
      bytesAfter: content.length,
    }
  },

  // Without a judge nothing is withheld: the model reads what it would have read.
  fallback: (input) => {
    const output = String(input.output ?? '')
    const chunks = splitChunks(output)
    return {
      mode: 'keep',
      content: output,
      kept: chunks.length,
      dropped: 0,
      chunks: chunks.length,
      bytesBefore: output.length,
      bytesAfter: output.length,
    }
  },
})

export default toolAdmission
