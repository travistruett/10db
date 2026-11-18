import {
  ConversationItemDto,
  mintId,
  ShapeDto,
  ShapeMessageDto,
  ShapeProposalDto,
  type ShapePreviewDto,
  ShapeViewDto,
  type ConversationId,
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
    model: null,
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
    id: mintId('ConversationItem'),
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

const SOURCE = mintId('ConversationItem');

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

/**
 * What each conversation's `/items` answers in a test, keyed by its id. `shapeViewDto` fills it from
 * the Plan rows a test gives, so the base handlers serve a view's transcript as the daemon does.
 */
const ITEMS = new Map<ConversationId, readonly ConversationItemDto[]>();

/** The items a test's conversation holds; none for one no fixture made. */
export const itemsOfConversation = (id: ConversationId): readonly ConversationItemDto[] =>
  ITEMS.get(id) ?? [];

/** Plan's row as the item the daemon stores it as (`transcript-kinds.ts`). */
function itemOfMessage(
  conversationId: ConversationId,
  m: ShapeMessageDto,
  seq: number,
): ConversationItemDto {
  const author = m.author === 'builder' ? 'builder' : m.author === 'claude' ? 'agent' : 'system';
  const common = {
    id: m.id,
    conversationId,
    seq,
    author,
    partial: false,
    hasFull: false,
    deliveredAt: m.createdAt,
    createdAt: m.createdAt,
  };
  switch (m.kind) {
    case 'text':
      return ConversationItemDto.parse({
        ...common,
        kind: m.author === 'builder' ? 'message' : 'agent_message',
        text: m.body,
      });
    case 'notice':
    case 'digest':
      return ConversationItemDto.parse({ ...common, kind: m.kind, text: m.body });
    case 'tool':
      return ConversationItemDto.parse({
        ...common,
        kind: 'tool_call',
        call: {
          kind: 'other',
          id: `plan-${m.id}`,
          harnessTool: '10db.plan',
          name: '10db.plan',
          status: 'done',
          title: m.body,
          inputPreview: m.body.slice(0, 200),
          startedAt: m.createdAt,
          durationMs: null,
          parentId: null,
          refusal: null,
          deniedBy: null,
          limit: null,
          soft: null,
        },
      });
    case 'propose':
    case 'rehearse':
    case 'edit':
    case 'event':
    case 'screen':
      return ConversationItemDto.parse({
        ...common,
        kind: 'shape_event',
        event: m.kind,
        text: m.body,
      });
  }
}

/**
 * A conversation's view. `messages` are Plan's rows as a test writes them: they become the items its
 * conversation serves, as the daemon stores them.
 */
export function shapeViewDto(
  overrides: Partial<ShapeViewDto> & {
    readonly shape?: Partial<ShapeDto>;
    readonly messages?: readonly ShapeMessageDto[];
    readonly items?: readonly ConversationItemDto[];
  } = {},
): ShapeViewDto {
  const { shape: shapeOverrides, messages = [], items, ...rest } = overrides;
  const shape = shapeDto(shapeOverrides);
  const view = ShapeViewDto.parse({
    shape,
    conversationId: mintId('Conversation'),
    models: {
      default: 'claude-opus-5-5',
      offered: [
        { model: 'claude-haiku-5-5', tier: 'efficient' },
        { model: 'claude-sonnet-5-5', tier: 'balanced' },
        { model: 'claude-opus-5-5', tier: 'capable' },
        { model: 'claude-fable-5-1', tier: 'frontier' },
        { model: 'house-model', tier: null },
      ],
    },
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
  ITEMS.set(
    view.conversationId,
    items ?? messages.map((m, i) => itemOfMessage(view.conversationId, m, i + 1)),
  );
  return view;
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
