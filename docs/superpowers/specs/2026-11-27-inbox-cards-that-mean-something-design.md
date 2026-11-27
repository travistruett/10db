# Inbox cards that mean something

**Status:** designed on 2026-11-27, not built.

**Builds on:** `docs/superpowers/specs/2026-11-17-10db-inbox-signal-design.md` (which cards exist: ask, notice or
status) and pull request #944 (a dim line in the bar saying what each answer does, and buttons named by effect).
This spec decides what an ask says, in what order, and when 10db should act instead of asking.

## Brief

**What changes for you.**

- Every card reads the same way, top to bottom: **what happened** in one plain line, **what it means** for you
  (what is stopped, what is safe), **what 10db already did**, your **answers**, each with its effect and whether you
  can undo it, one marked **Recommended** with its reason, and **if you leave it**, what happens. Logs, criteria and
  diffs fold behind a link.
- Titles put the outcome first and the work second, under a short name: `Didn't ship: 6 backend tests fail · Account
  Walls page conventions (findings, round 2)` instead of `Batch "Resolve the open findings of "Resolve the open
  findings of "…""" not shipped: the gate failed (exit 2)`.
- 10db stops asking where it can act and undo: a gate that fails in the batch's own files starts a fix task by
  itself, a claim deadlock is broken by the later task yielding, a finished worktree whose leftover files exist
  elsewhere is removed, and a flaky test files its own fix task. You read about each in the Activity panel (the
  history icon in the header), never in the Inbox.
- Review cards for work that already merged (Look, Check These Criteria) fold into one row per project, and leave
  Open unanswered after 7 days as "kept as is".
- A third round of "fix the findings" is not filed by itself; you get one card asking whether to keep going.
- Your phone buzzes only for cards where work is stopped until you answer.
- The Inbox keeps Open, Waiting and Resolved, and nothing else: it holds only what needs you. The Activity panel's
  rows get the Inbox list's spacing (§6.1).

**What it buys.** Since 2026-11-20 10db raised 419 cards. 214 closed themselves, 145 were answered with a choice
that changes nothing (Dismiss, Keep, Looks Right, Accept), 29 are open, and **31 (7%) got an answer that made 10db
do something**. The aim is that most of Open ends in an answer that does something, and that each card is
understood in seconds.

**What could go wrong, and how we'd know.**

- *10db acts where you'd have chosen otherwise.* Only moves you can undo are automatic, and each posts a line in the
  header's Activity panel saying what it did and how to undo it. Removing files found nowhere else, cancelling a task and shipping
  rejected work stay your call.
- *A recommendation is wrong and you follow it because it is marked.* Recommendations come from 10db's rules for
  each kind, never from an agent's guess on a 10db card, and each says its reason. Resolved records when you chose
  something else, so a bad rule shows.
- *An automatic fix task loops.* It counts against the project's fix attempts; past them, one card.
- *A summary hides the real cause.* The full log is one click away, and the summary says how many tests failed in
  which step, or that 10db couldn't read the log.
- *An expired review hides something you wanted.* It is in Resolved as "No answer · kept as is", searchable, and the
  task's For You keeps the diff.

**Calls you might disagree with.**

1. Unanswered Look and acceptance cards for merged work leave Open after 7 days as "kept as is".
2. A merged hand-made worktree that is clean and untouched for a day is removed without asking. Branches stay.
3. A claim deadlock is broken without asking: the task that asked later yields, which it can take back.
4. A gate failure in the batch's own files starts a fix task without asking, and Retry is not offered when the same
   code would fail the same way.
5. Phone pushes only for high-urgency asks.

**Needed from you:** a reply on this brief and on the mock-ups linked from the pull request. Then cut the stages in
§9. Nothing else.

---

## 1. What the Inbox says today

### 1.1 The numbers

The live database on 2026-11-27, cards created since 2026-11-20:

| Outcome                                                          | Cards |
| ---------------------------------------------------------------- | ----- |
| Withdrawn or resolved by 10db                                    | 214   |
| Answered with a choice that changes nothing                      | 145   |
| Answered with a choice 10db acted on (7 of them questions)       | 31    |
| Open                                                             | 29    |

The 145 no-op answers were 58 stray writes, 26 skipped-while-away cards, 25 merged-worktree cards, 12 failed runs,
12 Looks Right, 4 acceptance Accepts, and a handful of others. Every one of the 12 answered Look cards was Looks
Right, with no note. The 31 "Keep" answers on merged-worktree cards since 2026-10-28 carry the note "Cleared as
stale: every listed worktree is already gone": nobody kept a worktree, they were gone already.

Of the 29 open cards, 15 are Look cards and 4 are acceptance cards. **All 19 are for work whose pull request has
already merged**, and none blocks anything. The rest:

- 1 gate failure (high);
- 1 failed run from 2026-11-21 with no options and no closer ("Workstream failed: Add bye.txt for the retry proof",
  body "The gate failed 4 times (last exit 1)");
