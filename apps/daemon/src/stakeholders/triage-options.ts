import type { PersonDto, PersonId, QuestionCategory, RoutingRuleDto } from '@10db/contracts';

type Hints = Readonly<Record<QuestionCategory, { readonly hint: string; readonly covers: string }>>;

export interface TriageOptions {
  /** The route keys the judge chooses among, ending with `nobody`. */
  readonly options: [string, ...string[]];
  /** A description per option, for the judge. */
  readonly criteria: Record<string, string>;
  /** The people each route holds, in routing order. */
  readonly peopleFor: Record<string, PersonId[]>;
}

export const NOBODY = 'nobody';
const NOBODY_CRITERION = 'None of these: the builder answers it';

const capitalised = (text: string): string => text.charAt(0).toUpperCase() + text.slice(1);

/** "A", "A and B", "A, B and C". */
function listed(names: readonly string[]): string {
  if (names.length <= 1) return names.join('');
  return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1] ?? ''}`;
}

/** The route key for a category's project routes. */
export const categoryKey = (category: QuestionCategory): string => `category:${category}`;

/**
 * What the judge may choose among when no explicit rule matched a question: one option per category
 * the project has routes for, one per topic (named by its first route), and `nobody`. Only project-wide
 * routes count; a goal, task or area route is an explicit rule and never reaches triage. A person who
 * is gone is left out of a route.
 */
export function triageOptions(
  rows: readonly RoutingRuleDto[],
  people: readonly PersonDto[],
  hints: Hints,
): TriageOptions {
  const byId = new Map(people.map((p) => [p.id, p]));
  const projectWide = rows.filter((r) => r.goalId === null && r.taskId === null && r.area === null);
  const routes = new Map<string, { label: string; ids: PersonId[] }>();
  const add = (key: string, label: string, personId: PersonId): void => {
    const route = routes.get(key) ?? { label, ids: [] };
    if (byId.has(personId) && !route.ids.includes(personId)) route.ids.push(personId);
    routes.set(key, route);
  };
  const topicKeys = new Map<string, string>();
  for (const row of projectWide) {
    if (row.category !== null) {
      const hint = hints[row.category];
      add(
        categoryKey(row.category),
        `${capitalised(row.category)}: ${hint.hint} ${capitalised(hint.covers)}.`,
        row.personId,
      );
    } else if (row.topic !== null) {
      const key = topicKeys.get(row.topic) ?? `topic:${row.id}`;
      topicKeys.set(row.topic, key);
      add(key, `Topic: ${row.topic}.`, row.personId);
    }
  }
  const criteria: Record<string, string> = {};
  const peopleFor: Record<string, PersonId[]> = {};
  for (const [key, route] of routes) {
    const names = route.ids.flatMap((id) => byId.get(id)?.name ?? []);
    criteria[key] = `${route.label} Answered by ${listed(names)}.`;
    peopleFor[key] = route.ids;
  }
  criteria[NOBODY] = NOBODY_CRITERION;
  const [head, ...tail] = [...routes.keys(), NOBODY];
  return { options: [head, ...tail], criteria, peopleFor };
}
