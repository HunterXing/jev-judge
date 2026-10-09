# Publishing to the DeepSeek Harness plugin market

The market inside DeepSeek Harness (`dshmarket`) reads a curated list at
[`awesome-dsh-plugin.com`](https://awesome-dsh-plugin.com), generated from one
YAML file per plugin in the
[`awesome-dsh-plugin`](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin)
repository. This file is the checklist, and it is written so that the remaining
steps are the user's to run rather than something the repository has already
claimed to have done.

## What the registry requires, and where this repository stands

| Requirement | Status |
|---|---|
| `package.json` declares `dsh.bundle` | ✅ `"dsh": { "bundle": { "patch": "./cordis.patch.yml" } }` |
| A `cordis.patch.yml` next to it | ✅ inserts the `judge-kernel` row |
| Real, working code — not a placeholder | ✅ 208 tests, verified against a real harness boot ([`verification.md`](verification.md)) |
| Repo at least one day old | ⬜ the GitHub repository has to exist first |
| The `dsh-plugin` topic on the repository | ⬜ one command, below |
| A description that is accurate about the code | ✅ see the draft entry; every claim is in the source |
| `engines.dsh` or lockstep peers for the host badge | ✅ `"engines": { "dsh": ">=0.2.1-alpha.1 <0.3.0-0" }` |
| Official `@deepseek-ai/*` packages as peers, not dependencies | ✅ none are imported at runtime, so none are declared |
| npm publication (optional, recommended) | ⬜ prebuilt installs skip the build-script approval |

## One file is the whole submission

The entry goes in `data/plugins/HunterXing__jev-judge.yml`:

```yaml
url: https://github.com/HunterXing/jev-judge
name: HunterXing/jev-judge
category: dev
description:
  en: A judgment kernel for coding agents — long tool output, copied instructions, thin completion claims and risky commands go to a small Jev judge, and every verdict is recorded in a ledger.
  zh: 面向编码 Agent 的判定内核：长工具输出、夹带的指令、"已完成"的空话与高风险命令交给一个小 judge 判定，每次判定都记入账本。
```

`category` is `dev` (Development & Runtime) because the plugin is developer
tooling rather than a capability pack; maintainers re-file a near miss rather
than reject it, so the exact choice is not load-bearing.

The description is one sentence and every clause of it is a behaviour with a test:
`tool.admission` (`src/decisions/tool-admission.js`), `tool.injection`
(`src/decisions/tool-injection.js`), `turn.completion`
(`src/decisions/turn-completion.js`), `tool.risk` (`src/decisions/tool-risk.js`)
and the ledger (`src/kernel/ledger.js`). No numbers, no superlatives — the guide
is explicit that an overstated claim is the one thing that gets a good plugin
sent back.

## The remaining steps

```sh
# 1. Publish the repository (one day before the market PR, so the age bar passes)
gh repo create HunterXing/jev-judge --public --source . --remote origin --push
gh repo edit HunterXing/jev-judge --add-topic dsh-plugin

# 2. Publish to npm (prebuilt installs need no build-script approval)
npm login
npm publish          # `prepack` is not needed: the package has no build step

# 3. Submit the entry (one file, at most three entries per PR)
gh repo fork awesome-dsh-plugin/awesome-dsh-plugin --clone
cd awesome-dsh-plugin
mkdir -p data/plugins
$EDITOR data/plugins/HunterXing__jev-judge.yml   # the YAML above
git checkout -b add-jev-judge
git add data/plugins/HunterXing__jev-judge.yml
git commit -m "Add HunterXing/jev-judge"
gh pr create --title "Add HunterXing/jev-judge" --body "A judgment kernel for coding agents."
```

After the merge the website rebuilds itself, and the plugin appears in
**Settings → Plugin Market** inside DeepSeek Harness.

## Screenshots

None are declared. The market falls back to images found in the repository
README, and this repository ships none — a screenshot that shows something the
code does not do would be worse than an empty card. The honest candidates, once
someone runs them on a machine with the GUI open:

- the Plugins page with `dsh-jev-judge` installed, and
- a session where `judge_items` returned a selection.

Declare them in `screenshots.json` next to `package.json` (1–8 relative paths,
inside the repository), and remember that paths relative to that file break
visibly in this repository if a file is renamed — which is why the market asks
for them here rather than in the registry.

## Version compatibility

`engines.dsh` is `>=0.2.1-alpha.1 <0.3.0-0`. A peer range without an explicit
prerelease branch silently excludes every prerelease harness build, which is why
the floor names the prerelease it was verified against
([`verification.md`](verification.md)) instead of a broad-looking range that
matches nothing.

Nothing in the package imports `@deepseek-ai/*` at runtime, so there are no host
peers to resolve and no version-exemption to request. The plugin talks to the
harness through the `ctx` it is handed, and to the harness's schema subset
through `tests/tool-schema.test.mjs`.
