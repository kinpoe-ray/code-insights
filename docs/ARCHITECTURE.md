# Architecture — Code Insights

> Technical architecture reference. Linked from [CLAUDE.md](../CLAUDE.md).

---

## Data Flow

```
Source tool session files -> Provider (discover + parse) -> local SQLite
                                                         -> CLI stats commands
                                                         -> loopback dashboard/API
                                                         -> AnalysisEngine
                                                            -> local model endpoint, or
                                                            -> redacted content to cloud/custom endpoint
                                                         -> ClaudeNativeRunner
                                                            -> installed Claude CLI boundary
```

---

## Repository Structure

```
code-insights/
├── cli/                    # Node.js CLI (Commander.js, SQLite, providers)
│   └── src/
│       ├── commands/       # CLI commands (init, sync, status, stats, dashboard, config, insights)
│       ├── commands/stats/ # Stats command suite (4-layer architecture)
│       ├── analysis/       # Prompt builders, response parsers, normalizers, runner interface (shared by CLI + server)
│       ├── providers/      # Source tool providers (claude-code, cursor, codex, copilot, copilot-cli)
│       ├── parser/         # JSONL parsing, title generation
│       ├── db/             # SQLite schema, migrations, queries
│       ├── utils/          # Config, device, paths, telemetry
│       ├── types.ts        # Type definitions (SINGLE SOURCE OF TRUTH)
│       └── index.ts        # CLI entry point
├── dashboard/              # Vite + React SPA
│   └── src/
│       ├── components/     # React components (shadcn/ui)
│       │   ├── empty-states/  # Guided empty states (EmptyDashboard, EmptySessions, EmptyInsights)
│       │   └── patterns/      # Patterns page components (WeekAtAGlanceStrip, WeekSelector)
│       ├── hooks/          # React Query hooks
│       ├── lib/            # LLM providers, utilities, telemetry
│       │   ├── share-card-utils.ts   # Canvas 2D share card rendering (drawShareCard, downloadShareCard)
│       │   ├── share-card-icons.ts   # Lucide icon + tool logo rendering for Canvas 2D
│       │   └── prompt-quality-utils.ts  # PQ category labels, strength set detection
│       └── App.tsx         # SPA entry point
│   └── public/
│       └── icons/          # Source tool logos (Claude Code SVG, Cursor PNG, Codex PNG, Copilot PNG)
├── server/                 # Hono API server
│   └── src/
│       ├── routes/         # REST API endpoints
│       ├── llm/            # LLM client, reflect synthesis, export, cost tracking; prompt builders re-exported from cli/src/analysis/
│       └── index.ts        # Server entry point
├── docs/                   # Product docs, plans, roadmap
│   └── plans/              # Design plans (pending implementation only)
└── .claude/                # Agent definitions, commands, hookify rules
    ├── agents/             # Agent definitions (engineer, TA, PM, etc.)
    └── commands/           # Team commands (start-feature, start-review)
```

### CLI Directory Detail (`/cli/src/`)

- `commands/` — CLI commands (init, sync, status, dashboard, reset, install-hook, config, reflect, telemetry, insights)
- `commands/stats/` — Stats command suite (4-layer architecture):
  - `data/types.ts` — `StatsDataSource` interface, `SessionRow`, error classes
  - `data/source.ts` — Data source factory
  - `data/local.ts` — SQLite data source implementation
  - `data/aggregation.ts` — Pure compute functions (overview, cost, projects, today, models)
  - `data/fuzzy-match.ts` — Levenshtein distance for `--project` name matching
  - `render/` — Terminal rendering (colors, format, charts, layout)
  - `actions/` — Action handlers for each subcommand + shared error handler
  - `index.ts` — Command tree with lazy imports
  - `shared.ts` — Shared CLI flags
- `providers/` — Source tool providers (claude-code, cursor, codex, copilot, copilot-cli)
- `providers/types.ts` — `SessionProvider` interface
- `providers/registry.ts` — Provider registration and lookup
- `parser/jsonl.ts` — JSONL file parsing (used by ClaudeCodeProvider)
- `parser/titles.ts` — Smart session title generation (5-tier fallback strategy)
- `db/` — SQLite schema, migrations, query functions
- `utils/config.ts` — Configuration management (~/.code-insights/config.json)
- `utils/device.ts` — Device ID generation, git remote detection, stable project IDs
- `utils/paths.ts` — Virtual path handling (shared by sync and stats)
- `utils/telemetry.ts` — PostHog telemetry (default-on/opt-out, allowlisted
  events and properties)
- `types.ts` — TypeScript type definitions (SINGLE SOURCE OF TRUTH)
- `index.ts` — CLI entry point (Commander.js)

