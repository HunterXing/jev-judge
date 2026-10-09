# Wiring the kernel into an agent

The kernel is host-free. What changes between agents is only **how a judgment is
reached** and **what a verdict is allowed to do**, which is what each adapter
below encodes.

Three adapters ship, and they cover the field:

| Adapter | Reaches | What a verdict can do |
|---|---|---|
| DeepSeek Harness plugin (`dsh-jev-judge/host`) | DSH, through `dsh.bundle` | Register a tool; gate a tool call; rewrite a result; continue a turn |
| MCP server (`jev-judge mcp`) | Any MCP client — OpenCode, Cursor, Claude Code, Codex, Cline | Expose three tools the model calls on purpose |
| Command hooks (`jev-judge hook <dialect>`) | Claude Code, Codex, and DeepSeek Harness through its `dsh-hooks-claude-code` / `dsh-hooks-codex` bridges | Block a call, attach context, continue a stopped turn |

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
