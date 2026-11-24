# A finished task's pictures to Slack

## Brief

- **What changes for the builder.** With Settings › Sharing › Post Pictures to Slack on and a channel picked, every
  finished task that 10db took an after picture of gets its own Slack message: the task's title, its before and
  after of each page it pictured (at most 10 files), and the project's name, each time it finishes. That is a task
  outside a Workbench pass, in Your folder, naming a routed page area (`pictures/picture-routes.ts`
  `takesPictures`). For ampsio (delivery `local`, tasks in Your folder, 16 routed page areas) that is every UI task.
  Workbench pass pages are never posted per task: a pass opens a pull request at close even under local delivery
  (`pass/close.ts:433-438`, "a pull request as a record of the pass"), and #783 posts it once per pull request. The Sharing page's switch says "When a task that changes a page is done, or
  a UI Workbench pull request opens".
- **What it buys.** Partners see every finished UI change in Slack, not only Workbench passes, without the builder
  screenshotting.
- **What could go wrong, and how we'd know.** Your-folder tasks share one working tree, so an after can show a
  neighbour's edits too (it is the app as the builder sees it). ampsio has no Preview Command: with its app down
  the task gets no after and posts nothing, as it gets no picture today. A busy day is many messages (one per
  task); the builder can turn the switch off. A refused post leaves one Inbox item per task with Slack's reason and
  is tried again at start-up, when Settings › Sharing is saved, and every 15 minutes while the item is open. A task
  in a separate copy (the default for 10db and orgtools) still gets no pictures (Workbench spec §17) and so no post.
- **Calls the builder might disagree with.** One post per task (the builder chose this). A Codex-plan task more
  often posts an after with no before (the before rule drops a before once a Codex session starts). No pull request link: a
  local-delivery task has none, and a Your-folder task's pull request may not exist yet when its after is taken.
  Turning the switch on posts only tasks finished from then on, never a backlog (the sharing setting records `enabledAt`; a task posts only when its after was taken at or after it). Batch pull requests still get no
  Pictures section (cut from this plan; a later task if wanted).
- **What is needed from the builder.** Nothing beyond #783's setup.

## Size

Feature (about 350-450 lines). Slack wiring and copy; no sandbox, network rule, ledger, migration or git. One
implementer end to end, one Fable code review that blocks only on bugs, one test extended.

## Provider parity

No model is involved: the picture store, Slack and the inbox only. Every account kind behaves the same.

## Parts

