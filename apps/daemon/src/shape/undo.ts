import {
  ConflictError,
  InvalidError,
  KnowledgeState,
  ShapeMessageAuthor,
  ShapeMessageKind,
  ShapeProposalBody,
  ShapeProposalState,
  ShapeState,
  TaskStartedError,
  TaskStatus,
  type DecisionId,
  type GoalId,
  type LandingGroupId,
  type PrincipleId,
  type ShapeAcceptId,
  type ShapeId,
  type ShapeQuestionId,
  type TaskId,
} from '@10db/contracts';
import {
  cancelNeverStartedTask,
  decisionSuccessor,
  deleteLandingGroupOf,
  deleteShapeLinksOf,
  getDecision,
  getGoal,
  getPrinciple,
  getShapeAccept,
  getTask,
  insertShapeMessage,
  latestShapeAccept,
  latestWorkstreamOf,
  leaveLandingGroup,
  listAcceptedProposals,
  listGoalTasks,
  listLandingGroupsOfAccept,
  listShapeLinks,
  markShapeAcceptUndone,
  patchShape,
  patchShapeProposal,
  pendingProposalOf,
  rekeyShapeAttachmentsToProposal,
  releaseShapeLinksOfGoal,
  revivingClash,
  releaseDetachedShapeQuestions,
  releaseShapeQuestion,
  removeDraftGoal,
  withdrawDecision,
  type DbReader,
  type ShapeLinkRow,
  type ShapeProposalRow,
  type WriteContext,
} from '@10db/db';
import { withdrawPrincipleRecord } from '../knowledge';

// Shape spec §11, Undo. Convert has no undo of its own beyond these four: Remove Draft Goal, Undo
// Accept, Withdraw Decision and Withdraw Principle.

/**
 * Remove Draft Goal: the goal this conversation made goes with its tasks, while every one is
 * unstarted, and its proposal is pending again so it can be edited and converted anew.
 */
export function removeDraftGoalOf(ctx: WriteContext, shapeId: ShapeId, goalId: GoalId): void {
  const links = listShapeLinks(ctx.tx, shapeId);
  const link = links.find((l) => l.goalId === goalId);
  if (link === undefined) throw new InvalidError(`${goalId} is not a goal this conversation made`);
  // A diagram attached by the goal's or a task's id is keyed by that id; the links still say which
  // row it belongs to, so key it by the row before they go. The goal's tasks include any added in a
  // later round, whose links sit under their own proposal rows rather than the goal's.
  const taskIds = new Set<TaskId | null>(listGoalTasks(ctx.tx, goalId).map((t) => t.id));
  rekeyShapeAttachmentsToProposal(
    ctx,
    links.filter((l) => l.goalId === goalId || taskIds.has(l.taskId)),
  );
  // A task removal leaves its question stored under no task, which the goal's removal cannot find by
  // id; the question's proposal names the task key, which only these links still say.
  releaseDetachedShapeQuestions(
    ctx,
    shapeId,
    links.filter((l) => l.taskId !== null && taskIds.has(l.taskId)).map((l) => l.key),
  );
  // The links name the goal, so they go first; a refusal below rolls the whole write back.
  deleteShapeLinksOf(ctx, link.proposalId);
  removeDraftGoal(ctx, goalId);
  patchShapeProposal(ctx, link.proposalId, {
    state: ShapeProposalState.Pending,
    acceptId: null,
  });
  patchShape(ctx, shapeId, { state: ShapeState.Proposed });
}

/**
 * Withdraw Decision: a decision this conversation wrote becomes a tombstone with the builder's
 * reason, and leaves searches and context packs. Only the head of a supersede chain can be withdrawn.
 */
export function withdrawConvertedDecision(
  ctx: WriteContext,
  shapeId: ShapeId,
  decisionId: DecisionId,
  reason: string,
): void {
  if (!listShapeLinks(ctx.tx, shapeId).some((l) => l.decisionId === decisionId))
    throw new InvalidError(`${decisionId} is not a decision this conversation wrote`);
  withdrawDecision(ctx, decisionId, { by: 'builder', reason });
}

