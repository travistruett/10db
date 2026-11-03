import {
  InvalidError,
  KnowledgeScope,
  PrincipleKind,
  PrincipleStatus,
  SourceKind,
  targetColumns,
  topicKeyFrom,
  type DecisionEdit,
  type DecisionItem,
  type DecisionWrite,
  type KnowledgeItemDto,
  type KnowledgeListDto,
  type KnowledgeListQuery,
  type KnowledgeSearchState,
  type KnowledgeSource,
  type KnowledgeTarget,
  type PrincipleEdit,
  type PrincipleItem,
  type PrincipleWrite,
  type ProjectId,
  type SourceId,
  type DecisionId,
  type PrincipleId,
} from '@10db/contracts';
import {
  BUILDER_HANDLE,
  getDecisionDto,
  getPrinciple,
  getProject,
  insertDecision,
  insertPrinciple,
  insertSource,
  listDecisions,
  listPrinciples,
  searchDecisionIds,
  searchPrincipleIds,
  supersedeDecision,
  supersedePrinciple,
  type DbReader,
  type WriteContext,
} from '@10db/db';
import { decisionItem, principleItem } from './items';
import { checkTarget } from './targets';

/** The builder source a write names, or a bare one when it names none. */
function sourceFor(ctx: WriteContext, source: KnowledgeSource | undefined): SourceId {
  const ref: Record<string, string> = {};
  if (source !== undefined) {
    ref['via'] = source.via;
    if (source.sessionId !== undefined) ref['sessionId'] = source.sessionId;
    if (source.cwd !== undefined) ref['cwd'] = source.cwd;
    if (source.quote !== undefined) ref['quote'] = source.quote;
  }
  return insertSource(ctx, SourceKind.Builder, ref);
}

interface Placement {
  readonly scope?: KnowledgeScope | undefined;
  readonly area?: string | undefined;
  readonly projectId?: ProjectId | undefined;
}

interface Where {
  readonly scope: KnowledgeScope;
  readonly area: string | null;
  readonly projectId: ProjectId | null;
}

/**
 * The target a write asks for. A new record has no earlier place, so it defaults to the project it is
 * written in; an edit starts from the record it replaces and changes only what the body names. Every
 * refusal starts with the field to fix.
 */
export function resolveTarget(
  body: Placement,
  inProject: ProjectId | null,
  earlier: Where | null,
): KnowledgeTarget {
  const scope = body.scope ?? earlier?.scope ?? KnowledgeScope.Project;
  const projectId = body.projectId ?? inProject ?? earlier?.projectId ?? null;
  if (scope === KnowledgeScope.You) {
    if (body.area !== undefined)
      throw new InvalidError('area: only a record with scope area has one');
    return { scope };
  }
  if (projectId === null)
    throw new InvalidError(`projectId: name the project for a record with scope ${scope}`);
  if (scope === KnowledgeScope.Project) {
    if (body.area !== undefined)
      throw new InvalidError('area: only a record with scope area has one; send scope "area" too');
    return { scope, projectId };
  }
  const area = body.area ?? (earlier?.scope === KnowledgeScope.Area ? earlier.area : null);
  if (area === null) throw new InvalidError('area: name the area for a record with scope area');
  return { scope, projectId, area };
}

/** Decisions and principles together, narrowed; the best matches first with `q`, else the newest. */
export function knowledgeList(
  db: DbReader,
  projectId: ProjectId,
  q: KnowledgeListQuery,
  search: KnowledgeSearchState,
): KnowledgeListDto {
  const project = getProject(db, projectId);
  if (q.area !== undefined && !project.areas.some((a) => a.name === q.area))
    throw new InvalidError(`area: ${project.name} has no area named ${q.area}`);
  const wantDecisions = q.kind === undefined || q.kind === 'decision';
  const wantPrinciples = q.kind !== 'decision';
  const principleKind = Object.values(PrincipleKind).find((k) => k === q.kind);
  if (q.q !== undefined && q.q !== '' && !search.available)
    return { items: [], truncated: false, search };
  const narrow = {
    projectId,
    ...(q.scope ? { scope: q.scope } : {}),
    ...(q.area ? { area: q.area } : {}),
  };
  const searching = q.q !== undefined && q.q !== '';
  // One more than the limit of each kind tells whether more matched.
  const take = q.limit + 1;
  let decisions: DecisionItem[] = [];
  let principles: PrincipleItem[] = [];
  if (wantDecisions) {
    const found = searching
      ? listDecisions(db, {
          ...narrow,
          history: true,
          ids: searchDecisionIds(db, {
            ...narrow,
            query: q.q ?? '',
            limit: take,
            history: q.history,
          }),
        })
      : listDecisions(db, { ...narrow, history: q.history });
    decisions = found.map(decisionItem);
  }
  if (wantPrinciples) {
    const kind = principleKind ? { kind: principleKind } : {};
    const found = searching
      ? listPrinciples(db, {
          ...narrow,
          ...kind,
          history: true,
          ids: searchPrincipleIds(db, {
            ...narrow,
            ...kind,
            query: q.q ?? '',
            limit: take,
            history: q.history,
          }),
        })
      : listPrinciples(db, { ...narrow, ...kind, history: q.history });
    principles = found.map(principleItem);
  }
  const merged: KnowledgeItemDto[] = searching
    ? interleave(decisions, principles)
    : [...decisions, ...principles].toSorted(
        (a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id),
      );
  return { items: merged.slice(0, q.limit), truncated: merged.length > q.limit, search };
}

