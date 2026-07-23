# CLAUDE.md — Code Insights

> **Primary Claude Code workspace.** All sessions run from this repo root.
> See `docs/` for detailed documentation. This file is the quick reference.

---

## Project Overview

**Code Insights** is an open-source CLI tool and embedded dashboard for analyzing AI coding sessions. It parses session history from multiple AI coding tools (Claude Code, Cursor, Codex CLI, Copilot CLI, VS Code Copilot Chat), stores structured data in a local SQLite database, and provides both terminal analytics and a browser-based dashboard with LLM-powered insights.

**Architecture:** Single-repo pnpm workspace monorepo with three packages: CLI, dashboard (Vite + React SPA), and server (Hono API).

**Privacy model:** Local-first storage with no Code Insights account or hosted
sync. Raw sessions and generated results are stored in SQLite at
`~/.code-insights/data.db`. Configured-provider LLM requests receive session
content only after the outbound credential-pattern guard runs;
Ollama/llama.cpp remain local only when configured with a local endpoint.
Claude Code native analysis delegates to the installed Claude CLI and follows
that tool's own boundary. Aggregate allowlisted telemetry is enabled by default
and can be disabled. See
[docs/SECURITY-MODEL.md](docs/SECURITY-MODEL.md).

---

## Development Philosophy (CRITICAL)

**No MVPs, no prototypes, no half-measures.** This product is LIVE with real users. Every feature ships as a full, complete implementation. We do not build "minimum viable" anything — we build the real thing, iterate based on feedback, and revert or update if it doesn't work out.

This principle applies to planning, designing, AND implementation:
- **Planning:** Don't scope down to "MVP facet set" vs "ideal set." Design the complete solution.
- **Designing:** Don't propose phased rollouts with "ship phase 1, add phase 2 later." Design it right the first time.
- **Implementing:** Don't cut corners with "we can add this later." Build it now or explicitly decide not to build it.

---

## Configuration Hierarchy

| Priority | Source | Scope |
|----------|--------|-------|
| 1 (Highest) | This project CLAUDE.md | Code Insights workflows, ceremony, agents |
| 2 | Session Mode | Educational context, learning mode |
| 3 | Global ~/.claude/CLAUDE.md | General best practices |

**Key overrides from global config:**

| Behavior | Global Default | Code Insights Override |
|----------|---------------|----------------------|
| Planning | Ask first | Sub-agents autonomous in their domain |
| File Creation | Ask first | Agents create files autonomously in their domain |
| Review Process | Single reviewer | Triple-layer (TA Insider + Outsider + Synthesis) |
| PR Merges | Normal | **BLOCKED** — only founder merges |

---

## Documentation Index

| Document | Contents |
|----------|----------|
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | Repository structure, data flow, provider architecture, SQLite schema, type system, API routes, dashboard pages |
| [docs/AGENTS.md](docs/AGENTS.md) | Agent suite, orchestrator role, development ceremony, team workflow, triple-layer code review, document ownership |
| [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md) | Branch discipline, hookify rules, pre-action verification, version bump, configuration, dev notes |
| [docs/PRODUCT.md](docs/PRODUCT.md) | Product description, features, source tools, insight categories, export, reflect/patterns |
| [docs/SECURITY-MODEL.md](docs/SECURITY-MODEL.md) | Assets, trust boundaries, local dashboard controls, LLM redaction, telemetry, and local storage threats |
| [docs/QA.md](docs/QA.md) | Test strategy, migration expectations, test commands, and coverage targets |
| [docs/VISION.md](docs/VISION.md) | Philosophy, core beliefs, phase history, non-goals |
| [docs/ROADMAP.md](docs/ROADMAP.md) | Phase milestones, version table, upcoming work |
| [CONTRIBUTING.md](CONTRIBUTING.md) | Supported Node/pnpm versions and contributor workflow |

---

## Supported Source Tools

| Source Tool | Provider ID | Provider Class | Data Format | Location |
|-------------|-------------|---------------|-------------|----------|
| Claude Code | `claude-code` | `ClaudeCodeProvider` | JSONL | `~/.claude/projects/**/*.jsonl` |
| Cursor | `cursor` | `CursorProvider` | SQLite (state.vscdb) | Platform-specific |
| Codex CLI | `codex-cli` | `CodexProvider` | JSONL (rollout files) | `~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl` |
| Copilot CLI | `copilot-cli` | `CopilotCliProvider` | JSONL (events) | `~/.copilot/session-state/{id}/events.jsonl` |
| VS Code Copilot Chat | `copilot` | `CopilotProvider` | JSON | Platform-specific Copilot Chat storage |

---

## Commands

