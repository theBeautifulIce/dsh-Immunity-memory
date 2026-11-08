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
- [x] Measure real token cost of capture/review and add adaptive throttling.
- [ ] Optional user-defined trigger rules without code changes.

## v0.5 — Operations and observability

- [x] Maintenance dashboard: last run, duration, archived, deduped, promoted.
- [x] Slow-query log and retrieval score breakdown in the UI.
- [x] Injection hit rate, token cost trend, and memory health score.
- [x] Backup verification (restore into a temporary store and run integrity).
- [x] Retention policies per layer and per notebook.
- [x] Structured JSON logs with rotation.
- [x] Downloadable diagnostics bundle (status, settings, backups and audit in one file).

## v1.0 — Production readiness

- [ ] Stable schema and tool contracts with deprecation policy.
- [ ] Cross-platform release artifacts and checksums.
- [ ] Migration tests from every prior released schema.
- [ ] Security review of the local HTTP API and token handling.
- [ ] Performance budgets enforced by benchmark regressions.
- [ ] Complete Chinese/English docs and a contributor guide.
- [ ] At least one external user upgrade story validated end to end.

## Measured limits of lexical ranking

Measured on the public `natural-timegrid-20261101-v2` set (714 questions, 1 turn
per item, 30-item injection budget), single-run v0.4.10 code:

| variant | @1 | @3 | @10 | in list | marked hits | wrong marks |
| --- | --- | --- | --- | --- | --- | --- |
| baseline | 62.7% | 83.6% | 90.3% | 94.1% | 22.1% | 9.9% |
| PRF off | 63.0% | 83.8% | 90.3% | 94.0% | — | — |
| PRF seed 0.15 | 60.6% | 83.6% | 90.6% | — | — | — |
| BM25 b = 0.5 | 62.7% | 83.5% | 90.1% | 94.1% | 17.8% | 8.4% |
| BM25 b = 0.9 | 61.9% | 83.6% | 90.5% | 94.3% | 18.5% | 7.8% |

Every PRF/BM25 parameter, including the title-and-questions term weight, moves
recall by at most two questions — noise. Lowering `b` only trims wrong hit
badges. Title/question weight is not measurable on this set at all: the benchmark
items are titled `day N - turn N` and carry no questions, so the strong-token
channel never fires (three weight variants scored identically to the baseline).

Conclusion: lexical ranking is saturated at ~83.6% @3 and 94.1% in-list. The
remaining 42 misses are paraphrases, pronoun references and answers that span
several turns. Going further requires semantic similarity (an actual embedding
model, not the 384-dim feature hash) or relationship edges built from something
other than word overlap.

## Measured limits of the relationship graph

v0.4.11 derives `related` edges from token cosine (see CHANGELOG) and gives injected
neighbours a bonus. Same 714 questions, same 30-item budget, graph edges built per
query:

| graph bonus | @1 | @3 | @10 | in list | missed |
| --- | --- | --- | --- | --- | --- |
| off (v0.4.10) | 62.7% | 83.6% | 90.3% | 94.1% | 42 |
| 0.30 | 61.9% | 84.7% | 90.3% | 94.2% | 41 |
| 0.15 | 62.5% | 84.3% | 90.6% | 94.4% | 40 |
| 0.12 | 62.5% | 83.6% | 90.6% | 94.1% | 42 |

A word-overlap graph buys at most +8 questions at @3, and it buys them by taking
them from @1: at 0.30, @1 drops by 6. At 0.12 the change is neutral-to-positive
(@10 +2), which is why that is the default.

The limit is structural, not a tuning problem. These edges connect items that were
written with the same words. A question about the same event phrased in other words
("where did the lightbox thing get stuck?") still has no path to the answer. What the
graph *does* buy, beyond these six points: `memory_search` finally walks real edges
for its 0.2-weighted graph channel, conflict/related structure is visible in the store,
and duplicate clusters become discoverable without comparing every pair.

Next step for recall is a real semantic channel. The injection path is synchronous
(`buildDigest()` scores inline), so that work starts with making the channel async or
precomputing vectors at write time, not with swapping a model in.

How dense is the graph in practice? On the live store (39 memories) at edge threshold
0.22: 44 directed edges, 19 components, largest cluster 6, 7 items with no neighbour.
At 0.28 the same store leaves 22 items isolated; at 0.18 it collapses into one 39-item
blob. That is why 0.22 is the default: below it every memory is "related" to every other,
above it most memories stand alone.

## Measured limits of the injection budget

For a while the note here said the 6000-character cap was what kept answers out. It was
not; `prompt.topN` was clamped to 30, so the bench request for 45 lines was silently
folded back to 30 and the two runs looked identical. One missed question measured directly:
30 lines cost 3,323 characters, 45 cost 4,854 — both inside the cap — and the answer was
there at line 45.

| lines | @1 | @3 | @10 | in context | missed |
| --- | --- | --- | --- | --- | --- |
| 30 | 446 (62.5%) | 597 (83.6%) | 647 (90.6%) | 672 (94.1%) | 42 |
| 45 | 446 (62.5%) | 597 (83.6%) | 647 (90.6%) | 690 (96.6%) | 24 |
| 60 | 446 (62.5%) | 597 (83.6%) | 647 (90.6%) | 697 (97.6%) | 17 |

Line count and top ranks are independent: extra lines only ever arrive below the answered
ones, so @1/@3/@10 do not move. The cap is now 60 for anyone who overrides the template
budget; defaults stay at 6-10 lines because a longer prompt is not free.

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
