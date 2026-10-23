import { createHash } from 'node:crypto';
import {
  ConflictError,
  DECISION_CATEGORIES,
  InboxAnswer,
  InboxKind,
  InboxState,
  InvalidError,
  PermissionChoice,
  ProposalId,
  QuestionCategory,
  Urgency,
  type InboxItemDto,
  type InboxItemId,
  type InboxOption,
  type InboxTarget,
  type ProjectId,
  type SessionId,
  type WorkstreamId,
} from '@10db/contracts';
import {
  findOpenByFoldKey,
  getInboxItem,
  getProposal,
  insertDecision,
  insertInboxItem,
  insertPermissionRule,
  insertSource,
  openItemsForWorkstream,
  resolveProposal,
  updateInboxItem,
  type Json,
  type WriteContext,
} from '@10db/db';
import type { StateStore } from '../events';
import { commandPrefix } from '../permissions';
import { applyMcpApproval } from './mcp-approval';

/** Rejects an answer promise when the asking session stops waiting. */
export class ParkedError extends Error {
  override readonly name = 'ParkedError';
  constructor() {
    super('The session stopped waiting for this answer');
  }
}

interface AskInput {
  readonly projectId: ProjectId;
  readonly workstreamId: WorkstreamId;
  readonly sessionId: SessionId;
  readonly kind: 'question' | 'permission';
  readonly title: string;
  readonly body: string;
  readonly options: readonly InboxOption[];
  readonly recommendation: string | null;
  readonly category: QuestionCategory;
  readonly urgency: Urgency;
  readonly detail: Record<string, Json> | null;
  readonly signal: AbortSignal;
}

export interface InboxService {
  /** Folds into an open identical card; the returned promise never causes an unhandled rejection. */
  ask(input: AskInput): { item: InboxItemDto; answer: Promise<InboxAnswer> };
  answer(id: InboxItemId, answer: InboxAnswer): InboxItemDto;
  flag(input: {
    projectId: ProjectId;
    workstreamId: WorkstreamId | null;
    title: string;
    body: string;
    detail?: Record<string, Json>;
    foldKey?: string;
    options?: readonly InboxOption[];
  }): InboxItemDto;
  cancelForWorkstream(workstreamId: WorkstreamId): void;
  redeliver(id: InboxItemId): InboxItemDto;
}

/** Identical open questions fold into one card. */
function foldKeyFor(
  input: Pick<AskInput, 'projectId' | 'kind' | 'title' | 'body' | 'options'>,
): string {
  const norm = (s: string): string => s.trim().replace(/\s+/g, ' ').toLowerCase();
  const parts = [
    input.projectId,
    input.kind,
    norm(input.title),
    norm(input.body),
    ...input.options.map((o) => norm(o.label)),
  ];
  return createHash('sha256').update(parts.join('\u0000')).digest('hex');
}

interface Waiter {
  resolve(answer: InboxAnswer): void;
}

/**
 * A permission card's choice becomes rules in the answer's own transaction, so the choice holds even
 * when the asking session was parked before the builder answered. A Bash command with no storable
 * prefix gets no rule: the choice then behaves as allow-once.
 */
function applyPermissionChoice(ctx: WriteContext, item: InboxItemDto, answer: InboxAnswer): void {
  const toolName = item.detail?.['toolName'];
  const summary = item.detail?.['summary'];
  if (typeof toolName !== 'string' || typeof summary !== 'string') return;
  const pattern = toolName === 'Bash' ? commandPrefix(summary) : null;
  if (toolName === 'Bash' && pattern === null) return;
  if (answer.choice === PermissionChoice.AllowWorkstream) {
    for (const target of item.targets) {
      insertPermissionRule(ctx, {
        projectId: item.projectId,
        workstreamId: target.workstreamId,
        toolName,
        pattern,
        sourceInboxId: item.id,
      });
    }
  }
  if (answer.choice === PermissionChoice.AllowProject) {
    insertPermissionRule(ctx, {
      projectId: item.projectId,
      workstreamId: null,
      toolName,
      pattern,
      sourceInboxId: item.id,
    });
    const sourceId = insertSource(ctx, 'inbox_answer', { inboxId: item.id });
    insertDecision(ctx, {
      projectId: item.projectId,
      question: `Allow ${toolName}${pattern ? ` (${pattern})` : ''} in this project?`,
      choice: 'Always allow',
      rationale: answer.note ?? 'Allowed for the project from the inbox',
      decidedBy: 'me',
      scope: 'project',
      area: null,
      sourceId,
    });
  }
}

