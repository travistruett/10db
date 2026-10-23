import {
  BoardColumnDto,
  DaemonEvent,
  InboxItemDto,
  mintId,
  ProjectDto,
  TaskDto,
  WorkstreamDto,
} from '@10db/contracts';

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
    areas: [{ name: 'src', globs: ['src/**'] }],
    hazards: [],
    maxLanes: 2,
    provider: 'claude',
    billingMode: 'subscription',
    model: 'sonnet',
    effort: 'medium',
    handoffPct: 40,
    nudgePct: 50,
    humanWaitMinutes: 10,
    flowId: null,
    budgetCeiling: null,
    delivery: 'local',
    baseBranch: 'main',
    prTitlePrefix: null,
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