1. **One poster for passes and tasks.** Rename `delivery/pass-slack-post.ts` to `delivery/slack-picture-post.ts`
   (`createSlackPicturePost`), created once in `daemon/start.ts` from the `slack` block #783 added (`channelOf`,
   `clientFor`, the gate on data going out stays where it is), and handed to `createPassPullRequests` (its `slack`
   dep becomes the poster, `PassSlackPost`'s `announce(passId, url)` unchanged) and to the pictures service. It
   gains `announceTask(taskId)`, with the same never-throws, never-waits, detached shape and one in-flight set
   keyed by the pass or task id. The shared steps (resolve the channel, join a public one, refuse a private one,
   `uploadFiles`, the 10-file cut, `reasonOf`, the failure Inbox item) are one function both paths call; only the
   pictures picked, the text, the mark and the fold key differ.
2. **What a task posts.** `picturePlan([{ title: task.title, screens: listTaskScreens(db, taskId) }])`: its first
   before and last after per route. Posts nothing when the plan has no after. Text:
   `*<project name>*: <task title> is done.` then `<n> more pictures are in 10db.` past the cut (all escaped as
   the pass text is). A task with a `passId` is never posted here.
3. **Once per after.** The mark is the id of the newest after read before the upload (never re-read at write
   time), under the task id in the same `slack-pictures-posted.<projectId>` record (ids are branded, so a pass id
   and a task id never meet): a repeat call posts nothing; a task reopened and done again has a new after and
   posts again. In the task post's `.finally`, if the newest after now differs from the mark just written, it
   announces once more (a second after during an upload). A stop after Slack accepted the upload but before the
   mark posts twice at the next start; rare, accepted. Fold key
   `pictures-to-slack:<taskId>`; the item's body says the task is done and unaffected and when 10db tries again.
4. **Trigger.** `PicturesDeps` gains `onAfterCapture?: (taskId: TaskId) => void`, called in `pump`'s `.finally`
   for every After request with no `passId` that was not aborted, kept or thrown part-way (a throw after some rows
   were kept still leaves them to post), wrapped so its own throw is only logged. The poster decides whether there
   is an unmarked after. The pictures module imports nothing of Slack or delivery.
5. **Retries and catch-up.** `retryTasks()` on the poster: each open Inbox item whose fold key starts
   `pictures-to-slack:tsk` (a `@10db/db` read for open items by fold-key prefix, filtering in code or escaping
   LIKE's `_`; the id parsed with `TaskId.safeParse`) calls `announceTask` again, one at a time, stopping a
   project's run at its first Slack error. Run after `setSlackSharing` saves (a new dep on stakeholder services)
   and on a 15-minute interval cleared beside `pictures?.stop()`. Start-up also runs a catch-up: each task with no
   `passId`, Done within `MISSED_AFTER_MS` (the hour start-up already uses for missed afters), whose newest after
   is not its mark, is announced; the window keeps "no backlog". Timer retries raise the item without `refresh`
   unless the reason text changed, so a lasting failure does not resurface every 15 minutes. The poster is
   created before `createPassPullRequests` in `start.ts` and handed to it, to stakeholder services and to
   `startPictures`. Pass failures keep their retry at the next push.

   What one task announce ends in (item = the task's failure Inbox item):

   | State at the call                                    | Outcome                                           |
   | ---------------------------------------------------- | ------------------------------------------------- |
   | Task gone, or now in a pass                          | nothing posted; item withdrawn by its own id |
   | Sharing off or `channelOf` null                      | nothing posted; item withdrawn                    |
   | `clientFor` null (token removed)                     | nothing posted; item withdrawn                    |
   | Newest after already marked                          | nothing posted; item withdrawn                    |
   | No after, or no after file readable                  | nothing posted; item withdrawn                    |
   | A post for the task in flight                        | nothing now; the in-flight post's `.finally` rechecks |
   | Upload accepted                                      | marked; item withdrawn                            |
   | Slack or network error                               | item raised or kept with Slack's reason           |

   A restart drops the in-flight set; the start-up catch-up and the open items take its place.
6. **Copy.** `views/settings/sharing-section.tsx`: the switch description "When a task that changes a page is
   done, or a UI Workbench pull request opens, @10db posts its before and after pictures."; the help says one
   message per finished task (its before and after, up to 10 files) or per Workbench pull request, that everyone
   in the channel sees the pictures, data on the page included, and that only tasks finished after it is turned
   on are posted. The decision record `2026-11-23-a-projects-pictures-can-go-to-its-slack-channel.md` gains the
   per-task rule (amend in place: it is from today and states the current rule) and corrects "Projects that
   deliver locally, or have no origin, never open a pull request" (a local pass with an origin does, at close), and `pictures/AGENTS.md` and
   `delivery/AGENTS.md` name `onAfterCapture` and the poster. `views/settings/AGENTS.md` is at its word budget: trim
   to fit.

## Tests

- **Unit** (data going out of the Mac): one case beside #783's in `delivery/pass-pr.test.ts`'s Pictures to Slack
  block, or its own file on the same rung (real SQLite, the fake Slack fetch, `createSlackClient`): a Your-folder
  task with a before and an after posts once with both files and the project and task names; a task in a pass
  posts nothing; with sharing off nothing posts; after a refused upload one Inbox item is open and `retryTasks`
  posts and withdraws it. Value card: `why_new=data leaving the Mac`.
- **E2E**: none new; update the Sharing page wording if the settings e2e #783 extended asserts it.
- Screenshots of the Sharing page via the `screens` skill.

## Calls logged (cost if wrong)

- Passes with no origin or repo never post, as in #783 (rare; a follow-up if seen).
- No pull request link in a task's post (a link can be added once a batch's PR exists; cheap to add later).
- A task done again whose new capture kept nothing can post an older unmarked after (rare, harmless).
- 15-minute retry tick rather than a Try Again button (a button is an Inbox action type: more code).
