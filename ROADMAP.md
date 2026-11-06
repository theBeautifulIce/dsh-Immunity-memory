# Roadmap

This roadmap describes direction, not a promise of dates. Priorities may change
after user feedback, DSH API changes, or performance findings.

## Principles

1. **Local-first**: no cloud memory service is required for the core loop.
2. **Auditable**: every mutation and injection path should be explainable.
3. **Degrade, don't disappear**: a missing native component must not break the
   plugin; it must be visible in health/settings.
4. **Agent chooses the mutable layer**: the setting should not hard-code one
   writable layer for all content.
5. **TTL by default for mutable memories**: no silent permanent default.
6. **Small public surface**: keep the tool surface stable and justify each addition.

## v0.2 — Stability and distribution

- [ ] Linux x64 and macOS (arm64/x64) prebuilt binaries.
- [ ] GitHub Actions matrix: syntax + engine + API + render on Windows/Linux.
- [ ] One-command install from a tagged GitHub release.
- [ ] Version compatibility check between plugin, Go service, and native core.
- [ ] Upgrade/rollback path that preserves the memory database.
- [ ] Health page shows protocol versions and last handshake time.
- [ ] Fix remaining hard-coded local paths in tests and scripts.

## v0.3 — Memory quality

- [ ] Pluggable embedding providers; keep HashEmbedding as the offline default.
- [ ] Retrieval evaluation set with recall@k / MRR, run in CI.
- [x] Conflict-merge policy for L2 and consolidation candidates.
- [x] Forgetting curve in retrieval scoring (importance is not silently rewritten).
- [x] Per-project / per-workspace memory spaces.
- [ ] Better duplicate detection across notebooks and layers.
- [ ] Template packs: export/import a set of L0/L1/L3 entries.

## v0.4 — Automatic memory capture

- [x] Immediate signals: user correction, remember request, satisfaction/
      dissatisfaction, and assistant self-correction.
- [x] Hourly review of the previous window and a configurable daily review.
- [x] `memory_capture` tool: the agent explicitly chooses facts, layers, and TTLs.
- [x] Code-level notebook deduplication; memory layers keep semantic dedupe.
- [x] Capture state, diagnostics, and maintenance-panel card.
- [ ] Measure real token cost of capture/review and add adaptive throttling.
- [ ] Optional user-defined trigger rules without code changes.

## v0.5 — Operations and observability

- [x] Maintenance dashboard: last run, duration, archived, deduped, promoted.
- [x] Slow-query log and retrieval score breakdown in the UI.
- [x] Injection hit rate, token cost trend, and memory health score.
- [ ] Backup verification (restore into a temporary store and run integrity).
- [ ] Retention policies per layer and per notebook.
- [ ] Structured JSON logs with rotation and a downloadable diagnostics bundle.

## v1.0 — Production readiness

- [ ] Stable schema and tool contracts with deprecation policy.
- [ ] Cross-platform release artifacts and checksums.
- [ ] Migration tests from every prior released schema.
- [ ] Security review of the local HTTP API and token handling.
- [ ] Performance budgets enforced by benchmark regressions.
- [ ] Complete Chinese/English docs and a contributor guide.
- [ ] At least one external user upgrade story validated end to end.

## Non-goals

- A hosted multi-tenant memory service.
- Replacing the model's own reasoning with a knowledge graph.
- Storing every chat message verbatim by default.
- A general-purpose vector database or RAG framework.
- Silently uploading memory content to a third party.

## How to influence the roadmap

Open a feature request with the problem, the current workaround, and the
expected behavior. Concrete use cases and reproduction data are more useful
than a list of features. See [`CONTRIBUTING.md`](CONTRIBUTING.md).
