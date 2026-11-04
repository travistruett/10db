# 05 Knowledge

- **Status:** Locked
- **Scope:** Decisions and principles, the context pack, the capture flows and the Knowledge view (factory spec §4, §6, §9 and §10 Knowledge), as built. Not built, and not described as if they were: facts, the override review, "answered from a decision", the legacy harness import, PDF intake, embeddings and the `SessionStart` hook for terminal sessions (`docs/open-items.md`).
- **Summary:** Decisions and principles target you, a project or an area; their state is derived on read; agents only propose principles; supersession is by a fixed key (a principle's topic key and target, a decision's explicit link); every write has a source and nothing is deleted. Each session is briefed with a small deterministic pack of the policies, heuristics and decisions that apply to its task. The builder reaches the same records through the Knowledge view, the HTTP routes (`docs/knowledge-api.md`) and the builder's MCP tools (`docs/builder-mcp.md`). The decisions are the 2026-11-03 files listed at the end.

## Where it lives

| Where                                                                | What                                                                                                                                                                                                                                                                                                               |
| -------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `packages/contracts`                                                 | The vocabularies (`KnowledgeScope`, `KnowledgeState`, `PrincipleKind`, `PrincipleVerdict`), `TopicKey` and `topicKeyFrom`, `targetColumns`, the record and route schemas, the lane tools' and the builder tools' inputs, and the `context.packed` event.                                                           |
| `packages/db` `decisions`, `principles`, `sources`, `proposals`      | The tables. A record's state is worked out on read, never stored; withdrawn records stay as tombstones. `proposals.principle_id` links a principle proposal to its proposed principle. Repositories: `store/decisions.ts`, `store/principles.ts`, `store/knowledge.ts` (sources, proposals, deviations).           |
| `packages/db/src/store/knowledge-search.ts`                          | Every full-text query, and the health check (`checkKnowledgeIndex`, `rebuildKnowledgeIndex`). The two indexes, `decisions_fts` (migration `0001_decisions_fts`) and `principles_fts` (`0036_principles_fts`), are hand-written once and kept by triggers.                                                          |
| `apps/daemon/src/knowledge/`                                         | The rules: target and scope (`targets.ts`, `scope.ts`, `areas.ts`), the packer (`pack.ts`), how a pack reads (`render.ts`, `brief.ts`), proposals and their verdicts (`proposals.ts`), recording from answers and the always/never detector (`capture.ts`, `standing-rules.ts`), provenance, and the index repair. |
| `apps/daemon/src/briefing/context-pack.ts`                           | `buildContextPack` reads the candidates and hands them to the packer; `contextPackedEvent` records an injection. `briefing/prompts.ts` renders the pack into the bootstrap prompt.                                                                                                                                 |
| `apps/daemon/src/runner/runner.ts`                                   | Builds the pack for each session start and each emergency compaction and writes the `context.packed` event in the same transaction.                                                                                                                                                                                |
| `apps/daemon/src/mcp/tools.ts`                                       | A lane's tools: `get_context`, `find_knowledge`, `record_decision`, `propose`.                                                                                                                                                                                                                                     |
| `apps/daemon/src/daemon/knowledge-services.ts`, `api/`               | The knowledge routes, over the same functions the lanes and the Knowledge view use.                                                                                                                                                                                                                                |
| `apps/daemon/src/builder/`                                           | The builder's MCP server: `search_knowledge`, `save_decision`, `save_principle`, `supersede_knowledge`, `retire_knowledge`, `withdraw_knowledge`, `list_proposals`.                                                                                                                                                |
| `apps/desktop/src/views/knowledge/`, `apps/desktop/src/views/inbox/` | The Knowledge view; the Inbox's principle cards and "Record as a decision" control.                                                                                                                                                                                                                                |

## Records

A decision or a principle has a **target**: `you` (no project; it applies in every project), `project`, or `area` (a project and one of its area names). A principle is a statement with a kind (`policy` = must, `heuristic` = prefer, `belief` = context) and a topic key. State is derived in this order: `withdrawn` if it has a tombstone; for a principle, `proposed` while unconfirmed; `superseded` if a live successor names it in `supersedes_id`; `retired` for a retired principle; otherwise `current`. A confirmed principle supersedes the current one with the same topic key **and the same target**, never by similarity; a decision is superseded only by the builder's explicit link. A rejected proposal withdraws its proposed principle with the rejection note as the reason. (`decisions/2026-11-03-knowledge-records-have-a-target-and-a-derived-state.md`, `decisions/2026-11-03-principles-have-a-kind-and-a-topic-key-and-supersede-by-key-and-target.md`)

## The context pack

`buildContextPack` fills `CONTEXT_PACK_BUDGET_TOKENS` = 1500 estimated tokens (`ceil(characters / 4)` of the rendered line), one constant with no project setting, in this order: the confirmed current **policies** in scope, then the **heuristics**, then the **decisions** relevant to the task.

