import {
  TaskSize,
  type GoalBrief,
  type GoalId,
  type LandingGroupId,
  type WorkspaceMode,
  type PlanDraft,
  type PlanGoal,
  type ShapeMessageId,
  type TaskId,
} from '@10db/contracts';
import { checkBriefRules } from '../goals';

// Shape spec §6 Validation. A pure check of the merged draft (the draft, pinned fields and
// restored rows) that answers every error at once, each naming the field it is about.

export const MAX_GOALS = 12;
export const MAX_TASKS_PER_GOAL = 40;
export const MAX_PROPOSALS = 80;

/** Where a task works and where its work lands, as a landing's checks compare them (§10.4). */
export interface TaskPlace {
  readonly place: WorkspaceMode;
  /** How the task lands, as a verb phrase: "merges into main when checks pass". */
  readonly lands: string;
  /** The landing group the task is already in, if any. */
  readonly landingGroup: LandingGroupId | null;
}

const placeName = (place: WorkspaceMode): string =>
  place === 'shared' ? 'your folder' : 'a separate copy';

/** What the checks need to know about the project and the conversation. */
export interface PlanWorld {
  /** The project's area and hazard names. */
  readonly areaNames: readonly string[];
  readonly people: readonly { readonly handle: string; readonly name: string }[];
  /** The builder's messages in this conversation, and its engine-event notes. */
  readonly citable: ReadonlySet<ShapeMessageId>;
  /** Tasks this conversation already converted, by the key they were proposed under. */
  readonly convertedTasks: ReadonlyMap<string, TaskId>;
  readonly convertedGoals: ReadonlySet<GoalId>;
  /** Why this task cannot be a basis, or null when it is a finished task of the project. */
  basisProblem(id: TaskId): string | null;
  /** Why a record cannot supersede this decision, or null when it is a current one that applies. */
  decisionProblem(id: string): string | null;
  /** Why this task cannot change or go, or null when this conversation made it and it has not started. */
  unstartedProblem(id: TaskId): string | null;
  /** Keys of the rows that already hold source ids, which a draft may leave out. */
  readonly storedSources: ReadonlySet<string>;
  /** Every key a stored row answers to, in any state: its own, and a goal's tasks' keys. */
  readonly storedKeys: ReadonlySet<string>;
  /**
   * Stored goals and tasks a draft may leave out and a question still be about: converted goals and
   * pinned pending rows, which this round keeps. Converted tasks are in `convertedTasks`.
   */
  readonly storedEfforts: ReadonlySet<string>;
  /**
   * The stored tasks of each pinned pending goal, by goal key. This round keeps them only if the draft
   * leaves the goal out: a goal it restates has the merged draft's tasks instead.
   */
  readonly pinnedGoalTasks: ReadonlyMap<string, readonly string[]>;
  /** The place and landing a task still in the draft gets when converted: the project's defaults. */
  readonly draftPlace: TaskPlace;
  /** Where a task Convert made works and lands now; null when it is not a task of the project. */
  placeOf(id: TaskId): TaskPlace | null;
}

const plural = (n: number, noun: string): string => `${String(n)} ${noun}${n === 1 ? '' : 's'}`;

/** A task of the draft, as the cycle check sees it. */
interface Node {
  readonly key: string;
  readonly effort: string;
  readonly dependsOn: readonly string[];
}

function goalBrief(goal: PlanGoal): GoalBrief {
  return {
    title: goal.title,
    objective: goal.objective,
    cares_most: goal.cares_most,
    criteria: goal.criteria,
    people: goal.people,
    tasks: goal.tasks.map((t) => ({
      key: t.key,
      title: t.title,
      headline: t.headline,
      why: t.why,
      description: t.description,
      criteria: t.criteria,
      areas: t.areas,
      depends_on: t.depends_on,
    })),
  };
}

