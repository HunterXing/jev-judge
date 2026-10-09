/**
 * `jev-judge hook` — the command Claude Code, Codex and DeepSeek Harness run.
 *
 * The host writes one JSON event to stdin and reads JSON from stdout, so this
 * command's whole job is to read the event, ask the mapping, and move the answer
 * to the right stream. The mapping itself lives in `runtimes/hooks` and knows
 * nothing about processes.
 *
 * A hook that throws is a broken agent, so a stdin stream that cannot be read as
 * JSON is answered exactly like an event nobody mapped: exit 0, no output.
 *
 * @module dsh-jev-judge/commands/hook
 */

import { createHookRuntime, decideHookEvent, resolveDialect } from '../runtimes/hooks/index.js'
import { fail, out, parse } from './support.js'

/** How much of an event this command reads before giving up on it. */
const MAX_EVENT_BYTES = 8 * 1024 * 1024

/**
 * Read stdin to the end, bounded.
 *
 * @returns {Promise<string>}
 */
async function readEvent() {
  /** @type {Buffer[]} */
  const chunks = []
  let bytes = 0
  for await (const chunk of process.stdin) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk))
    bytes += buffer.length
    if (bytes > MAX_EVENT_BYTES) break
    chunks.push(buffer)
  }
  return Buffer.concat(chunks).toString('utf8')
}

/** @type {import('../cli.js').Command} */
export const command = {
  summary: 'Serve one command-hook event from stdin (Claude Code, Codex, DSH).',
  usage: `hook — serve one command-hook event from stdin (Claude Code, Codex, DSH).

Reads one JSON event from stdin and writes the hook's JSON answer to stdout.
Exit 0 lets the turn continue; exit 2 blocks it, with the reason on stderr.

Usage:
  jev-judge hook [dialect]

Arguments:
  dialect  claude-code (default) or codex; also read from JEV_JUDGE_HOOK_DIALECT.
           Both hosts share the JSON contract, so this only labels diagnostics.`,
  async run(argv) {
    const { positionals } = parse(argv, {}, { allowPositionals: true })
    const dialect = resolveDialect(positionals[0])
    // One runtime per process: loading the configuration, resolving the judges
    // and opening the ledger are per-deployment work, not per-event work.
    const runtime = createHookRuntime({ dialect })

    let payload
    try {
      payload = JSON.parse(await readEvent())
    } catch {
      // An unreadable event is not a decision. Say nothing the host could act on.
      return 0
    }

    const decision = await decideHookEvent({
      event: typeof payload?.hook_event_name === 'string' ? payload.hook_event_name : undefined,
      payload,
      runtime,
    })

    if (decision.stdout !== '') out(decision.stdout.trimEnd())
    if (decision.stderr !== '') fail(decision.stderr.trimEnd())
    return decision.exitCode
  },
}
