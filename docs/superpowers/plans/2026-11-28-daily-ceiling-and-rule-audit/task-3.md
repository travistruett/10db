# Task 3: two undos in 30 days set a rule to ask

Read the index's Brief and Global Constraints first. Size: Core (the decision rights). No migration: the record is
the app setting `rules.record`.

**Files:**

- New `packages/db/src/store/rule-record.ts`, exported from the package's entry point: the setting, read through
  zod as `rule-asking.ts` reads its own. Shape: project id → rule → mark → entries `{ at: ISO time, seq: number | null }`,
  oldest first. An `Undone` entry's `seq` is the event-log `seq` of the `notice.posted` event of the row
  that was undone (the same event `store/activity.ts` reads); a `SentUp` entry has no row, so its `seq` is null.
- New `packages/contracts/src/rule-stats.ts` with only `RULE_MARKS_KEPT = 200`; task 4 adds the rest of the file.
- `apps/daemon/src/inbox/activity-actions.ts`: `undo` records the mark and, at the second, switches the rule.
- New `apps/daemon/src/inbox/rule-asks-card.ts`, its answers wired where the other card answers are.
- `apps/daemon/src/inbox/activity-actions.test.ts` (extended); `apps/daemon/src/inbox/AGENTS.md`.

**Implements**, exactly: `RULE_WINDOW_DAYS`, `RULE_UNDOS_TO_ASK`, `RULE_MARKS_KEPT`, `RuleMark`, `recordRuleMark`,
`ruleMarkEntries`, `clearRuleMarks`, `RuleAsksChoice`. (`ruleStats` and the `SentUp` mark's callers are task 4's.)

**The rule.** In the write that marks a row undone:

- A row with `projectId === null` records nothing: a rule asks per project, and an app's row has none.
- Otherwise `recordRuleMark(ctx, projectId, rule, RuleMark.Undone, seq)`, with the undone row's `seq`. When it answers `RULE_UNDOS_TO_ASK` or more
  and the rule is not asking: `setRuleAsking(ctx, projectId, rule, true)` and the card, in that same write.
- A rule already asking raises nothing: one card per switch. Ask Me Next Time is unchanged and raises no card.
- Each mark's list keeps the newest `RULE_MARKS_KEPT` (200) entries, so a rule set to ask on a busy path can't grow
  the setting. A count read from it therefore tops out at 200 (task 4 shows that as "200+").

**The card.** `InboxKind.Flag`, `decidedByBuilder(BuilderOwns.Guardrails)`, fold key `rule-asks:<project>:<rule>`.
Title: "<Rule's name> now asks you in <Project>". Body: "You undid this rule's decision twice in 30 days, so its
next one is a card." and the two undone lines with their dates. The lines come from `ruleMarkEntries(db, projectId, rule,
RuleMark.Undone)`, the newest two: each entry's `at` is the date, and its `seq` finds the undone row's `notice.posted`
event, whose text is the line. An entry whose event is gone shows its date alone. Keep Asking closes it. Let 10db Decide Again
calls `setRuleAsking(..., false)` and `clearRuleMarks(..., RuleMark.Undone)`, so the next two undos count afresh.

**Test.** Extend `activity-actions.test.ts`, on real SQLite with the injected clock: two undos of one rule in one
project inside 30 days set it asking and raise one card; a third undo raises no second card; two undos 31 days
apart do not switch; two undos of an app's rows record nothing; Let 10db Decide Again clears the count. Show it
red first by raising the threshold to three.
`Value: protects=a rule the builder undid twice in 30 days stops deciding alone in that project; fails_when=the
rule keeps deciding, switches after one undo, or raises a card per undo; why_new=permissions (who decides);
no_claim=that each rule's site honours asking`.

**Spec:** "5." (Wrong automatic decisions) and "2. Who decides" (Ask me next time).