/**
 * Withdraw Principle: a principle this conversation wrote becomes a tombstone with the builder's
 * reason, as the knowledge routes withdraw one, and leaves searches and context packs. A principle
 * a later one replaced cannot be withdrawn (409).
 */
export function withdrawConvertedPrinciple(
  ctx: WriteContext,
  shapeId: ShapeId,
  principleId: PrincipleId,
  reason: string,
): void {
  if (!listShapeLinks(ctx.tx, shapeId).some((l) => l.principleId === principleId))
    throw new InvalidError(`${principleId} is not a principle this conversation wrote`);
  withdrawPrincipleRecord(ctx, principleId, reason, undefined);
}

/** What Undo does with a record the Accept wrote: take it back, find it taken back, or leave it. */
type Fate = 'withdraw' | 'taken' | 'kept';

interface Reach {
  /** A goal proposal, with the additions to the goal that this Accept also made. */
  readonly goals: readonly {
    readonly proposal: ShapeProposalRow;
    readonly goalId: GoalId;
    readonly additions: readonly ShapeProposalRow[];
  }[];
  /** Loose tasks, and additions to a goal an earlier Accept made. */
  readonly tasks: readonly { readonly proposal: ShapeProposalRow; readonly taskId: TaskId }[];
  /** Every task linked under the goal and task proposals, cancelled ones included. */
  readonly taskIds: readonly TaskId[];
  /** The linked tasks that are not cancelled: the ones Undo cancels. */
  readonly liveTaskIds: readonly TaskId[];
  readonly decisions: readonly {
    readonly proposal: ShapeProposalRow;
    readonly id: DecisionId | null;
    readonly fate: Fate;
  }[];
  readonly principles: readonly {
    readonly proposal: ShapeProposalRow;
    readonly id: PrincipleId;
    readonly fate: Fate;
  }[];
  readonly questions: readonly {
    readonly proposal: ShapeProposalRow;
    readonly id: ShapeQuestionId;
  }[];
  readonly landings: readonly {
    readonly proposal: ShapeProposalRow;
    readonly groupId: LandingGroupId | null;
    readonly members: readonly TaskId[];
    /** The group holds a task this Undo does not cancel, so it stays. */
    readonly stays: boolean;
  }[];
  /** Proposals that stay accepted under the Accept: the rule that makes `kept`. */
  readonly kept: ReadonlySet<ShapeProposalRow['id']>;
  readonly links: readonly ShapeLinkRow[];
}

function decisionFate(db: DbReader, id: DecisionId): Fate {
  if (getDecision(db, id).withdrawnAt !== null) return 'taken';
  return decisionSuccessor(db, id) === null ? 'withdraw' : 'kept';
}

function principleFate(db: DbReader, id: PrincipleId): Fate {
  const principle = getPrinciple(db, id);
  if (principle.supersededById !== null) return 'kept';
  switch (principle.state) {
    case KnowledgeState.Withdrawn:
    case KnowledgeState.Retired:
      return 'taken';
    // Withdrawing it would bring its predecessor back beside another principle: Undo leaves it.
    case KnowledgeState.Current:
      return revivingClash(db, principle) === undefined ? 'withdraw' : 'kept';
    // A proposed principle is decided through its proposal, which Undo does not touch.
    case KnowledgeState.Proposed:
      return pendingProposalOf(db, id) === null ? 'withdraw' : 'kept';
    case KnowledgeState.Superseded:
      return 'kept';
  }
}

/**
 * Reads what an Accept wrote, from its proposals and their links only, and what Undo would do with
 * each piece. Undo and the view both read it, so the confirm's "N stay" and Undo's result agree.
 */
