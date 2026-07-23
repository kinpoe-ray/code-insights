# Security Model — Code Insights

> This document describes the implemented boundary, not a promise that all data
> always remains on one machine.

## Scope and Assets

Code Insights is a local-first desktop/CLI application. It has no Code Insights
account service and no hosted session database. The assets it handles include:

- raw AI coding sessions and messages;
- generated insights, facets, reflections, and prompt-quality results;
- project paths, titles, timestamps, token counts, and estimated costs;
- LLM API keys and custom endpoint configuration;
- the local SQLite database and filesystem sync checkpoint;
- the process-scoped dashboard session token; and
- the pseudonymous telemetry identifier and allowlisted product events.

Raw sessions and generated results are stored in
`~/.code-insights/data.db`. LLM credentials are stored in
`~/.code-insights/config.json`, which Code Insights creates with user-only
permissions (`0600`).

## Trust Boundaries

| Boundary | Data crossing it | Implemented control |
|---|---|---|
| Source-tool storage → CLI | Raw local session files/SQLite rows | Provider-specific parsers; no account or hosted ingest |
| CLI/server → local SQLite | Raw messages, metadata, generated results | Local WAL database and versioned migrations |
| Browser → loopback Hono server | Dashboard API requests and responses | `127.0.0.1` bind, `Host`/`Origin` checks, process token |
| Analysis engine → LLM endpoint | Session content and analysis prompts | Credential-pattern redaction before provider request |
| CLI/server → PostHog | Allowlisted aggregate product events | Default-on disclosure, sanitizer, explicit opt-out |
| Other local processes → files/port | Anything the operating-system user can read or request | Relies on the host OS and user-account boundary |

## Local Dashboard Boundary

The production server listens on `127.0.0.1`. It does not bind to a LAN or
public interface.

Every request first passes loopback checks:

- `Host` must resolve syntactically to `localhost` or `127.0.0.1`.
- An absent `Origin` is accepted for non-browser clients. When present, it must
  be an HTTP origin whose hostname is `localhost` or `127.0.0.1`.
- `Origin: null`, HTTPS origins, external origins, and cross-site session
  bootstrap requests are rejected.

`GET /api/session` returns a random 32-byte base64url token in the
`X-Code-Insights-Session` response header. It is generated once per server
process, held only in memory, and sent with no-store response headers. The
dashboard caches it only in module memory, not in local storage. A server
restart rotates the token; after a token-related `401`, the dashboard obtains a
new token and retries once.

Every other `/api` request requires that token, including SSE and `OPTIONS`
requests. `/api/health` and static dashboard files do not require the token,
but still pass the `Host` and `Origin` checks.

These controls reduce cross-origin and DNS-rebinding attacks against the local
HTTP service. They are not an authentication boundary against malicious code
already running as the same operating-system user.

## LLM Providers and Custom Endpoints

Cloud analysis sends content directly from the local process to the configured
provider. It does not pass through Code Insights infrastructure.

- OpenAI and Gemini use their provider endpoints.
- Anthropic can use its provider endpoint or a configured compatible base URL.
  Non-loopback custom Anthropic endpoints must use HTTPS, and embedded URL
  credentials are rejected.
- Ollama and llama.cpp support configurable endpoints. They are local only when
  the configured endpoint is local; pointing either at another host creates an
  outbound data boundary.
- Claude Code native analysis is executed through the locally installed Claude
  CLI and is governed by that tool's own account and data-handling settings.

Choose a provider and endpoint whose retention, training, regional, and access
policies meet your requirements. A custom proxy can observe the same redacted
analysis payload as the upstream model.

## Outbound Credential Guard

All supported configured-provider session-analysis paths share one outbound
guard. It clones the messages and redacts matches before token budgeting,
chunking, or an LLM request. The guard does not rewrite the raw messages stored
in SQLite.

The implemented match categories are:

- configured known secrets;
- common fixed-prefix provider tokens;
- JSON Web Tokens;
- authorization values and API-key headers;
- credential assignments in common text/config forms;
- PEM, OpenSSH, and PGP private-key blocks;
- usernames/passwords embedded in URLs;
- access tokens, signatures, and credentials in query parameters;
- cookie values; and
- npm registry credentials.

Redaction reports contain category, count, message index, and text-block index
only; they do not include the matched secret. Supported provider names are
explicitly allowlisted so an unknown provider cannot silently bypass the guard.

This is pattern matching, not a complete secret scanner or data-loss-prevention
system. It can miss unknown formats, short or transformed values, credentials
split across messages, and sensitive business data that is not a credential.
It can also redact benign text. Review sessions before using a cloud or remote
custom endpoint when the material is sensitive.

## Telemetry

PostHog product telemetry is enabled by default. It is better described as
pseudonymous aggregate telemetry than as guaranteed anonymity: events use a
stable hashed machine identifier and may include CLI version, Node version,
operating system, architecture, installed provider names, hook presence, and
total session count.

Only these caller-supplied properties are allowed across the telemetry
boundary:

`success`, `duration_ms`, `sessions_synced`, `sessions_by_provider`, `errors`,
`source_filter`, `subcommand`, `period`, `port`, `error_type`, `command`,
`hook_types`, `sync_installed`, `analysis_installed`,
`sessions_recalculated`, `insight_count`, `type`, `count`, `format`,
`template`, `session_count`, `scope`, `depth`, `llm_provider`, `llm_model`,
`input_tokens`, `output_tokens`, `cache_creation_tokens`,
`cache_read_tokens`, and `cost_usd`.

Unknown properties are dropped. String properties must pass additional shape
and sensitive-pattern checks. Session messages, prompts, model responses, file
paths, API keys, and free-form errors are not intended telemetry fields.

Disable telemetry with any of:

```bash
code-insights telemetry disable
CODE_INSIGHTS_TELEMETRY_DISABLED=1 code-insights
DO_NOT_TRACK=1 code-insights
```

## Local Storage and Threat Assumptions

SQLite data is not encrypted by Code Insights. Anyone who can read the database
files can read raw session content and generated analysis. WAL and backup files
may contain the same material. Credential redaction protects the LLM outbound
boundary; it does not sanitize data at rest.

The model assumes the user's operating-system account and machine are trusted.
A malicious or compromised process running as that user may be able to read the
database/configuration, call the loopback API, inspect process memory, or alter
source sessions. Disk encryption, OS account separation, endpoint protection,
backup controls, and file permissions remain the user's responsibility.

Deleting or resetting Code Insights data does not delete the original source
tool sessions, provider-side records, telemetry already delivered, or copies in
filesystem backups.

## Security Practices

Changes to a trust boundary should include tests for both allowed and rejected
cases. In particular:

- keep the server loopback-only and preserve `Host`/`Origin` validation;
- keep session tokens random, process-scoped, no-store, and out of persistent
  browser storage;
- route every configured LLM provider through the shared credential guard;
- add new telemetry properties to the explicit allowlist only after privacy
  review;
- use versioned, idempotent migrations for SQLite changes; and
- never log or include matched secrets in redaction reports or test fixtures.

Dependency and CI findings should be treated as risk signals, not proof that a
release is secure. Review custom endpoints and new providers as separate trust
boundaries.

## Reporting a Vulnerability

Use the repository's private GitHub vulnerability-reporting channel when it is
available. If it is not available, open a minimal public issue asking the
maintainer for a private contact path. Do not put live credentials, private
session content, exploit payloads, or unredacted local paths in a public issue.

Include the affected version/commit, operating system, impact, reproduction
steps using synthetic data, and any suggested mitigation. Rotate any real
credential that may have crossed an unintended boundary; redaction after the
fact cannot revoke it.
