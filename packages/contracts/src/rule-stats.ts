import { z } from 'zod';
import { DecisionRule } from './activity';
import { ProjectId } from './ids';

/** A rule's record keeps at most this many of its newest entries per mark, so a count tops out here. */
export const RULE_MARKS_KEPT = 200;

/** What one rule did in the last 30 days, in one project or in all of them. */
export const RuleStatsDto = z.object({
  rule: z.enum(DecisionRule),
  /** Decisions the rule made. */
  decided: z.int().min(0),
  /** Decisions of the rule the builder undid; at most `RULE_MARKS_KEPT`. */
  undone: z.int().min(0),
  /** Times the rule asked the builder instead of deciding; at most `RULE_MARKS_KEPT`. */
  sentUp: z.int().min(0),
  /** `decided` inside the last 7 days. */
  lastWeek: z.int().min(0),
  /** `decided` inside the 7 days before those. */
  weekBefore: z.int().min(0),
  /** The rule is set to ask: in the project named, or in any project when none is. */
  asking: z.boolean(),
});
export type RuleStatsDto = z.infer<typeof RuleStatsDto>;

/** `GET /rules/stats`: one entry per rule, counted from `since`. */
export const RuleStatsListDto = z.object({
  since: z.iso.datetime(),
  rules: z.array(RuleStatsDto),
});
export type RuleStatsListDto = z.infer<typeof RuleStatsListDto>;

/** `GET /rules/stats` query: one project's counts, or every active project's. */
export const RuleStatsQuery = z.strictObject({ project: ProjectId.optional() });
export type RuleStatsQuery = z.infer<typeof RuleStatsQuery>;

/** A rule deciding more each week with nobody undoing it: worth a look. */
export function isWorthALook(row: RuleStatsDto): boolean {
  return row.undone === 0 && row.lastWeek > row.weekBefore;
}

/**
 * The table's order: rules that decide more each week and were never undone first, by the size of the rise,
 * then the rest by what they decided; ties by the rule's key.
 */
export function sampleFirst(rows: readonly RuleStatsDto[]): RuleStatsDto[] {
  const rise = (row: RuleStatsDto): number => row.lastWeek - row.weekBefore;
  return [...rows].sort((a, b) => {
    const first = Number(isWorthALook(b)) - Number(isWorthALook(a));
    if (first !== 0) return first;
    const bySize = isWorthALook(a) ? rise(b) - rise(a) : b.decided - a.decided;
    return bySize !== 0 ? bySize : a.rule.localeCompare(b.rule);
  });
}