---

## Provider Architecture

All source tools are integrated via the `SessionProvider` interface (`providers/types.ts`):

```typescript
interface SessionProvider {
  getProviderName(): string;                                    // e.g. 'claude-code', 'cursor'
  discover(options?: { projectFilter?: string }): Promise<string[]>;  // Find session files
  parse(filePath: string): Promise<ParsedSession | null>;       // Parse into common format
}
```

Providers are registered in `providers/registry.ts`. To add a new source tool:
1. Create `providers/<name>.ts` implementing `SessionProvider`
2. Register it in `providers/registry.ts`
3. Add color entry to dashboard `SOURCE_TOOL_COLORS`
4. Add avatar case to dashboard `getAssistantConfig()`
5. Add tool name aliases if tool names differ
6. Add option to source filter dropdown

---

## SQLite Database

- **Location:** `~/.code-insights/data.db`
- **Mode:** WAL (concurrent reads during CLI sync)
- **Driver:** better-sqlite3 (synchronous, fast, no async overhead)
- **Schema:** Versioned migrations (V1–V12) applied on startup
- **Timestamps:** ISO 8601 strings

### Tables

| Table | Purpose | Schema Version |
|-------|---------|---------------|
| `projects` | Project metadata (id = hash of git remote URL or path) | V1 |
| `sessions` | Session metadata, titles, character classification, `deleted_at` soft-delete; V6 adds `compact_count INTEGER`, `auto_compact_count INTEGER`, `slash_commands TEXT` | V1, V5, V6 |
| `messages` | Full message content (stored during sync) | V1 |
| `insights` | LLM-generated insights (5 types) | V1, V2 (index) |
| `usage_stats` | Global usage aggregation | V1 |
| `session_facets` | Cross-session facet data (friction, patterns, workflow) | V3 |
| `reflect_snapshots` | Cached synthesis results; V11 composite PK `(period, project_id, source_scope)` isolates all-source and per-source snapshots | V4, V11 |
| `analysis_usage` | Per-session LLM analysis cost data; V8 adds message-count freshness and V12 adds input/pipeline revision fields | V7, V8, V12 |
| `analysis_queue` | One durable row per session; V11 adds rerun coalescing and persistent retry scheduling through `next_attempt_at` | V9, V11 |
| `code_insights_metadata` | Persistent database ID and sync generation used to bind filesystem checkpoints to this database lifecycle | V10 |
| `analysis_campaigns` | Fixed scope and provider/model identity for one durable history reanalysis campaign | V12 |
| `analysis_campaign_items` | Frozen membership, staged first pass, attempts, claims, and per-session campaign state | V12 |
| `analysis_campaign_snapshots` | Previous visible results captured immediately before an atomic campaign replacement | V12 |
| `schema_version` | Migration tracking | V1 |

---

## Analysis Engine, Queue, and Database Identity

Configured-provider session analysis has one shared core:
`cli/src/analysis/analysis-engine.ts`. Both the CLI command and the server
persistence adapter call `createAnalysisEngine()`, so prompt construction,
budgeting, credential redaction, response parsing, usage accounting, and pricing
follow one contract. The server adapter persists only complete results.

`analysis_usage` records provider/model, input/output and cache tokens, estimated
cost, duration, analyzed message count, exact input revision, and pipeline
revision. Provider work is skipped only when both `session` and
`prompt_quality` rows match all five freshness dimensions: message count,
provider, model, input revision, and pipeline revision. Missing fields fail
closed, so pre-V12 rows with `NULL` revisions are stale until a new two-pass
analysis completes.

`analysis_queue` is a durable state machine:

```
pending (due) -> processing -> completed
                         \-> pending at next_attempt_at -> processing
                         \-> failed after max_attempts
```

- `claimNext()` atomically claims due `pending` rows in
  `(enqueued_at, rowid)` FIFO order.
- Claims exclude unfinished members of every active or paused history campaign;
  their queue rows stay pending instead of competing for paid provider work.
- The default maximum is three attempts. The first and second failures are
  deferred for 30 and 60 seconds; the third becomes terminal.
- Enqueuing a session that is currently processing sets `rerun_requested`
  without replacing the active runner metadata. Completion or failure then
  creates one fresh pending rerun.
- `POST /api/analysis/queue` validates and enqueues 1–500 session IDs as one
  batch. The local queue pump processes one item per turn; durable timing remains
  in SQLite, not only in a process timer.
- A `processing` claim has a ten-minute lease. A restart does not immediately
  reset a still-valid claim: SQLite exposes its lease deadline as the next
  durable wake-up. At expiry, stale recovery consumes an attempt and follows
  the same rerun/backoff rules.

