# gbrain lessons for 10db

Source: garrytan/gbrain, shallow clone at commit 95ebf77a (VERSION 0.60.213.0, 2026-10-13). Nothing was run or built. Tags: VERIFIED = read in source/doc/issue (reference given); INFERRED = my reading.

Scale caveat: gbrain is a very large, fast-moving, agent-written codebase (CHANGELOG.md is 39k lines; 6,600+ issues/PRs). Its stated production brain is ~155k pages. 10db is far smaller, so many of its costs (managed write coordination, git publication) are not 10db's problem.

## 1. Source of truth

- VERIFIED (docs/architecture/system-of-record.md): "Canonical Markdown and frontmatter are the system of record for file-backed knowledge. Their database indexes can be rebuilt from those files. DB-only knowledge and operational state still need a separate backup." Rebuild is `gbrain sync && gbrain extract all`; for PGLite, `gbrain reinit-pglite` wipes the embedded DB first.
- VERIFIED (same doc): three categories. FS-canonical (takes, facts, links, timeline, tags are stored as fenced tables / inline markers / frontmatter in the page and reconciled by `extract ...` phases). Derived (pages, content_chunks, page_versions). DB-only by design (raw_data, job queue, OAuth tokens, request log, eval captures, withdrawal ledger, mutation journal/receipts, write attribution).
- VERIFIED: the "both" reality is messy. Facts saved without an entity have no fence and exist only in the DB. Withdrawal decisions must survive stale imports, so the ledger is DB-only. Page version history and attribution are not rebuildable. The README itself says "Markdown export is not a full database backup."
- VERIFIED edit reconciliation: hand edits to files are picked up by `sync` (content_hash change triggers re-chunk and re-embed). Programmatic writes go through a "managed" path since v0.51: durable request with revision precondition, native worktree lock, record recovery data, atomic file replace, DB commit with receipt, then embedding and git effects as separate retryable states (system-of-record.md "Page-write persistence boundary"). Direct filesystem readers can observe a file/DB publication gap.
- VERIFIED pain from this design: v0.51.0.0 write coordination blocked every plain write on single-machine PGLite brains (#5392). Maintainers declined an "inert single-writer mode"; they added `gbrain sources writer deactivate` instead. Many bugs in the #5xxx-#6xxx range are file/DB drift (#6541 facts rows exist but stored body has no fence; #5170 extract keeps links removed from Markdown; #3625 a facts fence below the timeline sentinel silently deletes indexed rows; #5158 frontmatter key order defeats unchanged-page dedup; #3694 two content_hash formulas cause unbounded re-import).
- INFERRED for 10db: dual truth is the single most expensive thing in gbrain's history. 10db has no Markdown requirement, so make the database the only truth and add a one-way export if wanted.

## 2. Storage

- VERIFIED (docs/ENGINES.md): two engines behind one `BrainEngine` interface (100+ methods, src/core/engine.ts). PGLite is "the zero-config default"; PostgresEngine (Supabase or any Postgres + pgvector) is the "production scale path". The doc's own table says PGLite is "Good for < 1,000 files", single machine, single process, manual backups; Postgres is "production-proven at 10K+".
- VERIFIED abstraction: one schema (src/schema.sql, plus a generated `pglite-schema.generated.ts`), numbered migrations in src/core/migrate.ts (schema ~v215 in #6649), and since the "engine-sql" refactor the SQL for each storage domain is written once in src/core/engine-sql/ because "both engines speak the same SQL dialect". Parity pinned by test/e2e/engine-parity.test.ts. Extensions used: vector (HNSW), pg_trgm, pgcrypto; FTS is tsvector + GIN.
- VERIFIED: `gbrain migrate --to postgres` ("graduation") carries history, withdrawals, grants, ownership (PR #6022). The reverse path is a lossy legacy copier. Leftover PGLite store after migration stayed on disk at 2x size until fixed (#3856, PR #6106 `--discard-source`).
- VERIFIED SQLite: considered and rejected. CONTRIBUTING.md:608 and docs/GBRAIN_V0.md:532: "SQLite engine. Superseded by PGLite ... same SQL dialect as Postgres and eliminates the need for a separate FTS5/sqlite-vss translation layer". PR #291 (bun:sqlite + FTS5 engine) was closed unmerged: the maintainer said he did not want such a core change while ~600 PRs were backlogged (the PR was later listed HELD in docs/designs/COMMUNITY_IDEAS.md:308 as conflicting with "two-engine lockstep" and the "Postgres-for-memory North Star", while calling the "zero-WASM single-file install story" "strategically interesting"). No technical failure of SQLite was ever demonstrated; the reason is Postgres-lineage lock-in (pgvector, tsvector, a Supabase path), which does not apply to 10db.
- INFERRED: the reason for PGLite over SQLite is "same dialect as the production Postgres they already ran for Garry's 150k-page brain", not any PGLite advantage over SQLite as an embedded store.

## 3. PGLite in practice

Issue search is noisy; counts below are from `gh issue list --search "pglite in:title"` plus targeted searches (about 45 PGLite-titled issues, about 55 PGLite-titled PRs, all but ~10 closed). PGLite pinned at 0.4.3/0.4.4 (PG 17).

Startup crash / WAL corruption (the dominant theme, roughly 15 issues over 6 months)

- #223 (Apr 2026, closed Aug 9), #391, #519, #939, #1195, #1478, #1502, #1670, #1954, #1955, #2195, #2575: `RuntimeError: Aborted()` on PGLite init across macOS, Linux, Windows x64/ARM64. Initially blamed on "macOS 26.3 WASM bug". VERIFIED (PR #3901, v0.42.75.0): that was a misdiagnosis; an unclean shutdown tears the WAL and every later open dies replaying it. Fix: in-place WAL repair ported from rejected upstream electric-sql/pglite#994 (a `pg_resetwal` in TypeScript), auto-run on connect, plus `gbrain pglite-repair`. Misleading error banners were their own issues (#1870, #2674, PR #3519). #1346: repair path not wired for a while.
- #1872: SIGTERM of the daemon (systemctl stop) corrupted the engine; needed full reinit and resync. Fixed by graceful close PRs (#3271, #3775, #2392).
- #2058: lock reaper force-removed locks of LIVE processes after 5 minutes; observed 4 concurrent serves in one data dir with WAL corruption. Fixed (PR #2154 fail closed on stale heartbeat). Related lock bugs: #251, #4932 (older CLI bypassed lock and reached WAL), #5072, PR #4331/#3784 (PID reuse).
- #5216: migration 150 blocked by "torn TOAST" in pages body on PGLite; #4738 "tuple concurrently deleted" after migrating 125 to 144.

Single connection / locking

- PGLite is single-process, single-connection. Every second client dies on the lock: #677, #1841 (concurrent capture during serve corrupted writes), #3195, #3978 (docs never mentioned it), #2458, #2091. Fix pattern: one serve owns the DB and other processes go through IPC or `serve --http`; PR #2232 serialized MCP dispatch; PR #6247 auto-shared local PGLite across chats. #6246 (auto-sharing between concurrent chats) was closed "not planned" by the maintainer, so the supported answer to multiple agents is `serve --http`. For 10db's single daemon this is the topology gbrain converged on anyway.

Hangs / CPU spin / memory

- #1368, #2687, #4797, #4951, #5284, #5449: processes pinned at 100% CPU with no output. #5449 is the best root cause: inline checkpoint self-deadlock after ~2,000 page writes on a 3.4 GB store. Fixed in v0.60.5.0 (outermost-transaction checkpoint guard), after the first report in #2687 in July. #5284: wedge inside COMMIT after ~3k writes. PR #6577 (Oct 2026): ANALYZE/VACUUM must clear the PGLite statement cache.
- #2844: serve --http RSS grew ~3 GB/day (that report is about the HTTP transport, not necessarily PGLite). #4281 event-loop starvation.
- ENGINES.md:321: pglite.wasm caps memory at 2 GiB; HNSW build needs ~4.7 KB per 1024-dim chunk; they set `max_wal_size=8GB` because WAL past the checkpoint trigger "wedges PGLite"; vector index refused above ~300k chunks (`pglite_vector_index_too_large`); eval-bench.md:804 says TRUNCATE never returns WASM memory.

WASM / install

- #66, #250, #1340, #4054, #4116, #6512: pglite.wasm/pglite.data not found under bun-compiled binaries, global installs, odd paths. #1122, #1549: vector extension missing or failing to load. #2008 apostrophe in Windows username.
- Startup time: #2091 (slow PGLite boot killed the MCP host handshake at its 30 s timeout); PR #6404 cut serve first call from 4.3 s to 0.6 s. No clean cold-start number given elsewhere.

Backup / upgrade / scale

- #5312 backup create/restore fail on Windows plus swallowed `dumpDataDir` error. #6649 (open, today): no supported full recovery for a 13 GiB PGlite brain because the snapshot materializes via `dumpDataDir` into memory. Docs say PGLite backups are "manual (file copy)".
- Upgrade breakage: #2775 (pre-v121 PGLite brains), #2648, #4616 (new pages unreachable by vector search on PGLite while doctor said 100%, fixed in #5747).
- Frequency: 2026-04 to 2026-10, PGLite startup, lock, or hang bugs appear nearly every month. Most are fixed, but many took one to three months and several needed a defensive subsystem (lock manager, WAL repair, checkpoint guard, statement-cache clear). INFERRED: expect to own a PGLite-specific reliability layer.

## 4. Retrieval

- VERIFIED (docs/architecture/RETRIEVAL.md): arms are pgvector HNSW cosine, BM25-ish tsvector keyword (ts_rank), reciprocal-rank fusion (votes summed per page), typed-graph traversal, plus optional LLM multi-query expansion, intent-aware weighting, Voyage `rerank-2.5` cross-encoder (default on in balanced/tokenmax, off in conservative; "+150 ms p50"), autocut by score discontinuity, source-aware ranking, alias hop, relational re-pin. Search "fails open in RRF order" without the rerank key.
- Embedding provider: configurable through an AI gateway (src/core/ai/gateway.ts); defaults reference `openai:text-embedding-3-large` and Voyage; Ollama/local, dashscope also work. Embedding dimension is baked into the schema, so a model change needs `gbrain migrate embeddings` (docs/embedding-migrations.md; issues #5088, #5218, #5533, #1051).
- Without embeddings: VERIFIED keyless mode exists and is first-class ("Start with keyless memory and keyword retrieval" in README; ENGINES.md "hybridSearch keyword-only fallback"). Costs: no rerank, no expansion, and `remember` dedup/supersession degrade (`degraded_dedup: true`, near-duplicates may insert; #5152 exact duplicates without entity inserted twice).
- Evidence that vectors help: weak. VERIFIED (RETRIEVAL.md "The benchmark", Sept 9 2026 refresh): on 145 relationship questions, mean P@5 was keyword ranker 0.1710 vs vector-only 0.1076 vs reference hybrid 0.1917 vs specialized gbrain 0.3421. So keyword beat vector-only, and hybrid added about 2 points over keyword. The doc says the old headline "49.1% / +31.4 points" is retired because it was "not a graph-only effect" and used buggy metrics. "On the fuzzy and externally authored families the keyword and vector paths win some comparisons. None of this predicts accuracy on a different corpus." Their own claim that vector-only "underdelivers on real personal-knowledge queries" is consistent with that. Other results are LongMemEval/BEAM style, dominated by temporal and reranking work (docs/eval/*), not a clean keyword-vs-vector ablation. I did not find a published keyword-only vs hybrid ablation on conversational memory.
- INFERRED: for short, entity-keyed, LLM-written facts (10db's case), FTS5 with entity/scope filters should capture most of the value.

## 5. Memory model

- Pages: markdown "compiled truth" above a `<!-- timeline -->` sentinel, plus a timeline of dated bullets (append-only evidence). 14 canonical types in `gbrain-base-v2` (docs/architecture/type-taxonomy.md): person, company, media, tweet, analysis, atom, note, etc. Lesson there: a production brain had accreted 94 distinct `pages.type` values; they consolidated to 14 with subtype in frontmatter. Schema packs make this configurable.
- Two knowledge layers (docs/takes-vs-facts.md, "never conflate"): takes (holder, kind take/fact/bet/hunch, weight 0..1, extracted from pages by LLM, cold) and facts (hot, owner-only, per-turn extraction by Haiku; kinds event, preference, commitment, belief, fact, idea). A nightly dream `consolidate` phase promotes facts to takes.
- Links: typed edges, zero-LLM auto-link extraction from `[[slug]]`/markdown links and frontmatter; v204 added `link_transitions`, stints, `as_of`/`during`/`status live|ended` for time-bounded edges.
- Time: `valid_from` (default write time) and `ttl`/`valid_until` on facts; recall filters on event time (`valid_from` falling back to `created_at`); expired and superseded facts are excluded unless `include_expired`. Gaps still open: #6057 (valid_from/valid_until and as-of filter on remember/recall), #6058 (recall is not recency-weighted), #6624 (in a big fact table newest-first lets a weak match push out the closest fact).
- Supersession: VERIFIED reference rule in MEMORY_VERBS_v1.md: same entity + same kind + embedding similarity above threshold + different text means the new fact supersedes the old (status `superseded`, `superseded_by`, struck in the Facts table). Callers can pass `replaces`. Dedup is layered (exact text, embedding similarity; BrainBench mentions a 4-layer dedup). Corrections and `forget` create withdrawal tombstones: re-remembering the same text is refused (`fact_withdrawn`). INFERRED: supersession by embedding similarity is why keyless dedup degrades; deterministic keys (entity + kind + slot) would avoid that.
- Scopes and privacy: sources (multi-brain/multi-source with grants), per-fact `visibility` world|private (private never injected into agent sessions; remote callers see world only, fail-closed), `brain.audience` personal|shared declaration, consent gate for ambient capture, `db_only` gitignore paths for sensitive pages, 0600 on private data. Note the default for facts is `world`, which several issues treat as a footgun; the README warns embeddings and rerank providers receive text.
- Entity "cards" and `entity(name)`: zero-LLM p99 <100 ms deterministic entity summaries.

## 6. Agent integration

- MCP: frozen memory protocol, 7 verbs at `protocol_version: 1` (docs/protocol/MEMORY_VERBS_v1.md): `recall(query?, question?, entity?, budget_tokens?, since?, source_id?, session_id?, limit?)`, `remember(fact, provenance [required], ttl?, entity?, kind?, visibility?, valid_from?, request_id?)`, `entity(name)`, `synthesize(question, since?, until?)` (LLM, expensive, never on hot path), `forget(id, reason?, request_id?)`, `context_pack(entities[<=8], budget_tokens?, since?, session_id?, include_private?)`, `delta(since?, cursor?, entities?, budget_tokens?, session_id?)`. Responses are self-describing envelopes (protocol_version, evidence, provenance, budget meta, enumerated error codes with a `fix`). Additional full-surface ops include put_page, get_page, search, query, add_link, traverse_graph, add_timeline_entry. `--surface starter|verbs|full` limits what is exposed.
- Injection (docs/guides/ambient-recall.md): placement matters more than retrieval quality. Inject at session start, after compaction, and on heartbeat (delta), not per message ("per-message retrieval beyond entity cards adds latency faster than insight"). Claude Code hooks: SessionStart injects a warm `context_pack`; PreCompact banks standing entities and spools the window for fact harvest. Codex and Postgres brains use pull.
- Budgeting: `budget_tokens` packs server-side, cards first then facts, headers and envelope reserved, reports `budget_used` and `dropped_count`; output text is envelope-wrapped; deterministic, zero LLM, world-visibility only.
- Core memory (docs/guides/core-memory.md + docs/eval/decisions/p4-heldout-core-2026-10-06): always-loaded owner-designated pages with a char limit. A preregistered held-out eval FAILED the gate: claude-sonnet-5-5 +4.6 points (CI -0.4..+10.7) but gpt-6.1-sol -2.4, so it ships off by default. Lesson: always-on injection can hurt some models.
- Capture: explicit agent `remember` (provenance mandatory), opt-in ambient writeback `memory.auto_writeback = unset|off|salient|all` (default off, one-time consent ask, only on personal brains), Stop-hook turns, compaction harvest, SessionEnd transcripts. Extraction by an LLM (Haiku-class). No human review queue for facts; protection is the notability filter, provenance, dedup/supersession, `forget` tombstones, and `doctor` checks. Takes have a `take_proposals` promotion path (#2411 says CLI was missing). Skill proposals have an import step.

## 7. Lessons

Changed minds / abandoned (VERIFIED unless noted)

- SQLite engine planned, then superseded by PGLite before v1 (docs/GBRAIN_V0.md:532); community SQLite PR held.
- The "macOS 26 WASM bug" was a misdiagnosis for unclean-shutdown WAL damage (PR #3901; PR #3519 "stop blaming macOS").
- Headline benchmark claim (+31.4 points graph lift) retired as not graph-only (RETRIEVAL.md; CHANGELOG ~8118).
- Core always-on memory: shipped, then evaluated, then default-off.
- Concurrent local chats on one PGLite brain: tried (PR #6247), then declared not on roadmap (#6246); supported path is `serve --http`.
- Single-writer simplicity lost: v0.51 write-coordination removed the simple path, then "deactivate" was added; maintainers refused an inert single-writer mode (#5392).
- Retired hosted reranker/provider dependencies forced sunset migrations (CHANGELOG ~10764-10981).
- 94 page types collapsed to 14 (type-taxonomy.md).
- Four attempted test-harness rewrites reverted (CHANGELOG ~11878); `git log --grep revert` on the shallow clone found nothing, so I did not trace code reverts.

Pain points

- Embedded WASM Postgres reliability: startup aborts, WAL corruption on unclean exit, checkpoint deadlocks, 2 GiB memory ceiling, no good backup story at 10+ GB.
- Embedding dimension lock-in and model migration cost.
- Dual truth (files plus DB) causing drift bugs and an expanding "managed" persistence subsystem, receipts, journals, recovery states.
- Silent no-op failures: doctor reports healthy while search misses (#4616, #4283, #3783 hybrid returns identical results regardless of query), zero-norm embeddings. Lesson: health checks must exercise real reads.
- Scope creep: dozens of subsystems (dream cycle, graph, synthesis, connectors) with a flaky-test tail.

## 8. Takeaways for 10db

(a) Patterns to adopt

1. Make writes carry provenance (required free-text source) and write attribution (session/agent id). It cost gbrain a lot to retrofit.
2. Facts as a first-class table with kind, entity/scope, `valid_from`, `valid_until`/ttl, `superseded_by`, `withdrawn` tombstone. Add as-of reads from day one (gbrain has an open issue for exactly this, #6057).
3. Supersession by deterministic key (scope + entity + kind, optional explicit `replaces`) rather than embedding similarity; return `status: inserted|duplicate|superseded` and the superseded id. Exact-text dedup is free without embeddings.
4. `forget` produces a tombstone so re-extraction cannot resurrect a deleted fact.
5. Budget-packed injection: one deterministic function that takes scopes plus `budget_tokens`, fills in priority order (pinned decisions and principles, then active facts, then recent), reports `budget_used` and `dropped_count`, includes only non-private rows, and wraps text in a clearly delimited envelope. Inject at session start and after compaction; do not inject per message.
6. Keep MCP surface tiny: roughly recall, remember, forget, entity/context_pack. Self-describing responses with error codes and a `fix` string; additive-only versioning.
7. Do not default always-loaded "core" content without evaluating it on the model you use; gbrain's eval showed model-dependent harm.
8. Capture: explicit `remember` by the agent first; ambient extraction opt-in, notability-filtered, provenance-stamped; consider a pending/review state for extracted (not agent-stated) knowledge, since gbrain has none and gets drift and junk.
9. Constrain type vocabulary early (14 types after reaching 94); put subtype in a JSON column.
10. Health checks that run a real write-then-read-back round trip (gbrain's silent-miss bugs).
11. Keep privacy as a per-row column (`visibility`) enforced in the one read path used for injection, fail-closed for remote callers.

(b) PGLite vs SQLite for 10db: recommendation is SQLite (WAL) via Drizzle with FTS5, as planned.

Reasons

- gbrain's own evidence on PGLite is a six-month stream of startup aborts, WAL corruption on unclean exit, lock-reaper bugs, checkpoint deadlocks, 2 GiB WASM memory ceiling and no practical backup path at scale (section 3). The pattern is that embedded WASM Postgres is the least mature part of their stack. A Tauri app is killed, force-quit, and rebooted often, which is exactly the trigger for the WAL tear (#1872, PR #3901).
- 10db's workload (single TypeScript daemon, single writer, tasks/sessions/events plus a modest knowledge table) matches SQLite WAL's strengths: crash-safe, multiple readers, one writer, tiny footprint, native `sqlite3` live inspection, trivial `.backup`/file copy. PGLite cannot be opened by a second process at all (the single-process lock was gbrain's main operational problem), which kills live inspection, the thing 10db values.
- gbrain's main reason for PGLite does not apply: they chose it for dialect parity with a production Postgres (pgvector, tsvector) and a Supabase tier. They never demonstrated a technical SQLite failure; the SQLite engine PR (#291) was dropped for scheduling and "lockstep" reasons. The one thing they flagged as attractive about SQLite is the "zero-WASM single-file" install.
- No embeddings in slice 1: PGLite's two big selling points (pgvector HNSW, tsvector) are unneeded. FTS5 (bm25, porter/unicode61, column weights, prefix) covers keyword retrieval, and gbrain's benchmark found keyword beat vector-only on its relationship set and added only about 2 points when fused.
- Future hosted Postgres: the cost of that option is real but deferred. Mitigate it by keeping the knowledge access behind a small repository interface and Drizzle schema, using portable column types, keeping FTS isolated in one search module (the only dialect-specific code), and avoiding SQLite-only tricks in the data model. gbrain itself needed a 100+ method engine interface and an "engine-sql" refactor to keep two engines in lockstep; do not build that now. If 10db ever moves to a hosted service, plan a one-time migration (gbrain's "graduation" worked but took many PRs; see PR #6022) rather than dual-engine support.
- Embeddings later: sqlite-vec or an external index is viable at 10db's scale; gbrain's HNSW scale pain (300k chunk ceiling in PGLite) is irrelevant at thousands of facts.

What would change my mind

- A firm commitment to ship a hosted Postgres service soon with the same schema, plus a need for pgvector features in the first quarter. Even then I would run real Postgres locally in dev rather than PGLite.

Caveats

- INFERRED: the PGLite failure rate partly reflects gbrain's workload (3 GB+ stores, heavy bulk imports, many processes, 24/7 cron). A small 10db store with one process would hit fewer of them, but the unclean-exit WAL tear (#1872, #3901) is workload independent.
- SQLite is not free of risk: Drizzle with bun/better-sqlite3 inside a Tauri sidecar needs native-module packaging, and WAL needs checkpoint tuning. I did not research those; they are not from gbrain.
