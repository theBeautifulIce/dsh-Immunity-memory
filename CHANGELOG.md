# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses
[Semantic Versioning](https://semver.org/).

## [Unreleased]

## [0.4.5] - 2026-11-08

Tighten the `·命中` badge so it means something: only the item that is clearly
the best match of the turn gets it, and unrelated questions no longer light up
half the digest.

### Fixed

- The hit badge no longer fires on background noise. A single common word
  (「一下」「这段」) used to be enough to reach the old 0.12 threshold; a line is
  now marked only when its relevance is the strict maximum of the turn, is at
  least 1.5× the next distinct score, and matches at least two query tokens.
- Ties are treated as "cannot tell them apart" and mark nothing, instead of
  marking every tied line.
- `injectionStats()` lines now carry `matched` (how many query tokens the item
  hit) alongside `relevance`, and `query.hitBar` reports the effective threshold
  (`null` when this turn marks nothing). The field had been dropped when the
  stats objects were rebuilt.

### Tests

- `tests/recall.test.mjs` grew to 7 cases: an unrelated question
  (「今天上海天气怎么样」) and a single-token question must both leave the digest
  unmarked, and a real hit must cover at least two query tokens.
- `scripts/recall-eval.mjs`: sandbox evaluation harness — 21 seeded memories,
  20 recall questions plus 3 negatives, reporting `@1/@3/@5` and badge accuracy.
  Current numbers: `@1` 18/20, `@3` 20/20, `@5` 20/20, 13/20 badged, 0 false
  badges across the 3 negatives.

## [0.4.4] - 2026-11-08

Recall reranking: the injected digest now follows what the current turn is
about, instead of always replaying the highest-importance items.

### Added

- Per-turn context for ranking: the last eight user messages and failed tool
  results (700 characters each, 30-minute TTL, memory only — never persisted,
  never exported) are recorded via `engine.noteTurnContext()` and reset when the
  session changes.
- `promptDigest()` / `injectionStats()` now report `query` (`used`, `tokens`,
  `chars`, `preview`), and every injected line carries `relevance`. Lines above
  the hit threshold are labelled `·命中`, so "relevant to this turn" is visually
  distinct from "background".
- `engine.turnContext()` exposes what the ranking currently sees.

### Changed

- Query tokens are filtered by document frequency before scoring: tokens no
  memory mentions, and tokens more than half of the memories mention, are
  dropped, and at most 32 remain. A long turn therefore keeps its discriminating
  words instead of diluting relevance to zero.
- `scoreItem()` delegates the lexical half to `queryRelevance()`; the ranking
  weights are unchanged (`relevance 0.55 / importance 0.2 / recency 0.15 /
  access 0.1`, × status weight, × forgetting factor, + pin boost), so with no
  turn context the order is exactly what it was before.
- Injection is skipped back to importance-only ranking above 4000 candidate
  items, so a very large library cannot turn every request into a full scan.

### Tests

- New `tests/recall.test.mjs` (5 cases): importance-only order without context,
  a tool error pulling the matching memory to the front with a hit marker,
  duplicate suppression, session switch reset, and blank input ignored.

## [0.4.3] - 2026-11-08

Audit transparency, human-source detection, and a clearer split between what
the agent may touch and what only the user may touch.

### Fixed

- Audit denials for `memory_write` / `memory_update` now carry the pending
  payload into the approval dialog: tool, action, target id, layer, importance,
  TTL, tags, title, body, and quote. Previously the dialog showed only the
  judge's comment, so approving meant approving text the user could not see.
  The body is capped at 1200 characters and the whole reason at 2000.
- The pending snapshot is built before `recordAuditRun`, so a store failure can
  no longer produce a denial with no content.
- `sourceQuote()` no longer discards user messages delivered by a channel
  plugin: a `source.kind` of `plugin:<id>` (for example `plugin:dsh-onebot` for
  QQ) now counts as the user's own words, and a missing or non-object source
  falls back to `data.message.role` / `data.role`. When no quote can be found it
  logs a warning with up to five source samples instead of staying silent.
- Immutable layers (L0 / L1 / L3) are read-only to the agent only. The user can
  edit and delete them in the panel without enabling anything;
  `assertLayerWritable(active, layer, actor)` defaults to `'agent'`, and the
  delete / update guards check `actor !== 'user'`. The settings switch is now
  labelled "also let the agent edit immutable layers".
- Approving or rejecting a consolidation candidate no longer fails with
  `NOT_CANDIDATE` when the list legitimately shows states the guard did not
  expect (`new`, `rejected`): the check now asks
  `consolidationCandidates()` whether the entry is actually listed.

### Added

- `items.list` returns `content`, and the consolidation panel renders the
  candidate body plus a state chip (not proposed / pending audit / rejected
  before / consolidated) with per-row busy labels.
- The notebook filter gained an "all notes" option (empty id); new items still
  default to the `memory` notebook, which is now named "fragment notes" with a
  one-line hint (who / where / what it is called / how much).

### Tests

- `tests/client.render.mjs` asserts the client never calls `window.prompt(`,
  because some DSH desktop builds do not implement it and the click silently
  does nothing.

## [0.4.2] - 2026-11-06

### Fixed

- Approving or rejecting an audit candidate no longer depends on
  `window.prompt`. Some DSH desktop/webview builds do not support it, so the
  button could fail before entering the busy state or sending `audit.decide`.
  Audit notes are optional and an empty note is now submitted directly.

## [0.4.1] - 2026-11-06

UI and documentation polish for automatic memory capture.

### Changed

- Change cards now mark the operation with a small colored dot inside the
  operation badge instead of a thick colored left border.
- Reworded the automatic-capture responsibility boundary: the plugin detects,
  queues, and deduplicates; the agent decides fact, layer, and TTL. The audit gate
  still covers the two explicit `memory_write` / `memory_update` entry points.

## [0.4.0] - 2026-11-06

Automatic-memory capture release: signal detection, hourly/daily review queues,
and a dedicated capture tool, while the agent remains responsible for every fact,
layer, and TTL decision.

### Added

- `memory_capture` tool and capture service: the agent submits `facts` (each with
  an explicit mutable layer and `ttlDays`) and `notes` (notebook entries). Reports
  created/skipped/errors and can clear a handled reminder with `pendingId`.
- Immediate capture signals from `session/event`: user corrections, remember
  requests, clear satisfaction/dissatisfaction, and assistant self-correction.
  Signals are queued, never written directly; the system prompt shows pending
  signals and the capture rules.
- Small/large review timers: every X hours review the previous X hours, and a
  daily review at a configurable `HH:MM` with a configurable lookback. Queued
  reviews are handled by the agent like any other capture.
- `autoCapture` settings group and schema: enable/disable, immediate signals,
  hourly/daily cadence, review windows, max facts/notes, notebook dedupe threshold,
  and queue size.
- Code-level notebook deduplication: NFKC normalization plus exact/Jaccard matching
  within the same notebook; memory-layer writes still use engine semantic dedupe.
- Seeded/queued capture state is persisted under `meta.capture`, with pending
  signals, recent runs, and last review timestamps shown in diagnostics and the
  maintenance panel. `capture.stats` / `capture.tick` API methods are available.
- `memoryWriteHooks` service remains the low-level write-lifecycle extension point;
  automatic capture is intentionally separate and model-driven.

### Tests

- Engine 61, tools 15, API 24, render 21; full self-check 35 syntax modules plus
  audit 12, search 10, SQLite 13, native 6, Go service 12, engine×Go 8.

### Notes

- The plugin does not extract facts or guess layers/TTLs. If the model does not
  call `memory_capture`, nothing is written; this is deliberate.
- Triggers are heuristic and only produce reminders; token cost depends on how
  often the agent acts on them and should be measured in real use before tuning.

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
