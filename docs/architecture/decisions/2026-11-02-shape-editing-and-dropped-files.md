# A proposal's round is stored, files upload as the raw body, and edit notes wait in memory for the next turn

- **Date:** 2026-11-02
- **Amends:** `decisions/2026-11-02-the-shape-view.md` (Enter and the row keys in slice 2)

## Decision

**Built (Shape slice 2):**

- **`shape_proposals.created_round`** (migration 0029, generated) beside the existing round. A row's `round` is
  the round that last created, changed or moved it; a change in sources or list order does not move it. The view
  marks a row _new_ when `round == created_round == current` and _changed_ when `round == current` only.
- **`shape_files`** (same migration) stores each dropped file's name, type, size and path under
  `<dataDir>/shapes`, which is also the Shape session's read-allowed directory. **`shape_files.told_at`**
  (migration 0030, generated) is set when a turn first carries the file to Claude. The next turn takes the files
  with no `told_at` from the database, not from memory, so a file dropped before a restart still reaches a
  resumed session; a turn that fails to start marks nothing.
- **A pinned task a round leaves out of its goal is kept**: the stored task is carried into the merged goal with
  its pinned fields, and `propose_plan` answers it under `kept` as `<goal>.tasks.<task>`.
- **Files upload as the raw request body**, name in the query and type as the content type, to
  `POST /shapes/:id/files`. Only that route has a 20 MB body limit. Type, size, count and magic bytes are checked
  in the service; a refusal names its reason.
- **Edits, restores and drops write an Edit-kind note** in the same write as the change and queue the same
  sentence in memory for the next turn's prompt as `[note]` lines. The transcript view hides these notes.
- **A fresh session** (nothing to resume) is told about every file and, if Claude never spoke, the builder's
  earlier messages. This is how a `start_shape` summary reaches it.
- **`start_shape`** is a builder MCP tool: a summary and text files (256 KB in all, names only, no paths).
- **Enter on a row still opens its details.** E edits, P pins or unpins, W asks why.

## Why

- A mark computed from the round alone cannot tell a new row from a changed one; a column is honest, and the
  alternative (reserved keys in `taskHashes`) is a hack.
- A 20 MB base64 JSON body is 27 MB and meets the 8 MB global limit; the raw body does not.
- The note is a sentence the builder's own edit produced, so nothing is asked of a model.

## Trade-offs

- Pending notes are lost if the daemon restarts before the next turn; the resume digest still carries the
  current proposals and pins.
- Images are read from disk at turn time, so a 20 MB image is base64 in memory for that turn.
- A mislabelled image is refused by its magic bytes, because Claude rejects it and that would end the turn.
- macOS dictation into the Tauri window's Shape input is checked by hand (it works on macOS 27.2); a test pins
  only the input's structure (a native textarea, no contenteditable, no blocking attributes).
