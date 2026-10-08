# dsh-jev-judge

[English](README.md) | **简体中文**

面向编码 Agent 的判定内核（judgment kernel）。那些高频、低价值的小判断——这段工具输出要不要留下来、这句"已完成"到底有没有验证过、这个页面是不是夹带了针对模型的指令、这条命令用户是不是真的要跑——交给一个小型的 Jev judge 去判，主模型把上下文和 token 留给真正需要推理的工作。

> **状态：开发中。** 内核、判定点与宿主适配正在公开迭代。本 README 只写这个仓库今天的代码确实能做到的事，随各子系统落地逐步补全。

## 为什么要一层判定内核

一轮 Agent 任务里有几十到上百次小判断。全交给主模型，又慢又费 token；全写成固定规则，复杂输入下必然失效。这个包就是中间那层：在一个小状态上问一个**有界的问题**，由小 judge 回答，再由代码掌握阈值、回退与最终动作。

设计遵循 [`mu`](https://github.com/qybaihe/mu)——它把一个判定内核装进 `pi` 编码 Agent：判定点带版本与策略声明、`off` / `shadow` / `active` 三档上线方式、便宜的 judge 先答的层级级联，以及记录每一次判定的账本，让新判定点靠真实会话数据"挣到" active。见 [ATTRIBUTION.md](ATTRIBUTION.md)。

Provider 不写死。本包读取与 [`typesafe-ai-jev-skill`](https://github.com/HunterXing/typesafe-ai-jev-skill) 这个 Agent Skill 相同的私密配置，API 根、模型、端点与认证方式都属于用户设置，而不是硬编码的服务。

## 安装

开发中——下表的接入方式随对应子系统落地即可用。

| 宿主 | 接入方式 |
| --- | --- |
| DeepSeek Harness | `dsh plugin --profile <profile> add dsh-jev-judge`（一个 `dsh.bundle` 插件层） |
| Claude Code | `settings.json` 里的命令钩子 |
| Codex | `~/.codex/hooks.json` 里的命令钩子 |
| 任意 MCP client（OpenCode、Cursor 等） | `jev-judge mcp`（stdio） |

## Provider 配置

内核不会在对话里要 key，也不会把 key 写进仓库。按顺序读取：

1. `JEV_SKILL_CONFIG` —— 指向你的私密 provider 配置路径。
2. `<agent-home>/.config/typesafe-ai-jev-skill.json`

Schema 与上述 Agent Skill 完全一致、不做改动：`providerName`、`baseUrl`、`model`、`apiKey` 或 `apiKeyEnv`、`protocol`、`endpointPath`、`authHeader`、`authScheme`、`extraHeaders`、`timeoutSeconds`。`systemone` provider 回答类型化的 `noul` / `choice` / `score` 问题；`chat` provider 只作为文档中明示的低保真回退通道。

## 设计铁律

- **判定永远不会决定"要让 Agent 去问用户"。** 它只改变模型看到什么，或者要不要继续干。
- **没有判定，就等于没有这个包时的行为。** 每个判定点都带确定性的回退。
- **小状态、有界问题。** judge 读的是摘要与元数据，不是全文；`choice` 问题永远带 escape 选项。
- **先 shadow。** 一个只能"放宽策略"的判定点从 `shadow` 起步，靠真实账本数据再切 `active`。
- **失败向开（fail open）。** judge 慢、不可达、或答案含糊，都走回退，绝不让 Agent 循环卡住。

## 开发

刻意做到零运行时依赖、无构建步骤：包可以从 checkout 直接加载，`dsh plugin add <repo>` 不需要任何构建脚本授权。

```sh
node --test
node src/cli.js --help
```

## 许可

[MIT](LICENSE)。TypeSafe、System One 与 Jev 相关商标归各自权利人所有；本项目与它们无隶属关系。
