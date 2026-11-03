import {
  ConflictError,
  InboxKind,
  InvalidError,
  KnowledgeScope,
  PrincipleStatus,
  PrincipleVerdict,
  ProposalKind,
  ProposalStatus,
  QuestionCategory,
  topicKeyFrom,
  Urgency,
  type InboxAnswer,
  type InboxItemDto,
  type InboxOption,
  type KnowledgeTarget,
  type PrincipleDraft,
  type PrincipleDto,
  type ProjectId,
  type ProposalAccept,
  type ProposalDto,
  type ProposalId,
  type SourceId,
} from '@10db/contracts';
import {
  BUILDER_HANDLE,
  confirmPrinciple,
  getProposalDto,
  insertInboxItem,
  insertPrinciple,
  insertProposal,
  resolveProposal,
  withdrawPrinciple,
  type WriteContext,
} from '@10db/db';
import { z } from 'zod';
import { checkTarget } from './targets';

const Verdict = z.enum(PrincipleVerdict);

const SCOPE_WORDS: Readonly<Record<KnowledgeScope, string>> = {
  [KnowledgeScope.You]: 'you, in every project',
  [KnowledgeScope.Project]: 'this project',
  [KnowledgeScope.Area]: 'one area of this project',
};

/** The verdict that confirms a principle at its own scope; the card recommends it. */
const VERDICT_FOR_SCOPE: Readonly<Record<KnowledgeScope, PrincipleVerdict>> = {
  [KnowledgeScope.You]: PrincipleVerdict.AcceptYou,
  [KnowledgeScope.Project]: PrincipleVerdict.AcceptProject,
  [KnowledgeScope.Area]: PrincipleVerdict.AcceptArea,
};

/** The withdrawal reason of a rejected principle when the builder wrote no note. */
const REJECTED_IN_INBOX = 'Rejected in the Inbox';

/** The target a draft asks for, in the proposing project. */
function draftTarget(
  projectId: ProjectId,
  draft: Pick<PrincipleDraft, 'scope' | 'area'>,
): KnowledgeTarget {
  switch (draft.scope) {
    case KnowledgeScope.You:
      return { scope: KnowledgeScope.You };
    case KnowledgeScope.Project:
      return { scope: KnowledgeScope.Project, projectId };
    case KnowledgeScope.Area:
      // PrincipleDraft refuses an area scope without an area; the fallback only satisfies the type.
      return draft.area === undefined
        ? { scope: KnowledgeScope.Project, projectId }
        : { scope: KnowledgeScope.Area, projectId, area: draft.area };
  }
}

/** A principle proposal card's options (spec §9 "with a choice of scope"); the area one only when it names one. */
function principleCardOptions(principle: Pick<PrincipleDto, 'area'>): InboxOption[] {
  return [
    { label: PrincipleVerdict.AcceptProject, description: 'Confirm it for this project' },
    { label: PrincipleVerdict.AcceptYou, description: 'Confirm it for you, in every project' },
    ...(principle.area === null
      ? []
      : [
          {
            label: PrincipleVerdict.AcceptArea,
            description: `Confirm it for the ${principle.area} area of this project`,
          },
        ]),
    { label: PrincipleVerdict.Reject, description: 'Reject it; it stays on record as withdrawn' },
  ];
}

/** Where a principle applies, in the card's words. */
function placeWords(p: Pick<PrincipleDto, 'scope' | 'area'>): string {
  return `${SCOPE_WORDS[p.scope]}${p.area === null ? '' : ` (${p.area})`}`;
}

// Agent text is data: the card shows it as plain text with where it came from (spec §7).
function cardBody(p: PrincipleDto, body: string): string {
  return [
    p.statement,
    '',
    `Kind: ${p.kind}. Key: ${p.topicKey}. Proposed for ${placeWords(p)}.`,
    ...(p.sourceQuote === null ? [] : [`Quote: "${p.sourceQuote}"`]),
    ...(body === p.statement ? [] : ['', body]),
  ].join('\n');
}

interface PrincipleProposal {
  readonly projectId: ProjectId;
  readonly title: string;
  readonly body: string;
  readonly draft: PrincipleDraft;
  readonly sourceId: SourceId;
  /** Who stated it: `me`, or `agent:<session>`. */
  readonly speaker: string;
}

