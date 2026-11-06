# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses
[Semantic Versioning](https://semver.org/).

## [Unreleased]

### Planned

- Linux/macOS prebuilt binaries and a release pipeline.
- Pluggable embedding providers and a retrieval evaluation set.
- Per-project memory spaces and conflict-merge policies.

### Fixed

- Refresh the package metadata description so it matches the shipped
  eight-layer memory, four notebooks, hybrid retrieval, templates, and UI.
- Resolve the repository root and the DSH web profile from the current
  checkout and `DSH_HOME` instead of hard-coded developer paths in the client
  render test.

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

[Unreleased]: https://github.com/theBeautifulIce/dsh-Immunity-memory/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/theBeautifulIce/dsh-Immunity-memory/releases/tag/v0.1.0
