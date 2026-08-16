# CONTEXT.md — Code Insights domain glossary

Domain vocabulary for this repo. Use these terms (not ad-hoc synonyms) in code
names, docs, and reviews. Architecture vocabulary (module, seam, adapter,
locality, leverage) follows `/codebase-design`.

## Sessions & sync

- **Session** — one AI coding conversation from a source tool, stored in the
  `sessions` table. Never "conversation" or "chat" in code names.
- **Source tool** — where a session came from: Claude Code, Cursor, Codex CLI,
  Copilot CLI, VS Code Copilot Chat.
- **Sync** — parsing raw session history files into SQLite. Produces sessions
  and message rows; does not analyze.

## Analysis

- **Two-pass pipeline** — the single analysis execution + persistence path
  (cli/src/analysis/two-pass-analysis.ts): **freeze** → **prepare** both passes
  → **publish** atomically. Both the CLI queue and every dashboard endpoint go
  through it. There is no second pipeline.
- **Freeze** — point-in-time load of a session's rows plus a stable
  `input_revision` hash. All passes run against the frozen input.
- **Prepare (pass 1 / session pass)** — LLM extraction of summary, decisions,
  learnings, and facets. No DB writes.
- **Prepare (pass 2 / prompt-quality pass, "PQ")** — LLM extraction of prompt
  quality findings/takeaways/dimension scores. Retry-on-malformed-output is
  part of the pass. No DB writes. Can run alone (PQ-only re-run) via
  `preparePromptQualityPass` without a session stage.
- **Publish** — one SQLite transaction replacing all visible artifacts
  (insights, facets, title, usage rows) or nothing. `publishPreparedTwoPass`
  (full run) and `publishPreparedPromptQualityPass` (PQ-only re-run).
- **AnalysisPassError** — structured prepare failure; `message` is user-facing,
  `details.errorType` maps onto consumers' error-type contracts.
- **Insight** — one persisted row: `summary` | `decision` | `learning` |
  `prompt_quality`.
- **Facets** — structured per-session classification (outcome, workflow
  pattern, friction points, effective patterns). Stored separately from
  insights; also backfillable standalone (`extractFacetsOnly`).
- **Usage row** — one `analysis_usage` record per published pass, stamped with
  `input_revision` + `pipeline_revision` + `session_message_count`.

## Freshness

- **Freshness contract** — `isAlreadyAnalyzed` (cli/src/commands/insights.ts):
  a session counts as analyzed only when BOTH pass types have usage rows
  matching provider, model, input revision, and pipeline revision
  (`completed_passes = 2`). Missing revisions fail closed = not analyzed.
  Anything that writes analysis results must go through publish.

## Orchestration

- **Queue** — the durable per-session analysis queue (`analysis_queue`,
  queue-worker) fed by hooks/sync.
- **Campaign** — the reanalyze machinery (`reanalyze`, history-refresh-db):
  batch re-analysis of history with claims/leases/retry budgets.
- **Patterns / reflect** — weekly cross-session synthesis (friction points,
  effective patterns, prompt-quality trends). Read side; not part of two-pass.
- **Recurring insights** — LLM grouping of existing insights into themes.

## Provider seam

- **LLMClient** — the configured-provider interface (chat, estimateTokens,
  capabilities, prepareMessages). Routed through the shared analysis engine.
- **AnalysisRunner** — the wider runner interface; the native runner
  (`claude -p`) implements it without being an LLMClient. Prepare passes
  accept either and dispatch via `isAnalysisLLMClient`.
