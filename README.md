<p align="center">
  <img src="docs/assets/logo.svg" width="120" height="120" alt="Code Insights logo" />
</p>

<h1 align="center">Code Insights</h1>

<p align="center">
  <a href="https://www.npmjs.com/package/@code-insights/cli"><img src="https://img.shields.io/npm/v/@code-insights/cli" alt="npm version" /></a>
  <a href="https://www.npmjs.com/package/@code-insights/cli"><img src="https://img.shields.io/npm/dm/@code-insights/cli" alt="npm downloads" /></a>
  <a href="https://github.com/melagiri/code-insights/blob/master/LICENSE"><img src="https://img.shields.io/npm/l/@code-insights/cli" alt="license" /></a>
  <a href="https://nodejs.org"><img src="https://img.shields.io/node/v/@code-insights/cli" alt="node version" /></a>
  <a href="https://socket.dev/npm/package/@code-insights/cli"><img src="https://badge.socket.dev/npm/package/@code-insights/cli" alt="Socket Badge" /></a>
</p>

<p align="center">
  <strong>Turn your AI coding sessions into knowledge.</strong><br/>
  Extract decisions, learnings, and prompt quality scores. Detect patterns. Get better at working with AI.
</p>

```bash
npx @code-insights/cli
```

<p align="center">
  <img src="docs/assets/screenshots/patterns-light.png" alt="Patterns — friction points, effective patterns, prompt quality, working style" width="800" />
</p>

Analyzes your sessions from **Claude Code, Cursor, Codex CLI, Copilot CLI, and VS Code Copilot Chat** to extract structured insights — decisions with trade-offs, learnings with root causes, prompt quality with actionable feedback, and cross-session patterns that surface what's working and what's not. All stored locally in SQLite, browsable through terminal analytics and a built-in dashboard.

**Local-first storage. No account and no Code Insights cloud sync.** Raw sessions and
the SQLite database stay on your machine. If you select a configured cloud LLM
provider, credential-pattern-redacted session content is sent directly to that
provider for analysis.

---

> **Claude Code users: zero-config analysis with no separate API key.**
> Install the hook once. Every session gets analyzed automatically using your existing Claude subscription.
> ```bash
> code-insights install-hook
> ```

---

