import { sql } from 'drizzle-orm';
import { z } from 'zod';
import {
  DecisionRule,
  EventType,
  RULE_MARKS_KEPT,
  type ProjectId,
  type RuleStatsDto,
} from '@10db/contracts';
import * as schema from '../schema';
import { listActiveProjects } from './projects';
import { askingRules } from './rule-asking';
import { getAppSetting, setAppSetting } from './settings';
import type { DbReader, WriteContext } from './store';

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
const DAY_MS = 24 * 60 * 60 * 1000;

/** What was done to a rule's decision: the builder undid it, or it was sent up to the builder instead. */
export const RuleMark = { Undone: 'undone', SentUp: 'sent_up' } as const;
export type RuleMark = (typeof RuleMark)[keyof typeof RuleMark];

/** A setting that doesn't parse reads as empty: it is a boundary, and a bad value must never stop a rule. */
function readRecord(db: DbReader): RuleRecord {
  const parsed = RecordShape.safeParse(getAppSetting(db, RECORD_KEY));
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
  const record = readRecord(ctx.tx);
  const before = record[projectId]?.[rule]?.[mark] ?? [];
  const times = [...inWindow(before, ctx.now), ctx.now].slice(-RULE_MARKS_KEPT);
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
  const record = readRecord(ctx.tx);
  if ((record[projectId]?.[rule]?.[mark] ?? []).length === 0) return;
  write(ctx, record, projectId, rule, mark, []);
}

/** The projects a count covers: the one named, or every active one. */
function projectsCounted(db: DbReader, projectId: ProjectId | null): ProjectId[] {
  return projectId === null ? listActiveProjects(db).map((p) => p.id) : [projectId];
}

/** What each rule decided, had undone and sent up in the last window, for one project or every active one. */
export function ruleStats(
  db: DbReader,
  input: { readonly projectId: ProjectId | null; readonly now: Date },
): RuleStatsDto[] {
  const { projectId, now } = input;
  const at = (daysBack: number): string =>
    new Date(now.getTime() - daysBack * DAY_MS).toISOString();
  const [since, weekAgo, twoWeeksAgo] = [at(RULE_WINDOW_DAYS), at(7), at(14)];
  const events = schema.events;
  const ruleOf = sql<string | null>`json_extract(${events.data}, '$.decision.rule')`;
  const owner = sql`json_extract(${events.data}, '$.projectId')`;
  // An app's decision has no project: it counts in the total, not in a project's own.
  const inScope =
    projectId === null
      ? sql`(${owner} IS NULL OR ${owner} NOT IN
          (SELECT ${schema.projects.id} FROM ${schema.projects} WHERE ${schema.projects.archivedAt} IS NOT NULL))`
      : sql`${owner} = ${projectId}`;
  const decisions = new Map(
    db
      .select({
        rule: ruleOf,
        decided: sql<number>`count(*)`,
        lastWeek: sql<number>`coalesce(sum(${events.at} >= ${weekAgo}), 0)`,
        weekBefore: sql<number>`coalesce(sum(${events.at} >= ${twoWeeksAgo} AND ${events.at} < ${weekAgo}), 0)`,
      })
      .from(events)
      .where(
        sql`${events.type} = ${EventType.NoticePosted} AND ${events.at} >= ${since}
          AND ${ruleOf} IS NOT NULL AND ${inScope}`,
      )
      .groupBy(ruleOf)
      .all()
      .map((row) => [row.rule, row]),
  );
  const record = readRecord(db);
  const covered = projectsCounted(db, projectId);
  const asking = covered.map((id) => askingRules(db, id));
  const marked = (rule: DecisionRule, mark: RuleMark): number =>
    covered.reduce(
      (sum, id) => sum + inWindow(record[id]?.[rule]?.[mark] ?? [], now.toISOString()).length,
      0,
    );
  return Object.values(DecisionRule).map((rule) => {
    const row = decisions.get(rule);
    return {
      rule,
      decided: row?.decided ?? 0,
      undone: marked(rule, RuleMark.Undone),
      sentUp: marked(rule, RuleMark.SentUp),
      lastWeek: row?.lastWeek ?? 0,
      weekBefore: row?.weekBefore ?? 0,
      asking: asking.some((rules) => rules.has(rule)),
    };
  });
}