- 2 kept worktrees, 1 merged-worktree offer, 1 migrations notice, 1 flaky check, 1 standing-approval offer, 1 judge
  outage and 1 proposal.

### 1.2 Five ways a card fails the builder

**It shows raw output instead of saying what broke.** The card the builder quoted:

> **Batch "Resolve the open findings of "Resolve the open findings of "The Account Walls page follows the app's page
> conventions and reads cleanly""" not shipped: the gate failed (exit 2)**
>
> Last output:
> Container amps-backend-copy-run-9d1ca569391a Creating …
> gate: make gate WORKERS=4 · rev faeda5bfe … suite exit 1 (6 failed, 15891 passed, 5 warnings in 774.26s) …
> FAILED apps/ingest/tests/test_contract_application.py::test_only_a_closed_choice_mapping_takes_word_readings
> … (5 more FAILED lines) …
> make: \*\*\* [gate] Error 1
>
> Full log: ~/Library/Application Support/10db/logs/gate/batch-bat_01a21b42-….log
>
> Start a fix task in the batch (it reopens the batch), or press Retry in a task's drawer on the Board to ship
> again; nothing was merged.

`readGateFailures` (`apps/daemon/src/delivery/gate-failures.ts`) reads only 10db's own gate summary and vitest's
`FAIL` lines, so a pytest project falls through to the last 1,500 characters of output. The facts the builder needs
are in that output (6 tests fail, 15,891 pass, which files), but they are not pulled out. The card recommends a fix
task, but its buttons are Retry and Abandon: the step it advises isn't one of its answers, and Retry runs the same
gate on the same code.

**It asks for an answer that does nothing.** A Look card:

> **Look at these changes: Lanes hand off at 300k and stop at 400k by default**
> The change touched Migrations, Contracts and API, which you asked to look at yourself.
> Looks right closes this card. Send it back with a note to file a follow-up task.

Its pull request merged hours before the builder saw it. Looks Right changes nothing (`applyWatchpointAnswer`), and
there are 15 of these open.

**It hides the consequence in model output.** An acceptance card:

> **Check these criteria: The Executive board-pack download is proven in the browser on a named build**
> - The existing board-pack browser flow passes on a named build … (read as not met (0.01, second opinion))
> - The downloaded CSV is kept as evidence … (read as not met (0.01, second opinion))
> - The reader sees no Export Board Pack button … (read as not met (0.01, second opinion))
>
> It may also do something the task didn't ask for: The change may do something the task didn't ask for (0.97).

"(0.01, second opinion)" is a score, not a reason. The last line says nothing: the extra-behaviour reading carried
no description, only a probability. Another acceptance card lists "The builder has decided whether the
crosses_limit floor returns to 0.8" as not met. No agent can meet that criterion, so it is a question for the
builder, not a failed check.

**It names whole task titles where a short name would do.** A claim deadlock's four options are 4 full task titles,
for example `Resolve the open findings of "Unsigned work is reviewed separately from executed contracts" yields area
ingest`. #946 had to cut them to fit the 80-character option label. 24 of the 28 deadlock cards were withdrawn by
10db when the deadlock cleared by itself.

**It names 10db's machinery instead of the effect.**

- "Make 1 kind of command routine in ampsio?" is about `docker compose` being skipped 3 times.
- "10db's judge can't answer" means unattended work is skipping more than it should, because OpenRouter has no
  credits. The same card was raised and closed by 10db 17 times in a week.
- "Flaky check: pr-title (1 time)" tells the builder to "find which test it is" for a check that runs no tests.
- "10db kept the worktree of …: it holds git-ignored files" lists `next-env.d.ts`, which Next.js writes again on
  every build, and a `.env` the project's checkout also holds.

## 2. The card grammar

### 2.1 Five parts, always in this order

| Part             | Says                                                                        | Example (the gate card)                                                                         |
| ---------------- | --------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| **Happened**     | One sentence: the outcome, then the work, in the builder's words.           | Didn't ship: 6 backend tests fail.                                                              |
| **Means**        | What is stopped, what is at risk and what is safe.                          | Nothing merged. This batch waits; ampsio's other work goes on.                                  |
| **10db did**     | Up to three facts, in the past tense, about what 10db tried or checked.     | Ran the 6 tests again: they failed again. 4 of the 6 are in test files this batch changed.           |
| **Answers**      | Each answer: a verb label, one line of effect, and whether it can be undone. One is Recommended, with its reason. | **Start Fix Task** (Recommended: the failures are in this batch's files) · Run Gate Again · Abandon Batch |
| **If you leave it** | What happens with no answer, and when.                                   | Stays here. Nothing in this batch ships until you answer.                                       |

Evidence comes after the five parts and is folded: the failing tests, the criteria, the diff, the log link. The
card's first screen never holds raw output.

The grammar follows the published rules this spec draws on (sources in §11):

- **Every card is actionable and needs judgment.** "Every page should be actionable", and "pages with rote,
  algorithmic responses should be a red flag" (Google SRE book). A card whose right answer 10db can compute is a
  move 10db makes, told in the header's Activity panel (§3.2).
- **Lead with the symptom.** "What's broken, and why?" (SRE book): Happened is the symptom and Means is why it
  matters.
- **Offer the next step.** An alert should "indicate the severity of the issue and offer next steps" (PagerDuty), and
  "merely stating the problem is also not enough; offer some potential remedies" (NN/g).
- **Labels name results.** Instead of yes or no, give "response options that summarize what will happen for each
  possible response" (NN/g), and each button should get "a short, title-case term or phrase that clearly describes the
  result of the action" (Apple HIG).
- **Weigh one-way doors.** Irreversible, "one-way door" decisions deserve care; reversible ones "can and should be
  made quickly" (Bezos, 2015 letter). An undoable answer is a plain button. A one-way answer says so and never
  carries the Recommended mark unless every other answer loses work.
- **Recommend carefully.** A default is followed far more often than any other option (the default effect), so a
  recommendation must be right and must say why.
- **Never send the same card twice.** "Avoid sending multiple notifications for the same thing" (Apple HIG), and the
  SRE workbook calls for alert suppression. This is already the fold key's job; §3.3 extends it to rows that stand
  for many cards.

### 2.2 Answers

- **A verb phrase that names the result,** in title case, at most 4 words: Start Fix Task, Run Gate Again, Abandon
  Batch, Save Files and Remove, Mark All Looked At. Never Dismiss on an ask; "Not Now" is an answer only where leaving
  the card has a cost the builder may choose.
- **One line of effect** in the option's `description`, saying what 10db does next and what happens to the work.
- **Undo** (`InboxOption.undo`, §2.5): `yes` (what it does can be taken back, and the line says how), `no` (it
  deletes, cancels or ships), or absent for an answer that only records something.
- **At most one Recommended,** with a reason under 120 characters. The reason is a fact about this card, never "this
  is the usual choice". The bar draws the recommended answer as the filled primary button.
- **At most four answers,** as `ask_human` already allows. A fifth goes to the task's drawer. The failed-run card
  today has five (Retry, Ship Anyway, Ship Without It, Later, Dismiss); Dismiss goes, since Later says the same.

### 2.3 Who writes the words

- **10db writes every part of a 10db card** (flags, review, acceptance, Look), from facts it holds: counts, paths,
  states and what it ran. No judge or model writes Happened, Means or the recommendation, because the judge can be
  down (§1.2) and a model's words can claim anything. The one model text a 10db card may carry is an agent's own words
  (an `unasked` description, a fix session's handoff), set apart as "Claude says" or "Codex says", as the
  run-outside-the-sandbox card already does.
- **An agent's question** keeps its own title and options. `ask_human`'s `consequences` and `recommendation`, already
  in the contract, fill Means and Recommended. `consequences` becomes required for a question with more than two
  options.
- **A proposal** declares its kind (`detail.proposalKind`) so Accept's effect line can be written. A proposal with no
  kind is refused at the MCP boundary instead of being raised with "Accept the proposal".

### 2.4 If you leave it

Every card declares one of three fates, extending the signal spec's `closesWhen`:

| Fate                         | Says                                                                    | Used by                                                    |
| ---------------------------- | ----------------------------------------------------------------------- | ---------------------------------------------------------- |
| Stays until answered         | "Stays here. <what> waits until you answer."                            | asks whose work is stopped (high urgency)                  |
| Closes itself on an event    | "Closes itself when <event>. Until then <cost>."                        | condition cards (`by: 'event'`, `by: 'withdrawn'`)         |
| Expires as an answer         | "Leaves Open on <date> as <answer> if you don't answer."                | merged-work reviews, optional offers                       |

The third is a new `closesWhen` form, `{ by: 'expiry', afterDays, as }`. An hourly sweep resolves an expired card with
the named answer and `detail.resolution = { by: '10db', reason: 'No answer in 7 days: kept as is' }`. Resolved shows
it under the "No answer" outcome, and the sweep posts one notice per project in the Activity panel ("Kept as is with
  no answer in 7 days: 3 Look cards"). An expiring card never has urgency high.

### 2.5 Where it lives

A `CardBrief` in `@10db/contracts`, stored in the card's `detail` under `CARD_BRIEF`, as `detail.opens` and
`detail.closesItself` are today. It needs no migration.

```ts
export const CardBrief = z.object({
  happened: z.string().min(1).max(200),
  means: z.string().min(1).max(300),
  did: z.array(z.string().min(1).max(200)).max(3),
  ifIgnored: z.string().min(1).max(200),
  recommended: z.object({ choice: z.string(), why: z.string().max(120) }).nullable(),
});
// InboxOption gains: undo: z.enum(['yes', 'no']).optional()
```

`body` stays: it is the evidence, and Slack, search and push read it. A card with a brief draws the five parts and
folds the body under "Details". A card without one draws as today, with #944's decision line. `FlagInput` takes a
`brief`, optional at first. The repo test the signal spec's S3 adds checks that every builder it names passes one,
once Stage B in §9 has converted them all.

## 3. Every kind: current and proposed

### 3.1 The table

"→" marks the recommended answer. The fate column says whether the card stays, folds into a row with others,
expires, or is replaced by something 10db does itself (§3.2).

| Kind (fold key)                      | Title today (real)                                                                    | Title proposed                                                                       | Answers                                                                                  | Fate                                                                                 |
| ------------------------------------ | ------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| Gate failed at ship (`ship-failed`)  | Batch "Resolve the open findings of "Resolve…""" not shipped: the gate failed (exit 2) | Didn't ship: 6 backend tests fail · Account Walls page conventions (findings, round 2) | → Start Fix Task · Run Gate Again · Abandon Batch (undo: no)                              | 10db starts the fix itself; the card appears once fix attempts are used or the cause is outside the batch |
| Other ship failures                  | Batch "…" not shipped: the checkout has uncommitted changes                            | Didn't ship: <cause in words> · <short name>                                         | per cause (Commit With a Fix Task, Discard Changes (undo: no), Run Gate Again)            | stays                                                                                 |
| Failed run (`failed`)                | Workstream failed: Provide supported recovery replay for retained applied company reads | Failed at review after 2 rounds · Recovery replay for company reads                  | → Retry · Ship Anyway (undo: no) · Ship Without It · Later                                | stays; Dismiss removed                                                               |
| Claim deadlock (`claim-deadlock`)    | Claim deadlock: area ingest                                                           | Two ampsio tasks wait on each other · ingest and e2e                                 | → A Waits · B Waits · Cancel A (undo: no) · Cancel B (undo: no); A and B named in Means  | 10db makes the later asker yield; a card only if the same pair deadlocks again       |
| Stuck (`stuck`)                      | Stuck: Provide supported recovery replay …                                            | No activity for 40 min · Recovery replay for company reads                           | → Restart From Handoff · Cancel Run (undo: no) · Leave It Running                         | 10db restarts once from the latest handoff; the card comes after                     |
| Acceptance                           | Check these criteria: The Executive board-pack download is proven in the browser …    | Merged without proof of 3 criteria · Board-pack download in the browser              | → Send Back for Proof, or → Keep As Is (rule in §3.4)                                     | folds into the merged-work row; expires in 7 days as Keep As Is                      |
| Look (`watchpoint`)                  | Look at these changes: Lanes hand off at 300k and stop at 400k by default             | 13 merged changes touched Migrations or Contracts (one row per project; 15 cards)  | → Mark All Looked At · Send Back (per task) · Make Migrations a Show watchpoint           | folds; expires in 7 days as Looks Right                                              |
| Judge outage (`judge-outage`)        | 10db's judge can't answer                                                             | Unattended work skips more: OpenRouter has no credits                                | → Use <ready account> for Decisions · Open Decisions                                      | card only for causes that need the builder (401, 402, 403, an expired sign-in); others are a header status line |
| Standing approval (`precedent`)      | Make 1 kind of command routine in ampsio?                                             | Stop skipping `docker compose` in ampsio? 3 skips in 2 runs                          | Approve · Keep Skipping · → Later when a call of the kind hit a limit in 30 days          | stays; expires in 14 days as Later                                                   |
| Kept worktree (`worktree-ignored`)   | 10db kept the worktree of "…": it holds git-ignored files                             | A finished worktree holds 1 file found nowhere else: .env · Board-pack findings      | → Save Files and Remove · Keep · Open Folder                                              | 10db removes it when every file has a copy or is rebuilt by a tool                   |
| Merged hand-made worktrees (`hand-made-merged`) | 3 worktrees in ~/Projects/10db-worktrees.noindex have merged               | none                                                                                 | none                                                                                      | 10db removes clean ones untouched for 24 h; a notice in the Activity panel           |
| Migrations landed (`copy-migrations`) | The landing of "…" brought migrations into build                                     | Your dev database is 3 migrations behind ampsio's build branch                       | → Apply Migrations (when the project names a migrate command) · I Applied Them            | stays; normal urgency                                                                |
| Flaky check (`flaky-check`)          | Flaky check: pr-title (1 time)                                                        | none                                                                                 | none                                                                                      | a test check's second flake in 7 days files a fix task (notice); a check that runs no tests is a notice only |
| Stray write (`stray-write`)          | Write outside every claim                                                             | A lane wrote outside its claim: amps/frontend/src/api/generated/zod.gen.ts           | Trust This Version · → Close (when the path is one a hazard names as generated)           | stays; a generated path becomes a notice                                             |
| Skipped while away (`skipped`)       | Skipped while you were away: The see-screen e2e fails within 30 s …                   | 1 call skipped: reading ~/Library/Caches/ms-playwright · see-screen e2e              | → Run These Now · Leave It                                                                | stays; the call is described in words, never as JSON                                 |
| CI stopped (`ci-stopped`)            | CI still failing on A thread scrolled to its end …: gate-e2e-2                        | CI keeps failing, 10db stopped fixing: gate-e2e-2 · Thread stays scrolled to its end | → Rerun Failed Jobs · Open on GitHub                                                      | stays (already close to the grammar)                                                 |
| Base red (`base-red`)                | main fails CI, and 1 pull request wait on it                                          | main is red: 1 pull request waits on it                                              | none; closes itself                                                                       | stays                                                                                |
| Account moved (`account`)            | 10db moved to Orgtools Bedrock: Claude plan is at 95% of its weekly limit             | unchanged (it already says what, why and what's next)                                | Move Back · Stay                                                                          | stays; the model to copy                                                             |
| Start refused (`start-refused`)      | Not started: tasks depend on code that is not on the base branch                      | Can't start until <task> merges · <short name>                                       | → Retry Start · Cancel Task (undo: no)                                                    | stays                                                                                |
| Linear held (`linear-reporter`)      | Linear Updates Need You                                                               | Linear updates for ampsio are held: the Codex account isn't signed in to Linear      | → Connect Linear · Stop Retrying                                                          | closes itself once signed in                                                         |
| Question                             | the agent's question                                                                  | unchanged                                                                            | the agent's, with Recommended                                                             | stays; Means from `consequences`                                                     |
| Proposal                             | the agent's title                                                                     | unchanged                                                                            | Accept (its effect by kind) · Reject                                                      | stays; a proposal must declare its kind                                              |
| Check, Plan                          | Ready for you to check: X · Plan ready for you to approve: X                          | unchanged                                                                            | #944's labels                                                                             | stays                                                                                |
| Chat permission                      | Allow Bash?                                                                           | Claude wants to run a command outside the sandbox                                    | unchanged                                                                                 | stays                                                                                |
| A card with no answer and no closer  | Workstream failed: Add bye.txt for the retry proof (open since 2026-11-21)            | none                                                                                 | none                                                                                      | a bug: the S3 repo test refuses the builder, and the start sweep closes these        |

### 3.2 What 10db does instead of asking

Each move below is one the builder would almost always make, can be undone or loses nothing, and stays inside
the hard limits. Each posts a notice on the task or project (`postNotice`) saying what it did and how to undo it.
Notices are read in the Activity panel the header's history icon opens (`views/factory/activity-drawer.tsx`), and in
the task's drawer. None of them is an Inbox row, and the Inbox has no Activity tab.

1. **A ship gate that fails in the batch's own files starts a fix task in the batch**, as a task's own gate already
   does for its run. "Its own files" uses the test the shipper already applies (`outsideTheBatch`, `touchedBy`): a
   failing test in a file the batch changed, or one that imports a changed module. The fix counts against the
   project's fix attempts. The card is raised only when they are used up, or when the failure is outside the batch
   (base red, flaky, the machine), which already has its own path (`gateFailedUnrelated`).
2. **A claim deadlock is broken by the task that asked later yielding** what the other waits for, 2 minutes after it
   is found if it hasn't cleared by itself. Yielding is already reversible: the task asks again before editing there
   (`yieldRefusal`). A card is raised only if the same pair deadlocks again after a yield, and its options then name
   the tasks as A and B, defined in Means.
3. **A finished worktree's leftover git-ignored files are checked against the project's checkout.** A file with an
   identical copy there, or one a known tool writes again (`next-env.d.ts`, `*.tsbuildinfo`, `.DS_Store`, a list in
   one pure table), doesn't stop the removal. Only a file found nowhere else raises the card, and its recommended
   answer saves the files under `~/.10db/kept/<batch>/` before removing, so the one-way door becomes two-way.
4. **A merged hand-made worktree is removed** once it meets every condition the card already checks (the pull request
   merged, the branch holds nothing it lacks, no uncommitted or loose files), and also: no file under it changed in 24
   hours, and no process has its working directory there (`lsof`). The branch stays, as Remove Merged Worktrees does
   today. The Spotlight cards stay asks.
5. **A stuck run is restarted once from its latest handoff** before any card. The card comes only if the restarted
   session also stalls, with Restart From Handoff, Cancel Run and Leave It Running.
6. **A test check's second flake in 7 days files one fix task** in the project's Ready column ("Find and fix the
   flaky test in gate-test-1"), since the testing rules say a flake needs a code fix, never a retry. A check that runs
   no tests (`pr-title`, commitlint) flaking is a notice: a passing rerun there usually means the title was edited.
7. **A transient judge outage is a status line**, not a card: a slow or failing provider that clears by itself
   (`OUTAGE_WINDOW_MS`) shows in the header while it lasts. The card is for the causes only the builder can fix:
   a missing key, HTTP 401, 402 or 403, or an expired sign-in.

### 3.3 Merged-work reviews: one row per project

Look and acceptance cards are raised after the run moved on, and nothing waits on them. Once the task's pull request
merges (or the task lands), its open Look and acceptance cards join one row per project in Open, "Merged changes to
look over", grouped by `inboxRowKey` as a Workbench pass's pages are today. The row's content lists each task with:

- its short name;
- what it touched or which criteria are unproven;
- the reviewer's verdict on the watched files, which `useWatchpointHits` already reads;
- its own Looks Right or Keep As Is, and Send Back.

Mark All Looked At answers every card in the row with its no-change answer. Each card expires 7 days after its merge.
What happened to the row (looked at, sent back, expired) is posted as one notice in the Activity panel.

When an ask watchpoint passes the noisy mark the watchpoints spec defines (at least 5 cards, at least 80% Looks Right
with no note), the row offers **Make <watchpoint> a Show watchpoint**. Show keeps its hits in For You and the pull
request body.

While the pull request is still open, a Look card stays its own row and says "Merges by itself when its checks pass;
Send Back before then files a fix task in the batch". The hold that would let it wait is the watchpoints spec's S5.

### 3.4 Recommendation rules, by kind

| Kind                 | Recommended when                                                                                                 |
| -------------------- | ---------------------------------------------------------------------------------------------------------------- |
| Gate failed          | Start Fix Task when a failing test is in the batch's files; Run Gate Again only when 10db's own rerun hasn't run yet and the failures are outside the batch |
| Failed run           | Retry when the cause was outside the work (timeout, account limit, restart); Later otherwise                     |
| Acceptance           | Send Back for Proof when every unmet criterion is unproven and none is partly met; Keep As Is when all are "unclear" and the review passed |
| Look                 | Mark All Looked At when the reviewer passed every watched file; none when it raised a finding there              |
| Claim deadlock       | A Waits for the task that asked later                                                                            |
| Stuck                | Restart From Handoff when a handoff exists; Cancel Run when none and no commit in the run                         |
| Standing approval    | Later when a call of the kind hit a limit in the last 30 days; else none                                         |
| Kept worktree        | Save Files and Remove                                                                                            |
| Judge outage         | Use <account> for Decisions when another of the builder's accounts can run the judge                              |

An acceptance criterion that names the builder ("The builder has decided whether …") is never judged. It is raised as
a question card from the task, with the criterion as the question.

## 4. Titles

### 4.1 Outcome first, short name second

A row truncates at its right edge, so a card title puts the outcome first and the work after a `·`:
`Didn't ship: 6 backend tests fail · Account Walls page conventions`. Task titles here are sentences ("The Executive
board-pack download is proven in the browser on a named build"), so cards use the task's **short name**:

- the task's `shortTitle` when it has one: planners and `create_task` may set it, at most 48 characters;
- else the title with its leading article dropped, cut at the last word boundary before 48 characters, with no
  ellipsis inside a quote.

`shortTitle` is a nullable column on `tasks`, so it needs a migration, generated last, as the repo's rule says. No
card title nests quotes.

### 4.2 Follow-ups of follow-ups

Three builders in `packages/db/src/store/tasks.ts` and `apps/daemon/src/delivery/ci-fix-text.ts` prefix the source's
title. Each prefix wraps the whole title, so a chain nests. The live database holds three titles two or more levels
deep, for example `Resolve the open findings of "Resolve the open findings of "Resolve the open findings of "The
Account Walls page follows the app's page conventions and reads cleanly"""`.

The rule:

- **Every follow-up names its root.** The root is found by following the source id each follow-up's description
  already names. A title with no source chain is read by stripping the known prefixes (`Resolve the open findings
  of "…"`, `Meet the acceptance criteria of `, `Fix CI: <job> on `) until none is left.
- **The title is `<root short name> (<what>, round n)`**, for example `Account Walls page conventions (findings,
  round 2)`, `Board-pack download (acceptance proof)` and `Linear comment posting (CI gate-e2e-1)`. The round counts
  follow-ups of the same kind on the same root.
- **Round 3 isn't filed by itself.** A retry-limit follow-up whose source is already round 2 raises one card
  instead: `Review keeps rejecting Account Walls page conventions after 2 rounds`. Means says how the findings
  changed (6, then 4, then 4). The answers are Keep Going (files round 3), Stop Here (files nothing; the merged work
  stays) and Open the Findings. Keep Going is recommended when the count fell in the last round, Stop Here when it
  didn't. A follow-up loop that isn't converging is exactly what the builder should judge.

## 5. Raw logs become a summary

### 5.1 What a failure card shows

```
6 tests fail in the backend suite (15,891 pass)
  apps/ingest   3   test_contract_application · test_api · test_service_package
  apps/demo     3   test_load_feeds · test_tasks (×2)
Likely cause: 4 of the 6 are in test files this batch changed.
[Open Full Log]
```

- **Count and step first,** from the runner's own summary line.
- **Failing tests grouped by directory,** at most 5 groups, with short test names. Full ids are in the fold.
- **One "Likely cause" line**, chosen by rule, not written by a model:
  - in files the batch changed;
  - outside them, and the same tests fail on the base (base red);
  - outside them and passing on the base (flaky or a combination);
  - failed to run (a collection or import error);
  - timed out;
  - the machine was overloaded (the existing overload note).
- **When a fix session gave up,** its handoff's own words are quoted under "Claude says" or "Codex says" as the
  likely cause, since it read the failure most closely.
- **The log is one link** (`detail.logPath`, drawn by the existing `StepLogLink`). Raw lines never sit in the
  card's first screen.

### 5.2 Reading more runners

`gate-failures.ts` gains one pure table of runner patterns beside vitest's:

- pytest: `FAILED path::name`, `ERROR path`, and the `N failed, M passed` summary;
- jest: `● Suite › test`, and `Tests: N failed`;
- go test: `--- FAIL: TestX`, and `FAIL\tpkg`;
- cargo test: `test x ... FAILED`, and `test result: FAILED`;
- rspec: `rspec ./spec/…:12`;
- make: `make: *** [target] Error N`, which names the step.

Parsers are one of the core areas `testing.md` allows unit tests for. The table gets one test per runner, from a real
log excerpt.

When nothing parses, the card says "The gate failed (exit 2) and 10db couldn't read which tests" and shows the last
10 lines left after a noise filter. The filter drops container lifecycle lines, progress bars, blank lines and colour
codes, and prefers lines containing `FAILED`, `Error` or `error:`.

## 6. Notifications and the Open list

- **Push and macOS notifications fire only for high-urgency asks.** `push-sender.ts` sends on every
  `inbox.opened` today. Normal and low cards still count in Open and the badge. The lock-screen payload rule (kind and
  task headline only) is unchanged.
- **Open is drawn in three sections,** by the urgency it already sorts on: **Stopped until you answer** (high),
  **Decide when you can** (normal) and **Look over** (low, the merged-work rows and expiring offers). Each heading
  shows its count.
- **The row's second line is Means,** not the body's first line, so the list itself says what is at stake.
- **High is earned.** `urgency: high` is allowed only on a card whose fate is "stays until answered" and whose
  work is stopped. The gate card and the claim deadlock are high. The failed run on a test project from 2026-11-21 is
  not.

### 6.1 The Activity panel's rows

The Inbox holds only what needs the builder, so its switch stays Open, Waiting and Resolved. Activity is the panel
the header's history icon opens, left of the Live and Metrics switch (`ActivityButton` in
`views/factory/activity-drawer.tsx`). It has a search field, then one row per notice (`ActivityRowItem`).

Today a row reuses the Inbox row's two lines (`Lines` in `views/inbox/inbox-row-item.tsx`) but not the list's row
box (`inbox-row-list.module.css`). It has no padding, no fixed height, 5 px between its lines, and a full-width rule
between rows. The rows read as one block of text.

The rows take the Inbox list's box:

- **Height:** each row is at least 64 px, as an Inbox row is, with its two lines centred.
- **Padding:** 10 px top and bottom, 12 px each side.
- **Lines:** 6 px between the line and the second line. The title is 13 px at weight 500, and its count and age are
  11 px dimmed, on the right. The second line is the project chip, then the body's first line, 12 px dimmed.
- **Rows:** a hairline inset 12 px each side parts the rows. A row's hover is the list's half-step fill, with the
  md radius, and the hairline beside a filled row is hidden.
- **Search:** 12 px of space between the search field and the first row.
- **Days:** rows are grouped under day headings (Today, Yesterday, then the date). A heading is 11 px uppercase
  dimmed, with 16 px above it and 4 px below.

The simplest build is a shared class beside `inbox-row-list.module.css`'s `.row`, without its absolute
positioning, which `activity-drawer.tsx`'s list item uses. It needs no new component. This is Small (A6 in §9).

## 7. Provider parity

- **The grammar is 10db's text,** the same on a Claude plan, Claude through Bedrock or an API key, and a
  ChatGPT/Codex plan.
- **Automatic fix tasks and restarts run on the project's own account,** as every lane does, so all three get them.
  A fix session's quoted words name their agent, Claude or Codex.
- **The judge outage card offers a switch only to an account the judge runs on:** an Anthropic API key, Bedrock or
  OpenRouter (`apps/daemon/src/judge/`). With only a ChatGPT plan, the card offers Open Decisions and says the judge
  can't run on that plan yet; closing that gap is a follow-up task for the judge.
- **Questions** come through `ask_human` from Claude and Codex lanes alike, so the required `consequences` holds for
  both.

## 8. How this fits with the work in flight

- **#944 (merged)** keeps its renames (Keep As Is, Approve and Finish, Re-plan, Looks Right) and its folded
  acceptance evidence. Its decision line is built in the browser from the card's kind; this spec moves that text to
  the daemon, into each option's `description` and the brief, where the facts are. `decision-line.ts` stays as the
  fallback for a card with no brief and goes once Stage B has converted every builder.
- **The Inbox signal spec** decides whether something is a card; this one decides what a card says and moves some
  asks into 10db's hands (§3.2). The expiry fate extends its `closesWhen`, and its S3 repo test checks the `brief`.
- **The watchpoints spec:** §3.3 uses its noisy mark and leaves its S5 hold alone.

## 9. Stages

Each stage is sized by the code it touches, per the repo's rules. Stages A and B are independent; C to F each need B.

| Stage | Size    | What                                                                                                                                         | Tests                                                                         |
| ----- | ------- | -------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| A1    | Small   | Gate card title: outcome first, no exit code; the no-parse fallback's noise filter                                                           | related tests                                                                 |
| A2    | Small   | Acceptance: drop the scores from the body and notes, and drop the `unasked` line when it carries no description (a bug)                      | related tests                                                                 |
| A3    | Small   | Retitle precedent, judge outage, Linear held, base red, flaky check (a check with no tests reads as a title change)                          | related tests                                                                 |
| A4    | Small   | Claim deadlock: options read A Waits, B Waits, Cancel A, Cancel B, with A and B named in the body                                            | related tests                                                                 |
| A5    | Small   | Push only for high asks                                                                                                                      | related tests                                                                 |
| A6    | Small   | The Activity panel's rows take the Inbox list's spacing (§6.1)                                                                               | none (a screenshot)                                                           |
| B     | Feature | `CardBrief`, `InboxOption.undo` and the expiry fate in contracts; the expiry sweep; the desktop draws the five parts, the Recommended mark and Open's sections; briefs on the six mock-up kinds | extend `apps/desktop/e2e/inbox.spec.ts` with one acceptance and one gate card |
| C     | Feature | The runner table (§5.2), the summary layout, and Start Fix Task on the gate card                                                             | one unit test per runner (a parser)                                           |
| D     | Feature | Merged-work rows (§3.3), the 7-day expiry, Make It Show, and acceptance criteria that name the builder raised as questions                   | extend the `loop` e2e                                                         |
| E     | Feature | Short names (`shortTitle`, its migration last), follow-up titles by root and round, the round-3 card                                         | one test on the real SQLite for the root walk                                 |
| F1    | Core    | Automatic fix task for an in-batch ship gate failure                                                                                         | per its plan's cards                                                          |
| F2    | Core    | Claim deadlock: automatic yield of the later asker                                                                                           | per its plan's cards                                                          |
| F3    | Core    | Worktree leftovers: copy check, Save Files and Remove, and removal of idle merged hand-made worktrees                                        | per its plan's cards                                                          |
| F4    | Core    | Stuck run restarted once from its handoff                                                                                                    | per its plan's cards                                                          |
| F5    | Feature | Flaky test fix task on the second flake; a no-test check becomes a notice                                                                    | related tests                                                                 |

Each F stage gets its own Core plan (an index and cards), since each touches git, claims, recovery or data loss.
Recommended order: A1 to A6 now, then B, then C and D (they remove the most noise), then F1 and F2, then E, F3, F4
and F5.

## 10. How we'd know it worked

One query over `inbox_items`, run before Stage B and after each stage: the share of a week's cards that ended in an
answer 10db acted on (Dismiss, Keep, Looks Right, Later and an acceptance Accept change nothing; expiry is counted
apart). The baseline is **31 of 419 (7%)** for 2026-11-20 to 2026-11-27.

- After B, C and D: no card for merged work older than 7 days in Open, and no raw output on a gate card's first
  screen.
- After F1 and F2: no gate card for in-batch failures until fix attempts are used, and under one deadlock card a week.
- Throughout: how often the builder picks something other than the recommended answer. Above about a third for a
  kind, its rule in §3.4 is wrong.

## 11. Sources

The quotes in §2.1 are from these pages.

- Google SRE book, "Monitoring Distributed Systems" and "Practical Alerting":
  <https://sre.google/sre-book/monitoring-distributed-systems/>, <https://sre.google/sre-book/practical-alerting/>
- Google SRE workbook, "Alerting on SLOs" (precision; alert suppression): <https://sre.google/workbook/alerting-on-slos/>
- PagerDuty, "Alert Fatigue": <https://www.pagerduty.com/resources/digital-operations/learn/alert-fatigue/>
- Nielsen Norman Group, "Confirmation Dialogs", "OK-Cancel or Cancel-OK?" and "Error-Message Guidelines":
  <https://www.nngroup.com/articles/confirmation-dialog/>, <https://www.nngroup.com/articles/ok-cancel-or-cancel-ok/>,
  <https://www.nngroup.com/articles/error-message-guidelines/>
- Apple Human Interface Guidelines, "Notifications" (concise content, no repeats, result-naming action labels,
  context before a destructive action): <https://developer.apple.com/design/human-interface-guidelines/notifications>
- Jeff Bezos, 2015 letter to shareholders (one-way and two-way doors):
  <https://www.sec.gov/Archives/edgar/data/1018724/000119312516530910/d168744dex991.htm>
- The default effect: <https://en.wikipedia.org/wiki/Default_effect>
- GitHub Docs, "About notifications" (a reason on every item, Done, expiry of unsaved items):
  <https://docs.github.com/en/subscriptions-and-notifications/concepts/about-notifications>
- Linear Docs, "Triage" and "Inbox" (a small fixed verb set; snooze): <https://linear.app/docs/triage>,
  <https://linear.app/docs/inbox>
- GitHub Docs, "Workflow commands" (annotations name the failing file; the log stays behind a link):
  <https://docs.github.com/en/actions/using-workflows/workflow-commands-for-github-actions>
