import {
  QuestionCategory,
  type PersonDto,
  type RoutingRuleDto,
  type RoutingRuleInput,
} from '@10db/contracts';

export const RouteScope = {
  Task: 'Task',
  Goal: 'Goal',
  Area: 'Area',
  Project: 'Project',
  Topic: 'Topic',
} as const;
export type RouteScope = (typeof RouteScope)[keyof typeof RouteScope];

const SCOPE_ORDER: readonly RouteScope[] = [
  RouteScope.Task,
  RouteScope.Goal,
  RouteScope.Area,
  RouteScope.Project,
  RouteScope.Topic,
];
const CATEGORY_ORDER: readonly string[] = Object.values(QuestionCategory);

export interface RouteRow {
  readonly key: string;
  readonly scope: RouteScope;
  /** The goal or task id, the area, or the topic words; empty for the project. */
  readonly subject: string;
  readonly categories: readonly string[];
  readonly people: readonly string[];
  /** The rules the row stands for, so Remove drops exactly these. */
  readonly ruleIds: readonly string[];
}

function scopeOf(rule: RoutingRuleDto): { scope: RouteScope; subject: string } {
  if (rule.taskId !== null) return { scope: RouteScope.Task, subject: rule.taskId };
  if (rule.goalId !== null) return { scope: RouteScope.Goal, subject: rule.goalId };
  if (rule.topic !== null) return { scope: RouteScope.Topic, subject: rule.topic };
  if (rule.area !== null) return { scope: RouteScope.Area, subject: rule.area };
  return { scope: RouteScope.Project, subject: '' };
}

/**
 * The project's rules as the table reads them: grouped by scope, most specific first. Rules of one
 * scope and subject for the same people fold into one row naming their categories; two people with
 * the same category at one scope share a row, since they are asked together.
 */
export function routeRows(
  rules: readonly RoutingRuleDto[],
  people: readonly PersonDto[],
): RouteRow[] {
  const nameOf = (id: string): string => people.find((p) => p.id === id)?.name ?? 'Someone';
  // Per scope, subject and category (or the topic itself): who is asked.
  const byKind = new Map<
    string,
    { scope: RouteScope; subject: string; category: string; people: string[]; ruleIds: string[] }
  >();
  for (const rule of rules) {
    const { scope, subject } = scopeOf(rule);
    const category = rule.category ?? '';
    const key = [scope, subject, category].join('\u0000');
    const entry = byKind.get(key) ?? { scope, subject, category, people: [], ruleIds: [] };
    entry.people.push(nameOf(rule.personId));
    entry.ruleIds.push(rule.id);
    byKind.set(key, entry);
  }
  const rows = new Map<string, RouteRow>();
  for (const entry of byKind.values()) {
    const key = [entry.scope, entry.subject, entry.people.join('|')].join('\u0000');
    const row = rows.get(key);
    rows.set(key, {
      key,
      scope: entry.scope,
      subject: entry.subject,
      categories: [
        ...(row?.categories ?? []),
        ...(entry.category === '' ? [] : [entry.category]),
      ].sort((a, b) => CATEGORY_ORDER.indexOf(a) - CATEGORY_ORDER.indexOf(b)),
      people: entry.people,
      ruleIds: [...(row?.ruleIds ?? []), ...entry.ruleIds],
    });
  }
  return [...rows.values()].sort(
    (a, b) => SCOPE_ORDER.indexOf(a.scope) - SCOPE_ORDER.indexOf(b.scope),
  );
}

/** The rules as the save route takes them. */
export function ruleInputs(rules: readonly RoutingRuleDto[]): RoutingRuleInput[] {
  return rules.map((r) => ({
    category: r.category,
    topic: r.topic,
    goalId: r.goalId,
    taskId: r.taskId,
    area: r.area,
    personId: r.personId,
  }));
}
