# dsh-jev-judge

**English** | [简体中文](README.zh.md)

A judgment kernel for coding agents. The small, frequent calls an agent makes —
does this tool output matter, did anything actually verify that claim, does this
page carry instructions aimed at the model, did the user really ask for this
command — go to a small judge instead of the main model. The agent keeps its
context and its tokens for the work that needs reasoning.

It runs in **DeepSeek Harness** as a plugin bundle, in **Claude Code**, **Codex**
and **OpenCode** through command hooks or MCP, and anywhere else that can start
an MCP server or run a command.

## Why a kernel

An agent loop makes dozens of small judgments per run. Handing every one to the
main model is slow and expensive; encoding every one as a fixed rule breaks on
real input. This package is the layer in between: one bounded question over a
small state, answered by a small judge, consumed by code that owns the
thresholds, the fallbacks and the final action.

The design follows [`mu`](https://github.com/qybaihe/mu), which loads a judgment
kernel into the `pi` coding agent. What this project adds is reach: the kernel is
host-free, so the same decision points run in agents that `mu` does not cover.
[`docs/mu-analysis.md`](docs/mu-analysis.md) is the study, including the wording
discipline and the measurements behind it.

## Install

### DeepSeek Harness

```sh
dsh plugin --profile <profile> add dsh-jev-judge
dsh --profile <profile> --dump-config   # shows the layer
```

Or install it from **Settings → Plugins** in the Web GUI, by registry name, git
address or local path.

### Everything else

- **Claude Code / Codex** — command hooks in `settings.json` / `hooks.json`.
- **OpenCode, Cursor, Claude Code, Codex, Cline** — the MCP server.

```sh
claude mcp add jev-judge -- npx -y dsh-jev-judge mcp
```

[`docs/agents.md`](docs/agents.md) has the exact configuration for each host and
what a verdict is able to do in each.

## What it decides

| Decision point | The question | Default |
|---|---|---|
| `judge.items` | One yes/no question asked of many items — hundreds of log lines, files or findings, without reading them all | on when called |
| `tool.admission` | Which chunks of a long tool result are needed for this task, so the rest never enters the context | `active` |
| `tool.injection` | Which passages of fetched content read as instructions aimed at the model rather than material for a reader | `active` |
| `turn.completion` | Does this "it's done" claim have anything that verified it | `active` |
| `turn.continue` | Did the turn stop in front of a step it announced, or ask for a go-ahead it already had | `active` |
| `memory.capture` | Is this message a correction worth keeping, or just the next task | `active` |
| `tool.risk` | For a command the rules already flagged: did the user actually ask for this | `shadow` |

Every point carries a deterministic fallback equal to the behaviour without this
package, and every verdict is written to a ledger — which is how a point earns
`active` from real sessions instead of from optimism.

`tool.risk` starts in `shadow` on purpose: its verdict can only loosen policy, so
it has to earn that from your own ledger before it is allowed to.

## Configure

The provider is a private record you own, in the format published by the
[`typesafe-ai-jev-skill`](https://github.com/HunterXing/typesafe-ai-jev-skill)
Agent Skill:

```text
$JEV_SKILL_CONFIG  →  ~/.config/typesafe-ai-jev-skill.json
```

```json
{
  "providerName": "your-provider",
  "baseUrl": "https://api.your-provider.example",
  "model": "jev",
  "apiKeyEnv": "JEV_API_KEY",
  "protocol": "systemone",
  "endpointPath": "v1/systemone",
  "authHeader": "Authorization",
  "authScheme": "Bearer",
  "timeoutSeconds": 30
}
```

```sh
jev-judge verify    # offline; reports the contract, never the key
jev-judge doctor    # what will happen: judges, modes, ledger
```

Kernel settings, all optional, live in `~/.config/jev-judge/kernel.json`:

```json
{
  "modes": { "default": "shadow", "tool.admission": "active" },
  "routes": { "turn.continue": ["jev"] },
  "tiers": ["jev"],
  "ledger": { "path": "~/.config/jev-judge/ledger.ndjson", "recordState": false },
  "options": { "judge.items": { "maxItems": 20 } },
  "timeoutMs": 8000
}
```

`jev-judge ledger` reads the ledger; `--json` prints the records as stored.

## Design rules

- **A verdict never decides that the agent should ask the user something.** It
  changes what the model sees, or whether it keeps working.
- **No verdict means the behaviour you would have had without this package.**
- **Small state, bounded question.** The judge reads summaries and metadata, not
  bulk text; a `choice` question always carries an escape answer.
- **One predicate per question.** Compound questions are split and combined in
  the policy — measured, not assumed ([`docs/verification.md`](docs/verification.md)).
- **Shadow first.** A point whose verdict can only loosen policy starts there.
- **Fail open.** A judge that is slow, unreachable or unsure yields the fallback,
  never a stalled agent loop.
- **The key never leaves your private record** — not into a log, a ledger record,
  an error message, or a chat.

## Measured

From [`docs/verification.md`](docs/verification.md), on a real 81-line test log
with two failures, judged by the live provider 20 items per call:

- 81 lines → 5 selected, **191 of 3047 bytes (6.3%)** need reading, 7.9 s;
- the same log with the question aimed at fixing rather than triage selected the
  assertion message and the error text instead of the summary line.

## Development

No runtime dependencies and no build step, on purpose: the package loads straight
from a checkout, so `dsh plugin add <path>` needs no build-script approval.

```sh
node --test              # 208 tests, no network
node src/cli.js --help
```

Releases are cut by pushing a version tag: `.github/workflows/release.yml`
publishes to npm through trusted publishing (no token in the repository) after
the same suite passes. See [`docs/market.md`](docs/market.md).

## License

[MIT](LICENSE). TypeSafe, System One and Jev belong to their respective rights
holders; this project is not affiliated with them. The judgment-kernel design is
adapted from [`mu`](https://github.com/qybaihe/mu) (MIT) — see
[ATTRIBUTION.md](ATTRIBUTION.md).
