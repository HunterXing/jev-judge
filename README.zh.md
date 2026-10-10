# dsh-jev-judge

[English](README.md) | **简体中文**

面向编码 Agent 的判定内核。让 Agent 那些高频的小判断——这段工具输出要不要读、这句"已完成"有没有被验证过、这个页面是不是夹带了针对模型的指令、这条命令用户是不是真的要跑——交给一个小 judge，而不是主模型。主模型把上下文和 token 留给真正需要推理的工作。

它在 **DeepSeek Harness** 里是一个插件包（bundle），在 **Claude Code**、**Codex**、**OpenCode** 里通过命令钩子或 MCP 接入；任何能起 MCP server 或能执行命令的 Agent 都可以用。

## 为什么需要一层判定内核

一轮 Agent 任务里有几十次小判断。全交给主模型，又慢又贵；全写成固定规则，真实输入下必然失效。这个包就是中间那层：在**小状态**上问一个**有界的问题**，由小 judge 回答，再由代码掌握阈值、回退与最终动作。

设计遵循 [`mu`](https://github.com/qybaihe/mu)——它把一个判定内核装进 `pi` 编码 Agent。本项目补的是**覆盖面**：内核不依赖任何宿主，所以同一批判定点也能跑在 `mu` 没覆盖的 Agent 里。[`docs/mu-analysis.md`](docs/mu-analysis.md) 是那份分析，含措辞纪律与其实测数据。

## 安装

### DeepSeek Harness

```sh
dsh plugin --profile <profile> add dsh-jev-judge
dsh --profile <profile> --dump-config   # 能看到该插件层
```

也可以在 Web GUI 的 **Settings → Plugins** 里按包名、git 地址或本地路径安装。

### 其他 Agent

- **Claude Code / Codex** —— `settings.json` / `hooks.json` 里的命令钩子。
- **OpenCode、Cursor、Claude Code、Codex、Cline** —— MCP server。

```sh
claude mcp add jev-judge -- npx -y dsh-jev-judge mcp
```

各宿主的具体配置、以及每个宿主里"判定能做什么"的边界，见 [`docs/agents.md`](docs/agents.md)。

## 它判什么

| 判定点 | 它回答的问题 | 默认模式 |
|---|---|---|
| `judge.items` | 对上百条日志/文件/发现问同一个是非问，不必全部读进上下文 | 被调用时即生效 |
| `tool.admission` | 一长段工具输出里哪些片段与当前任务有关，其余不必进上下文 | `active` |
| `tool.injection` | 抓取内容里哪些段落是"对模型下的指令"，而不是写给读者看的素材 | `active` |
| `turn.completion` | 这句"已经完成"到底有没有东西验证过 | `active` |
| `turn.continue` | 这一轮是不是在宣布了下一步之后停住了，或者在为已经授权的工作讨要许可 | `active` |
| `memory.capture` | 这条消息是值得留存的纠正，还是下一个任务 | `active` |
| `tool.risk` | 规则已标记的高风险命令：用户是否真的要求过 | `shadow` |

每个判定点都带一个确定性回退，等于"没有这个包时的行为"；每次判定都写进账本——判定点靠真实会话数据挣到 `active`，而不是靠乐观。

`tool.risk` 默认 `shadow` 是刻意的：它的判定只能放宽策略，必须先用你自己的账本证明它可信。

## 配置

Provider 是你自己持有的私密记录，格式沿用 [`typesafe-ai-jev-skill`](https://github.com/HunterXing/typesafe-ai-jev-skill) 这个 Agent Skill：

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
jev-judge verify    # 离线校验；只报契约，永不打印 key
jev-judge doctor    # 实际会发生什么：judge、模式、账本
```

内核设置（全部可选）在 `~/.config/jev-judge/kernel.json`：

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

`jev-judge ledger` 读账本，`--json` 输出原始记录。`options["judge.items"].maxItems` 是每次请求的条数上限——真实 Provider 明确限制"每次调用最多 20 个问题"，超出会被自动拆成多次请求。

## 设计铁律

- **判定永远不会决定"要让 Agent 去问用户"。** 它只改变模型看到什么，或者要不要继续干。
- **没有判定，就等于没有这个包时的行为。**
- **小状态、有界问题。** judge 读摘要与元数据，不读全文；`choice` 问题永远带 escape 选项。
- **一个问题一个谓词。** 复合问题拆开、在 policy 里合成——这是实测结论，不是感觉。
- **先 shadow。** 只能"放宽策略"的判定点从 shadow 起步。
- **失败向开（fail open）。** judge 慢、不可达、答案含糊都走回退，绝不让 Agent 循环卡住。
- **key 永不离开你的私密记录**——不进日志、不进账本记录、不进错误信息、不进对话。

## 实测

见 [`docs/verification.md`](docs/verification.md)。在一份真实的、含 2 个失败的 81 行测试日志上，由真实 Provider 每次 20 条判定：

- 81 行 → 选中 5 行，**3047 字节里只有 191 字节（6.3%）需要读**，耗时 7.9 秒；
- 同一份日志把问题从"排查"改成"修复"，选中的就变成了断言消息与错误文本，而不再是汇总行。

## 开发

刻意做到零运行时依赖、无构建步骤：包可以从 checkout 直接加载，`dsh plugin add <path>` 不需要任何构建脚本授权。

```sh
node --test              # 213 项测试，不联网
node src/cli.js --help
```

发布靠打版本 tag：`.github/workflows/release.yml` 在测试通过后，经 npm 的
trusted publishing（仓库里不放任何 token）自动发版，详见 [`docs/market.md`](docs/market.md)。

## 许可

[MIT](LICENSE)。TypeSafe、System One 与 Jev 相关商标归各自权利人所有；本项目与它们无隶属关系。判定内核的设计改编自 [`mu`](https://github.com/qybaihe/mu)（MIT），详见 [ATTRIBUTION.md](ATTRIBUTION.md)。
