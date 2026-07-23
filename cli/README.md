<p align="center">
  <img src="https://raw.githubusercontent.com/melagiri/code-insights/master/docs/assets/logo.svg" width="80" height="80" alt="Code Insights logo" />
</p>

<h1 align="center">Code Insights CLI</h1>

Extract decisions, learnings, and prompt quality scores from your AI coding sessions. Detect cross-session patterns. Get better at working with AI. Stores structured data in a local SQLite database and serves a built-in browser dashboard with LLM-powered synthesis.

**Local-first storage. No account and no Code Insights cloud sync.** Configured
cloud-provider analysis sends credential-pattern-redacted session content
directly to the provider you select.

<p align="center">
  <img src="https://raw.githubusercontent.com/melagiri/code-insights/master/docs/assets/screenshots/code-insights-ai-fluency-score.png" alt="AI Fluency Score — your coding fingerprint across tools" width="600" />
</p>

---

> **Claude Code users: zero-config analysis with no separate API key.**
> Install the hook once. Every session gets analyzed automatically using your existing Claude subscription.
> ```bash
> code-insights install-hook
> ```

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

The dashboard opens at `http://localhost:7890` and shows your sessions, analytics, and LLM-powered insights.

### Individual commands

```bash
code-insights stats                    # terminal analytics (no dashboard needed)
code-insights stats today              # today's sessions

code-insights dashboard                # start dashboard server (auto-syncs first)
code-insights dashboard --no-sync      # start dashboard without syncing
code-insights sync                     # sync sessions only
code-insights init                     # customize settings (optional)
code-insights doctor                   # diagnose your installation (start here if something's wrong)
```

<p align="center">
  <img src="https://raw.githubusercontent.com/melagiri/code-insights/master/docs/assets/screenshots/session-insight-light.png" alt="Session detail — insights, learnings, decisions, and conversation" width="800" />
</p>

## Supported Tools

| Tool | Data Location |
|------|---------------|
| **Claude Code** | `~/.claude/projects/**/*.jsonl` |
| **Cursor** | Workspace storage SQLite (macOS, Linux, Windows) |
| **Codex CLI** | `~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl` |
| **Copilot CLI** | `~/.copilot/session-state/{id}/events.jsonl` |
| **VS Code Copilot Chat** | Platform-specific Copilot Chat storage |

Sessions from all tools are discovered automatically during sync.

## Dashboard

```bash
code-insights dashboard
```

Opens the built-in React dashboard at `http://localhost:7890`. The dashboard provides:

- **Session Browser** — global search (`Cmd+K`), advanced filters (date range, outcome, saved presets), soft-delete, and full session details with chat view
- **Analytics** — usage patterns, cost trends, activity charts
- **LLM Insights** — AI-generated summaries, decisions, learnings, and prompt quality analysis (7 deficit + 3 strength categories with dimension scores)
- **Patterns** — weekly cross-session synthesis: friction points (with attribution), effective patterns (with driver classification), working style rules, and shareable AI Fluency Score card (downloadable 1200×630 PNG with score circle, fingerprint bars, and effective patterns)
- **Export** — LLM-powered cross-session synthesis in 4 formats (Agent Rules, Knowledge Brief, Obsidian, Notion)
- **Settings** — configure your LLM provider for analysis

<p align="center">
  <img src="https://raw.githubusercontent.com/melagiri/code-insights/master/docs/assets/screenshots/patterns-light.png" alt="Patterns — friction points, effective patterns, working style profile" width="800" />
</p>

<p align="center">
  <img src="https://raw.githubusercontent.com/melagiri/code-insights/master/docs/assets/screenshots/analytics-light.png" alt="Analytics — activity charts, model usage, cost breakdown, project table" width="800" />
</p>

### Options

```bash
code-insights dashboard --port 8080    # Custom port
code-insights dashboard --no-open      # Start server without opening browser
```

## CLI Commands

### Setup & Configuration

```bash
# Sync sessions and open dashboard — no setup required
code-insights

# Customize settings (optional) — prompts for Claude dir, excluded projects, etc.
code-insights init

# Show current configuration
code-insights config

# Configure LLM provider for session analysis (interactive)
code-insights config llm

# Configure LLM provider with flags (non-interactive)
code-insights config llm --provider anthropic --model claude-sonnet-4-20250514 --api-key sk-ant-...

# Show current LLM configuration
code-insights config llm --show

# Set a config value (e.g., disable telemetry)
code-insights config set telemetry false
```

