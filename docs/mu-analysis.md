# How `mu` strengthens a harness with Jev — and what this project took from it

This is the study behind `dsh-jev-judge`. It records what [`qybaihe/mu`](https://github.com/qybaihe/mu)
actually does, so the design decisions here can be checked against their source
rather than against a summary, and it records where this project deliberately
diverges.

`mu` is `pi` (a coding agent) plus a **judgment kernel** loaded as an extension,
plus a desktop application that runs both. Everything `mu` adds to `pi` lives in
`packages/kyrn-judge/`.

## The shape of the kernel

```
mu ──▶ pi ──▶ judgment kernel (packages/kyrn-judge)
                ├─ features    hook pi's events, ask a decision point, act on the verdict
                ├─ decision engine: modes, judges, fallbacks, the ledger
                └─ judges: Jev (hosted), Laya (local), classifiers, LLMs
```

A decision, end to end (`tool.injection`, which screens fetched pages):

1. A **feature** hooks a host event (`tool_result`) and cuts the text into passages.
2. It **asks a decision point** — a file under `src/decisions/` that declares an
   id and a version, the questions, the small state the judge reads, the policy
   that turns answers into an outcome, and the fallback.
3. The **engine** decides: which mode the point is in, which judge answers, how
   long to wait. A judge that is slow, down or unsure yields the fallback, with a
   reason.
4. The **ledger** records the outcome, whether it came from a judge or the
   fallback, the probabilities, the latency and the usage.
5. The feature **acts** — in `active` mode only. In `shadow` the verdict is
   recorded and nothing changes.

## The five rules every decision point follows

1. **Small state, bounded question.** The judge reads summaries and metadata, not
   bulk text, and answers yes/no, one of a few named answers, or a score.
2. **A safe fallback.** Without a verdict, the agent behaves as it would without
   the kernel.
3. **A verdict never decides that the agent should ask the user something.**
4. **Shadow first.** A decision point earns `active` with numbers from real sessions.
5. **The kernel owns the failure policy** — a provider never retries; the engine
   bounds the wait and falls back.

## The vocabulary, as implemented

`defineDecision` (`packages/kyrn-judge/src/decision.ts`) takes:

| Field | Meaning |
|---|---|
| `id`, `version` | Stable identity; the version is bumped whenever wording or policy changes, so ledger records stay comparable |
| `questions` / `questionsFor` | One map of bounded questions, or one question per candidate built from the input |
| `capabilities` | What answering takes (`classify`, `relate`, `rate`, `meta`), so a cascade can skip a judge that cannot |
| `cacheImpact` | `none`, `append-only`, or `prefix-mutating` — what acting does to the provider prompt cache |
| `latency` | `inline`, `parallel`, or `background` |
| `buildState` | Digest the input into the small state the judge reads |
| `policy` | Answers to an outcome, or `ABSTAIN` to decline |
| `fallback` | The deterministic behaviour without a judge |

Modes are `off`, `shadow`, `active`. `mu` ships **38 decision points** grouped as
Input, Context, Tools and safety, Turn, and Teamwork — `tool.admission`,
`context.forget`, `context.compact`, `memory.*`, `tool.risk`, `tool.approval`,
`tool.constraint`, `tool.injection`, `files.locate`, `judge.items`,
`turn.drift`, `turn.completion`, `turn.continue`, `goal.met`, `swarm.*`,
`hive.*` and more (`docs/reference/decision-points.md`).

## Who answers

Judges are a first-class, replaceable choice, configured in `~/.mu/agent/mu.json`:

- `tiers` — an ordered cascade. A later judge only sees the questions an earlier
  one left uncertain, so a cheap judge answers the easy ones and a hosted one
  catches the rest.
- `routes` — per decision point overrides.
- Types: `typesafe` (any service speaking System One), `http`, `llm`,
  `classifier`, `local` (Laya, a 322M local judge), `clm`.
- The key never goes in the file: `apiKeyEnv` names the environment variable.

Jev is reached through the first service whose key is set, with a free tier when
none is. Published measurements from the authors' sessions: one warm question in
about 0.3 s; 16 chunks of tool output judged in one request in 0.44 s, with the
state billed once.

## The wire contract this project implements

`SystemOneJudgeProvider` (`providers/typesafe.ts`) maps the kernel's questions onto
TypeSafe's System One protocol:

| Kernel | Wire |
|---|---|
| `boolean` | `{ type: "noul", instructions, criteria? }` → `{ noul: <probability> }` |
| `choice` | `{ type: "choice", instructions, criteria }` → `{ choice, probabilities? }` |
| `score` | `{ type: "score", instructions, criteria }` → `{ score }` |

Answers may carry `confidence`. HTTP failures are classified (401 auth, 402
payment, 403 auth-or-payment, 429 rate limit, 5xx server, other bad request), and
the error text names the service and the key's variable — never the key, never the
submitted state.

## Wording discipline, learned the hard way

`mu`'s own guide records what the numbers showed, and this project's question
wording follows it:

- One predicate per question, about what the state says, with the state's fields
  named in backticks. No lists of conditions, no "and/or", no quantifiers.
- **Split compound questions and combine them in the policy.** `turn.continue`
  asked as one question — "asks for a go-ahead on work the user already asked
  for" — scored 0.79 on a message it should have rejected; split into
  `asks_go_ahead` and `work_requested` it scored 0.29 and 0.38 there and 0.95
  where it should. The same split appears here in `turn.completion`.
- Boolean probabilities are compressed (clear cases land near 0.15 and 0.85) while
  choice distributions are sharp, so thresholds do not carry over between types.
  The kernel's usual bars are yes at 0.8 or more, no at 0.2 or less.
- A `choice` question must include an escape answer, or the judge is being forced
  to pick something that does not fit.

## Where this project diverges, and why

| `mu` | `dsh-jev-judge` | Why |
|---|---|---|
| Judge services hardcoded, key read from `mu`'s own env names | Provider record from the `typesafe-ai-jev-skill` contract: `JEV_SKILL_CONFIG`, then `~/.config/typesafe-ai-jev-skill.json` | One credential file serves the Agent Skill and the kernel; the provider stays a user setting |
| The kernel is a `pi` extension | A host-free kernel with three adapters (DeepSeek Harness plugin, MCP stdio server, command hooks) | The same decision points run in an agent that has none of `mu`'s plumbing |
| The ledger is written into the session file | NDJSON on disk, `recordState` off by default | No persistence-format change to any host, and the file is readable with `tail` and `jq` |
| 38 decision points | 7 to start (`judge.items`, `tool.admission`, `tool.injection`, `tool.risk`, `turn.completion`, `turn.continue`, `memory.capture`) | Each one has to be wired and verified in all three hosts before the next earns its place |
| A desktop app renders verdicts | `jev-judge ledger` and a `judge_ledger` tool | Reading the ledger is what a point is promoted on; a GUI is v1.1 |
| `context.forget` / `context.compact` rewrite outgoing context | Deferred to v1.1, on the host's compaction seam | See below |

### The one deliberate omission

`mu`'s `context.forget` replaces stale tool results with one-line tombstones in the
outgoing request. In DeepSeek Harness the only seam that rewrites context is the
compaction backend (`ctx.compaction`), because `agent/request` selects the model
rather than the messages. Adding a compaction backend means owning checkpoint
markers and session-format behaviour, which is a v1.1 project of its own rather
than a side effect of shipping the first seven points. `tool.risk` took that slot.

## Reading the source

Paths are relative to the `mu` repository:

- `docs/architecture.md` — the map of the pieces and a decision end to end.
- `docs/judges.md` — judge selection, tiers, the free Jev, comparing judges.
- `docs/reference/decision-points.md` — all 38 points, generated from the manifest.
- `docs/adding-a-decision-point.md` — the guide and the wording studies.
- `packages/kyrn-judge/src/decision.ts` — the engine.
- `packages/kyrn-judge/src/providers/typesafe.ts` — the System One wire.
- `kyrn/docs/` — the measurements, mostly in Chinese.
