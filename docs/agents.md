# Wiring the kernel into an agent

The kernel is host-free. What changes between agents is only **how a judgment is
reached** and **what a verdict is allowed to do**, which is what each adapter
below encodes.

Three adapters ship, and they cover the field:

| Adapter | Reaches | What a verdict can do |
|---|---|---|
| DeepSeek Harness plugin (`dsh-jev-judge/host`) | DSH, through `dsh.bundle` | Register a tool; gate a tool call; rewrite a result; continue a turn |
| MCP server (`jev-judge mcp`) | Any MCP client — OpenCode, Cursor, Claude Code, Codex, Cline, MiniMax Code, Hermes | Expose three tools the model calls on purpose |
| Command hooks (`jev-judge hook <dialect>`) | Claude Code, Codex, and DeepSeek Harness through its `dsh-hooks-claude-code` / `dsh-hooks-codex` bridges | Block a call, attach context, continue a stopped turn |

## Will it work with the agent you use?

Two capabilities decide it, and you can check either one in a minute:

1. **Can it start an MCP stdio server?** Look for an MCP entry in its settings or
   an `mcp` subcommand. That is the common case — if it is there, the three tools
   appear, and nothing else is needed.
2. **Does it run command hooks in the Claude Code dialect?** That is what reaches
   the deeper points (result screening, turn nudges). DSH does this through its
   own bridges; other clients usually do not.

An agent with neither can still use the kernel the plain way, as long as the
model can run a command: `jev-judge judge` asks one typed question and prints the
probabilities, which is a tool call in any agent that has a shell.

What none of this helps is an agent that cannot call a tool at all: the value is
in the loop — a result, a tool call, a turn — and a chat-only assistant has none
of those to attach to.

| Agent | How it attaches | Verified |
|---|---|---|
| DeepSeek Harness | `dsh.bundle` plugin, all seven points | ✅ installed into a booted profile, and a live session's own tool result was screened by it |
| Claude Code | command hooks + MCP | ✅ a real `claude -p` session ran the hooks and repeated the injected brief back |
| Hermes | `hermes mcp add jev-judge --command node --args <path>/src/cli.js mcp` | ✅ connected, three tools discovered, saved to `~/.hermes/config.yaml` |
| OpenCode | MCP server in `~/.config/opencode/opencode.json` | documented from that client's own config format |
| Codex | MCP in `~/.codex/config.toml`; `~/.codex/hooks.json` for hooks | documented from that client's own config format |
| MiniMax Code (`mcode`) | project `.mcp.json` with `mcpServers` — the same shape Claude Code uses | config file confirmed from its own bundle; handshake not run |
| Cursor, Cline, anything else with MCP | the stdio server below | the wire is standard MCP |

An agent whose name is not on this list is not a gap in the kernel: if it speaks
MCP stdio, it is the same three lines of configuration.

Everything needs the same private provider record. Validate it first — no network
is used:

```sh
jev-judge verify          # reports provider, endpoint, model, auth; never the key
jev-judge doctor          # what will actually happen: judges, modes, ledger
```

If a command below says `jev-judge` and you have not installed the package
globally, replace it with `node /path/to/jev-judge/src/cli.js`. Nothing here needs
a build step.

---

## DeepSeek Harness

The package is a **bundle**: an npm package whose `package.json` declares
`dsh.bundle.patch`, applied as one layer of a profile.

```sh
dsh plugin --profile <profile> add dsh-jev-judge        # from the registry
dsh plugin --profile <profile> add /path/to/jev-judge   # from a checkout
```

Check the composition before booting, then boot:

```sh
dsh --profile <profile> --dump-config   # shows "# == dsh-jev-judge"
dsh --profile <profile>
```

