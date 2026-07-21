# deja-vu 与 kinpoe-ray/code-insights 对比研究

> 调研时间：2026-07-18（Asia/Shanghai）
> 比较对象：[`vshulcz/deja-vu`](https://github.com/vshulcz/deja-vu) 的 `main@145397a`，以及 [`kinpoe-ray/code-insights`](https://github.com/kinpoe-ray/code-insights) 的 `feature/anthropic-baseurl@999aa1f`。
> 资料范围：两仓库 README、架构/安全文档、源码、package metadata、工作流及 GitHub API。未采用第三方评测。

## 结论

没有脱离场景的绝对胜者：

- **想让 Claude/Codex 等代理检索并复用过去会话，选 deja-vu。** 它的产品闭环是“本地索引 → 毫秒级搜索 → MCP/SessionStart 自动召回 → 恢复原会话”，不需要 LLM，支持的代理更多，单二进制安装更轻，凭据脱敏和安全边界也更完整。
- **想复盘自己怎样使用 AI 编程、提炼决策和经验、评估提示词、查看趋势与成本，选 Code Insights。** 它使用 LLM 做结构化分析，拥有更丰富的 Web 仪表盘、跨会话模式、AI Fluency Score、提示词质量和成本分析；这类“洞察深度”明显高于 deja-vu 的词法检索和统计。
- **若只能给当前综合工程完成度投一票，我会选 deja-vu；若按 Code Insights 的核心产品目标投票，我会保留并继续做 Code Insights。** deja-vu 当前在分发、安全、跨平台 CI、诊断、同步和代理接入上更完整；Code Insights 则有更难被替代的“分析与成长反馈”定位。最合理的产品方向不是照搬 deja-vu，而是吸收它的召回层、脱敏和安装体验。

## 定位与用户价值

| 维度 | deja-vu | Code Insights |
|---|---|---|
| 核心承诺 | 把已有代理会话变成可搜索、可自动注入的长期记忆 | 把 AI 编程会话变成决策、经验、提示词反馈和跨会话模式 |
| 主要动作 | search、ctx、MCP recall、auto-recall、resume | sync、analyze、reflect、stats、dashboard、export |
| 是否需要模型 | 不需要；纯词法索引 | 深度分析需要配置 LLM；可用 Ollama/llama.cpp 本地运行 |
| 输出重点 | 找回原始上下文与相关片段 | 生成新的结构化洞察、评分、趋势和规则 |
| 更适合 | “我们以前怎么解决过？” | “我从过去工作中学到了什么？怎样做得更好？” |

deja-vu 明确自称 coding-agent 的 “memory layer”，README 展示搜索、MCP recall、SessionStart 自动召回、分享、同步和恢复会话。[来源：deja-vu README](https://github.com/vshulcz/deja-vu/blob/145397a4b93bd7d6bb367846615cc018895190ab/README.md)

Code Insights 的 README 则明确强调 decisions、learnings、五维 prompt quality、cross-session patterns、AI Fluency Score 和 cost analytics。[来源：Code Insights README](https://github.com/kinpoe-ray/code-insights/blob/feature/anthropic-baseurl/README.md)

因此，“洞察”一词在两边含义不同：deja-vu 帮代理**找到旧知识**；Code Insights 用模型**从旧材料生成新解释**。

## 功能与支持工具

### deja-vu

- 支持 Claude Code、Codex CLI、opencode、aider、Gemini CLI、Cursor、Antigravity、Grok Build、Qwen Code，共 9 类会话源。
- CLI 提供全文/正则/范围过滤搜索、最佳会话摘要、最近会话、原生 harness 恢复、来源诊断、统计卡片。
- MCP 提供 `recall` 与 `recall_context`；`install --auto` 可在支持的代理启动时自动注入项目记忆。
- 提供本地目录或 SSH 增量同步、脱敏分享和自更新。

支持矩阵、命令与限制均见其 [README](https://github.com/vshulcz/deja-vu/blob/145397a4b93bd7d6bb367846615cc018895190ab/README.md)，解析器实现位于 [`internal/sources`](https://github.com/vshulcz/deja-vu/tree/145397a4b93bd7d6bb367846615cc018895190ab/internal/sources)。

### Code Insights

- 支持 Claude Code、Cursor、Codex CLI、Copilot CLI、VS Code Copilot Chat，共 5 类会话源。
- 会话级分析包括摘要、决策/权衡、经验/根因、提示词五维评分和改进建议。
- 周度 reflection 聚合摩擦点、有效模式、提示词趋势，并可生成 CLAUDE.md / `.cursorrules` 规则。
- Web 仪表盘覆盖会话详情、活动、模型与项目成本、模式和 AI Fluency Score；终端另有 `stats`。
- LLM 支持 OpenAI、Anthropic、Gemini、Ollama、llama.cpp；个人分支还增加 Anthropic-compatible 自定义 `baseUrl` 和持久化串行分析队列。

产品能力见 [README](https://github.com/kinpoe-ray/code-insights/blob/feature/anthropic-baseurl/README.md)；五种 LLM provider 的服务端校验见 [`server/src/routes/config.ts`](https://github.com/kinpoe-ray/code-insights/blob/feature/anthropic-baseurl/server/src/routes/config.ts)；个人分支的 6 个新增提交可由 [GitHub commits API](https://api.github.com/repos/kinpoe-ray/code-insights/commits?sha=feature%2Fanthropic-baseurl&per_page=8) 核验。

**功能判断：** deja-vu 的工具覆盖与“召回闭环”更完整；Code Insights 的分析维度与可视化明显更丰富。

## 洞察深度与检索质量

deja-vu 采用本地倒排索引：查询分词后读取 posting lists，多词取交集，再按匹配数与新近程度预排序；任意正则则扫描 records。它快、确定、无模型成本，但本质是 lexical search，不能自行归纳隐含主题或评价提示词。[来源：deja-vu 架构文档](https://github.com/vshulcz/deja-vu/blob/145397a4b93bd7d6bb367846615cc018895190ab/docs/ARCHITECTURE.md)

Code Insights 会把会话交给 LLM，生成结构化 session analysis、prompt quality、facets 与 weekly reflection，并计算调用成本。它能给出更高层解释和跨会话趋势，但结果受模型、提示词和输入截断影响，也增加时间、费用与不确定性。[来源：Code Insights 分析实现](https://github.com/kinpoe-ray/code-insights/tree/feature/anthropic-baseurl/server/src/llm)

所以：

- 对“准确找回曾经说过的文本”，deja-vu 更合适。
- 对“总结为什么反复失败、有哪些工作模式、提示词怎样改”，Code Insights 更强。
- 对“语义相似但没有共享关键词”的召回，两者都不是完美答案：deja-vu 明确是词法检索；Code Insights 虽使用 LLM 分析，却不是面向任意历史问题的实时语义检索器。

## 隐私与安全

两者都把会话数据库留在本机，但边界并不相同。

### deja-vu

- 索引和搜索路径不访问网络；MCP 走 stdio，不监听端口。
- 写入索引前会匹配并替换 AWS、JWT、PEM、常见 provider token、带用户名密码 URL 等凭据；share 与 sync export 再脱敏一次。
- 安全文档明确承认：模式匹配不是秘密检测、索引不加密、能读文件的人仍能读内容。
- 仅显式执行 update 或 SSH sync 才产生网络访问。

这些边界及局限写在独立的 [Security Model](https://github.com/vshulcz/deja-vu/blob/145397a4b93bd7d6bb367846615cc018895190ab/docs/SECURITY-MODEL.md)；发布还包含 checksum、cosign 签名、provenance attestation 与 SBOM。

### Code Insights

- 原始会话与分析结果保存在本机 SQLite，无账户、无云同步。
- Ollama/llama.cpp 可使分析内容不离机；选择 OpenAI、Anthropic 或 Gemini 时，会话内容会发送给用户配置的 provider。
- 匿名使用遥测默认开启、可以退出；因此不能把“会话本地存储”理解成
  进程绝无网络流量。
- 仓库当前未看到与 deja-vu 同等级的索引前凭据脱敏层、独立安全模型和签名/SBOM 发布说明。

Code Insights 对上述边界的公开说明见 [README Privacy](https://github.com/kinpoe-ray/code-insights/blob/feature/anthropic-baseurl/README.md#privacy)，遥测开关与披露实现见 [`cli/src/utils/telemetry.ts`](https://github.com/kinpoe-ray/code-insights/blob/feature/anthropic-baseurl/cli/src/utils/telemetry.ts)。

**隐私判断：** 默认条件下 deja-vu 更强。Code Insights 若使用 Ollama/llama.cpp 并关闭遥测，也能保持核心数据本地，但仍缺少系统性的凭据脱敏防线。

## 架构、性能与可维护性

### deja-vu

- Go 1.25，单一静态二进制，`go.mod` 没有第三方 module dependency。[来源：go.mod](https://github.com/vshulcz/deja-vu/blob/145397a4b93bd7d6bb367846615cc018895190ab/go.mod)
- 自建 `records.bin + token buckets + manifest/sessions` 索引；按文件状态增量更新，写入保持确定性。
- 文件解析使用 `runtime.NumCPU()` worker pool；opencode/Cursor IDE 通过系统 `sqlite3`，避免 CGO。
- README 报告的自有语料基准为：1,250+ sessions / 3.3GB，warm search 约 12ms、cold index 约 10s、索引约为原语料 2.4%。这是作者提供的基准，不是独立复测。[来源：Performance](https://github.com/vshulcz/deja-vu/blob/145397a4b93bd7d6bb367846615cc018895190ab/README.md#performance)

### Code Insights

- pnpm monorepo：TypeScript CLI + better-sqlite3、Hono 本地 API、React/Vite dashboard。[来源：根 package.json](https://github.com/kinpoe-ray/code-insights/blob/feature/anthropic-baseurl/package.json)
- 业务分层更适合复杂分析产品：provider 解析、SQLite、LLM proxy、REST API、SPA 相互独立。
- 代价是 Node/pnpm/native addon 和大量前端依赖，安装面、构建面与供应链面显著大于单 Go 二进制。
- 个人分支新增共享 LLM 锁、持久队列、失败隔离与定时维护，改善了长期批处理可靠性，但当前自动化维护主要面向 macOS launchd。

**架构判断：** 搜索型 CLI 的工程简洁性和可部署性，deja-vu 胜；复杂分析仪表盘的扩展空间，Code Insights 胜。

## 安装与使用门槛

deja-vu 提供 shell installer、`go install`、npm wrapper、Homebrew，并通过 GitHub release 发布多平台二进制；`deja install --all/--auto` 自动修改代理配置且保留 `.bak`，`doctor --json` 给出可脚本化诊断。[来源：README Install/Doctor](https://github.com/vshulcz/deja-vu/blob/145397a4b93bd7d6bb367846615cc018895190ab/README.md)

Code Insights 的正式入口同样很短：`npx @code-insights/cli` 或全局 npm 安装；Claude Code 可安装 SessionEnd hook，Ollama 会自动探测。源码开发则需要 Node 18+、pnpm、三个 package 的构建链和 native SQLite addon。[来源：Quick Start/Development](https://github.com/kinpoe-ray/code-insights/blob/feature/anthropic-baseurl/README.md#quick-start)

**安装判断：** 普通用户两者都能快速启动；跨平台分发、自诊断和“装完即代理可调用”方面 deja-vu 更完整。Code Insights 的 Web dashboard 对非命令行用户更友好。

## 成熟度、活跃度与测试

这里要区分“项目年龄”“继承历史”和“当前社区热度”。

- GitHub API 显示 deja-vu 仓库创建于 2026-07-14，调研时约 4 天，349 stars、16 forks、12 open issues，最新 release 为 v0.12.0（2026-07-17）。增长和提交非常活跃，但**时间验证仍很短**。[来源：deja-vu repository API](https://api.github.com/repos/vshulcz/deja-vu)、[latest release API](https://api.github.com/repos/vshulcz/deja-vu/releases/latest)
- kinpoe-ray/code-insights fork 创建于 2026-07-14，0 stars、0 forks、0 open issues、无 fork 自有 release；但代码继承上游 `melagiri/code-insights` 的长历史，本地目标分支有约 1,080 个提交，并非从零开始的新项目。[来源：fork repository API](https://api.github.com/repos/kinpoe-ray/code-insights)
- deja-vu 当前快照有 56 个 `*_test.go` 文件，并覆盖 parser、索引增量/崩溃安全、去重、脱敏、同步、搜索、安装、更新和 Windows packaging；CI、lint、CodeQL、Scorecard、release 五条工作流齐全。[来源：测试树](https://github.com/vshulcz/deja-vu/tree/145397a4b93bd7d6bb367846615cc018895190ab)、[workflows](https://github.com/vshulcz/deja-vu/tree/145397a4b93bd7d6bb367846615cc018895190ab/.github/workflows)
- Code Insights 目标分支有 71 个 TypeScript/shell 测试文件，根测试同时运行 automation tests 和各 workspace tests，并有覆盖率命令/阈值；但 CI 只在 `master` push/PR 触发，个人 feature 分支的新增自动化未天然获得同等远程 CI 保障。[来源：Code Insights CI](https://github.com/kinpoe-ray/code-insights/blob/feature/anthropic-baseurl/.github/workflows/ci.yml)、[根 scripts](https://github.com/kinpoe-ray/code-insights/blob/feature/anthropic-baseurl/package.json)

**成熟度判断：**

- 按“历史代码积累”，Code Insights 更老、更大。
- 按“当前仓库的发布工程、安全工程、跨平台验证和社区势头”，deja-vu 更强。
- 按“长期生产稳定性”，两者都不宜仅凭 stars 或测试文件数下结论；deja-vu 尤其需要注意仓库年龄极短。

## 评分（只代表当前快照）

| 维度 | deja-vu | Code Insights | 说明 |
|---|---:|---:|---|
| 历史会话检索/代理召回 | 9 | 4 | deja-vu 是核心闭环 |
| 分析与成长洞察 | 4 | 9 | Code Insights 有 LLM 结构化分析与趋势 |
| 支持会话源 | 9 | 6 | 9 类对 5 类 |
| 隐私/安全设计 | 9 | 6 | deja-vu 有双重脱敏与完整威胁边界 |
| 安装/跨平台分发 | 9 | 7 | 单二进制、多渠道、doctor |
| 可视化与可读性 | 4 | 9 | Code Insights 的 React dashboard 优势明显 |
| 发布与 CI 工程 | 9 | 6 | deja-vu 的工作流和 supply-chain 产物更全 |
| 时间验证 | 4 | 7 | deja-vu 仓库非常新；Code Insights 继承长期历史 |

这些分数不是把不同产品硬凑成一个总分，而是帮助选择。如果权重以“代理记忆”为主，deja-vu 胜；以“个人复盘与洞察”为主，Code Insights 胜。

## 对 kinpoe-ray/code-insights 的建议

优先借鉴 deja-vu 的长处，而不是改成另一个 deja-vu：

1. **补一层即时召回。** 在现有结构化洞察之外提供 MCP `recall`，优先搜索已生成的 decisions/learnings/facets；这是 Code Insights 可以比纯历史文本检索更有差异化的地方。
2. **分析前脱敏。** 在落库和发往云端 LLM 前增加凭据检测；导出时再做一次，并明确模式匹配的局限。
3. **收紧隐私文案。** 把“会话不离机”“云 LLM 会收到内容”“匿名遥测默认开启”分开说明，避免绝对化措辞。
4. **改善零配置诊断。** 增加 `doctor`，统一检查 session stores、SQLite/native addon、LLM、hook、队列与 dashboard 端口。
5. **让 feature 分支进入 CI。** 当前工作流只面向 `master`；至少应通过 PR 或 workflow 调整验证个人分支中的队列与 launchd 逻辑。
6. **保留 dashboard 与深度分析。** 这是与 deja-vu 最明确的区隔，不应为了追求单二进制而牺牲。

## 当前实现更新（未绑定提交，2026-07-18）

上文评分与比较仍是开头所列两个固定提交的历史快照。本节只记录当前
Code Insights 工作树已经落地的变化，不虚构尚未产生的 commit hash：

- **配置型 LLM 出站脱敏已实现。** CLI 与 server 的配置型 session analysis
  共用一个 `AnalysisEngine`，OpenAI、Anthropic、Gemini、Ollama 和 llama.cpp
  请求都会先经过同一个凭据模式守卫。它覆盖已配置 secret、常见 token
  前缀、JWT、Authorization/API-key header、credential assignment、私钥块、
  带凭据 URL、签名 query、Cookie 和 npmrc。原始本地 SQLite 不会因此被
  改写；模式匹配仍可能漏报或误报，不能当完整 secret scanner。Claude Code
  的 `--native` 路径交给本机 Claude CLI，当前不经过这套配置型 provider
  守卫，应按 Claude CLI 自身的数据边界评估。
- **本地 dashboard 边界已收紧。** Hono 只绑定 `127.0.0.1`，验证 loopback
  `Host`/`Origin`；`GET /api/session` 发放仅存于进程内存的随机 token，除
  static/health/bootstrap 外的 API（包括 SSE）都要求该 token，重启即轮换。
  这能降低跨站和 DNS rebinding 风险，但不能防御同一系统用户下的恶意本地
  进程；SQLite 仍未加密。完整边界见
  [`docs/SECURITY-MODEL.md`](../SECURITY-MODEL.md)。
- **CI 配置已补强。** 当前 workflow 对所有分支 push 触发，并对目标为
  `master` 的 PR 触发；在 Ubuntu/Node 20、pnpm 9.15.9 上执行 frozen
  install、typecheck、build 和 test。由于本节记录的是尚未提交/推送的工作
  树，这批本地改动本身仍要等 push 后才会获得远程 CI 结果。
- **建议状态发生变化。** 上面的第 2、3 项已针对 LLM 出站与公开文案落地，
  第 4 项的 `doctor` 已存在；第 5 项的 workflow 配置已完成，但当前工作树
  仍待远程运行。即时 recall/MCP、索引前或
  落库前脱敏、签名/SBOM 发布链仍是 deja-vu 的优势。

一句话定位建议：**deja-vu 让代理记得过去；Code Insights 应让人和代理理解过去、改进下一次。**
