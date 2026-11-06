# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses
[Semantic Versioning](https://semver.org/).

## [Unreleased]

## [0.3.1] - 2026-11-06

Patch release exposing the write-lifecycle hook registry to other Cordis plugins.

### Added

- `ctx.provide('memoryWriteHooks', engine.writeHooks)`: sibling plugins can call
  `ctx.get('memoryWriteHooks')` and register before/after handlers without
  importing the engine. Bootstrap now reports `writeHooks.service`.

### Notes

- Registering a hook does not create or update memories automatically. Automatic
  update remains a policy that a registering plugin must implement.

## [0.3.0] - 2026-11-06

Memory-quality and observability release: conflict resolution, forgetting curve,
per-project spaces, maintenance/slow-query diagnostics, memory health score, and
generic write-lifecycle hooks.

### Added

- Conflict resolution (`conflicts.resolve`): explicitly keep one side, or merge
  title/content/tags into the winner, archive the loser with `supersededBy` /
  `validTo`, and record the decision in the audit log. The editor exposes
  “keep this entry” and “merge body” actions.
- Forgetting curve: retrieval score multiplies the base score by a configurable
  exponential decay (`retrieval.forgetting.*`, based on `lastAccessAt`), with a
  floor so old memories remain reachable. Importance itself is not silently
  rewritten.
- Per-project memory spaces: entries carry an optional normalized `workspace`;
  writes default to the current session cwd, searches default to that project
  plus global entries, and `workspace: "*"` searches everything. Same-key and
  conflict detection are scoped to one workspace.
- Observability: `diagnostics` API and maintenance card show a 0–100 health
  score with issue breakdown, recent maintenance runs, slow queries, and the
  latest injection hit rate. `maintenance.slowQueryMs` / `slowQueryKeep` and
  `maintenance.historyKeep` are configurable.
- Generic write hooks (`lib/write-hooks.js`): register before/after handlers for
  create, update, import and conflict resolution. Before hooks can rewrite input
  or block with a reason; hook errors fail open. `hooks.list` and the bootstrap
  payload expose the registry; the maintenance page shows registered hooks.

### Changed

- `memory_write` / `memory_search` accept `workspace`; `memory_get`,
  `memory_update` and `memory_forget` validate the current project scope.
- `promptDigest` records the ids it injected, so the next searches can compute a
  real injection hit rate.

### Fixed

- Slow-query logging treats `maintenance.slowQueryMs = 0` as “log every search”
  instead of silently clamping to 1 ms.
- Conflict resolution rejects cross-project or cross-layer pairs instead of
  merging unrelated entries.
- Same-key writes still renew TTL, and conflict rejection no longer archives an
  update target that was never applied.

## [0.2.0] - 2026-11-06

Write-audit hook with a pending-candidate queue, isolated-judge token accounting,
entity keys / provenance / supersedes, and a hardened audit approval path.

### Added

- Write-audit hook (`hook.*`, default off): an isolated subagent reviews every
  `memory_write` / `memory_update` against the user's turn, with enforce vs
  shadow mode, confidence threshold, timeout fail-open, candidate queue, and
  per-run input/output/cache token accounting.
- Entity keys and versioning: `memory_write` with the same `key`, layer, type,
  and notebook updates the active entry in place instead of appending a
  duplicate; `supersedes` archives old versions and hides them from prompt
  injection and default search.
- Provenance on writes: `quote` captures the user's source text and `turn`
  records where it came from; `memory_get` surfaces both.
- Audit tab in the sidebar page with hook toggle, token KPIs, pending
  candidates, approve/reject, and recent runs.

### Fixed

- Keep the long-term-memory prompt header visible when the store is empty, so a
  brand-new session still learns that `memory_write`/`memory_search` exist
  instead of seeing only the tool schemas.
- Refresh the package metadata description so it matches the shipped
  eight-layer memory, four notebooks, hybrid retrieval, templates, and UI.
- Resolve the repository root and the DSH web profile from the current
  checkout and `DSH_HOME` instead of hard-coded developer paths in the client
  render test.
- Renew the freshness period when an idempotent same-key write repeats the same
  content, and stop counting already-decided audit candidates as pending while
  including both rejected and needs-user denials in the blocked KPI.
- Keep the write-audit hook fail-open when settings or the audit ledger cannot be
  read/written, and time out `startActivation` as well as the judge result.
  Concurrent decisions are serialized, an already-persisted candidate is adopted
  after a crash instead of being written twice, long candidate content is kept
  in full through approval, and rejecting an update candidate no longer archives
  a memory that the update never touched.

## [0.1.0] - 2026-11-06

First public release of **dsh-Immunity-memory** (technical plugin id:
`dsh-memory-plugin`).

### Added

- Eight-layer memory model (L0-L7) with immutable L0/L1/L3 and mutable
  L2/L4-L7; the agent selects the mutable layer by content.
- Four notebooks: memory, daily, asset, and pitfall. Pitfall notes use the
  symptom / root cause / fix / prevention shape with record, search, and
  check operations.
- 10 agent tools: `memory_write`, `memory_search`, `memory_get`,
  `memory_update`, `memory_forget`, `memory_stats`, `memory_usage`,
  `memory_consolidate`, `memory_pitfall`, and `memory_diff`.
- Hybrid retrieval: SQLite FTS5 bm25, 384-dimensional hashed-vector cosine,
  and graph BFS, fused with configurable weights (default 0.4 / 0.4 / 0.2).
- Go memory service with SQLite persistence, FTS5, graph traversal, audit,
  backup, integrity checks, and graceful shutdown.
- Optional Rust native core for batch cosine, importance scoring, and
  similarity/dedupe; automatic JavaScript fallback when unavailable.
- Memory templates organized by L0/L1/L3 immutable entries, with hot
  switching while L2/L4-L7 shared memories remain untouched.
- Prompt injection with preview, per-layer token counts, and a usage ledger
  for query/result tokens.
- Consolidation candidates with agent or UI review; approved entries become
  permanent L1/L3 memories and lose their TTL.
- Hard TTL requirement for mutable writes and updates (`TTL_REQUIRED` when
  omitted), plus expiry cleanup and archive maintenance.
- Git-style red/green change diff in the UI, with line-level LCS and
  human-readable field formatting; `memory_diff` and the API stay lossless
  JSON.
- Sidebar "Memory" page and settings section: memories, notebooks, pitfalls,
  changes, usage, consolidation, settings, and maintenance.
- Chinese/English UI and plugin metadata.
- Versioned SQLite migrations, WAL, rotating backups, restore, export/import,
  and integrity checks.
- Self-check suite: syntax, engine, tools, retrieval, SQLite, native, Go
  service, API, and client render tests.
- Benchmark tooling and a performance report.

### Security

- Data is stored locally; no cloud memory API or extra credentials are used.
- The loopback Go service uses a random token per process.
- Backups and memory databases are treated as sensitive local data.

[Unreleased]: https://github.com/theBeautifulIce/dsh-Immunity-memory/compare/v0.2.0...HEAD
[0.2.0]: https://github.com/theBeautifulIce/dsh-Immunity-memory/releases/tag/v0.2.0
[0.1.0]: https://github.com/theBeautifulIce/dsh-Immunity-memory/releases/tag/v0.1.0
