# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses
[Semantic Versioning](https://semver.org/).

## [Unreleased]

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
