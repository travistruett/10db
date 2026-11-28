# 10db's own work stops at a daily ceiling, a rule undone twice asks, and Settings shows each rule's decisions

Size: Core (money and the decision rights). Five tasks, built in order 1 → 5, each after its predecessor has
merged. Stage 11 of `docs/superpowers/specs/2026-11-27-what-reaches-the-builder-design.md` (§5, §6, §10).
Status: designed, not built. This pull request holds the plan only. It changes no guardrail file.

## Brief

**What changes for the builder.**

- Work 10db started by itself (a fix task it filed, a CI fix, its one re-run of a crashed or stuck run) stops for
  the day at the project's ceiling. Running sessions finish; new ones wait. One card (Money) names the measure
  passed and the runs waiting: Carry On Today or Wait Until Tomorrow. Work you started is never counted or held.
- Two undos of one rule in 30 days set that rule to ask in that project, and one card says so.
- Settings › Decisions gains a Rules tab: per rule, decisions made, undone and sent up in 30 days.
- The Activity icon shows a dot only after a rule was switched to asking or a ceiling was reached.

**What it buys.** A brake on self-healing that spends your money, and a way to see a rule that decides more each
week with nobody checking it.

**What could go wrong, and how we'd know.** A site that starts work without the mark spends uncounted: Settings ›
Billing shows today's counted line. A wrong mark makes your own work wait: task 2's engine test starts a builder
run at the ceiling. A Claude plan that never reports its use trips only on the session count; the line shows it.

**Calls the builder might disagree with.**

1. Defaults: $10, 10% of the plan's limit, and 20 sessions that could not be measured (a plan session that
   reported no share, or a metered one that used tokens and has no price). Three numbers, not one.
2. The share is of the weekly limit, not the five-hour one.
3. A fix task 10db filed stays counted after you answer its card or retry it. One 10db re-run of your own run is
   counted and can wait. Second reviews and send-backs inside your run, and judge calls, are not counted.
4. Waiting work is kept, not dropped. It starts at local midnight or on Carry On Today.
5. The card that says a rule now asks is filed as Your Guardrails: the rule deciding alone was a standing yes.
6. The dot clears when the panel opens. Ask Me Next Time raises no card and no dot: you did it yourself.

**Known limits.** On a plan the share is the account's whole rise while the session ran, so other use of the plan
then (other sessions, your own, use outside 10db) counts as 10db's: it stops early, never late. Settings says so.

**Needed from the builder:** nothing.

## Global Constraints

- `.claude/rules/code-style.md` and `.claude/rules/testing.md`. Contracts change by addition only.
- All seven columns land in task 1, in one migration, generated last (`packages/db/AGENTS.md`): no later task adds one.
- App-setting keys come only from the exported builders below and are read through zod; unreadable reads as empty.
- The ceiling never stops a running session and never looks at a run that is not checked.
- Each card declares its decider and has `options`, no `detail.actions`. Labels are Title Case.
- The day is the local day of a session's start on the injected clock, as `accounts/month.ts` computes a month.
- Decision file in `docs/architecture/decisions/`: `2026-11-28-10dbs-own-work-has-a-daily-ceiling.md`. It starts
  with how an unpriced metered session is counted; task 2 completes it.

## Provider parity

Bedrock, an API key and OpenRouter count dollars (`isMetered`), priced at every `turn_complete`; a session there
that used tokens but has no cost (an OpenRouter model its list gives no price, a Codex report of $0) counts as
unmeasured, so it reaches the sessions ceiling instead of counting nowhere. A ChatGPT/Codex
plan counts the share: each snapshot carries a utilization per window. A Claude plan counts the share when a
`rate_limit_event` carries one, else the session count; how often a Max plan reports is not verified (follow-up).
Rules, cards, the table and the dot are 10db's own and the same everywhere. Lacks: the Known limit above.

## Interfaces

