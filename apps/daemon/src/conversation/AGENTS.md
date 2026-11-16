# apps/daemon/src/conversation

- `conversation/` (sessions spec §6.1) is what every conversation shares, whoever owns it (a chat, a Plan or a task's
  thread): the picture limits of each account (`picture-limits.ts`), the image budget a live session holds
  (`inline-budget.ts`, `picture-budget.ts`, `block-pictures.ts`), the checks a dropped file or pasted picture must
  pass (`file-check.ts`, `image-check.ts`, `pictures.ts`, which also keeps a picture under its hash), the delivery
  rules a builder message reaches a session by (`delivery-rules.ts`: the uuid it goes under, what an interrupt
  pushes again) and the library that applies them to one session over any conversation (`delivery.ts`, which
  `runner/lane-messages.ts` builds over the task's thread with the thread's words), and the builder-message intake
  (`intake.ts`: limits, pictures on disk first, the rows in one write). The read-back ask after a restart is
  `readBackAsk` (`delivery-rules.ts`), which the engine's restart and the runner's read-back
  (`runner/read-back.ts`) both use. `item-recorder.ts` turns one session's item events into live
  frames and stored items, capped by `full-output.ts`; a turn's end finishes what streamed and answers the
  turn's last reply, and what an early end streamed is stored partial under the turn (`partial.ts`),
  for the engine's sessions and a page's alike; `live-registry.ts` serves what a task conversation's
  runner-owned session streams now. A task's side (sessions spec §6.1): `task-thread.ts` takes the
  builder's message (`POST /tasks/:taskId/thread` and `POST /conversations/:id/messages` or `/redo` for
  the task's conversation, a multipart form of a `text` part and a `picture` part per picture; up to 10
  pictures and 40 MB together, each at most Plan's 20 MB), refused (409) while the page's pass is not
  open or the page is being taken out, and hands it to the runner, injected; a picture is a PNG, JPEG
  or WebP by its name's extension (a name of at most 255 characters) and its bytes must agree, kept at
  `<data dir>/tasks/<task id>/files/<sha256>.<ext>` (`task-files.ts`), mode 0600, written under a
  temporary name and renamed, its row written with the message; a write that fails removes the
  pictures that call wrote, never one an earlier message holds. `GET /conversations/:id/files/:fileId`
  serves a picture sent with one of the conversation's messages, and 404 for any other file or one whose
  bytes are gone (`readConversationPicture`). `lane-text.ts` is how the thread reads to a lane session:
  `builderMessageText` (a message under its id, each picture attached or named by its stored path) and
  `buildThreadDigest` (the brief, then the builder's messages and the agent's replies before the
  message a fresh session acts on, from the latest handoff on). It holds the explore engine (sessions spec
  §6.3–§6.8, decision `decisions/2026-11-13-one-explore-engine-runs-sessions-and-plan.md`): `explore-state.ts` is
  §6.7's table as a pure reducer; `explore-engine.ts` keeps one runtime per conversation and applies the effects one
  at a time on its chain; `explore-session.ts` turns one open handle's events into the engine's events and, through the item
  recorder, live frames (`live-buffers.ts`, sent on `events/live-frames.ts`, never stored) and stored
  items; `explore-recovery.ts` is what a start does for each conversation before the restart row;
  `explore-hooks.ts` is what an owner gives it. It imports none of `pass`, `pictures`, `mcp`, `screens`, `thread`,
  `shape` or `runner`.

- A session's `background_tasks` report is kept by `openSession` in memory (never stored): `ExploreEngine.view` reads it from the open session, so it is empty with no session, and each report emits a `conversation.state` event with `backgroundTasks: true` for the screen to read the view again.
