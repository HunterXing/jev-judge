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
| npm publication (optional, recommended) | ⬜ prebuilt installs skip the build-script approval; `release.yml` publishes on a tag via trusted publishing, or with an `NPM_TOKEN` secret for the bootstrap |

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

# 2. Bootstrap the first npm release, then let CI own every release after it
npm login && npm publish   # see "Publishing with CI" below for why this one is manual

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

## Listing without npm

npm is optional for the registry: entries point at a **repository**, and
installing from GitHub works exactly as installing from the registry does. The
plugin's description asks readers for neither.

```sh
dsh plugin --profile <profile> add github:HunterXing/jev-judge
```

This works without a build-script approval because the package has no build step
and no runtime dependencies — a `prepare` script would have made pnpm ask the
user to allowlist code execution before the plugin could install.

For storefronts that prefer a prebuilt artifact, attach a version-free tarball
to a GitHub Release and name it in the entry:

```yaml
tarball: https://github.com/HunterXing/jev-judge/releases/latest/download/dsh-jev-judge.tgz
```

The asset name must not carry the version: `latest/download/` resolves `latest`
at request time but takes the filename literally, so a versioned name works the
day it is submitted and 404s after the next release. Pin the tag instead if the
filename should keep its version.

What npm adds when it is used: a download count in the market, a host
compatibility badge (storefronts read `engines.dsh` from the npm manifest), and
`npx -y dsh-jev-judge mcp` as a zero-clone way to wire the MCP server into a
client. None of them change whether the plugin can be found or installed.

## Publishing with CI

`.github/workflows/release.yml` publishes on a version tag. There is no npm token
in this repository, by design: the workflow authenticates with npm's
[trusted publishing](https://docs.npmjs.com/trusted-publishers/) — GitHub's OIDC
identity is exchanged for a short-lived credential that is scoped to this
workflow and cannot be extracted or reused. npm also attaches a **provenance
attestation** automatically on that path, so every release carries a signed
statement of which commit and workflow built it.

```sh
git tag v0.1.1 && git push origin v0.1.1     # that is the whole release
```

The workflow checks that the tag matches `package.json`, runs the test suite the
CI workflow runs, and only then publishes. It refuses to publish anything the
push was allowed to break.

### The first release is manual, on purpose

A trusted publisher is configured on the **package's own settings page**, and a
package that has never been published has no settings page. So the bootstrap is
one manual command, after which CI owns every release:

```sh
npm login
npm publish        # first release only
```

Then register the publisher at
`https://www.npmjs.com/package/dsh-jev-judge/settings` → **Trusted Publisher** →
GitHub Actions, with:

| Field | Value |
|---|---|
| Organization or user | `HunterXing` |
| Repository | `jev-judge` |
| Workflow filename | `release.yml` (the filename, not the path) |
| Allowed actions | `npm publish` (leave `npm stage publish` too if you want to try staged releases) |

Requirements for that path, straight from npm's documentation: **npm CLI ≥ 11.5.1
and Node ≥ 22.14** — the workflow installs the newest npm for exactly this reason
— on GitHub-hosted runners. A new trusted publisher configuration must complete
its first successful publish **within two days** of being created, or it expires
and has to be recreated.

Once the publisher works, npm's own advice is to restrict token access
(`Settings → Publishing access → Require 2FA and disallow tokens`) so the OIDC
path is the only way in.

### If the very first release must also be automatic

npm refuses every publish that is neither 2FA-approved nor made with a granular
token that explicitly bypasses 2FA — a plain `npm login` session satisfies
neither, and the error says so:

```console
npm error 403 Forbidden - PUT https://registry.npmjs.org/<package>
npm error Two-factor authentication or granular access token with bypass 2fa
npm error enabled is required to publish packages.
```

So publish the bootstrap with a granular token, and let the workflow do it:

1. npmjs.com → **Access Tokens** → **Generate New Token** → **Granular Access
   Token**. Name it, set an expiry, give it **Read and write** on all packages
   (a token cannot be scoped to a package that does not exist yet), and enable
   **bypass 2FA**.
2. Store it as a repository secret — pasted at the prompt, never in a file:

   ```sh
   gh secret set NPM_TOKEN
   ```
3. Tag and push. `release.yml` picks the token up automatically; no edit needed.

The same token can publish every later release, but it should not have to: once
trusted publishing is configured, delete the secret and the releases carry
provenance without a long-lived credential.

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
