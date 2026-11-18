import {
  DecisionItem,
  KNOWLEDGE_PAGE_SIZE,
  KnowledgeListDto,
  KnowledgeListShelf,
  KnowledgeState,
  mintId,
  PAST_KNOWLEDGE_STATES,
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
    withdrawnBy: null,
    withdrawnReason: null,
    createdAt: AT,
    updatedAt: AT,
    ...overrides,
  });
}

/** The list answer for `GET /projects/:id/knowledge`: one page holding `items`. */
export function knowledgeList(
  items: KnowledgeListDto['items'] = [],
  overrides: Partial<KnowledgeListDto> = {},
): KnowledgeListDto {
  return KnowledgeListDto.parse({
    items,
    total: items.length,
    page: 1,
    pageSize: KNOWLEDGE_PAGE_SIZE,
    search: { available: true, message: null },
    ...overrides,
  });
}

/**
 * What the daemon answers a list request over `records`, in their order: the shelf's records (Past
 * holds the superseded, retired and withdrawn ones, Current the current ones), one page of them.
 */
export function knowledgePage(
  records: KnowledgeListDto['items'],
  params: URLSearchParams,
): KnowledgeListDto {
  const past = params.get('shelf') === KnowledgeListShelf.Past;
  const shelved = records.filter((r) =>
    past ? PAST_KNOWLEDGE_STATES.includes(r.state) : r.state === KnowledgeState.Current,
  );
  const pageSize = Number(params.get('pageSize') ?? KNOWLEDGE_PAGE_SIZE);
  const page = Number(params.get('page') ?? 1);
  return knowledgeList(shelved.slice((page - 1) * pageSize, page * pageSize), {
    total: shelved.length,
    page,
    pageSize,
  });
}
