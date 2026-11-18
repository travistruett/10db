import {
  GoalDigestDto,
  GoalDto,
  GoalListDto,
  GoalSummaryDto,
  mintId,
  type GoalId,
  type GoalStatus,
  type UngroupedDigestDto,
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

export function goalDigestDto(
  goalId: GoalId,
  overrides: Partial<GoalDigestDto> = {},
): GoalDigestDto {
  return GoalDigestDto.parse({
    goalId,
    status: 'not_started',
    since: null,
    progress: { merged: 0, inReview: 0, total: 3, cancelled: [] },
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
  return GoalSummaryDto.parse({ goal: dto, digest: goalDigestDto(dto.id, digest), newItems });
}

export function goalListDto(...goals: GoalSummaryDto[]): GoalListDto {
  return GoalListDto.parse({ goals, ungrouped: null });
}

export function ungroupedDto(
  overrides: Partial<UngroupedDigestDto> & { status?: GoalStatus } = {},
): UngroupedDigestDto {
  return {
    goalId: null,
    status: 'running',
    running: 1,
    failed: 0,
    workstreams: [],
    ...overrides,
  };
}
