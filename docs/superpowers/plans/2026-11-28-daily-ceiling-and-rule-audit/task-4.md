# Task 4: the Rules tab of Settings › Decisions

Read the index's Brief and Global Constraints first. Size: Feature (a read and a table), built on task 3's record.

**Files:**

- New `packages/contracts/src/rule-stats.ts`: `RuleStatsDto`, `RuleStatsListDto { since, rules }`, `sampleFirst`.
- `packages/db/src/store/rule-record.ts`: `ruleStats`. `apps/daemon/src/api/app.ts`: `GET /rules/stats?project=`.
- The sites that read `isRuleAsking` (`stalls/sweep.ts`, `watcher/watcher.ts`, `accounts/move-back.ts`,
  `mcp/claim-wait.ts`, `mcp/tools.ts`, `delivery/worktree-save.ts`, `delivery/hand-made-worktrees.ts`,
  `delivery/copy-landing-cards.ts`, `runner/runner.ts`): each records `RuleMark.SentUp` where asking made it raise
  a card, or leave the move to the builder, instead of deciding.
- `apps/desktop/src/views/settings/decisions-section.tsx`: a third tab, Rules, and a new `rule-stats-table.tsx`.
- `apps/desktop/e2e/inbox-activity.spec.ts` (extended); `apps/desktop/src/views/settings/AGENTS.md`.

**Implements**, exactly: `ruleStats`, `RuleStatsDto`, `sampleFirst`.

**The numbers.** One row per `DecisionRule`, zeros included; 30 days back from the injected clock.

- `decided`: `notice.posted` events whose `decision.rule` is the rule, counted in SQL with `json_extract`, as
  `store/activity.ts` filters them. `lastWeek` and `weekBefore` are that count for the last 7 days and the 7
  before. These events are kept (only `session.context` and `session.activity` are pruned).
- `undone` and `sentUp`: the times in `rules.record`. An app's row was never recorded, so it is not in `undone`.
- `asking`: the rule asks in the project named, or in any project when none is.
- With `project`, every count is that project's; without, all active projects'.

**The order.** `sampleFirst`: first the rules with `undone === 0` and `lastWeek > weekBefore`, by the rise
(`lastWeek - weekBefore`), largest first; then the rest by `decided`, largest first; ties by the rule's name.
The list is the eleven rules, so it is not paged.

**The tab.** Columns: Rule (its `DECISION_RULE_NAMES` name), Decided, Undone, Sent Up, This Week, Last Week. A row
in the first group carries a "Worth a Look" badge with the hint "Deciding more each week, never undone". A rule
that asks shows "Asks you" beside its name. A project select filters it, as Activity's does. Empty state: "10db
has decided nothing by rule in the last 30 days."

**Tests.** No unit test: this is a read. Extend `inbox-activity.spec.ts`: after its flow posts a decision and
undoes it, the Rules tab shows that rule with one decided and one undone.

**Spec:** "5." (Silent drift) and "6. Auditing what 10db decided".