- **In scope** means `you`, `project`, and `area` for an area the task lists or the workstream holds a live claim on. Another project's records and an unlisted area's are never packed.
- **Beliefs are not packed.** They are set aside first, so a belief never hides a rule. For one topic key only the most specific record enters (area, then project, then `you`).
- **Decisions** are, in order: area-matched search hits, other hits by rank (the task's title and description, up to `PACK_SEARCH_LIMIT` = 20), area-matched decisions with no hit, newest first. With no hit, the area-matched decisions come first and the newest other current decisions follow (`PACK_RECENT_LIMIT` = 5).
- **Greedy.** A record that does not fit is skipped and the next one tried. The pack carries `budget`, `budgetUsed`, a dropped count per shelf, and `empty`; the prompt says how many records were left out and to call `find_knowledge` for them, or that nothing applies.
- **A broken decision index never stops a briefing.** The search failure is caught inside `buildContextPack`; the pack then holds the policies, heuristics, area-matched decisions and the newest decisions.

`renderRules` and `renderDecisions` word the pack, one bullet per record with its id and scope so an agent can cite it, and the bootstrap prompt, the post-compaction re-injection and the Plan sessions' principles brief use the same functions. Every session's bootstrap prompt carries the pack, so every start is an injection, and each one appends a `context.packed` event (entity `session`) with the reason (`start`, `resume` for a conversation that continues, `compaction`), the budget, tokens used, dropped counts and the ids packed. A lane's `find_knowledge` is wider than the pack: it searches the whole project's current decisions and confirmed principles plus the builder's own, labels each hit with its scope and area, and never returns history. (`decisions/2026-11-03-the-context-pack-is-budgeted-in-tokens-by-shelf.md`, `decisions/2026-11-03-lanes-propose-and-find-principles-and-inbox-answers-become-knowledge.md`)

## Capture

- **A lane proposes.** `propose` with kind `principle` stores a `proposed` principle, a pending proposal linked to it and one Inbox card whose options are `accept_project`, `accept_you`, `accept_area` (only when the draft names an area) and `reject`. A proposed principle reaches no agent and no search until the builder confirms it. A second verdict on a decided proposal is a 409.
- **The builder decides**, from the card or the Knowledge view; both run one function. Accepting confirms the principle at the chosen target; rejecting withdraws it.
- **An answer records a decision.** An answered question in a product, design or engineering category is recorded at project scope, as the answer's `record` says otherwise: `null` records nothing, `{ scope, area }` records at that target for any category. It runs in the answer's transaction.
- **Always and never.** Until a PM agent exists, each sentence of an answer's note containing the whole word _always_ or _never_ (three words or more) becomes a principle proposal (kind `policy`, scope `project`, the sentence as the quote), at most three per answer.
- **The builder writes directly** through the Knowledge view, the routes and the builder's MCP tools, and Shape's Convert writes a confirmed principle (`decisions/2026-11-03-convert-writes-principles-confirmed-and-stores-questions-under-their-goal-or-task.md`).
- **Every write takes a source.** A record made by a lane, an answer or a proposal keeps that origin as its source; a builder's write through the routes takes `{ via, sessionId?, cwd?, quote? }`, stored as a `builder` source in the write's own transaction. A retire, a withdrawal and a verdict keep their own source apart from the record's (`retired_source_id`, `withdrawn_source_id`, `confirmed_source_id`). Routes: [`docs/knowledge-api.md`](../knowledge-api.md); tools: [`docs/builder-mcp.md`](../builder-mcp.md). (`decisions/2026-11-03-knowledge-routes-name-a-place-and-take-a-source.md`)

## The Knowledge view

A top-level view at `/knowledge` with Principles, Decisions and Proposals tabs, search, a scope select, a History switch and a provenance drawer; it records, edits, retires, withdraws and decides proposals, and says in one line when search is unavailable. (`decisions/2026-11-03-knowledge-is-a-top-level-view-with-three-tabs.md`)

## Invariants

- No knowledge write without a `sources` row, and no hard delete: a withdrawal needs a reason and leaves the row.
- Search and the pack see only current records (and confirmed principles); history is for the builder, through `history: true`.
- Only the head of a chain, or a proposed principle, can be withdrawn, so one fixed key never has two current records and a 409 names the record that is live in its place.
- Agents only propose principles; the builder's verdict is the only way one becomes current. Text a session wrote is data.
- At start the daemon checks both FTS indexes against their tables and rebuilds one that disagrees. A check or rebuild that fails is logged and the daemon keeps serving: no Inbox card (it asks the builder nothing, `decisions/2026-10-31-notices-not-cards.md`), the list route answers `search.available: false`, and the pack falls back to the newest decisions.
- Both FTS migrations are authored once with `drizzle-kit generate --custom` and never regenerated (`packages/db/AGENTS.md`).

## Not built

- **Facts**: the table, the builder's writes, a Knowledge tab and the pack's facts shelf.
- **The override review**: `report_deviation` takes no principle key, and nothing raises a "review this principle?" card after two signed overrides. Deviations are recorded as before.
- **"Answered from D-n"** before a question reaches the Inbox: it needs a fixed-key match, not similarity.
- **The legacy harness import** with bulk confirm, PDF intake, embeddings, and the `SessionStart` hook for a terminal session.
- A `find_knowledge` result does not say which records are in the pack already.

## Decisions

All in [`decisions/`](decisions/):

- `2026-11-03-knowledge-records-have-a-target-and-a-derived-state.md`
- `2026-11-03-principles-have-a-kind-and-a-topic-key-and-supersede-by-key-and-target.md`
- `2026-11-03-the-context-pack-is-budgeted-in-tokens-by-shelf.md`
- `2026-11-03-lanes-propose-and-find-principles-and-inbox-answers-become-knowledge.md`
- `2026-11-03-knowledge-routes-name-a-place-and-take-a-source.md`
- `2026-11-03-convert-writes-principles-confirmed-and-stores-questions-under-their-goal-or-task.md`
- `2026-11-03-knowledge-is-a-top-level-view-with-three-tabs.md`