`code_insights_metadata` stores a stable database ID and a sync generation.
Filesystem sync checkpoints include both values. A successful full sync
advances the generation, while `reset` clears user tables and advances the
generation transactionally. This prevents a stale `sync-state.json` from
silently suppressing data after a reset or database replacement.

### Durable History Reanalysis

`reanalyze --dry-run` opens the existing SQLite database read-only. It selects
the exact eligible membership and reports the call estimate without applying
migrations, creating a campaign, or invoking a model.

`reanalyze start` persists that fixed membership plus the provider, model,
one-way endpoint fingerprint, analysis version, and pipeline revision. The
optional `--model` for preview/start must equal the currently configured model;
it is a guard, not an execution override. A model migration therefore begins by
changing `config llm`. At most one active or paused campaign can exist. Items
move through this resumable state machine:

```
pending -> session_staged -> succeeded
   \              \-> failed -> session_staged (explicit retry)
    \-> failed ----------------> pending        (explicit retry)
```

The first analysis pass is staged but does not change user-visible results. Once
the prompt-quality pass also succeeds, one SQLite transaction snapshots the old
insights, facets, usage rows, and generated title; publishes both prepared
passes; and marks the item successful. Failures therefore leave the old results
visible. Claims are leased so work can resume after a crash, and succeeded items
are never selected again.

Before taking the LLM lock or creating a runner, `reanalyze run` compares every
locked identity field with the current configuration and pipeline. Any provider,
model, endpoint fingerprint, analysis-version, or pipeline-revision mismatch
stops with zero provider requests.

For `N` members, the two logical passes require a minimum of `2N` provider
requests. Long-session chunking, facet extraction, and bounded retries increase
that number. A process crash after a provider response but before its local stage
or publish commit is an unavoidable uncertainty window and may add another
request. `reanalyze retry-failed --yes` grants failed members a fresh bounded
retry budget; `reanalyze cancel --yes` terminally releases the active campaign
without rolling back already-published members.

Campaign and global maintenance pauses are cooperative scheduling boundaries:
an in-flight provider request can finish, but no new pass starts after the pause
or deadline is observed. Scheduled maintenance prioritizes an active campaign
over legacy history batches and defers weekly reflection until that campaign is
complete.

The ordinary analysis queue excludes every unfinished member of an active or
paused campaign when claiming work. The queue row stays pending until the member
succeeds or the campaign reaches a terminal state, avoiding duplicate paid work
between the two schedulers.

---

## Local Dashboard Security Boundary

The Hono server binds to `127.0.0.1`, not an external interface. Security
middleware rejects non-loopback `Host` values and, when supplied, non-loopback
or non-HTTP `Origin` values.

`GET /api/session` bootstraps a random 32-byte, base64url token held only in the
server process. The dashboard caches it only in JavaScript memory and sends it
on later API requests. Every `/api` route except `/api/health` and that bootstrap
requires the token; static assets and health are token-exempt but still pass
the `Host`/`Origin` checks. Restarting the server rotates the token.

This boundary reduces browser-based cross-origin and DNS-rebinding exposure. It
does not protect against another local process running as the same user, and
the SQLite database is not encrypted. See
[SECURITY-MODEL.md](SECURITY-MODEL.md).

---

## Type Architecture (CRITICAL)

Types are defined **once** in `cli/src/types.ts`. This is the single source of truth for the entire monorepo.

```
CLI (cli/src/types.ts)       -> Writes to SQLite
Server (server/src/)         -> Reads from SQLite, exposes via API
Dashboard (dashboard/src/)   -> Reads from Server API
```

**Rules:**
- New SQLite columns MUST have defaults or be nullable (backward compatible)
- Type changes in `types.ts` must be reflected in SQLite migrations
- TA owns this contract — flag all type changes to `technical-architect`

### Key Types (`cli/src/types.ts`)

| Type | Purpose |
|------|---------|
| `ClaudeMessage` | Individual message entry |
| `ParsedSession` | Aggregated session with metadata, title, character |
| `Insight` | Types: summary, decision, learning, technique, prompt_quality; source: 'llm' |
| `FrictionPoint` | Friction with category, severity, resolution, description; optional `attribution` field (`'user-actionable' \| 'ai-capability' \| 'environmental'`) |
| `EffectivePattern` | Pattern with required `category`, `description`, `confidence`; optional `driver` field (`'user-driven' \| 'ai-driven' \| 'collaborative'`); CoT `_reasoning` scratchpad stored in JSON blob |
| `SessionCharacter` | 7 classifications: deep_focus, bug_hunt, feature_build, exploration, refactor, learning, quick_task |
| `ClaudeInsightConfig` | Config format |
| `PQDimensionScores` | Per-dimension PQ averages (overall, context_provision, request_specificity, scope_management, information_timing, correction_quality); used by share card |
| `SyncState` | File modification tracking for incremental sync |