```ts
// packages/db: workstreams.self_started, workstreams.auto_rerun, sessions.self_started (boolean, false);
// sessions.limit_share (real, null); projects.auto_ceiling_usd (10), auto_ceiling_share (0.1),
// auto_ceiling_sessions (20). insertWorkstream takes `selfStarted`; insertSession takes `selfStarted`.
// apps/daemon/src/accounts/limit-share.ts (pure)
export const UNNAMED_LIMIT = 'unnamed'; // a report whose limit type is null
export type LimitShareState = ReadonlyMap<string, { readonly last: number; readonly rise: number | null }>;
export function limitShare(state: LimitShareState, report: { limitType: string | null; utilization: number | null }): LimitShareState;
/** `seven_day` when heard, else the longest named window, else the unnamed one; null when none. */
export function ceilingLimit(typesHeard: readonly string[]): string | null;
// packages/db/src/store/usage.ts
export function selfStartedToday(db: DbReader, projectId: ProjectId, day: { start: string; end: string }): { usd: number; share: number; unmeasured: number };
// apps/daemon/src/accounts/auto-ceiling.ts
export const CeilingMeasure = { Usd: 'usd', Share: 'share', Sessions: 'sessions' } as const;
export const autoCeilingDayKey = (projectId: ProjectId): string => `auto_ceiling_day.${projectId}`;
export const AutoCeilingDay = z.object({ day: z.iso.date(), carryOns: z.int().nonnegative() });
export function ceilingStatus(spent: { usd: number; share: number; unmeasured: number }, ceilings: { usd: number; share: number; sessions: number }, carryOns: number): CeilingMeasure | null;
export function isChecked(row: { selfStarted: boolean; autoRerun: boolean }): boolean;

// apps/daemon/src/scheduler/queue-waits.ts; QueueWaitKind.Ceiling in @10db/contracts
queueWait.ceiling(): FoundWait; // "for tomorrow: this project's own work reached today's ceiling"
// apps/daemon/src/inbox/auto-ceiling-card.ts
export const AutoCeilingChoice = { Carry: 'Carry On Today', Wait: 'Wait Until Tomorrow' } as const;
export const autoCeilingFoldKey = (projectId: ProjectId, day: string, carryOns: number): string => `auto-ceiling:${projectId}:${day}:${String(carryOns)}`;

// packages/db/src/store/rule-record.ts: app setting `rules.record`
export const RULE_WINDOW_DAYS = 30; export const RULE_UNDOS_TO_ASK = 2;
export const RuleMark = { Undone: 'undone', SentUp: 'sent_up' } as const;
export const RULE_MARKS_KEPT = 200; // packages/contracts/src/rule-stats.ts: newest entries kept per mark, so a count tops out here
export const RuleMarkEntry = z.object({ at: z.iso.datetime(), seq: z.int().nullable() }); // seq: the undone row's notice.posted event
/** Appends an entry (`seq` for an undone row), drops those past the window and the oldest past RULE_MARKS_KEPT, and answers the count left for this project, rule and mark. */
export function recordRuleMark(ctx: WriteContext, projectId: ProjectId, rule: DecisionRule, mark: RuleMark, seq?: number): number;
export function ruleMarkEntries(db: DbReader, projectId: ProjectId, rule: DecisionRule, mark: RuleMark): RuleMarkEntry[]; // oldest first
export function clearRuleMarks(ctx: WriteContext, projectId: ProjectId, rule: DecisionRule, mark: RuleMark): void;
export function ruleStats(db: DbReader, input: { projectId: ProjectId | null; now: Date }): RuleStatsDto[];
// packages/contracts/src/rule-stats.ts; GET /rules/stats?project=
export const RuleStatsDto = z.object({ rule: z.enum(DecisionRule), decided: z.int(), undone: z.int(), sentUp: z.int(), lastWeek: z.int(), weekBefore: z.int(), asking: z.boolean() });
export function sampleFirst(rows: readonly RuleStatsDto[]): RuleStatsDto[]; // the table's order
// apps/daemon/src/inbox/rule-asks-card.ts
export const RuleAsksChoice = { Keep: 'Keep Asking', Decide: 'Let 10db Decide Again' } as const;

// packages/db/src/store/activity-attention.ts: app setting `activity.attention`
export function markActivityAttention(ctx: WriteContext): void; // sets `since` when it is null
// clearActivityAttention(ctx) clears it. GET /activity/attention -> { since: string | null }; POST /activity/seen
```

## State table (design, not a test list)

A run is checked when `selfStarted || autoRerun`. The session inserted for it is written `self_started = true`, and
that same write clears `auto_rerun`.

| Event                                                         | `self_started` | `auto_rerun` | Next session counted         |
| ------------------------------------------------------------- | -------------- | ------------ | ---------------------------- |
| The builder starts a task                                     | false          | false        | no                           |
| 10db files and starts a fix task or a CI fix                  | true, for life | -            | yes, every session           |
| Crash retry, stall restart or recovery of a builder run       | false          | true         | that one; cleared at insert  |
| Later steps, handoffs, review and verify fixes of that run    | false          | false        | no                           |
| The builder's Retry or start of a builder run                 | false          | cleared      | no                           |
| A card answered, or the builder's Retry, on a 10db-filed run  | true           | -            | yes                          |
| A second review, proof or reviewer send-back in a builder run | false          | false        | no                           |
| Carry On Today                                                | unchanged      | unchanged    | the allowance rises          |

`ceilingStatus` answers the first measure reached, in this order, each ceiling times `1 + carryOns`:
dollars (`usd >= ceilings.usd`), share (`share >= ceilings.share`), sessions (`unmeasured >= ceilings.sessions`).

A checked run of a project at its ceiling, by where it is met:

- Scheduler tick: Queued, `queueWait.ceiling()` again each tick, never launched. One card per fold key.
- Runner, about to start a further session: `requeue(...)`, so it is Queued and the scheduler decides.
- Released at the next tick after Carry On Today (the answer wakes the scheduler) or after local midnight. A tick
  on a later day closes an unanswered card of an earlier day.

## Tracks and tasks

One track; each task is one pull request and a fresh implementer.

1. `task-1.md`: mark and measure. The seven columns, the marker sites, `limitShare`, `selfStartedToday`.
2. `task-2.md`: the ceiling. Settings fields, `ceilingStatus`, the wait, the card and its answers. Covers
   tsk_01a21f6d-42eb (gate fix tasks count against the ceiling).
3. `task-3.md`: two undos in 30 days set a rule to ask, with one card.
4. `task-4.md`: the Rules tab of Settings › Decisions, and the sent-up count.
5. `task-5.md`: the Activity icon's dot.

Follow-ups filed with this plan: read a Max plan's reports from the live log; apportion the share between
sessions that ran together; tokens instead of a session count.
