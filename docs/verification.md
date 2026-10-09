# Verification record

Every claim in this project is checked against something that ran. This file
records what was run, on what, and what came back — including the two places
where real use found something the unit tests could not.

## Environment

| | |
|---|---|
| Machine | macOS, Node `v22.22.3` |
| DeepSeek Harness | `0.2.1-alpha.1` (source checkout, and the packaged desktop runtime) |
| Judge provider | a hosted System One endpoint, model `jev` — the private record at `$HOME/.config/typesafe-ai-jev-skill.json`. The provider's identity is elided in this record; everything else is as it ran. |
| Test suite | `node --test` — 208 tests, no network, no key |

## Offline: the test suite

```console
$ node --test
# tests 208
# pass 208
# fail 0
```

The suite covers the kernel contract, the thresholds, the engine's three modes,
the cascade, all seven decision points, the System One wire mapping and failure
classification, secret scrubbing, the ledger, all four CLI surfaces, and the
three adapters — including a local stand-in for the provider, so a test never
spends money and never depends on a network.

## R1 — the provider contract, offline and live

```console
$ jev-judge verify
Configuration valid.
Config:     $HOME/.config/typesafe-ai-jev-skill.json
Provider:   your-provider
Base URL:   https://api.your-provider.example
Model:      jev
Protocol:   systemone
Endpoint:   https://api.your-provider.example/v1/systemone
Auth:       Authorization (Bearer)
Key source: config file apiKey; value hidden

$ jev-judge smoke --yes
systemone reachable: model=jev is_configuration_valid=0.5100 (2036ms)
```

The endpoint speaks the typed protocol, not a chat fallback. The key is never
printed by either command.

## R2 — a real judgment, and what it saves

A TAP log from a deliberately failing test file (`node --test
--test-reporter=tap`), 81 lines / 3047 bytes, judged over the MCP adapter by the
live provider, 20 items per call.

**Run A — "does this line mean the run is not green?"**

```console
$ node /tmp/jev-mcp-client.mjs
lines judged: 81 | bytes: 3068
selected: 5 [ 'l6', 'l35', 'l40', 'l48', 'l76' ]
latencyMs: 7878 (wall 7896ms)
bytes that must be read in full without the judge: 3047
bytes the judge says matter: 191
```

Selected: both `not ok` lines, one failure-type line, the error message line, and
`# fail 2`. **191 of 3047 bytes — 6.3%**, the rest never needs to be read.

**Run B — same log, wording aimed at fixing rather than triage: "would this line
help someone understand or fix a failure?"**

```console
selected: 5 [ 'l6', 'l13', 'l35', 'l43', 'l48' ]
bytes the judge says matter: 255
```

The two lines that changed are exactly the ones that matter for a fix — the
assertion message (`expected the parser to keep the field name`) and the error
text (`TypeError: loader: cannot read property of undefined`) — while the summary
line dropped out.

Two things this measured rather than assumed:

- **Wording decides granularity.** The same log, the same judge, two questions:
  one gives you the shape of the failure, the other gives you its cause. This is
  the lesson `mu`'s own guide records, reproduced on a real log.
- **Recall is not one number.** Run A selected every line that *reports* a
  failure; it did not select every line that *explains* one, because it was not
  asked to. A caller that needs the explanation must say so in the question.