Or install it from the Web GUI: **Settings → Plugins** (bundles accept a registry
name, a git address, or a local path), and find it in the market under
[Development & Runtime](https://awesome-dsh-plugin.com).

### What the plugin row configures

Every value below is the default in `cordis.patch.yml`, and a later layer (your
profile's `cordis.patch.yml`, the home layer, `--patch`) overrides them per row:

```yaml
- id: judge-kernel
  name: dsh-jev-judge/host
  config:
    modes:
      default: shadow          # nothing acts until you say so
      tool.admission: active   # long tool output is filtered before you read it
      tool.injection: active   # fetched content is screened for instructions
      turn.completion: active  # a "done" with nothing verifying it is nudged once
      turn.continue: active    # a turn that stopped short is sent back
      memory.capture: active   # a correction becomes a lesson
      tool.risk: shadow        # this verdict can loosen policy: it may not start active
    ledger:
      path: ~/.dsh/judge-ledger.ndjson
```

### What the plugin does at each extension point

| Extension point | Decision point | What the model sees |
|---|---|---|
| `ctx.tools.register` | `judge.items` | A `judge_items` tool: many items, one question, one probability each |
| `tools/pre-execute` | `tool.risk` | Only rule-flagged commands are judged; an unvouched call raises an approval, a vouched one proceeds |
| `tools/post-execute` | `tool.injection` | Passages that read as instructions are replaced by a note; the full result is spilled to `$DSH_HOME/jev-judge/spill/` |
| `tools/post-execute` | `tool.admission` | Only the chunks that matter are kept, with a note naming the spill file |
| `agent/turn-stopping` | `turn.completion`, `turn.continue` | At most one completion nudge and two continuation nudges per turn; an irreversible next step is never pushed |
| `agent/turn-stopping` | `memory.capture` | A correction is appended to `$DSH_HOME/jev-judge/lessons.md` |

Two guarantees worth stating plainly:

- **A blocked result is never rewritten.** The plugin takes the downstream
  decision first and only transforms an `accept`.
- **Nothing here throws into a turn.** Every listener is fail-open; a judgment
  that cannot be made leaves the harness exactly as it was.

---

## Claude Code

Copy-paste into `~/.claude/settings.json` (or a project's `.claude/settings.json`).
The same file can serve a team, and the hook command can be any executable:

```json
{
  "hooks": {
    "SessionStart": [
      { "hooks": [{ "type": "command", "command": "jev-judge hook claude-code" }] }
    ],
    "PreToolUse": [
      { "matcher": "Bash", "hooks": [{ "type": "command", "command": "jev-judge hook claude-code" }] }
    ],
    "PostToolUse": [
      { "matcher": "WebFetch", "hooks": [{ "type": "command", "command": "jev-judge hook claude-code" }] },
      { "matcher": "Bash", "hooks": [{ "type": "command", "command": "jev-judge hook claude-code" }] }
    ],
    "Stop": [
      { "hooks": [{ "type": "command", "command": "jev-judge hook claude-code" }] }
    ]
  }
}
```

What each event maps to: `SessionStart` → a short kernel brief; `PreToolUse` →
`tool.risk`, and only for commands a rule flagged; `PostToolUse` →
`tool.injection` then `tool.admission`; `Stop` → `turn.completion`,
`turn.continue` and `memory.capture`.

Add the MCP tools as well if you want the model to call judgments on purpose:

```sh
claude mcp add jev-judge -- npx -y dsh-jev-judge mcp
```

The hooks dialect cannot rewrite a tool result, so a screened result is handed
over as added context instead: you see the kept passages plus the note, and the
original stays in the transcript. When every passage was withheld the result is
blocked, and the note is the reason.

---

## Codex

`~/.codex/hooks.json` uses the same shape as Claude Code, so the file above works
unchanged with `jev-judge hook codex`.

MCP, in `~/.codex/config.toml`:

```toml
[mcp_servers.jev-judge]
command = "npx"
args = ["-y", "dsh-jev-judge", "mcp"]
```

---

## OpenCode

MCP, merged into `~/.config/opencode/opencode.json`:

```json
{
  "mcp": {
    "servers": {
      "jev-judge": {
        "type": "local",
        "command": ["npx", "-y", "dsh-jev-judge", "mcp"],
        "disabled": false
      }
    }
  }
}
```

---

## MiniMax Code (`mcode`)

MiniMax Code reads a **project** `.mcp.json` — the same file name and shape Claude
Code uses, with an `mcpServers` map:

```json
{
  "mcpServers": {
    "jev-judge": {
      "command": "node",
      "args": ["/path/to/jev-judge/src/cli.js", "mcp"]
    }
  }
}
```

Put it at the root of the project you run `mcode` in.

## Hermes

Hermes has an MCP client of its own:

```sh
hermes mcp add jev-judge --command node --args /path/to/jev-judge/src/cli.js mcp
hermes mcp test jev-judge     # reports the three tools it discovered
hermes mcp list
hermes mcp remove jev-judge   # to undo
```

The `add` command connects first and asks whether to enable the tools it found;
answer `y`, or pipe it: `printf 'y\n' | hermes mcp add …`. The configuration is
saved to `~/.hermes/config.yaml`.

## Any other MCP client

Anything that can start a stdio server can use the kernel:

```json
{
  "mcpServers": {
    "jev-judge": {
      "command": "npx",
      "args": ["-y", "dsh-jev-judge", "mcp"]
    }
  }
}
```

The server offers three tools, and they are also usable from a shell — any agent
that can run a command can ask a typed question:

```sh
jev-judge judge \
  --state '{"task":"fix the login 500","passage":"2026-10-08 INFO healthcheck ok"}' \
  --question '{"keep":{"type":"boolean","instructions":"Does `passage` matter for `task`?"}}'
# keep: 0.0500
```

Exit code 0 means a judge answered; exit code 1 means nothing answered, which is
deliberately different from an answer of "no".

---

## The Agent Skill

`skills/jev-judge/SKILL.md` ships inside the package so an agent knows *when* to
hand a judgment over instead of reading everything. Install it into whichever
skill directory the client reads:

```sh
jev-judge install-skill --agent claude-code    # ~/.claude/skills/jev-judge
jev-judge install-skill --agent codex
jev-judge install-skill --agent opencode
jev-judge install-skill --agent agents         # ~/.agents/skills (the interop convention)
```

It pairs with [`typesafe-ai-jev-skill`](https://github.com/HunterXing/typesafe-ai-jev-skill):
that one owns the provider configuration and how to model a judgment, this one
owns running the kernel and asking many items at once.
