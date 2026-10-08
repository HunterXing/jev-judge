/**
 * `jev-judge verify` — validate the private provider record without touching the
 * network.
 *
 * The report is deliberately the same shape the `typesafe-ai-jev-skill` verifier
 * prints, because it is the same contract: provider, endpoint, model,
 * authentication mode and whether a key is present, with the key never shown.
 *
 * @module dsh-jev-judge/commands/verify
 */

import { ConfigError, discoverProviderConfigPath, readConfigFile, validateProviderConfig } from '../kernel/config.js'
import { fail, out, parse } from './support.js'

/** @type {import('../cli.js').Command} */
export const command = {
  summary: 'Validate the private provider record offline (no network).',
  usage: `verify — validate the private provider record offline (no network).

Options:
  --config <path>  Validate another record instead of the discovered one.
  --quiet          Print nothing; report through the exit code only.`,
  async run(argv) {
    const { values } = parse(argv, {
      config: { type: 'string' },
      quiet: { type: 'boolean' },
    })

    const discovered = values.config
      ? { path: String(values.config), fromEnv: false }
      : discoverProviderConfigPath(process.env)

    let config
    try {
      config = validateProviderConfig(readConfigFile(discovered.path), process.env)
    } catch (error) {
      const message = error instanceof ConfigError ? error.message : String(error)
      fail(`Configuration invalid: ${message}`)
      if (!values.config) {
        fail(
          `Expected a private record at ${discovered.path} or a path in JEV_SKILL_CONFIG.`,
        )
      }
      return 1
    }

    if (!values.quiet) {
      out('Configuration valid.')
      out(`Config:     ${discovered.path}`)
      out(`Provider:   ${config.providerName}`)
      out(`Base URL:   ${config.baseUrl}`)
      out(`Model:      ${config.model}`)
      out(`Protocol:   ${config.protocol}`)
      out(`Endpoint:   ${config.endpoint}`)
      out(
        `Auth:       ${config.authHeader}${config.authScheme ? ` (${config.authScheme})` : ''}`,
      )
      out(`Key source: ${config.apiKeySource}; value hidden`)
      if (config.protocol === 'chat') {
        out(
          'Note:       a chat route proves reachability only; it does not prove typed decision support.',
        )
      }
    }
    return 0
  },
}
