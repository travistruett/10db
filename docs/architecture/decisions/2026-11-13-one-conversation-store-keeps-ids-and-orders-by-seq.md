# One conversation store keeps every message's id and orders by seq

- **Date:** 2026-11-13

## Decision

- Plan's transcripts and files (`shape_messages`, `shape_files`) and the tasks' threads (`task_messages`,
  `task_files`) move into `conversations`, `conversation_items` and `conversation_files`, by one forward `--custom`
  migration (0070) between generated ones. The old tables are dropped (0074).
- Every row keeps its id. `ConversationItemId` reads `cvi_`, `shm_` and `tmg_`; `ConversationFileId` reads `cvf_`,
  `sfl_` and `tfl_` (`packages/contracts/src/ids.ts`); only `cvi_` and `cvf_` are minted. A migrated conversation's
  id is `cnv_` and its owner's UUID.
- A transcript's order is `conversation_items.seq`, unique per conversation and numbered in the old id order; never
  the id. Files order by `created_at`, then id.
- Plan's `text` becomes `message` (builder) or `agent_message`; `tool` becomes a finished `other` tool call;
  `notice` and `digest` keep their kinds; `propose`, `rehearse`, `edit`, `event` and `screen` become `shape_event`
  with the old kind in the body. Authors `claude` and `note` become `agent` and `system`. A task's `reply` becomes
  `agent_message`.
- Plan's builder messages are delivered at their own time: Plan's queue lived in memory.
- A session names its conversation (`sessions.conversation_id`); `shape_id` is dropped. A session has a conversation,
  a workstream, or both (a lane of a task with a thread).
- The lane's `idOfUuid('TaskMessage', …)` becomes a lookup of the conversation's items by push uuid or by the row's
  own uuid.

## Why

- Keeping ids keeps `shape_proposals.source_message_ids` and `shape_questions.source_message_ids` (JSON lists), the
  shadow answers, `pass_turns.message_id` and `pass_preview_marks.notice_id` valid with no rewrite. The reviewers
  preferred fresh ids with a `legacy_id` column; that needs every JSON list rewritten in SQL and two ids per row
  forever.
- `seq` because a new `cvi_` id sorts before every `shm_` and `tmg_` id as text, so id order would put new messages
  first.
- Delivered-at for Plan: after any restart Plan's queue was empty, and the explore engine reads an undelivered
  builder message as one waiting to be sent.
