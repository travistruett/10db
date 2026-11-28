import { z } from 'zod';
import type { DecisionRule, ProjectId } from '@10db/contracts';
import { getAppSetting, setAppSetting } from './settings';
import type { WriteContext } from './store';

/** What the builder did to a rule's decisions, per project: project id to rule to mark to times, oldest first. */
const RECORD_KEY = 'rules.record';
const RecordShape = z.record(
  z.string(),
  z.record(z.string(), z.record(z.string(), z.array(z.string()))),
);
type RuleRecord = z.infer<typeof RecordShape>;

/** Marks older than this many days no longer count. */
export const RULE_WINDOW_DAYS = 30;
/** Undos of one rule inside the window that set it to ask in that project. */
export const RULE_UNDOS_TO_ASK = 2;
/** A mark's list keeps at most this many times, so a busy rule can't grow the setting. */
const TIMES_KEPT = 200;

const DAY_MS = 24 * 60 * 60 * 1000;

/** What was done to a rule's decision: the builder undid it, or it was sent up to the builder instead. */
export const RuleMark = { Undone: 'undone', SentUp: 'sent_up' } as const;
export type RuleMark = (typeof RuleMark)[keyof typeof RuleMark];

/** A setting that doesn't parse reads as empty: it is a boundary, and a bad value must never stop a rule. */
function readRecord(ctx: WriteContext): RuleRecord {
  const parsed = RecordShape.safeParse(getAppSetting(ctx.tx, RECORD_KEY));
  return parsed.success ? parsed.data : {};
}

function write(
  ctx: WriteContext,
  record: RuleRecord,
  projectId: ProjectId,
  rule: DecisionRule,
  mark: RuleMark,
  times: readonly string[],
): void {
  const forProject = record[projectId] ?? {};
  const forRule = forProject[rule] ?? {};
  setAppSetting(ctx, RECORD_KEY, {
    ...record,
    [projectId]: { ...forProject, [rule]: { ...forRule, [mark]: [...times] } },
  });
}

/** The times of a mark that are still inside the window at `now`. */
function inWindow(times: readonly string[], now: string): string[] {
  const cutoff = Date.parse(now) - RULE_WINDOW_DAYS * DAY_MS;
  return times.filter((time) => Date.parse(time) >= cutoff);
}

/** Appends a time, drops those past the window, and answers the count left for this project, rule and mark. */
export function recordRuleMark(
  ctx: WriteContext,
  projectId: ProjectId,
  rule: DecisionRule,
  mark: RuleMark,
): number {
  const record = readRecord(ctx);
  const before = record[projectId]?.[rule]?.[mark] ?? [];
  const times = [...inWindow(before, ctx.now), ctx.now].slice(-TIMES_KEPT);
  write(ctx, record, projectId, rule, mark, times);
  return times.length;
}

/** Forgets every time of a mark for this project and rule, so its count starts again. */
export function clearRuleMarks(
  ctx: WriteContext,
  projectId: ProjectId,
  rule: DecisionRule,
  mark: RuleMark,
): void {
  const record = readRecord(ctx);
  if ((record[projectId]?.[rule]?.[mark] ?? []).length === 0) return;
  write(ctx, record, projectId, rule, mark, []);
}