/** Best match of each kind first, then the second best of each, so neither kind buries the other. */
function interleave(
  a: readonly KnowledgeItemDto[],
  b: readonly KnowledgeItemDto[],
): KnowledgeItemDto[] {
  const out: KnowledgeItemDto[] = [];
  for (let i = 0; i < Math.max(a.length, b.length); i += 1) {
    const x = a[i];
    const y = b[i];
    if (x) out.push(x);
    if (y) out.push(y);
  }
  return out;
}

/** The builder records a decision. */
export function recordDecision(
  ctx: WriteContext,
  projectId: ProjectId,
  body: DecisionWrite,
): DecisionItem {
  const target = resolveTarget(body, projectId, null);
  checkTarget(ctx.tx, target);
  const id = insertDecision(ctx, {
    ...targetColumns(target),
    question: body.question,
    choice: body.choice,
    rationale: body.rationale,
    decidedBy: BUILDER_HANDLE,
    sourceId: sourceFor(ctx, body.source),
  });
  return decisionItem(getDecisionDto(ctx.tx, id));
}

/** The builder edits a decision: the successor keeps what the body does not change. */
export function supersedeDecisionRecord(
  ctx: WriteContext,
  id: DecisionId,
  body: Omit<DecisionEdit, 'dryRun'>,
): DecisionItem {
  const old = getDecisionDto(ctx.tx, id);
  const target = resolveTarget(body, null, old);
  checkTarget(ctx.tx, target);
  const next = supersedeDecision(ctx, id, {
    ...targetColumns(target),
    question: body.question ?? old.question,
    choice: body.choice ?? old.choice,
    rationale: body.rationale ?? old.rationale,
    decidedBy: BUILDER_HANDLE,
    sourceId: sourceFor(ctx, body.source),
  });
  return decisionItem(getDecisionDto(ctx.tx, next));
}

/** The builder states a principle; it is confirmed at once and replaces the current one with its key and target. */
export function createPrinciple(
  ctx: WriteContext,
  projectId: ProjectId,
  body: PrincipleWrite,
): PrincipleItem {
  const target = resolveTarget(body, projectId, null);
  checkTarget(ctx.tx, target);
  return principleItem(
    insertPrinciple(ctx, {
      target,
      statement: body.statement,
      kind: body.kind ?? PrincipleKind.Heuristic,
      topicKey: body.topicKey ?? topicKeyFrom(body.statement),
      rationale: body.rationale ?? null,
      status: PrincipleStatus.Confirmed,
      sourceId: sourceFor(ctx, body.source),
      sourceQuote: body.quote ?? body.source?.quote ?? null,
      speaker: BUILDER_HANDLE,
      confirmedBy: BUILDER_HANDLE,
    }),
  );
}

/** The builder edits a principle by the store's explicit link; the 409 for a taken key names its holder. */
export function supersedePrincipleRecord(
  ctx: WriteContext,
  id: PrincipleId,
  body: Omit<PrincipleEdit, 'dryRun'>,
): PrincipleItem {
  const old = getPrinciple(ctx.tx, id);
  const target = resolveTarget(body, null, old);
  checkTarget(ctx.tx, target);
  return principleItem(
    supersedePrinciple(ctx, id, {
      target,
      statement: body.statement,
      kind: body.kind,
      topicKey: body.topicKey,
      rationale: body.rationale,
      sourceId: sourceFor(ctx, body.source),
      sourceQuote: body.quote ?? body.source?.quote ?? null,
      speaker: BUILDER_HANDLE,
      confirmedBy: BUILDER_HANDLE,
    }),
  );
}
