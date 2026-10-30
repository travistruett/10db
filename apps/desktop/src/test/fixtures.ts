import {
  BatchDto,
  BoardColumnDto,
  DaemonEvent,
  FlowDto,
  InboxItemDto,
  mintId,
  PickerCandidate,
  ProjectDto,
  ProjectViewDto,
  TaskDto,
  WorkstreamDto,
  WorkstreamStep,
} from '@10db/contracts';
import { DEFAULT_ACCOUNT } from './account-fixtures';

const AT = '2026-10-13T12:00:00.000Z';

/**
 * Schema-valid DTOs for UI tests; each is parsed, so a contract change breaks the fixture first.
 */
export function projectDto(overrides: Partial<ProjectDto> = {}): ProjectDto {
  return ProjectDto.parse({
    id: mintId('Project'),
    name: 'Demo',
    repoPath: '/tmp/demo',
    gateCommand: 'true',
    changedCheckCommand: null,
    areas: [{ name: 'src', globs: ['src/**'] }],
    hazards: [],
    maxLanes: 2,
    provider: 'claude',
    accountId: DEFAULT_ACCOUNT.id,
    movedFromAccountId: null,
    moveBackAt: null,
    fallbackAccountId: null,
    usageHandoffAt: 0.95,
    handoffPct: 40,
    nudgePct: 50,
    humanWaitMinutes: 10,
    flowId: null,
    budgetCeiling: null,
    delivery: 'local',
    baseBranch: 'main',
    landing: 'merge',
    prTitlePrefix: null,
    allowedCommands: [],
    sandboxLoopback: false,
    workspaceMode: 'shared',
    worktreeSeed: ['node_modules'],
    createdAt: AT,
    updatedAt: AT,
    ...overrides,
  });
}

export function projectViewDto(overrides: Partial<ProjectViewDto> = {}): ProjectViewDto {
  return ProjectViewDto.parse({ ...projectDto(), currentBatch: null, ...overrides });
}

export function batchDto(overrides: Partial<BatchDto> = {}): BatchDto {
  return BatchDto.parse({
    id: mintId('Batch'),
    projectId: mintId('Project'),
    title: 'Greetings',
    state: 'OPEN',
    branch: '10db/greetings-0a1b2c3d',
    baseBranch: 'main',
    autoMerge: true,
    baseSha: 'a'.repeat(40),
    repo: 'acme/widgets',
    prUrl: null,
    gateExitCode: null,
    gateLogPath: null,
    failure: null,
    worktreePath: null,
    createdAt: AT,
    updatedAt: AT,
    ...overrides,
  });
}

export function boardColumnDto(overrides: Partial<BoardColumnDto> = {}): BoardColumnDto {
  return BoardColumnDto.parse({
    id: mintId('BoardColumn'),
    projectId: mintId('Project'),
    name: 'Icebox',
    position: 0,
    createdAt: AT,
    updatedAt: AT,
    ...overrides,
  });
}

export function taskDto(overrides: Partial<TaskDto> = {}): TaskDto {
  return TaskDto.parse({
    id: mintId('Task'),
    projectId: mintId('Project'),
    title: 'Write the greeting',
    description: '',
    acceptanceCriteria: ['src/greeting/hello.txt exists'],
    areas: ['src'],
    riskTags: [],
    flowId: null,
    landing: { kind: 'base' },
    status: 'open',
    boardOrder: 1,
    boardColumnId: null,
    dependsOn: [],
    boardStatus: 'ready',
    workstreamId: null,
    createdAt: AT,
    updatedAt: AT,
    ...overrides,
  });
}

export function workstreamDto(overrides: Partial<WorkstreamDto> = {}): WorkstreamDto {
  return WorkstreamDto.parse({
    id: mintId('Workstream'),
    taskId: mintId('Task'),
    projectId: mintId('Project'),
    batchId: null,
    taskTitle: 'Write the greeting',
    state: 'RUNNING',
    nextAction: { kind: 'start' },
    attempt: 0,
    recoveryAttempts: 0,
    model: 'sonnet',
    effort: 'medium',
    steps: [],
    stepIndex: 0,
    currentSessionId: null,
    sessionCount: 1,
    contextPct: 42,
    pausedUntil: null,
    failureReason: null,
    lastActivityAt: AT,
    runNextAt: null,
    createdAt: AT,
    updatedAt: AT,
    ...overrides,
  });
}

export function inboxItemDto(overrides: Partial<InboxItemDto> = {}): InboxItemDto {
  return InboxItemDto.parse({
    id: mintId('InboxItem'),
    projectId: mintId('Project'),
    kind: 'question',
    state: 'OPEN',
    title: 'Which greeting?',
    body: 'Greeting',
    options: [
      { label: 'Hello', description: '' },
      { label: 'Howdy', description: '' },
    ],
    recommendation: null,
    category: 'other',
    urgency: 'normal',
    assignee: 'me',
    detail: null,
    answer: null,
    targets: [],
    createdAt: AT,
    updatedAt: AT,
    ...overrides,
  });
}

export function daemonEvent(overrides: Partial<DaemonEvent> = {}): DaemonEvent {
  return DaemonEvent.parse({
    seq: 1,
    type: 'project.created',
    entityType: 'project',
    entityId: mintId('Project'),
    data: {},
    at: AT,
    ...overrides,
  });
}

export function stepDto(overrides: Partial<WorkstreamStep> = {}): WorkstreamStep {
  return WorkstreamStep.parse({
    role: 'implement',
    personaId: null,
    personaName: 'Implementer',
    tools: 'edit',
    score: 'coding',
    profileId: null,
    model: 'sonnet',
    effort: 'high',
    need: 40,
    reason: 'cheapest profile at or above 40 coding',
    overBudget: false,
    pinned: false,
    status: 'pending',
    attempts: 0,
    startedAt: null,
    sessionFloor: 0,
    result: null,
    earlier: [],
    sentBack: 0,
    ...overrides,
  });
}

/** A picker candidate for `task`: proposed, claiming its areas, on the standard flow. */
export function candidate(
  task: TaskDto,
  overrides: Partial<PickerCandidate> = {},
): PickerCandidate {
  return PickerCandidate.parse({
    task,
    proposed: true,
    resumed: false,
    unblocks: 0,
    claims: task.areas.map((name) => ({ kind: 'area', name })),
    conflict: null,
    plan: {
      flowName: 'standard',
      steps: [
        stepDto(),
        stepDto({
          role: 'review',
          personaName: 'Reviewer',
          tools: 'read_only',
          score: 'intelligence',
        }),
      ],
      overBudget: [],
    },
    planError: null,
    ...overrides,
  });
}

export function flowDto(overrides: Partial<FlowDto> = {}): FlowDto {
  return FlowDto.parse({
    id: mintId('Flow'),
    name: 'quick',
    steps: [{ role: 'implement', need: 40, skip: [], persona: null }],
    createdAt: AT,
    updatedAt: AT,
    ...overrides,
  });
}