/** Every rule the shape of a draft cannot see; an empty list means the draft may be reconciled. */
export function validatePlan(draft: PlanDraft, world: PlanWorld): string[] {
  const errors: string[] = [];
  const draftKeys = new Map<string, number>();
  const note = (key: string): void => {
    draftKeys.set(key, (draftKeys.get(key) ?? 0) + 1);
  };

  // Size caps.
  const total =
    draft.goals.length +
    draft.looseTasks.length +
    draft.additions.length +
    draft.landings.length +
    draft.records.length +
    draft.questions.length +
    draft.changes.length +
    draft.removals.length;
  if (draft.goals.length > MAX_GOALS)
    errors.push(
      `Plan: at most ${plural(MAX_GOALS, 'goal')} (it has ${String(draft.goals.length)}); fold some together or leave them for a later plan`,
    );
  if (total > MAX_PROPOSALS)
    errors.push(
      `Plan: at most ${String(MAX_PROPOSALS)} proposals in all (it has ${String(total)})`,
    );
  for (const goal of draft.goals)
    if (goal.tasks.length > MAX_TASKS_PER_GOAL)
      errors.push(
        `Goal ${goal.key}: at most ${plural(MAX_TASKS_PER_GOAL, 'task')} (it has ${String(goal.tasks.length)}); split it into two goals`,
      );

  // Keys: unique across the draft.
  for (const goal of draft.goals) {
    note(goal.key);
    for (const t of goal.tasks) note(t.key);
  }
  for (const t of draft.looseTasks) note(t.key);
  for (const t of draft.additions) note(t.key);
  for (const row of [...draft.landings, ...draft.records, ...draft.questions]) note(row.key);
  for (const [key, count] of draftKeys)
    if (count > 1) errors.push(`Plan: the key ${key} is used more than once; keys are unique`);

  const taskKeys = new Set<string>([
    ...draft.goals.flatMap((g) => g.tasks.map((t) => t.key)),
    ...draft.looseTasks.map((t) => t.key),
    ...draft.additions.map((t) => t.key),
  ]);
  const knownTask = (key: string): boolean => taskKeys.has(key) || world.convertedTasks.has(key);
  const dependency = (label: string, field: string, keys: readonly string[], own: string): void => {
    for (const key of keys) {
      if (key === own) errors.push(`${label}, ${field}: a task cannot depend on itself`);
      else if (!knownTask(key)) errors.push(`${label}, ${field}: no proposal has the key ${key}`);
    }
  };

  // Goals: the adopt validator on each, then what crosses efforts.
  for (const goal of draft.goals) {
    for (const issue of checkBriefRules(goalBrief(goal), {
      areaNames: world.areaNames,
      people: world.people,
    }))
      errors.push(`Goal ${goal.key}: ${issue.path}: ${issue.message}`);
    goal.tasks.forEach((t, i) => {
      const own = new Set(goal.tasks.map((x) => x.key));
      dependency(
        `Goal ${goal.key}, task ${String(i + 1)}`,
        'depends on outside',
        t.dependsOnOutside,
        t.key,
      );
      for (const key of t.dependsOnOutside)
        if (own.has(key))
          errors.push(
            `Goal ${goal.key}, task ${String(i + 1)}, depends on outside: ${key} is in this goal; use depends_on`,
          );
    });
  }

  // Loose tasks and additions: the same area checks.
  const areas = new Set(world.areaNames);
  draft.looseTasks.forEach((t, i) => {
    const label = `Loose task ${String(i + 1)}`;
    if (t.criteria.length === 0)
      errors.push(`${label}, criteria: a task needs at least one acceptance criterion`);
    for (const area of t.areas)
      if (!areas.has(area))
        errors.push(
          `${label}, areas: the project has no area ${area} (it has ${world.areaNames.join(', ')})`,
        );
    dependency(label, 'depends on', t.dependsOn, t.key);
  });
  draft.additions.forEach((t, i) => {
    const label = `Addition ${String(i + 1)}`;
    if (!world.convertedGoals.has(t.goalId))
      errors.push(`${label}, goal: ${t.goalId} is not a goal this conversation converted`);
    if (t.criteria.length === 0)
      errors.push(`${label}, criteria: a task needs at least one acceptance criterion`);
    for (const area of t.areas)
      if (!areas.has(area))
        errors.push(
          `${label}, areas: the project has no area ${area} (it has ${world.areaNames.join(', ')})`,
        );
    dependency(label, 'depends on', t.dependsOn, t.key);
  });

  // Sizes: a basis is a finished task, and nothing is XL.
  const sized = [
    ...draft.goals.flatMap((g) =>
      g.tasks.map((t, i) => ({ label: `Goal ${g.key}, task ${String(i + 1)}`, t })),
    ),
    ...draft.looseTasks.map((t, i) => ({ label: `Loose task ${String(i + 1)}`, t })),
    ...draft.additions.map((t, i) => ({ label: `Addition ${String(i + 1)}`, t })),
  ];
  for (const { label, t } of sized) {
    for (const id of t.basis ?? []) {
      const problem = world.basisProblem(id);
      if (problem !== null) errors.push(`${label}, basis: ${problem}`);
    }
    if (t.size === TaskSize.XL) errors.push(`${label}, size: XL — split it into smaller tasks`);
  }

  // Sources: the builder's messages, or the rows' stored ones.
  const sources = (
    label: string,
    key: string,
    ids: readonly ShapeMessageId[] | undefined,
  ): void => {
    if (ids === undefined) {
      if (!world.storedSources.has(key)) errors.push(`${label}, sources: cites no message`);
      return;
    }
    for (const id of ids)
      if (!world.citable.has(id))
        errors.push(
          `${label}, sources: ${id} is not one of the builder’s messages in this conversation`,
        );
  };
  draft.goals.forEach((g) => {
    sources(`Goal ${g.key}`, g.key, g.sourceMessageIds);
    g.tasks.forEach((t, i) => {
      // A goal task's sources may fall back to its goal's.
      if (t.sourceMessageIds !== undefined)
        sources(`Goal ${g.key}, task ${String(i + 1)}`, t.key, t.sourceMessageIds);
    });
  });
  draft.looseTasks.forEach((t, i) => {
    sources(`Loose task ${String(i + 1)}`, t.key, t.sourceMessageIds);
  });
  draft.additions.forEach((t, i) => {
    sources(`Addition ${String(i + 1)}`, t.key, t.sourceMessageIds);
  });
  draft.landings.forEach((r, i) => {
    sources(`Landing ${String(i + 1)}`, r.key, r.sourceMessageIds);
  });
  draft.records.forEach((r, i) => {
    sources(`Record ${String(i + 1)}`, r.key, r.sourceMessageIds);
  });
  draft.questions.forEach((r, i) => {
    sources(`Question ${String(i + 1)}`, r.key, r.sourceMessageIds);
  });
  draft.changes.forEach((r, i) => {
    sources(`Change ${String(i + 1)}`, `change:${r.taskId}`, r.sourceMessageIds);
  });
  draft.removals.forEach((r, i) => {
    sources(`Removal ${String(i + 1)}`, `remove:${r.taskId}`, r.sourceMessageIds);
  });

  // Questions: the goal or task one is about must be in this plan, converted, or kept by this round.
  const goalKeys = new Set(draft.goals.map((g) => g.key));
  const keptGoalTasks = new Set(
    [...world.pinnedGoalTasks].flatMap(([goal, tasks]) => (goalKeys.has(goal) ? [] : tasks)),
  );
  draft.questions.forEach((q, i) => {
    if (q.about === undefined) return;
    if (
      knownTask(q.about) ||
      goalKeys.has(q.about) ||
      world.storedEfforts.has(q.about) ||
      keptGoalTasks.has(q.about)
    )
      return;
    errors.push(
      world.storedKeys.has(q.about)
        ? `Question ${String(i + 1)}, about: ${q.about} is not a goal or task that is still in the plan; a question can only be about a goal or task`
        : `Question ${String(i + 1)}, about: no proposal has the key ${q.about}`,
    );
  });

  // Records: what a decision supersedes must be a current decision that applies here, and a
  // principle names no predecessor, since Convert replaces the current one with its key and scope.
  draft.records.forEach((r, i) => {
    if (r.supersedes === undefined) return;
    if (r.kind === 'principle') {
      errors.push(
        `Record ${String(i + 1)}, supersedes: a principle supersedes by topic key and scope; drop supersedes and give the topicKey of the one it replaces`,
      );
      return;
    }
    const problem = world.decisionProblem(r.supersedes);
    if (problem !== null) errors.push(`Record ${String(i + 1)}, supersedes: ${problem}`);
  });

  // Changes and removals: only this conversation's tasks that have not started, once each.
  const seenTasks = new Set<string>();
  const reach = (label: string, id: TaskId): void => {
    const problem = world.unstartedProblem(id);
    if (problem !== null) errors.push(`${label}, task: ${problem}`);
  };
  draft.changes.forEach((c, i) => {
    reach(`Change ${String(i + 1)}`, c.taskId);
    if (seenTasks.has(`change:${c.taskId}`))
      errors.push(`Change ${String(i + 1)}, task: ${c.taskId} already has a change in this plan`);
    seenTasks.add(`change:${c.taskId}`);
    if (c.dependsOn !== undefined)
      errors.push(
        `Change ${String(i + 1)}, depends on: a task's dependencies cannot be changed yet; remove the task and add it again`,
      );
  });
  draft.removals.forEach((r, i) => {
    reach(`Removal ${String(i + 1)}`, r.taskId);
    if (seenTasks.has(`remove:${r.taskId}`))
      errors.push(`Removal ${String(i + 1)}, task: ${r.taskId} already has a removal in this plan`);
    seenTasks.add(`remove:${r.taskId}`);
  });

  // Landings: a task is in at most one, each key is a task, and the tasks of one share a pull
  // request, so they work in the same place and land the same way (§10.4).
  const landed = new Map<string, string>();
  draft.landings.forEach((landing, i) => {
    const label = `Landing ${String(i + 1)}, keys`;
    let first: { key: string; place: TaskPlace } | undefined;
    for (const key of landing.keys) {
      if (!knownTask(key)) {
        errors.push(`${label}: no proposal has the key ${key}`);
        continue;
      }
      const other = landed.get(key);
      if (other !== undefined && other !== landing.key)
        errors.push(`${label}: ${key} is already in landing ${other}`);
      else landed.set(key, landing.key);
      // A task Convert made is judged by the place and landing it has; one still in the draft gets
      // the project's defaults when it is converted.
      const convertedId = world.convertedTasks.get(key);
      const place = convertedId === undefined ? world.draftPlace : world.placeOf(convertedId);
      if (place === null) continue;
      if (place.landingGroup !== null) errors.push(`${label}: ${key} is already in a landing`);
      if (first === undefined) first = { key, place };
      else if (first.place.place !== place.place)
        errors.push(
          `${label}: ${first.key} works in ${placeName(first.place.place)}, but ${key} works in ${placeName(place.place)}; a landing's tasks share a pull request, so they must work in the same place`,
        );
      else if (first.place.lands !== place.lands)
        errors.push(
          `${label}: ${first.key} ${first.place.lands}, but ${key} ${place.lands}; a landing's tasks share a pull request, so they must land the same way`,
        );
    }
  });

  errors.push(...crossEffortCycles(draft));
  return errors;
}

