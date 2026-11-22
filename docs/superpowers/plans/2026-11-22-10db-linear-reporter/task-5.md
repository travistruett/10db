# Card 5: what it is handed, the Inbox item, the decision record

**Spec:** "Reporter" › "What it is handed", "What it may do" (the footer, read comments first, find the
attachment by URL), "Rules in its brief"; "States" (the Inbox rows); the brief's "Linear goes quiet".
**Track:** A, after card 4.

## Files

- `apps/daemon/src/linear/reporter-brief.ts` (new): `readReporterFacts` and `reporterBrief`, quoted in the index.
  The facts:
  - the task (title, headline, acceptance criteria), its link and the binding;
  - the project's note (`LinearReporterSettings.note`);
  - the rows this run takes (id, event, attempt, detail) and the task's recorded rows (comment ids, last status
    set, attachment URL);
  - per workstream the rows name: the implementation report (`implementationReportFor`), every review verdict
    and open finding (`reviewRounds` and the finding parser in `contracts/review-rounds.ts`), the evidence
    (`listEvidence`, `listWorkstreamCommitShas`), and what is missing from it (`listSkipsForWorkstream`,
    `deniedPermissionsForWorkstream`, and "no gate ran" when there is no `gate` evidence row);
  - the PR URL (`TaskDto.pullRequest`);
  - the task's screenshots: their ids and what each shows (`listTaskScreens`). Card 7 uses them; until card 7
    lands, the brief says "screenshots are not posted".

  Cap long text, the report and the findings, at about 4,000 characters each, saying what was cut.
- The brief's rules, as numbered lines:
  1. Call `get_workspace`, then `report_linear_workspace` with the workspace's and team's ids, before anything
     else.
  2. Read the issue (`get_issue`) and its comments (`list_comments`). An update whose id already appears in a
     comment's footer is recorded without posting again.
  3. Read the team's statuses with their types and positions. Never move to an earlier position or a lower type.
  4. If the status changed since the last recorded row's `statusSet`, and it isn't what 10db set, comment only.
  5. No completed-type status unless the note says so.
  6. Open findings and unverified checks are named in the comment and block a Ready for Release–like status.
  7. One comment per update. Each ends with `10db · <event> · attempt N · <post id>`.
  8. Find your attachment by its URL on the issue and update it, never add a second one. Its title is "10db". Its
     subtitle is the state, and its URL is the PR's or the card's. A card link is
     `tendb://tasks/<taskId>`; if the app has no such link scheme, use the PR URL only and say so.
  9. After posting, call `report_linear_post` once per outcome. A write refused as withheld is reported as
     withheld with the pattern's name.
  10. Change nothing but this issue. Say nothing else.
- `apps/daemon/src/linear/reporter-inbox.ts` (new): `linearReporterFoldKey` and `refreshReporterCard`.
  - Counts come from `linearPostCounts`. With nothing left, `withdraw` the open card.
  - Otherwise `flag` with `refresh: true`: tier Status, `closesWhen: BY_ANSWER`, `workstreamId: null`, detail
    `{ linearReporter: projectId }`.
  - Title "Linear Updates Need You"; the body gives the counts and the latest reason ("3 waiting, 1 failed, 1
    withheld (anthropic_key). Latest: <lastError>").
  - It is called after every settle and every drop. A dismiss goes through `onFlagAnswerInWrite` in
    `daemon/start.ts`: an item with `detail.linearReporter` calls `dismissLinearPosts`.
- A new decision record in `docs/architecture/decisions/`, dated 2026-11-22 and titled "The Linear reporter is 10db's own errand with its own guard": the
  Reporter owner kind, no judge, the rule's allow-list, the workspace check by a seen result, the secret-only
  scan, and why there's no visible chat (index calls 1, 3 and 4). Format per the decisions README.
- `apps/daemon/src/linear/AGENTS.md`: a paragraph on the reporter's modules.

## State-table rows

any / nothing left → withdrawn; any / dismissed → rows dismissed; pending / failure → the count rises.

## Tests

None new: card 4's run test exercises the brief, and the Inbox card is plain wiring. Read the brief back once
from card 4's test fixture and paste it into your report, so the reviewer can judge it.

## Done when

The checks in Global Constraints pass, and your report includes one rendered brief.
