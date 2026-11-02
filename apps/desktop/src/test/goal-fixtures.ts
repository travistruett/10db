import {
  GoalDigestDto,
  GoalDto,
  GoalListDto,
  GoalSummaryDto,
  mintId,
  type GoalCriterionDto,
  type GoalId,
  type PersonId,
  type ProjectId,
  type TaskId,
} from '@10db/contracts';

const AT = '2026-10-31T12:00:00.000Z';

function goalDto(overrides: Partial<GoalDto> = {}): GoalDto {
  return GoalDto.parse({
    id: mintId('Goal'),
    projectId: mintId('Project'),
    title: 'Ship the greeting',
    objective: 'Every visitor is greeted by name.',
    caresMost: null,
    description: '',
    ownerId: mintId('Person'),
    state: 'draft',
    budget: null,
    criteria: [],
    taskIds: [],
    createdAt: AT,
    updatedAt: AT,
    ...overrides,
  });
}

export function goalCriterionDto(
  goalId: GoalId,
  overrides: Partial<GoalCriterionDto> = {},
): GoalCriterionDto {
  return {
    id: mintId('GoalCriterion'),
    goalId,
    text: 'The greeting names the visitor',
    check: 'accept',
    taskId: null,
    command: null,
    commandApproved: false,
    personId: null,
    state: 'unproven',
    proof: [],
    provenAt: null,
    provenBy: null,
    ...overrides,
  };
}

function goalDigestDto(goalId: GoalId, overrides: Partial<GoalDigestDto> = {}): GoalDigestDto {
  return GoalDigestDto.parse({
    goalId,
    status: 'not_started',
    since: null,
    progress: { done: 0, total: 0, cancelled: [] },
    openPullRequests: 0,
    workingNow: [],
    team: [],
    waitingOn: { recent: [], earlier: [] },
    next: null,
    deviations: { recent: [], earlier: [] },
    decisions: { recent: [], earlier: [] },
    cost: { tokens: 0, dollars: null, sessions: 0 },
    ungrouped: null,
    ...overrides,
  });
}

/** A goal with its digest: `taskIds` are the goal's, `done` how many of them are finished. */
export function goalSummaryDto(
  input: {
    readonly goal?: Partial<GoalDto>;
    readonly digest?: Partial<GoalDigestDto>;
    readonly projectId?: ProjectId;
    readonly taskIds?: readonly TaskId[];
    readonly owner?: PersonId;
  } = {},
): GoalSummaryDto {
  const goal = goalDto({
    ...(input.projectId ? { projectId: input.projectId } : {}),
    ...(input.taskIds ? { taskIds: [...input.taskIds] } : {}),
    ...(input.owner ? { ownerId: input.owner } : {}),
    ...input.goal,
  });
  return GoalSummaryDto.parse({
    goal,
    digest: goalDigestDto(goal.id, {
      progress: { done: 0, total: goal.taskIds.length, cancelled: [] },
      ...input.digest,
    }),
    newItems: 0,
  });
}

export function goalListDto(goals: readonly GoalSummaryDto[] = []): GoalListDto {
  return GoalListDto.parse({ goals, ungrouped: null });
}
