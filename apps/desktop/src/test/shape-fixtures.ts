import {
  mintId,
  ShapeFindingDto,
  ShapeDto,
  ShapeMessageDto,
  ShapePreviewDto,
  ShapeProposalDto,
  ShapeViewDto,
  type ShapeId,
} from '@10db/contracts';

const AT = '2026-11-02T12:00:00.000Z';

/** Schema-valid Shape DTOs for UI tests; each is parsed, so a contract change breaks the fixture first. */
export function shapeDto(overrides: Partial<ShapeDto> = {}): ShapeDto {
  return ShapeDto.parse({
    id: mintId('Shape'),
    projectId: mintId('Project'),
    title: 'Board polish',
    state: 'listening',
    origin: 'app',
    proposeUnlocked: false,
    round: 0,
    createdAt: AT,
    updatedAt: AT,
    ...overrides,
  });
}

export function shapeMessageDto(
  shapeId: ShapeId,
  overrides: Partial<ShapeMessageDto> = {},
): ShapeMessageDto {
  return ShapeMessageDto.parse({
    id: mintId('ShapeMessage'),
    shapeId,
    author: 'builder',
    kind: 'text',
    body: 'Move density ahead of the scrollbars.',
    createdAt: AT,
    ...overrides,
  });
}

interface ProposalOverrides {
  readonly state?: ShapeProposalDto['state'];
  readonly round?: number;
  readonly converted?: ShapeProposalDto['converted'];
  readonly pinned?: string[];
  readonly mark?: ShapeProposalDto['mark'];
  readonly sourceMessageIds?: ShapeProposalDto['sourceMessageIds'];
}

const SOURCE = mintId('ShapeMessage');

const proposalBase = (overrides: ProposalOverrides) => ({
  id: mintId('ShapeProposal'),
  state: overrides.state ?? 'pending',
  round: overrides.round ?? 1,
  pinned: overrides.pinned ?? [],
  mark: overrides.mark ?? null,
  sourceMessageIds: overrides.sourceMessageIds ?? [SOURCE],
  converted: overrides.converted ?? null,
  createdAt: AT,
  updatedAt: AT,
});

/** A pending goal with `taskKeys.length` tasks. */
export function goalProposal(
  key: string,
  taskKeys: readonly string[] = ['first-task'],
  overrides: ProposalOverrides & { readonly title?: string } = {},
): ShapeProposalDto {
  return ShapeProposalDto.parse({
    ...proposalBase(overrides),
    key,
    kind: 'goal',
    body: {
      key,
      title: overrides.title ?? 'Brainstorm chat in 10db',
      objective: 'Brainstorm, size and file work without leaving 10db.',
      criteria: [{ text: 'The builder accepts the sidebar', check: 'accept' }],
      ceremony: 'direct',
      sourceMessageIds: [SOURCE],
      tasks: taskKeys.map((taskKey) => ({
        key: taskKey,
        title: `Task ${taskKey}`,
        areas: ['desktop'],
        size: 'M',
      })),
    },
  });
}

export function looseTaskProposal(
  key: string,
  overrides: ProposalOverrides & { readonly title?: string; readonly goalId?: string } = {},
): ShapeProposalDto {
  return ShapeProposalDto.parse({
    ...proposalBase(overrides),
    key,
    kind: 'task',
    body: {
      key,
      title: overrides.title ?? `Task ${key}`,
      criteria: ['It works'],
      areas: ['desktop'],
      size: 'S',
      ceremony: 'direct',
      sourceMessageIds: [SOURCE],
      ...(overrides.goalId === undefined ? {} : { goalId: overrides.goalId }),
    },
  });
}

export function decisionProposal(
  key: string,
  overrides: ProposalOverrides & { readonly choice?: string } = {},
): ShapeProposalDto {
  return ShapeProposalDto.parse({
    ...proposalBase(overrides),
    key,
    kind: 'decision',
    body: {
      key,
      kind: 'decision',
      scope: 'project',
      question: 'What replaces Adopt a Plan?',
      choice: overrides.choice ?? 'The chat replaces Adopt',
      rationale: 'The builder finds Adopt too thin.',
      sourceMessageIds: [SOURCE],
    },
  });
}

