/**
 * The DeepSeek Harness face of the judgment kernel.
 *
 * This module is the plugin row target of `cordis.patch.yml`. It is loaded by
 * the harness Loader by package subpath (`dsh-jev-judge/host`), so it must stay
 * importable with nothing installed beyond the package itself — it deliberately
 * imports no `@deepseek-ai/*` module at runtime and reaches the harness only
 * through the `ctx` it is handed.
 *
 * The kernel's decision points attach to host extension points here as they
 * land; until then this module's whole job is to mount cleanly and refuse a
 * configuration it cannot understand without breaking the process. A harness
 * boot is all-or-nothing, so a malformed row is reported and skipped rather
 * than thrown.
 *
 * @module dsh-jev-judge/host
 */

/** Plugin name as the Loader sees it. */
export const name = 'jev-judge'

/**
 * Mount the kernel for one profile.
 *
 * @param {object} ctx The Cordis context of this plugin's fiber.
 * @param {unknown} config The row's `config` object from the patch layer.
 * @returns {void}
 */
export function apply(ctx, config) {
  const settings = readConfig(config, ctx)
  if (settings === null) return
}

/**
 * Normalize the row config, warning instead of throwing when it is unusable.
 *
 * @param {unknown} config The raw row config.
 * @param {object} ctx The Cordis context, used for its logger.
 * @returns {Record<string, unknown> | null} The settings, or `null` when the
 *   row must be skipped.
 */
function readConfig(config, ctx) {
  if (config === undefined || config === null) return {}
  if (typeof config !== 'object' || Array.isArray(config)) {
    warn(ctx, 'plugin config must be an object; using defaults')
    return {}
  }
  return { ...config }
}

/**
 * Report a skipped setting the way the harness reports them.
 *
 * @param {object} ctx The Cordis context.
 * @param {string} message The warning text.
 * @returns {void}
 */
function warn(ctx, message) {
  ctx.logger?.warn(`jev-judge: ${message}`)
}
