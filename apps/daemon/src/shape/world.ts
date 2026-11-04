import {
  Delivery,
  landingTarget,
  ShapeMessageAuthor,
  ShapeMessageKind,
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
} from '@10db/db';
import type { PlanWorld } from './validate';

/** How a landing target reads in a refusal: "merges into main when checks pass". */
const landsText = (target: LandingTarget): string =>
  target.autoMerge
    ? `merges into ${target.baseBranch} when checks pass`
    : `is held for your review (pull request against ${target.baseBranch})`;

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
  return {
    areaNames: [...project.areas.map((a) => a.name), ...project.hazards.map((h) => h.name)],
    people: listPeople(db),
    citable,
    convertedTasks,
    convertedGoals,
    storedSources: new Set(proposals.map((r) => r.key)),
    storedEfforts: new Set(
      proposals
        .filter(
          (r) =>
            (r.kind === 'goal' || r.kind === 'task') &&
            (r.state === ShapeProposalState.Pending || r.state === ShapeProposalState.Accepted),
        )
        .map((r) => r.key),
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
