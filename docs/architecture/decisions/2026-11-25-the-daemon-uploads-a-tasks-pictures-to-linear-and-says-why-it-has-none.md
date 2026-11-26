# The daemon uploads a task's pictures to Linear, and says why it has none

- **Date:** 2026-11-25
- **Amends:** `decisions/2026-11-25-the-daemon-authors-the-reporters-linear-comment.md` (its "nothing else from the
  agent": the pictures are now added by 10db)

## Decision

- **Pictures.** The `ended` comment of a task with before and after pictures carries them (the `pr_merged` one
  when the `ended` comment showed none), at most six, the pairs `picturePlan` gives its pull request and Slack. 10db
  uploads them itself in `reportPost` (`linear/reporter-pictures.ts`): Linear's `prepare_file_upload` through the
  same `Authorization` sign-in that writes the comment (`LinearCommentWriter.preparePicture`), then a PUT of the
  file to the signed address, only when `isLinearUploadUrl` accepts it. The agent never sees a picture and its
  guard still refuses every upload. The first picture's address is recorded on the row (`attachmentUrl`), which is
  also how a later row knows pictures were shown. A picture that fails to upload leaves the comment going out
  without it and says the rest are in 10db.
- **No pull request in the words.** The text 10db adds says "in 10db", never "in the pull request": a project that
  commits directly has no pull request.
- **The comment waits for the capture.** The after picture is asked at the same event that owes the `ended`
  comment, so a due `ended` or `pr_merged` row whose task has an after capture waiting or running
  (`Pictures.outlook` is `wait`) is picked up again every 15 s instead of run, with no try spent, for at most five
  minutes; then the comment goes out and says the pictures were still being taken. The reason a task has none is
  read after the capture ended, so a sign-in that failed during it is said.
- **A local copy's landing is a comment.** A local copy's after is taken when its batch ships, so the batch
  shipping makes a `pr_merged` row for each finished run (`landed:<batch>`, detail `prUrl: null`,
  `localCopy: true`); its `ended` comment says the pictures follow when the change lands, and the landing comment
  carries them or the reason there are none. The brief tells the agent to name no pull request when `prUrl` is
  null. The footer still reads `pr_merged`, the event's stored name.
- **Why there are none.** A task that names a page and has no after picture says so once, on its first `ended`
  comment (a local copy's landing comment), with the reason (`Pictures.outlook`, `skipped`): the task ran in a
  separate copy (10db pictures only Your folder, a local copy or a pass's page), its project's picture sign-in
  failed, or the pictures browser is refused. Slack says the same once per task, in the channel, when the project
  shares pictures.
- **A failed picture sign-in reaches the builder.** `pictures/sign-in-record.ts` keeps the latest failure per
  project (`pictures-sign-in.<projectId>` in `app_settings`); a sign-in that succeeds, or a change of the project's
  app address or dev login command, clears it. The builder's one Inbox card per project, "<project>'s pictures
  can't sign in" (`inbox/sign-in-card.ts`), names the exit code and the last twelve lines of the command's output
  with every address, query string and secret masked (the login prints its token there).
- **An account whose Linear sign-in only its agent holds** (a Codex login, a claude.ai connector) gives 10db no
  header to upload with, so its `ended` comment says the pictures are in 10db and why they are not here, once. A
  follow-up closes that gap.

## Why

The agent-driven upload was removed because the reporter's agent has no network and 10db had to send the bytes
anyway; moving the whole step to the daemon leaves the agent only words and keeps the guard's rule that it uploads
nothing. A sign-in that failed only at warn level left Ampsio with no picture and no one told for two days; the
card, the record and the words in the updates make that failure visible where the builder and the partners look.
Taking the reason from one place (`Pictures.skipped`) keeps Linear and Slack from saying different things.