/** A proposal keeps its status and the builder's accept/reject rationale; a resolved one is final. */
function applyProposalVerdict(ctx: WriteContext, item: InboxItemDto, answer: InboxAnswer): void {
  const proposalId = ProposalId.safeParse(item.detail?.['proposalId']);
  if (!proposalId.success) return;
  const proposal = getProposal(ctx.tx, proposalId.data);
  if (proposal.status !== 'pending') {
    throw new ConflictError(`Proposal ${proposal.id} is already ${proposal.status}`);
  }
  resolveProposal(ctx, proposalId.data, {
    status: answer.choice === 'accept' ? 'accepted' : 'rejected',
    rationale: answer.note ?? null,
  });
}

export function createInboxService(deps: {
  readonly state: StateStore;
  onParkedAnswer(target: InboxTarget, item: InboxItemDto): void;
  /** Acts on an open flag card's answer before it is recorded; throwing keeps the card open. */
  onFlagAnswer?(item: InboxItemDto, answer: InboxAnswer): void;
}): InboxService {
  const waiters = new Map<InboxItemId, Map<SessionId, Waiter>>();

  /** Moves a card to `to` only from one of `from`, checked in the same transaction as the write. */
  function transition(
    id: InboxItemId,
    from: readonly InboxState[],
    to: InboxState,
    answer?: InboxAnswer,
  ): InboxItemDto {
    return deps.state.write((ctx) => {
      const current = getInboxItem(ctx.tx, id);
      if (!from.includes(current.state)) {
        throw new ConflictError(`Inbox item ${id} is already ${current.state}`);
      }
      return updateInboxItem(ctx, id, { state: to, ...(answer ? { answer } : {}) });
    });
  }

  function deliver(item: InboxItemDto): InboxItemDto {
    const answer = item.answer;
    if (answer === null) throw new ConflictError(`Inbox item ${item.id} has no answer to deliver`);
    if (item.state === InboxState.Answered) {
      transition(item.id, [InboxState.Answered], InboxState.Delivering);
    }
    const live = waiters.get(item.id);
    waiters.delete(item.id);
    for (const target of item.targets) {
      const waiter = target.sessionId ? live?.get(target.sessionId) : undefined;
      if (waiter) waiter.resolve(answer);
      else deps.onParkedAnswer(target, item);
    }
    return transition(item.id, [InboxState.Delivering], InboxState.Resolved);
  }

  return {
    ask(input) {
      const foldKey = foldKeyFor(input);
      const target: InboxTarget = { workstreamId: input.workstreamId, sessionId: input.sessionId };
      const item = deps.state.write((ctx) => {
        const existing = findOpenByFoldKey(ctx.tx, input.projectId, foldKey);
        if (existing) {
          const others = existing.targets.filter((t) => t.workstreamId !== input.workstreamId);
          return updateInboxItem(ctx, existing.id, { targets: [...others, target] });
        }
        return insertInboxItem(ctx, {
          projectId: input.projectId,
          kind: input.kind,
          title: input.title,
          body: input.body,
          options: input.options,
          recommendation: input.recommendation,
          category: input.category,
          urgency: input.urgency,
          detail: input.detail,
          foldKey,
          targets: [target],
        });
      });
      const answer = new Promise<InboxAnswer>((resolve, reject) => {
        const forItem = waiters.get(item.id) ?? new Map<SessionId, Waiter>();
        forItem.set(input.sessionId, { resolve });
        waiters.set(item.id, forItem);
        const onAbort = (): void => {
          forItem.delete(input.sessionId);
          reject(new ParkedError());
        };
        if (input.signal.aborted) onAbort();
        else input.signal.addEventListener('abort', onAbort, { once: true });
      });
      // A caller may never await this (onWaitStart threw, or the session parked), and an unhandled
      // rejection would take the daemon down. Awaiting callers still see the rejection.
      answer.catch(() => undefined);
      return { item, answer };
    },

    answer(id, raw) {
      const answer = InboxAnswer.parse(raw);
      const current = getInboxItem(deps.state.db, id);
      if (current.kind === InboxKind.Flag && current.state === InboxState.Open)
        deps.onFlagAnswer?.(current, answer);
      const answered = deps.state.write((ctx) => {
        const item = getInboxItem(ctx.tx, id);
        if (item.state !== InboxState.Open) {
          throw new ConflictError(`Inbox item ${id} is already ${item.state}`);
        }
        if (item.options.length > 0 && !item.options.some((o) => o.label === answer.choice)) {
          throw new InvalidError(`Choose one of: ${item.options.map((o) => o.label).join(', ')}`);
        }
        const closesDirectly =
          item.kind !== InboxKind.Question && item.kind !== InboxKind.Permission;
        const updated = updateInboxItem(ctx, id, {
          state: closesDirectly ? InboxState.Resolved : InboxState.Answered,
          answer,
        });
        if (item.kind === InboxKind.Question && DECISION_CATEGORIES.includes(item.category)) {
          const sourceId = insertSource(ctx, 'inbox_answer', { inboxId: id });
          insertDecision(ctx, {
            projectId: item.projectId,
            question: item.title,
            choice: answer.choice,
            rationale: answer.note ?? 'Answered in the inbox',
            decidedBy: 'me',
            scope: 'project',
            area: null,
            sourceId,
          });
        }
        if (item.kind === InboxKind.Permission) applyPermissionChoice(ctx, updated, answer);
        if (item.kind === InboxKind.Proposal) applyProposalVerdict(ctx, updated, answer);
        if (item.kind === InboxKind.Flag) applyMcpApproval(ctx, updated, answer);
        return updated;
      });
      return answered.state === InboxState.Resolved ? answered : deliver(answered);
    },

    flag(input) {
      return deps.state.write((ctx) => {
        if (input.foldKey) {
          const existing = findOpenByFoldKey(ctx.tx, input.projectId, input.foldKey);
          if (existing) return existing;
        }
        return insertInboxItem(ctx, {
          projectId: input.projectId,
          kind: InboxKind.Flag,
          title: input.title,
          body: input.body,
          options: input.options ? [...input.options] : [],
          recommendation: null,
          category: QuestionCategory.Other,
          urgency: Urgency.High,
          detail: input.detail ?? null,
          foldKey: input.foldKey ?? null,
          targets: input.workstreamId
            ? [{ workstreamId: input.workstreamId, sessionId: null }]
            : [],
        });
      });
    },

    cancelForWorkstream(workstreamId) {
      deps.state.write((ctx) => {
        for (const item of openItemsForWorkstream(ctx.tx, workstreamId)) {
          if (item.state !== InboxState.Open) continue;
          const targets = item.targets.filter((t) => t.workstreamId !== workstreamId);
          updateInboxItem(
            ctx,
            item.id,
            targets.length === 0 ? { state: InboxState.Cancelled, targets } : { targets },
          );
        }
      });
    },

    redeliver(id) {
      const item = getInboxItem(deps.state.db, id);
      return item.state === InboxState.Answered || item.state === InboxState.Delivering
        ? deliver(item)
        : item;
    },
  };
}