function acceptReach(db: DbReader, shapeId: ShapeId, acceptId: ShapeAcceptId): Reach {
  const proposals = listAcceptedProposals(db, acceptId);
  const links = listShapeLinks(db, shapeId);
  const under = (p: ShapeProposalRow): ShapeLinkRow[] => links.filter((l) => l.proposalId === p.id);
  const ofKind = (kind: ShapeProposalRow['kind']): ShapeProposalRow[] =>
    proposals.filter((p) => p.kind === kind);
  const kept = new Set<ShapeProposalRow['id']>();

  const goalLinks = ofKind('goal').flatMap((proposal) => {
    const goalId = under(proposal).find((l) => l.goalId !== null)?.goalId;
    return goalId === undefined || goalId === null ? [] : [{ proposal, goalId }];
  });
  const goalIds = new Set(goalLinks.map((g) => g.goalId));
  const additionsOf = new Map<GoalId, ShapeProposalRow[]>();
  const tasks: { proposal: ShapeProposalRow; taskId: TaskId }[] = [];
  for (const proposal of ofKind('task')) {
    const taskId = under(proposal).find((l) => l.taskId !== null)?.taskId;
    if (taskId === undefined || taskId === null) continue;
    const goalId = getTask(db, taskId).goalId ?? null;
    if (goalId !== null && goalIds.has(goalId))
      additionsOf.set(goalId, [...(additionsOf.get(goalId) ?? []), proposal]);
    else tasks.push({ proposal, taskId });
  }
  const goals = goalLinks.map((g) => ({ ...g, additions: additionsOf.get(g.goalId) ?? [] }));
  const taskIds = [
    ...new Set(
      [
        ...goals.map((g) => g.proposal),
        ...goals.flatMap((g) => g.additions),
        ...tasks.map((t) => t.proposal),
      ]
        .flatMap(under)
        .flatMap((l) => (l.taskId === null ? [] : [l.taskId])),
    ),
  ];
  const liveTaskIds = taskIds.filter((id) => getTask(db, id).status !== TaskStatus.Cancelled);

  const decisions = ofKind('decision').map((proposal) => {
    const id = under(proposal).find((l) => l.decisionId !== null)?.decisionId ?? null;
    // A decision for this effort only has no link: nothing was written beyond the proposal.
    const fate: Fate = id === null ? 'taken' : decisionFate(db, id);
    if (fate === 'kept') kept.add(proposal.id);
    return { proposal, id, fate };
  });
  const principles = ofKind('principle').flatMap((proposal) => {
    const id = under(proposal).find((l) => l.principleId !== null)?.principleId;
    if (id === undefined || id === null) return [];
    const fate = principleFate(db, id);
    if (fate === 'kept') kept.add(proposal.id);
    return [{ proposal, id, fate }];
  });
  const questions = ofKind('question').flatMap((proposal) => {
    const id = under(proposal).find((l) => l.questionId !== null)?.questionId;
    return id === undefined || id === null ? [] : [{ proposal, id }];
  });
  for (const p of [...ofKind('change_task'), ...ofKind('remove_task')]) kept.add(p.id);

  const groups = [...listLandingGroupsOfAccept(db, acceptId)];
  const made = new Set(taskIds);
  const landings = ofKind('landing').flatMap((proposal) => {
    const parsed = ShapeProposalBody.landing.safeParse(proposal.body);
    if (!parsed.success) return [];
    const title = parsed.data.title;
    const at = groups.findIndex((g) => g.title === title);
    const group = at < 0 ? undefined : groups.splice(at, 1)[0];
    const members = group?.members ?? [];
    const stays = members.some((id) => !made.has(id));
    if (stays) kept.add(proposal.id);
    return [{ proposal, groupId: group?.id ?? null, members, stays }];
  });
  return {
    goals,
    tasks,
    taskIds,
    liveTaskIds,
    decisions,
    principles,
    questions,
    landings,
    kept,
    links,
  };
}

