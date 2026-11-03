import {
  InvalidError,
  KnowledgeState,
  ProposalKind,
  type DecisionItem,
  type KnowledgeDryRunDto,
  type KnowledgeItemDto,
  type KnowledgeScope,
  type KnowledgeSearchState,
  type PrincipleDto,
  type PrincipleItem,
  type ProposalDto,
  type ProposalId,
} from '@10db/contracts';
import {
  BUILDER_HANDLE,
  getDecisionDto,
  getPrinciple,
  getProject,
  getProposalDto,
  listProposals,
  type WriteContext,
} from '@10db/db';
import type { ApiServices } from '../api';
import type { StateStore } from '../events';
import {
  acceptProposal,
  actionSourceFor,
  closeProposalCard,
  createPrinciple,
  decisionItem,
  decisionProvenance,
  draftOf,
  knowledgeList,
  principleItem,
  principleProvenance,
  recordDecision,
  rejectProposal,
  resolveTarget,
  retirePrincipleRecord,
  supersedeDecisionRecord,
  supersedePrincipleRecord,
  withdrawDecisionRecord,
  withdrawPrincipleRecord,
} from '../knowledge';

/** The builder-facing knowledge routes' side of the services (docs/knowledge-api.md). */
export type KnowledgeApiServices = Pick<
  ApiServices,
  | 'listKnowledge'
  | 'recordDecision'
  | 'supersedeDecision'
  | 'withdrawDecision'
  | 'decisionProvenance'
  | 'createPrinciple'
  | 'supersedePrinciple'
  | 'retirePrinciple'
  | 'withdrawPrinciple'
  | 'principleProvenance'
  | 'listProposals'
  | 'acceptProposal'
  | 'rejectProposal'
>;

/** Thrown inside a write to roll it back once a dry run has seen its result. */
class RolledBack extends Error {
  override readonly name = 'RolledBack';
}

export const SEARCH_UNAVAILABLE =
  'Search is unavailable: 10db could not repair a knowledge search index at start. Lists still work; daemon.log has the error.';