### Sync

```bash
# Sync new and modified sessions (incremental)
code-insights sync

# Force re-sync all sessions
code-insights sync --force

# Preview what would be synced (no changes made)
code-insights sync --dry-run

# Sync only from a specific tool
code-insights sync --source cursor
code-insights sync --source claude-code
code-insights sync --source codex-cli
code-insights sync --source copilot-cli

# Sync only sessions from a specific project
code-insights sync --project "my-project"

# Quiet mode (useful for hooks)
code-insights sync -q

# Show diagnostic warnings from providers
code-insights sync --verbose

# Regenerate titles for all sessions
code-insights sync --regenerate-titles

# Soft-delete sessions (preview + confirm)
code-insights sync prune
```

### Terminal Analytics

```bash
# Overview: sessions, cost, activity (last 7 days)
code-insights stats

# Cost breakdown by project and model
code-insights stats cost

# Per-project detail cards
code-insights stats projects

# Today's sessions with time, cost, and model details
code-insights stats today

# Model usage distribution and cost chart
code-insights stats models

# Cross-session patterns summary
code-insights stats patterns
```

<p align="center">
  <img src="https://raw.githubusercontent.com/melagiri/code-insights/master/docs/assets/screenshots/stats.png" alt="Terminal stats — sessions, cost, activity chart, top projects" width="500" />
</p>

**Shared flags for all `stats` subcommands:**

| Flag | Description |
|------|-------------|
| `--period 7d\|30d\|90d\|all` | Time range (default: `7d`) |
| `--project <name>` | Scope to a specific project (fuzzy matching) |
| `--source <tool>` | Filter by source tool |
| `--no-sync` | Skip auto-sync before displaying stats |

### Reflect & Patterns

Cross-session pattern detection and synthesis. Requires an LLM provider to be configured.

```bash
# Generate weekly cross-session synthesis (current week)
code-insights reflect

# Reflect on a specific ISO week
code-insights reflect --week 2026-W11

# Scope to a specific project
code-insights reflect --project "my-project"

# Scope to a specific source tool
code-insights reflect --source cursor

# Backfill facets for sessions that were synced before Reflect existed
code-insights reflect backfill

# Backfill prompt quality analysis
code-insights reflect backfill --prompt-quality
```

The Reflect feature analyzes your sessions to surface:
- **Friction points** — recurring obstacles classified into 9 categories with attribution (user-actionable, AI capability, environmental)
- **Effective patterns** — working strategies across 8 categories with driver classification (user-driven, AI-driven, collaborative)
- **Prompt quality** — how well you communicate with AI tools (7 deficit + 3 strength categories)
- **Working style** — rules and skills derived from your sessions

### Diagnostics

```bash
# Check your installation — environment, database, providers, hooks, LLM, sync state
code-insights doctor

# Show what's wrong and fix it automatically (safe, idempotent fixes only)
code-insights doctor --fix

# Show probed paths for skipped/not-installed items
code-insights doctor --verbose

# Machine-readable output for bug reports
code-insights doctor --json
```

`doctor` checks ~30 things across 8 sections and tells you exactly what to run to fix each issue. If something isn't working, run this first. On a fresh install with no config, it shows a step-by-step setup guide instead of a check list.

### Status & Maintenance

```bash
# Show sync statistics (sessions, projects, last sync)
code-insights status

# Pause all automatic maintenance, inspect its state, then resume it
code-insights maintenance pause
code-insights maintenance status
code-insights maintenance resume

# Open the local dashboard in your browser
code-insights open
code-insights open --project           # Open filtered to the current project

# Delete all local data and reset sync state
code-insights reset --confirm
```

### Session Analysis

```bash
# Analyze a session using your configured LLM provider
code-insights insights <session_id>

# Analyze using Claude Code (no API key needed — uses your Claude subscription)
code-insights insights <session_id> --native

# Check for unanalyzed sessions (last 7 days)
code-insights insights check

# Batch analyze all unanalyzed sessions
code-insights insights check --analyze

# Custom lookback window
code-insights insights check --days 14
```

### Historical Reanalysis Campaigns

Use a durable campaign for a full-history model change or any reanalysis that
must continue safely across several runs.