### Friction & Pattern Normalization

Both friction points and effective patterns use canonical category taxonomies with Levenshtein-based normalization (`server/src/llm/friction-normalize.ts`, `server/src/llm/pattern-normalize.ts`).

**Friction categories (9 canonical):** `wrong-approach`, `knowledge-gap`, `stale-assumptions`, `incomplete-requirements`, `context-loss`, `scope-creep`, `repeated-mistakes`, `documentation-gap`, `tooling-limitation`

**Effective pattern categories (8 canonical):** `structured-planning`, `incremental-implementation`, `verification-workflow`, `systematic-debugging`, `self-correction`, `context-gathering`, `domain-expertise`, `effective-tooling`

**Normalization pipeline:** exact match → alias lookup → Levenshtein (distance ≤ 2) → substring match → pass-through (novel category). Normalization runs at write time in `saveFacetsToDb()` and at read time as a belt-and-suspenders guard.

**Legacy alias remapping:** 11 old friction categories (from the original 15-category taxonomy) are aliased to the current 9. See `FRICTION_ALIASES` in `friction-normalize.ts`.

**Attribution model:** Each friction point carries an optional `attribution` field classifying who contributed: `user-actionable` (better input would have prevented it), `ai-capability` (AI failed despite adequate input), or `environmental` (external constraint). Old data without attribution is detected by the `/api/facets/outdated` endpoint.

---

## Server API Routes

### Core Resources

| Route | Method | Purpose |
|-------|--------|---------|
| `/api/session` | GET | Bootstrap the in-memory local-dashboard session token |
| `/api/health` | GET | Server health check |
| `/api/projects` | GET | List all projects |
| `/api/projects/:id` | GET | Project detail |
| `/api/sessions` | GET | Session list with filters |
| `/api/sessions/:id` | GET | Session detail |
| `/api/sessions/:id` | PATCH | Update session (custom title, soft delete) |
| `/api/sessions/:id` | DELETE | Soft-delete a session |
| `/api/sessions/deleted/count` | GET | Count of soft-deleted sessions |
| `/api/messages/:sessionId` | GET | Message content for a session |
| `/api/search` | GET | Search sessions, insights, and patterns |
| `/api/insights` | GET | Browse generated insights |
| `/api/insights` | POST | Create an insight |
| `/api/insights/:id` | DELETE | Delete an insight |

### Analytics & Stats

| Route | Method | Purpose |
|-------|--------|---------|
| `/api/analytics/dashboard` | GET | Analytics overview aggregation |
| `/api/analytics/usage` | GET | Global usage stats |

### Analysis (LLM-Powered)

| Route | Method | Purpose |
|-------|--------|---------|
| `/api/analysis/usage` | GET | Analysis cost/usage data per session |
| `/api/analysis/queue` | GET | Read queue status and next retry/lease wake time |
| `/api/analysis/queue` | POST | Enqueue a validated batch of 1–500 sessions |
| `/api/analysis/session` | POST | Trigger session analysis with LLM |
| `/api/analysis/session/stream` | GET | SSE streaming for session analysis |
| `/api/analysis/prompt-quality` | POST | Trigger prompt quality analysis |
| `/api/analysis/prompt-quality/stream` | GET | SSE streaming for PQ analysis |
| `/api/analysis/recurring` | POST | Find recurring insight patterns |

### Export

| Route | Method | Purpose |
|-------|--------|---------|
| `/api/export/markdown` | POST | Session-level markdown export (Knowledge Base / Agent Rules templates) |
| `/api/export/generate` | POST | LLM-powered cross-session export synthesis |
| `/api/export/generate/stream` | GET | SSE streaming for export generation |

### Dispatch

| Route | Method | Purpose |
|-------|--------|---------|
| `/api/dispatch/generate` | POST | Generate a blog or LinkedIn post from curated insights |
| `/api/dispatch/image-prompt` | POST | Generate a cover-image prompt for a Dispatch result |

### Facets

