import {
  Delivery,
  landingTarget,
  ShapeMessageAuthor,
  ShapeMessageKind,
  ShapeProposalBody,
  ShapeProposalState,
  taskLandingFor,
  TaskStatus,
  WorkspaceMode,
  type DecisionId,
  type LandingTarget,
  type ShapeId,
  type ShapeMessageId,
  type TaskId,
} from '@10db/contracts';
import {
  decisionSuccessor,
  getDecision,
  getProject,
  getShape,
  getTask,
  latestWorkstreamOf,
  listPeople,
  listShapeLinks,
  listShapeMessages,
  listShapeProposals,
  type DbReader,
  type ShapeProposalRow,
} from '@10db/db';
import type { PlanWorld } from './validate';

/** How a landing target reads in a refusal: "merges into main when checks pass". */
const landsText = (target: LandingTarget): string =>
  target.autoMerge
    ? `merges into ${target.baseBranch} when checks pass`
    : `is held for your review (pull request against ${target.baseBranch})`;

/** The keys of the tasks a goal row holds in its body; none for any other row. */
export const tasksInside = (row: ShapeProposalRow): string[] =>
  row.kind === 'goal' ? ShapeProposalBody.goal.parse(row.body).tasks.map((t) => t.key) : [];

/**
 * What the rules about the conversation and the project read, as of now. Built inside the write
 * that uses it, so a reconcile and a Convert judge the same rows they write.
 */
export function buildPlanWorld(db: DbReader, shapeId: ShapeId): PlanWorld {
  const shape = getShape(db, shapeId);
  const project = getProject(db, shape.projectId);
  const links = listShapeLinks(db, shapeId);
  const created = new Set<TaskId>();
  const convertedTasks = new Map<string, TaskId>();
  const convertedGoals = new Set<NonNullable<(typeof links)[number]['goalId']>>();
  for (const link of links) {
    if (link.taskId !== null) {
      created.add(link.taskId);
      convertedTasks.set(link.key, link.taskId);
    }
    if (link.goalId !== null) convertedGoals.add(link.goalId);
  }
  const citable = new Set<ShapeMessageId>(
    listShapeMessages(db, shapeId)
      .filter(
        (m) =>
          (m.author === ShapeMessageAuthor.Builder && m.kind === ShapeMessageKind.Text) ||
          m.kind === ShapeMessageKind.Event,
      )
      .map((m) => m.id),
  );
  const proposals = listShapeProposals(db, shapeId);
  // A converted removal cancels its task and leaves the link, so the key stays in `convertedTasks`.
  const removedIds = new Set<TaskId>(
    proposals
      .filter((r) => r.kind === 'remove_task' && r.state === ShapeProposalState.Accepted)
      .map((r) => ShapeProposalBody.remove_task.parse(r.body).taskId),
  );
  const removedTasks = new Set(
    [...convertedTasks].filter(([, id]) => removedIds.has(id)).map(([key]) => key),
  );
  const pinned = proposals.filter(
    (r) => r.state === ShapeProposalState.Pending && r.pinned.length > 0,
  );
  return {
    areaNames: [...project.areas.map((a) => a.name), ...project.hazards.map((h) => h.name)],
    people: listPeople(db),
    citable,
    convertedTasks,
    removedTasks,
    convertedGoals,
    storedSources: new Set(proposals.map((r) => r.key)),
    storedKeys: new Set(proposals.flatMap((r) => [r.key, ...tasksInside(r)])),
    storedEfforts: new Set([
      // Decided from the links: an addition Remove Draft Goal took back stays Accepted, linkless.
      ...links.filter((l) => l.goalId !== null).map((l) => l.key),
      // A round supersedes every other pending row its draft leaves out.
      ...pinned.filter((r) => r.kind === 'goal' || r.kind === 'task').map((r) => r.key),
    ]),
    pinnedGoalTasks: new Map(
      pinned.filter((r) => r.kind === 'goal').map((r) => [r.key, tasksInside(r)]),
    ),
    draftPlace: {
      // What `insertTask` gives a task with no placement named: the project's own.
      place:
        project.delivery === Delivery.PullRequest ? project.workspaceMode : WorkspaceMode.Shared,
      lands: landsText(landingTarget(taskLandingFor(project), project.baseBranch)),
      landingGroup: null,
    },
    placeOf(id) {
      try {
        const task = getTask(db, id);
        if (task.projectId !== project.id) return null;
        return {
          place: task.workspaceMode,
          lands: landsText(landingTarget(task.landing, project.baseBranch)),
          landingGroup: task.landingGroupId ?? null,
        };
      } catch {
        return null;
      }
    },
    basisProblem(id) {
      try {
        const task = getTask(db, id);
        return task.projectId === project.id && task.status === TaskStatus.Done
          ? null
          : `${id} is not a finished task of this project`;
      } catch {
        return `${id} is not a finished task of this project`;
      }
    },
    decisionProblem(id) {
      let row: ReturnType<typeof getDecision>;
      try {
        row = getDecision(db, id as DecisionId);
      } catch {
        return `${id} is not a decision that applies to this project`;
      }
      if (row.projectId !== null && row.projectId !== project.id)
        return `${id} is not a decision that applies to this project`;
      if (row.withdrawnAt !== null) return `${id} has been withdrawn`;
      return decisionSuccessor(db, row.id) === null ? null : `${id} has been superseded`;
    },
    unstartedProblem(id) {
      if (!created.has(id)) return `${id} was not created by this conversation`;
      const task = getTask(db, id);
      if (task.status !== TaskStatus.Open || latestWorkstreamOf(db, id) !== undefined)
        return `${id} (${task.title}) has started`;
      return null;
    },
  };
}