```bash
# Strictly read-only: opens SQLite read-only and makes no model calls
code-insights reanalyze --dry-run

# Change the configured model before beginning a model migration
code-insights config llm

# Preview an inclusive local-date range; --model must match current configuration
code-insights reanalyze --dry-run --from 2026-02-01 --to 2026-07-21 --model glm-5.2

# Create the fixed campaign; --expected-count protects against a changed preview
code-insights reanalyze start --from 2026-02-01 --to 2026-07-21 \
  --model glm-5.2 --expected-count 499 --yes

# Advance a bounded batch and inspect progress
code-insights reanalyze run --batch-size 20
code-insights reanalyze status

# Pause or resume the campaign between model passes
code-insights reanalyze pause
code-insights reanalyze resume

# Reset failed members with a fresh bounded retry budget, then continue
code-insights reanalyze retry-failed --yes
code-insights reanalyze run --batch-size 20

# Permanently terminate the active/paused campaign; it cannot be resumed
code-insights reanalyze cancel --yes
```

The campaign freezes its session membership, provider, model, endpoint
fingerprint, analysis version, and pipeline revision. `run` stops with zero
provider requests if the current configuration or analysis pipeline does not
match. The `--model` option on preview/start must match the currently configured
model; it does not switch models. Run `code-insights config llm` first when
changing models.

A pause is cooperative: an already in-flight request may finish, but another
pass is not started after the pause is observed. `retry-failed --yes` explicitly
resets failed members' attempt counters while preserving a completed first pass.
`cancel --yes` is terminal; already-published members stay published and
unfinished members keep their previous visible results.

Each session has two logical analysis passes, so `N` sessions require at least
`2N` provider requests. Long conversations can be split into several chunks;
facet extraction and bounded retries also add requests. A process crash after a
provider returns but before the local stage or publish commit creates another
uncertain request that may need to be repeated.

New results become visible only after both passes succeed. One transaction first
snapshots the previous insights, facets, usage, and generated title, then replaces
the visible results and marks the campaign item successful. A failed or paused
item keeps its previous visible results.

### Bounded Analysis Script

From a source checkout, `throttled-analyze.sh` can preview or process one bounded
batch:

```bash
# Inclusive local-date range; no model calls
./throttled-analyze.sh --from 2026-07-01 --to 2026-07-21 \
  --batch-size 20 --dry-run

# Include already-complete sessions in this one batch
./throttled-analyze.sh --from 2026-07-01 --to 2026-07-21 \
  --batch-size 20 --force
```

`--force` does not keep cross-run progress and can select the same newest
sessions again. Use a `reanalyze` campaign, not repeated forced batches, for a
multi-day or full-history model migration.

### macOS Scheduled Maintenance

The source checkout includes a LaunchAgent installer. Its default daily window
is 02:00–06:00 with batches of 20:

```bash
./automation/install-launchd.sh --install

# Optional custom same-day window and batch size
./automation/install-launchd.sh --install --start 01:30 --end 05:30 --batch-size 10

./automation/install-launchd.sh --uninstall
```

Start must be earlier than end; cross-midnight windows are not supported. When a
reanalysis campaign is active, scheduled maintenance advances the campaign
instead of running legacy historical batches and delays weekly `reflect` until
the campaign is complete.

### Auto-Sync & Auto-Analyze Hook

```bash
# Install Claude Code hooks — auto-sync + auto-analyze when sessions end
code-insights install-hook

# Remove all hooks
code-insights uninstall-hook
```

The installed `SessionEnd` hook calls the internal `session-end` workflow. It
syncs the completed session, enqueues it in SQLite, and starts a detached queue
worker. The old `insights --hook` interface has been removed.

### Analysis Queue

The hook and dashboard share a durable SQLite analysis queue.

Queue claims skip unfinished members of an active or paused reanalysis campaign.
Those rows remain pending, preventing the ordinary queue and the campaign from
paying to analyze the same session concurrently.

For a claimed session, resume detection skips provider requests only when both
the `session` and `prompt_quality` usage rows match the current message count,
provider, model, exact input revision, and pipeline revision. A missing or
different field—including `NULL` revision fields in older rows—makes the result
stale and triggers a fresh two-pass analysis.

```bash
# Human-readable status; -q emits count-only JSON
code-insights queue status
code-insights queue status --quiet

# Process a bounded foreground batch
code-insights queue process --limit 5 --delay 2
code-insights queue process --model sonnet

# Retry one or all terminal failures
code-insights queue retry <session_id>
code-insights queue retry --all

# Remove completed/failed rows older than a threshold
code-insights queue prune --days 7
```

