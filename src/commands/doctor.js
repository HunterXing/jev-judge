/**
 * `jev-judge doctor` — say what this kernel will do, without doing it.
 *
 * When a judgment does not happen, the reason is almost always configuration:
 * no record, a record the loader refused, a judge name that does not resolve, or
 * a decision point left in `shadow`. This prints all of it in one screen, with
 * the key never shown.
 *
 * @module dsh-jev-judge/commands/doctor
 */

import { PACKAGE_NAME, VERSION } from '../meta.js'
import { DEFAULT_KERNEL_CONFIG_PATH } from '../kernel/config.js'
import { createJudgeRuntime } from '../kernel/registry.js'
import { fail, out, parse } from './support.js'

/** @type {import('../cli.js').Command} */
export const command = {
  summary: 'Show the resolved configuration, judges, modes and ledger.',
  usage: `doctor — show the resolved configuration, judges, modes and ledger.

Options:
  --config <path>  Use another provider record.
  --kernel <path>  Use another kernel settings file.
  --json           Print the report as JSON.`,
  async run(argv) {
    const { values } = parse(argv, {
      config: { type: 'string' },
      kernel: { type: 'string' },
      json: { type: 'boolean' },
    })

    const runtime = createJudgeRuntime({
      kernelPath: values.kernel ? String(values.kernel) : undefined,
      providerPath: values.config ? String(values.config) : undefined,
    })

    const ledgerPath = runtime.kernel.ledger.path ?? null
    const ledgerRecords = runtime.ledger ? runtime.ledger.count() : 0
    const report = {
      package: `${PACKAGE_NAME} ${VERSION}`,
      node: process.version,
      platform: process.platform,
      provider: {
        path: runtime.paths.provider,
        configured: runtime.provider !== null,
        name: runtime.provider?.providerName ?? null,
        model: runtime.provider?.model ?? null,
        protocol: runtime.provider?.protocol ?? null,
        endpoint: runtime.provider?.endpoint ?? null,
        auth: runtime.provider
          ? `${runtime.provider.authHeader}${runtime.provider.authScheme ? ` (${runtime.provider.authScheme})` : ''}`
          : null,
        keySource: runtime.provider?.apiKeySource ?? null,
      },
      kernel: {
        path: values.kernel ? String(values.kernel) : DEFAULT_KERNEL_CONFIG_PATH,
        modes: runtime.kernel.modes,
        routes: runtime.kernel.routes,
      },
      judges: runtime.judgeNames,
      tiers: runtime.engine.tiers,
      ledger: { path: ledgerPath, records: ledgerRecords },
      problems: runtime.problems,
    }

    if (values.json) {
      out(JSON.stringify(report, null, 2))
      return runtime.problems.length === 0 ? 0 : 1
    }

    out(report.package + `  (node ${report.node}, ${report.platform})`)
    out()
    out('Provider')
    out(`  record:     ${report.provider.path}`)
    if (report.provider.configured) {
      out(`  provider:   ${report.provider.name}`)
      out(`  model:      ${report.provider.model}`)
      out(`  protocol:   ${report.provider.protocol}`)
      out(`  endpoint:   ${report.provider.endpoint}`)
      out(`  auth:       ${report.provider.auth}`)
      out(`  key:        ${report.provider.keySource}; value hidden`)
    } else {
      out('  status:     not usable — see the problems below')
    }

    out()
    out('Judges')
    if (report.judges.length === 0) {
      out('  (none) — every decision point will return its fallback')
    } else {
      for (const name of report.judges) {
        out(`  ${name}${runtime.engine.tiers.includes(name) ? '' : ' (not in the tier order)'}`)
      }
    }
    out(`  tiers:      ${report.tiers.join(' -> ') || '(none)'}`)

    out()
    out('Decision points')
    out(`  modes:      ${JSON.stringify(report.kernel.modes)}`)
    if (Object.keys(report.kernel.routes).length > 0) {
      out(`  routes:     ${JSON.stringify(report.kernel.routes)}`)
    }

    out()
    out('Ledger')
    out(`  path:       ${report.ledger.path ?? '(not configured)'}`)
    if (report.ledger.path) out(`  records:    ${report.ledger.records}`)

    if (report.problems.length > 0) {
      out()
      for (const problem of report.problems) fail(`problem: ${problem}`)
      return 1
    }
    return 0
  },
}
