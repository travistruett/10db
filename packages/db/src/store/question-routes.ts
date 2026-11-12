import {
  QuestionCategory,
  type QuestionRouteDto,
  type RoutingRuleDto,
  type TaskId,
} from '@10db/contracts';
import { eq } from 'drizzle-orm';
import * as schema from '../schema';
import { listRoutingRules } from './routing-rules';
import type { DbReader } from './store';
import { listPeople } from './team';

/**
 * Who a task's questions go to, as rows the lane's briefing and the API both read: for each category the
 * people at the first scope that has a route (the task, its goal, a project area it claims, the project),
 * and the project's topics. A category nobody is routed for goes to the builder and has no row.
 */
export function questionRoutesForTask(db: DbReader, taskId: TaskId): QuestionRouteDto[] {
  const task = db
    .select({
      projectId: schema.tasks.projectId,
      goalId: schema.tasks.goalId,
      areas: schema.tasks.areas,
    })
    .from(schema.tasks)
    .where(eq(schema.tasks.id, taskId))
    .get();
  if (!task) return [];
  const rules = listRoutingRules(db, task.projectId);
  const people = new Map(listPeople(db).map((p) => [p.id, p]));
  const peopleOf = (rows: readonly RoutingRuleDto[]) => [
    ...new Map(
      rows.flatMap((r) => {
        const person = people.get(r.personId);
        return person ? [[person.id, person] as const] : [];
      }),
    ).values(),
  ];
  const projectScope = rules.filter((r) => r.goalId === null && r.taskId === null);
  const inAreas = (r: RoutingRuleDto): boolean => r.area !== null && task.areas.includes(r.area);
  const out: QuestionRouteDto[] = [];
  for (const category of Object.values(QuestionCategory)) {
    const mine = rules.filter((r) => r.category === category);
    const tiers: ['task' | 'goal' | 'area' | 'project', RoutingRuleDto[]][] = [
      ['task', mine.filter((r) => r.taskId === taskId)],
      [
        'goal',
        task.goalId === null
          ? []
          : mine.filter((r) => r.goalId === task.goalId && (r.area === null || inAreas(r))),
      ],
      ['area', mine.filter((r) => projectScope.includes(r) && inAreas(r))],
      ['project', mine.filter((r) => projectScope.includes(r) && r.area === null)],
    ];
    const hit = tiers.find(([, matched]) => matched.length > 0);
    if (hit) out.push({ category, topic: null, people: peopleOf(hit[1]), from: hit[0] });
  }
  const topics = new Map<string, RoutingRuleDto[]>();
  for (const r of projectScope)
    if (r.topic !== null) topics.set(r.topic, [...(topics.get(r.topic) ?? []), r]);
  for (const [topic, rows] of topics)
    out.push({ category: null, topic, people: peopleOf(rows), from: 'topic' });
  return out;
}