export function createKnowledgeServices(deps: {
  readonly state: StateStore;
  /** False when a search index could not be rebuilt at start. */
  readonly searchAvailable: boolean;
}): KnowledgeApiServices {
  const { state } = deps;
  const db = state.db;
  const search: KnowledgeSearchState = deps.searchAvailable
    ? { available: true, message: null }
    : { available: false, message: SEARCH_UNAVAILABLE };

  /**
   * Runs the real write and rolls it back, so a dry run meets every check the write does (the same
   * 409, the same 400) and writes nothing. `replaces` is read after the rollback, as the record is now;
   * `restores` is read inside the write, since only there is the record current again.
   */
  function dryRun<T extends KnowledgeItemDto>(
    write: (ctx: WriteContext) => T,
    replaced: (item: T) => KnowledgeItemDto | null,
    restored: (ctx: WriteContext, item: T) => KnowledgeItemDto | null = () => null,
  ): KnowledgeDryRunDto {
    let written: T | undefined;
    let restores: KnowledgeItemDto | null = null;
    try {
      state.write((ctx) => {
        const item = write(ctx);
        written = item;
        restores = restored(ctx, item);
        throw new RolledBack('dry run');
      });
    } catch (error) {
      if (!(error instanceof RolledBack)) throw error;
    }
    if (written === undefined) throw new Error('a dry run wrote nothing to read');
    return { dryRun: true, wouldWrite: draftOf(written), replaces: replaced(written), restores };
  }

  const decisionReplaced = (item: Pick<DecisionItem, 'supersedesId'>) =>
    item.supersedesId === null ? null : decisionItem(getDecisionDto(db, item.supersedesId));
  const principleReplaced = (item: Pick<PrincipleItem, 'supersedesId'>) =>
    item.supersedesId === null ? null : principleItem(getPrinciple(db, item.supersedesId));

  function decisionRestored(ctx: WriteContext, item: DecisionItem): DecisionItem | null {
    if (item.supersedesId === null) return null;
    const predecessor = getDecisionDto(ctx.tx, item.supersedesId);
    return predecessor.state === KnowledgeState.Current ? decisionItem(predecessor) : null;
  }
  function principleRestored(ctx: WriteContext, item: PrincipleItem): PrincipleItem | null {
    if (item.supersedesId === null) return null;
    const predecessor = getPrinciple(ctx.tx, item.supersedesId);
    return predecessor.state === KnowledgeState.Current ? principleItem(predecessor) : null;
  }

  function principleProposal(ctx: WriteContext, id: ProposalId) {
    const proposal = getProposalDto(ctx.tx, id);
    if (proposal.kind !== ProposalKind.Principle || proposal.principle === null)
      throw new InvalidError(
        'proposal: only a principle proposal is decided here; answer other proposals in the Inbox',
      );
    return { proposal, principle: proposal.principle };
  }

  return {
    listKnowledge: (projectId, query) => knowledgeList(db, projectId, query, search),

    recordDecision(projectId, { dryRun: dry, ...body }) {
      return dry === true
        ? dryRun<DecisionItem>((ctx) => recordDecision(ctx, projectId, body), decisionReplaced)
        : state.write((ctx) => recordDecision(ctx, projectId, body));
    },
    supersedeDecision(id, { dryRun: dry, ...body }) {
      return dry === true
        ? dryRun<DecisionItem>((ctx) => supersedeDecisionRecord(ctx, id, body), decisionReplaced)
        : state.write((ctx) => supersedeDecisionRecord(ctx, id, body));
    },
    withdrawDecision(id, { dryRun: dry, reason, source }) {
      const write = (ctx: WriteContext) => withdrawDecisionRecord(ctx, id, reason, source);
      return dry === true
        ? dryRun<DecisionItem>(write, () => decisionItem(getDecisionDto(db, id)), decisionRestored)
        : state.write(write);
    },
    decisionProvenance: (id) => decisionProvenance(db, id),

    createPrinciple(projectId, { dryRun: dry, ...body }) {
      return dry === true
        ? dryRun<PrincipleItem>((ctx) => createPrinciple(ctx, projectId, body), principleReplaced)
        : state.write((ctx) => createPrinciple(ctx, projectId, body));
    },
    supersedePrinciple(id, { dryRun: dry, ...body }) {
      return dry === true
        ? dryRun<PrincipleItem>((ctx) => supersedePrincipleRecord(ctx, id, body), principleReplaced)
        : state.write((ctx) => supersedePrincipleRecord(ctx, id, body));
    },
    retirePrinciple(id, { dryRun: dry, reason, source }) {
      const write = (ctx: WriteContext) => retirePrincipleRecord(ctx, id, reason, source);
      return dry === true
        ? dryRun<PrincipleItem>(write, () => principleItem(getPrinciple(db, id)))
        : state.write(write);
    },
    withdrawPrinciple(id, { dryRun: dry, reason, source }) {
      const write = (ctx: WriteContext) => withdrawPrincipleRecord(ctx, id, reason, source);
      return dry === true
        ? dryRun<PrincipleItem>(write, () => principleItem(getPrinciple(db, id)), principleRestored)
        : state.write(write);
    },
    principleProvenance: (id) => principleProvenance(db, id),

    listProposals(projectId, query) {
      getProject(db, projectId);
      return listProposals(db, { projectId, status: query.status }).filter(
        (p) => p.kind === ProposalKind.Principle,
      );
    },
    acceptProposal(id, { dryRun: dry, scope, area, note, source, ...edits }) {
      const accept = (ctx: WriteContext): ProposalDto => {
        const { proposal, principle } = principleProposal(ctx, id);
        const target = resolveTarget({ scope, area }, proposal.projectId, whereOf(principle));
        const accepted = acceptProposal(
          ctx,
          id,
          { target, ...edits, ...(note === undefined ? {} : { note }) },
          BUILDER_HANDLE,
          actionSourceFor(ctx, source),
        );
        closeProposalCard(ctx, accepted, note);
        return accepted;
      };
      if (dry !== true) return state.write(accept);
      // The principle the proposal would become, as a record, for the same dry-run answer.
      return dryRun<PrincipleItem>((ctx) => {
        const proposal = accept(ctx);
        if (proposal.principle === null) throw new InvalidError('proposal: it has no principle');
        return principleItem(proposal.principle);
      }, principleReplaced);
    },
    rejectProposal: (id, { note, source }) =>
      state.write((ctx) => {
        principleProposal(ctx, id);
        const rejected = rejectProposal(ctx, id, note ?? null, BUILDER_HANDLE, {
          sourceId: actionSourceFor(ctx, source),
        });
        closeProposalCard(ctx, rejected, note);
        return rejected;
      }),
  };
}

function whereOf(p: PrincipleDto) {
  return {
    scope: p.scope,
    area: p.area,
    projectId: p.projectId,
  } satisfies { scope: KnowledgeScope; area: string | null; projectId: PrincipleDto['projectId'] };
}