/** Stores a proposed principle, its pending proposal and the card that asks the builder (spec §9). */
export function proposePrinciple(
  ctx: WriteContext,
  input: PrincipleProposal,
): { principle: PrincipleDto; proposalId: ProposalId; card: InboxItemDto } {
  const principle = insertPrinciple(ctx, {
    target: draftTarget(input.projectId, input.draft),
    statement: input.draft.statement,
    kind: input.draft.kind,
    topicKey: input.draft.topicKey ?? topicKeyFrom(input.draft.statement),
    status: PrincipleStatus.Proposed,
    sourceId: input.sourceId,
    sourceQuote: input.draft.quote ?? null,
    rationale: input.draft.rationale ?? null,
    speaker: input.speaker,
    confirmedBy: null,
  });
  const proposalId = insertProposal(ctx, {
    projectId: input.projectId,
    kind: ProposalKind.Principle,
    title: input.title,
    body: input.body,
    sourceId: input.sourceId,
    principleId: principle.id,
  });
  const card = insertInboxItem(ctx, {
    projectId: input.projectId,
    kind: InboxKind.Proposal,
    title: input.title,
    body: cardBody(principle, input.body),
    options: principleCardOptions(principle),
    recommendation: VERDICT_FOR_SCOPE[principle.scope],
    category: QuestionCategory.Product,
    urgency: Urgency.Low,
    detail: { proposalId, principleId: principle.id },
    foldKey: null,
    targets: [],
  });
  return { principle, proposalId, card };
}

/** The target a card verdict confirms at, or null for a rejection. */
function verdictTarget(
  verdict: PrincipleVerdict,
  principle: PrincipleDto,
  projectId: ProjectId,
): KnowledgeTarget | null {
  switch (verdict) {
    case PrincipleVerdict.AcceptProject:
      return { scope: KnowledgeScope.Project, projectId };
    case PrincipleVerdict.AcceptYou:
      return { scope: KnowledgeScope.You };
    case PrincipleVerdict.AcceptArea:
      if (principle.area === null)
        throw new InvalidError(
          'This proposal names no area; accept it for the project or for you.',
        );
      return { scope: KnowledgeScope.Area, projectId, area: principle.area };
    case PrincipleVerdict.Reject:
      return null;
  }
}

function storedTarget(p: PrincipleDto, projectId: ProjectId): KnowledgeTarget {
  return draftTarget(projectId, { scope: p.scope, ...(p.area === null ? {} : { area: p.area }) });
}

/** A resolved proposal is final: the first verdict wins and a later one changes nothing. */
function pending(ctx: WriteContext, id: ProposalId): ProposalDto {
  const proposal = getProposalDto(ctx.tx, id);
  if (proposal.status !== ProposalStatus.Pending)
    throw new ConflictError(`Proposal ${id} is already ${proposal.status}`);
  return proposal;
}

/**
 * Accepts a proposal; its principle is confirmed at the accepted target, with any edits (spec §9).
 * The target is checked here, so every path refuses an area the project lacks alike.
 */
export function acceptProposal(
  ctx: WriteContext,
  id: ProposalId,
  accept: ProposalAccept,
  by: string,
): ProposalDto {
  const proposal = pending(ctx, id);
  const { principle } = proposal;
  if (principle) {
    const target = accept.target ?? storedTarget(principle, proposal.projectId);
    checkTarget(ctx.tx, target);
    confirmPrinciple(ctx, principle.id, {
      target,
      statement: accept.statement,
      kind: accept.kind,
      topicKey: accept.topicKey,
      confirmedBy: by,
    });
  } else if (
    [accept.target, accept.statement, accept.kind, accept.topicKey].some((v) => v !== undefined)
  ) {
    throw new InvalidError(
      'Only a principle proposal takes a target, statement, kind or topic key.',
    );
  }
  resolveProposal(ctx, id, { status: ProposalStatus.Accepted, rationale: accept.note ?? null });
  return getProposalDto(ctx.tx, id);
}

/**
 * Rejects a proposal; a proposed principle is withdrawn with the note as its reason, or `noNoteReason`
 * when the builder wrote none (spec §9 tombstones).
 */
function rejectProposal(
  ctx: WriteContext,
  id: ProposalId,
  note: string | null,
  by: string,
  noNoteReason = 'Rejected',
): ProposalDto {
  const proposal = pending(ctx, id);
  if (proposal.principle) {
    const reason = note === null || note.trim() === '' ? noNoteReason : note;
    withdrawPrinciple(ctx, proposal.principle.id, by, reason);
  }
  resolveProposal(ctx, id, { status: ProposalStatus.Rejected, rationale: note });
  return getProposalDto(ctx.tx, id);
}

/**
 * A principle proposal card's answer, in the answer's own transaction: the card's choice is a verdict
 * (accept at a scope, or reject), so a refused one rolls the whole answer back and the card stays open.
 */
export function applyPrincipleCard(
  ctx: WriteContext,
  proposal: ProposalDto,
  answer: InboxAnswer,
): void {
  const { principle } = proposal;
  if (!principle) return;
  const { note } = answer;
  // The inbox checked the choice against the card's options, which are verdicts.
  const verdict = Verdict.safeParse(answer.choice);
  if (!verdict.success) throw new InvalidError(`${answer.choice} is not a verdict on a principle`);
  const target = verdictTarget(verdict.data, principle, proposal.projectId);
  if (target === null)
    rejectProposal(ctx, proposal.id, note ?? null, BUILDER_HANDLE, REJECTED_IN_INBOX);
  else
    acceptProposal(
      ctx,
      proposal.id,
      note === undefined ? { target } : { target, note },
      BUILDER_HANDLE,
    );
}
