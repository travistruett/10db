import {
  DecisionItem,
  KnowledgeListDto,
  mintId,
  PrincipleItem,
  ProposalDto,
  ProvenanceDto,
} from '@10db/contracts';

const AT = '2026-10-13T12:00:00.000Z';

/** Schema-valid knowledge DTOs for UI tests; each is parsed, so a contract change breaks the fixture first. */
export function decisionItem(overrides: Partial<DecisionItem> = {}): DecisionItem {
  return DecisionItem.parse({
    kind: 'decision',
    id: mintId('Decision'),
    projectId: mintId('Project'),
    scope: 'project',
    area: null,
    question: 'Which queue library?',
    choice: 'BullMQ',
    rationale: 'Redis is already deployed',
    decidedBy: 'me',
    supersedesId: null,
    supersededById: null,
    state: 'current',
    sourceId: mintId('Source'),
    withdrawnAt: null,
    withdrawnReason: null,
    createdAt: AT,
    updatedAt: AT,
    ...overrides,
  });
}

export function principleItem(overrides: Partial<PrincipleItem> = {}): PrincipleItem {
  return PrincipleItem.parse({
    kind: 'principle',
    id: mintId('Principle'),
    projectId: mintId('Project'),
    scope: 'project',
    area: null,
    statement: 'Never sleep in tests',
    rationale: null,
    principleKind: 'policy',
    topicKey: 'testing.no-sleeps',
    status: 'confirmed',
    state: 'current',
    supersedesId: null,
    supersededById: null,
    sourceId: mintId('Source'),
    sourceQuote: null,
    speaker: 'me',
    confirmedBy: 'me',
    confirmedAt: AT,
    retiredAt: null,
    retiredReason: null,
    withdrawnAt: null,
    withdrawnReason: null,
    createdAt: AT,
    updatedAt: AT,
    ...overrides,
  });
}

/** The list answer for `GET /projects/:id/knowledge`. */
export function knowledgeList(
  items: KnowledgeListDto['items'] = [],
  overrides: Partial<KnowledgeListDto> = {},
): KnowledgeListDto {
  return KnowledgeListDto.parse({
    items,
    truncated: false,
    search: { available: true, message: null },
    ...overrides,
  });
}

export function proposalDto(overrides: Partial<ProposalDto> = {}): ProposalDto {
  const proposed = principleItem({
    statement: 'Never sleep in tests',
    status: 'proposed',
    state: 'proposed',
    confirmedBy: null,
    confirmedAt: null,
    speaker: 'agent:ses_x',
  });
  return ProposalDto.parse({
    id: mintId('Proposal'),
    projectId: mintId('Project'),
    kind: 'principle',
    title: 'No sleeps in tests',
    body: 'Two flaky runs came from sleeps.',
    status: 'pending',
    rationale: null,
    // The item's own `kind` says "principle"; the DTO's `kind` is the principle's (policy, …).
    principle: { ...proposed, kind: proposed.principleKind },
    sourceId: mintId('Source'),
    createdAt: AT,
    updatedAt: AT,
    ...overrides,
  });
}

export function provenanceDto(overrides: Partial<ProvenanceDto> = {}): ProvenanceDto {
  return ProvenanceDto.parse({
    id: mintId('Principle'),
    kind: 'principle',
    text: 'Never sleep in tests',
    state: 'current',
    sourceKind: 'builder',
    sourceRef: {},
    origin: null,
    recordedAt: AT,
    by: 'me',
    supersedes: null,
    supersededBy: null,
    supersedesText: null,
    supersededByText: null,
    retired: null,
    withdrawn: null,
    inbox: null,
    session: null,
    quote: null,
    speaker: null,
    confirmedBy: null,
    confirmedAt: null,
    confirmedSource: null,
    ...overrides,
  });
}