```bash
# From repository root. Supported Node: 20, 22, or 24+.
corepack enable
pnpm install --frozen-lockfile   # pnpm 9.15.9
pnpm typecheck
pnpm test
pnpm build                      # CLI -> server -> dashboard

# After building, link for local testing:
cd cli
npm link
code-insights                          # Sync + open dashboard (zero-config)
code-insights init                     # Optional: customize settings
code-insights sync                     # Sync sessions to SQLite
code-insights sync --force             # Re-sync all sessions
code-insights sync --dry-run           # Preview without changes
code-insights sync -q                  # Quiet mode (for hook usage)
code-insights sync --source cursor     # Sync only from a specific tool
code-insights status                   # Show sync statistics
code-insights open                     # Open dashboard in browser (no server start)
code-insights dashboard                # Start server + open dashboard (auto-syncs first)
code-insights dashboard --no-sync      # Start server + open dashboard without syncing
code-insights install-hook             # Auto-sync + auto-analysis on session end
code-insights uninstall-hook           # Remove all Code Insights hooks
code-insights queue status             # Show durable queue state
code-insights queue process --limit 5  # Process a bounded foreground batch
code-insights queue retry --all        # Retry all terminal failures
code-insights config                   # Show current configuration
code-insights config llm               # Configure LLM provider interactively
code-insights reset --confirm          # Delete all local data
code-insights reflect                  # Cross-session LLM synthesis
code-insights reflect --week 2026-W11  # Synthesis for a specific ISO week
code-insights reflect --source cursor  # Scope synthesis to one source tool
code-insights reflect backfill         # Backfill facets for legacy sessions
code-insights sync prune               # Soft-delete trivial sessions (≤2 messages)
code-insights telemetry                # Show telemetry status
code-insights telemetry disable        # Opt out of aggregate telemetry
code-insights telemetry enable         # Opt back in

# Insights — session analysis
code-insights insights <session_id>              # Analyze using configured LLM
code-insights insights <session_id> --native     # Analyze using claude -p (no API key needed)
code-insights insights check                     # Check for unanalyzed sessions (last 7 days)

# Stats — terminal analytics
code-insights stats                    # Dashboard overview (last 7 days)
code-insights stats cost               # Cost breakdown by project and model
code-insights stats projects           # Per-project detail cards
code-insights stats today              # Today's sessions with details
code-insights stats models             # Model usage distribution
code-insights stats patterns           # Cross-session patterns summary

# Stats shared flags:
#   --period 7d|30d|90d|all   Time range (default: 7d)
#   --project <name>     Scope to a specific project
#   --source <tool>      Filter by source tool
#   --no-sync            Skip auto-sync before showing stats
```

---

## Tech Stack

- **Runtime**: Node.js (ES2022, ES Modules)
- **CLI Framework**: Commander.js
- **Database**: SQLite (better-sqlite3) — WAL mode, local at `~/.code-insights/data.db`, Schema V11
- **Dashboard**: Vite + React 19 SPA
- **Server**: Hono
- **UI**: Tailwind CSS 4 + shadcn/ui (New York), Lucide icons
- **Server State**: React Query (TanStack Query)
- **Charts**: Recharts 3
- **LLM**: OpenAI, Anthropic, Gemini, Ollama, llama.cpp (multi-provider abstraction)
- **Telemetry**: PostHog (opt-out model, enabled by default)
- **Terminal UI**: Chalk (colors), Ora (spinners), Inquirer (prompts)
- **Utilities**: date-fns
- **Package Manager**: pnpm (workspace monorepo)
- **npm Package**: `@code-insights/cli`
- **Binary**: `code-insights`

---

## Key Patterns

### Session Character Classification
Sessions are classified into one of 7 types based on tool call patterns:
- `deep_focus`, `bug_hunt`, `feature_build`, `exploration`, `refactor`, `learning`, `quick_task`

### Title Generation
Multi-tier fallback: Claude summary -> user message (scored) -> character-based -> generic fallback.

### Friction & Pattern Taxonomy
- **9 friction categories:** `wrong-approach`, `knowledge-gap`, `stale-assumptions`, `incomplete-requirements`, `context-loss`, `scope-creep`, `repeated-mistakes`, `documentation-gap`, `tooling-limitation`
- **8 effective pattern categories:** `structured-planning`, `incremental-implementation`, `verification-workflow`, `systematic-debugging`, `self-correction`, `context-gathering`, `domain-expertise`, `effective-tooling`
- **Attribution model:** Each friction point carries `attribution: 'user-actionable' | 'ai-capability' | 'environmental'`

### Multi-Source Support
The CLI and dashboard support sessions from multiple AI coding tools via the `sourceTool` field.

**Supported sources:** `'claude-code'` (default), `'cursor'`, `'codex-cli'`, `'copilot-cli'`, `'copilot'`

**Adding a new source tool:** See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for the 6-step provider guide.

### Analysis Core, Queue, and Reset Identity

- Configured-provider session analysis has one shared `AnalysisEngine` in
  `cli/src/analysis/analysis-engine.ts`. Both CLI and server entry points call
  it; the server layer is a persistence adapter.
- `analysis_usage` records provider/model, token/cache counts, cost, duration,
  and the analyzed message count used for resume detection.
- `analysis_queue` is a durable one-row-per-session FIFO queue. It coalesces a
  request received while processing into `rerun_requested`, and uses
  `next_attempt_at` for 30s/60s retry backoff before a third failure becomes
  terminal. Processing claims have a ten-minute lease whose durable deadline
  wakes a restarted queue pump before stale recovery.
- `code_insights_metadata` gives the database a persistent ID and sync
  generation. `reset` rotates the generation transactionally so a stale
  `sync-state.json` checkpoint cannot silently suppress the next full sync.

### Local Dashboard Boundary

The server binds only to `127.0.0.1`. Middleware validates loopback
`Host`/`Origin`, and all `/api` routes except `/api/health` and the
`GET /api/session` bootstrap require a random in-memory session token.
Static files and health are token-exempt but still pass the loopback checks.
Restarting the server rotates the token. Full assumptions and limitations are
documented in [docs/SECURITY-MODEL.md](docs/SECURITY-MODEL.md).