> **Works with Ollama — free, local, zero API keys.**
> If you have [Ollama](https://ollama.com) installed, `code-insights` will detect it automatically and use it for AI analysis. With a loopback Ollama endpoint, analysis stays on your machine.
>
> ```bash
> ollama pull llama3.3        # recommended
> npx @code-insights/cli      # Ollama detected automatically
> ```

---

## What You Get

### Decisions, Learnings & Prompt Quality

Each session is analyzed to extract structured insights — decisions with trade-offs and alternatives, learnings with root causes, and prompt quality scores across 5 dimensions with actionable before/after takeaways.

<p align="center">
  <img src="docs/assets/screenshots/session-insight-light.png" alt="Session detail — insights, prompt quality, summary, decisions" width="800" />
</p>

### Cross-Session Patterns

Weekly synthesis detects friction points, effective patterns, and prompt quality trends across all your sessions. Navigate week-by-week to see how your habits evolve — and export generated rules for your CLAUDE.md or .cursorrules.

<p align="center">
  <img src="docs/assets/screenshots/patterns-rules-light.png" alt="Patterns — friction points, effective patterns, generated rules" width="800" />
</p>

### AI Fluency Score

All of the above rolls up into your AI Fluency Score — a shareable snapshot of your coding fingerprint, working style, and top patterns.

<p align="center">
  <img src="docs/assets/screenshots/code-insights-ai-fluency-score.png" alt="AI Fluency Score — your coding fingerprint" width="600" />
</p>

### Analytics & Cost Tracking

Activity charts, cost breakdown by project and model, session types, and multi-tool usage — all in one dashboard.

<p align="center">
  <img src="docs/assets/screenshots/analytics-light.png" alt="Analytics — activity charts, model usage, cost breakdown, project table" width="800" />
</p>

### Terminal Analytics

Don't need a browser? `code-insights stats` gives you the full picture from the terminal.

<p align="center">
  <img src="docs/assets/screenshots/stats.png" alt="Terminal stats — sessions, cost, activity chart, top projects" width="500" />
</p>

---

## Supported AI Tools

| Tool | Data Location |
|------|---------------|
| Claude Code | `~/.claude/projects/**/*.jsonl` |
| Cursor | Workspace storage SQLite (macOS, Linux, Windows) |
| Codex CLI | `~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl` |
| Copilot CLI | `~/.copilot/session-state/{id}/events.jsonl` |
| VS Code Copilot Chat | Platform-specific Copilot Chat storage |

Sessions from all tools are discovered automatically during sync.

---

## Quick Start

```bash
# Try instantly (no install needed)
npx @code-insights/cli

# Or install globally
npm install -g @code-insights/cli
code-insights                          # sync sessions + open dashboard
code-insights install-hook             # auto-sync + auto-analyze on session end
```

### Common Commands

```bash
code-insights                          # sync + open dashboard (zero-config)
code-insights stats                    # terminal analytics (last 7 days)
code-insights stats today              # today's sessions
code-insights stats cost               # cost breakdown by project and model
code-insights dashboard                # start dashboard server
code-insights sync                     # sync sessions only
code-insights sync --source cursor     # sync from a specific tool
code-insights reflect                  # cross-session pattern synthesis
code-insights reflect --week 2026-W11  # reflect on a specific week
code-insights reflect --source cursor  # reflect on one source tool
code-insights config llm               # configure LLM provider
code-insights install-hook             # auto-sync + auto-analyze when sessions end
code-insights reanalyze --dry-run      # read-only historical reanalysis preview
code-insights reanalyze status         # show reanalysis campaign progress
code-insights maintenance status       # show whether automatic maintenance is paused
```

See [`cli/README.md`](cli/README.md) for the full CLI reference.

### Safe Historical Reanalysis

Use a durable reanalysis campaign when changing models across many sessions:

```bash
# Strictly read-only: no database writes, campaign creation, or model calls
code-insights reanalyze --dry-run

# Freeze the previewed membership, then process it in resumable batches
code-insights reanalyze start --yes
code-insights reanalyze run --batch-size 20
code-insights reanalyze status

# Pause or resume this campaign between model passes
code-insights reanalyze pause
code-insights reanalyze resume

# Give failed members a fresh bounded retry budget, or stop permanently
code-insights reanalyze retry-failed --yes
code-insights reanalyze cancel --yes
```

For `N` sessions, expect a minimum of `2N` provider requests. Long-conversation
chunking, facet extraction, and bounded retries add requests. A crash after an
in-flight provider response but before local progress is saved adds further
uncertainty. Existing results remain visible until both analysis passes succeed;
the replacement and a snapshot of the old results are then saved atomically.

A campaign locks its provider, model, endpoint fingerprint, analysis version,
and pipeline revision. Configuration or pipeline drift stops a run before any
provider request. The optional `--model` on preview/start is a check, not an
override: change models with `code-insights config llm` first.

The ordinary queue leaves unfinished active/paused Campaign members pending.
For other sessions it skips provider work only when both saved passes match the
current message count, provider/model, exact input revision, and pipeline
revision; legacy records missing those fields are treated as stale.

### Optional macOS Scheduled Maintenance

When running from a source checkout, you can install one daily LaunchAgent plus
the Claude Code SessionEnd hook:

```bash
./automation/install-launchd.sh --install
```

The default window is 02:00–06:00 with batches of 20. Customize it when
installing:

```bash
./automation/install-launchd.sh --install --start 01:30 --end 05:30 --batch-size 10
```

The job uses a shared process lock to serialize scheduled, hook, direct CLI,
and dashboard LLM work. When a reanalysis campaign is active, maintenance
advances that campaign instead of legacy historical batches and defers weekly
reflection until the campaign finishes. Logs are stored under
`~/.code-insights/logs/`.

```bash
code-insights maintenance pause
code-insights maintenance status
code-insights maintenance resume
```

```bash
./automation/install-launchd.sh --uninstall
```

---

## Architecture

```
Session files (Claude Code, Cursor, Codex CLI, Copilot CLI, VS Code Copilot Chat)
                          │
                          ▼
               ┌──────────────────┐
               │   CLI Providers  │  discover + parse sessions
               └──────────────────┘
                          │
                          ▼
               ┌──────────────────┐
               │  SQLite Database │  ~/.code-insights/data.db
               └──────────────────┘
                    │          │
          ┌─────────┘          └──────────┐
          ▼                               ▼
  ┌───────────────┐            ┌──────────────────┐
  │  stats/reflect │            │  Hono API server │
  │  (terminal)    │            │  + React SPA     │
  └───────────────┘            │  localhost:7890   │
                               └──────────────────┘
                                        │
                                        ▼
                               ┌──────────────────┐
                               │  LLM Providers   │  analysis, facets,
                               │(API key or Ollama)│  reflect, export
                               └──────────────────┘
```

Configured-provider session analysis is implemented once in the shared
`AnalysisEngine`; the CLI and local server are adapters around that same core.
Hook and dashboard jobs use a durable SQLite queue with FIFO claiming, bounded
retry/backoff, and rerun coalescing.

The monorepo contains three packages:
- **`cli/`** — Node.js CLI, session providers, SQLite writes, terminal analytics
- **`server/`** — Hono API server, REST endpoints, LLM proxy (API keys stay server-side)
- **`dashboard/`** — Vite + React SPA, served by the Hono server

## Development

```bash
# Node 20, 22, or 24+; workspace uses pnpm 9.15.9
git clone https://github.com/melagiri/code-insights.git
cd code-insights
corepack enable
pnpm install --frozen-lockfile
pnpm typecheck
pnpm test
pnpm build
cd cli && npm link
code-insights --version
```

See [`cli/README.md`](cli/README.md) for the full CLI reference,
[`docs/SECURITY-MODEL.md`](docs/SECURITY-MODEL.md) for the trust boundaries, and
[`CONTRIBUTING.md`](CONTRIBUTING.md) for contribution guidelines.

## Privacy

Raw session data and analysis results are stored locally in
`~/.code-insights/data.db`; Code Insights has no account system or hosted data
sync. Configured cloud-provider analysis sends session content directly to the
provider or custom endpoint you configure after a pattern-based credential
guard redacts recognized tokens, authorization headers, credential assignments,
private-key blocks, credential URLs, signed query parameters, cookies, and npm
credentials. Pattern matching reduces accidental disclosure but is not a
complete secret scanner and can miss credentials. Claude Code `--native`
analysis instead passes its prompt to the locally installed Claude CLI and is
governed by that tool's own data boundary.

Ollama and llama.cpp keep analysis local only when their configured endpoint is
local. Anonymous/pseudonymous aggregate usage telemetry is enabled by default,
restricted to an event/property allowlist, and never intentionally includes
session content, prompts, responses, or file paths. Opt out with
`code-insights telemetry disable`, `CODE_INSIGHTS_TELEMETRY_DISABLED=1`, or
`DO_NOT_TRACK=1`. See the
[Security Model](docs/SECURITY-MODEL.md) for the complete boundary and local
threat assumptions.

## License

MIT — see [LICENSE](LICENSE) for details.
