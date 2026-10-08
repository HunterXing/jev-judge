/**
 * Programmatic entry point of the judgment kernel.
 *
 * Everything exported here is host-free: it runs in a plain Node process with
 * no DeepSeek Harness, MCP client, or agent runtime present. Host wiring lives
 * under `src/runtimes/` and is reached through its own entry points
 * (`dsh-jev-judge/host`, `dsh-jev-judge/mcp`, `dsh-jev-judge/hooks`).
 *
 * @module dsh-jev-judge
 */

export { PACKAGE_NAME, VERSION } from './meta.js'