| Route | Method | Purpose |
|-------|--------|---------|
| `/api/facets` | GET | Session facets data |
| `/api/facets/aggregated` | GET | Pre-aggregated friction/patterns |
| `/api/facets/missing` | GET | Sessions with insights but no facets |
| `/api/facets/outdated` | GET | Sessions missing `effective_patterns.category`/`driver` or `friction_points.attribution` |
| `/api/facets/backfill` | POST | Backfill facets for legacy sessions (`force` option) |
| `/api/facets/missing-pq` | GET | Sessions missing prompt quality analysis |
| `/api/facets/outdated-pq` | GET | Sessions with outdated prompt quality insights |
| `/api/facets/backfill-pq` | POST | Backfill prompt quality for sessions |

### Reflect (Cross-Session Synthesis)

CLI reflection accepts `--source <tool>`. The same source scope is carried
through aggregation, week history, generation, and snapshot lookup, and is part
of the V11 snapshot primary key.

| Route | Method | Purpose |
|-------|--------|---------|
| `/api/reflect/generate` | POST | Cross-session LLM synthesis (SSE streaming) |
| `/api/reflect/results` | GET | Aggregated facet data without LLM synthesis |
| `/api/reflect/weeks` | GET | Data-driven ISO week history, optionally scoped by project/source |
| `/api/reflect/snapshot` | GET | Cached synthesis for a specific week/project/source scope |

### Configuration & Telemetry

| Route | Method | Purpose |
|-------|--------|---------|
| `/api/config/llm` | GET | Current LLM configuration |
| `/api/config/llm` | PUT | Update LLM configuration |
| `/api/config/llm/test` | POST | Test LLM credentials |
| `/api/config/llm/ollama-models` | GET | Discover available Ollama models |
| `/api/config/llm/llamacpp-models` | GET | Discover models exposed by llama.cpp |
| `/api/telemetry/identity` | GET | Telemetry identity and opt-out status |

---

## Dashboard Pages

| Page | Route | Purpose |
|------|-------|---------|
| Dashboard | `/dashboard` | Overview with charts (`/` redirects here) |
| Sessions | `/sessions` | Session list with filters |
| Session Detail | `/sessions/:id` | Full session with analyze button |
| Insights | `/insights` | Browse generated insights |
| Analytics | `/analytics` | Charts: cost, models, projects |
| Patterns | `/patterns` | Cross-session synthesis (Friction & Wins, Rules & Skills, Working Style) |
| Export | `/export` | LLM-powered export wizard (4 formats, 3 depths) |
| Journal | `/journal` | Chronological timeline of learnings and decisions by ISO week |
| Settings | `/settings` | Configuration UI |

---

## Share Card Pipeline

The share card generates a 1200×630 PNG (OG image standard) from Canvas 2D:

```
PatternsPage → useFacetAggregation(period) → WeekAtAGlanceStrip → "Share" button
                                                                       ↓
                                              downloadShareCard() → drawShareCard()
                                                                       ↓
                                              Canvas 2D (2400×1260 @ 2× DPR) → toBlob() → PNG download
```

**Data sources for the card:**
- `computePQScores()` in `server/src/routes/shared-aggregation.ts` — 4-week rolling PQ dimension averages
- Working-style tagline from Reflect LLM synthesis
- Effective patterns from facet aggregation (top 3 by frequency)
- Lifetime session count (all-time, no date filter)
- Token sum from 4-week scoring window
- Source tools from sessions in scope

**Key files:**
- `dashboard/src/lib/share-card-utils.ts` — Canvas 2D drawing logic (`drawShareCard()`, `downloadShareCard()`)
- `dashboard/src/lib/share-card-icons.ts` — Lucide icon + tool logo rendering (`drawIcon()`, `drawToolIcon()`)
- `dashboard/src/components/patterns/WeekAtAGlanceStrip.tsx` — UI component with download trigger
- `dashboard/public/icons/` — Static tool logo assets (SVG/PNG)

---

## Known Architectural Debt

Items identified during the production-grade audit (2026-03-21) and intentionally deferred. Revisit when their trigger conditions are met.

| Item | File | Trigger | Notes |
|------|------|---------|-------|
| Refactor `AnalysisContext` | `dashboard/src/components/analysis/AnalysisContext.tsx` (256 lines) | When parallel/concurrent analyses are needed | Currently mixes SSE streaming orchestration with React state management. Works correctly as a single-analysis state machine. Refactor into separate streaming hook + read-only context when concurrent analysis support is required. |
| Split `route-helpers.ts` | `server/src/routes/route-helpers.ts` (353 lines) | When SSE protocol or middleware evolves independently | 3 cohesive concerns (DB loading, middleware, SSE) always co-imported. Split only if concerns diverge. |
| Remaining `console.warn` monitors | `server/src/llm/response-parsers.ts` | After confirming classification quality is stable | 4 remaining monitors (`[friction-monitor]`, `[pattern-monitor]`) — add env toggle or remove once confident in LLM output quality. |
