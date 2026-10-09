/**
 * `jev-judge mcp` — serve the kernel to any MCP client over stdio.
 *
 * This is the channel for agents this project does not build a plugin for. Wire
 * it into a client as a stdio server and its tools appear:
 * `judge_items`, `judge_ask`, `judge_ledger`.
 *
 * @module dsh-jev-judge/commands/mcp
 */

import { createJudgeRuntime } from '../kernel/registry.js'
import { serveStdio } from '../runtimes/mcp/server.js'
import { fail, parse } from './support.js'

/** @type {import('../cli.js').Command} */
export const command = {
  summary: 'Serve the kernel over MCP on stdio (for Claude/Codex/OpenCode/Cursor).',
  usage: `mcp — serve the kernel over MCP on stdio.

The client speaks JSON-RPC on stdin/stdout; diagnostics go to stderr.

Options:
  --config <path>  Use another provider record.
  --kernel <path>  Use another kernel settings file.

Example client configuration:

  {
    "mcpServers": {
      "jev-judge": { "command": "npx", "args": ["-y", "dsh-jev-judge", "mcp"] }
    }
  }`,
  async run(argv) {
    const { values } = parse(argv, {
      config: { type: 'string' },
      kernel: { type: 'string' },
    })

    const runtime = createJudgeRuntime({
      providerPath: values.config ? String(values.config) : undefined,
      kernelPath: values.kernel ? String(values.kernel) : undefined,
    })
    // The handshake must never be blocked by a broken deployment: report the
    // problem on stderr and serve anyway, so the client can see the tools.
    for (const problem of runtime.problems) fail(`jev-judge: ${problem}`)
    if (runtime.judgeNames.length === 0) {
      fail('jev-judge: no judge is configured; the judging tools will report that instead of answering.')
    }

    await serveStdio({ runtime })
    return 0
  },
}
