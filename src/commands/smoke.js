/**
 * `jev-judge smoke` — one real call, to prove the endpoint answers.
 *
 * It sends the smallest typed question there is and reports whether a numeric
 * answer came back. It costs money, so it runs only with `--yes`: a smoke test
 * that fires itself is how a bill arrives from a CI job nobody was watching.
 *
 * A `chat` record is checked for reachability only, and the output says so — a
 * chat gateway answering proves nothing about typed decision support.
 *
 * @module dsh-jev-judge/commands/smoke
 */

import { isJudgeError } from '../kernel/errors.js'
import { ChatJsonJudge } from '../kernel/judges/chat-json.js'
import { SystemOneJudge } from '../kernel/judges/typesafe.js'
import { loadProviderConfig } from '../kernel/config.js'
import { fail, out, parse } from './support.js'

/** The question the smoke test asks, mirroring the Agent Skill's verifier. */
export const SMOKE_QUESTION_ID = 'is_configuration_valid'

/** @type {import('../cli.js').Command} */
export const command = {
  summary: 'Send one real request to the provider (costs money; needs --yes).',
  usage: `smoke — send one real request to the provider (costs money).

Options:
  --yes            Required: acknowledge that the call may be billed.
  --config <path>  Use another provider record.
  --json           Print the result as JSON.`,
  async run(argv) {
    const { values } = parse(argv, {
      yes: { type: 'boolean' },
      config: { type: 'string' },
      json: { type: 'boolean' },
    })

    if (!values.yes) {
      fail('Refusing to send a billable request without --yes.')
      fail('Smoke sends one minimal typed question and may incur provider charges.')
      return 2
    }

    const { config, path } = loadProviderConfig({
      path: values.config ? String(values.config) : undefined,
    })

    const judge =
      config.protocol === 'chat'
        ? new ChatJsonJudge({
            apiKey: config.apiKey,
            model: config.model,
            baseUrl: config.baseUrl,
            endpointPath: config.endpointPath,
            authHeader: config.authHeader,
            authScheme: config.authScheme,
            extraHeaders: config.extraHeaders,
            timeoutMs: config.timeoutSeconds * 1000,
          })
        : new SystemOneJudge({
            apiKey: config.apiKey,
            model: config.model,
            baseUrl: config.baseUrl,
            endpointPath: config.endpointPath,
            authHeader: config.authHeader,
            authScheme: config.authScheme,
            extraHeaders: config.extraHeaders,
            timeoutMs: config.timeoutSeconds * 1000,
          })

    const startedAt = Date.now()
    try {
      const response = await judge.evaluate({
        state: 'Provider configuration smoke test.',
        questions: {
          [SMOKE_QUESTION_ID]: {
            type: 'boolean',
            instructions: 'Is this a valid System One configuration test?',
          },
        },
      })
      const answer = response.answers[SMOKE_QUESTION_ID]
      const latencyMs = Date.now() - startedAt
      if (answer === undefined) {
        fail(`Provider answered without a usable typed answer after ${latencyMs}ms.`)
        return 1
      }
      if (values.json) {
        out(
          JSON.stringify(
            {
              ok: true,
              configPath: path,
              protocol: config.protocol,
              model: response.modelId ?? config.model,
              [SMOKE_QUESTION_ID]: answer.probability,
              latencyMs,
              ...(response.usage ? { usage: response.usage } : {}),
            },
            null,
            2,
          ),
        )
      } else {
        out(
          `${config.protocol} reachable: model=${response.modelId ?? config.model} ` +
            `${SMOKE_QUESTION_ID}=${answer.probability.toFixed(4)} (${latencyMs}ms)`,
        )
        if (config.protocol === 'chat') {
          out('Note: a chat route proves reachability only, not typed decision support.')
        }
      }
      return 0
    } catch (error) {
      const detail = isJudgeError(error) ? `${error.kind}: ${error.message}` : String(error)
      fail(`Smoke test failed — ${detail}`)
      return 1
    }
  },
}
