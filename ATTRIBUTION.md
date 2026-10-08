# Attribution

`dsh-jev-judge` is an independent implementation of a judgment kernel for
coding agents. It adapts ideas and, where noted, code structure from the
projects below. Names and trademarks belong to their respective rights holders;
this project is not affiliated with any of them.

## mu (judgment kernel design)

- Source: <https://github.com/qybaihe/mu>
- License: MIT (`Copyright (c) 2025 Mario Zechner`; mu is a fork of
  [pi](https://github.com/earendil-works/pi), whose license it keeps)
- Adapted: the decision-point contract (`defineDecision`: id, version, questions,
  capabilities, cache impact, latency, state builder, policy, fallback), the
  `off` / `shadow` / `active` rollout modes, the judge tier cascade where a later
  judge only sees what an earlier one left uncertain, the ledger record shape,
  and the semantics and wording discipline of the individual decision points
  (`tool.admission`, `tool.injection`, `tool.risk`, `turn.completion`,
  `turn.continue`, `memory.capture`, `judge.items`).
- Changed: mu hardcodes its judge services and is coupled to pi's extension API.
  This project takes the provider-neutral configuration contract from
  `typesafe-ai-jev-skill` instead, keeps the kernel free of any host dependency,
  and reaches hosts through three thin adapters (DeepSeek Harness plugin, MCP
  stdio server, Claude Code / Codex command hooks).

## typesafe-ai-jev-skill (provider contract)

- Source: <https://github.com/HunterXing/typesafe-ai-jev-skill>
- License: MIT
- Adapted: the private provider configuration schema and its discovery order
  (`JEV_SKILL_CONFIG`, then `<agent-home>/.config/typesafe-ai-jev-skill.json`),
  the offline validation rules, and the safe-failure behavior of the verifier
  (never print the key, never echo a provider error body).

## TypeSafe, System One, Jev

The System One request/response contract implemented in `src/kernel/judges/`
follows the public TypeSafe documentation (<https://docs.typesafe.ai/llms.txt>).
TypeSafe, System One, Jev, and any related marks belong to their rights holders.
