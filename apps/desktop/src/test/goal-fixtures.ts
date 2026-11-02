import {
  GoalDigestDto,
  GoalDto,
  GoalListDto,
  GoalSummaryDto,
  mintId,
  type GoalCriterionDto,
  type GoalId,
} from '@10db/contracts';

const AT = '2026-10-13T12:00:00.000Z';

/** Schema-valid goal DTOs for UI tests; each is parsed, so a contract change breaks the fixture first. */
export function goalDto(overrides: Partial<GoalDto> = {}): GoalDto {
  return GoalDto.parse({
    id: mintId('Goal'),
    projectId: mintId('Project'),
    title: 'Ship the importer',
    objective: 'Importing a CSV works end to end.',
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

function digestFor(goalId: GoalId, overrides: Partial<GoalDigestDto>): GoalDigestDto {
  return GoalDigestDto.parse({
    goalId,
    status: 'not_started',
    since: null,
    progress: { done: 0, total: 3, cancelled: [] },
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

export function goalSummaryDto(
  goal: Partial<GoalDto> = {},
  digest: Partial<GoalDigestDto> = {},
  newItems = 0,
): GoalSummaryDto {
  const dto = goalDto(goal);
  return GoalSummaryDto.parse({ goal: dto, digest: digestFor(dto.id, digest), newItems });
}

export function goalListDto(...goals: GoalSummaryDto[]): GoalListDto {
  return GoalListDto.parse({ goals, ungrouped: null });
}
