import {
  GoalDigestDto,
  type DigestDeviation,
  type DigestWaitingOn,
  GoalDto,
  GoalListDto,
  GoalSummaryDto,
  mintId,
  type GoalStatus,
  type UngroupedDigestDto,
} from '@10db/contracts';
import { projectViewDto } from './fixtures';

const AT = '2026-10-13T12:00:00.000Z';

/** Schema-valid goal DTOs for UI tests; each is parsed, so a contract change breaks the fixture first. */
export function goalDto(overrides: Partial<GoalDto> = {}): GoalDto {
  return GoalDto.parse({
    id: mintId('Goal'),
    projectId: projectViewDto().id,
    title: 'Real areas',
    objective: 'Areas.',
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

export function goalDigestDto(overrides: Partial<GoalDigestDto> = {}): GoalDigestDto {
  return GoalDigestDto.parse({
    goalId: mintId('Goal'),
    status: 'running',
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

/** A goal and its digest as the list answers them; `newItems` defaults to the digest's recent items. */
export function goalSummaryDto(
  overrides: { goal?: Partial<GoalDto>; digest?: Partial<GoalDigestDto>; newItems?: number } = {},
): GoalSummaryDto {
  const goal = goalDto(overrides.goal);
  const digest = goalDigestDto({ goalId: goal.id, ...overrides.digest });
  const recent =
    digest.waitingOn.recent.length +
    digest.deviations.recent.length +
    digest.decisions.recent.length;
  return GoalSummaryDto.parse({ goal, digest, newItems: overrides.newItems ?? recent });
}

export function digestDeviation(summary: string, at: string): DigestDeviation {
  return { id: mintId('Deviation'), taskId: null, summary, at };
}

export function digestWaitingOn(title: string, at: string): DigestWaitingOn {
  return {
    inboxItemId: mintId('InboxItem'),
    taskId: mintId('Task'),
    title,
    assigneeId: null,
    assigneeName: 'You',
    at,
  };
}

export function goalListDto(
  goals: readonly GoalSummaryDto[] = [],
  ungrouped: UngroupedDigestDto | null = null,
): GoalListDto {
  return GoalListDto.parse({ goals, ungrouped });
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
