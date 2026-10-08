# dsh-jev-judge

**English** | [简体中文](README.zh.md)

A judgment kernel for coding agents. High-frequency, low-value calls — does this
tool output matter, did anything actually verify that claim, does this page carry
instructions aimed at the model, did the user really ask for this command — go to
a small Jev judge instead of the main model. The agent keeps its context and its
tokens for the work that needs reasoning.

> **Status: work in progress.** The kernel, the decision points and the host
> adapters are being built in the open. This README states only what the code in
> this repository does today; it is completed as each subsystem lands.

## Why a kernel

An agent loop makes many small judgments per run. Handing every one to the main
model is slow and expensive; encoding every one as a fixed rule breaks on real
input. This package is the middle layer: a bounded question over a small state,
answered by a small judge, consumed by code that owns the thresholds, the
fallbacks and the final action.

The design follows [`mu`](https://github.com/qybaihe/mu), which loads a judgment
kernel into the `pi` coding agent: decision points declared with a version and a
policy, `off` / `shadow` / `active` rollout modes, a tier cascade where a cheap
judge takes the easy questions, and a ledger that records every verdict so a new
decision point earns `active` from real sessions. See
[ATTRIBUTION.md](ATTRIBUTION.md).

The provider side is not baked in. This package reads the same private
configuration as the [`typesafe-ai-jev-skill`](https://github.com/HunterXing/typesafe-ai-jev-skill)
Agent Skill, so the API root, model, endpoint and authentication stay a user
setting rather than a hardcoded service.

## Install

Work in progress — the install paths below become live as their subsystem lands.

| Host | How it will be reached |
| --- | --- |
| DeepSeek Harness | `dsh plugin --profile <profile> add dsh-jev-judge` (a `dsh.bundle` plugin layer) |
| Claude Code | command hooks in `settings.json` |
| Codex | command hooks in `~/.codex/hooks.json` |
| Any MCP client (OpenCode, Cursor, …) | `jev-judge mcp` over stdio |

## Provider configuration

The kernel never asks for a key in chat and never writes one into a repository.
It reads, in order:

1. `JEV_SKILL_CONFIG` — a path to your private provider configuration.
2. `<agent-home>/.config/typesafe-ai-jev-skill.json`

The schema is the one the Agent Skill documents, unchanged: `providerName`,
`baseUrl`, `model`, `apiKey` or `apiKeyEnv`, `protocol`, `endpointPath`,
`authHeader`, `authScheme`, `extraHeaders`, `timeoutSeconds`. A `systemone`
provider answers typed `noul` / `choice` / `score` questions; a `chat` provider is
reached only as a documented lower-fidelity fallback.

## Design rules

- **A verdict never decides that the agent should ask the user something.** It
  changes what the model sees, or whether it keeps working.
- **No verdict means the behaviour you would have had without this package.**
  Every decision point carries a deterministic fallback.
- **Small state, bounded question.** The judge reads summaries and metadata, not
  bulk text; a `choice` question always carries an escape answer.
- **Shadow first.** A decision point whose verdict can only loosen policy starts
  in `shadow` and is switched to `active` with numbers from a real ledger.
- **Fail open.** A judge that is slow, unreachable or unsure yields the fallback,
  never a stalled agent loop.

## Development

No runtime dependencies and no build step, on purpose: the package loads straight
from a checkout, so `dsh plugin add <repo>` needs no build-script approval.

```sh
node --test
node src/cli.js --help
```

## License

[MIT](LICENSE). TypeSafe, System One and Jev are the property of their respective
rights holders; this project is not affiliated with them.
