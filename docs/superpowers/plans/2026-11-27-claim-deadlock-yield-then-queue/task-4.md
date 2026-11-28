# Task 4: a third repeat files a 10db defect task

Read the index's Brief and Global Constraints first. Size: Core (claims; it writes a task into another project).

**Files:**

- New `apps/daemon/src/defects/file-defect.ts`, with an `AGENTS.md` beside it: a minimal filer that later rules
  (a stuck run, a batch out of moves three times) reuse.
- New `apps/daemon/src/defects/file-defect.test.ts`.
- `apps/daemon/src/mcp/tools.ts` (or `daemon/start.ts`): wire `Asking.reportRepeat`.
- `apps/daemon/src/mcp/claim-wait.ts`: the notice body when no task could be filed.

**Implements**, exactly (index, Interfaces): `fileDefect`. **Calls:** `markReported`, `readPair` (task 1).

**The filer.**

- 10db's own project is the project whose repository is 10db's (compare the checkout's GitHub repository with one
  exported constant; find how the project row names its repository and reuse that reading). None on this Mac:
  null.
- The task is inserted in the Icebox with `insertTask`, as a proposal's task is, never started by this code.
- The description's first line is `Defect signature: <signature>`. An open (not terminal, not archived) task in
  that project whose description carries the same line: null, nothing filed. Repeats across runs fold this way.

**The report.** `reportRepeat(pair)` runs in the yield's write when the move is `yield_queue_and_report` and
`pair.reported` is false:

- Signature: `claim-deadlock:` plus the sorted `contested` claim names (`<kind> <name>`, joined by `,`). Never a
  task id, so the same two areas deadlocking in another run fold into one task.
- Title: `Two tasks deadlocked three times over <claims>`.
- Description: the project's name, the two task titles, the contested claims, the times of the breaks from the
  pair's notices, and what 10db did each time. It quotes another project's task titles and claim names into
  10db's project; both are in the builder's local database only.
- `markReported` either way, so a fourth break files nothing.
- `fileDefect` answers null for "no 10db project": the yield's notice body then carries the same report, so it is
  not lost. Never a card.

**State-table row:** `yield_queue_and_report`.

**Test (real SQLite in a temp directory).** Seed a 10db project and another project with two tasks; drive
`recordBreak` three times and the report: the third files one Icebox task in the 10db project carrying the
signature; a fourth break, and a second pair over the same claims, file none. Without a 10db project nothing is
filed and the answer is null. Red first with the signature check removed.

`Value: protects=a repeated claim deadlock being reported once, as a task in 10db's own project, and never as a
card; fails_when=each repeat files another task, or the report is dropped when 10db's project is absent;
why_new=claims; no_claim=that the defect task is ever started or fixed`.

**Spec:** "5. How self-healing fails, and its guards" (Loops: "A rule that fires three times on one task files a
10db defect") and the "Claim deadlock" row of §3 in the what-reaches-the-builder spec.