/** What Undoing the Accept would take back, for the confirm; the same reading Undo acts on. */
export function acceptPreview(
  db: DbReader,
  shapeId: ShapeId,
  acceptId: ShapeAcceptId,
): {
  readonly goals: number;
  readonly tasks: number;
  readonly records: number;
  readonly kept: number;
  readonly taskIds: TaskId[];
} {
  const reach = acceptReach(db, shapeId, acceptId);
  const records = [...reach.decisions, ...reach.principles].filter((r) => r.fate === 'withdraw');
  return {
    goals: reach.goals.length,
    tasks: reach.liveTaskIds.length,
    records: records.length,
    kept: reach.kept.size,
    taskIds: [...reach.taskIds],
  };
}

export interface UndoneAccept {
  readonly goals: number;
  readonly tasks: number;
  readonly decisions: number;
  readonly principles: number;
  readonly questions: number;
  /** What this Accept wrote that Undo leaves: changes and removals of Board tasks, a decision superseded or a
   *  principle replaced since, a landing group holding a task with a run or one it didn't make. */
  readonly kept: number;
}

const STARTED = 'has started; cancel its run and remove it from the Board first';

/** The store's own refusals, in the words Undo Accept gives; each stays a 409. */
function rewrapped(error: unknown): unknown {
  if (error instanceof TaskStartedError) {
    const title = /^Task (.+?) (?:has started|has already run|is finished)/.exec(
      error.message,
    )?.[1];
    return new ConflictError(`${title ?? 'A task'} ${STARTED}`);
  }
  if (error instanceof ConflictError && /^Batch ".*" is being cut/.test(error.message))
    return new ConflictError('A batch is being cut; try Undo Accept again once it has started');
  return error;
}

/**
 * Undo Accept: takes back exactly what one Accept wrote, read from its proposals and their links,
 * in the caller's one write. It cancels no run and leaves no branch, batch or worktree: any task of
 * it with a workstream row refuses the whole Undo before anything is written.
 */