### Telemetry

Anonymous/pseudonymous aggregate usage telemetry is enabled by default and is
restricted to an event/property allowlist. It does not intentionally collect
session content, prompts, responses, file paths, API keys, or free-form errors.

```bash
code-insights telemetry status   # Check current status
code-insights telemetry disable  # Disable telemetry
code-insights telemetry enable   # Re-enable telemetry
```

Alternatively, set the environment variable:

```bash
CODE_INSIGHTS_TELEMETRY_DISABLED=1 code-insights sync
```

`DO_NOT_TRACK=1` also disables telemetry.

## LLM Configuration

**Claude Code users don't need to configure anything.** Run `code-insights install-hook` and sessions are analyzed automatically using your Claude subscription.

For other tools, or if you prefer a different model, configure a provider via CLI or the dashboard Settings page:

```bash
code-insights config llm
```

**Supported providers:**

| Provider | Models | Requires API Key |
|----------|--------|-----------------|
| Claude Code (native) | Your Claude subscription model | No (via `install-hook`) |
| Anthropic | claude-opus-4-6, claude-sonnet-4-6, etc. | Yes |
| OpenAI | gpt-4o, gpt-4o-mini, etc. | Yes |
| Google Gemini | gemini-2.0-flash, gemini-2.0-pro, etc. | Yes |
| Ollama | llama3.2, qwen2.5-coder, etc. | No |
| llama.cpp | Any model served by its OpenAI-compatible endpoint | No |

API keys are stored in `~/.code-insights/config.json` (mode 0o600, readable only by you).
Ollama and llama.cpp are local only when their configured endpoint is local;
custom endpoints may be remote. Before any supported provider request, Code
Insights applies a pattern-based credential guard to session content. This
guard reduces accidental disclosure but is not a complete secret scanner.
Claude Code `--native` analysis instead delegates the prompt to the locally
installed Claude CLI and follows that tool's own data boundary.

## Development

This is a pnpm workspace monorepo with three packages: `cli`, `dashboard`, and `server`.

```bash
# Clone
git clone https://github.com/melagiri/code-insights.git
cd code-insights

# Node 20, 22, or 24+; install pinned pnpm 9.15.9 and dependencies
corepack enable
pnpm install --frozen-lockfile

# Verify and build all packages
pnpm typecheck
pnpm test
pnpm build

# Link CLI for local testing
cd cli && npm link
code-insights --version

# Watch mode (CLI only)
cd cli && pnpm dev
```

### Workspace Structure

```
code-insights/
├── cli/        # This package — Node.js CLI, SQLite, providers
├── dashboard/  # Vite + React SPA
└── server/     # Hono API server (serves dashboard + REST API)
```

### Contributing

See [CONTRIBUTING.md](https://github.com/melagiri/code-insights/blob/master/CONTRIBUTING.md) for code style, PR guidelines, and how to add a new source tool provider.

## Privacy

- Raw sessions and generated results are stored locally in
  `~/.code-insights/data.db` (SQLite); there is no Code Insights account or
  hosted database sync.
- Configured cloud-provider analysis sends credential-pattern-redacted session
  content directly to the provider or custom endpoint you select. Recognized
  credential categories include common tokens, authorization/API-key headers,
  credential assignments, private-key blocks, credential URLs, signed query
  parameters, cookies, and npm credentials.
- Ollama and llama.cpp keep analysis content on the machine only when pointed at
  a local endpoint.
- Anonymous/pseudonymous aggregate telemetry is enabled by default, allowlisted,
  and opt-out. Disable it with `code-insights telemetry disable`,
  `CODE_INSIGHTS_TELEMETRY_DISABLED=1`, or `DO_NOT_TRACK=1`.
- Credential-pattern redaction can produce false positives or miss unknown
  secret formats. Treat it as a safety guard, not as a full secret scanner or
  data-loss-prevention system.

See the repository
[Security Model](https://github.com/melagiri/code-insights/blob/master/docs/SECURITY-MODEL.md)
for local dashboard controls, endpoint boundaries, and threat assumptions.

## License

MIT — see [LICENSE](https://github.com/melagiri/code-insights/blob/master/LICENSE) for details.