A green run was judged too (the project's own 120-line TAP output): the judge
selected **nothing**, which is the correct answer for a passing suite.

## R2b — the provider's own limit, found by using it

Judging 1284 lines in one request:

```console
reason: bad_request: judge provider answered HTTP 400
```

Sending the request directly, the provider says why:

```console
$ curl -X POST …/v1/systemone -d @24-questions.json
{"error":{"message":"at most 20 questions per call","type":"invalid_request_error","param":"questions"}}
```

`judge.items` now splits a longer list into request-sized groups
(`MAX_ITEMS = 20`, overridable per deployment through
`options["judge.items"].maxItems`), and reports how many requests it took. A
21-item list is not sent once and lost; it is sent twice and answered.

The same run also found the second tuning problem: the first judge call of a
process takes ~2.6 s, and the original 3 s inline budget turned it into "no
verdict". The default is now 8 s for an inline point and 15 s otherwise, with
`timeoutMs` in the kernel settings overriding both.

## R3 — DeepSeek Harness, installed and booted

```console
$ dsh plugin --profile jevtest add $HOME/workspace/coding/jev-judge
+ dsh-jev-judge link:$HOME/workspace/coding/jev-judge

$ dsh --profile jevtest --dump-config | grep -A 12 'dsh-jev-judge'
# == dsh-jev-judge
- id: judge-kernel
  name: dsh-jev-judge/host
  config:
    modes:
      default: shadow
      tool.admission: active
      …
```

Then a real boot of a web-backed profile carrying the bundle:

```console
$ dsh --profile jevweb --port 3478
dsh web: http://127.0.0.1:3478/?token=…
```

No plugin error, and the server answers. Because a harness boot fails as a whole
when a row cannot load, a clean boot is what proves the plugin mounted and
`apply()` ran — including the tool registration inside it.

**What this step caught.** The first real boot did fail:

```console
judge-kernel (dsh-jev-judge/host): JsonSchemaError: unsupported JSON schema:
schema.properties.items.items.properties.probability.type must be a single type string
(type arrays are not supported)
```

The harness's schema subset takes one scalar `type` and no `anyOf`; the tool's
output schema had used `type: ['number', 'null']`. That is invisible to a unit
test with a stand-in context and immediate in a real install. The schema now uses
`oneOf: [{type:'number'},{type:'null'}]`, and `tests/tool-schema.test.mjs`
re-implements the subset locally so the same mistake is a red test rather than a
broken install.

## R4 — Claude Code, hooks live

A scratch project with the hooks from [`docs/agents.md`](agents.md):

```console
$ claude -p "Reply with exactly: kernel hook test ok"
kernel hook test ok
```

The hook did not break the turn. To show it actually ran, the session was asked
what it had been told at startup:

```console
$ claude -p "In one short sentence: what is available in this session for handing
routine judgments to a small judge instead of reading everything yourself?"
jev-judge runs routine judgments (worth-reading output, AI-instructing pages,
risky commands) via judgment tool or CLI, each recorded in ledger.
```

That is the SessionStart brief, word for word: the hook ran, its output reached
the model, and the model used it.

## R5 — MCP over stdio

Both R2 runs are MCP runs: a real client spawned `node src/cli.js mcp`, sent
`initialize`, then `tools/call judge_items` over newline-delimited JSON-RPC, and
read the verdict from the response. The offline suite additionally covers the
handshake, the tool list, notifications producing no reply, unknown methods
returning `-32601`, invalid JSON returning `-32700`, and a judged call driven by
a local provider.

## R6 — two more clients

Neither of these needed a code change; both went through the MCP server.

**MiniMax Code** reads a project `.mcp.json`. A scratch project with

```json
{ "mcpServers": { "jev-judge": { "command": "node", "args": ["<repo>/src/cli.js", "mcp"] } } }
```

was handed one prompt, and the answer named exactly the three tools:

```console
$ mcode exec --cwd /tmp/mcode-mcp-test --timeout 3m "List every tool name you have available that comes from the MCP server named jev-judge."
judge_ask
judge_items
judge_ledger
```

**Hermes** has its own MCP client:

```console
$ hermes mcp add jev-judge --command node --args <repo>/src/cli.js mcp
  ✓ Connected! Found 3 tool(s) from 'jev-judge'
$ hermes mcp test jev-judge
  ✓ Connected (376ms)
  ✓ Tools discovered: 3
```

Both report the same three tools, which is what "the kernel is host-free" means
in practice: the agent changes, the decision points do not.

## R7 — two defects the first install found

Both were found by installing the released plugin into a real profile and using
it, not by the suite.

**The ledger was never written.** The bundled `cordis.patch.yml` set `modes` and
nothing else, so `kernel.ledger.path` was undefined and the engine ran with no
ledger at all — every verdict was computed and dropped. The documentation had
described the `~/.dsh/judge-ledger.ndjson` default from the start, so this was a
released configuration that did not match its own description, and it made the
advice "run in shadow and read the ledger" impossible to follow. The patch now
ships the ledger path, which is what makes a point's promotion evidence-based
rather than hopeful.

**Admission could reduce a result to a bare pointer.** A 31 KB tool result the
agent had asked for was judged chunk by chunk, nothing was kept, and the whole
result was replaced by one line naming the spill file. Recovering it cost an
extra read, and for a client with no filesystem — an MCP-only agent — the pointer
leads nowhere it can follow. The policy now keeps the head when no chunk earns
its place: the outcome degrades to `trimmed` (with `headKept: true` recorded in
the ledger) instead of to nothing. The result of a tool the agent called on
purpose is evidence, and evidence is not dropped on an inference.

### A third finding, from reading the ledger it had just written

The ledger recorded the fix above — and in doing so held 2995 characters of tool
output in its `outcome`. The module's own promise is that a record is
"comparable and countable without becoming a second copy of the user's content",
and hashing the *state* had only made that half true: `tool.admission`'s outcome
carries the chunks it kept. With `recordState` off (the default), any string over
200 characters is now cut to its head plus a length and a digest, at any depth,
and the record says how many it elided. Turning `recordState` on still keeps
everything, which is what that flag was always for.

```console
$ tail -1 ~/.dsh/judge-ledger.ndjson | jq '{point, mode, source, elidedStrings, outcome}'
{"point":"tool.admission","mode":"active","source":"judge","elidedStrings":1,
 "outcome":{"mode":"trimmed","content":"progress line… [2995 chars, sha256:…]","kept":1,"headKept":true}}
```

## What is not verified here

- **A full agent turn inside DeepSeek Harness** driving the plugin's extension
  points end to end. The listeners are covered against the real signatures in
  `tests/dsh-plugin.test.mjs`, and the plugin is proven to mount in a real boot;
  a scripted turn through the Web GUI has not been run.
- **The npm publish and the market listing**, which are the user's to run; the
  package is prepared for both (`docs/market.md`).
- **Windows.** The code paths are platform-neutral (`node:path`, `os.homedir()`),
  and nothing here has been run on win32.