export function undoAccept(
  ctx: WriteContext,
  shapeId: ShapeId,
  acceptId: ShapeAcceptId,
): UndoneAccept {
  const accept = getShapeAccept(ctx.tx, shapeId, acceptId);
  if (accept === undefined) throw new InvalidError(`${acceptId} is not an Accept of this plan`);
  if (accept.undoneAt !== null) throw new InvalidError('This Accept was undone');
  if (latestShapeAccept(ctx.tx, shapeId)?.id !== acceptId)
    throw new InvalidError('Undo the later Accept first');
  const reach = acceptReach(ctx.tx, shapeId, acceptId);

  for (const id of reach.liveTaskIds) {
    const task = getTask(ctx.tx, id);
    if (task.status !== TaskStatus.Open || latestWorkstreamOf(ctx.tx, id) !== undefined)
      throw new ConflictError(`${task.title} ${STARTED}`);
  }
  const made = new Set(reach.taskIds);
  for (const { goalId } of reach.goals)
    for (const task of listGoalTasks(ctx.tx, goalId))
      if (task.status !== TaskStatus.Cancelled && !made.has(task.id))
        throw new ConflictError(
          `${getGoal(ctx.tx, goalId).title} holds ${task.title}, which this Accept didn't make`,
        );

  try {
    // Attachments, questions and links come off first, while every task is still open: cancelling
    // a task detaches the questions stored under it.
    const allLinks = listShapeLinks(ctx.tx, shapeId);
    for (const { goalId, proposal } of reach.goals) {
      const goalTasks = listGoalTasks(ctx.tx, goalId).map((t) => t.id);
      const inGoal = allLinks.filter(
        (l) =>
          l.goalId === goalId ||
          l.proposalId === proposal.id ||
          (l.taskId !== null && goalTasks.includes(l.taskId)),
      );
      rekeyShapeAttachmentsToProposal(ctx, inGoal);
      releaseDetachedShapeQuestions(
        ctx,
        shapeId,
        inGoal.filter((l) => l.taskId !== null).map((l) => l.key),
      );
      releaseShapeLinksOfGoal(ctx, goalId, goalTasks);
      deleteShapeLinksOf(ctx, proposal.id);
    }
    for (const { proposal } of reach.tasks)
      rekeyShapeAttachmentsToProposal(
        ctx,
        reach.links.filter((l) => l.proposalId === proposal.id),
      );
    // Then every task this Accept made, in an order no remaining one waits on: tasks of a goal and
    // loose tasks wait on each other across goals, so the order is by task, not by goal.
    const waitsOn = new Map(
      reach.liveTaskIds.map((id) => [id, getTask(ctx.tx, id).dependsOn] as const),
    );
    for (let remaining = [...reach.liveTaskIds]; remaining.length > 0;) {
      const leaves = remaining.filter(
        (id) => !remaining.some((other) => waitsOn.get(other)?.includes(id)),
      );
      if (leaves.length === 0)
        throw new ConflictError(
          'Tasks of this Accept wait on each other, so Undo cannot order them',
        );
      for (const id of leaves) cancelNeverStartedTask(ctx, id);
      remaining = remaining.filter((id) => !leaves.includes(id));
    }
    for (const { proposal } of [
      ...reach.goals.flatMap((g) => g.additions.map((proposal) => ({ proposal }))),
      ...reach.tasks,
    ])
      deleteShapeLinksOf(ctx, proposal.id);
    for (const { goalId } of reach.goals) removeDraftGoal(ctx, goalId);
  } catch (error) {
    throw rewrapped(error);
  }

  for (const { id, fate } of reach.decisions) {
    if (fate === 'withdraw' && id !== null)
      withdrawDecision(ctx, id, { by: 'builder', reason: 'Undo Accept' });
  }
  for (const { id, fate } of reach.principles) {
    if (fate === 'withdraw') withdrawPrincipleRecord(ctx, id, 'Undo Accept', undefined);
  }
  for (const { proposal, fate } of [...reach.decisions, ...reach.principles])
    if (fate !== 'kept') deleteShapeLinksOf(ctx, proposal.id);
  for (const { id } of reach.questions) releaseShapeQuestion(ctx, id);
  for (const landing of reach.landings) {
    if (landing.groupId === null) continue;
    if (!landing.stays) deleteLandingGroupOf(ctx, landing.groupId);
    else for (const id of landing.members) if (made.has(id)) leaveLandingGroup(ctx, id);
  }

  const taken = (n: number, one: string, many: string): string =>
    `${String(n)} ${n === 1 ? one : many}`;
  const result: UndoneAccept = {
    goals: reach.goals.length,
    tasks: reach.liveTaskIds.length,
    decisions: reach.decisions.filter((d) => d.fate === 'withdraw' && d.id !== null).length,
    principles: reach.principles.filter((p) => p.fate === 'withdraw').length,
    questions: reach.questions.length,
    kept: reach.kept.size,
  };
  for (const proposal of listAcceptedProposals(ctx.tx, acceptId))
    if (!reach.kept.has(proposal.id))
      patchShapeProposal(ctx, proposal.id, { state: ShapeProposalState.Pending, acceptId: null });
  patchShape(ctx, shapeId, { state: ShapeState.Proposed });
  markShapeAcceptUndone(ctx, acceptId);
  const parts = [
    ...(result.goals > 0 ? [taken(result.goals, 'goal', 'goals')] : []),
    ...(result.tasks > 0 ? [taken(result.tasks, 'task', 'tasks')] : []),
  ];
  const withdrew = [
    ...(result.decisions > 0 ? [taken(result.decisions, 'decision', 'decisions')] : []),
    ...(result.principles > 0 ? [taken(result.principles, 'principle', 'principles')] : []),
  ];
  const body = [
    `Undid Accept${parts.length > 0 ? `: ${parts.join(', ')}` : ''}`,
    ...(withdrew.length > 0 ? [`withdrew ${withdrew.join(' and ')}`] : []),
    ...(result.kept > 0 ? [`${String(result.kept)} stay${result.kept === 1 ? 's' : ''}`] : []),
  ].join('; ');
  insertShapeMessage(ctx, shapeId, {
    author: ShapeMessageAuthor.Note,
    kind: ShapeMessageKind.Event,
    body,
  });
  return result;
}