export function principleProposal(
  key: string,
  overrides: ProposalOverrides & { readonly statement?: string } = {},
): ShapeProposalDto {
  return ShapeProposalDto.parse({
    ...proposalBase(overrides),
    key,
    kind: 'principle',
    body: {
      key,
      kind: 'principle',
      scope: 'project',
      statement: overrides.statement ?? 'Never mock the database',
      rationale: 'Mocks hid a broken migration once.',
      sourceMessageIds: [SOURCE],
    },
  });
}

export function questionProposal(key: string, text = 'When should this ship?'): ShapeProposalDto {
  return ShapeProposalDto.parse({
    ...proposalBase({}),
    key,
    kind: 'question',
    body: { key, text, for: 'designer', sourceMessageIds: [SOURCE] },
  });
}

export function landingProposal(key: string, keys: readonly string[]): ShapeProposalDto {
  return ShapeProposalDto.parse({
    ...proposalBase({}),
    key,
    kind: 'landing',
    body: { key, title: 'Real areas', keys, sourceMessageIds: [SOURCE] },
  });
}

export function shapeViewDto(
  overrides: Partial<ShapeViewDto> & { readonly shape?: Partial<ShapeDto> } = {},
): ShapeViewDto {
  const { shape: shapeOverrides, ...rest } = overrides;
  const shape = shapeDto(shapeOverrides);
  return ShapeViewDto.parse({
    shape,
    messages: [],
    proposals: [],
    heard: [],
    files: [],
    turn: {
      running: false,
      queued: 0,
      proposing: false,
      rehearsing: false,
      waitingForUpdate: false,
    },
    sizes: [],
    ceremony: [],
    findings: [],
    rehearsals: [],
    preview: EMPTY_PREVIEW,
    attachments: [],
    tokens: 0,
    ...rest,
  });
}

/** A preview with nothing placed: no pending task, nothing running. */
export const EMPTY_PREVIEW: ShapePreviewDto = {
  lanes: [],
  criticalPath: [],
  clashes: [],
  tasks: 0,
  totalLaneHours: 0,
  scheduleHours: 0,
  nonLaneHoursPerTask: null,
  endEstimateHours: 0,
  landings: { pullRequests: 0, pullRequestsAlone: 0, ciRuns: 0, ciRunsAlone: 0 },
};

/**
 * Two lanes: a task already running holds lane 1 first, the draft's two tasks clash on `desktop` and
 * run one after the other behind it, the critical path; a third draft task runs beside them.
 */
export function previewDto(): ShapePreviewDto {
  return ShapePreviewDto.parse({
    lanes: [
      {
        items: [
          {
            key: 'tsk_running',
            title: 'Fix the gate log',
            startHours: 0,
            endHours: 1.5,
            existing: true,
            critical: true,
          },
          {
            key: 'density',
            title: 'Compact density',
            startHours: 1.5,
            endHours: 3.5,
            existing: false,
            critical: true,
          },
          {
            key: 'shape-view',
            title: 'Shape view',
            startHours: 3.5,
            endHours: 5,
            existing: false,
            critical: true,
          },
        ],
      },
      {
        items: [
          {
            key: 'scrollbars',
            title: 'Thin scrollbars',
            startHours: 0,
            endHours: 1,
            existing: false,
            critical: false,
          },
        ],
      },
    ],
    criticalPath: ['tsk_running', 'density', 'shape-view'],
    clashes: [
      {
        area: 'desktop',
        titles: ['Compact density', 'Shape view'],
        text: "Compact density and Shape view both claim `desktop`: they'll run one after the other",
      },
    ],
    tasks: 3,
    totalLaneHours: 4.5,
    scheduleHours: 5,
    nonLaneHoursPerTask: 2,
    endEstimateHours: 9,
    landings: { pullRequests: 3, pullRequestsAlone: 3, ciRuns: 3, ciRunsAlone: 3 },
  });
}

/** A reviewer's finding or a rehearsal question, open unless the override says otherwise. */
export function findingDto(
  shapeId: ShapeId,
  overrides: Partial<ShapeFindingDto> = {},
): ShapeFindingDto {
  return ShapeFindingDto.parse({
    id: mintId('ShapeFinding'),
    shapeId,
    effortKey: 'brainstorm',
    taskKey: null,
    reviewer: 'scope',
    kind: 'finding',
    severity: 'medium',
    text: 'Names no migration',
    state: 'open',
    how: null,
    round: 1,
    taskHash: null,
    createdAt: AT,
    updatedAt: AT,
    ...overrides,
  });
}