/** Cycles over the whole draft; a cycle inside one goal is the adopt validator's to report. */
function crossEffortCycles(draft: PlanDraft): string[] {
  const nodes = new Map<string, Node>();
  for (const goal of draft.goals)
    for (const t of goal.tasks)
      nodes.set(t.key, {
        key: t.key,
        effort: `goal:${goal.key}`,
        dependsOn: [...t.depends_on, ...t.dependsOnOutside],
      });
  for (const t of [...draft.looseTasks, ...draft.additions])
    nodes.set(t.key, { key: t.key, effort: `task:${t.key}`, dependsOn: t.dependsOn });

  const errors: string[] = [];
  const finished = new Set<string>();
  const stack: Node[] = [];
  const visit = (node: Node): void => {
    if (finished.has(node.key)) return;
    stack.push(node);
    for (const key of node.dependsOn) {
      const next = nodes.get(key);
      if (!next || next === node) continue;
      const at = stack.indexOf(next);
      if (at === -1) visit(next);
      else {
        const loop = stack.slice(at);
        if (new Set(loop.map((n) => n.effort)).size > 1)
          errors.push(
            `Plan: these tasks wait on each other: ${[...loop, next].map((n) => n.key).join(', ')}`,
          );
      }
    }
    stack.pop();
    finished.add(node.key);
  };
  for (const node of nodes.values()) visit(node);
  return errors;
}
