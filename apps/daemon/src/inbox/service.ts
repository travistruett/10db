import { createHash } from 'node:crypto';
import {
  CheckChoice,
  ConflictError,
  DECISION_CATEGORIES,
  InboxAnswer,
  InboxAnswerRefused,
  InboxKind,
  InboxState,
  InvalidError,
  PermissionChoice,
  ProposalId,
  ProposalKind,
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
  insertTaskFromProposal,
  openItemsForWorkstream,
  resolveProposal,
  updateInboxItem,
  type Json,
  type WriteContext,
} from '@10db/db';
import type { StateStore } from '../events';
import { storableRule } from '../permissions';
import { applyMcpApproval } from './mcp-approval';
import { taskFieldsFromProposal } from './proposal-task';

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
  /**
   * Rewrites an open card's body (a cap card's running overshoot), and its options and detail when
   * given, in one write; a closed card is left as it was.
   */
  reword(
    id: InboxItemId,
    body: string,
    card?: { readonly options: readonly InboxOption[]; readonly detail: Record<string, Json> },
  ): void;
  /** Closes an open card whose question a later change made moot; a closed card is left as it was. */
  withdraw(id: InboxItemId): void;
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

/** A card with options takes one of them as its choice. */
function assertKnownChoice(item: InboxItemDto, answer: InboxAnswer): void {
  if (item.options.length > 0 && !item.options.some((o) => o.label === answer.choice)) {
    throw new InvalidError(`Choose one of: ${item.options.map((o) => o.label).join(', ')}`);
  }
}

interface Waiter {
  resolve(answer: InboxAnswer): void;
}

/**
 * A permission card's choice becomes rules in the answer's own transaction, so the choice holds even
 * when the asking session was parked before the builder answered. A Bash command with no storable
 * prefix, and a sandboxed file path that holds a glob character, get no rule: the choice then
 * behaves as allow-once.
 */
function applyPermissionChoice(ctx: WriteContext, item: InboxItemDto, answer: InboxAnswer): void {
  const toolName = item.detail?.['toolName'];
  const summary = item.detail?.['summary'];
  if (typeof toolName !== 'string' || typeof summary !== 'string') return;
  const rule = storableRule(toolName, summary);
  if (rule === undefined) return;
  if (answer.choice === PermissionChoice.AllowWorkstream) {
    for (const target of item.targets) {
      insertPermissionRule(ctx, {
        projectId: item.projectId,
        workstreamId: target.workstreamId,
        toolName: rule.toolName,
        pattern: rule.pattern,
        sourceInboxId: item.id,
      });
    }
  }
  if (answer.choice === PermissionChoice.AllowProject) {
    insertPermissionRule(ctx, {
      projectId: item.projectId,
      workstreamId: null,
      toolName: rule.toolName,
      pattern: rule.pattern,
      sourceInboxId: item.id,
    });
    const sourceId = insertSource(ctx, 'inbox_answer', { inboxId: item.id });
    insertDecision(ctx, {
      projectId: item.projectId,
      question: `Allow ${rule.toolName}${rule.pattern ? ` (${rule.pattern})` : ''} in this project?`,
      choice: 'Always allow',
      rationale: answer.note ?? 'Allowed for the project from the inbox',
      decidedBy: 'me',
      scope: 'project',
      area: null,
      sourceId,
    });
  }
}

/**
 * A proposal keeps its status and the builder's accept/reject rationale; a resolved one is final. Accepting
 * a new-task proposal files its task in the same transaction, so a task that cannot be filed leaves the
 * proposal pending.
 */
function applyProposalVerdict(ctx: WriteContext, item: InboxItemDto, answer: InboxAnswer): void {
  const proposalId = ProposalId.safeParse(item.detail?.['proposalId']);
  if (!proposalId.success) return;
  const proposal = getProposal(ctx.tx, proposalId.data);
  if (proposal.status !== 'pending') {
    throw new ConflictError(`Proposal ${proposal.id} is already ${proposal.status}`);
  }
  const accepted = answer.choice === 'accept';
  resolveProposal(ctx, proposalId.data, {
    status: accepted ? 'accepted' : 'rejected',
    rationale: answer.note ?? null,
  });
  if (accepted && proposal.kind === ProposalKind.NewTask) {
    insertTaskFromProposal(ctx, {
      proposalId: proposal.id,
      projectId: proposal.projectId,
      ...taskFieldsFromProposal(proposal),
    });
  }
}

export function createInboxService(deps: {
  readonly state: StateStore;
  onParkedAnswer(target: InboxTarget, item: InboxItemDto): void;
  /** Acts on an open flag card's answer before it is recorded; throwing keeps the card open. */
  onFlagAnswer?(item: InboxItemDto, answer: InboxAnswer): void;
  /**
   * Acts on an open check card's answer inside the write that closes the card, so the workstream and
   * the card change together; throwing keeps the card open and changes nothing. The result runs once
   * that write has committed. A check card closes with its answer and never reaches `onParkedAnswer`.
   */
  onCheckAnswer?(ctx: WriteContext, item: InboxItemDto, answer: InboxAnswer): () => void;
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
    // The workstream it concerns acted on the answer when it was given; there is nothing to hand on.
    if (item.kind === InboxKind.Check) {
      return transition(item.id, [InboxState.Delivering], InboxState.Resolved);
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
      if (current.kind === InboxKind.Check && current.state === InboxState.Open) {
        assertKnownChoice(current, answer);
        // Send Back is the builder's note to the agent; without one the agent has nothing to act on.
        if (answer.choice === CheckChoice.SendBack && (answer.note ?? '').trim() === '') {
          throw new InboxAnswerRefused('Send Back needs a note saying what to change');
        }
      }
      let afterCommit: (() => void) | undefined;
      const answered = deps.state.write((ctx) => {
        const item = getInboxItem(ctx.tx, id);
        if (item.state !== InboxState.Open) {
          throw new ConflictError(`Inbox item ${id} is already ${item.state}`);
        }
        assertKnownChoice(item, answer);
        if (item.kind === InboxKind.Check) afterCommit = deps.onCheckAnswer?.(ctx, item, answer);
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
      afterCommit?.();
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

    reword(id, body, card) {
      deps.state.write((ctx) => {
        if (getInboxItem(ctx.tx, id).state === InboxState.Open)
          updateInboxItem(ctx, id, { body, ...card });
      });
    },

    withdraw(id) {
      deps.state.write((ctx) => {
        if (getInboxItem(ctx.tx, id).state === InboxState.Open)
          updateInboxItem(ctx, id, { state: InboxState.Cancelled });
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
