import {
  mintId,
  ShapeDto,
  ShapeMessageDto,
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
    turn: { running: false, queued: 0, proposing: false },
    sizes: [],
    ...rest,
  });
}
